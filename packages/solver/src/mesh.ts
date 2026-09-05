// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Ray → triangle mesh, the solver's own.
 *
 * ## Why this exists when `packages/sim` already has one
 *
 * The two models are deliberately independent. `tools/boundary-lint.ts` R1 bans
 * `packages/solver` from importing `packages/sim` and the reverse, and the
 * allowlist leaves the solver exactly one dependency, `packages/calibration`,
 * which is data-only. So the solver cannot call the simulator's intersection
 * even if it wanted to — and it should not want to. The repository's argument,
 * `packages/calibration/README.md`: "the two sides each implement
 * `conventions.ts` from scratch, and the only thing they agree on is a JSON
 * document." A solver that recovered a calibration using the simulator's own
 * geometry would be marking its own homework, and the bench would be measuring
 * a shared bug as a success.
 *
 * That makes agreement between the two a RESULT rather than a construction, and
 * it is the result that has to be tested — in `packages/bench`, which is the one
 * package permitted to hold both. Nothing in this file is derived from the
 * simulator's traversal; the structural choices below differ from it in several
 * places, which is the point. What must match is the ANSWER: a `t`, a point and
 * a normal, to the tolerance a test states and justifies.
 *
 * ## Scope, and what it deliberately does not do
 *
 * Phase 5 holds the model's pose and scale: a visitor supplies geometry already
 * placed in world coordinates, and the mesh contributes no bundle parameters.
 * That decision is why {@link intersectMeshJacobian} below is a REPLACEMENT for
 * `intersectSphereJacobian` inside the existing camera block rather than a new
 * parameter block — the camera still moves, so the hit still moves with it, but
 * the model does not.
 */

import type { SurfaceMesh } from '../../calibration/src/index.ts';

import { mat3MulVec, vAdd, vDot, vNorm, vScale, type Vec3 } from './linalg.ts';
import {
  projectorPixelToRay,
  rotationWithDerivatives,
  type ProjectorModel,
  type RotationWithDerivatives,
} from './project.ts';
import {
  CAM_FOCAL,
  CAM_PARAM_COUNT,
  CAM_PITCH,
  CAM_ROLL,
  CAM_VELOCITY_OF,
  CAM_VPX,
  CAM_VROLL,
  CAM_YAW,
  type CameraModel,
} from './sphere.ts';

/**
 * A ray's nearest intersection with a mesh.
 *
 * Mirrors `SphereHit` field for field, plus `triangle`, so a caller that already
 * handles a sphere hit handles this one. The shared shape is not cosmetic: the
 * bundle reads `point`, `intersectMeshJacobian` below reads `normal` and `t`,
 * the test capture reads `normal` for its incidence cut, and a second hit type
 * with a different spelling would be two code paths where the geometry is one.
 */
export interface MeshHit {
  hit: boolean;
  /** Distance along the unit ray to the nearest intersection ahead of the origin. */
  t: number;
  point: Vec3;
  /**
   * Unit normal of the hit triangle, from its winding — outward for a mesh wound
   * counter-clockwise seen from outside, which `SurfaceMesh.indices` requires.
   *
   * FLAT, not interpolated, even when the mesh carries per-vertex normals.
   * `SurfaceMesh.normals` documents its own null case as "not a lesser option —
   * a projection surface is usually a built object with real creases", and the
   * same argument decides this: the quantity the solve needs is the orientation
   * of the surface the light actually met, and a smoothed normal describes a
   * curve the tessellation does not have. It would also make `normal` disagree
   * with `point`, which is exactly on the flat facet.
   */
  normal: Vec3;
  /**
   * Cosine between the incoming ray and the inward normal, as `SphereHit`.
   *
   * NEGATIVE when the ray met the back of a facet. On a sphere that cannot
   * happen for a camera outside it, so the sphere's version is documented as
   * falling to zero at the limb and no further. A mesh can be open, or seen from
   * inside, and reporting a negative cosine is the honest answer — a caller that
   * needs "did this face the lens" should test the sign rather than be handed a
   * flipped normal that hides it.
   */
  cosIncidence: number;
  /** Index of the hit triangle, or `-1` on a miss. Indexes `indices` in threes. */
  triangle: number;
}

const MISS: MeshHit = {
  hit: false,
  t: NaN,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
  cosIncidence: 0,
  triangle: -1,
};

/**
 * A bounding volume hierarchy over a mesh's triangles.
 *
 * Flat typed arrays rather than linked nodes. A mesh is built once and then
 * intersected once per correspondence per iteration — hundreds of thousands of
 * times across a solve — so the traversal's inner loop should not be chasing
 * pointers through objects the collector has scattered.
 *
 * `order` is the permutation the build produced: a leaf names a contiguous span
 * of it, and the span's entries name triangles. The triangle indices themselves
 * are never moved, so a hit reports the caller's own numbering.
 */
