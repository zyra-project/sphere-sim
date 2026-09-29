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

/** The page plan at azimuth 0, or where given, with the projectors moved or re-balanced. */
function sceneWith(rig: { azimuths: number[]; gains: number[] }, where: Placement = { azimuth: 0 }): Scene {
  const saved = [PROJECTOR_AZIMUTHS.slice(), PROJECTOR_GAINS.slice()];
  PROJECTOR_AZIMUTHS.splice(0, 4, ...rig.azimuths);
  PROJECTOR_GAINS.splice(0, 4, ...rig.gains);
  try {
    return sceneOf(PAGE, 64, where);
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
            // A refusal is always in words, and only a dark slot is out of view.
            if (r.problems.some((x) => x.length === 0) || (!r.ok && r.problems.length === 0)) {
              assert.fail(`unseen [${unseen.map((p) => p + 1)}], fault ${JSON.stringify(fault)}: refused without words`);
            }
            for (const q of r.unseenProjectors) {
              if (!unseen.includes(q)) assert.fail(`unseen [${unseen.map((p) => p + 1)}]: projector ${q + 1} said out of view`);
            }
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
  // Measured: 11 654 of 19 680 seen runs placed, 59.2% — 58.7% until the reading
  // that no run of the position was found stopped contesting folders whose
  // photographs before the first run hold nothing a run found repeats. The rest
  // are refused on purpose — the run a black-frame fault broke, and folders whose
  // ends allow more than one numbering or whose runs read two ways — so the floor
  // sits just under the measured figure: a change that refuses more fails here,
  // and has to say why. The ends are held to lower bounds only, so a folder that
  // two numberings fit is refused rather than one of them excluded by an upper
  // bound and the other used — which filed runs a projector over once the extras
  // passed the allowance (the overrun test below). That costs this enumeration
  // 60.1% -> 58.7%, all of it in folders with 20 or more extras at one end and an
  // end at the other that cannot say how many of them are extras: 33 or 40 dark
  // photographs, or a broken run.
  assert.ok(folders > 5000, `${folders} folders`);
  assert.ok(placedRuns > 0.58 * seenRuns, `placed ${placedRuns} of ${seenRuns} seen runs`);
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
    assert.match(r.problems.join(' '), /the camera moved between the two: shoot the whole camera position again, into a folder of its own, and read it under the same camera number/);
  }

  // Two projectors that photograph alike are outside what this reads: on a
  // sphere no two do, so a run that repeats another's white and black is read
  // as that projector shot again. It takes two projectors stacked on one
  // mount — projector 2 placed where projector 1 is, at its brightness — to
  // make one, and then the second is a repeat of the first in the middle of
  // the position, which no reading of the folder fits. Refused, in words, and
  // nothing filed.
  {
    const stackedRig = sceneWith({ azimuths: [45, 45, 225, 315], gains: [1, 1, 1.06, 0.97] });
    const photos = camera(stackedRig, 18)([...position(stackedRig, { trailing: 1 }), ...run(stackedRig, 0)]);
    const r = indexPosition(photos.prints, expected);
    assert.equal(misplaced(r.assignment, photos.truth), 0);
    assert.equal(r.ok, false);
    assert.deepEqual(r.usableProjectors, []);
    assert.deepEqual(r.reshoots, []);
    assert.match(r.problems.join(' '), /^The run at photographs 35–68 shows the same white and black as the run at photographs 1–34, and no reading of the folder fits the two/);
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
// Test 8b — the re-shoot the page's own remedy produces
// ---------------------------------------------------------------------------

/**
 * What an operator adds to a position's folder by following a refusal's remedy
 * for projector `q` (`handIn` in `indexing.ts`): step the page to q's white and
 * press Play. Photographs taken before Play show that white. Play does not stop
 * after q's run — `advance()` in `packages/web/web/emit.ts` plays every later
 * projector's run and then paints black — so a camera left running appends runs
 * q to P and then dark photographs. A camera stopped once q's run is done has
 * caught what the page went on to show: the next projector's white, then its
 * black. A projector this camera cannot see is dark photographs in the re-shoot,
 * as in the position.
 */
function reshootFrom(
  s: Scene,
  q: number,
  options: { unseen: readonly number[]; before: number; after: number; playedOn: boolean },
): Shot[] {
  const R = s.specs.length;
  const last = options.playedOn ? PROJECTOR_AZIMUTHS.length - 1 : q;
  const shot = (p: number, f: number): Shot => (options.unseen.includes(p) ? null : { projector: p, frame: f });
  const shots: Shot[] = [];
  for (let i = 0; i < options.before; i++) shots.push(shot(q, 0));
  for (let p = q; p <= last; p++) for (let f = 0; f < R; f++) shots.push(shot(p, f));
  for (let i = 0; i < options.after; i++) shots.push(last === PROJECTOR_AZIMUTHS.length - 1 ? null : shot(last + 1, i));
  return shots;
}

/**
 * Why projector `q` was re-shot: its original clean, lost to a Gray frame
 * dropped or doubled (no run is found there), or refused by a straddled pair.
 */
type Original = 'clean' | 'dropped' | 'doubled' | 'straddled';

function spoiled(shots: readonly Shot[], q: number, R: number, original: Original): Shot[] {
  const out = shots.slice();
  const gray = q * R + 6;
  if (original === 'dropped') out.splice(gray, 1);
  if (original === 'doubled') out.splice(gray, 0, out[gray]);
  if (original === 'straddled') out[q * R + 2] = { projector: q, frame: 2, blend: { projector: q, frame: 3, weight: 0.5 } };
  return out;
}

test('a re-shoot played on to the end replaces every run it shoots again, and one stopped after its own run replaces that run', () => {
  // F7 as the remedy plays out: what reaches the folder is runs q to P and the
  // black after them, unless the camera is stopped. Every shape that makes, on
  // the cheap plan: every set of projectors out of view, each projector re-shot,
  // q's original clean, lost or refused, 0, 1 or 2 dark photographs kept after
  // the position, 0, 1 or 3 of q's white before Play, and 0, 1 or 2 after the
  // re-shoot. The re-shoot itself is clean, so every projector in it that the
  // camera sees is read from it — the latest run that passes — and nothing is
  // refused. With one exception the reader cannot count past: a camera that sees
  // only q, whose original was lost, leaves the position no run to number
  // anything from, and that is refused in words.
  //
  // Two things only this shape showed, both fixed with it. With projector 1 out
  // of view, a run of projector 4 re-shot within three photographs of the
  // position's end also read as projectors 1 to 4 — the dark slot as photographs
  // before Play, the original and its re-shoot as two neighbours a camera cannot
  // tell apart — and the two readings refused each other. And an original lost
  // to a doubled frame puts its spare photograph in the next slot, or past the
  // last, so the photographs its re-shoot copies named two projectors.
  const s = scene(CHEAP, 16, { azimuth: 0, elevation: 70, distance: 3 });
  const R = s.specs.length;
  const P = PROJECTOR_AZIMUTHS.length;
  const expected = expectedOf(CHEAP);
  const shoot = camera(s, 20);
  const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  let folders = 0;
  let alone = 0;
  for (let mask = 0; mask < 16; mask++) {
    const unseen = [0, 1, 2, 3].filter((p) => ((mask >> p) & 1) === 1);
    const seen = [0, 1, 2, 3].filter((p) => !unseen.includes(p));
    for (const q of seen) {
      // Stopped differs from played on only after q's run, and not at all for
      // the last projector, so it is asked of the clean original alone.
      const shapes: [Original, boolean][] = [
        ...(['clean', 'dropped', 'doubled', 'straddled'] as const).map((o): [Original, boolean] => [o, true]),
        ...(q < P - 1 ? [['clean', false] as [Original, boolean]] : []),
      ];
      for (const [original, playedOn] of shapes) {
        for (const trailing of [0, 1, 2]) {
          for (const before of [0, 1, 3]) {
            for (const after of [0, 1, 2]) {
              const own = spoiled(position(s, { unseen, trailing }), q, R, original);
              const shots = [...own, ...reshootFrom(s, q, { unseen, before, after, playedOn })];
              const { prints, truth } = shoot(shots);
              const r = indexPosition(prints, expected);
              folders++;
              const label = (): string =>
                `unseen [${unseen.map((p) => p + 1)}], projector ${q + 1} re-shot and ${playedOn ? 'played on' : 'stopped'}, ` +
                `original ${original}, ${trailing} dark after the position, ${before} before Play, ${after} after: ` +
                `placed [${r.usableProjectors.map((p) => p + 1)}], re-shot [${r.reshoots.map((x) => x.projector + 1)}]; ` +
                r.problems.join(' | ');
              if (misplaced(r.assignment, truth) > 0) assert.fail(`${label()}: photographs filed wrong`);
              if (seen.length === 1 && (original === 'dropped' || original === 'doubled')) {
                alone++;
                const why = r.problems[0] ?? '';
                if (
                  r.usableProjectors.length > 0 ||
                  !why.startsWith('No run of this camera position could be read') ||
                  !why.includes('Shoot the whole camera position again, into a folder of its own, and read it under the same camera number.')
                ) {
                  assert.fail(label());
                }
                continue;
              }
              const reshot = seen.filter((p) => p === q || (playedOn && p > q));
              if (
                r.problems.length > 0 ||
                !same(r.usableProjectors, seen) ||
                !same(r.unseenProjectors, unseen) ||
                !same(
                  r.reshoots.map((x) => x.projector),
                  reshot,
                ) ||
                r.reshoots.some((x) => x.used < own.length)
              ) {
                assert.fail(label());
              }
            }
          }
        }
      }
    }
  }
  assert.equal(folders, 4104);
  assert.equal(alone, 216);

  // The page's own plan, where test 8 reads its re-shoots: each projector re-shot
  // and played on, its original clean or lost to a doubled frame, at the
  // smallest and the largest extras above; and the shape that read two ways.
  const page = scene(PAGE, 64, { azimuth: 0 });
  const pageExpected = expectedOf(PAGE);
  const pageShoot = camera(page, 21);
  const pageShapes: [number[], number, Original, number, number, number][] = [
    ...[0, 1, 2, 3].flatMap((q) =>
      (['clean', 'doubled'] as const).flatMap((o) => [
        [[], q, o, 0, 0, 0] as [number[], number, Original, number, number, number],
        [[], q, o, 2, 3, 2] as [number[], number, Original, number, number, number],
      ]),
    ),
    [[0], 3, 'clean', 0, 0, 0],
    [[2], 1, 'doubled', 1, 1, 1],
  ];
  for (const [unseen, q, original, trailing, before, after] of pageShapes) {
    const own = spoiled(position(page, { unseen, trailing }), q, page.specs.length, original);
    const { prints, truth } = pageShoot([...own, ...reshootFrom(page, q, { unseen, before, after, playedOn: true })]);
    const r = indexPosition(prints, pageExpected);
    const label = `page plan, unseen [${unseen.map((p) => p + 1)}], projector ${q + 1} re-shot, original ${original}, ${trailing}/${before}/${after}`;
    const seen = [0, 1, 2, 3].filter((p) => !unseen.includes(p));
    assert.equal(misplaced(r.assignment, truth), 0, label);
    assert.deepEqual(r.problems, [], label);
    assert.deepEqual(r.usableProjectors, seen, label);
    assert.deepEqual(
      r.reshoots.map((x) => x.projector),
      seen.filter((p) => p >= q),
      label,
    );
    assert.ok(r.reshoots.every((x) => x.used >= own.length), label);
  }

  // Played on, the later projectors are shot again whether or not anything was
  // wrong with them. One of those runs straddling costs nothing: that
  // projector's own run passed and is used, and the failed re-shoot is a note —
  // asking for it to be re-shot would be asking for a run the position has.
  {
    const own = spoiled(position(page, { trailing: 1 }), 1, page.specs.length, 'straddled');
    const again = reshootFrom(page, 1, { unseen: [], before: 1, after: 2, playedOn: true });
    const third = 1 + page.specs.length;
    again[third + 4] = { projector: 2, frame: 4, blend: { projector: 2, frame: 5, weight: 0.5 } };
    const { prints, truth } = pageShoot([...own, ...again]);
    const r = indexPosition(prints, pageExpected);
    assert.equal(misplaced(r.assignment, truth), 0);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    assert.deepEqual(
      r.reshoots.map((x) => x.projector),
      [1, 3],
    );
    assert.ok(r.assignment[2 * page.specs.length] === 2 * page.specs.length, "projector 3's own run is the one used");
    assert.ok(
      r.notes.some((n) => /^Projector 3's re-shoot at photographs \d+–\d+ did not pass, so its earlier run, which did, is used: its frames 5 and 6/.test(n)),
      r.notes.join(' | '),
    );
  }

  // Why the remedy says to stop the camera and not the page: a page paused on
  // q's last frame is photographed again, and a run followed by more of its own
  // last frame is what a frame doubled inside it looks like. So that re-shoot
  // is refused too, loudly, and projector 2 — whose original was refused, which
  // is why it was re-shot — has no run.
  {
    const own = spoiled(position(page, { trailing: 1 }), 1, page.specs.length, 'straddled');
    const last = { projector: 1, frame: page.specs.length - 1 };
    const { prints, truth } = pageShoot([...own, ...run(page, 1), last, last]);
    const r = indexPosition(prints, pageExpected);
    assert.equal(misplaced(r.assignment, truth), 0);
    assert.deepEqual(r.usableProjectors, [0, 2, 3]);
    assert.deepEqual(r.reshoots, []);
    assert.ok(
      r.problems.some((x) => x.startsWith("Projector 2's re-shot run holds 35 photographs and should hold 34")),
      r.problems.join(' | '),
    );
  }
});

// ---------------------------------------------------------------------------
// Test 8c — a projector re-shot in line
// ---------------------------------------------------------------------------

test('a projector re-shot in line — paused, stepped back, played again — replaces its run, and the count goes on from it', () => {
  // An operator who sees a run go wrong can pause the page, step back to that
  // projector with [ and play again before the position ends. The folder then
  // holds the run, a photograph of what the paused page showed, the run again,
  // and the rest of the position. The same white and black twice is one
  // projector twice, never two — on a sphere no two projectors photograph
  // alike — so the count goes on from the projector it repeats. Read as the next
  // projector instead, every run after it was filed one over: 68 photographs
  // with projector 4 out of view, 34 with projector 1, with the page saying ok.
  const expected = expectedOf(PAGE);
  for (const [azimuth, seen] of [
    [250, [1, 2, 3]],
    [110, [0, 1, 2]],
    [0, [0, 1, 2, 3]],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth });
    const view = (shot: Shot): Shot => (shot !== null && seen.includes(shot.projector as never) ? shot : null);
    for (const original of ['fine', 'straddled'] as const) {
      const shots: Shot[] = [view({ projector: 0, frame: 0 }), view({ projector: 0, frame: 0 })];
      for (let p = 0; p < 4; p++) {
        const own = run(s, p).map(view);
        if (p === 1 && original === 'straddled') own[6] = { projector: 1, frame: 6, blend: { projector: 1, frame: 7, weight: 0.5 } };
        shots.push(...own);
        // Paused on projector 3's white, [ back to projector 2's, Play.
        if (p === 1) shots.push(view({ projector: 2, frame: 0 }), ...run(s, 1).map(view));
      }
      shots.push(null, null, null);
      const { prints, truth } = camera(s, 30)(shots);
      const r = indexPosition(prints, expected);
      const label = `azimuth ${azimuth}, projector 2's first run ${original}`;
      assert.equal(misplaced(r.assignment, truth), 0, label);
      assert.deepEqual(r.problems, [], label);
      assert.deepEqual(r.usableProjectors, [...seen], label);
      assert.deepEqual(r.reshoots, [{ projector: 1, used: 2 + 2 * 34 + 1, replaced: 2 + 34 }], label);
      assert.ok(r.notes.some((n) => n.startsWith('The page was stepped back to projector 2 and played again')), label);
    }
  }

  // Every in-line re-shoot the page's keys make, on the cheap plan: every set of
  // projectors out of view, each projector re-shot straight after its run, with
  // 0 to 3 photographs between — the next projector's white the page paused
  // on, then the re-shot projector's white before Play — its first run fine or
  // straddled, and a couple of photographs before Play and after the black or
  // none. The review that found the defect counted 96 of these 512 folders
  // filed wrong with ok true, and 72 more beside a problem.
  const c = scene(CHEAP, 16, { azimuth: 0, elevation: 70, distance: 3 });
  const R = c.specs.length;
  const shoot = camera(c, 31);
  const e = expectedOf(CHEAP);
  let folders = 0;
  let placed = 0;
  for (let mask = 0; mask < 15; mask++) {
    const unseen = [0, 1, 2, 3].filter((p) => ((mask >> p) & 1) === 1);
    const white = (p: number): Shot => (p > 3 || unseen.includes(p) ? null : { projector: p, frame: 0 });
    for (const q of [0, 1, 2, 3].filter((p) => !unseen.includes(p))) {
      for (const between of [0, 1, 2, 3]) {
        for (const original of ['fine', 'straddled'] as const) {
          for (const [before, after] of [
            [0, 0],
            [2, 3],
          ]) {
            const shots: Shot[] = Array.from({ length: before }, () => white(0));
            for (let p = 0; p < 4; p++) {
              const own = unseen.includes(p) ? run(c, p).map((): Shot => null) : run(c, p);
              if (p === q && original === 'straddled') own[4] = { projector: q, frame: 4, blend: { projector: q, frame: 5, weight: 0.5 } };
              shots.push(...own);
              if (p === q) shots.push(...[white(q + 1), white(q), white(q)].slice(0, between), ...run(c, q));
            }
            for (let i = 0; i < after; i++) shots.push(null);
            const { prints, truth } = shoot(shots);
            const r = indexPosition(prints, e);
            folders++;
            if (misplaced(r.assignment, truth) > 0) {
              assert.fail(
                `unseen [${unseen.map((p) => p + 1)}], projector ${q + 1} re-shot in line with ${between} between, ` +
                  `first run ${original}, ${before}/${after}: filed wrong; placed [${r.usableProjectors.map((p) => p + 1)}]`,
              );
            }
            if (r.ok && r.usableProjectors.length === 4 - unseen.length) placed++;
          }
        }
      }
    }
  }
  assert.equal(folders, 512);
  // Measured: all 512 read whole. Until d4f46c7, 464: a copy of a run lying
  // before the later pass's first slot — the next projector's white the page
  // was paused on — named projector 1, and the folder was refused.
  assert.equal(placed, folders, `${placed} of ${folders} read whole`);

  // A run that repeats nothing cannot be a projector the first pass already
  // holds a run of. Here a re-shoot played on from projector 2 has its
  // projector 3 run from a camera nudged ten degrees: it matches nothing, so it
  // is refused on its own, and the position with the other two re-shot runs is
  // read — rather than a reading that numbers it projector 3 disagreeing with
  // that one, and the whole folder refused.
  {
    const s = scene(PAGE, 64, { azimuth: 0 });
    const nudged = scene(PAGE, 64, { azimuth: -10 });
    const photos = [
      camera(s, 32)([...position(s, { trailing: 3 }), ...run(s, 1)]),
      camera(nudged, 33)(run(nudged, 2)),
      camera(s, 34)(run(s, 3)),
    ].reduce(joined);
    const r = indexPosition(photos.prints, expected);
    assert.equal(misplaced(r.assignment, photos.truth), 0);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    assert.deepEqual(
      r.reshoots.map((x) => x.projector),
      [1, 3],
    );
    assert.equal(r.problems.length, 1, r.problems.join(' | '));
    assert.match(r.problems[0], /^The run at photographs 174–207, after the end of this camera position, /);
  }
});

test('a run shot again in line and spoiled there is not the next projector: the photographs after it that copy it say where they belong', () => {
  // Review B's B2d, review C's C5. The page stepped back in line — Pause, [,
  // Play — to re-shoot a projector, with no photograph between the passes, and
  // the run shot again spoiled by a photograph doubled or dropped, so no run
  // was found there. Counted as the next projector's place, it put every run
  // after it a projector late, decoded while the page refused the rest: 15 of
  // the review's 56 folders on the cheap plan, and 15 again once the page's
  // remedy was followed. A run's photographs belong where the run is, before it
  // or after it; the photographs after a run that copy its frames, other than
  // what a paused page leaves straight after its last, are that run shot again.
  const expected = expectedOf(PAGE);
  for (const azimuth of [0, 110]) {
    const s = scene(PAGE, 64, { azimuth });
    const shoot = camera(s, 8100 + azimuth);
    for (const q of [0, 1]) {
      for (const [how, at] of [
        ['doubled', 11],
        ['dropped', 20],
      ] as const) {
        const again = run(s, q);
        if (how === 'doubled') again.splice(at, 0, again[at]);
        else again.splice(at, 1);
        const shots: Shot[] = [{ projector: 0, frame: 0 }, { projector: 0, frame: 0 }];
        for (let p = 0; p < 4; p++) {
          shots.push(...run(s, p));
          if (p === q) shots.push(...again);
        }
        shots.push(null, null, null);
        const { prints, truth } = shoot(shots);
        const r = indexPosition(prints, expected);
        const label = `azimuth ${azimuth}, projector ${q + 1} shot again in line with photograph ${at + 1} ${how}`;
        assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
        assert.equal(r.ok, false, label);
        assert.ok(
          r.problems.some((x) => x.includes('Shoot the whole camera position again, into a folder of its own')),
          `${label}: ${r.problems.join(' | ')}`,
        );
      }
    }
  }
  // A copy of a run's white after it is not that run played again: Home and ]
  // show every white on the way to a re-shoot. Projector 4's run lost to a
  // dropped photograph, one short of its place, and the re-shoot's walk from
  // projector 1's white straight after it: the first white lies in projector
  // 4's place, and the folder is read with projector 4 re-shot.
  // On the page's plan from azimuth 0 projector 1's second plane lights nine
  // tenths of its crescent, and its white copies it: a frame that reads flat
  // about its median level carries no more than the white does.
  const walk: Shot[] = [0, 1, 2, 3].map((p): Shot => ({ projector: p, frame: 0 }));
  for (const [plan, where] of [
    [CHEAP, { azimuth: 0, elevation: 70, distance: 3 }],
    [PAGE, { azimuth: 0 }],
  ] as const) {
    const c = scene(plan, plan === CHEAP ? 16 : 64, where);
    const e = expectedOf(plan);
    const lost = position(c);
    lost.splice(3 * 34 + 6, 1);
    for (const after of [[null, null, null], [null]] as Shot[][]) {
      const { prints, truth } = camera(c, 55)([...lost, ...walk, ...run(c, 3), ...after]);
      const r = indexPosition(prints, e);
      const label = `${plan === CHEAP ? 'cheap' : "page's"} plan, the walk to the re-shoot straight after the position`;
      assert.equal(misplaced(r.assignment, truth), 0, label);
      assert.deepEqual(r.problems, [], label);
      assert.deepEqual(r.usableProjectors, [0, 1, 2, 3], label);
      assert.deepEqual(
        r.reshoots.map((x) => x.projector),
        [3],
        label,
      );
    }
  }
});

test("a photograph copying a run names the slot it lies in, whichever pass of the page laid that slot", () => {
  // Found by review C's fuzzer once a copy before the first slot stopped naming
  // it. Projector 2 re-shot in line, its re-shot run spoiled, with projector
  // 3's white photographed as the page was stepped back; projector 4 out of
  // view; and the page's remedy added, projector 1 re-shot and played on. One
  // reading takes the added projector 1 for the whole position played again
  // in line, which lays projector 3's place once more after it, and the stray
  // white copying projector 3 — in the first pass's place for projector 3 — was
  // judged by the later pass's layout alone: in no place, so no evidence, and
  // that reading filed projector 3 as projector 4. The first pass's places
  // count too.
  const s = scene(CHEAP, 16, { azimuth: 0, elevation: 70, distance: 3 });
  const expected = expectedOf(CHEAP);
  const dark = (k: number): Shot[] => Array.from({ length: k }, (): Shot => null);
  const white = (p: number): Shot => ({ projector: p, frame: 0 });
  const doubled = (p: number, f: number): Shot[] => {
    const r = run(s, p);
    r.splice(f, 0, r[f]);
    return r;
  };
  for (const seed of [1105223, 8]) {
    const shots = [
      white(0),
      ...run(s, 0),
      ...run(s, 1),
      white(2),
      white(1),
      ...doubled(1, 15),
      ...run(s, 2),
      ...dark(37),
      ...run(s, 0),
      ...run(s, 1),
      ...doubled(2, 9),
      ...dark(36),
      white(0),
      white(0),
      white(1),
      ...dark(37),
    ];
    const { prints, truth } = camera(s, seed)(shots);
    const r = indexPosition(prints, expected);
    assert.equal(misplaced(r.assignment, truth), 0, `seed ${seed}: filed wrong`);
    assert.equal(r.ok, false);
    assert.match(r.problems[0] ?? '', /^The run at photographs \d+–\d+ is copied by photograph \d+, where no run was found/);
  }
  // And what lies between the passes is in neither: the page played part of
  // projector 3's run, was sent Home and played again from projector 1. Taken
  // for photographs before the later pass's first slot, the part of projector
  // 3's run was a run's worth of copies naming projector 1, and the folder was
  // refused; it is read.
  const page = scene(PAGE, 64, { azimuth: 0 });
  const pageExpected = expectedOf(PAGE);
  for (const part of [8, 20]) {
    const again = [white(0), white(0), ...run(page, 0), ...run(page, 1), ...run(page, 2).slice(0, part), ...position(page, { trailing: 3 })];
    const { prints, truth } = camera(page, 7900 + part)(again);
    const r = indexPosition(prints, pageExpected);
    assert.equal(misplaced(r.assignment, truth), 0, `${part} of projector 3 then Home: filed wrong`);
    assert.deepEqual(r.problems, [], `${part} of projector 3 then Home`);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3], `${part} of projector 3 then Home`);
  }
});

