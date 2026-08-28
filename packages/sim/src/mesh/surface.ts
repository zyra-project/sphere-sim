// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `MeshSurface` — the second implementation of `Surface`, and the one that makes
 * the interface mean something.
 *
 * `docs/ARBITRARY-SHAPES.md` Phase 1. Phase 0 collected "what shape is this"
 * behind an interface with one implementation, which proves nothing on its own:
 * an abstraction with a single implementor is a rename. This is the second, and
 * everything it cannot do cleanly is a real finding about the interface rather
 * than a hypothetical.
 *
 * ## The two findings, stated up front
 *
 * **1. `pointAt` is not invertible on a mesh, and the interface asked for it.**
 * On a sphere, "give me the surface point at this content coordinate" is a
 * closed form. On a mesh it is a search: a UV maps to a point only if some
 * triangle's UV triangle contains it, there may be several such triangles (a UV
 * set is allowed to overlap), and there may be none (an unwrapped mesh has gaps
 * between islands). It is implemented here by a UV-space lookup built at
 * construction, and it returns the first match in triangle order — deterministic,
 * but a choice rather than an answer. Callers that sample the surface should use
 * {@link MeshSurface.sampleArea}, which has no such ambiguity.
 *
 * **2. The content coordinate really did have to widen, and it widened cheaply.**
 * `SurfaceCoord` is still `{ latDeg, lonDeg }` because Phase 0 could not justify
 * changing it. A mesh has UVs in [0, 1]², so this maps them onto the same two
 * numbers through the equirectangular convention `sampleEquirect` already
 * defines — `u = (lon + 180) / 360`, `v = (90 - lat) / 180` — inverted. That is
 * not a fudge: it means a mesh whose unwrap is an equirectangular projection
 * shows exactly the content a sphere would, which is the behaviour anyone
 * dropping a dome model expects. It does mean `latDeg`/`lonDeg` are a transport
 * for UV rather than a geographic fact, which is recorded in
 * `docs/ARBITRARY-SHAPES.md` as the thing Phase 2 should rename.
 *
 * ## What a mesh has that a sphere does not
 *
 * Self-occlusion. A sphere is convex, so `dot(normal, lens - point) > 0` is the
 * whole visibility test and `coverage.ts` said so for the whole of Phase 0. A
 * mesh occludes itself, and {@link MeshSurface.shadowed} is the query that
 * answers it — now on the `Surface` interface and called by `isIlluminatedAt`,
 * which is what the previous revision of this note said would happen "in the
 * commit that makes that change measurable".
 */

import type { SurfaceMesh, Vec3 } from '../../../calibration/src/index.ts';
import type { Surface, SurfaceAreaSample, SurfaceCoord, SurfaceHit } from '../surface.ts';
import type { Bvh } from './bvh.ts';
import { buildBvh, intersectBvh, meshBounds, occludedBvh } from './bvh.ts';
import type { MeshBounds } from './bvh.ts';

/**
 * UV -> the equirectangular `SurfaceCoord` the rest of the model speaks.
 *
 * The exact inverse of `equirect.ts`'s `sampleEquirect`, which reads
 * `u = (lon + 180) / 360` and `v = (90 - lat) / 180`. Round-tripping through
 * these two is what lets a dome unwrapped equirectangularly show the same map a
 * sphere would.
 */
export function uvToCoord(u: number, v: number): SurfaceCoord {
  return { latDeg: 90 - v * 180, lonDeg: u * 360 - 180 };
}

/** Inverse of {@link uvToCoord}. */
export function coordToUv(coord: SurfaceCoord): { u: number; v: number } {
  return { u: (coord.lonDeg + 180) / 360, v: (90 - coord.latDeg) / 180 };
}

/**
 * A triangle mesh as a `Surface`.
 *
 * Built once per mesh: the hierarchy, the per-triangle areas and the cumulative
 * area table all live on the instance. `prepareRig` shares one instance across
 * every projector for exactly this reason.
 */
export class MeshSurface implements Surface {
  readonly kind = 'mesh' as const;
  readonly mesh: SurfaceMesh;
  readonly bounds: MeshBounds;
  readonly boundsRadiusM: number;

  private readonly bvh: Bvh;
  /** Cumulative triangle area, for the equal-area sampler. `cdf[n-1]` is the total. */
  private readonly cdf: Float64Array;
  /** Geometric (flat) unit normal per triangle, from the winding. */
  private readonly faceNormals: Float64Array;

