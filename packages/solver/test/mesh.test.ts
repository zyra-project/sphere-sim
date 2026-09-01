// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The solver's own ray-mesh intersection.
 *
 * Three kinds of test, and the middle one is the load-bearing one.
 *
 *  1. Against CLOSED FORM, on a box and a plane, where the answer is arithmetic
 *     and no tolerance is needed beyond float64 rounding.
 *  2. Against BRUTE FORCE, on a tessellated sphere, where an independent
 *     formulation of ray-triangle — plane distance then barycentric by signed
 *     area, rather than Möller–Trumbore — is run against every triangle with no
 *     hierarchy at all. This is what actually pins the BVH: a traversal that
 *     prunes a box it should have entered gives a plausible wrong answer, and
 *     only an exhaustive scan can catch it. The repository has the same pattern
 *     for the simulator's own traversal, and its argument applies here too — the
 *     two orderings are NOT bit-identical, so the assertion is on `t` to a
 *     stated tolerance.
 *  3. On the cases a projection surface actually produces and a renderer's
 *     intersection would be within its rights to ignore: an open shell seen from
 *     its concave side, a degenerate fan, and an empty mesh.
 *
 * Note what is NOT here: agreement with `packages/sim`'s intersection. It cannot
 * be — `tools/boundary-lint.ts` R1 bans the import and grants tests no
 * exemption, so that comparison can only live in `packages/bench`, which holds
 * both models. That test is the point of writing this independently and it does
 * not exist yet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SurfaceMesh } from '../../calibration/src/index.ts';

import {
  buildMeshIndex,
  intersectMesh,
  intersectMeshJacobian,
  meshTraversalStats,
  resetMeshTraversalStats,
} from '../src/mesh.ts';
import {
  CAM_FOCAL,
  CAM_PARAM_COUNT,
  CAM_VPX,
  type CameraModel,
  intersectSphereJacobian,
  zeroCameraRate,
} from '../src/sphere.ts';
import { phoneIntrinsics } from './synthetic.ts';

function meshOf(positions: number[], indices: number[], name = 'fixture'): SurfaceMesh {
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name,
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/**
 * An axis-aligned box, `2h` on a side, centred at the origin.
 *
 * Built face by face from an axis and a sign rather than by transcribing 36
 * indices, because a transcribed winding is a thing you get wrong once and then
 * cannot see. The test below asserts every triangle's winding normal points away
 * from the centre, so the fixture proves its own orientation.
 */
function boxMesh(h = 1): SurfaceMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      // The four corners of this face, walked so that (corner1-corner0) x
      // (corner2-corner0) points along `sign` on `axis`. Reversing the walk for
      // the negative face is what makes both faces outward.
      const walk = sign > 0 ? [[-1, -1], [1, -1], [1, 1], [-1, 1]] : [[-1, -1], [-1, 1], [1, 1], [1, -1]];
      const base = positions.length / 3;
      for (const [a, b] of walk) {
        const p = [0, 0, 0];
        p[axis] = sign * h;
        p[u] = a * h;
        p[v] = b * h;
        positions.push(p[0], p[1], p[2]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return meshOf(positions, indices, 'box');
}

/** A UV sphere. Enough triangles that the hierarchy has real work to do. */
function uvSphereMesh(nLat: number, nLon: number, r = 1): SurfaceMesh {
  const positions: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const theta = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const phi = (2 * Math.PI * j) / nLon;
      positions.push(
        r * Math.sin(theta) * Math.cos(phi),
        r * Math.sin(theta) * Math.sin(phi),
        r * Math.cos(theta),
      );
    }
  }
  const at = (i: number, j: number): number => i * nLon + (j % nLon);
  const indices: number[] = [];
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i !== 0) indices.push(a, b, d);
      if (i !== nLat - 1) indices.push(b, c, d);
    }
  }
  return meshOf(positions, indices, 'uv-sphere');
}

