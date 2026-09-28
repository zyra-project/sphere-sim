// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * One rig's clean frames, rendered once, and everything a straddle is then
 * computed from without rendering again.
 *
 * ## Why a bank at all
 *
 * A straddled photograph is a weighted sum of frames the page lit, taken in
 * linear light before the sensor (`capture.ts`, `ShutterStraddle`). Every
 * weighted sum this experiment needs is therefore a sum of the SAME few hundred
 * noiseless frames per rig, and rendering each blend from scratch would redo
 * the one expensive thing — the ray trace — thousands of times to produce
 * frames that differ only in their weights. So each rig is rendered once,
 * noiseless, through the bench's own `captureAndDecode` and exactly the options
 * `runScenario` would use (`captureOptionsFor`), and kept.
 *
 * ## The fast path, and what it is worth
 *
 * {@link noisyRun} then puts a blend through the renderer's OWN sensor and the
 * pair's OWN noise stream — `makeSensor` over `pairNoiseSeed` — one draw per
 * pixel in (frame, row, column) order, which is exactly the walk the renderer
 * makes. So a straddled run and its clean twin share every noise draw (common
 * random numbers), and what separates them is the straddle alone.
 *
 * It is a model of the renderer, worth exactly its agreement with the renderer,
 * and it is not bit-exact for a known reason: the bank stores what the renderer
 * stores, Float32, so the sensor here is handed a rounded value where the
 * renderer's hook hands it the double, and now and then the two land either
 * side of a 12-bit step. `capture.test.ts` (T6) measures that walk on clean
 * frames; `straddle.test.ts` holds this module's blends to the hook's renders
 * and its walk to the renderer's; the experiment's G stage validates both on
 * full-size rigs before any number is quoted.
 *
 * ## What a lit state is, seen by one pair
 *
 * A pair (camera `c`, projector `p`) is what the renderer renders and the page
 * decodes. When the part of an exposure is projector `p`'s own frame, it is the
 * bank's frame. When it is the page's dark, it is `p`'s black: the page paints
 * black and `p` still leaks its floor. When it is ANOTHER projector `q`'s
 * frame, the page lit `q`'s quadrant and left `p` black, so the pair saw
 * `L_p(black) + L_q(frame) - L0`, where `L0` is what the pixel shows with no
 * projector lit — the renderer's own composition (`capture.ts`, `stateInto`),
 * exact under the bench's additive light. The bank does not know `L0` from the
 * scene; it reads it off the frames, as the black frame of a projector whose
 * white and black agree at that pixel, and refuses to build if some pixel is
 * reached by every projector.
 *
 * ## What is NOT modelled
 *
 * What the renderer's hook does not model (`capture.ts`): the other
 * projectors' black floors, a camera moving between the parts of one exposure,
 * a DLP projector's sub-frames and a display that scans out.
 */

import { cameraPixelToRay } from '../../../bench/src/camera.ts';
import { captureAndDecode, makeSensor, pairNoiseSeed, type SensorModel } from '../../../bench/src/capture.ts';
import { makeBenchRng } from '../../../bench/src/random.ts';
import { buildWorld, captureOptionsFor, type RunOptions, type ScenarioWorld } from '../../../bench/src/run.ts';
import { PRESETS, makeScenario, type BenchPreset, type Scenario } from '../../../bench/src/scenarios.ts';
import { raySphereIntersect } from '../../../sim/src/geometry.ts';
import { prepareRig, worldToPixel } from '../../../sim/src/optics.ts';
import { assembleCapture, type AssembleParams } from '../../../solver/src/assemble.ts';
import {
  DEFAULT_DECODE_OPTIONS,
  decodeCapture,
  type DecodeOptions,
  type DecodeResult,
  type LinearImage,
  type PatternCapture,
} from '../../../solver/src/decode.ts';
import { fingerprint, type FrameFingerprint } from '../../../solver/src/indexing.ts';
import { manifestFrameRoles } from '../../../web/src/manifest.ts';
import {
  EXPECTED,
  FINGERPRINT_BLOCKS,
  FRAMES_PER_RUN,
  MANIFEST,
  PLAN,
  PROJECTORS,
  SCENE_ROOT_SEED,
  SPILL_ROOM,
  STEPS,
  azimuthOffsetDeg,
  sceneIndex,
} from './design.ts';
import { blendFingerprint, decodedPhotographs, rowParts, type LitState, type Photo } from './run.ts';

