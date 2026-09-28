// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A whole camera position read from its fingerprints, on a sphere.
 *
 * `indexing.test.ts` holds the older mechanisms to hand-built fractions and a
 * four-block toy plan, and that is the right place for them: what they do is a
 * function of the kinds they are handed. {@link indexPosition} is handed no
 * kinds. What it does depends on what a projector's patterns look like from one
 * place in front of a sphere — how much of the raster a camera sees, how far
 * neighbouring projectors overlap, how coarse the Gray planes and the fringe are
 * against the crescent — and a toy plan on a flat raster has none of that. So
 * these tests photograph a sphere.
 *
 * ## The model, and why it lives here
 *
 * `packages/solver` may not import the bench (`tools/boundary-lint.ts`), so this
 * is a second, small forward model rather than a call into the renderer — the
 * same separation `realphotos.test.ts` and `synthetic.ts` keep, and for their
 * reason: a fixture that asks the code under test what it painted can only
 * agree with itself.
 *
 * It works in BLOCK space: the camera's picture is rendered straight at the
 * fingerprint's grid, each block the mean of a few sub-samples, and handed to
 * the solver's own {@link fingerprint} and {@link observe}. Fringes finer than a
 * block average out exactly as they do in a fingerprint of a real photograph.
 *
 *   - A unit sphere, lit by four projectors at quarter turns round it, six radii
 *     out (the bench's 5.18 m over its 0.8636 m radius), each aimed at the
 *     centre with a raster that just covers the sphere — so, as on a Science On
 *     a Sphere, each lights the hemisphere facing it and neighbours overlap
 *     heavily.
 *   - A pinhole camera 3.5 radii out, a little below the equator, the sphere
 *     filling three quarters of the picture's height: the card's marks.
 *   - Lambertian light with the projector's cosine and distance falloff, a
 *   black floor of 1/800 (PARAMETERS.md §3.2), a little ambient, and noise per
 *   block — a read floor plus a shot term — seeded, so every run is the same.
 *   - The patterns written from `decode.ts`'s normative header: Gray planes MSB
 *   first, each followed by its complement, then the phase steps; the page's
 *   frame order, restated here because `planFrames` lives in the bench.
 *
 * It is a model, not the bench: no limb darkening, no specular term, no room.
 * What it is for is the geometry, and the measured facts the tests below rest on
 * are asserted where they are used rather than assumed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { LinearImage } from '../src/decode.ts';
import {
  COMPLEMENT_LIMIT,
  DARK_LIMIT,
  complementResidual,
  fingerprint,
  indexByFingerprint,
  indexPosition,
  litFractions,
  observe,
  type ExpectedSequence,
  type FrameFingerprint,
  type FrameKind,
  type FrameStats,
} from '../src/indexing.ts';

// ---------------------------------------------------------------------------
// The plan, restated
// ---------------------------------------------------------------------------

interface Plan {
  grayBits: number;
  phaseSteps: number;
  phasePeriodStrides: number;
}

interface Spec {
  kind: 'white' | 'black' | 'gray' | 'inverse' | 'phase';
  axis: 'u' | 'v' | null;
  index: number;
}

/** The page's own plan: 6 Gray planes and 4 phase steps per axis, 34 frames. */
const PAGE: Plan = { grayBits: 6, phaseSteps: 4, phasePeriodStrides: 2 };

/**
 * Also 34 frames a run, at a quarter of the page's fingerprint grid: 4 Gray
 * planes and 8 phase steps per axis, so 16 blocks across. For the tests that
 * run thousands of folders — the reader is some 15 times faster on it — and the
 * one where a fringe finer than a block is what matters, since at 16 blocks the
 * phase frames average to half in every block.
 */
const CHEAP: Plan = { grayBits: 4, phaseSteps: 8, phasePeriodStrides: 2 };

const RES = { x: 1920, y: 1200 };

function specsOf(plan: Plan): Spec[] {
  const out: Spec[] = [
    { kind: 'white', axis: null, index: 0 },
    { kind: 'black', axis: null, index: 0 },
  ];
  for (const axis of ['u', 'v'] as const) {
    for (let j = 0; j < plan.grayBits; j++) {
      out.push({ kind: 'gray', axis, index: j });
      out.push({ kind: 'inverse', axis, index: j });
    }
  }
  for (const axis of ['u', 'v'] as const) {
    for (let k = 0; k < plan.phaseSteps; k++) out.push({ kind: 'phase', axis, index: k });
  }
  return out;
}

/** What the plan asks a projector to emit at raster position (u, v). */
function target(spec: Spec, plan: Plan, u: number, v: number): number {
  if (spec.kind === 'white') return 1;
  if (spec.kind === 'black') return 0;
  const res = spec.axis === 'u' ? RES.x : RES.y;
  const s = spec.axis === 'u' ? u : v;
  const stride = res / 2 ** plan.grayBits;
  if (spec.kind === 'phase') {
    const period = stride * plan.phasePeriodStrides;
    return 0.5 + 0.5 * Math.cos((2 * Math.PI * s) / period - (2 * Math.PI * spec.index) / plan.phaseSteps);
  }
  const code = Math.max(0, Math.min(2 ** plan.grayBits - 1, Math.floor(s / stride)));
  const bit = ((code ^ (code >>> 1)) >>> (plan.grayBits - 1 - spec.index)) & 1;
  return spec.kind === 'inverse' ? 1 - bit : bit;
}

function expectedOf(plan: Plan, projectors = 4): ExpectedSequence {
  const specs = specsOf(plan);
  const kinds: FrameKind[] = specs.map((s) =>
    s.kind === 'white' ? 'white' : s.kind === 'black' ? 'black' : 'patterned',
  );
  const pairs: [number, number][] = [];
  specs.forEach((s, i) => {
    if (s.kind === 'gray') pairs.push([i, i + 1]);
  });
  const phases = (['u', 'v'] as const).map((axis) =>
    specs.flatMap((s, i) => (s.kind === 'phase' && s.axis === axis ? [i] : [])),
  );
  return { kinds, projectors, complements: { pairs, minBlocks: 2 ** plan.grayBits }, phases };
}

// ---------------------------------------------------------------------------
// The sphere
// ---------------------------------------------------------------------------

type V3 = [number, number, number];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

interface Placement {
  /** Camera azimuth and elevation in degrees, and its distance in sphere radii. */
  azimuth: number;
  elevation?: number;
  distance?: number;
}

const PROJECTOR_AZIMUTHS = [45, 135, 225, 315];
const PROJECTOR_GAINS = [1, 0.92, 1.06, 0.97];
const PROJECTOR_DISTANCE = 6;
const ALBEDO = 0.6;
const AMBIENT = 0.004;
const BLACK_FLOOR = 1 / 800;
const SUB = 3;

/**
 * One camera position: for every sub-sample of every block, the light each
 * projector puts there per unit of its target, and where in its raster.
 */
interface Scene {
  plan: Plan;
  blocks: number;
  specs: Spec[];
  /** Noiseless block values, `[projector][frame]`, and the all-black frame. */
  clean: Float32Array[][];
  dark: Float32Array;
}

function sceneOf(plan: Plan, blocks: number, where: Placement): Scene {
  const P = PROJECTOR_AZIMUTHS.length;
  const az = (where.azimuth * Math.PI) / 180;
  const el = ((where.elevation ?? -12) * Math.PI) / 180;
  const d = where.distance ?? 3.5;
  const cam: V3 = [d * Math.cos(az) * Math.cos(el), d * Math.sin(az) * Math.cos(el), d * Math.sin(el)];
  const f = unit([-cam[0], -cam[1], -cam[2]]);
  const r = unit(cross(f, [0, 0, 1]));
  const up = cross(r, f);
  const halfV = Math.tan(Math.asin(1 / d)) / 0.75;
  const halfU = halfV * (4 / 3);
  const projectors = PROJECTOR_AZIMUTHS.map((deg, p) => {
    const a = (deg * Math.PI) / 180;
    const C: V3 = [PROJECTOR_DISTANCE * Math.cos(a), PROJECTOR_DISTANCE * Math.sin(a), 0];
    const pf = unit([-C[0], -C[1], -C[2]]);
    const pr = unit(cross(pf, [0, 0, 1]));
    const pu = cross(pr, pf);
    const hv = Math.tan(Math.asin(1 / PROJECTOR_DISTANCE)) * 1.02;
    return { C, pf, pr, pu, hv, hu: hv * (RES.x / RES.y), gain: PROJECTOR_GAINS[p] };
  });
  const samples = blocks * blocks * SUB * SUB;
  const weight = new Float32Array(samples * P);
  const us = new Float32Array(samples * P);
  const vs = new Float32Array(samples * P);
  let s = 0;
  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++, s++) {
          const x = ((bx + (sx + 0.5) / SUB) / blocks) * 2 - 1;
          const y = 1 - ((by + (sy + 0.5) / SUB) / blocks) * 2;
          const dir = unit([
            f[0] + r[0] * x * halfU + up[0] * y * halfV,
            f[1] + r[1] * x * halfU + up[1] * y * halfV,
            f[2] + r[2] * x * halfU + up[2] * y * halfV,
          ]);
          const b = dot(cam, dir);
          const disc = b * b - (dot(cam, cam) - 1);
          if (disc <= 0) continue;
          const t = -b - Math.sqrt(disc);
          const X: V3 = [cam[0] + t * dir[0], cam[1] + t * dir[1], cam[2] + t * dir[2]];
          for (let p = 0; p < P; p++) {
            const pr = projectors[p];
            const toP: V3 = [pr.C[0] - X[0], pr.C[1] - X[1], pr.C[2] - X[2]];
            const dist = Math.hypot(toP[0], toP[1], toP[2]);
            const cosI = dot(X, toP) / dist;
            if (cosI <= 0) continue;
            const rel: V3 = [-toP[0], -toP[1], -toP[2]];
            const z = dot(rel, pr.pf);
            const u = ((dot(rel, pr.pr) / z / pr.hu + 1) / 2) * RES.x;
            const v = ((dot(rel, pr.pu) / z / pr.hv + 1) / 2) * RES.y;
            if (u < 0 || u >= RES.x || v < 0 || v >= RES.y) continue;
            weight[s * P + p] = ALBEDO * pr.gain * cosI * ((PROJECTOR_DISTANCE - 1) / dist) ** 2;
            us[s * P + p] = u;
            vs[s * P + p] = v;
          }
        }
      }
    }
  }
  const specs = specsOf(plan);
  const render = (lit: number | null, spec: Spec | null): Float32Array => {
    const out = new Float32Array(blocks * blocks);
    const per = SUB * SUB;
    for (let blk = 0; blk < blocks * blocks; blk++) {
      let sum = 0;
      for (let k = 0; k < per; k++) {
        const i = blk * per + k;
        let value = AMBIENT;
        for (let p = 0; p < P; p++) {
          const w = weight[i * P + p];
          if (w === 0) continue;
          const t = p === lit && spec !== null ? target(spec, plan, us[i * P + p], vs[i * P + p]) : 0;
          value += w * (BLACK_FLOOR + (1 - BLACK_FLOOR) * t);
        }
        sum += value;
      }
      out[blk] = sum / per;
    }
    return out;
  };
  const clean = PROJECTOR_AZIMUTHS.map((_, p) => specs.map((spec) => render(p, spec)));
  return { plan, blocks, specs, clean, dark: render(null, null) };
}