/**
 * Ray-triangle by a DIFFERENT route than the one under test.
 *
 * Möller–Trumbore never forms the plane; this forms it explicitly, solves for
 * the plane distance, and then decides containment by three signed areas
 * against the face normal. Two formulations that agree to 1e-12 on ten thousand
 * rays are unlikely to share a mistake.
 */
function bruteHit(mesh: SurfaceMesh, o: number[], d: number[]): { t: number; tri: number } {
  const { positions: P, indices: I } = mesh;
  let best = Infinity;
  let tri = -1;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = 3 * I[3 * t];
    const b = 3 * I[3 * t + 1];
    const c = 3 * I[3 * t + 2];
    const A = [P[a], P[a + 1], P[a + 2]];
    const B = [P[b], P[b + 1], P[b + 2]];
    const C = [P[c], P[c + 1], P[c + 2]];
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const denom = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (Math.abs(denom) < 1e-15) continue;
    const num = n[0] * (A[0] - o[0]) + n[1] * (A[1] - o[1]) + n[2] * (A[2] - o[2]);
    const s = num / denom;
    if (!(s > 0) || s >= best) continue;
    const p = [o[0] + s * d[0], o[1] + s * d[1], o[2] + s * d[2]];
    // Inside if all three edge cross-products agree in sign with the face normal.
    let inside = true;
    const corners = [A, B, C];
    for (let k = 0; k < 3 && inside; k++) {
      const p0 = corners[k];
      const p1 = corners[(k + 1) % 3];
      const ex = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const vp = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
      const cr = [
        ex[1] * vp[2] - ex[2] * vp[1],
        ex[2] * vp[0] - ex[0] * vp[2],
        ex[0] * vp[1] - ex[1] * vp[0],
      ];
      if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) inside = false;
    }
    if (inside) {
      best = s;
      tri = t;
    }
  }
  return { t: best, tri };
}

test('the box fixture is wound outward, which every later assertion assumes', () => {
  const mesh = boxMesh(1);
  assert.equal(mesh.triangleCount, 12);
  const { positions: P, indices: I } = mesh;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = 3 * I[3 * t];
    const b = 3 * I[3 * t + 1];
    const c = 3 * I[3 * t + 2];
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    // Centroid doubles as an outward direction for a box centred at the origin.
    const cen = [
      (P[a] + P[b] + P[c]) / 3,
      (P[a + 1] + P[b + 1] + P[c + 1]) / 3,
      (P[a + 2] + P[b + 2] + P[c + 2]) / 3,
    ];
    const dot = n[0] * cen[0] + n[1] * cen[1] + n[2] * cen[2];
    assert.ok(dot > 0, `triangle ${t} is wound inward (n . centroid = ${dot})`);
  }
});

test('a box is hit where arithmetic says it is', () => {
  const index = buildMeshIndex(boxMesh(1));
  // Down each axis, from outside, at the face centre. `t` is exact: the ray
  // travels 5 units to reach the plane at -1 from an origin at -6... etc.
  const cases: { o: number[]; d: number[]; t: number; n: number[] }[] = [
    { o: [0, 0, -6], d: [0, 0, 1], t: 5, n: [0, 0, -1] },
    { o: [0, 0, 6], d: [0, 0, -1], t: 5, n: [0, 0, 1] },
    { o: [-4, 0, 0], d: [1, 0, 0], t: 3, n: [-1, 0, 0] },
    { o: [0, 2.5, 0], d: [0, -1, 0], t: 1.5, n: [0, 1, 0] },
  ];
  for (const c of cases) {
    const h = intersectMesh(index, { x: c.o[0], y: c.o[1], z: c.o[2] }, { x: c.d[0], y: c.d[1], z: c.d[2] });
    assert.ok(h.hit, `missed from ${c.o.join(',')}`);
    assert.equal(h.t, c.t, `t from ${c.o.join(',')}`);
    assert.deepEqual([h.normal.x, h.normal.y, h.normal.z], c.n);
    // Straight at a face: the cosine is exactly 1.
    assert.equal(h.cosIncidence, 1);
    assert.ok(h.triangle >= 0 && h.triangle < 12);
  }
});