test('a spoiled run re-shot from an earlier projector and played on is read: its runs are the same projectors, played on in line or added after', () => {
  // The page's remedy steps to the projector asked for, but Home goes to the
  // first projector's white, and a re-shoot started from there plays every run
  // again. After the page's black that reads two ways — the page played on in
  // line from projector 2, or runs added after the position — and the two
  // differed only in calling the re-shot run of the spoiled projector its own
  // or its re-shoot. The folder was refused as "could be projector 3 or a
  // re-shoot of projector 3" at every place and every ending tried from 250
  // degrees. Both file every run under the same projector, and the latest
  // that passes is used either way.
  const expected = expectedOf(PAGE);
  const s = scene(PAGE, 64, { azimuth: 250 });
  const dark = (k: number): Shot[] => Array.from({ length: k }, (): Shot => null);
  const shoot = camera(s, 7800);
  for (const q of [2, 3]) {
    for (const trail of [0, 3, 17]) {
      const spoilt = run(s, q);
      spoilt.splice(20, 0, spoilt[20]);
      const own = [...dark(2), ...dark(34), ...[1, 2, 3].flatMap((p) => (p === q ? spoilt : run(s, p))), ...dark(trail)];
      const again = [{ projector: 1, frame: 0 }, ...run(s, 1), ...run(s, 2), ...run(s, 3), ...dark(3)];
      const { prints, truth } = shoot([...own, ...again]);
      const r = indexPosition(prints, expected);
      const label = `projector ${q + 1} spoiled, re-shot from projector 2, ${trail} dark between`;
      assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
      assert.deepEqual(r.problems, [], label);
      assert.deepEqual(r.usableProjectors, [1, 2, 3], label);
      assert.ok(r.assignment[own.length + 1 + (q - 1) * 34] === q * 34, `${label}: the re-shot run used`);
    }
  }
});