/** A seeded stream: xorshift32, Box-Muller. Nothing here calls Math.random. */
function stream(seed: number): () => number {
  let x = seed >>> 0 || 1;
  const uniform = (): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return (x + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * One photograph of a block image: a read floor of 0.0008 and a shot term, per
 * block. Set against the plan's probe of the bench, where an unseen projector's
 * frames and the blacks sat within 0.0032 of the floor.
 */
function photograph(values: Float32Array, noise: () => number): LinearImage {
  const blocks = Math.sqrt(values.length);
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    data[i] = v + Math.sqrt(0.0008 ** 2 + 0.004 ** 2 * Math.max(0, v)) * noise();
  }
  return { width: blocks, height: blocks, channels: 1, data };
}

/**
 * What a folder is built from: one frame of one projector's run, or `null` for a
 * dark photograph — the page's black, or a projector this camera cannot see.
 * `blend` mixes in a second frame, as a shutter open across a pattern change
 * does (`indexing.test.ts`'s straddle test, at this model's scale).
 */
type Shot = { projector: number; frame: number; blend?: { projector: number; frame: number; weight: number } } | null;

interface Photos {
  prints: FrameFingerprint[];
  stats: FrameStats[];
  /** `p * runLength + f` for a frame, -1 for a dark photograph. */
  truth: number[];
}

function keyOf(shot: Shot): string {
  if (shot === null) return 'dark';
  const b = shot.blend;
  return b === undefined ? `${shot.projector}:${shot.frame}` : `${shot.projector}:${shot.frame}~${b.projector}:${b.frame}:${b.weight}`;
}

/**
 * A camera at one scene: every photograph it takes of a given frame is its own
 * draw of noise, and the n-th photograph of a frame is the same draw in every
 * folder built from the same camera — so a folder's duplicate is a second
 * photograph, not a copy, and thousands of folders cost a few hundred renders.
 */
function camera(scene: Scene, seed: number): (shots: readonly Shot[]) => Photos {
  const noise = stream(seed);
  const taken = new Map<string, { print: FrameFingerprint; stats: FrameStats }[]>();
  const R = scene.specs.length;
  const take = (shot: Shot, n: number): { print: FrameFingerprint; stats: FrameStats } => {
    const key = keyOf(shot);
    let list = taken.get(key);
    if (list === undefined) {
      list = [];
      taken.set(key, list);
    }
    while (list.length <= n) {
      let values = scene.dark;
      if (shot !== null) {
        values = scene.clean[shot.projector][shot.frame];
        if (shot.blend !== undefined) {
          const other = scene.clean[shot.blend.projector][shot.blend.frame];
          const w = shot.blend.weight;
          values = values.map((v, k) => w * v + (1 - w) * other[k]);
        }
      }
      const image = photograph(values, noise);
      list.push({ print: fingerprint(image, 0, scene.blocks), stats: observe(image, 0) });
    }
    return list[n];
  };
  return (shots) => {
    const counts = new Map<string, number>();
    const out: Photos = { prints: [], stats: [], truth: [] };
    shots.forEach((shot, i) => {
      const key = keyOf(shot);
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      const got = take(shot, n);
      out.prints.push({ ...got.print, ordinal: i });
      out.stats.push({ ...got.stats, ordinal: i });
      // A blend is filed, if at all, under the frame it mostly shows.
      out.truth.push(shot === null ? -1 : shot.projector * R + shot.frame);
    });
    return out;
  };
}

/** Every projector's run, back to back, the unseen ones' frames dark. */
function position(
  scene: Scene,
  options: { unseen?: readonly number[]; leading?: number; trailing?: number } = {},
): Shot[] {
  const R = scene.specs.length;
  const unseen = options.unseen ?? [];
  const shots: Shot[] = [];
  // Before Play the page shows step 0: projector 1's white.
  for (let i = 0; i < (options.leading ?? 0); i++) {
    shots.push(unseen.includes(0) ? null : { projector: 0, frame: 0 });
  }
  for (let p = 0; p < PROJECTOR_AZIMUTHS.length; p++) {
    for (let f = 0; f < R; f++) shots.push(unseen.includes(p) ? null : { projector: p, frame: f });
  }
  for (let i = 0; i < (options.trailing ?? 0); i++) shots.push(null);
  return shots;
}

/** One projector's run. */
function run(scene: Scene, p: number): Shot[] {
  return scene.specs.map((_, f) => ({ projector: p, frame: f }));
}

/** Photographs placed under a frame they are not. The number that matters. */
function misplaced(assignment: readonly (number | null)[], truth: readonly number[]): number {
  let wrong = 0;
  assignment.forEach((got, i) => {
    if (got !== null && got !== truth[i]) wrong++;
  });
  return wrong;
}

const scenes = new Map<string, Scene>();
function scene(plan: Plan, blocks: number, where: Placement): Scene {
  const key = JSON.stringify([plan, blocks, where]);
  let got = scenes.get(key);
  if (got === undefined) {
    got = sceneOf(plan, blocks, where);
    scenes.set(key, got);
  }
  return got;
}

/** The page plan at azimuth 0, with the projectors moved or re-balanced. */
function sceneWith(rig: { azimuths: number[]; gains: number[] }): Scene {
  const saved = [PROJECTOR_AZIMUTHS.slice(), PROJECTOR_GAINS.slice()];
  PROJECTOR_AZIMUTHS.splice(0, 4, ...rig.azimuths);
  PROJECTOR_GAINS.splice(0, 4, ...rig.gains);
  try {
    return sceneOf(PAGE, 64, { azimuth: 0 });
  } finally {
    PROJECTOR_AZIMUTHS.splice(0, 4, ...saved[0]);
    PROJECTOR_GAINS.splice(0, 4, ...saved[1]);
  }
}

/** How far up from its black to its white `values` stand over a run's crescent. */
function levelOver(scene: Scene, p: number, values: Float32Array): number {
  const W = scene.clean[p][0];
  const B = scene.clean[p][1];
  let peak = 0;
  for (let i = 0; i < W.length; i++) peak = Math.max(peak, W[i] - B[i]);
  let num = 0;
  let den = 0;
  for (let i = 0; i < W.length; i++) {
    const m = W[i] - B[i];
    if (m < Math.max(DARK_LIMIT, 0.1 * peak)) continue;
    num += values[i] - B[i];
    den += m;
  }
  return num / den;
}

// ---------------------------------------------------------------------------
// Test 1 — the finding: coarse planes light all of a crescent or none of it
// ---------------------------------------------------------------------------

test('coarse Gray planes that light all of a crescent or none of it still place every run; the old path refuses', () => {
  // EXPERIMENT-10's finding F1a, measured on this model before anything rests
  // on it: from one place the first Gray plane lights nearly all of some
  // crescents and nearly none of others, where `classify` assumes a half.
  const expected = expectedOf(PAGE);
  for (const [azimuth, seen] of [
    [0, [0, 1, 2, 3]],
    [110, [0, 1, 2]],
    [250, [1, 2, 3]],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth });
    const u0 = seen.map((p) => levelOver(s, p, s.clean[p][2]));
    assert.ok(
      u0.some((l) => l > 0.9 || l < 0.1),
      `azimuth ${azimuth}: no crescent where the first plane lights all or none (${u0.map((l) => l.toFixed(2))})`,
    );

    const { prints, stats, truth } = camera(s, 1)(position(s));
    const r = indexPosition(prints, expected);
    assert.deepEqual(r.problems, [], `azimuth ${azimuth}`);
    assert.equal(r.ok, true);
    assert.deepEqual(r.usableProjectors, [...seen], `azimuth ${azimuth}`);
    assert.equal(misplaced(r.assignment, truth), 0);
    assert.equal(r.assignment.filter((a) => a !== null).length, seen.length * s.specs.length);
    assert.equal(r.mechanism, 'position');

    // The page's old route, on the same photographs: refused whole.
    const old = indexByFingerprint(litFractions(stats), prints, expected);
    assert.equal(old.ok, false, `azimuth ${azimuth}: the old path should refuse`);
    assert.deepEqual(old.usableProjectors, []);
  }
});

