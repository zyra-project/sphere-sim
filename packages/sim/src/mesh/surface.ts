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
import type {
  Surface,
  SurfaceAreaSample,
  SurfaceCoord,
  SurfaceHit,
  SurfaceLocation,
} from '../surface.ts';
import { buildAdjacency } from '../footprint.ts';
import type { MeshAdjacency } from '../footprint.ts';
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
  readonly extentRadiusM: number;
  /** The model's own centre — what `extentRadiusM` is a radius about. */
  readonly centre: Vec3;
  readonly shadowBiasM: number;

  /**
   * The hierarchy, readable so nothing has to build a second one.
   *
   * Was private, and `packMesh` in `packages/web` therefore called `buildBvh`
   * again over the same mesh: the dominant preparation cost paid twice, and --
   * worse -- two hierarchies whose `order` arrays are only equal because the
   * build happens to be deterministic. `packBvh` indexes triangles BY that
   * order, and `pickMarker` traverses this one while the picture traverses the
   * texels packed from the other, so a future tie-break would make the picker
   * and the picture point at different faces with nothing failing.
   *
   * Readonly, and `Bvh` is arrays: a caller can read it, and a caller that
   * mutates it is a caller doing something this comment cannot help with.
   */
  readonly bvh: Bvh;
  /**
   * Built lazily: only the blend needs it, and only off a sphere. A mesh loaded
   * purely to be looked at should not pay for a graph it never walks.
   */
  private cachedAdjacency: MeshAdjacency | null = null;
  private cachedVertexNormals: Float64Array | null = null;
  /**
   * Which faces meet at each vertex, CSR: `face[start[i] .. start[i + 1])`.
   * Built only when the file carried no normals, because only then does a
   * vertex have more than one answer to what it is shaded with.
   */
  private cachedIncidence: { start: Uint32Array; face: Uint32Array } | null = null;
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
    // The contract: `boundsRadiusM` is about the ORIGIN, because the limb
    // constant pairs it with a lens distance measured from the origin.
    // `extentRadiusM` is the model's own size, which is what the length scales
    // below all want. They differ by the model's translation.
    this.boundsRadiusM = this.bounds.originRadiusM;
    this.extentRadiusM = this.bounds.radiusM;
    this.centre = this.bounds.centre;
    // Both lengths: the model's size, and its distance from the origin. See
    // `shadowed` — the second is what float32 needs and the first is what the
    // geometry needs.
    this.shadowBiasM =
      SHADOW_BIAS_FRACTION *
      Math.max(
        this.extentRadiusM,
        Math.hypot(this.centre.x, this.centre.y, this.centre.z),
        Number.MIN_VALUE,
      );

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
    const idx = this.mesh.indices;
    return {
      t: hit.t,
      point,
      normal: this.normalOfHit(hit.triangle, hit.u, hit.v),
      // The face is known exactly here. Carrying it is the whole point: every
      // consumer that would otherwise call `locate` and re-derive it by search
      // now gets the triangle the ray actually struck.
      location: {
        triangle: hit.triangle,
        a: idx[3 * hit.triangle],
        b: idx[3 * hit.triangle + 1],
        c: idx[3 * hit.triangle + 2],
        u: hit.u,
        v: hit.v,
      },
    };
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
   * a length the surface knows.
   *
   * **Of the extent AND of where the model stands**, which the first version got
   * wrong by using the extent alone. The shader runs this same ray in float32
   * over positions `pack.ts` stored as float32, so the self-intersection
   * residual is on the order of the float32 spacing AT THE WORLD COORDINATE:
   * about 4.8e-7 m at |x| = 6. A 0.6 m model standing six metres out then got a
   * bias of 6e-7 m — roughly one ulp — and the GPU re-hit the face the ray left,
   * so a fully lit wall rendered black. On the CPU the same formula is ~1e9 ulps
   * and nothing showed. `Surface.shadowBiasM` is where the number lives now, so
   * the binders stop copying the fraction.
   */
  shadowed(point: Vec3, lens: Vec3): boolean {
    const dx = lens.x - point.x;
    const dy = lens.y - point.y;
    const dz = lens.z - point.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance === 0) return false;
    const inv = 1 / distance;
    const bias = this.shadowBiasM;
    return occludedBvh(
      this.bvh,
      this.mesh,
      point,
      { x: dx * inv, y: dy * inv, z: dz * inv },
      bias,
      distance,
    );
  }

  /**
   * Which triangle a point sits on. The public form of the search `coordAt` and
   * `normalAt` already use, promoted because the blend needs it once per point
   * and would otherwise pay for it once per projector.
   */
  locate(point: Vec3): SurfaceLocation | null {
    const hit = this.nearestTriangle(point);
    if (hit === null) return null;
    const idx = this.mesh.indices;
    return {
      triangle: hit.triangle,
      a: idx[3 * hit.triangle],
      b: idx[3 * hit.triangle + 1],
      c: idx[3 * hit.triangle + 2],
      u: hit.u,
      v: hit.v,
    };
  }

  /**
   * The outward normal at VERTEX `i` — from the file when it carried normals,
   * and otherwise from the faces that meet there.
   *
   * The area-weighted sum of incident face normals, which is what a vertex
   * normal means. It exists because the alternative was worse than it looked:
   * asking `normalAt(position)` re-finds the face by the radial search, which is
   * exact only for a star-shaped body and returns NOTHING for a flat wall — so
   * every vertex of a wall got the `{0, 0, 1}` fallback, a wall facing a
   * projector on +x read as facing away, and the footprint field found no lit
   * vertex to feather from. A vertex knows its own faces; it should never have
   * been asked to search for them.
   */
  vertexNormal(i: number): Vec3 {
    const file = this.mesh.normals;
    if (file !== null) return { x: file[3 * i], y: file[3 * i + 1], z: file[3 * i + 2] };
    this.cachedVertexNormals ??= this.buildVertexNormals();
    const n = this.cachedVertexNormals;
    return { x: n[3 * i], y: n[3 * i + 1], z: n[3 * i + 2] };
  }

  private buildVertexNormals(): Float64Array {
    const out = new Float64Array(3 * this.mesh.vertexCount);
    const p = this.mesh.positions;
    const idx = this.mesh.indices;
    for (let t = 0; t < this.mesh.triangleCount; t++) {
      const i0 = idx[3 * t];
      const i1 = idx[3 * t + 1];
      const i2 = idx[3 * t + 2];
      const ax = p[3 * i1] - p[3 * i0];
      const ay = p[3 * i1 + 1] - p[3 * i0 + 1];
      const az = p[3 * i1 + 2] - p[3 * i0 + 2];
      const bx = p[3 * i2] - p[3 * i0];
      const by = p[3 * i2 + 1] - p[3 * i0 + 1];
      const bz = p[3 * i2 + 2] - p[3 * i0 + 2];
      // NOT normalized: the cross product's length is twice the triangle's area,
      // so accumulating it raw is the area weighting.
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      for (const v of [i0, i1, i2]) {
        out[3 * v] += nx;
        out[3 * v + 1] += ny;
        out[3 * v + 2] += nz;
      }
    }
    for (let v = 0; v < this.mesh.vertexCount; v++) {
      const len = Math.hypot(out[3 * v], out[3 * v + 1], out[3 * v + 2]);
      if (len === 0) {
        out[3 * v + 2] = 1;
        continue;
      }
      out[3 * v] /= len;
      out[3 * v + 1] /= len;
      out[3 * v + 2] /= len;
    }
    return out;
  }

  /**
   * Does the surface AT VERTEX `i` face the lens?
   *
   * Here, and not at the call site, because the answer depends on what `i` is
   * shaded with — and that is `normalOfHit`'s question, a few methods down. A
   * caller that reached for `vertexNormal(i)` instead would be giving a second
   * answer to it, and the two disagree exactly where it matters:
   *
   * With no normals in the file, a hit is shaded with the FACE normal of
   * whichever triangle the ray struck. `vertexNormal(i)` averages every face
   * that meets at `i`, so at a hard edge — a cube corner, the eave of a roof —
   * it produces a direction no adjacent face has. Test the average and a vertex
   * can be called lit by a normal nothing is ever rendered with, and the
   * footprint field stops describing the set that actually gets light. So test
   * the incident faces themselves: the vertex is lit if ANY face meeting there
   * would be, which is true precisely when some rendered hit at that corner is.
   *
   * With normals in the file, rendering interpolates them, and at the vertex
   * that interpolation IS the file's vertex normal — one face, one answer, no
   * disagreement to resolve.
   *
   * (Faces are collected by INDEX, not by welded position. A flat-shaded export
   * duplicates its vertices per face, so each corner keeps its own face and its
   * own answer; `adjacency` welds them afterwards, which is what lets the field
   * still flow across the seam. That is the per-face-corner granularity, got
   * from the mesh's own indexing rather than from a second graph.)
   */
  vertexFacesLens(i: number, lens: Vec3): boolean {
    const p = this.mesh.positions;
    const point = { x: p[3 * i], y: p[3 * i + 1], z: p[3 * i + 2] };
    if (this.mesh.normals !== null) {
      return this.facesLens(point, this.vertexNormal(i), lens);
    }
    const inc = (this.cachedIncidence ??= this.buildIncidence());
    for (let k = inc.start[i]; k < inc.start[i + 1]; k++) {
      const t = inc.face[k];
      const normal = {
        x: this.faceNormals[3 * t],
        y: this.faceNormals[3 * t + 1],
        z: this.faceNormals[3 * t + 2],
      };
      if (this.facesLens(point, normal, lens)) return true;
    }
    return false;
  }

  private buildIncidence(): { start: Uint32Array; face: Uint32Array } {
    const idx = this.mesh.indices;
    const n = this.mesh.vertexCount;
    const start = new Uint32Array(n + 1);
    for (let k = 0; k < idx.length; k++) start[idx[k] + 1]++;
    for (let v = 0; v < n; v++) start[v + 1] += start[v];
    const face = new Uint32Array(idx.length);
    // A copy of the offsets, advanced as each face is written. `start` itself
    // has to survive as the offsets, so it cannot double as the cursor.
    const cursor = start.slice(0, n);
    for (let t = 0; t < this.mesh.triangleCount; t++) {
      for (let c = 0; c < 3; c++) face[cursor[idx[3 * t + c]]++] = t;
    }
    return { start, face };
  }

  /** Vertex adjacency, welded by position. Built once, on demand. */
  get adjacency(): MeshAdjacency {
    this.cachedAdjacency ??= buildAdjacency(this.mesh, this.extentRadiusM);
    return this.cachedAdjacency;
  }

  coordAt(point: Vec3, location?: SurfaceLocation | null): SurfaceCoord {
    // The exact answer, when the caller kept the face the point came from.
    // `intersect` and `sampleArea` both know it and now both carry it, so this
    // is the ordinary path rather than the optimization it looks like.
    if (location) return this.coordOfTriangle(location.triangle, location.u, location.v);
    // Otherwise the face has to be found again from the point alone, which is
    // a SEARCH and not an inverse — see `nearestTriangle` for what it assumes.
    // This path is for a world point that arrived some other way.
    const nearest = this.nearestTriangle(point);
    if (nearest === null) return { latDeg: 0, lonDeg: 0 };
    return this.coordOfTriangle(nearest.triangle, nearest.u, nearest.v);
  }

  /**
   * The surface point at a content coordinate.
   *
   * See the module note: this is a search, not an inverse, and it returns the
   * first triangle in index order whose UV triangle contains the coordinate.
   * Returns the mesh centre when the coordinate falls in a GAP between UV
   * islands — a defined answer rather than a NaN, because the callers that reach
   * here are building field maps over a regular lat/lon grid and a NaN there
   * would poison an integral rather than leave a hole. That fallback is not on
   * the surface: the AABB centre is usually inside the model, so a caller that
   * takes it and asks `normalAt` or `isIlluminated` gets a number computed from
   * a place the surface does not occupy. It is the accepted cost of a total
   * function over a gap, and it bounds what this may be used for — it answers
   * "where does this content coordinate go", and it is not a way to obtain a
   * point to shade. Callers that need points ON the surface should use
   * {@link MeshSurface.sampleArea}, which has neither the ambiguity nor the
   * fallback, and `coordAt`/`locate` for the direction that is a real inverse.
   *
   * **A mesh with no UV set at all THROWS, rather than returning that fallback
   * everywhere.** The two cases look the same in the code and are not the same
   * thing. A gap is one coordinate with no answer among many that have one; no
   * UV set is no parameterization, so every coordinate returns the same interior
   * point and the caller receives a complete, smooth, entirely fabricated field
   * — plausible numbers for coverage or displacement over a model that never
   * had a content mapping. Nothing reaches this today (every caller is a lat/lon
   * metric path, and those run on the sphere), so the throw is a tripwire for
   * the code that wires a mesh into one of them, not a live path. `buildWarpExport`
   * refuses the same mesh for the same reason, and says the same fix.
   */
  pointAt(coord: SurfaceCoord): Vec3 {
    const uvs = this.mesh.uvs;
    if (uvs === null) {
      throw new Error(
        `${this.mesh.name} carries no UV set, so a content coordinate maps nowhere on it. ` +
          `Trace it, sample it, and measure coverage on it; asking where content lands ` +
          `needs an unwrap. Re-export the model with one.`,
      );
    }
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

  normalAt(point: Vec3, location?: SurfaceLocation | null): Vec3 {
    if (location) return this.normalOfHit(location.triangle, location.u, location.v);
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
        // Chosen by the sampler, so it is exact and free.
        location: { triangle: t, a: i0, b: i1, c: i2, u: bu, v: bv },
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
   * **THIS IS A SEARCH, NOT A NEAREST-TRIANGLE QUERY, AND IT ASSUMES A
   * STAR-SHAPED BODY.** A radial ray from the bounds centre meets the owning
   * face first only if the model is visible in its entirety from that centre.
   * Give it a fold, a concavity, or a shell with an inner wall and the ray can
   * graze the owning face tangentially or reach a nearer one instead — so the
   * answer is a triangle NEAR the point rather than the triangle the point is
   * on, for a point that is exactly on the surface. That is a real limitation,
   * not a rounding one, and on a model with an overhang it puts the interpolated
   * normal, content coordinate and blend weight on the wrong face.
   *
   * It is a fallback rather than the main path, which is what makes it
   * tolerable. Every point that came from {@link MeshSurface.intersect} or
   * {@link MeshSurface.sampleArea} now carries its own `SurfaceLocation`, and
   * the callers pass it — so the face is known exactly and this function is
   * never consulted. What reaches here is a world point that arrived some other
   * way and has no face attached, where the alternatives are this or nothing.
   *
   * The general answer is a true closest-point-on-mesh query over the BVH
   * (descend by box distance, keep the best point-triangle distance, prune on
   * it). It is correct for any topology and costs a second traversal kernel.
   * Worth writing the day a caller needs a face for a point it did not trace;
   * until then this would be paying for generality nothing exercises.
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
    const window = SEARCH_FRACTION * Math.max(this.extentRadiusM, Number.MIN_VALUE);
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
