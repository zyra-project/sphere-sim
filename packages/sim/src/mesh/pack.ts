// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The hierarchy, as texels — `docs/ARBITRARY-SHAPES.md` Phase 2.
 *
 * A fragment shader cannot follow a `Float64Array`. To trace a mesh on the GPU
 * the hierarchy and the triangles have to arrive as textures, and this is the
 * layout both shaders read. It is a MEMORY LAYOUT and nothing else: no
 * intersection, no traversal, no decision about what a ray hits. That matters
 * for the parity chain — `packages/harness/src/glsl.ts` and its transliteration
 * are deliberately independent re-implementations of the simulator's model, and
 * they stay independent because what they share here is a byte order rather than
 * an answer.
 *
 * ## Why the triangles are written out rather than indexed
 *
 * A vertex texture plus an index texture would be smaller — a shared vertex is
 * stored once instead of up to six times. It would also cost a second dependent
 * texture fetch inside the innermost loop of a ray traversal, which is the one
 * place a dependent fetch is worst: the address is not known until the first
 * fetch returns, so the hardware cannot prefetch and every triangle test stalls
 * twice instead of once. Positions, normals and UVs are therefore written per
 * triangle, already permuted into `order`, so a leaf's triangles are contiguous
 * in memory as well as in index.
 *
 * ## Layout
 *
 * Two RGBA32F textures, both indexed by `texelFetch` with the linear index
 * unpacked as `ivec2(i % width, i / width)`.
 *
 * **Nodes**, 2 texels each:
 *
 *     texel 2i     (minX, minY, minZ, link)
 *     texel 2i + 1 (maxX, maxY, maxZ, start)
 *
 * `link >= 0` is an interior node and names its RIGHT child; the left child is
 * always `i + 1`, which is what a depth-first build gives for free and what
 * `bvh.ts` documents. `link < 0` is a leaf holding `-link` triangles beginning
 * at `start`. Leaves always hold at least one triangle, so `-1` is the smallest
 * leaf and `0` is unambiguously an interior node.
 *
 * **Triangles**, 6 texels each, in `order` sequence:
 *
 *     texel 6t .. 6t+2  (position.xyz, uv.u)  for corners 0, 1, 2
 *     texel 6t+3 .. 6t+5 (normal.xyz,  uv.v)  for corners 0, 1, 2
 *
 * The UV rides in the `w` slot each position and normal leaves empty, so a
 * triangle is six fetches rather than nine.
 */

import type { SurfaceMesh } from '../../../calibration/src/index.ts';
import type { Bvh } from './bvh.ts';

/** Texels per node and per triangle. See the module note. */
export const NODE_TEXELS = 2;
export const TRI_TEXELS = 6;

/**
 * Texel width of both textures.
 *
 * A power of two, and well under the 2048 minimum `MAX_TEXTURE_SIZE` that WebGL2
 * guarantees, so the height is what grows with the model and the width never has
 * to be negotiated with the device. At 1024 texels a row, the node texture holds
 * a 512-node hierarchy per row and the triangle texture 170 triangles.
 */
export const PACK_WIDTH = 1024;

export interface PackedBvh {
  /** `RGBA32F` data, row-major, `4 * width * height` floats. */
  nodes: Float32Array;
  nodeWidth: number;
  nodeHeight: number;
  triangles: Float32Array;
  triangleWidth: number;
  triangleHeight: number;
  /** Counts, for the shader's loop bounds and for a sanity read. */
  nodeCount: number;
  triangleCount: number;
  /**
   * Deepest path from the root.
   *
   * The shader's traversal stack is a fixed-size array — GLSL has no other kind
   * — so a hierarchy deeper than the stack would silently drop the nodes it
   * could not push and report a miss where there is geometry. The consumer
   * checks this against its own stack depth and refuses rather than renders.
   */
  maxDepth: number;
}

