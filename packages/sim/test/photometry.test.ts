// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * conventions.ts §P's transfer curve and PARAMETERS.md §3.2's per-channel model.
 *
 * §3.2's worked example is the closest thing the spec has to a unit test it wrote
 * for itself, and it is carried all the way through here: from the encoded 0.730,
 * through twelve divergent transfer terms, through the sphere's reflectance, into
 * CIE Lab, and out as a ΔE2000 against PARAMETERS.md §7's seam-chromaticity gate.
 * The spec stops at "a 6% blue deficit ... reads as a yellow band"; the number that
 * matters for a gate is what that is worth in ΔE2000, and it is 3.5 against a gate
 * of 1.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNELS,
  channelMatchedTransferSet,
  divergentTransferSet,
  emittedBlackUpliftRatio,
  emittedRadiance,
  emittedRadianceRgb,
  encodedSignalFor,
  nominalTransfer,
  nominalTransferSet,
  observedBlackUpliftRatio,
  overlapWhiteSum,
  summariseTransfers,
  whitePointOfTransfer,
} from '../src/photometry.ts';
import { deltaE2000, linearRgbToLab, relativeLuminance } from '../src/color.ts';
import { blendedSignal } from '../src/render.ts';

const ENCODE = { r: 2.2, g: 2.2, b: 2.2 };
const RHO = { r: 0.9, g: 0.9, b: 0.88 };

test('§P: L = gain * ((1 - blackFloor) * V^gamma + blackFloor)', () => {
  // Black in, black floor out — the mechanism behind every overlap artifact in dark
  // content, which §10 ranks the second highest photometric risk.
  assert.ok(Math.abs(emittedRadiance(0, 2.2, 1 / 800, 1) - 1 / 800) < 1e-15);
  // White in, full output out, regardless of the floor. This is what the (1 - b)
  // factor buys and it is what keeps the Radiometry convention's definition of 1.0
  // true.
  assert.ok(Math.abs(emittedRadiance(1, 2.2, 1 / 800, 1) - 1) < 1e-15);
  assert.ok(Math.abs(emittedRadiance(1, 2.2, 1 / 300, 1) - 1) < 1e-15);
  // Gain scales everything, including the floor.
  assert.ok(Math.abs(emittedRadiance(0, 2.2, 1 / 800, 0.5) - 0.5 / 800) < 1e-15);
  // Out-of-range signals clamp rather than producing NaN from a negative base.
  assert.ok(Number.isFinite(emittedRadiance(-0.5, 2.2, 0, 1)));
  assert.equal(emittedRadiance(2, 2.2, 0, 1), 1);
  // Monotone in V.
  let prev = -1;
  for (let v = 0; v <= 1.0001; v += 0.01) {
    const l = emittedRadiance(Math.min(v, 1), 2.2, 1 / 800, 1);
    assert.ok(l > prev);
    prev = l;
  }
});

test('§P inverts exactly, and refuses targets the projector cannot reach', () => {
  for (const gamma of [1.9, 2.2, 2.5]) {
    for (const floor of [0, 1 / 2000, 1 / 800, 1 / 300]) {
      for (const gain of [0.85, 1, 1.15]) {
        for (const v of [0, 0.25, 0.7297, 1]) {
          const l = emittedRadiance(v, gamma, floor, gain);
          const back = encodedSignalFor(l, gamma, floor, gain);
          assert.ok(Math.abs(back - v) < 1e-12, `round trip ${v} -> ${l} -> ${back}`);
        }
      }
    }
  }
  // Below the leak and above full output there is no answer, and NaN says so.
  assert.ok(Number.isNaN(encodedSignalFor(0.0001, 2.2, 1 / 800, 1)));
  assert.ok(Number.isNaN(encodedSignalFor(1.5, 2.2, 1 / 800, 1)));
  assert.ok(Number.isNaN(encodedSignalFor(0.5, 2.2, 1 / 800, 0)));
});