/**
 * Which build of a rig: the default preset (320x240); the same with the room
 * on (`SPILL_ROOM`); `PRESETS.thorough` (640x480); or `'reduced'`, the test
 * design, `PRESETS.quick` (224x168) — for checking the plumbing, never quoted.
 */
export type RigVariant = 'default' | 'spill' | 'thorough' | 'reduced';

/** The page's frame roles for one run, from the manifest: what `readRun` assembles with. */
const ROLES = manifestFrameRoles(MANIFEST);
const WHITE = EXPECTED.kinds.indexOf('white');
const BLACK = EXPECTED.kinds.indexOf('black');

/** One rig: its world, its clean frames and fingerprints, and its geometric truth. */
export interface RigBank {
  k: number;
  variant: RigVariant;
  scenario: Scenario;
  world: ScenarioWorld;
  preset: BenchPreset;
  /** The seed every pair's noise stream derives from, as `captureOptionsFor` sets it: the scenario's. */
  seed: number;
  width: number;
  height: number;
  /** The cameras held, by their index in the rig. All of them unless the build asked for fewer. */
  cameras: readonly number[];
  /** `frames[c][p][f]`: noiseless radiance, Float32 as the renderer stores it, `planFrames` order. */
  frames: Float32Array[][][];
  /** `fingerprints[c][p][f]`, by the page's `fingerprint` on `FINGERPRINT_BLOCKS`. */
  fingerprints: FrameFingerprint[][][];
  /** `ambient[c]`: what each pixel shows with no projector lit, `L0`. */
  ambient: Float32Array[];
  ambientFingerprint: FrameFingerprint[];
  /** `lit[c][p]`: pixels whose white exceeds their black by the decoder's own `minModulation`. */
  lit: number[][];
  /**
   * `truth[c][p]`: the projector pixel each camera pixel's ray lands on, NaN
   * where the ray misses the sphere or lands outside `p`'s raster. It is the
   * geometric map and knows nothing of occlusion or incidence, so it is defined
   * too where `p` lights nothing (the far side of the sphere from `p`, or below
   * the incidence floor): read it at decoded pixels, which `p` lit.
   */
  truth: { projU: Float32Array; projV: Float32Array }[][];
  /** `hits[c]`: where each camera pixel's ray meets the sphere, xyz interleaved, NaN where it misses. */
  hits: Float64Array[];
  /** Built on first use; see {@link stateFrame}, {@link stateRowSums}. */
  cache: {
    cross: Map<string, Float64Array>;
    crossFingerprint: Map<string, FrameFingerprint>;
    rowSums: Map<string, Float32Array>;
  };
}

/**
 * A capture's frames in `planFrames` order — white, black, each Gray plane then
 * its complement per axis, then the phase steps per axis — the order the
 * renderer fills a `PatternCapture` in and the decoder's header makes normative.
 * {@link buildRig} holds it to the page's own assembler on every pair it builds.
 */
export function planOrder(capture: PatternCapture): LinearImage[] {
  const out: LinearImage[] = [];
  if (capture.white !== null) out.push(capture.white);
  if (capture.black !== null) out.push(capture.black);
  for (const g of capture.gray) {
    for (let j = 0; j < g.bits; j++) {
      out.push(g.patterns[j]);
      out.push(g.inverses[j]);
    }
  }
  for (const ph of capture.phase) for (const f of ph.frames) out.push(f);
  if (out.length !== FRAMES_PER_RUN) {
    throw new Error(`planOrder: a capture of ${out.length} frames is not the page's run of ${FRAMES_PER_RUN}`);
  }
  return out;
}

/** The page's assembly parameters for one pair: `readRun`'s, from the manifest. */
function assembleParams(camera: number, projector: number): AssembleParams {
  return {
    camera,
    projector,
    projectorRes: MANIFEST.projectorRes,
    grayBits: MANIFEST.plan.grayBits,
    phaseSteps: MANIFEST.plan.phaseSteps,
    phasePeriodStrides: MANIFEST.plan.phasePeriodStrides,
  };
}

