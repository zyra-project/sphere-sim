// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The one scenario whose body is not the sphere, run end to end.
 *
 * `capture.test.ts` proves the capture photographs a supplied surface and
 * `packages/solver`'s tests prove the bundle fits one. Neither proves that
 * `run.ts` hands the SAME body to both — and #14 recorded what the join looks
 * like when it is wrong: a mesh photographed and a sphere fitted lands hundreds
 * of millimetres away with every assertion in the suite still green. This runs
 * the `mesh` archetype through `runScenario` at the smallest preset and asserts
 * the three things the scenario exists for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { ARCHETYPE_NAMES, PRESETS, makeScenario } from '../src/scenarios.ts';
import { runScenario } from '../src/run.ts';
import { buildGates } from '../src/results.ts';

test('the mesh archetype solves against the body it photographed and is judged on recovery alone', { timeout: 600_000 }, () => {
  const index = ARCHETYPE_NAMES.indexOf('mesh');
  const scenario = makeScenario(1234, index, PRESETS.quick);
  assert.equal(scenario.id, 's12-mesh');
  const result = runScenario(scenario, {
    preset: PRESETS.quick,
    outDir: path.join(os.tmpdir(), 'sphere-sim-mesh-scenario'),
    repoRoot: process.cwd(),
    writeArtifacts: false,
    baseline: true,
  });

  // 1. It solves, and against the right body. At this preset the same seed
  //    recovers 31.9 mm with the mesh on both sides. Measured under mutation,
  //    with `surface` dropped from the solve so a sphere is fitted to the
  //    ellipsoid's photographs: the solve does not converge at all, and the
  //    test fails on the line below this comment. The position bound is twice
  //    the measurement, not §7's 2 mm — the pose gate itself is waived on every
  //    archetype under A-18, and this test is about the join, not the lens.
  assert.equal(result.error, null);
  assert.ok(result.solver !== null && result.solver.diagnostics.converged, 'the solve did not converge');
  assert.ok(result.recovery !== null, 'no recovery was scored');
  assert.ok(
    result.recovery.aligned.maxPositionMm < 60,
    `recovered ${result.recovery.aligned.maxPositionMm.toFixed(1)} mm against the mesh`,
  );
  // A tri-axial body leaves the gauge nothing to pin: every rotation is
  // observable, so nothing is aligned away before scoring.
  assert.deepEqual(result.solver.extra.gaugeFreeAxes, [false, false, false]);

  // 2. No §7 geometry is computed for it — neither the recovered rig's nor the
  //    documented baseline's — because both would be sampled on a sphere that
  //    is not in the room.
  assert.equal(result.metrics, null);
  assert.equal(result.baseline, null);

  // 3. And the gates read that as NOT MEASURABLE, never as a missing number.
  //    Alone in a run, the mesh scenario brings no §7 gate into the block at all
  //    — a gate with nothing scored would be judged NOT-MEASURED and fail the
  //    build — while its recovery gates are scored like any other's. Beside a
  //    sphere scenario the §7 gates appear, with the mesh listed as not
  //    measurable on each; `gates.test.ts` covers that mixed case with fixtures.
  const gates = buildGates([result]);
  const byId = new Map(gates.gates.map((g) => [g.id, g]));
  for (const id of ['pose_position', 'pose_rotation', 'h_center_recovery']) {
    const g = byId.get(id);
    assert.ok(g, `${id} missing`);
    assert.equal(g.scenariosScored, 1, `${id} did not score the mesh scenario`);
    assert.deepEqual(g.scenariosUnmeasured, []);
    assert.deepEqual(g.scenariosNotMeasurable, []);
  }
  for (const id of ['grid_displacement', 'unlit_in_mask', 'off_sphere_flux']) {
    assert.equal(byId.get(id), undefined, `${id} reached the judgement with nothing to judge`);
  }
});
