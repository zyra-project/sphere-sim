// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The slider manifest.
 *
 * PARAMETERS.md's whole structure is a claim about where the risk sits: the
 * geometric half is `DOC`/`CFG`/`SOLVE` and the photometric half is
 * `ASSUME`/`MEAS`, and §10 says of `ASSUME` "All of it. This is where the bar
 * breaks." A harness that lets a human drag those numbers without telling them
 * which they are dragging would quietly undo that, because a value you can move
 * with your finger feels like a value somebody checked.
 *
 * So these tests are about honesty rather than about arithmetic:
 *
 *  1. Every section of PARAMETERS.md the task names has controls.
 *  2. Every control the calibration table also carries agrees with it, or says
 *     in its own note that the travel was widened and why.
 *  3. Every `ASSUME` control is discoverable as `ASSUME`, and the count is
 *     pinned so one cannot quietly be reclassified.
 *  4. Defaults are the documented nominals, and `normalizeState` cannot be made
 *     to emit something outside the declared range.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_CONTROLS,
  ASSUME_CONTROL_IDS,
  CONTROL_GROUPS,
  PRESETS,
  RAMP_SHAPE_BY_INDEX,
  RESOLUTIONS,
  defaultState,
  normalizeState,
  rampShapeAt,
  presetState,
} from '../src/params.ts';
import { PARAMETER_TABLE } from '../../calibration/src/parameters.ts';
import { buildRig, buildScene, buildImage } from '../src/state.ts';
import { assertFramebufferTopology } from '../../sim/src/scene.ts';

test('every PARAMETERS.md section the harness must cover has controls', () => {
  const sections = new Set(ALL_CONTROLS.map((c) => c.section));
  // Geometry: §1, §2, §3.1, §4. Photometry: §3.2, §4.5, §5. Plus §6's viewer.
  for (const required of ['§1', '§2', '§3.1', '§3.2', '§4.4', '§4.5', '§5', '§6']) {
    assert.ok(sections.has(required), `no control covers PARAMETERS.md ${required}`);
  }
});

test('controls are grouped by section, and every group says what it changes', () => {
  assert.ok(CONTROL_GROUPS.length >= 7);
  for (const g of CONTROL_GROUPS) {
    assert.ok(g.section.startsWith('§'), `group ${g.title} has no section`);
    assert.ok(g.blurb.length > 40, `group ${g.section} has no blurb worth reading`);
    assert.ok(g.controls.length > 0);
  }
});

test('every control carries a provenance class, a range source and a note', () => {
  for (const c of ALL_CONTROLS) {
    assert.ok(['DOC', 'CFG', 'SOLVE', 'ASSUME', 'MEAS'].includes(c.klass), `${c.id} has class ${c.klass}`);
    assert.ok(['stated', 'inferred', 'harness'].includes(c.rangeSource), `${c.id}: ${c.rangeSource}`);
    assert.ok(c.note.length > 30, `${c.id} has no note explaining itself`);
    assert.ok(c.min <= c.nominal && c.nominal <= c.max, `${c.id}: nominal ${c.nominal} is outside [${c.min}, ${c.max}]`);
    assert.ok(c.step > 0, `${c.id} has a non-positive step`);
    if (c.kind === 'select') assert.ok(c.options && c.options.length > 1, `${c.id} is a select with no options`);
  }
});

test('a control that names a calibration-table parameter agrees with it', () => {
  for (const c of ALL_CONTROLS) {
    const spec = PARAMETER_TABLE[c.id];
    if (!spec) continue;
    assert.equal(c.nominal, spec.nominal, `${c.id}: nominal disagrees with PARAMETER_TABLE`);
    assert.equal(c.klass, spec.klass, `${c.id}: class disagrees with PARAMETER_TABLE`);
    assert.equal(c.section, spec.section, `${c.id}: section disagrees with PARAMETER_TABLE`);
    if (c.min === spec.min && c.max === spec.max) {
      assert.equal(
        c.rangeSource,
        spec.rangeSource,
        `${c.id}: the range matches the table but the rangeSource does not`,
      );
    } else {
      // A widened range must say it is a harness framing choice, not pass itself
      // off as something PARAMETERS.md states.
      assert.equal(
        c.rangeSource,
        'harness',
        `${c.id}: the slider travel is wider than the table's range but claims rangeSource '${c.rangeSource}'`,
      );
    }
  }
});

