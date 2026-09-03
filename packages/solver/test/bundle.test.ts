// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
  cloneState,
  evaluate,
  gaugeNullSpace,
  packState,
  rotationVector,
  runBundle,
  unpackState,
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

/**
 * Four independent fields of view — the model this fixture's truth actually has.
 *
 * `makeScene` jitters each projector's `fovHDeg` INDEPENDENTLY by up to 0.25
 * degrees, because a rig's four zoom rings are set one at a time by the Red Ball
 * procedure against four slightly different lens distances. The default solve
 * ties them (docs/AMENDMENTS.md A-35: one install, one projector model), so on
 * this fixture the default is a deliberately mis-specified model, and the
 * exactness tests below would be measuring that mis-specification rather than
 * the optimiser.
 *
 * So the tests that assert EXACT recovery pass this explicitly, and the cost of
 * the tie on a fixture whose fields genuinely differ is measured in its own test
 * ('the shared-lens tie costs what the spread costs') rather than being hidden
 * inside a loosened tolerance somewhere.
 */
const FOUR_LENSES = { bundle: { tieProjectorFov: false } };

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
  const res = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrs,
    floor,
    FOUR_LENSES,
  );
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

test('the gauge pins every rotation the floor cannot measure, including mixtures', () => {
  // The count is arithmetic, not a preference. Floor references see a rotation
  // only through the height it gives each referenced lens, so with N references
  // the observable part of the rotation space has the rank of an N-by-2 matrix
  // over the two horizontal axes, and the gauge must pin what is left:
  //
  //   0 or 1 reference   rank 0   ->  3 constraints
  //   2 references       rank 1   ->  2 constraints
  //   3+ non-collinear   rank 2   ->  1 constraint (azimuth, which moves no height)
  //
  // The two-reference row is the one that regressed. The old code asked of each
  // WORLD AXIS separately whether the heights moved under it; at two references
  // both pure axes move them, so both looked observable and only the azimuth was
  // pinned — while the MIXTURE that raises both lenses equally, which no
  // reference can see, was left free for the damping to resolve. It applied one
  // constraint where the space needs two.
  const scene = makeScene(7);
  const corrs = generateCorrespondences(scene.truth);
  const refs = (idx: number[]): FloorReference[] =>
    idx.map((i) => ({
      kind: 'projector' as const,
      index: i,
      heightM: scene.truth.projectors[i].position.z + scene.truth.centerHeightM,
      sigmaM: 0.002,
    }));
  const constraintsFor = (idx: number[]): number =>
    solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, refs(idx)).extra
      .gaugeConstraints;

  assert.equal(constraintsFor([]), 3, 'no reference determines no rotation');
  assert.equal(constraintsFor([0]), 3, 'one height determines no rotation either');
  assert.equal(constraintsFor([0, 1]), 2, 'two ADJACENT lenses leave one tilt unmeasurable');
  assert.equal(constraintsFor([0, 2]), 2, 'two ANTIPODAL lenses leave one tilt unmeasurable');
  assert.equal(constraintsFor([0, 1, 2]), 1, 'three lenses leave only the azimuth');
  assert.equal(constraintsFor([0, 1, 2, 3]), 1, 'four lenses leave only the azimuth');
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
    FOUR_LENSES,
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
  const res = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrupted,
    floor,
    FOUR_LENSES,
  );

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

// ---------------------------------------------------------------------------
// Parameter priors
// ---------------------------------------------------------------------------

