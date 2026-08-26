// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Camera model and ray-sphere intersection.
 *
 * The intersection is checked against closed-form geometry rather than against
 * itself, because the failure mode that matters — picking the far root, or
 * losing precision on a grazing ray — round-trips perfectly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAM_FOCAL,
  CAM_PARAM_COUNT,
  type CameraModel,
  cameraPixelToNormalized,
  cameraPixelToRay,
  distanceFromAngularRadius,
  fitRayCone,
  intersectSphere,
  intersectSphereJacobian,
  latLonOf,
  rayFromNormalized,
  surfacePoint,
  zeroCameraRate,
} from '../src/sphere.ts';
import { vNorm, vNormalize } from '../src/linalg.ts';
import { phoneIntrinsics } from './synthetic.ts';

const R = 0.8636;

function camera(overrides: Partial<CameraModel> = {}): CameraModel {
  return {
    position: { x: 2.1, y: -1.4, z: -0.58 },
    yawDeg: 146.3,
    pitchDeg: 12.1,
    rollDeg: -3.4,
    intrinsics: phoneIntrinsics(640, 480),
    focalScale: 1,
    velocity: zeroCameraRate(),
    ...overrides,
  };
}

test('a ray straight at the centre hits at exactly distance - R', () => {
  const o = { x: 3, y: 0, z: 0 };
  const d = { x: -1, y: 0, z: 0 };
  const hit = intersectSphere(o, d, R);
  assert.ok(hit.hit);
  assert.ok(Math.abs(hit.t - (3 - R)) < 1e-14, `t = ${hit.t}`);
  assert.ok(Math.abs(hit.cosIncidence - 1) < 1e-14, 'head-on incidence is 1');
  assert.ok(Math.abs(vNorm(hit.point) - R) < 1e-14);
});

test('the NEAR root is returned, not the far one', () => {
  const o = { x: 5, y: 0, z: 0 };
  const hit = intersectSphere(o, { x: -1, y: 0, z: 0 }, R);
  assert.ok(hit.t < 5, 'near root');
  assert.ok(Math.abs(hit.point.x - R) < 1e-13, 'hit is on the near face');
});