test('a ray that passes beside the box misses, and one aimed away misses', () => {
  const index = buildMeshIndex(boxMesh(1));
  const beside = intersectMesh(index, { x: 2, y: 0, z: -6 }, { x: 0, y: 0, z: 1 });
  assert.equal(beside.hit, false);
  assert.equal(beside.triangle, -1);
  assert.ok(Number.isNaN(beside.t));

  // The box is behind the origin, so every root is negative.
  const behind = intersectMesh(index, { x: 0, y: 0, z: -6 }, { x: 0, y: 0, z: -1 });
  assert.equal(behind.hit, false);
});

test('the traversal agrees with an exhaustive scan on ten thousand rays', () => {
  // The test the hierarchy exists to pass. A BVH that prunes a box it should
  // have entered returns a FARTHER triangle, or none — both plausible, neither
  // catchable without scanning everything.
  const mesh = uvSphereMesh(24, 48, 1);
  assert.ok(mesh.triangleCount > 2000, `only ${mesh.triangleCount} triangles`);
  const index = buildMeshIndex(mesh);

  let checked = 0;
  let misses = 0;
  let worst = 0;
  // Deterministic, not random: a failure has to reproduce.
  for (let k = 0; k < 10000; k++) {
    const a = 1 + k * 0.7853981633974483;
    const b = 1 + k * 0.2617993877991494;
    const o = [3 * Math.cos(a), 3 * Math.sin(a) * Math.cos(b), 3 * Math.sin(b)];
    // Aim at a jittered point near the origin so most rays hit and some graze.
    const target = [1.4 * Math.sin(2.3 * k), 1.4 * Math.cos(1.7 * k), 1.4 * Math.sin(0.9 * k)];
    const d = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    d[0] /= len;
    d[1] /= len;
    d[2] /= len;

    const got = intersectMesh(index, { x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] });
    const want = bruteHit(mesh, o, d);

    assert.equal(got.hit, want.tri >= 0, `ray ${k}: hit disagrees`);
    if (!got.hit) {
      misses++;
      continue;
    }
    checked++;
    const rel = Math.abs(got.t - want.t) / Math.max(1, Math.abs(want.t));
    if (rel > worst) worst = rel;
    assert.ok(rel < 1e-12, `ray ${k}: t ${got.t} against brute force ${want.t} (rel ${rel})`);
    // The point is on the ray at `t`, to rounding.
    for (const [g, e] of [
      [got.point.x, o[0] + got.t * d[0]],
      [got.point.y, o[1] + got.t * d[1]],
      [got.point.z, o[2] + got.t * d[2]],
    ]) {
      assert.ok(Math.abs(g - e) < 1e-12);
    }
  }
  // Both branches have to be exercised or the assertion above is vacuous.
  assert.ok(checked > 3000, `only ${checked} hits`);
  assert.ok(misses > 100, `only ${misses} misses — the fixture never tests the miss path`);
});

