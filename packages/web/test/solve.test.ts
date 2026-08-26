// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
import { BOULDER_PRESET, cameraDistanceM, IN_TO_M } from '../src/settings.ts';
import { buildWorld } from '../src/rigs.ts';
import { runSolve, solverNominalFor } from '../src/pipeline.ts';
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

/** Each projector's azimuth, in whole degrees, in rig order. */
function azimuths(rig: RigCalibration): number[] {
  return rig.projectors.map(
    (p) =>
      (Math.round((Math.atan2(p.pose.position.y, p.pose.position.x) * 180) / Math.PI) + 360) % 360,
  );
}

function settingsWith(overrides: Record<string, unknown>): typeof BOULDER_PRESET {
  return { ...BOULDER_PRESET, ...overrides } as typeof BOULDER_PRESET;
}

/** The preset with one projector switched off at the wall. */
function withOff(index: number, overrides: Record<string, unknown> = {}): typeof BOULDER_PRESET {
  const base = settingsWith(overrides);
  return { ...base, nudge: base.nudge.map((n, k) => ({ ...n, on: k !== index })) };
}

test('the nominal handed to the solver is placed by SLOT, not by position', () => {
  // The defect this replaces took a PREFIX of the four-slot nominal, so the
  // moment the lit set was not a prefix — one click on `Projectors = 2`, or
  // switching any projector but the last off at the wall — every projector past
  // the gap was handed a nominal a full quadrant around the ring. Measured
  // against the corrected placement that is 7.33 m of position error in the
  // starting point of a bundle adjustment whose gate is 2 mm.
  //
  // Each case below states the truth rig's azimuths first, because the whole
  // requirement is that the nominal agree with them.
  const cases: { label: string; settings: typeof BOULDER_PRESET; want: number[] }[] = [
    { label: 'four projectors, all on', settings: BOULDER_PRESET, want: [0, 90, 180, 270] },
    { label: 'four installed, P2 off at the wall', settings: withOff(1), want: [0, 180, 270] },
    { label: 'four installed, P1 off at the wall', settings: withOff(0), want: [90, 180, 270] },
    // conventions.ts SN.2: three projectors take slots 0, 1, 2 — 0/90/180 — not
    // an even 0/120/240 split.
    { label: 'three projectors', settings: settingsWith({ projectorCount: 3 }), want: [0, 90, 180] },
    {
      label: 'three installed, the middle one off',
      settings: withOff(1, { projectorCount: 3 }),
      want: [0, 180],
    },
    // A-06: two projectors take the OPPOSED pair. This one needs no off switch
    // at all — it is the plain "2" chip in the Projectors row.
    { label: 'two projectors', settings: settingsWith({ projectorCount: 2 }), want: [0, 180] },
  ];

  for (const c of cases) {
    const world = buildWorld(c.settings);
    const nominal = solverNominalFor(c.settings, world.slots);
    assert.deepEqual(azimuths(nominal), c.want, c.label);
    assert.equal(
      nominal.projectors.length,
      world.truthRig.projectors.length,
      `${c.label}: the nominal and the truth rig disagree about how many lenses are lit`,
    );
    // The real check: the nominal must be within a mount tolerance of the truth
    // rig it is initialising, not a quadrant away from it.
    for (let i = 0; i < nominal.projectors.length; i++) {
      const a = nominal.projectors[i].pose.position;
      const b = world.truthRig.projectors[i].pose.position;
      const mm = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000;
      assert.ok(mm < 500, `${c.label}: projector ${i} starts ${mm.toFixed(0)} mm from the truth`);
    }
  }
});

test('convergence is reported, and it is not a warrant for the answer', { timeout: 900_000 }, () => {
  // Two claims, and the second is the one that matters.
  //
  // (1) `converged` is real: a capture the optimiser cannot settle reports
  //     false, and the page refuses to install that rig.
  // (2) `converged` is NOT sufficient. A single camera converges to a residual
  //     BETTER than a three-camera solve and recovers a rig metres from the
  //     lenses, because from one viewpoint a near projector zoomed in is
  //     indistinguishable from a far one zoomed out. Nothing the solver
  //     produces catches it — `lastDeficiency` is computed after LM damping and
  //     reads 0 here, as it does on every case in the suite.
  //
  // This is the measurement `MIN_CAMERA_POSITIONS` rests on, and it is taken
  // through `runSolve` on purpose: the pipeline MEASURES and the page JUDGES, so
  // the one-position case is refused by `web/main.ts` and stays reachable here.
  // If the degeneracy ever goes away, this test fails and the refusal should go
  // with it — which is the property that keeps the refusal honest rather than
  // permanent.
  //
  // It also exists so that a future change which starts treating `converged` as
  // a certificate has to argue with a measurement.
  const three = runSolve(request({ cameraCount: 3 }));
  assert.ok(three.converged, 'the reference solve did not converge');
  assert.ok(three.posePositionMm < 500, `reference recovered ${three.posePositionMm.toFixed(0)} mm`);

  const one = runSolve(request({ cameraCount: 1 }));
  assert.ok(one.converged, 'the single-camera solve is expected to CONVERGE — that is the point');
  assert.ok(
    one.residualRmsPx < three.residualRmsPx * 1.5,
    `single-camera residual ${one.residualRmsPx.toFixed(3)} px is not comparable to the ` +
      `reference ${three.residualRmsPx.toFixed(3)} px, so the fixture no longer shows the trap`,
  );
  assert.ok(
    one.posePositionMm > 20 * three.posePositionMm,
    `a single camera recovered ${one.posePositionMm.toFixed(0)} mm against the reference ` +
      `${three.posePositionMm.toFixed(0)} mm — the degeneracy this warns about has gone, and the ` +
      'warning should go with it',
  );
});