test('every ASSUME control is discoverable as ASSUME, and the count is pinned', () => {
  const assume = ALL_CONTROLS.filter((c) => c.klass === 'ASSUME');
  assert.deepEqual(
    ASSUME_CONTROL_IDS.slice().sort(),
    assume.map((c) => c.id).sort(),
    'ASSUME_CONTROL_IDS and the manifest disagree — the UI marks the wrong sliders',
  );
  // PARAMETERS.md §10 counts 31 ASSUME entries across the whole document; the
  // harness exposes a subset. Pinning the number means a reclassification has to
  // be deliberate rather than a diff nobody read.
  assert.equal(assume.length, 24, `the harness now exposes ${assume.length} ASSUME controls, not 24`);
  // The four §10 calls out as highest-risk must all be reachable.
  for (const id of ['gamma_B', 'L_black_R', 'E_amb', 'E_amb_chroma', 'rho_R']) {
    assert.ok(assume.some((c) => c.id === id), `PARAMETERS.md §10's risk list names ${id} and it has no slider`);
  }
});

test('the defaults are the documented nominals', () => {
  const state = defaultState();
  for (const c of ALL_CONTROLS) assert.equal(state[c.id], c.nominal, `${c.id} does not default to its nominal`);
  const spec = PARAMETER_TABLE.gamma_blend;
  assert.equal(state.gamma_blend, spec.nominal, 'the one DOC-class photometric constant is not at its nominal');
  assert.equal(state.gamma_blend, 0.8, 'PARAMETERS.md §4.5 gives gamma_blend as 0.8, from the SOS config');
});

test('normalizeState clamps, fills and refuses NaN', () => {
  const wild = normalizeState({ d_proj: 1e6, E_amb: -5, gamma_R: Number.NaN, nonsense: 3 });
  assert.equal(wild.d_proj, PARAMETER_TABLE.d_proj.max);
  assert.equal(wild.E_amb, PARAMETER_TABLE.E_amb.min);
  assert.equal(wild.gamma_R, PARAMETER_TABLE.gamma_R.nominal, 'a NaN was not replaced by the nominal');
  assert.equal(wild.nonsense, undefined, 'an unknown key survived normalization');
  for (const c of ALL_CONTROLS) assert.ok(Number.isFinite(wild[c.id]), `${c.id} came back non-finite`);
});

test('every preset produces a valid state and a rig with the §3.4 topology', () => {
  for (const preset of PRESETS) {
    assert.ok(preset.why.length > 60, `preset ${preset.id} does not explain itself`);
    const state = presetState(preset);
    for (const c of ALL_CONTROLS) {
      assert.ok(state[c.id] >= c.min && state[c.id] <= c.max, `preset ${preset.id} put ${c.id} out of range`);
    }
    const rig = buildRig(state);
    // PARAMETERS.md §3.4: the framebuffer is exactly twice the per-projector
    // raster in each dimension. `nominalRig` asserts it; this proves the harness
    // has not defeated the assertion on the way past.
    assertFramebufferTopology(rig);
    assert.equal(rig.framebuffer.width, rig.projectors[0].intrinsics.resX * 2);
    assert.equal(rig.framebuffer.height, rig.projectors[0].intrinsics.resY * 2);
  }
});

test('the §3.2 preset really is §3.2’s worked example', () => {
  const preset = PRESETS.find((p) => p.id === 'yellow-band');
  assert.ok(preset);
  const state = presetState(preset);
  const rig = buildRig(state);
  const scene = buildScene(state, buildImage('mid-gray', 32, 16));
  // The projector's blue channel runs 2.4 while the compositor still encodes at
  // 2.2. That gap IS the artifact; if the two moved together there would be none.
  for (const p of rig.projectors) assert.equal(p.transfer.gamma.b, 2.4);
  assert.equal(scene.encodeGamma.b, 2.2);
  assert.notEqual(rig.projectors[0].transfer.gamma.b, scene.encodeGamma.b);
});

