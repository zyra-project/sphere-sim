// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The geometric segmenter, on a body that is not the sphere.
 *
 * `sphereSegmenter` keeps a correspondence only when the projector pixel that
 * produced it strikes the ball, and `packages/bench/src/run.ts` refused to build
 * one for a mesh scenario on the reading that "both segmenters fit a CIRCLE to
 * the sphere's silhouette". That is true of the IMAGE-space detector in
 * `silhouette.ts`. It was never true of this one: the geometric segmenter is a
 * ray cast, and `meshSegmenter` is the same ray cast against a BVH.
 *
 * What is proved here: that it accepts what hits and rejects what misses, that
 * it agrees with the sphere version on a body which IS a sphere (so the two are
 * the same predicate and not merely two predicates that both return booleans),
 * and that it separates a body a circle cannot describe from the room behind it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SurfaceMesh } from '../../calibration/src/index.ts';
import { buildMeshIndex, meshSegmenter } from '../src/mesh.ts';
import { bundleStateFromCalibration, sphereSegmenter } from '../src/index.ts';
import { makeScene } from './synthetic.ts';

/** A UV ellipsoid at the rig's own radius, flattened along y and z. */
function ellipsoid(r: number, sy: number, sz: number, nLat = 64, nLon = 128): SurfaceMesh {
  const P: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const th = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const ph = (2 * Math.PI * j) / nLon;
      P.push(
        r * Math.sin(th) * Math.cos(ph),
        r * sy * Math.sin(th) * Math.sin(ph),
        r * sz * Math.cos(th),
      );
    }
  }
  const at = (i: number, j: number): number => i * nLon + (j % nLon);
  const I: number[] = [];
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i !== 0) I.push(a, b, d);
      if (i !== nLat - 1) I.push(b, c, d);
    }
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: `seg-${sy}-${sz}`,
    positions: Float64Array.from(P),
    indices: Uint32Array.from(I),
    normals: null,
    uvs: null,
    vertexCount: P.length / 3,
    triangleCount: I.length / 3,
  };
}

// The solver's own fixture rig. `packages/solver` may not import `packages/sim`
// — boundary-lint R1 exempts only R2's math rule for tests — so the projectors
// come from the synthetic scene every other solver test is built on.
const SCENE = makeScene(1);
const PROJECTORS = bundleStateFromCalibration(SCENE.nominal, []).projectors;
const R = SCENE.truth.radiusM;

/** Every pixel of a coarse grid over one projector's raster. */
function grid(projector: number, step = 24): { u: number; v: number }[] {
  const p = PROJECTORS[projector];
  const out: { u: number; v: number }[] = [];
  for (let v = 0; v < p.resY; v += step) for (let u = 0; u < p.resX; u += step) out.push({ u, v });
  return out;
}

