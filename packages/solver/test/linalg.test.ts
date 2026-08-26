// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The solver's own linear algebra.
 *
 * These are the routines whose failures are silent: a Cholesky that quietly
 * returns garbage for a semi-definite matrix, a Kabsch that returns a rank-2
 * matrix for a coplanar point set, a PRNG that is not reproducible. None of
 * those announce themselves — they show up two modules later as a pose that is
 * wrong by a degree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRng,
  jacobiEigenSymmetric,
  kabschRotation,
  mat3Det,
  mat3Multiply,
  mat3MulVec,
  mat3Transpose,
  median,
  nearestRotation,
  solveSymmetric,
  type Vec3,
} from '../src/linalg.ts';

function randomSpd(n: number, seed: number): Float64Array {
  const rng = createRng(seed);
  const a = new Float64Array(n * n);
  const b = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) b[i] = rng.nextGaussian();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += b[i * n + k] * b[j * n + k];
      a[i * n + j] = s + (i === j ? n : 0);
    }
  }
  return a;
}

test('the symmetric solve is exact for a positive-definite system', () => {
  const n = 9;
  const a = randomSpd(n, 3);
  const rng = createRng(4);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rng.nextGaussian();
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += a[i * n + j] * x[j];
    b[i] = s;
  }
  const r = solveSymmetric(a, n, b);
  assert.equal(r.method, 'cholesky');
  assert.equal(r.ok, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(r.x[i] - x[i]) < 1e-10);
});

test('a rank-deficient system falls back to LDL^T and pseudo-solves', () => {
  // Rows summing to zero: eigenvalues 0, 3, 3 with null direction (1, 1, 1).
  // That is the shape a free-network normal matrix has before the gauge bites —
  // perfectly conditioned in every direction the data sees, and exactly singular
  // in the one it does not.
  const n = 3;
  const a = Float64Array.of(2, -1, -1, -1, 2, -1, -1, -1, 2);
  const b = Float64Array.of(1, -1, 0);
  const r = solveSymmetric(a, n, b, 1e-10);
  assert.equal(r.method, 'ldlt', 'Cholesky must decline a semi-definite matrix');
  assert.equal(r.ok, false, 'the deficiency must be reported, not hidden');
  assert.equal(r.deficiency, 1);
  assert.ok(Number.isFinite(r.x[0] + r.x[1] + r.x[2]), 'the answer is still finite');
  // The pseudo-solution must satisfy the equations in the observable subspace.
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += a[i * n + j] * r.x[j];
    assert.ok(Math.abs(s - b[i]) < 1e-9, `row ${i} residual ${s - b[i]}`);
  }
});

test('the Jacobi eigensolver reproduces a known spectrum', () => {
  const n = 6;
  const a = randomSpd(n, 11);
  const { values, vectors } = jacobiEigenSymmetric(a, n);
  for (let i = 1; i < n; i++) assert.ok(values[i] >= values[i - 1], 'ascending');
  // A v = lambda v, column by column.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += a[i * n + k] * vectors[k * n + j];
      assert.ok(Math.abs(s - values[j] * vectors[i * n + j]) < 1e-8);
    }
  }
});

test('the eigensolver is deterministic, including eigenvector signs', () => {
  const a = randomSpd(5, 21);
  const one = jacobiEigenSymmetric(a, 5);
  const two = jacobiEigenSymmetric(a, 5);
  assert.deepEqual(Array.from(one.values), Array.from(two.values));
  assert.deepEqual(Array.from(one.vectors), Array.from(two.vectors));
});

test('nearestRotation returns a proper rotation and reproduces an exact one', () => {
  const r = Float64Array.of(
    0.36, -0.48, 0.8,
    0.8, 0.6, 0,
    -0.48, 0.64, 0.6,
  );
  assert.ok(Math.abs(mat3Det(r) - 1) < 1e-12, 'fixture is a rotation');
  // Perturb it and check the nearest rotation comes back.
  const noisy = Float64Array.from(r);
  const rng = createRng(7);
  for (let i = 0; i < 9; i++) noisy[i] += rng.nextGaussian() * 1e-3;
  const fixed = nearestRotation(noisy);
  assert.ok(Math.abs(mat3Det(fixed) - 1) < 1e-12);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(fixed[i] - r[i]) < 5e-3);
});