/** Pack a built hierarchy and its mesh into the texture layout above. */
export function packBvh(bvh: Bvh, mesh: SurfaceMesh): PackedBvh {
  const nodeTexels = bvh.nodeCount * NODE_TEXELS;
  const nodeHeight = Math.max(1, Math.ceil(nodeTexels / PACK_WIDTH));
  const nodes = new Float32Array(4 * PACK_WIDTH * nodeHeight);

  for (let i = 0; i < bvh.nodeCount; i++) {
    const b = 6 * i;
    const a = 4 * NODE_TEXELS * i;
    nodes[a] = bvh.bounds[b];
    nodes[a + 1] = bvh.bounds[b + 1];
    nodes[a + 2] = bvh.bounds[b + 2];
    // A leaf is a negative link carrying its own triangle count, so the node
    // costs two texels whether it is interior or not and the shader branches on
    // a sign rather than fetching a third.
    nodes[a + 3] = bvh.rightChild[i] >= 0 ? bvh.rightChild[i] : -bvh.count[i];
    nodes[a + 4] = bvh.bounds[b + 3];
    nodes[a + 5] = bvh.bounds[b + 4];
    nodes[a + 6] = bvh.bounds[b + 5];
    nodes[a + 7] = bvh.rightChild[i] >= 0 ? 0 : bvh.start[i];
  }

  const triCount = bvh.order.length;
  const triTexels = triCount * TRI_TEXELS;
  const triangleHeight = Math.max(1, Math.ceil(triTexels / PACK_WIDTH));
  const triangles = new Float32Array(4 * PACK_WIDTH * triangleHeight);

  const p = mesh.positions;
  const nrm = mesh.normals;
  const uvs = mesh.uvs;
  const idx = mesh.indices;
  for (let t = 0; t < triCount; t++) {
    // `order`, not `t`: the leaves own contiguous runs of `order`, so writing in
    // that sequence is what makes a leaf's triangles contiguous here too.
    const tri = bvh.order[t];
    const base = 4 * TRI_TEXELS * t;
    for (let c = 0; c < 3; c++) {
      const v = idx[3 * tri + c];
      const at = base + 4 * c;
      triangles[at] = p[3 * v];
      triangles[at + 1] = p[3 * v + 1];
      triangles[at + 2] = p[3 * v + 2];
      triangles[at + 3] = uvs === null ? 0 : uvs[2 * v];

      const an = base + 4 * (3 + c);
      // A mesh with no normals in the file gets zeros, and the shader reads that
      // as "use the face normal" — the same rule `MeshSurface.normalOfHit`
      // follows, so the two renderers shade an unlit-normal model identically.
      triangles[an] = nrm === null ? 0 : nrm[3 * v];
      triangles[an + 1] = nrm === null ? 0 : nrm[3 * v + 1];
      triangles[an + 2] = nrm === null ? 0 : nrm[3 * v + 2];
      triangles[an + 3] = uvs === null ? 0 : uvs[2 * v + 1];
    }
  }

  return {
    nodes,
    nodeWidth: PACK_WIDTH,
    nodeHeight,
    triangles,
    triangleWidth: PACK_WIDTH,
    triangleHeight,
    nodeCount: bvh.nodeCount,
    triangleCount: triCount,
    maxDepth: bvh.maxDepth,
  };
}

/** One node, read back out of the packed form. For tests and for the reference. */
export interface PackedNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Right child index, or `-1` on a leaf. */
  rightChild: number;
  /** First `order` entry and triangle count, on a leaf. Zero on an interior node. */
  start: number;
  count: number;
}

/**
 * Read node `i` back.
 *
 * The inverse of the write above, and the shape the shader's own fetch takes.
 * Kept beside the packer rather than in a test so that the layout is written
 * down once: a reader and a writer that disagree about a byte order is the
 * failure this file exists to make impossible.
 */
export function readPackedNode(packed: PackedBvh, i: number): PackedNode {
  const a = 4 * NODE_TEXELS * i;
  const link = packed.nodes[a + 3];
  const leaf = link < 0;
  return {
    minX: packed.nodes[a],
    minY: packed.nodes[a + 1],
    minZ: packed.nodes[a + 2],
    maxX: packed.nodes[a + 4],
    maxY: packed.nodes[a + 5],
    maxZ: packed.nodes[a + 6],
    rightChild: leaf ? -1 : link,
    start: leaf ? packed.nodes[a + 7] : 0,
    count: leaf ? -link : 0,
  };
}

/** One packed triangle corner: position, normal and UV. */
export interface PackedCorner {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
}

/** Read corner `c` of packed triangle `t`. */
export function readPackedCorner(packed: PackedBvh, t: number, c: number): PackedCorner {
  const base = 4 * TRI_TEXELS * t;
  const at = base + 4 * c;
  const an = base + 4 * (3 + c);
  return {
    x: packed.triangles[at],
    y: packed.triangles[at + 1],
    z: packed.triangles[at + 2],
    u: packed.triangles[at + 3],
    nx: packed.triangles[an],
    ny: packed.triangles[an + 1],
    nz: packed.triangles[an + 2],
    v: packed.triangles[an + 3],
  };
}