export interface MeshIndex {
  readonly mesh: SurfaceMesh;
  /** `6 * nodeCount`: minX, minY, minZ, maxX, maxY, maxZ per node. */
  readonly bounds: Float64Array;
  /** `2 * nodeCount`. For an interior node, `[leftChild, -1]`; for a leaf, `[start, count]`. */
  readonly nodes: Int32Array;
  /** Triangle indices, permuted by the build. */
  readonly order: Uint32Array;
  readonly nodeCount: number;
}

/**
 * Triangles per leaf.
 *
 * Not tuned — chosen as the point where a linear scan of the leaf costs about
 * what one more level of box tests costs, and left alone. A BVH's traversal
 * order is what makes it fast; the leaf size moves the constant.
 */
const LEAF_SIZE = 4;

/** The stack depth the traversal allocates. 2^64 leaves is not a mesh. */
const MAX_DEPTH = 64;

/**
 * Build the hierarchy.
 *
 * Median split on the widest axis of the node's centroid spread, which is the
 * cheapest build that still adapts to the shape: splitting on the widest extent
 * of the BOUNDS instead would put every triangle of a long thin panel on one
 * side, and a fixed axis cycle ignores the geometry altogether. A surface-area
 * heuristic would build a better tree and cost more to build; a projection
 * surface is a few tens of thousands of triangles and is traversed far more
 * often than it is built, so that trade is open if traversal ever dominates.
 *
 * Selection is by `Array.prototype.sort` on each node's own slice rather than a
 * quickselect. It is O(n log^2 n) overall instead of O(n log n), and for the
 * sizes involved the difference is not measurable against the cost of reading
 * the file that produced the mesh.
 */
export function buildMeshIndex(mesh: SurfaceMesh): MeshIndex {
  const n = mesh.triangleCount;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  // Centroids up front. The build reads each one O(log n) times and computing it
  // from three vertices every time is the build's whole cost.
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const cz = new Float64Array(n);
  const { positions, indices } = mesh;
  for (let t = 0; t < n; t++) {
    const a = 3 * indices[3 * t];
    const b = 3 * indices[3 * t + 1];
    const c = 3 * indices[3 * t + 2];
    cx[t] = (positions[a] + positions[b] + positions[c]) / 3;
    cy[t] = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    cz[t] = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
  }

  // An upper bound on the node count: a binary tree whose leaves hold at least
  // one triangle each has at most 2n-1 nodes. Allocating for the bound once
  // beats growing, and the unused tail is trimmed on return.
  const maxNodes = Math.max(1, 2 * n - 1);
  const bounds = new Float64Array(6 * maxNodes);
  const nodes = new Int32Array(2 * maxNodes);
  let nodeCount = 0;

  const boundsOf = (start: number, count: number, node: number): void => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        const v = 3 * indices[3 * t + k];
        const x = positions[v];
        const y = positions[v + 1];
        const z = positions[v + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    const b = 6 * node;
    bounds[b] = minX;
    bounds[b + 1] = minY;
    bounds[b + 2] = minZ;
    bounds[b + 3] = maxX;
    bounds[b + 4] = maxY;
    bounds[b + 5] = maxZ;
  };

  // Recursion written as an explicit stack. A deep mesh should fail an assertion
  // about its own size, not blow the JS call stack somewhere in a library.
  const build = (start: number, count: number): number => {
    const node = nodeCount++;
    boundsOf(start, count, node);

    if (count <= LEAF_SIZE) {
      nodes[2 * node] = start;
      nodes[2 * node + 1] = count;
      return node;
    }

    // Widest axis of the CENTROID spread.
    const minC = [Infinity, Infinity, Infinity];
    const maxC = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i++) {
      const t = order[i];
      const c = [cx[t], cy[t], cz[t]];
      for (let k = 0; k < 3; k++) {
        if (c[k] < minC[k]) minC[k] = c[k];
        if (c[k] > maxC[k]) maxC[k] = c[k];
      }
    }
    let axis = 0;
    let widest = maxC[0] - minC[0];
    for (let k = 1; k < 3; k++) {
      const w = maxC[k] - minC[k];
      if (w > widest) {
        widest = w;
        axis = k;
      }
    }

    // Every centroid coincident — a fan of degenerate triangles, or duplicated
    // geometry. No split separates them, so stop rather than recurse forever on
    // a partition that never shrinks.
    if (!(widest > 0)) {
      nodes[2 * node] = start;
      nodes[2 * node + 1] = count;
      return node;
    }

    const key = axis === 0 ? cx : axis === 1 ? cy : cz;
    const slice = Array.from(order.subarray(start, start + count));
    slice.sort((p, q) => key[p] - key[q]);
    order.set(slice, start);

    const half = count >> 1;
    const left = build(start, half);
    const right = build(start + half, count - half);
    // Children are contiguous by construction of the pre-order walk, but the
    // right child's index is recorded rather than assumed: `left + 1` is only
    // the right child when the left subtree is a single node.
    nodes[2 * node] = left;
    nodes[2 * node + 1] = -right - 1;
    return node;
  };

  if (n > 0) build(0, n);
  else {
    nodes[0] = 0;
    nodes[1] = 0;
    bounds.fill(0, 0, 6);
    nodeCount = 1;
  }

  return {
    mesh,
    bounds: bounds.slice(0, 6 * nodeCount),
    nodes: nodes.slice(0, 2 * nodeCount),
    order,
    nodeCount,
  };
}

