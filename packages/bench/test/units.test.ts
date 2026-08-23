/**
 * Unit tests for the scorer's own machinery.
 *
 * The bench is the thing that decides whether everything else works, so a bug
 * in here does not fail loudly — it reports a number. These tests exist to make
 * the scorer falsifiable: each one either recovers a quantity that was put in by
 * hand, or checks the bench's arithmetic against `packages/sim`'s independent
 * implementation of the same convention.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { projectorRotationMatrix } from '../../sim/src/geometry.ts';
import { emittedRadiance } from '../../sim/src/shading.ts';
import { nominalRig } from '../../sim/src/scene.ts';
import { matMul, matVec } from '../../sim/src/vec.ts';
import type { RigCalibration } from '../../calibration/src/index.ts';

import {
  applyGlobalRotation,
  axisAngleOf,
  eulerFromMatrix,
  fitGlobalRotation,
  hybridCalibration,
  poseErrors,
  rodrigues,
  rotationAngleDeg,
  scoreRecovery,
} from '../src/score.ts';
import {
  DEFAULT_PATTERN_PLAN,
  compileFrame,
  emittedRadianceForTarget,
  grayBitsForCamera,
  planFrames,
  signalForTarget,
  targetRadiance,
} from '../src/patterns.ts';
import { deriveSeed, makeBenchRng } from '../src/random.ts';
import { VOLATILE_PATHS, dispersion, stringifyResults } from '../src/results.ts';

// ---------------------------------------------------------------------------
// §R round trip
// ---------------------------------------------------------------------------

test('eulerFromMatrix inverts the forward model\'s own §R composition', () => {
  const cases = [
    { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    { yawDeg: 180, pitchDeg: 0, rollDeg: 0 },
    { yawDeg: -37.5, pitchDeg: 12.25, rollDeg: -3.75 },
    { yawDeg: 91.3, pitchDeg: -44.0, rollDeg: 179.0 },
    { yawDeg: 5, pitchDeg: 79.9, rollDeg: -120 },
  ];
  for (const c of cases) {
    const m = projectorRotationMatrix({ position: { x: 0, y: 0, z: 0 }, ...c });
    const back = eulerFromMatrix(m);
    const m2 = projectorRotationMatrix({ position: { x: 0, y: 0, z: 0 }, ...back });
    // The angles themselves can differ by a 360-degree wrap; the ROTATION
    // cannot. Comparing matrices is the statement that actually matters, and it
    // is the one a pose error is computed from.
    assert.ok(
      rotationAngleDeg(m, m2) < 1e-9,
      `round trip lost ${rotationAngleDeg(m, m2)} deg for ${JSON.stringify(c)}`,
    );
  }
});

test('rodrigues and axisAngleOf are inverses', () => {
  const axis = { x: 0.3, y: -0.5, z: 0.81 };
  const n = Math.hypot(axis.x, axis.y, axis.z);
  const angle = 0.037; // radians, the scale a gauge lives at
  const m = rodrigues((axis.x / n) * angle, (axis.y / n) * angle, (axis.z / n) * angle);
  const aa = axisAngleOf(m);
  assert.ok(Math.abs(aa.angleDeg - (angle * 180) / Math.PI) < 1e-9);
  assert.ok(Math.abs(aa.axis.x - axis.x / n) < 1e-9);
  assert.ok(Math.abs(aa.axis.z - axis.z / n) < 1e-9);
});

// ---------------------------------------------------------------------------
// Gauge fitting
// ---------------------------------------------------------------------------

test('fitGlobalRotation recovers a known rotation from a COPLANAR point set', () => {
  // The PARAMETERS.md §2 layout is four lenses at one height: coplanar, which is
  // the configuration `packages/solver` reports breaks a polar-decomposition
  // Kabsch. This fit must not care.
  const from = [
    { x: 5.18, y: 0, z: 0 },
    { x: 0, y: 5.18, z: 0 },
    { x: -5.18, y: 0, z: 0 },
    { x: 0, y: -5.18, z: 0 },
  ];
  const truth = rodrigues(0.004, -0.002, 0.009);
  const to = from.map((p) => matVec(truth, p));
  const fitted = fitGlobalRotation(from, to, [true, true, true]);
  assert.ok(
    rotationAngleDeg(fitted, truth) < 1e-9,
    `coplanar fit off by ${rotationAngleDeg(fitted, truth)} deg`,
  );
  // And it is a rotation, not a reflection: determinant +1.
  const det =
    fitted[0] * (fitted[4] * fitted[8] - fitted[5] * fitted[7]) -
    fitted[1] * (fitted[3] * fitted[8] - fitted[5] * fitted[6]) +
    fitted[2] * (fitted[3] * fitted[7] - fitted[4] * fitted[6]);
  assert.ok(Math.abs(det - 1) < 1e-12, `determinant ${det}`);
});

test('fitGlobalRotation restricted to Z leaves an X tilt alone', () => {
  const from = [
    { x: 5.18, y: 0, z: 0.1 },
    { x: 0, y: 5.18, z: -0.1 },
    { x: -5.18, y: 0, z: 0.2 },
    { x: 0, y: -5.18, z: 0 },
  ];
  // A tilt about X plus a twist about Z. With only Z free, the fit must take out
  // the twist and NOT the tilt — that is the whole reason the fit is
  // constrained, and an unconstrained one would hide the tilt in "the gauge".
  const applied = matMul(rodrigues(0, 0, 0.01), rodrigues(0.008, 0, 0));
  const to = from.map((p) => matVec(applied, p));
  const fitted = fitGlobalRotation(from, to, [false, false, true]);
  const aa = axisAngleOf(fitted);
  assert.ok(Math.abs(aa.axis.x) < 1e-9 && Math.abs(aa.axis.y) < 1e-9, 'fit left the Z axis');
  assert.ok(Math.abs(aa.angleDeg - (0.01 * 180) / Math.PI) < 0.02, `twist ${aa.angleDeg}`);
  // The residual after fitting still carries the tilt, i.e. it was not absorbed.
  let worst = 0;
  for (let i = 0; i < from.length; i++) {
    const a = matVec(fitted, from[i]);
    worst = Math.max(worst, Math.hypot(a.x - to[i].x, a.y - to[i].y, a.z - to[i].z));
  }
  assert.ok(worst > 0.01, `tilt was absorbed: residual only ${worst} m`);
});

// ---------------------------------------------------------------------------
// Scoring correctness: put a perturbation in, get it back out
// ---------------------------------------------------------------------------

function shiftProjector(
  rig: RigCalibration,
  index: number,
  dx: number,
  dy: number,
  dz: number,
  dRollDeg: number,
): RigCalibration {
  return {
    ...rig,
    projectors: rig.projectors.map((p, i) =>
      i !== index
        ? p
        : {
            ...p,
            pose: {
              position: {
                x: p.pose.position.x + dx,
                y: p.pose.position.y + dy,
                z: p.pose.position.z + dz,
              },
              yawDeg: p.pose.yawDeg,
              pitchDeg: p.pose.pitchDeg,
              rollDeg: p.pose.rollDeg + dRollDeg,
            },
          },
    ),
  };
}

test('poseErrors reports exactly the perturbation it was given', () => {
  const truth = nominalRig({ projectorCount: 4 });
  const moved = shiftProjector(truth, 1, 0.007, -0.003, 0.0025, 0.031);
  const e = poseErrors(moved, truth);

  assert.equal(e.perProjector[0].positionMm, 0);
  assert.ok(Math.abs(e.perProjector[1].dxMm - 7) < 1e-9);
  assert.ok(Math.abs(e.perProjector[1].dyMm + 3) < 1e-9);
  assert.ok(Math.abs(e.perProjector[1].dzMm - 2.5) < 1e-9);
  assert.ok(Math.abs(e.perProjector[1].positionMm - Math.hypot(7, 3, 2.5)) < 1e-9);
  assert.ok(Math.abs(e.perProjector[1].rollDeg - 0.031) < 1e-9);
  // Roll is a rotation about the optical axis, so the total rotation angle IS
  // the roll here — a check that the angle is being taken between matrices and
  // not by summing Euler components.
  assert.ok(Math.abs(e.perProjector[1].rotationDeg - 0.031) < 1e-9);
  assert.ok(Math.abs(e.maxPositionMm - Math.hypot(7, 3, 2.5)) < 1e-9);
});

test('a diverged projector poisons the maximum instead of being skipped by it', () => {
  // A bundle that diverges hands back a non-finite pose, and `poseErrors` used
  // to take its maxima with `if (positionMm > maxP)`. Every comparison against
  // NaN is false, so the non-finite projector was SKIPPED: the maximum stayed
  // at the largest finite value it happened to see. The failure mode is not a
  // wrong number, it is a passing gate — `pose_position` scores
  // `aligned.maxPositionMm`, so a rig with one diverged projector could report
  // a small maximum and pass, while its own `perProjector` entry beside it read
  // NaN and the RMS read NaN too (`sumP` was never comparison-guarded).
  const truth = nominalRig({ projectorCount: 4 });
  const moved = shiftProjector(truth, 1, 0.007, -0.003, 0.0025, 0.031);

  // Projector 2 diverges; projector 3 is finite and comes AFTER it, which is
  // the case a sticky-NaN written as a comparison would still get wrong.
  const diverged: RigCalibration = {
    ...moved,
    projectors: moved.projectors.map((p, i) =>
      i !== 2
        ? p
        : { ...p, pose: { ...p.pose, position: { x: NaN, y: p.pose.position.y, z: p.pose.position.z } } },
    ),
  };
  const e = poseErrors(diverged, truth);

  assert.ok(Number.isNaN(e.perProjector[2].positionMm), 'the diverged projector really is NaN');
  assert.ok(Number.isFinite(e.perProjector[3].positionMm), 'and a later projector is not');
  assert.ok(
    Number.isNaN(e.maxPositionMm),
    'so the maximum cannot be a finite number the gate would pass',
  );
  // The RMS already reported it. The two must not disagree about whether the
  // rig was measurable.
  assert.ok(Number.isNaN(e.rmsPositionMm));

  // Rotation is untouched here, so it stays finite and scorable: the poisoning
  // is per quantity, not a blanket write-off of the whole rig.
  assert.ok(Number.isFinite(e.maxRotationDeg));
  assert.ok(Math.abs(e.maxRotationDeg - 0.031) < 1e-9);
});

test('a pure gauge rotation is large raw and vanishes after alignment', () => {
  const truth = nominalRig({ projectorCount: 4 });
  const cams = [
    { position: { x: 2.4, y: 0.3, z: -0.5 }, yawDeg: 175, pitchDeg: 5, rollDeg: 1 },
    { position: { x: -1.0, y: 2.3, z: -0.7 }, yawDeg: -60, pitchDeg: 8, rollDeg: -2 },
    { position: { x: -0.5, y: -2.5, z: -0.4 }, yawDeg: 70, pitchDeg: 4, rollDeg: 0 },
  ];

  const angleRad = 0.25 * (Math.PI / 180);
  const g = rodrigues(0, 0, angleRad);
  const rotated = applyGlobalRotation(truth, g);
  const rotatedCams = cams.map((c) => {
    const m = matMul(g, projectorRotationMatrix(c));
    return { position: matVec(g, c.position), ...eulerFromMatrix(m) };
  });

  const score = scoreRecovery({
    truthRig: truth,
    recoveredRig: rotated,
    truthCameras: cams,
    recoveredCameras: rotatedCams,
    cameraIds: ['C1', 'C2', 'C3'],
    gaugeFreeAxes: [true, true, true],
    centerHeightObserved: true,
    nominalCenterHeightM: 2.1844,
  });

  // 0.25 degrees at 5.18 m is 22.6 mm of lens displacement. Raw, that is a
  // catastrophic pose error; it is also completely invisible to any solver.
  assert.ok(score.raw.maxPositionMm > 20, `raw ${score.raw.maxPositionMm} mm`);
  assert.ok(Math.abs(score.raw.maxRotationDeg - 0.25) < 1e-6);
  assert.ok(Math.abs(score.gauge.angleDeg - 0.25) < 1e-6, `gauge ${score.gauge.angleDeg}`);
  assert.ok(score.aligned.maxPositionMm < 1e-6, `aligned ${score.aligned.maxPositionMm} mm`);
  assert.ok(score.aligned.maxRotationDeg < 1e-9);
});

test('a real error survives gauge alignment; only the rotation is removed', () => {
  const truth = nominalRig({ projectorCount: 4 });
  // One projector genuinely displaced 12 mm outward, plus a global 0.2 degree
  // twist. The twist must come out and the 12 mm must not.
  const moved = shiftProjector(truth, 2, -0.012, 0, 0, 0);
  const g = rodrigues(0, 0, 0.2 * (Math.PI / 180));
  const recovered = applyGlobalRotation(moved, g);

  const score = scoreRecovery({
    truthRig: truth,
    recoveredRig: recovered,
    truthCameras: [],
    recoveredCameras: [],
    cameraIds: [],
    gaugeFreeAxes: [true, true, true],
    centerHeightObserved: true,
    nominalCenterHeightM: 2.1844,
  });

  assert.ok(score.raw.maxPositionMm > 15, `raw ${score.raw.maxPositionMm}`);
  // The gauge fit sees three unmoved projectors and one moved by 12 mm, so it
  // lands very close to the applied twist but not exactly on it.
  assert.ok(Math.abs(score.gauge.angleDeg - 0.2) < 0.02, `gauge ${score.gauge.angleDeg}`);
  assert.ok(score.aligned.maxPositionMm > 8, `aligned ${score.aligned.maxPositionMm}`);
  assert.ok(score.aligned.maxPositionMm < 14, `aligned ${score.aligned.maxPositionMm}`);
});

test('hybridCalibration swaps exactly one group', () => {
  const truth = nominalRig({ projectorCount: 4 });
  const recovered = shiftProjector(truth, 0, 0.05, 0, 0, 1.5);
  const bumped: RigCalibration = {
    ...recovered,
    projectors: recovered.projectors.map((p, i) =>
      i !== 0 ? p : { ...p, intrinsics: { ...p.intrinsics, k1: p.intrinsics.k1 + 0.01 } },
    ),
  };

  const posFixed = hybridCalibration(bumped, truth, 'position');
  assert.equal(posFixed.projectors[0].pose.position.x, truth.projectors[0].pose.position.x);
  assert.equal(posFixed.projectors[0].pose.rollDeg, bumped.projectors[0].pose.rollDeg);
  assert.equal(posFixed.projectors[0].intrinsics.k1, bumped.projectors[0].intrinsics.k1);

  const radialFixed = hybridCalibration(bumped, truth, 'radial');
  assert.equal(radialFixed.projectors[0].intrinsics.k1, truth.projectors[0].intrinsics.k1);
  assert.equal(radialFixed.projectors[0].pose.position.x, bumped.projectors[0].pose.position.x);

  assert.equal(hybridCalibration(bumped, truth, 'none'), bumped);
  assert.equal(hybridCalibration(bumped, truth, 'all'), truth);
});

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

test('the closed-form emitted radiance matches the full §P inversion', () => {
  // The render path uses `clamp(T, gain*floor, gain)` instead of inverting the
  // transfer per pixel. That identity is the reason gamma drops out of a
  // structured-light capture, and it is checked here against `packages/sim`'s
  // OWN forward transfer rather than against the bench's algebra.
  const cases = [
    { gamma: 2.2, blackFloor: 1 / 800, gain: 1 },
    { gamma: 2.45, blackFloor: 1 / 300, gain: 0.92 },
    { gamma: 1.9, blackFloor: 1 / 2000, gain: 1.08 },
  ];
  for (const c of cases) {
    for (const target of [0, 0.0001, 0.00125, 0.05, 0.5, 0.73, 0.999, 1, 1.2]) {
      const signal = signalForTarget(target, c.gamma, c.blackFloor, c.gain);
      const forward = emittedRadiance(signal, c.gamma, c.blackFloor, c.gain);
      const closed = emittedRadianceForTarget(target, {
        gamma: { r: c.gamma, g: c.gamma, b: c.gamma },
        blackFloor: { r: c.blackFloor, g: c.blackFloor, b: c.blackFloor },
        gain: { r: c.gain, g: c.gain, b: c.gain },
        whitePointK: 6500,
      }).r;
      assert.ok(
        Math.abs(forward - closed) < 1e-12,
        `T=${target} gamma=${c.gamma}: forward ${forward} vs closed ${closed}`,
      );
    }
  }
});

test('a black frame still emits the projector black floor', () => {
  // PARAMETERS.md §3.2: the floor survives V = 0, and it is what sets the
  // modulation floor the decoder rejects on. If this ever returns 0 the capture
  // has silently become noiseless in the dark.
  const t = {
    gamma: { r: 2.2, g: 2.2, b: 2.2 },
    blackFloor: { r: 1 / 800, g: 1 / 800, b: 1 / 400 },
    gain: { r: 1, g: 1, b: 0.9 },
    whitePointK: 6500,
  };
  const e = emittedRadianceForTarget(0, t);
  assert.ok(Math.abs(e.r - 1 / 800) < 1e-15);
  assert.ok(Math.abs(e.b - 0.9 / 400) < 1e-15);
});

test('compileFrame agrees with the reference targetRadiance everywhere', () => {
  const plan = { ...DEFAULT_PATTERN_PLAN, grayBits: 5 };
  const specs = planFrames(plan);
  for (const spec of specs) {
    const frame = compileFrame(spec, plan, 1920, 1080);
    for (let i = 0; i < 200; i++) {
      const u = (i * 1920) / 200 + 0.5;
      const v = (i * 1080) / 200 + 0.5;
      const a = frame.at(frame.axis === 'v' ? v : u);
      const b = targetRadiance(spec, u, v, plan, 1920, 1080);
      assert.equal(a, b, `${spec.kind} ${spec.axis}#${spec.index} at u=${u}`);
    }
  }
});

test('planFrames pairs each Gray plane with its own complement, adjacently', () => {
  const plan = { ...DEFAULT_PATTERN_PLAN, grayBits: 4 };
  const specs = planFrames(plan);
  assert.equal(specs[0].kind, 'white');
  assert.equal(specs[1].kind, 'black');
  for (let i = 2; i < 2 + 2 * plan.grayBits * 2; i += 2) {
    assert.equal(specs[i].kind, 'gray');
    assert.equal(specs[i + 1].kind, 'grayInverse');
    assert.equal(specs[i].axis, specs[i + 1].axis);
    assert.equal(specs[i].index, specs[i + 1].index);
  }
  assert.equal(specs.length, 2 + 4 * plan.grayBits + 2 * plan.phaseSteps);
});

test('grayBitsForCamera keeps the finest stride above the camera resolution', () => {
  // 4.4 projector pixels per camera pixel is the nominal geometry: a 320-wide
  // phone at 2.6 m against a 1920-wide projector at 5.18 m.
  assert.equal(grayBitsForCamera(1920, 4.4, 4), 6);
  // A finer camera earns more planes; a coarser one loses them.
  assert.equal(grayBitsForCamera(1920, 1.1, 4), 8);
  assert.ok(grayBitsForCamera(1920, 20, 4) <= 4);
});

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

test('sub-streams are addressed by name, not by draw order', () => {
  const a = makeBenchRng(7);
  const b = makeBenchRng(7);
  // Consuming from the parent must not change what a named fork produces —
  // otherwise adding a knob to one part of a scenario renumbers every other
  // part of the corpus.
  a.gaussian();
  a.gaussian();
  a.gaussian();
  assert.equal(a.fork('cameras').gaussian(), b.fork('cameras').gaussian());
  assert.notEqual(makeBenchRng(7).fork('cameras').gaussian(), makeBenchRng(7).fork('floor').gaussian());
});

test('adjacent seeds are decorrelated', () => {
  // The loop hands out adjacent seeds by construction, so a generator whose
  // first draw is a smooth function of the seed would make consecutive rounds
  // look correlated.
  const first: number[] = [];
  for (let s = 1; s <= 64; s++) first.push(makeBenchRng(s).nextFloat());
  const mean = first.reduce((a, b) => a + b, 0) / first.length;
  assert.ok(Math.abs(mean - 0.5) < 0.12, `mean of first draws ${mean}`);
  let ascending = 0;
  for (let i = 1; i < first.length; i++) if (first[i] > first[i - 1]) ascending++;
  assert.ok(ascending > 20 && ascending < 43, `monotone run: ${ascending}/63 ascending`);
});

test('deriveSeed is stable and label-sensitive', () => {
  assert.equal(deriveSeed(1234, 'scenario:0:clean'), deriveSeed(1234, 'scenario:0:clean'));
  assert.notEqual(deriveSeed(1234, 'scenario:0:clean'), deriveSeed(1234, 'scenario:1:clean'));
  assert.notEqual(deriveSeed(1234, 'scenario:0:clean'), deriveSeed(1235, 'scenario:0:clean'));
});

// ---------------------------------------------------------------------------
// Results serialisation
// ---------------------------------------------------------------------------

test('dispersion reports the shape, not just the middle', () => {
  // A bimodal sample: five good scenarios and one catastrophe. The mean is
  // unremarkable and the p95 and max are not, which is the whole argument for
  // carrying both.
  const d = dispersion([1, 1.1, 0.9, 1.05, 0.95, 40]);
  assert.equal(d.count, 6);
  assert.ok(d.median < 1.2);
  assert.ok(d.max === 40);
  assert.ok(d.iqr < 0.3, `iqr ${d.iqr}`);
  assert.ok(d.stdDev > 10);
  assert.deepEqual(d.values, [1, 1.1, 0.9, 1.05, 0.95, 40]);
});

test('dispersion keeps non-finite values in the series but out of the statistics', () => {
  const d = dispersion([1, NaN, 3]);
  assert.equal(d.count, 2);
  assert.equal(d.mean, 2);
  assert.equal(d.values.length, 3);
  assert.ok(Number.isNaN(d.values[1]));
});

test('stringifyResults writes numeric arrays inline and NaN as null', () => {
  const text = stringifyResults({ a: [1, 2, NaN, 4], b: { c: 'x' }, d: [] });
  assert.match(text, /"a": \[1, 2, null, 4\]/);
  assert.match(text, /"d": \[\]/);
  // And it must still be parseable, which is the only property that is not
  // negotiable.
  const back = JSON.parse(text) as { a: (number | null)[] };
  assert.deepEqual(back.a, [1, 2, null, 4]);
});

test('the volatile path list is the one tools/assert-deterministic.ts knows', async () => {
  // The determinism tool carries its own copy on purpose — see its module note.
  // This test is the third party that notices when the two drift apart, because
  // a silently widened exclusion list is how a determinism check stops checking.
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const tool = fs.readFileSync(path.join(here, '..', '..', '..', 'tools', 'assert-deterministic.ts'), 'utf8');
  // Non-greedy up to the terminating `];`, because one of the paths itself
  // contains a `]` and a naive character class stops inside it.
  const match = /const VOLATILE_PATHS: string\[\] = \[([\s\S]*?)\];/.exec(tool);
  assert.ok(match !== null, 'could not find VOLATILE_PATHS in the tool');
  const declared = match[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);
  assert.deepEqual(declared, VOLATILE_PATHS);
});