/**
 * Build rig `k`: the nominal scenario of cycle `k` (`sceneIndex`), its camera
 * set turned by `azimuthOffsetDeg(k)`, the room on for `'spill'`, and every
 * pair rendered noiseless with exactly the options `runScenario` would use —
 * the page's plan forced through `RunOptions.plan`, the sensor off.
 *
 * `cameras` builds a subset, for a rig too large to hold whole (a thorough rig
 * is about 500 MB of frames); a camera's noiseless frames do not depend on
 * which other cameras were rendered beside it.
 *
 * Checked as it builds, and each check names the defect it stops: the frames'
 * order against the page's own `assembleCapture`, the ambient read off the
 * frames against every projector that does not reach a pixel, and every
 * fingerprint block measured, which the linear fingerprint predictor assumes.
 */
export function buildRig(k: number, variant: RigVariant = 'default', cameras?: readonly number[]): RigBank {
  const preset = variant === 'thorough' ? PRESETS.thorough : variant === 'reduced' ? PRESETS.quick : PRESETS.default;
  const scenario = makeScenario(SCENE_ROOT_SEED, sceneIndex(k), preset);
  scenario.cameras.azimuthOffsetDeg = azimuthOffsetDeg(k);
  if (variant === 'spill') scenario.degradation.roomSpill = { ...SPILL_ROOM };
  const world = buildWorld(scenario);
  if (world.truthRig.projectors.length !== PROJECTORS) {
    throw new Error(`buildRig: rig ${k} has ${world.truthRig.projectors.length} projectors, the page plays ${PROJECTORS}`);
  }
  const held = cameras ?? world.cameras.map((_, c) => c);
  const runOptions: RunOptions = {
    preset,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
    plan: PLAN,
  };
  const base = captureOptionsFor(world, scenario, runOptions, PLAN);
  const width = world.cameras[0].intrinsics.resX;
  const height = world.cameras[0].intrinsics.resY;
  const n = width * height;

  const frames: Float32Array[][][] = world.cameras.map(() => []);
  captureAndDecode(
    world.truthRig,
    held.map((c) => world.cameras[c]),
    {
      ...base,
      conditions: { ...base.conditions, sensor: null },
      onCapture: (i, p, capture) => {
        const c = held[i];
        const ordered = planOrder(capture);
        // The page reassembles a run from roles; if its order and the
        // renderer's ever disagreed, every blend here would decode a frame in
        // another's slot. Identity, not equality: the same images, same slots.
        const again = assembleCapture(ordered, ROLES, assembleParams(c, p));
        if (!again.ok || planOrder(again.capture).some((img, f) => img !== ordered[f])) {
          throw new Error(`buildRig: the page assembles pair (${c}, ${p}) in another order than the renderer`);
        }
        const strides = (x: PatternCapture): string =>
          [...x.gray.map((s) => s.stridePx), ...x.phase.map((s) => s.periodPx)].join();
        if (strides(again.capture) !== strides(capture)) {
          throw new Error(`buildRig: the page and the renderer disagree about pair (${c}, ${p})'s strides`);
        }
        frames[c][p] = ordered.map((img) => {
          if (!(img.data instanceof Float32Array) || img.data.length !== n || img.channels !== 1) {
            throw new Error('buildRig: the renderer no longer stores one Float32 channel per frame');
          }
          return img.data;
        });
      },
    },
  );

  const fingerprints: FrameFingerprint[][][] = world.cameras.map(() => []);
  const ambient: Float32Array[] = [];
  const ambientFingerprint: FrameFingerprint[] = [];
  const lit: number[][] = world.cameras.map(() => []);
  const truth: RigBank['truth'] = world.cameras.map(() => []);
  const hits: Float64Array[] = [];
  const prepared = prepareRig(world.truthRig);
  const radius = world.truthRig.sphere.radiusM;
  const floor = DEFAULT_DECODE_OPTIONS.minModulation;

  for (const c of held) {
    for (let p = 0; p < PROJECTORS; p++) {
      if (frames[c][p] === undefined) throw new Error(`buildRig: pair (${c}, ${p}) was never photographed`);
      fingerprints[c][p] = frames[c][p].map((data, f) => {
        const fp = fingerprint({ width, height, channels: 1, data }, f, FINGERPRINT_BLOCKS);
        if (fp.measured.some((m) => m !== 1)) {
          throw new Error(`buildRig: a ${width}x${height} frame leaves a ${FINGERPRINT_BLOCKS}-block cell empty`);
        }
        return fp;
      });
      let count = 0;
      const w = frames[c][p][WHITE];
      const b = frames[c][p][BLACK];
      for (let i = 0; i < n; i++) if (w[i] - b[i] >= floor) count++;
      lit[c][p] = count;
    }

    // L0: the black frame of any projector that does not reach the pixel, which
    // the renderer writes as the same constant in its white and its black.
    const amb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let found = false;
      for (let p = 0; p < PROJECTORS; p++) {
        const w = frames[c][p][WHITE][i];
        const b = frames[c][p][BLACK][i];
        if (w !== b) continue;
        if (found && amb[i] !== b) {
          throw new Error(`buildRig: camera ${c} pixel ${i} shows two different unlit radiances`);
        }
        amb[i] = b;
        found = true;
      }
      if (!found) {
        throw new Error(`buildRig: every projector reaches camera ${c} pixel ${i}, so no frame shows its unlit radiance`);
      }
    }
    ambient[c] = amb;
    ambientFingerprint[c] = fingerprint({ width, height, channels: 1, data: amb }, -1, FINGERPRINT_BLOCKS);

    // Geometric truth at the pixel centres the decoder reports (camU = px + 0.5).
    const cam = world.cameras[c];
    const xyz = new Float64Array(3 * n).fill(Number.NaN);
    const us = PROJECTORS_ARRAY.map(() => new Float32Array(n).fill(Number.NaN));
    const vs = PROJECTORS_ARRAY.map(() => new Float32Array(n).fill(Number.NaN));
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const i = py * width + px;
        const hit = raySphereIntersect(cam.pose.position, cameraPixelToRay(cam, px + 0.5, py + 0.5), radius);
        if (hit === null) continue;
        xyz[3 * i] = hit.point.x;
        xyz[3 * i + 1] = hit.point.y;
        xyz[3 * i + 2] = hit.point.z;
        for (let p = 0; p < PROJECTORS; p++) {
          const at = worldToPixel(prepared.projectors[p], hit.point);
          if (at === null) continue;
          us[p][i] = at.u;
          vs[p][i] = at.v;
        }
      }
    }
    hits[c] = xyz;
    truth[c] = PROJECTORS_ARRAY.map((p) => ({ projU: us[p], projV: vs[p] }));
  }

  return {
    k,
    variant,
    scenario,
    world,
    preset,
    seed: scenario.seed,
    width,
    height,
    cameras: held,
    frames,
    fingerprints,
    ambient,
    ambientFingerprint,
    lit,
    truth,
    hits,
    cache: { cross: new Map(), crossFingerprint: new Map(), rowSums: new Map() },
  };
}

