// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * End to end: pattern images in, `RigCalibration` out.
 *
 * Everything upstream is tested in isolation; what this file adds is the joint,
 * which is where a convention gets applied twice or not at all. The camera
 * resolution is deliberately small — the point is the pipeline, and a 12
 * megapixel frame proves nothing extra while costing gigabytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solve, bundleStateFromCalibration, nominalRig } from '../src/index.ts';
import { NOMINAL_SILHOUETTE_MARGIN_FRAC } from '../../calibration/src/conventions.ts';
import type { BundleState, FloorReference } from '../src/bundle.ts';
import {
  alignToTruth,
  makeScene,
  renderAllCaptures,
  scoreRecovery,
} from './synthetic.ts';

const SMALL = { cameraRes: { x: 160, y: 120 }, cameraCount: 2 };

/**
 * Four independent fields of view — the model this fixture's truth actually has.
 *
 * `makeScene` jitters each projector's `fovHDeg` independently, because four
 * zoom rings are set one at a time by the Red Ball procedure against four
 * slightly different lens distances. The shipped default ties them
 * (docs/AMENDMENTS.md A-35: one install, one projector model), so on a NOISELESS
 * fixture whose fields differ the tie is the only error left in the residual —
 * and these tests are about the pipeline and the bootstrap, not about the tie.
 *
 * What the tie costs is measured on purpose in `bundle.test.ts` ("the
 * shared-lens tie costs what the spread costs"), and on the bench's own corpus
 * it converges on every scenario at both seeds round 4 ran. Here, with nothing
 * else in the residual, the fit plateaus against its own model error and the
 * optimiser correctly reports a stall rather than convergence — which is
 * `bundle.ts` behaving as documented, not a reason to loosen an assertion.
 */
const FOUR_LENSES = { bundle: { tieProjectorFov: false } };

test('solve() recovers the rig from rendered structured-light images', () => {
  const scene = makeScene(31, SMALL);
  const captures = renderAllCaptures(scene.truth, { noiseSigma: 0 });
  const floor: FloorReference[] = scene.truth.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM: p.position.z + scene.truth.centerHeightM,
    sigmaM: 0.002,
  }));

  const res = solve({
    nominal: scene.nominal,
    cameras: scene.cameraInputs,
    captures,
    floorReferences: floor,
    options: FOUR_LENSES,
  });

  assert.ok(res.extra.decode.accepted > 1000, `decoded ${res.extra.decode.accepted}`);
  assert.ok(res.diagnostics.converged, `stopped for ${res.extra.stopReason}`);
  // The decode's own quantisation is the error floor here, so this is a
  // sub-pixel assertion rather than the machine-precision one the
  // correspondence-level tests make.
  assert.ok(res.diagnostics.rmsResidualPx < 0.5, `rms ${res.diagnostics.rmsResidualPx} px`);

  const state: BundleState = {
    ...bundleStateFromCalibration(res.calibration, []),
    cameras: res.extra.cameras,
  };
  const aligned = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
  assert.ok(
    aligned.maxProjectorPositionM < 0.05,
    `projector position error ${aligned.maxProjectorPositionM * 1000} mm`,
  );
  assert.ok(
    aligned.maxProjectorRotationDeg < 0.05,
    `projector rotation error ${aligned.maxProjectorRotationDeg} deg`,
  );
  assert.ok(
    Math.abs(res.diagnostics.recoveredCenterHeightM - scene.truth.centerHeightM) < 0.01,
    `h_center error ${(res.diagnostics.recoveredCenterHeightM - scene.truth.centerHeightM) * 1000} mm`,
  );
});