test('§3.2: a divergent blue gamma produces the 6% blue deficit the spec predicts', () => {
  // "In an overlap each projector should contribute 0.5 linear, encoded as
  // 0.5^(1/gamma) = 0.730 at gamma=2.2. If that projector's blue channel runs
  // gamma=2.4, blue emits 0.730^2.4 = 0.469 per projector, summing to 0.938 against
  // 1.000 in red — a 6% blue deficit."
  //
  // The compositor still encodes assuming 2.2 — that is the whole point, it does
  // not know — so the encode gamma and the transfer gamma differ.
  const signal = blendedSignal({ r: 1, g: 1, b: 1 }, 0.5, ENCODE);
  assert.ok(Math.abs(signal.b - 0.7297) < 0.0005, `encoded ${signal.b}, spec says 0.730`);

  const divergent = nominalTransfer({
    gamma: { r: 2.2, g: 2.2, b: 2.4 },
    // Zero the black floor so the 6% figure is not contaminated by the uplift; the
    // spec's arithmetic ignores it too.
    blackFloor: { r: 0, g: 0, b: 0 },
  });
  const emitted = emittedRadianceRgb(signal, divergent);
  assert.ok(Math.abs(emitted.b - 0.4695) < 0.001, `blue emitted ${emitted.b}, spec says 0.469`);
  assert.ok(Math.abs(emitted.r - 0.5) < 1e-9);

  const sumR = 2 * emitted.r;
  const sumB = 2 * emitted.b;
  assert.ok(Math.abs(sumR - 1) < 1e-9);
  assert.ok(Math.abs(sumB - 0.9389) < 0.002, `blue summed to ${sumB}, spec says 0.938`);
  const deficit = 1 - sumB / sumR;
  assert.ok(
    Math.abs(deficit - 0.061) < 0.003,
    `blue deficit came out ${(deficit * 100).toFixed(1)}%, spec says about 6%`,
  );

  // And the point §3.2 is making: OUTSIDE the overlap, where one projector emits
  // full signal, there is no deficit at all. The error appears only where the blend
  // is active, which is why it reads as a band rather than an overall colour cast.
  const full = emittedRadianceRgb(blendedSignal({ r: 1, g: 1, b: 1 }, 1, ENCODE), divergent);
  assert.ok(Math.abs(full.b - full.r) < 1e-9, 'no chromatic error away from the seam');
});

test('§3.2 carried through the colour path: the yellow band is dE2000 3.5 against a gate of 1.0', () => {
  // The step the spec stops short of. A 6% blue deficit is a number; whether it
  // matters is a question about §7's gate, and §7's gate is in dE2000.
  const signal = blendedSignal({ r: 1, g: 1, b: 1 }, 0.5, ENCODE);
  const divergent = nominalTransfer({
    gamma: { r: 2.2, g: 2.2, b: 2.4 },
    blackFloor: { r: 0, g: 0, b: 0 },
  });
  const perProjector = emittedRadianceRgb(signal, divergent);
  const seamEmitted = {
    r: 2 * perProjector.r,
    g: 2 * perProjector.g,
    b: 2 * perProjector.b,
  };
  // Off the seam, one projector at full signal.
  const surroundEmitted = emittedRadianceRgb(blendedSignal({ r: 1, g: 1, b: 1 }, 1, ENCODE), divergent);

  // Through PARAMETERS.md §1's paint. Both points are at the same incidence and the
  // same distance for the purposes of this arithmetic, so the geometry cancels and
  // what is left is exactly the chromatic error.
  const seam = { r: seamEmitted.r * RHO.r, g: seamEmitted.g * RHO.g, b: seamEmitted.b * RHO.b };
  const surround = {
    r: surroundEmitted.r * RHO.r,
    g: surroundEmitted.g * RHO.g,
    b: surroundEmitted.b * RHO.b,
  };

  const dE = deltaE2000(linearRgbToLab(seam, RHO), linearRgbToLab(surround, RHO));
  assert.ok(Math.abs(dE - 3.472) < 0.01, `the yellow band is dE2000 ${dE.toFixed(3)}`);
  assert.ok(dE > 1.0, "and 1.0 is §7's seam-chromaticity gate, so it FAILS by 3.5x");

  // The luminance half of the same artifact is under half a percent, because blue
  // carries only 7.2% of the luminance. That asymmetry is the reason §7 gates
  // chromaticity separately: a luminance-only seam metric would call this seam
  // clean, and §3.2 says the eye is MORE sensitive to a chromatic edge than to a
  // luminance one.
  const luminanceFraction = 1 - relativeLuminance(seam) / relativeLuminance(surround);
  assert.ok(luminanceFraction < 0.005, `luminance deficit only ${luminanceFraction}`);
  assert.ok(luminanceFraction < 0.02, "and it passes §7's 2% luminance gate while failing chroma");

  // The band is yellow, not blue: the deficit is IN blue, so what is left is red
  // plus green. Positive Lab b* is yellow.
  const seamLab = linearRgbToLab(seam, RHO);
  assert.ok(seamLab.b > 1, `seam b* is ${seamLab.b}, i.e. yellow, exactly as §3.2 says`);
});

