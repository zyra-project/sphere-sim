// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The bodies a scenario can put in the room instead of the sphere.
 *
 * A `SurfaceSpec` is the scenario's own description of its body: a handful of
 * numbers, so it prints in `bench-results.json` under `inputs` like every other
 * knob and the baseline digest notices when it moves. The mesh itself is built
 * from it by `run.ts`'s `buildWorld`, at the rig's own radius, and is never
 * serialised — a `SurfaceMesh` is typed arrays, and `packages/sim/src/optics.ts`
 * records above `prepareRig` what `JSON.stringify` does to those.
 *
 * Why a tri-axial ellipsoid and not a tessellated sphere: `packages/solver`'s
 * mesh-bundle tests found that a mesh with the sphere's own symmetry passes
 * identically with the mesh disconnected from the solve — the sphere can
 * impersonate it — so a fixture meant to prove the mesh path is live has to be a
 * body a sphere cannot stand in for. docs/ARBITRARY-SHAPES.md measures the
 * consequence across ten shapes and three seeds: every tri-axial body recovers
 * to the analytic sphere's own accuracy and frees the gauge's azimuth; every
 * spheroid pins it, and the nearly spherical ones recover worse.
 */

import type { SurfaceMesh } from '../../calibration/src/index.ts';

export interface EllipsoidSpec {
  kind: 'ellipsoid';
  /** Semi-axis along y as a fraction of the sphere's radius; x is the radius itself. */
  scaleY: number;
  /** Semi-axis along z — up — as a fraction of the sphere's radius. */
  scaleZ: number;
  /** Latitude bands of the tessellation. */
  nLat: number;
  /** Longitude segments of the tessellation. */
  nLon: number;
  /**
   * Which axis the UV grid's POLES sit on. Undefined means `z`, which is what
   * every scenario in the bench uses and what this builder has always done.
   *
   * A diagnostic, not a shape. On a SPHERE the body is unchanged — a sphere is
   * the same sphere however its parametrisation is oriented — so this moves the
   * tessellation and nothing else: where the facet edges run, where the bands
   * are degenerate, where the vertex fans collapse. That is the one thing an
   * experiment can vary to ask whether an effect belongs to the tessellation's
   * own geometry or to the rig.
   *
   * On anything but a sphere it would rotate the BODY, which is a different
   * measurement wearing the same name, so `ellipsoidMesh` refuses it there.
   */
  poleAxis?: 'z' | 'x';
}

export type SurfaceSpec = EllipsoidSpec;

/**
 * A closed UV-tessellated ellipsoid centred on the origin — the sphere's own
 * frame, so it stands exactly where `rig.sphere` stood. The poles are fans, the
 * seam shares its vertices, and the construction is the one every Phase 5
 * measurement in docs/ARBITRARY-SHAPES.md was made with.
 */
export function ellipsoidMesh(spec: EllipsoidSpec, radiusM: number): SurfaceMesh {
  const { nLat, nLon } = spec;
  if (!Number.isInteger(nLat) || !Number.isInteger(nLon) || nLat < 2 || nLon < 3) {
    // Integers, not merely numbers: a fractional band count indexes a ring that
    // was never emitted, and an infinite one never finishes emitting.
    throw new Error(`ellipsoidMesh: tessellation ${nLat}x${nLon} is not a closed integer grid`);
  }
  // Only on a sphere, and refused rather than documented: on a tri-axial body
  // this would turn the ellipsoid on its side, which is a change of SHAPE, and
  // an experiment reading it as a change of tessellation would be measuring the
  // wrong thing under the right name.
  if (spec.poleAxis === 'x' && (spec.scaleY !== 1 || spec.scaleZ !== 1)) {
    throw new Error(
      `ellipsoidMesh: poleAxis 'x' moves the tessellation, not the body, and only a sphere is ` +
        `unchanged by it — got scales 1:${spec.scaleY}:${spec.scaleZ}`,
    );
  }
  const positions: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const theta = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const phi = (2 * Math.PI * j) / nLon;
      const x = radiusM * Math.sin(theta) * Math.cos(phi);
      const y = radiusM * spec.scaleY * Math.sin(theta) * Math.sin(phi);
      const z = radiusM * spec.scaleZ * Math.cos(theta);
      // A ROTATION about y, not a swap of components. (x,y,z) -> (z,y,-x) has
      // determinant +1 and carries the pole (0,0,R) to (R,0,0); the obvious
      // (x,y,z) -> (z,y,x) is a reflection, which reverses every triangle's
      // winding and so inverts the vertex normals `meshNormal: 'smooth'`
      // derives from it — silently, and in the one mode the experiment is about.
      if (spec.poleAxis === 'x') positions.push(z, y, -x);
      else positions.push(x, y, z);
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
      // The first band's `a` and `d` are the same pole vertex, the last band's
      // `b` and `c` the other; the degenerate triangle is left out rather than
      // emitted with zero area.
      if (i !== 0) indices.push(a, b, d);
      if (i !== nLat - 1) indices.push(b, c, d);
    }
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: `bench-ellipsoid-1-${spec.scaleY}-${spec.scaleZ}`,
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}