test('projector count follows conventions.ts §N.2, and dark quadrants stay dark', () => {
  // §2 says "quadrants go dark" and never says which; conventions.ts §N.2 pins
  // {0,2} for N=2 (opposed — A-06) and {0,1,2} for N=3 (A-19).
  const two = buildRig({ ...defaultState(), N_proj: 2 });
  assert.equal(two.projectors.length, 2);
  assert.deepEqual(two.projectors.map((p) => p.id), ['P1', 'P3']);
  // The framebuffer does NOT shrink: the X screen is still the full 2x2.
  assert.equal(two.framebuffer.width, two.projectors[0].intrinsics.resX * 2);
  const three = buildRig({ ...defaultState(), N_proj: 3 });
  assert.deepEqual(three.projectors.map((p) => p.id), ['P1', 'P2', 'P3']);
});

test('the resolution selector spans §3.1 and doubles for §3.4', () => {
  assert.equal(RESOLUTIONS.length, 3);
  assert.ok(RESOLUTIONS.some((r) => r.resX === 1920 && r.resY === 1080), '§3.1 names 1920x1080');
  assert.ok(RESOLUTIONS.some((r) => r.resX === 3840 && r.resY === 2160), '§3.1 names 3840x2160');
  for (let i = 0; i < RESOLUTIONS.length; i++) {
    const rig = buildRig({ ...defaultState(), res_index: i });
    assert.equal(rig.framebuffer.width, RESOLUTIONS[i].resX * 2);
    assert.equal(rig.framebuffer.height, RESOLUTIONS[i].resY * 2);
  }
});

test('the ramp shape selector covers all four of conventions.ts §B', () => {
  assert.deepEqual([...RAMP_SHAPE_BY_INDEX], ['linear', 'cosine', 'smoothstep', 'gaussian']);
  for (let i = 0; i < 4; i++) {
    const rig = buildRig({ ...defaultState(), ramp_shape: i });
    assert.equal(rig.blend.rampShape, RAMP_SHAPE_BY_INDEX[i]);
  }
});

test('azimuth jitter and roll alternate sign, so a seam actually moves', () => {
  // A common-mode rotation of the whole rig is a gauge freedom (A-09) and is very
  // nearly invisible. A single-sign slider would look like it did nothing.
  const rig = buildRig({ ...defaultState(), phi_jitter: 2, roll: 1.5 });
  assert.equal(rig.projectors[0].pose.rollDeg, 1.5);
  assert.equal(rig.projectors[1].pose.rollDeg, -1.5);
  const az = rig.projectors.map((p) => (Math.atan2(p.pose.position.y, p.pose.position.x) * 180) / Math.PI);
  assert.ok(Math.abs(az[0] - 2) < 1e-9, `P1 azimuth ${az[0]}`);
  assert.ok(Math.abs(az[1] - 88) < 1e-9, `P2 azimuth ${az[1]}`);
});

test('a ramp-shape index that is not a number is refused, not looked up', () => {
  // `normalizeState` drops non-finite values, so nothing in this repository can
  // reach `buildRig` with a NaN control. But `buildRig` is exported, and the
  // clamp it used to carry -- `Math.max(0, Math.min(3, Math.round(v)))` -- passes
  // NaN through both bounds untouched: the table lookup then returned `undefined`
  // and the rig carried a shape that is not a shape, which downstream became NaN
  // coverage, NaN registration and NaN photometry with nothing raised.
  assert.equal(rampShapeAt(0), 'linear');
  assert.equal(rampShapeAt(3), 'gaussian');
  // Out of range still clamps -- a slider that overshoots is not an error.
  assert.equal(rampShapeAt(-7), 'linear');
  assert.equal(rampShapeAt(99), 'gaussian');
  assert.equal(rampShapeAt(1.4), 'cosine');
  // Not a number is.
  assert.throws(() => rampShapeAt(Number.NaN), /finite control index/);
  assert.throws(() => rampShapeAt(Number.POSITIVE_INFINITY), /finite control index/);
});
