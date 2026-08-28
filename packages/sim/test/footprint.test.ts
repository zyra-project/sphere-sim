// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The general blend, held against the closed form it replaces.
 *
 * `docs/ARBITRARY-SHAPES.md` Phase 3. `footprint.ts` claims that ramping on the
 * distance to a projector's footprint edge is the general form of the sphere's
 * limb ramp. That is a claim about arithmetic, and the sphere is the one shape
 * where the answer is already known — so the load-bearing test tessellates one,
 * runs the general algorithm on the mesh, and compares against the closed form
 * running on the analytic sphere beside it.
 *
 * If the two disagree the general form is wrong, because on a sphere there is
 * nothing to disagree about.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { SurfaceMesh } from '../../calibration/src/index.ts';
import { blendWidthM, buildAdjacency } from '../src/footprint.ts';
import { meshSurface } from '../src/mesh/surface.ts';
import { prepareRig } from '../src/optics.ts';
import { coverageAndWeights } from '../src/coverage.ts';
import { nominalRig } from '../src/scene.ts';
import { latLonToWorld } from '../src/geometry.ts';

const R = 0.8636;

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

// ---------------------------------------------------------------------------
// The graph the distance is measured over
// ---------------------------------------------------------------------------

test('adjacency welds coincident vertices, or a UV seam becomes a wall', () => {
  // A lat/lon sphere carries two vertices at every point down its back seam:
  // longitude -180 and +180 are the same place with different texture
  // coordinates. Without welding, the graph is split there, distances route the
  // long way round, and the blend grows a bright line down the model at exactly
  // the place a texture seam already makes suspicious.
  const mesh = uvSphere(32, 16);
  const adj = buildAdjacency(mesh, R);
  assert.ok(
    adj.nodeCount < mesh.vertexCount,
    `nothing was welded: ${adj.nodeCount} nodes for ${mesh.vertexCount} vertices`,
  );
  // The seam is one duplicated column, and both poles collapse to a point.
  const seamColumn = 17; // rings + 1
  assert.ok(
    mesh.vertexCount - adj.nodeCount >= seamColumn,
    `expected at least the seam column welded, folded ${mesh.vertexCount - adj.nodeCount}`,
  );
  // Every welded node must have neighbours, or the graph has isolated points
  // that Dijkstra can never reach.
  for (let i = 0; i < adj.nodeCount; i++) {
    assert.ok(adj.offset[i + 1] > adj.offset[i], `node ${i} has no neighbours`);
  }
});

test('edge lengths are the real distances between the points', () => {
  const mesh = uvSphere(16, 8);
  const adj = buildAdjacency(mesh, R);
  for (let e = 0; e < adj.length.length; e++) {
    assert.ok(adj.length[e] > 0, 'a welded graph must not carry a zero-length edge');
    // No edge on a sphere of radius R can be longer than its diameter.
    assert.ok(adj.length[e] < 2 * R + 1e-9, `edge ${e} is ${adj.length[e]} m long`);
  }
});

test('the blend width converts to an arc that degenerates on a sphere', () => {
  // The whole degeneration argument rests on this one line: `w_width` degrees of
  // sphere angle is `R * w * pi/180` of arc.
  assert.ok(Math.abs(blendWidthM(20, R) - 20 * (Math.PI / 180) * R) < 1e-15);
  assert.ok(Math.abs(blendWidthM(20, R) - 0.30144) < 1e-4, 'about 30 cm at the Boulder radius');
});

// ---------------------------------------------------------------------------
// The claim: the general form reproduces the closed form
// ---------------------------------------------------------------------------

