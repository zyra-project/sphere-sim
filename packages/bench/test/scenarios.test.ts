// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The scenario corpus: reproducible from a seed, fresh between seeds, and
 * pinned where an archetype exists to pin something.
 *
 * docs/ARCHITECTURE.md's overfitting rule only works if both halves hold. If a
 * seed did not reproduce, the loop's before/after pair would be comparing two
 * different rigs; if two seeds produced the same corpus, a builder could tune
 * to it. These tests are the two halves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ARCHETYPE_NAMES, PRESETS, generateScenarios, makeScenario, scaledMisalignment } from '../src/scenarios.ts';
import { buildWorld } from '../src/run.ts';

test('the same seed regenerates the identical corpus', () => {
  const a = generateScenarios(4321, 12, PRESETS.default);
  const b = generateScenarios(4321, 12, PRESETS.default);
  assert.deepEqual(a, b);
});

test('a different seed regenerates a different corpus, but the same questions', () => {
  const a = generateScenarios(1, 6, PRESETS.default);
  const b = generateScenarios(2, 6, PRESETS.default);
  for (let i = 0; i < a.length; i++) {
    // Same archetype in the same slot: CI's six scenarios ask the same six
    // questions of every commit, which is what makes verdicts comparable.
    assert.equal(a[i].archetype, b[i].archetype);
    assert.notEqual(a[i].seed, b[i].seed);
  }
  // And the rigs really do differ, not just the seeds.
  assert.notEqual(a[1].distanceM, b[1].distanceM);
  assert.notEqual(a[1].cameras.distanceM, b[1].cameras.distanceM);
});

test('scenario 0 is always the canary, whatever the seed', () => {
  for (const seed of [1, 7, 99991, 20240001]) {
    const s = makeScenario(seed, 0, PRESETS.default);
    assert.equal(s.archetype, 'clean');
    assert.equal(s.misalignmentScale, 0);
    assert.equal(s.degradation.ambient, 0);
    assert.equal(s.degradation.sensor, null);
    assert.equal(s.degradation.handheld, null);
    // Scale zero must reach every magnitude, or the canary quietly stops being
    // one for whichever degree of freedom was missed.
    const m = scaledMisalignment(s);
    for (const [key, value] of Object.entries(m)) {
      assert.equal(value, 0, `${key} survived misalignmentScale = 0`);
    }
  }
});

test('a zero-misalignment scenario builds a rig identical to its as-built nominal', () => {
  const s = makeScenario(31337, 0, PRESETS.quick);
  const world = buildWorld(s);
  for (let i = 0; i < world.truthRig.projectors.length; i++) {
    const p = world.truthRig.projectors[i].pose.position;
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  }
  // The as-built rig differs from the DOCUMENTED one only through the
  // scenario's own d_proj and heights, which the canary draws near nominal.
  //
  // The tolerance is 1 mm rather than exact, and the reason is worth recording.
  // `packages/sim`'s `nominalRig` places a lens at `distanceM` in the HORIZONTAL
  // plane and then lifts it to `h_proj - h_center`; `packages/solver`'s places
  // it at `distanceM` in three dimensions and solves for the horizontal radius.
  // PARAMETERS.md §2 defines `d_proj` as "distance, sphere center to lens",
  // which is the solver's reading — but the two agree EXACTLY at §2's own
  // nominal, where §1 and §2 put the lens and the equator at the same 2.1844 m
  // and the lift is zero. With this corpus's 2 cm of height scatter the
  // disagreement is 40 micrometres, fifty times below the §7 pose gate, and it
  // affects only where the solver starts. Recorded in packages/bench/README.md
  // rather than silently patched: it is a divergence between two independent
  // implementations, which is exactly what this repository is built to surface.
  const d = Math.hypot(
    world.truthRig.projectors[0].pose.position.x,
    world.truthRig.projectors[0].pose.position.y,
    world.truthRig.projectors[0].pose.position.z,
  );
  assert.ok(Math.abs(d - s.distanceM) < 1e-3, `d_proj ${d} vs ${s.distanceM}`);
  assert.equal(world.truthRig.sphere.centerHeightM, s.centerHeightM);
});