// ---------------------------------------------------------------------------
// Test 2 — a projector the camera cannot see
// ---------------------------------------------------------------------------

test('a projector out of view at any slot is a note, and every other run keeps its number', () => {
  // From one position some projectors are out of sight (F1b). Their slot is
  // 34 dark photographs, which is not a run with no white — it is a projector
  // with nothing to decode and nothing to re-shoot.
  const s = scene(PAGE, 64, { azimuth: 0 });
  const expected = expectedOf(PAGE);
  const shoot = camera(s, 2);
  for (let q = 0; q < 4; q++) {
    const { prints, truth } = shoot(position(s, { unseen: [q] }));
    const r = indexPosition(prints, expected);
    assert.deepEqual(r.problems, [], `projector ${q + 1} out of view`);
    assert.equal(r.ok, true);
    assert.deepEqual(r.unseenProjectors, [q]);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3].filter((p) => p !== q));
    assert.equal(misplaced(r.assignment, truth), 0, `projector ${q + 1} out of view`);
    assert.ok(r.notes.some((n) => n.startsWith(`Projector ${q + 1} was not in this camera's view`)));
  }
});

// ---------------------------------------------------------------------------
// Test 3 — noise is not light
// ---------------------------------------------------------------------------

test('a projector out of view, photographed with noise, is never told to be re-shot', () => {
  // F1b(ii): handed exact kinds, the complement check reads an unseen run's
  // noise as a broken pair and tells the operator to re-shoot a projector the
  // camera cannot see. Here projector 4 is genuinely out of view, and projector
  // 2 is made so; both are noise on the floor.
  const s = scene(PAGE, 64, { azimuth: 110 });
  const expected = expectedOf(PAGE);
  const R = s.specs.length;
  let reach = 0;
  for (const values of s.clean[3]) for (let i = 0; i < values.length; i++) reach = Math.max(reach, values[i] - s.dark[i]);
  assert.ok(reach < 1e-6, `projector 4 reaches the picture: ${reach}`);

  const shots = position(s, { unseen: [1] });
  const { prints, truth } = camera(s, 3)(shots);
  const r = indexPosition(prints, expected);
  assert.deepEqual(r.problems, []);
  assert.doesNotMatch([...r.problems, ...r.notes].join(' '), /Re-shoot/);
  assert.deepEqual(r.unseenProjectors, [1, 3]);
  assert.deepEqual(r.usableProjectors, [0, 2]);
  assert.equal(misplaced(r.assignment, truth), 0);

  // What the counterfactual reader EXPERIMENT-10 used says about the same
  // photographs, handed every kind exactly: noise read as a broken run.
  const exact = truth.map((t, i) => {
    const f = t < 0 ? i % R : t % R;
    const lit = f === 0 ? 1 : f === 1 ? 0 : 0.5;
    return { ordinal: i, mean: lit, litFraction: lit };
  });
  const oracle = indexByFingerprint(exact, prints, expected);
  assert.match(oracle.problems.join(' '), /Re-shoot projector 4\./);
});

