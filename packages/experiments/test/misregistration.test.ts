// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Experiment 2 registration knob.
 *
 * The knob claims that rotating a projector about the polar axis by `epsilon`
 * displaces every texel it paints by exactly `R * epsilon * cos(lat)` of arc, in the
 * across-seam direction, and that alternating the sign around the rig makes every
 * adjacent pair disagree by the full `epsilon`. Experiment 2's entire x-axis is that
 * claim, so it is checked against `packages/sim`'s own geodesic measurement of where
 * the two projectors actually land the same texel — which reaches the same number
 * through the frustum, the distortion model and a ray-sphere intersection rather
 * than through the claim's trigonometry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRegistration,
  geodesicMm,
  latLonToWorld,
  nominalRig,
  placeTexelAt,
  prepareRig,
} from '../../sim/src/index.ts';
import {
  alternatingRotations,
  epsilonForMm,
  misregisteredRig,
  registrationMm,
  rotateProjectors,
} from '../src/photometric/misregistration.ts';

test('a zero rotation is the identity, to the last bit', () => {
  const rig = nominalRig();
  const same = rotateProjectors(rig, [0, 0, 0, 0]);
  assert.deepEqual(same.projectors, rig.projectors);
});

test('the knob is calibrated: sim measures back the millimetres that were asked for', () => {
  const content = nominalRig();
  for (const wantMm of [1, 4, 16, 64]) {
    const epsilonDeg = epsilonForMm(wantMm, content.sphere.radiusM);
    const physical = misregisteredRig(content, epsilonDeg);
    const registration = computeRegistration(physical, content, 'latitude', null, {
      sampleCount: 4000,
      fieldWidth: 8,
      fieldHeight: 4,
      convergence: false,
    });
    // The maximum over the overlap is the equatorial value: the displacement falls as
    // cos(lat), so nowhere on the sphere exceeds it and the seam tracks reach it.
    assert.ok(
      Math.abs(registration.overlap.max - wantMm) < wantMm * 0.01,
      `asked for ${wantMm} mm, sim measured ${registration.overlap.max.toFixed(4)} mm`,
    );
  }
});

test('the displacement falls as cos(lat), as the closed form says', () => {
  const content = nominalRig();
  const epsilonDeg = epsilonForMm(16, content.sphere.radiusM);
  const physical = misregisteredRig(content, epsilonDeg);
  const physicalPrepared = prepareRig(physical);
  const contentPrepared = prepareRig(content);

  for (const latDeg of [0, 25, 50]) {
    // Projector 0 and projector 1 both reach longitude 45 at these latitudes.
    const intended = latLonToWorld(latDeg, 45, content.sphere.radiusM);
    const a = placeTexelAt(latDeg, 45, physicalPrepared, contentPrepared, 0);
    const b = placeTexelAt(latDeg, 45, physicalPrepared, contentPrepared, 1);
    assert.ok(a.landed !== null && b.landed !== null, `no landing at lat ${latDeg}`);
    const measured = geodesicMm(a.landed, b.landed, content.sphere.radiusM);
    const predicted = Math.abs(registrationMm(epsilonDeg, content.sphere.radiusM, latDeg));
    assert.ok(
      Math.abs(measured - predicted) < predicted * 0.02,
      `lat ${latDeg}: measured ${measured.toFixed(4)} mm, closed form ${predicted.toFixed(4)} mm`,
    );
    // And each projector is displaced by half of it, in opposite directions.
    const half = geodesicMm(a.landed, intended, content.sphere.radiusM);
    assert.ok(
      Math.abs(half - predicted / 2) < predicted * 0.02,
      `lat ${latDeg}: one projector moved ${half.toFixed(4)}, expected ${(predicted / 2).toFixed(4)}`,
    );
  }
});

test('the alternating pattern gives every ADJACENT pair the full epsilon', () => {
  const pattern = alternatingRotations(4, 2);
  assert.deepEqual(pattern, [1, -1, 1, -1]);
  // Projectors sit at azimuths 0, 90, 180, 270, so adjacency wraps round.
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    assert.equal(Math.abs(pattern[i] - pattern[j]), 2);
  }
});

test('rotateProjectors refuses a mismatched angle count rather than padding it', () => {
  assert.throws(() => rotateProjectors(nominalRig(), [1, 2]), /one angle per projector/);
});
