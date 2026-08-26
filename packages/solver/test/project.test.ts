// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * conventions.ts §R, §I and §D, checked clause by clause, plus the analytic
 * Jacobian against central differences.
 *
 * The clause tests matter more than they look. A projection round-trip passes
 * whether or not the right vector points the way §R says, because the round trip
 * inverts whatever the code does. Only a test that reads a sentence out of the
 * conventions and asserts it independently can catch a sign that is
 * self-consistently wrong — and a sign that is self-consistently wrong is
 * precisely the A/B disagreement the bench exists to surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJ_PARAM_COUNT,
  aimEuler,
  distortNormalized,
  eulerFromMatrix,
  frameAxes,
  pixelIntrinsics,
  projectPoint,
  projectPointJacobian,
  projectorPixelToRay,
  rasterToFramebuffer,
  rotationMatrix,
  rotationWithDerivatives,
  undistortNormalized,
  type ProjectorModel,
} from '../src/project.ts';
import { mat3Column, mat3Det, mat3Multiply, mat3Transpose, vDot, vNorm } from '../src/linalg.ts';

function model(overrides: Partial<ProjectorModel> = {}): ProjectorModel {
  return {
    id: 'P1',
    position: { x: 5.18, y: 0.31, z: 0.12 },
    yawDeg: 177.4,
    pitchDeg: -1.9,
    rollDeg: 0.7,
    resX: 1920,
    resY: 1080,
    pixelAspect: 1.0,
    fovHDeg: 33.4,
    shiftH: 0.05,
    shiftV: -0.04,
    k1: -0.031,
    k2: 0.011,
    p1: 0.0007,
    p2: -0.0004,
    ...overrides,
  };
}

test('§R: the rotation is a proper rotation for arbitrary angles', () => {
  for (const [y, p, r] of [
    [0, 0, 0],
    [37, -12, 5],
    [-160, 44, -170],
    [180, 0, 0],
  ]) {
    const m = rotationMatrix(y, p, r);
    const should = mat3Multiply(m, mat3Transpose(m));
    for (let i = 0; i < 9; i++) {
      assert.ok(Math.abs(should[i] - (i % 4 === 0 ? 1 : 0)) < 1e-12, 'R R^T = I');
    }
    assert.ok(Math.abs(mat3Det(m) - 1) < 1e-12, 'det = +1');
  }
});

test('§R: the closed form and the product of generators agree', () => {
  const a = rotationMatrix(23, -14, 61);
  const b = rotationWithDerivatives(23, -14, 61).r;
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-13);
});

test('§R: positive pitch raises the optical axis toward +Z', () => {
  const flat = frameAxes(rotationMatrix(0, 0, 0));
  assert.ok(Math.abs(flat.axis.z) < 1e-15);
  const up = frameAxes(rotationMatrix(0, 10, 0));
  assert.ok(up.axis.z > 0.17 && up.axis.z < 0.18, `sin(10 deg), got ${up.axis.z}`);
});

test('§R: the canonical frame is axis +X, right -Y, up +Z', () => {
  const a = frameAxes(rotationMatrix(0, 0, 0));
  // `+ 0` normalises the negative zeros that fall out of the trigonometry;
  // `Object.is(-0, 0)` is false and deep-equal agrees with it.
  const round = (v: number): number => Math.round(v) + 0;
  assert.deepEqual([a.axis.x, a.axis.y, a.axis.z].map(round), [1, 0, 0]);
  assert.deepEqual([a.right.x, a.right.y, a.right.z].map(round), [0, -1, 0]);
  assert.deepEqual([a.up.x, a.up.y, a.up.z].map(round), [0, 0, 1]);
});

test('§R: a projector at azimuth phi aimed at the sphere centre has yaw = phi + 180', () => {
  for (const phi of [0, 90, 180, 270, 37]) {
    const rad = (phi * Math.PI) / 180;
    const pos = { x: 5.18 * Math.cos(rad), y: 5.18 * Math.sin(rad), z: 0 };
    const e = aimEuler(pos, { x: 0, y: 0, z: 0 }, 0);
    const expected = ((phi + 180 + 540) % 360) - 180;
    assert.ok(Math.abs(((e.yawDeg - expected + 540) % 360) - 180) < 1e-9);
    assert.ok(Math.abs(e.pitchDeg) < 1e-12, 'a lens at equator height aims level');
  }
});

