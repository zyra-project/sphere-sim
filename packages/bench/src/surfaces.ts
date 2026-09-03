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
  const positions: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const theta = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const phi = (2 * Math.PI * j) / nLon;
      positions.push(
        radiusM * Math.sin(theta) * Math.cos(phi),
        radiusM * spec.scaleY * Math.sin(theta) * Math.sin(phi),
        radiusM * spec.scaleZ * Math.cos(theta),
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
