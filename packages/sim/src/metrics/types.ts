// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The shape every metric reports itself in, and why it has the fields it has.
 *
 * PARAMETERS.md's central conclusion is that the geometric half of the parameter
 * set is `DOC`/`CFG`/`SOLVE` and the photometric half is `ASSUME`/`MEAS`, so
 * geometric metrics are trustworthy today and photometric ones are not until the
 * ground-truth visit happens. A report that presents both kinds side by side
 * without saying which is which is exactly the dishonesty this project exists to
 * avoid — hence {@link MetricResult.provisional}, which every metric carries
 * even though every metric in this directory sets it to `false`. Phase 2 adds
 * seam luminance, seam chromaticity and black uplift, whose gates §7 itself
 * marks PROVISIONAL, and the report must be able to mark them without a type
 * change.
 *
 * {@link MetricResult.scored} is the other honesty field. Two metrics here fail
 * or pass against a gate that measures something other than what its name
 * suggests — the absolute off-sphere flux gate is confounded by the projector's
 * aspect ratio (docs/AMENDMENTS.md A-01, A-03), and PARAMETERS.md §7 sets no
 * numeric gate on registration error at all. Those are reported with their
 * nearest gate for reference and excluded from the verdict, rather than either
 * hidden or allowed to decide a build.
 */

import type { MetricGate } from '../../../calibration/src/parameters.ts';

export type { MetricGate };

/**
 * How a metric was sampled, and whether the number moved when the sampling did.
 *
 * Carried on every metric because the alternative is a report where a reader
 * cannot tell whether a value changed because the rig changed or because
 * somebody edited a sample count. The convergence entry is the answer to that
 * question: the same metric recomputed at a coarser density, so the reader sees
 * the discretisation error rather than being asked to trust it.
 */
export interface SamplingReport {
  /** Stable identifier for the scheme, e.g. `fibonacci-equal-area`. */
  scheme: string;
  /** One sentence a report can print next to the number. */
  description: string;
  /** How many samples the reported value was computed from. */
  count: number;
  /**
   * Samples per steradian, or `null` for schemes that do not sample the sphere
   * (the raster scan in `flux.ts`, the line scan in `grid.ts`).
   */
  densityPerSr: number | null;
  convergence: ConvergenceReport | null;
}

/** The same metric at two sampling densities, and the gap between them. */
export interface ConvergenceReport {
  coarseCount: number;
  coarseValue: number;
  fineValue: number;
  absoluteChange: number;
  /** `absoluteChange` over `|fineValue|`, or `NaN` when the value is zero. */
  relativeChange: number;
  /** Absolute tolerance, in the metric's own unit. */
  tolerance: number;
  /**
   * True when the two densities agree to better than `tolerance`, or to better
   * than 5% relative. A metric whose value is far from its gate does not need
   * the same absolute convergence as one sitting on it, which is why both tests
   * are offered and either suffices.
   */
  converged: boolean;
}

export interface MetricResult {
  /** Stable id. Matches a `GATES` id where one exists. */
  id: string;
  label: string;
  value: number;
  unit: string;
  /** The gate this is judged against, or `null` when §7 sets none. */
  gate: MetricGate | null;
  /** `gate.max`, lifted out so a report does not have to null-check twice. */
  gateMax: number | null;
  /** `null` when there is no gate. */
  pass: boolean | null;
  /**
   * Whether this metric's pass/fail counts toward {@link MetricSetVerdict}.
   * False for reference-only readings; the `note` always says why.
   */
  scored: boolean;
  /**
   * False for every geometric metric. PARAMETERS.md's provenance table makes
   * this a property of the metric, not of the run: no geometric metric depends
   * on an ASSUME-class photometric constant.
   */
  provisional: boolean;
  /** Prose the report prints verbatim. Explains gate choice and caveats. */
  note: string;
  /**
   * The measurement could not evaluate part of its own domain, so `value` is a
   * LOWER BOUND and `pass` is false whatever the number says.
   *
   * Carried on the result, not just taken as an input, because everything
   * downstream needs it: a bench gate must count this as unmeasured so a
   * waiver's ceiling cannot vouch for a number nobody has, and a page must not
   * print the value as a worst case. `sampling.count` reports how MANY samples
   * there were; this reports that the ones missing are missing for a reason
   * correlated with the answer.
   */
  censored: boolean;
  sampling: SamplingReport;
  /** Secondary numbers a reader needs to interpret `value`. */
  detail: Record<string, number>;
}