const PROJECTORS_ARRAY: readonly number[] = Array.from({ length: PROJECTORS }, (_, p) => p);

function held(bank: RigBank, camera: number, projector: number): void {
  if (!bank.cameras.includes(camera) || !(projector >= 0 && projector < PROJECTORS)) {
    throw new Error(`bank: rig ${bank.k} holds no pair (${camera}, ${projector})`);
  }
}

function checkedState(state: LitState): void {
  if (state === 'dark') return;
  if (!(Number.isInteger(state.projector) && state.projector >= 0 && state.projector < PROJECTORS)) {
    throw new Error(`bank: no projector ${state.projector}`);
  }
  if (!(Number.isInteger(state.frame) && state.frame >= 0 && state.frame < FRAMES_PER_RUN)) {
    throw new Error(`bank: no frame ${state.frame}`);
  }
}

/**
 * What pair `(camera, projector)` photographed while the page showed `state`,
 * noiseless: this projector's own frame; its black, for the page's dark; or,
 * for another projector's frame, `L_p(black) + L_q(frame) - L0`. The last is
 * built on first use and kept.
 */
export function stateFrame(bank: RigBank, camera: number, projector: number, state: LitState): Float32Array | Float64Array {
  held(bank, camera, projector);
  checkedState(state);
  if (state === 'dark') return bank.frames[camera][projector][BLACK];
  if (state.projector === projector) return bank.frames[camera][projector][state.frame];
  const key = `${camera}:${projector}:${state.projector}:${state.frame}`;
  let out = bank.cache.cross.get(key);
  if (out === undefined) {
    const black = bank.frames[camera][projector][BLACK];
    const other = bank.frames[camera][state.projector][state.frame];
    const l0 = bank.ambient[camera];
    out = new Float64Array(black.length);
    for (let i = 0; i < out.length; i++) out[i] = black[i] + other[i] - l0[i];
    bank.cache.cross.set(key, out);
  }
  return out;
}