test('§R: positive roll swings the top of the projected image toward the right', () => {
  // A raster point above the principal point maps to `axis + y*up`; under roll
  // its outgoing direction should acquire a positive component along the
  // UNROLLED right vector. §R calls that clockwise as seen from the lens.
  const base = frameAxes(rotationMatrix(0, 0, 0));
  const rolled = frameAxes(rotationMatrix(0, 0, 12));
  const dir = {
    x: rolled.axis.x + rolled.up.x,
    y: rolled.axis.y + rolled.up.y,
    z: rolled.axis.z + rolled.up.z,
  };
  assert.ok(vDot(dir, base.right) > 0.2, 'top of the image swings right');
});

test('§R: euler extraction inverts the rotation', () => {
  for (const [y, p, r] of [
    [12, 34, -56],
    [-179, 3, 178],
    [0, 0, 0],
    [95, -60, 20],
  ]) {
    const m = rotationMatrix(y, p, r);
    const e = eulerFromMatrix(m);
    const back = rotationMatrix(e.yawDeg, e.pitchDeg, e.rollDeg);
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(m[i] - back[i]) < 1e-12);
  }
});

test('§I: focal length and principal point follow the stated formulas', () => {
  const m = model({ shiftH: 0.25, shiftV: -0.5, fovHDeg: 40, pixelAspect: 1.2 });
  const k = pixelIntrinsics(m);
  assert.ok(Math.abs(k.fx - m.resX / 2 / Math.tan((40 * Math.PI) / 360)) < 1e-9);
  assert.ok(Math.abs(k.fy - k.fx * 1.2) < 1e-9);
  // Lens shift is a fraction of the HALF dimension, and vertical is negated
  // because v increases downward.
  assert.ok(Math.abs(k.cx - (1920 / 2 + 0.25 * 960)) < 1e-9);
  assert.ok(Math.abs(k.cy - (1080 / 2 - -0.5 * 540)) < 1e-9);
});

test('§I: the principal point is where the optical axis lands', () => {
  const m = model({ k1: 0, k2: 0, p1: 0, p2: 0 });
  const axes = frameAxes(rotationMatrix(m.yawDeg, m.pitchDeg, m.rollDeg));
  const target = {
    x: m.position.x + axes.axis.x * 3,
    y: m.position.y + axes.axis.y * 3,
    z: m.position.z + axes.axis.z * 3,
  };
  const k = pixelIntrinsics(m);
  const shot = projectPoint(m, target);
  assert.ok(Math.abs(shot.u - k.cx) < 1e-9);
  assert.ok(Math.abs(shot.v - k.cy) < 1e-9);
});

test('§D: distortion inverts to machine precision over the whole raster', () => {
  const m = model();
  let worst = 0;
  for (let i = -10; i <= 10; i++) {
    for (let j = -10; j <= 10; j++) {
      const x = i * 0.045;
      const y = j * 0.045;
      const d = distortNormalized(x, y, m.k1, m.k2, m.p1, m.p2);
      const back = undistortNormalized(d.xd, d.yd, m.k1, m.k2, m.p1, m.p2);
      worst = Math.max(worst, Math.hypot(back.x - x, back.y - y));
    }
  }
  assert.ok(worst < 1e-12, `worst inversion error ${worst}`);
});

test('§D: the analytic 2x2 distortion derivative matches central differences', () => {
  const m = model();
  const h = 1e-6;
  for (const [x, y] of [
    [0.1, -0.2],
    [-0.31, 0.27],
    [0, 0],
  ]) {
    const d = distortNormalized(x, y, m.k1, m.k2, m.p1, m.p2);
    const dxp = distortNormalized(x + h, y, m.k1, m.k2, m.p1, m.p2);
    const dxm = distortNormalized(x - h, y, m.k1, m.k2, m.p1, m.p2);
    const dyp = distortNormalized(x, y + h, m.k1, m.k2, m.p1, m.p2);
    const dym = distortNormalized(x, y - h, m.k1, m.k2, m.p1, m.p2);
    assert.ok(Math.abs(d.dxdx - (dxp.xd - dxm.xd) / (2 * h)) < 1e-7);
    assert.ok(Math.abs(d.dxdy - (dyp.xd - dym.xd) / (2 * h)) < 1e-7);
    assert.ok(Math.abs(d.dydx - (dxp.yd - dxm.yd) / (2 * h)) < 1e-7);
    assert.ok(Math.abs(d.dydy - (dyp.yd - dym.yd) / (2 * h)) < 1e-7);
  }
});

