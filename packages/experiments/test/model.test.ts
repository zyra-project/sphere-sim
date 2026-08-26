// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The parameter-to-model mapping, and the two sweep helpers whose arithmetic decides
 * what Experiments 2 and 3 report.
 *
 * The first two tests exist because of the same failure mode: a constant that never
 * reaches the model reports a sensitivity of zero, and there is nothing in the output
 * to distinguish that from a constant that genuinely does not matter. So every id the
 * experiment sweeps must be applicable, an unknown id must throw rather than be
 * ignored, and the one id the model deliberately does NOT apply — the compositor's
 * assumed gamma, which is what makes PARAMETERS.md §3.2's artifact possible — has to
 * stay unapplied on purpose and be asserted so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASSUME_PHOTOMETRIC_IDS, PARAMETER_TABLE } from '../../calibration/src/parameters.ts';
import { relativeLuminance } from '../../sim/src/index.ts';
import { APPLIED_IDS, buildModel } from '../src/photometric/model.ts';
import { levelsFor, measureResponses, RESPONSES } from '../src/photometric/experiment3.ts';
import { logLogSlope, thresholdCrossing } from '../src/photometric/experiment2.ts';

test('every constant Experiment 3 sweeps is one buildModel can apply', () => {
  for (const id of ASSUME_PHOTOMETRIC_IDS) {
    assert.ok(APPLIED_IDS.includes(id), `${id} is swept but never reaches the model`);
    assert.ok(PARAMETER_TABLE[id] !== undefined, `${id} is not in PARAMETER_TABLE`);
  }
});

test('an unknown id throws instead of being silently ignored', () => {
  assert.throws(() => buildModel({ gamma_b: 2.4 }), /cannot apply/);
  assert.throws(() => buildModel({ d_proj: 6 }), /cannot apply/);
});

test('the defaults are PARAMETERS.md nominals, read from the table rather than restated', () => {
  const built = buildModel({});
  assert.equal(built.rig.blend.widthDeg, PARAMETER_TABLE.w_width.nominal);
  assert.equal(built.rig.blend.rampGamma, PARAMETER_TABLE.gamma_blend.nominal);
  assert.equal(built.rig.projectors[0].transfer.gamma.b, PARAMETER_TABLE.gamma_B.nominal);
  assert.equal(built.scene.reflectance.b, PARAMETER_TABLE.rho_B.nominal);
  for (const id of APPLIED_IDS) assert.equal(built.applied[id], PARAMETER_TABLE[id].nominal);
});

test('sweeping a projector gamma moves the DISPLAY, never the compositor', () => {
  const built = buildModel({ gamma_B: 2.4 });
  for (const p of built.rig.projectors) assert.equal(p.transfer.gamma.b, 2.4);
  // §3.2's worked example is precisely the case where the two differ. If the
  // compositor's assumed encode gamma tracked the projector's, the rig would be
  // perfectly corrected by construction and the sweep would report that the single
  // highest-risk constant in §10 does not matter.
  assert.equal(built.scene.encodeGamma.b, 2.2);
  assert.equal(built.scene.encodeGamma.r, 2.2);
});

test('the ambient sweep changes the colour of the light without changing how much', () => {
  const level = PARAMETER_TABLE.E_amb.nominal;
  const warm = buildModel({ E_amb_chroma: 2700 }).scene.ambient;
  const cool = buildModel({ E_amb_chroma: 6500 }).scene.ambient;
  // To a part in ten thousand, which is the accuracy of the published RGB<->XYZ
  // matrix pair's round trip and not a property of the tint. §5's `E_amb` and
  // `E_amb_chroma` have to be separable or the sensitivity of one is the other's.
  assert.ok(
    Math.abs(relativeLuminance(warm) - level) < level * 1e-4,
    `warm ambient carries ${relativeLuminance(warm)}`,
  );
  assert.ok(
    Math.abs(relativeLuminance(cool) - level) < level * 1e-4,
    `cool ambient carries ${relativeLuminance(cool)}`,
  );
  assert.notEqual(warm.b, cool.b);
});

test('a mask that closes before it opens is refused', () => {
  assert.throws(() => buildModel({ mask_lo: 70, mask_hi: 60 }), /mask_hi/);
});

test('levels are logarithmic where the range spans decades, and always include the nominal', () => {
  const ambient = levelsFor(PARAMETER_TABLE.E_amb, 5);
  assert.equal(ambient[0], PARAMETER_TABLE.E_amb.min);
  assert.equal(ambient[ambient.length - 1], PARAMETER_TABLE.E_amb.max);
  assert.ok(ambient.includes(PARAMETER_TABLE.E_amb.nominal));
  // Log spacing puts the geometric mean in the middle of the five original levels;
  // linear spacing would put the arithmetic mean there.
  const geometric = Math.sqrt(PARAMETER_TABLE.E_amb.min * PARAMETER_TABLE.E_amb.max);
  assert.ok(ambient.some((v) => Math.abs(v - geometric) < geometric * 1e-9));

  const gamma = levelsFor(PARAMETER_TABLE.gamma_B, 5);
  assert.ok(Math.abs(gamma[2] - (gamma[1] + gamma[3]) / 2) < 1e-12, 'a 1.3x range is swept linearly');
});

test('every declared response is actually produced', () => {
  const responses = measureResponses({});
  for (const spec of RESPONSES) {
    assert.ok(spec.id in responses, `${spec.id} is declared but never measured`);
    assert.ok(Number.isFinite(responses[spec.id]), `${spec.id} is ${responses[spec.id]}`);
  }
});

test('thresholdCrossing inverts a power law exactly', () => {
  // y = 0.005 * x, so y crosses 0.02 at x = 4 — a value deliberately BETWEEN two
  // sweep points, because the crossing is what the contour plot draws.
  const xs = [1, 2, 8, 16];
  const ys = xs.map((x) => 0.005 * x);
  assert.ok(Math.abs(thresholdCrossing(xs, ys, 0.02) - 4) < 1e-9);
  assert.equal(thresholdCrossing(xs, ys, 0.001), 0, 'already over at the smallest sample');
  assert.equal(thresholdCrossing(xs, ys, 1), Infinity, 'never reached inside the sweep');
  assert.ok(Math.abs(logLogSlope(xs, ys) - 1) < 1e-12);
  assert.ok(Math.abs(logLogSlope(xs, xs.map((x) => x * x)) - 2) < 1e-12);
});