test('a prior is inert when it is wide and decisive when it is tight', () => {
  // The point of a prior is that it competes with the data on a stated footing.
  // A prior far wider than the data's own precision must not move the answer at
  // all; one far tighter must dominate it. Anything in between is a weighting,
  // and the reported residual says which regime the solve landed in.
  const scene = makeScene(31);
  const corrs = generateCorrespondences(scene.truth, { noisePx: 0.05, seed: 5, sigmaPx: 0.05 });
  const floor = floorAtEveryLens(scene);
  // A deliberately WRONG prior mean, so a prior that bites is unmistakable.
  const wrongFovDeg = scene.nominal.projectors[0].intrinsics.fovHDeg + 5;
  const nominal = {
    ...scene.nominal,
    projectors: scene.nominal.projectors.map((p) => ({
      ...p,
      intrinsics: { ...p.intrinsics, fovHDeg: wrongFovDeg },
    })),
  };

  const free = solveFromCorrespondences(nominal, scene.cameraInputs, corrs, floor, {
    priors: { fovHDegSigma: 0 },
  });
  const wide = solveFromCorrespondences(nominal, scene.cameraInputs, corrs, floor, {
    priors: { fovHDegSigma: 50 },
  });
  const tight = solveFromCorrespondences(nominal, scene.cameraInputs, corrs, floor, {
    priors: { fovHDegSigma: 1e-4 },
  });

  const fov = (r: typeof free): number => r.calibration.projectors[0].intrinsics.fovHDeg;
  const truth = scene.truth.projectors[0].fovHDeg;

  assert.equal(free.extra.priorResiduals.length, 0, 'sigma 0 registers no prior');
  assert.ok(
    Math.abs(fov(wide) - fov(free)) < 1e-3,
    `a 50 deg prior moved fovH by ${Math.abs(fov(wide) - fov(free))} deg`,
  );
  assert.ok(
    Math.abs(fov(tight) - wrongFovDeg) < 1e-3,
    `a 1e-4 deg prior should pin fovH at its mean, got ${fov(tight)} vs ${wrongFovDeg}`,
  );
  // The free fit should be the one that finds the truth; the pinned one should
  // not. That is the trade the prior width is buying or selling.
  assert.ok(Math.abs(fov(free) - truth) < Math.abs(fov(tight) - truth));
});

test('prior residuals report how hard the prior is fighting the data', () => {
  const scene = makeScene(32);
  const corrs = generateCorrespondences(scene.truth, { noisePx: 0.05, seed: 6, sigmaPx: 0.05 });
  const offsetDeg = 2;
  const nominal = {
    ...scene.nominal,
    projectors: scene.nominal.projectors.map((p) => ({
      ...p,
      intrinsics: { ...p.intrinsics, fovHDeg: p.intrinsics.fovHDeg + offsetDeg },
    })),
  };
  const res = solveFromCorrespondences(nominal, scene.cameraInputs, corrs, floorAtEveryLens(scene), {
    priors: { fovHDegSigma: 0.5 },
    // Four priors on four fields. Tied, `buildProblem` keeps ONE of them (four
    // readings of one spec sheet are not four measurements) and this test's
    // per-projector assertion would have nothing to check.
    ...FOUR_LENSES,
  });
  assert.equal(res.extra.priorResiduals.length, scene.truth.projectors.length);
  for (let i = 0; i < res.extra.priorResiduals.length; i++) {
    const r = res.extra.priorResiduals[i];
    assert.match(r.name, /fovH$/);
    const recovered = res.calibration.projectors[i].intrinsics.fovHDeg;
    const mean = nominal.projectors[i].intrinsics.fovHDeg;
    assert.ok(
      Math.abs(r.sigmas - (recovered - mean) / 0.5) < 1e-6,
      'the reported residual is the actual offset in sigmas',
    );
    // The data is strong enough here to overrule a half-degree prior on a
    // two-degree error, which is the whole reason it is a prior and not a hold.
    assert.ok(Math.abs(r.sigmas) > 1, `prior residual ${r.sigmas} sigma — the prior won`);
  }
});

