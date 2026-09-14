// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `poleAxis: 'x'` — the geometry, not the policy.
 *
 * Added because review pointed out that the manipulation Experiment 7's negative
 * result rests on had no test on its own vertices. The tessellation tests cover
 * the summary policy — which seeds count, how pairs are formed — and would go on
 * passing if this function moved the body, inverted the winding, or quietly did
 * nothing at all. The experiment artifact would still look plausible, and the
 * conclusion drawn from it would be about a different manipulation than the one
 * the write-up names.
 *
 * The four properties below are the ones a sign slip would break, in the order
 * they would break silently:
 *
 *  1. The BODY does not move. Turning the poles is a re-parameterisation of the
 *     same sphere; a version that moved the sphere would answer a question
 *     nobody asked.
 *  2. The POLE does. That is the whole manipulation, and a no-op would leave the
 *     experiment measuring seed variance under a name that says otherwise.
 *  3. The map is a ROTATION, not a reflection. `(x,y,z) -> (z,y,x)` is the
 *     obvious spelling and it is wrong: determinant -1 reverses every triangle's
 *     winding, which inverts the vertex normals `meshNormal: 'smooth'` derives
 *     from them — silently, and in the one mode the experiment is about.
 *  4. A non-sphere is refused rather than silently mis-tessellated.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ellipsoidMesh } from '../src/surfaces.ts';

const R = 1.2;
const GRID = { nLat: 16, nLon: 32 } as const;

function meshFor(poleAxis: 'z' | 'x'): ReturnType<typeof ellipsoidMesh> {
  return ellipsoidMesh(
    {
      kind: 'ellipsoid',
      scaleY: 1,
      scaleZ: 1,
      ...GRID,
      ...(poleAxis === 'x' ? { poleAxis: 'x' as const } : {}),
    },
    R,
  );
}

test('turning the poles leaves every vertex on the same sphere', () => {
  for (const axis of ['z', 'x'] as const) {
    const m = meshFor(axis);
    let worst = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      const x = m.positions[3 * v];
      const y = m.positions[3 * v + 1];
      const z = m.positions[3 * v + 2];
      worst = Math.max(worst, Math.abs(Math.hypot(x, y, z) - R));
    }
    assert.ok(worst < 1e-12, `poles on ${axis}: worst radius error ${worst}`);
  }
});

test('the tessellation moves while the body does not', () => {
  // These are two claims and the first draft of this test collapsed them into a
  // false one: that the turned mesh has the SAME VERTEX SET as the original. It
  // does not, and it must not — rotating a lat-long grid ninety degrees about y
  // carries its points somewhere else on the same sphere, and that displacement
  // IS the manipulation. Asserting set equality would have demanded a no-op.
  //
  // What "the body does not move" actually means here is the test above: every
  // vertex sits on the sphere of radius R about the origin, under both
  // orientations. What is left to check is that the grid genuinely moved, and
  // that it is the same grid — same vertex and triangle counts, so the two arms
  // differ in orientation alone and not in density.
  const key = (m: ReturnType<typeof ellipsoidMesh>, v: number): string =>
    [0, 1, 2].map((c) => m.positions[3 * v + c].toFixed(9)).join(',');
  const z = meshFor('z');
  const x = meshFor('x');
  assert.equal(x.vertexCount, z.vertexCount, 'same vertex budget');
  assert.equal(x.triangleCount, z.triangleCount, 'same triangle budget');
  const zs = new Set(Array.from({ length: z.vertexCount }, (_, v) => key(z, v)));
  let moved = 0;
  for (let v = 0; v < x.vertexCount; v++) if (!zs.has(key(x, v))) moved++;
  assert.ok(
    moved > x.vertexCount / 4,
    `only ${moved} of ${x.vertexCount} vertices moved — the poles barely turned`,
  );
});