test('on a body that IS a sphere the mesh segmenter is EXACTLY the sphere segmenter', () => {
  // The strongest available cross-check, and the reason the fixture is a sphere
  // here and nothing else: the two predicates are computed by different code
  // against different representations of the same surface, so agreement is
  // evidence about the predicate rather than about the shape.
  //
  // Measured, over every 4th pixel of all four rasters — 518 400 of them:
  //
  //   tessellation   agreement   mesh-only   sphere-only
  //   128 x 256      100.000 %   0           0
  //    64 x 128       99.994 %   0           32
  //    32 x  64       99.917 %   0           432
  //
  // Two things in that table, and the second is the one worth having. Agreement
  // is EXACT at 128 x 256 — not approximate, not within a tolerance. And every
  // disagreement at a coarser tessellation is one-sided: the sphere catches a
  // grazing ray the mesh does not. That is what an INSCRIBED tessellation must
  // do, since its facets are chords lying inside the surface they approximate.
  // A single mesh-only pixel would mean the mesh caught a ray that missed the
  // sphere it is inscribed in, which is not tessellation error but a wrong
  // answer, so it is asserted at every refinement rather than only at the fine
  // one.
  const onSphere = sphereSegmenter({ radiusM: R, projectors: PROJECTORS, marginFrac: 0 });
  const compare = (nLat: number, nLon: number) => {
    const onMesh = meshSegmenter({ index: buildMeshIndex(ellipsoid(R, 1, 1, nLat, nLon)), projectors: PROJECTORS });
    let tested = 0;
    let accepted = 0;
    let meshOnly = 0;
    let sphereOnly = 0;
    for (let p = 0; p < PROJECTORS.length; p++) {
      for (const { u, v } of grid(p, 4)) {
        const a = onMesh(p, u, v);
        const b = onSphere(p, u, v);
        tested++;
        if (a && b) accepted++;
        else if (a) meshOnly++;
        else if (b) sphereOnly++;
      }
    }
    return { tested, accepted, meshOnly, sphereOnly };
  };

  const fine = compare(128, 256);
  assert.equal(fine.tested, 518_400, 'the sampling changed, so the numbers above are no longer the numbers below');
  // Not vacuous: the grid straddles the silhouette, so both predicates are
  // returning a mix rather than agreeing by saying "no" everywhere.
  assert.ok(fine.accepted > 200_000, `only ${fine.accepted} pixels struck the body`);
  assert.ok(fine.accepted < fine.tested * 0.6, 'the grid never leaves the body, so nothing is being separated');
  assert.equal(fine.sphereOnly, 0, `${fine.sphereOnly} pixels disagreed at 128x256`);
  assert.equal(fine.meshOnly, 0, `${fine.meshOnly} pixels disagreed at 128x256`);

  // And the band appears as the facets coarsen, in the direction it must.
  const coarse = compare(32, 64);
  assert.equal(coarse.meshOnly, 0, 'a ray struck the inscribed mesh and missed the sphere containing it');
  assert.ok(
    coarse.sphereOnly > fine.sphereOnly,
    'coarsening the tessellation produced no limb band, so the fine agreement was not a measurement of anything',
  );
});

test('it accepts what strikes a tri-axial body and rejects what flies past it', () => {
  // The case the sphere segmenter cannot serve. A 1:0.7:0.5 ellipsoid is much
  // narrower than the sphere of its own major radius, so a large band of pixels
  // must be accepted by one and refused by the other — and it is the mesh that
  // must refuse, because those rays really do miss the body and land in the room.
  const index = buildMeshIndex(ellipsoid(R, 0.7, 0.5, 64, 128));
  const onMesh = meshSegmenter({ index, projectors: PROJECTORS });
  const onSphere = sphereSegmenter({ radiusM: R, projectors: PROJECTORS, marginFrac: 0 });

  let hitBoth = 0;
  let sphereOnly = 0;
  let meshOnly = 0;
  for (let p = 0; p < PROJECTORS.length; p++) {
    for (const { u, v } of grid(p, 12)) {
      const a = onMesh(p, u, v);
      const b = onSphere(p, u, v);
      if (a && b) hitBoth++;
      else if (b) sphereOnly++;
      else if (a) meshOnly++;
    }
  }
  assert.ok(hitBoth > 0, 'nothing struck the flattened body at all');
  assert.ok(
    sphereOnly > hitBoth * 0.2,
    `only ${sphereOnly} pixels separate the bodies against ${hitBoth} shared; the fixture is too round to test anything`,
  );
  assert.equal(meshOnly, 0, 'a ray missed the enclosing sphere and struck the body inside it');
});

test('a correspondence naming a projector the caller did not describe is refused', () => {
  // The same direction as the sphere version's guard, and for the same reason:
  // passing an untestable point would make the option silently partial in
  // exactly the direction that admits the points it exists to remove.
  const index = buildMeshIndex(ellipsoid(R, 1, 1, 32, 64));
  const onMesh = meshSegmenter({ index, projectors: PROJECTORS.slice(0, 2) });
  const centre = { u: PROJECTORS[0].resX / 2, v: PROJECTORS[0].resY / 2 };
  assert.equal(onMesh(0, centre.u, centre.v), true, 'the centre of a described projector missed');
  assert.equal(onMesh(3, centre.u, centre.v), false, 'an undescribed projector was not refused');
});
