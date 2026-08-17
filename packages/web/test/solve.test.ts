/**
 * The live calibration, run for real.
 *
 * This is slow — it photographs a sphere with structured light and runs a bundle
 * adjustment — and it is the only test in this package that exercises the
 * inverse model at all. It is worth the seconds: the page's central claim is
 * that pressing a button recovers a rig from photographs, and nothing else here
 * checks that the claim survives contact with the pipeline.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { RigCalibration } from '../../calibration/src/index.ts';
import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import { BOULDER_PRESET } from '../src/settings.ts';
import { buildWorld } from '../src/rigs.ts';
import { runSolve } from '../src/pipeline.ts';
import type { SolvePhase, SolveRequest } from '../src/protocol.ts';

function request(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return {
    kind: 'solve',
    id: 1,
    settings: BOULDER_PRESET,
    cameraCount: 2,
    cameraResX: 320,
    cameraResY: 240,
    handheld: false,
    sensorNoise: true,
    customImage: null,
    customImageId: '',
    ambient: 0.04,
    seed: 20260817,
    ...overrides,
  };
}

test('a solve recovers the rig from photographs and improves the alignment', { timeout: 300_000 }, () => {
  const phases: SolvePhase[] = [];
  let shots = 0;
  const req = request();
  // One run, everything read off its progress stream. A second solve to count
  // the previews would double the slowest test in the suite for a number this
  // one already carries.
  const result = runSolve(req, (p) => {
    phases.push(p.phase);
    if (p.shots) shots = p.shots.length;
  });

  // It really did photograph something.
  assert.ok(result.frames > 50, `expected a real pattern sequence, got ${result.frames} frames`);
  assert.ok(
    result.correspondences > 500,
    `expected a usable point cloud, got ${result.correspondences} correspondences`,
  );
  assert.ok(result.grayBits >= 3 && result.grayBits <= 8, `implausible Gray depth ${result.grayBits}`);

  // The page shows one photograph per camera position. Zero of them would leave
  // "what it worked from" empty with no indication that anything was wrong.
  assert.equal(shots, req.cameraCount, `expected one preview per camera, got ${shots}`);

  // And it can say what it moved and whether it moved to the right place.
  assert.ok(result.recovery.length > 0, 'the recovery table is empty');
  for (const row of result.recovery) {
    assert.ok(Number.isFinite(row.errorFromTruth), `${row.projectorId} ${row.axis} has no error`);
    assert.ok(/^P[1-4]$/.test(row.projectorId));
  }
  // Sorted by how far the solve moved each axis, largest first: the page shows
  // the top handful and what a reader wants is what it actually did.
  const moves = result.recovery.map((r) => Math.abs(r.moved));
  assert.deepEqual(moves, [...moves].sort((a, b) => b - a));

  // And it converged to something with a small residual.
  assert.ok(result.converged, 'the bundle adjustment hit its iteration cap');
  assert.ok(result.residualRmsPx < 1, `residual ${result.residualRmsPx} px is not a converged solve`);

  // The page shows these; they must be finite and the right order of magnitude.
  assert.ok(Number.isFinite(result.posePositionMm) && result.posePositionMm >= 0);
  assert.ok(Number.isFinite(result.poseRotationDeg) && result.poseRotationDeg >= 0);
  assert.ok(Number.isFinite(result.gaugeAngleDeg));

  // Progress was reported in order and reached the end. The bundle stage now
  // reports every accepted optimiser step, so the assertion is on the sequence
  // of DISTINCT phases: pinning the count would turn a solver that converged in
  // one fewer iteration into a test failure.
  const distinct = phases.filter((p, i) => i === 0 || p !== phases[i - 1]);
  assert.deepEqual(distinct, ['capture', 'decode', 'initialize', 'bundle', 'score']);
  assert.ok(
    phases.filter((p) => p === 'bundle').length > 3,
    'the optimiser reported no convergence steps, so the page would show a bare spinner',
  );

  // The claim the headline makes: the recovered calibration aligns the content
  // better than the config as written did. Measured through `packages/sim`,
  // exactly as the page measures it.
  const world = buildWorld(BOULDER_PRESET);
  const at = (contentRig: RigCalibration): number =>
    computeGeometricMetrics(world.truthRig, world.scene, {
      contentRig,
      densityScale: 0.35,
      convergence: false,
    }).grid.metric.value;

  const before = at(world.asBuiltRig);
  const after = at(result.recoveredRig);
  assert.ok(
    after < before,
    `the calibration must help: ${before.toFixed(2)} mm before, ${after.toFixed(2)} mm after`,
  );
  assert.ok(
    after < before / 2,
    `and by a margin worth showing: ${before.toFixed(2)} -> ${after.toFixed(2)} mm`,
  );
});

test('the same seed solves to the same answer', { timeout: 300_000 }, () => {
  // Determinism is what makes the before/after on the page mean anything. If two
  // presses of the button gave different numbers, every comparison it draws
  // would be measuring noise.
  const a = runSolve(request());
  const b = runSolve(request());
  assert.equal(a.correspondences, b.correspondences);
  assert.equal(a.residualRmsPx, b.residualRmsPx);
  assert.deepEqual(a.recoveredRig, b.recoveredRig);
});

test('a handheld capture localises worse than a tripod', { timeout: 600_000 }, () => {
  // Experiment 1's headline, at the page's own settings: the tripod-versus-hand
  // difference outweighs sensor noise, room light and camera resolution put
  // together. The page offers the switch and this is the claim behind it.
  const tripod = runSolve(request({ handheld: false }));
  const hand = runSolve(request({ handheld: true, id: 2 }));
  assert.ok(
    hand.residualRmsPx > tripod.residualRmsPx,
    `handheld ${hand.residualRmsPx.toFixed(3)} px should exceed tripod ` +
      `${tripod.residualRmsPx.toFixed(3)} px`,
  );
});