/**
 * Triangle tests performed, cumulative. Diagnostics and tests only.
 *
 * A BVH that stops pruning still returns the RIGHT answer — it just tests every
 * triangle to get it. No black-box assertion can see that, which was
 * demonstrated rather than assumed: removing the slab's `near <= far` rejection
 * left all seven tests in `mesh.test.ts` green. Since pruning is the entire
 * reason this hierarchy exists, and a solve intersects hundreds of thousands of
 * rays, the counter makes the property assertable.
 *
 * Module-level mutable state in a package that must be deterministic deserves a
 * sentence: nothing here reads it, no result depends on it, and it is not reset
 * by the traversal — a caller that wants a measurement brackets it with
 * {@link resetMeshTraversalStats}.
 */
let triangleTests = 0;

/** @see triangleTests */
export function meshTraversalStats(): { triangleTests: number } {
  return { triangleTests };
}

/** @see triangleTests */
export function resetMeshTraversalStats(): void {
  triangleTests = 0;
}

/**
 * Slab test: the entry distance of the ray into the box, or `Infinity`.
 *
 * Each axis is handled explicitly and an axis the ray does not move along is
 * SKIPPED rather than divided through, which is the whole point of the shape
 * below. The compact form — six products against a precomputed reciprocal, then
 * `max` of the minima against `min` of the maxima — is the version everyone
 * writes, and it was the version here first. It produces `0 * Infinity` = NaN
 * whenever a ray has a zero direction component AND the box touches that plane,
 * and every comparison against NaN is false, so the box is rejected.
 *
 * That was written off in this file as "a measure-zero case ... at worst a
 * coplanar grazing hit that carries no useful incidence anyway". Both halves
 * were wrong, and the sim-vs-solver agreement test caught it. It is not measure
 * zero: an axis-aligned ray meets an axis-aligned tessellation systematically —
 * a UV sphere's `phi = 0` meridian lies exactly in `y = 0`, so every ray in that
 * plane hits it. And the hit being lost was not grazing but HEAD ON, at
 * barycentrics `u = v = 0.5`, the exact centre of an edge. Measured: 151 of 6624
 * seam rays took the FAR side of a closed sphere because the near-side box had
 * been rejected on a NaN, a gap of 1.9957 m — the diameter.
 *
 * `-0` compares equal to `0`, so a direction component of `-0` takes the skip
 * branch too, which is the case that actually occurred.
 *
 * `far` starts at the best hit so far, so pruning falls out of the same test:
 * a box whose entry is beyond a hit already found cannot improve on it.
 */
function slab(
  bounds: Float64Array,
  node: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ix: number,
  iy: number,
  iz: number,
  best: number,
): number {
  const b = 6 * node;
  let near = 0;
  let far = best;

  if (dx !== 0) {
    let t1 = (bounds[b] - ox) * ix;
    let t2 = (bounds[b + 3] - ox) * ix;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
  } else if (ox < bounds[b] || ox > bounds[b + 3]) {
    return Infinity;
  }

  if (dy !== 0) {
    let t1 = (bounds[b + 1] - oy) * iy;
    let t2 = (bounds[b + 4] - oy) * iy;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
  } else if (oy < bounds[b + 1] || oy > bounds[b + 4]) {
    return Infinity;
  }

  if (dz !== 0) {
    let t1 = (bounds[b + 2] - oz) * iz;
    let t2 = (bounds[b + 5] - oz) * iz;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
  } else if (oz < bounds[b + 2] || oz > bounds[b + 5]) {
    return Infinity;
  }

  return near <= far ? near : Infinity;
}

/**
 * Möller–Trumbore, without backface culling.
 *
 * Culling is a rendering optimisation and this is a measurement. A visitor's
 * model may be an open shell, and a camera placed to see the concave side of one
 * would silently see through it — a miss reported where the geometry plainly has
 * a surface. So both sides hit, and {@link MeshHit.cosIncidence} carries the
 * sign for a caller that cares which side it met.
 *
 * Two tolerances, and the second one was got WRONG here first.
 *
 * `EPS` guards the determinant, i.e. a ray parallel to the triangle's plane.
 * Uncontroversial.
 *
 * `BARY_EPS` admits a hit slightly outside the triangle, and the first version
 * of this file argued against having one at all: widening the barycentric tests
 * makes adjacent triangles overlap along their shared edge, so a ray hitting the
 * seam hits both, and excluding the seam exactly looked like the reproducible
 * choice. That reasoning is wrong, and it was wrong in a way this repository had
 * already found and written down. Without the tolerance, a ray meeting a shared
 * edge is rejected by BOTH neighbours on opposite sides of the rounding and
 * falls straight through the surface. Measured on the fixture in
 * `test/mesh.test.ts`: **71 of 6624 edge rays, 1.07%, missed a CLOSED sphere** —
 * which is `docs/ARBITRARY-SHAPES.md`'s own figure for the same effect.
 *
 * Reproducible is not the same as correct. The dropped rays are not scattered:
 * a regular tessellation puts its seams on meridians, so the holes line up along
 * them and stay in the same place on every frame.
 *
 * The value matches `packages/sim`'s deliberately. These are two independent
 * implementations whose agreement is a tested result, and an edge tolerance is
 * exactly where a difference in the CONSTANT would put them at odds on a whole
 * class of rays by construction rather than by mistake. At 1e-9 in barycentric
 * units the enlargement is sub-nanometre on a metre-scale triangle, nine orders
 * below the tessellation error it sits inside. The cost is a seam ray hitting
 * both neighbours at the same `t`, and the nearest-hit search below then takes
 * one of them deterministically.
 *
 * This is a tolerance, not a watertightness proof. Woop et al. (2013) give a
 * ray-triangle test that is crack-free by construction, and `packages/sim`
 * records it as the upgrade if the mesh path ever has to carry a §7-style gate.
 * The same applies here, for the same reason.
 */
