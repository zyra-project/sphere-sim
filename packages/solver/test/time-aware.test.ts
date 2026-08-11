/**
 * The time-aware decode: a correspondence's two coordinates were photographed
 * at two different times, and a bundle that models one camera pose per capture
 * has nowhere to put the difference.
 *
 * What these tests have to establish, in order:
 *
 *  - the epochs are read off the capture's own structure and mean what the
 *    normative order in `decode.ts` says they mean;
 *  - carrying them changes NOTHING unless the rate is freed, so the default
 *    build is untouched;
 *  - freeing the rate recovers a rig from a moving camera that a single pose
 *    cannot;
 *  - it does NOT absorb a projector pose error, which is the failure mode that
 *    would make the mechanism worse than useless — it would hide the quantity
 *    PARAMETERS.md §7 scores;
 *  - and the six extra degrees of freedom per camera are not handed out when
 *    the data cannot see them, nor do they wreck the conditioning when it can.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BUNDLE_OPTIONS,
  DEFAULT_FREE_FLAGS,
  DEFAULT_GAUGE_OPTIONS,
  buildLayout,
  buildProblem,
  epochTable,
  evaluate,
  gaugeNullSpace,
  runBundle,
  type BundleOptions,
  type BundleState,
  type FloorReference,
} from '../src/bundle.ts';
import { DEFAULT_ROBUST_OPTIONS } from '../src/robust.ts';
import { captureEpochs, decodeAll } from '../src/decode.ts';
import { jacobiEigenSymmetric } from '../src/linalg.ts';
import { bundleStateFromCalibration, solveFromCorrespondences } from '../src/index.ts';
import { slotCamera } from '../src/bundle.ts';
import { CAM_VPX } from '../src/sphere.ts';
import {
  alignToTruth,
  generateCorrespondences,
  makeScene,
  renderAllCaptures,
  renderCapture,
  scoreRecovery,
} from './synthetic.ts';

const SMALL = { cameraRes: { x: 240, y: 180 }, cameraCount: 3 };

function floorAtEveryLens(truth: BundleState): FloorReference[] {
  return truth.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM: p.position.z + truth.centerHeightM,
    sigmaM: 0.002,
  }));
}

/** A camera that drifts: sway-scale motion, a few tenths of a mm per frame. */
function moving(truth: BundleState): BundleState {
  for (const cam of truth.cameras) {
    cam.velocity = {
      px: 0.0005,
      py: -0.0003,
      pz: 0.0002,
      yawDeg: 0.0125,
      pitchDeg: -0.006,
      rollDeg: 0.004,
    };
  }
  return truth;
}

// ---------------------------------------------------------------------------
// The epochs
// ---------------------------------------------------------------------------

test('the epochs come off the capture structure, in the documented order', () => {
  const scene = makeScene(6101, SMALL);
  const captures = renderAllCaptures(scene.truth, { grayBits: 6, phaseSteps: 4 });
  const e = captureEpochs(captures[0]);
  // white, black, then 2 axes x 6 Gray planes x (pattern + complement) = 24,
  // then 4 phase steps per axis. So the `u` phase block is frames 26..29 and the
  // `v` block 30..33, and the epoch of each is its block's mean.
  assert.equal(e.frames, 34);
  assert.equal(e.u, 27.5);
  assert.equal(e.v, 31.5);
  // The gap between the two coordinates is exactly one phase block, which is
  // the quantity the whole mechanism turns on.
  assert.equal(e.v - e.u, 4);
});

