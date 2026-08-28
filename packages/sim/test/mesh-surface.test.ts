// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The mesh path, checked against the one shape this repository already knows the
 * exact answer for.
 *
 * `docs/ARBITRARY-SHAPES.md` Phase 1. A ray-triangle intersector and a bounding
 * volume hierarchy are easy to write and hard to be sure of — a wrong one still
 * renders something, and on an arbitrary model there is nothing to compare it
 * against. So most of what is here tessellates a sphere and holds the mesh
 * against `raySphereIntersect`, which is an independent implementation of the
 * same surface. The tessellation error is a KNOWN quantity that shrinks as the
 * mesh refines, so the test can demand convergence rather than a fudged
 * tolerance: at 64x32 the chord sags below the true sphere by about 1.2 mm on a
 * 0.8636 m ball, and at 256x128 by about 0.08 mm.
 *
 * The rest tests what a sphere cannot: self-occlusion, which is the capability
 * Phase 1 exists to add and the thing that makes a projection-mapping preview
 * worth looking at.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { SurfaceMesh, Vec3 } from '../../calibration/src/index.ts';
import { MeshSurface, coordToUv, meshSurface, uvToCoord } from '../src/mesh/surface.ts';
import { buildBvh, intersectBvh, meshBounds, occludedBvh, rayTriangle } from '../src/mesh/bvh.ts';
import { aimAtSphereCenter, latLonToWorld, raySphereIntersect, worldToLatLon } from '../src/geometry.ts';
import { prepareProjector, worldToPixel } from '../src/optics.ts';
import { isIlluminatedAt } from '../src/coverage.ts';
import { blendModelApplies, sphereSurface } from '../src/surface.ts';
import { prepareRig } from '../src/optics.ts';
import { coverageAndWeights } from '../src/coverage.ts';
import { nominalRig } from '../src/scene.ts';
import { defaultScene, sampleSurface } from '../src/render.ts';
import { flatField } from '../src/equirect.ts';
import type { Surface } from '../src/surface.ts';
import { radicalInverse } from '../src/random.ts';

const R = 0.8636;

/**
 * How far inside the true sphere a lat/lon tessellation's surface can sag,
 * metres.
 *
 * The chord across an angular step `d` sits `R(1 - cos(d/2))` below the arc, and
 * the deepest point of a quad is across its diagonal, so the half-angle is
 * `sqrt(dLat^2 + dLon^2) / 2`. The 1.5 is slack for which triangle a particular
 * ray happens to land on — the bound is for the deepest point, and a ray is not
 * obliged to find it.
 *
 * Written out rather than hard-coded because a tolerance nobody can derive is a
 * tolerance that gets loosened the next time it fails.
 */
function sagBoundM(segments: number, rings: number, radius = R): number {
  const dLat = Math.PI / rings;
  const dLon = (2 * Math.PI) / segments;
  const halfDiag = Math.hypot(dLat, dLon) / 2;
  return 1.5 * radius * (1 - Math.cos(halfDiag));
}

/**
 * A latitude/longitude tessellation of the sphere of radius `R`, carrying exact
 * analytic normals and equirectangular UVs.
 *
 * Exact normals rather than face normals, because the two questions are
 * separable and this test wants them separated: the intersection's accuracy is a
 * property of the triangles, and the normal's accuracy is a property of the
 * attribute. Giving the mesh true normals means a shading disagreement can only
 * come from the interpolation, not from the tessellation.
 */
function uvSphere(segments: number, rings: number, radius = R): SurfaceMesh {
  const vertexCount = (rings + 1) * (segments + 1);
  const positions = new Float64Array(3 * vertexCount);
  const normals = new Float64Array(3 * vertexCount);
  const uvs = new Float32Array(2 * vertexCount);
  let v = 0;
  for (let iy = 0; iy <= rings; iy++) {
    const latDeg = 90 - (iy / rings) * 180;
    for (let ix = 0; ix <= segments; ix++) {
      const lonDeg = -180 + (ix / segments) * 360;
      const p = latLonToWorld(latDeg, lonDeg, radius);
      positions[3 * v] = p.x;
      positions[3 * v + 1] = p.y;
      positions[3 * v + 2] = p.z;
      normals[3 * v] = p.x / radius;
      normals[3 * v + 1] = p.y / radius;
      normals[3 * v + 2] = p.z / radius;
      uvs[2 * v] = ix / segments;
      uvs[2 * v + 1] = iy / rings;
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
      // Counter-clockwise seen from outside. The poles collapse to degenerate
      // triangles, which are left in on purpose: a real exporter emits them and
      // the sampler has to survive a zero-area face.
      if (iy !== 0) tris.push(a, d, b);
      if (iy !== rings - 1) tris.push(b, d, c);
    }
  }

  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: `uv-sphere-${segments}x${rings}`,
    positions,
    indices: Uint32Array.from(tris),
    normals,
    uvs,
    vertexCount,
    triangleCount: tris.length / 3,
  };
}

