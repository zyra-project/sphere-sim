/**
 * Bundle adjustment: recovery, gauge handling, and `h_center`.
 *
 * Recovery is scored two ways on purpose. The RAW score compares the recovered
 * calibration to ground truth in the world frame; the ALIGNED score removes the
 * global rotation first. The difference between them is not slack — it is the
 * gauge, and bundle.ts argues at length that no solver can observe it. Reporting
 * only the aligned number would hide how large the gauge is; reporting only the
 * raw number would charge the solver for something it cannot measure. Both are
 * asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BUNDLE_OPTIONS,
  DEFAULT_FREE_FLAGS,
  DEFAULT_GAUGE_OPTIONS,
  buildProblem,
  evaluate,
  gaugeNullSpace,
  runBundle,
  type BundleState,
  type FloorReference,
} from '../src/bundle.ts';
import { jacobiEigenSymmetric } from '../src/linalg.ts';
import { DEFAULT_ROBUST_OPTIONS, lossAndWeight, rejectOutliers } from '../src/robust.ts';
import { solveFromCorrespondences, bundleStateFromCalibration } from '../src/index.ts';
import {
  alignToTruth,
  generateCorrespondences,
  makeScene,
  scoreRecovery,
  type Scene,
} from './synthetic.ts';

/** PARAMETERS.md §7 gates for pose recovery against synthetic ground truth. */
const GATE_POSITION_M = 0.002;
const GATE_ROTATION_DEG = 0.05;

function floorAtEveryLens(scene: Scene, sigmaM = 0.002): FloorReference[] {
  // PARAMETERS.md §8 item 1: "floor to each projector lens". Four heights, which
  // is what makes the rig's level — and therefore h_center — observable.
  return scene.truth.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM: p.position.z + scene.truth.centerHeightM,
    sigmaM,
  }));
}

function solvedState(scene: Scene, floor: FloorReference[], noisePx = 0, seed = 1): BundleState {
  const corrs = generateCorrespondences(scene.truth, {
    noisePx,
    seed,
    sigmaPx: Math.max(noisePx, 0.02),
  });
  const res = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor);
  return {
    ...bundleStateFromCalibration(res.calibration, []),
    cameras: res.extra.cameras,
  };
}

test('noiseless recovery is far inside the §7 gates once the gauge is removed', () => {
  for (const seed of [1, 2, 3]) {
    const scene = makeScene(seed);
    const state = solvedState(scene, floorAtEveryLens(scene));
    const aligned = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);

    assert.ok(
      aligned.maxProjectorPositionM < GATE_POSITION_M / 100,
      `seed ${seed}: projector position error ${aligned.maxProjectorPositionM * 1000} mm`,
    );
    assert.ok(
      aligned.maxProjectorRotationDeg < GATE_ROTATION_DEG / 100,
      `seed ${seed}: projector rotation error ${aligned.maxProjectorRotationDeg} deg`,
    );
    assert.ok(
      aligned.maxCameraPositionM < GATE_POSITION_M / 100,
      `seed ${seed}: camera position error ${aligned.maxCameraPositionM * 1000} mm`,
    );
    assert.ok(aligned.maxFovErrorDeg < 1e-6, `seed ${seed}: fov error ${aligned.maxFovErrorDeg}`);
  }
});

test('the raw world-frame error is bounded by the nominal layout, as documented', () => {
  const scene = makeScene(1);
  const state = solvedState(scene, floorAtEveryLens(scene));
  const raw = scoreRecovery(state, scene.truth);
  // The gauge alignment anchors the reported frame to PARAMETERS.md §2's layout,
  // which itself scatters by the injected ±3 cm. That leaves a residual global
  // azimuth of order a tenth of a degree — larger than the §7 rotation gate, and
  // unavoidable for any solver. The bench must align frames before scoring.
  assert.ok(raw.maxProjectorRotationDeg < 0.5, `raw rotation error ${raw.maxProjectorRotationDeg}`);
  assert.ok(raw.maxProjectorPositionM < 0.05, `raw position error ${raw.maxProjectorPositionM}`);
});