test('a tessellated sphere is inside its own analytic one, by the sagitta and no more', () => {
  // Not a tolerance pulled from the air, and the FIRST version of this bound was
  // wrong in a way worth recording: the deepest point of an inscribed triangle
  // is its circumcentre, not the midpoint of an edge, so the quantity is the
  // triangle's angular CIRCUMRADIUS. That is at most half its longest edge (with
  // equality only when the triangle is right or obtuse), and on a UV sphere the
  // longest edge is the quad's diagonal, whose angular length is bounded by
  // hypot(latitude step, longitude step). A cap of angular radius rho sits
  // r(1 - cos(rho)) below the surface, so that is the band.
  const nLat = 24;
  const nLon = 48;
  const r = 1;
  const index = buildMeshIndex(uvSphereMesh(nLat, nLon, r));
  const diagonal = Math.hypot(Math.PI / nLat, (2 * Math.PI) / nLon);
  const sagitta = r * (1 - Math.cos(diagonal / 2));

  for (let k = 0; k < 500; k++) {
    const a = 0.3 + k * 0.4;
    const b = 0.1 + k * 0.19;
    const d = [Math.sin(a) * Math.cos(b), Math.sin(a) * Math.sin(b), Math.cos(a)];
    const o = [-5 * d[0], -5 * d[1], -5 * d[2]];
    const h = intersectMesh(index, { x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] });
    assert.ok(h.hit, `ray ${k} missed a closed sphere from outside`);
    // `o` is at 5r along -d, so the hit's distance from the centre is `5 - t`,
    // and its depth below the analytic surface is `r` minus that.
    const depth = r - (5 - h.t);
    assert.ok(
      depth >= -1e-12 && depth <= sagitta + 1e-9,
      `ray ${k}: hit ${depth} inside the analytic surface, band is 0..${sagitta}`,
    );
    // Facing the camera, so the cosine is positive on every one of them.
    assert.ok(h.cosIncidence > 0, `ray ${k}: cosIncidence ${h.cosIncidence} on a front face`);
  }
});

test('an open shell is hit from its concave side, and says so in the sign', () => {
  // A renderer may cull backfaces; a measurement may not. A visitor's model can
  // be a shell, and a camera placed to see its inside would otherwise be told
  // there is nothing there.
  const shell = meshOf([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], [0, 1, 2, 0, 2, 3], 'shell');
  const index = buildMeshIndex(shell);

  const front = intersectMesh(index, { x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: -1 });
  assert.ok(front.hit);
  assert.equal(front.t, 3);
  assert.equal(front.cosIncidence, 1);

  const back = intersectMesh(index, { x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 1 });
  assert.ok(back.hit, 'the concave side was culled — a shell would be invisible from inside');
  assert.equal(back.t, 3);
  assert.equal(back.cosIncidence, -1, 'the back face did not report a negative cosine');
  // The normal is the geometry's, not flipped toward the ray.
  assert.deepEqual([back.normal.x, back.normal.y, back.normal.z], [0, 0, 1]);
});

test('degenerate meshes do not hang or lie', () => {
  // Empty.
  const empty = buildMeshIndex(meshOf([], [], 'empty'));
  assert.equal(intersectMesh(empty, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }).hit, false);

  // Every centroid coincident: the median split can never separate them, so the
  // build has to stop rather than recurse on a partition that does not shrink.
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < 32; i++) {
    const base = pos.length / 3;
    pos.push(0, 0, 0, 1, 0, 0, 0, 1, 0);
    idx.push(base, base + 1, base + 2);
  }
  const stacked = buildMeshIndex(meshOf(pos, idx, 'stacked'));
  const h = intersectMesh(stacked, { x: 0.25, y: 0.25, z: -1 }, { x: 0, y: 0, z: 1 });
  assert.ok(h.hit);
  assert.equal(h.t, 1);

  // A zero-area triangle cannot be hit at all.
  const sliver = buildMeshIndex(meshOf([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 2], 'sliver'));
  assert.equal(intersectMesh(sliver, { x: 0.5, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }).hit, false);
});