test('the pole moves from +Z to +X, which is the entire manipulation', () => {
  // theta = 0 is the first row of the grid, so vertex 0 is the pole. A no-op
  // implementation passes every test above this one and fails this.
  const z = meshFor('z');
  const x = meshFor('x');
  assert.ok(Math.abs(z.positions[2] - R) < 1e-12, `Z-pole mesh starts at +Z, got ${z.positions[2]}`);
  assert.ok(Math.abs(z.positions[0]) < 1e-12);
  assert.ok(Math.abs(x.positions[0] - R) < 1e-12, `X-pole mesh starts at +X, got ${x.positions[0]}`);
  assert.ok(Math.abs(x.positions[2]) < 1e-12);
});

test('the map is a rotation, so winding is preserved and smooth normals stay outward', () => {
  // Determinant of the transform, read off the basis vectors rather than
  // assumed: (x,y,z) -> (z,y,-x) sends e1 -> -e3, e2 -> e2, e3 -> e1. The
  // reflection (z,y,x) that this code deliberately does NOT use has
  // determinant -1 and would fail here.
  //
  // Checked on the mesh itself as well: for a convex body wound consistently
  // outward, every triangle's normal points away from the centre. A reversed
  // winding flips all of them at once, so one negative dot product is enough.
  const m = meshFor('x');
  let inward = 0;
  for (let t = 0; t < m.triangleCount; t++) {
    const [ia, ib, ic] = [0, 1, 2].map((k) => m.indices[3 * t + k]);
    const p = (i: number): [number, number, number] => [
      m.positions[3 * i],
      m.positions[3 * i + 1],
      m.positions[3 * i + 2],
    ];
    const [ax, ay, az] = p(ia);
    const [bx, by, bz] = p(ib);
    const [cx, cy, cz] = p(ic);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    // u × v, and the centroid it should point away from.
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const gx = (ax + bx + cx) / 3;
    const gy = (ay + by + cy) / 3;
    const gz = (az + bz + cz) / 3;
    if (nx * gx + ny * gy + nz * gz < 0) inward++;
  }
  assert.equal(inward, 0, `${inward} of ${m.triangleCount} triangles wind inward`);
});

test('the same winding check fails on the reflection this code refuses to use', () => {
  // Teeth. Without this, the test above passes for a mesh built either way as
  // long as the checker itself has a sign error, and "no triangles wind inward"
  // would be a statement about the checker rather than about the mesh.
  const m = meshFor('x');
  let inward = 0;
  for (let t = 0; t < m.triangleCount; t++) {
    const [ia, ib, ic] = [0, 1, 2].map((k) => m.indices[3 * t + k]);
    // Mirror every vertex through x -> -x, which is what using (z,y,x) instead
    // of (z,y,-x) amounts to: the same points, opposite handedness.
    const p = (i: number): [number, number, number] => [
      -m.positions[3 * i],
      m.positions[3 * i + 1],
      m.positions[3 * i + 2],
    ];
    const [ax, ay, az] = p(ia);
    const [bx, by, bz] = p(ib);
    const [cx, cy, cz] = p(ic);
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const gx = (ax + bx + cx) / 3;
    const gy = (ay + by + cy) / 3;
    const gz = (az + bz + cz) / 3;
    if (nx * gx + ny * gy + nz * gz < 0) inward++;
  }
  assert.equal(inward, m.triangleCount, 'a reflected mesh should wind inward everywhere');
});

test('a non-sphere is refused, because turning its poles would move the body', () => {
  for (const [scaleY, scaleZ] of [
    [0.9, 1],
    [1, 0.8],
    [1.1, 0.7],
  ]) {
    assert.throws(
      () =>
        ellipsoidMesh(
          { kind: 'ellipsoid', scaleY, scaleZ, ...GRID, poleAxis: 'x' },
          R,
        ),
      /moves the tessellation, not the body/,
      `scales 1:${scaleY}:${scaleZ} should be refused`,
    );
  }
  // And the same scales are fine with the poles left alone, so the refusal is
  // about the combination rather than about non-spheres in general.
  assert.doesNotThrow(() =>
    ellipsoidMesh({ kind: 'ellipsoid', scaleY: 0.9, scaleZ: 0.8, ...GRID }, R),
  );
});
