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
  meshTraversalStats,
  resetMeshTraversalStats,
} from '../src/mesh.ts';

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