test('solve() survives sensor noise and an ambient wash', () => {
  const scene = makeScene(32, SMALL);
  // PARAMETERS.md §5 puts ambient at 0.04 nominal with a plausible range up to
  // 0.15, and notes that NOAA's own lighting control is unusually good. 0.12
  // with 1% sensor noise is a bad room, not a good one.
  const captures = renderAllCaptures(scene.truth, { ambient: 0.12, noiseSigma: 0.01, seed: 5 });
  const res = solve({
    nominal: scene.nominal,
    cameras: scene.cameraInputs,
    captures,
    floorReferences: scene.truth.projectors.map((p, i) => ({
      kind: 'projector' as const,
      index: i,
      heightM: p.position.z + scene.truth.centerHeightM,
      sigmaM: 0.002,
    })),
    options: { decode: { noiseSigma: 0.01 } },
  });
  assert.ok(res.extra.decode.accepted > 500, `decoded ${res.extra.decode.accepted}`);
  const state: BundleState = {
    ...bundleStateFromCalibration(res.calibration, []),
    cameras: res.extra.cameras,
  };
  const aligned = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
  assert.ok(
    aligned.maxProjectorPositionM < 0.2,
    `projector position error ${aligned.maxProjectorPositionM * 1000} mm`,
  );
  assert.ok(aligned.maxProjectorRotationDeg < 0.5);
});

test('the bootstrap does not care where in the d_proj prior it starts', () => {
  // PARAMETERS.md §2's conflict, exercised directly: the alignment manual says
  // 5.18 m, the floor plan implies 5.50-6.14 m, and the solver is told to treat
  // the value as SOLVE with a 5.0-6.5 m prior. Handing it a nominal at either
  // end of that prior must not change the answer materially.
  const scene = makeScene(33, SMALL);
  const captures = renderAllCaptures(scene.truth, { noiseSigma: 0 });
  const floor: FloorReference[] = scene.truth.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM: p.position.z + scene.truth.centerHeightM,
    sigmaM: 0.002,
  }));

  const scores: number[] = [];
  for (const distanceM of [5.0, 6.5]) {
    const nominal = nominalRig({
      projectorCount: 4,
      resX: scene.options.projectorRes.x,
      resY: scene.options.projectorRes.y,
      distanceM,
      // The field of view is class CFG — read off the projector's spec sheet —
      // so it stays at the true rig's value while the distance is varied. That
      // is the situation §2 actually describes: the throw ratio is known, the
      // room measurement is disputed.
      fovHDeg: scene.nominal.projectors[0].intrinsics.fovHDeg,
    });
    const res = solve({
      nominal,
      cameras: scene.cameraInputs,
      captures,
      floorReferences: floor,
      options: FOUR_LENSES,
    });
    const state: BundleState = {
      ...bundleStateFromCalibration(res.calibration, []),
      cameras: res.extra.cameras,
    };
    const aligned = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
    scores.push(aligned.maxProjectorPositionM);
    assert.ok(
      aligned.maxProjectorPositionM < 0.05,
      `nominal d_proj ${distanceM} m left ${aligned.maxProjectorPositionM * 1000} mm of error`,
    );
    assert.ok(res.diagnostics.converged, `nominal d_proj ${distanceM} m did not converge`);
  }
  assert.ok(
    Math.abs(scores[0] - scores[1]) < 0.02,
    `the two starting points should agree: ${scores[0]} vs ${scores[1]}`,
  );
});

test('solve() rejects an input with neither captures nor correspondences', () => {
  assert.throws(
    () => solve({ nominal: nominalRig(), cameras: [] }),
    /captures|correspondences/,
  );
});

