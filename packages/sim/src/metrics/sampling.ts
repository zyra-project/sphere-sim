// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Deterministic equal-area sampling of the sphere, and the reductions built on
 * it.
 *
 * ## Why not a lat/lon grid
 *
 * The obvious way to sample the sphere is to walk latitude and longitude in
 * equal steps. It is wrong for every area-weighted number in this project, and
 * wrong in the direction that flatters the results. A cell of a lat/lon grid has
 * solid angle proportional to `cos(lat)`, so a uniform grid over-represents the
 * poles by `1/cos(lat)` — a factor of 115 in the outermost row of a 1-degree
 * grid. Since the polar region is precisely where PARAMETERS.md §4.3 puts the
 * scalloped unlit lobe and where §4.3's incidence falls below 0.2, an unweighted
 * lat/lon mean turns a 0.9%-of-the-sphere unlit region into a double-digit
 * number and drags every incidence statistic toward grazing.
 *
 * `equirect.ts` exposes `cellSolidAngleWeight` for code that must work on a
 * lat/lon grid (the field maps, which are images and therefore have to be one).
 * Everything scalar in this directory uses the lattice below instead, because an
 * equal-area sample set has a property no weighted grid has: **every weight is
 * identical**, so an ordinary mean is already an area-weighted mean, an ordinary
 * RMS is already area-weighted, and an ordinary percentile is already the
 * area-weighted percentile. There is no weight to forget.
 *
 * ## Why a Fibonacci lattice and not random points
 *
 * packages/sim/README.md requires every computation to be a pure function of its
 * inputs plus an explicit seed, and the bench compares runs byte for byte. A
 * Monte-Carlo sample would satisfy that with a seeded PRNG, but it converges as
 * `1/sqrt(N)` and its error is noise — so a metric would move between rounds for
 * reasons unrelated to the rig. The Fibonacci (golden-angle) lattice is
 * deterministic with no seed at all, has near-uniform density with no clustering
 * or voids, and its area estimates converge far faster than random sampling.
 * The same construction is used in `test/coverage.test.ts`, which is where the
 * §4.2 multiplicity claim is checked.
 */

import type { Vec3 } from '../vec.ts';
import { clamp } from '../vec.ts';

/** One lattice point: its position on the unit sphere and its coordinates. */
export interface SphereSample {
  latDeg: number;
  lonDeg: number;
  /** Unit vector in the world frame. Multiply by the radius for a surface point. */
  unit: Vec3;
}

/**
 * `n` points on the unit sphere, each representing exactly `4*pi/n` steradians.
 *
 * The z coordinates are the midpoints of `n` equal-height bands, which by
 * Archimedes' hat-box theorem are equal-area bands; the golden angle then
 * spreads the longitudes so no band's points line up with its neighbour's.
 *
 * The `(2i + 1)/n` offset rather than `2i/n` puts the first and last points half
 * a band from the poles instead of exactly on them. On the pole, longitude is
 * undefined and every projector's coverage test returns the same answer, which
 * would put a spurious sample of the degenerate case into every statistic.
 */
export function equalAreaLattice(n: number): SphereSample[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`lattice size must be a positive integer, got ${n}`);
  const out: SphereSample[] = new Array<SphereSample>(n);
  // The golden angle, pi*(3 - sqrt(5)) radians. Any irrational multiple of 2*pi
  // works; this one maximises the minimum gap between consecutive longitudes.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const latDeg = (Math.asin(clamp(z, -1, 1)) * 180) / Math.PI;
    const lonDeg = (((i * golden) % (2 * Math.PI)) * 180) / Math.PI - 180;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const lonRad = (lonDeg * Math.PI) / 180;
    out[i] = {
      latDeg,
      lonDeg,
      unit: { x: r * Math.cos(lonRad), y: r * Math.sin(lonRad), z },
    };
  }
  return out;
}

/** Solid angle each lattice point stands for, steradians. */
export function latticeWeightSr(n: number): number {
  return (4 * Math.PI) / n;
}

/** Surface area each lattice point stands for, square metres. */
export function latticeWeightM2(n: number, radiusM: number): number {
  return (4 * Math.PI * radiusM * radiusM) / n;
}

/** `4*pi*R^2`, for the check that the weights really do add up to the sphere. */
export function sphereAreaM2(radiusM: number): number {
  return 4 * Math.PI * radiusM * radiusM;
}

/**
 * Linear-interpolated percentile of an ASCENDING-sorted array.
 *
 * Because the lattice is equal-area, an ordinary order statistic over the sample
 * values already is the area-weighted percentile — no weight array needed. That
 * equivalence is the whole reason this directory samples the way it does, and it
 * is asserted in `test/metrics.test.ts`.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  const n = sortedAscending.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAscending[0];
  const idx = (n - 1) * clamp(p, 0, 1);
  const lo = Math.floor(idx);
  const hi = Math.min(n - 1, lo + 1);
  const t = idx - lo;
  return sortedAscending[lo] * (1 - t) + sortedAscending[hi] * t;
}

/** Summary statistics of a sample of scalar values. All equal-weighted. */
export interface Stats {
  count: number;
  mean: number;
  rms: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
}

export const EMPTY_STATS: Stats = {
  count: 0,
  mean: NaN,
  rms: NaN,
  p50: NaN,
  p95: NaN,
  max: NaN,
  min: NaN,
};

/**
 * Summarise a sample.
 *
 * The input array is copied before sorting: several callers keep their sample
 * in lattice order so a value can be traced back to a location, and a sort in
 * place would silently destroy that association. Determinism does not depend on
 * the sort being stable — the comparator is a total order on finite numbers —
 * but it does depend on the accumulation order for `mean` and `rms`, which is
 * the caller's array order and therefore fixed.
 */
export function summarise(values: readonly number[]): Stats {
  const n = values.length;
  if (n === 0) return { ...EMPTY_STATS };
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: n,
    mean: sum / n,
    rms: Math.sqrt(sumSq / n),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[n - 1],
    min: sorted[0],
  };
}

/**
 * Lattice sizes for a metric and its convergence check.
 *
 * The coarse run is a QUARTER of the fine one rather than a half. Area estimates
 * from a lattice converge roughly as `1/N`, so halving the count moves the value
 * by about the same amount as the fine run's own error — which makes the
 * convergence report indistinguishable from the thing it is meant to bound.
 * A factor of four separates them enough to read.
 */
export function densityPair(base: number, scale: number): { fine: number; coarse: number } {
  const fine = Math.max(16, Math.round(base * scale));
  return { fine, coarse: Math.max(16, Math.round(fine / 4)) };
}
