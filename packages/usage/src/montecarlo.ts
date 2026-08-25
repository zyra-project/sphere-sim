/**
 * montecarlo — deterministic sampling for quantities nobody has measured.
 *
 * ## Why a Monte Carlo and not a spreadsheet
 *
 * The environmental half of this analysis multiplies six or seven numbers
 * together, and not one of them is known to better than a factor of two. Point
 * estimates through a chain like that produce a single confident-looking figure
 * whose error bar nobody can reconstruct. Worse, the obvious manual alternative —
 * take every input at its low end, then every input at its high end — reports a
 * range far wider than reality, because it assumes all six unknowns conspire.
 *
 * Sampling gets both right: the width comes out of the arithmetic rather than
 * being asserted, and independent errors partially cancel the way they actually do.
 *
 * ## Why lognormal, and why specified by a 90% interval
 *
 * Every physical quantity here is positive and known to within a multiplicative
 * factor rather than an additive one — "somewhere between 100 and 600 billion
 * parameters" is a ratio statement, not an interval around a mean. A lognormal
 * is the distribution that says exactly that and nothing more. Specifying it by
 * its 5th and 95th percentiles keeps the declaration honest: you write down the
 * range you would actually bet on, and the median falls out as the geometric
 * mean rather than being chosen.
 *
 * ## Determinism is load-bearing
 *
 * The generator is seeded and the seed is part of the report. Re-running this
 * analysis on the same transcripts must produce the same numbers to the cent, or
 * a reader cannot tell a methodology change from sampling noise. This is the
 * same discipline the bench harness applies to its scenario seeds.
 */

/** mulberry32 — small, fast, and good enough for quantiles at 1e5 draws. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal via Box-Muller.
 *
 * The second variate is discarded rather than cached. Caching it would couple
 * consecutive draws to the order in which callers happen to ask for them, which
 * would make adding a parameter to a model silently change every other
 * parameter's samples — and the whole point of seeding is that it does not.
 */
export function standardNormal(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The z-score bounding a central 90% interval. */
const Z90 = 1.6448536269514722;

/**
 * A lognormal declared by the range you would bet on.
 *
 * `low` and `high` are the 5th and 95th percentiles. The median is their
 * geometric mean — deliberately, so that writing `range(100e9, 600e9)` cannot
 * smuggle in a central estimate you did not think about.
 */
export interface Uncertain {
  readonly name: string;
  readonly low: number;
  readonly high: number;
  readonly unit: string;
  /** Provenance class — see docs/USAGE-ACCOUNTING.md. */
  readonly provenance: 'PUB' | 'IND' | 'ASSUME';
  readonly note: string;
}

export function median(u: Uncertain): number {
  return Math.sqrt(u.low * u.high);
}

export function sample(u: Uncertain, rng: () => number): number {
  if (!(u.low > 0) || !(u.high > 0)) {
    throw new Error(`${u.name}: a lognormal needs strictly positive bounds`);
  }
  if (u.high < u.low) {
    throw new Error(`${u.name}: high (${u.high}) is below low (${u.low})`);
  }
  const mu = Math.log(Math.sqrt(u.low * u.high));
  const sigma = Math.log(u.high / u.low) / (2 * Z90);
  return Math.exp(mu + sigma * standardNormal(rng));
}

/**
 * Percentile of an unsorted sample, by nearest rank.
 *
 * Sorts a copy: callers pass accumulating arrays and a sort in place would make
 * a second call on the same array cheap and a first call on a shared array a
 * bug at a distance.
 */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(q * (sorted.length - 1));
  return sorted[index];
}

export interface Band {
  readonly p5: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
}

/**
 * Five percentiles from ONE sort.
 *
 * The obvious spelling — five calls to `percentile` — sorts a fresh copy each
 * time. `runImpact` builds nine bands and four of them hold three draws each, so
 * the default 200,000 draws meant 45 sorts, several of 600,000 elements.
 * Measured at 3.1 s per band against 0.58 s for a single sort: the report spent
 * most of its time re-sorting data it had already sorted.
 *
 * Same nearest-rank definition as `percentile`, and still no mutation of the
 * caller's array — callers pass accumulating arrays.
 */
export function bandOf(values: readonly number[]): Band {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted.length === 0 ? Number.NaN : sorted[Math.floor(q * (sorted.length - 1))];
  return { p5: at(0.05), p10: at(0.1), p50: at(0.5), p90: at(0.9), p95: at(0.95) };
}
