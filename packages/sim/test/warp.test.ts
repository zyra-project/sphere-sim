// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The warp-and-blend export.
 *
 * Two of these tests exist because the errors they catch are invisible: both
 * axes flip between this repository's conventions and the file format's, and
 * getting either wrong produces a picture that is plainly a picture — just
 * upside down, or with the map mirrored — which reads as a bad model rather than
 * a bad exporter. So the conventions are pinned against hand-computed nodes
 * rather than against the prose in `warp.ts`.
 *
 * The rest check the property that makes the file worth writing: what it says
 * about brightness has to be the same thing the simulator says, or the export is
 * a second, quietly different blend.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { SurfaceMesh } from '../../calibration/src/index.ts';
import { buildWarpExport, buildWarpExports, formatWarpMesh } from '../src/warp.ts';
import { prepareRig, pixelToRay } from '../src/optics.ts';
import { coverageAndWeights, polarMask } from '../src/coverage.ts';
import { nominalRig } from '../src/scene.ts';
import { meshSurface } from '../src/mesh/surface.ts';
import { latLonToWorld, worldToLatLon } from '../src/geometry.ts';

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
    name: 'uv-sphere',
    positions,
    indices: Uint32Array.from(tris),
    normals,
    uvs,
    vertexCount,
    triangleCount: tris.length / 3,
  };
}

// ---------------------------------------------------------------------------
// The two conventions that flip
// ---------------------------------------------------------------------------

test('display y runs UP while the raster runs down', () => {
  const rig = prepareRig(nominalRig());
  const w = buildWarpExport(rig, 0, { cols: 3, rows: 3 });
  // Node (0,0) is the raster's TOP-LEFT — v = 0 — and must export as the
  // display's top-left, which is y = +1. Emitting y = -1 there flips every
  // exported frame vertically, and a flipped sphere still looks like a sphere.
  assert.equal(w.nodes[0].x, -1);
  assert.equal(w.nodes[0].y, 1);
  // Bottom-right of the raster is bottom-right of the display.
  const last = w.nodes[w.nodes.length - 1];
  assert.equal(last.x, 1);
  assert.equal(last.y, -1);
  // And the centre node is the centre.
  const mid = w.nodes[1 * 3 + 1];
  assert.ok(Math.abs(mid.x) < 1e-12 && Math.abs(mid.y) < 1e-12);
});

test('texture v runs UP while the equirectangular map runs down from the pole', () => {
  // `sampleEquirect` reads `v = (90 − lat)/180`, so v = 0 is the NORTH pole. The
  // format wants v up, so the exported v must be `1 − that`: a node looking at
  // the northern hemisphere has to come out with a HIGH v. Getting this backwards
  // puts the map on upside down, which on a world map is obvious and on an
  // abstract pattern is not.
  const rig = prepareRig(nominalRig());
  const w = buildWarpExport(rig, 0, { cols: 21, rows: 21 });
  let checked = 0;
  const projector = rig.projectors[0];
  const it = projector.cal.intrinsics;
  for (let j = 0; j < 21; j++) {
    for (let i = 0; i < 21; i++) {
      const node = w.nodes[j * 21 + i];
      if (node.intensity < 0) continue;
      // Re-trace this node independently and check the hemisphere agrees.
      const hit = rig.surface.intersect(
        projector.lens,
        pixelToRay(projector, (i / 20) * it.resX, (j / 20) * it.resY),
      );
      assert.ok(hit !== null);
      const latDeg = worldToLatLon(hit.point).latDeg;
      if (Math.abs(latDeg) < 5) continue;
      if (latDeg > 0) assert.ok(node.v > 0.5, `north at v = ${node.v}`);
      else assert.ok(node.v < 0.5, `south at v = ${node.v}`);
      checked++;
    }
  }
  assert.ok(checked > 40, `expected a real sample of both hemispheres, got ${checked}`);
});

// ---------------------------------------------------------------------------
// The file says what the simulator says
// ---------------------------------------------------------------------------