// ---------------------------------------------------------------------------
// Test 8d — the ends of the folder, past the page's allowance
// ---------------------------------------------------------------------------

test('the ends are held to lower bounds only: photographs past the allowance refuse a folder, and never move its projector numbers', () => {
  // A cap on the photographs before the first run and after the last excluded
  // the true numbering once an end passed it, and left the numbering a
  // projector over alone to be used: with projector 1 out of view and 42 dark
  // photographs after the black, every run was filed one projector early and
  // the page said ok. Held to lower bounds only, both numberings are readings;
  // they disagree, and the folder is refused. One that counts only with more
  // extras than the allowance is refused too.
  const expected = expectedOf(PAGE);
  const R = 34;
  const dark = (k: number): Shot[] => Array.from({ length: k }, (): Shot => null);
  const refusedWhole = (label: string, shots: Shot[], s: Scene, seed: number): string[] => {
    const { prints, truth } = camera(s, seed)(shots);
    const r = indexPosition(prints, expected);
    assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
    assert.equal(r.ok, false, `${label}: read`);
    assert.deepEqual(r.usableProjectors, [], label);
    return r.problems;
  };
  // Projector 1 out of view, 42 to 60 dark photographs after the black.
  const p1Out = scene(PAGE, 64, { azimuth: 250 });
  for (const trailing of [42, 60]) {
    refusedWhole(`projector 1 out of view, ${trailing} after the black`, position(p1Out, { unseen: [0], trailing }), p1Out, 32);
  }
  // Projector 4 out of view, 42 or 50 dark photographs before Play (the page
  // left on black while the camera ran).
  const p4Out = scene(PAGE, 64, { azimuth: 110 });
  for (const before of [42, 50]) {
    const shots = [...dark(before), ...run(p4Out, 0), ...run(p4Out, 1), ...run(p4Out, 2), ...dark(R + 3)];
    refusedWhole(`projector 4 out of view, ${before} dark before Play`, shots, p4Out, 33);
  }
  // All four in view, projector 1's black shot twice (its run is then not
  // found) and 42 photographs after the black.
  const all = scene(PAGE, 64, { azimuth: 0 });
  {
    const shots = position(all, { leading: 2, trailing: 42 });
    shots.splice(3, 0, shots[3]);
    refusedWhole("projector 1's black shot twice, 42 after the black", shots, all, 34);
  }
  // All four in view, the page left on black before Home: 42 dark photographs
  // and two of projector 1's white before Play. The reading that makes projector
  // 4's run a re-shoot matching nothing numbers the first three one over, and
  // disagrees with the reading of all four: refused, in words about the count,
  // not about re-shoots.
  {
    const problems = refusedWhole(
      '42 dark and 2 whites before Play',
      [...dark(42), { projector: 0, frame: 0 }, { projector: 0, frame: 0 }, ...position(all, { trailing: 3 })],
      all,
      35,
    );
    assert.match(problems[0] ?? '', /^The run at photographs 45–78 could be projector 1 or projector 2: /);
    assert.match(problems[0] ?? '', /keep the photographs taken before Play and after the screen goes black to a few\.$/);
    assert.doesNotMatch(problems.join(' '), /re-shoot/i);
  }
  // Projector 4 out of view, and the camera stopped two photographs into its
  // run: from the camera's side the sphere went dark as that run began, which
  // is easy to take for the page's end. Too short for a position with two
  // photographs of the page's first step before Play, and with thirty nothing
  // numbers three runs and two dark photographs as four projectors. Either way
  // the words say which end to wait for: the page's, not the sphere going dark.
  // (With thirty-one DARK photographs before Play — the page left on black —
  // it numbers them one over and says ok: the limit `indexPosition`'s docblock
  // names, which only the procedure prevents.)
  const whites = (k: number): Shot[] => Array.from({ length: k }, (): Shot => ({ projector: 0, frame: 0 }));
  const stopped = [...run(p4Out, 0), ...run(p4Out, 1), ...run(p4Out, 2), ...dark(2)];
  {
    const problems = refusedWhole('projector 4 out of view, stopped as its run began', [...whites(2), ...stopped], p4Out, 36);
    assert.match(problems[0] ?? '', /^The folder holds 106 photographs, /);
    assert.match(
      problems[0] ?? '',
      /And if the camera was started after Play, or stopped before the page had played to its end — the sphere goes dark on the camera's side while a projector this camera cannot see is playing — shoot the whole camera position again, into a folder of its own, and read it under the same camera number\.$/,
    );
  }
  {
    const problems = refusedWhole('projector 4 out of view, 30 before Play, stopped as its run began', [...whites(30), ...stopped], p4Out, 37);
    assert.match(problems[0] ?? '', /^The 3 runs found do not fit 4 projectors /);
    assert.match(
      problems[0] ?? '',
      /start the camera before Play and stop it only once the page has played to its end, not when the sphere goes dark on the camera's side, as it does while a projector this camera cannot see is playing;/,
    );
  }
  // A clean position, every projector in view, 50 dark photographs after the
  // black: one numbering, but only with more extras than the page leaves room
  // for — which is also what a run lost from the folder looks like.
  {
    const problems = refusedWhole('50 after the black', position(all, { trailing: 50 }), all, 36);
    assert.match(problems[0] ?? '', /^The 4 runs found could be projectors 1, 2, 3 and 4 only with 50 taken after the screen went black/);
  }

  // Every set of projectors out of view, on the cheap plan, with the ends taken
  // past the allowance: dark photographs or copies of projector 1's white
  // before, dark after. The review that found the defect counted 216 of 4032
  // such folders filed wrong with ok true, and 432 more beside a problem.
  const c = scene(CHEAP, 16, { azimuth: 0, elevation: 70, distance: 3 });
  const e = expectedOf(CHEAP);
  const shoot = camera(c, 37);
  let folders = 0;
  for (let mask = 1; mask < 15; mask++) {
    const unseen = [0, 1, 2, 3].filter((p) => ((mask >> p) & 1) === 1);
    for (const darkBefore of [true, false]) {
      for (const before of [0, 7, 40, 42, 60]) {
        for (const trailing of [0, 7, 40, 42, 60]) {
          const pre = Array.from({ length: before }, (): Shot => (darkBefore || unseen.includes(0) ? null : { projector: 0, frame: 0 }));
          const { prints, truth } = shoot([...pre, ...position(c, { unseen, trailing })]);
          const r = indexPosition(prints, e);
          folders++;
          if (misplaced(r.assignment, truth) > 0) {
            assert.fail(`unseen [${unseen.map((p) => p + 1)}], ${before} ${darkBefore ? 'dark' : 'whites'} before, ${trailing} after: filed wrong`);
          }
        }
      }
    }
  }
  assert.equal(folders, 700);
});