const EPS = 1e-12;
const BARY_EPS = 1e-9;

function rayTriangle(
  positions: Float64Array,
  ia: number,
  ib: number,
  ic: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const ax = positions[ia];
  const ay = positions[ia + 1];
  const az = positions[ia + 2];

  const e1x = positions[ib] - ax;
  const e1y = positions[ib + 1] - ay;
  const e1z = positions[ib + 2] - az;
  const e2x = positions[ic] - ax;
  const e2y = positions[ic + 1] - ay;
  const e2z = positions[ic + 2] - az;

  // p = d x e2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPS && det < EPS) return Infinity;
  const inv = 1 / det;

  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;

  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -BARY_EPS || u > 1 + BARY_EPS) return Infinity;

  // q = t x e1
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -BARY_EPS || u + v > 1 + BARY_EPS) return Infinity;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : Infinity;
}

/**
 * Nearest intersection of a unit ray with the mesh.
 *
 * `dir` must be normalized: `t` is then a distance in metres, which is what
 * every caller wants and what `SphereHit.t` already means.
 *
 * The traversal is nearest-child-first with the far child pushed only when it
 * can still beat the best hit so far. That ordering is what makes a BVH worth
 * building — a depth-first walk in index order visits the same boxes but cannot
 * prune, because it has no bound to prune against until it happens upon a hit.
 */
export function intersectMesh(index: MeshIndex, origin: Vec3, dir: Vec3): MeshHit {
  const { mesh, bounds, nodes, order } = index;
  const { positions, indices } = mesh;
  if (mesh.triangleCount === 0) return MISS;

  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;
  const dx = dir.x;
  const dy = dir.y;
  const dz = dir.z;
  const ix = 1 / dx;
  const iy = 1 / dy;
  const iz = 1 / dz;

  let best = Infinity;
  let bestTri = -1;

  const stack = new Int32Array(MAX_DEPTH);
  let sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    const node = stack[--sp];
    if (slab(bounds, node, ox, oy, oz, dx, dy, dz, ix, iy, iz, best) === Infinity) continue;

    const a = nodes[2 * node];
    const b = nodes[2 * node + 1];
    if (b >= 0) {
      // Leaf: `a` is the start of its span in `order`, `b` the count.
      triangleTests += b;
      for (let i = a; i < a + b; i++) {
        const t = order[i];
        const base = 3 * t;
        const hit = rayTriangle(
          positions,
          3 * indices[base],
          3 * indices[base + 1],
          3 * indices[base + 2],
          ox, oy, oz, dx, dy, dz,
        );
        if (hit < best) {
          best = hit;
          bestTri = t;
        }
      }
      continue;
    }

    // Interior: `a` is the left child, `b` encodes the right as `-right - 1`.
    const left = a;
    const right = -b - 1;
    const dl = slab(bounds, left, ox, oy, oz, dx, dy, dz, ix, iy, iz, best);
    const dr = slab(bounds, right, ox, oy, oz, dx, dy, dz, ix, iy, iz, best);
    if (sp + 2 > MAX_DEPTH) {
      throw new Error(
        `intersectMesh: traversal stack exceeded ${MAX_DEPTH} — the hierarchy is deeper than ` +
          'a median split over any real mesh can produce, so the tree is malformed',
      );
    }
    // Push the FAR child first so the near one is popped and bounded against
    // first; that is the whole of the pruning.
    if (dl <= dr) {
      if (dr !== Infinity) stack[sp++] = right;
      if (dl !== Infinity) stack[sp++] = left;
    } else {
      if (dl !== Infinity) stack[sp++] = left;
      if (dr !== Infinity) stack[sp++] = right;
    }
  }

  if (bestTri < 0) return MISS;

  const base = 3 * bestTri;
  const ia = 3 * indices[base];
  const ib = 3 * indices[base + 1];
  const ic = 3 * indices[base + 2];
  const e1x = positions[ib] - positions[ia];
  const e1y = positions[ib + 1] - positions[ia + 1];
  const e1z = positions[ib + 2] - positions[ia + 2];
  const e2x = positions[ic] - positions[ia];
  const e2y = positions[ic + 1] - positions[ia + 1];
  const e2z = positions[ic + 2] - positions[ia + 2];
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  // A zero-area triangle cannot be hit — `rayTriangle`'s determinant vanishes
  // with it — so reaching here with `len === 0` would mean the hit and the
  // normal disagree about which triangle was met.
  if (!(len > 0)) return MISS;
  nx /= len;
  ny /= len;
  nz /= len;

  const normal = { x: nx, y: ny, z: nz };
  return {
    hit: true,
    t: best,
    point: vAdd(origin, vScale(dir, best)),
    normal,
    cosIncidence: -(dx * nx + dy * ny + dz * nz),
    triangle: bestTri,
  };
}