test('the nominal rig follows §2 and §3.4', () => {
  const rig = nominalRig();
  assert.equal(rig.projectors.length, 4);
  // §V and §3.4: four quadrant viewports of one framebuffer, origin bottom-left.
  assert.deepEqual(
    rig.projectors.map((p) => [p.viewport.x, p.viewport.y, p.viewport.w, p.viewport.h]),
    [
      [0, 0, 0.5, 0.5],
      [0.5, 0, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ],
  );
  assert.equal(rig.framebuffer.width, 3840);
  assert.equal(rig.framebuffer.height, 2160);
  // §2: azimuths 0/90/180/270, all aimed at the sphere centre.
  for (let i = 0; i < 4; i++) {
    const p = rig.projectors[i].pose;
    const azimuth = (Math.atan2(p.position.y, p.position.x) * 180) / Math.PI;
    const expected = i * 90;
    assert.ok(Math.abs(((azimuth - expected + 540) % 360) - 180) < 1e-9);
    const yawExpected = ((expected + 180 + 540) % 360) - 180;
    assert.ok(Math.abs(((p.yawDeg - yawExpected + 540) % 360) - 180) < 1e-9);
  }
  // §1: h_center at the documented 86 in, radius at the documented 0.8636 m.
  assert.equal(rig.sphere.centerHeightM, 2.1844);
  assert.equal(rig.sphere.radiusM, 0.8636);
  // AMENDMENTS.md A-01: the silhouette is inscribed in the raster's MINOR
  // dimension, so the vertical field subtends the sphere — plus the headroom
  // conventions.ts §N.1 pins, which is applied to the TANGENT of the
  // silhouette's angular radius. This used to assert zero headroom, which is
  // what put this builder 0.63 degrees away from the forward model's for a whole
  // round (docs/AMENDMENTS.md A-17, A-19).
  const halfV = Math.atan(Math.tan((rig.projectors[0].intrinsics.fovHDeg * Math.PI) / 360) * (1080 / 1920));
  const expectedHalfV = Math.atan(
    Math.tan(Math.asin(0.8636 / 5.18)) * (1 + NOMINAL_SILHOUETTE_MARGIN_FRAC),
  );
  assert.ok(
    Math.abs(halfV - expectedHalfV) < 1e-12,
    `${(halfV * 360) / Math.PI} vs ${(expectedHalfV * 360) / Math.PI} deg of vertical field`,
  );
});

test('§N.2: a 3-projector install drops a quadrant rather than respacing the rest', () => {
  // PARAMETERS.md §2 is silent about which quadrants go dark, and this builder
  // used to space them equally at 0/120/240 while `packages/sim` dropped a
  // quadrant at 0/90/180. conventions.ts §N.2 settles it; docs/AMENDMENTS.md
  // A-19 asks the author to settle it upstream.
  const azimuths = (n: number): number[] =>
    nominalRig({ projectorCount: n }).projectors.map(
      (p) => Math.round((Math.atan2(p.pose.position.y, p.pose.position.x) * 180) / Math.PI),
    );
  assert.deepEqual(azimuths(4), [0, 90, 180, -90]);
  assert.deepEqual(azimuths(3), [0, 90, 180]);
  // A-06: the opposed pair is the only 2-projector arrangement that covers the
  // sphere.
  assert.deepEqual(azimuths(2), [0, 180]);
  // The ids and viewports name the SLOT, so a 3-projector rig keeps P1/P2/P3 in
  // the quadrants §3.4's config gives them.
  assert.deepEqual(
    nominalRig({ projectorCount: 2 }).projectors.map((p) => p.id),
    ['P1', 'P3'],
  );
});

test('the solver refuses duplicate azimuth slots, exactly as the simulator does', () => {
  // Two projectors on one slot share an azimuth AND an id: `buildLayout` emits
  // 'P1.px' twice into the parameter names, every diagnostic keyed by projector
  // id collides, and `sectorHalfWidths` degenerates on a zero angular gap. The
  // sim's `nominalRig` has always thrown on this; the solver's accepted it and
  // returned ids 'P1,P1,P2,P3'. The two sides of this project are allowed to
  // disagree about almost everything, but not about what a rig is.
  assert.throws(() => nominalRig({ projectorCount: 4, slots: [0, 0, 1, 2] }), /distinct/);
  assert.throws(() => nominalRig({ projectorCount: 2, slots: [3, 3] }), /distinct/);
  // The legitimate subsets still work.
  assert.equal(nominalRig({ projectorCount: 3, slots: [0, 1, 2] }).projectors.length, 3);
});
