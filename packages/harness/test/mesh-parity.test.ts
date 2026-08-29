// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Link (1) of the parity chain, for the mesh: does the shader's traversal agree
 * with `packages/sim`?
 *
 * `glsl.test.ts` proves the reference still describes the shader — structure.
 * This proves the reference describes the same MODEL as the simulator —
 * arithmetic. Neither is a substitute for the other, and neither can be run on a
 * GPU in this container; link (3) is measured at runtime by the page.
 *
 * ## Two fixtures, because float32 is part of the answer
 *
 * The packed textures are `Float32Array` — that is what a GPU reads — while
 * `packages/sim` traces in float64. So a general mesh cannot agree exactly, and
 * a test that demanded it would be measuring the rounding rather than the
 * traversal.
 *
 * The first fixture therefore uses coordinates that are EXACTLY representable in
 * float32 (dyadic rationals), so packing is lossless and any disagreement is a
 * real difference in the traversal. The second is an ordinary tessellated
 * sphere, where the departure is measured and reported rather than assumed
 * small.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { SurfaceMesh, Vec3 } from '../../calibration/src/index.ts';
import { buildBvh, intersectBvh } from '../../sim/src/mesh/bvh.ts';
import { packBvh } from '../../sim/src/mesh/pack.ts';
import { latLonToWorld } from '../../sim/src/geometry.ts';
import { bvhIntersect, bvhNormalAt } from '../src/reference.ts';
import type { MeshUniforms, Uniforms } from '../src/uniforms.ts';

/** Just enough `Uniforms` for the traversal, which reads only `mesh`. */
function uniformsFor(mesh: SurfaceMesh): { u: Uniforms; packed: MeshUniforms } {
  const bvh = buildBvh(mesh);
  const p = packBvh(bvh, mesh);
  const packed: MeshUniforms = {
    nodes: p.nodes,
    nodeWidth: p.nodeWidth,
    triangles: p.triangles,
    triangleWidth: p.triangleWidth,
    nodeCount: p.nodeCount,
    triangleCount: p.triangleCount,
  };
  return { u: { mesh: packed } as unknown as Uniforms, packed };
}

/**
 * A crumpled grid on a dyadic lattice.
 *
 * Every coordinate is a multiple of 1/64, so it is exactly representable in
 * float32 and the packing loses nothing — the only thing left that can differ is
 * the traversal. Crumpled rather than flat so the hierarchy has real structure:
 * a plane splits into slabs that every ray crosses, which would exercise the
 * descent without ever exercising the pruning.
 *
 * The octahedron below is exact too, but it builds three nodes and one level.
 * This builds hundreds and enough depth for the near-child-first ordering, the
 * `bestT` pruning and the stack to all matter.
 */
function exactCrumpledGrid(n = 24): SurfaceMesh {
  const positions: number[] = [];
  const q = (x: number): number => Math.round(x * 64) / 64;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = q((i / n) * 2 - 1);
      const y = q((j / n) * 2 - 1);
      // A dyadic height that is not a plane and not smooth, so the centroid
      // split has something to separate on all three axes.
      const z = q(0.5 * Math.sin(i * 1.7) * Math.cos(j * 2.3));
      positions.push(x, y, z);
    }
  }
  const tris: number[] = [];
  const at = (i: number, j: number): number => j * (n + 1) + i;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      tris.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      tris.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'exact-crumpled-grid',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(tris),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: tris.length / 3,
  };
}

/**
 * An octahedron on the unit axes.
 *
 * Every coordinate is 0 or +/-1, so the float32 packing is exact and the only
 * thing that can differ is the traversal itself.
 */
