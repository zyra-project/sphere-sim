// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * conventions.ts §B's ramp algebra, and PARAMETERS.md §4.5's arithmetic about the
 * one DOC-class photometric constant in the whole document.
 *
 * The §4.5 test is the interesting one. It reproduces the calculation the spec uses
 * to REJECT an explanation — "ambient light explains the blend gamma of 0.8" — and
 * a calculation that rejects a hypothesis is worth pinning at least as firmly as
 * one that supports it, because it is the kind that quietly gets re-litigated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RAMP_SHAPES,
  continuityEncodedValue,
  crossfadeSum,
  crossfadeWeight,
  displayGammaImpliedByBlendGamma,
  normalizeWeights,
  rampValue,
  rampWeight,
} from '../src/blend.ts';
import type { RampShape } from '../src/blend.ts';
import { emittedRadiance } from '../src/photometry.ts';

test('§B: every ramp shape runs 0 to 1, monotonically, and clamps outside', () => {
  for (const shape of RAMP_SHAPES) {
    assert.ok(Math.abs(rampValue(shape, 0)) < 1e-15, `${shape} must be 0 at t=0`);
    assert.ok(Math.abs(rampValue(shape, 1) - 1) < 1e-15, `${shape} must be 1 at t=1`);
    assert.equal(rampValue(shape, -0.5), rampValue(shape, 0), `${shape} must clamp below 0`);
    assert.equal(rampValue(shape, 1.5), rampValue(shape, 1), `${shape} must clamp above 1`);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = rampValue(shape, t);
      assert.ok(v >= prev - 1e-12, `${shape} dipped at t=${t}`);
      prev = v;
    }
  }
  // The gaussian is the one that needs its endpoints forced: the raw
  // exp(-4.5*(1-t)^2) is 0.0111 at t=0, which would leak 1% of full signal past
  // every projector's footprint edge and read as a rectangular halo in dark content.
  assert.ok(Math.abs(Math.exp(-4.5) - 0.011109) < 1e-5, 'the unnormalized value this fixes');
  assert.ok(Math.abs(rampValue('gaussian', 0)) < 1e-15);
  // Linear, cosine and smoothstep are all 0.5 at the midpoint; the gaussian is not.
  assert.ok(Math.abs(rampValue('linear', 0.5) - 0.5) < 1e-15);
  assert.ok(Math.abs(rampValue('cosine', 0.5) - 0.5) < 1e-15);
  assert.ok(Math.abs(rampValue('smoothstep', 0.5) - 0.5) < 1e-15);
  assert.ok(Math.abs(rampValue('gaussian', 0.5) - 0.5) > 0.05, 'the gaussian is asymmetric');
});

test('§B: rampGamma applies to the WEIGHT, and normalization makes it sum to one anyway', () => {
  // The pair of clauses that look contradictory and are not. Raising the weights to
  // 0.8 changes them individually — at the midpoint of a linear ramp each goes from
  // 0.5 to 0.574 — so the raw sum is 1.149 rather than 1.
  const raw = crossfadeSum('linear', 0.8, 0.5);
  assert.ok(Math.abs(raw - 1.1486983549970349) < 1e-12, `raw crossfade sum ${raw}`);
  assert.ok(Math.abs(crossfadeSum('linear', 1, 0.5) - 1) < 1e-15, 'gamma 1 needs no fixing');
  for (let t = 0; t <= 1.0001; t += 0.05) {
    assert.ok(Math.abs(crossfadeSum('linear', 1, Math.min(t, 1)) - 1) < 1e-12);
  }

  // ...and after §B's normalization the sum is exactly one at every position and
  // for every exponent. So no ramp exponent can create or remove a luminance step
  // on its own — which is the reason §4.5's "0.8 corrects the seam" reading cannot
  // be what §B's rampGamma does.
  for (const shape of RAMP_SHAPES) {
    for (const gamma of [0.5, 0.8, 1, 1.5]) {
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const x = Math.min(t, 1);
        const a = crossfadeWeight(shape, gamma, x);
        const b = crossfadeWeight(shape, gamma, 1 - x);
        assert.ok(Math.abs(a + b - 1) < 1e-12, `${shape} gamma ${gamma} at t=${x} summed ${a + b}`);
      }
    }
  }

  // The exponent DOES change the shape of the crossfade, which is the part that
  // matters for Experiment 2. Below 1 it pushes weight toward the outgoing
  // projector; above 1 it pulls it toward the incoming one.
  const soft = crossfadeWeight('linear', 0.8, 0.25);
  const hard = crossfadeWeight('linear', 1.5, 0.25);
  assert.ok(soft > crossfadeWeight('linear', 1, 0.25));
  assert.ok(hard < crossfadeWeight('linear', 1, 0.25));

  // A non-positive exponent is rejected rather than silently producing full weight
  // everywhere, because Math.pow(0, 0) is 1.
  assert.throws(() => rampWeight('linear', 0.5, 0), /rampGamma/);
  assert.throws(() => rampWeight('linear', 0.5, -1), /rampGamma/);
  assert.equal(rampWeight('linear', 0, 0.8), 0, 'zero weight must stay zero at any exponent');
});

