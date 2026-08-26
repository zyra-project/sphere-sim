// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The sampler.
 *
 * Two properties matter and neither is about statistics. First, the draw must be
 * reproducible from the seed, or a reader cannot tell a methodology change from
 * sampling noise between two runs of the report. Second, a lognormal declared by
 * a 90% interval must actually recover that interval — otherwise every "plausible
 * range" in the report is a different range from the one written down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bandOf, makeRng, median, percentile, sample, standardNormal } from '../src/montecarlo.ts';
import type { Uncertain } from '../src/montecarlo.ts';

const U = (low: number, high: number): Uncertain => ({
  name: 't', low, high, unit: 'x', provenance: 'ASSUME', note: '',
});

test('the same seed produces the same draws', () => {
  const a = Array.from({ length: 64 }, (_, i) => sample(U(1, 100), makeRng(7 + i * 0)));
  const b = Array.from({ length: 64 }, (_, i) => sample(U(1, 100), makeRng(7 + i * 0)));
  assert.deepEqual(a, b);
});

test('different seeds produce different draws', () => {
  assert.notEqual(sample(U(1, 100), makeRng(1)), sample(U(1, 100), makeRng(2)));
});

test('a lognormal recovers the 90% interval it was declared with', () => {
  const u = U(100e9, 600e9);
  const rng = makeRng(20260823);
  const draws = Array.from({ length: 200_000 }, () => sample(u, rng));
  const band = bandOf(draws);
  // 2% tolerance: this is a sampling check, not an exactness check.
  assert.ok(Math.abs(band.p5 / u.low - 1) < 0.02, `p5 ${band.p5} vs ${u.low}`);
  assert.ok(Math.abs(band.p95 / u.high - 1) < 0.02, `p95 ${band.p95} vs ${u.high}`);
});

test('the median is the geometric mean of the bounds, not the arithmetic one', () => {
  // Declaring range(100, 10000) must not smuggle in a central estimate of 5050.
  const u = U(100, 10_000);
  assert.equal(median(u), 1000);
  const rng = makeRng(11);
  const draws = Array.from({ length: 100_000 }, () => sample(u, rng));
  assert.ok(Math.abs(bandOf(draws).p50 / 1000 - 1) < 0.02);
});

test('every draw is positive', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 20_000; i++) assert.ok(sample(U(0.05, 1.5), rng) > 0);
});

test('non-positive or inverted bounds are refused', () => {
  assert.throws(() => sample(U(0, 10), makeRng(1)), /strictly positive/);
  assert.throws(() => sample(U(-1, 10), makeRng(1)), /strictly positive/);
  assert.throws(() => sample(U(10, 1), makeRng(1)), /below low/);
});

test('a degenerate interval collapses to a constant', () => {
  const rng = makeRng(5);
  for (let i = 0; i < 100; i++) assert.ok(Math.abs(sample(U(42, 42), rng) - 42) < 1e-9);
});

test('standardNormal is roughly standard', () => {
  const rng = makeRng(99);
  const n = 200_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const z = standardNormal(rng);
    sum += z;
    sumSq += z * z;
  }
  assert.ok(Math.abs(sum / n) < 0.02, `mean ${sum / n}`);
  assert.ok(Math.abs(Math.sqrt(sumSq / n) - 1) < 0.02);
});

test('percentile does not reorder the caller array', () => {
  // Callers pass accumulating arrays; sorting in place would make a second call
  // cheap and a first call on a shared array a bug at a distance.
  const values = [5, 1, 4, 2, 3];
  percentile(values, 0.5);
  assert.deepEqual(values, [5, 1, 4, 2, 3]);
});

test('percentile picks by nearest rank', () => {
  const values = [1, 2, 3, 4, 5];
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 0.5), 3);
  assert.equal(percentile(values, 1), 5);
});

test('an empty sample is NaN rather than a silent zero', () => {
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test('bandOf agrees with percentile, having sorted only once', () => {
  // The five-calls-to-percentile spelling sorted a fresh copy each time; with
  // nine bands per run and four of them holding three draws, 200k draws meant 45
  // sorts and a 13.0 s report. Sorting once cut that to 3.8 s, and must not
  // change the nearest-rank answers.
  const rng = makeRng(31337);
  const draws = Array.from({ length: 5_000 }, () => sample(U(1, 1000), rng));
  const b = bandOf(draws);
  assert.equal(b.p5, percentile(draws, 0.05));
  assert.equal(b.p10, percentile(draws, 0.1));
  assert.equal(b.p50, percentile(draws, 0.5));
  assert.equal(b.p90, percentile(draws, 0.9));
  assert.equal(b.p95, percentile(draws, 0.95));
});

test('bandOf does not reorder the caller array', () => {
  const values = [5, 1, 4, 2, 3];
  bandOf(values);
  assert.deepEqual(values, [5, 1, 4, 2, 3]);
});

test('bandOf on an empty sample is NaN throughout, not a crash', () => {
  const b = bandOf([]);
  for (const v of Object.values(b)) assert.ok(Number.isNaN(v));
});

test('bands are ordered', () => {
  const rng = makeRng(1234);
  const draws = Array.from({ length: 50_000 }, () => sample(U(1, 1000), rng));
  const b = bandOf(draws);
  assert.ok(b.p5 <= b.p10 && b.p10 <= b.p50 && b.p50 <= b.p90 && b.p90 <= b.p95);
});