test('a solve with every projector switched off says so in words', () => {
  // It used to be `TypeError: Cannot read properties of undefined (reading
  // 'intrinsics')` from `planPatternFor`, surfaced raw in the page's error
  // banner. Nothing upstream prevents it: the projector tabs toggle freely and
  // the metrics worker is perfectly happy with an unlit sphere, so the first
  // thing that notices is the solve.
  const dark = { ...BOULDER_PRESET, nudge: BOULDER_PRESET.nudge.map((n) => ({ ...n, on: false })) };
  assert.throws(
    () => runSolve(request({ settings: dark })),
    /Every projector is switched off at the wall/,
  );
});

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

test('the room toggle reaches the capture, and segmentation undoes it', { timeout: 900_000 }, () => {
  // The page's own version of experiments 4 and 5. The claim the two switches
  // make is that a room destroys the solve and that finding the ball in the
  // photograph gets it back; if either switch did not reach the capture this
  // would pass by doing nothing, so the first assertion is that the room
  // actually changed the correspondence set.
  const clean = runSolve(request({ settings: { ...BOULDER_PRESET, roomSpill: 0, segmentSphere: 0 } }));
  const spilt = runSolve(
    request({ id: 2, settings: { ...BOULDER_PRESET, roomSpill: 1, segmentSphere: 0 } }),
  );
  const fixed = runSolve(
    request({ id: 3, settings: { ...BOULDER_PRESET, roomSpill: 1, segmentSphere: 1 } }),
  );

  assert.notEqual(
    spilt.correspondences,
    clean.correspondences,
    'turning the room on did not change what the decoder accepted — the switch is inert',
  );
  assert.ok(
    spilt.posePositionMm > clean.posePositionMm,
    `the room must cost the pose something: clean ${clean.posePositionMm.toFixed(3)} mm, ` +
      `room ${spilt.posePositionMm.toFixed(3)} mm`,
  );
  assert.ok(
    fixed.posePositionMm < spilt.posePositionMm,
    `segmentation must recover most of it: room ${spilt.posePositionMm.toFixed(3)} mm, ` +
      `segmented ${fixed.posePositionMm.toFixed(3)} mm`,
  );
});

test('the page reports how many camera views segmentation refused', { timeout: 600_000 }, () => {
  // Refusing is correct and still costs the solve that camera entirely, so the
  // count has to reach the page. Experiment 5 measured one refusal in ninety
  // runs and only a counter noticed; a silent refusal and a working camera are
  // indistinguishable from outside.
  const off = runSolve(request({ settings: { ...BOULDER_PRESET, segmentSphere: 0 } }));
  assert.equal(off.silhouetteRefusals, 0, 'nothing can refuse when the detector is not running');
  assert.equal(off.silhouetteCameras, 0);

  const on = runSolve(request({ id: 2, settings: { ...BOULDER_PRESET, segmentSphere: 1 } }));
  assert.equal(on.silhouetteCameras, 2, 'every camera view is examined and counted');
  assert.ok(
    on.silhouetteRefusals >= 0 && on.silhouetteRefusals <= on.silhouetteCameras,
    `refusals ${on.silhouetteRefusals} outside 0..${on.silhouetteCameras}`,
  );
  // The page's own default framing must not be one the detector chokes on.
  assert.equal(on.silhouetteRefusals, 0, 'the shipped default framing should find every sphere');
});

test('segmentation ships on, and the presets agree', () => {
  // The one default this page deliberately differs from the bench on.
  assert.equal(BOULDER_PRESET.segmentSphere, 1);
  assert.equal(BOULDER_PRESET.roomSpill, 0, 'the room stays off: its constants are all ASSUME');
});