test('§B: normalization leaves an all-zero weight set alone', () => {
  const w = [0, 0, 0, 0];
  assert.equal(normalizeWeights(w), 0);
  assert.deepEqual(w, [0, 0, 0, 0]);

  const v = [1, 3];
  assert.equal(normalizeWeights(v), 4);
  assert.deepEqual(v, [0.25, 0.75]);
});

test('§4.5: an additive floor moves the continuity value by 2%, so ambient is not the explanation', () => {
  // "For two projectors to sum to unity in the overlap, each must emit 0.5 linear,
  // encoded as 0.5^(1/gamma)." At gamma 2.2 that is 0.730.
  const noFloor = continuityEncodedValue(2.2, 0);
  assert.ok(Math.abs(noFloor - 0.7297400528) < 1e-9, `no-floor value ${noFloor}`);
  assert.ok(Math.abs(noFloor - Math.pow(0.5, 1 / 2.2)) < 1e-15, 'must equal 0.5^(1/gamma)');

  // §4.5: "Including an additive floor f, continuity requires V^gamma =
  // (1-2f)/(2(1-f)); at gamma 2.2 and a generous f=0.05 this gives V=0.716 against
  // 0.730 with no floor at all. A 2% shift. Ambient is not the explanation."
  //
  // Evaluating the spec's own formula at the spec's own f = 0.05 gives 0.7120, not
  // 0.716. The stated 0.716 is what the formula gives at f = 0.04 — which is
  // exactly §5's nominal E_amb. So the sentence's "generous f = 0.05" and its
  // quoted result do not correspond, and the quoted result is the NOMINAL ambient
  // rather than a generous one. Recorded as docs/AMENDMENTS.md A-14; both are
  // asserted here so the discrepancy cannot silently drift either way.
  const atFivePercent = continuityEncodedValue(2.2, 0.05);
  const atFourPercent = continuityEncodedValue(2.2, 0.04);
  assert.ok(Math.abs(atFivePercent - 0.7120245343) < 1e-9, `f=0.05 gives ${atFivePercent}`);
  assert.ok(Math.abs(atFourPercent - 0.7157587003) < 1e-9, `f=0.04 gives ${atFourPercent}`);
  assert.ok(Math.abs(atFourPercent - 0.716) < 0.0005, "f=0.04 is the spec's quoted 0.716");

  // The conclusion is unaffected by which of the two the spec meant: both are a
  // shift of about 2%, and §4.5's 0.8 would need a shift of 76%.
  const shiftFive = 1 - atFivePercent / noFloor;
  const shiftFour = 1 - atFourPercent / noFloor;
  assert.ok(shiftFive > 0.019 && shiftFive < 0.025, `f=0.05 shift ${shiftFive}`);
  assert.ok(shiftFour > 0.015 && shiftFour < 0.021, `f=0.04 shift ${shiftFour}`);
  assert.ok(
    Math.abs(1 - 0.8 / noFloor) > 0.09,
    'and 0.8 is nowhere near 0.730, which is the point §4.5 is making',
  );

  // The formula really is a continuity condition: feed its output back through
  // conventions.ts §P for two projectors and the overlap sums to exactly one.
  for (const f of [0, 0.01, 0.04, 0.05, 0.2]) {
    const v = continuityEncodedValue(2.2, f);
    const sum = 2 * emittedRadiance(v, 2.2, f, 1);
    assert.ok(Math.abs(sum - 1) < 1e-12, `floor ${f} summed to ${sum}`);
  }

  // Floors that already exceed unity have no solution, and the function says so
  // rather than returning a complex root as NaN by accident.
  assert.ok(Number.isNaN(continuityEncodedValue(2.2, 0.6)));
});

test("§4.5's reading of gamma_blend = 0.8 as an inverse display gamma", () => {
  // "An exponent of 0.8 implies an effective display transfer of gamma ~ 1.25."
  assert.ok(Math.abs(displayGammaImpliedByBlendGamma(0.8) - 1.25) < 1e-12);
  // Which is nothing like 2.2, and nothing like the 0.4545 an inverse of 2.2 would
  // be. §4.5's two surviving explanations — a projector running a flat
  // high-brightness curve, or an empirical shaping constant — both live in that gap.
  assert.ok(Math.abs(1 / 2.2 - 0.4545) < 0.001);
  assert.ok(displayGammaImpliedByBlendGamma(1 / 2.2) === 2.2);
});

test('an unrecognised ramp shape is refused, not turned into NaN', () => {
  // `rampValue`'s switch had no default, so a shape the type system never saw --
  // a rig loaded from JSON with a typo, or written by an older version -- fell
  // out of it as `undefined`. Every weight became NaN, `normalizeWeights` left
  // them alone because `sum > 0` is false for NaN, and coverage, registration
  // and photometry all came back NaN with nothing raised anywhere.
  assert.throws(() => rampValue('cos' as RampShape, 0.5), /unknown rampShape/);
  assert.throws(() => rampWeight('COSINE' as RampShape, 0.5, 0.8), /unknown rampShape/);
  // And the shapes that exist are untouched.
  for (const shape of RAMP_SHAPES) {
    const v = rampValue(shape, 0.5);
    assert.ok(Number.isFinite(v), `${shape} at t=0.5 is not finite`);
  }
});