test('every archetype builds a world without throwing', () => {
  for (let i = 0; i < ARCHETYPE_NAMES.length; i++) {
    const s = makeScenario(555, i, PRESETS.quick);
    const world = buildWorld(s);
    assert.equal(world.truthRig.projectors.length, s.projectorCount);
    assert.equal(world.solverNominal.projectors.length, s.projectorCount);
    // The nominal handed to the solver must name the SAME projectors as the
    // rig it is initialising, or the solver is fitting P2 to P3's images.
    for (let k = 0; k < s.projectorCount; k++) {
      assert.equal(world.solverNominal.projectors[k].id, world.truthRig.projectors[k].id);
    }
    assert.equal(world.cameras.length, s.cameras.count);
  }
});

test('the two-projector archetype uses opposed mounts (AMENDMENTS A-06)', () => {
  const index = ARCHETYPE_NAMES.indexOf('two-projectors');
  const s = makeScenario(9, index, PRESETS.quick);
  assert.deepEqual(s.slots, [0, 2]);
  const world = buildWorld(s);
  const az = world.truthRig.projectors.map(
    (p) => (Math.atan2(p.pose.position.y, p.pose.position.x) * 180) / Math.PI,
  );
  // Opposed: 180 degrees apart, not 90. A-06 measures the difference as 16.7%
  // of the sphere unlit versus 33.8%. The tolerance is §2's stated mount
  // tolerance of one to two degrees.
  const separation = Math.abs(((az[1] - az[0] + 540) % 360) - 180);
  assert.ok(separation > 175, `azimuths ${az[0]} and ${az[1]} are not opposed`);
});

test('the long-throw archetype puts truth at the floor plan end and the nominal at the manual end', () => {
  const index = ARCHETYPE_NAMES.indexOf('long-throw');
  const s = makeScenario(17, index, PRESETS.quick);
  const world = buildWorld(s);
  const truthD = Math.hypot(
    world.truthRig.projectors[0].pose.position.x,
    world.truthRig.projectors[0].pose.position.y,
    world.truthRig.projectors[0].pose.position.z,
  );
  const nominalD = Math.hypot(
    world.solverNominal.projectors[0].pose.position.x,
    world.solverNominal.projectors[0].pose.position.y,
    world.solverNominal.projectors[0].pose.position.z,
  );
  // PARAMETERS.md §2's unresolved conflict, made into a test case: the site is
  // built to the floor plan and configured from the alignment manual.
  assert.ok(truthD > 6.0 && truthD < 6.25, `truth d_proj ${truthD}`);
  assert.ok(Math.abs(nominalD - 5.18) < 0.01, `nominal d_proj ${nominalD}`);
});

test('fov-held is the SAME rig and the same capture as two-cameras, with one knob moved', () => {
  // A paired comparison or it is not a measurement. Two different rigs
  // photographed by two different camera sets under two different noise draws
  // would differ for a dozen reasons, and the difference would get attributed to
  // the one knob that was named.
  const paired = ARCHETYPE_NAMES.indexOf('fov-held');
  const partner = ARCHETYPE_NAMES.indexOf('two-cameras');
  for (const seed of [1234, 77, 20240001]) {
    const a = makeScenario(seed, partner, PRESETS.default);
    const b = makeScenario(seed, paired, PRESETS.default);
    assert.equal(a.seed, b.seed, 'the pair must share a seed');
    assert.equal(a.distanceM, b.distanceM);
    assert.equal(a.cameras.count, b.cameras.count);
    assert.equal(a.cameras.distanceM, b.cameras.distanceM);
    assert.equal(a.degradation.ambient, b.degradation.ambient);
    assert.equal(a.freeFov, true);
    assert.equal(b.freeFov, false);
  }
  // And the pairing must survive cycling past the end of the archetype list,
  // or `--scenarios 24` would pair round one's rig against round two's.
  const cycle = ARCHETYPE_NAMES.length;
  assert.equal(
    makeScenario(1234, paired + cycle, PRESETS.default).seed,
    makeScenario(1234, partner + cycle, PRESETS.default).seed,
  );
  assert.notEqual(
    makeScenario(1234, paired + cycle, PRESETS.default).seed,
    makeScenario(1234, partner, PRESETS.default).seed,
  );
});