test('the overlap white sum is 1 + (n-1)*blackFloor, not 1 + n*blackFloor', () => {
  // Summing §P over n projectors whose normalized weights total 1:
  //   sum = (1 - b) * SUM(w_i) + n*b = 1 + (n - 1) * b
  // The (1 - b) factor scales the signal down by exactly the one floor a single
  // projector already carries. Off by one here is a 0.125% seam step reported as
  // 0.25%, and both look fine on screen.
  const b = 1 / 800;
  assert.ok(Math.abs(overlapWhiteSum(2, b) - 1.00125) < 1e-15);
  assert.ok(Math.abs(overlapWhiteSum(1, b) - 1) < 1e-15);

  // Checked against the actual transfer rather than against the algebra: two
  // projectors at weight 0.5 each, encoded at the matching gamma.
  const t = nominalTransfer();
  const half = blendedSignal({ r: 1, g: 1, b: 1 }, 0.5, ENCODE);
  const sum = 2 * emittedRadianceRgb(half, t).r;
  assert.ok(Math.abs(sum - overlapWhiteSum(2, b)) < 1e-12, `measured ${sum}`);
  assert.ok(sum > 1, 'the black floor makes the overlap slightly BRIGHTER than unity');

  // Three weights that total one give the same answer as two, which is the content
  // of the "(n-1)" claim — it depends on the count, not on how the weight is split.
  const thirds = blendedSignal({ r: 1, g: 1, b: 1 }, 1 / 3, ENCODE);
  const sum3 = 3 * emittedRadianceRgb(thirds, t).r;
  assert.ok(Math.abs(sum3 - overlapWhiteSum(3, b)) < 1e-12, `three-way sum ${sum3}`);
});

test('the black uplift ratio is exactly n before ambient, and finite after it', () => {
  // In dark content every projector emits gain*blackFloor, so n of them emit n
  // times as much as one. There is no black floor and no gain for which this is
  // anything other than n — so as a gate against §7's 1.20 it is a constant, and a
  // metric that reported it alone would be reporting the projector count.
  assert.equal(emittedBlackUpliftRatio(2), 2);
  for (const floor of [1 / 2000, 1 / 800, 1 / 300]) {
    for (const gain of [0.85, 1.15]) {
      const one = emittedRadiance(0, 2.2, floor, gain);
      assert.ok(Math.abs((2 * one) / one - 2) < 1e-12);
    }
  }

  // Ambient is what makes it finite. At §5's nominal E_amb = 0.04 and a black floor
  // delivered at the seam, the observed ratio is a couple of percent — comfortably
  // inside §7's 1.20. Which of the two readings §7 meant decides whether the gate
  // is passable at all.
  const delivered = (1 / 800) * 0.53; // one floor, at the seam's incidence and falloff
  const observed = observedBlackUpliftRatio(0.04, 2 * delivered, delivered);
  assert.ok(observed > 1 && observed < 1.05, `observed ratio ${observed}`);
  assert.ok(observed < 1.2, "passes §7's gate — because of the room, not the projectors");
  // Turn the room lights off and it is 2.0 again.
  assert.ok(Math.abs(observedBlackUpliftRatio(0, 2 * delivered, delivered) - 2) < 1e-12);
  // The gate's sensitivity to E_amb, in one line: a fifteen-fold darker room.
  const dark = observedBlackUpliftRatio(0.01, 2 * delivered, delivered);
  assert.ok(dark > observed, 'a darker room makes the uplift MORE visible, not less');
});