test('the exported intensity IS the blend weight, not a second one', () => {
  const rig = prepareRig(nominalRig());
  const projector = rig.projectors[1];
  const it = projector.cal.intrinsics;
  const cols = 15;
  const rows = 15;
  const w = buildWarpExport(rig, 1, { cols, rows });
  let checked = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const node = w.nodes[j * cols + i];
      if (node.intensity < 0) continue;
      const hit = rig.surface.intersect(
        projector.lens,
        pixelToRay(projector, (i / (cols - 1)) * it.resX, (j / (rows - 1)) * it.resY),
      );
      assert.ok(hit !== null);
      const { weights } = coverageAndWeights(hit.point, hit.normal, rig);
      const mask = polarMask(worldToLatLon(hit.point).latDeg, rig.blend, 'latitude');
      assert.ok(
        Math.abs(node.intensity - weights[1] * mask) < 1e-12,
        `node (${i}, ${j}) exports ${node.intensity} against a model weight of ${weights[1] * mask}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 50, `expected a real sample, checked ${checked}`);
});

test('a node whose ray misses the object says so, rather than saying black', () => {
  const rig = prepareRig(nominalRig());
  const w = buildWarpExport(rig, 0, { cols: 31, rows: 31 });
  // The corners of a raster overshoot the silhouette — AMENDMENTS A-01 has the
  // sphere inscribed in the minor dimension with margin — so a corner must be a
  // no-data node.
  assert.equal(w.nodes[0].intensity, -1, 'the top-left corner must reach nothing');
  assert.ok(w.onSurface > 0 && w.onSurface < 31 * 31, `on-surface count ${w.onSurface}`);
  // -1 rather than 0, and the difference is not pedantic: a zero is a black
  // pixel the projector still emits its black floor into, which is the glow
  // around every real installation. -1 tells the player to draw nothing at all.
  for (const n of w.nodes) {
    assert.ok(n.intensity === -1 || n.intensity >= 0, `intensity ${n.intensity}`);
    if (n.intensity === -1) assert.ok(Number.isNaN(n.u) && Number.isNaN(n.v));
  }
});

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

test('the serialized file parses back to the mesh it came from', () => {
  const rig = prepareRig(nominalRig());
  const w = buildWarpExport(rig, 0, { cols: 9, rows: 7 });
  const text = formatWarpMesh(w);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '2', 'the type line must say rectangular mesh');
  assert.equal(lines[1], '9 7');
  // A positional format: every node occupies a line, including the ones with no
  // data. Skipping them would shift every node after.
  assert.equal(lines.length, 2 + 9 * 7);
  for (let k = 0; k < 9 * 7; k++) {
    const parts = lines[2 + k].split(' ');
    assert.equal(parts.length, 5, `node ${k} has ${parts.length} fields`);
    for (const p of parts) assert.ok(!p.includes('e'), `exponent form in the file: ${p}`);
    const [x, y, , , i] = parts.map(Number);
    assert.ok(Math.abs(x - w.nodes[k].x) < 1e-5 && Math.abs(y - w.nodes[k].y) < 1e-5);
    if (w.nodes[k].intensity < 0) assert.equal(i, -1);
    else assert.ok(Math.abs(i - w.nodes[k].intensity) < 1e-5);
  }
});

test('the file carries no negative zero', () => {
  // Valid, and an eyesore in a text file people diff and read.
  const rig = prepareRig(nominalRig());
  const text = formatWarpMesh(buildWarpExport(rig, 0, { cols: 5, rows: 5 }));
  assert.ok(!text.includes('-0.000000'), 'negative zero reached the file');
});

// ---------------------------------------------------------------------------
// A mesh exports too, which is the point of the exercise
// ---------------------------------------------------------------------------

test('a mesh exports a warp with a real blend in it', () => {
  const rig = prepareRig(nominalRig(), meshSurface(uvSphere(96, 48)));
  const all = buildWarpExports(rig, { cols: 25, rows: 25 });
  assert.equal(all.length, rig.projectors.length);
  for (const w of all) {
    assert.ok(w.onSurface > 0, `${w.projectorId} reached nothing`);
    // The blend is the geodesic footprint ramp, so the intensities must be a
    // continuum rather than the equal splits Phase 1 refused with.
    const distinct = new Set(
      w.nodes.filter((n) => n.intensity > 0).map((n) => n.intensity.toFixed(4)),
    );
    assert.ok(distinct.size > 10, `${w.projectorId} exports ${distinct.size} distinct intensities`);
    assert.ok(w.meanIntensity > 0 && w.meanIntensity <= 1, `mean ${w.meanIntensity}`);
  }
});

test('a mesh export carries no polar mask, because a mesh has no pole', () => {
  // Tested as the DECISION rather than by hunting for a fully dark node. At a
  // 31x31 grid the deepest node a projector reaches is about latitude -65.5,
  // which is inside the mask's cosine feather (60 to 70) and short of the full
  // mask — so "find a zero" finds nothing, and the first version of this test
  // failed against code that was working.
  //
  // Comparing the two exports against each other would not work either: they
  // run different blends, so a difference in intensity says nothing about the
  // mask. So each is checked against ITS OWN blend weight.
  const projectorIndex = 1;
  const check = (
    rig: ReturnType<typeof prepareRig>,
    expectMask: boolean,
  ): { inBand: number; attenuated: number } => {
    const projector = rig.projectors[projectorIndex];
    const it = projector.cal.intrinsics;
    const cols = 31;
    const rows = 31;
    const w = buildWarpExport(rig, projectorIndex, { cols, rows });
    let inBand = 0;
    let attenuated = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const node = w.nodes[j * cols + i];
        if (node.intensity <= 0) continue;
        // Texture v runs up, so latitude is `v * 180 - 90`.
        const latDeg = node.v * 180 - 90;
        if (latDeg > -60) continue;
        inBand++;
        const hit = rig.surface.intersect(
          projector.lens,
          pixelToRay(projector, (i / (cols - 1)) * it.resX, (j / (rows - 1)) * it.resY),
        );
        assert.ok(hit !== null);
        const raw = coverageAndWeights(hit.point, hit.normal, rig).weights[projectorIndex];
        if (node.intensity < raw - 1e-9) attenuated++;
        else assert.ok(Math.abs(node.intensity - raw) < 1e-9, 'unmasked nodes must be the raw weight');
      }
    }
    assert.ok(inBand > 3, `expected nodes below latitude -60, got ${inBand}`);
    if (expectMask) assert.ok(attenuated > 0, 'the sphere must attenuate inside the mask feather');
    else assert.equal(attenuated, 0, "a mesh must not inherit a mask keyed on a sphere's latitude");
    return { inBand, attenuated };
  };

  check(prepareRig(nominalRig()), true);
  check(prepareRig(nominalRig(), meshSurface(uvSphere(96, 48))), false);
});