test('sequential timing continues the clock across captures; perCapture restarts it', () => {
  const scene = makeScene(6102, SMALL);
  // One camera's view of two projectors, which is the smallest input on which
  // "the second sequence was shot after the first" says anything.
  const captures = [
    renderCapture(scene.truth, 0, 0, { grayBits: 4, phaseSteps: 4 }),
    renderCapture(scene.truth, 0, 1, { grayBits: 4, phaseSteps: 4 }),
  ];
  const per = decodeAll(captures, { pixelStride: 4 });
  const seq = decodeAll(captures, { pixelStride: 4, frameEpochs: 'sequential' });
  const frames = captureEpochs(captures[0]).frames;

  const firstOfPair = (cs: readonly { projector: number; timeU: number }[], p: number): number =>
    cs.find((c) => c.projector === p)!.timeU;
  assert.equal(firstOfPair(per.correspondences, 0), firstOfPair(per.correspondences, 1));
  assert.equal(
    firstOfPair(seq.correspondences, 1) - firstOfPair(seq.correspondences, 0),
    frames,
  );
});

test('epochs are inert: carrying them changes no number unless the rate is freed', () => {
  const scene = makeScene(6103, SMALL);
  const captures = renderAllCaptures(scene.truth, { noiseSigma: 0.004, seed: 3 });
  const floor = floorAtEveryLens(scene.truth);
  const nominal = bundleStateFromCalibration(scene.nominal, scene.cameraInputs);

  const withEpochs = decodeAll(captures, {}).correspondences;
  const without = decodeAll(captures, { frameEpochs: 'off' }).correspondences;
  assert.ok(withEpochs[0].timeU > 0, 'the default decode should report epochs');
  assert.equal(without[0].timeU, 0);

  const held = { free: { ...DEFAULT_FREE_FLAGS, cameraVelocity: 'off' as const } };
  const a = runBundle(nominal, without, floor, held, nominal);
  const b = runBundle(nominal, withEpochs, floor, held, nominal);
  // Bit-for-bit, not approximately. An epoch that is only READ when the rate is
  // free must not perturb a single arithmetic operation when it is not.
  assert.equal(a.cost, b.cost);
  assert.equal(a.rmsResidualPx, b.rmsResidualPx);
  assert.equal(a.used, b.used);
  assert.equal(a.rejected, b.rejected);
  assert.equal(a.state.projectors[0].fovHDeg, b.state.projectors[0].fovHDeg);
  for (const m of b.cameraMotion) assert.equal(m.translationMm, 0);

  // And the other direction, which is what protects a caller who decoded
  // without a clock: the DEFAULT flags on a capture that carries no epochs
  // reproduce the rate-held solve exactly, because `buildLayout` refuses to
  // hand out a parameter the data cannot see.
  const c = runBundle(nominal, without, floor, {}, nominal);
  assert.equal(c.cost, a.cost);
  assert.equal(c.rmsResidualPx, a.rmsResidualPx);
});

// ---------------------------------------------------------------------------
// What it buys
// ---------------------------------------------------------------------------

test('a moving camera: the rate recovers a rig the single pose cannot', () => {
  const scene = makeScene(6104, SMALL);
  moving(scene.truth);
  // Epochs four frames apart, which is what the capture protocol produces.
  const corrs = generateCorrespondences(scene.truth, {
    cameraStride: 6,
    noisePx: 0.05,
    epochU: 0,
    epochV: 4,
  });
  const floor = floorAtEveryLens(scene.truth);

  const score = (
    cameraVelocity: 'off' | 'rotation' | 'full',
  ): ReturnType<typeof scoreRecovery> => {
    const res = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
      bundle: { free: { ...DEFAULT_FREE_FLAGS, cameraVelocity } },
    });
    const state: BundleState = {
      ...bundleStateFromCalibration(res.calibration, []),
      cameras: res.extra.cameras,
    };
    return scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
  };

  const off = score('off');
  const on = score('full');
  assert.ok(
    on.maxProjectorPositionM < off.maxProjectorPositionM / 3,
    `position ${off.maxProjectorPositionM * 1000} -> ${on.maxProjectorPositionM * 1000} mm`,
  );
  assert.ok(
    on.maxProjectorRotationDeg < off.maxProjectorRotationDeg / 3,
    `rotation ${off.maxProjectorRotationDeg} -> ${on.maxProjectorRotationDeg} deg`,
  );
});