test('recovery degrades gracefully and predictably with decode noise', () => {
  const scene = makeScene(4);
  const results: { noise: number; position: number }[] = [];
  for (const noise of [0, 0.05, 0.1]) {
    const state = solvedState(scene, floorAtEveryLens(scene), noise, 77);
    const aligned = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
    results.push({ noise, position: aligned.maxProjectorPositionM });
  }
  assert.ok(results[0].position < 1e-6, 'noiseless is exact');
  assert.ok(results[1].position < 0.02, `0.05 px noise -> ${results[1].position * 1000} mm`);
  assert.ok(results[2].position < 0.04, `0.10 px noise -> ${results[2].position * 1000} mm`);
  // The error grows roughly linearly in the decode noise: the residual position
  // uncertainty is dominated by the focal/distance correlation of a long-throw
  // lens, whose target subtends only about 19 degrees, so there is very little
  // depth baseline with which to separate the two.
  assert.ok(results[2].position > results[1].position, 'monotone in noise');
});

test('h_center is recovered from floor references and is otherwise held', () => {
  const scene = makeScene(5);
  const corrs = generateCorrespondences(scene.truth);

  const withFloor = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrs,
    floorAtEveryLens(scene),
  );
  assert.equal(withFloor.extra.centerHeightObserved, true);
  const err = Math.abs(withFloor.diagnostics.recoveredCenterHeightM - scene.truth.centerHeightM);
  // NOAA's documented remedy is to add or subtract an inch and re-run alignment
  // (PARAMETERS.md §1). One millimetre is forty times finer than that step.
  assert.ok(err < 0.001, `h_center error ${err * 1000} mm`);

  const noFloor = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, []);
  assert.equal(noFloor.extra.centerHeightObserved, false);
  assert.equal(
    noFloor.diagnostics.recoveredCenterHeightM,
    scene.nominal.sphere.centerHeightM,
    'with nothing observing the floor, h_center must not wander',
  );
});

test('h_center tracks a deliberately shifted floor measurement', () => {
  // The mechanism, isolated: move the tape measure by a centimetre and the
  // recovered sphere-centre height must move by the same centimetre. This is the
  // whole content of the claim that the solve is a concrete improvement over the
  // add-an-inch-and-re-run loop — it converts one accessible measurement into
  // the inaccessible one.
  const scene = makeScene(6);
  const corrs = generateCorrespondences(scene.truth);
  const base = floorAtEveryLens(scene);
  const shifted = base.map((f) => ({ ...f, heightM: f.heightM + 0.01 }));

  const a = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, base);
  const b = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, shifted);
  const delta =
    b.diagnostics.recoveredCenterHeightM - a.diagnostics.recoveredCenterHeightM;
  assert.ok(Math.abs(delta - 0.01) < 5e-4, `expected +10 mm, got ${delta * 1000} mm`);
});

test('a single floor reference leaves h_center tied to the tilt gauge', () => {
  // Documented limitation, asserted so it cannot regress into a silent claim.
  // With one height, tilting the rig and shifting h_center to compensate leaves
  // every residual unchanged, so h_center inherits whatever tilt the gauge
  // happened to pick. Four heights fix it; one does not.
  const scene = makeScene(7);
  const corrs = generateCorrespondences(scene.truth);
  const one: FloorReference[] = [
    {
      kind: 'camera',
      index: 0,
      heightM: scene.truth.cameras[0].position.z + scene.truth.centerHeightM,
      sigmaM: 0.002,
    },
  ];
  const single = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, one);
  const many = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrs,
    floorAtEveryLens(scene),
  );
  assert.deepEqual(single.extra.gaugeFreeAxes, [true, true, true], 'all three rotations free');
  assert.deepEqual(many.extra.gaugeFreeAxes, [false, false, true], 'only azimuth free');

  const errSingle = Math.abs(
    single.diagnostics.recoveredCenterHeightM - scene.truth.centerHeightM,
  );
  const errMany = Math.abs(many.diagnostics.recoveredCenterHeightM - scene.truth.centerHeightM);
  assert.ok(errMany < errSingle, `four references must beat one: ${errMany} vs ${errSingle}`);
  assert.ok(errMany < 0.001);
});