test('a shift prior closes the lens-shift/pointing near-degeneracy', () => {
  // Documented in docs/AMENDMENTS.md A-12 and measured on the bench corpus: at a
  // 33 degree field a lens shift of 0.01 is worth 0.17 degrees of yaw, and the
  // two are separated only by a second-order term. Here the mechanism is pinned
  // rather than the policy: a tight shift prior must move the recovered ROTATION,
  // not merely the shift, because that is the coupling the amendment is about.
  const scene = makeScene(33);
  const corrs = generateCorrespondences(scene.truth, { noisePx: 0.2, seed: 8, sigmaPx: 0.05 });
  const floor = floorAtEveryLens(scene);
  const free = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor);
  const pinned = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    priors: { shiftSigma: 1e-5 },
  });
  let moved = 0;
  for (let i = 0; i < free.calibration.projectors.length; i++) {
    const a = free.calibration.projectors[i].pose;
    const b = pinned.calibration.projectors[i].pose;
    moved = Math.max(moved, Math.abs(a.pitchDeg - b.pitchDeg), Math.abs(a.yawDeg - b.yawDeg));
  }
  assert.ok(moved > 1e-3, `pinning the shift moved pointing by only ${moved} deg`);
  for (const p of pinned.calibration.projectors) {
    assert.ok(Math.abs(p.intrinsics.shiftH) < 1e-3, `shiftH ${p.intrinsics.shiftH} not pinned`);
    assert.ok(Math.abs(p.intrinsics.shiftV) < 1e-3, `shiftV ${p.intrinsics.shiftV} not pinned`);
  }
});

test('a camera whose correspondences are worse than they claim is down-weighted', () => {
  // Variance components measure what the decode cannot see. Here camera 1's
  // correspondences carry a deliberate extra error while still reporting the
  // same sigma as everyone else — which is exactly what inter-frame motion does
  // to a handheld capture. The fit must notice from the residuals alone.
  const scene = makeScene(34, { cameraCount: 3 });
  const corrs = generateCorrespondences(scene.truth, { noisePx: 0.02, seed: 12, sigmaPx: 0.02 });
  const spoiled = corrs.map((c) =>
    c.camera === 1 ? { ...c, projU: c.projU + 1.5, projV: c.projV - 1.5 } : c,
  );
  const floor = floorAtEveryLens(scene);

  const on = solveFromCorrespondences(scene.nominal, scene.cameraInputs, spoiled, floor, FOUR_LENSES);
  const off = solveFromCorrespondences(scene.nominal, scene.cameraInputs, spoiled, floor, {
    bundle: { ...FOUR_LENSES.bundle, varianceComponents: false },
  });

  const scales = on.extra.cameraResidualScale;
  assert.equal(scales.length, 3);
  assert.ok(scales[1] > 2 * Math.max(scales[0], scales[2]), `scales ${scales.join(', ')}`);
  // Floored at 1: a camera is never allowed to claim it beat its own decode.
  for (const s of scales) assert.ok(s >= 1, `scale ${s} below the floor`);
  // With the components off nothing is measured, so every camera reports 1.
  for (const s of off.extra.cameraResidualScale) assert.equal(s, 1);
});