/**
 * Radius of the origin-centred sphere that contains the model, metres.
 *
 * The mesh analogue of `BundleState.radiusM` — but only for the sense of that
 * field which means "how big is the thing". `radiusM` carries two roles in the
 * solver and they part company on a mesh: as a CONDITIONING constant (the DLT
 * divides world points by it before assembling its design matrix) any value of
 * the right order does, and as a SIZE it decides whether a camera is too far
 * away or a projector implausibly close. This is the second one.
 *
 * Origin-centred rather than a tight bounding sphere, because the world origin
 * is where the rest of the solver measures from — `conventions.ts` §W puts it at
 * the sphere centre, projectors are placed at a distance from it, and the model
 * arrives already positioned relative to it. A tight sphere around a model
 * parked off to one side would report a small radius for a large excursion.
 *
 * Read off the root node's bounds, so it costs a loop over eight corners and no
 * traversal at all.
 */
export function boundingRadiusM(index: MeshIndex): number {
  if (index.nodeCount === 0 || index.mesh.triangleCount === 0) return 0;
  const b = index.bounds;
  let worst = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = b[corner & 1 ? 3 : 0];
    const y = b[corner & 2 ? 4 : 1];
    const z = b[corner & 4 ? 5 : 2];
    const d = Math.hypot(x, y, z);
    if (d > worst) worst = d;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// The smooth normal: an EXPERIMENT, off by default
// ---------------------------------------------------------------------------

/**
 * Which normal `intersectMeshJacobian` differentiates against.
 *
 * `'facet'` is the surface the ray actually met: exact within a triangle, the
 * mode every production caller uses, and the only one the central-difference
 * tests can hold to. `'smooth'` is the normal of the surface the tessellation
 * STANDS IN FOR — per-vertex normals interpolated at the hit — and exists for
 * one measurement, recorded in docs/ARBITRARY-SHAPES.md: whether a nearly
 * spherical mesh recovers worse than the analytic sphere because every step
 * carries the facet's derivative rather than the curve's. It makes the Jacobian
 * describe a surface the residual is not on, trading exactness for smoothness
 * on purpose; `BundleOptions.meshNormal` selects it and defaults to `'facet'`.
 *
 * It also presumes a body WITHOUT creases. Where two panels share vertices
 * across a fold — or a file carries normals smoothed across one — the
 * interpolated normal at the edge is the bisector of two facet normals, so the
 * derivative's singular set moves from "ray in the facet's plane" to "ray in
 * the interpolated tangent plane", which a ray can reach at ordinary incidence
 * on either panel; the only guard is the 1e-12 clamp on the denominator. The
 * fixtures the measurement used are closed ellipsoids with no crease. Were this
 * mode ever to ship, falling back to the facet normal where the interpolated
 * incidence collapses relative to the facet's would be the obvious guard, and
 * it has not been built because nothing has been measured with it.
 */
export type MeshNormalMode = 'facet' | 'smooth';

const vertexNormalCache = new WeakMap<MeshIndex, Float64Array>();

/**
 * Per-vertex unit normals: the file's own when `SurfaceMesh.normals` carries
 * them — the same choice `packages/sim`'s shading makes — else derived from the
 * winding, each triangle's unnormalised cross product (so area-weighted) summed
 * at its three corners and normalised. Cached per index. A vertex no
 * non-degenerate triangle touches keeps a zero normal — and can never be a
 * corner of a hit, since `intersectMesh` rejects a degenerate triangle — while
 * the interpolation falls back to the facet only where the weighted sum of the
 * three corner normals vanishes.
 */
function vertexNormalsOf(index: MeshIndex): Float64Array {
  const cached = vertexNormalCache.get(index);
  if (cached !== undefined) return cached;
  const { positions, indices, vertexCount, triangleCount, normals: own } = index.mesh;
  let normals: Float64Array;
  if (own !== null && own.length === 3 * vertexCount) {
    normals = own;
  } else {
    normals = new Float64Array(3 * vertexCount);
    for (let tri = 0; tri < triangleCount; tri++) {
      const ia = 3 * indices[3 * tri];
      const ib = 3 * indices[3 * tri + 1];
      const ic = 3 * indices[3 * tri + 2];
      const e1x = positions[ib] - positions[ia];
      const e1y = positions[ib + 1] - positions[ia + 1];
      const e1z = positions[ib + 2] - positions[ia + 2];
      const e2x = positions[ic] - positions[ia];
      const e2y = positions[ic + 1] - positions[ia + 1];
      const e2z = positions[ic + 2] - positions[ia + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      for (const i of [ia, ib, ic]) {
        normals[i] += nx;
        normals[i + 1] += ny;
        normals[i + 2] += nz;
      }
    }
    for (let v = 0; v < vertexCount; v++) {
      const len = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]);
      if (len > 0) {
        normals[3 * v] /= len;
        normals[3 * v + 1] /= len;
        normals[3 * v + 2] /= len;
      }
    }
  }
  vertexNormalCache.set(index, normals);
  return normals;
}