test('lit photographs no run was found in, straight before the first run or after the last, are a run the count needs a place for', () => {
  // Review B. The ends were counted, never looked at. A camera started four
  // photographs after Play leaves the end of projector 1's run before the first
  // run found; counted as photographs taken before Play, with 31 dark ones after
  // the black, it numbered projectors 2 to 4 as 1 to 3 and the page said ok. The
  // mirror, a camera stopped four photographs early, did the same the other way.
  // And a run's worth of dark photographs inside the position — a projector
  // this camera cannot see played twice — put the last run found in the last
  // projector's place, the lost last run after it "belonging to no run". Lit
  // photographs no run was found in, more than a few strays, that lead straight
  // into a numbering's first run or follow straight on from its last are a run
  // the page was playing there: that numbering is not used.
  const expected = expectedOf(PAGE);
  const R = 34;
  const dark = (k: number): Shot[] => Array.from({ length: k }, (): Shot => null);
  const read = (s: Scene, shots: Shot[], seed: number): { r: ReturnType<typeof indexPosition>; wrong: number } => {
    const { prints, truth } = camera(s, seed)(shots);
    const r = indexPosition(prints, expected);
    return { r, wrong: misplaced(r.assignment, truth) };
  };
  const all = scene(PAGE, 64, { azimuth: 0 });
  {
    const { r, wrong } = read(all, [...position(all).slice(4), ...dark(31)], 90);
    assert.equal(wrong, 0, 'started four late, 31 after the black: filed wrong');
    assert.deepEqual(r.usableProjectors, []);
    assert.match(r.problems[0] ?? '', /only if photographs 1–30, lit and in no run found, were taken before Play/);
    assert.match(r.problems[0] ?? '', /read it under the same camera number/);
  }
  {
    const shots = [...dark(31), ...position(all)];
    const { r, wrong } = read(all, shots.slice(0, shots.length - 4), 91);
    assert.equal(wrong, 0, '31 dark before Play, stopped four early: filed wrong');
    assert.deepEqual(r.usableProjectors, []);
    assert.match(r.problems[0] ?? '', /only if photographs 134–163, lit and in no run found, were taken after the screen went black/);
  }
  // Projector 2 out of view and played again in line, projector 4's run then
  // lost to a doubled photograph.
  const p2Out = scene(PAGE, 64, { azimuth: 300, elevation: 40, distance: 2.5 });
  {
    const p4 = run(p2Out, 3);
    p4.splice(20, 0, p4[20]);
    const shots = [{ projector: 0, frame: 0 }, { projector: 0, frame: 0 }, ...run(p2Out, 0), ...dark(2 * R), ...run(p2Out, 2), ...p4, ...dark(3)];
    const { r, wrong } = read(p2Out, shots, 92);
    assert.equal(wrong, 0, 'an unseen run played twice, the last run lost: filed wrong');
    assert.deepEqual(r.usableProjectors, []);
    assert.match(r.problems[0] ?? '', /were taken after the screen went black\. They follow straight on from the position's last run/);
  }

  // What the ends hold that is not a run is still set aside. The last run lost
  // to a doubled photograph costs that run alone; a spoiled re-shoot of a run
  // found is that run shot again, even straight after the position;
  // projector 1 paused
  // part way and played again from its white leaves its first attempt before
  // the run used; ten of projector 1's white before Play, projector 1's run lost
  // to a dropped black, are the page's step 0 all the same; the room's light
  // coming on as the page goes black is the room's.
  {
    const p4 = run(all, 3);
    p4.splice(20, 0, p4[20]);
    const { r, wrong } = read(all, [{ projector: 0, frame: 0 }, ...run(all, 0), ...run(all, 1), ...run(all, 2), ...p4, ...dark(3)], 93);
    assert.equal(wrong, 0);
    assert.deepEqual(r.usableProjectors, [0, 1, 2]);
    assert.equal(r.problems.length, 1, r.problems.join(' | '));
    assert.match(r.problems[0], /Re-shoot projector 4\./);
  }
  {
    // Straight on from the position, no black or white before it, and its own
    // black dropped: it copies projector 1's frames, so it is projector 1 shot
    // again and not passing, not a fifth run.
    const again = run(all, 0);
    again.splice(1, 1);
    const { r, wrong } = read(all, [...position(all, { leading: 1 }), ...again, ...dark(2)], 94);
    assert.equal(wrong, 0);
    assert.deepEqual(r.problems, [], 'a spoiled re-shoot straight after the position');
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
  }
  {
    const partial = run(all, 0).slice(0, 12);
    partial.push(partial[11], partial[11]);
    const first: Shot = { projector: 0, frame: 0 };
    const { r, wrong } = read(all, [first, first, ...partial, first, ...position(all, { trailing: 3 })], 95);
    assert.equal(wrong, 0);
    assert.deepEqual(r.problems, [], 'projector 1 paused and played again');
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
  }
  {
    const shots = position(all, { leading: 10, trailing: 3 });
    shots.splice(11, 1);
    const { r, wrong } = read(all, shots, 96);
    assert.equal(wrong, 0);
    assert.deepEqual(r.usableProjectors, [1, 2, 3], `projector 1's black dropped after ten of its white: ${r.problems.join(' | ')}`);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /^Projector 1's photographs are lit/);
  }
  {
    // And with a focus shot of projector 4's stripes before the ten: two of the
    // photographs before the first run found are then each lit where the other
    // is not, as a run's are, but the copies of projector 1's white among them
    // are its step 0 still, though its run was not found, and the one stray
    // left is no run.
    const shots: Shot[] = [{ projector: 3, frame: 2 + 2 * 3 }, ...position(all, { leading: 10, trailing: 3 })];
    shots.splice(12, 1);
    const { r, wrong } = read(all, shots, 99);
    assert.equal(wrong, 0);
    assert.deepEqual(r.usableProjectors, [1, 2, 3], `and a focus shot before them: ${r.problems.join(' | ')}`);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /^Projector 1's photographs are lit/);
  }
  {
    const clean = camera(all, 97)(position(all));
    const g = stream(98);
    const room = Array.from({ length: 6 }, (_, k): FrameFingerprint => ({
      ordinal: clean.prints.length + k,
      blocks: 64,
      values: Float32Array.from({ length: 4096 }, () => 0.034 + 0.001 * g()),
      measured: new Uint8Array(4096).fill(1),
    }));
    const r = indexPosition([...clean.prints, ...room], expected);
    assert.equal(misplaced(r.assignment, [...clean.truth, ...room.map(() => -1)]), 0);
    assert.deepEqual(r.problems, [], 'the room lit as the page went black');
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
  }
});

test('light at an end that changes only in level is not a run: the room switched on or off, a door, a bracketed test shot', () => {
  // Review C. An end was doubted wherever its lit photographs failed a narrow
  // test of the room's light — the same blocks, rising by amounts within half
  // again of each other — and a room light is not that on the photograph that
  // catches the switch: a clean position whose camera ran on at the end tone
  // while the lights came on was refused, "shoot the whole camera position
  // again", as were ramps, a door, lights put out just before Play, and test
  // shots of the white bracketed about the exposure before a short pre-roll.
  // What a run the page was playing shows instead is its structure: a pattern
  // lit where another is not, and that one lit where the first is not. Light
  // that changes only in level moves every block the same way, and light that
  // stays on under a run cancels between two of its photographs.
  const expected = expectedOf(PAGE);
  const R = 34;
  const read = (photos: Photos): { r: ReturnType<typeof indexPosition>; wrong: number } => {
    const r = indexPosition(photos.prints, expected);
    return { r, wrong: misplaced(r.assignment, photos.truth) };
  };
  const dark = (k: number): Shot[] => Array.from({ length: k }, (): Shot => null);
  for (const [azimuth, seen] of [
    [0, [0, 1, 2, 3]],
    [250, [1, 2, 3]],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth });
    const unseen = [0, 1, 2, 3].filter((p) => !seen.includes(p as never));
    const shoot = camera(s, 7400 + azimuth);
    const placed = (label: string, photos: Photos): void => {
      const { r, wrong } = read(photos);
      assert.equal(wrong, 0, `azimuth ${azimuth}, ${label}: filed wrong`);
      assert.deepEqual(r.problems, [], `azimuth ${azimuth}, ${label}`);
      assert.deepEqual(r.usableProjectors, [...seen], `azimuth ${azimuth}, ${label}`);
    };
    // The lights switched on as the end tone sounds, the camera still running:
    // the first lit photograph catches the switch.
    for (const room of [0.03, 0.1]) {
      for (const black of [0, 2]) {
        for (const lit of [4, 6]) {
          const base = shoot(position(s, { unseen, leading: 2, trailing: black + lit }));
          const from = base.prints.length - lit;
          placed(
            `the room at ${room} switched on ${black} after the black, ${lit} lit`,
            relit(base, (values, i) => {
              if (i >= from) for (let k = 0; k < values.length; k++) values[k] += (i === from ? 0.4 : 1) * room;
            }),
          );
        }
      }
    }
    // A lamp warming up, and a door opening on the right third of the picture.
    const after = shoot(position(s, { unseen, leading: 2, trailing: 8 }));
    const from = after.prints.length - 6;
    placed(
      'a lamp warming up after the black',
      relit(after, (values, i) => {
        if (i >= from) for (let k = 0; k < values.length; k++) values[k] += 0.02 + 0.008 * (i - from);
      }),
    );
    placed(
      'a door opening after the black',
      relit(after, (values, i) => {
        if (i >= from) for (let k = 0; k < values.length; k++) if (k % 64 >= 43) values[k] += 0.015 * (i - from + 1);
      }),
    );
    // The lights put out just before Play, dimming.
    const before = shoot(position(s, { unseen, leading: 6, trailing: 3 }));
    placed(
      'the lights put out just before Play',
      relit(before, (values, i) => {
        if (i < 4) for (let k = 0; k < values.length; k++) values[k] += 0.01 * (4 - i);
      }),
    );
    // The exposure set on the first projector in view's white, bracketed, then
    // one photograph of the page's step 0 before Play.
    const q = seen[0];
    const gains = [0.5, 0.7, 1.4, 2];
    placed(
      `the white of projector ${q + 1} bracketed, then one before Play`,
      relit(shoot([...gains.map((): Shot => ({ projector: q, frame: 0 })), ...position(s, { unseen, leading: 1, trailing: 3 })]), (values, i) => {
        if (i < gains.length) for (let k = 0; k < values.length; k++) values[k] *= gains[i];
      }),
    );
  }

  // A run the page was playing still shows its structure at an end, and the
  // numbering that calls it extras is not used: a camera started 8, or 28 —
  // only phase steps left — photographs after Play with 33 dark ones after the
  // black; stopped 26 early with 33 before Play; and started 20 late with the
  // room's light on under the remnant, which cancels between its photographs.
  const all = scene(PAGE, 64, { azimuth: 0 });
  const shoot = camera(all, 7500);
  for (const [label, photos] of [
    ['started 8 late', shoot([...position(all).slice(8), ...dark(33)])],
    ['started 28 late', shoot([...position(all).slice(28), ...dark(33)])],
    ['stopped 26 early', shoot([...dark(33), ...position(all).slice(0, 4 * R - 26)])],
    [
      'started 20 late, the room lit under the remnant',
      relit(shoot([...position(all).slice(20), ...dark(36)]), (values, i) => {
        if (i < R - 20) for (let k = 0; k < values.length; k++) values[k] += 0.3;
      }),
    ],
  ] as const) {
    const { r, wrong } = read(photos);
    assert.equal(wrong, 0, `${label}: filed wrong`);
    assert.deepEqual(r.usableProjectors, [], label);
    assert.match(r.problems[0] ?? '', /lit and in no run found/, label);
  }
});

test('a re-shoot added after the position explains nothing at the end before it: its original, cut short there, is still a run the count has no room for', () => {
  // Review C. The card's own remedy — a run missed, re-shoot that projector
  // into the same folder — appends a run whose frames the photographs of its
  // original copy, and after the last run a copy of any run's frame was set
  // aside as an extra. So the lit end of a camera stopped four or more
  // photographs early, projector 4 in view and 31 dark before Play, was
  // explained away by projector 4's re-shoot, and the numbering a projector
  // over was used: 324 of the review's 1575 folders on either plan, silent.
  // Only a copy of a run found before the stretch is set aside now.
  const expected = expectedOf(PAGE);
  const dark = (k: number): Shot[] => Array.from({ length: k }, (): Shot => null);
  const white = (p: number): Shot => ({ projector: p, frame: 0 });
  const s = scene(PAGE, 64, { azimuth: 45 });
  for (const lost of [4, 8]) {
    for (const before of [0, 2]) {
      const pos = position(s, { unseen: [2] });
      const shots = [...dark(31), ...pos.slice(0, pos.length - lost), ...Array.from({ length: before }, () => white(3)), ...run(s, 3), ...dark(3)];
      const { prints, truth } = camera(s, 7600 + lost + before)(shots);
      const r = indexPosition(prints, expected);
      const label = `31 dark before Play, stopped ${lost} early in projector 4, re-shot with ${before} of its white before`;
      assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
      assert.equal(r.ok, false, label);
    }
  }
});

test('a numbering leaves a projector for every run found after a stretch that is not whole runs', () => {
  // Review C. Projector 2, out of view, paused a run's worth in its run, and
  // projector 4's run spoiled and re-shot: the count put projector 3 in the
  // last projector's place and called what followed it a stretch that is not
  // whole runs, the re-shoot after it one of the later projectors — of which
  // there were none. Projector 3 was filed as projector 4, decoded, in 30 of
  // the review's 180 folders. The runs after such a stretch are the position's
  // later projectors, so the numbering has to leave one for each. With
  // projector 4's black dropped, its spoiled run is no pass of the re-shoot —
  // a pass begins with the run's white and black — so the stretch before the
  // re-shoot is counted as it stands, and five dark photographs after it leave
  // it short of whole runs.
  const expected = expectedOf(PAGE);
  const R = 34;
  const dark = (k: number): Shot[] => Array.from({ length: k }, (): Shot => null);
  const white = (p: number): Shot => ({ projector: p, frame: 0 });
  const s = scene(PAGE, 64, { azimuth: 300, elevation: 40, distance: 2.5 });
  for (const [how, at, between] of [
    ['doubled', 5, 3],
    ['dropped', 17, 3],
    ['dropped', 1, 5],
  ] as const) {
    const p4 = run(s, 3);
    if (how === 'doubled') p4.splice(at, 0, p4[at]);
    else p4.splice(at, 1);
    const shots = [white(0), white(0), ...run(s, 0), ...dark(R + 31), ...run(s, 2), ...p4, ...dark(between), ...run(s, 3), ...dark(3)];
    const { prints, truth } = camera(s, 7700 + at)(shots);
    const r = indexPosition(prints, expected);
    const label = `projector 2 paused 31 in its run, projector 4's photograph ${at + 1} ${how}, and re-shot`;
    assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
    assert.equal(r.ok, false, label);
  }
});