test('the shared-lens tie costs what the spread costs, and the cost is not hidden', () => {
  // The tie is ON by default from round 4, licensed by docs/AMENDMENTS.md A-35:
  // the install runs four projectors of one model, so there is one lens and one
  // throw ratio. That licence covers the LENS. It does not cover the ZOOM
  // SETTING, which the Red Ball procedure turns per projector until each image
  // matches the sphere — and this fixture's truth says so, jittering each
  // `fovHDeg` independently by up to 0.25 degrees.
  //
  // So on a NOISELESS scene, where a correctly-specified model recovers the rig
  // exactly, the tie leaves a residue. This test measures it rather than
  // tolerating it: the number is the price of the model, and a round that
  // shipped the tie owes the reader the number on a case where nothing else is
  // going wrong.
  const scene = makeScene(1);
  const floor = floorAtEveryLens(scene);
  const corrs = generateCorrespondences(scene.truth, { noisePx: 0, seed: 1, sigmaPx: 0.02 });

  const solved = (options: Record<string, unknown>): ReturnType<typeof scoreRecovery> => {
    const res = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, options);
    const state: BundleState = {
      ...bundleStateFromCalibration(res.calibration, []),
      cameras: res.extra.cameras,
    };
    return scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
  };

  const free = solved(FOUR_LENSES);
  const tied = solved({});
  const spreadDeg =
    Math.max(...scene.truth.projectors.map((p) => p.fovHDeg)) -
    Math.min(...scene.truth.projectors.map((p) => p.fovHDeg));

  // The correctly-specified model is exact, which is what makes the comparison
  // meaningful: everything below is the tie and nothing else.
  assert.ok(free.maxProjectorPositionM < 1e-6, `free: ${free.maxProjectorPositionM * 1000} mm`);
  assert.ok(free.maxFovErrorDeg < 1e-6, `free: ${free.maxFovErrorDeg} deg`);

  // Tied, the four fields come back as one, so the recovered field cannot be
  // closer to every truth than half the spread, and the position error follows
  // it through the subtense relation of docs/AMENDMENTS.md A-18.
  assert.ok(
    tied.maxFovErrorDeg > spreadDeg / 4,
    `tied fov error ${tied.maxFovErrorDeg} deg against a truth spread of ${spreadDeg}`,
  );
  assert.ok(
    tied.maxProjectorPositionM > 5 * free.maxProjectorPositionM,
    'the tie should cost something measurable on a fixture whose fields differ',
  );
  // And it is bounded: this is a modelling error of a few centimetres on a
  // noiseless scene, against the hundreds of millimetres of fitting error the
  // tie removes when the decode carries a bias (docs/PHASE-1.md round 4).
  assert.ok(
    tied.maxProjectorPositionM < 0.05,
    `tied position error ${tied.maxProjectorPositionM * 1000} mm is larger than the modelling error should be`,
  );
});

/** Row-major rotation matrix for a unit axis and an angle. */
function rodrigues(ax: number, ay: number, az: number, theta: number): Float64Array {
  const n = Math.hypot(ax, ay, az);
  const x = ax / n;
  const y = ay / n;
  const z = az / n;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  return Float64Array.from([
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ]);
}

test('rotationVector recovers an angle past ninety degrees, and at a half turn', () => {
  // The `asin` this replaced could not represent an angle above 90 degrees: it
  // returned 0.14 rad for a true 3.0 and exactly zero for a half turn, which
  // made `alignGaugeToReference` apply a fraction of the rotation it needed --
  // or, at 180 degrees, silently none at all while reporting success. A gauge
  // alignment that no-ops reports the raw bootstrap frame as if it were aligned.
  const axes: [number, number, number][] = [
    [0, 0, 1],
    [1, 0, 0],
    [0.3, -0.7, 0.5],
    [1, 1, 1],
  ];
  const angles = [0, 1e-9, 0.01, 0.5, 1.2, Math.PI / 2, 2.0, 2.5, 3.0, Math.PI];
  for (const [ax, ay, az] of axes) {
    for (const theta of angles) {
      const R = rodrigues(ax, ay, az, theta);
      const w = rotationVector(R);
      const got = Math.hypot(w.x, w.y, w.z);
      assert.ok(
        Math.abs(got - theta) < 1e-7,
        `axis ${ax},${ay},${az} angle ${theta}: recovered ${got}`,
      );
      // A half turn has no signed axis, so the check that matters either way is
      // that the vector rebuilds the rotation it came from.
      const back = got < 1e-12 ? rodrigues(1, 0, 0, 0) : rodrigues(w.x, w.y, w.z, got);
      let fro = 0;
      for (let i = 0; i < 9; i++) fro += (back[i] - R[i]) ** 2;
      assert.ok(Math.sqrt(fro) < 1e-6, `axis ${ax},${ay},${az} angle ${theta} did not rebuild`);
    }
  }
});

