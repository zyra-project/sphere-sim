// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * How far inside a projector's footprint a surface point sits, measured ALONG
 * THE SURFACE.
 *
 * `docs/ARBITRARY-SHAPES.md` Phase 3. Phase 1 refused to blend on anything but a
 * sphere rather than approximate it. This is the general form that replaces the
 * refusal.
 *
 * ## The insight the sphere hands over
 *
 * `theta_max` is not really a limb constant. It is where `cos(incidence)`
 * reaches zero: `incidenceCosineClosed` is `(d·cosθ − R)/√(…)`, which vanishes
 * exactly at `cosθ = R/d`. So the sphere's ramp already IS "distance inside the
 * boundary where this projector's light stops" — it merely has a closed form
 * there. On a mesh that boundary has three causes and no closed form: the raster
 * edge, the terminator where the surface turns away, and a shadow edge where the
 * model gets in its own way. All three are edges of one set — the points
 * `isIlluminatedAt` says this projector lights — so one distance handles them
 * all, and a shadow edge feathers exactly like a raster edge.
 *
 * ## Why the distance is geodesic and NOT screen-space
 *
 * `docs/ARBITRARY-SHAPES.md` proposed a screen-space distance transform: draw
 * each projector's footprint in its own raster, distance-transform it, ramp on
 * that. **That proposal was wrong, and the arithmetic says so plainly.**
 *
 * `w_width` is an angle ON THE SPHERE — 20° of arc, about 0.30 m at R = 0.8636.
 * A screen-space field can only measure angle AT THE LENS, and the two are
 * violently different near a limb, which is exactly where the ramp lives. Taken
 * literally at the nominal rig: 20° at the lens is 1096 px, which at a
 * 128-cell field is 73 cells — while the sphere's entire silhouette is 35 cells
 * in radius. The ramp comes out wider than the footprint it is ramping across
 * and can never complete. Measured against the closed form, a screen-space
 * blend departed by 0.46 of a normalized weight; the whole scale is 1.
 *
 * Distance along the surface has no such problem, and it degenerates EXACTLY.
 * On a sphere the footprint is a cap bounded at `theta_max`, so the surface
 * distance from a point to its edge is `R(theta_max − theta)`; dividing by
 * `w_width` expressed as an arc, `R·w·π/180`, gives `(theta_max − theta)/w` —
 * the closed form, algebraically identical. `test/footprint.test.ts` measures
 * that rather than trusting this paragraph.
 *
 * It is also the more meaningful quantity: "crossfade over 30 cm of surface" is
 * a statement an operator can check with a tape measure on any shape, which is
 * what §4.5's "verify against a real sphere" asks for.
 *
 * ## Why this does NOT replace the sphere's ramp
 *
 * It could. It must not. `coverageBoundaryLatitude` bisects sixty times against
 * the closed form, `unlitPolarAreaFraction` integrates that boundary, and
 * `bench-results.json` is byte-compared — so even an algebraically identical
 * route through a mesh graph would move every number in the file. The sphere
 * keeps its own arithmetic; this runs on everything else.
 */

import type { SurfaceMesh } from '../../calibration/src/index.ts';
import type { SurfaceLocation } from './surface.ts';

/**
 * Geodesic distance from every vertex to the nearest point where this
 * projector's light stops, in metres. Zero at and outside the boundary.
 */
export interface FootprintField {
  /** One entry per mesh vertex. */
  distance: Float64Array;
  /** How many vertices this projector lights. Zero means it reaches nothing. */
  litVertices: number;
}

/**
 * Vertex adjacency, welded by position.
 *
 * Welding is not an optimisation. A mesh exported with a UV seam carries two
 * vertices at the same place with different texture coordinates — every
 * lat/lon sphere has one down its back — and an adjacency built from the index
 * buffer alone treats that seam as a wall. Distances would route the long way
 * round it, and the blend would develop a bright line down a model at exactly
 * the place a texture seam already makes suspicious.
 */
export interface MeshAdjacency {
  /** Representative vertex for each vertex, after welding coincident positions. */
  weld: Int32Array;
  /** CSR neighbour list over WELDED representatives. */
  offset: Int32Array;
  neighbour: Int32Array;
  /** Edge length in metres, parallel to {@link MeshAdjacency.neighbour}. */
  length: Float64Array;
  /** How many distinct welded vertices there are. */
  nodeCount: number;
}

/**
 * Quantisation used to decide that two vertices are the same point.
 *
 * A millionth of the model's size. Exporters write float32 positions, which
 * carry about seven significant digits, so two vertices authored at the same
 * place agree to roughly that — while a millionth of a metre-scale model is far
 * below any feature a projector can resolve.
 */