/** {@link stateFrame}'s fingerprint, by linearity from the bank's own fingerprints. */
export function stateFingerprint(bank: RigBank, camera: number, projector: number, state: LitState): FrameFingerprint {
  held(bank, camera, projector);
  checkedState(state);
  if (state === 'dark') return bank.fingerprints[camera][projector][BLACK];
  if (state.projector === projector) return bank.fingerprints[camera][projector][state.frame];
  const key = `${camera}:${projector}:${state.projector}:${state.frame}`;
  let out = bank.cache.crossFingerprint.get(key);
  if (out === undefined) {
    const black = bank.fingerprints[camera][projector][BLACK];
    const other = bank.fingerprints[camera][state.projector][state.frame];
    const l0 = bank.ambientFingerprint[camera];
    const values = new Float32Array(black.values.length);
    for (let i = 0; i < values.length; i++) values[i] = black.values[i] + other.values[i] - l0.values[i];
    out = { ordinal: -1, blocks: black.blocks, values, measured: black.measured };
    bank.cache.crossFingerprint.set(key, out);
  }
  return out;
}

/**
 * One camera row's sum over each block column, for every row: the pieces a
 * fingerprint's block means are made of, so a blend whose weights change from
 * row to row (a rolling readout) can be fingerprinted without its pixels.
 *
 * The block of a pixel is `fingerprint`'s own rule — column
 * `min(B - 1, floor(x·B / width))`, row likewise — and it is checked, not
 * trusted: the block means these sums rebuild must reproduce `fingerprint` on
 * the same frame, or this throws. Float32, like the frames they sum.
 */
export function stateRowSums(bank: RigBank, camera: number, projector: number, state: LitState): Float32Array {
  const key = state === 'dark' ? `${camera}:${projector}:dark` : `${camera}:${projector}:${state.projector}:${state.frame}`;
  let out = bank.cache.rowSums.get(key);
  if (out !== undefined) return out;
  const data = stateFrame(bank, camera, projector, state);
  const { width, height } = bank;
  const B = FINGERPRINT_BLOCKS;
  out = new Float32Array(height * B);
  for (let y = 0; y < height; y++) {
    const acc = new Float64Array(B);
    for (let x = 0; x < width; x++) acc[Math.min(B - 1, Math.floor((x * B) / width))] += data[y * width + x];
    out.set(acc, y * B);
  }
  const want = fingerprint({ width, height, channels: 1, data }, -1, B);
  const whole = [{ weight: 1, sums: out }];
  const rebuilt = fingerprintFromRows(bank, () => whole);
  for (let b = 0; b < want.values.length; b++) {
    if (!(Math.abs(rebuilt[b] - want.values[b]) <= 1e-6 * Math.max(1, Math.abs(want.values[b])))) {
      throw new Error(`stateRowSums: block ${b} rebuilds to ${rebuilt[b]}, and fingerprint() says ${want.values[b]}`);
    }
  }
  bank.cache.rowSums.set(key, out);
  return out;
}

/** Block means from per-row sums, each row weighted by its own parts. */
function fingerprintFromRows(
  bank: RigBank,
  rowTerms: (y: number) => readonly { weight: number; sums: Float32Array }[],
): Float64Array {
  const { width, height } = bank;
  const B = FINGERPRINT_BLOCKS;
  const sums = new Float64Array(B * B);
  const counts = new Float64Array(B * B);
  const colCount = new Float64Array(B);
  for (let x = 0; x < width; x++) colCount[Math.min(B - 1, Math.floor((x * B) / width))]++;
  for (let y = 0; y < height; y++) {
    const by = Math.min(B - 1, Math.floor((y * B) / height));
    for (let bx = 0; bx < B; bx++) counts[by * B + bx] += colCount[bx];
    for (const { weight, sums: rowSums } of rowTerms(y)) {
      for (let bx = 0; bx < B; bx++) sums[by * B + bx] += weight * rowSums[y * B + bx];
    }
  }
  for (let b = 0; b < sums.length; b++) sums[b] /= counts[b];
  return sums;
}

