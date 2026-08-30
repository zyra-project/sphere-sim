// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The models the page can put in front of the projectors.
 *
 * These exist to make link (3) measurable — see `fixtures.ts` — so they carry a
 * burden the tests in `mesh-parity.test.ts` do not: a fixture that is subtly
 * wrong makes the parity number on screen wrong, and the number is what somebody
 * would act on. So the tessellated sphere is checked against the ANALYTIC sphere
 * it stands in for, and the plates are checked for the one property they exist
 * to have.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { SURFACE_SHAPES, surfaceMeshFor } from '../src/fixtures.ts';
import { buildWorld } from '../src/state.ts';
import { defaultState } from '../src/params.ts';
import { meshSurface } from '../../sim/src/mesh/surface.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { renderRoomView } from '../../sim/src/render.ts';

test('the shape control selects a model, and the sphere selects none', () => {
  assert.equal(surfaceMeshFor(0, 0.8636), null, 'index 0 is the analytic sphere');
  const uv = surfaceMeshFor(1, 0.8636);
  const plates = surfaceMeshFor(2, 0.8636);
  assert.ok(uv !== null && plates !== null);
  assert.equal(SURFACE_SHAPES.length, 3, 'the control options and the builder must agree');

  // A fragment somebody edited by hand must not take the page down.
  assert.equal(surfaceMeshFor(99, 0.8636), null);
  assert.equal(surfaceMeshFor(-1, 0.8636), null);

  // UVs inside the contract `SurfaceMesh` states, on both. A fixture whose UVs
  // escape [0, 1] would export as holes through the Bourke writer, and would
  // sample the content texture's clamp edge here.
  for (const mesh of [uv, plates]) {
    assert.ok(mesh.uvs !== null, `${mesh.name} must carry an unwrap`);
    for (const t of mesh.uvs) assert.ok(t >= 0 && t <= 1, `${mesh.name} has a UV of ${t}`);
    assert.equal(mesh.positions.length, 3 * mesh.vertexCount);
    assert.equal(mesh.indices.length, 3 * mesh.triangleCount);
    for (const i of mesh.indices) assert.ok(i < mesh.vertexCount);
  }
});

test('the tessellated sphere renders as the analytic sphere it stands in for', () => {
  // The whole reason this fixture is a sphere: the right answer is already
  // known, and it is on screen beside it. A parity failure that is really a
  // FIXTURE problem then announces itself here rather than being read as the
  // driver disagreeing with `packages/sim`.
  const world = buildWorld(defaultState(), 'graticule');
  const camera = { ...world.viewer, width: 64, height: 48 };
  const options = { samplesPerPixel: 1, drawFloor: false, shading: world.shading };

  const analytic = renderRoomView(prepareRig(world.rig), world.scene, camera, options);
  const mesh = surfaceMeshFor(1, world.state.R);
  assert.ok(mesh !== null);
  const tessellated = renderRoomView(
    prepareRig(world.rig, meshSurface(mesh)),
    world.scene,
    camera,
    options,
  );

  let worst = 0;
  let sum = 0;
  let lit = 0;
  for (let i = 0; i < analytic.data.length; i++) {
    const d = Math.abs(analytic.data[i] - tessellated.data[i]);
    worst = Math.max(worst, d);
    if (analytic.data[i] > 0) {
      sum += d;
      lit++;
    }
  }
  const mean = lit > 0 ? sum / lit : 0;
  assert.ok(lit > 500, `only ${lit} lit samples; the camera is not looking at the sphere`);
  // Reported, then bounded. The departure is the TESSELLATION -- a 48x24 sphere
  // is faceted, and its silhouette is a polygon -- so the mean over lit pixels
  // is the honest measure and the worst case belongs to the limb, where one
  // renderer has geometry and the other has background.
  console.log(`  tessellated vs analytic: mean ${mean.toExponential(2)}, worst ${worst.toExponential(2)}`);
  assert.ok(mean < 0.02, `mean departure ${mean} is too large to be tessellation alone`);
});

test('the plates shadow themselves, which is the only reason they exist', () => {
  // A sphere is convex and cannot exercise the shadow ray at all: dropping it
  // from the shader leaves a tessellated sphere pixel-identical. This fixture is
  // the one that would notice, so it has to actually occlude itself.
  const world = buildWorld(defaultState(), 'graticule');
  const mesh = surfaceMeshFor(2, world.state.R);
  assert.ok(mesh !== null);
  const surface = meshSurface(mesh);
  const rig = prepareRig(world.rig, surface);

  let facing = 0;
  let shadowed = 0;
  for (const sample of surface.sampleArea(400)) {
    for (const p of rig.projectors) {
      if (!surface.facesLens(sample.point, sample.normal, p.lens)) continue;
      facing++;
      if (surface.shadowed(sample.point, p.lens)) shadowed++;
    }
  }
  assert.ok(facing > 0, 'nothing faces a lens, so the fixture is not in the rig at all');
  assert.ok(
    shadowed > facing * 0.1,
    `only ${shadowed} of ${facing} facing samples are occluded; the plates must hide each other`,
  );
});

test('the model follows the sphere radius, so a slider cannot put it out of frame', () => {
  const small = surfaceMeshFor(1, 0.4);
  const large = surfaceMeshFor(1, 1.2);
  assert.ok(small !== null && large !== null);
  const extent = (m: NonNullable<ReturnType<typeof surfaceMeshFor>>): number =>
    meshSurface(m).extentRadiusM;
  assert.ok(Math.abs(extent(small) - 0.4) < 1e-9, `${extent(small)}`);
  assert.ok(Math.abs(extent(large) - 1.2) < 1e-9, `${extent(large)}`);
  // And the plates too, or a wide sphere would leave them a speck in the middle.
  assert.ok(extent(surfaceMeshFor(2, 1.2) as never) > extent(surfaceMeshFor(2, 0.4) as never));
});