test('the hierarchy prunes, which no answer-checking test can see', () => {
  // Established by mutation rather than assumed: removing the slab test's
  // `near <= far` rejection left every other test in this file green, because a
  // BVH that has stopped pruning still returns the right triangle — it just
  // tests more of them to find it.
  //
  // The assertion is on SCALING, not on a constant. A constant bound loose
  // enough to survive tuning `LEAF_SIZE` was measured not to catch that
  // mutation at all (7.7 tests per ray against 19.9, both far under any
  // tolerable absolute limit), while the scaling separates them cleanly:
  // seventeen times the triangles costs a working hierarchy 1.01x the work and
  // a broken one 4.44x. That is the property being claimed — cost set by the
  // depth of the tree rather than by the size of the mesh — and it is the one
  // that matters on a solve intersecting hundreds of thousands of rays.
  const work = (nLat: number, nLon: number): { n: number; per: number } => {
    const mesh = uvSphereMesh(nLat, nLon, 1);
    const index = buildMeshIndex(mesh);
    resetMeshTraversalStats();
    let rays = 0;
    for (let k = 0; k < 200; k++) {
      const a = 0.3 + k * 0.4;
      const b = 0.1 + k * 0.19;
      const d = [Math.sin(a) * Math.cos(b), Math.sin(a) * Math.sin(b), Math.cos(a)];
      intersectMesh(index, { x: -5 * d[0], y: -5 * d[1], z: -5 * d[2] }, { x: d[0], y: d[1], z: d[2] });
      rays++;
    }
    return { n: mesh.triangleCount, per: meshTraversalStats().triangleTests / rays };
  };

  const small = work(12, 24);
  const big = work(48, 96);
  const triangleGrowth = big.n / small.n;
  const workGrowth = big.per / small.per;
  assert.ok(triangleGrowth > 10, `the two fixtures are too close in size (${triangleGrowth}x)`);
  assert.ok(
    workGrowth < 2,
    `${triangleGrowth.toFixed(1)}x the triangles cost ${workGrowth.toFixed(2)}x the triangle ` +
      `tests (${small.per.toFixed(1)} -> ${big.per.toFixed(1)} per ray) — the hierarchy is ` +
      'degenerating toward a linear scan',
  );
});

test('a ray meeting a shared edge does not fall through a closed surface', () => {
  // The defect this file shipped with, and the reason `BARY_EPS` exists.
  //
  // With the barycentric tests taken strictly, a ray meeting the seam between
  // two triangles is rejected by BOTH — each sees the hit as a hair outside
  // itself, on opposite sides of the rounding — and passes through a closed
  // surface. Measured before the fix: 71 of these 6624 rays, 1.07%, missed a
  // sphere with no hole in it. That is the figure `docs/ARBITRARY-SHAPES.md`
  // reports for the same effect, and `packages/sim/src/mesh/bvh.ts` records
  // finding it "on the first try".
  //
  // The count matters more than it looks. The holes are not scattered: a regular
  // tessellation puts its seams on meridians, so they line up and stay put.
  const mesh = uvSphereMesh(24, 48, 1);
  const index = buildMeshIndex(mesh);
  const { positions: P, indices: I } = mesh;

  let through = 0;
  let fired = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    for (let e = 0; e < 3; e++) {
      const p = 3 * I[3 * t + e];
      const q = 3 * I[3 * t + ((e + 1) % 3)];
      const m = [(P[p] + P[q]) / 2, (P[p + 1] + P[q + 1]) / 2, (P[p + 2] + P[q + 2]) / 2];
      const len = Math.hypot(m[0], m[1], m[2]);
      const d = [m[0] / len, m[1] / len, m[2] / len];
      fired++;
      const h = intersectMesh(
        index,
        { x: 5 * d[0], y: 5 * d[1], z: 5 * d[2] },
        { x: -d[0], y: -d[1], z: -d[2] },
      );
      // NOT just `h.hit`. A ray that falls through the near seam carries on and
      // exits the far side, which reports a perfectly good hit about a diameter
      // further along — so counting misses alone scores a hole in the surface as
      // a success. This test made exactly that mistake first, and the
      // sim-vs-solver comparison in `packages/bench` is what caught it: 151 of
      // these rays were taking the far side. The near surface is at t = 4 for a
      // unit sphere seen from 5, so anything past the centre is a pass-through.
      if (!h.hit || h.t > 5) through++;
    }
  }
  assert.ok(fired > 6000, `only ${fired} edge rays — the fixture is too small to be evidence`);
  assert.equal(through, 0, `${through} of ${fired} rays passed through the near surface at a seam`);
});

// ---------------------------------------------------------------------------
// The derivative
// ---------------------------------------------------------------------------