test('transfer sets: twelve values per term, and no divergence unless it is asked for', () => {
  const nominal = nominalTransferSet(4);
  const summary = summariseTransfers(nominal);
  assert.equal(summary.projectorCount, 4);
  assert.equal(summary.valuesPerTerm, 12, "§3.2's 12 values across the rig");
  assert.equal(summary.channelMatched, true);
  assert.equal(summary.gamma.distinct, 1);
  assert.equal(summary.gamma.spread, 0);
  assert.equal(summary.blackFloor.spread, 1, 'a ratio, so 1 means identical');
  assert.equal(summary.gain.spread, 0);

  // The default really is nominal: asking for divergence with no magnitudes gives
  // back the nominal set, not a plausible-looking guess.
  const undiverged = divergentTransferSet(4);
  assert.deepEqual(undiverged, nominal);

  // With magnitudes it diverges, deterministically, inside the stated bounds.
  const spread = 0.3; // §3.2: "Real projectors diverge 0.1-0.3 between channels."
  const a = divergentTransferSet(4, { gammaSpread: spread, blackFloorFactor: 2.7, gainSpread: 0.2, seed: 7 });
  const b = divergentTransferSet(4, { gammaSpread: spread, blackFloorFactor: 2.7, gainSpread: 0.2, seed: 7 });
  assert.deepEqual(a, b, 'same seed, same set — every render is a pure function of its seed');
  const c = divergentTransferSet(4, { gammaSpread: spread, blackFloorFactor: 2.7, gainSpread: 0.2, seed: 8 });
  assert.notDeepEqual(a, c, 'a different seed must give a different set');

  const diverged = summariseTransfers(a);
  assert.equal(diverged.channelMatched, false);
  assert.equal(diverged.gamma.distinct, 12);
  assert.ok(diverged.gamma.spread > 0 && diverged.gamma.spread <= spread + 1e-12);
  assert.ok(diverged.gamma.min >= 2.2 - spread / 2 - 1e-12);
  assert.ok(diverged.gamma.max <= 2.2 + spread / 2 + 1e-12);
  // The black floor is drawn log-uniformly, so the spread is a ratio and the floor
  // can never go negative — the plausible range in §3.2 is stated as a ratio too.
  assert.ok(diverged.blackFloor.min > 0);
  assert.ok(diverged.blackFloor.spread > 1 && diverged.blackFloor.spread <= 2.7 * 2.7 + 1e-9);
  for (const t of a) for (const ch of CHANNELS) assert.ok(t.blackFloor[ch] > 0);
});

test('the channel-matched counterfactual really is matched, and preserves projector 0 red', () => {
  const diverged = divergentTransferSet(4, {
    gammaSpread: 0.3,
    blackFloorFactor: 2.0,
    gainSpread: 0.2,
    seed: 1234,
  });
  const matched = channelMatchedTransferSet(diverged);
  assert.equal(summariseTransfers(matched).channelMatched, true);
  for (const t of matched) {
    for (const ch of CHANNELS) {
      assert.equal(t.gamma[ch], diverged[0].gamma.r);
      assert.equal(t.blackFloor[ch], diverged[0].blackFloor.r);
      assert.equal(t.gain[ch], diverged[0].gain.r);
    }
  }
  // Matching an already-matched set is the identity.
  assert.deepEqual(channelMatchedTransferSet(nominalTransferSet(4)), nominalTransferSet(4));
  assert.throws(() => channelMatchedTransferSet(diverged, 9), /no projector at index 9/);
});

test("§3.2's wp_i is derived from the gains, and unit gain is D65-ish", () => {
  // "White point (CCT) ... Derived from g; tracked separately for reporting."
  const unit = whitePointOfTransfer(nominalTransfer());
  // Unit gain through Rec.709/D65 primaries IS D65, whose CCT is about 6504 K.
  assert.ok(Math.abs(unit.x - 0.3127) < 0.001, `x = ${unit.x}`);
  assert.ok(Math.abs(unit.y - 0.329) < 0.001, `y = ${unit.y}`);
  assert.ok(Math.abs(unit.cctK - 6504) < 60, `CCT = ${unit.cctK}`);

  // A rig whose blue lamp has aged reports a warmer white — which is the mechanism
  // §3.2 describes as "four lamps at different hour counts give four different
  // white points", and it is visible in the reported CCT without anybody measuring
  // a spectrum.
  const agedBlue = whitePointOfTransfer(nominalTransfer({ gain: { r: 1, g: 1, b: 0.85 } }));
  assert.ok(agedBlue.cctK < unit.cctK - 500, `aged blue reports ${agedBlue.cctK} K`);

  // The stored whitePointK is reported, not applied: it does not move when the
  // gains do, which is exactly the over-specification a report should be able to
  // notice.
  assert.equal(nominalTransfer({ gain: { r: 1, g: 1, b: 0.85 } }).whitePointK, 6500);
});
