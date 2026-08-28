// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The seam is exact, or it is not a seam.
 *
 * `surface.ts` is Phase 0 of `docs/ARBITRARY-SHAPES.md`: it moves the decision
 * "what shape is this" out of forty-odd call sites and into one interface,
 * WITHOUT moving a number. The bench's byte-identity check is the real gate on
 * that, and it runs in CI — but a bench diff names a scenario, not a function.
 * These tests name the function.
 *
 * So each one compares a `Surface` method against the free function in
 * `geometry.ts` that the call sites used to call directly, and demands
 * `Object.is` equality rather than a tolerance. A tolerance here would pass a
 * seam that rounded differently, and a seam that rounds differently is exactly
 * the thing the bench would then catch three minutes later with a worse error
 * message.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { SphereSurface, sphereSurface } from '../src/surface.ts';
import { latLonToWorld, raySphereIntersect, worldToLatLon } from '../src/geometry.ts';
import { equalAreaLattice } from '../src/metrics/sampling.ts';
import { nominalRig } from '../src/scene.ts';
import { prepareRig } from '../src/optics.ts';
import { scale } from '../src/vec.ts';
import type { Vec3 } from '../src/vec.ts';

const R = 0.8636;

/** A spread of rays, including ones that graze, miss, and start inside. */
function rays(): { origin: Vec3; dir: Vec3 }[] {
  const out: { origin: Vec3; dir: Vec3 }[] = [];
  for (const az of [0, 37, 90, 180, 271, 359]) {
    for (const el of [-80, -33, 0, 12, 61, 89]) {
      const a = (az * Math.PI) / 180;
      const e = (el * Math.PI) / 180;
      const origin = {
        x: 5.18 * Math.cos(a) * Math.cos(e),
        y: 5.18 * Math.sin(a) * Math.cos(e),
        z: 5.18 * Math.sin(e),
      };
      const len = Math.hypot(origin.x, origin.y, origin.z);
      // Straight at the centre, and a fan around it that includes the limb —
      // `acos(R/d)` is where the discriminant goes to zero and where a seam
      // that re-derived the intersection would first disagree.
      for (const nudge of [0, 0.05, 0.164, 0.1665, 0.5, 1.4]) {
        const base = { x: -origin.x / len, y: -origin.y / len, z: -origin.z / len };
        const dir = {
          x: base.x + nudge * -base.y,
          y: base.y + nudge * base.x,
          z: base.z,
        };
        const dl = Math.hypot(dir.x, dir.y, dir.z);
        out.push({ origin, dir: { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl } });
      }
    }
  }
  return out;
}

test('intersect is raySphereIntersect, bit for bit, hits and misses alike', () => {
  const s = sphereSurface(R);
  let hits = 0;
  let misses = 0;
  for (const { origin, dir } of rays()) {
    const want = raySphereIntersect(origin, dir, R);
    const got = s.intersect(origin, dir);
    if (want === null) {
      assert.equal(got, null);
      misses++;
      continue;
    }
    assert.ok(got !== null);
    assert.ok(Object.is(got.t, want.t), `t: ${got.t} vs ${want.t}`);
    assert.ok(Object.is(got.point.x, want.point.x));
    assert.ok(Object.is(got.point.y, want.point.y));
    assert.ok(Object.is(got.point.z, want.point.z));
    assert.ok(Object.is(got.normal.x, want.normal.x));
    assert.ok(Object.is(got.normal.y, want.normal.y));
    assert.ok(Object.is(got.normal.z, want.normal.z));
    hits++;
  }
  // The fan has to actually exercise both branches, or the test above is a
  // tautology over an empty set.
  assert.ok(hits > 50, `expected plenty of hits, got ${hits}`);
  assert.ok(misses > 20, `expected plenty of misses, got ${misses}`);
});

test('the tMin default matches raySphereIntersect, and a custom tMin is passed through', () => {
  const s = sphereSurface(R);
  const origin = { x: 5.18, y: 0, z: 0 };
  const dir = { x: -1, y: 0, z: 0 };
  assert.ok(Object.is(s.intersect(origin, dir)!.t, raySphereIntersect(origin, dir, R)!.t));

  // The shadow query in `render.ts` passes 1e-6 to step off the surface it is
  // standing on, so a seam that dropped the argument would self-shadow every
  // floor point and the room would go black.
  //
  // The ray has to be chosen so the two cutoffs DISAGREE, which the obvious
  // choice does not: an outward ray from a point on the sphere returns null
  // under both, and an assertion built on it passes whether or not `tMin` is
  // forwarded. This one starts 5e-7 outside the surface pointing in, so its
  // near root at ~5.0e-7 clears the 1e-9 default and is rejected by 1e-6 —
  // under which the far root at ~1.73 is returned instead.
  const justOutside = { x: R + 5e-7, y: 0, z: 0 };
  const inward = { x: -1, y: 0, z: 0 };
  const near = s.intersect(justOutside, inward);
  const far = s.intersect(justOutside, inward, 1e-6);
  assert.ok(near !== null && far !== null);
  assert.ok(near.t < 1e-6, `near root should clear the default cutoff, got ${near.t}`);
  assert.ok(far.t > 1, `1e-6 should skip past the near root, got ${far.t}`);
  assert.ok(Object.is(near.t, raySphereIntersect(justOutside, inward, R)!.t));
  assert.ok(Object.is(far.t, raySphereIntersect(justOutside, inward, R, 1e-6)!.t));
});