function testCamera(overrides: Partial<CameraModel> = {}): CameraModel {
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

/**
 * A coarse sphere on purpose.
 *
 * The derivative is exact within a facet and undefined across one, so a central
 * difference is only meaningful while the perturbed rays stay on the SAME
 * triangle. Big facets make that easy to arrange and easy to CHECK, which the
 * test below does rather than assumes — a finite difference taken across a
 * crease is comparing two different planes and would produce a number that
 * looks like a tolerance problem and is not.
 */
const COARSE = uvSphereMesh(8, 16, 1);

test('the analytic mesh Jacobian matches central differences, on a facet', () => {
  const index = buildMeshIndex(COARSE);
  const cam = testCamera();
  const nx = 0.21;
  const ny = -0.13;

  const analytic = intersectMeshJacobian(index, cam, nx, ny);
  assert.ok(analytic.hit.hit, 'the fixture ray misses the mesh');

  // Steps as `sphere.test.ts` uses: metres for position, degrees for angle.
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
    const hi = intersectMeshJacobian(index, perturb(i, h), nx, ny);
    const lo = intersectMeshJacobian(index, perturb(i, -h), nx, ny);
    // The precondition, asserted rather than hoped for.
    assert.equal(
      hi.hit.triangle,
      analytic.hit.triangle,
      `column ${i}: the +h ray left the facet, so the difference spans a crease`,
    );
    assert.equal(lo.hit.triangle, analytic.hit.triangle, `column ${i}: the -h ray left the facet`);

    const fd = [
      (hi.hit.point.x - lo.hit.point.x) / (2 * h),
      (hi.hit.point.y - lo.hit.point.y) / (2 * h),
      (hi.hit.point.z - lo.hit.point.z) / (2 * h),
    ];
    for (let r = 0; r < 3; r++) {
      const an = analytic.dPoint[r * CAM_PARAM_COUNT + i];
      assert.ok(
        Math.abs(fd[r] - an) / Math.max(1, Math.abs(fd[r])) < 1e-5,
        `dPoint[${r}][${i}] analytic ${an} against central difference ${fd[r]}`,
      );
    }
  }
});

test('the focal column is filled only when asked, and is right when it is', () => {
  // The failure this guards is recorded in `SphereHitJacobian`: a parameter was
  // freed whose Jacobian column was identically zero, the normal equations went
  // rank deficient by one, and `focalScale` came back as exactly 1.0 however
  // wrong it was. A column of zeros is not a small error, it is a silent one.
  const index = buildMeshIndex(COARSE);
  const cam = testCamera();
  const nx = 0.21;
  const ny = -0.13;

  const held = intersectMeshJacobian(index, cam, nx, ny);
  for (let r = 0; r < 3; r++) {
    assert.equal(held.dPoint[r * CAM_PARAM_COUNT + CAM_FOCAL], 0, 'the focal column filled itself');
  }

  // `focalScale` multiplies the normalised coordinate, so d(x,y)/d(focalScale)
  // is (x, y) itself — the caller owns the intrinsics and supplies this.
  const dNormalized = { dx: nx, dy: ny };
  const free = intersectMeshJacobian(index, cam, nx, ny, undefined, undefined, undefined, dNormalized);
  let magnitude = 0;
  for (let r = 0; r < 3; r++) {
    magnitude = Math.max(magnitude, Math.abs(free.dPoint[r * CAM_PARAM_COUNT + CAM_FOCAL]));
  }
  assert.ok(magnitude > 1e-6, `the focal column is ${magnitude}, indistinguishable from zero`);

  // Against a central difference in the scale itself.
  const h = 1e-6;
  const at = (s: number): { x: number; y: number; z: number } =>
    intersectMeshJacobian(index, cam, nx * s, ny * s).hit.point;
  const hi = at(1 + h);
  const lo = at(1 - h);
  const fd = [(hi.x - lo.x) / (2 * h), (hi.y - lo.y) / (2 * h), (hi.z - lo.z) / (2 * h)];
  for (let r = 0; r < 3; r++) {
    const an = free.dPoint[r * CAM_PARAM_COUNT + CAM_FOCAL];
    assert.ok(
      Math.abs(fd[r] - an) / Math.max(1, Math.abs(fd[r])) < 1e-5,
      `focal column row ${r}: analytic ${an} against central difference ${fd[r]}`,
    );
  }
});

