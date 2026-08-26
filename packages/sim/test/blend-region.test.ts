// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * docs/AMENDMENTS.md A-37 — where the blend region is.
 *
 * The amendment is implemented and NOT applied: `'limb'` is the default and must
 * stay bit-for-bit what every number in `bench-results.json` was produced under.
 * These tests pin both halves — that opting out changes nothing, and that opting
 * in changes the specific thing the amendment says it changes.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { RigCalibration } from '../../calibration/src/index.ts';
import { coverageAndWeights } from '../src/coverage.ts';
import { latLonToWorld } from '../src/geometry.ts';
import { prepareRig } from '../src/optics.ts';
import { nominalBlend, nominalRig } from '../src/scene.ts';

const base = nominalRig({ projectorCount: 4 });

function rigWith(region?: 'limb' | 'sector'): RigCalibration {
  return { ...base, blend: { ...base.blend, ...(region ? { region } : {}) } };
}

function weightsAt(rig: RigCalibration, latDeg: number, lonDeg: number): number[] {
  const prepared = prepareRig(rig);
  return coverageAndWeights(latLonToWorld(latDeg, lonDeg, prepared.radiusM), prepared).weights;
}

test('a rig that never mentions the region serializes exactly as it did before the field existed', () => {
  // bench-results.json is what critics read. It must not gain a key because the
  // simulator grew an option nobody opted into.
  assert.equal('region' in nominalBlend(), false);
  assert.equal(JSON.stringify(nominalBlend()).includes('region'), false);
  assert.equal(nominalBlend({ region: 'sector' }).region, 'sector');
  assert.equal(nominalBlend({ region: 'limb' }).region, 'limb');
});

test('the default is the limb reading, and naming it explicitly changes nothing', () => {
  for (const [lat, lon] of [
    [0, 0],
    [0, 20],
    [0, 45],
    [0, 70],
    [30, 15],
    [55, 40],
    [-40, 60],
  ] as const) {
    const implicit = weightsAt(rigWith(), lat, lon);
    const explicit = weightsAt(rigWith('limb'), lat, lon);
    assert.deepEqual(implicit, explicit, `at ${lat},${lon}`);
  }
});

test('the limb reading really does leave a neighbour carrying a third of the signal at 20 degrees', () => {
  // The measurement A-37 rests on. Twenty degrees from P1's own centre meridian
  // is not a seam by any reading, and under the limb model the projector next
  // door is still doing more than a third of the work there.
  const w = weightsAt(rigWith('limb'), 0, 20);
  assert.ok(w[0] > 0.55 && w[0] < 0.7, `P1 carries ${w[0].toFixed(3)}`);
  assert.ok(w[1] > 0.3, `P2 should carry a third of the signal 20 degrees into P1's territory, got ${w[1].toFixed(3)}`);

  // And under the sector reading it carries none of it.
  const s = weightsAt(rigWith('sector'), 0, 20);
  assert.equal(s[0], 1, 'P1 should own its own sector outright');
  assert.equal(s[1], 0);
});

test('the sector reading crossfades at the seam and nowhere else', () => {
  const at = (lon: number): number[] => weightsAt(rigWith('sector'), 0, lon);

  // Inside P1's wedge, P1 alone.
  assert.deepEqual(at(0).slice(0, 2), [1, 0]);
  assert.deepEqual(at(30).slice(0, 2), [1, 0]);
  // At the seam between P1 and P2 they split it evenly.
  const seam = at(45);
  assert.ok(Math.abs(seam[0] - 0.5) < 1e-9, `P1 has ${seam[0]} at the seam`);
  assert.ok(Math.abs(seam[1] - 0.5) < 1e-9, `P2 has ${seam[1]} at the seam`);
  // Past it, P2 alone.
  assert.deepEqual(at(60).slice(0, 2), [0, 1]);

  // The crossfade is monotone across the band and confined to it. w_width is 20,
  // so the band is 35 to 55 degrees and nothing outside it is mixed.
  let previous = 1;
  for (let lon = 35; lon <= 55; lon += 2.5) {
    const w = at(lon)[0];
    assert.ok(w <= previous + 1e-12, `P1's weight rose from ${previous} to ${w} at ${lon}`);
    previous = w;
  }
});

test('weights sum to one under both readings, which is what §B clause 3 requires', () => {
  for (const region of ['limb', 'sector'] as const) {
    for (let lat = -60; lat <= 60; lat += 15) {
      for (let lon = 0; lon < 360; lon += 7) {
        const w = weightsAt(rigWith(region), lat, lon);
        const sum = w.reduce((a, b) => a + b, 0);
        const lit = sum > 0;
        assert.ok(
          !lit || Math.abs(sum - 1) < 1e-12,
          `${region} at ${lat},${lon} sums to ${sum} — a seam that does not sum to one is a bright or dark band`,
        );
      }
    }
  }
});

test('a sector still cannot claim light past its own limb', () => {
  // The wedge is bounded by what the projector can physically reach. Without the
  // clamp a two-projector rig would assert 180 degrees of coverage each and the
  // unlit polar region — PARAMETERS.md §4.3, four-lobed and scalloped — would
  // quietly vanish from the model.
  const two = { ...nominalRig({ projectorCount: 2 }) };
  const rig = { ...two, blend: { ...two.blend, region: 'sector' as const } };
  const prepared = prepareRig(rig);
  const pole = coverageAndWeights(latLonToWorld(89, 0, prepared.radiusM), prepared);
  assert.deepEqual(pole.lit, [false, false], 'the pole is outside every limb and must stay unlit');
  assert.equal(
    pole.weights.reduce((a, b) => a + b, 0),
    0,
  );
});
