/**
 * The four photometric gates of PARAMETERS.md §7 — every one of them PROVISIONAL.
 *
 * | Metric | Gate |
 * | --- | --- |
 * | Seam luminance discontinuity | <= 2% of local mean |
 * | Seam chromaticity discontinuity | ΔE2000 <= 1.0 |
 * | Black uplift ratio, overlap / single | <= 1.20 |
 * | Black uplift chromaticity shift | ΔE2000 <= 2.0 |
 *
 * ## Read this before reading a number out of this module
 *
 * docs/ARCHITECTURE.md's phase gate: Phase 2 is BUILD BUT DO NOT OPTIMIZE, because
 * every constant these four metrics consume is class ASSUME or MEAS and **nobody
 * has measured any of them**. A photometric metric that passes today is a statement
 * about `γ_B = 2.2`, which PARAMETERS.md §10 ranks the single highest photometric
 * risk in the project. So every metric this module produces carries
 * `provisional: true`, the set carries it too, and `provenance.assumed` lists every
 * unmeasured constant that went into the answer with its class and its section.
 *
 * Nothing here has been tuned to make a gate pass. Where a gate fails, or passes
 * for a reason that is really a statement about something else, the metric's `note`
 * says so in the output rather than in a commit message.
 *
 * ## Measuring a discontinuity in a field that is not flat
 *
 * The naive seam metric — max minus min over the seam region, divided by the mean —
 * measures the incidence falloff and not the seam. On this rig that is not a small
 * error: PARAMETERS.md §4.1's `cos(incidence)` runs from 1.0 at a projector's
 * sub-projector point to 0.61 at the 45-degree seam bisector, and inverse-square
 * falloff takes another 12%. One projector's delivered irradiance therefore spans
 * **49% of the local level across a window only 16 degrees wide**, and a factor of
 * three across the whole overlap. A max-minus-min estimator would report tens of
 * percent against a 2% gate on a *perfect* rig.
 *
 * So {@link estimateStep} does what the gate actually asks for. Along a track
 * crossing the seam, with `s` the signed arc distance from the seam in degrees:
 *
 *  1. Exclude a guard band `|s| < guardDeg` — the transition zone, where a
 *     discontinuity would live.
 *  2. Least-squares fit a low-order polynomial in `s` to each side separately, over
 *     `guardDeg <= |s| <= windowDeg`. That is the smooth trend: incidence falloff,
 *     inverse-square, and the blend's own curvature.
 *  3. Extrapolate both fits to `s = 0`. Their difference is the STEP, and half
 *     their sum is the local mean the gate is a fraction of.
 *  4. Fit ONE polynomial to both sides together and compare the observed field
 *     against it inside the guard band. The largest departure is the BAND — an
 *     artifact localized at the seam that is not a step, which is what a narrow
 *     blend defect or a mask edge produces. A two-sided fit is used here and a
 *     one-sided pair above, because across the guard the two-sided fit
 *     *interpolates* where a one-sided fit *extrapolates*, and on this field the
 *     difference between those two is the size of the whole gate.
 *
 * The scored value is the larger of the step and the band, both as a fraction of
 * the local mean. `test/photometric.test.ts` injects known steps spanning four
 * orders of magnitude into a synthetic field with a known non-polynomial trend and
 * requires each one back to a part in a thousand, and requires the estimator to
 * report its own bias — not zero, its own bias — on the same field with no step.
 *
 * ## Two things the estimator will not do quietly
 *
 * **It reports its own noise floor.** Every seam carries a CONTROL: the same
 * estimator, on the same field, on a stretch of the same overlap with no hand-over
 * in it. Whatever that reads is estimator and not rig. On the nominal rig the
 * control reads 2.2e-3 and the seam reads 1.4e-3, so the honest statement about
 * that rig is "no seam is resolvable", not "the seam is 0.14%".
 *
 * **It refuses to measure a seam that is not one.** A projector pair's normalized
 * weights also cross where BOTH are zero — one projector's footprint edge, which on
 * the nominal rig is where the two antipodal pairs' weights meet. Those are not
 * hand-overs, and measuring them produced the worst readings in the whole set until
 * they were excluded, because a footprint edge is exactly where the field is least
 * polynomial. `SeamOptions.minSeamWeight` is the exclusion and `nonSeamPairs`
 * counts what it excluded, so a coverage hole shows up as a count rather than as
 * silence.
 *
 * **What this estimator deliberately does not see.** A smooth artifact spread over
 * the whole 71-degree overlap — §3.2's chromatic band is one — is absorbed into the
 * trend, because at that scale it is not a discontinuity and a trend-fit estimator
 * cannot tell it from geometry. That is the correct behaviour for a gate whose
 * basis §7 gives as "Weber fraction for a step in a smooth field", and it would be
 * a hole in the metric set if nothing else covered it. {@link
 * computePhotometricMetrics} therefore also reports the DIVERGENCE readings, which
 * catch exactly that case by a different route.
 *
 * ## The divergence readings, and why they are unscored
 *
 * §3.2's whole argument is that per-channel divergence produces "a colored band
 * rather than a bright or dark one". The two divergence metrics measure it
 * directly: render the field twice, once with the rig's real thirty-six transfer
 * terms and once with every channel of every projector forced to agree
 * ({@link channelMatchedTransferSet}), and report the difference in luminance and in
 * ΔE2000. On a channel-matched rig they are exactly zero; on §3.2's worked example
 * they reproduce its 6% blue deficit.
 *
 * They are UNSCORED because §7 sets no gate on them and inventing one would be
 * inventing a requirement — and because they are a differential between two
 * simulations, which no photograph can produce. They are reported because a metric
 * set that cannot see the artifact its own spec section is about would be worse than
 * useless: it would be reassuring.
 */

import type { ChannelTriplet, ProjectorTransfer, RigCalibration } from '../../../calibration/src/index.ts';
import { CONVENTIONS_VERSION } from '../../../calibration/src/conventions.ts';
import { GATES, PARAMETER_TABLE } from '../../../calibration/src/parameters.ts';
import type { ParamClass } from '../../../calibration/src/parameters.ts';
import type { Vec3 } from '../vec.ts';
import { DEG2RAD, RAD2DEG, dot, scale, sub, wrapDeg180 } from '../vec.ts';
import { latLonToWorld, raySphereIntersect, worldToLatLon } from '../geometry.ts';
import type { PreparedRig } from '../optics.ts';
import { pixelToRay, prepareRig, worldToPixel } from '../optics.ts';
import type { MaskInterpretation } from '../coverage.ts';
import { coverageAndWeights, isIlluminatedAt, polarMask } from '../coverage.ts';
import { deltaE2000, linearRgbToLab, linearRgbToXyz, relativeLuminance } from '../color.ts';
import { channelMatchedTransferSet, summariseTransfers } from '../photometry.ts';
import type { TransferSummary } from '../photometry.ts';
import type { ProjectorContribution, ShadeInput, ShadingModel } from '../shading.ts';
import { fullShading } from '../shading.ts';
import type { Scene } from '../render.ts';
import { blendedSignal } from '../render.ts';
import type { ConvergenceReport, MetricResult, SamplingReport } from './types.ts';
import { convergenceOf, gateById, makeMetric } from './types.ts';
import { densityPair, equalAreaLattice, percentile } from './sampling.ts';

// ---------------------------------------------------------------------------
// The step estimator
// ---------------------------------------------------------------------------

/** One point on a track across a seam: signed arc offset in degrees, and a value. */
export interface TrendSample {
  s: number;
  value: number;
}

/** A least-squares polynomial in the scaled variable `s / scale`. */
export interface TrendFit {
  coefficients: number[];
  scale: number;
  residualRms: number;
  count: number;
}

