// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The uniform block, cross-checked against `packages/sim`'s own preparation.
 *
 * `uniforms.ts` derives the rotation matrix, the focal lengths and the principal
 * point independently of `prepareRig`, and this compares the OUTPUTS. That is a
 * real check; calling one from the other would make it a tautology.
 *
 * It matters more than it looks. These are the values the shader never
 * recomputes, so a bug in them is a bug in the GPU path and in the reference
 * path simultaneously — the parity number is blind to it by construction, and
 * this test is the only thing standing there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUniforms, cameraBasis, rotationMatrix } from '../src/uniforms.ts';
import { buildWorld } from '../src/state.ts';
import { defaultState } from '../src/params.ts';
import type { HarnessState } from '../src/params.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { projectorRotationMatrix } from '../../sim/src/geometry.ts';

const CASES: HarnessState[] = [
  {},
  { phi_jitter: 1.7, roll: 2.4, h_proj: 2.9, d_proj: 6.2 },
  { shiftH: 0.11, shiftV: -0.09, k1: 0.04, k2: -0.01, res_index: 2 },
  { N_proj: 2, R: 1.1, h_center: 2.3, theta_rot: 137 },
];

function world(overrides: HarnessState) {
  return buildWorld({ ...defaultState(), ...overrides }, 'graticule', {
    textureWidth: 64,
    textureHeight: 32,
    viewWidth: 32,
    viewHeight: 24,
  });
}

test('the uniform block agrees with prepareRig to 1e-12', () => {
  for (const overrides of CASES) {
    const w = world(overrides);
    const prepared = prepareRig(w.rig);
    const u = buildUniforms(w.rig, w.scene, w.viewer, { mode: 'room' });
    assert.equal(u.projectors.length, prepared.projectors.length);

    for (let i = 0; i < u.projectors.length; i++) {
      const a = u.projectors[i];
      const b = prepared.projectors[i];
      const near = (x: number, y: number, what: string): void => {
        assert.ok(
          Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(y)),
          `projector ${i} ${what}: harness ${x}, prepareRig ${y}`,
        );
      };
      near(a.intrinsics[0], b.fx, 'fx');
      near(a.intrinsics[1], b.fy, 'fy');
      near(a.intrinsics[2], b.cx, 'cx');
      near(a.intrinsics[3], b.cy, 'cy');
      near(a.limb[0], b.distanceM, 'distanceM');
      near(a.limb[1], b.limbCos, 'limbCos');
      near(a.lens.x, b.lens.x, 'lens.x');
      near(a.lens.z, b.lens.z, 'lens.z');
      for (let k = 0; k < 9; k++) near(a.rot[k], b.rotation[k], `rotation[${k}]`);
    }
  }
});

test('the rotation matrix implements conventions.ts §R, including the negated pitch', () => {
  // §R states positive pitch raises the optical axis toward +Z. A right-handed
  // rotation about +Y lowers +X toward -Z, so the sign has to flip for the
  // documented meaning to hold. Writing Ry(pitch) typechecks and mirrors every
  // projector about the equator.
  const m = rotationMatrix(0, 10, 0);
  const axisZ = m[6]; // (R * (1,0,0)).z
  assert.ok(axisZ > 0, `positive pitch must raise the optical axis toward +Z; got z = ${axisZ}`);
  assert.ok(Math.abs(axisZ - Math.sin((10 * Math.PI) / 180)) < 1e-12);

  // And it matches sim's independent implementation on a general pose.
  const mine = rotationMatrix(37, -11, 4.5);
  const theirs = projectorRotationMatrix({
    position: { x: 0, y: 0, z: 0 },
    yawDeg: 37,
    pitchDeg: -11,
    rollDeg: 4.5,
  });
  for (let k = 0; k < 9; k++) {
    assert.ok(Math.abs(mine[k] - theirs[k]) < 1e-12, `rotation[${k}]: ${mine[k]} vs ${theirs[k]}`);
  }
});

test('the camera basis is orthonormal and survives a degenerate up hint', () => {
  const w = world({});
  const basis = cameraBasis(w.viewer);
  const dot = (a: { x: number; y: number; z: number }, b: typeof a): number =>
    a.x * b.x + a.y * b.y + a.z * b.z;
  assert.ok(Math.abs(dot(basis.forward, basis.forward) - 1) < 1e-12);
  assert.ok(Math.abs(dot(basis.right, basis.right) - 1) < 1e-12);
  assert.ok(Math.abs(dot(basis.up, basis.up) - 1) < 1e-12);
  assert.ok(Math.abs(dot(basis.forward, basis.right)) < 1e-12);
  assert.ok(Math.abs(dot(basis.forward, basis.up)) < 1e-12);

  // Looking straight down the up hint would give a zero cross product. It must
  // produce a picture, not a NaN.
  const degenerate = cameraBasis({
    position: { x: 0, y: 0, z: 3 },
    target: { x: 0, y: 0, z: 0 },
    upHint: { x: 0, y: 0, z: 1 },
    fovHDeg: 50,
    width: 4,
    height: 3,
  });
  assert.ok(Number.isFinite(degenerate.right.x + degenerate.right.y + degenerate.right.z));
  assert.ok(Math.abs(dot(degenerate.right, degenerate.right) - 1) < 1e-12);
});

test('the mask interpretation and blend configuration reach the uniform block', () => {
  const lat = world({ mask_interp: 0 });
  const colat = world({ mask_interp: 1 });
  assert.equal(buildUniforms(lat.rig, lat.scene, lat.viewer, { mode: 'room' }).maskInterp, 0);
  assert.equal(buildUniforms(colat.rig, colat.scene, colat.viewer, { mode: 'room' }).maskInterp, 1);

  const g = world({ ramp_shape: 3, gamma_blend: 1.2, w_width: 7 });
  const u = buildUniforms(g.rig, g.scene, g.viewer, { mode: 'room' });
  assert.equal(u.rampShape, 3, 'gaussian is index 3 in conventions.ts §B order');
  assert.equal(u.rampGamma, 1.2);
  assert.equal(u.widthDeg, 7);
});

test('the ambient uniform carries §5’s colour temperature, not a grey', () => {
  // §5's E_amb_chroma tints the whole sphere and shifts every deltaE. A harness
  // that passed a grey ambient would make the control inert while still moving.
  const warm = world({ E_amb: 0.08, E_amb_chroma: 2700 });
  const u = buildUniforms(warm.rig, warm.scene, warm.viewer, { mode: 'room' });
  assert.ok(u.ambient.r > u.ambient.b, `2700 K ambient is not warmer in red: ${JSON.stringify(u.ambient)}`);
  const cool = world({ E_amb: 0.08, E_amb_chroma: 6500 });
  const u2 = buildUniforms(cool.rig, cool.scene, cool.viewer, { mode: 'room' });
  assert.ok(u2.ambient.b > u.ambient.b, 'raising the colour temperature did not raise blue');
});