const WELD_FRACTION = 1e-6;

/**
 * The distance recorded for a vertex with no unlit vertex anywhere in reach, as
 * a multiple of the model's size.
 *
 * Any value that clamps the ramp to 1 will do; a million model-widths does so
 * for any blend width a person would type, and stays a long way inside float64.
 */
const UNREACHABLE_SCALE = 1e6;

export function buildAdjacency(mesh: SurfaceMesh, scaleM: number): MeshAdjacency {
  const n = mesh.vertexCount;
  const weld = new Int32Array(n);
  const grid = Math.max(WELD_FRACTION * Math.max(scaleM, 1e-9), Number.MIN_VALUE);
  const seen = new Map<string, number>();
  const p = mesh.positions;
  let nodeCount = 0;
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(p[3 * i] / grid)},${Math.round(p[3 * i + 1] / grid)},${Math.round(p[3 * i + 2] / grid)}`;
    const found = seen.get(key);
    if (found === undefined) {
      seen.set(key, nodeCount);
      weld[i] = nodeCount;
      nodeCount++;
    } else {
      weld[i] = found;
    }
  }

  // Count then fill: a CSR built by pushing into arrays of arrays allocates one
  // array per vertex, which for a 100k-triangle model is 50k allocations to
  // hold three numbers each.
  const degree = new Int32Array(nodeCount);
  const idx = mesh.indices;
  const bump = (a: number, b: number): void => {
    degree[a]++;
    degree[b]++;
  };
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = weld[idx[3 * t]];
    const b = weld[idx[3 * t + 1]];
    const c = weld[idx[3 * t + 2]];
    if (a !== b) bump(a, b);
    if (b !== c) bump(b, c);
    if (c !== a) bump(c, a);
  }
  const offset = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) offset[i + 1] = offset[i] + degree[i];
  const neighbour = new Int32Array(offset[nodeCount]);
  const length = new Float64Array(offset[nodeCount]);
  const cursor = Int32Array.from(offset.subarray(0, nodeCount));

  const original = new Int32Array(nodeCount).fill(-1);
  for (let i = 0; i < n; i++) if (original[weld[i]] < 0) original[weld[i]] = i;
  const edge = (a: number, b: number): void => {
    const ia = original[a];
    const ib = original[b];
    const len = Math.hypot(
      p[3 * ia] - p[3 * ib],
      p[3 * ia + 1] - p[3 * ib + 1],
      p[3 * ia + 2] - p[3 * ib + 2],
    );
    neighbour[cursor[a]] = b;
    length[cursor[a]] = len;
    cursor[a]++;
    neighbour[cursor[b]] = a;
    length[cursor[b]] = len;
    cursor[b]++;
  };
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = weld[idx[3 * t]];
    const b = weld[idx[3 * t + 1]];
    const c = weld[idx[3 * t + 2]];
    if (a !== b) edge(a, b);
    if (b !== c) edge(b, c);
    if (c !== a) edge(c, a);
  }
  // Duplicate edges (every interior edge is shared by two triangles) are left
  // in. Dijkstra relaxes the same pair twice at identical cost, which is a few
  // percent of wasted comparisons rather than a wrong answer, and de-duplicating
  // would cost a sort or a hash per vertex to save it.
  return { weld, offset, neighbour, length, nodeCount };
}

/**
 * Geodesic distance from each vertex to the nearest UNLIT one, by multi-source
 * Dijkstra seeded at every vertex this projector does not light.
 *
 * Graph distance over mesh edges rather than a true geodesic across triangle
 * faces: a path constrained to edges is longer than one free to cut across
 * them, by a few percent on a reasonable tessellation and by more on a coarse
 * one. Fast marching would remove that and needs a per-triangle eikonal solve;
 * the error it would remove is a few percent of a blend width that
 * PARAMETERS.md §4.5 classes ASSUME with "verify against a real sphere" beside
 * it, so it is well inside the uncertainty already carried.
 */
export function buildFootprintField(
  mesh: SurfaceMesh,
  adjacency: MeshAdjacency,
  scaleM: number,
  litVertex: (index: number) => boolean,
): FootprintField {
  const { weld, offset, neighbour, length, nodeCount } = adjacency;

  // A welded node is lit only if every vertex welded into it is: a seam vertex
  // that is lit on one side and not the other sits ON the boundary.
  const lit = new Uint8Array(nodeCount).fill(1);
  for (let i = 0; i < mesh.vertexCount; i++) if (!litVertex(i)) lit[weld[i]] = 0;

  const dist = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
  const heap = new MinHeap(nodeCount);
  let litVertices = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (lit[i] === 1) {
      litVertices++;
      continue;
    }
    dist[i] = 0;
    heap.push(i, 0);
  }

  const settled = new Uint8Array(nodeCount);
  while (heap.size > 0) {
    const node = heap.pop();
    if (settled[node] === 1) continue;
    settled[node] = 1;
    const base = dist[node];
    for (let e = offset[node]; e < offset[node + 1]; e++) {
      const to = neighbour[e];
      if (settled[to] === 1) continue;
      const candidate = base + length[e];
      if (candidate < dist[to]) {
        dist[to] = candidate;
        heap.push(to, candidate);
      }
    }
  }

  // Back out to per-VERTEX, which is what the barycentric interpolation needs.
  //
  // A vertex Dijkstra never reached has NO unlit vertex anywhere in its
  // component — this projector covers that whole piece of surface with nothing
  // to feather against. The honest distance there is "as deep as it gets", not
  // zero. Zero was the first version and it is precisely backwards: it ramps a
  // fully-covered panel down to nothing at its own rim, and where two projectors
  // both cover it they would both go to zero and normalization would leave the
  // rim black.
  //
  // A finite sentinel rather than `Infinity`, because the interpolation
  // multiplies these by barycentric weights and `0 * Infinity` is NaN — which
  // would put a hole in the surface at every point that landed exactly on an
  // edge.
  const unreachable = UNREACHABLE_SCALE * Math.max(scaleM, Number.MIN_VALUE);
  const distance = new Float64Array(mesh.vertexCount);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const d = dist[weld[i]];
    distance[i] = Number.isFinite(d) ? d : unreachable;
  }
  return { distance, litVertices };
}

/**
 * The blend width as a distance along the surface, metres.
 *
 * `w_width` is an angle, because that is how PARAMETERS.md §4.5 states it and
 * how an operator thinks about a seam on a ball. `scaleM` turns it into an arc:
 * on a sphere the bounding radius IS the radius, so this is exactly `R·w` and
 * the ramp degenerates to the closed form. On a mesh it reads as "a fixed
 * fraction of the model's size", which is the only shape-independent meaning the
 * number can carry until somebody states a seam width in metres directly.
 */
export function blendWidthM(widthDeg: number, scaleM: number): number {
  return Math.max(1e-9, widthDeg) * (Math.PI / 180) * Math.max(scaleM, 1e-9);
}

/** Interpolate the field across the face a point was located on. */
export function footprintDistanceAt(field: FootprintField, at: SurfaceLocation): number {
  const d = field.distance;
  return (1 - at.u - at.v) * d[at.a] + at.u * d[at.b] + at.v * d[at.c];
}

/**
 * A binary min-heap over integer nodes.
 *
 * Lazy deletion — a node can be pushed several times and the settled flag drops
 * the stale copies — because a decrease-key heap needs a position index and the
 * bookkeeping costs more than the duplicates do at these sizes.
 */
class MinHeap {
  private node: Int32Array;
  private key: Float64Array;
  size = 0;

  constructor(capacity: number) {
    // Lazy deletion means more entries than nodes. Each vertex can be pushed
    // once per incoming edge, so the degree sum bounds it, and four times the
    // vertex count is a comfortable start for a triangle mesh.
    const initial = Math.max(16, capacity * 4);
    this.node = new Int32Array(initial);
    this.key = new Float64Array(initial);
  }

  push(node: number, key: number): void {
    // It grows, which is what the paragraph above always claimed and what the
    // code did not do — it threw. `4 * nodeCount` is only comfortable for a
    // manifold triangle graph: a valid mesh with a high-valence or non-manifold
    // vertex can hold more entries alive at once, and refusing to prepare a
    // model because it is unusual is not a decision this heap gets to make.
    if (this.size >= this.node.length) this.grow();
    let i = this.size++;
    this.node[i] = node;
    this.key[i] = key;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.key[parent] <= this.key[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.node[0];
    this.size--;
    if (this.size > 0) {
      this.node[0] = this.node[this.size];
      this.key[0] = this.key[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let small = i;
        if (l < this.size && this.key[l] < this.key[small]) small = l;
        if (r < this.size && this.key[r] < this.key[small]) small = r;
        if (small === i) break;
        this.swap(i, small);
        i = small;
      }
    }
    return top;
  }

  private grow(): void {
    const node = new Int32Array(this.node.length * 2);
    node.set(this.node);
    this.node = node;
    const key = new Float64Array(this.key.length * 2);
    key.set(this.key);
    this.key = key;
  }

  private swap(a: number, b: number): void {
    const n = this.node[a];
    this.node[a] = this.node[b];
    this.node[b] = n;
    const k = this.key[a];
    this.key[a] = this.key[b];
    this.key[b] = k;
  }
}
