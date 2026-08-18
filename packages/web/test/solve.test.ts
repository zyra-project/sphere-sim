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
import { BOULDER_PRESET, IN_TO_M } from '../src/settings.ts';
import { buildWorld } from '../src/rigs.ts';
import { cameraDistanceM, runSolve } from '../src/pipeline.ts';
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
    if (p.shotCameras) shots = p.shotCameras.length;
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
  assert.equal(shots, req.cameraCount, `expected one camera pose per camera, got ${shots}`);

  // And it can say what it moved and whether it moved to the right place.
  assert.ok(result.recovery.length > 0, 'the recovery table is empty');
  for (const row of result.recovery) {
    assert.ok(Number.isFinite(row.errorFromTruth), `${row.projectorId} ${row.axis} has no error`);
    assert.ok(/^P[1-4]$/.test(row.projectorId));
  }
  // Azimuth comes from `atan2`, which cuts at 180 degrees. A projector sitting
  // on that cut reported a tenth of a degree of real movement as 359.8, and the
  // sort put that fiction at the top of the table.
  for (const row of result.recovery) {
    if (row.unit !== '\u00b0') continue;
    assert.ok(
      Math.abs(row.moved) <= 180 && Math.abs(row.errorFromTruth) <= 180,
      `${row.projectorId} ${row.axis} reports ${row.moved.toFixed(1)}deg of movement — ` +
        'an angle difference has not been wrapped to the short way round',
    );
  }

  // Sorted by how far the solve moved each axis MEASURED ON THE SPHERE, largest
  // first. Raw magnitude put 60 mm above 0.3 degrees every time, so the six rows
  // the page prints under "largest movements first" were six distances and
  // heights and never an angle, however far the aim had been knocked.
  const throwMm = new Map<string, number>();
  for (const r of result.recovery) {
    if (r.axis === 'distance to sphere') throwMm.set(r.projectorId, r.recovered);
  }
  const rank = (r: (typeof result.recovery)[number]): number =>
    Math.abs(r.moved) *
    (r.unit === 'mm' ? 1 : ((throwMm.get(r.projectorId) ?? 0) * Math.PI) / 180);
  const ranks = result.recovery.map(rank);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(
      ranks[i - 1] >= ranks[i] - 1e-9,
      `row ${i} ranks ${ranks[i].toFixed(3)} above row ${i - 1}'s ${ranks[i - 1].toFixed(3)}`,
    );
  }

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

test('the operator stands back further for a bigger ball, and at the same height', () => {
  // The capture geometry is quoted for §1's 68-inch sphere: 2.6 m from the
  // centre, inside §6's 2.0–3.5 m band, bounded below by a guard rail at 1.9 m.
  // None of that survives a 130-inch ball at a fixed distance — the camera would
  // be 0.95 m off the surface, inside the rail, seeing a fraction of the
  // silhouette — so the distance scales with the radius.
  const nominal = (68 * IN_TO_M) / 2;
  assert.ok(
    Math.abs(cameraDistanceM(nominal) - 2.6) < 1e-9,
    'the default sphere must place the cameras exactly where it always did',
  );

  const big = (130 * IN_TO_M) / 2;
  assert.ok(cameraDistanceM(big) > big + 1.2, 'a big ball needs the camera outside the rail');
  // Proportional, so the silhouette subtends the same angle in every capture —
  // which is the property the solve actually depends on.
  assert.ok(Math.abs(cameraDistanceM(big) / big - cameraDistanceM(nominal) / nominal) < 1e-9);

  const small = (40 * IN_TO_M) / 2;
  assert.ok(cameraDistanceM(small) < 2.6, 'and a small one lets the operator come in');
});