export interface StepOptions {
  /**
   * Half-width of the excluded zone around the seam, degrees of arc. Default 2,
   * which is about 30 mm of arc on the 0.8636 m sphere — the scale at which a
   * displacement reads as an edge rather than as softness, and comfortably wider
   * than anything §7's 1.0 mm grid gate would let through.
   */
  guardDeg?: number;
  /** Outer edge of the fitting window on each side, degrees of arc. Default 6. */
  windowDeg?: number;
  /**
   * Polynomial degree of the trend. Default 3.
   *
   * ## Why these three defaults and not the obvious ones
   *
   * The trend model is a local Taylor expansion of a smooth field, so the honest
   * way to choose its order and its span is to measure the estimator's own bias and
   * require it to be small against the gate it has to resolve. Two independent
   * measurements do that, and both are in the output rather than in a comment.
   *
   * `test/photometric.test.ts` runs the estimator on a synthetic field with a known
   * smooth trend and a known injected step, and requires the step back to better
   * than a part in a thousand. And every seam measured at runtime carries a CONTROL
   * (see {@link SeamReport.estimatorFloorFraction}): the same estimator on the same
   * field, at a place with no hand-over in it, whose reading is by construction all
   * estimator and no rig.
   *
   * On the nominal rig the control reads 2.2e-3 at degree 3 over a 6-degree window —
   * nine times inside §7's 2% gate. The obvious defaults do far worse: degree 2 over
   * 12 degrees puts the control at 2.6e-2, which EXCEEDS the gate, so an estimator
   * built that way would report a seam artifact on a perfect rig and there would be
   * nothing in the output to say so.
   */
  degree?: number;
}

export interface StepEstimate {
  /** Left-side trend extrapolated to the seam. */
  left: number;
  /** Right-side trend extrapolated to the seam. */
  right: number;
  /** `|left - right|`. */
  step: number;
  /** `(left + right) / 2` — what §7's "fraction of local mean" is a fraction OF. */
  localMean: number;
  /** `step / |localMean|`. */
  stepFraction: number;
  /** Largest departure from the TWO-SIDED trend inside the guard band. */
  band: number;
  /** `band / |localMean|`. */
  bandFraction: number;
  /** `max(stepFraction, bandFraction)`. The gated quantity. */
  fraction: number;
  /** Worse of the one-sided fits' residual RMS, as a fraction of the local mean. */
  fitResidualFraction: number;
  leftCount: number;
  rightCount: number;
  guardCount: number;
}

/** The defaults {@link StepOptions} documents, in one place so nothing drifts. */
export const DEFAULT_STEP: Required<StepOptions> = { guardDeg: 2, windowDeg: 6, degree: 3 };

/**
 * Solve a small dense linear system by Gaussian elimination with partial pivoting.
 * Returns null on a singular system rather than a vector of NaN.
 */
function solveDense(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (!(Math.abs(m[pivot][col]) > 1e-14)) return null;
    if (pivot !== col) {
      const t = m[pivot];
      m[pivot] = m[col];
      m[col] = t;
    }
    for (let row = col + 1; row < n; row++) {
      const f = m[row][col] / m[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) m[row][k] -= f * m[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let acc = m[row][n];
    for (let k = row + 1; k < n; k++) acc -= m[row][k] * x[k];
    x[row] = acc / m[row][row];
  }
  return x;
}

/**
 * Least-squares polynomial fit of `value` against `s`, in the variable `s / scale`.
 *
 * The scaling is not cosmetic. The normal equations for a degree-2 fit over a
 * window of ±12 involve moments up to `s^4`, i.e. numbers spanning 10^4; scaling the
 * abscissa into [-1, 1] first keeps the matrix condition number near 10 rather than
 * near 10^5, which matters because the fit is then EXTRAPOLATED and extrapolation
 * amplifies coefficient error by the same factor it amplifies everything else.
 */
export function fitTrend(
  samples: readonly TrendSample[],
  degree: number,
  scale: number,
): TrendFit | null {
  const n = degree + 1;
  if (samples.length < n + 1) return null;
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (const sample of samples) {
    const x = sample.s / scale;
    const powers = new Array<number>(n);
    powers[0] = 1;
    for (let k = 1; k < n; k++) powers[k] = powers[k - 1] * x;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i][j] += powers[i] * powers[j];
      b[i] += powers[i] * sample.value;
    }
  }
  const coefficients = solveDense(a, b);
  if (coefficients === null) return null;

  const fit: TrendFit = { coefficients, scale, residualRms: 0, count: samples.length };
  let sumSq = 0;
  for (const sample of samples) {
    const d = sample.value - evalTrend(fit, sample.s);
    sumSq += d * d;
  }
  fit.residualRms = Math.sqrt(sumSq / samples.length);
  return fit;
}

export function evalTrend(fit: TrendFit, s: number): number {
  const x = s / fit.scale;
  let acc = 0;
  for (let k = fit.coefficients.length - 1; k >= 0; k--) acc = acc * x + fit.coefficients[k];
  return acc;
}

/**
 * The seam-step estimator. See the module note for the method and for what it
 * deliberately cannot see.
 *
 * Returns null when either side has too few samples to fit — which happens when a
 * track runs off the lit region or into the polar mask, and is reported as a
 * dropped track rather than as a zero.
 */
export function estimateStep(
  samples: readonly TrendSample[],
  options: StepOptions = {},
): StepEstimate | null {
  const guardDeg = options.guardDeg ?? DEFAULT_STEP.guardDeg;
  const windowDeg = options.windowDeg ?? DEFAULT_STEP.windowDeg;
  const degree = options.degree ?? DEFAULT_STEP.degree;

  const left: TrendSample[] = [];
  const right: TrendSample[] = [];
  const inner: TrendSample[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue;
    const a = Math.abs(sample.s);
    if (a > windowDeg) continue;
    if (a < guardDeg) inner.push(sample);
    else if (sample.s < 0) left.push(sample);
    else right.push(sample);
  }

  const leftFit = fitTrend(left, degree, windowDeg);
  const rightFit = fitTrend(right, degree, windowDeg);
  if (leftFit === null || rightFit === null) return null;

  const leftAtSeam = evalTrend(leftFit, 0);
  const rightAtSeam = evalTrend(rightFit, 0);
  const step = Math.abs(leftAtSeam - rightAtSeam);
  const localMean = (leftAtSeam + rightAtSeam) / 2;
  const denominator = Math.abs(localMean);

  // The band is measured against a SINGLE two-sided fit over both windows, not
  // against a crossfade of the two one-sided ones, and the difference is not
  // cosmetic. Across the guard band a two-sided fit INTERPOLATES where a one-sided
  // fit EXTRAPOLATES. Measured on this rig's real field by the per-track control:
  // a crossfade of two one-sided quadratics over a twelve-degree window reads
  // 2.6e-2 where there is no seam at all — MORE than §7's entire 2% gate — against
  // 2.2e-3 for the two-sided fit at the defaults. An estimator whose own bias
  // exceeds the gate cannot measure the gate, and that bias is invisible unless you
  // go looking for it, because it is smooth and looks exactly like a real seam.
  //
  // A genuine step still registers here, at roughly half its size, because the
  // two-sided fit splits the difference between the two levels. That is why the
  // reported value is the MAX of the two statistics rather than their sum: they
  // measure overlapping things, and the step statistic is the sharper of the two.
  const twoSidedFit = fitTrend([...left, ...right], degree, windowDeg);
  let band = 0;
  if (twoSidedFit !== null) {
    for (const sample of inner) {
      const d = Math.abs(sample.value - evalTrend(twoSidedFit, sample.s));
      if (d > band) band = d;
    }
  }

  const stepFraction = denominator > 0 ? step / denominator : NaN;
  const bandFraction = denominator > 0 ? band / denominator : NaN;
  return {
    left: leftAtSeam,
    right: rightAtSeam,
    step,
    localMean,
    stepFraction,
    band,
    bandFraction,
    fraction: Math.max(stepFraction, bandFraction),
    fitResidualFraction:
      denominator > 0 ? Math.max(leftFit.residualRms, rightFit.residualRms) / denominator : NaN,
    leftCount: left.length,
    rightCount: right.length,
    guardCount: inner.length,
  };
}

// ---------------------------------------------------------------------------
// Evaluating the field
// ---------------------------------------------------------------------------

const BLACK: ChannelTriplet = { r: 0, g: 0, b: 0 };

interface FieldContext {
  physical: PreparedRig;
  content: PreparedRig;
  scene: Scene;
  shading: ShadingModel;
  maskInterpretation: MaskInterpretation;
  transfers: ProjectorTransfer[];
  /** Flat content level, LINEAR. The metrics generate their own field; see below. */
  target: ChannelTriplet;
  /** `null` means "observe each point head-on"; see {@link PhotometricOptions.viewFrom}. */
  viewFrom: Vec3 | null;
}

interface PointEval {
  point: Vec3;
  normal: Vec3;
  viewDir: Vec3;
  contributions: ProjectorContribution[];
  /** How many projectors the CONTENT calibration gives this point to. */
  contentContributors: number;
  mask: number;
}