test("a run that matches no projector is a re-shoot only after the position's black, and an honest gap contests it", () => {
  // Review B. A run that matches nothing was taken for a re-shoot added after
  // the position wherever the count put the position's end before it: with a
  // projector this camera cannot see played twice in line, the last genuine run
  // became "a re-shoot from a camera that moved" and every run before it was
  // filed a projector late, decoded though the page refused. The page ends a
  // position by painting black and a re-shoot comes after it, so such a run has
  // to follow a dark photograph. And a reading whose count has an honest
  // stretch that is not whole runs was set aside for one without — even one
  // taking a genuine run for such a re-shoot; now they contest.
  const expected = expectedOf(PAGE);
  const R = 34;
  const dark = (k: number): Shot[] => Array.from({ length: k }, (): Shot => null);
  const refused = (label: string, s: Scene, shots: Shot[], seed: number): string => {
    const { prints, truth } = camera(s, seed)(shots);
    const r = indexPosition(prints, expected);
    assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
    assert.deepEqual(r.usableProjectors, [], label);
    return r.problems[0] ?? '';
  };
  const p2Out = scene(PAGE, 64, { azimuth: 300, elevation: 40, distance: 2.5 });
  const lead: Shot[] = [{ projector: 0, frame: 0 }, { projector: 0, frame: 0 }];
  // Projector 2 played again in line; then, instead, the page paused a minute in its run.
  assert.match(
    refused('projector 2 played twice', p2Out, [...lead, ...run(p2Out, 0), ...dark(2 * R), ...run(p2Out, 2), ...run(p2Out, 3), ...dark(3)], 100),
    /only if the run at photographs 139–172, which matches no projector, is a re-shoot added after the position\. It follows the run before it with no dark photograph between/,
  );
  refused('a minute paused in projector 2', p2Out, [...lead, ...run(p2Out, 0), ...dark(R + 31), ...run(p2Out, 2), ...run(p2Out, 3), ...dark(3)], 101);
  // A camera that moved ten degrees for its re-shoot, projector 1 out of view,
  // and no dark photograph between: refused, not read with every run shifted.
  const p1Out = scene(PAGE, 64, { azimuth: 250 });
  {
    const moved = scene(PAGE, 64, { azimuth: 260 });
    const a = camera(p1Out, 102)(position(p1Out, { unseen: [0], leading: 2 }));
    const b = camera(moved, 103)(run(moved, 1));
    const photos = joined(a, { ...b, truth: b.truth.map((t) => (t < 0 ? -1 : 10000 + t)) });
    const r = indexPosition(photos.prints, expected);
    assert.equal(misplaced(r.assignment, photos.truth), 0, 'moved re-shoot straight after the position: filed wrong');
    assert.deepEqual(r.usableProjectors, []);
  }
  // 31 dark photographs before Play and the page paused eight photographs in
  // projector 3's run: the reading with the honest gap numbers projector 1's
  // run 1 or 2, and the one without calls projector 4's run a re-shoot.
  const all = scene(PAGE, 64, { azimuth: 0 });
  {
    const p3 = run(all, 2);
    for (let k = 0; k < 8; k++) p3.splice(15, 0, p3[15]);
    assert.match(
      refused('31 dark before Play, projector 3 paused eight', all, [...dark(31), ...run(all, 0), ...run(all, 1), ...p3, ...run(all, 3), ...dark(3)], 104),
      /^The run at photographs 32–65 could be projector 1 or projector 2/,
    );
  }
  // The same with projector 3 out of view, so the run taken for a re-shoot does
  // follow dark photographs: only the gap's reading refuses it.
  refused('31 dark before Play, eight more in projector 3', all, [...dark(31), ...run(all, 0), ...run(all, 1), ...dark(R + 8), ...run(all, 3), ...dark(3)], 105);

  // A re-shoot from a camera that moved, after ten dark photographs: the
  // reading that counts it into the position past a stretch that is not whole
  // runs agrees with the one that does not, and the one without is used — the
  // position's runs placed, and the re-shoot refused as the camera having moved.
  {
    const moved = scene(PAGE, 64, { azimuth: 3 });
    const photos = joined(camera(all, 106)(position(all, { trailing: 10 })), camera(moved, 107)(run(moved, 1)));
    const r = indexPosition(photos.prints, expected);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    assert.equal(misplaced(r.assignment, photos.truth), 0);
    assert.equal(r.problems.length, 1, r.problems.join(' | '));
    assert.match(r.problems[0], /after the end of this camera position, matches no projector/);
  }
  // There every projector is numbered, and the count leaves the re-shoot no
  // projector to be. With projector 4 out of view it leaves one: the reading
  // with the stretch then fits as well, agreeing with the other about every
  // run, and says only that the runs after the stretch cannot be numbered. The
  // reading without it is used: projector 4 noted out of view, and the re-shoot
  // refused as the camera having moved.
  {
    const p4Out = scene(PAGE, 64, { azimuth: 110 });
    const moved = scene(PAGE, 64, { azimuth: 120 });
    const photos = joined(camera(p4Out, 108)(position(p4Out, { unseen: [3], trailing: 10 })), camera(moved, 109)(run(moved, 2)));
    const r = indexPosition(photos.prints, expected);
    assert.deepEqual(r.usableProjectors, [0, 1, 2]);
    assert.deepEqual(r.unseenProjectors, [3]);
    assert.equal(misplaced(r.assignment, photos.truth), 0);
    assert.equal(r.problems.length, 1, r.problems.join(' | '));
    assert.match(r.problems[0], /after the end of this camera position, matches no projector/);
  }
});

// ---------------------------------------------------------------------------
// Test 8e — dark, judged where it is looked at
// ---------------------------------------------------------------------------

/** The same photographs with `change(values, i)` applied to each fingerprint. */
function relit(photos: Photos, change: (values: Float32Array, i: number) => void): Photos {
  return {
    ...photos,
    prints: photos.prints.map((f, i) => {
      const values = f.values.slice();
      change(values, i);
      return { ...f, values };
    }),
  };
}

