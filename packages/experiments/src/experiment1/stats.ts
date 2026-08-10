/**
 * Dispersion, reported rather than averaged away.
 *
 * The requirement this file exists for: "Every point gets multiple seeds with
 * dispersion reported. A single-seed curve is an anecdote." So every aggregate
 * here carries the raw values alongside the summary, and the plots draw the
 * individual draws on top of the median line. A reader who distrusts the summary
 * can count the dots.
 *
 * Two choices worth defending:
 *
 *  - **Median, not mean.** Several of these distributions are bias-limited
 *    rather than noise-limited (packages/bench/README.md measures handheld
 *    captures scattering across hundreds of millimetres), and one bad draw moves
 *    a mean of five much further than it moves the median. The mean is reported
 *    beside it so the skew is visible instead of hidden by the choice.
 *  - **Full range, not a standard error.** At n = 1 to 5 a standard error is a
 *    number with a confidence interval wider than itself. The plots draw
 *    min-to-max, which at these n is an honest statement of what was seen.
 */

export interface Dispersion {
  n: number;
  values: number[];
  median: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
  /** Values that were NaN or infinite — a solve that threw, or a metric with no seam. */
  nonFinite: number;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function disperse(raw: readonly number[]): Dispersion {
  const values = raw.filter((v) => Number.isFinite(v));
  const nonFinite = raw.length - values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  const mean = n === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / n;
  // Sample standard deviation. n = 1 gives NaN rather than 0: one draw says
  // nothing about spread and a printed 0 would claim it did.
  const sd =
    n < 2
      ? Number.NaN
      : Math.sqrt(values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1));
  return {
    n,
    values: [...raw],
    median: quantile(sorted, 0.5),
    mean,
    sd,
    min: n === 0 ? Number.NaN : sorted[0],
    max: n === 0 ? Number.NaN : sorted[n - 1],
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    nonFinite,
  };
}

/**
 * The quadrature sum of a set of excesses over a common baseline.
 *
 * docs/AMENDMENTS.md A-16 found the tape term and the sensor term independent
 * and additive in quadrature — `sqrt(5.029^2 + 4.375^2)` = 6.66 against 6.559
 * measured. The brief asks whether the three degradation conditions do the same.
 * This computes the prediction; nothing here asserts it holds.
 */
export function quadrature(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) return Number.NaN;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

/** Excess of a measurement over a baseline, floored at zero. */
export function excessOver(value: number, baseline: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return Number.NaN;
  return Math.max(0, value - baseline);
}