test('a ray that misses reports a miss', () => {
  const hit = intersectSphere({ x: 3, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, R);
  assert.equal(hit.hit, false);
});

test('a tangent ray is stable and reports near-zero incidence', () => {
  // Offset the ray by exactly R so it grazes the limb.
  const o = { x: 4, y: R, z: 0 };
  const hit = intersectSphere(o, { x: -1, y: 0, z: 0 }, R);
  assert.ok(hit.hit);
  assert.ok(Math.abs(vNorm(hit.point) - R) < 1e-9);
  assert.ok(Math.abs(hit.cosIncidence) < 1e-6, `grazing, got ${hit.cosIncidence}`);
});

test('intersection stays accurate for a very distant camera', () => {
  // The stable quadratic form earns its keep here: the two roots differ by five
  // orders of magnitude and the textbook subtraction loses most of its digits.
  const o = { x: 1e5, y: 0, z: 0 };
  const hit = intersectSphere(o, { x: -1, y: 0, z: 0 }, R);
  assert.ok(hit.hit);
  // 1e-10 is the conditioning limit, and it comes from the surface point itself
  // rather than from the discriminant: `point.x = 1e5 - 99999.14` cancels five
  // digits no matter how the root was found.
  assert.ok(Math.abs(vNorm(hit.point) - R) / R < 1e-10, 'hit lies on the sphere');
});

test('camera pixel -> ray -> surface is consistent with the projection back', () => {
  const cam = camera();
  const k = cam.intrinsics;
  // The principal point must map to the optical axis.
  const ray = cameraPixelToRay(cam, k.cx, k.cy);
  const axis = rayFromNormalized(cam, 0, 0).dir;
  assert.ok(Math.abs(ray.dir.x - axis.x) < 1e-12);
  assert.ok(Math.abs(ray.dir.y - axis.y) < 1e-12);
  assert.ok(Math.abs(ray.dir.z - axis.z) < 1e-12);

  // A pixel below the principal point must look downward relative to the axis:
  // v increases DOWN while normalized y is UP.
  const below = cameraPixelToNormalized(cam, k.cx, k.cy + 50);
  assert.ok(below.y < 0, 'pixel below the principal point has negative normalized y');
});

test('the camera distortion is real and inverted, not ignored', () => {
  const cam = camera();
  const k = cam.intrinsics;
  const corner = cameraPixelToNormalized(cam, 10, 10);
  const ideal = {
    x: (10 - k.cx) / k.fx,
    y: (k.cy - 10) / k.fy,
  };
  const shift = Math.hypot(corner.x - ideal.x, corner.y - ideal.y);
  assert.ok(shift > 0.01, `phone-class distortion should move a corner ray, got ${shift}`);
});

test('the analytic surface-point Jacobian matches central differences', () => {
  const cam = camera();
  const nx = 0.21;
  const ny = -0.13;
  const analytic = intersectSphereJacobian(cam, nx, ny, R);
  assert.ok(analytic.hit.hit);

  const steps = [1e-6, 1e-6, 1e-6, 1e-4, 1e-4, 1e-4];
  const perturb = (i: number, delta: number): CameraModel => {
    const c: CameraModel = { ...cam, position: { ...cam.position } };
    if (i === 0) c.position.x += delta;
    else if (i === 1) c.position.y += delta;
    else if (i === 2) c.position.z += delta;
    else if (i === 3) c.yawDeg += delta;
    else if (i === 4) c.pitchDeg += delta;
    else c.rollDeg += delta;
    return c;
  };

  for (let i = 0; i < 6; i++) {
    const h = steps[i];
    const a = intersectSphereJacobian(perturb(i, h), nx, ny, R).hit.point;
    const b = intersectSphereJacobian(perturb(i, -h), nx, ny, R).hit.point;
    const fd = [(a.x - b.x) / (2 * h), (a.y - b.y) / (2 * h), (a.z - b.z) / (2 * h)];
    for (let r = 0; r < 3; r++) {
      const an = analytic.dPoint[r * CAM_PARAM_COUNT + i];
      assert.ok(
        Math.abs(fd[r] - an) / Math.max(1, Math.abs(fd[r])) < 1e-5,
        `dPoint[${r}][${i}] analytic ${an} vs finite difference ${fd[r]}`,
      );
    }
  }
});

test('§S: lat/lon round-trips and puts (0, 0) on +X', () => {
  const p = surfacePoint(0, 0, R);
  assert.ok(Math.abs(p.x - R) < 1e-14 && Math.abs(p.y) < 1e-14 && Math.abs(p.z) < 1e-14);
  // Longitude increases toward +Y.
  const east = surfacePoint(0, 90, R);
  assert.ok(east.y > 0.86, `+90 lon lies on +Y, got ${east.y}`);
  for (const [lat, lon] of [
    [12.5, -47],
    [-80, 179],
    [0, 0],
  ]) {
    const q = latLonOf(surfacePoint(lat, lon, R));
    assert.ok(Math.abs(q.latDeg - lat) < 1e-12);
    assert.ok(Math.abs(((q.lonDeg - lon + 540) % 360) - 180) < 1e-12);
  }
});

test('the cone fit recovers the distance when the rays really do span the silhouette', () => {
  const d = 3.4;
  const half = Math.asin(R / d);
  const dirs = [];
  // A full ring at the silhouette angle, plus the axis.
  for (let i = 0; i < 64; i++) {
    const t = (2 * Math.PI * i) / 64;
    dirs.push(
      vNormalize({
        x: Math.cos(half),
        y: Math.sin(half) * Math.cos(t),
        z: Math.sin(half) * Math.sin(t),
      }),
    );
  }
  dirs.push({ x: 1, y: 0, z: 0 });
  const cone = fitRayCone(dirs);
  assert.ok(Math.abs(cone.halfAngleRad - half) < 1e-9);
  assert.ok(Math.abs(distanceFromAngularRadius(R, cone.halfAngleRad) - d) < 1e-9);
});

test('the focal column is the real derivative when asked for, and absent when not', () => {
  // It used to be neither. `SphereHitJacobian.dPoint` promised the column was
  // 'filled by finite differences in bundle.ts' and no such code existed, so
  // freeing the camera focal added a parameter whose Jacobian column was
  // identically zero: the normal equations lost rank, the step in that direction
  // stayed zero, and `focalScale` was reported as exactly 1.0 however wrong it
  // was -- while `buildProblem` paid to recompute every normalised coordinate on
  // every evaluation for it.
  const cam: CameraModel = {
    position: { x: 4, y: 0, z: 0 },
    yawDeg: 180,
    pitchDeg: 0,
    rollDeg: 2,
    focalScale: 1,
    velocity: { px: 0, py: 0, pz: 0, yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    intrinsics: {
      resX: 640,
      resY: 480,
      fx: 900,
      fy: 900,
      cx: 320,
      cy: 240,
      k1: -0.08,
      k2: 0.02,
      p1: 0.001,
      p2: -0.0005,
    },
  };
  const u = 340;
  const v = 232;
  const radius = 0.61;

  // The truth: difference the WHOLE pipeline, pixel through intersection.
  const pointAt = (scale: number) => {
    const c = { ...cam, focalScale: scale };
    const n = cameraPixelToNormalized(c, u, v);
    const j = intersectSphereJacobian(c, n.x, n.y, radius);
    assert.ok(j.hit.hit, 'the fixture ray must hit the sphere');
    return j.hit.point;
  };
  const h = 1e-5;
  const plus = pointAt(1 + h);
  const minus = pointAt(1 - h);
  const truth = {
    x: (plus.x - minus.x) / (2 * h),
    y: (plus.y - minus.y) / (2 * h),
    z: (plus.z - minus.z) / (2 * h),
  };

  const n0 = cameraPixelToNormalized(cam, u, v);
  const d = 1e-6;
  const np = cameraPixelToNormalized({ ...cam, focalScale: 1 + d }, u, v);
  const nm = cameraPixelToNormalized({ ...cam, focalScale: 1 - d }, u, v);
  const dNormalized = { dx: (np.x - nm.x) / (2 * d), dy: (np.y - nm.y) / (2 * d) };

  const withFocal = intersectSphereJacobian(
    cam,
    n0.x,
    n0.y,
    radius,
    undefined,
    undefined,
    0,
    dNormalized,
  );
  const col = (j: Float64Array) => ({
    x: j[0 * CAM_PARAM_COUNT + CAM_FOCAL],
    y: j[1 * CAM_PARAM_COUNT + CAM_FOCAL],
    z: j[2 * CAM_PARAM_COUNT + CAM_FOCAL],
  });
  const got = col(withFocal.dPoint);
  const scale = Math.hypot(truth.x, truth.y, truth.z);
  assert.ok(scale > 1e-3, 'the fixture should have a focal derivative worth checking');
  assert.ok(
    Math.hypot(got.x - truth.x, got.y - truth.y, got.z - truth.z) / scale < 1e-6,
    `focal column ${JSON.stringify(got)} against finite difference ${JSON.stringify(truth)}`,
  );

  // And a solve with the focal held must be bit-for-bit what it always was.
  const held = col(intersectSphereJacobian(cam, n0.x, n0.y, radius).dPoint);
  assert.deepEqual(held, { x: 0, y: 0, z: 0 });
});