test('coordAt is worldToLatLon and pointAt is latLonToWorld, bit for bit', () => {
  const s = sphereSurface(R);
  for (let lat = -90; lat <= 90; lat += 7.5) {
    for (let lon = -180; lon < 180; lon += 11.25) {
      const want = latLonToWorld(lat, lon, R);
      const got = s.pointAt({ latDeg: lat, lonDeg: lon });
      assert.ok(Object.is(got.x, want.x) && Object.is(got.y, want.y) && Object.is(got.z, want.z));

      const wantLL = worldToLatLon(want);
      const gotLL = s.coordAt(want);
      assert.ok(Object.is(gotLL.latDeg, wantLL.latDeg));
      assert.ok(Object.is(gotLL.lonDeg, wantLL.lonDeg));
    }
  }
});

test('normalAt is the scaled point the renderers used to compute inline', () => {
  const s = sphereSurface(R);
  for (const lat of [-89, -40, 0, 23.5, 71, 90]) {
    for (const lon of [-179, -90, 0, 45, 137]) {
      const p = latLonToWorld(lat, lon, R);
      const want = scale(p, 1 / R);
      const got = s.normalAt(p);
      assert.ok(Object.is(got.x, want.x) && Object.is(got.y, want.y) && Object.is(got.z, want.z));
    }
  }
});

test('sampleArea is the equal-area lattice, with the lattice unit vector AS the normal', () => {
  const s = sphereSurface(R);
  for (const n of [1, 7, 256, 4096]) {
    const want = equalAreaLattice(n);
    const got = s.sampleArea(n);
    assert.equal(got.length, want.length);
    for (let i = 0; i < n; i++) {
      const p = latLonToWorld(want[i].latDeg, want[i].lonDeg, R);
      assert.ok(Object.is(got[i].point.x, p.x));
      assert.ok(Object.is(got[i].point.y, p.y));
      assert.ok(Object.is(got[i].point.z, p.z));
      assert.ok(Object.is(got[i].coord.latDeg, want[i].latDeg));
      assert.ok(Object.is(got[i].coord.lonDeg, want[i].lonDeg));
      // The lattice's own `unit`, bit for bit — NOT a recomputed `point / R`.
      // The two differ in the last ulp at most lattice points, because `unit` is
      // built from `(r*cos, r*sin, z)` while `point / R` round-trips through
      // `latLonToWorld` and a division. `coverage-stats.ts` used to hand `s.unit`
      // straight to `pointStats` as the normal, so recomputing it here would
      // move a number the statistic depends on — which is exactly what the
      // byte-identity gate would then catch, three minutes later, as a bench
      // diff naming a scenario instead of naming this line.
      assert.ok(Object.is(got[i].normal.x, want[i].unit.x), `normal.x at ${i}`);
      assert.ok(Object.is(got[i].normal.y, want[i].unit.y), `normal.y at ${i}`);
      assert.ok(Object.is(got[i].normal.z, want[i].unit.z), `normal.z at ${i}`);
    }
  }
});

test('a rig shares one surface across every projector, and it is the rig radius', () => {
  const prepared = prepareRig(nominalRig());
  assert.equal(prepared.surface.kind, 'sphere');
  assert.equal(prepared.surface.boundsRadiusM, prepared.radiusM);
  for (const p of prepared.projectors) {
    // Identity, not equality: Phase 1's mesh carries a bounding volume
    // hierarchy, and four projectors rebuilding it four times per prepare is
    // the bug this assertion is here to prevent.
    assert.equal(p.surface, prepared.surface);
    assert.equal(p.radiusM, prepared.radiusM);
  }
});

test('a surface refuses a radius that would make every intersection NaN', () => {
  assert.throws(() => sphereSurface(0), /finite and positive/);
  assert.throws(() => sphereSurface(-1), /finite and positive/);
  assert.throws(() => sphereSurface(Number.NaN), /finite and positive/);
  assert.throws(() => new SphereSurface(Number.POSITIVE_INFINITY), /finite and positive/);
});

test('the interface carries what the call sites use and nothing dead', () => {
  // Phase 0's rule, from `surface.ts`: a method nobody calls is a claim the
  // model does something it does not. If a method is added here it should be
  // added because a call site needs it — so this list is the contract, and
  // widening it is a deliberate edit rather than a drive-by.
  //
  // It has been widened once, and this is the record of it. Phase 1 added
  // `facesLens` and `shadowed` because `coverage.ts`'s `isIlluminatedAt` calls
  // both: a mesh occludes itself and the old facing-only test was a statement
  // about convexity that nothing enforced. They are two methods rather than one
  // because their costs differ by orders of magnitude — the facing test runs
  // first and the shadow ray last, after the raster has rejected most points.
  const expected = ['intersect', 'coordAt', 'pointAt', 'normalAt', 'sampleArea', 'facesLens', 'shadowed'];
  const proto = SphereSurface.prototype as unknown as Record<string, unknown>;
  const actual = Object.getOwnPropertyNames(proto).filter(
    (k) => k !== 'constructor' && typeof proto[k] === 'function',
  );
  assert.deepEqual(actual.sort(), [...expected].sort());
});