export interface MakeMetricInput {
  id: string;
  label: string;
  value: number;
  unit: string;
  gate?: MetricGate | null;
  scored?: boolean;
  provisional?: boolean;
  note: string;
  sampling: SamplingReport;
  detail?: Record<string, number>;
  /**
   * The measurement could not evaluate part of its own domain, so `value` is a
   * LOWER BOUND rather than the worst case.
   *
   * Forces `pass` false. It is not the same as a non-finite value — the number
   * is real and was really measured — and it is not the same as an empty sample
   * set, which `sampling.count` already reports. It is the case where samples
   * were dropped for a reason that CORRELATES with the quantity being measured,
   * so what survives is biased toward the gate rather than merely sparse. The
   * metric's own `note` must say which samples went and why.
   */
  censored?: boolean;
}

/**
 * Build a {@link MetricResult}, deciding pass/fail from the gate.
 *
 * `value <= gate.max` — inclusive, matching `MetricGate.max`'s own wording
 * ("inclusive upper bound the metric must not exceed"). The unlit gate has
 * `max = 0`, so it passes only on an exact zero, which is what §7's "hard
 * requirement" means and is achievable because the quantity is a count of
 * unlit samples divided by a count, not a floating-point residual.
 *
 * A NaN value fails. That is deliberate: a metric that could not be computed is
 * not a metric that passed.
 */
export function makeMetric(input: MakeMetricInput): MetricResult {
  const gate = input.gate ?? null;
  const gateMax = gate ? gate.max : null;
  // A censored metric cannot pass. `value <= gate.max` is a claim about the
  // WHOLE domain, and a measurement that could not evaluate part of its own
  // domain has not made that claim — it has reported the worst of what it could
  // reach, which is a lower bound. The same rule the bench applies one level up
  // in `waivers.ts`: a verdict that does not cover the corpus is not a verdict.
  const pass =
    gate === null
      ? null
      : !input.censored && Number.isFinite(input.value) && input.value <= gate.max;
  return {
    id: input.id,
    label: input.label,
    value: input.value,
    unit: input.unit,
    gate,
    gateMax,
    pass,
    scored: input.scored ?? true,
    provisional: input.provisional ?? false,
    note: input.note,
    censored: input.censored ?? false,
    sampling: input.sampling,
    detail: input.detail ?? {},
  };
}

/**
 * Look a §7 gate up by id, throwing rather than returning undefined.
 *
 * Every call site passes a literal that exists in `GATES`; a typo should stop
 * the run at the point of the typo instead of silently producing a metric with
 * no gate, which would then quietly report `pass: null` and be excluded from the
 * verdict. A metric that vanishes from the scored set is the worst possible
 * failure mode for a quality bar.
 */
export function gateById(gates: readonly MetricGate[], id: string): MetricGate {
  const found = gates.find((g) => g.id === id);
  if (!found) {
    throw new Error(
      `no gate '${id}' in PARAMETERS.md §7 (packages/calibration/src/parameters.ts GATES). ` +
        `Known ids: ${gates.map((g) => g.id).join(', ')}`,
    );
  }
  return found;
}

/** Assemble a {@link ConvergenceReport} from two densities. */
export function convergenceOf(
  fineValue: number,
  coarseValue: number,
  coarseCount: number,
  tolerance: number,
): ConvergenceReport {
  const absoluteChange = Math.abs(fineValue - coarseValue);
  const relativeChange = fineValue === 0 ? NaN : absoluteChange / Math.abs(fineValue);
  return {
    coarseCount,
    coarseValue,
    fineValue,
    absoluteChange,
    relativeChange,
    tolerance,
    converged: absoluteChange <= tolerance || relativeChange <= 0.05,
  };
}

/** A scalar field over the sphere in the equirectangular parameterization. */
export interface ScalarField {
  width: number;
  height: number;
  /**
   * Row 0 is latitude +90, column 0 is longitude -180, samples at CELL CENTRES —
   * the same parameterization `equirect.ts` uses, so a field map and the content
   * it describes overlay directly. `NaN` marks a cell where the quantity is
   * undefined (for registration error, a cell fewer than two projectors light).
   */
  data: Float32Array;
}

export function createScalarField(width: number, height: number, fill = NaN): ScalarField {
  const data = new Float32Array(width * height);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

/** An integer field over the sphere, same parameterization as {@link ScalarField}. */
export interface CountField {
  width: number;
  height: number;
  data: Uint8Array;
}
