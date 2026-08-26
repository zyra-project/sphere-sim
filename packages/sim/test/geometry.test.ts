// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Frames, rotation order, and the numerics of the sphere intersection.
 *
 * These are the conventions from packages/calibration/src/conventions.ts §W, §S
 * and §R. The solver implements the same prose independently, so an error here
 * does not show up as a crash — it shows up as a solver that cannot converge, or
 * worse, one that converges to a mirrored rig. Pin the signs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acosDeg,
  aimAtSphereCenter,
  angleBetweenDeg,
  applySphereRotation,
  latLonToWorld,
  projectorBasis,
  projectorRotationMatrix,
  raySphereIntersect,
  worldLonToTextureLon,
  worldToLatLon,
} from '../src/geometry.ts';
import { DEG2RAD, dot, matVec, normalize, sub } from '../src/vec.ts';

const R = 0.8636; // PARAMETERS.md §1
const D = 5.18; // PARAMETERS.md §2, the alignment manual's figure

test('§S: (0 lat, 0 lon) lies on +X and longitude increases toward +Y', () => {
  const origin = latLonToWorld(0, 0, R);
  assert.ok(Math.abs(origin.x - R) < 1e-15, `expected +X, got ${JSON.stringify(origin)}`);
  assert.ok(Math.abs(origin.y) < 1e-15);
  assert.ok(Math.abs(origin.z) < 1e-15);

  const east = latLonToWorld(0, 90, R);
  assert.ok(Math.abs(east.y - R) < 1e-15, 'longitude +90 must lie on +Y');

  const north = latLonToWorld(90, 0, R);
  assert.ok(Math.abs(north.z - R) < 1e-15, '+90 latitude must lie on +Z');
});

test('§S: lat/lon round-trips through the world frame', () => {
  let worst = 0;
  for (let lat = -89; lat <= 89; lat += 7) {
    for (let lon = -179; lon <= 179; lon += 11) {
      const back = worldToLatLon(latLonToWorld(lat, lon, R));
      worst = Math.max(worst, Math.abs(back.latDeg - lat), Math.abs(back.lonDeg - lon));
    }
  }
  assert.ok(worst < 1e-12, `worst lat/lon round-trip error ${worst} deg`);
});

test('§S: sphere rotation carries texture longitude to world longitude, and back', () => {
  // A texel authored at texture longitude 0 on a sphere rotated +30 deg is seen
  // at world longitude +30. Getting this backwards rotates every rendered map by
  // twice the offset, and on a symmetric test pattern that is invisible.
  assert.equal(applySphereRotation(0, 30), 30);
  assert.equal(applySphereRotation(170, 30), -160, 'must wrap into (-180, 180]');
  assert.equal(worldLonToTextureLon(30, 30), 0);

  for (const offset of [-180, -30, 0, 45, 179.5]) {
    for (const lon of [-179, -90, 0, 90, 180]) {
      const round = worldLonToTextureLon(applySphereRotation(lon, offset), offset);
      assert.ok(Math.abs(round - lon) < 1e-12, `round trip failed at lon=${lon} offset=${offset}`);
    }
  }
});

test('§R: a projector at azimuth phi aimed at the sphere centre has yaw = phi + 180', () => {
  for (const phi of [0, 90, 180, 270, 37.5]) {
    const a = phi * DEG2RAD;
    const position = { x: D * Math.cos(a), y: D * Math.sin(a), z: 0 };
    const aim = aimAtSphereCenter(position);

    // conventions §S wraps into (-180, +180] — note the half-open end, so a
    // projector at azimuth 0 reports yaw +180, not -180.
    let expected = (phi + 180) % 360;
    if (expected <= -180) expected += 360;
    if (expected > 180) expected -= 360;
    assert.ok(
      Math.abs(aim.yawDeg - expected) < 1e-12,
      `azimuth ${phi}: expected yaw ${expected}, got ${aim.yawDeg}`,
    );
    assert.ok(
      Math.abs(aim.pitchDeg) < 1e-12,
      `a lens at the equator height must have pitch 0, got ${aim.pitchDeg}`,
    );

    // ...and the resulting optical axis really does point at the origin.
    const basis = projectorBasis({ position, ...aim, rollDeg: 0 });
    const toCentre = normalize({ x: -position.x, y: -position.y, z: -position.z });
    assert.ok(angleBetweenDeg(basis.axis, toCentre) < 1e-10);
  }
});