test('projection round-trips through the pixel-to-ray inverse', () => {
  const m = model();
  const axes = frameAxes(rotationMatrix(m.yawDeg, m.pitchDeg, m.rollDeg));
  for (const [du, dv] of [
    [0.2, 0.3],
    [-0.4, 0.1],
    [0, 0],
  ]) {
    const world = {
      x: m.position.x + (axes.axis.x + du * axes.right.x + dv * axes.up.x) * 4.5,
      y: m.position.y + (axes.axis.y + du * axes.right.y + dv * axes.up.y) * 4.5,
      z: m.position.z + (axes.axis.z + du * axes.right.z + dv * axes.up.z) * 4.5,
    };
    const shot = projectPoint(m, world);
    assert.ok(shot.inFront);
    const ray = projectorPixelToRay(m, shot.u, shot.v);
    const to = {
      x: world.x - m.position.x,
      y: world.y - m.position.y,
      z: world.z - m.position.z,
    };
    const len = vNorm(to);
    assert.ok(Math.abs(vDot(ray, { x: to.x / len, y: to.y / len, z: to.z / len }) - 1) < 1e-12);
  }
});

test('the analytic projector Jacobian matches central differences on every column', () => {
  const base = model();
  const world = { x: 0.31, y: -0.62, z: 0.44 };
  const analytic = projectPointJacobian(base, world);

  // Step sizes are per-parameter because the parameters are in different units:
  // metres, degrees, and dimensionless distortion coefficients. A single h would
  // be far too coarse for one and far too fine for another.
  const steps: number[] = [
    1e-6, 1e-6, 1e-6, // position, metres
    1e-4, 1e-4, 1e-4, // angles, degrees
    1e-4, // fovHDeg
    1e-6, 1e-6, // shifts
    1e-6, 1e-6, 1e-6, 1e-6, // distortion
  ];
  const set = (m: ProjectorModel, i: number, value: number): ProjectorModel => {
    const c: ProjectorModel = { ...m, position: { ...m.position } };
    const fields = [
      (v: number) => (c.position.x = v),
      (v: number) => (c.position.y = v),
      (v: number) => (c.position.z = v),
      (v: number) => (c.yawDeg = v),
      (v: number) => (c.pitchDeg = v),
      (v: number) => (c.rollDeg = v),
      (v: number) => (c.fovHDeg = v),
      (v: number) => (c.shiftH = v),
      (v: number) => (c.shiftV = v),
      (v: number) => (c.k1 = v),
      (v: number) => (c.k2 = v),
      (v: number) => (c.p1 = v),
      (v: number) => (c.p2 = v),
    ];
    fields[i](value);
    return c;
  };
  const read = (m: ProjectorModel, i: number): number =>
    [
      m.position.x,
      m.position.y,
      m.position.z,
      m.yawDeg,
      m.pitchDeg,
      m.rollDeg,
      m.fovHDeg,
      m.shiftH,
      m.shiftV,
      m.k1,
      m.k2,
      m.p1,
      m.p2,
    ][i];

  for (let i = 0; i < PROJ_PARAM_COUNT; i++) {
    const h = steps[i];
    const plus = projectPoint(set(base, i, read(base, i) + h), world);
    const minus = projectPoint(set(base, i, read(base, i) - h), world);
    const fdU = (plus.u - minus.u) / (2 * h);
    const fdV = (plus.v - minus.v) / (2 * h);
    const anU = analytic.dParam[i];
    const anV = analytic.dParam[PROJ_PARAM_COUNT + i];
    const scale = Math.max(1, Math.abs(fdU), Math.abs(anU));
    assert.ok(
      Math.abs(fdU - anU) / scale < 1e-5,
      `du/dp[${i}] analytic ${anU} vs finite difference ${fdU}`,
    );
    const scaleV = Math.max(1, Math.abs(fdV), Math.abs(anV));
    assert.ok(
      Math.abs(fdV - anV) / scaleV < 1e-5,
      `dv/dp[${i}] analytic ${anV} vs finite difference ${fdV}`,
    );
  }
});