function exactOctahedron(): SurfaceMesh {
  const positions = Float64Array.from([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
  const indices = Uint32Array.from([0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0, 4, 3, 0, 1, 3, 4, 5, 3, 1, 0, 3, 5]);
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'exact-octahedron',
    positions,
    indices,
    normals: null,
    uvs: null,
    vertexCount: 6,
    triangleCount: 8,
  };
}

function uvSphere(segments: number, rings: number, radius = 0.8636): SurfaceMesh {
  const vertexCount = (rings + 1) * (segments + 1);
  const positions = new Float64Array(3 * vertexCount);
  let v = 0;
  for (let iy = 0; iy <= rings; iy++) {
    const latDeg = 90 - (iy / rings) * 180;
    for (let ix = 0; ix <= segments; ix++) {
      const p = latLonToWorld(latDeg, -180 + (ix / segments) * 360, radius);
      positions[3 * v] = p.x;
      positions[3 * v + 1] = p.y;
      positions[3 * v + 2] = p.z;
      v++;
    }
  }
  const tris: number[] = [];
  const at = (ix: number, iy: number): number => iy * (segments + 1) + ix;
  for (let iy = 0; iy < rings; iy++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = at(ix, iy);
      const b = at(ix + 1, iy);
      const c = at(ix + 1, iy + 1);
      const d = at(ix, iy + 1);
      if (iy !== 0) tris.push(a, d, b);
      if (iy !== rings - 1) tris.push(b, d, c);
    }
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: `uv-${segments}x${rings}`,
    positions,
    indices: Uint32Array.from(tris),
    normals: null,
    uvs: null,
    vertexCount,
    triangleCount: tris.length / 3,
  };
}

/** Rays from a shell around the object, aimed across it. */
function* probeRays(count: number, radius: number): Generator<{ origin: Vec3; dir: Vec3 }> {
  for (let i = 0; i < count; i++) {
    // A deterministic spread rather than a PRNG: the same rays every run, and
    // the golden angle keeps them from lining up with the tessellation.
    const t = (i + 0.5) / count;
    const z = 1 - 2 * t;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * 2.399963229728653;
    const origin: Vec3 = {
      x: radius * r * Math.cos(phi),
      y: radius * r * Math.sin(phi),
      z: radius * z,
    };
    // Aimed at a point that walks across the object, so some rays miss.
    const aim: Vec3 = {
      x: 0.6 * Math.cos(phi * 1.7),
      y: 0.6 * Math.sin(phi * 2.3),
      z: 0.6 * Math.cos(phi * 0.9),
    };
    const dx = aim.x - origin.x;
    const dy = aim.y - origin.y;
    const dz = aim.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    yield { origin, dir: { x: dx / len, y: dy / len, z: dz / len } };
  }
}

test('on a float32-exact mesh the shader traversal agrees with the simulator exactly', () => {
  const mesh = exactCrumpledGrid();
  const bvh = buildBvh(mesh);
  const { u } = uniformsFor(mesh);
  // The fixture has to build a hierarchy worth traversing, or this test would
  // pass against a linear scan.
  assert.ok(bvh.maxDepth >= 6, `the fixture builds only ${bvh.maxDepth} levels`);
  assert.ok(bvh.nodeCount >= 64, `the fixture builds only ${bvh.nodeCount} nodes`);

  let hits = 0;
  let misses = 0;
  for (const { origin, dir } of probeRays(2000, 4)) {
    const cpu = intersectBvh(bvh, mesh, origin, dir, 1e-9, Infinity);
    const gpu = bvhIntersect(u, origin, dir, 1e-9, Infinity);

    if (cpu === null) {
      assert.ok(gpu[0] < 0, `simulator missed and the shader hit at t=${gpu[0]}`);
      misses++;
      continue;
    }
    hits++;
    assert.ok(gpu[0] >= 0, `simulator hit at t=${cpu.t} and the shader missed`);
    // `bvhIntersect` returns the index into `order`; the simulator returns the
    // mesh triangle. `order` is what the packing is written in, so this is the
    // one place the two indices are legitimately different numbers.
    assert.equal(bvh.order[gpu[1]], cpu.triangle, 'a different triangle');
    assert.equal(gpu[0], cpu.t, 'a different distance');
    assert.equal(gpu[2], cpu.u);
    assert.equal(gpu[3], cpu.v);
  }
  // The probe has to actually probe: a run that missed everything would pass
  // every assertion above.
  assert.ok(hits > 400, `only ${hits} of 2000 rays hit`);
  assert.ok(misses > 100, `only ${misses} of 2000 rays missed`);
});