test('an unusable correspondence is charged for missing; an excluded one is not', () => {
  // This is the mechanism behind the exclusion rule, and it is the reason
  // `runBundle` must not bank an unusable point as excluded. `evaluate` skips
  // excluded points BEFORE charging `missPenalty`, so a point moved into that
  // set stops paying anything at all and can never make itself worth recovering
  // -- which is the opposite of what `RobustOptions.missPenalty` documents:
  // 'the penalty disappears when the point comes back, which makes recovering
  // one rewarding'.
  //
  // Stated on the two states directly, because it holds whatever the solve does
  // with them. If a later change made `evaluate` charge the penalty for excluded
  // points too, the banking would become harmless and this test would say so.
  const scene = makeScene(11);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 24 });
  const floor = floorAtEveryLens(scene);
  const opts = {
    ...DEFAULT_BUNDLE_OPTIONS,
    free: DEFAULT_FREE_FLAGS,
    gauge: DEFAULT_GAUGE_OPTIONS,
  };

  // Swing one projector far enough behind itself that its points cannot project.
  const wrecked = cloneState(bundleStateFromCalibration(scene.nominal, scene.cameraInputs));
  wrecked.projectors[0].yawDeg += 180;

  const problem = buildProblem(wrecked, corrs, floor, opts);
  const missing = evaluate(wrecked, problem, false);
  const unusable: number[] = [];
  for (let i = 0; i < corrs.length; i++) if (!missing.usable[i]) unusable.push(i);
  assert.ok(unusable.length > 0, 'the fixture should put some correspondences behind a lens');

  // Now exclude exactly those, and the cost must FALL -- they stop paying the
  // miss penalty. That fall is the objective quietly losing the evidence that
  // the pose is wrong, which is what banking them would make permanent.
  const banked = buildProblem(wrecked, corrs, floor, opts);
  for (const i of unusable) banked.excluded[i] = true;
  const bankedEval = evaluate(wrecked, banked, false);
  assert.ok(
    bankedEval.cost < missing.cost,
    `excluding ${unusable.length} unusable points did not reduce the cost ` +
      `(${missing.cost} -> ${bankedEval.cost}); the miss penalty is not being charged`,
  );
});

// ---------------------------------------------------------------------------
// The assembly loop
// ---------------------------------------------------------------------------

/**
 * A base state and problem whose residuals are EXACTLY zero.
 *
 * Two things have to line up for that. `generateCorrespondences` traces the
 * solver's own forward model, so at `scene.truth` there is nothing to disagree
 * with — but only with `FOUR_LENSES`, because `makeScene` jitters the four
 * fields of view independently and the default tie would collapse them.
 *
 * And the state is round-tripped through `packState`/`unpackState` before
 * anything is measured against it. Under a tie those two are not inverses: pack
 * reads one slot per column, unpack writes every slot the column stands for. A
 * numerical derivative walks the PACKED vector, so it can only be compared
 * against an analytic one taken at a state the packed vector actually maps to.
 * Skipping this is not a small error — it moved the curvature ratio below by
 * fourteen orders of magnitude.
 */
function differentiableFixture(seed = 8): {
  base: BundleState;
  problem: ReturnType<typeof buildProblem>;
  v0: Float64Array;
} {
  const scene = makeScene(seed);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 24 });
  const problem = buildProblem(scene.truth, corrs, floorAtEveryLens(scene), {
    ...DEFAULT_BUNDLE_OPTIONS,
    ...FOUR_LENSES.bundle,
    free: { ...DEFAULT_FREE_FLAGS },
    gauge: { ...DEFAULT_GAUGE_OPTIONS },
    loss: DEFAULT_ROBUST_OPTIONS,
  });
  const base = cloneState(scene.truth);
  const v0 = packState(base, problem.layout);
  unpackState(v0, base, problem.layout);
  return { base, problem, v0 };
}