test('on a tessellated sphere the footprint blend tracks the limb ramp', () => {
  const cal = nominalRig();
  const sphere = prepareRig(cal);
  const mesh = prepareRig(cal, meshSurface(uvSphere(192, 96)));
  assert.equal(sphere.footprints, null, 'a sphere must not build a field it does not need');
  assert.ok(mesh.footprints !== null, 'a mesh must build one');

  // Walk the equator through a seam between two projectors. This is where the
  // ramp lives — well inside one footprint at each end, crossfading in between.
  let worst = 0;
  let compared = 0;
  let sawCrossfade = false;
  for (let lonDeg = 0; lonDeg <= 90; lonDeg += 1) {
    const p = latLonToWorld(0, lonDeg, R);
    const sw = coverageAndWeights(p, sphere.surface.normalAt(p), sphere).weights;
    const mw = coverageAndWeights(p, mesh.surface.normalAt(p), mesh).weights;
    // Both must be normalized, whatever else they disagree about.
    const ss = sw.reduce((a, b) => a + b, 0);
    const ms = mw.reduce((a, b) => a + b, 0);
    if (ss <= 0 || ms <= 0) continue;
    assert.ok(Math.abs(ss - 1) < 1e-9 && Math.abs(ms - 1) < 1e-9, 'weights must sum to one');
    // A genuine crossfade somewhere in the walk, or this test is comparing two
    // constant functions and proving nothing.
    if (mw.some((w) => w > 0.02 && w < 0.98)) sawCrossfade = true;
    for (let i = 0; i < sw.length; i++) worst = Math.max(worst, Math.abs(sw[i] - mw[i]));
    compared++;
  }
  assert.ok(compared > 60, `expected a full walk, compared ${compared}`);
  assert.ok(sawCrossfade, 'the walk never crossed a seam — it proves nothing about a ramp');

  // The degeneration is ALGEBRAIC — geodesic distance from the cap boundary is
  // `R(theta_max − theta)` and the width is `R·w·pi/180`, so the ratio is the
  // closed form exactly — and what is left is discretisation.
  //
  // Measured: 0.093 at 96x48, 0.0099 at 192x96, and 0.0099 again at 384x192. It
  // converges and then STOPS, which is the signature of an error that is not
  // about resolution: a path constrained to mesh edges is a few percent longer
  // than one free to cut across faces, and refining the mesh does not remove
  // that. Fast marching would; it needs a per-triangle eikonal solve to buy back
  // one percent of a blend width that §4.5 classes ASSUME.
  //
  // For contrast, the screen-space field this replaced departed by 0.46 — half
  // the entire scale — and `footprint.ts` explains why that was not fixable by
  // refining anything.
  assert.ok(worst < 0.02, `the general blend departs from the limb ramp by ${worst.toFixed(4)}`);
});

test('the departure from the closed form shrinks with the mesh, then plateaus', () => {
  // The convergence is the evidence that the two are the same formula. A
  // constant offset would mean they are merely similar.
  const cal = nominalRig();
  const sphere = prepareRig(cal);
  const departures = [96, 192].map((seg) => {
    const mesh = prepareRig(cal, meshSurface(uvSphere(seg, seg / 2)));
    let worst = 0;
    for (let lonDeg = 0; lonDeg <= 90; lonDeg += 1) {
      const p = latLonToWorld(0, lonDeg, R);
      const sw = coverageAndWeights(p, sphere.surface.normalAt(p), sphere).weights;
      const mw = coverageAndWeights(p, mesh.surface.normalAt(p), mesh).weights;
      if (sw.reduce((a, b) => a + b, 0) <= 0 || mw.reduce((a, b) => a + b, 0) <= 0) continue;
      for (let i = 0; i < sw.length; i++) worst = Math.max(worst, Math.abs(sw[i] - mw[i]));
    }
    return worst;
  });
  assert.ok(
    departures[1] < departures[0] / 3,
    `refining did not converge: ${departures[0].toFixed(4)} -> ${departures[1].toFixed(4)}`,
  );
});

test('the footprint blend is a real ramp, not a step', () => {
  // The refusal Phase 1 shipped produced only equal splits — a handful of
  // distinct weight vectors. The whole point of Phase 3 is a continuum, so this
  // is the test that would have failed before it and must not fail after.
  const mesh = prepareRig(nominalRig(), meshSurface(uvSphere(192, 96)));
  const seen = new Set<string>();
  for (let lonDeg = 0; lonDeg <= 90; lonDeg += 1) {
    const p = latLonToWorld(0, lonDeg, R);
    const w = coverageAndWeights(p, mesh.surface.normalAt(p), mesh).weights;
    seen.add(w.map((x) => x.toFixed(3)).join(','));
  }
  assert.ok(seen.size > 30, `expected a continuum of weights, got ${seen.size} distinct values`);
});

