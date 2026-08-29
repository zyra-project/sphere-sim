// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A triangle mesh, as DATA. Part of the boundary object.
 *
 * ## Why this is here and not in `packages/sim`
 *
 * `docs/ARBITRARY-SHAPES.md` Phase 1. Both models need to know what shape the
 * light is landing on: the forward model to trace rays at it, the inverse model
 * to intersect a camera ray with it while solving. Under R1 they may share
 * exactly one package — this one — so the mesh has to arrive here or not at all.
 *
 * The alternative that looks reasonable and is not: a `packages/mesh` holding a
 * loader and a bounding volume hierarchy, imported by both sides.
 * `tools/boundary-lint.ts` rejects it, and its message says why in the general
 * case — "a shared helper package is how the boundary erodes: today it holds a
 * PRNG, next month it holds a distortion model, and every recovery score becomes
 * circular." A shared BVH would be worse than a shared PRNG: ray-triangle
 * intersection IS the geometry, and the moment both sides call the same one, the
 * solver is inverting the simulator's own arithmetic and the recovery scores mean
 * nothing.
 *
 * So this file carries vertices, indices and attributes, and **each side builds
 * its own acceleration structure and writes its own intersection routine**,
 * exactly as each side already writes its own distortion model. R2 enforces the
 * split mechanically: there is no arithmetic in this file, so there is no way to
 * smuggle a traversal in.
 *
 * ## Not JSON, and that is a deliberate break from `RigCalibration`
 *
 * `RigCalibration` says "serialized to JSON, passed between A and B", and that
 * is right for forty numbers. It is wrong for a mesh: a 100k-triangle model is
 * roughly 5 MB of `Float64Array` and about 40 MB as JSON text, parsed a digit at
 * a time. Typed arrays survive `structuredClone`, which is how the page already
 * moves a {@link ../../web/src/protocol.ts} `WarpMesh` between its workers, so
 * the transport that matters already handles them. A calibration that has to
 * reach disk as JSON can carry the mesh beside it as a `.bin`, or carry the
 * source file's own bytes and re-read them.
 */

/** Schema identifier. Bump when the shape of this record changes incompatibly. */
export type SurfaceMeshSchema = 'sphere-sim/surface-mesh@1';

/**
 * Where a mesh vertex sits in the content's parameterization.
 *
 * `u` and `v` in [0, 1], the convention every authoring tool writes and every
 * glTF file stores. This is what replaces latitude and longitude on the mesh
 * path: a sphere has a content parameterization by construction, a mesh has one
 * only because somebody unwrapped it.
 *
 * A mesh with no UV set is legal — `uvs` is nullable — and means the model can
 * be lit and measured but has no defined content. Refusing to load one would be
 * wrong: coverage, overlap and blend are all answerable without a texture, and
 * those are most of what a projection-mapping preview is for.
 */
export interface MeshUv {
  u: number;
  v: number;
}

/**
 * A triangle mesh in the MODEL frame, metres.
 *
 * Interleaved flat arrays rather than an array of vertex objects: a
 * 100k-triangle model is 300k `{x, y, z}` objects, which costs about 40 bytes
 * each in V8 against 24 bytes for three doubles, and scatters them across the
 * heap where a traversal wants them contiguous.
 *
 * ## Frames
 *
 * The MODEL frame, not the world frame. conventions.ts §W puts the world origin
 * at the sphere centre; a GLB arrives in whatever frame its author used, at
 * whatever scale, and where it sits in the room is a separate fact — one that
 * Phase 5 makes a solve variable. Keeping the mesh in its own frame is what lets
 * that pose be fitted later without rewriting every vertex.
 */
export interface SurfaceMesh {
  schema: SurfaceMeshSchema;
  /** Human-readable name, for a panel and for a diagnostic. Never parsed. */
  name: string;
  /**
   * Vertex positions, model frame, metres. `3 * vertexCount` values,
   * `[x0, y0, z0, x1, y1, z1, ...]`.
   *
   * float64 rather than float32. The simulator is a float64 model everywhere
   * else, and `docs/ARBITRARY-SHAPES.md` Phase 2 has the GPU meeting the CPU at
   * a measured parity number — starting the CPU side from float32 vertices
   * would put a rounding floor under that measurement that has nothing to do
   * with either renderer.
   */
  positions: Float64Array;
  /**
   * Triangle corners, `3 * triangleCount` indices into the vertex arrays,
   * counter-clockwise when seen from outside.
   *
   * Winding is load-bearing: it is what gives a triangle an outward side at all,
   * and therefore what makes "does this point face the lens" answerable on a
   * shape that is not convex.
   */
  indices: Uint32Array;
  /**
   * Per-vertex outward unit normals, `3 * vertexCount` values, or `null`.
   *
   * `null` means the consumer derives a flat normal per triangle from the
   * winding. That is not a lesser option — a projection surface is usually a
   * built object with real creases, and smoothing a crease across the seam
   * between two panels would model light arriving at an angle no panel presents.
   */
  normals: Float64Array | null;
  /**
   * Per-vertex content coordinates, `2 * vertexCount` values, or `null` for a
   * mesh with no unwrap. See {@link MeshUv}.
   */
  uvs: Float32Array | null;
  /** Vertex count. `positions.length` is three times this. */
  vertexCount: number;
  /** Triangle count. `indices.length` is three times this. */
  triangleCount: number;
}

/**
 * What a loader reports about a file it read, beside the mesh itself.
 *
 * Separate from {@link SurfaceMesh} because it describes the READING rather
 * than the shape: a caller deciding whether to trust a model wants to know what
 * was dropped on the floor getting here, and a caller rendering one does not.
 */
export interface MeshLoadReport {
  /** The mesh, or `null` when nothing usable was found. */
  mesh: SurfaceMesh | null;
  /** Source format, as detected rather than as claimed by a file extension. */
  format: 'glb' | 'gltf' | 'obj' | null;
  /**
   * What the reader dropped or adjusted, and why. A glTF scene routinely holds
   * lines, points and non-triangle modes that a projection surface has no use
   * for, and a file can ask for more than a reader will give it.
   *
   * Reported rather than applied in silence: a model that arrives with half its
   * geometry missing, or with its texture coordinates changed, should say so —
   * the alternative is somebody studying a coverage map of a shape that is not
   * the one they loaded.
   */
  skipped: string[];
  /** Whether the file supplied its own normals, or they must be derived. */
  hasNormals: boolean;
  /** Whether the file supplied a UV set. Without one there is no content. */
  hasUvs: boolean;
}