  constructor(mesh: SurfaceMesh) {
    if (mesh.positions.length !== 3 * mesh.vertexCount) {
      throw new Error(
        `mesh positions hold ${mesh.positions.length} values for ${mesh.vertexCount} vertices`,
      );
    }
    if (mesh.indices.length !== 3 * mesh.triangleCount) {
      throw new Error(
        `mesh indices hold ${mesh.indices.length} values for ${mesh.triangleCount} triangles`,
      );
    }
    this.mesh = mesh;
    this.bvh = buildBvh(mesh);
    this.bounds = meshBounds(mesh);
    this.boundsRadiusM = this.bounds.radiusM;

    const n = mesh.triangleCount;
    this.cdf = new Float64Array(n);
    this.faceNormals = new Float64Array(3 * n);
    const p = mesh.positions;
    const idx = mesh.indices;
    let acc = 0;
    for (let t = 0; t < n; t++) {
      const a = 3 * idx[3 * t];
      const b = 3 * idx[3 * t + 1];
      const c = 3 * idx[3 * t + 2];
      const e1x = p[b] - p[a];
      const e1y = p[b + 1] - p[a + 1];
      const e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a];
      const e2y = p[c + 1] - p[a + 1];
      const e2z = p[c + 2] - p[a + 2];
      // The cross product's magnitude is twice the triangle area, and its
      // direction is the outward normal for counter-clockwise winding.
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        this.faceNormals[3 * t] = nx / len;
        this.faceNormals[3 * t + 1] = ny / len;
        this.faceNormals[3 * t + 2] = nz / len;
      }
      // A degenerate triangle has zero area and therefore zero probability of
      // being sampled, which is the correct treatment rather than a special case.
      acc += 0.5 * len;
      this.cdf[t] = acc;
    }
  }

  /** Total surface area, square metres. What `sampleArea` divides by. */
  get areaM2(): number {
    const n = this.mesh.triangleCount;
    return n === 0 ? 0 : this.cdf[n - 1];
  }

  intersect(origin: Vec3, dir: Vec3, tMin = 1e-9): SurfaceHit | null {
    const hit = intersectBvh(this.bvh, this.mesh, origin, dir, tMin, Infinity);
    if (hit === null) return null;
    const point: Vec3 = {
      x: origin.x + dir.x * hit.t,
      y: origin.y + dir.y * hit.t,
      z: origin.z + dir.z * hit.t,
    };
    return { t: hit.t, point, normal: this.normalOfHit(hit.triangle, hit.u, hit.v) };
  }

  /**
   * Is the segment from `origin` to `origin + dir * distance` blocked by the
   * mesh itself?
   *
   * The general form. {@link MeshSurface.shadowed} is the `Surface` method built
   * on it, and this stays public because a caller that already knows the
   * direction and the distance — a shading loop that computed both to get the
   * inverse-square falloff — should not pay to have them derived again.
   */
  occluded(origin: Vec3, dir: Vec3, distance: number, tMin = SHADOW_BIAS_FRACTION): boolean {
    return occludedBvh(this.bvh, this.mesh, origin, dir, tMin, distance);
  }

  /**
   * The facing test, on the surface's REAL normal.
   *
   * `SphereSurface` can substitute the position for the normal because a sphere
   * centred on the origin has them parallel. Nothing else does, and a mesh that
   * borrowed that shortcut would light every face whose position happens to
   * point away from the world origin — which for a model that is not centred on
   * the origin is most of them.
   */
  facesLens(point: Vec3, normal: Vec3, lens: Vec3): boolean {
    return (
      normal.x * (lens.x - point.x) +
        normal.y * (lens.y - point.y) +
        normal.z * (lens.z - point.z) >
      0
    );
  }

  /**
   * Does the model come between this point and the lens?
   *
   * The query Phase 1 exists to make possible, and the one that turns a coverage
   * map from a statement about angles into a statement about a room: a dome's
   * own rim shading its floor, a set piece behind a wall, the far side of a
   * torus. On a sphere the answer is always no, which is why `coverage.ts` was
   * able to ignore the question until now.
   *
   * ## The bias, and why it scales with the model
   *
   * A ray leaving the surface it is standing on will hit that surface at `t`
   * near zero unless it is told not to. A fixed epsilon cannot do that job for
   * both a 30 cm prop and a 30 m facade — too small and every point shadows
   * itself into blackness, too large and a thin panel stops casting a shadow
   * onto whatever is a few millimetres behind it. So the bias is a fraction of
   * the bounding radius, which is the only length scale the surface knows.
   */
  shadowed(point: Vec3, lens: Vec3): boolean {
    const dx = lens.x - point.x;
    const dy = lens.y - point.y;
    const dz = lens.z - point.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance === 0) return false;
    const inv = 1 / distance;
    const bias = SHADOW_BIAS_FRACTION * Math.max(this.boundsRadiusM, Number.MIN_VALUE);
    return occludedBvh(
      this.bvh,
      this.mesh,
      point,
      { x: dx * inv, y: dy * inv, z: dz * inv },
      bias,
      distance,
    );
  }

  coordAt(point: Vec3): SurfaceCoord {
    // The nearest point on the surface decides the coordinate, found by asking
    // the hierarchy which triangle a ray from just outside would meet. A caller
    // holding a hit already knows the answer more cheaply, which is why
    // `intersect` returns it; this path exists for a world point that arrived
    // some other way.
    const nearest = this.nearestTriangle(point);
    if (nearest === null) return { latDeg: 0, lonDeg: 0 };
    return this.coordOfTriangle(nearest.triangle, nearest.u, nearest.v);
  }

  /**
   * The surface point at a content coordinate.
   *
   * See the module note: this is a search, not an inverse, and it returns the
   * first triangle in index order whose UV triangle contains the coordinate.
   * Returns the mesh centre when the coordinate falls in a gap between UV
   * islands — a defined answer rather than a NaN, because the callers that reach
   * here are building field maps over a regular lat/lon grid and a NaN there
   * would poison an integral rather than leave a hole.
   */
  pointAt(coord: SurfaceCoord): Vec3 {
    const uvs = this.mesh.uvs;
    if (uvs === null) return this.bounds.centre;
    const { u, v } = coordToUv(coord);
    const idx = this.mesh.indices;
    const p = this.mesh.positions;
    for (let t = 0; t < this.mesh.triangleCount; t++) {
      const i0 = idx[3 * t];
      const i1 = idx[3 * t + 1];
      const i2 = idx[3 * t + 2];
      const bary = baryInUvTriangle(
        u, v,
        uvs[2 * i0], uvs[2 * i0 + 1],
        uvs[2 * i1], uvs[2 * i1 + 1],
        uvs[2 * i2], uvs[2 * i2 + 1],
      );
      if (bary === null) continue;
      const w0 = 1 - bary.u - bary.v;
      return {
        x: w0 * p[3 * i0] + bary.u * p[3 * i1] + bary.v * p[3 * i2],
        y: w0 * p[3 * i0 + 1] + bary.u * p[3 * i1 + 1] + bary.v * p[3 * i2 + 1],
        z: w0 * p[3 * i0 + 2] + bary.u * p[3 * i1 + 2] + bary.v * p[3 * i2 + 2],
      };
    }
    return this.bounds.centre;
  }

  normalAt(point: Vec3): Vec3 {
    const nearest = this.nearestTriangle(point);
    if (nearest === null) return { x: 0, y: 0, z: 1 };
    return this.normalOfHit(nearest.triangle, nearest.u, nearest.v);
  }

  /**
   * `n` points spread over the surface, each standing for the same area.
   *
   * Area-weighted triangle sampling: pick a triangle with probability
   * proportional to its area, then a point uniformly inside it. That is the
   * mesh's answer to the Fibonacci lattice, and it has the same property the
   * lattice was chosen for — every sample carries the same weight, so an
   * ordinary mean is already an area-weighted mean and there is no weight for a
   * metric to forget (`metrics/sampling.ts` explains why that matters).
   *
   * **Deterministic, with no seed**, matching the lattice it replaces. The
   * triangle is chosen by stratifying the cumulative-area axis — sample `i`
   * takes `(i + 0.5) / n` of the total area — and the point inside it comes from
   * a radical inverse rather than a PRNG. Two runs therefore produce identical
   * samples, which `packages/sim/README.md` requires and the bench relies on
   * absolutely.
   */
  sampleArea(n: number): SurfaceAreaSample[] {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`sample count must be a positive integer, got ${n}`);
    }
    const out = new Array<SurfaceAreaSample>(n);
    const total = this.areaM2;
    const p = this.mesh.positions;
    const idx = this.mesh.indices;
    if (total <= 0 || this.mesh.triangleCount === 0) {
      const c = this.bounds.centre;
      for (let i = 0; i < n; i++) {
        out[i] = { point: c, normal: { x: 0, y: 0, z: 1 }, coord: { latDeg: 0, lonDeg: 0 } };
      }
      return out;
    }

    for (let i = 0; i < n; i++) {
      const target = ((i + 0.5) / n) * total;
      const t = this.triangleAtArea(target);
      // Uniform in the triangle: the square root warps the unit square onto the
      // simplex without bias. A plain (r1, r2) pair would pile samples into one
      // corner, which on a long thin triangle is a visible clump.
      const r1 = radicalInverse2(i + 1);
      const r2 = radicalInverse3(i + 1);
      const s = Math.sqrt(r1);
      const bu = 1 - s;
      const bv = r2 * s;
      const i0 = idx[3 * t];
      const i1 = idx[3 * t + 1];
      const i2 = idx[3 * t + 2];
      const w0 = 1 - bu - bv;
      const point: Vec3 = {
        x: w0 * p[3 * i0] + bu * p[3 * i1] + bv * p[3 * i2],
        y: w0 * p[3 * i0 + 1] + bu * p[3 * i1 + 1] + bv * p[3 * i2 + 1],
        z: w0 * p[3 * i0 + 2] + bu * p[3 * i1 + 2] + bv * p[3 * i2 + 2],
      };
      out[i] = {
        point,
        normal: this.normalOfHit(t, bu, bv),
        coord: this.coordOfTriangle(t, bu, bv),
      };
    }
    return out;
  }

  /** Binary search of the cumulative-area table. */
  private triangleAtArea(target: number): number {
    let lo = 0;
    let hi = this.mesh.triangleCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Shading normal at a barycentric point: the file's own vertex normals when it
   * supplied them, the triangle's geometric normal otherwise.
   *
   * Interpolated vertex normals are renormalized — the linear combination of
   * three unit vectors is not a unit vector, and an un-normalized normal walks
   * straight into every `dot(normal, toLens)` in the shading chain as a scale
   * error that varies across each triangle.
   */
  private normalOfHit(triangle: number, u: number, v: number): Vec3 {
    const normals = this.mesh.normals;
    if (normals === null) {
      return {
        x: this.faceNormals[3 * triangle],
        y: this.faceNormals[3 * triangle + 1],
        z: this.faceNormals[3 * triangle + 2],
      };
    }
    const idx = this.mesh.indices;
    const i0 = 3 * idx[3 * triangle];
    const i1 = 3 * idx[3 * triangle + 1];
    const i2 = 3 * idx[3 * triangle + 2];
    const w0 = 1 - u - v;
    const nx = w0 * normals[i0] + u * normals[i1] + v * normals[i2];
    const ny = w0 * normals[i0 + 1] + u * normals[i1 + 1] + v * normals[i2 + 1];
    const nz = w0 * normals[i0 + 2] + u * normals[i1 + 2] + v * normals[i2 + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) {
      return {
        x: this.faceNormals[3 * triangle],
        y: this.faceNormals[3 * triangle + 1],
        z: this.faceNormals[3 * triangle + 2],
      };
    }
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /** Interpolated content coordinate at a barycentric point. */
  private coordOfTriangle(triangle: number, u: number, v: number): SurfaceCoord {
    const uvs = this.mesh.uvs;
    if (uvs === null) return { latDeg: 0, lonDeg: 0 };
    const idx = this.mesh.indices;
    const i0 = 2 * idx[3 * triangle];
    const i1 = 2 * idx[3 * triangle + 1];
    const i2 = 2 * idx[3 * triangle + 2];
    const w0 = 1 - u - v;
    return uvToCoord(
      w0 * uvs[i0] + u * uvs[i1] + v * uvs[i2],
      w0 * uvs[i0 + 1] + u * uvs[i1 + 1] + v * uvs[i2 + 1],
    );
  }

  /**
   * The triangle a world point lies on, found by shooting a short ray INWARD at
   * it from just outside, along the direction from the bounds centre.
   *
   * A true closest-point-on-mesh query would be the general answer and is much
   * heavier; every caller in this package hands over a point that came off the
   * surface in the first place, so the cheap version answers the question they
   * are actually asking. A point genuinely off the surface gets `null` and the
   * caller's documented fallback.
   *
   * ## Why the window is a percent of the model and not a few microns
   *
   * The obvious version shoots outward from a hair inside the point, with a
   * micron of slack. It fails on the one case that matters most, and
   * `test/mesh-surface.test.ts` caught it: a tessellated sphere is INSCRIBED in
   * the sphere it approximates, so a point computed analytically on that sphere
   * sits OUTSIDE the mesh by the chord sag — 4 mm on a 0.86 m ball at 32x16, four
   * thousand times a micron. A ray fired outward from there never turns round,
   * and every content coordinate on the model came back as the fallback.
   *
   * So: start OUTSIDE by {@link SEARCH_FRACTION} of the bounding radius and
   * travel inward twice that, which brackets a point sitting either side of the
   * surface. Inward also picks the near wall first on a thin shell, which is the
   * one the point belongs to.
   */
  private nearestTriangle(point: Vec3): { triangle: number; u: number; v: number } | null {
    const c = this.bounds.centre;
    let dx = point.x - c.x;
    let dy = point.y - c.y;
    let dz = point.z - c.z;
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return null;
    dx /= len;
    dy /= len;
    dz /= len;
    const window = SEARCH_FRACTION * Math.max(this.boundsRadiusM, Number.MIN_VALUE);
    const origin: Vec3 = {
      x: point.x + dx * window,
      y: point.y + dy * window,
      z: point.z + dz * window,
    };
    const hit = intersectBvh(
      this.bvh,
      this.mesh,
      origin,
      { x: -dx, y: -dy, z: -dz },
      0,
      2 * window,
    );
    return hit === null ? null : { triangle: hit.triangle, u: hit.u, v: hit.v };
  }
}

/**
 * How far either side of the surface {@link MeshSurface.coordAt} and
 * {@link MeshSurface.normalAt} will look for the triangle a point belongs to,
 * as a fraction of the bounding radius.
 *
 * One percent. It has to exceed the chord sag of a COARSE tessellation — 1.1% of
 * the radius at 32x16 on a sphere — or an analytically-computed surface point
 * falls outside the search and reports the fallback coordinate. It also has to
 * stay well under the wall spacing of a thin shell, or the search could reach
 * past the near wall to the far one; inward-first ordering already prevents
 * that, so the constraint that binds is the first.
 */
const SEARCH_FRACTION = 0.01;

/**
 * How far a shadow ray steps off the surface before it starts looking, as a
 * fraction of the bounding radius.
 *
 * A ray leaving the surface it stands on hits that surface at `t` near zero.
 * The step past it has to be larger than the floating-point error in the hit
 * point and smaller than the thinnest gap the model needs to cast a shadow
 * across — and both of those scale with the model, which is why this is a
 * fraction rather than a length. One part in a million of the bounding radius
 * is about a micron on a metre-scale prop and a millimetre on a kilometre of
 * terrain.
 */
const SHADOW_BIAS_FRACTION = 1e-6;

/** {@link MeshSurface}, for callers that would rather not write `new`. */
export function meshSurface(mesh: SurfaceMesh): MeshSurface {
  return new MeshSurface(mesh);
}

/**
 * Barycentric coordinates of `(u, v)` inside a UV triangle, or `null` when it
 * falls outside.
 *
 * The tolerance admits a point exactly on an edge to both triangles that share
 * it, which is deliberate: a UV grid sample landing on a shared edge should
 * resolve to a surface point rather than to a gap, and either neighbour is a
 * correct answer.
 */
function baryInUvTriangle(
  u: number,
  v: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): { u: number; v: number } | null {
  const v0x = bx - ax;
  const v0y = by - ay;
  const v1x = cx - ax;
  const v1y = cy - ay;
  const den = v0x * v1y - v1x * v0y;
  if (den === 0) return null;
  const px = u - ax;
  const py = v - ay;
  const bu = (px * v1y - v1x * py) / den;
  const bv = (v0x * py - px * v0y) / den;
  const eps = 1e-9;
  if (bu < -eps || bv < -eps || bu + bv > 1 + eps) return null;
  return { u: bu, v: bv };
}

/**
 * Van der Corput radical inverse in base 2 and base 3.
 *
 * A local copy rather than an import of `random.ts`'s `radicalInverse`, which
 * takes an arbitrary base and pays for it with a division per digit. These two
 * bases carry the whole sampler and base 2 reduces to bit reversal, so the hot
 * path costs a handful of integer operations. `test/mesh-surface.test.ts` pins
 * them against the general function so the copy cannot drift.
 */
function radicalInverse2(i: number): number {
  let bits = i >>> 0;
  bits = ((bits >>> 16) | (bits << 16)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

function radicalInverse3(i: number): number {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= 3;
    r += f * (n % 3);
    n = Math.floor(n / 3);
  }
  return r;
}