/**
 * The noiseless radiance of `photo` as pair `(camera, projector)` decodes it:
 * each row the weighted sum of what its parts lit, in doubles, which is what
 * the renderer's hook hands its sensor. A row of one part is that state's own
 * values, exactly.
 */
export function photoFrame(bank: RigBank, camera: number, projector: number, photo: Photo): Float64Array {
  const { width, height } = bank;
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const parts = rowParts(photo, y);
    const start = y * width;
    const end = start + width;
    if (parts.length === 1) {
      const only = stateFrame(bank, camera, projector, parts[0].state);
      for (let i = start; i < end; i++) out[i] = only[i];
      continue;
    }
    const ideals = parts.map((part) => stateFrame(bank, camera, projector, part.state));
    for (let i = start; i < end; i++) {
      let v = 0;
      for (let k = 0; k < parts.length; k++) v += parts[k].weight * ideals[k][i];
      out[i] = v;
    }
  }
  return out;
}

/**
 * `photo`'s fingerprint as pair `(camera, projector)` would photograph it,
 * without touching a pixel: the weighted sum of its states' fingerprints for a
 * photograph every row of which integrated the same thing, and per-row block
 * sums (`stateRowSums`) for one whose rows differ.
 */
export function photoFingerprint(
  bank: RigBank,
  camera: number,
  projector: number,
  photo: Photo,
  ordinal: number,
): FrameFingerprint {
  if (photo.rows.length === 1) {
    return blendFingerprint(photo.rows[0], ordinal, (s) => stateFingerprint(bank, camera, projector, s));
  }
  if (photo.rows.length !== bank.height) {
    throw new Error(`photoFingerprint: ${photo.rows.length} rows for a ${bank.height}-row camera`);
  }
  const perRow = new Map<unknown, { weight: number; sums: Float32Array }[]>();
  const rows = (y: number): { weight: number; sums: Float32Array }[] => {
    const parts = photo.rows[y];
    let terms = perRow.get(parts);
    if (terms === undefined) {
      terms = parts.map((part) => ({ weight: part.weight, sums: stateRowSums(bank, camera, projector, part.state) }));
      perRow.set(parts, terms);
    }
    return terms;
  };
  const values = Float32Array.from(fingerprintFromRows(bank, rows));
  return {
    ordinal,
    blocks: FINGERPRINT_BLOCKS,
    values,
    measured: new Uint8Array(values.length).fill(1),
  };
}

/**
 * A camera position's 136 fingerprints in folder order — what the page's
 * `indexPhotographs` would be handed — with photograph `j` photographed as the
 * pair it is filed under.
 */
export function positionFingerprints(bank: RigBank, camera: number, photos: readonly Photo[]): FrameFingerprint[] {
  if (photos.length !== STEPS.length) throw new Error(`positionFingerprints: ${photos.length} photographs, not ${STEPS.length}`);
  return photos.map((photo, j) => photoFingerprint(bank, camera, STEPS[photo.filedStep].projector, photo, j));
}

/**
 * One run's 34 fingerprints, as `pairResiduals` wants them: frame `f` of
 * projector `projector`'s run is the photograph `decodedPhotographs` says the
 * page decodes there, fingerprinted as that pair. With no assignment these are
 * the run's slice of {@link positionFingerprints}.
 */
export function runFingerprints(
  bank: RigBank,
  camera: number,
  projector: number,
  photos: readonly Photo[],
  assignment: readonly (number | null)[] | null = null,
): FrameFingerprint[] {
  const photoFor = decodedPhotographs(photos, assignment);
  const out: FrameFingerprint[] = [];
  for (let f = 0; f < FRAMES_PER_RUN; f++) {
    const j = photoFor[projector * FRAMES_PER_RUN + f];
    out.push(photoFingerprint(bank, camera, projector, photos[j], j));
  }
  return out;
}

