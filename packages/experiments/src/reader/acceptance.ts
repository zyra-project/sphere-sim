// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The page's reader, handed the bench's own photographs and held to a
 * counterfactual reader.
 *
 * `packages/solver/test/position.test.ts` holds `indexPosition` to a small
 * block-space sphere, because the solver may not import the bench. That model
 * has no limb darkening, no specular term, no room and no page encode. So this
 * hands the page's reader what the bench itself renders, noisy, through the
 * page's own path: `noisyRun` (the renderer's sensor and each pair's own noise
 * stream, `straddle/bank.ts`), `encodeSrgb8` at `ENCODE_FULL_SCALE`,
 * `summarisePhoto`, and `indexPhotographs` with the page's manifest. That is the
 * path EXPERIMENT-10's Q0 measured refusing every clean bench position, with the
 * reader the page used then.
 *
 * ## The counterfactual
 *
 * `indexByFingerprint`, handed the SAME encoded fingerprints and every frame's
 * kind exactly, as EXPERIMENT-10's `oracleObservations` hands them. It cannot
 * misclassify a frame, so what it places is what the complement check alone
 * places, and it isolates finding runs from photometry: where the two readers
 * disagree about a run, it is the page's way of finding and numbering runs that
 * differs, not the check. It is not the page's answer on every run, and where
 * it is wrong it is wrong on purpose: it tells the operator to re-shoot a
 * projector the camera cannot see (EXPERIMENT-10's F1b(ii)), which the page
 * must note instead.
 *
 * ## What a clean position is held to
 *
 * {@link judgePosition}: nothing filed under the wrong projector or frame; the
 * projectors the page places are the ones the counterfactual places; every
 * projector that lights no pixel of this camera's picture is noted out of view,
 * never refused and never re-shot; and a run the camera sees is refused only
 * where the counterfactual refuses it too — grazing, and said which.
 *
 * ## The folder shapes
 *
 * {@link judgeShapes}: the folders the card's own procedure makes, from the
 * same renders. The photographs besides the position come from a second noise
 * stream: copies of step 0, projector 1's white, taken before Play; dark ones
 * of the page's black after the last step; and a projector's run shot again —
 * added after the position, played on to the end as the page's remedy leaves it
 * when Play is left running, or handed in alone. Every one is read against what
 * the position alone was read as.
 *
 * And the faults an operator makes on the way (review B's finding 11, untested
 * until then): the camera started a few photographs after Play, with a few dark
 * ones after the black; stopped a few photographs early, with a few of step 0
 * before Play; an exposure test shot of another projector's white before Play,
 * alone and with that projector's re-shoot appended; a projector's run
 * spoiled, one photograph shot twice or not at all, with its re-shoot appended
 * or played on; and (review C's C1 and C6) a test shot of each projector's
 * Gray plane or of its white a stop under before Play, and the room's light
 * switched on at the end tone. None of those has to read as the position: each
 * is held to reading as it, or being refused in words, and never to a
 * photograph filed under the wrong projector or frame.
 *
 * Used by `packages/experiments/test/reader.test.ts` on two rigs at the reduced
 * preset and by `tools/reader-acceptance.ts` on every clean position
 * EXPERIMENT-10's Q0 photographed, so the two hold the reader to one statement
 * of the criteria.
 */

import { captureAndDecode, DEFAULT_SENSOR } from '../../../bench/src/capture.ts';
import { buildWorld, captureOptionsFor, type RunOptions } from '../../../bench/src/run.ts';
import {
  complementResidual,
  DARK_LIMIT,
  FLOOR_QUANTILE,
  indexByFingerprint,
  MODULATION_FLOOR,
  SLOT_SLACK,
  type FrameFingerprint,
  type IndexingResult,
  type ReshootProvenance,
} from '../../../solver/src/indexing.ts';
import { manifestFrameRoles } from '../../../web/src/manifest.ts';
import { indexPhotographs, readRun, summarisePhoto, type IndexedCapture, type PhotoSummary } from '../../../web/src/readback.ts';
import { litMask, noisyRun, planOrder, stateFrame, type RigBank } from '../straddle/bank.ts';
import {
  ENCODE_FULL_SCALE,
  EXPECTED,
  FINGERPRINT_BLOCKS,
  FRAMES_PER_RUN,
  GROSS_PX,
  MANIFEST,
  PLAN,
  PROJECTORS,
  TRANSFER,
  nullSeed,
} from '../straddle/design.ts';
import { designedPhotos, encodeSrgb8, oracleObservations, pairResiduals } from '../straddle/run.ts';
import { reasonOf } from '../straddle/stages.ts';

const WHITE = EXPECTED.kinds.indexOf('white');
const BLACK = EXPECTED.kinds.indexOf('black');
const EVERY: readonly number[] = Array.from({ length: PROJECTORS }, (_, p) => p);

/** A whole camera position's photographs: every projector's run, back to back. */
export const POSITION = PROJECTORS * FRAMES_PER_RUN;

/** What made the page refuse, in EXPERIMENT-10's classes of its words (`reasonOf`). */
export type Reason = ReturnType<typeof reasonOf>;

// ---------------------------------------------------------------------------
// Photographs
// ---------------------------------------------------------------------------

/** The file name the page would show for photograph `j` of a folder, as EXPERIMENT-10 names them. */
function photoName(j: number): string {
  return `IMG_${String(j + 1).padStart(4, '0')}.png`;
}

/** One photograph as the page reads it: encoded to 8-bit sRGB, then summarised. */
export function pagePhoto(width: number, height: number, data: Float32Array, ordinal: number): PhotoSummary {
  const encoded = encodeSrgb8({ width, height, channels: 1, data }, ENCODE_FULL_SCALE);
  return summarisePhoto(encoded, ordinal, photoName(ordinal), TRANSFER, FINGERPRINT_BLOCKS);
}

/** Photographs `from` to the end of one run's noise stream. */
function shoot(
  bank: RigBank,
  camera: number,
  projector: number,
  frames: (f: number) => Float32Array | Float64Array,
  seed: number,
  from = 0,
): PhotoSummary[] {
  return noisyRun(bank, camera, projector, frames, DEFAULT_SENSOR, seed)
    .slice(from)
    .map((img, i) => pagePhoto(bank.width, bank.height, img.data as Float32Array, projector * FRAMES_PER_RUN + from + i));
}

/** `make(p)`, worked out once per `p`. */
function kept<T>(make: (p: number) => T): (p: number) => T {
  const got = new Map<number, T>();
  return (p) => {
    if (!got.has(p)) got.set(p, make(p));
    return got.get(p) as T;
  };
}

/**
 * One camera of a rig, photographed: its clean position, and every photograph
 * the folder shapes add to it.
 */
export interface CameraShots {
  rig: number;
  camera: number;
  /** `bank.lit[c]`: pixels whose white clears their black by the decoder's own floor. */
  lit: number[];
  /** Of those, the pixels whose ray meets the sphere. The rest are the room, where it is on. */
  litOnSphere: number[];
  /** Projector p's run in the clean position, noised as the renderer noises it for this rig. */
  own: PhotoSummary[][];
  /** Projector p's run shot again, under the second stream. Rendered when first asked for. */
  again: (p: number) => PhotoSummary[];
  /** Three photographs of projector p's white, as taken before Play with the page on it. */
  whiteOf: (p: number) => PhotoSummary[];
  /** Four photographs of the page's black after the last step. */
  darks: PhotoSummary[];
  /**
   * A second photograph of projector p's frame f, as the camera takes when it
   * fires twice on one step. Rendered when first asked for.
   */
  twiceOf: (p: number, f: number) => PhotoSummary;
  /**
   * Projector p's white a stop under — its radiance halved — as a test shot of
   * the exposure taken before Play. Rendered when first asked for.
   */
  underOf: (p: number) => PhotoSummary;
  /**
   * The page's black after the last step with the room's light switched on at
   * the end tone: four photographs of it, the room's own light raised `times`
   * over, the first taken as the light came on and lit {@link SWITCHING} of
   * that. Rendered when first asked for.
   */
  roomLit: (times: number) => PhotoSummary[];
}

/**
 * The draw of a pair's second stream a photograph shot twice is taken from:
 * the one before the three a white shot before Play is taken from and the four
 * of the page's black. A run shot again takes this draw for its own frame 29,
 * so a folder holding both still holds no two photographs that are the same
 * draw of the same frame, for any frame shot twice but that one.
 */
const TWICE_AT = FRAMES_PER_RUN - 5;

/** The draw a white a stop under is taken from: the one before a photograph shot twice. */
const UNDER_AT = TWICE_AT - 1;

/** A stop under: the exposure a test shot of a white is taken at, as a share of the position's. */
export const STOP_UNDER = 0.5;

/** How much of the room's light the first photograph after the switch catches: review C's C6. */
export const SWITCHING = 0.4;

/**
 * How many times over the room's own light is raised when it is switched on
 * at the end tone. The bench's ambient, `L0`, lights the sphere at about 4% of
 * a white's peak (0.036 against 0.93), so these put it at about 12% and 38%.
 */
export const ROOM_LIGHT: readonly number[] = [3, 10];

/**
 * Camera `camera` of `bank`, photographed.
 *
 * The clean position is `noisyRun` under the rig's own seed, which shares every
 * draw with a render of the same pair under the same seed (its docblock), so
 * nothing is rendered again. Everything else comes from `second`, a second
 * capture's seed — EXPERIMENT-10 re-shoots rig `k` under `nullSeed(k, i)`. A
 * re-shot run is its pair's whole stream. The photographs taken before Play
 * and after the black come from the end of their pair's stream under the same
 * seed, one photograph a draw, so that no two photographs in one folder are the
 * same draws of the same frame: a copy of a white taken before Play is a second
 * photograph of it, not the same one. A white a stop under takes the draw
 * before a photograph shot twice; the page's black with the room's light
 * switched on takes the draws of the page's black, and is never in a folder
 * with it.
 */
export function photographCamera(bank: RigBank, camera: number, second: number): CameraShots {
  const lit = bank.lit[camera].slice();
  const hits = bank.hits[camera];
  const litOnSphere = EVERY.map((p) => {
    const mask = litMask(bank, camera, p);
    let count = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1 && Number.isFinite(hits[3 * i])) count++;
    return count;
  });
  const frames = (p: number) => (f: number) => bank.frames[camera][p][f];
  const own = EVERY.map((p) => shoot(bank, camera, p, frames(p), bank.seed));
  const last = PROJECTORS - 1;
  const dark = stateFrame(bank, camera, last, 'dark');
  const ambient = bank.ambient[camera];
  /** The page's black with the room's own light raised `times` over, `share` of the way. */
  const roomOn = (times: number, share: number): Float32Array => {
    const out = new Float32Array(dark.length);
    for (let i = 0; i < out.length; i++) out[i] = dark[i] + share * (times - 1) * ambient[i];
    return out;
  };
  const twice = kept((key) => {
    const p = Math.floor(key / FRAMES_PER_RUN);
    const f = key % FRAMES_PER_RUN;
    return shoot(bank, camera, p, () => bank.frames[camera][p][f], second, TWICE_AT)[0];
  });
  return {
    rig: bank.k,
    camera,
    lit,
    litOnSphere,
    own,
    again: kept((p) => shoot(bank, camera, p, frames(p), second)),
    whiteOf: kept((p) => shoot(bank, camera, p, () => bank.frames[camera][p][WHITE], second, FRAMES_PER_RUN - 3)),
    darks: shoot(bank, camera, last, () => dark, second, FRAMES_PER_RUN - 4),
    twiceOf: (p, f) => twice(p * FRAMES_PER_RUN + f),
    underOf: kept((p) => {
      const white = bank.frames[camera][p][WHITE];
      const half = white.map((x) => x * STOP_UNDER);
      return shoot(bank, camera, p, () => half, second, UNDER_AT)[0];
    }),
    roomLit: kept((times) => {
      const switching = roomOn(times, SWITCHING);
      const on = roomOn(times, 1);
      return shoot(bank, camera, last, (f) => (f === FRAMES_PER_RUN - 4 ? switching : on), second, FRAMES_PER_RUN - 4);
    }),
  };
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** Photographs in the order a folder holds them, and the frame each truly is (`-1`: no run's). */
export interface Part {
  photos: readonly PhotoSummary[];
  truth: readonly number[];
}

/** Projector p's run, as the frames it is. */
export function runPart(photos: readonly PhotoSummary[], p: number): Part {
  return { photos, truth: photos.map((_, f) => p * FRAMES_PER_RUN + f) };
}

/** Runs `from` to the last, back to back, as the page plays them. */
export function runsPart(runOf: (p: number) => readonly PhotoSummary[], from: number): Part {
  const photos: PhotoSummary[] = [];
  const truth: number[] = [];
  for (let p = from; p < PROJECTORS; p++) {
    const r = runPart(runOf(p), p);
    photos.push(...r.photos);
    truth.push(...r.truth);
  }
  return { photos, truth };
}

/** Photographs that belong to no run. */
export function extrasPart(photos: readonly PhotoSummary[]): Part {
  return { photos, truth: photos.map(() => -1) };
}

/** A part less its first `k` photographs: what a camera started `k` photographs after Play keeps. */
export function withoutFirst(part: Part, k: number): Part {
  return { photos: part.photos.slice(k), truth: part.truth.slice(k) };
}

/** A part less its last `k` photographs: what a camera stopped `k` photographs early keeps. */
export function withoutLast(part: Part, k: number): Part {
  const n = part.photos.length - k;
  return { photos: part.photos.slice(0, n), truth: part.truth.slice(0, n) };
}

/**
 * A part with photograph `at` shot twice — `twice`, a second photograph of the
 * same frame, straight after it — or not shot at all.
 */
export function spoiled(part: Part, at: number, how: 'doubled' | 'dropped', twice: PhotoSummary): Part {
  if (how === 'dropped') {
    return {
      photos: [...part.photos.slice(0, at), ...part.photos.slice(at + 1)],
      truth: [...part.truth.slice(0, at), ...part.truth.slice(at + 1)],
    };
  }
  return {
    photos: [...part.photos.slice(0, at + 1), twice, ...part.photos.slice(at + 1)],
    truth: [...part.truth.slice(0, at + 1), part.truth[at], ...part.truth.slice(at + 1)],
  };
}

export interface Folder {
  summaries: PhotoSummary[];
  truth: number[];
}

/**
 * A folder of photographs summarised once each. Each is stamped with its place
 * in the folder and named for it, as the page stamps a photograph's ordinal
 * when it reads the file: the ordinal and the name are all `summarisePhoto`
 * takes from where a photograph sits, so this is the summary the page would
 * make of it there.
 */
export function folder(parts: readonly Part[]): Folder {
  const summaries: PhotoSummary[] = [];
  const truth: number[] = [];
  for (const part of parts) {
    part.photos.forEach((s, i) => {
      const j = summaries.length;
      summaries.push({
        ...s,
        name: photoName(j),
        stats: { ...s.stats, ordinal: j },
        fingerprint: { ...s.fingerprint, ordinal: j },
      });
      truth.push(part.truth[i]);
    });
  }
  return { summaries, truth };
}

/** Photographs placed under a frame they are not, counted from one. */
export function misfiled(indexed: IndexedCapture, truth: readonly number[]): string[] {
  const out: string[] = [];
  for (const r of indexed.runs) {
    r.ordinals.forEach((j, f) => {
      if (truth[j] !== r.projector * FRAMES_PER_RUN + f) {
        out.push(`photograph ${j + 1} as projector ${r.projector + 1} frame ${f + 1}`);
      }
    });
  }
  return out;
}

/** Exact kinds for a clean position, from EXPERIMENT-10's own `oracleObservations`. */
const CLEAN_OBSERVATIONS = oracleObservations(designedPhotos('forward', () => 0, 1), 'content');

/** The counterfactual: the complement check alone, handed every frame's kind. A clean position only. */
export function counterfactual(summaries: readonly PhotoSummary[]): IndexingResult {
  if (summaries.length !== CLEAN_OBSERVATIONS.length) {
    throw new Error(`counterfactual: ${summaries.length} photographs, and a clean position is ${CLEAN_OBSERVATIONS.length}`);
  }
  return indexByFingerprint(
    CLEAN_OBSERVATIONS,
    summaries.map((s) => s.fingerprint),
    EXPECTED,
  );
}

// ---------------------------------------------------------------------------
// What the reader looks at, measured the way it looks
// ---------------------------------------------------------------------------

function usable(f: FrameFingerprint, i: number): boolean {
  return f.measured[i] === 1 && Number.isFinite(f.values[i]);
}

/**
 * The crescent a run's references light: blocks whose white clears the black
 * by `DARK_LIMIT` and by `MODULATION_FLOOR` of the brightest block — the rule
 * `indexPosition` finds a run's crescent by (`runWindowAt`), which `MIN_CRESCENT_BLOCKS`
 * counts. Zero blocks where no block clears `DARK_LIMIT`, where the reader
 * finds no run at all.
 */
export function crescentOf(white: FrameFingerprint, black: FrameFingerprint): { blocks: number; peak: number } {
  let peak = 0;
  for (let i = 0; i < white.values.length; i++) {
    if (!usable(white, i) || !usable(black, i)) continue;
    peak = Math.max(peak, white.values[i] - black.values[i]);
  }
  if (!(peak >= DARK_LIMIT)) return { blocks: 0, peak };
  const cut = Math.max(DARK_LIMIT, MODULATION_FLOOR * peak);
  let blocks = 0;
  for (let i = 0; i < white.values.length; i++) {
    if (usable(white, i) && usable(black, i) && white.values[i] - black.values[i] >= cut) blocks++;
  }
  return { blocks, peak };
}

/**
 * How far a slot's photographs rise above the slot's own dark: the most any
 * block of the slot's core rises above its `FLOOR_QUANTILE` over the core —
 * the slot less `SLOT_SLACK` photographs at either end. That is the test
 * `indexPosition` makes of a slot where it found no run (`slotLightOf`): under
 * `DARK_LIMIT` the projector is out of view. Over a run the camera sees it is
 * that run's light.
 */
export function slotRise(photos: readonly FrameFingerprint[]): number {
  const core = photos.length > 2 * SLOT_SLACK ? photos.slice(SLOT_SLACK, photos.length - SLOT_SLACK) : photos;
  const cells = core[0].values.length;
  const column = new Float64Array(core.length);
  let rise = 0;
  for (let i = 0; i < cells; i++) {
    let n = 0;
    for (const f of core) if (usable(f, i)) column[n++] = f.values[i];
    if (n === 0) continue;
    const sorted = Array.from(column.subarray(0, n)).sort((a, b) => a - b);
    const floor = sorted[Math.floor(FLOOR_QUANTILE * (n - 1))];
    rise = Math.max(rise, sorted[n - 1] - floor);
  }
  return rise;
}

/**
 * How far one run's references are from another's: `complementResidual` with
 * one run's white and black as the pair and the other's as the reference, both
 * ways round, and the larger — the number `indexPosition`'s `sameReferences`
 * holds within `COMPLEMENT_LIMIT` before it takes the two for one projector
 * photographed from one place. Null where either way cannot be asked.
 */
export function referenceResidual(
  a: readonly [FrameFingerprint, FrameFingerprint],
  b: readonly [FrameFingerprint, FrameFingerprint],
): number | null {
  const ab = complementResidual(b[0], b[1], a[0], a[1]);
  const ba = complementResidual(a[0], a[1], b[0], b[1]);
  return ab === null || ba === null ? null : Math.max(ab, ba);
}

const refsOf = (run: readonly PhotoSummary[]): [FrameFingerprint, FrameFingerprint] => [
  run[WHITE].fingerprint,
  run[BLACK].fingerprint,
];

// ---------------------------------------------------------------------------
// A clean position
// ---------------------------------------------------------------------------

/** What each reader made of one projector's run in a clean position. */
export interface ProjectorRecord {
  /** Zero-based, as the page's `IndexedCapture` counts projectors. */
  projector: number;
  litPixels: number;
  litOnSphere: number;
  /** {@link crescentOf} the run's own references. */
  crescentBlocks: number;
  peakModulation: number;
  /** {@link slotRise} over the run's slot. */
  slotRise: number;
  reader: 'placed' | 'unseen' | 'barely seen' | 'refused' | 'not placed';
  counterfactual: 'placed' | 'broken' | 'unanswered' | 'refused';
  /** The run's worst complementary pair against its own white and black; null if one cannot be asked. */
  worstPair: number | null;
  /** {@link referenceResidual} between this run and the same run shot again under the second stream. */
  reshootResidual: number | null;
}

export interface PositionRecord {
  rig: number;
  camera: number;
  photographs: number;
  placed: number[];
  unseen: number[];
  barelySeen: number[];
  ok: boolean;
  problems: string[];
  reasons: Reason[];
  notes: string[];
  counterfactualPlaced: number[];
  counterfactualProblems: string[];
  /** The two readers place the same projectors. */
  agrees: boolean;
  misfiled: number;
  projectors: ProjectorRecord[];
  /** Runs the camera lights that neither reader places, said which: `projector N (L px, C blocks): ...`. */
  grazing: string[];
  /** The least {@link referenceResidual} between two projectors this position places; null under two. */
  crossResidual: number | null;
  /** Every criterion the position fails, in words. Empty when it passes. */
  failures: string[];
}

/** The projector a problem is about, zero-based, or null for one about the folder. */
function problemProjector(problem: string): number | null {
  const m = /^Projector (\d+)'s/.exec(problem);
  return m === null ? null : Number(m[1]) - 1;
}

/**
 * Read camera `shots.camera`'s clean position with the page and with the
 * counterfactual, and hold the page to the criteria in the header.
 *
 * `reshootResidual` needs the run shot again, so it is measured only where
 * `withReshoots` asks; the tool asks, the test does not need it.
 */
export function judgePosition(shots: CameraShots, withReshoots: boolean): { record: PositionRecord; indexed: IndexedCapture } {
  const f = folder([runsPart((p) => shots.own[p], 0)]);
  const indexed = indexPhotographs(f.summaries, MANIFEST);
  const cf = counterfactual(f.summaries);
  const placed = indexed.runs.map((r) => r.projector);
  const cfPlaced = [...cf.usableProjectors];
  const wrong = misfiled(indexed, f.truth);
  const failures: string[] = [];
  if (wrong.length > 0) failures.push(`${wrong.length} photographs filed under the wrong frame: ${wrong.slice(0, 3).join('; ')}`);
  const agrees = placed.length === cfPlaced.length && placed.every((p, i) => p === cfPlaced[i]);
  if (!agrees) failures.push(`the page places [${placed}] and the counterfactual [${cfPlaced}]`);
  for (const problem of indexed.problems) {
    const p = problemProjector(problem);
    if (p === null) failures.push(`a problem with the folder: ${problem}`);
    else if (shots.lit[p] === 0) failures.push(`projector ${p + 1} lights nothing here, and is refused: ${problem}`);
    else if (cfPlaced.includes(p)) failures.push(`projector ${p + 1} is refused by the page alone: ${problem}`);
  }
  const texts = [...indexed.problems, ...indexed.notes];
  const grazing: string[] = [];
  const projectors: ProjectorRecord[] = EVERY.map((p) => {
    const run = shots.own[p];
    const crescent = crescentOf(run[WHITE].fingerprint, run[BLACK].fingerprint);
    const residuals = pairResiduals(run.map((s) => s.fingerprint));
    const worstPair = residuals.some((r) => r === null) ? null : Math.max(...(residuals as number[]));
    const cfProblem = cf.problems.find((x) => problemProjector(x) === p) ?? '';
    const reader: ProjectorRecord['reader'] = placed.includes(p)
      ? 'placed'
      : indexed.unseen.includes(p)
        ? 'unseen'
        : indexed.barelySeen.includes(p)
          ? 'barely seen'
          : indexed.problems.some((x) => problemProjector(x) === p)
            ? 'refused'
            : 'not placed';
    if (shots.lit[p] === 0) {
      if (reader !== 'unseen') failures.push(`projector ${p + 1} lights nothing here, and is ${reader}, not out of view`);
      if (!indexed.notes.some((n) => n.startsWith(`Projector ${p + 1} was not in this camera's view`))) {
        failures.push(`projector ${p + 1} lights nothing here, and no note says it was out of view`);
      }
      if (texts.some((x) => x.includes(`Re-shoot projector ${p + 1}`))) {
        failures.push(`projector ${p + 1} lights nothing here, and the page asks for it to be re-shot`);
      }
    } else if (!placed.includes(p) && !cfPlaced.includes(p)) {
      grazing.push(
        `projector ${p + 1} (${shots.lit[p]} px, ${shots.litOnSphere[p]} on the sphere, ${crescent.blocks} blocks): ` +
          `the page: ${reader}; the counterfactual: ${cfProblem || 'not placed'}`,
      );
    }
    return {
      projector: p,
      litPixels: shots.lit[p],
      litOnSphere: shots.litOnSphere[p],
      crescentBlocks: crescent.blocks,
      peakModulation: crescent.peak,
      slotRise: slotRise(run.map((s) => s.fingerprint)),
      reader,
      counterfactual: cfPlaced.includes(p)
        ? 'placed'
        : /played as a pattern and its complement/.test(cfProblem)
          ? 'broken'
          : /could not be checked/.test(cfProblem)
            ? 'unanswered'
            : 'refused',
      worstPair,
      reshootResidual: withReshoots ? referenceResidual(refsOf(run), refsOf(shots.again(p))) : null,
    };
  });
  let crossResidual: number | null = null;
  for (const p of placed) {
    for (const q of placed) {
      if (q <= p) continue;
      const r = referenceResidual(refsOf(shots.own[p]), refsOf(shots.own[q]));
      if (r !== null && (crossResidual === null || r < crossResidual)) crossResidual = r;
    }
  }
  return {
    indexed,
    record: {
      rig: shots.rig,
      camera: shots.camera,
      photographs: f.summaries.length,
      placed,
      unseen: [...indexed.unseen],
      barelySeen: [...indexed.barelySeen],
      ok: indexed.ok,
      problems: [...indexed.problems],
      reasons: indexed.problems.map(reasonOf),
      notes: [...indexed.notes],
      counterfactualPlaced: cfPlaced,
      counterfactualProblems: [...cf.problems],
      agrees,
      misfiled: wrong.length,
      projectors,
      grazing,
      crossResidual,
      failures,
    },
  };
}

// ---------------------------------------------------------------------------
// The folder shapes
// ---------------------------------------------------------------------------

/** What the page should make of every shape: what it made of the position alone. */
export interface Expected {
  placed: readonly number[];
  unseen: readonly number[];
  barelySeen: readonly number[];
  /** Projectors the position alone was refused on: grazing runs the counterfactual refuses too. */
  refused: readonly number[];
}

export interface ShapeRecord {
  rig: number;
  camera: number;
  shape: string;
  /** The shape less the projector and the counts it was made with: what the totals count by. */
  kind: string;
  photographs: number;
  placed: number[];
  unseen: number[];
  barelySeen: number[];
  reshoots: ReshootProvenance[];
  ok: boolean;
  problems: string[];
  reasons: Reason[];
  notes: string[];
  /** Read as the position alone was, a re-shot run used where one was added, and nothing refused. */
  read: boolean;
  misfiled: number;
  failures: string[];
}

const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Adds what a shape fails to `failures`, and says whether the page read it as its position. */
export type Judge = (indexed: IndexedCapture, failures: string[]) => boolean;

/** Read one shape, and what it fails of its judge. */
function readShape(shots: CameraShots, shape: string, kind: string, parts: readonly Part[], judge: Judge): ShapeRecord {
  const f = folder(parts);
  const indexed = indexPhotographs(f.summaries, MANIFEST);
  const wrong = misfiled(indexed, f.truth);
  const failures: string[] = [];
  if (wrong.length > 0) failures.push(`${wrong.length} photographs filed under the wrong frame: ${wrong.slice(0, 3).join('; ')}`);
  const read = judge(indexed, failures) && wrong.length === 0;
  return {
    rig: shots.rig,
    camera: shots.camera,
    shape,
    kind,
    photographs: f.summaries.length,
    placed: indexed.runs.map((r) => r.projector),
    unseen: [...indexed.unseen],
    barelySeen: [...indexed.barelySeen],
    reshoots: indexed.reshoots.map((r) => ({ ...r })),
    ok: indexed.ok,
    problems: [...indexed.problems],
    reasons: indexed.problems.map(reasonOf),
    notes: [...indexed.notes],
    read,
    misfiled: wrong.length,
    failures,
  };
}

/**
 * Every run placed, and out of view and barely seen, as `expect` says, and
 * nothing refused that the position alone was not refused on.
 */
function asPosition(expect: Expected): Judge {
  return (indexed, failures) => {
    const before = failures.length;
    const placed = indexed.runs.map((r) => r.projector);
    if (!same(placed, expect.placed)) failures.push(`placed [${placed}], and the position alone [${expect.placed}]`);
    if (!same(indexed.unseen, expect.unseen)) failures.push(`out of view [${indexed.unseen}], and the position alone [${expect.unseen}]`);
    if (!same(indexed.barelySeen, expect.barelySeen)) {
      failures.push(`barely seen [${indexed.barelySeen}], and the position alone [${expect.barelySeen}]`);
    }
    for (const problem of indexed.problems) {
      const p = problemProjector(problem);
      if (p === null || !expect.refused.includes(p)) failures.push(`refused: ${problem}`);
    }
    return failures.length === before;
  };
}

/** Re-shoots used for exactly `want`'s projectors, each from a run at or after photograph `from`, counted from 0. */
function reshotAfter(want: readonly number[], from: number): Judge {
  return (indexed, failures) => {
    const before = failures.length;
    const got = indexed.reshoots.map((r) => r.projector);
    if (!same(got, want)) failures.push(`re-shoots used for [${got}], where runs of [${want}] were added`);
    if (!indexed.reshoots.every((r) => r.used >= from)) failures.push('a re-shoot used from inside the position');
    return failures.length === before;
  };
}

/**
 * Read as its position, and as `also` says where given — or refused in words.
 * Refused in words: a problem said, nothing placed or noted that the position
 * alone did not place or note, and every run the position alone placed that
 * this does not place named in a problem, unless one is about the folder as a
 * whole. What is placed is held to the photographs' frames either way.
 */
export function asPositionOrRefused(expect: Expected, also?: Judge): Judge {
  return (indexed, failures) => {
    const asIt: string[] = [];
    const read = asPosition(expect)(indexed, asIt);
    if (read && (also === undefined || also(indexed, asIt))) return true;
    if (indexed.problems.length === 0) {
      failures.push(`neither read as its position nor refused: ${asIt.join('; ')}`);
      return false;
    }
    const placed = indexed.runs.map((r) => r.projector);
    for (const p of placed) if (!expect.placed.includes(p)) failures.push(`projector ${p + 1} placed, and the position alone does not place it`);
    for (const p of indexed.unseen) if (!expect.unseen.includes(p)) failures.push(`projector ${p + 1} noted out of view, and the position alone does not note it`);
    for (const p of indexed.barelySeen) {
      if (!expect.barelySeen.includes(p)) failures.push(`projector ${p + 1} noted barely seen, and the position alone does not note it`);
    }
    const named = new Set(indexed.problems.map(problemProjector));
    if (!named.has(null)) {
      for (const p of expect.placed) if (!placed.includes(p) && !named.has(p)) failures.push(`projector ${p + 1} neither placed nor refused`);
    }
    return false;
  };
}

/** How many photographs the camera started late or stopped early by, in the faults' folders. */
export const FEW_LOST: readonly number[] = [1, 2, 4, 8];

/**
 * Which of the faults' folders {@link judgeShapes} builds: every one, or a few
 * for a test — started and stopped 2 and 4 photographs out, the last projector
 * placed test-shot, and the first projector re-shot spoiled, doubled and
 * appended and dropped and played on; then the last projector placed
 * test-shot on a Gray plane and a stop under, and the room's light switched on
 * at the end tone the brighter way.
 */
export type Faults = 'every' | 'few';

/**
 * The frame a spoiled run has shot twice or not at all: Gray plane u4, frame 11
 * counted from 1, whose complement follows it. Every frame after it in the run
 * is then one out, and its pair and every later one no longer add up.
 */
export const SPOILED = 10;

/**
 * The card's folder shapes for one camera, each read by the page and held to
 * `expect`: photographs of step 0 before Play (0, 1 or 3) by dark ones after
 * the black (0, 1 or 2), all nine; and for each projector in `reshot`, its run
 * shot again and added after the position, shot again with the page played on
 * to the end (copies of its white before it, every run from it to the last,
 * and dark photographs after), and shot again and handed in alone.
 *
 * Then the faults in the header, each read as the position or refused in
 * words: the camera started 1, 2, 4 or 8 photographs after Play, with three
 * dark ones after the black; stopped that many early, with three of step 0
 * before Play; for each projector but the first that the position places, a
 * test shot of its white before two of step 0, alone and with that projector
 * re-shot and appended; and for each projector in `reshot`, its run with
 * {@link SPOILED} shot twice and not at all, each re-shot and appended and
 * re-shot and played on. Then, for each projector the position places, a test
 * shot of its Gray plane {@link SPOILED} and of its white a stop under, each
 * before two of step 0; and the room's light switched on at the end tone,
 * {@link ROOM_LIGHT} times over, with two of step 0 before Play. `faults` can
 * ask for a few of those instead.
 */
export function judgeShapes(
  shots: CameraShots,
  expect: Expected,
  reshot: readonly number[],
  faults: Faults = 'every',
): ShapeRecord[] {
  const few = faults === 'few';
  const out: ShapeRecord[] = [];
  const position = runsPart((p) => shots.own[p], 0);
  for (const leading of [0, 1, 3]) {
    for (const trailing of [0, 1, 2]) {
      out.push(
        readShape(
          shots,
          `leading ${leading}, trailing ${trailing}`,
          'before Play and after the black',
          [extrasPart(shots.whiteOf(0).slice(0, leading)), position, extrasPart(shots.darks.slice(0, trailing))],
          asPosition(expect),
        ),
      );
    }
  }
  for (const q of reshot) {
    // Added after the position: used, and the original noted as replaced.
    const appendedAt = POSITION + 2;
    out.push(
      readShape(
        shots,
        `projector ${q + 1} re-shot and appended`,
        're-shot and appended',
        [
          position,
          extrasPart(shots.darks.slice(0, 1)),
          extrasPart(shots.whiteOf(q).slice(0, 1)),
          runPart(shots.again(q), q),
        ],
        (indexed, failures) => {
          const before = failures.length;
          asPosition(expect)(indexed, failures);
          const want = [{ projector: q, used: appendedAt, replaced: q * FRAMES_PER_RUN }];
          if (JSON.stringify(indexed.reshoots) !== JSON.stringify(want)) {
            failures.push(`re-shoots ${JSON.stringify(indexed.reshoots)}, where ${JSON.stringify(want)} was added`);
          }
          const replaced = `Projector ${q + 1}'s run at photographs ${q * FRAMES_PER_RUN + 1}–${(q + 1) * FRAMES_PER_RUN} was replaced by its re-shoot`;
          if (!indexed.notes.some((n) => n.startsWith(replaced))) failures.push('no note says the original was replaced');
          return failures.length === before;
        },
      ),
    );
    // Played on: what the page's remedy produces when Play is left running.
    // Every run of it that the camera sees is used.
    out.push(
      readShape(
        shots,
        `projector ${q + 1} re-shot and played on`,
        're-shot and played on',
        [
          position,
          extrasPart(shots.darks.slice(0, 2)),
          extrasPart(shots.whiteOf(q).slice(0, 3)),
          runsPart(shots.again, q),
          extrasPart(shots.darks.slice(2, 4)),
        ],
        (indexed, failures) => {
          const before = failures.length;
          asPosition(expect)(indexed, failures);
          reshotAfter(expect.placed.filter((p) => p >= q), POSITION)(indexed, failures);
          return failures.length === before;
        },
      ),
    );
    // Handed in alone: refused, with how to hand it in.
    out.push(
      readShape(
        shots,
        `projector ${q + 1} re-shot alone`,
        're-shot alone',
        [extrasPart(shots.whiteOf(q).slice(0, 1)), runPart(shots.again(q), q)],
        (indexed, failures) => {
          const first = indexed.problems[0] ?? '';
          if (indexed.ok || indexed.runs.length > 0) failures.push('a re-shoot handed in alone was read');
          if (!/a re-shoot of one projector handed in on its own/.test(first) || !/added to the end of that camera position's folder/.test(first)) {
            failures.push(`refused without the remedy: ${first}`);
          }
          return false;
        },
      ),
    );
  }
  // ---- the faults on the way
  const first = (photos: readonly PhotoSummary[], k: number): Part => extrasPart(photos.slice(0, k));
  const lostBy = few ? [2, 4] : FEW_LOST;
  for (const lost of lostBy) {
    out.push(
      readShape(
        shots,
        `started ${lost} late, trailing 3`,
        'camera started late',
        [withoutFirst(position, lost), first(shots.darks, 3)],
        asPositionOrRefused(expect),
      ),
    );
  }
  for (const lost of lostBy) {
    out.push(
      readShape(
        shots,
        `stopped ${lost} early, leading 3`,
        'camera stopped early',
        [first(shots.whiteOf(0), 3), withoutLast(position, lost)],
        asPositionOrRefused(expect),
      ),
    );
  }
  const others = expect.placed.filter((p) => p !== 0);
  for (const q of few ? others.slice(-1) : others) {
    // The third photograph of q's white, so that the one a re-shoot starts from is another.
    const head = [extrasPart(shots.whiteOf(q).slice(2, 3)), first(shots.whiteOf(0), 2)];
    out.push(
      readShape(
        shots,
        `a test shot of projector ${q + 1}'s white before Play`,
        'a test shot before Play',
        [...head, position, first(shots.darks, 2)],
        asPositionOrRefused(expect),
      ),
    );
    out.push(
      readShape(
        shots,
        `a test shot of projector ${q + 1}'s white before Play, projector ${q + 1} re-shot and appended`,
        'a test shot before Play, re-shot and appended',
        [...head, position, first(shots.darks, 1), first(shots.whiteOf(q), 1), runPart(shots.again(q), q)],
        asPositionOrRefused(expect, reshotAfter([q], 3 + POSITION)),
      ),
    );
  }
  for (const q of few ? reshot.slice(0, 1) : reshot) {
    for (const how of ['doubled', 'dropped'] as const) {
      const spoilt = spoiled(position, q * FRAMES_PER_RUN + SPOILED, how, shots.twiceOf(q, SPOILED));
      const end = spoilt.photos.length;
      const name = `projector ${q + 1} spoiled, photograph ${SPOILED + 1} of its run ${how}`;
      if (!few || how === 'doubled') {
        out.push(
          readShape(
            shots,
            `${name}, re-shot and appended`,
            'spoiled, re-shot and appended',
            [spoilt, first(shots.darks, 1), first(shots.whiteOf(q), 1), runPart(shots.again(q), q)],
            asPositionOrRefused(expect, reshotAfter([q], end)),
          ),
        );
      }
      if (!few || how === 'dropped') {
        out.push(
          readShape(
            shots,
            `${name}, re-shot and played on`,
            'spoiled, re-shot and played on',
            [spoilt, first(shots.darks, 2), first(shots.whiteOf(q), 3), runsPart(shots.again, q), extrasPart(shots.darks.slice(2, 4))],
            asPositionOrRefused(expect, reshotAfter(expect.placed.filter((p) => p >= q), end)),
          ),
        );
      }
    }
  }
  // A test shot of anything, at any exposure (review C's C1): a focus shot of
  // a projector's Gray plane, or its white a stop under, before two of step 0.
  const tail = [first(shots.whiteOf(0), 2), position, first(shots.darks, 2)];
  for (const q of few ? expect.placed.slice(-1) : expect.placed) {
    out.push(
      readShape(
        shots,
        `a test shot of projector ${q + 1}'s Gray plane, photograph ${SPOILED + 1} of its run, before Play`,
        'a test shot of a Gray plane before Play',
        [extrasPart([shots.twiceOf(q, SPOILED)]), ...tail],
        asPositionOrRefused(expect),
      ),
    );
    out.push(
      readShape(
        shots,
        `a test shot of projector ${q + 1}'s white a stop under before Play`,
        'a test shot a stop under before Play',
        [extrasPart([shots.underOf(q)]), ...tail],
        asPositionOrRefused(expect),
      ),
    );
  }
  // The room's light switched on at the end tone (review C's C6), the first
  // photograph after it taken as it came on, and the camera stopped with four.
  for (const times of few ? ROOM_LIGHT.slice(-1) : ROOM_LIGHT) {
    out.push(
      readShape(
        shots,
        `the room light switched on at the end tone, ${times} times the room's own`,
        'the room light switched on at the end tone',
        [first(shots.whiteOf(0), 2), position, extrasPart(shots.roomLit(times))],
        asPositionOrRefused(expect),
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a run the page does not place would have decoded
// ---------------------------------------------------------------------------

const ROLES = manifestFrameRoles(MANIFEST);

/** What the page's decode made of one run, against the geometric truth. */
export interface DecodeRecord {
  correspondences: number;
  /** Of those, how many sit where the camera pixel's ray misses the sphere: the room. */
  offSphere: number;
  /** Median distance from the truth over the rest, projector pixels; null when there are none. */
  medianErrorPx: number | null;
  /** Of the rest, how many miss the truth by more than a quarter of a fringe period on an axis. */
  gross: number;
}

/**
 * Projector `projector`'s run in camera `camera`'s clean position through the
 * page's own decode, `readRun` with the manifest's roles, as the page would
 * decode it had it placed the run: the same photographs {@link photographCamera}
 * shoots — the rig's seed, so the same draws — encoded as the page reads them.
 * Every correspondence is held to the bank's geometric truth. For a run the
 * page leaves undecoded, this is what it gave up.
 */
export function pageDecode(bank: RigBank, camera: number, projector: number): DecodeRecord {
  const images = noisyRun(bank, camera, projector, (f) => bank.frames[camera][projector][f], DEFAULT_SENSOR, bank.seed).map(
    (img) => encodeSrgb8(img, ENCODE_FULL_SCALE),
  );
  const { correspondences } = readRun(
    { camera, projector, images, names: images.map((_, f) => photoName(projector * FRAMES_PER_RUN + f)) },
    ROLES,
    MANIFEST,
    TRANSFER,
  );
  const truth = bank.truth[camera][projector];
  const hits = bank.hits[camera];
  const errors: number[] = [];
  let offSphere = 0;
  let gross = 0;
  for (const x of correspondences) {
    const i = (x.camV - 0.5) * bank.width + (x.camU - 0.5);
    const du = x.projU - truth.projU[i];
    const dv = x.projV - truth.projV[i];
    if (!Number.isFinite(hits[3 * i]) || !Number.isFinite(du) || !Number.isFinite(dv)) {
      offSphere++;
      continue;
    }
    errors.push(Math.hypot(du, dv));
    if (Math.abs(du) > GROSS_PX.u || Math.abs(dv) > GROSS_PX.v) gross++;
  }
  errors.sort((a, b) => a - b);
  return {
    correspondences: correspondences.length,
    offSphere,
    medianErrorPx: errors.length === 0 ? null : errors[Math.floor(errors.length / 2)],
    gross,
  };
}

// ---------------------------------------------------------------------------
// A camera moved between a run and its re-shoot
// ---------------------------------------------------------------------------

/**
 * A rig's runs as its camera set, turned `deltaDeg` further about the sphere's
 * axis, would photograph them under capture seed `seed`: every camera's run of
 * every projector, through the renderer's own sensor, then the page's encode
 * and summary.
 *
 * The bank's own scenario — `buildRig`'s, with the set already turned by
 * `azimuthOffsetDeg(k)` — copied and turned further. `buildRig` is left alone,
 * because EXPERIMENT-10's rigs are what it builds. The turn moves every camera
 * by `deltaDeg` and nothing else: heights, distances and each camera's own
 * jitter draw are the scenario's. Rendered with the sensor on rather than
 * banked and noised, which is how EXPERIMENT-10's Q0 photographed: under the
 * same seed a pair's noise stream is the one `noisyRun` walks, so a set turned
 * by 0 photographs the bank's runs under that seed, to within the 12-bit steps
 * `noisyRun`'s docblock says the two can land either side of.
 */
export function turnedRuns(bank: RigBank, deltaDeg: number, seed: number): PhotoSummary[][][] {
  const { preset } = bank;
  const scenario = structuredClone(bank.scenario);
  scenario.cameras.azimuthOffsetDeg = (scenario.cameras.azimuthOffsetDeg ?? 0) + deltaDeg;
  const world = buildWorld(scenario);
  const runOptions: RunOptions = {
    preset,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
    plan: PLAN,
    captureSeed: seed,
  };
  const base = captureOptionsFor(world, scenario, runOptions, PLAN);
  if (JSON.stringify(base.conditions.sensor) !== JSON.stringify(DEFAULT_SENSOR)) {
    throw new Error(`turnedRuns: rig ${bank.k} (${bank.variant}) does not photograph with DEFAULT_SENSOR`);
  }
  const width = world.cameras[0].intrinsics.resX;
  const height = world.cameras[0].intrinsics.resY;
  const out: PhotoSummary[][][] = world.cameras.map(() => []);
  captureAndDecode(world.truthRig, world.cameras, {
    ...base,
    noiseCameraIndices: world.cameras.map((_, c) => c),
    onCapture: (c, p, capture) => {
      out[c][p] = planOrder(capture).map((img, f) =>
        pagePhoto(width, height, img.data as Float32Array, p * FRAMES_PER_RUN + f),
      );
    },
  });
  return out;
}

/** Rig `k`'s second capture seed, for the photographs besides its clean positions. */
export function secondSeed(k: number): number {
  return nullSeed(k, 0);
}
