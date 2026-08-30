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
import { packBvh, readPackedField } from '../../sim/src/mesh/pack.ts';
import { meshSurface } from '../../sim/src/mesh/surface.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { nominalRig } from '../../sim/src/scene.ts';
import { footprintDistanceAt } from '../../sim/src/footprint.ts';
import type { FootprintField } from '../../sim/src/footprint.ts';
import { latLonToWorld } from '../../sim/src/geometry.ts';
import { bvhCoordAt, bvhIntersect, bvhNormalAt, sampleSurface, surfaceIntersect } from '../src/reference.ts';
import { buildUniforms } from '../src/uniforms.ts';
import { defaultScene } from '../../sim/src/render.ts';
import { flatField } from '../../sim/src/equirect.ts';
import { coverageAndWeights } from '../../sim/src/coverage.ts';
import type { MeshUniforms, Uniforms } from '../src/uniforms.ts';

/** Just enough `Uniforms` for the traversal, which reads only `mesh`. */
function uniformsFor(mesh: SurfaceMesh): { u: Uniforms; packed: MeshUniforms } {
  const bvh = buildBvh(mesh);
  const p = packBvh(bvh, mesh);
  const surface = meshSurface(mesh);
  const packed: MeshUniforms = {
    nodes: p.nodes,
    nodeWidth: p.nodeWidth,
    triangles: p.triangles,
    triangleWidth: p.triangleWidth,
    nodeCount: p.nodeCount,
    triangleCount: p.triangleCount,
    field: p.field,
    fieldWidth: p.fieldWidth,
    centre: surface.centre,
    extentRadiusM: surface.extentRadiusM,
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

function uvSphere(
  segments: number,
  rings: number,
  radius = 0.8636,
  withUvs = false,
): SurfaceMesh {
  const vertexCount = (rings + 1) * (segments + 1);
  const positions = new Float64Array(3 * vertexCount);
  // The equirectangular unwrap, which is the one that makes a tessellated sphere
  // show what the analytic sphere shows -- so a content coordinate can be
  // compared between the two renderers rather than merely being present.
  const uvs = withUvs ? new Float32Array(2 * vertexCount) : null;
  let v = 0;
  for (let iy = 0; iy <= rings; iy++) {
    const latDeg = 90 - (iy / rings) * 180;
    for (let ix = 0; ix <= segments; ix++) {
      const p = latLonToWorld(latDeg, -180 + (ix / segments) * 360, radius);
      positions[3 * v] = p.x;
      positions[3 * v + 1] = p.y;
      positions[3 * v + 2] = p.z;
      if (uvs !== null) {
        uvs[2 * v] = ix / segments;
        uvs[2 * v + 1] = iy / rings;
      }
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
    uvs,
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

// ---------------------------------------------------------------------------
// The blend, as texels
// ---------------------------------------------------------------------------

test('the packed field reproduces footprintDistanceAt across a face', () => {
  // The general blend is a per-VERTEX geodesic field that `footprintDistanceAt`
  // interpolates across the face a hit landed on. A shader cannot follow a
  // Float64Array any more than it can follow the hierarchy, so the same three
  // corners are written beside the triangle -- and this is the claim that makes
  // that substitution legitimate: the packed corners interpolate to the same
  // number the simulator reads, at any point of any face.
  //
  // Without it the GPU would blend from one field and the CPU from another, and
  // the parity number on the page would be measuring the packing.
  const mesh = uvSphere(24, 12);
  const surface = meshSurface(mesh);
  const rig = prepareRig(nominalRig(), surface);
  assert.ok(rig.footprints != null, 'a mesh rig must build footprint fields');
  // Bound with its type written down. Narrowing `rig.footprints` through the
  // assertion above leaves the element type flowing from an inference that
  // `const field = fields[j]` inside the loops then takes part in, which
  // TypeScript reports as a circularity (TS7022) rather than resolving.
  const fields: readonly (FootprintField | null)[] = rig.footprints;

  const bvh = buildBvh(mesh);
  const packed = packBvh(bvh, mesh, fields);
  assert.ok(packed.field !== null, 'fields were supplied, so a field texture must be written');

  // Barycentric points spread over each sampled face, corners included, because
  // a corner is where a mistaken vertex lookup would still agree in the middle.
  const bary: [number, number][] = [
    [0, 0], [1, 0], [0, 1], [1 / 3, 1 / 3], [0.7, 0.2], [0.05, 0.9],
  ];
  let checked = 0;
  let worst = 0;
  for (let t = 0; t < packed.triangleCount; t += 7) {
    const tri = bvh.order[t];
    const a = mesh.indices[3 * tri];
    const b = mesh.indices[3 * tri + 1];
    const c = mesh.indices[3 * tri + 2];
    const corners = [0, 1, 2].map((k) => readPackedField(packed, t, k));
    for (const corner of corners) assert.ok(corner !== null);
    for (const [u, v] of bary) {
      for (let j = 0; j < fields.length; j++) {
        const field = fields[j];
        if (field === null) continue;
        const want = footprintDistanceAt(field, { triangle: tri, a, b, c, u, v });
        const got =
          (1 - u - v) * (corners[0] as number[])[j] +
          u * (corners[1] as number[])[j] +
          v * (corners[2] as number[])[j];
        // float32, so not bit-exact against a float64 field. The tolerance is
        // float32's own resolution scaled by the distance, not a fudge: these
        // are metres across a 0.86 m sphere.
        const tol = 1e-6 * Math.max(1, Math.abs(want));
        worst = Math.max(worst, Math.abs(got - want));
        assert.ok(
          Math.abs(got - want) <= tol,
          `triangle ${t} projector ${j} at (${u}, ${v}): packed ${got}, field ${want}`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 500, `only ${checked} comparisons; the sweep must actually cover the mesh`);
  // Reported rather than merely bounded, so a regression in the packing shows up
  // as a number moving rather than as a threshold still being met.
  console.log(`  packed field vs footprintDistanceAt: worst ${worst.toExponential(2)} m`);

  // And the corner values themselves are the float32 of the field, exactly --
  // the interpolation above could hide a systematic corner error that the
  // barycentric mix averages out.
  for (let t = 0; t < packed.triangleCount; t += 13) {
    const tri = bvh.order[t];
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * tri + k];
      const corner = readPackedField(packed, t, k) as number[];
      for (let j = 0; j < fields.length; j++) {
        const field = fields[j];
        if (field === null) continue;
        assert.equal(corner[j], Math.fround(field.distance[v]));
      }
    }
  }
});

test('a mesh with no fields packs no field texture, and a fifth field is refused', () => {
  const mesh = uvSphere(8, 4);
  const bvh = buildBvh(mesh);
  // Omitted entirely, and explicitly empty: both mean "nothing is lighting this
  // yet", and neither is the same as a field of zeros, which the shader would
  // read as a footprint nothing is inside.
  assert.equal(packBvh(bvh, mesh).field, null);
  assert.equal(packBvh(bvh, mesh, []).field, null);
  assert.equal(packBvh(bvh, mesh, null).field, null);

  // One texel is four channels because the shaders light four projectors. A
  // fifth field has nowhere to go, and dropping it silently would dim one
  // projector's share of the blend rather than fail.
  const five = new Array(5).fill({ distance: new Float64Array(mesh.vertexCount), litVertices: 0 });
  assert.throws(() => packBvh(bvh, mesh, five), /MAX_PROJ|nowhere to go/);
});

// ---------------------------------------------------------------------------
// Link (1) for the SHADING, not just the traversal
// ---------------------------------------------------------------------------

/**
 * Two plates facing +x, one behind the other.
 *
 * The far one FACES a projector on +x and is entirely in the near one's shadow,
 * which is the case a sphere can never present and the only one that exercises
 * `meshIlluminatedAt`'s third test. A convex fixture cannot: dropping the shadow
 * ray from the reference leaves a tessellated sphere pixel-identical, which is
 * how this fixture came to exist.
 */
function twoPlates(halfSizeM = 0.3): SurfaceMesh {
  const s = halfSizeM;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const x of [0.2, -0.2]) {
    const base = positions.length / 3;
    // Wound so the face normal is +x: cross(v1 - v0, v2 - v0) points that way.
    positions.push(x, -s, -s, x, s, -s, x, s, s, x, -s, s);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'two-plates',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: Float32Array.from(uvs),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/**
 * Every decision the mesh path makes, held against `packages/sim`.
 *
 * The traversal tests above prove the shader finds the same triangle. This
 * proves the rest of the model follows it: the normal, the content coordinate,
 * which projectors light the point, and the geodesic blend weight each of them
 * gets. Those are four separate decisions, and every one was a sphere closed
 * form until this phase.
 *
 * Against `packages/sim` directly rather than against a stored number, because
 * the claim is that the two renderers are one model.
 */
function compareShading(
  mesh: SurfaceMesh,
  label: string,
  options: { minRays: number; shellM: number },
): { lit: number; shadowed: number } {
  const surface = meshSurface(mesh);
  const rig = prepareRig(nominalRig(), surface);
  const bvh = buildBvh(mesh);
  const packed = packBvh(bvh, mesh, rig.footprints);

  const u = buildUniforms(
    nominalRig(),
    defaultScene(flatField(64, 32, { r: 0.5, g: 0.5, b: 0.5 })),
    {
      position: { x: 6.2, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      fovHDeg: 50,
      width: 32,
      height: 24,
    },
    {
      mode: 'room',
      displayGamma: 0,
      mesh: {
        nodes: packed.nodes,
        nodeWidth: packed.nodeWidth,
        triangles: packed.triangles,
        triangleWidth: packed.triangleWidth,
        nodeCount: packed.nodeCount,
        triangleCount: packed.triangleCount,
        field: packed.field,
        fieldWidth: packed.fieldWidth,
        centre: surface.centre,
        extentRadiusM: surface.extentRadiusM,
      },
    },
  );

  // 29 by 17 with an offset, deliberately incommensurate with any lattice the
  // fixtures use. A sweep on the model's own grid aims every ray at a vertex,
  // where float32 and float64 pick different adjacent faces about half the time
  // -- an honest measurement of edge behaviour and a useless one of shading.
  let compared = 0;
  let edgeDisagreements = 0;
  let litCount = 0;
  let shadowedCount = 0;
  let worstT = 0;
  let worstWeight = 0;
  let worstNormal = 0;
  let worstLon = 0;
  for (let a = 0; a < 29; a++) {
    for (let b = 0; b < 17; b++) {
      const az = ((a + 0.37) / 29) * 2 * Math.PI;
      const el = -Math.PI / 2 + ((b + 0.21) / 17) * Math.PI;
      const origin = {
        x: options.shellM * Math.cos(el) * Math.cos(az),
        y: options.shellM * Math.cos(el) * Math.sin(az),
        z: options.shellM * Math.sin(el),
      };
      const len = Math.hypot(origin.x, origin.y, origin.z);
      const dir = { x: -origin.x / len, y: -origin.y / len, z: -origin.z / len };

      const simHit = surface.intersect(origin, dir);
      const refHit = surfaceIntersect(u, origin, dir, 1e-9, 1e30);
      if (simHit === null || simHit.location == null) {
        assert.ok(refHit[0] < 0, `${label}: the reference found geometry the simulator did not`);
        continue;
      }
      assert.ok(refHit[0] > 0, `${label}: the simulator found geometry the reference did not`);
      compared++;
      worstT = Math.max(worstT, Math.abs(refHit[0] - simHit.t));

      // The packed index is a position in `order`; the simulator's is a mesh
      // triangle, and `order` is the map between them. They agree except at a
      // shared edge, where float32 and float64 can land either side -- the same
      // departure the fixtures above measure, counted rather than asserted away.
      // A ray that picked a different face gets no further comparison: two
      // adjacent triangles have genuinely different normals and UVs, so
      // measuring those would be measuring the tessellation.
      if (bvh.order[Math.trunc(refHit[1])] !== simHit.location.triangle) {
        edgeDisagreements++;
        continue;
      }

      const point = {
        x: origin.x + dir.x * refHit[0],
        y: origin.y + dir.y * refHit[0],
        z: origin.z + dir.z * refHit[0],
      };
      const surf = sampleSurface(u, point, refHit);

      worstNormal = Math.max(
        worstNormal,
        Math.hypot(
          surf.normal.x - simHit.normal.x,
          surf.normal.y - simHit.normal.y,
          surf.normal.z - simHit.normal.z,
        ),
      );
      const coord = surface.coordAt(simHit.point, simHit.location);
      assert.ok(
        Math.abs(surf.latDeg - coord.latDeg) < 1e-3,
        `${label}: lat ${surf.latDeg} vs ${coord.latDeg}`,
      );
      worstLon = Math.max(worstLon, Math.abs(surf.lonDeg - coord.lonDeg));

      const want = coverageAndWeights(simHit.point, simHit.normal, rig, simHit.location);
      for (let i = 0; i < rig.projectors.length; i++) {
        assert.equal(
          surf.lit[i],
          want.lit[i],
          `${label}: projector ${i} lit disagrees at ${JSON.stringify(point)}`,
        );
        if (surf.lit[i]) litCount++;
        // Faces the lens and lands on the raster and is dark anyway: the model
        // is in its own way. Counted so a fixture that never shadows cannot
        // masquerade as one that does.
        else if (
          surface.facesLens(simHit.point, simHit.normal, rig.projectors[i].lens) &&
          surface.shadowed(simHit.point, rig.projectors[i].lens)
        ) {
          shadowedCount++;
        }
        worstWeight = Math.max(worstWeight, Math.abs(surf.weights[i] - want.weights[i]));
      }
    }
  }

  assert.ok(
    compared > options.minRays,
    `${label}: only ${compared} rays hit the model; the sweep proves little`,
  );
  assert.ok(
    edgeDisagreements / compared < 0.01,
    `${label}: ${edgeDisagreements} of ${compared} rays chose a different triangle; not an edge case`,
  );
  // Reported, then bounded. float32 packing is the floor on all four: positions
  // and normals are stored as float32 and the field with them, so a
  // disagreement at 1e-6 is the texture format rather than the model.
  console.log(
    `  ${label}: ${compared} rays (${edgeDisagreements} at a shared edge, ` +
      `${shadowedCount} self-shadowed): t ${worstT.toExponential(2)} m, ` +
      `normal ${worstNormal.toExponential(2)}, lon ${worstLon.toExponential(2)} deg, ` +
      `weight ${worstWeight.toExponential(2)}`,
  );
  assert.ok(worstT < 1e-5, `${label}: worst t ${worstT}`);
  assert.ok(worstNormal < 1e-5, `${label}: worst normal ${worstNormal}`);
  assert.ok(worstLon < 1e-3, `${label}: worst lon ${worstLon}`);
  assert.ok(worstWeight < 1e-5, `${label}: worst weight ${worstWeight}`);
  return { lit: litCount, shadowed: shadowedCount };
}

test('on a mesh the reference shades the same surface the simulator does', () => {
  const counts = compareShading(uvSphere(24, 12, 0.8636, true), 'tessellated sphere', {
    minRays: 200,
    shellM: 4,
  });
  assert.ok(counts.lit > 0, 'nothing was lit, so the blend was never compared');
  // Convex: it cannot get in its own way, which is exactly why the next test
  // exists.
  assert.equal(counts.shadowed, 0);
});

test('and it agrees about a surface that shadows itself, which a sphere never does', () => {
  // Mutation-checked: removing the shadow ray from `meshIlluminatedAt` leaves
  // the tessellated sphere above pixel-identical and fails this line.
  const counts = compareShading(twoPlates(), 'two plates', { minRays: 40, shellM: 3 });
  assert.ok(
    counts.shadowed > 20,
    `only ${counts.shadowed} samples were shadowed; the fixture must actually occlude itself`,
  );
});

test('a mesh with no unwrap reads the same content coordinate in both renderers', () => {
  // A mesh may legitimately carry no UV set: it can be traced, lit and measured,
  // it simply has no content. `MeshSurface.coordAt` answers (0, 0) for one.
  //
  // The shader has no null to read, so it reads whatever the packer wrote,
  // through `uvToCoord`. A zero comes back as latitude 90, longitude -180 -- the
  // north pole at the date line -- so the GPU painted the whole model with one
  // corner texel while the CPU painted it with another, and the parity check
  // would report a full-surface disagreement that looks like a traversal fault.
  const mesh = { ...uvSphere(12, 6, 0.8636, true), uvs: null };
  const surface = meshSurface(mesh);
  const bvh = buildBvh(mesh);
  const packed = packBvh(bvh, mesh);
  const u = { mesh: { ...packedUniforms(packed), centre: surface.centre, extentRadiusM: surface.extentRadiusM } } as unknown as Uniforms;

  for (let t = 0; t < packed.triangleCount; t += 5) {
    const sim = surface.coordAt({ x: 0, y: 0, z: 0 }, {
      triangle: bvh.order[t],
      a: mesh.indices[3 * bvh.order[t]],
      b: mesh.indices[3 * bvh.order[t] + 1],
      c: mesh.indices[3 * bvh.order[t] + 2],
      u: 0.25,
      v: 0.25,
    });
    const [latDeg, lonDeg] = bvhCoordAt(u, t, 0.25, 0.25);
    assert.ok(Math.abs(latDeg - sim.latDeg) < 1e-4, `lat ${latDeg} vs ${sim.latDeg}`);
    assert.ok(Math.abs(lonDeg - sim.lonDeg) < 1e-4, `lon ${lonDeg} vs ${sim.lonDeg}`);
  }
});

/** The packed arrays as the uniform block wants them. */
function packedUniforms(packed: ReturnType<typeof packBvh>) {
  return {
    nodes: packed.nodes,
    nodeWidth: packed.nodeWidth,
    triangles: packed.triangles,
    triangleWidth: packed.triangleWidth,
    nodeCount: packed.nodeCount,
    triangleCount: packed.triangleCount,
    field: packed.field,
    fieldWidth: packed.fieldWidth,
  };
}