/**
 * One run's noiseless frames, as `noisyRun` wants them: frame `f` of projector
 * `projector`'s run is the photograph `decodedPhotographs` says the page decodes
 * there, photographed as that pair.
 */
export function runFrames(
  bank: RigBank,
  camera: number,
  projector: number,
  photos: readonly Photo[],
  assignment: readonly (number | null)[] | null = null,
): (f: number) => Float64Array {
  const photoFor = decodedPhotographs(photos, assignment);
  return (f) => photoFrame(bank, camera, projector, photos[photoFor[projector * FRAMES_PER_RUN + f]]);
}

/**
 * One run through the renderer's own sensor and the pair's own noise stream.
 *
 * `makeSensor(sensor, makeBenchRng(pairNoiseSeed(seed, camera, projector)))`,
 * walked over frames 0-33 and pixels in order, one draw each: exactly what
 * `renderPair` does, so frames noised here share every draw with a render of
 * the same pair under the same seed, and with each other. `seed` is the
 * capture's — the scenario's for a twin (`bank.seed`), a re-shoot's own for the
 * null. Returns what the renderer returns: one Float32 channel per frame.
 */
export function noisyRun(
  bank: RigBank,
  camera: number,
  projector: number,
  framesFor: (f: number) => Float32Array | Float64Array,
  sensor: SensorModel | null,
  seed: number,
): LinearImage[] {
  held(bank, camera, projector);
  const { width, height } = bank;
  const n = width * height;
  const noisy = makeSensor(sensor, makeBenchRng(pairNoiseSeed(seed, camera, projector)));
  const out: LinearImage[] = [];
  for (let f = 0; f < FRAMES_PER_RUN; f++) {
    const src = framesFor(f);
    if (src.length !== n) throw new Error(`noisyRun: frame ${f} holds ${src.length} pixels, the camera ${n}`);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = noisy(src[i]);
    out.push({ width, height, channels: 1, data });
  }
  return out;
}

/**
 * Decode one run's frames as the page does: the page's own `assembleCapture`
 * with the manifest's roles and parameters, then `decodeCapture` — with its
 * defaults unless `decode` says otherwise. Throws where the page would refuse
 * to assemble, which for frames this module built is a bug.
 */
export function decodeRun(
  camera: number,
  projector: number,
  frames: readonly LinearImage[],
  decode: Partial<DecodeOptions> = {},
): DecodeResult {
  return decodeCapture(assembled(camera, projector, frames), decode);
}

function assembled(camera: number, projector: number, frames: readonly LinearImage[]): PatternCapture {
  const got = assembleCapture(frames, ROLES, assembleParams(camera, projector));
  if (!got.ok) throw new Error(`decodeRun: ${got.problems.join(' ')}`);
  return got.capture;
}

/**
 * Each pixel's Gray address as the decoder itself reads it: the same run,
 * assembled the same way, decoded with its phase sequences withheld.
 *
 * With no phase to refine it, `decodeCapture` reports an axis at the centre of
 * the Gray bin it read, `(index + 0.5)·stride` (`decode.ts`, `decodeAxis`), and
 * it reads that index with the very test it uses on a full decode. So two such
 * decodes of one pixel differ on an axis exactly when its Gray word does, and a
 * Gray word is compared without a second statement of how a bit is read. The
 * modulation gate and the bit-separation test are the full decode's, so every
 * pixel a full decode accepts is here too; the phase-only rejections are not.
 */
export function decodeGrayOnly(camera: number, projector: number, frames: readonly LinearImage[]): DecodeResult {
  return decodeCapture({ ...assembled(camera, projector, frames), phase: [] });
}

/**
 * Pixels of camera `camera` that projector `projector` lights: its white clears
 * its black by the decoder's own `minModulation`, the rule {@link RigBank.lit}
 * counts by. One byte per pixel.
 */
export function litMask(bank: RigBank, camera: number, projector: number): Uint8Array {
  held(bank, camera, projector);
  const w = bank.frames[camera][projector][WHITE];
  const b = bank.frames[camera][projector][BLACK];
  const floor = DEFAULT_DECODE_OPTIONS.minModulation;
  const out = new Uint8Array(w.length);
  for (let i = 0; i < w.length; i++) if (w[i] - b[i] >= floor) out[i] = 1;
  return out;
}