test('the global-rotation directions really are null, and the gauge fixes the rank', () => {
  const scene = makeScene(8);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 24 });
  const options = {
    ...DEFAULT_BUNDLE_OPTIONS,
    free: { ...DEFAULT_FREE_FLAGS, centerHeight: false },
    gauge: { ...DEFAULT_GAUGE_OPTIONS },
    loss: DEFAULT_ROBUST_OPTIONS,
  };
  const problem = buildProblem(scene.truth, corrs, [], options);
  const ev = evaluate(scene.truth, problem, true);
  assert.ok(ev.jtj);
  const jtj = ev.jtj as Float64Array;
  const n = problem.layout.n;

  const spectrum = jacobiEigenSymmetric(jtj, n);
  const largest = spectrum.values[n - 1];
  // Exactly three directions are unobservable, so exactly three eigenvalues are
  // numerically zero. Four would mean an unintended degeneracy; two would mean
  // the null space is not what bundle.ts claims.
  let nullCount = 0;
  for (let i = 0; i < n; i++) if (spectrum.values[i] < largest * 1e-12) nullCount++;
  assert.equal(nullCount, 3, `spectrum: ${Array.from(spectrum.values).slice(0, 6).join(', ')}`);

  // And they are the directions gaugeNullSpace names.
  const nulls = gaugeNullSpace(scene.truth, problem);
  assert.equal(nulls.length, 3);
  for (const cand of nulls) {
    let q = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) row += jtj[i * n + j] * cand.dir[j];
      q += cand.dir[i] * row;
    }
    assert.ok(q < largest * 1e-14, `axis ${cand.axis}: |J n|^2 = ${q} against ${largest}`);
  }

  // Adding the gauge penalty makes the normal matrix positive definite, which is
  // the practical statement that the LM step is now well posed.
  const meanDiag = (() => {
    let s = 0;
    for (let i = 0; i < n; i++) s += jtj[i * n + i];
    return s / n;
  })();
  const withGauge = Float64Array.from(jtj);
  for (const cand of nulls) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        withGauge[i * n + j] += meanDiag * cand.dir[i] * cand.dir[j];
      }
    }
  }
  const after = jacobiEigenSymmetric(withGauge, n);
  assert.ok(after.values[0] > largest * 1e-12, `smallest eigenvalue now ${after.values[0]}`);
});

test('the gauge is a choice, not an adjustment: the fit is identical either way', () => {
  const scene = makeScene(9);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 20 });
  const floor = floorAtEveryLens(scene);
  const nominalState = bundleStateFromCalibration(scene.nominal, scene.cameraInputs);

  const anchored = runBundle(nominalState, corrs, floor, {}, nominalState);
  const free = runBundle(nominalState, corrs, floor, {});
  // Re-expressing the solution in a different frame is an exact symmetry of the
  // correspondence residuals, so the reported RMS must not move.
  assert.ok(
    Math.abs(anchored.rmsResidualPx - free.rmsResidualPx) < 1e-9,
    `${anchored.rmsResidualPx} vs ${free.rmsResidualPx}`,
  );
});

test('the optimiser converges and says why', () => {
  const scene = makeScene(10);
  const corrs = generateCorrespondences(scene.truth);
  const res = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrs,
    floorAtEveryLens(scene),
  );
  assert.equal(res.diagnostics.converged, true);
  assert.ok(
    res.extra.stopReason === 'gradient' ||
      res.extra.stopReason === 'step' ||
      res.extra.stopReason === 'cost',
    `stopped for ${res.extra.stopReason}`,
  );
  assert.ok(res.diagnostics.iterations < 120, `${res.diagnostics.iterations} iterations`);
  assert.ok(res.diagnostics.rmsResidualPx < 1e-6, `rms ${res.diagnostics.rmsResidualPx}`);
  assert.equal(res.diagnostics.residuals.length, res.diagnostics.correspondencesUsed);
  assert.equal(res.diagnostics.perProjectorRmsPx.length, 4);
  for (const r of res.diagnostics.perProjectorRmsPx) assert.ok(r < 1e-6);
});

test('every residual is reported, with its projector, camera and decoded pixel', () => {
  const scene = makeScene(11, { cameraCount: 2 });
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 24 });
  const res = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrs,
    floorAtEveryLens(scene),
  );
  const seenProjectors = new Set<number>();
  const seenCameras = new Set<number>();
  for (const r of res.diagnostics.residuals) {
    seenProjectors.add(r.projector);
    seenCameras.add(r.camera);
    assert.ok(Number.isFinite(r.du) && Number.isFinite(r.dv));
    assert.ok(r.u >= 0 && r.u <= 1920 && r.v >= 0 && r.v <= 1080);
  }
  assert.equal(seenProjectors.size, 4, 'the scatter must be separable per projector');
  assert.equal(seenCameras.size, 2);
  assert.equal(
    res.diagnostics.correspondencesUsed + res.diagnostics.correspondencesRejected,
    corrs.length,
  );
});

