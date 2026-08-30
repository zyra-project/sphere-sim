// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Models the harness can put in front of the projectors — `docs/ARBITRARY-SHAPES.md`
 * Phase 2, link (3).
 *
 * ## Why the harness needs any model at all
 *
 * `packages/harness/README.md` names three links in the parity chain and says
 * plainly that the third one — a real GL driver compiling the shader text into
 * the arithmetic the reference describes — is not verified in this repository's
 * container. It is measured at runtime, by this page, and shown at the top of
 * the metrics panel.
 *
 * Phase 2 taught both shaders to trace a mesh, and link (3) did not follow: the
 * page had no way to select a model, so the mesh path had never executed on ANY
 * GL implementation, software or hardware. Every claim about it rested on
 * `reference.ts` — links (1) and (2), which are float64 TypeScript. That is a
 * whole renderer verified by not being run.
 *
 * ## Built here rather than loaded
 *
 * No file picker, no GLB, no fetch. A fixture that arrives over the network is a
 * fixture that can fail to arrive, and this page's job is to say whether the GPU
 * agrees with `packages/sim` — not whether a server served a file. These are the
 * same two shapes `harness/test/mesh-parity.test.ts` measures against the
 * simulator on the CPU, so a disagreement on screen is a disagreement about the
 * DRIVER and about nothing else.
 *
 * ## Why these two shapes
 *
 * **A tessellated sphere** is the one model whose right answer is already known:
 * the analytic sphere is beside it, so a parity failure that is really a fixture
 * problem announces itself as the two spheres disagreeing with each other.
 *
 * **Two plates** because a sphere is convex and therefore cannot exercise
 * `meshIlluminated`'s third test at all. Removing the shadow ray from the
 * reference leaves a tessellated sphere pixel-identical; it took a concave
 * fixture to catch that on the CPU, and it takes one here.
 */

import type { SurfaceMesh } from '../../calibration/src/index.ts';
import { latLonToWorld } from '../../sim/src/geometry.ts';

/** Which model is in front of the projectors. The state value is the index. */
export const SURFACE_SHAPES = [
  { id: 'sphere', label: 'Analytic sphere' },
  { id: 'uv-sphere', label: 'Tessellated sphere (mesh)' },
  { id: 'two-plates', label: 'Two plates (mesh, self-shadowing)' },
] as const;

export type SurfaceShapeId = (typeof SURFACE_SHAPES)[number]['id'];

/**
 * The model for a shape index, or `null` for the analytic sphere.
 *
 * Out-of-range falls back to the sphere rather than throwing: this reads a
 * number off a URL fragment somebody may have edited, and a page that refuses to
 * load over it would be worse than one that shows the shape it has always shown.
 */
export function surfaceMeshFor(shapeIndex: number, radiusM: number): SurfaceMesh | null {
  const shape = SURFACE_SHAPES[Math.round(shapeIndex)]?.id ?? 'sphere';
  if (shape === 'uv-sphere') return uvSphere(48, 24, radiusM);
  if (shape === 'two-plates') return twoPlates(radiusM * 0.35);
  return null;
}

/**
 * A sphere as triangles, unwrapped equirectangularly.
 *
 * 48x24 rather than something finer: the traversal cost is per RAY and this page
 * renders five viewports plus two parity read-backs every settled frame, and a
 * denser mesh would measure the driver's patience rather than its arithmetic.
 * The unwrap is the equirectangular one so the model shows the same content the
 * analytic sphere beside it shows — a difference in the PICTURE is then a
 * difference in the renderer.
 */
export function uvSphere(segments: number, rings: number, radiusM: number): SurfaceMesh {
  const vertexCount = (rings + 1) * (segments + 1);
  const positions = new Float64Array(3 * vertexCount);
  const uvs = new Float32Array(2 * vertexCount);
  let v = 0;
  for (let iy = 0; iy <= rings; iy++) {
    const latDeg = 90 - (iy / rings) * 180;
    for (let ix = 0; ix <= segments; ix++) {
      const p = latLonToWorld(latDeg, -180 + (ix / segments) * 360, radiusM);
      positions[3 * v] = p.x;
      positions[3 * v + 1] = p.y;
      positions[3 * v + 2] = p.z;
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
      // The polar rows are triangles rather than quads: at a pole every vertex
      // of the ring meets one point, so half of each quad is degenerate.
      if (iy !== 0) tris.push(a, d, b);
      if (iy !== rings - 1) tris.push(b, d, c);
    }
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: `tessellated sphere ${segments}x${rings}`,
    positions,
    indices: Uint32Array.from(tris),
    normals: null,
    uvs,
    vertexCount,
    triangleCount: tris.length / 3,
  };
}

/**
 * Two plates facing +x, one behind the other.
 *
 * The far one FACES a projector out on +x and is entirely in the near one's
 * shadow — the case a sphere can never present, and the only one that exercises
 * the shadow ray. Sized from the sphere's radius so it sits inside the rig's
 * frustum whatever §1's diameter slider is set to.
 */
export function twoPlates(halfSizeM: number): SurfaceMesh {
  const s = halfSizeM;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const x of [s, -s]) {
    const base = positions.length / 3;
    // Wound so the face normal is +x: cross(v1 - v0, v2 - v0) points that way.
    positions.push(x, -s, -s, x, s, -s, x, s, s, x, -s, s);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'two plates',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: Float32Array.from(uvs),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}