test('§R: a lens above the equator must pitch DOWN to see the centre', () => {
  // PARAMETERS.md §2 puts projectors at h_proj = h_center nominally, but a
  // ceiling mount does not. §R fixes positive pitch as raising the axis toward
  // +Z, so a high lens aiming at the origin has NEGATIVE pitch. The Ry(-pitch)
  // in the composition is what makes that true; Ry(+pitch) also typechecks and
  // mirrors every projector about the equator.
  const position = { x: D, y: 0, z: 1.0 };
  const aim = aimAtSphereCenter(position);
  assert.ok(aim.pitchDeg < 0, `lens above the equator must pitch down, got ${aim.pitchDeg}`);

  const basis = projectorBasis({ position, ...aim, rollDeg: 0 });
  assert.ok(basis.axis.z < 0, 'optical axis must point downward');
  assert.ok(angleBetweenDeg(basis.axis, normalize({ x: -D, y: 0, z: -1 })) < 1e-10);
});

test('§R: the canonical frame is optical axis +X, right -Y, up +Z', () => {
  const identityPose = { position: { x: 0, y: 0, z: 0 }, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const basis = projectorBasis(identityPose);
  assert.deepEqual(round(basis.axis), { x: 1, y: 0, z: 0 });
  assert.deepEqual(round(basis.right), { x: 0, y: -1, z: 0 });
  assert.deepEqual(round(basis.up), { x: 0, y: 0, z: 1 });

  // Right-handed and orthonormal: right x up = axis.
  assert.ok(Math.abs(dot(basis.axis, basis.right)) < 1e-15);
  assert.ok(Math.abs(dot(basis.axis, basis.up)) < 1e-15);
  assert.ok(Math.abs(dot(basis.right, basis.up)) < 1e-15);
});

test('§R: positive roll rotates the image clockwise seen from the lens', () => {
  // Looking out along +X with up +Z and right -Y, a clockwise rotation of the
  // image tips the top of the frame toward the viewer's right, i.e. toward -Y.
  const basis = projectorBasis({
    position: { x: 0, y: 0, z: 0 },
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 10,
  });
  assert.ok(basis.up.y < 0, `up must tip toward -Y (image right), got ${JSON.stringify(basis.up)}`);
  assert.ok(basis.up.z > 0.98, 'a 10 degree roll must not tip up out of the vertical plane');
  assert.ok(Math.abs(basis.axis.x - 1) < 1e-15, 'roll must not move the optical axis');
});

test('§R: the sequence is Rz(yaw) * Ry(-pitch) * Rx(roll), not any other order', () => {
  // With all three non-zero the orders differ materially. Pin the composed
  // matrix against an independently written triple product.
  const pose = { position: { x: 0, y: 0, z: 0 }, yawDeg: 25, pitchDeg: -12, rollDeg: 7 };
  const m = projectorRotationMatrix(pose);

  const cy = Math.cos(25 * DEG2RAD);
  const sy = Math.sin(25 * DEG2RAD);
  const cp = Math.cos(12 * DEG2RAD); // cos(-(-12)) = cos(12)
  const sp = Math.sin(12 * DEG2RAD);
  const cr = Math.cos(7 * DEG2RAD);
  const sr = Math.sin(7 * DEG2RAD);

  // Rz(yaw) * Ry(+12 deg) * Rx(roll), written out longhand.
  const expected = [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    -sp,
    cp * sr,
    cp * cr,
  ];
  for (let i = 0; i < 9; i++) {
    assert.ok(Math.abs(m[i] - expected[i]) < 1e-14, `element ${i}: ${m[i]} vs ${expected[i]}`);
  }
});

test('ray-sphere: hits land exactly on the sphere, even at grazing incidence', () => {
  // The projector sits ~6 R from the centre, so a naive `b*b - 4ac` subtracts
  // two numbers near 26.8 to get one near 0.7 and throws away half the mantissa.
  // geometry.ts forms the discriminant from the ray's perpendicular offset
  // instead. Check the invariant that matters: the reported hit is ON the
  // sphere, all the way in to the limb.
  const origin = { x: D, y: 0, z: 0 };
  const limbLat = acosDeg(R / D);

  let worstRadial = 0;
  let worstT = 0;
  for (const eps of [1, 1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6]) {
    const target = latLonToWorld(limbLat - eps, 0, R);
    const dir = normalize(sub(target, origin));
    const hit = raySphereIntersect(origin, dir, R);
    assert.ok(hit, `no hit at ${eps} deg inside the limb`);
    const radius = Math.hypot(hit.point.x, hit.point.y, hit.point.z);
    worstRadial = Math.max(worstRadial, Math.abs(radius - R));
    const expectedT = Math.hypot(
      target.x - origin.x,
      target.y - origin.y,
      target.z - origin.z,
    );
    worstT = Math.max(worstT, Math.abs(hit.t - expectedT));
  }
  assert.ok(worstRadial < 1e-12, `hit points drifted off the sphere by ${worstRadial} m`);
  assert.ok(worstT < 1e-8, `worst grazing t error ${worstT} m`);
});

test('ray-sphere: the stable form beats the naive quadratic at grazing incidence', () => {
  // The claim in geometry.ts is that the geometric discriminant is better
  // conditioned, not merely different. Measure it.
  const origin = { x: D, y: 0, z: 0 };
  const limbLat = acosDeg(R / D);

  const naive = (dir: { x: number; y: number; z: number }): number | null => {
    const b = 2 * (origin.x * dir.x + origin.y * dir.y + origin.z * dir.z);
    const c = origin.x * origin.x + origin.y * origin.y + origin.z * origin.z - R * R;
    const disc = b * b - 4 * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    const t0 = (-b - s) / 2;
    return t0 > 0 ? t0 : (-b + s) / 2;
  };

  let worstStable = 0;
  let worstNaive = 0;
  for (let i = 0; i < 60; i++) {
    const eps = Math.pow(10, -i / 10); // 1 deg down to 1e-6 deg inside the limb
    const target = latLonToWorld(limbLat - eps, 0, R);
    const dir = normalize(sub(target, origin));
    const expectedT = Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z);
    const hit = raySphereIntersect(origin, dir, R);
    const nt = naive(dir);
    if (hit) worstStable = Math.max(worstStable, Math.abs(hit.t - expectedT));
    if (nt !== null) worstNaive = Math.max(worstNaive, Math.abs(nt - expectedT));
  }
  assert.ok(
    worstStable <= worstNaive,
    `stable form was worse: ${worstStable} vs naive ${worstNaive}`,
  );
});