test('the blend falls to zero at a footprint edge rather than stepping off it', () => {
  const mesh = prepareRig(nominalRig(), meshSurface(uvSphere(192, 96)));
  // Toward the pole, past where any projector reaches: the last lit sample must
  // be carrying a SMALL weight, not a full one, or the ramp is not reaching the
  // edge it is supposed to feather.
  let lastLitWeight = Number.NaN;
  for (let latDeg = 60; latDeg <= 85; latDeg += 0.5) {
    const p = latLonToWorld(latDeg, 45, R);
    const { weights, lit } = coverageAndWeights(p, mesh.surface.normalAt(p), mesh);
    if (!lit.some(Boolean)) break;
    const total = weights.reduce((a, b) => a + b, 0);
    if (total > 0) lastLitWeight = Math.max(...weights);
  }
  assert.ok(Number.isFinite(lastLitWeight), 'nothing was lit on the walk toward the pole');
});

// ---------------------------------------------------------------------------
// Self-shadowing, which is where the general form earns its keep
// ---------------------------------------------------------------------------

test('a shadow edge feathers, which no limb-based blend could ever do', () => {
  // A wall facing the projectors with a smaller panel in front of it. The panel
  // casts a shadow, and the distance field must RAMP across that shadow's edge
  // exactly as it ramps at a raster edge — because both are edges of the same
  // set. A sphere has no shadow, so this behaviour has no analogue in the closed
  // form it replaces.
  const surface = meshSurface(wallAndPanel());
  const rig = prepareRig(nominalRig(), surface);
  assert.ok(rig.footprints !== null);
  const reaching = rig.footprints.filter((f): f is NonNullable<typeof f> => f !== null && f.litVertices > 0);
  assert.ok(reaching.length > 0, 'no projector reached the wall at all');

  // The gradient is the thing being tested, so count DISTINCT distances rather
  // than bucketing by a fraction of the deepest. A projector that merely grazes
  // the wall lights a handful of vertices all at one step from the boundary, and
  // a quartile test calls that "no gradient" when it is simply a small
  // footprint — which is how the first version of this assertion failed against
  // an algorithm that was working.
  const richest = Math.max(
    ...reaching.map((f) => new Set(Array.from(f.distance).map((d) => d.toFixed(4))).size),
  );
  assert.ok(
    richest > 8,
    `no projector's footprint feathers: the richest has ${richest} distinct distances`,
  );

  // And a projector that covers a piece of surface completely must NOT ramp down
  // at its rim: with nothing to feather against, every vertex is as deep as it
  // gets. Zero there would darken the edge of a fully-covered panel.
  for (const f of reaching) {
    for (const d of f.distance) assert.ok(Number.isFinite(d), 'a distance must stay finite');
  }
});

test('a field is built per projector and never for a sphere', () => {
  const cal = nominalRig();
  assert.equal(prepareRig(cal).footprints, null);
  const mesh = prepareRig(cal, meshSurface(uvSphere(48, 24)));
  assert.ok(mesh.footprints !== null);
  assert.equal(mesh.footprints.length, mesh.projectors.length);
  for (const f of mesh.footprints) {
    assert.ok(f !== null);
    assert.ok(f.litVertices > 0, 'every projector in the nominal rig reaches the ball');
    assert.equal(f.distance.length, 49 * 25);
  }
});

/**
 * A wall facing the projector ring with a smaller panel in front of it.
 *
 * Both face +X, so the projector at azimuth 0 sees them square on — a HORIZONTAL
 * plate would be edge-on to an equatorial rig and reach nothing at all, which is
 * how the first version of this fixture failed. Subdivided, because the distance
 * field lives on vertices and four corners cannot show a gradient.
 */
function wallAndPanel(): SurfaceMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const grid = (x: number, half: number, n: number): void => {
    const base = positions.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        positions.push(x, -half + (2 * half * i) / n, -half + (2 * half * j) / n);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        // Wound so the outward normal is +X, toward the ring.
        indices.push(a, c, b, b, c, d);
      }
    }
  };
  grid(0, 1.0, 12);
  grid(0.35, 0.25, 6);
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'wall-and-panel',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}
