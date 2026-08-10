/**
 * Robust loss and outlier rejection for the bundle adjustment.
 *
 * Two separate mechanisms, because they do different jobs and conflating them
 * is how a solver quietly throws away good data:
 *
 *  1. A **robust loss** down-weights large residuals continuously during the
 *     optimisation. It keeps a handful of bad correspondences from dragging the
 *     whole fit, while leaving them in the problem in case the fit moves and
 *     they turn out to be fine.
 *
 *  2. An **explicit rejection pass** removes correspondences outright between
 *     LM runs, and reports how many. That number is a diagnostic in its own
 *     right: a decode that rejects 0.1% is healthy, and one that rejects 15%
 *     means the capture or the pattern set has a problem the reprojection RMS
 *     will never tell you about.
 *
 * Residuals reaching this module are already divided by their per-correspondence
 * sigma from decode.ts, so they are standardised: a value of 1 means "one sigma
 * of the decode's own uncertainty estimate". That is what makes fixed tuning
 * constants meaningful instead of arbitrary.
 */

import { median } from './linalg.ts';

export type LossKind = 'none' | 'huber' | 'cauchy';

export interface RobustOptions {
  kind: LossKind;
  /**
   * Tuning constant, in standardised-residual units.
   *
   * The familiar Huber constant 1.345 is derived for a SCALAR Gaussian residual,
   * where it leaves about 17.8% of samples in the linear tail and buys 95%
   * asymptotic efficiency. A reprojection residual is a 2-vector, and its norm
   * is Rayleigh rather than half-normal, so the same 17.8% tail sits at
   * `sqrt(-2 ln 0.178)` = 1.86. Using 1.345 on a 2-vector norm would put roughly
   * 40% of perfectly good correspondences into the linear regime and throw away
   * efficiency for no robustness gain.
   */
  huberK: number;
  /** Cauchy constant. 2.3849 is the scalar 95%-efficiency value. */
  cauchyC: number;
  /**
   * Rejection threshold as a multiple of the estimated robust scale, applied
   * between LM passes.
   */
  rejectK: number;
  /**
   * Floor on the rejection threshold, in standardised units.
   *
   * Without it, a noiseless synthetic capture has a robust scale near zero and
   * the rejection pass would discard essentially everything on floating-point
   * dust. Three sigma of the decode's own stated uncertainty is the natural
   * floor: below that, "outlier" means nothing.
   */
  rejectFloor: number;
  /**
   * Ceiling on the fraction of live correspondences one pass may discard.
   *
   * A rejection pass that throws away half the data is not removing outliers,
   * it is removing the evidence that the model is wrong — and then the refit
   * converges beautifully onto whatever is left. Worse, the discards are not
   * spread evenly: a projector whose pose drifted loses ALL of its
   * correspondences, its parameters stop being constrained by anything, and its
   * reported pose is then whatever the damping happened to leave. Capping the
   * fraction keeps that failure visible in the residual scatter, which is where
   * PARAMETERS.md's progress page can actually see it.
   *
   * When the cap binds, the threshold is raised to the corresponding quantile
   * rather than the pass being skipped, so the worst offenders still go.
   */
  maxRejectFraction: number;
  /**
   * Standardised residual charged to a correspondence that the current state
   * cannot use at all — its camera ray misses the sphere, or its surface point
   * falls behind the projector's lens.
   *
   * Without this the cost function is not comparable between states, and the
   * optimiser exploits it. A correspondence that leaves the frustum simply stops
   * contributing, so the cheapest available "improvement" is to swing a
   * projector until most of its points fall behind it: the cost drops, the step
   * is accepted, and the solve converges neatly onto a pose that explains forty
   * per cent of the data and ignores the rest. Charging a fixed, large penalty
   * makes losing a point expensive and — because the penalty disappears when the
   * point comes back — makes recovering one rewarding.
   *
   * 20 sigma is far beyond any residual a working fit produces, and under the
   * Huber loss it is a finite cost rather than the infinity a hard constraint
   * would impose, so a genuinely unobservable correspondence does not make the
   * whole problem infeasible.
   */
  missPenalty: number;
}

