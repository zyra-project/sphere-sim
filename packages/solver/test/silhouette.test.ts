// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Tests for the image-space sphere finder.
 *
 * The detector's value rests on one claim — that it reads pixels and nothing
 * else — and on one assumption: the ball is framed and the room reaches the
 * frame edge. The first is checked structurally, the second by making it fail.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { otsuThreshold, segmentSphere } from '../src/silhouette.ts';

const W = 320;
const H = 240;

/** A lit scene: a floor band running off the edges, and a framed disc. */
function scene(
  discRadius: number | null,
  extras: { cx: number; cy: number; r: number }[] = [],
): Float64Array {
  const lit = new Float64Array(W * H);
  for (let i = 0; i < lit.length; i++) lit[i] = 0.01;
  for (let y = 190; y < H; y++) for (let x = 0; x < W; x++) lit[y * W + x] = 0.8;
  const blobs = [...extras];
  if (discRadius !== null) blobs.unshift({ cx: 160, cy: 110, r: discRadius });
  for (const b of blobs) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if ((x - b.cx) ** 2 + (y - b.cy) ** 2 < b.r * b.r) lit[y * W + x] = 1.0;
      }
    }
  }
  return lit;
}

test('it picks the framed disc and rejects the floor that runs off the edge', () => {
  const r = segmentSphere(scene(45), W, H);
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  assert.ok(r.chosen >= 0, 'nothing was chosen');

  let inDisc = 0;
  let total = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (r.mask[y * W + x] === 0) continue;
      total++;
      if ((x - 160) ** 2 + (y - 110) ** 2 < 45 * 45) inDisc++;
    }
  }
  assert.equal(inDisc, total, 'the mask kept pixels that are not the disc');
  assert.ok(total > 0.97 * Math.PI * 45 * 45, `recall too low: ${total}`);
});

test('it refuses rather than guessing when every lit thing touches the edge', () => {
  // The failure mode that matters: with no framed object, returning the floor
  // would hand the solver a confident lie. It must return nothing and say so.
  const r = segmentSphere(scene(null), W, H);
  assert.equal(r.chosen, -1);
  assert.equal(r.mask.reduce((s, v) => s + v, 0), 0, 'it masked something anyway');
  assert.match(r.warnings.join(' '), /frame edge/);
});

test('it warns when two interior blobs make the border rule moot', () => {
  // A second interior object of similar size means AREA decided, not the rule
  // the method is justified by. The caller has to be able to see that.
  const r = segmentSphere(scene(45, [{ cx: 60, cy: 60, r: 42 }]), W, H);
  assert.ok(r.chosen >= 0);
  assert.match(r.warnings.join(' '), /two interior components/);
});

test('a blob big enough to matter still loses to the border rule, not to size', () => {
  // The floor band is 16 000 px and the disc is 6 300. If selection were by size
  // alone the floor would win every time.
  const r = segmentSphere(scene(45), W, H);
  const floor = r.components.find((c) => c.touchesBorder);
  const chosen = r.components[r.chosen];
  assert.ok(floor !== undefined && floor.area > chosen.area, 'fixture no longer tests the rule');
});

test('Otsu separates the two populations under the rule that consumes it', () => {
  // The contract is separation, not a value in the gap: the threshold is the top
  // of the lower class and `segmentSphere` cuts with a strict `>`. Asserting a
  // midpoint instead would fail on a correct implementation, which is how this
  // test was written the first time.
  for (const [lowShare, low, high] of [
    [0.5, 0.1, 0.9],
    [0.3, 0.1, 0.9],
    [0.8, 0.02, 0.5],
  ] as const) {
    const n = 10000;
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = i < lowShare * n ? low : high;
    const t = otsuThreshold(a);
    assert.ok(!(low > t), `threshold ${t} would keep the low population ${low}`);
    assert.ok(high > t, `threshold ${t} would discard the high population ${high}`);
  }
});

test('a flat image produces no components rather than a crash', () => {
  const flat = new Float64Array(W * H).fill(0.5);
  const r = segmentSphere(flat, W, H);
  assert.equal(r.chosen, -1);
  assert.ok(r.warnings.length > 0);
});

test('the detector cannot read the rig: it imports nothing', () => {
  // The whole argument for preferring this over the geometric segmentation is
  // that it cannot inherit a dependence on the rig being solved for. That is a
  // property of the file's imports, so assert on them rather than on behaviour.
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '../src/silhouette.ts'),
    'utf8',
  );
  const imports = src.match(/^\s*import\s/gm) ?? [];
  assert.equal(imports.length, 0, `silhouette.ts grew ${imports.length} import(s)`);
});
