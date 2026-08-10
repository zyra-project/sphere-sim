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
import type { BundleState, FloorReference } from '../src/bundle.ts';
import {
  alignToTruth,
  makeScene,
  renderAllCaptures,
  scoreRecovery,
} from './synthetic.ts';

const SMALL = { cameraRes: { x: 160, y: 120 }, cameraCount: 2 };

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
  // dimension, so the vertical field subtends the sphere.
  const fovV =
    (2 * Math.atan(Math.tan((rig.projectors[0].intrinsics.fovHDeg * Math.PI) / 360) * (1080 / 1920)) *
      180) /
    Math.PI;
  const subtended = (2 * Math.asin(0.8636 / 5.18) * 180) / Math.PI;
  assert.ok(Math.abs(fovV - subtended) < 1e-6, `${fovV} vs ${subtended}`);
});