// ---------------------------------------------------------------------------
// Test 4 — dark photographs after the end
// ---------------------------------------------------------------------------

test('dark photographs after the last step keep the last run, from none to forty', () => {
  // F8: the page shows black after the last step, and an intervalometer keeps
  // shooting it. The bookends ran the last run to the end of the folder, and
  // one extra photograph lost it.
  const s = scene(PAGE, 64, { azimuth: 0 });
  const expected = expectedOf(PAGE);
  const shoot = camera(s, 4);
  for (const trailing of [0, 1, 2, 40]) {
    const { prints, truth } = shoot(position(s, { trailing }));
    const r = indexPosition(prints, expected);
    assert.deepEqual(r.problems, [], `${trailing} trailing`);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3], `${trailing} trailing`);
    assert.equal(misplaced(r.assignment, truth), 0);
    assert.equal(
      r.notes.some((n) => / after the last projector's run .*taken after the screen went black/.test(n)),
      trailing > 0,
      `${trailing} trailing: ${r.notes.join(' | ')}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 5 — the projector numbers, exhaustively
// ---------------------------------------------------------------------------

/**
 * Every single dark fault a folder can carry, one per stretch: the first dark
 * photograph of each run of them, and each seen run's black, dropped or shot
 * twice. The count model this rests on (the reader-fix notes) found that where
 * in a dark stretch the fault falls does not change what the ends count.
 */
function darkFaults(shots: readonly Shot[]): { at: number; twice: boolean }[] {
  const at: number[] = [];
  shots.forEach((shot, i) => {
    if (shot === null ? i === 0 || shots[i - 1] !== null : shot.frame === 1) at.push(i);
  });
  return at.flatMap((i) => [
    { at: i, twice: false },
    { at: i, twice: true },
  ]);
}

function withFault(shots: readonly Shot[], fault: { at: number; twice: boolean } | null): Shot[] {
  const out = shots.slice();
  if (fault === null) return out;
  if (fault.twice) out.splice(fault.at, 0, out[fault.at]);
  else out.splice(fault.at, 1);
  return out;
}

test('projector numbers are never wrong: every unseen set, pre-roll, trailing darks, dark fault and re-shoot', () => {
  // The design's pin on its residual risk. A wrong number needs the counts at
  // the two ends to be misread together, so this runs every combination the
  // page's procedure can produce and a few it should not: pre-roll and
  // trailing darks past the allowance (40), one dark photograph dropped or
  // doubled anywhere, and a re-shot run appended or not. Every run is either
  // filed under its own projector or refused; none is ever filed under another.
  const s = scene(CHEAP, 16, { azimuth: 0, elevation: 70, distance: 3 });
  const expected = expectedOf(CHEAP);
  const shoot = camera(s, 5);
  const clean = indexPosition(shoot(position(s)).prints, expected);
  assert.deepEqual(clean.usableProjectors, [0, 1, 2, 3], 'the model has to see all four for this to test anything');

  let folders = 0;
  let placedRuns = 0;
  let seenRuns = 0;
  for (let mask = 0; mask < 16; mask++) {
    const unseen = [0, 1, 2, 3].filter((p) => ((mask >> p) & 1) === 1);
    const seen = [0, 1, 2, 3].filter((p) => !unseen.includes(p));
    for (const leading of [0, 1, 3, 20, 33, 40]) {
      for (const trailing of [0, 1, 2, 33, 40]) {
        const base = position(s, { unseen, leading, trailing });
        const tails = [null, ...(seen.length > 0 ? [seen[(leading + trailing + mask) % seen.length]] : [])];
        for (const tail of tails) {
          const shots = tail === null ? base : [...base, ...run(s, tail)];
          for (const fault of [null, ...darkFaults(shots)]) {
            const { prints, truth } = shoot(withFault(shots, fault));
            const r = indexPosition(prints, expected);
            folders++;
            seenRuns += seen.length;
            placedRuns += r.usableProjectors.length;
            const wrong = misplaced(r.assignment, truth);
            if (wrong > 0) {
              assert.fail(
                `unseen [${unseen.map((p) => p + 1)}], ${leading} leading, ${trailing} trailing, ` +
                  `re-shoot ${tail === null ? 'none' : tail + 1}, fault ${JSON.stringify(fault)}: ` +
                  `${wrong} photographs filed wrong; placed ${r.usableProjectors.map((p) => p + 1)}`,
              );
            }
          }
        }
      }
    }
  }
  // Not vacuous: a reader that refused everything would pass the loop above.
  assert.ok(folders > 5000, `${folders} folders`);
  assert.ok(placedRuns > 0.6 * seenRuns, `placed ${placedRuns} of ${seenRuns} seen runs`);
});

// ---------------------------------------------------------------------------
// Test 6 — one photograph dropped or doubled, anywhere
// ---------------------------------------------------------------------------

/** Every run's frames, with one photograph at `at` dropped or shot twice. */
function singleFault(shots: readonly Shot[], at: number, twice: boolean): Shot[] {
  return withFault(shots, { at, twice });
}

/**
 * The verdict on one faulted folder: nothing misplaced, every other run kept,
 * and the faulted run either refused in words that name it or — when the
 * fault leaves its photographs intact — placed.
 */
function checkSingleFault(
  label: string,
  r: ReturnType<typeof indexPosition>,
  truth: readonly number[],
  seen: readonly number[],
  p: number,
  f: number,
  twice: boolean,
): void {
  assert.equal(misplaced(r.assignment, truth), 0, `${label}: photographs filed wrong`);
  for (const q of seen) {
    if (q !== p) assert.ok(r.usableProjectors.includes(q), `${label}: projector ${q + 1} lost`);
  }
  if (r.usableProjectors.includes(p)) {
    // Placed with every photograph right: a white shot twice before its run,
    // whose spare is a photograph belonging to no run.
    assert.ok(twice && f === 0, `${label}: the faulted run was placed`);
    return;
  }
  assert.ok(
    r.problems.some((x) => x.includes(`Re-shoot projector ${p + 1}.`)),
    `${label}: refused without naming projector ${p + 1}: ${r.problems.join(' | ')}`,
  );
}

test('one photograph dropped or doubled anywhere refuses its own run loudly and costs no other', () => {
  // The page plan where a neighbour overlaps heavily: at this azimuth the
  // next projector's white reads about half the crescent, which is what a
  // phase frame reads — so a dropped phase frame, which pulls that white into
  // the last phase slot, is caught by the phase steps' own identities and not
  // by a level.
  const s = scene(PAGE, 64, { azimuth: 90 });
  const R = s.specs.length;
  const nextWhite = levelOver(s, 0, s.clean[1][0]);
  assert.ok(nextWhite > 0.25 && nextWhite < 0.75, `projector 2's white reads ${nextWhite.toFixed(2)} of projector 1's range`);
  const expected = expectedOf(PAGE);
  const shoot = camera(s, 6);
  const shots = position(s);
  for (let at = 0; at < shots.length; at++) {
    for (const twice of [false, true]) {
      const { prints, truth } = shoot(singleFault(shots, at, twice));
      const r = indexPosition(prints, expected);
      checkSingleFault(`page plan, ${twice ? 'doubled' : 'dropped'} photograph ${at + 1}`, r, truth, [0, 1, 2, 3], Math.floor(at / R), at % R, twice);
    }
  }

  // And at a fingerprint too coarse for the fringe, where a doubled phase frame
  // passes every phase-step identity and the photograph it pushes past the end
  // of the run is what gives it away.
  for (const where of [{ azimuth: 0, elevation: 70, distance: 3 }, { azimuth: 110 }, { azimuth: 250 }]) {
    const c = scene(CHEAP, 16, where);
    const e = expectedOf(CHEAP);
    const cam = camera(c, 7);
    const clean = indexPosition(cam(position(c)).prints, e);
    const base = position(c);
    for (let at = 0; at < base.length; at++) {
      const shot = base[at];
      if (shot === null || !clean.usableProjectors.includes(shot.projector)) continue;
      for (const twice of [false, true]) {
        const { prints, truth } = cam(singleFault(base, at, twice));
        const r = indexPosition(prints, e);
        checkSingleFault(
          `16-block plan at ${JSON.stringify(where)}, ${twice ? 'doubled' : 'dropped'} photograph ${at + 1}`,
          r,
          truth,
          clean.usableProjectors,
          shot.projector,
          shot.frame,
          twice,
        );
      }
    }
  }
});

test('a drop and a duplicate that cancel pass only where no photograph the decoder reads differently moved', () => {
  // `indexByFingerprint`'s documented limit, and two this reader adds. A
  // cancelling pair that disturbs only phase frames passes when the fingerprint
  // cannot resolve the fringe. A photograph can stand in for one it matches
  // over the crescent — a black for a Gray plane that lights none of it — and
  // the run is the same run to within what the complement check tolerates. And
  // a black shot twice with the first Gray plane's complement dropped, where
  // that plane lights the whole crescent, swaps the pair — which is
  // photographically the same run seen from the other half of the raster, so
  // nothing that reads photographs can tell. Every other cancelling pair is
  // refused.
  const expected = expectedOf(CHEAP);
  const pairs = expected.complements?.pairs ?? [];
  const phaseSlots = new Set((expected.phases ?? []).flat());
  let phaseBlock = 0;
  let sameContent = 0;
  let swaps = 0;
  let refused = 0;
  let tried = 0;
  // Two scenes: one seeing all four projectors from above, and one where
  // projector 1's first Gray plane lights its whole crescent, which is where
  // the swap can happen.
  for (const [where, runs] of [
    [{ azimuth: 0, elevation: 70, distance: 3 }, [0, 1]],
    [{ azimuth: 110 }, [0]],
  ] as const) {
    const s = scene(CHEAP, 16, where);
    const R = s.specs.length;
    const shoot = camera(s, 8);
    for (const p of runs) {
      /**
       * Whether the photograph of frame `a` stands in for frame `b` over the
       * region the run's placed white and black light — the region the reader
       * checked and the decoder will read. Within the tolerance the complement
       * check gives a photograph standing in for another.
       */
      const alike = (a: number, b: number, white: number, black: number): boolean => {
        const W = s.clean[p][white];
        const B = s.clean[p][black];
        let dev = 0;
        let mod = 0;
        for (let i = 0; i < W.length; i++) {
          const m = W[i] - B[i];
          if (m < DARK_LIMIT) continue;
          dev += Math.abs(s.clean[p][a][i] - s.clean[p][b][i]);
          mod += m;
        }
        return mod > 0 && dev <= COMPLEMENT_LIMIT * mod;
      };
      for (let drop = 0; drop < R; drop++) {
        for (let dup = 0; dup < R; dup++) {
          if (dup === drop) continue;
          const shots = position(s);
          const frames: Shot[] = [];
          for (let f = 0; f < R; f++) {
            if (f === drop) continue;
            frames.push({ projector: p, frame: f });
            if (f === dup) frames.push({ projector: p, frame: f });
          }
          shots.splice(p * R, R, ...frames);
          const { prints, truth } = shoot(shots);
          const r = indexPosition(prints, expected);
          tried++;
          for (const q of expectedSeen(where)) if (q !== p) assert.ok(r.usableProjectors.includes(q));
          if (!r.usableProjectors.includes(p)) {
            refused++;
            continue;
          }
          const start = r.assignment.indexOf(p * R);
          const moved: number[] = [];
          for (let f = 0; f < R; f++) if (truth[start + f] !== p * R + f) moved.push(f);
          const got = (f: number): number => truth[start + f] - p * R;
          const label = `projector ${p + 1}, frame ${drop + 1} dropped and frame ${dup + 1} doubled`;
          if (moved.every((f) => phaseSlots.has(f) && phaseSlots.has(got(f)))) {
            phaseBlock++;
            continue;
          }
          const same = (a: number, b: number): boolean => alike(a, b, got(0), got(1));
          if (moved.every((f) => same(got(f), f))) {
            sameContent++;
            continue;
          }
          const swapped = pairs.find(([a, b]) => moved.includes(a) && moved.includes(b));
          assert.ok(
            swapped !== undefined && moved.length === 2 && same(got(swapped[0]), swapped[1]) && same(got(swapped[1]), swapped[0]),
            `${label}: placed with frames ${moved.map((f) => f + 1)} moved`,
          );
          // Exactly the configuration the docblock names: the black twice, the
          // first plane's complement dropped, the first plane lit over the crescent.
          assert.deepEqual([drop, dup, swapped[0]], [3, 1, 2], label);
          assert.ok(levelOver(s, p, s.clean[p][2]) > 0.9, label);
          swaps++;
        }
      }
    }
  }
  // Measured: 3366 cancelling pairs over the three runs; the counts below are
  // what the model gives, pinned loosely so a change that lets more through fails.
  assert.ok(phaseBlock > 0, 'the phase-block limit should show at this grid');
  assert.ok(refused > 0.95 * tried, `${refused} of ${tried} refused`);
  assert.ok(swaps >= 1 && swaps <= 3, `${swaps} swaps`);
  assert.ok(sameContent >= 0);
});

/** The projectors the model's camera sees at the placements these tests use. */
function expectedSeen(where: Placement): number[] {
  if (where.elevation === 70) return [0, 1, 2, 3];
  if (where.azimuth === 110) return [0, 1, 2];
  if (where.azimuth === 250) return [1, 2, 3];
  return [0, 1, 2, 3];
}

// ---------------------------------------------------------------------------
// Test 7 — a straddled photograph, the complement check's own case
// ---------------------------------------------------------------------------

/** Exact kinds for a folder, as EXPERIMENT-10's counterfactual reader was handed them. */
function exactObservations(truth: readonly number[], runLength: number): { ordinal: number; mean: number; litFraction: number }[] {
  return truth.map((t, i) => {
    const f = t < 0 ? 1 : t % runLength;
    const lit = f === 0 ? 1 : f === 1 ? 0 : 0.5;
    return { ordinal: i, mean: lit, litFraction: lit };
  });
}

test('a straddled Gray plane is refused where the complement check refuses it, with the pair named', () => {
  // The levels `indexing.test.ts` pins: a pattern frame smeared into its own
  // complement misses the identity by the smear. One smeared the other way, into
  // the next plane, misses by the smear times the share of the crescent where
  // the two planes differ — a half on a flat raster, anything on a crescent — so
  // that miss is read off the model's noiseless frames rather than assumed. The
  // run is found by its phase frames, so the verdict is the complement check's,
  // unchanged: the same one `indexByFingerprint` gives the same photographs when
  // it is handed every kind exactly.
  const s = scene(PAGE, 64, { azimuth: 0 });
  const R = s.specs.length;
  const expected = expectedOf(PAGE);
  const shoot = camera(s, 9);
  const noiseless = (values: Float32Array): FrameFingerprint =>
    fingerprint({ width: 64, height: 64, channels: 1, data: values }, 0, 64);
  let refused = 0;
  let placed = 0;
  for (const weight of [0.5, 0.75, 0.85, 0.9, 0.95]) {
    for (const [frame, into] of [
      [2, 3],
      [3, 4],
    ] as const) {
      const shots = position(s);
      shots[frame] = { projector: 0, frame, blend: { projector: 0, frame: into, weight } };
      const blended = s.clean[0][frame].map((v, k) => weight * v + (1 - weight) * s.clean[0][into][k]);
      const miss = complementResidual(
        noiseless(frame === 2 ? blended : s.clean[0][2]),
        noiseless(frame === 3 ? blended : s.clean[0][3]),
        noiseless(s.clean[0][0]),
        noiseless(s.clean[0][1]),
      ) as number;
      // Blocks astride the plane's edge carry less than the full difference, so
      // a little under the smear.
      if (frame === 2) assert.ok(Math.abs(miss - (1 - weight)) < 0.03, `the pattern side misses by the smear: ${miss}`);
      const { prints, truth } = shoot(shots);
      const r = indexPosition(prints, expected);
      const label = `frame ${frame + 1} at ${weight} of itself (misses by ${miss.toFixed(3)})`;
      assert.equal(misplaced(r.assignment, truth), 0, label);
      const oracle = indexByFingerprint(exactObservations(truth, R), prints, expected);
      assert.equal(r.usableProjectors.includes(0), oracle.usableProjectors.includes(0), `${label}: the complement check decides`);
      if (miss > COMPLEMENT_LIMIT + 0.03) {
        refused++;
        assert.ok(!r.usableProjectors.includes(0), `${label}: placed`);
        assert.match(r.problems.join(' '), /Projector 1's frames 3 and 4 were played as a pattern and its complement/, label);
        assert.match(r.problems.join(' '), /Re-shoot projector 1\./, label);
      } else if (miss < COMPLEMENT_LIMIT - 0.03) {
        placed++;
        assert.ok(r.usableProjectors.includes(0), `${label}: refused: ${r.problems.join(' | ')}`);
      }
    }
  }
  assert.ok(refused >= 2 && placed >= 2, `${refused} refused, ${placed} placed`);
});

// ---------------------------------------------------------------------------
// Test 8 — re-shoots
// ---------------------------------------------------------------------------

/** Two folders' photographs, one after the other, renumbered as one folder. */
function joined(a: Photos, b: Photos): Photos {
  const offset = a.prints.length;
  return {
    prints: [...a.prints, ...b.prints.map((f, i) => ({ ...f, ordinal: offset + i }))],
    stats: [...a.stats, ...b.stats.map((f, i) => ({ ...f, ordinal: offset + i }))],
    truth: [...a.truth, ...b.truth],
  };
}

test('a re-shot run appended to its position replaces the original, and one that matches nothing is refused', () => {
  // F7. The page tells an operator to re-shoot one projector; this is where the
  // re-shoot goes — after the position, in the same folder — and it is matched
  // to its projector by its white and black against the original's, or, when
  // the original was too broken to be found, by photographs of the original
  // that it copies. Never by where it falls in the count.
  const s = scene(PAGE, 64, { azimuth: 0 });
  const R = s.specs.length;
  const expected = expectedOf(PAGE);
  const shoot = camera(s, 10);
  const reshoot = (p: number, pre = 0, after = 0): Shot[] => [
    ...Array.from({ length: pre }, () => ({ projector: p, frame: 0 })),
    ...run(s, p),
    ...Array.from({ length: after }, (): Shot => null),
  ];

  // The original broken badly enough not to be found at all: a Gray frame lost.
  {
    const broken = position(s, { trailing: 2 });
    broken.splice(R + 6, 1);
    const shots = [...broken, ...reshoot(1, 2, 1)];
    const { prints, truth } = shoot(shots);
    const r = indexPosition(prints, expected);
    assert.deepEqual(r.problems, [], 'a broken original with its re-shoot appended');
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    assert.equal(misplaced(r.assignment, truth), 0);
    const used = shots.length - 1 - R;
    assert.deepEqual(r.reshoots, [{ projector: 1, used, replaced: R }]);
    assert.ok(r.assignment[used] === R && r.assignment[R] === null, 'the re-shoot is what is placed');
    assert.ok(r.notes.some((n) => n.startsWith("Projector 2's run") && n.includes('was replaced by its re-shoot')));
  }

  // The original found but refused by its pairs: a straddled Gray plane.
  {
    const straddled = position(s);
    straddled[R + 2] = { projector: 1, frame: 2, blend: { projector: 1, frame: 3, weight: 0.5 } };
    const shots = [...straddled, ...reshoot(1)];
    const { prints, truth } = shoot(shots);
    const r = indexPosition(prints, expected);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    assert.equal(misplaced(r.assignment, truth), 0);
    assert.deepEqual(r.reshoots.map((x) => [x.projector, x.used]), [[1, 4 * R]]);
  }

  // The original fine: the latest run that passes is the one used.
  {
    const shots = [...position(s, { trailing: 1 }), ...reshoot(3)];
    const { prints, truth } = shoot(shots);
    const r = indexPosition(prints, expected);
    assert.deepEqual(r.problems, []);
    assert.equal(misplaced(r.assignment, truth), 0);
    assert.deepEqual(r.reshoots, [{ projector: 3, used: 4 * R + 1, replaced: 3 * R }]);
  }

  // Re-shot from a camera that moved three degrees: it matches no original,
  // and it is refused rather than filed by count. The original is still used.
  {
    const moved = scene(PAGE, 64, { azimuth: 3 });
    const photos = joined(shoot(position(s, { trailing: 1 })), camera(moved, 11)(run(moved, 1)));
    const r = indexPosition(photos.prints, expected);
    assert.equal(r.ok, false);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    assert.deepEqual(r.reshoots, []);
    assert.equal(misplaced(r.assignment, photos.truth), 0);
    assert.match(r.problems.join(' '), /after the end of this camera position, matches no projector/);
    assert.match(r.problems.join(' '), /the camera moved between the two/);
  }

  // A re-shoot that matches more than one projector cannot say which it
  // re-shoots. On a sphere no two projectors photograph alike, so it takes two
  // projectors stacked on one mount — projector 2 placed where projector 1 is,
  // at its brightness — for the position to hold two runs a re-shoot matches.
  {
    const stackedRig = sceneWith({ azimuths: [45, 45, 225, 315], gains: [1, 1, 1.06, 0.97] });
    const photos = camera(stackedRig, 18)([...position(stackedRig, { trailing: 1 }), ...run(stackedRig, 0)]);
    const r = indexPosition(photos.prints, expected);
    assert.equal(misplaced(r.assignment, photos.truth), 0);
    assert.deepEqual(r.reshoots, []);
    assert.match(r.problems.join(' '), /after the end of this camera position, matches more than one projector/);
  }

  // A re-shoot handed in on its own is refused, with how to hand it in.
  {
    const { prints } = shoot(reshoot(1, 3, 2));
    const r = indexPosition(prints, expected);
    assert.equal(r.ok, false);
    assert.deepEqual(r.usableProjectors, []);
    assert.match(r.problems[0] ?? '', /This looks like part of a position: a re-shoot of one projector handed in on its own/);
    assert.match(r.problems[0] ?? '', /added to the end of that camera position's folder/);
  }
});

// ---------------------------------------------------------------------------
// Coarse fringes, and plans with an odd number of phase steps
// ---------------------------------------------------------------------------

test('a fringe coarse against the crescent still finds every run: the steps are held to identities, not to a half', () => {
  // The design's open risk on coarse fringes. `PLAN_LIMITS` lets a plan put
  // anywhere from 128 fringes across the raster down to an eighth of one, and a
  // phase step averages to half its range over a crescent only while the
  // crescent spans a fringe or more. So the reader asks the steps what holds at
  // any fringe: step k and step k + N/2 are complements, and together the steps
  // have no more contrast than a cosine can. Measured here first: at every one
  // of these plans some run's steps read well outside a quarter to three
  // quarters of its range, where a test of "about half" would lose the run.
  for (const [plan, blocks] of [
    [{ grayBits: 1, phaseSteps: 4, phasePeriodStrides: 2 }, 16],
    [{ grayBits: 2, phaseSteps: 4, phasePeriodStrides: 2 }, 16],
    [{ grayBits: 6, phaseSteps: 4, phasePeriodStrides: 16 }, 64],
  ] as const) {
    const expected = expectedOf(plan);
    const phaseSlots = (expected.phases ?? []).flat();
    let outOfBand = 0;
    for (const azimuth of [0, 110, 250]) {
      const s = scene(plan, blocks, { azimuth });
      const { prints, truth } = camera(s, 12)(position(s));
      const r = indexPosition(prints, expected);
      const label = `${2 ** plan.grayBits / plan.phasePeriodStrides} fringes across, azimuth ${azimuth}`;
      assert.deepEqual(r.problems, [], label);
      assert.equal(misplaced(r.assignment, truth), 0, label);
      assert.ok(r.usableProjectors.length >= 2, `${label}: placed ${r.usableProjectors}`);
      for (const p of r.usableProjectors) {
        const levels = phaseSlots.map((j) => levelOver(s, p, s.clean[p][j]));
        if (levels.some((l) => l < 0.2 || l > 0.8)) outOfBand++;
      }
    }
    assert.ok(outOfBand > 0, `${plan.grayBits} bits, ${plan.phasePeriodStrides} strides: no coarse run to test`);
  }
});

test('an odd number of phase steps has no complements among them, so it is read while the fringe is fine and refused when not', () => {
  // With five steps no step is half a cycle from another, so the reader falls
  // back to asking each step for about half the run's range, and the steps for
  // their sum. Fine fringes: read. Two fringes across the raster: refused out
  // loud, and nothing filed wrong.
  const fine = { grayBits: 6, phaseSteps: 5, phasePeriodStrides: 2 };
  const s = scene(fine, 64, { azimuth: 0 });
  const { prints, truth } = camera(s, 13)(position(s));
  const r = indexPosition(prints, expectedOf(fine));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
  assert.equal(misplaced(r.assignment, truth), 0);

  const coarse = { grayBits: 3, phaseSteps: 5, phasePeriodStrides: 4 };
  let refusedRuns = 0;
  for (const azimuth of [20, 110, 250]) {
    const c = scene(coarse, 16, { azimuth });
    const photos = camera(c, 14)(position(c));
    const q = indexPosition(photos.prints, expectedOf(coarse));
    assert.equal(misplaced(q.assignment, photos.truth), 0, `azimuth ${azimuth}`);
    refusedRuns += q.problems.filter((x) => /Re-shoot projector \d\./.test(x)).length;
  }
  assert.ok(refusedRuns > 0, 'a coarse odd-step plan should lose runs, loudly');
});

// ---------------------------------------------------------------------------
// What is refused before anything is read
// ---------------------------------------------------------------------------

test('the checks it shares with the fingerprint mechanism refuse in the same words', () => {
  const s = scene(CHEAP, 16, { azimuth: 0, elevation: 70, distance: 3 });
  const expected = expectedOf(CHEAP);
  const R = s.specs.length;
  const { prints, truth } = camera(s, 15)(position(s));
  const observations = exactObservations(truth, R);
  const same = (label: string, fps: readonly FrameFingerprint[], e: ExpectedSequence): void => {
    const a = indexPosition(fps, e);
    const b = indexByFingerprint(observations, fps, e);
    assert.equal(a.ok, false, label);
    assert.deepEqual(a.usableProjectors, [], label);
    // The fingerprint mechanism can say something of its own first — the
    // bookends it is built on refuse a plan with no references before it looks
    // — so the sentence has to be among its problems, word for word.
    assert.ok(b.problems.includes(a.problems[0] ?? ''), `${label}: ${a.problems[0]}`);
  };
  const short = { ...prints[5], values: prints[5].values.slice(0, 10) };
  same('a fingerprint short of its own grid', prints.map((f, i) => (i === 5 ? short : f)), expected);
  const other = fingerprint({ width: 8, height: 8, channels: 1, data: new Float32Array(64) }, 7, 8);
  same('fingerprints on different grids', prints.map((f, i) => (i === 7 ? other : f)), expected);
  same('fingerprints too coarse for the plan', prints, { ...expected, complements: { pairs: expected.complements?.pairs ?? [], minBlocks: 32 } });
  same('pairs outside the run', prints, { ...expected, complements: { pairs: [[40, 41]], minBlocks: 16 } });
  same('no pairs at all', prints, { ...expected, complements: undefined });
  same('no references', prints, { ...expected, kinds: expected.kinds.map(() => 'patterned' as const) });
});

test('what only this reader needs is refused by name: the phase steps, the folder order, a dark or unreadable folder', () => {
  const s = scene(CHEAP, 16, { azimuth: 0, elevation: 70, distance: 3 });
  const expected = expectedOf(CHEAP);
  const shoot = camera(s, 16);
  const { prints } = shoot(position(s));

  const noPhases = indexPosition(prints, { ...expected, phases: undefined });
  assert.match(noPhases.problems[0] ?? '', /does not say which frames of a run are phase steps/);

  const bad = indexPosition(prints, { ...expected, phases: [[0, 1, 2, 3]] });
  assert.match(bad.problems[0] ?? '', /lists phase steps 1, 2, 3, 4 of a run/);

  const swapped = prints.slice();
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.match(indexPosition(swapped, expected).problems[0] ?? '', /Fingerprint 4 says it is photograph 4, and it is number 3 in the list/);

  const dark = shoot(Array.from({ length: prints.length }, (): Shot => null));
  const d = indexPosition(dark.prints, expected);
  assert.equal(d.ok, false);
  assert.match(d.problems[0] ?? '', /^Every one of the 136 photographs is dark/);

  // The same photographs read as if their phase steps alternated between the
  // axes: lit, and no run anywhere.
  const wrongPlan = indexPosition(prints, {
    ...expected,
    phases: [
      [18, 20, 22, 24, 26, 28, 30, 32],
      [19, 21, 23, 25, 27, 29, 31, 33],
    ],
  });
  assert.equal(wrongPlan.ok, false);
  assert.match(wrongPlan.problems[0] ?? '', /^No projector run could be found in the 136 photographs/);
  assert.equal(indexPosition([], expected).problems[0]?.startsWith('The folder holds no photographs'), true);
});

test('phase slots holding a white, a black, a plane lit nowhere and one lit everywhere are not a run', () => {
  // What PHASE_CONTRAST_LIMIT is for. Those four photographs pair up the way
  // a step and the step half a cycle on do — white with the plane lit nowhere,
  // black with the plane lit everywhere, each pair summing to white plus black —
  // so the phase steps' own identities pass them. It is the configuration a
  // window that is not a run meets when the next projector covers this one's
  // crescent at its own brightness: that run's white and black, then its first
  // Gray pair, fall in the phase slots. What gives it away is contrast: those
  // four read 1, 0, 0 and 1 of the run's range, which no cosine does.
  const s = scene(PAGE, 64, { azimuth: 0 });
  const expected = expectedOf(PAGE);
  const v = expected.phases?.[1] ?? [];
  const shots = position(s);
  // Projector 1's v steps photographed as white, black, black, white.
  [0, 1, 1, 0].forEach((f, k) => {
    shots[v[k]] = { projector: 0, frame: f };
  });
  const { prints, truth } = camera(s, 17)(shots);
  const r = indexPosition(prints, expected);
  assert.equal(misplaced(r.assignment, truth), 0);
  assert.ok(!r.usableProjectors.includes(0), 'the run was taken for one');
  assert.match(r.problems.join(' '), /Re-shoot projector 1\./);
  assert.deepEqual(r.usableProjectors, [1, 2, 3]);
});