export const DEFAULT_ROBUST_OPTIONS: RobustOptions = {
  kind: 'huber',
  huberK: 1.86,
  cauchyC: 2.3849,
  rejectK: 3.0,
  rejectFloor: 3.0,
  maxRejectFraction: 0.25,
  missPenalty: 20,
};

/**
 * The loss `rho(s)` and the IRLS weight `omega = rho'(s) / (2 s)`.
 *
 * The normalisation is chosen so `rho(s) = s^2` and `omega = 1` in the
 * quadratic regime, which makes the robust cost directly comparable to the plain
 * sum of squares and makes a `kind: 'none'` run bit-identical to an
 * unrobustified one rather than merely equivalent.
 */
export function lossAndWeight(s: number, opts: RobustOptions): { rho: number; omega: number } {
  const a = Math.abs(s);
  switch (opts.kind) {
    case 'huber': {
      const k = opts.huberK;
      if (a <= k) return { rho: s * s, omega: 1 };
      return { rho: k * (2 * a - k), omega: k / a };
    }
    case 'cauchy': {
      const c2 = opts.cauchyC * opts.cauchyC;
      const q = 1 + (s * s) / c2;
      return { rho: c2 * Math.log(q), omega: 1 / q };
    }
    default:
      return { rho: s * s, omega: 1 };
  }
}

/**
 * Robust scale of a set of 2-vector residual norms.
 *
 * Not the usual `1.4826 * MAD`: that constant is the consistency factor for a
 * scalar normal. These are norms of 2-vectors, so under the null hypothesis they
 * follow a Rayleigh distribution whose median is `sqrt(2 ln 2)` = 1.1774 times
 * the underlying sigma. Dividing the observed median by that recovers the scale
 * with the right constant, and it is a median so half the sample can be garbage
 * without moving it.
 */
export function robustScaleFromNorms(norms: readonly number[] | Float64Array): number {
  if (norms.length === 0) return 0;
  return median(norms) / 1.1774;
}

export interface RejectionResult {
  /** Parallel to the input: true = keep. */
  keep: boolean[];
  used: number;
  rejected: number;
  /** The threshold actually applied, in standardised units. Reported for audit. */
  threshold: number;
  scale: number;
}

/**
 * One explicit rejection pass over standardised residual norms.
 *
 * `alreadyRejected` lets a caller carry forward rejections from an earlier pass
 * (for instance, correspondences whose camera ray missed the sphere entirely)
 * so that the counts reported in `SolveDiagnostics` add up.
 */
export function rejectOutliers(
  norms: readonly number[] | Float64Array,
  opts: RobustOptions,
  alreadyRejected?: readonly boolean[],
): RejectionResult {
  const live: number[] = [];
  for (let i = 0; i < norms.length; i++) {
    if (alreadyRejected && alreadyRejected[i]) continue;
    live.push(norms[i]);
  }
  const scale = robustScaleFromNorms(live);
  let threshold = Math.max(opts.rejectFloor, opts.rejectK * scale);

  if (live.length > 0 && opts.maxRejectFraction < 1) {
    let over = 0;
    for (const v of live) if (!(v <= threshold)) over++;
    if (over > live.length * opts.maxRejectFraction) {
      // Raise the bar to the quantile the cap allows. Sorting a copy keeps the
      // caller's array untouched and the result independent of input order.
      const sorted = Float64Array.from(live);
      sorted.sort();
      const keepCount = Math.max(
        1,
        Math.floor(live.length * (1 - opts.maxRejectFraction)),
      );
      threshold = sorted[Math.min(sorted.length - 1, keepCount - 1)];
    }
  }

  const keep: boolean[] = new Array(norms.length);
  let used = 0;
  let rejected = 0;
  for (let i = 0; i < norms.length; i++) {
    const dead = (alreadyRejected && alreadyRejected[i]) || !(norms[i] <= threshold);
    keep[i] = !dead;
    if (dead) rejected++;
    else used++;
  }
  return { keep, used, rejected, threshold, scale };
}