/**
 * Everything reaching one surface point, with the two-calibration structure
 * `metrics/registration.ts` explains: the CONTENT calibration decides what each
 * projector pixel carries, and the PHYSICAL calibration decides where that pixel
 * lands and how obliquely it arrives.
 *
 * With content === physical this reduces to the aligned case, and the pixel
 * round-trip returns the point it started from to floating-point.
 */
function evaluatePoint(point: Vec3, ctx: FieldContext): PointEval {
  const physical = ctx.physical;
  const inv = 1 / physical.radiusM;
  const normal: Vec3 = { x: point.x * inv, y: point.y * inv, z: point.z * inv };
  const viewDir =
    ctx.viewFrom === null
      ? normal
      : normalizeTo(sub(ctx.viewFrom, point));

  const contributions: ProjectorContribution[] = [];
  for (let i = 0; i < physical.projectors.length; i++) {
    const p = physical.projectors[i];
    // Physics first: does this lens see this point at all?
    if (!isIlluminatedAt(point, p)) continue;
    const px = worldToPixel(p, point);
    if (px === null) continue;

    // Then the compositor: what did it put in that pixel? It decided using the
    // CONTENT calibration, so the pixel's ray has to be traced through the content
    // rig's frustum to find the texel it believed it was painting.
    let signal: ChannelTriplet = BLACK;
    let weight = 0;
    const c = ctx.content.projectors[i];
    const ray = pixelToRay(c, px.u, px.v);
    const hit = raySphereIntersect(c.lens, ray, ctx.content.radiusM);
    if (hit !== null) {
      const ll = worldToLatLon(hit.point);
      const mask = polarMask(ll.latDeg, ctx.content.blend, ctx.maskInterpretation);
      weight = coverageAndWeights(hit.point, ctx.content).weights[i] * mask;
      signal = blendedSignal(ctx.target, weight, ctx.scene.encodeGamma);
    }

    const toLensVec = sub(p.lens, point);
    const distanceM = Math.hypot(toLensVec.x, toLensVec.y, toLensVec.z);
    contributions.push({
      projector: i,
      signal,
      weight,
      incidenceCos: dot(normal, toLensVec) / distanceM,
      distanceM,
      toLens: scale(toLensVec, 1 / distanceM),
      transfer: ctx.transfers[i],
      referenceDistanceM: p.distanceM - physical.radiusM,
    });
  }

  const ll = worldToLatLon(point);
  const contentCoverage = coverageAndWeights(point, ctx.content);
  let contentContributors = 0;
  for (const lit of contentCoverage.lit) if (lit) contentContributors++;

  return {
    point,
    normal,
    viewDir,
    contributions,
    contentContributors,
    mask: polarMask(ll.latDeg, ctx.content.blend, ctx.maskInterpretation),
  };
}

function normalizeTo(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z);
  return n > 0 ? { x: v.x / n, y: v.y / n, z: v.z / n } : { x: 0, y: 0, z: 1 };
}

/** Shade one evaluated point, optionally restricting which contributions count. */
function shadeAt(
  ev: PointEval,
  ctx: FieldContext,
  contributions: ProjectorContribution[] = ev.contributions,
): ChannelTriplet {
  const input: ShadeInput = {
    point: ev.point,
    normal: ev.normal,
    viewDir: ev.viewDir,
    contributions,
    reflectance: ctx.scene.reflectance,
    ambient: ctx.scene.ambient,
  };
  return ctx.shading.shade(input);
}

