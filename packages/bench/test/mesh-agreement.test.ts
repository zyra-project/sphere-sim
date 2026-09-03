// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The simulator and the solver intersect the same mesh and must agree.
 *
 * ## Why this file is in `packages/bench`
 *
 * It is the only package that may hold both models. `tools/boundary-lint.ts` R1
 * bans `packages/sim` and `packages/solver` from importing each other and grants
 * tests no exemption, so neither side can host this comparison — which is the
 * point rather than an inconvenience. The two implement the same geometry
 * separately so that agreement is a RESULT, and a result nobody measures is a
 * hope. `nominal-agreement.test.ts` is the same argument applied to rig
 * construction; this is it applied to the surface.
 *
 * Before this file existed there was no sim-vs-solver geometry test at all — not
 * for a mesh, not even for the sphere.
 *
 * ## What it caught on the day it was written
 *
 * Two defects in `packages/solver/src/mesh.ts`, both of which its own nine tests
 * passed:
 *
 *  - **A crack at every shared edge.** The solver excluded the seam exactly, on
 *    the argument that a tolerance would make neighbours overlap. Without one, a
 *    ray meeting a seam is rejected by BOTH neighbours on opposite sides of the
 *    rounding: 71 of 6624 seam rays missed a closed sphere. `packages/sim` had
 *    already found and documented this, and the solver now carries the same
 *    `BARY_EPS` for the same reason.
 *  - **A NaN in the box test, dropping head-on hits.** The compact slab form
 *    computes `0 * Infinity` when a ray has a zero direction component and the
 *    box touches that plane, and every comparison against NaN is false, so the
 *    box is silently rejected. 151 of 6624 seam rays took the FAR side of a
 *    closed sphere — a 1.9957 m error, the diameter — and the solver's own tests
 *    could not see it, because a far-side hit is still a hit.
 *
 * Both were systematic rather than random, which is what makes them serious: a
 * regular tessellation puts its seams on meridians, and a rig aimed down an axis
 * fires rays straight at them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SurfaceMesh } from '../../calibration/src/index.ts';
import { buildBvh, intersectBvh } from '../../sim/src/mesh/bvh.ts';
import { buildMeshIndex, intersectMesh } from '../../solver/src/mesh.ts';

/**
 * Tolerances, each with a reason. A tolerance with no argument behind it is a
 * tolerance somebody will widen the first time it fails.
 */
const TOL = {
  /**
   * Relative difference in `t`. MEASURED AT EXACTLY ZERO on every ray this file
   * fires — 40 000 general and 6 624 aimed at seams — because the two use the
   * same Möller–Trumbore algebra and float64 is deterministic, so identical
   * operands give identical bits.
   *
   * It is not asserted as zero, because that would fail on a legitimate
   * re-association of one side's arithmetic. 1e-12 is roughly four thousand ulp
   * at these magnitudes: room for a reordered expression, and nothing like room
   * for the defects above, which were 0.5 RELATIVE.
   */
  relT: 1e-12,
  /**
   * Fraction of seam rays allowed to disagree about WHICH triangle they hit,
   * when both report the same `t`.
   *
   * This one is a real difference and not an error. `BARY_EPS` admits a hit a
   * hair outside a triangle, so a ray landing on a shared edge hits both
   * neighbours at the same distance, and each traversal takes whichever its own
   * ordering reached first. The simulator's own note says so. Measured: 408 of
   * 6624, 6.2%, all at bit-identical `t`. The bound is generous because the
   * quantity being bounded is a tie-break, not an accuracy — what must never
   * happen, and is asserted separately with no tolerance at all, is two
   * different `t`.
   */
  seamTieFraction: 0.25,
};

function meshOf(positions: number[], indices: number[], name: string): SurfaceMesh {
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name,
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/**
 * A UV sphere, optionally with its radius perturbed per vertex.
 *
 * Both shapes are needed. The REGULAR one is the adversarial case — its seams
 * lie on meridians and its `phi = 0` column sits exactly in the `y = 0` plane,
 * which is what turns an axis-aligned ray into a systematic failure rather than
 * a fluke. The JITTERED one breaks that symmetry, so a test that only passed by
 * accident of alignment does not pass here.
 */
function uvSphere(nLat: number, nLon: number, jitter = 0): SurfaceMesh {
  const positions: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const theta = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const phi = (2 * Math.PI * j) / nLon;
      const r = 1 + jitter * Math.sin(7.1 * i + 3.3 * j);
      positions.push(
        r * Math.sin(theta) * Math.cos(phi),
        r * Math.sin(theta) * Math.sin(phi),
        r * Math.cos(theta),
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
      if (i !== 0) indices.push(a, b, d);
      if (i !== nLat - 1) indices.push(b, c, d);
    }
  }
  return meshOf(positions, indices, jitter === 0 ? 'uv-sphere' : 'uv-sphere-jittered');
}

interface Ray {
  o: { x: number; y: number; z: number };
  d: { x: number; y: number; z: number };
}

/** Deterministic, not random: a failure has to reproduce. */
function sweepRays(count: number): Ray[] {
  const out: Ray[] = [];
  for (let k = 0; k < count; k++) {
    const a = 1 + k * 0.7853981633974483;
    const b = 1 + k * 0.2617993877991494;
    const o = [3 * Math.cos(a), 3 * Math.sin(a) * Math.cos(b), 3 * Math.sin(b)];
    const target = [1.2 * Math.sin(2.3 * k), 1.2 * Math.cos(1.7 * k), 1.2 * Math.sin(0.9 * k)];
    const d = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    out.push({
      o: { x: o[0], y: o[1], z: o[2] },
      d: { x: d[0] / len, y: d[1] / len, z: d[2] / len },
    });
  }
  return out;
}