/**
 * The interpolated normal at a hit: the barycentric weights of `hit.point` in
 * its triangle applied to the corner normals, renormalised. Sign and scale do
 * not reach the derivative — `dt = -(n . do + t n . dd) / (n . d)` is invariant
 * to both — so a file's inward normals serve as well as outward ones. Falls
 * back to the facet normal where the interpolation vanishes.
 */
function smoothNormalAt(index: MeshIndex, hit: MeshHit): Vec3 {
  const { positions, indices } = index.mesh;
  const vn = vertexNormalsOf(index);
  const base = 3 * hit.triangle;
  const ia = 3 * indices[base];
  const ib = 3 * indices[base + 1];
  const ic = 3 * indices[base + 2];
  const ax = positions[ia];
  const ay = positions[ia + 1];
  const az = positions[ia + 2];
  const v0x = positions[ib] - ax;
  const v0y = positions[ib + 1] - ay;
  const v0z = positions[ib + 2] - az;
  const v1x = positions[ic] - ax;
  const v1y = positions[ic + 1] - ay;
  const v1z = positions[ic + 2] - az;
  const v2x = hit.point.x - ax;
  const v2y = hit.point.y - ay;
  const v2z = hit.point.z - az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const denom = d00 * d11 - d01 * d01;
  if (!(Math.abs(denom) > 0)) return hit.normal;
  // `point = a + wb (b - a) + wc (c - a)`; the corner weights follow.
  const wb = (d11 * d20 - d01 * d21) / denom;
  const wc = (d00 * d21 - d01 * d20) / denom;
  const wa = 1 - wb - wc;
  const nx = wa * vn[ia] + wb * vn[ib] + wc * vn[ic];
  const ny = wa * vn[ia + 1] + wb * vn[ib + 1] + wc * vn[ic + 1];
  const nz = wa * vn[ia + 2] + wb * vn[ib + 2] + wc * vn[ic + 2];
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0)) return hit.normal;
  return { x: nx / len, y: ny / len, z: nz / len };
}

// ---------------------------------------------------------------------------
// The derivative
// ---------------------------------------------------------------------------

/**
 * `intersectMeshJacobian`'s result, matching `SphereHitJacobian`.
 */
export interface MeshHitJacobian {
  hit: MeshHit;
  /** d(point)/d(camera params), `3 x CAM_PARAM_COUNT` row-major. */
  dPoint: Float64Array;
}