test('every column of `jtr` is the derivative of the cost it claims to be', () => {
  // The two COMPONENT Jacobians are central-differenced already — project.test.ts
  // and sphere.test.ts do it. The loop that ASSEMBLES them into `jtj` and `jtr`
  // (bundle.ts, the `idx`/`ju`/`jv` gather and the rank-one update under it) is
  // not differentiated by anything, and it is where the three interesting
  // mistakes live: a column dropped, a column mis-signed, and a column paired
  // with the wrong one. Today the only thing standing under it is the eigenvalue
  // count in 'the global-rotation directions really are null', which catches a
  // wholly-absent column and nothing finer.
  //
  // The identity is exact and holds for every loss kind. With rho the loss and
  // omega = rho'(s)/s its IRLS weight (robust.ts), the cost is sum(rho(s)) and
  //
  //     d(cost)/d(theta) = rho'(s) . ds/d(theta)
  //                      = omega . (du.wu^2.d(du)/d(theta) + dv.wv^2.d(dv)/d(theta)) . 2
  //
  // while the assembly writes `jtr[i] += omega.wu^2.ju.du + omega.wv^2.jv.dv`.
  // So grad(cost) = 2 . jtr, with no approximation and no dependence on where
  // the state sits. Measured here: the ratio lands within 1.3e-6 of 2 on all 60
  // columns.
  const { base, problem, v0 } = differentiableFixture();
  const layout = problem.layout;
  const n = layout.n;

  // OFF the minimum on purpose. At truth the residuals vanish and so does the
  // gradient, and a test comparing zero against zero would pass with the entire
  // gather deleted. The offset is deterministic and small enough that no
  // correspondence changes its `usable` verdict, which would step the cost.
  const state = cloneState(base);
  const v = Float64Array.from(v0, (x, i) => x + 1e-3 * (1 + Math.abs(x)) * ((i % 3) - 1));
  unpackState(v, state, layout);

  const ev = evaluate(state, problem, true);
  assert.ok(ev.jtr, 'evaluate returned no jtr');
  const jtr = ev.jtr as Float64Array;
  assert.ok(ev.contributing > 0, 'no correspondence contributed; the fixture is empty');

  const work = cloneState(state);
  const costAt = (vec: Float64Array): number => {
    unpackState(vec, work, layout);
    return evaluate(work, problem, false).cost;
  };

  const numeric = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = 1e-6 * (1 + Math.abs(v[i]));
    const vp = Float64Array.from(v);
    const vm = Float64Array.from(v);
    vp[i] += h;
    vm[i] -= h;
    numeric[i] = (costAt(vp) - costAt(vm)) / (2 * h);
  }

  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(2 * jtr[i]));
  assert.ok(scale > 0, 'the analytic gradient is identically zero');

  for (let i = 0; i < n; i++) {
    const analytic = 2 * jtr[i];
    const slot = layout.freeSlots[i];
    if (Math.abs(analytic) > scale * 1e-9) {
      const rel = Math.abs(numeric[i] - analytic) / Math.abs(analytic);
      assert.ok(
        rel < 1e-4,
        `column ${i} (slot ${slot}): analytic 2*jtr = ${analytic}, central difference ` +
          `= ${numeric[i]}, relative error ${rel}`,
      );
    } else {
      // The catch for a DROPPED column: the assembly says this parameter does
      // not move the cost, so the cost had better not move.
      assert.ok(
        Math.abs(numeric[i]) < scale * 1e-6,
        `column ${i} (slot ${slot}) contributes nothing to jtr, but perturbing it ` +
          `changes the cost by ${numeric[i]} against a gradient scale of ${scale} ` +
          '— a column is missing from the assembly',
      );
    }
  }
});