test('the analytic derivative with respect to the world point matches central differences', () => {
  const m = model();
  const world = { x: 0.31, y: -0.62, z: 0.44 };
  const analytic = projectPointJacobian(m, world);
  const h = 1e-7;
  const axesNames: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const plus = { ...world };
    const minus = { ...world };
    plus[axesNames[i]] += h;
    minus[axesNames[i]] -= h;
    const a = projectPoint(m, plus);
    const b = projectPoint(m, minus);
    const fdU = (a.u - b.u) / (2 * h);
    const fdV = (a.v - b.v) / (2 * h);
    assert.ok(Math.abs(fdU - analytic.dWorld[i]) / Math.max(1, Math.abs(fdU)) < 1e-5);
    assert.ok(Math.abs(fdV - analytic.dWorld[3 + i]) / Math.max(1, Math.abs(fdV)) < 1e-5);
  }
});

test('§V: the framebuffer mapping flips vertically, because the viewport origin is bottom-left', () => {
  const fb = { width: 3840, height: 2160 };
  const res = { resX: 1920, resY: 1080 };
  // Bottom-left quadrant, top-left raster pixel: §V's origin is bottom-left, so
  // the top of the raster sits at the TOP of that quadrant, i.e. y = 0.5 * H.
  const topLeft = rasterToFramebuffer({ x: 0, y: 0, w: 0.5, h: 0.5 }, fb, res, 0, 0);
  assert.ok(Math.abs(topLeft.x - 0) < 1e-9);
  assert.ok(Math.abs(topLeft.y - 1080) < 1e-9);
  const bottomRight = rasterToFramebuffer({ x: 0, y: 0, w: 0.5, h: 0.5 }, fb, res, 1920, 1080);
  assert.ok(Math.abs(bottomRight.x - 1920) < 1e-9);
  assert.ok(Math.abs(bottomRight.y - 0) < 1e-9);
});

test('a point behind the lens is reported as not in front rather than projected', () => {
  const m = model();
  const axes = frameAxes(rotationMatrix(m.yawDeg, m.pitchDeg, m.rollDeg));
  const behind = {
    x: m.position.x - axes.axis.x,
    y: m.position.y - axes.axis.y,
    z: m.position.z - axes.axis.z,
  };
  assert.equal(projectPoint(m, behind).inFront, false);
  assert.equal(projectPointJacobian(m, behind).inFront, false);
});

test('the rotation derivatives match central differences of the rotation itself', () => {
  const d = rotationWithDerivatives(31, -17, 44);
  const h = 1e-5;
  const check = (
    analytic: Float64Array,
    plus: Float64Array,
    minus: Float64Array,
    label: string,
  ): void => {
    for (let i = 0; i < 9; i++) {
      const fd = (plus[i] - minus[i]) / (2 * h);
      assert.ok(Math.abs(fd - analytic[i]) < 1e-8, `${label}[${i}] ${fd} vs ${analytic[i]}`);
    }
  };
  check(d.dYaw, rotationMatrix(31 + h, -17, 44), rotationMatrix(31 - h, -17, 44), 'dYaw');
  check(d.dPitch, rotationMatrix(31, -17 + h, 44), rotationMatrix(31, -17 - h, 44), 'dPitch');
  check(d.dRoll, rotationMatrix(31, -17, 44 + h), rotationMatrix(31, -17, 44 - h), 'dRoll');
  // The optical axis is column 0 of R; assert the extraction convention here so
  // a change to `frameAxes` cannot pass unnoticed.
  const c0 = mat3Column(d.r, 0);
  const a = frameAxes(d.r).axis;
  assert.deepEqual([c0.x, c0.y, c0.z], [a.x, a.y, a.z]);
});