/**
 * Analytic derivative of the surface point with respect to the camera.
 *
 * ## The one line that differs from the sphere
 *
 * `intersectSphereJacobian` factors into three parts, and only ONE of them
 * knows what surface it is on. The canonical ray `(1, -x, y)`, the rotation
 * derivatives, the normalisation projector `(I - d d^T)/|w|`, and the velocity
 * chain on `pose(t) = pose + velocity * dt` are all statements about a camera
 * and carry over unchanged. What is sphere-specific is `dt`, and for a plane it
 * is simpler than for a quadric.
 *
 * The hit lies on the facet's plane, so with `n` the unit face normal and `A`
 * one of its corners, `n . (o + t d - A) = 0` for all parameter values.
 * Differentiating in place — rather than re-deriving the root, which is the same
 * trick the sphere version uses —
 *
 *     n . do + dt (n . d) + t (n . dd) = 0
 *     dt = -(n . do + t (n . dd)) / (n . d)
 *
 * and then `dX = do + t dd + d dt` as before. `n . d` is `-cosIncidence`, so the
 * denominator vanishes exactly when the ray runs parallel to the facet — the
 * analogue of the sphere's limb, and guarded the same way.
 *
 * ## What this derivative is honestly not
 *
 * **It is exact WITHIN a facet and undefined ACROSS one.** The surface is C0 and
 * not C1: as the camera moves, the hit crosses from one triangle to its
 * neighbour and the normal changes discontinuously, so the true derivative does
 * not exist on that set and the two one-sided limits disagree by the dihedral
 * angle. This returns the derivative of the facet the ray actually met, which is
 * the right-hand limit approaching from wherever the camera currently is.
 *
 * Two consequences worth stating rather than discovering:
 *
 *  1. A Gauss-Newton step that crosses a facet boundary lands somewhere the
 *     linearisation did not predict. That is a question about CONVERGENCE, and
 *     it is answerable by running the bench rather than by argument — which is
 *     the honest place to leave it.
 *  2. The derivative describes the TESSELLATION, not the shape the tessellation
 *     approximates. On a mesh standing in for a smooth surface, the residual
 *     will carry the faceting. That is a modelling statement about the input,
 *     not an error here, and it is the same statement {@link MeshHit.normal}
 *     already makes about the flat normal.
 *
 * ## The smooth-normal mode, and what it gives up
 *
 * `normalMode: 'smooth'` swaps `n` — and only `n` — for the interpolated vertex
 * normal at the hit ({@link MeshNormalMode}). Everything else is the same
 * arithmetic: the hit is still the facet's, `t` is still the facet's, and the
 * residual the bundle computes from `point` does not change. What changes is
 * the tangent plane the derivative believes the hit slides along: the curve's,
 * not the facet's. So on a tessellated sphere the smooth derivative converges
 * to `sphere.ts`'s closed form at SECOND order where the facet's converges at
 * first — WHEN the vertex normals are themselves second-order accurate: a
 * file's own normals, or derived normals on a tessellation whose vertex fans
 * are centrally symmetric, which the UV grid every fixture here uses is away
 * from its poles (each duplicated pole vertex touches one triangle, so its
 * derived normal is that facet's and first-order). On an
 * irregular tessellation the area-weighted derived normal is only first-order
 * accurate and so is this mode, with about a third of the facet's constant
 * (measured on a 30%-jittered UV sphere: 2.6e-2 → 6.6e-3 → 1.7e-3 against the
 * facet's 7.6e-2 → 1.9e-2 → 4.9e-3 across three refinements). And it no longer
 * differentiates exactly what the residual computes, which is why the
 * central-difference tests run the default and only the default. It is an
 * experiment with one question, measured in docs/ARBITRARY-SHAPES.md, and not a
 * mode a production caller selects.
 *
 * ## On not sharing code with `sphere.ts`
 *
 * The camera machinery above is duplicated rather than extracted, and that is
 * deliberate for now: the sphere path is byte-identical across this whole phase
 * (`bench-baseline.json`, 203 digests) and the cheapest way to keep it that way
 * is for it not to enter new code at all. The duplication is ~25 lines and both
 * copies are pinned by central-difference tests, so a divergence between them
 * fails a test rather than silently biasing a solve. If a third surface ever
 * appears, extract then.
 */
export function intersectMeshJacobian(
  index: MeshIndex,
  cam: CameraModel,
  x: number,
  y: number,
  precomputedRotation?: RotationWithDerivatives,
  out?: Float64Array,
  /** Elapsed frames from the reference epoch; fills the six velocity columns. */
  dtFrames?: number,
  /** d(x, y)/d(focalScale); fills the focal column. */
  dNormalized?: { dx: number; dy: number },
  /** Which normal to differentiate against. See {@link MeshNormalMode}. */
  normalMode: MeshNormalMode = 'facet',
): MeshHitJacobian {
  const dPoint = out ?? new Float64Array(3 * CAM_PARAM_COUNT);
  dPoint.fill(0);
  const rot =
    precomputedRotation ?? rotationWithDerivatives(cam.yawDeg, cam.pitchDeg, cam.rollDeg);
  const canonical = { x: 1, y: -x, z: y };
  const raw = mat3MulVec(rot.r, canonical);
  const len = vNorm(raw);
  const dir = vScale(raw, 1 / len);
  const origin = cam.position;

  const hit = intersectMesh(index, origin, dir);
  if (!hit.hit) return { hit, dPoint };

  const t = hit.t;
  const n = normalMode === 'smooth' ? smoothNormalAt(index, hit) : hit.normal;
  // `n . d`: in facet mode `-cosIncidence`, zero exactly when the ray runs in
  // the facet's plane, where `t` is not a differentiable function of anything.
  // In smooth mode it is the incidence against the interpolated normal, and it
  // vanishes when the ray runs in the interpolated tangent plane — a different
  // plane, which beside a crease can be reached at healthy facet incidence
  // (see {@link MeshNormalMode}).
  let denom = n.x * dir.x + n.y * dir.y + n.z * dir.z;
  if (Math.abs(denom) < 1e-12) denom = denom >= 0 ? 1e-12 : -1e-12;

  // --- translation: do = e_i, dd = 0, so dt = -n_i / (n . d) ---
  for (let i = 0; i < 3; i++) {
    const ndo = i === 0 ? n.x : i === 1 ? n.y : n.z;
    const dt = -ndo / denom;
    dPoint[0 * CAM_PARAM_COUNT + i] = (i === 0 ? 1 : 0) + dir.x * dt;
    dPoint[1 * CAM_PARAM_COUNT + i] = (i === 1 ? 1 : 0) + dir.y * dt;
    dPoint[2 * CAM_PARAM_COUNT + i] = (i === 2 ? 1 : 0) + dir.z * dt;
  }

  // --- anything that moves the unnormalised direction and nothing else ---
  // Rotation and focal both land here, exactly as on the sphere: the camera
  // stays put, `w` changes, and only the source of `dw` differs.
  const dirSlot = (dw: Vec3, slot: number): void => {
    const proj = vDot(dir, dw);
    const dd = {
      x: (dw.x - dir.x * proj) / len,
      y: (dw.y - dir.y * proj) / len,
      z: (dw.z - dir.z * proj) / len,
    };
    // do = 0, so dt = -t (n . dd) / (n . d).
    const dt = (-t * (n.x * dd.x + n.y * dd.y + n.z * dd.z)) / denom;
    dPoint[0 * CAM_PARAM_COUNT + slot] = t * dd.x + dir.x * dt;
    dPoint[1 * CAM_PARAM_COUNT + slot] = t * dd.y + dir.y * dt;
    dPoint[2 * CAM_PARAM_COUNT + slot] = t * dd.z + dir.z * dt;
  };
  dirSlot(mat3MulVec(rot.dYaw, canonical), CAM_YAW);
  dirSlot(mat3MulVec(rot.dPitch, canonical), CAM_PITCH);
  dirSlot(mat3MulVec(rot.dRoll, canonical), CAM_ROLL);

  if (dNormalized !== undefined) {
    dirSlot(mat3MulVec(rot.r, { x: 0, y: -dNormalized.dx, z: dNormalized.dy }), CAM_FOCAL);
  }

  // --- velocity: exact, because the effective pose is affine in the rate ---
  if (dtFrames !== undefined && dtFrames !== 0) {
    for (let slot = CAM_VPX; slot <= CAM_VROLL; slot++) {
      const src = CAM_VELOCITY_OF[slot];
      dPoint[0 * CAM_PARAM_COUNT + slot] = dtFrames * dPoint[0 * CAM_PARAM_COUNT + src];
      dPoint[1 * CAM_PARAM_COUNT + slot] = dtFrames * dPoint[1 * CAM_PARAM_COUNT + src];
      dPoint[2 * CAM_PARAM_COUNT + slot] = dtFrames * dPoint[2 * CAM_PARAM_COUNT + src];
    }
  }

  return { hit, dPoint };
}