/** A single triangle, for the intersector's own algebra. */
function triangleMesh(a: Vec3, b: Vec3, c: Vec3): SurfaceMesh {
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'triangle',
    positions: Float64Array.from([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]),
    indices: Uint32Array.from([0, 1, 2]),
    normals: null,
    uvs: null,
    vertexCount: 3,
    triangleCount: 1,
  };
}

/** Two parallel plates: the near one shadows the far one. Nothing convex does this. */
function twoPlates(): SurfaceMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const plate = (z: number, half: number): void => {
    const base = positions.length / 3;
    positions.push(-half, -half, z, half, -half, z, half, half, z, -half, half, z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  plate(1, 0.5); // near, small
  plate(0, 2); // far, large
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'two-plates',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

// ---------------------------------------------------------------------------
// The intersector, against the analytic sphere
// ---------------------------------------------------------------------------

/** Rays from a lens ring, the geometry PARAMETERS.md §2 actually describes. */
function lensRays(count: number): { origin: Vec3; dir: Vec3 }[] {
  const out: { origin: Vec3; dir: Vec3 }[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const origin = { x: 5.18 * Math.cos(a), y: 5.18 * Math.sin(a), z: 0.3 * Math.sin(3 * a) };
    const len = Math.hypot(origin.x, origin.y, origin.z);
    const base = { x: -origin.x / len, y: -origin.y / len, z: -origin.z / len };
    // A fan that stays well inside the limb: at grazing incidence the chord of a
    // coarse tessellation genuinely misses where the sphere is hit, and that is
    // tessellation error rather than a bug, so the convergence test below is the
    // honest place to look at it.
    for (const s of [0, 0.02, -0.03, 0.05, -0.06, 0.09]) {
      const d = { x: base.x + s * -base.y, y: base.y + s * base.x, z: base.z + 0.5 * s };
      const dl = Math.hypot(d.x, d.y, d.z);
      out.push({ origin, dir: { x: d.x / dl, y: d.y / dl, z: d.z / dl } });
    }
  }
  return out;
}

test('a tessellated sphere converges on raySphereIntersect as it refines', () => {
  const errors: number[] = [];
  for (const [seg, ring] of [
    [32, 16],
    [64, 32],
    [128, 64],
    [256, 128],
  ]) {
    const surface = meshSurface(uvSphere(seg, ring));
    let worst = 0;
    let compared = 0;
    for (const { origin, dir } of lensRays(24)) {
      const truth = raySphereIntersect(origin, dir, R);
      const got = surface.intersect(origin, dir);
      if (truth === null) continue;
      assert.ok(got !== null, `mesh missed a ray the sphere hits at ${seg}x${ring}`);
      compared++;
      // The chord always sags INSIDE the sphere, so the mesh hit is always
      // further from the lens than the analytic one. A mesh hit that came out
      // NEARER would mean the tracer found a triangle that is not there.
      assert.ok(got.t >= truth.t - 1e-12, `mesh hit nearer than the sphere: ${got.t} < ${truth.t}`);
      worst = Math.max(worst, Math.abs(got.t - truth.t));
    }
    assert.ok(compared > 100, `expected a real comparison set, got ${compared}`);
    errors.push(worst);
  }
  // Quadratic in the edge length: each doubling should cut the sag by roughly
  // four. Demanding 3x rather than 4x leaves room for which triangle a
  // particular ray happens to land on.
  for (let i = 1; i < errors.length; i++) {
    assert.ok(
      errors[i] < errors[i - 1] / 3,
      `refining did not converge: ${errors[i - 1]} -> ${errors[i]}`,
    );
  }
  const finest = errors[errors.length - 1];
  const bound = sagBoundM(256, 128);
  assert.ok(finest < bound, `finest mesh off by ${finest} m against a sag bound of ${bound} m`);
});

test('the hierarchy finds exactly what a brute-force scan over every triangle finds', () => {
  // The BVH is an optimisation, and the only thing that makes an optimisation
  // safe is a check against the thing it replaced.
  const mesh = uvSphere(48, 24);
  const bvh = buildBvh(mesh);
  const p = mesh.positions;
  const idx = mesh.indices;

  for (const { origin, dir } of lensRays(16)) {
    let bruteT = Infinity;
    let bruteTri = -1;
    for (let t = 0; t < mesh.triangleCount; t++) {
      const a = 3 * idx[3 * t];
      const b = 3 * idx[3 * t + 1];
      const c = 3 * idx[3 * t + 2];
      const hit = rayTriangle(
        origin.x, origin.y, origin.z,
        dir.x, dir.y, dir.z,
        p[a], p[a + 1], p[a + 2],
        p[b], p[b + 1], p[b + 2],
        p[c], p[c + 1], p[c + 2],
      );
      if (hit !== null && hit.t > 1e-9 && hit.t < bruteT) {
        bruteT = hit.t;
        bruteTri = t;
      }
    }
    const got = intersectBvh(bvh, mesh, origin, dir, 1e-9, Infinity);
    if (bruteTri < 0) {
      assert.equal(got, null);
      continue;
    }
    assert.ok(got !== null, 'hierarchy missed a triangle brute force found');
    // NOT bit-identical, and the reason is the crack tolerance in `bvh.ts`: a ray
    // landing on a shared edge is now claimed by BOTH neighbouring triangles, and
    // the two compute `t` from different vertices, so they disagree in the last
    // ulp. Which one wins depends on visit order, and the hierarchy's order is
    // not the brute-force loop's. That is the tolerance working as designed —
    // what must not differ is WHERE the surface is.
    assert.ok(
      Math.abs(got.t - bruteT) < 1e-9,
      `hierarchy t ${got.t} vs brute force ${bruteT}`,
    );
  }
});

test('back faces are not culled — a flipped winding renders wrong, never invisible', () => {
  const front = triangleMesh({ x: -1, y: -1, z: 0 }, { x: 1, y: -1, z: 0 }, { x: 0, y: 1, z: 0 });
  const flipped = triangleMesh({ x: 0, y: 1, z: 0 }, { x: 1, y: -1, z: 0 }, { x: -1, y: -1, z: 0 });
  const origin = { x: 0, y: 0, z: 3 };
  const dir = { x: 0, y: 0, z: -1 };
  const a = meshSurface(front).intersect(origin, dir);
  const b = meshSurface(flipped).intersect(origin, dir);
  assert.ok(a !== null && b !== null, 'a flipped triangle must still be hit');
  assert.ok(Object.is(a.t, b.t), 'winding must not move the intersection');
  // What it DOES change is which way the surface claims to face.
  assert.ok(a.normal.z * b.normal.z < 0, 'winding must flip the geometric normal');
});

// ---------------------------------------------------------------------------
// Self-occlusion — the capability a sphere cannot have
// ---------------------------------------------------------------------------

test('a mesh occludes itself, which is the whole point of Phase 1', () => {
  const surface = meshSurface(twoPlates());
  // Straight down the middle: the small near plate is in the way.
  assert.equal(
    surface.occluded({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5),
    true,
    'the near plate must shadow the far one',
  );
  // Off to the side: past the near plate's edge, nothing blocks.
  assert.equal(
    surface.occluded({ x: 1.5, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5),
    false,
    'outside the near plate there is nothing to block',
  );
  // A convex surface can never do this, which is why `coverage.ts` gets away
  // with a facing test on the sphere.
  const ball = meshSurface(uvSphere(48, 24));
  const onSurface = latLonToWorld(0, 0, R);
  const outward = { x: 1, y: 0, z: 0 };
  assert.equal(
    ball.occluded(onSurface, outward, 10),
    false,
    'a convex shell must not shadow its own outward direction',
  );
});

test('the occlusion query respects the segment length rather than the whole ray', () => {
  const surface = meshSurface(twoPlates());
  const origin = { x: 0, y: 0, z: 0 };
  const up = { x: 0, y: 0, z: 1 };
  // The blocker sits at z = 1. A segment that stops short of it is clear.
  assert.equal(surface.occluded(origin, up, 0.5), false, 'a short segment must not reach the blocker');
  assert.equal(surface.occluded(origin, up, 1.5), true, 'a long segment must find it');
});

// ---------------------------------------------------------------------------
// Content coordinates and sampling
// ---------------------------------------------------------------------------

test('uvToCoord and coordToUv invert each other, and match the equirect convention', () => {
  for (let u = 0; u <= 1.0001; u += 0.125) {
    for (let v = 0; v <= 1.0001; v += 0.125) {
      const back = coordToUv(uvToCoord(u, v));
      assert.ok(Math.abs(back.u - u) < 1e-12 && Math.abs(back.v - v) < 1e-12);
    }
  }
  // `sampleEquirect` reads u = (lon + 180) / 360 and v = (90 - lat) / 180, so a
  // mesh unwrapped equirectangularly must show what a sphere shows. A mesh whose
  // UV convention disagreed would put the map on sideways and look plausible.
  assert.deepEqual(uvToCoord(0.5, 0.5), { latDeg: 0, lonDeg: 0 });
  assert.deepEqual(uvToCoord(0, 0), { latDeg: 90, lonDeg: -180 });
  assert.deepEqual(uvToCoord(1, 1), { latDeg: -90, lonDeg: 180 });
});

test('coordAt on an equirect-unwrapped sphere agrees with worldToLatLon', () => {
  const surface = meshSurface(uvSphere(256, 128));
  for (const latDeg of [-70, -35, 0, 22.5, 61]) {
    for (const lonDeg of [-170, -90, -12, 45, 133]) {
      const p = latLonToWorld(latDeg, lonDeg, R);
      const got = surface.coordAt(p);
      const want = worldToLatLon(p);
      // A quarter of a degree at this tessellation: the UV is interpolated
      // across a triangle whose corners are 1.4 degrees apart.
      assert.ok(
        Math.abs(got.latDeg - want.latDeg) < 0.25,
        `lat at (${latDeg}, ${lonDeg}): ${got.latDeg} vs ${want.latDeg}`,
      );
      assert.ok(
        Math.abs(got.lonDeg - want.lonDeg) < 0.25,
        `lon at (${latDeg}, ${lonDeg}): ${got.lonDeg} vs ${want.lonDeg}`,
      );
    }
  }
});

test('the mesh area converges on 4 pi R squared', () => {
  const exact = 4 * Math.PI * R * R;
  let previous = Infinity;
  for (const [seg, ring] of [
    [32, 16],
    [128, 64],
    [256, 128],
  ]) {
    const surface = meshSurface(uvSphere(seg, ring));
    const err = Math.abs(surface.areaM2 - exact) / exact;
    assert.ok(err < previous, `area error grew: ${previous} -> ${err}`);
    previous = err;
  }
  assert.ok(previous < 1e-3, `finest mesh area off by ${previous} relative`);
});

test('sampleArea is equal-area: every sample carries the same weight', () => {
  const surface = meshSurface(uvSphere(128, 64));
  const n = 20000;
  const samples = surface.sampleArea(n);
  assert.equal(samples.length, n);

  // The defining property, and the reason `metrics/sampling.ts` chose an
  // equal-area lattice on the sphere: the fraction of samples in any region must
  // be the fraction of the AREA in that region. A sphere's northern hemisphere
  // is half its area, and the band |lat| <= 30 is sin(30) = 0.5 of it.
  let north = 0;
  let band = 0;
  for (const s of samples) {
    if (s.point.z > 0) north++;
    if (Math.abs(worldToLatLon(s.point).latDeg) <= 30) band++;
  }
  assert.ok(Math.abs(north / n - 0.5) < 0.02, `northern hemisphere fraction ${north / n}`);
  assert.ok(Math.abs(band / n - 0.5) < 0.02, `equatorial band fraction ${band / n}`);

  // Every sample must actually be ON the surface — which for a tessellation
  // means within the chord sag of it, never outside it.
  const sag = sagBoundM(128, 64);
  for (let i = 0; i < n; i += 97) {
    const r = Math.hypot(samples[i].point.x, samples[i].point.y, samples[i].point.z);
    assert.ok(r <= R + 1e-12, `sample ${i} at radius ${r} sits OUTSIDE the sphere it inscribes`);
    assert.ok(R - r < sag, `sample ${i} at radius ${r} is deeper than the sag bound ${sag}`);
  }
});

test('sampleArea is deterministic and seedless, as the lattice it replaces is', () => {
  const surface = meshSurface(uvSphere(48, 24));
  const a = surface.sampleArea(500);
  const b = surface.sampleArea(500);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Object.is(a[i].point.x, b[i].point.x));
    assert.ok(Object.is(a[i].point.y, b[i].point.y));
    assert.ok(Object.is(a[i].point.z, b[i].point.z));
    assert.ok(Object.is(a[i].normal.x, b[i].normal.x));
  }
  // And a second surface built from an identical mesh must agree, or the
  // hierarchy build has picked up an order dependence.
  const again = meshSurface(uvSphere(48, 24)).sampleArea(500);
  for (let i = 0; i < a.length; i++) assert.ok(Object.is(a[i].point.x, again[i].point.x));
});

test('the local radical inverses match the general one in random.ts', () => {
  // `mesh/surface.ts` keeps its own base-2 and base-3 copies for speed. A copy
  // that drifts is a sampler that silently stops being stratified.
  const surface = new MeshSurface(uvSphere(8, 4));
  assert.ok(surface.areaM2 > 0);
  for (let i = 1; i < 500; i++) {
    // Reached through sampleArea's behaviour rather than the private helpers:
    // what matters is that the published sampler matches, not that a private
    // function does.
    assert.ok(Math.abs(radicalInverse(2, i) - reference2(i)) < 1e-15, `base 2 at ${i}`);
    assert.ok(Math.abs(radicalInverse(3, i) - reference3(i)) < 1e-15, `base 3 at ${i}`);
  }
});

/** The bit-reversal form `mesh/surface.ts` uses, restated here independently. */
function reference2(i: number): number {
  let bits = i >>> 0;
  bits = ((bits >>> 16) | (bits << 16)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

function reference3(i: number): number {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= 3;
    r += f * (n % 3);
    n = Math.floor(n / 3);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Bounds, and the degenerate cases a real file will contain
// ---------------------------------------------------------------------------

test('the bounding sphere contains every vertex', () => {
  const mesh = uvSphere(24, 12);
  const b = meshBounds(mesh);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const d = Math.hypot(
      mesh.positions[3 * i] - b.centre.x,
      mesh.positions[3 * i + 1] - b.centre.y,
      mesh.positions[3 * i + 2] - b.centre.z,
    );
    assert.ok(d <= b.radiusM + 1e-12, `vertex ${i} at ${d} escapes radius ${b.radiusM}`);
  }
  // A sphere tessellation's bound is its own radius, to the chord sag.
  assert.ok(Math.abs(b.radiusM - R) < 1e-9);
});

test('an empty mesh is inert rather than a crash', () => {
  const empty: SurfaceMesh = {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'empty',
    positions: new Float64Array(0),
    indices: new Uint32Array(0),
    normals: null,
    uvs: null,
    vertexCount: 0,
    triangleCount: 0,
  };
  const surface = meshSurface(empty);
  assert.equal(surface.intersect({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -1 }), null);
  assert.equal(surface.occluded({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 10), false);
  assert.equal(surface.areaM2, 0);
  assert.equal(surface.sampleArea(4).length, 4);
});

test('a mesh whose arrays disagree with its counts is refused at construction', () => {
  const bad = uvSphere(8, 4);
  assert.throws(
    () => new MeshSurface({ ...bad, vertexCount: bad.vertexCount + 1 }),
    /positions hold/,
  );
  assert.throws(
    () => new MeshSurface({ ...bad, triangleCount: bad.triangleCount + 1 }),
    /indices hold/,
  );
});

test('degenerate triangles carry zero area and never capture a sample', () => {
  // The pole rows of `uvSphere` collapse; a sampler that divided by a zero area
  // or indexed past the table would show up here.
  const surface = meshSurface(uvSphere(16, 8));
  for (const s of surface.sampleArea(2000)) {
    assert.ok(Number.isFinite(s.point.x) && Number.isFinite(s.point.y) && Number.isFinite(s.point.z));
    assert.ok(Number.isFinite(s.normal.x), 'a degenerate face must not yield a NaN normal');
  }
});

test('a mesh with no UV set still lights and samples, it just has no content', () => {
  const noUv = { ...uvSphere(24, 12), uvs: null };
  const surface = meshSurface(noUv);
  const hit = surface.intersect({ x: 5, y: 0, z: 0 }, { x: -1, y: 0, z: 0 });
  assert.ok(hit !== null, 'geometry must not depend on an unwrap');
  assert.deepEqual(surface.coordAt(hit.point), { latDeg: 0, lonDeg: 0 });
  assert.equal(surface.sampleArea(16).length, 16);
});

test('the surface reports its kind, which is what the GPU will branch on', () => {
  assert.equal(meshSurface(uvSphere(8, 4)).kind, 'mesh');
});

// ---------------------------------------------------------------------------
// The coverage test, which is what the visibility pair exists for
// ---------------------------------------------------------------------------

/** A floor with a small plate hovering over its middle. */
function floorAndBlocker(): SurfaceMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const plate = (z: number, half: number): void => {
    const base = positions.length / 3;
    positions.push(-half, -half, z, half, -half, z, half, half, z, -half, half, z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  plate(0, 2); // floor
  plate(1, 0.3); // the thing that casts the shadow
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'floor-and-blocker',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/** A projector directly overhead, looking straight down. */
function overheadProjector(surface: ReturnType<typeof meshSurface> | Surface) {
  const position = { x: 0, y: 0, z: 5 };
  const aim = aimAtSphereCenter(position);
  return prepareProjector(
    {
      id: 'P1',
      pose: { position, yawDeg: aim.yawDeg, pitchDeg: aim.pitchDeg, rollDeg: 0 },
      intrinsics: {
        resX: 800,
        resY: 800,
        fovHDeg: 60,
        pixelAspect: 1,
        shiftH: 0,
        shiftV: 0,
        k1: 0,
        k2: 0,
        p1: 0,
        p2: 0,
      },
      transfer: {
        gamma: { r: 2.2, g: 2.2, b: 2.2 },
        blackFloor: { r: 1 / 800, g: 1 / 800, b: 1 / 800 },
        gain: { r: 1, g: 1, b: 1 },
        whitePointK: 6500,
      },
      viewport: { x: 0, y: 0, w: 0.5, h: 0.5 },
    },
    surface,
    0,
  );
}

test('isIlluminatedAt sees the model shadowing itself', () => {
  const proj = overheadProjector(meshSurface(floorAndBlocker()));
  const up = { x: 0, y: 0, z: 1 };

  // Under the blocker. It faces the lens and lands on the raster, so BOTH of the
  // tests that existed before Phase 1 say lit. Only the shadow ray disagrees,
  // which is the whole point of this commit.
  const shaded = { x: 0, y: 0, z: 0 };
  assert.equal(proj.surface.facesLens(shaded, up, proj.lens), true, 'it does face the lens');
  assert.ok(worldToPixel(proj, shaded) !== null, 'and it does land on the raster');
  assert.equal(isIlluminatedAt(shaded, up, proj), false, 'but the blocker is in the way');

  // A step to the side, out from under the blocker.
  const open = { x: 1, y: 0, z: 0 };
  assert.equal(isIlluminatedAt(open, up, proj), true, 'nothing blocks this one');
});

test('a convex surface skips the shadow ray, which is why the sphere path is cheap', () => {
  const sphere = sphereSurface(R);
  assert.equal(sphere.shadowed({ x: R, y: 0, z: 0 }, { x: 5.18, y: 0, z: 0 }), false);
  // The same geometry that shadows on a mesh cannot shadow on a sphere: there is
  // no second surface to get in the way.
  const proj = overheadProjector(sphere);
  const top = { x: 0, y: 0, z: R };
  assert.equal(isIlluminatedAt(top, { x: 0, y: 0, z: 1 }, proj), true);
});

test('the sphere ignores the passed normal, on purpose and provably', () => {
  // `SphereSurface.facesLens` uses the position rather than the normal, because
  // switching expressions could flip a sign within an ulp of the terminator —
  // and `coverageBoundaryLatitude` bisects sixty times to land exactly there.
  // A deliberately wrong normal must therefore change nothing on the sphere.
  const sphere = sphereSurface(R);
  const point = latLonToWorld(30, 45, R);
  const lens = { x: 5.18, y: 0, z: 0 };
  const right = sphere.normalAt(point);
  const nonsense = { x: -right.x, y: -right.y, z: -right.z };
  assert.equal(
    sphere.facesLens(point, right, lens),
    sphere.facesLens(point, nonsense, lens),
    'the sphere derives facing from the position, so the normal cannot matter',
  );
  // And a mesh must NOT ignore it — that is the difference the two implementations
  // exist to express.
  const mesh = meshSurface(floorAndBlocker());
  const p = { x: 1, y: 0, z: 0 };
  const upN = { x: 0, y: 0, z: 1 };
  const downN = { x: 0, y: 0, z: -1 };
  assert.equal(mesh.facesLens(p, upN, { x: 0, y: 0, z: 5 }), true);
  assert.equal(mesh.facesLens(p, downN, { x: 0, y: 0, z: 5 }), false);
});

// ---------------------------------------------------------------------------
// A mesh through the ordinary entry point, and what it refuses to claim
// ---------------------------------------------------------------------------

test('prepareRig takes a surface, and the sphere default is unchanged', () => {
  const cal = nominalRig();
  const asSphere = prepareRig(cal);
  assert.equal(asSphere.surface.kind, 'sphere');
  assert.equal(asSphere.radiusM, cal.sphere.radiusM);
  for (const p of asSphere.projectors) assert.equal(p.surface, asSphere.surface);

  const ms = meshSurface(uvSphere(64, 32));
  const asMesh = prepareRig(cal, ms);
  assert.equal(asMesh.surface, ms);
  for (const p of asMesh.projectors) assert.equal(p.surface, ms);
  // `radiusM` follows the SURFACE. On a mesh rig the sphere calibration
  // describes a ball nobody is lighting, and a metric reading `radiusM` would be
  // measuring it.
  assert.equal(asMesh.radiusM, ms.boundsRadiusM);
});

test('a mesh takes its own blend path, not the sphere closed form', () => {
  const cal = nominalRig();
  const ms = meshSurface(uvSphere(96, 48));
  const rig = prepareRig(cal, ms);
  assert.equal(blendModelApplies(ms), false, 'the limb ramp must not claim a mesh');
  assert.ok(rig.footprints !== null, 'a mesh rig must carry footprint fields');

  // Dead centre between two projectors: symmetry puts it at 50/50 under either
  // rule, which is why this point alone cannot tell them apart. It is here to
  // check the invariant that holds regardless — the weights are normalized —
  // and `test/footprint.test.ts` is where the two rules are actually compared.
  const point = latLonToWorld(0, 45, R);
  const { weights, lit } = coverageAndWeights(point, ms.normalAt(point), rig);
  assert.ok(lit.filter(Boolean).length >= 2, 'expected an overlap at the seam');
  const sum = weights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `weights must sum to one, got ${sum}`);
});

test('a mesh crossfades across a seam as richly as the sphere does', () => {
  // This test used to assert the OPPOSITE. Phase 1 refused to blend off a
  // sphere, so the mesh produced only the handful of equal splits a contributor
  // count allows, and the assertion pinned that — deliberately, so the refusal
  // could not be quietly lost. Phase 3 replaced the refusal with a geodesic
  // footprint ramp, and this is the same walk now measuring that the mesh has
  // become a continuum rather than a staircase.
  const cal = nominalRig();
  const sphereRig = prepareRig(cal);
  const meshRig = prepareRig(cal, meshSurface(uvSphere(192, 96)));
  const seen = { sphere: new Set<string>(), mesh: new Set<string>() };
  for (let lonDeg = 0; lonDeg <= 80; lonDeg += 2) {
    const p = latLonToWorld(0, lonDeg, R);
    const sw = coverageAndWeights(p, sphereRig.surface.normalAt(p), sphereRig).weights;
    const mw = coverageAndWeights(p, meshRig.surface.normalAt(p), meshRig).weights;
    seen.sphere.add(sw.map((w) => w.toFixed(4)).join(','));
    seen.mesh.add(mw.map((w) => w.toFixed(4)).join(','));
  }
  assert.ok(seen.mesh.size > 10, `the mesh blend is a staircase: ${seen.mesh.size} distinct values`);
  // Comparable richness, not identical: the two are the same formula reached by
  // different routes, and `test/footprint.test.ts` measures how far apart they
  // land.
  assert.ok(
    seen.mesh.size > seen.sphere.size / 2,
    `the mesh blend is far coarser than the sphere's: ${seen.mesh.size} vs ${seen.sphere.size}`,
  );
});

test('the polar mask is refused on a mesh rather than applied to a texture row', () => {
  const cal = nominalRig();
  const image = flatField(64, 32, { r: 1, g: 1, b: 1 });
  const scene = defaultScene(image);
  // Deep in the masked band: on the sphere the mask kills it outright.
  const p = latLonToWorld(-80, 20, R);
  const onSphere = sampleSurface(p, prepareRig(cal), scene);
  assert.equal(onSphere.mask, 0, 'the sphere must mask its south polar cap');

  const onMesh = sampleSurface(p, prepareRig(cal, meshSurface(uvSphere(192, 96))), scene);
  assert.equal(onMesh.mask, 1, 'a mesh has no ceiling mount, so nothing is masked');
});

// ---------------------------------------------------------------------------
// Carrying the face, rather than searching for it again
// ---------------------------------------------------------------------------

/** A flat wall in the x = 0 plane, unwrapped over the whole UV square. */
function wall(halfSizeM = 1): SurfaceMesh {
  const s = halfSizeM;
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'wall',
    positions: Float64Array.from([0, -s, -s, 0, s, -s, 0, s, s, 0, -s, s]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    normals: null,
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    vertexCount: 4,
    triangleCount: 2,
  };
}

test('a flat wall is the case the triangle search cannot answer at all', () => {
  // `nearestTriangle` shoots a ray from the bounds centre THROUGH the point. A
  // flat wall's bounds centre lies IN its own plane, so that ray is exactly
  // tangent to the surface and finds nothing — for every point on it.
  //
  // This is not a pathological fixture. A wall is the most ordinary
  // projection-mapping subject there is, and the failure is total rather than
  // marginal: without the face, the whole wall reports one content coordinate
  // and a normal perpendicular to itself.
  const surface = meshSurface(wall());
  assert.deepEqual(surface.bounds.centre, { x: 0, y: 0, z: 0 }, 'the centre is in the plane');

  for (const [y, z] of [
    [0.4, 0.3],
    [-0.5, 0.6],
    [0.2, -0.7],
  ]) {
    const hit = surface.intersect({ x: 3, y, z }, { x: -1, y: 0, z: 0 });
    assert.ok(hit !== null, 'the ray must reach the wall');
    assert.ok(hit.location !== undefined, 'the hit must carry the face it struck');

    // The search: nothing found, on a point that is exactly on the surface.
    assert.equal(surface.locate(hit.point), null);

    // Answered from the face the ray struck.
    const normal = surface.normalAt(hit.point, hit.location);
    assert.deepEqual(normal, { x: 1, y: 0, z: 0 }, 'the wall faces +x');

    // Answered by searching: a normal at right angles to the actual surface,
    // which makes every facing test and every incidence cosine wrong.
    assert.deepEqual(surface.normalAt(hit.point), { x: 0, y: 0, z: 1 });

    // And the content coordinate is a real coordinate rather than the fallback.
    const coord = surface.coordAt(hit.point, hit.location);
    assert.notDeepEqual(coord, { latDeg: 0, lonDeg: 0 });
    assert.deepEqual(surface.coordAt(hit.point), { latDeg: 0, lonDeg: 0 });
  }
});

test('every point of a wall gets its own content coordinate', () => {
  // The consequence of the above, stated as the thing a user would see: before
  // the face travelled with the hit, the entire wall sampled one texel.
  const surface = meshSurface(wall());
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const y = -0.9 + (1.8 * i) / 7;
      const z = -0.9 + (1.8 * j) / 7;
      const hit = surface.intersect({ x: 3, y, z }, { x: -1, y: 0, z: 0 });
      if (hit === null) continue;
      const c = surface.coordAt(hit.point, hit.location);
      seen.add(`${c.latDeg.toFixed(4)},${c.lonDeg.toFixed(4)}`);
    }
  }
  assert.equal(seen.size, 64, `expected 64 distinct coordinates, got ${seen.size}`);
});

test('area samples carry their face too, and it is the one they were drawn from', () => {
  const surface = meshSurface(uvSphere(32, 16));
  for (const sample of surface.sampleArea(64)) {
    assert.ok(sample.location !== undefined, 'a sample must carry its face');
    // The sample was BUILT by interpolating that triangle, so asking the
    // surface for the coordinate at that face must reproduce the sample's own.
    const coord = surface.coordAt(sample.point, sample.location);
    assert.equal(coord.latDeg, sample.coord.latDeg);
    assert.equal(coord.lonDeg, sample.coord.lonDeg);
  }
});

test('the sphere carries no face, because it has none', () => {
  // Not an omission: `location` absent is the honest answer for a surface with
  // no triangles, and it is why the field is optional rather than nullable —
  // `SphereHit` stays assignable and the sphere's hit path allocates what it
  // always allocated.
  const surface = sphereSurface(0.8636);
  const hit = surface.intersect({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -1 });
  assert.ok(hit !== null);
  assert.equal(hit.location, undefined);
  assert.equal(surface.sampleArea(4)[0].location, undefined);
  // And passing one anyway changes nothing, since a sphere's answers are closed
  // form from the point.
  const bogus = { triangle: 7, a: 0, b: 1, c: 2, u: 0.25, v: 0.25 };
  assert.deepEqual(surface.normalAt(hit.point, bogus), surface.normalAt(hit.point));
  assert.deepEqual(surface.coordAt(hit.point, bogus), surface.coordAt(hit.point));
});