/** The same contributions with every transfer replaced. For the divergence reading. */
function withTransfers(
  contributions: readonly ProjectorContribution[],
  transfers: readonly ProjectorTransfer[],
): ProjectorContribution[] {
  return contributions.map((c) => ({ ...c, transfer: transfers[c.projector] }));
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface SeamOptions {
  /**
   * Latitudes at which each seam is crossed. Default `[-50, -25, 0, 25, 50]`:
   * inside the polar mask onset at |lat| = 60 (PARAMETERS.md §4.4) at both ends,
   * and spread far enough that a defect confined to one latitude band is not missed.
   */
  latitudesDeg?: number[];
  /** Arc spacing of the samples along the track, degrees. */
  sampleSpacingDeg?: number;
  step?: StepOptions;
  /**
   * Minimum normalized blend weight both projectors must carry at a crossing for it
   * to count as a seam. Default 0.05, matching `metrics/registration.ts`'s
   * `visibleWeightFloor`. Without it, every ANTIPODAL projector pair reports a
   * spurious seam at the point where both their weights are zero — one projector's
   * footprint edge — and on the nominal rig those spurious tracks are the WORST
   * ones in the set, because a footprint edge is where the field is least
   * polynomial.
   */
  minSeamWeight?: number;
  /**
   * Flat content level, LINEAR, that the seam is measured on. PARAMETERS.md §8 item
   * 13 prescribes "a flat mid-gray field, all projectors, in the darkest room
   * condition available" as the blend characterization frame, so 0.5 linear is the
   * default. The level matters — the transfer of §P is nonlinear, so a seam that is
   * invisible at white need not be invisible at mid-gray.
   */
  level?: number;
  convergence?: boolean;
}

export interface SeamMeasurement {
  projectorA: number;
  projectorB: number;
  latDeg: number;
  /** Longitude at which the two projectors' normalized blend weights are equal. */
  seamLonDeg: number;
  /** Each projector's normalized blend weight at the seam. Equal by construction. */
  seamWeight: number;
  /** Luminance step and band, as fractions of the local mean. */
  luminance: StepEstimate;
  /** dE2000 between the two one-sided trends extrapolated to the seam. */
  chromaStepDeltaE: number;
  /** Largest dE2000 departure from the two-sided trend inside the guard band. */
  chromaBandDeltaE: number;
  leftRgb: ChannelTriplet;
  rightRgb: ChannelTriplet;
  /**
   * The same luminance statistic measured on a stretch of the SAME overlap that
   * contains no hand-over — the estimator's own noise floor on this field. `NaN`
   * when the overlap is too narrow to fit a control window into. See
   * {@link SeamReport.estimatorFloorFraction}.
   */
  controlFraction: number;
  controlOffsetDeg: number;
  sampleCount: number;
}

export interface SeamReport {
  measurements: SeamMeasurement[];
  /** Tracks that could not be measured, and why. */
  dropped: { projectorA: number; projectorB: number; latDeg: number; reason: string }[];
  /**
   * Projector pairs that never hand over to each other. On the nominal
   * four-projector rig these are the two ANTIPODAL pairs, which PARAMETERS.md §4.2
   * proves can never overlap: a point within 80.4 degrees of two directions 180
   * degrees apart does not exist. Counted rather than silently skipped, because a
   * rig where an ADJACENT pair lands here has a coverage hole.
   */
  nonSeamPairs: number;
  worstLuminance: SeamMeasurement | null;
  worstChroma: SeamMeasurement | null;
  /** Max over tracks of `max(stepFraction, bandFraction)`. The gated quantity. */
  luminanceFraction: number;
  /** Max over tracks of `max(chromaStep, chromaBand)`. The gated quantity. */
  chromaDeltaE: number;
  luminanceP95: number;
  chromaP95: number;
  /** Worst fit residual over all tracks, as a fraction of local mean. */
  worstFitResidualFraction: number;
  /**
   * Worst control reading over all tracks: what the estimator reports where there
   * is demonstrably no seam. A luminance figure at or below this is the estimator
   * talking, not the rig, and a report should say so rather than quoting it as a
   * measurement.
   */
  estimatorFloorFraction: number;
}

/** Azimuth of a lens in the world XY plane, degrees. */
function lensAzimuthDeg(rig: PreparedRig, index: number): number {
  const lens = rig.projectors[index].lens;
  return Math.atan2(lens.y, lens.x) * RAD2DEG;
}

/**
 * Where projectors `a` and `b` hand over to each other on the parallel at `latDeg`,
 * and how much weight each carries there.
 *
 * Bisection on the weight difference rather than a closed form, for the same reason
 * `coverage.ts` bisects the coverage boundary: on a perturbed rig the two lenses are
 * not at their nominal azimuths, not at the same distance and not at the same
 * height, so the seam is not where arithmetic on the nominals would put it. A metric
 * that measured the step at the nominal seam of a misaligned rig would be measuring
 * the wrong place by exactly the amount that matters.
 *
 * ## The plateau, and why a single bisection finds the wrong point
 *
 * `w_a - w_b` is not a strictly decreasing function with one root. Wherever both
 * projectors are inside their ramp PLATEAUS — both raw weights at 1, so both
 * normalized weights at 0.5 — the difference is identically zero across a whole
 * interval. At the equator of the nominal rig that interval is 31 degrees wide.
 * A single bisection converges to the *near edge* of that interval, which is where
 * one projector's ramp meets its plateau: a kink in the field, not the hand-over,
 * and about 15 degrees away from it. Measured there, the nominal rig reports a 1.8%
 * seam step that is really the estimator straddling a discontinuity in the first
 * derivative.
 *
 * So both edges of the zero set are found and the seam is their midpoint, which is
 * the hand-over for a plateau and the crossing itself when there is no plateau.
 */
function seamLongitude(
  rig: PreparedRig,
  a: number,
  b: number,
  latDeg: number,
  iterations = 60,
): { lonDeg: number; weight: number } | null {
  const azA = lensAzimuthDeg(rig, a);
  const delta = wrapDeg180(lensAzimuthDeg(rig, b) - azA);
  const weightsAt = (offset: number): number[] =>
    coverageAndWeights(latLonToWorld(latDeg, azA + offset, rig.radiusM), rig).weights;
  const difference = (offset: number): number => {
    const w = weightsAt(offset);
    return w[a] - w[b];
  };

  // `a` must dominate at its own azimuth and `b` at its own, or the two do not hand
  // over on this parallel at all.
  if (!(difference(0) > 0) || !(difference(delta) < 0)) return null;

  const edge = (stillOnA: (value: number) => boolean): number => {
    let lo = 0;
    let hi = delta;
    for (let i = 0; i < iterations; i++) {
      const mid = 0.5 * (lo + hi);
      if (stillOnA(difference(mid))) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  const zeroStart = edge((v) => v > 0);
  const zeroEnd = edge((v) => v >= 0);
  const offset = 0.5 * (zeroStart + zeroEnd);
  const w = weightsAt(offset);
  return { lonDeg: wrapDeg180(azA + offset), weight: Math.min(w[a], w[b]) };
}

interface TrackSample {
  s: number;
  rgb: ChannelTriplet;
  contributors: number;
}

/** Sample the field along a parallel, `s` being arc distance from `centreLonDeg`. */
function sampleTrack(
  ctx: FieldContext,
  latDeg: number,
  centreLonDeg: number,
  halfWidthDeg: number,
  spacingDeg: number,
  offsetDeg = 0,
): TrackSample[] {
  const cosLat = Math.cos(latDeg * DEG2RAD);
  const out: TrackSample[] = [];
  if (!(cosLat > 1e-6)) return out;
  for (let s = -halfWidthDeg; s <= halfWidthDeg + 1e-9; s += spacingDeg) {
    const lonDeg = centreLonDeg + (s + offsetDeg) / cosLat;
    const point = latLonToWorld(latDeg, lonDeg, ctx.physical.radiusM);
    const ev = evaluatePoint(point, ctx);
    if (ev.mask <= 0 || ev.contentContributors < 1) continue;
    out.push({ s, rgb: shadeAt(ev, ctx), contributors: ev.contentContributors });
  }
  return out;
}

interface SeamGeometry {
  latitudesDeg: number[];
  sampleSpacingDeg: number;
  /**
   * Both projectors must carry at least this much normalized weight at the seam for
   * the crossing to be a hand-over rather than a footprint edge. 0.05 matches
   * `metrics/registration.ts`'s `visibleWeightFloor`, and it is what separates a
   * real seam from the place where an antipodal pair's weights cross at zero
   * because neither of them reaches.
   */
  minSeamWeight: number;
}

function measureSeams(
  ctx: FieldContext,
  options: SeamGeometry,
  step: StepOptions,
  whiteRgb: ChannelTriplet,
): SeamReport {
  const measurements: SeamMeasurement[] = [];
  const dropped: SeamReport['dropped'] = [];
  const content = ctx.content;
  const n = content.projectors.length;
  const windowDeg = step.windowDeg ?? DEFAULT_STEP.windowDeg;
  const guardDeg = step.guardDeg ?? DEFAULT_STEP.guardDeg;
  const degree = step.degree ?? DEFAULT_STEP.degree;
  let nonSeamPairs = 0;

  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (const latDeg of options.latitudesDeg) {
        const seam = seamLongitude(content, a, b, latDeg);
        if (seam === null) continue;
        if (!(seam.weight >= options.minSeamWeight)) {
          // The weights cross, but at zero: this is one projector's footprint edge,
          // not a hand-over. PARAMETERS.md §4.2 says antipodal pairs never overlap,
          // and this is what that looks like from inside the metric.
          nonSeamPairs++;
          continue;
        }

        const samples = sampleTrack(
          ctx,
          latDeg,
          seam.lonDeg,
          windowDeg,
          options.sampleSpacingDeg,
        );
        const luminance = estimateStep(
          samples.map((x) => ({ s: x.s, value: relativeLuminance(x.rgb) })),
          step,
        );
        if (luminance === null) {
          dropped.push({
            projectorA: a,
            projectorB: b,
            latDeg,
            reason: `only ${samples.length} valid samples on the track; the fit needs at least ${degree + 2} on each side`,
          });
          continue;
        }

        // Per-channel trends in LINEAR light, converted to Lab only after
        // extrapolation. Fitting a polynomial in Lab instead would be fitting it to
        // a cube root of the quantity that is actually smooth.
        const channels = ['r', 'g', 'b'] as const;
        const fits = channels.map((ch) => {
          const left = samples
            .filter((x) => x.s <= -guardDeg && x.s >= -windowDeg)
            .map((x) => ({ s: x.s, value: x.rgb[ch] }));
          const right = samples
            .filter((x) => x.s >= guardDeg && x.s <= windowDeg)
            .map((x) => ({ s: x.s, value: x.rgb[ch] }));
          return {
            left: fitTrend(left, degree, windowDeg),
            right: fitTrend(right, degree, windowDeg),
            both: fitTrend([...left, ...right], degree, windowDeg),
          };
        });
        if (fits.some((f) => f.left === null || f.right === null || f.both === null)) {
          dropped.push({
            projectorA: a,
            projectorB: b,
            latDeg,
            reason: 'per-channel trend fit failed on a track whose luminance fit succeeded',
          });
          continue;
        }

        const leftRgb = tripletFromFits(fits, 'left');
        const rightRgb = tripletFromFits(fits, 'right');
        const chromaStepDeltaE = deltaE2000(
          linearRgbToLab(leftRgb, whiteRgb),
          linearRgbToLab(rightRgb, whiteRgb),
        );

        let chromaBandDeltaE = 0;
        for (const sample of samples) {
          if (Math.abs(sample.s) >= guardDeg) continue;
          const baseline: ChannelTriplet = {
            r: evalTrend(fits[0].both as TrendFit, sample.s),
            g: evalTrend(fits[1].both as TrendFit, sample.s),
            b: evalTrend(fits[2].both as TrendFit, sample.s),
          };
          const d = deltaE2000(
            linearRgbToLab(sample.rgb, whiteRgb),
            linearRgbToLab(baseline, whiteRgb),
          );
          if (d > chromaBandDeltaE) chromaBandDeltaE = d;
        }

        const control = measureControl(ctx, latDeg, seam.lonDeg, options, step);

        measurements.push({
          projectorA: a,
          projectorB: b,
          latDeg,
          seamLonDeg: seam.lonDeg,
          seamWeight: seam.weight,
          luminance,
          chromaStepDeltaE,
          chromaBandDeltaE,
          leftRgb,
          rightRgb,
          controlFraction: control.fraction,
          controlOffsetDeg: control.offsetDeg,
          sampleCount: samples.length,
        });
      }
    }
  }

  const lumValues = measurements.map((m) => m.luminance.fraction);
  const chromaValues = measurements.map((m) => Math.max(m.chromaStepDeltaE, m.chromaBandDeltaE));
  let worstLuminance: SeamMeasurement | null = null;
  let worstChroma: SeamMeasurement | null = null;
  for (const m of measurements) {
    if (worstLuminance === null || m.luminance.fraction > worstLuminance.luminance.fraction) {
      worstLuminance = m;
    }
    const c = Math.max(m.chromaStepDeltaE, m.chromaBandDeltaE);
    if (
      worstChroma === null ||
      c > Math.max(worstChroma.chromaStepDeltaE, worstChroma.chromaBandDeltaE)
    ) {
      worstChroma = m;
    }
  }
  const controls = measurements.map((m) => m.controlFraction).filter((v) => Number.isFinite(v));

  return {
    measurements,
    dropped,
    nonSeamPairs,
    worstLuminance,
    worstChroma,
    luminanceFraction: lumValues.length > 0 ? Math.max(...lumValues) : NaN,
    chromaDeltaE: chromaValues.length > 0 ? Math.max(...chromaValues) : NaN,
    luminanceP95: percentile([...lumValues].sort((x, y) => x - y), 0.95),
    chromaP95: percentile([...chromaValues].sort((x, y) => x - y), 0.95),
    worstFitResidualFraction:
      measurements.length > 0
        ? Math.max(...measurements.map((m) => m.luminance.fitResidualFraction))
        : NaN,
    estimatorFloorFraction: controls.length > 0 ? Math.max(...controls) : NaN,
  };
}

/**
 * The control: the same estimator, on the same field, at a place with no seam.
 *
 * Centred `windowDeg + guardDeg` to one side of the seam, so the control's own
 * window reaches no closer to the seam than the seam's own guard band and never
 * contains the hand-over. Every sample must still be in a two-projector overlap, so
 * the control is measuring the same kind of field the seam measurement is — a
 * control taken in a single-projector region would have different curvature and
 * would understate the floor.
 *
 * Whichever side fits is used; if neither does, the floor is `NaN` and a report
 * should say the estimator was not characterized on that track rather than assume
 * it was clean.
 */
function measureControl(
  ctx: FieldContext,
  latDeg: number,
  seamLonDeg: number,
  options: SeamGeometry,
  step: StepOptions,
): { fraction: number; offsetDeg: number } {
  const windowDeg = step.windowDeg ?? DEFAULT_STEP.windowDeg;
  const guardDeg = step.guardDeg ?? DEFAULT_STEP.guardDeg;
  const offset = windowDeg + guardDeg;
  for (const direction of [1, -1]) {
    const offsetDeg = direction * offset;
    const samples = sampleTrack(
      ctx,
      latDeg,
      seamLonDeg,
      windowDeg,
      options.sampleSpacingDeg,
      offsetDeg,
    );
    if (samples.some((x) => x.contributors < 2)) continue;
    const estimate = estimateStep(
      samples.map((x) => ({ s: x.s, value: relativeLuminance(x.rgb) })),
      step,
    );
    if (estimate !== null) return { fraction: estimate.fraction, offsetDeg };
  }
  return { fraction: NaN, offsetDeg: NaN };
}

interface ChannelFitTrio {
  left: TrendFit | null;
  right: TrendFit | null;
  both: TrendFit | null;
}

function tripletFromFits(fits: ChannelFitTrio[], side: 'left' | 'right'): ChannelTriplet {
  const at = (i: number): number => {
    const fit = fits[i][side];
    return fit === null ? NaN : evalTrend(fit, 0);
  };
  return { r: at(0), g: at(1), b: at(2) };
}

// ---------------------------------------------------------------------------
// Black uplift
// ---------------------------------------------------------------------------

export interface BlackOptions {
  /** Equal-area lattice size over the whole sphere, before restriction to overlaps. */
  sampleCount?: number;
  convergence?: boolean;
}

export interface BlackUpliftReading {
  latDeg: number;
  lonDeg: number;
  contributors: number;
  /** Luminance with every contributor, with the strongest alone, and with none. */
  overlapY: number;
  singleY: number;
  ambientY: number;
  /** `overlapY / singleY` — both include ambient. THE gated quantity. */
  observedRatio: number;
  /** The same with ambient subtracted: what §8 frames 8 minus 9 would measure. */
  projectorOnlyRatio: number;
  /** ΔE2000 between the overlap colour and the strongest-single colour. */
  deltaE: number;
}

export interface BlackUpliftReport {
  samples: number;
  overlapSamples: number;
  /** Max over overlap samples. The gated quantity. */
  ratio: number;
  ratioP95: number;
  /** Max over overlap samples of the ambient-removed ratio. Reported, not scored. */
  projectorOnlyRatio: number;
  /** Max ΔE2000. The gated quantity for the chromaticity half. */
  deltaE: number;
  deltaEP95: number;
  worstRatio: BlackUpliftReading | null;
  worstDeltaE: BlackUpliftReading | null;
}

function measureBlackUplift(
  ctx: FieldContext,
  count: number,
  whiteRgb: ChannelTriplet,
  keepWorst: boolean,
): BlackUpliftReport {
  const lattice = equalAreaLattice(count);
  const ratios: number[] = [];
  const deltas: number[] = [];
  let projectorOnly = 0;
  let overlapSamples = 0;
  let worstRatio: BlackUpliftReading | null = null;
  let worstDeltaE: BlackUpliftReading | null = null;

  for (const s of lattice) {
    const point = latLonToWorld(s.latDeg, s.lonDeg, ctx.physical.radiusM);
    const ev = evaluatePoint(point, ctx);
    if (ev.mask <= 0) continue;
    if (ev.contributions.length < 2) continue;
    overlapSamples++;

    // The strongest single contributor at this very point — same incidence, same
    // distance, same everything except that it is alone. Comparing the overlap to a
    // MEAN over the single-projector region instead would compare the seam, where
    // both projectors are at their most oblique, against a projector's own
    // sub-projector point, where it is at its least: a geometry difference of a
    // factor of two, reported as a photometric one.
    let strongest = ev.contributions[0];
    let strongestY = -1;
    for (const c of ev.contributions) {
      const y = relativeLuminance(shadeAt(ev, ctx, [c]));
      if (y > strongestY) {
        strongestY = y;
        strongest = c;
      }
    }

    const overlapRgb = shadeAt(ev, ctx);
    const singleRgb = shadeAt(ev, ctx, [strongest]);
    const ambientRgb = shadeAt(ev, ctx, []);
    const overlapY = relativeLuminance(overlapRgb);
    const singleY = relativeLuminance(singleRgb);
    const ambientY = relativeLuminance(ambientRgb);

    const observedRatio = singleY > 0 ? overlapY / singleY : NaN;
    const singleAbove = singleY - ambientY;
    const projectorOnlyRatio = singleAbove > 0 ? (overlapY - ambientY) / singleAbove : NaN;
    const deltaE = deltaE2000(
      linearRgbToLab(overlapRgb, whiteRgb),
      linearRgbToLab(singleRgb, whiteRgb),
    );

    ratios.push(observedRatio);
    deltas.push(deltaE);
    if (Number.isFinite(projectorOnlyRatio) && projectorOnlyRatio > projectorOnly) {
      projectorOnly = projectorOnlyRatio;
    }

    if (keepWorst) {
      const reading: BlackUpliftReading = {
        latDeg: s.latDeg,
        lonDeg: s.lonDeg,
        contributors: ev.contributions.length,
        overlapY,
        singleY,
        ambientY,
        observedRatio,
        projectorOnlyRatio,
        deltaE,
      };
      if (worstRatio === null || observedRatio > worstRatio.observedRatio) worstRatio = reading;
      if (worstDeltaE === null || deltaE > worstDeltaE.deltaE) worstDeltaE = reading;
    }
  }

  const sortedRatios = [...ratios].sort((a, b) => a - b);
  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  return {
    samples: count,
    overlapSamples,
    ratio: ratios.length > 0 ? sortedRatios[sortedRatios.length - 1] : NaN,
    ratioP95: percentile(sortedRatios, 0.95),
    projectorOnlyRatio: ratios.length > 0 ? projectorOnly : NaN,
    deltaE: deltas.length > 0 ? sortedDeltas[sortedDeltas.length - 1] : NaN,
    deltaEP95: percentile(sortedDeltas, 0.95),
    worstRatio,
    worstDeltaE,
  };
}

// ---------------------------------------------------------------------------
// Divergence: what the thirty-six unmeasured transfer terms actually do
// ---------------------------------------------------------------------------

export interface DivergenceReport {
  /** Max over overlap samples of `|Y_actual - Y_matched| / Y_matched`. */
  luminanceFraction: number;
  /** Max over overlap samples of ΔE2000 between the two. */
  deltaE: number;
  luminanceP95: number;
  deltaEP95: number;
  overlapSamples: number;
  worst: { latDeg: number; lonDeg: number; luminanceFraction: number; deltaE: number } | null;
  /** True when the rig's transfers already agree, in which case both are exactly 0. */
  channelMatched: boolean;
}

function measureDivergence(
  ctx: FieldContext,
  count: number,
  whiteRgb: ChannelTriplet,
): DivergenceReport {
  const matched = channelMatchedTransferSet(ctx.transfers);
  const summary = summariseTransfers(ctx.transfers);
  const lattice = equalAreaLattice(count);
  const lums: number[] = [];
  const deltas: number[] = [];
  let overlapSamples = 0;
  let worst: DivergenceReport['worst'] = null;

  for (const s of lattice) {
    const point = latLonToWorld(s.latDeg, s.lonDeg, ctx.physical.radiusM);
    const ev = evaluatePoint(point, ctx);
    if (ev.mask <= 0 || ev.contributions.length < 2) continue;
    overlapSamples++;

    const actualRgb = shadeAt(ev, ctx);
    const matchedRgb = shadeAt(ev, ctx, withTransfers(ev.contributions, matched));
    const actualY = relativeLuminance(actualRgb);
    const matchedY = relativeLuminance(matchedRgb);
    const lum = matchedY > 0 ? Math.abs(actualY - matchedY) / matchedY : NaN;
    const de = deltaE2000(
      linearRgbToLab(actualRgb, whiteRgb),
      linearRgbToLab(matchedRgb, whiteRgb),
    );
    lums.push(lum);
    deltas.push(de);
    if (worst === null || de > worst.deltaE) {
      worst = { latDeg: s.latDeg, lonDeg: s.lonDeg, luminanceFraction: lum, deltaE: de };
    }
  }

  const sortedLums = [...lums].sort((a, b) => a - b);
  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  return {
    luminanceFraction: lums.length > 0 ? sortedLums[sortedLums.length - 1] : NaN,
    deltaE: deltas.length > 0 ? sortedDeltas[sortedDeltas.length - 1] : NaN,
    luminanceP95: percentile(sortedLums, 0.95),
    deltaEP95: percentile(sortedDeltas, 0.95),
    overlapSamples,
    worst,
    channelMatched: summary.channelMatched,
  };
}

// ---------------------------------------------------------------------------
// The metric set
// ---------------------------------------------------------------------------

export interface PhotometricOptions {
  /** What the compositor believes. Defaults to `rig` — the perfectly aligned case. */
  contentRig?: RigCalibration;
  /** Defaults to {@link fullShading} at PARAMETERS.md §1's nominals. */
  shading?: ShadingModel;
  /**
   * Where the viewer stands, or `null` to observe every point head-on (`viewDir` =
   * surface normal). Null by default, and the default is a real choice: with
   * §1's specular lobe switched on the radiance genuinely depends on where the
   * viewer is, so a metric computed from one viewpoint is a statement about that
   * viewpoint. Observing head-on makes the number a property of the rig, and puts
   * the specular hot spot at each projector's sub-projector point — which is where
   * §1's own sentence ("a hot spot toward each projector") puts it. Pass a position
   * from PARAMETERS.md §6 to measure what one viewer actually sees instead.
   */
  viewFrom?: Vec3 | null;
  /**
   * The Lab reference white, as linear RGB. Defaults to `scene.reflectance` — the
   * sphere's radiance under one projector's full white at the centre of its own
   * footprint, which is the brightest thing in the room. See `color.ts`.
   */
  whiteRgb?: ChannelTriplet;
  seams?: SeamOptions;
  black?: BlackOptions;
  /** Scales every sampling density at once. */
  densityScale?: number;
  convergence?: boolean;
}

/** One unmeasured constant that went into these numbers. */
export interface AssumedConstant {
  symbol: string;
  section: string;
  klass: ParamClass;
  value: number;
  note: string;
}

export interface PhotometricProvenance {
  conventions: string;
  perfectlyAligned: boolean;
  maskInterpretation: MaskInterpretation;
  shadingModel: string;
  /** `null` when every point was observed head-on. */
  viewFrom: Vec3 | null;
  whiteRgb: ChannelTriplet;
  seamLevel: number;
  transfers: TransferSummary;
  /** Every ASSUME/MEAS constant these metrics consumed, with its value. */
  assumed: AssumedConstant[];
  densityScale: number;
}

export interface PhotometricMetricSet {
  schema: 'sphere-sim/metrics@1';
  phase: 'photometry';
  /** Always true. See the module note and docs/ARCHITECTURE.md's phase gate. */
  provisional: true;
  metrics: MetricResult[];
  /** True when every SCORED metric passes. Still PROVISIONAL. */
  pass: boolean;
  unscored: { id: string; reason: string }[];
  seams: SeamReport;
  black: BlackUpliftReport;
  divergence: DivergenceReport;
  provenance: PhotometricProvenance;
}

/** Compact fixed-point for prose. */
function fmt(x: number): string {
  return Number.isFinite(x) ? x.toExponential(2) : 'not characterized';
}

const PROVISIONAL_PREFIX =
  'PROVISIONAL. Every constant behind this number is class ASSUME or MEAS and none ' +
  'has been measured (PARAMETERS.md §10, docs/ARCHITECTURE.md phase gate). ';

/**
 * Every photometric metric of PARAMETERS.md §7, on a rig.
 *
 * `rig` is the physical rig; `opts.contentRig` is what the compositor believes, and
 * defaults to the same object — the perfectly registered case. `scene` supplies
 * reflectance (§1), ambient (§5, already tinted by the caller — `color.ts`'s
 * `tintedAmbient` is what tints it), the compositor's assumed encode gamma, and the
 * mask interpretation.
 *
 * The content the seam metrics measure on is a FLAT FIELD generated here, not
 * `scene.image`: §8 item 13 prescribes a flat mid-gray field as the blend
 * characterization frame, and a metric that measured whatever content happened to be
 * playing would answer a different question every time it ran.
 */
export function computePhotometricMetrics(
  rig: RigCalibration,
  scene: Scene,
  opts: PhotometricOptions = {},
): PhotometricMetricSet {
  const contentRig = opts.contentRig ?? rig;
  const densityScale = opts.densityScale ?? 1;
  const physical = prepareRig(rig);
  const content = prepareRig(contentRig);
  const shading = opts.shading ?? fullShading();
  const transfers = rig.projectors.map((p) => p.transfer);
  const whiteRgb = opts.whiteRgb ?? scene.reflectance;
  const wantConvergence = opts.convergence ?? true;

  const seamOptions = opts.seams ?? {};
  const level = seamOptions.level ?? 0.5;
  const seamGeometry: SeamGeometry = {
    latitudesDeg: seamOptions.latitudesDeg ?? [-50, -25, 0, 25, 50],
    sampleSpacingDeg: seamOptions.sampleSpacingDeg ?? 0.25,
    minSeamWeight: seamOptions.minSeamWeight ?? 0.05,
  };
  const stepOptions: StepOptions = seamOptions.step ?? {};

  const baseCtx: Omit<FieldContext, 'target'> = {
    physical,
    content,
    scene,
    shading,
    maskInterpretation: scene.maskInterpretation,
    transfers,
    viewFrom: opts.viewFrom ?? null,
  };
  const grayCtx: FieldContext = { ...baseCtx, target: { r: level, g: level, b: level } };
  const blackCtx: FieldContext = { ...baseCtx, target: { r: 0, g: 0, b: 0 } };

  const seams = measureSeams(grayCtx, seamGeometry, stepOptions, whiteRgb);

  const { fine, coarse } = densityPair(opts.black?.sampleCount ?? 4000, densityScale);
  const black = measureBlackUplift(blackCtx, fine, whiteRgb, true);
  const divergence = measureDivergence(grayCtx, fine, whiteRgb);

  let seamConvergence: ConvergenceReport | null = null;
  let blackConvergence: ConvergenceReport | null = null;
  if (wantConvergence) {
    const coarseSeams = measureSeams(
      grayCtx,
      { ...seamGeometry, sampleSpacingDeg: seamGeometry.sampleSpacingDeg * 2 },
      stepOptions,
      whiteRgb,
    );
    seamConvergence = convergenceOf(
      seams.luminanceFraction,
      coarseSeams.luminanceFraction,
      coarseSeams.measurements.length,
      // A tenth of the gate. Finer than that cannot change a verdict.
      0.002,
    );
    const coarseBlack = measureBlackUplift(blackCtx, coarse, whiteRgb, false);
    blackConvergence = convergenceOf(black.ratio, coarseBlack.ratio, coarse, 0.02);
  }

  const seamSampling: SamplingReport = {
    scheme: 'seam-track+trend-subtraction',
    description:
      `${seams.measurements.length} tracks (each hand-over pair crossed at ` +
      `${seamGeometry.latitudesDeg.length} latitudes), sampled every ${seamGeometry.sampleSpacingDeg} ` +
      `deg of arc over +/-${stepOptions.windowDeg ?? DEFAULT_STEP.windowDeg} deg, with the inner ` +
      `+/-${stepOptions.guardDeg ?? DEFAULT_STEP.guardDeg} deg excluded from the ` +
      `degree-${stepOptions.degree ?? DEFAULT_STEP.degree} trend ` +
      `fit and used to measure the departure from it. The seam longitude is the midpoint of the ` +
      `interval where the two projectors' normalized blend weights are equal, found by bisection ` +
      `rather than assumed to be the azimuth bisector. ${seams.nonSeamPairs} pair-latitude ` +
      `combinations were not hand-overs at all (their weights cross at zero, which is a footprint ` +
      `edge) and ${seams.dropped.length} tracks were dropped for too few valid samples. Each track ` +
      `carries a CONTROL: the same estimator on a stretch of the same overlap with no hand-over ` +
      `in it, whose worst reading is ${fmt(seams.estimatorFloorFraction)} — the estimator's own ` +
      `noise floor on this field.`,
    count: seams.measurements.length,
    densityPerSr: null,
    convergence: seamConvergence,
  };

  const blackSampling: SamplingReport = {
    scheme: 'fibonacci-equal-area',
    description:
      `${fine}-point equal-area lattice over the sphere, of which ${black.overlapSamples} lie in ` +
      `an unmasked region two or more projectors reach. Equal-area, so the p95 is already ` +
      `area-weighted. The single-projector reference is the strongest contributor AT THE SAME ` +
      `POINT, not a mean over the single-projector region — same incidence, same distance.`,
    count: black.overlapSamples,
    densityPerSr: fine / (4 * Math.PI),
    convergence: blackConvergence,
  };

  const divergenceSampling: SamplingReport = {
    scheme: 'fibonacci-equal-area+matched-transfer-differential',
    description:
      `${fine}-point equal-area lattice, ${divergence.overlapSamples} of them in an unmasked ` +
      `overlap, each shaded twice: once with the rig's ${summariseTransfers(transfers).valuesPerTerm}` +
      ` per-channel transfer terms and once with every channel of every projector forced to agree.`,
    count: divergence.overlapSamples,
    densityPerSr: fine / (4 * Math.PI),
    convergence: null,
  };

  const seamLuminance = makeMetric({
    id: 'seam_luminance',
    label: 'Seam luminance discontinuity',
    value: seams.luminanceFraction,
    unit: 'fraction of local mean',
    gate: gateById(GATES, 'seam_luminance'),
    scored: true,
    provisional: true,
    note:
      PROVISIONAL_PREFIX +
      'Trend-subtracted: a low-order polynomial is fitted to the field on each side of the seam, ' +
      'excluding a guard band, and extrapolated to the seam. The reported value is the larger of ' +
      'the STEP between the two extrapolated trends and the largest departure from a crossfade ' +
      'between them inside the guard band, both as a fraction of the local mean. Subtracting the ' +
      'trend is not a refinement: the incidence falloff of §4.1 changes the field by nearly a ' +
      'factor of two between a projector meridian and the seam bisector, so a max-minus-min ' +
      'estimator reports about 47% on a perfect rig. This estimator cannot see an artifact that ' +
      'is smooth across the whole 71-degree overlap; the unscored divergence readings can, and ' +
      'that is what they are for.',
    sampling: seamSampling,
    detail: {
      p95: seams.luminanceP95,
      worstLatDeg: seams.worstLuminance ? seams.worstLuminance.latDeg : NaN,
      worstLonDeg: seams.worstLuminance ? seams.worstLuminance.seamLonDeg : NaN,
      worstStepFraction: seams.worstLuminance ? seams.worstLuminance.luminance.stepFraction : NaN,
      worstBandFraction: seams.worstLuminance ? seams.worstLuminance.luminance.bandFraction : NaN,
      worstFitResidualFraction: seams.worstFitResidualFraction,
      estimatorFloorFraction: seams.estimatorFloorFraction,
      trackCount: seams.measurements.length,
      droppedTracks: seams.dropped.length,
      nonSeamPairs: seams.nonSeamPairs,
      contentLevel: level,
    },
  });

  const seamChroma = makeMetric({
    id: 'seam_chroma',
    label: 'Seam chromaticity discontinuity',
    value: seams.chromaDeltaE,
    unit: 'dE2000',
    gate: gateById(GATES, 'seam_chroma'),
    scored: true,
    provisional: true,
    note:
      PROVISIONAL_PREFIX +
      'The same trend subtraction as the luminance metric, but fitted PER CHANNEL in linear ' +
      'light and converted to Lab only after extrapolation — fitting a polynomial in Lab would ' +
      'be fitting it to a cube root of the quantity that is actually smooth. The Lab reference ' +
      'white is the sphere under one projector\'s full white output at the centre of its own ' +
      'footprint, which is the brightest thing in the room; adapting instead to the local level ' +
      'would inflate every dark-content dE by an order of magnitude. The primaries behind the ' +
      'RGB->XYZ conversion are Rec.709, class ASSUME — PARAMETERS.md never states the ' +
      'projector\'s primaries, and §9 already lists spectral rendering as an omission.',
    sampling: seamSampling,
    detail: {
      p95: seams.chromaP95,
      worstLatDeg: seams.worstChroma ? seams.worstChroma.latDeg : NaN,
      worstLonDeg: seams.worstChroma ? seams.worstChroma.seamLonDeg : NaN,
      worstStepDeltaE: seams.worstChroma ? seams.worstChroma.chromaStepDeltaE : NaN,
      worstBandDeltaE: seams.worstChroma ? seams.worstChroma.chromaBandDeltaE : NaN,
      trackCount: seams.measurements.length,
    },
  });

  const blackUplift = makeMetric({
    id: 'black_uplift',
    label: 'Black uplift ratio, overlap / single',
    value: black.ratio,
    unit: 'ratio',
    gate: gateById(GATES, 'black_uplift'),
    scored: true,
    provisional: true,
    note:
      PROVISIONAL_PREFIX +
      'Measured on a full-black field, as the ratio between the radiance at a point two ' +
      'projectors reach and the radiance the STRONGEST of them alone would put at THE SAME ' +
      'POINT — same incidence, same distance. Comparing region means instead would compare the ' +
      'seam, where both projectors are at their most oblique, against a sub-projector point ' +
      'where one is at its least, and report a factor-of-two geometry difference as a ' +
      'photometric one. Both terms include ambient light, because what makes an overlap band ' +
      'visible is its contrast against its surround and the surround has the room in it. That ' +
      'choice decides the verdict: with ambient removed the ratio is exactly the projector ' +
      'count, 2.00 against a gate of 1.20, for any black floor and any gain — see the unscored ' +
      'companion metric. §7 does not say which reading it means, and §8 frames 8 and 9 exist ' +
      'precisely to separate them.',
    sampling: blackSampling,
    detail: {
      p95: black.ratioP95,
      projectorOnlyRatio: black.projectorOnlyRatio,
      overlapSamples: black.overlapSamples,
      worstLatDeg: black.worstRatio ? black.worstRatio.latDeg : NaN,
      worstLonDeg: black.worstRatio ? black.worstRatio.lonDeg : NaN,
      worstOverlapY: black.worstRatio ? black.worstRatio.overlapY : NaN,
      worstSingleY: black.worstRatio ? black.worstRatio.singleY : NaN,
      worstAmbientY: black.worstRatio ? black.worstRatio.ambientY : NaN,
    },
  });

  const blackChroma = makeMetric({
    id: 'black_uplift_chroma',
    label: 'Black uplift chromaticity shift',
    value: black.deltaE,
    unit: 'dE2000',
    gate: gateById(GATES, 'black_uplift_chroma'),
    scored: true,
    provisional: true,
    note:
      PROVISIONAL_PREFIX +
      'dE2000 between the overlap colour and the strongest-single colour at the same point in ' +
      'black content, both including ambient. §3.2 predicts this shift is TINTED — "DLP and LCD ' +
      'leak differently per channel; the uplift in overlaps is tinted, usually blue-gray" — so ' +
      'the number is a direct function of how far apart the twelve black floors are, which is ' +
      'the second-highest-risk unmeasured group in §10 and spans a factor of six. With all ' +
      'twelve equal, as the nominal rig has them, the uplift is neutral and the only shift is ' +
      'the lightness change the ratio metric already reports.',
    sampling: blackSampling,
    detail: {
      p95: black.deltaEP95,
      worstLatDeg: black.worstDeltaE ? black.worstDeltaE.latDeg : NaN,
      worstLonDeg: black.worstDeltaE ? black.worstDeltaE.lonDeg : NaN,
      worstRatioAtSamePoint: black.worstDeltaE ? black.worstDeltaE.observedRatio : NaN,
    },
  });

  const blackProjectorOnly = makeMetric({
    id: 'black_uplift_projector_only',
    label: 'Black uplift ratio with ambient removed (§8 frames 8 minus 9)',
    value: black.projectorOnlyRatio,
    unit: 'ratio',
    gate: gateById(GATES, 'black_uplift'),
    scored: false,
    provisional: true,
    note:
      'REFERENCE ONLY, NOT SCORED. ' +
      PROVISIONAL_PREFIX +
      'The same measurement with ambient subtracted, which is what the difference of §8 items 8 ' +
      '("full black, projectors on") and 9 ("full black, projectors off") would give. It is ' +
      'exactly the projector count wherever two projectors deliver equal light, for ANY black ' +
      'floor and ANY gain, so as a gate it would be a constant. Reported because it says which ' +
      'of the two readings §7\'s 1.20 could possibly have meant: on this evidence the gate is ' +
      'satisfiable only if ambient is included, in which case whether it passes is mostly a ' +
      'statement about `E_amb` — class ASSUME, plausible range 0.01 to 0.15, a factor of 15.',
    sampling: blackSampling,
    detail: { scoredRatio: black.ratio },
  });

  const divergenceLuminance = makeMetric({
    id: 'seam_divergence_luminance',
    label: 'Luminance shift from per-channel transfer divergence',
    value: divergence.luminanceFraction,
    unit: 'fraction',
    gate: gateById(GATES, 'seam_luminance'),
    scored: false,
    provisional: true,
    note:
      'REFERENCE ONLY, NOT SCORED — §7 sets no gate on this, and inventing one would invent a ' +
      'requirement. ' +
      PROVISIONAL_PREFIX +
      'The overlap field rendered twice, once with the rig\'s real per-channel transfer terms ' +
      'and once with every channel of every projector forced to agree, differenced in ' +
      'luminance. This is the artifact §3.2 is about, and it is invisible to the seam ' +
      'discontinuity metrics above because it is smooth across the whole overlap rather than ' +
      'localized at the seam. It is a differential between two simulations and no photograph ' +
      'can produce it. Exactly zero on a channel-matched rig, which the PARAMETERS.md nominal ' +
      'is — §3.2\'s artifact requires divergence, and the amount of divergence is unmeasured.',
    sampling: divergenceSampling,
    detail: {
      p95: divergence.luminanceP95,
      channelMatched: divergence.channelMatched ? 1 : 0,
      gammaSpread: summariseTransfers(transfers).gamma.spread,
      gainSpread: summariseTransfers(transfers).gain.spread,
      blackFloorSpreadRatio: summariseTransfers(transfers).blackFloor.spread,
    },
  });

  const divergenceChroma = makeMetric({
    id: 'seam_divergence_chroma',
    label: 'Chromaticity shift from per-channel transfer divergence',
    value: divergence.deltaE,
    unit: 'dE2000',
    gate: gateById(GATES, 'seam_chroma'),
    scored: false,
    provisional: true,
    note:
      'REFERENCE ONLY, NOT SCORED. ' +
      PROVISIONAL_PREFIX +
      'The chromatic half of the divergence differential — §3.2\'s "colored band rather than a ' +
      'bright or dark one", in dE2000 against the §7 seam gate shown for scale. On the nominal ' +
      'rig it is exactly zero and that is the point: the one configuration in which the ' +
      'project\'s headline photometric artifact cannot appear is the configuration whose ' +
      'constants nobody has measured.',
    sampling: divergenceSampling,
    detail: {
      p95: divergence.deltaEP95,
      worstLatDeg: divergence.worst ? divergence.worst.latDeg : NaN,
      worstLonDeg: divergence.worst ? divergence.worst.lonDeg : NaN,
      worstLuminanceFraction: divergence.worst ? divergence.worst.luminanceFraction : NaN,
    },
  });

  const metrics: MetricResult[] = [
    seamLuminance,
    seamChroma,
    blackUplift,
    blackChroma,
    blackProjectorOnly,
    divergenceLuminance,
    divergenceChroma,
  ];

  return {
    schema: 'sphere-sim/metrics@1',
    phase: 'photometry',
    provisional: true,
    metrics,
    pass: metrics.every((m) => !m.scored || m.pass === true),
    unscored: metrics.filter((m) => !m.scored).map((m) => ({ id: m.id, reason: m.note })),
    seams,
    black,
    divergence,
    provenance: {
      conventions: CONVENTIONS_VERSION,
      perfectlyAligned: contentRig === rig,
      maskInterpretation: scene.maskInterpretation,
      shadingModel: shading.name,
      viewFrom: opts.viewFrom ?? null,
      whiteRgb,
      seamLevel: level,
      transfers: summariseTransfers(transfers),
      assumed: assumedConstants(rig, scene, transfers),
      densityScale,
    },
  };
}

/**
 * Every unmeasured constant that went into the numbers above, with the value this
 * run used.
 *
 * PARAMETERS.md §10's whole point is that the photometric half of the parameter set
 * is unmeasured. A report that prints four numbers and a pass/fail without printing
 * the thirty-odd guesses underneath them is exactly the kind of thing this project
 * says it is trying not to be, so the list travels with the result.
 */
function assumedConstants(
  rig: RigCalibration,
  scene: Scene,
  transfers: readonly ProjectorTransfer[],
): AssumedConstant[] {
  const out: AssumedConstant[] = [];
  const push = (id: string, value: number, extra = ''): void => {
    const spec = PARAMETER_TABLE[id];
    if (!spec) return;
    out.push({
      symbol: spec.symbol,
      section: spec.section,
      klass: spec.klass,
      value,
      note: `${spec.note}${extra ? ` ${extra}` : ''} Plausible range ${spec.min} to ${spec.max} (${spec.rangeSource}).`,
    });
  };

  push('rho_R', scene.reflectance.r);
  push('rho_G', scene.reflectance.g);
  push('rho_B', scene.reflectance.b);
  push('rho_spec', 0.03, 'Value as configured on the shading model.');
  push('alpha_spec', 0.4, 'Value as configured on the shading model.');
  push('E_amb', relativeLuminance(scene.ambient), 'Reported as the luminance of the ambient triple.');
  push('E_amb_chroma', ambientCct(scene.ambient));

  const summary = summariseTransfers(transfers);
  push('gamma_R', summary.gamma.min, `Rig spread ${summary.gamma.min} to ${summary.gamma.max} over ${summary.valuesPerTerm} values.`);
  push('L_black_R', summary.blackFloor.min, `Rig spread ${summary.blackFloor.min} to ${summary.blackFloor.max}.`);
  push('g_R', summary.gain.min, `Rig spread ${summary.gain.min} to ${summary.gain.max}.`);
  push('w_width', rig.blend.widthDeg);
  push('gamma_blend', rig.blend.rampGamma);
  push('mask_lo', rig.blend.maskLoDeg);
  push('mask_hi', rig.blend.maskHiDeg);
  return out;
}

/** Correlated colour temperature of an ambient triple, for the provenance block. */
function ambientCct(ambient: ChannelTriplet): number {
  const xyz = linearRgbToXyz(ambient);
  const sum = xyz.X + xyz.Y + xyz.Z;
  if (!(sum > 0)) return NaN;
  const n = (xyz.X / sum - 0.332) / (0.1858 - xyz.Y / sum);
  return 437 * n * n * n + 3601 * n * n + 6861 * n + 5517;
}