// ---------------------------------------------------------------------------
// Geometric segmentation for a body that is not the sphere
// ---------------------------------------------------------------------------

/** What {@link meshSegmenter} needs to decide whether a projector pixel lands on the model. */
export interface MeshSegmentation {
  /**
   * The solver's own hierarchy over the body in the room. The NOMINAL geometry
   * — the mesh the operator supplied, standing where the configuration says it
   * stands — never a mesh built from anything the solver is trying to recover.
   */
  index: MeshIndex;
  /**
   * The projector calibration to test against, indexed by the correspondence's
   * projector index. The NOMINAL one — what the operator starts from — never
   * the truth, exactly as `SphereSegmentation.projectors` requires.
   */
  projectors: readonly ProjectorModel[];
}

/**
 * The mesh counterpart of {@link sphereSegmenter}: keep a correspondence only
 * when the projector pixel that produced it actually strikes the body.
 *
 * The sphere version asks `intersectSphere(...).hit` and this asks
 * `intersectMesh(...).hit`. That is the entire difference, and it is the point:
 * the guard the bench applies to a mesh scenario reads that "both segmenters fit
 * a CIRCLE to the sphere's silhouette", which is true of the IMAGE-space
 * detector in `silhouette.ts` and was never true of this one. The geometric
 * segmenter is a ray cast, and a ray cast against a mesh is a ray cast against a
 * mesh. Nothing here fits a circle, projects a centre, or assumes a radius.
 *
 * NO MARGIN, and unlike the sphere's zero default that is not a measurement
 * waiting to be revisited — it is that the sphere's margin has no mesh analogue.
 * `SphereSegmentation.marginFrac` scales one number, R, and docs/EXPERIMENT-4.md
 * measured that inflating it costs more than it buys, because a ray threaded
 * between R and (1 + margin) R misses the ball and flies on to the wall.
 * Inflating a mesh is not one number: it is an offset surface, which self-
 * intersects wherever the body's concavities are tighter than the offset, and
 * the tri-axial and concave bodies this exists for are exactly where that bites.
 * A caller who wants the limb points back should say so with a different
 * predicate rather than have this one guess at a dilation.
 *
 * The failure mode this shares with the sphere version, deliberately: a
 * correspondence naming a projector the caller did not describe is REJECTED, not
 * passed. Passing would make the option silently partial in the one direction
 * that admits the points it exists to remove.
 */
export function meshSegmenter(seg: MeshSegmentation): (
  projector: number,
  u: number,
  v: number,
) => boolean {
  return (projector: number, u: number, v: number): boolean => {
    const model = seg.projectors[projector];
    if (model === undefined) return false;
    const dir = projectorPixelToRay(model, u, v);
    return intersectMesh(seg.index, model.position, dir).hit;
  };
}