test('Kabsch recovers a rotation from COPLANAR points, which the polar form cannot', () => {
  // Four points at the same height: the PARAMETERS.md §2 projector layout, and
  // the case that made the first implementation of the gauge alignment wrong.
  const from: Vec3[] = [
    { x: 5.18, y: 0, z: 0 },
    { x: 0, y: 5.18, z: 0 },
    { x: -5.18, y: 0, z: 0 },
    { x: 0, y: -5.18, z: 0 },
  ];
  const angle = 0.031;
  const axis = { x: 0.3, y: -0.5, z: 0.81 };
  const norm = Math.hypot(axis.x, axis.y, axis.z);
  const a = { x: axis.x / norm, y: axis.y / norm, z: axis.z / norm };
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const truth = Float64Array.of(
    t * a.x * a.x + c, t * a.x * a.y - s * a.z, t * a.x * a.z + s * a.y,
    t * a.x * a.y + s * a.z, t * a.y * a.y + c, t * a.y * a.z - s * a.x,
    t * a.x * a.z - s * a.y, t * a.y * a.z + s * a.x, t * a.z * a.z + c,
  );
  const to = from.map((p) => mat3MulVec(truth, p));
  const fitted = kabschRotation(from, to);
  assert.ok(Math.abs(mat3Det(fitted) - 1) < 1e-10, 'proper rotation');
  for (let i = 0; i < 9; i++) {
    assert.ok(Math.abs(fitted[i] - truth[i]) < 1e-9, `entry ${i}: ${fitted[i]} vs ${truth[i]}`);
  }
  // And the orientation is right: it maps `from` onto `to`, not the reverse.
  for (let i = 0; i < from.length; i++) {
    const p = mat3MulVec(fitted, from[i]);
    assert.ok(Math.hypot(p.x - to[i].x, p.y - to[i].y, p.z - to[i].z) < 1e-9);
  }
});

test('Kabsch is exact for a non-degenerate cloud too', () => {
  const rng = createRng(31);
  const from: Vec3[] = [];
  for (let i = 0; i < 12; i++) {
    from.push({ x: rng.nextGaussian(), y: rng.nextGaussian(), z: rng.nextGaussian() });
  }
  const truth = Float64Array.of(
    0.36, -0.48, 0.8,
    0.8, 0.6, 0,
    -0.48, 0.64, 0.6,
  );
  const to = from.map((p) => mat3MulVec(truth, p));
  const fitted = kabschRotation(from, to);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(fitted[i] - truth[i]) < 1e-10);
});

test('matrix helpers agree with each other', () => {
  const a = Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 10);
  const b = Float64Array.of(2, 0, 1, 1, 3, 0, 0, 1, 4);
  const ab = mat3Multiply(a, b);
  // (AB)^T = B^T A^T
  const lhs = mat3Transpose(ab);
  const rhs = mat3Multiply(mat3Transpose(b), mat3Transpose(a));
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(lhs[i] - rhs[i]) < 1e-12);
  // det(AB) = det(A) det(B)
  assert.ok(Math.abs(mat3Det(ab) - mat3Det(a) * mat3Det(b)) < 1e-9);
});

test('the PRNG is reproducible and roughly uniform', () => {
  const a = createRng(1234);
  const b = createRng(1234);
  for (let i = 0; i < 1000; i++) assert.equal(a.nextUint32(), b.nextUint32());

  const c = createRng(99);
  let sum = 0;
  let min = 1;
  let max = 0;
  const buckets = new Array<number>(10).fill(0);
  const n = 200000;
  for (let i = 0; i < n; i++) {
    const v = c.nextFloat();
    sum += v;
    min = Math.min(min, v);
    max = Math.max(max, v);
    buckets[Math.min(9, Math.floor(v * 10))]++;
  }
  assert.ok(Math.abs(sum / n - 0.5) < 0.005, `mean ${sum / n}`);
  assert.ok(min >= 0 && max < 1);
  for (const b2 of buckets) assert.ok(Math.abs(b2 / n - 0.1) < 0.01);

  const d = createRng(5);
  let g = 0;
  let g2 = 0;
  for (let i = 0; i < 200000; i++) {
    const v = d.nextGaussian();
    g += v;
    g2 += v * v;
  }
  assert.ok(Math.abs(g / 200000) < 0.02, 'gaussian mean');
  assert.ok(Math.abs(g2 / 200000 - 1) < 0.02, 'gaussian variance');

  // nextInt must stay in range even at the boundary.
  const e = createRng(77);
  for (let i = 0; i < 10000; i++) {
    const v = e.nextInt(7);
    assert.ok(v >= 0 && v < 7);
  }
  assert.equal(e.nextInt(0), 0);
});

test('median handles both parities and does not disturb the input', () => {
  const odd = [3, 1, 2];
  assert.equal(median(odd), 2);
  assert.deepEqual(odd, [3, 1, 2], 'input untouched');
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});