test('presets differ only in cost, not in what is being asked', () => {
  const quick = generateScenarios(77, 3, PRESETS.quick);
  const thorough = generateScenarios(77, 3, PRESETS.thorough);
  for (let i = 0; i < quick.length; i++) {
    assert.equal(quick[i].archetype, thorough[i].archetype);
    assert.equal(quick[i].seed, thorough[i].seed);
    assert.equal(quick[i].distanceM, thorough[i].distanceM);
    assert.equal(quick[i].misalignmentScale, thorough[i].misalignmentScale);
    // The camera resolution is the cost knob, and it is the ONLY thing about
    // the scenario a preset is allowed to change.
    assert.notEqual(quick[i].cameras.resX, thorough[i].cameras.resX);
  }
});

test('mesh is the SAME rig and the same capture as nominal, with the sphere replaced', () => {
  // The paired-comparison rule again: the difference between `mesh` and
  // `nominal` has to be the body and nothing else, or it measures two rigs.
  const paired = ARCHETYPE_NAMES.indexOf('mesh');
  const partner = ARCHETYPE_NAMES.indexOf('nominal');
  assert.equal(paired, ARCHETYPE_NAMES.length - 1, 'new archetypes go on the end');
  for (const seed of [1234, 77, 20240001]) {
    const a = makeScenario(seed, partner, PRESETS.default);
    const b = makeScenario(seed, paired, PRESETS.default);
    assert.equal(a.seed, b.seed, 'the pair must share a seed');
    assert.equal(a.distanceM, b.distanceM);
    assert.equal(a.projectorHeightM, b.projectorHeightM);
    assert.equal(a.cameras.count, b.cameras.count);
    assert.equal(a.cameras.distanceM, b.cameras.distanceM);
    assert.equal(a.degradation.ambient, b.degradation.ambient);
    assert.deepEqual(a.degradation.sensor, b.degradation.sensor);
    assert.equal(a.degradation.handheld, b.degradation.handheld);
    assert.equal(a.freeFov, b.freeFov);
    assert.equal(a.surface, null);
    assert.deepEqual(b.surface, { kind: 'ellipsoid', scaleY: 0.8, scaleZ: 0.6, nLat: 64, nLon: 128 });
  }
  const cycle = ARCHETYPE_NAMES.length;
  assert.equal(
    makeScenario(1234, paired + cycle, PRESETS.default).seed,
    makeScenario(1234, partner + cycle, PRESETS.default).seed,
  );
});

test('only the mesh archetype puts a body other than the sphere in the world, and it puts it on both sides', () => {
  // `surface` is what the cameras photograph and `meshIndex` what the bundle
  // fits. One without the other is the failure #14's cache existed to prevent:
  // a photograph of one shape fitted to another. Both or neither, per scenario.
  for (let i = 0; i < ARCHETYPE_NAMES.length; i++) {
    const s = makeScenario(31, i, PRESETS.quick);
    const world = buildWorld(s);
    if (ARCHETYPE_NAMES[i] === 'mesh') {
      assert.notEqual(s.surface, null);
      assert.ok(world.surface !== null, 'the cameras would photograph a sphere');
      assert.ok(world.meshIndex !== null, 'the bundle would fit a sphere');
      // Built at the rig's own radius: the ellipsoid's long axis is the sphere.
      const r = world.truthRig.sphere.radiusM;
      let maxX = 0;
      let maxZ = 0;
      for (let k = 0; k < world.meshIndex.mesh.vertexCount; k++) {
        maxX = Math.max(maxX, Math.abs(world.meshIndex.mesh.positions[3 * k]));
        maxZ = Math.max(maxZ, Math.abs(world.meshIndex.mesh.positions[3 * k + 2]));
      }
      assert.ok(Math.abs(maxX - r) < 1e-9, `long axis ${maxX} vs radius ${r}`);
      assert.ok(Math.abs(maxZ - 0.6 * r) < 1e-9, `short axis ${maxZ} vs 0.6 x ${r}`);
    } else {
      assert.equal(s.surface, null);
      assert.equal(world.surface, null);
      assert.equal(world.meshIndex, null);
    }
  }
});