test('the velocity columns are the pose columns through the epoch, by difference', () => {
  // `pose(t) = pose + velocity * dt` is affine in the rate, so the chain rule is
  // exact rather than approximate. Asserted by DIFFERENCING the rate, not by
  // restating the multiplication the code performs — which would pass with the
  // factor written the wrong way round.
  const index = buildMeshIndex(COARSE);
  const dtFrames = 2.5;
  const nx = 0.21;
  const ny = -0.13;
  const base = testCamera();

  // The caller epochs the camera and tells the Jacobian how far it travelled.
  const epoched = (vpx: number): CameraModel => ({
    ...base,
    position: { ...base.position, x: base.position.x + vpx * dtFrames },
  });

  const analytic = intersectMeshJacobian(
    index,
    epoched(0),
    nx,
    ny,
    undefined,
    undefined,
    dtFrames,
  );
  assert.ok(analytic.hit.hit);

  const h = 1e-6;
  const hi = intersectMeshJacobian(index, epoched(h), nx, ny).hit.point;
  const lo = intersectMeshJacobian(index, epoched(-h), nx, ny).hit.point;
  const fd = [(hi.x - lo.x) / (2 * h), (hi.y - lo.y) / (2 * h), (hi.z - lo.z) / (2 * h)];
  for (let r = 0; r < 3; r++) {
    const an = analytic.dPoint[r * CAM_PARAM_COUNT + CAM_VPX];
    assert.ok(
      Math.abs(fd[r] - an) / Math.max(1, Math.abs(fd[r])) < 1e-5,
      `velocity column row ${r}: analytic ${an} against central difference ${fd[r]}`,
    );
  }

  // And they stay zero when the solve holds the rate.
  const stationary = intersectMeshJacobian(index, epoched(0), nx, ny);
  for (let r = 0; r < 3; r++) {
    assert.equal(stationary.dPoint[r * CAM_PARAM_COUNT + CAM_VPX], 0);
  }
});

test('the derivative is discontinuous across a crease, and the size of the jump is the dihedral', () => {
  // The claim the docblock makes, measured rather than asserted. This is not a
  // defect to be fixed by a tolerance — the surface really is C0 and not C1, and
  // a solve stepping across a facet boundary lands somewhere the linearisation
  // did not predict. Recording HOW BIG the jump is turns that from a worry into
  // a number the bench can be pointed at.
  const index = buildMeshIndex(COARSE);
  const cam = testCamera();

  // Sweep the normalised coordinate until the hit changes facet, then take the
  // analytic derivative on either side of the crossing.
  let crossings = 0;
  let worstJump = 0;
  let prev = intersectMeshJacobian(index, cam, -0.3, -0.13);
  for (let k = 1; k <= 600; k++) {
    const nx = -0.3 + (0.6 * k) / 600;
    const here = intersectMeshJacobian(index, cam, nx, -0.13);
    if (!here.hit.hit || !prev.hit.hit) {
      prev = here;
      continue;
    }
    if (here.hit.triangle !== prev.hit.triangle) {
      crossings++;
      // Compare the translation block, which is the one the bundle uses most.
      let jump = 0;
      for (let r = 0; r < 3; r++) {
        for (let i = 0; i < 3; i++) {
          const a = here.dPoint[r * CAM_PARAM_COUNT + i];
          const b = prev.dPoint[r * CAM_PARAM_COUNT + i];
          jump = Math.max(jump, Math.abs(a - b));
        }
      }
      worstJump = Math.max(worstJump, jump);
    }
    prev = here;
  }

  assert.ok(crossings > 5, `only ${crossings} facet crossings — the sweep is not crossing creases`);
  // A jump of ZERO would mean the facets are coplanar and this fixture proves
  // nothing; an enormous one would mean the derivative is wrong rather than
  // merely one-sided. On an 8x16 sphere the dihedral is about 22 degrees, and a
  // unit-scale translation derivative turning through that is O(0.1..1).
  assert.ok(worstJump > 1e-3, `the largest jump is ${worstJump} — the fixture has no creases`);
  assert.ok(
    worstJump < 10,
    `the derivative jumps by ${worstJump} across a crease, far more than the dihedral can ` +
      'explain — that is a wrong derivative, not a one-sided one',
  );
});