test('on an ordinary mesh the departure is float32 rounding and is measured', () => {
  const mesh = uvSphere(48, 24);
  const bvh = buildBvh(mesh);
  const { u } = uniformsFor(mesh);

  let hits = 0;
  let agreed = 0;
  let worstT = 0;
  let differentTriangle = 0;
  for (const { origin, dir } of probeRays(3000, 5)) {
    const cpu = intersectBvh(bvh, mesh, origin, dir, 1e-9, Infinity);
    const gpu = bvhIntersect(u, origin, dir, 1e-9, Infinity);
    if (cpu === null || gpu[0] < 0) continue;
    hits++;
    if (bvh.order[gpu[1]] === cpu.triangle) {
      agreed++;
      worstT = Math.max(worstT, Math.abs(gpu[0] - cpu.t));
    } else {
      // A ray landing near a shared edge can be given to either neighbour once
      // the vertices move by a float32 ulp. The distance must still agree.
      differentTriangle++;
      worstT = Math.max(worstT, Math.abs(gpu[0] - cpu.t));
    }
  }
  assert.ok(hits > 1000, `only ${hits} rays hit`);
  // A float32 mantissa is 24 bits, so a coordinate near 1 m rounds by ~6e-8 and
  // a distance accumulated from a handful of them stays within a micron. This
  // bound is measured, not chosen: the observed worst case is reported when it
  // fails.
  assert.ok(
    worstT < 1e-5,
    `worst distance disagreement ${worstT.toExponential(2)} m over ${hits} hits`,
  );
  // And essentially all of them agree on WHICH triangle; the exceptions are
  // edge-grazing rays, which is the documented consequence of moving a vertex.
  assert.ok(
    differentTriangle / hits < 0.01,
    `${differentTriangle} of ${hits} hits chose a different triangle`,
  );
  assert.ok(agreed > 0);
});

test('a mesh with no normals falls back to the face normal, as the simulator does', () => {
  const mesh = exactOctahedron();
  const bvh = buildBvh(mesh);
  const { u } = uniformsFor(mesh);
  const origin: Vec3 = { x: 3, y: 0.1, z: 0.1 };
  const dir: Vec3 = { x: -1, y: 0, z: 0 };
  const gpu = bvhIntersect(u, origin, dir, 1e-9, Infinity);
  assert.ok(gpu[0] > 0, 'the probe ray must hit');
  const n = bvhNormalAt(u, gpu[1], gpu[2], gpu[3]);
  // The octahedron's +x+y+z face has normal (1,1,1)/sqrt(3).
  const s = 1 / Math.sqrt(3);
  assert.ok(Math.abs(Math.abs(n.x) - s) < 1e-6, `normal ${JSON.stringify(n)}`);
  assert.ok(Math.hypot(n.x, n.y, n.z) - 1 < 1e-6, 'the normal must be unit length');
});

test('the traversal stack is deep enough for the hierarchies the packer produces', () => {
  // The shader's stack is a compile-time 32. A hierarchy deeper than that would
  // silently drop nodes and report a miss where there is geometry, so the
  // packer reports its depth and this pins that a realistic model stays under.
  for (const [seg, ring] of [[16, 8], [48, 24], [96, 48], [192, 96]] as const) {
    const mesh = uvSphere(seg, ring);
    const packed = packBvh(buildBvh(mesh), mesh);
    assert.ok(
      packed.maxDepth < 32,
      `${seg}x${ring} (${mesh.triangleCount} triangles) needs depth ${packed.maxDepth}`,
    );
  }
});
