// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A bounding volume hierarchy over a triangle mesh, and the ray-triangle test
 * it accelerates. The forward model's own, and nobody else's.
 *
 * ## This file may not be shared, and that is the point
 *
 * `packages/calibration/src/mesh.ts` explains the rule: the mesh crosses the
 * boundary as DATA, and each side builds its own traversal. Ray-triangle
 * intersection is not a helper, it IS the geometry — the moment the solver calls
 * the simulator's, the solver is inverting the simulator's arithmetic and every
 * recovery score in `bench-results.json` becomes circular. `tools/boundary-lint.ts`
 * makes that structural rather than a promise.
 *
 * ## Why a BVH and not a grid or an octree
 *
 * A projection surface is a made object: a dome, a car, a building facade, a set
 * piece. Those are hollow, thin-walled and wildly non-uniform in triangle
 * density — a uniform grid over a dome spends almost every cell on empty
 * interior, and the traversal then walks hundreds of empty cells per ray. A BVH
 * adapts to where the triangles actually are, which for a shell is a thin sheet
 * in a large box.
 *
 * ## Why the median split and not the surface area heuristic
 *
 * The SAH builds a measurably better tree — typically 10-30% fewer node visits
 * per ray — and it costs `O(n log^2 n)` with a sort per axis per level, against
 * `O(n log n)` for the median. For the sizes this will see interactively (a
 * dropped GLB, rebuilt whenever the user swaps models) the build happens in
 * front of a person who is waiting, and the traversal happens on a worker that
 * is not. A better tree built more slowly is the wrong trade until a measurement
 * says otherwise, and there is no measurement yet.
 *
 * What IS here is the part that matters more than the split rule: the tree is
 * built once per mesh, never per frame, and its nodes live in flat typed arrays
 * so a traversal touches contiguous memory.
 *
 * ## Determinism
 *
 * packages/sim/README.md requires every computation to be a pure function of its
 * inputs plus an explicit seed. The build has no seed and no randomness: the
 * split is the median of centroids along the widest axis, ties broken by index,
 * so the same mesh always produces the same tree and therefore the same
 * traversal order and the same floating-point result.
 */

import type { SurfaceMesh, Vec3 } from '../../../calibration/src/index.ts';

/** Triangles per leaf. Below this a node is not split. */
const LEAF_SIZE = 4;

/**
 * Where a ray met a triangle.
 *
 * `u` and `v` are the barycentric coordinates of the hit within the triangle,
 * with the third being `1 - u - v`. They are returned rather than discarded
 * because interpolating a normal or a content coordinate needs them, and
 * recomputing them from the hit point would be a second, differently-rounded
 * answer to a question this function already answered exactly.
 */
export interface TriangleHit {
  /** Parametric distance along the (unit) ray direction, metres. */
  t: number;
  /** Index of the triangle hit. */
  triangle: number;
  /** Barycentric weight of the second corner. */
  u: number;
  /** Barycentric weight of the third corner. */
  v: number;
}

/**
 * A built hierarchy. Flat arrays, not a node graph.
 *
 * Node `i` occupies `bounds[6i .. 6i+5]` as `[minX, minY, minZ, maxX, maxY,
 * maxZ]`. An interior node stores its right child's index in `rightChild[i]`
 * and has its left child at `i + 1`; a leaf stores `-1` there and a range of
 * `order` in `start[i]` and `count[i]`.
 */
export interface Bvh {
  bounds: Float64Array;
  /** Right-child node index, or `-1` for a leaf. */
  rightChild: Int32Array;
  /** First entry in {@link Bvh.order} for a leaf. Unused for an interior node. */
  start: Int32Array;
  /** Triangle count for a leaf. Zero for an interior node. */
  count: Int32Array;
  /** Triangle indices, permuted so each leaf owns a contiguous run. */
  order: Uint32Array;
  nodeCount: number;
  /** Deepest path from the root, for a diagnostic and for the traversal stack. */
  maxDepth: number;
}