/**
 * One ray per triangle edge, fired radially at that edge's midpoint.
 *
 * The adversarial set. Every one of these is aimed exactly at a seam, which is
 * where both implementations' tolerances are load-bearing and where every defect
 * this file has caught actually lived.
 */
function seamRays(mesh: SurfaceMesh): Ray[] {
  const { positions: P, indices: I } = mesh;
  const out: Ray[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    for (let e = 0; e < 3; e++) {
      const p = 3 * I[3 * t + e];
      const q = 3 * I[3 * t + ((e + 1) % 3)];
      const m = [(P[p] + P[q]) / 2, (P[p + 1] + P[q + 1]) / 2, (P[p + 2] + P[q + 2]) / 2];
      const len = Math.hypot(m[0], m[1], m[2]);
      const d = [m[0] / len, m[1] / len, m[2] / len];
      out.push({
        o: { x: 5 * d[0], y: 5 * d[1], z: 5 * d[2] },
        d: { x: -d[0], y: -d[1], z: -d[2] },
      });
    }
  }
  return out;
}

interface Disagreement {
  hitMiss: number;
  worstRelT: number;
  differentTriangle: number;
  differentTriangleSameT: number;
  hits: number;
  misses: number;
}

function compare(mesh: SurfaceMesh, rays: Ray[]): Disagreement {
  const bvh = buildBvh(mesh);
  const index = buildMeshIndex(mesh);
  const d: Disagreement = {
    hitMiss: 0,
    worstRelT: 0,
    differentTriangle: 0,
    differentTriangleSameT: 0,
    hits: 0,
    misses: 0,
  };
  for (const ray of rays) {
    const sim = intersectBvh(bvh, mesh, ray.o, ray.d, 0, Infinity);
    const solver = intersectMesh(index, ray.o, ray.d);
    if ((sim !== null) !== solver.hit) {
      d.hitMiss++;
      continue;
    }
    if (sim === null) {
      d.misses++;
      continue;
    }
    d.hits++;
    const rel = Math.abs(sim.t - solver.t) / Math.max(1, Math.abs(sim.t));
    if (rel > d.worstRelT) d.worstRelT = rel;
    if (sim.triangle !== solver.triangle) {
      d.differentTriangle++;
      if (sim.t === solver.t) d.differentTriangleSameT++;
    }
  }
  return d;
}

for (const [label, mesh] of [
  ['a regular UV sphere', uvSphere(24, 48)],
  ['a jittered UV sphere', uvSphere(20, 40, 0.12)],
] as const) {
  test(`the two intersections agree across ${label}`, () => {
    const rays = sweepRays(20000);
    const d = compare(mesh, rays);

    // Both branches have to be exercised or every assertion below is vacuous.
    assert.ok(d.hits > 5000, `only ${d.hits} hits of ${rays.length}`);
    assert.ok(d.misses > 5000, `only ${d.misses} misses — the miss path is untested`);

    assert.equal(d.hitMiss, 0, `${d.hitMiss} rays where one model found a surface and the other did not`);
    assert.ok(
      d.worstRelT <= TOL.relT,
      `worst relative disagreement in t is ${d.worstRelT}, over ${TOL.relT}`,
    );
    // Away from seams there is no tie to break, so the triangle must be the same
    // one. This is the strongest claim in the file and it needs no tolerance:
    // agreeing on `t` while naming different faces would mean two surfaces that
    // happen to be the same distance away.
    assert.equal(
      d.differentTriangle,
      0,
      `${d.differentTriangle} rays hit different triangles at the same distance`,
    );
  });
}

test('the two agree on rays aimed exactly at shared edges, ties included', () => {
  // Where both defects this file caught actually lived. Every ray here is aimed
  // at a seam, which is the case a general sweep almost never produces and a
  // real rig produces constantly.
  const mesh = uvSphere(24, 48);
  const rays = seamRays(mesh);
  assert.ok(rays.length > 6000, `only ${rays.length} seam rays — too few to be evidence`);

  const d = compare(mesh, rays);
  assert.equal(d.hitMiss, 0, `${d.hitMiss} seam rays where one model found nothing`);
  assert.equal(d.misses, 0, 'a seam ray missed a closed sphere entirely');

  // No tolerance on this one. A seam ray legitimately hits two triangles, but it
  // hits them at the SAME distance — so a difference in `t` is never a tie, it
  // is one model taking the far side of the sphere because it lost the near one.
  // That is exactly what happened: 151 of these rays, a 1.9957 m error.
  assert.ok(
    d.worstRelT <= TOL.relT,
    `worst relative disagreement in t on a seam ray is ${d.worstRelT} — one model is ` +
      'passing through the near surface and hitting the far side',
  );
  assert.equal(
    d.differentTriangle - d.differentTriangleSameT,
    0,
    `${d.differentTriangle - d.differentTriangleSameT} seam rays name different triangles at ` +
      'DIFFERENT distances, which is not a tie',
  );

  const tieFraction = d.differentTriangleSameT / Math.max(1, d.hits);
  assert.ok(
    tieFraction <= TOL.seamTieFraction,
    `${(100 * tieFraction).toFixed(1)}% of seam rays break the tie differently, over ` +
      `${100 * TOL.seamTieFraction}% — the two orderings have diverged further than a tie-break`,
  );
});