test('ray-sphere: returns the NEAR hit, and null for a genuine miss', () => {
  const origin = { x: D, y: 0, z: 0 };
  const hit = raySphereIntersect(origin, { x: -1, y: 0, z: 0 }, R);
  assert.ok(hit);
  assert.ok(Math.abs(hit.t - (D - R)) < 1e-12, 'must be the near root, not the far one');
  assert.ok(Math.abs(hit.point.x - R) < 1e-12);
  assert.ok(Math.abs(hit.normal.x - 1) < 1e-12, 'normal points outward');

  // A ray tilted past the silhouette's angular radius asin(R/d) misses entirely.
  const missAngle = Math.asin(R / D) * 1.05;
  const miss = raySphereIntersect(
    origin,
    { x: -Math.cos(missAngle), y: 0, z: Math.sin(missAngle) },
    R,
  );
  assert.equal(miss, null);

  // A ray pointing away from the sphere misses even though the line through it
  // would intersect.
  assert.equal(raySphereIntersect(origin, { x: 1, y: 0, z: 0 }, R), null);
});

test('matVec agrees with the rotation applied to a known vector', () => {
  const m = projectorRotationMatrix({
    position: { x: 0, y: 0, z: 0 },
    yawDeg: 90,
    pitchDeg: 0,
    rollDeg: 0,
  });
  const v = matVec(m, { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(v.x) < 1e-15 && Math.abs(v.y - 1) < 1e-15 && Math.abs(v.z) < 1e-15);
});

function round(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const r = (n: number): number => (Math.abs(n) < 1e-15 ? 0 : Number(n.toFixed(12)));
  return { x: r(v.x), y: r(v.y), z: r(v.z) };
}