/** Axis-aligned bounds of the whole mesh, and its centre. */
export interface MeshBounds {
  min: Vec3;
  max: Vec3;
  centre: Vec3;
  /** Radius of a sphere about {@link MeshBounds.centre} containing every vertex. */
  radiusM: number;
}

/**
 * The bounding sphere every vertex fits inside, centred on the AABB centre.
 *
 * Not the minimal enclosing sphere — that is Welzl's algorithm and it is
 * randomized, which this package may not be. The AABB-centred sphere is at most
 * `sqrt(3)` times the minimal radius in the worst case and much closer for
 * anything that is not a thin diagonal sliver. It is used for the limb constant
 * `R/d` that PARAMETERS.md §4.1 defines for the sphere, where being generous is
 * the safe direction: it widens the footprint a projector is assumed to reach,
 * and the raster test then rejects what actually falls outside.
 */
export function meshBounds(mesh: SurfaceMesh): MeshBounds {
  const p = mesh.positions;
  if (mesh.vertexCount === 0) {
    const zero = { x: 0, y: 0, z: 0 };
    return { min: zero, max: zero, centre: zero, radiusM: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = p[3 * i];
    const y = p[3 * i + 1];
    const z = p[3 * i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = 0.5 * (minX + maxX);
  const cy = 0.5 * (minY + maxY);
  const cz = 0.5 * (minZ + maxZ);
  let r2 = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const dx = p[3 * i] - cx;
    const dy = p[3 * i + 1] - cy;
    const dz = p[3 * i + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    centre: { x: cx, y: cy, z: cz },
    radiusM: Math.sqrt(r2),
  };
}

/**
 * Build the hierarchy. `O(n log n)` on triangle count, deterministic.
 *
 * The node arrays are sized at `2 * triangleCount + 1`, which is the exact
 * bound for a binary tree whose leaves hold at least one triangle each, so
 * nothing here grows a JavaScript array element by element.
 */
export function buildBvh(mesh: SurfaceMesh): Bvh {
  const n = mesh.triangleCount;
  const maxNodes = Math.max(1, 2 * n + 1);
  const bounds = new Float64Array(6 * maxNodes);
  const rightChild = new Int32Array(maxNodes).fill(-1);
  const start = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  // Centroid per triangle, precomputed: the split reads them O(log n) times
  // each and recomputing from three vertices every time is the whole build cost.
  const cent = new Float64Array(3 * n);
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let t = 0; t < n; t++) {
    const a = 3 * idx[3 * t];
    const b = 3 * idx[3 * t + 1];
    const c = 3 * idx[3 * t + 2];
    cent[3 * t] = (p[a] + p[b] + p[c]) / 3;
    cent[3 * t + 1] = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
    cent[3 * t + 2] = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
  }

  let nodeCount = 0;
  let maxDepth = 0;

  /** Bounds of `order[from..to)`, written into node `node`. */
  const boundTriangles = (node: number, from: number, to: number): void => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = from; i < to; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        const v = 3 * idx[3 * t + k];
        const x = p[v];
        const y = p[v + 1];
        const z = p[v + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    bounds[6 * node] = minX;
    bounds[6 * node + 1] = minY;
    bounds[6 * node + 2] = minZ;
    bounds[6 * node + 3] = maxX;
    bounds[6 * node + 4] = maxY;
    bounds[6 * node + 5] = maxZ;
  };

  /**
   * Recursive build, written as an explicit stack.
   *
   * A mesh whose triangles all share a centroid — a degenerate fan, or a model
   * exported with every vertex welded to one point — recurses to depth n if the
   * split is allowed to put everything on one side. The guard below falls back
   * to a middle split by position in `order`, which always makes progress.
   */
  const build = (from: number, to: number, depth: number): number => {
    const node = nodeCount++;
    if (depth > maxDepth) maxDepth = depth;
    boundTriangles(node, from, to);
    const size = to - from;
    if (size <= LEAF_SIZE) {
      rightChild[node] = -1;
      start[node] = from;
      count[node] = size;
      return node;
    }

    // Widest axis of the CENTROID bounds, not of the triangle bounds. Splitting
    // on the triangle extent lets one long triangle decide the axis for a
    // thousand small ones.
    let cMinX = Infinity;
    let cMinY = Infinity;
    let cMinZ = Infinity;
    let cMaxX = -Infinity;
    let cMaxY = -Infinity;
    let cMaxZ = -Infinity;
    for (let i = from; i < to; i++) {
      const t = order[i];
      const x = cent[3 * t];
      const y = cent[3 * t + 1];
      const z = cent[3 * t + 2];
      if (x < cMinX) cMinX = x;
      if (y < cMinY) cMinY = y;
      if (z < cMinZ) cMinZ = z;
      if (x > cMaxX) cMaxX = x;
      if (y > cMaxY) cMaxY = y;
      if (z > cMaxZ) cMaxZ = z;
    }
    const ex = cMaxX - cMinX;
    const ey = cMaxY - cMinY;
    const ez = cMaxZ - cMinZ;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;

    const mid = (from + to) >> 1;
    if (ex === 0 && ey === 0 && ez === 0) {
      // Every centroid coincides. Any split is arbitrary; the middle one at
      // least halves the range, so the recursion terminates.
      rightChild[node] = 0;
      start[node] = 0;
      count[node] = 0;
      build(from, mid, depth + 1);
      rightChild[node] = build(mid, to, depth + 1);
      return node;
    }

    // Partial sort about the median. `nthElement` leaves everything below `mid`
    // no greater than everything above it, which is all a median split needs —
    // a full sort would do strictly more work for the same tree.
    nthElement(order, from, to, mid, cent, axis);

    rightChild[node] = 0;
    start[node] = 0;
    count[node] = 0;
    build(from, mid, depth + 1);
    rightChild[node] = build(mid, to, depth + 1);
    return node;
  };

  if (n > 0) build(0, n, 0);
  else {
    nodeCount = 1;
    rightChild[0] = -1;
    start[0] = 0;
    count[0] = 0;
    bounds.fill(0, 0, 6);
  }

  return { bounds, rightChild, start, count, order, nodeCount, maxDepth };
}

/**
 * Quickselect about `k`, comparing centroids on `axis`, ties broken by triangle
 * index so the permutation is a pure function of the mesh.
 *
 * The tie-break is not cosmetic. Two triangles with the same centroid on the
 * split axis are common in a machine-generated mesh — a revolved surface has
 * whole rings of them — and without a total order the partition depends on the
 * order the loop happened to visit them in, which makes the tree, the traversal
 * order and the last bit of every intersection depend on nothing at all.
 */
function nthElement(
  order: Uint32Array,
  from: number,
  to: number,
  k: number,
  cent: Float64Array,
  axis: number,
): void {
  let lo = from;
  let hi = to - 1;
  const less = (a: number, b: number): boolean => {
    const ca = cent[3 * a + axis];
    const cb = cent[3 * b + axis];
    if (ca < cb) return true;
    if (ca > cb) return false;
    return a < b;
  };
  while (lo < hi) {
    // Median-of-three pivot, which keeps a sorted or reverse-sorted input —
    // exactly what a mesh straight out of an exporter tends to be — off the
    // quadratic path.
    const mid = (lo + hi) >> 1;
    let pivot = order[mid];
    if (less(order[hi], order[lo])) swap(order, lo, hi);
    if (less(order[mid], order[lo])) swap(order, mid, lo);
    if (less(order[hi], order[mid])) swap(order, hi, mid);
    pivot = order[mid];

    let i = lo;
    let j = hi;
    while (i <= j) {
      while (less(order[i], pivot)) i++;
      while (less(pivot, order[j])) j--;
      if (i <= j) {
        swap(order, i, j);
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

function swap(a: Uint32Array, i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/**
 * Möller-Trumbore, single-sided disabled.
 *
 * Back faces are NOT culled, and that is deliberate rather than lazy. A
 * projection surface is routinely a shell modelled from one side, and an
 * exporter that flipped a winding would make whole panels invisible to the
 * tracer while looking correct in the modelling tool. The surface reports which
 * side was hit through the sign of the geometric normal instead, so a
 * wrongly-wound model renders as lit-from-behind — visibly wrong — rather than
 * as a hole.
 *
 * `EPS` is on the determinant, i.e. on the ray being parallel to the triangle
 * plane, not on `t`. A tolerance on `t` belongs to the caller, which knows
 * whether it is tracing from a lens (nothing to self-intersect) or from a
 * surface point (everything to self-intersect).
 *
 * ## `BARY_EPS`, and the crack it closes
 *
 * A ray that meets a triangle exactly on a shared edge computes a barycentric
 * coordinate of zero — and in floating point, "zero" comes out a few ulps either
 * side. With a strict `u < 0` test, BOTH triangles sharing that edge can reject
 * it, the ray passes through the surface, and the tracer reports the far wall or
 * nothing at all.
 *
 * That is not a rare accident. `test/mesh-surface.test.ts` found it on the first
 * try, because it is SYSTEMATIC: a regular tessellation puts its shared edges on
 * meridians, a rig aimed down an axis fires rays straight at them, and the
 * dropped ray lands in the same place on every frame. A random crack is noise; a
 * crack that follows the mesh's own seams is a black meridian through the middle
 * of a coverage map.
 *
 * Admitting a hit slightly outside the triangle closes it. The cost is that a
 * ray landing exactly on an edge now hits both neighbours, at the same `t` — the
 * nearest-hit search takes one deterministically and the occlusion query does
 * not care. At 1e-9 in barycentric units the enlargement is sub-nanometre on a
 * metre-scale triangle, which is nine orders below the tessellation error it
 * sits inside.
 *
 * **What this is not:** a watertightness proof. Woop et al. (2013) give a
 * ray-triangle test that is provably crack-free by construction rather than by
 * tolerance, and that is the right answer if the mesh path ever has to carry a
 * §7-style gate. It is more code and it is not needed to render a dropped model
 * correctly, so it is recorded in `docs/ARBITRARY-SHAPES.md` as the upgrade
 * rather than written speculatively here.
 */
const EPS = 1e-12;
const BARY_EPS = 1e-9;

export function rayTriangle(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): { t: number; u: number; v: number } | null {
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPS && det < EPS) return null;

  const inv = 1 / det;
  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -BARY_EPS || u > 1 + BARY_EPS) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -BARY_EPS || u + v > 1 + BARY_EPS) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return { t, u, v };
}

/** Slab test. Returns the near distance, or `Infinity` for a miss. */
function rayBox(
  bounds: Float64Array,
  node: number,
  ox: number,
  oy: number,
  oz: number,
  invDx: number,
  invDy: number,
  invDz: number,
  tMin: number,
  tMax: number,
): number {
  const b = 6 * node;
  // The multiply-by-reciprocal form gives +/-Infinity for an axis-parallel ray
  // rather than a NaN, and min/max then propagate it correctly — which is why
  // the reciprocal is taken once by the caller instead of dividing here.
  let t0 = (bounds[b] - ox) * invDx;
  let t1 = (bounds[b + 3] - ox) * invDx;
  let lo = Math.min(t0, t1);
  let hi = Math.max(t0, t1);

  t0 = (bounds[b + 1] - oy) * invDy;
  t1 = (bounds[b + 4] - oy) * invDy;
  lo = Math.max(lo, Math.min(t0, t1));
  hi = Math.min(hi, Math.max(t0, t1));

  t0 = (bounds[b + 2] - oz) * invDz;
  t1 = (bounds[b + 5] - oz) * invDz;
  lo = Math.max(lo, Math.min(t0, t1));
  hi = Math.min(hi, Math.max(t0, t1));

  if (hi < Math.max(lo, tMin) || lo > tMax) return Infinity;
  return Math.max(lo, tMin);
}

/**
 * Nearest triangle along the ray, or `null`.
 *
 * The traversal descends the near child first and skips a subtree whose box is
 * already further than the best hit, which is what makes the hierarchy worth
 * building: for a closed shell it usually visits a handful of nodes rather than
 * every triangle.
 */
export function intersectBvh(
  bvh: Bvh,
  mesh: SurfaceMesh,
  origin: Vec3,
  dir: Vec3,
  tMin: number,
  tMax: number,
): TriangleHit | null {
  if (bvh.nodeCount === 0 || mesh.triangleCount === 0) return null;
  const p = mesh.positions;
  const idx = mesh.indices;
  const invDx = 1 / dir.x;
  const invDy = 1 / dir.y;
  const invDz = 1 / dir.z;

  let best: TriangleHit | null = null;
  let bestT = tMax;

  // +2 for the root and for the slack a leaf at maxDepth needs.
  const stack = new Int32Array(bvh.maxDepth + 2);
  let sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    const node = stack[--sp];
    if (rayBox(bvh.bounds, node, origin.x, origin.y, origin.z, invDx, invDy, invDz, tMin, bestT) === Infinity) {
      continue;
    }
    const right = bvh.rightChild[node];
    if (right < 0) {
      const from = bvh.start[node];
      const to = from + bvh.count[node];
      for (let i = from; i < to; i++) {
        const t = bvh.order[i];
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
        if (hit === null) continue;
        if (hit.t <= tMin || hit.t >= bestT) continue;
        bestT = hit.t;
        best = { t: hit.t, triangle: t, u: hit.u, v: hit.v };
      }
      continue;
    }

    // Near child first. Pushing the far one first means it is popped last.
    const left = node + 1;
    const dLeft = rayBox(bvh.bounds, left, origin.x, origin.y, origin.z, invDx, invDy, invDz, tMin, bestT);
    const dRight = rayBox(bvh.bounds, right, origin.x, origin.y, origin.z, invDx, invDy, invDz, tMin, bestT);
    if (dLeft <= dRight) {
      if (dRight !== Infinity) stack[sp++] = right;
      if (dLeft !== Infinity) stack[sp++] = left;
    } else {
      if (dLeft !== Infinity) stack[sp++] = left;
      if (dRight !== Infinity) stack[sp++] = right;
    }
  }

  return best;
}

/**
 * Is anything between `origin` and a point `tMax` along `dir`?
 *
 * The shadow query, and the reason Phase 1 exists at all: on a sphere "does this
 * point face the lens" IS the visibility test, because a sphere is convex. On a
 * mesh it is not, and a projection surface that cannot answer this cannot show
 * the thing a projection-mapping preview is for — which part of the model one
 * projector cannot reach because another part of the model is in the way.
 *
 * Any hit is enough, so this returns on the first one rather than tracking the
 * nearest. That is a real saving on the query that runs per projector per shaded
 * point, which is the innermost loop of the mesh path.
 */
export function occludedBvh(
  bvh: Bvh,
  mesh: SurfaceMesh,
  origin: Vec3,
  dir: Vec3,
  tMin: number,
  tMax: number,
): boolean {
  if (bvh.nodeCount === 0 || mesh.triangleCount === 0) return false;
  const p = mesh.positions;
  const idx = mesh.indices;
  const invDx = 1 / dir.x;
  const invDy = 1 / dir.y;
  const invDz = 1 / dir.z;

  const stack = new Int32Array(bvh.maxDepth + 2);
  let sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    const node = stack[--sp];
    if (rayBox(bvh.bounds, node, origin.x, origin.y, origin.z, invDx, invDy, invDz, tMin, tMax) === Infinity) {
      continue;
    }
    const right = bvh.rightChild[node];
    if (right < 0) {
      const from = bvh.start[node];
      const to = from + bvh.count[node];
      for (let i = from; i < to; i++) {
        const t = bvh.order[i];
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
        if (hit !== null && hit.t > tMin && hit.t < tMax) return true;
      }
      continue;
    }
    stack[sp++] = right;
    stack[sp++] = node + 1;
  }
  return false;
}