test('the mesh derivative converges to the sphere’s closed form, first order in the facet', () => {
  // The central-difference tests above confirm this code differentiates what it
  // COMPUTES. They cannot confirm it differentiates the right geometry — a
  // derivative can be perfectly self-consistent about the wrong surface. This
  // compares it against a completely independent closed form, `sphere.ts`, on a
  // mesh that approximates the same sphere.
  //
  // The statistic is the MEDIAN, not the worst case, and that is not a way of
  // being kind to the number. The worst case is set by rays that graze, where
  // `n . d` approaches zero and the derivative legitimately diverges on both
  // sides — and where PARAMETERS.md §4.3 has the decode rejecting the
  // correspondence anyway, at `minCosIncidence = 0.2`. Measuring convergence on
  // rays the solve would throw away measures the wrong thing.
  //
  // Expect FIRST order: the flat normal differs from the true one by about half
  // the facet's angular size, so halving the facet halves the error. Measured
  // across five refinements: 1.29e-1, 6.08e-2, 3.30e-2, 1.68e-2, 8.39e-3 — a
  // clean halving each time, and a factor of 15.4 over a 16x refinement.
  const cam = testCamera();

  const medianError = (nLat: number, nLon: number): number => {
    const index = buildMeshIndex(uvSphereMesh(nLat, nLon, 1));
    const errors: number[] = [];
    for (let k = 0; k < 300; k++) {
      const nx = -0.25 + (0.5 * k) / 300;
      const ny = -0.13 + 0.2 * Math.sin(k * 0.7);
      const m = intersectMeshJacobian(index, cam, nx, ny);
      const s = intersectSphereJacobian(cam, nx, ny, 1);
      if (!m.hit.hit || !s.hit.hit) continue;
      if (m.hit.cosIncidence < 0.2) continue;
      let worst = 0;
      for (let r = 0; r < 3; r++) {
        for (let i = 0; i < 6; i++) {
          const d = Math.abs(m.dPoint[r * CAM_PARAM_COUNT + i] - s.dPoint[r * CAM_PARAM_COUNT + i]);
          if (d > worst) worst = d;
        }
      }
      errors.push(worst);
    }
    assert.ok(errors.length > 200, `only ${errors.length} usable rays at ${nLat}x${nLon}`);
    errors.sort((a, b) => a - b);
    return errors[Math.floor(errors.length / 2)];
  };

  const coarse = medianError(16, 32);
  const fine = medianError(64, 128);
  const ratio = coarse / fine;

  // A four-fold refinement should buy about four. The band is generous in one
  // direction only: a ratio far ABOVE 4 would mean the coarse fixture is being
  // flattered by something other than convergence.
  assert.ok(
    ratio > 2.5 && ratio < 8,
    `refining 4x moved the median error by ${ratio.toFixed(2)}x (${coarse.toExponential(2)} -> ` +
      `${fine.toExponential(2)}) — first order in the facet size predicts about 4`,
  );
  // And the absolute level is where a tessellation error should sit, not where a
  // wrong formula would.
  assert.ok(fine < 0.05, `the fine median is ${fine.toExponential(2)}, too large to be faceting`);
});