test('dark is judged where it is looked at: room light elsewhere in the folder neither lights a slot the camera cannot see nor hides a run it can', () => {
  // Against the folder's own floor, a door opening in the background or the
  // ambient drifting up made an out-of-view projector "lit, but no run... Re-
  // shoot projector 4", and hundreds of room-lit photographs after the black
  // raised the floor until two seen projectors were called out of view. A slot
  // with no run is now judged against its own photographs, the folder's end
  // against the last run's black, and runs are found by their own white and
  // black.
  const expected = expectedOf(PAGE);
  const p4Out = scene(PAGE, 64, { azimuth: 110 });
  const base = camera(p4Out, 38)(position(p4Out, { leading: 2, trailing: 3 }));
  const n = base.prints.length;
  const outOfView = (label: string, photos: Photos): void => {
    const r = indexPosition(photos.prints, expected);
    assert.equal(misplaced(r.assignment, photos.truth), 0, label);
    assert.deepEqual(r.problems, [], label);
    assert.deepEqual(r.usableProjectors, [0, 1, 2], label);
    assert.deepEqual(r.unseenProjectors, [3], label);
  };
  // A door opens during projector 4's slot: a 6x6 patch of background the sphere
  // never covers brightens and stays bright.
  for (const step of [0.025, 0.05]) {
    outOfView(
      `a door opening, +${step}`,
      relit(base, (v, i) => {
        if (i < 110) return;
        for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) v[y * 64 + x] += step;
      }),
    );
  }
  // The ambient creeping up by 0.03 across the whole folder.
  outOfView('an ambient ramp of 0.03', relit(base, (v, i) => v.forEach((_, k) => (v[k] += (0.03 * i) / (n - 1)))));

  // Projector 1 out of view, and the room light still on for the first ten
  // photographs: its slot is lit, the same way everywhere, and the refusal
  // names the room before the re-shoot.
  {
    const p1Out = scene(PAGE, 64, { azimuth: 250 });
    const photos = relit(camera(p1Out, 39)(position(p1Out, { unseen: [0], leading: 2, trailing: 3 })), (v, i) => {
      if (i < 10) v.forEach((_, k) => (v[k] += 0.03));
    });
    const r = indexPosition(photos.prints, expected);
    assert.equal(misplaced(r.assignment, photos.truth), 0);
    assert.deepEqual(r.usableProjectors, [1, 2, 3]);
    assert.equal(r.problems.length, 1, r.problems.join(' | '));
    assert.match(r.problems[0], /^Projector 1's photographs are lit, but no run of 34 could be found among them, and the light in them changes the way a room changes/);
    assert.match(r.problems[0], /Most likely the room's light changed while they were shot/);
    assert.match(r.problems[0], /with the room's light as it will stay, and read it under the same camera number/);
    assert.match(r.problems[0], /Re-shoot projector 1\./);
  }

  // Four hundred and fifty room-lit photographs after a clean position: every
  // run still found and placed, and the photographs after it said to belong to
  // no run, not taken for dark ones past the allowance.
  {
    const all = scene(PAGE, 64, { azimuth: 0 });
    const clean = camera(all, 40)(position(all, { trailing: 3 }));
    const g = stream(41);
    const room = Array.from({ length: 450 }, (_, k): FrameFingerprint => ({
      ordinal: clean.prints.length + k,
      blocks: 64,
      values: Float32Array.from({ length: 4096 }, () => 0.2 + 0.002 * g()),
      measured: new Uint8Array(4096).fill(1),
    }));
    const r = indexPosition([...clean.prints, ...room], expected);
    assert.equal(misplaced(r.assignment, [...clean.truth, ...room.map(() => -1)]), 0);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    assert.ok(r.notes.includes("453 photographs after the last projector's run belong to no run; not used."), r.notes.join(' | '));
  }
});

// ---------------------------------------------------------------------------
// Test 8f — photographs of a white that are not a run's
// ---------------------------------------------------------------------------

test('a slot cut short at the front by a late start is refused where light is left in it, not noted barely seen', () => {
  // A run's first photograph is its white, its brightest, and a camera started
  // after Play loses it first. On the bench a run lit only by the room behind
  // the sphere — each Gray plane photographed as the room's bounce of it, alike
  // across the picture — was placed whole, and without its white lit 1 to 3
  // blocks against its slot's own photographs: noted barely seen, and dropped
  // with a note that a re-shoot from there would see no more of it. Here
  // projector 1 at a tenth of its gain, each Gray plane photographed half and
  // half with its complement but the coarsest, whose two halves light the room
  // either side as they do on the bench, where that pair still separates by
  // 0.93 of the run's modulation.
  const expected = expectedOf(PAGE);
  const weak = sceneWith({ azimuths: [45, 135, 225, 315], gains: [0.1, 0.92, 1.06, 0.97] });
  const shots: Shot[] = position(weak, { trailing: 3 }).map((x) =>
    x === null || x.projector !== 0 || x.frame < 4 || x.frame > 25
      ? x
      : { ...x, blend: { projector: 0, frame: x.frame ^ 1, weight: 0.5 } },
  );
  const whole = camera(weak, 39)(shots);
  const read = indexPosition(whole.prints, expected);
  assert.equal(misplaced(read.assignment, whole.truth), 0);
  assert.deepEqual(read.usableProjectors, [0, 1, 2, 3], 'placed whole');
  for (const lost of [1, 2]) {
    const cut = camera(weak, 39)(shots.slice(lost));
    const r = indexPosition(cut.prints, expected);
    const label = `started ${lost} late`;
    assert.equal(misplaced(r.assignment, cut.truth), 0, label);
    assert.deepEqual(r.barelySeenProjectors, [], label);
    assert.deepEqual(r.usableProjectors, [1, 2, 3], label);
    assert.match(r.problems[0] ?? '', /^Projector 1's photographs are lit, but no run of 34 could be found/, label);
  }
  // Inside the position a slot short of a run is a photograph dropped, any of
  // 34 and not its white first: projector 2 grazing the sphere from here,
  // barely seen whole, is barely seen still with its white dropped.
  const grazing = sceneWith({ azimuths: [45, 135, 225, 315], gains: [1, 0.03, 1.06, 0.97] }, { azimuth: 100 });
  const all = position(grazing, { trailing: 3 });
  for (const [label, shots] of [
    ['whole', all],
    ["projector 2's white dropped", [...all.slice(0, 34), ...all.slice(35)]],
  ] as const) {
    const photos = camera(grazing, 40)(shots);
    const r = indexPosition(photos.prints, expected);
    assert.equal(misplaced(r.assignment, photos.truth), 0, label);
    assert.deepEqual(r.barelySeenProjectors, [1], label);
    assert.deepEqual(r.usableProjectors, [0, 2], label);
    assert.deepEqual(r.problems, [], label);
  }
});

test('test shots of a white before the position, and a white shot twice before its run, cost nothing', () => {
  // An operator setting the exposure steps through the projectors' whites and
  // photographs them before pressing Home. A test shot of a later projector's
  // white is a copy of that run's frame outside every run — which is also what
  // the photographs of a run broken too badly to be found are — and the folder
  // was refused as out of order. Before the first run it is a test shot: set
  // aside, and said.
  const expected = expectedOf(PAGE);
  for (const [azimuth, seen] of [
    [0, [0, 1, 2, 3]],
    [250, [1, 2, 3]],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth });
    const unseen = [0, 1, 2, 3].filter((p) => !seen.includes(p as never));
    for (const tests of [[2], [3], [0, 1, 2, 3]]) {
      const white = (p: number): Shot => (seen.includes(p as never) ? { projector: p, frame: 0 } : null);
      const shots = [...tests.map(white), white(0), white(0), ...position(s, { unseen, trailing: 3 })];
      const { prints, truth } = camera(s, 42)(shots);
      const r = indexPosition(prints, expected);
      const label = `azimuth ${azimuth}, test shots of ${tests.map((p) => p + 1)}`;
      assert.equal(misplaced(r.assignment, truth), 0, label);
      assert.deepEqual(r.problems, [], label);
      assert.deepEqual(r.usableProjectors, [...seen], label);
      assert.ok(r.notes.some((x) => /before the first run cop(y|ies) a later projector's white — a test shot/.test(x)), `${label}: ${r.notes.join(' | ')}`);
    }
  }

  // A white shot twice is the next run's white, not more of the run before it,
  // however much of that run's light it falls inside: projectors 60 degrees
  // apart, where projector 2's white lies inside projector 1's light.
  const squeezed = sceneWith({ azimuths: [0, 60, 180, 300], gains: [1, 0.92, 1.06, 0.97] });
  const R = squeezed.specs.length;
  const shots = withFault(position(squeezed, { leading: 1, trailing: 2 }), { at: 1 + R, twice: true });
  const { prints, truth } = camera(squeezed, 43)(shots);
  const r = indexPosition(prints, expected);
  assert.equal(misplaced(r.assignment, truth), 0);
  assert.deepEqual(r.problems, []);
  assert.ok(r.usableProjectors.includes(0) && r.usableProjectors.includes(1), `placed ${r.usableProjectors}`);
});

test("a test shot of a projector's white says nothing about where that projector's re-shoot belongs", () => {
  // Review B. The page's own remedy for a run lost to a dropped photograph is
  // to step to that projector's white and play on, adding the photographs to
  // the folder; a re-shoot whose original was never found is matched by the
  // photographs of the original's stretch that copy it. A test shot of the
  // same projector's white, taken at the head of the folder while the exposure
  // was set, copies it too, and it was counted: the re-shoot then copied
  // photographs in two projectors' places and was refused as "the camera
  // moved", in 16 of 16 such folders, 0 of 16 without the test shot. A copy of
  // a run's white before the first run is a test shot or the page's step 0,
  // for every run, not only the first.
  const expected = expectedOf(PAGE);
  const R = 34;
  let folders = 0;
  for (const [azimuth, seen] of [
    [0, [0, 1, 2, 3]],
    [250, [1, 2, 3]],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth });
    const unseen = [0, 1, 2, 3].filter((p) => !seen.includes(p as never));
    const white = (p: number): Shot => (seen.includes(p as never) ? { projector: p, frame: 0 } : null);
    for (const N of seen) {
      for (const tests of [[N], [0, 1, 2, 3]]) {
        const lost = position(s, { unseen, trailing: 3 });
        lost.splice(N * R + 6, 1);
        const remedy: Shot[] = [];
        for (let p = 0; p <= N; p++) remedy.push(white(p));
        for (let p = N; p < 4; p++) for (let f = 0; f < R; f++) remedy.push(seen.includes(p as never) ? { projector: p, frame: f } : null);
        remedy.push(null, null, null);
        const shots = [...tests.map(white), white(0), white(0), ...lost, ...remedy];
        const { prints, truth } = camera(s, 9000 + azimuth)(shots);
        const r = indexPosition(prints, expected);
        const label = `azimuth ${azimuth}, projector ${N + 1} lost and re-shot, test shots of ${tests.map((p) => p + 1)}`;
        folders++;
        assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
        assert.deepEqual(r.problems, [], label);
        assert.deepEqual(r.usableProjectors, [...seen], label);
        assert.ok(r.reshoots.some((x) => x.projector === N), `${label}: ${JSON.stringify(r.reshoots)}`);
      }
    }
  }
  assert.equal(folders, 14);
});

test('a test shot of any frame, at any exposure, says nothing about where a run belongs', () => {
  // Review C. A focus shot of a projector's stripes, or its white a stop
  // under, taken while the camera was set up and kept as the card says, was
  // taken for a photograph of that run found outside every run. Before the
  // first slot every such copy counted as projector 1's, so a later
  // projector's test shot refused a clean position as out of order — 1071 of
  // the 1638 folders of the review's sweep on the cheap plan — and with
  // projector 1 out of view and 30 photographs before Play the one reading
  // left took the last run for projector 1's re-shoot and filed every run a
  // projector over, the page saying all was well. And a white a stop under
  // reads a half in every block, as a phase step and the finest Gray planes do
  // at the page's grid: it copied them. Now a copy before the first slot names
  // no slot, and a frame that reads flat across the crescent is no frame a
  // copy can be told by.
  const expected = expectedOf(PAGE);
  const FINEST_U = 2 + 2 * (PAGE.grayBits - 1);
  const MID_U = 2 + 2 * 3;
  const PHASE_U = 2 + 4 * PAGE.grayBits;
  /** Photographs `at` taken at `gain` times the exposure of the rest. */
  const exposed = (photos: Photos, at: ReadonlyMap<number, number>): Photos =>
    relit(photos, (values, i) => {
      const gain = at.get(i);
      if (gain !== undefined) for (let k = 0; k < values.length; k++) values[k] *= gain;
    });
  const read = (photos: Photos): { r: ReturnType<typeof indexPosition>; wrong: number } => {
    const r = indexPosition(photos.prints, expected);
    return { r, wrong: misplaced(r.assignment, photos.truth) };
  };
  let folders = 0;
  for (const [azimuth, seen] of [
    [0, [0, 1, 2, 3]],
    [250, [1, 2, 3]],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth });
    const unseen = [0, 1, 2, 3].filter((p) => !seen.includes(p as never));
    const shoot = camera(s, 7100 + azimuth);
    for (const q of seen.filter((p) => p > 0)) {
      const shots: [string, Shot[], number[]][] = [
        ['its white a stop under, then at the exposure', [{ projector: q, frame: 0 }, { projector: q, frame: 0 }], [0.5, 1]],
        ['its finest Gray plane', [{ projector: q, frame: FINEST_U }], [1]],
        ['a Gray plane the grid resolves, twice', [{ projector: q, frame: MID_U }, { projector: q, frame: MID_U }], [1, 1]],
        ['a phase step', [{ projector: q, frame: PHASE_U }], [1]],
      ];
      for (const [what, tests, gains] of shots) {
        for (const leading of [2, 26]) {
          const photos = exposed(
            shoot([...tests, ...position(s, { unseen, leading, trailing: 3 })]),
            new Map(gains.map((g, i) => [i, g])),
          );
          const { r, wrong } = read(photos);
          const label = `azimuth ${azimuth}, a test shot of projector ${q + 1}'s ${what}, ${leading} before Play`;
          folders++;
          assert.equal(wrong, 0, `${label}: filed wrong`);
          assert.deepEqual(r.problems, [], label);
          assert.deepEqual(r.usableProjectors, [...seen], label);
        }
      }
    }
  }
  assert.equal(folders, 48);

  // Projector 1 out of view, 30 photographs before Play: with the test shot,
  // more than a run's worth of photographs lie before the first run, which a
  // numbering a projector over also fits. Refused, never read that way.
  {
    const s = scene(PAGE, 64, { azimuth: 250 });
    const shoot = camera(s, 7200);
    for (const [tests, gains] of [
      [[{ projector: 3, frame: FINEST_U }], [1]],
      [[{ projector: 3, frame: 0 }, { projector: 3, frame: 0 }], [0.5, 1]],
    ] as [Shot[], number[]][]) {
      for (const trailing of [0, 3]) {
        const photos = exposed(
          shoot([...tests, ...position(s, { unseen: [0], leading: 30, trailing })]),
          new Map(gains.map((g, i) => [i, g])),
        );
        const { r, wrong } = read(photos);
        assert.equal(wrong, 0, `30 before Play, ${trailing} after: filed wrong`);
        assert.equal(r.ok, false);
      }
    }
  }

  // However many test shots of one projector's pattern, they are no run
  // played: projector 4's Gray plane photographed four, six and ten times
  // before Play, with projector 1 out of view and 31 dark photographs before
  // Play. Counted as that run played before Play, they named projector 1's
  // place, and the one reading left took projector 4's run for projector 1's
  // re-shoot and filed every run a projector over, the page saying all was
  // well. A pass of a run — its frames from its white, in order — is what the
  // page playing it leaves; one frame photographed again and again is not. So
  // the folder is refused, as any with that many dark photographs before Play
  // is: they could be projector 1's run.
  {
    const s = scene(PAGE, 64, { azimuth: 250 });
    const shoot = camera(s, 4242);
    for (const times of [4, 6, 10]) {
      const tests = Array.from({ length: times }, (): Shot => ({ projector: 3, frame: MID_U }));
      const { r, wrong } = read(shoot([...tests, ...position(s, { unseen: [0], leading: 31, trailing: 3 })]));
      assert.equal(wrong, 0, `projector 4's Gray plane shot ${times} times before Play: filed wrong`);
      assert.match(r.problems[0] ?? '', /^The run at photographs \d+–\d+ could be projector 2 or projector 3:/, `${times} test shots`);
    }
    // And with two photographs of step 0 before Play, read: counted as a run,
    // they refused it.
    for (const times of [4, 10]) {
      const tests = Array.from({ length: times }, (): Shot => ({ projector: 3, frame: MID_U }));
      const { r, wrong } = read(shoot([...tests, ...position(s, { unseen: [0], leading: 2, trailing: 3 })]));
      assert.equal(wrong, 0, `projector 4's Gray plane shot ${times} times, 2 before Play: filed wrong`);
      assert.deepEqual(r.problems, [], `projector 4's Gray plane shot ${times} times, 2 before Play`);
      assert.deepEqual(r.usableProjectors, [1, 2, 3], `projector 4's Gray plane shot ${times} times, 2 before Play`);
    }
  }

  // The page's remedy walked end to end with such test shots kept at the head:
  // projector 2's run spoiled by a doubled photograph is refused by name, its
  // re-shoot added as the page says is used, and so is the position shot again.
  {
    const s = scene(PAGE, 64, { azimuth: 0 });
    const shoot = camera(s, 7300);
    const tests: Shot[] = [{ projector: 1, frame: 0 }, { projector: 1, frame: 0 }];
    const gains = new Map([[0, 0.5]]);
    const pre: Shot[] = [{ projector: 0, frame: 0 }, { projector: 0, frame: 0 }];
    const doubled = run(s, 1);
    doubled.splice(20, 0, doubled[20]);
    const dark: Shot[] = [null, null, null];
    const spoilt = [...tests, ...pre, ...run(s, 0), ...doubled, ...run(s, 2), ...run(s, 3), ...dark];
    const first = read(exposed(shoot(spoilt), gains));
    assert.equal(first.wrong, 0);
    assert.deepEqual(first.r.usableProjectors, [0, 2, 3]);
    assert.ok(first.r.problems.every((x) => x.includes('Re-shoot projector 2.')), first.r.problems.join(' | '));
    const remedy: Shot[] = [{ projector: 1, frame: 0 }, { projector: 1, frame: 0 }, ...run(s, 1), ...run(s, 2), ...run(s, 3), ...dark];
    const second = read(exposed(shoot([...spoilt, ...remedy]), gains));
    assert.equal(second.wrong, 0);
    assert.deepEqual(second.r.problems, [], 'the re-shoot added as the page says');
    assert.deepEqual(second.r.usableProjectors, [0, 1, 2, 3]);
    assert.ok(second.r.reshoots.some((x) => x.projector === 1 && x.used >= spoilt.length), JSON.stringify(second.r.reshoots));
    const again = read(exposed(shoot([...tests, ...pre, ...run(s, 0), ...run(s, 1), ...run(s, 2), ...run(s, 3), ...dark]), gains));
    assert.equal(again.wrong, 0);
    assert.deepEqual(again.r.problems, [], 'the position shot again with the same test shots');
    assert.deepEqual(again.r.usableProjectors, [0, 1, 2, 3]);

    // The exposure checked again, a stop under, just before the re-shoot: a
    // photograph a few after the position's last run, where it named the last
    // projector's place as well as the lost original's, and the re-shoot was
    // refused as copying photographs of more than one projector.
    for (const q of [1, 2]) {
      for (const gap of [0, 1, 2]) {
        const lost = position(s, { leading: 2, trailing: gap });
        lost.splice(2 + q * 34 + 6, 1);
        const replay: Shot[] = [];
        for (let p = q; p < 4; p++) replay.push(...run(s, p));
        const shots = [...lost, { projector: q, frame: 0 }, { projector: q, frame: 0 }, ...replay, ...dark];
        const { r, wrong } = read(exposed(shoot(shots), new Map([[lost.length, 0.5]])));
        const label = `projector ${q + 1} lost and re-shot, its white a stop under ${gap} after the position`;
        assert.equal(wrong, 0, label);
        assert.deepEqual(r.problems, [], label);
        assert.ok(r.reshoots.some((x) => x.projector === q), `${label}: ${JSON.stringify(r.reshoots)}`);
      }
    }
  }
  // The same on the cheap plan from 110 degrees, each projector the camera
  // sees lost and re-shot, its white checked at four exposures under. Projector
  // 3's last phase step there reads flat about its median level and not quite
  // about its mean: a white a stop under copies it, and it is no frame a copy
  // can be told by.
  {
    const c = scene(CHEAP, 16, { azimuth: 110 });
    const shootC = camera(c, 55);
    const e = expectedOf(CHEAP);
    for (const q of [0, 1, 2]) {
      for (const gap of [0, 1, 2]) {
        for (const gain of [0.4, 0.5, 0.6, 0.7]) {
          const lost = position(c, { unseen: [3], leading: 2, trailing: gap });
          lost.splice(2 + q * 34 + 6, 1);
          const replay: Shot[] = [];
          for (let p = q; p < 4; p++) replay.push(...(p === 3 ? run(c, p).map((): Shot => null) : run(c, p)));
          const shots = [...lost, { projector: q, frame: 0 }, { projector: q, frame: 0 }, ...replay, null, null, null];
          const photos = exposed(shootC(shots), new Map([[lost.length, gain]]));
          const r = indexPosition(photos.prints, e);
          const label = `cheap plan, projector ${q + 1} lost and re-shot, its white at ${gain} of the exposure ${gap} after the position`;
          assert.equal(misplaced(r.assignment, photos.truth), 0, label);
          assert.deepEqual(r.problems, [], label);
          assert.deepEqual(r.usableProjectors, [0, 1, 2], label);
          assert.ok(r.reshoots.some((x) => x.projector === q), `${label}: ${JSON.stringify(r.reshoots)}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Test 8g — what a refusal says
// ---------------------------------------------------------------------------

test('a refusal says what the folder holds: one unchanging picture, a whole card, a re-shoot that did not match', () => {
  const expected = expectedOf(PAGE);
  const all = scene(PAGE, 64, { azimuth: 0 });
  const R = all.specs.length;

  // The page never played: every photograph is its white. Not a lens cap.
  {
    const { prints } = camera(all, 44)(Array.from({ length: 4 * R }, (): Shot => ({ projector: 0, frame: 0 })));
    const r = indexPosition(prints, expected);
    assert.match(r.problems[0] ?? '', /^Every one of the 136 photographs is the same picture/);
    assert.match(r.problems[0] ?? '', /the page was not playing while the camera ran/);
  }

  // The camera's whole card, three positions in one folder: the first is read,
  // and the rest are said to be other positions, to be handed in on their own
  // — not re-shoots from a camera that moved.
  {
    const photos = [0, 120, 240].map((azimuth, k) => {
      const s = scene(PAGE, 64, { azimuth });
      return camera(s, 45 + k)(position(s, { leading: 2, trailing: 3 }));
    });
    const prints = photos.flatMap((p) => p.prints).map((f, i) => ({ ...f, ordinal: i }));
    const truth = photos.flatMap((p, k) => p.truth.map((t) => (k === 0 ? t : t < 0 ? -1 : 10000 + t)));
    const r = indexPosition(prints, expected);
    assert.equal(misplaced(r.assignment, truth), 0);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    assert.equal(r.problems.length, 1, r.problems.join(' | '));
    assert.match(r.problems[0], /^From photograph 144 on, the folder holds \d+ runs that match no projector of this camera position/);
    assert.match(r.problems[0], /split the folder at photograph 144 and hand each position in on its own/);
  }

  // A run lost to a doubled frame, and its re-shoot from a camera that moved
  // ten degrees: the re-shoot matches nothing, and the lost run is not told to
  // be re-shot and added to the end again, which is what just failed.
  {
    const shots = position(all, { trailing: 1 });
    shots.splice(R + 6, 0, shots[R + 6]);
    const moved = scene(PAGE, 64, { azimuth: 10 });
    const photos = joined(camera(all, 48)(shots), camera(moved, 49)(run(moved, 1)));
    const r = indexPosition(photos.prints, expected);
    assert.equal(misplaced(r.assignment, photos.truth), 0);
    const lost = r.problems.find((x) => x.startsWith("Projector 2's")) ?? '';
    assert.match(lost, /Re-shoot projector 2\. A re-shoot added to this folder could not be matched, so shoot the whole camera position again, into a folder of its own, and read it under the same camera number/);
    assert.doesNotMatch(lost, /add the new photographs to the end/);
    assert.ok(r.problems.some((x) => /after the end of this camera position, (matches no projector|copies photographs)/.test(x)), r.problems.join(' | '));
  }

  // One run found, and the ends allow two numberings: "projector", once.
  {
    const c = scene(CHEAP, 16, { azimuth: 0, elevation: 70, distance: 3 });
    const { prints } = camera(c, 50)(position(c, { unseen: [0, 2, 3], trailing: 33 }));
    const r = indexPosition(prints, expectedOf(CHEAP));
    assert.match(r.problems[0] ?? '', /^The run found could be projector 1 or projector 2: /);
  }

  // A long wait before Play is not a camera position whose every run was lost.
  // With 133 photographs or more before the first run, the reading that no
  // run of the position was found, everything before the first run being it,
  // fitted too, and the folder was refused as every run found repeating
  // photographs of a run that could not be read. Copies of projector 1's white
  // are the page's step 0, and a clean position after them is read, a stray
  // photograph at the head included; dark ones hold nothing a re-shoot could
  // repeat, and leave only the count to refuse.
  for (const wait of [133, 200]) {
    // Lit, and a copy of no frame of any run: half of each of two whites.
    const stray: Shot = { projector: 1, frame: 0, blend: { projector: 2, frame: 0, weight: 0.5 } };
    const white = camera(all, 52)([stray, ...Array.from({ length: wait }, (): Shot => ({ projector: 0, frame: 0 })), ...position(all, { trailing: 3 })]);
    const r = indexPosition(white.prints, expected);
    assert.equal(misplaced(r.assignment, white.truth), 0);
    assert.deepEqual(r.problems, [], `${wait} of projector 1's white before Play`);
    assert.deepEqual(r.usableProjectors, [0, 1, 2, 3]);
    const dark = camera(all, 53)([...Array.from({ length: wait }, (): Shot => null), ...position(all, { trailing: 3 })]);
    const d = indexPosition(dark.prints, expected);
    assert.equal(misplaced(d.assignment, dark.truth), 0);
    assert.doesNotMatch(d.problems.join(' '), /^No run of this camera position could be read/, `${wait} dark before Play`);
    assert.match(d.problems[0] ?? '', /could be projector 1 or projector 2/, `${wait} dark before Play`);
  }

  // A re-shoot handed in alone: the refusal says to add it to the position's
  // folder and to keep every photograph, and does not describe deleting any.
  {
    const { prints } = camera(all, 51)([{ projector: 1, frame: 0 }, ...run(all, 1), null]);
    const r = indexPosition(prints, expected);
    assert.match(r.problems[0] ?? '', /a re-shoot of one projector handed in on its own/);
    assert.match(r.problems[0] ?? '', /Hand in every photograph the camera took, the dark ones included/);
    assert.doesNotMatch(r.problems[0] ?? '', /delet/);
  }
});

// ---------------------------------------------------------------------------
// Where the count stops
// ---------------------------------------------------------------------------

test('a stretch between runs that is not whole runs ends the count there, and a run shot out of turn ends it everywhere', () => {
  // Counting is how a run gets its projector number. Past a stretch that is
  // not whole runs the count is lost: the runs before it keep their numbers,
  // and the projectors after it are neither out of view nor broken — nothing
  // is known of them, and that is said once. And a run shot again two
  // projectors on is inside the position, so not a re-shoot, and not two
  // neighbours a camera cannot tell apart either: nothing is filed.
  const s = scene(PAGE, 64, { azimuth: 0 });
  const R = s.specs.length;
  const expected = expectedOf(PAGE);
  const shoot = camera(s, 19);
  // Two photographs before Play and none after the black, so the end's count
  // is short by the stretch's four lost photographs and more: the count after
  // the last numbered run is allowed the stretch's own excess.
  const third = 2 + 2 * R;
  const cases: [string, (shots: Shot[]) => void][] = [
    ['four photographs of projector 3 lost', (shots) => void shots.splice(third + 8, 4)],
    [
      'six of projector 3 shot twice',
      (shots) => void shots.splice(third + 10, 6, ...shots.slice(third + 10, third + 16).flatMap((x) => [x, x])),
    ],
  ];
  for (const [label, edit] of cases) {
    const shots = position(s, { leading: 2 });
    edit(shots);
    const { prints, truth } = shoot(shots);
    const r = indexPosition(prints, expected);
    assert.equal(misplaced(r.assignment, truth), 0, label);
    assert.deepEqual(r.usableProjectors, [0, 1], label);
    assert.deepEqual(r.unseenProjectors, [], `${label}: a projector whose run was found is not out of view`);
    assert.deepEqual(r.barelySeenProjectors, [], label);
    assert.doesNotMatch([...r.problems, ...r.notes].join(' | '), /not in this camera's view|Re-shoot projector/, label);
    assert.equal(r.problems.length, 1, `${label}: ${r.problems.join(' | ')}`);
    assert.match(r.problems[0], /^Photographs 71–\d+ lie between two runs/, label);
    // Six photographs shot twice can put a run's start six photographs in,
    // where a Gray pair stands in for its white and black: found, not numbered.
    assert.match(r.problems[0], /: the (run|2 runs) found after it (is|are) not used, and projectors 3 and 4 are not decoded\./, label);
    assert.match(r.problems[0], /Shoot the whole camera position again, into a folder of its own, and read it under the same camera number/, label);
  }
  // Projector 1's run again where projector 3's belongs.
  {
    const shots = position(s, { trailing: 1 });
    shots.splice(2 * R, R, ...run(s, 0));
    const { prints, truth } = shoot(shots);
    const r = indexPosition(prints, expected);
    assert.equal(misplaced(r.assignment, truth), 0);
    assert.equal(r.ok, false);
    assert.deepEqual(r.usableProjectors, []);
    assert.ok(r.problems.length > 0 && r.problems.every((x) => x.length > 0), 'refused in words');
    assert.match(
      r.problems[0],
      /^The run at photographs 69–102 shows the same white and black as the run at photographs 1–34, and no reading of the folder fits the two/,
    );
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
  assert.match(indexPosition(swapped, expected).problems[0] ?? '', /^The fingerprint at place 4 in the list says it is photograph 5\./);

  const dark = shoot(Array.from({ length: prints.length }, (): Shot => null));
  const d = indexPosition(dark.prints, expected);
  assert.equal(d.ok, false);
  assert.match(d.problems[0] ?? '', /^Every one of the 136 photographs is the same picture/);

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

test('a window whose black outshines its white is not a run: a phase step shot three times refuses its run, never places it frames out', () => {
  // Review B. With one run's second phase step photographed three times — the
  // page paused two shutters, or the camera fired twice more — the run's own
  // window no longer fits, and the scan went on into it: a window starting on
  // the run's first Gray plane, that plane for its white and its complement for
  // its black, passed every identity, and the run was placed with its frames a
  // slot or two out while the page said every frame was found. A run's black is
  // never brighter than its white; that window's black was, over most of what
  // the two differ by. The five folders the review found, each refused now in
  // words that name its projector, and costing no other run.
  const expected = expectedOf(PAGE);
  const R = 34;
  for (const [azimuth, elevation, q, f] of [
    [0, -12, 0, 27],
    [0, 30, 0, 27],
    [110, -12, 1, 27],
    [250, 30, 3, 27],
    [250, 30, 3, 28],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth, elevation });
    const label = `azimuth ${azimuth}, elevation ${elevation}: projector ${q + 1}'s frame ${f + 1} three times`;
    const clean = indexPosition(camera(s, 1900 + azimuth + f)(position(s, { leading: 1, trailing: 2 })).prints, expected);
    const shots = position(s, { leading: 1, trailing: 2 });
    const at = 1 + q * R + f;
    shots.splice(at, 0, shots[at], shots[at]);
    const { prints, truth } = camera(s, 900 + azimuth + f)(shots);
    const r = indexPosition(prints, expected);
    assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
    assert.ok(clean.usableProjectors.includes(q), `${label}: the clean position has to place it`);
    assert.deepEqual(r.usableProjectors, clean.usableProjectors.filter((p) => p !== q), label);
    assert.match(r.problems.join(' '), new RegExp(`Re-shoot projector ${q + 1}\\.`), label);
  }
  // A run's black can outshine its white another way: the room's light
  // switched on just after the white was photographed, so that every later
  // photograph, the black among them, carries light the white does not. The
  // page's card says light that comes on while a projector is playing spoils
  // that projector's run, and it is refused by name rather than read against a
  // white photographed in another light; the runs after it, the room's light
  // under their white and black alike, are read.
  for (const [azimuth, q] of [
    [0, 0],
    [250, 3],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth });
    const photos = camera(s, 1950 + azimuth)(position(s, { leading: 2, trailing: 3 }));
    const white = 2 + q * R;
    const lit = relit(photos, (values, i) => {
      if (i > white) for (let k = 0; k < values.length; k++) values[k] += 0.03;
    });
    const clean = indexPosition(photos.prints, expected);
    const r = indexPosition(lit.prints, expected);
    const label = `azimuth ${azimuth}: the room's light switched on after projector ${q + 1}'s white`;
    assert.equal(misplaced(r.assignment, lit.truth), 0, `${label}: filed wrong`);
    assert.ok(clean.usableProjectors.includes(q), `${label}: the position without the room's light has to place it`);
    assert.deepEqual(r.usableProjectors, clean.usableProjectors.filter((p) => p !== q), label);
    assert.match(r.problems.join(' '), new RegExp(`Re-shoot projector ${q + 1}\\.`), label);
  }
});

test('a window with a frame darker than its black is not a run: a run paused three shutters and shot again in line is read, never a projector late', () => {
  // A run whose twenty-first photograph was taken four times — the page paused
  // three shutters — puts its own phase frames back in the phase slots of the
  // window three photographs into it. From 110 degrees that window's white is
  // projector 3's first plane's complement, lighting nearly all of the
  // crescent, and its black the second plane, lighting little of it: its
  // black does not outshine its white and its pairs separate, so it was found
  // as a broken run, and the page's in-line re-shoot after it, projector 3's
  // run shot again, was counted as projector 4's, decoded. A run's black is the
  // page's black, and no photograph of the run is darker; that window's next
  // planes are. With the window gone, the pass the page was stepped back from
  // begins with projector 3's white and goes on as its run does, and the run
  // shot again is read in its place.
  const expected = expectedOf(PAGE);
  const s = scene(PAGE, 64, { azimuth: 110 });
  for (const leading of [2, 20]) {
    const paused = run(s, 2);
    paused.splice(20, 0, paused[20], paused[20], paused[20]);
    const shots: Shot[] = [
      ...position(s, { leading }).slice(0, leading + 68),
      ...paused,
      null,
      ...run(s, 2),
      ...Array.from({ length: 37 }, (): Shot => null),
    ];
    const { prints, truth } = camera(s, 1800 + leading)(shots);
    const r = indexPosition(prints, expected);
    const label = `${leading} before Play, projector 3 paused three shutters and shot again in line`;
    assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
    assert.deepEqual(r.problems, [], label);
    assert.deepEqual(r.usableProjectors, [0, 1, 2], label);
    assert.deepEqual(r.reshoots, [{ projector: 2, used: leading + 106, replaced: leading + 68 }], label);
  }
});

test('a run shot again in line after a pass too spoiled to be found is that projector\'s: the pass begins with its white and goes on as the run does', () => {
  // Review B's B5. The page paused in a projector's run and stepped back to
  // its white (Pause, [, Play), the pass before too spoiled to be found as a
  // run. Nothing matched the run shot again by its references, so the stretch
  // before it was a count that is not whole runs, and such folders were
  // refused: 90 of the review's 120. With more than thirty dark photographs
  // before Play and projector 1 out of view, the dark ones read as projectors
  // 1 and 2 and the run shot again as a re-shoot added after the position,
  // and every run was filed a projector over with nothing said. The pass the
  // page was stepped back from begins with the projector's white and black
  // and goes on as its run does, so it is that projector's place, and the run
  // shot again is read there.
  const expected = expectedOf(PAGE);
  const white = (p: number): Shot => ({ projector: p, frame: 0 });
  let folders = 0;
  for (const [azimuth, seen] of [
    [0, [0, 1, 2, 3]],
    [110, [0, 1, 2]],
    [250, [1, 2, 3]],
  ] as const) {
    const s = scene(PAGE, 64, { azimuth });
    const own = (p: number): Shot[] => (seen.includes(p as never) ? run(s, p) : run(s, p).map((): Shot => null));
    for (const q of seen) {
      for (const [k, pause] of [
        [12, 2],
        [25, 6],
      ]) {
        const first = [...own(q).slice(0, k), ...Array.from({ length: pause }, () => own(q)[k - 1])];
        const shots: Shot[] = seen.includes(0 as never) ? [white(0), white(0)] : [null, null];
        for (let p = 0; p < q; p++) shots.push(...own(p));
        const from = shots.length;
        shots.push(...first, white(q));
        const used = shots.length;
        for (let p = q; p < 4; p++) shots.push(...own(p));
        shots.push(null, null, null);
        const { prints, truth } = camera(s, 5100 + azimuth + k)(shots);
        const r = indexPosition(prints, expected);
        const label = `azimuth ${azimuth}, projector ${q + 1} paused at photograph ${k} and shot again in line`;
        assert.equal(misplaced(r.assignment, truth), 0, `${label}: filed wrong`);
        // Before the first run found there is no run to count the pass from:
        // it is read with the photographs before Play, or refused.
        if (q === seen[0]) continue;
        folders++;
        assert.deepEqual(r.problems, [], label);
        assert.deepEqual(r.usableProjectors, [...seen], label);
        assert.deepEqual(r.reshoots, [{ projector: q, used, replaced: from }], label);
        // The pass ends at its last photograph copying the run, the frame the
        // page was paused on; the white it was stepped back to is no run's.
        const back = `The page was stepped back to projector ${q + 1} and played again from photograph ${used + 1}:`;
        const stray = 'and the 1 photograph taken before it belongs to no run; not used.';
        assert.ok(r.notes.some((n) => n.startsWith(back) && n.endsWith(stray)), `${label}: ${r.notes.join(' | ')}`);
      }
    }
  }
  assert.equal(folders, 14);

  // Thirty-one dark photographs before Play, projector 1 out of view: the dark
  // ones can be projector 1's run and extras, or projectors 1 and 2 less three
  // lost to a late start, and the run shot again in line or added after the
  // position. Both fit, so none is used.
  {
    const s = scene(CHEAP, 16, { azimuth: 180, elevation: 20 });
    const e = expectedOf(CHEAP);
    for (const [how, spoil] of [
      ['paused three shutters', (x: Shot[]) => void x.splice(20, 0, x[20], x[20], x[20])],
      ['a photograph doubled', (x: Shot[]) => void x.splice(15, 0, x[15])],
    ] as const) {
      const first = run(s, 2);
      spoil(first);
      const shots: Shot[] = [
        ...Array.from({ length: 31 }, (): Shot => null),
        ...run(s, 0).map((): Shot => null),
        ...run(s, 1),
        ...first,
        null,
        ...run(s, 2),
        ...run(s, 3).map((): Shot => null),
        null,
        null,
        null,
      ];
      const { prints, truth } = camera(s, 1831)(shots);
      const r = indexPosition(prints, e);
      assert.equal(misplaced(r.assignment, truth), 0, `31 dark before Play, projector 3 ${how}: filed wrong`);
      assert.equal(r.ok, false, `31 dark before Play, projector 3 ${how}`);
    }
  }

  // The page stepped back within a run (←) rather than to its white: the
  // photographs before the window found run straight into it, the window's
  // first photograph the frame they would have shown next. That pass never
  // stopped: it is the run itself, found late, and not a pass before it.
  {
    const s = scene(PAGE, 64, { azimuth: 0 });
    const stepped = [...run(s, 1).slice(0, 8), ...run(s, 1).slice(2)];
    const shots: Shot[] = [white(0), white(0), ...run(s, 0), ...stepped, ...run(s, 2), ...run(s, 3), null, null, null];
    const { prints, truth } = camera(s, 3062)(shots);
    const r = indexPosition(prints, expected);
    assert.equal(misplaced(r.assignment, truth), 0, 'stepped back six frames within projector 2: filed wrong');
  }
});

test("a window whose Gray planes never separate from their complements is not a run: bracketed test shots of a white are not projector 1", () => {
  // Review C. Test shots of projector 1's white bracketed about the exposure —
  // one over, one under — then copies of it at the exposure: a window starting
  // at the shot over has it for its white, the shot under for its black, and
  // every pair the white twice, which adds up to the two as a plane and its
  // complement do. Every identity held; it was placed as projector 1, and with
  // the last projector out of view and 34 photographs from the first bracket
  // shot to Play every run after it was filed a projector late — 135
  // photographs, the page saying every frame was found. A run's coarsest plane
  // lights the crescent one side of its edge and its complement the other, so
  // one of its pairs always differs by most of its modulation; this window's
  // differ by none of it.
  const expected = expectedOf(PAGE);
  for (const azimuth of [110, 0, 45]) {
    const s = scene(PAGE, 64, { azimuth });
    const shoot = camera(s, 2468 + azimuth);
    const seen = indexPosition(shoot(position(s, { leading: 2, trailing: 3 })).prints, expected).usableProjectors;
    assert.ok(azimuth !== 110 || !seen.includes(3), 'the last projector out of view at azimuth 110');
    for (const gains of [
      [1.4, 0.7, 1, 1],
      [1.25, 0.8, 1, 1],
    ]) {
      for (const leading of [28, 30, 40]) {
        const shots: Shot[] = [...gains.map((): Shot => ({ projector: 0, frame: 0 })), ...position(s, { leading, trailing: 0 })];
        const photos = relit(shoot(shots), (values, i) => {
          if (i < gains.length) for (let k = 0; k < values.length; k++) values[k] *= gains[i];
        });
        const r = indexPosition(photos.prints, expected);
        const label = `azimuth ${azimuth}, white shot at ${gains.join(', ')} then ${leading} before Play`;
        assert.equal(misplaced(r.assignment, photos.truth), 0, `${label}: filed wrong`);
        assert.deepEqual(r.problems, [], label);
        assert.deepEqual(r.usableProjectors, seen, label);
      }
    }
  }
  // And a run whose pairs separate least is still a run: of 1315 runs with a
  // crescent photographed from 384 camera placements, the least separated are on
  // the cheap plan from 25 degrees up, by 0.938 of their modulation.
  const cheap = expectedOf(CHEAP);
  for (const [azimuth, q] of [
    [0, 3],
    [90, 1],
    [180, 1],
    [270, 2],
  ]) {
    const s = scene(CHEAP, 16, { azimuth, elevation: 25 });
    const r = indexPosition(camera(s, 2500 + azimuth)(position(s, { leading: 2, trailing: 3 })).prints, cheap);
    const label = `cheap plan, azimuth ${azimuth}, 25 degrees up`;
    assert.deepEqual(r.problems, [], label);
    assert.ok(r.usableProjectors.includes(q), `${label}: projector ${q + 1} not placed (${r.usableProjectors})`);
  }
});