test('`jtj` is the curvature of the cost, off-diagonals included', () => {
  // `jtj` is the GAUSS-NEWTON matrix, not the true Hessian: the two differ by a
  // term in the residuals times their second derivatives. That term is exactly
  // zero at a zero-residual point, and `generateCorrespondences` gives us one —
  // so at `base` the identity d^T (2.jtj) d = d^2(cost)/dd^2 is exact rather
  // than approximate, and can be asserted at 1e-4 instead of hand-waved.
  //
  // Directions, not entries. An n-by-n numerical Hessian is O(n^2) evaluations
  // for a matrix whose failure modes are all visible in O(n): a basis direction
  // e_i probes jtj[i][i], and a MIXED direction probes the off-diagonals,
  // because d^T J d expands to the diagonal terms plus twice every cross term.
  // A column paired with the wrong one survives the basis pass and dies here.
  const { base, problem, v0 } = differentiableFixture();
  const layout = problem.layout;
  const n = layout.n;

  const ev = evaluate(base, problem, true);
  assert.ok(ev.jtj, 'evaluate returned no jtj');
  const jtj = ev.jtj as Float64Array;
  assert.equal(ev.cost, 0, `the fixture is not at a zero-residual point (cost ${ev.cost})`);

  // Parameters here are metres, degrees and unitless distortion coefficients at
  // once, so a single absolute step is meaningless. Everything below is done in
  // units of each parameter's own characteristic scale.
  const S = Float64Array.from(v0, (x) => 1 + Math.abs(x));
  const H = 1e-6;

  const work = cloneState(base);
  const costAt = (vec: Float64Array): number => {
    unpackState(vec, work, layout);
    return evaluate(work, problem, false).cost;
  };

  // The largest scaled diagonal, read straight off jtj — no evaluations needed —
  // to tell a genuinely null direction from a mistake.
  let maxQ = 0;
  for (let i = 0; i < n; i++) maxQ = Math.max(maxQ, S[i] * S[i] * jtj[i * n + i]);
  assert.ok(maxQ > 0, 'jtj has no positive diagonal');

  const probe = (dhat: Float64Array): { ratio: number; q: number } => {
    const d = Float64Array.from(dhat, (x, i) => x * S[i]);
    let q = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) row += jtj[i * n + j] * d[j];
      q += d[i] * row;
    }
    const vp = Float64Array.from(v0);
    const vm = Float64Array.from(v0);
    for (let i = 0; i < n; i++) {
      vp[i] += H * d[i];
      vm[i] -= H * d[i];
    }
    // cost(base) is exactly zero, so the usual three-point stencil loses its
    // middle term.
    return { ratio: (costAt(vp) + costAt(vm)) / (H * H) / (2 * q), q };
  };

  let checked = 0;
  let nullish = 0;
  for (let i = 0; i < n; i++) {
    const d = new Float64Array(n);
    d[i] = 1;
    const r = probe(d);
    if (r.q < maxQ * 1e-10) {
      nullish++;
      continue;
    }
    checked++;
    assert.ok(
      Math.abs(r.ratio - 1) < 1e-4,
      `basis direction ${i} (slot ${layout.freeSlots[i]}): d'(2.jtj)d and the second ` +
        `difference of the cost disagree by ${Math.abs(r.ratio - 1)}`,
    );
  }
  // The gauge is three-dimensional, so a handful of axes lying in it is expected
  // and a great many would mean the fixture stopped exercising the matrix.
  assert.ok(
    checked > n / 2,
    `only ${checked} of ${n} basis directions carried any curvature (${nullish} near-null)`,
  );

  // Mixed directions, deterministic rather than random so a failure reproduces.
  let mixed = 0;
  for (let k = 0; k < 24; k++) {
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = Math.sin(1 + i * 7.3 + k * 2.1);
    let norm = 0;
    for (let i = 0; i < n; i++) norm += d[i] * d[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < n; i++) d[i] /= norm;
    const r = probe(d);
    if (r.q < maxQ * 1e-10) continue;
    mixed++;
    assert.ok(
      Math.abs(r.ratio - 1) < 1e-4,
      `mixed direction ${k}: d'(2.jtj)d and the second difference of the cost ` +
        `disagree by ${Math.abs(r.ratio - 1)} — an off-diagonal is wrong`,
    );
  }
  assert.ok(mixed >= 20, `only ${mixed} mixed directions carried curvature`);
});