test('the recovered rate is the motion that was there, not a free parameter', () => {
  const scene = makeScene(6105, SMALL);
  moving(scene.truth);
  const corrs = generateCorrespondences(scene.truth, {
    cameraStride: 6,
    noisePx: 0.05,
    epochU: 0,
    epochV: 4,
  });
  const res = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrs,
    floorAtEveryLens(scene.truth),
    { bundle: { free: { ...DEFAULT_FREE_FLAGS, cameraVelocity: 'full' } } },
  );
  const v = scene.truth.cameras[0].velocity;
  const trueMm = Math.hypot(v.px, v.py, v.pz) * 4 * 1000;
  const trueDeg = Math.hypot(v.yawDeg, v.pitchDeg, v.rollDeg) * 4;
  for (const m of res.extra.cameraMotion) {
    assert.equal(m.spanFrames, 4);
    assert.ok(
      Math.abs(m.translationMm - trueMm) < 0.5 * trueMm,
      `recovered ${m.translationMm} mm against ${trueMm}`,
    );
    assert.ok(
      Math.abs(m.rotationDeg - trueDeg) < 0.5 * trueDeg,
      `recovered ${m.rotationDeg} deg against ${trueDeg}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Guard: it must not absorb a projector pose error
// ---------------------------------------------------------------------------

test('the rate does NOT absorb an injected projector pose error', () => {
  // The failure this rules out is the one round 2's `raw` coherence mode
  // committed: a mechanism that quietly eats a projector-level error stops the
  // bench measuring the thing it exists to measure. Two truths differing by a
  // known error on one projector; the difference between the two recovered rigs
  // has to BE that error, with the rate free and the camera moving.
  const inject = { projector: 1, yawDeg: 0.25, dx: 0.02 };

  const recovered = (injected: boolean): { yawDeg: number; x: number } => {
    const scene = makeScene(6106, SMALL);
    moving(scene.truth);
    if (injected) {
      scene.truth.projectors[inject.projector].yawDeg += inject.yawDeg;
      scene.truth.projectors[inject.projector].position.x += inject.dx;
    }
    const corrs = generateCorrespondences(scene.truth, {
      cameraStride: 6,
      noisePx: 0.05,
      epochU: 0,
      epochV: 4,
    });
    const res = solveFromCorrespondences(
      scene.nominal,
      scene.cameraInputs,
      corrs,
      floorAtEveryLens(scene.truth),
      { bundle: { free: { ...DEFAULT_FREE_FLAGS, cameraVelocity: 'full' } } },
    );
    const state: BundleState = {
      ...bundleStateFromCalibration(res.calibration, []),
      cameras: res.extra.cameras,
    };
    // Compared in each solve's own gauge-aligned frame, so the injection is not
    // measured against a rotation the solver could not observe anyway.
    const aligned = alignToTruth(state, scene.truth);
    const p = aligned.projectors[inject.projector];
    return { yawDeg: p.yawDeg, x: p.position.x };
  };

  const a = recovered(false);
  const b = recovered(true);
  const yawRatio = (b.yawDeg - a.yawDeg) / inject.yawDeg;
  const xRatio = (b.x - a.x) / inject.dx;
  assert.ok(yawRatio > 0.8 && yawRatio < 1.2, `injected yaw recovered at ${yawRatio}x`);
  assert.ok(xRatio > 0.8 && xRatio < 1.2, `injected position recovered at ${xRatio}x`);
});

// ---------------------------------------------------------------------------
// The extra degrees of freedom have to be earned
// ---------------------------------------------------------------------------

test('no epoch spread, no free rate: six parameters the data cannot see stay held', () => {
  const scene = makeScene(6107, SMALL);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 10 });
  const opts: BundleOptions = {
    ...DEFAULT_BUNDLE_OPTIONS,
    free: { ...DEFAULT_FREE_FLAGS, cameraVelocity: 'full' },
  };
  // Every correspondence carries the same epoch on both axes, so the rate is
  // multiplied by zero in every row it appears in. A layout that handed out the
  // columns anyway would be handing the damping six parameters to invent.
  const flat = epochTable(corrs, scene.truth.cameras.length, scene.truth.projectors.length);
  for (const s of flat.spread) assert.equal(s, 0);
  const held = buildLayout(scene.truth, opts, flat.spread);
  assert.equal(held.freeMap[slotCamera(held, 0, CAM_VPX)], -1);

  const spread = generateCorrespondences(scene.truth, {
    cameraStride: 10,
    epochU: 0,
    epochV: 4,
  });
  const table = epochTable(spread, scene.truth.cameras.length, scene.truth.projectors.length);
  for (const s of table.spread) assert.equal(s, 4);
  const free = buildLayout(scene.truth, opts, table.spread);
  assert.ok(free.freeMap[slotCamera(free, 0, CAM_VPX)] >= 0);
  assert.equal(free.n, held.n + 6 * scene.truth.cameras.length);
});

test('the rate does not degrade the conditioning of the normal equations', () => {
  const scene = makeScene(6108, SMALL);
  moving(scene.truth);
  const corrs = generateCorrespondences(scene.truth, {
    cameraStride: 6,
    noisePx: 0.05,
    epochU: 0,
    epochV: 4,
  });
  const floor = floorAtEveryLens(scene.truth);

  /**
   * The smallest eigenvalue of the gauge-augmented normal matrix in the
   * diagonally-scaled metric — i.e. exactly the matrix the LM step solves,
   * before damping. Reported in that metric because the raw one compares a
   * metre against a degree.
   */
  const spectrum = (
    cameraVelocity: 'off' | 'full',
  ): { n: number; min: number; cond: number } => {
    const res = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
      bundle: { free: { ...DEFAULT_FREE_FLAGS, cameraVelocity } },
    });
    const state: BundleState = {
      ...bundleStateFromCalibration(res.calibration, []),
      cameras: res.extra.cameras,
    };
    const opts: BundleOptions = {
      ...DEFAULT_BUNDLE_OPTIONS,
      free: { ...DEFAULT_FREE_FLAGS, cameraVelocity },
      gauge: DEFAULT_GAUGE_OPTIONS,
      loss: DEFAULT_ROBUST_OPTIONS,
    };
    const problem = buildProblem(state, corrs, floor, opts);
    const ev = evaluate(state, problem, true);
    const n = problem.layout.n;
    const jtj = ev.jtj!;
    let meanDiag = 0;
    for (let i = 0; i < n; i++) meanDiag += jtj[i * n + i];
    meanDiag /= n;
    for (const g of gaugeNullSpace(state, problem)) {
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) jtj[a * n + b] += meanDiag * g.dir[a] * g.dir[b];
      }
    }
    const scaled = new Float64Array(n * n);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = Math.sqrt(Math.max(jtj[i * n + i], 1e-300));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) scaled[i * n + j] = jtj[i * n + j] / (d[i] * d[j]);
    }
    const vals = Array.from(jacobiEigenSymmetric(scaled, n).values).sort((a, b) => a - b);
    return { n, min: vals[0], cond: vals[n - 1] / vals[0] };
  };

  const off = spectrum('off');
  const on = spectrum('full');
  assert.equal(on.n, off.n + 6 * scene.truth.cameras.length);
  // The near-null directions of this geometry are the shift/pointing ones the
  // README describes, and they are not what the rate adds. Half an order of
  // magnitude of slack, so the assertion is about "no new null space" rather
  // than about a number that will drift with the scene.
  assert.ok(
    on.min > off.min / 3,
    `smallest scaled eigenvalue ${off.min} -> ${on.min} (cond ${off.cond} -> ${on.cond})`,
  );
});