test('gross outliers are rejected and counted, and do not move the answer', () => {
  const scene = makeScene(12);
  const clean = generateCorrespondences(scene.truth);
  const corrupted = clean.map((c, i) =>
    // One in twenty correspondences gets a whole-fringe error, which is what an
    // undetected Gray/phase disagreement produces.
    i % 20 === 0 ? { ...c, projU: c.projU + 30, projV: c.projV - 30 } : c,
  );
  const floor = floorAtEveryLens(scene);
  const res = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrupted, floor);

  assert.ok(
    res.diagnostics.correspondencesRejected >= Math.floor(clean.length / 20) * 0.9,
    `rejected ${res.diagnostics.correspondencesRejected} of ${Math.floor(clean.length / 20)} planted`,
  );
  const state: BundleState = {
    ...bundleStateFromCalibration(res.calibration, []),
    cameras: res.extra.cameras,
  };
  const aligned = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
  assert.ok(
    aligned.maxProjectorPositionM < GATE_POSITION_M,
    `5% gross outliers left ${aligned.maxProjectorPositionM * 1000} mm of error`,
  );
});

test('the robust loss and the rejection pass behave as documented', () => {
  const opts = DEFAULT_ROBUST_OPTIONS;
  // Quadratic below the tuning constant, linear above, continuous at it.
  const inner = lossAndWeight(1.0, opts);
  assert.ok(Math.abs(inner.rho - 1) < 1e-12 && inner.omega === 1);
  const at = lossAndWeight(opts.huberK, opts);
  const just = lossAndWeight(opts.huberK + 1e-9, opts);
  assert.ok(Math.abs(at.rho - just.rho) < 1e-6, 'rho is continuous at k');
  const outer = lossAndWeight(10, opts);
  assert.ok(outer.omega < 0.2 && outer.rho < 100, 'a big residual is down-weighted');

  const cauchy = lossAndWeight(10, { ...opts, kind: 'cauchy' });
  assert.ok(cauchy.omega < 0.1);
  const none = lossAndWeight(10, { ...opts, kind: 'none' });
  assert.equal(none.rho, 100);
  assert.equal(none.omega, 1);

  // A clean set loses nothing to the floor; planting one wild value loses one.
  const norms = new Array(200).fill(0).map((_, i) => 0.5 + (i % 7) * 0.05);
  const clean = rejectOutliers(norms, opts);
  assert.equal(clean.rejected, 0);
  norms[3] = 40;
  const dirty = rejectOutliers(norms, opts);
  assert.equal(dirty.rejected, 1);
  assert.equal(dirty.keep[3], false);
});

test('tangential distortion is held at zero unless explicitly freed', () => {
  const scene = makeScene(13);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 20 });
  const res = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrs,
    floorAtEveryLens(scene),
  );
  // PARAMETERS.md §3.1: hold p1, p2 at zero unless residuals demand otherwise.
  for (const p of res.calibration.projectors) {
    assert.equal(p.intrinsics.p1, 0);
    assert.equal(p.intrinsics.p2, 0);
  }
});

test('the solver passes through everything it did not observe', () => {
  const scene = makeScene(14, { cameraCount: 2 });
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 24 });
  const res = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, []);
  assert.deepEqual(res.calibration.blend, scene.nominal.blend);
  assert.deepEqual(res.calibration.framebuffer, scene.nominal.framebuffer);
  assert.equal(
    res.calibration.sphere.rotationOffsetDeg,
    scene.nominal.sphere.rotationOffsetDeg,
    'no structured-light pattern observes the sphere texture rotation',
  );
  assert.equal(res.calibration.sphere.radiusM, scene.nominal.sphere.radiusM);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(res.calibration.projectors[i].transfer, scene.nominal.projectors[i].transfer);
    assert.deepEqual(res.calibration.projectors[i].viewport, scene.nominal.projectors[i].viewport);
  }
  assert.equal(res.calibration.schema, 'sphere-sim/rig-calibration@2');
});
