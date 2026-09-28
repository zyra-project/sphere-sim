// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * EXPERIMENT-10's measurements: the stages, their checkpoints and the solves.
 *
 * Everything a checkpoint holds is computed here, and this file is inside the
 * checkpoint fingerprint. The document the checkpoints are assembled into is
 * computed in `assemble.ts`, which is outside it, and `cli.ts` only runs the
 * one and then the other. The stages and what each is for are listed in
 * `cli.ts`'s header.
 *
 * ## Why the measurement and the document are two modules
 *
 * A checkpoint is a measurement taken by one build against one design, so it
 * carries a fingerprint of the design constants and of every source file that
 * decides what it holds, and a mismatch refuses to resume (see
 * {@link codeFingerprint}). The full run is about four hours of measurement.
 * While the assembly lived in the same file as the stages, the fingerprint
 * covered it too. So an edit to a document field, to what a table needs or to
 * the verdict's wording, made after that run had started, turned every
 * checkpoint stale. The choice was then between measuring again and committing
 * a document that lists every stage under `staleCheckpointsAccepted`.
 * `segmentation/cli.ts` had already drawn this line ("the plot and the
 * aggregation are deliberately NOT in it"), and this split draws it for
 * EXPERIMENT-10.
 *
 * ## What must never move across the line
 *
 * Nothing that measures may move to `assemble.ts`. That covers anything that
 * renders, fingerprints, indexes, decodes or solves; anything that writes a
 * checkpoint or a line of `solves.jsonl`; and anything that decides what a
 * stage renders, decodes or solves. Edited over there, such code would change
 * what the next run measures without changing the fingerprint, and a resumed
 * run would mix two builds' numbers under one stamp.
 *
 * The rules a stage decides by stay here even where the document needs them
 * too, and the assembly imports them from here. That covers a position's
 * category, the refine band and which runs a solve withholds. A document can
 * then only describe a run in the terms the run was chosen by. Two statements
 * of one such rule are how a solve's straddle came to disagree with its
 * capture's reported category (see {@link deciding}).
 *
 * Nothing here may import `assemble.ts` or `cli.ts`, not even for a type. The
 * fingerprint hashes bytes, not imports, so a stage that called into the
 * assembly would carry unfingerprinted code into its measurements.
 * `straddle.test.ts` walks this module's import closure and holds every file
 * in it to the fingerprint, and holds both documents' modules out of both.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SENSOR,
  captureAndDecode,
  type CaptureOptions,
  type ShutterStraddle,
} from '../../../bench/src/capture.ts';
import { frameBlockGrid, planFrames } from '../../../bench/src/patterns.ts';
import { deriveSeed, makeBenchRng } from '../../../bench/src/random.ts';
import { captureOptionsFor, runScenario, type RunOptions } from '../../../bench/src/run.ts';
import { GATES } from '../../../calibration/src/parameters.ts';
import type { RigCalibration } from '../../../calibration/src/index.ts';
import { raySphereIntersect } from '../../../sim/src/geometry.ts';
import { computeGridDisplacement } from '../../../sim/src/metrics/grid.ts';
import { gateById } from '../../../sim/src/metrics/types.ts';
import { pixelToRay, prepareRig, type PreparedRig } from '../../../sim/src/optics.ts';
import type {
  Correspondence,
  DecodeStats,
  LinearImage,
  PatternCapture,
} from '../../../solver/src/decode.ts';
import {
  COMPLEMENT_LIMIT,
  classify,
  fingerprint,
  indexByBookends,
  indexByFingerprint,
  litFractions,
  type FrameFingerprint,
  type IndexingResult,
} from '../../../solver/src/indexing.ts';
import { manifestFrameRoles } from '../../../web/src/manifest.ts';
import {
  describeIndexing,
  finishCapture,
  indexPhotographs,
  readRun,
  summarisePhoto,
  type PhotoSummary,
} from '../../../web/src/readback.ts';
import {
  runTrial,
  shotTimings,
  straddles,
  summarise,
  type ShotTiming,
} from '../tether/run.ts';
import type { Arm, StartPhase } from '../tether/design.ts';
import * as DESIGN from './design.ts';
import {
  ARMS,
  DECODE_LEVELS,
  DESIGNED_RIGS,
  DWELL_S,
  ENCODE_FULL_SCALE,
  EXP9_SEED_ROOT,
  EXPECTED,
  EXPOSURE_S,
  FINGERPRINT_BLOCKS,
  FRAMES_PER_RUN,
  GAIN_JITTER,
  GATE_SCAN,
  GROSS_PX,
  HANDHELD_TRIALS,
  HEADLESS_LATENESS_MS,
  K_NULL,
  LATE_MS_RENDERED,
  LATE_MS_TIMING,
  MANIFEST,
  MARGINAL_RESIDUAL,
  MINOR_RUN_CORR,
  NOISY_LEVELS,
  PERIOD_PX,
  PLAN,
  POSE_LEVELS,
  POSITIONS,
  PROJECTORS,
  PROJECTOR_RES,
  READOUT_S,
  RIGS,
  SHORT_EXPOSURE_S,
  SINGLE_LEVELS,
  SPILL_RIGS,
  STEPS,
  THOROUGH_RIGS,
  TONE_CURVE,
  TRANSFER,
  TRIALS,
  VSYNC_S,
  DECODE_SUBSAMPLE,
  SOLVE_SUBSAMPLE,
  exp9TrialSeed,
  gainSeed,
  nullSeed,
  straddledCamera,
  subsampleSeed,
  vsyncSeed,
} from './design.ts';
import {
  PHASE_FRAMES,
  blendFingerprint,
  classifyPosition,
  contentChanged,
  designedPhotos,
  encodeSrgb8,
  failingPair,
  isolatedCheck,
  oracleObservations,
  pageParts,
  pairResiduals,
  positionPhotos,
  quarterMasses,
  reconcileShots,
  runCrossing,
  runPlaced,
  runVerdicts,
  straddleForCamera,
  u0Crossing,
  type Photo,
  type PositionCategory,
  type RunOutcome10,
  type RunOutcomeKind,
  type TwinStatus,
} from './run.ts';
import {
  buildRig,
  decodeGrayOnly,
  decodeRun,
  litMask,
  noisyRun,
  photoFingerprint,
  photoFrame,
  planOrder,
  positionFingerprints,
  runFingerprints,
  runFrames,
  type RigBank,
  type RigVariant,
} from './bank.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const CHECKPOINT_SCHEMA = 'sphere-sim/experiment-10-checkpoint@1';

export const STAGES = [
  'q0',
  'bank',
  'gate',
  'decode',
  'pose',
  'rescore',
  'lateness',
  'assemble',
] as const;
export type StageName = (typeof STAGES)[number];

// ---------------------------------------------------------------------------
// The design a run executes
// ---------------------------------------------------------------------------

/**
 * Everything a run executes, as data. The published run is {@link FULL_PLAN},
 * built from `design.ts` and nothing else; the others shrink it for a stated
 * purpose and are never written to the committed file.
 *
 * It is one object, and it enters the checkpoint fingerprint whole, so a
 * checkpoint from a quick run can never be resumed as part of a full one.
 */
export interface Exp10Plan {
  /** `full` is the published run; `quick` and `smoke` check plumbing; `test` is T24's. */
  mode: 'full' | 'quick' | 'smoke' | 'test';
  /** What every rig of the main sweep is built at: `default` (320x240), or `reduced` (224x168). */
  variant: 'default' | 'reduced';
  /** The main sweep: q0, bank, gate crossings and the re-scoring's trial-to-rig map. */
  rigs: readonly number[];
  /** Rigs the dose-response arms use (noisy confirmation, rolling, gain, decode, pose). */
  designedRigs: readonly number[];
  /** Rigs rebuilt with the room on (`DEFAULT_ROOM_SPILL`). */
  spillRigs: readonly number[];
  /** Rigs rebuilt at a finer preset, and which one: 640x480 in the published run. */
  fineRigs: readonly number[];
  fineVariant: RigVariant;
  /** The hook validation: rigs, cameras and forward smears rendered through `captureAndDecode`. */
  hookRigs: readonly number[];
  hookCameras: readonly number[];
  hookLevels: readonly number[];
  /** Rigs whose every frame is straddled alone and decoded (D, single-frame classes). */
  singleFrameRigs: readonly number[];
  /** Rigs the 8-bit encode is checked on, at the main and the fine preset. */
  encodeRigs: readonly number[];
  /** Mechanism arms take at most this many attributable runs a camera; null takes every one. */
  runsPerCamera: number | null;
  /**
   * The crossing scan takes at most this many runs a camera, attributable ones first; null scans
   * every run.
   */
  crossingsPerCamera: number | null;
  /**
   * Cameras the gate and decode arms visit; null visits every one. Positions are always every
   * camera.
   */
  armCameras: readonly number[] | null;
  trials: number;
  handheldTrials: number;
  /**
   * EXPERIMENT-9 cells are re-derived at this many trials; 2000 compares with the committed file.
   */
  auditTrials: number;
  noisyLevels: readonly number[];
  singleLevels: readonly number[];
  rollingRatios: readonly number[];
  gainSigmas: readonly number[];
  gainDraws: number;
  gainLevels: readonly number[];
  encodeLevels: readonly number[];
  shortRowFractions: readonly number[];
  decodeNoiseless: readonly number[];
  decodeNoisy: readonly number[];
  singleFrameLevels: readonly number[];
  rollingDecode: { ratios: readonly number[]; midRow: readonly number[] };
  /** Pose arms; false skips every solve (quick, test). */
  pose: boolean;
  poseLevels: {
    forward: readonly number[];
    backward: readonly number[];
    rolling: { readoutOverExposure: number; midRow: readonly number[] };
  };
  kNull: number;
  solveSubsample: number;
  decodeSubsample: number;
  lateMsTiming: readonly number[];
  lateMsRendered: readonly number[];
}

/** The published run: every number from `design.ts`. */
export const FULL_PLAN: Exp10Plan = {
  mode: 'full',
  variant: 'default',
  rigs: Array.from({ length: RIGS }, (_, k) => k),
  designedRigs: DESIGNED_RIGS,
  spillRigs: SPILL_RIGS,
  fineRigs: THOROUGH_RIGS,
  fineVariant: 'thorough',
  hookRigs: [0, 12],
  hookCameras: [0, 1],
  hookLevels: [0.06, 0.12],
  singleFrameRigs: [0, 12],
  encodeRigs: THOROUGH_RIGS,
  runsPerCamera: null,
  crossingsPerCamera: null,
  armCameras: null,
  trials: TRIALS,
  handheldTrials: HANDHELD_TRIALS,
  auditTrials: TRIALS,
  noisyLevels: NOISY_LEVELS,
  singleLevels: SINGLE_LEVELS,
  rollingRatios: [READOUT_S[1] / EXPOSURE_S, READOUT_S[2] / EXPOSURE_S],
  gainSigmas: GAIN_JITTER,
  gainDraws: 20,
  gainLevels: [0.05, 0.1, 0.15],
  encodeLevels: [0.1, 0.12, 0.14],
  shortRowFractions: [0.25, 0.5, 0.75],
  decodeNoiseless: DECODE_LEVELS.noiseless,
  decodeNoisy: DECODE_LEVELS.noisy,
  singleFrameLevels: [0.2, 0.5],
  rollingDecode: {
    ratios: [READOUT_S[1] / EXPOSURE_S, READOUT_S[2] / EXPOSURE_S],
    midRow: [0.05, 0.1],
  },
  pose: true,
  poseLevels: POSE_LEVELS,
  kNull: K_NULL,
  solveSubsample: SOLVE_SUBSAMPLE,
  decodeSubsample: DECODE_SUBSAMPLE,
  lateMsTiming: LATE_MS_TIMING,
  lateMsRendered: LATE_MS_RENDERED,
};

/**
 * `--quick`: the spec's four rigs, 300 trials and no pose, at the reduced
 * preset, with every arm run but thinned. Its purpose is that every code path
 * runs end to end in minutes; its numbers are not quoted anywhere, and the
 * fine-preset comparison is the default preset against the reduced one.
 */
export const QUICK_PLAN: Exp10Plan = {
  ...FULL_PLAN,
  mode: 'quick',
  variant: 'reduced',
  rigs: [0, 6, 12, 18],
  designedRigs: [0, 6, 12, 18],
  spillRigs: [0],
  fineRigs: [0],
  fineVariant: 'default',
  hookRigs: [0],
  hookCameras: [0],
  hookLevels: [0.12],
  singleFrameRigs: [0],
  encodeRigs: [0],
  runsPerCamera: 1,
  crossingsPerCamera: 2,
  trials: 300,
  handheldTrials: 75,
  auditTrials: TRIALS,
  noisyLevels: [0, 0.06, 0.12],
  rollingRatios: [READOUT_S[2] / EXPOSURE_S],
  gainDraws: 5,
  decodeNoiseless: [0.05, 0.1, 0.4, 0.43, 0.5],
  decodeNoisy: [0.05, 0.1],
  singleFrameLevels: [0.2],
  rollingDecode: { ratios: [READOUT_S[2] / EXPOSURE_S], midRow: [0.1] },
  pose: false,
  kNull: 0,
  solveSubsample: 0,
  decodeSubsample: 10,
  lateMsTiming: LATE_MS_TIMING,
  lateMsRendered: LATE_MS_RENDERED,
};

/**
 * `--smoke`: the solve path, which `--quick` never touches, on one designed
 * rig with one level of each pose arm, one re-shoot, and the first few solved
 * captures of the headline and lateness cells. For finding out that a
 * three-hour run would crash at its first solve before it has spent two hours
 * getting there.
 */
export const SMOKE_PLAN: Exp10Plan = {
  ...QUICK_PLAN,
  mode: 'smoke',
  rigs: [0],
  designedRigs: [0],
  spillRigs: [],
  fineRigs: [],
  hookRigs: [],
  singleFrameRigs: [],
  encodeRigs: [],
  runsPerCamera: 1,
  trials: 48,
  handheldTrials: 8,
  auditTrials: 40,
  noisyLevels: [0.12],
  singleLevels: [0.1],
  gainSigmas: [0.01],
  gainDraws: 2,
  gainLevels: [0.1],
  encodeLevels: [0.12],
  shortRowFractions: [0.5],
  decodeNoiseless: [0.1],
  decodeNoisy: [0.1],
  singleFrameLevels: [0.2],
  lateMsTiming: [0, HEADLESS_LATENESS_MS.hudTickOff],
  pose: true,
  poseLevels: {
    forward: [0.06],
    backward: [0.06],
    rolling: { readoutOverExposure: 0.3, midRow: [0.06] },
  },
  kNull: 1,
  solveSubsample: 2,
  decodeSubsample: 3,
};

/**
 * T24's reduced design: one rig at the reduced preset, a few trials, every
 * stage but the solves, each thinned to seconds. It exists to be run twice and
 * compared, so it must reach every place a run-to-run difference could enter.
 */
export const TEST_PLAN: Exp10Plan = {
  ...SMOKE_PLAN,
  mode: 'test',
  crossingsPerCamera: 1,
  armCameras: [0],
  // Large enough that the gain arm's verdicts depend on its draws, so a stream
  // that stopped being a function of its seed would change the document.
  gainSigmas: [0.05],
  pose: false,
  kNull: 0,
  solveSubsample: 0,
  trials: 10,
  handheldTrials: 4,
  auditTrials: 10,
  rollingRatios: [0.3],
  rollingDecode: { ratios: [0.3], midRow: [0.1] },
  lateMsTiming: [0, HEADLESS_LATENESS_MS.hudTickOff],
  lateMsRendered: [HEADLESS_LATENESS_MS.hudTickOff],
};

// ---------------------------------------------------------------------------
// Small arithmetic, stated once
// ---------------------------------------------------------------------------

/** Linear-interpolated quantile of an ascending array (type 7); NaN when empty. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function ascending(xs: readonly number[]): number[] {
  return xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

export function median(xs: readonly number[]): number {
  return quantile(ascending(xs), 0.5);
}

export function mean(xs: readonly number[]): number {
  const f = xs.filter((x) => Number.isFinite(x));
  return f.length === 0 ? Number.NaN : f.reduce((a, x) => a + x, 0) / f.length;
}

/** For the document only, never for a decision: numbers a reader can read. */
export function round(x: number | null, digits = 4): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function worstOf(residuals: readonly (number | null)[]): number | null {
  if (residuals.some((r) => r === null)) return null;
  return Math.max(...(residuals as number[]));
}

/** The page's plan, frame by frame. */
export const SPECS = planFrames(PLAN);
/** A frame's class: W, B, G_u0..., C_u0..., then the phase steps φ_u0... */
export const FRAME_CLASSES: readonly string[] = SPECS.map((s) =>
  s.kind === 'white'
    ? 'W'
    : s.kind === 'black'
      ? 'B'
      : s.kind === 'gray'
        ? `G_${s.axis}${s.index}`
        : s.kind === 'grayInverse'
          ? `C_${s.axis}${s.index}`
          : `phase_${s.axis}${s.index}`,
);
const BLACK_FRAME = EXPECTED.kinds.indexOf('black');
const ROLES = manifestFrameRoles(MANIFEST);
const CLEAN: readonly Photo[] = designedPhotos('forward', () => 0, 1);

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/** Where a run keeps its checkpoints: a directory, or memory for T24. */
export interface Store {
  read(name: string): string | null;
  write(name: string, text: string): void;
  append(name: string, line: string): void;
  where: string;
}

export function fileStore(dir: string): Store {
  return {
    where: path.relative(ROOT, dir) || dir,
    read(name) {
      const f = path.join(dir, name);
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    },
    write(name, text) {
      fs.mkdirSync(dir, { recursive: true });
      // Written aside and renamed, so an interrupted write leaves the previous
      // checkpoint rather than half of a new one.
      const f = path.join(dir, name);
      fs.writeFileSync(`${f}.tmp`, text);
      fs.renameSync(`${f}.tmp`, f);
    },
    append(name, line) {
      fs.mkdirSync(dir, { recursive: true });
      // One write per line. Linux serialises writes to one regular file, so the
      // stages that may run side by side (pose, rescore, lateness) can share
      // `solves.jsonl` without interleaving a line. A reader can still catch a
      // line half-written; `loadSolves` reads whole lines only.
      fs.appendFileSync(path.join(dir, name), `${line}\n`);
    },
  };
}

export function memoryStore(): Store {
  const files = new Map<string, string>();
  return {
    where: '(memory)',
    read: (name) => files.get(name) ?? null,
    write: (name, text) => {
      files.set(name, text);
    },
    append: (name, line) => {
      files.set(name, `${files.get(name) ?? ''}${line}\n`);
    },
  };
}

/**
 * Every source file that decides what a stage measures: the spec's list, with
 * this experiment's own directory taken whole rather than file by file.
 *
 * Whole, less {@link DOCUMENT_SOURCES}, so that a module added to the directory
 * is fingerprinted until somebody decides otherwise. That is the safe way to
 * be wrong: a stage outside the fingerprint resumes stale measurements
 * silently, and a document module inside it costs a re-run.
 */
const MEASUREMENT_SOURCES = [
  'packages/sim/src',
  'packages/solver/src',
  'packages/bench/src',
  'packages/calibration/src',
  'packages/web/src/readback.ts',
  'packages/web/src/manifest.ts',
  'packages/web/src/emit.ts',
  'packages/experiments/src/tether/design.ts',
  'packages/experiments/src/tether/run.ts',
  'packages/experiments/src/straddle',
];

/**
 * The document's side of the line (see the header): read checkpoints, write
 * the document, and never measure. Left out of {@link codeFingerprint}, so an
 * edit here re-assembles a finished run instead of invalidating it, and hashed
 * on their own into the document's `assemblyFingerprint`, so the document still
 * says which code wrote it.
 */
export const DOCUMENT_SOURCES: readonly string[] = [
  'packages/experiments/src/straddle/assemble.ts',
  'packages/experiments/src/straddle/cli.ts',
];

/** Every `.ts` under a path, sorted, so the hash does not depend on readdir order. */
function sourceFiles(target: string): string[] {
  if (!fs.existsSync(target)) return [];
  if (fs.statSync(target).isFile()) return [target];
  const out: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

/**
 * The files {@link codeFingerprint} hashes, relative to the repository, in the
 * order it hashes them.
 *
 * A document module that is not on disk is refused rather than skipped. Renamed
 * without this list following, it would fall into the directory's measurement
 * side, which is safe; deleted while still listed, it would leave the list
 * naming a line that no longer exists.
 */
export function measurementFiles(): string[] {
  for (const rel of DOCUMENT_SOURCES) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      throw new Error(`experiment10: the document module ${rel} is not there`);
    }
  }
  const out: string[] = [];
  for (const rel of MEASUREMENT_SOURCES) {
    const files = sourceFiles(path.join(ROOT, rel))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
      .filter((file) => !DOCUMENT_SOURCES.includes(file));
    if (files.length === 0) throw new Error(`experiment10: nothing to fingerprint at ${rel}`);
    out.push(...files);
  }
  return out;
}

/**
 * The design constants — every value `design.ts` exports, which is what the
 * document's `generatedFrom` repeats — and the plan, as one canonical string.
 */
export function designConstants(plan: Exp10Plan): Record<string, unknown> {
  const constants: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(DESIGN)) {
    if (typeof value !== 'function') constants[name] = value;
  }
  return { constants, plan };
}

/** How a fingerprint reads a source file; the test hands in one that edits a file on the way. */
export type SourceReader = (file: string) => Uint8Array | string;
const readSource: SourceReader = (file) => fs.readFileSync(file);

/**
 * The checkpoint fingerprint: the design, the plan and the bytes of every
 * {@link measurementFiles} file, the path included, so a file moved across the
 * line changes it.
 */
export function codeFingerprint(plan: Exp10Plan, read: SourceReader = readSource): string {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(designConstants(plan)));
  for (const rel of measurementFiles()) {
    h.update(rel);
    h.update(read(path.join(ROOT, rel)));
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * The document's own provenance: the bytes of {@link DOCUMENT_SOURCES}. It is
 * not a checkpoint's concern, and a checkpoint never carries it.
 */
export function assemblyFingerprint(read: SourceReader = readSource): string {
  const h = crypto.createHash('sha256');
  for (const rel of DOCUMENT_SOURCES) {
    h.update(rel);
    h.update(read(path.join(ROOT, rel)));
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * A checkpoint that belongs to another build or design, refused unless stale ones were accepted.
 */
export class StaleCheckpoint extends Error {}

export interface RunContext {
  plan: Exp10Plan;
  store: Store;
  fingerprint: string;
  acceptStale: boolean;
  /** Stale checkpoints accepted on purpose, named in the document. */
  staleAccepted: string[];
  log: (line: string) => void;
  /** Every solve on record, by id; filled from `solves.jsonl` and by this process. */
  solves: Map<string, SolveRecord>;
  /**
   * The last rig built, kept for the next stage that asks for the same one. A
   * rig is rebuilt from its scenario deterministically, so this saves time
   * and changes nothing; one rig at a time, because a rig is about 125 MB.
   */
  held: { unit: string; bank: RigBank } | null;
}

export interface StageFile<T> {
  schema: string;
  fingerprint: string;
  stage: StageName;
  /**
   * Per-unit results, keyed by the unit (usually a rig); a resumed stage skips the units present.
   */
  units: Record<string, T>;
  complete: boolean;
}

function checkRecord(
  ctx: RunContext,
  where: string,
  raw: { schema?: unknown; fingerprint?: unknown },
): void {
  const why =
    raw.schema !== CHECKPOINT_SCHEMA
      ? `schema ${String(raw.schema)}, expected ${CHECKPOINT_SCHEMA}`
      : raw.fingerprint !== ctx.fingerprint
        ? `fingerprint ${String(raw.fingerprint)}, expected ${ctx.fingerprint}`
        : null;
  if (why === null) return;
  if (ctx.acceptStale) {
    ctx.log(`  ${where}: ${why} — accepted anyway (EXP10_ACCEPT_STALE=1)`);
    if (!ctx.staleAccepted.includes(where)) ctx.staleAccepted.push(where);
    return;
  }
  throw new StaleCheckpoint(
    `${ctx.store.where}/${where}: ${why}.\n\n` +
      `  These are measurements from a different build or a different design, and resuming\n` +
      `  would publish them under this one's provenance. Delete the checkpoint directory to\n` +
      `  re-measure, or set EXP10_ACCEPT_STALE=1 to use them knowing what they are.`,
  );
}

export function readStage<T>(ctx: RunContext, stage: StageName): StageFile<T> {
  const text = ctx.store.read(`${stage}.json`);
  const fresh: StageFile<T> = {
    schema: CHECKPOINT_SCHEMA,
    fingerprint: ctx.fingerprint,
    stage,
    units: {},
    complete: false,
  };
  if (text === null) return fresh;
  const raw = JSON.parse(text) as Partial<StageFile<T>>;
  checkRecord(ctx, `${stage}.json`, raw);
  if (raw.stage !== stage)
    throw new StaleCheckpoint(`${stage}.json holds stage ${String(raw.stage)}`);
  // Accepted stale (the override), a checkpoint keeps the stamp it was read
  // with, and so does every write of it. Re-stamped with this build's, as it
  // first was, a stage resumed once under EXP10_ACCEPT_STALE came back as this
  // build's own on the next run without it, and that run's document said no
  // stale checkpoint was used.
  const stale = raw.schema !== CHECKPOINT_SCHEMA || raw.fingerprint !== ctx.fingerprint;
  const stamp = stale ? { schema: String(raw.schema), fingerprint: String(raw.fingerprint) } : {};
  return { ...fresh, ...stamp, units: raw.units ?? {}, complete: raw.complete === true };
}

function writeStage<T>(ctx: RunContext, file: StageFile<T>): void {
  ctx.store.write(`${file.stage}.json`, `${JSON.stringify(file)}\n`);
}

/**
 * Run a stage unit by unit, checkpointing after each: an interrupted stage costs
 * the unit it was in the middle of and nothing else. Units already on disk are
 * not recomputed; `finish` runs once every unit is present and may add
 * stage-wide results under `units['*']`.
 */
function runUnits<T>(
  ctx: RunContext,
  stage: StageName,
  units: readonly string[],
  compute: (unit: string, file: StageFile<T>) => T,
  finish?: (file: StageFile<T>) => T | null,
): StageFile<T> {
  const file = readStage<T>(ctx, stage);
  if (file.complete) {
    ctx.log(`  ${stage}: complete on disk`);
    return file;
  }
  for (const unit of units) {
    if (unit in file.units) continue;
    const t0 = Date.now();
    file.units[unit] = compute(unit, file);
    writeStage(ctx, file);
    ctx.log(`  ${stage} ${unit}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  if (finish !== undefined) {
    const extra = finish(file);
    if (extra !== null) file.units['*'] = extra;
  }
  file.complete = true;
  writeStage(ctx, file);
  return file;
}

/** A stage another depends on, which must already be complete on disk. */
function needStage<T>(ctx: RunContext, stage: StageName): StageFile<T> {
  const file = readStage<T>(ctx, stage);
  if (!file.complete) {
    throw new Error(`experiment10: stage ${stage} is not complete; run \`--stage ${stage}\` first`);
  }
  return file;
}

// ---------------------------------------------------------------------------
// Rigs, twins and the page's read path, shared by every stage
// ---------------------------------------------------------------------------

export type Which = 'main' | 'spill' | 'fine';

export function variantOf(plan: Exp10Plan, which: Which): RigVariant {
  return which === 'main' ? plan.variant : which === 'spill' ? 'spill' : plan.fineVariant;
}

function unitKey(which: Which, k: number, camera?: number): string {
  return camera === undefined ? `${which}:${k}` : `${which}:${k}:${camera}`;
}

export function parseUnit(unit: string): { which: Which; k: number; camera: number | null } {
  const [which, k, camera] = unit.split(':');
  if (which !== 'main' && which !== 'spill' && which !== 'fine')
    throw new Error(`experiment10: unit ${unit}`);
  return { which, k: Number(k), camera: camera === undefined ? null : Number(camera) };
}

/**
 * The units a stage visits for each kind of rig: fine rigs a camera at a time, because a 640x480
 * rig is about 500 MB of frames.
 */
function rigUnits(plan: Exp10Plan, kinds: readonly Which[]): string[] {
  const out: string[] = [];
  for (const which of kinds) {
    if (which === 'main') for (const k of plan.rigs) out.push(unitKey('main', k));
    if (which === 'spill') for (const k of plan.spillRigs) out.push(unitKey('spill', k));
    if (which === 'fine')
      for (const k of plan.fineRigs)
        for (let c = 0; c < DESIGN.CAMERAS; c++) out.push(unitKey('fine', k, c));
  }
  return out;
}

function bankOf(ctx: RunContext, unit: string): RigBank {
  if (ctx.held !== null && ctx.held.unit === unit) return ctx.held.bank;
  // Released before the next is built, so two rigs are never held at once.
  ctx.held = null;
  const { which, k, camera } = parseUnit(unit);
  const bank = buildRig(k, variantOf(ctx.plan, which), camera === null ? undefined : [camera]);
  ctx.held = { unit, bank };
  return bank;
}

/** The options `runScenario` photographs a scenario with, less the solve: `buildRig`'s own. */
function runOptionsFor(bank: RigBank): RunOptions {
  return {
    preset: bank.preset,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
    plan: PLAN,
  };
}

/** The file name the page would show an operator for photograph `j` of a position. */
function photoName(j: number): string {
  return `IMG_${String(j + 1).padStart(4, '0')}.png`;
}

/** 34 fingerprints of one run's frames, carrying their folder ordinals. */
function runPrints(images: readonly LinearImage[], projector: number): FrameFingerprint[] {
  return images.map((img, f) =>
    fingerprint(img, projector * FRAMES_PER_RUN + f, FINGERPRINT_BLOCKS),
  );
}

/**
 * One run through the page's own read path: each frame encoded to 8-bit sRGB
 * as a camera file would carry it, then `readRun` — the page's ingest, its
 * assembler with the manifest's roles, and `decodeCapture` with its defaults.
 */
function pageRead(
  camera: number,
  projector: number,
  images: readonly LinearImage[],
): ReturnType<typeof readRun> {
  const encoded = images.map((img) => encodeSrgb8(img, ENCODE_FULL_SCALE));
  return readRun(
    {
      camera,
      projector,
      images: encoded,
      names: encoded.map((_, f) => photoName(projector * FRAMES_PER_RUN + f)),
    },
    ROLES,
    MANIFEST,
    TRANSFER,
  );
}

/**
 * The fast path: a run's frames, as the bookends would decode them, through the rig's own sensor
 * and noise stream.
 */
function fastRun(
  bank: RigBank,
  c: number,
  p: number,
  photos: readonly Photo[],
  assignment: readonly (number | null)[] | null = null,
): LinearImage[] {
  return noisyRun(bank, c, p, runFrames(bank, c, p, photos, assignment), DEFAULT_SENSOR, bank.seed);
}

/** The same with the sensor off: the renderer's noiseless frames, Float32 as it stores them. */
function cleanRun(
  bank: RigBank,
  c: number,
  p: number,
  photos: readonly Photo[],
  assignment: readonly (number | null)[] | null = null,
): LinearImage[] {
  return noisyRun(bank, c, p, runFrames(bank, c, p, photos, assignment), null, bank.seed);
}

/** What the clean position through the rig's own noise says about one run. See BANK. */
export interface TwinRun {
  projector: number;
  /**
   * Pixels whose white clears its black by the decoder's own floor, as a share of the photograph.
   */
  litShare: number;
  /** Placed by the isolated check (content footing) on the noisy twin: ATTRIBUTABLE. */
  placed: boolean;
  placedNoiseless: boolean;
  worstNoisy: number | null;
  worstNoiseless: number | null;
  /** b: how far noise alone lifts the run's worst pair, `worstNoisy - worstNoiseless`. */
  noiseFloor: number | null;
  /** Clean page-path correspondences: `readRun`'s own `stats.accepted`. */
  accepted: number;
  sigmaU: number | null;
  sigmaV: number | null;
  marginal: boolean;
  minor: boolean;
}

export interface TwinCamera {
  camera: number;
  placedContent: number[];
  placedFiled: number[];
  placedNoiseless: number[];
  problems: string[];
  runs: TwinRun[];
  /**
   * What the page's worth report would say of this position read alone, as the page reads it (F9).
   */
  worthUsable: boolean;
  worthRefusal: string | null;
}

export function twinStatus(t: TwinCamera): TwinStatus[] {
  return t.runs.map((r) => ({
    projector: r.projector,
    placed: r.placed,
    worstResidual: r.worstNoisy,
    correspondences: r.accepted,
  }));
}

/**
 * One camera's twin: the clean position through the fast path, fingerprinted,
 * checked on both footings, and read by the page run by run.
 *
 * The noisy fingerprints are handed back too, because the re-scoring needs them
 * for every run a straddle did not touch: those frames are the twin's, draw for
 * draw, so recomputing them per position would be the same numbers again.
 */
export function computeTwin(
  bank: RigBank,
  c: number,
): { twin: TwinCamera; prints: FrameFingerprint[] } {
  const prints: FrameFingerprint[] = [];
  const reads: ReturnType<typeof readRun>[] = [];
  for (let p = 0; p < PROJECTORS; p++) {
    const images = fastRun(bank, c, p, CLEAN);
    prints.push(...runPrints(images, p));
    reads.push(pageRead(c, p, images));
  }
  const clean = positionFingerprints(bank, c, CLEAN);
  const content = isolatedCheck(prints, CLEAN, 'content');
  const filed = isolatedCheck(prints, CLEAN, 'filed');
  const noiseless = isolatedCheck(clean, CLEAN, 'content');
  const runs: TwinRun[] = [];
  for (let p = 0; p < PROJECTORS; p++) {
    const slice = (fps: FrameFingerprint[]) =>
      fps.slice(p * FRAMES_PER_RUN, (p + 1) * FRAMES_PER_RUN);
    const worstNoisy = worstOf(pairResiduals(slice(prints)));
    const worstNoiseless = worstOf(pairResiduals(slice(clean)));
    const stats = reads[p].outcome.stats;
    const accepted = stats === null ? 0 : stats.accepted;
    const placed = content.usableProjectors.includes(p);
    const status: TwinStatus = {
      projector: p,
      placed,
      worstResidual: worstNoisy,
      correspondences: accepted,
    };
    runs.push({
      projector: p,
      litShare: bank.lit[c][p] / (bank.width * bank.height),
      placed,
      placedNoiseless: noiseless.usableProjectors.includes(p),
      worstNoisy,
      worstNoiseless,
      noiseFloor:
        worstNoisy === null || worstNoiseless === null ? null : worstNoisy - worstNoiseless,
      accepted,
      sigmaU: round(median(reads[p].correspondences.map((x) => x.sigmaU)), 6),
      sigmaV: round(median(reads[p].correspondences.map((x) => x.sigmaV)), 6),
      marginal:
        status.placed && status.worstResidual !== null && status.worstResidual > MARGINAL_RESIDUAL,
      minor: accepted < MINOR_RUN_CORR,
    });
  }
  // The page reads one folder as one camera, so its worth report sees one camera.
  const worth = finishCapture(
    reads.map((r) => r.outcome),
    reads.flatMap((r) => (r.pair === null ? [] : [r.pair])),
    PROJECTORS,
  );
  return {
    twin: {
      camera: c,
      placedContent: content.usableProjectors,
      placedFiled: filed.usableProjectors,
      placedNoiseless: noiseless.usableProjectors,
      problems: content.problems,
      runs,
      worthUsable: worth.ok ? worth.worth.usable : false,
      worthRefusal: worth.ok ? worth.worth.refusal : worth.refusal,
    },
    prints,
  };
}

/**
 * Everything one rig contributes to a stage, built once while the rig is held:
 * the bank, its twins from the BANK checkpoint, and the twins' noisy
 * fingerprints and page decodes as the stage asks for them.
 */
export interface RigContext {
  unit: string;
  bank: RigBank;
  twins: Map<number, TwinCamera>;
  prints: Map<number, FrameFingerprint[]>;
  decodes: Map<string, Correspondence[]>;
  prepared: PreparedRig | null;
}

function rigContext(ctx: RunContext, unit: string, bankFile: StageFile<BankUnit>): RigContext {
  const bank = bankOf(ctx, unit);
  const stored = bankFile.units[unit];
  if (stored === undefined) throw new Error(`experiment10: the bank stage has no ${unit}`);
  const twins = new Map<number, TwinCamera>();
  for (const t of stored.twins) twins.set(t.camera, t);
  return { unit, bank, twins, prints: new Map(), decodes: new Map(), prepared: null };
}

function twinOf(rc: RigContext, c: number): TwinCamera {
  const t = rc.twins.get(c);
  if (t === undefined) throw new Error(`experiment10: ${rc.unit} has no twin for camera ${c}`);
  return t;
}

/**
 * The twin's noisy fingerprints, folder order, recomputed on the rig's own stream and checked
 * against the stored verdict.
 */
function twinPrints(rc: RigContext, c: number): FrameFingerprint[] {
  let got = rc.prints.get(c);
  if (got === undefined) {
    got = [];
    for (let p = 0; p < PROJECTORS; p++) got.push(...runPrints(fastRun(rc.bank, c, p, CLEAN), p));
    // The BANK stage computed this same verdict from these same draws; if it
    // no longer agrees, the stream has moved and every attribution would be
    // against a twin that is not the one on record.
    const again = isolatedCheck(got, CLEAN, 'content').usableProjectors;
    if (JSON.stringify(again) !== JSON.stringify(twinOf(rc, c).placedContent)) {
      const stored = twinOf(rc, c).placedContent;
      throw new Error(`experiment10: ${rc.unit} camera ${c}'s twin no longer places ${stored}`);
    }
    rc.prints.set(c, got);
  }
  return got;
}

/** The twin's page-path decode of one run. */
function twinDecode(rc: RigContext, c: number, p: number): Correspondence[] {
  const key = `${c}:${p}`;
  let got = rc.decodes.get(key);
  if (got === undefined) {
    got = pageRead(c, p, fastRun(rc.bank, c, p, CLEAN)).correspondences;
    rc.decodes.set(key, got);
  }
  return got;
}

/**
 * Runs the crossing scan takes: every one, unless the plan thins it, then attributable ones
 * brightest first.
 */
function crossingRuns(plan: Exp10Plan, twin: TwinCamera): number[] {
  const all = twin.runs.map((r) => r.projector);
  if (plan.crossingsPerCamera === null) return all;
  return twin.runs
    .slice()
    .sort(
      (a, b) =>
        Number(b.placed) - Number(a.placed) || b.litShare - a.litShare || a.projector - b.projector,
    )
    .slice(0, plan.crossingsPerCamera)
    .map((r) => r.projector)
    .sort((a, b) => a - b);
}

/** Runs a mechanism arm takes: attributable ones, brightest first, at most `runsPerCamera`. */
function armRuns(plan: Exp10Plan, twin: TwinCamera, needDecode = false): number[] {
  const runs = twin.runs
    .filter((r) => r.placed && (!needDecode || !r.minor))
    .sort((a, b) => b.litShare - a.litShare || a.projector - b.projector)
    .map((r) => r.projector);
  return plan.runsPerCamera === null
    ? runs.sort((a, b) => a - b)
    : runs.slice(0, plan.runsPerCamera).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Comparing two decodes of one run
// ---------------------------------------------------------------------------

const pixelOf = (x: Correspondence): number => x.camV * 100000 + x.camU;

/** Per-axis signed shift and its spread, over the pixels both decodes accepted. */
export interface Shift {
  matched: number;
  meanU: number | null;
  meanV: number | null;
  medianAbsU: number | null;
  medianAbsV: number | null;
  p95AbsU: number | null;
  p95AbsV: number | null;
  /**
   * Matched pixels moved by more than a quarter period on either axis: a wrong fringe, not a bias.
   */
  gross: number;
  /** Matched pixels whose six solver-facing fields are not all identical. */
  changed: number;
  /** Matched pixels whose projector coordinate moved at all. */
  moved: number;
  /**
   * Matched pixels whose decode moved half a period or more on either axis. A
   * DISPLACEMENT bound, not a count of Gray flips. A correct Gray word with a
   * phase error can move a decode by up to 0.65 of a period: the unwrap keeps
   * it within 0.4 of a period of its Gray bin's centre (`decode.ts`,
   * `unwrapToleranceFrac`), and the bin is half a period wide. So this can
   * count a decode whose Gray word never changed. The first full run found
   * exactly that at forward s = 0.45: a phase error of 0.50004 of a v period at
   * a seam, both Gray words unchanged. This field was then named `wrongFringe`
   * and read as flips. The flips themselves are counted from the Gray words
   * ({@link GrayFlips}).
   */
  movedHalfPeriod: number;
}

export function shiftBetween(
  before: readonly Correspondence[],
  after: readonly Correspondence[],
): Shift {
  const was = new Map(before.map((x) => [pixelOf(x), x]));
  const du: number[] = [];
  const dv: number[] = [];
  let gross = 0;
  let changed = 0;
  let moved = 0;
  let movedHalfPeriod = 0;
  for (const y of after) {
    const x = was.get(pixelOf(y));
    if (x === undefined) continue;
    const u = y.projU - x.projU;
    const v = y.projV - x.projV;
    du.push(u);
    dv.push(v);
    if (Math.abs(u) > GROSS_PX.u || Math.abs(v) > GROSS_PX.v) gross++;
    if (u !== 0 || v !== 0 || y.sigmaU !== x.sigmaU || y.sigmaV !== x.sigmaV) changed++;
    if (u !== 0 || v !== 0) moved++;
    if (Math.abs(u) >= PERIOD_PX.u / 2 || Math.abs(v) >= PERIOD_PX.v / 2) movedHalfPeriod++;
  }
  const absU = ascending(du.map(Math.abs));
  const absV = ascending(dv.map(Math.abs));
  return {
    matched: du.length,
    meanU: du.length === 0 ? null : mean(du),
    meanV: dv.length === 0 ? null : mean(dv),
    medianAbsU: absU.length === 0 ? null : quantile(absU, 0.5),
    medianAbsV: absV.length === 0 ? null : quantile(absV, 0.5),
    p95AbsU: absU.length === 0 ? null : quantile(absU, 0.95),
    p95AbsV: absV.length === 0 ? null : quantile(absV, 0.95),
    gross,
    changed,
    moved,
    movedHalfPeriod,
  };
}

/**
 * H7's flip clause, measured: Gray-word changes per axis on the pixels both
 * decodes accept. A pixel's Gray word is read by {@link decodeGrayOnly}, the
 * decoder's own Gray address, so this counts flips and nothing else; a phase
 * error that moves a decode however far, with the Gray word right, is not one.
 */
export interface GrayFlips {
  /** Pixels both full decodes accepted. */
  matched: number;
  u: number;
  v: number;
  /** Pixels whose Gray word changed on either axis. */
  either: number;
}

/**
 * The per-pixel signs of the decoded shift on one set of matched pixels. A
 * mean can be one-signed while its pixels are not, and the first full run's
 * verdict said "one-signed" of a bias whose v shift was positive on 3% of its
 * pixels; a pixel that is neither positive nor negative did not move.
 */
export interface SignTally {
  pixels: number;
  uPos: number;
  uNeg: number;
  vPos: number;
  vNeg: number;
  maxAbsU: number;
  maxAbsV: number;
}

function emptySigns(): SignTally {
  return { pixels: 0, uPos: 0, uNeg: 0, vPos: 0, vNeg: 0, maxAbsU: 0, maxAbsV: 0 };
}

/**
 * Over the pixels both full decodes accepted: which changed their Gray word, and
 * the signs of their shift, split into the SEAM (pixels `seam` marks: the
 * projector whose light the blend brings into the run also lights them) and
 * the rest. Every matched pixel must have a Gray address on both sides, because
 * a full decode accepts only pixels whose Gray words it could read; one that
 * does not throws, since the two decodes would then disagree about a bit.
 */
export function pixelTallies(
  before: readonly Correspondence[],
  after: readonly Correspondence[],
  grayBefore: readonly Correspondence[],
  grayAfter: readonly Correspondence[],
  seam: Uint8Array,
  width: number,
): { grayFlips: GrayFlips; signs: { seam: SignTally; rest: SignTally } } {
  const was = new Map(before.map((x) => [pixelOf(x), x]));
  const grayWas = new Map(grayBefore.map((x) => [pixelOf(x), x]));
  const grayNow = new Map(grayAfter.map((x) => [pixelOf(x), x]));
  const flips: GrayFlips = { matched: 0, u: 0, v: 0, either: 0 };
  const signs = { seam: emptySigns(), rest: emptySigns() };
  for (const y of after) {
    const key = pixelOf(y);
    const x = was.get(key);
    if (x === undefined) continue;
    const gx = grayWas.get(key);
    const gy = grayNow.get(key);
    if (gx === undefined || gy === undefined) {
      throw new Error(
        `experiment10: camera pixel (${y.camU}, ${y.camV}) decodes whole but has no Gray address`,
      );
    }
    flips.matched++;
    const fu = gx.projU !== gy.projU;
    const fv = gx.projV !== gy.projV;
    if (fu) flips.u++;
    if (fv) flips.v++;
    if (fu || fv) flips.either++;
    const du = y.projU - x.projU;
    const dv = y.projV - x.projV;
    const t = seam[(y.camV - 0.5) * width + (y.camU - 0.5)] === 1 ? signs.seam : signs.rest;
    t.pixels++;
    if (du > 0) t.uPos++;
    else if (du < 0) t.uNeg++;
    if (dv > 0) t.vPos++;
    else if (dv < 0) t.vNeg++;
    t.maxAbsU = Math.max(t.maxAbsU, Math.abs(du));
    t.maxAbsV = Math.max(t.maxAbsV, Math.abs(dv));
  }
  for (const t of [signs.seam, signs.rest]) {
    t.maxAbsU = round(t.maxAbsU, 5) as number;
    t.maxAbsV = round(t.maxAbsV, 5) as number;
  }
  return { grayFlips: flips, signs };
}

function statsDelta(before: DecodeStats, after: DecodeStats): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(before) as (keyof DecodeStats)[])
    out[key] = after[key] - before[key];
  return out;
}

/**
 * Where each decoded coordinate lands on the sphere: the decoded projector
 * pixel cast back through the TRUE projector (`pixelToRay`) from its lens and
 * met with the sphere. Beside the bank's own ray-sphere hit at the camera
 * pixel's centre, that is the decode's error in millimetres on the sphere;
 * beside another decode of the same pixel, what the straddle moved.
 */
function decodedOnSphere(
  rc: RigContext,
  p: number,
  xs: readonly Correspondence[],
): Map<number, [number, number, number]> {
  rc.prepared ??= prepareRig(rc.bank.world.truthRig);
  const proj = rc.prepared.projectors[p];
  const radius = rc.bank.world.truthRig.sphere.radiusM;
  // Keyed by the camera pixel's index, so the bank's own hit at that pixel can be looked up.
  const out = new Map<number, [number, number, number]>();
  for (const x of xs) {
    const hit = raySphereIntersect(proj.lens, pixelToRay(proj, x.projU, x.projV), radius);
    if (hit !== null)
      out.set((x.camV - 0.5) * rc.bank.width + (x.camU - 0.5), [
        hit.point.x,
        hit.point.y,
        hit.point.z,
      ]);
  }
  return out;
}

interface SphereMm {
  /** |P_dec - P_true| of the treated decode, mm. */
  errorMedian: number | null;
  errorP95: number | null;
  /** |P_dec(treated) - P_dec(clean)| over matched pixels, mm. */
  shiftMean: number | null;
  shiftMedian: number | null;
  shiftP95: number | null;
}

function sphereMm(
  rc: RigContext,
  c: number,
  clean: Map<number, [number, number, number]>,
  treated: Map<number, [number, number, number]>,
): SphereMm {
  const hits = rc.bank.hits[c];
  const error: number[] = [];
  const shift: number[] = [];
  for (const [i, at] of treated) {
    if (!Number.isNaN(hits[3 * i])) {
      error.push(
        1000 * Math.hypot(at[0] - hits[3 * i], at[1] - hits[3 * i + 1], at[2] - hits[3 * i + 2]),
      );
    }
    const was = clean.get(i);
    if (was !== undefined)
      shift.push(1000 * Math.hypot(at[0] - was[0], at[1] - was[1], at[2] - was[2]));
  }
  const e = ascending(error);
  const d = ascending(shift);
  return {
    errorMedian: round(quantile(e, 0.5), 4),
    errorP95: round(quantile(e, 0.95), 4),
    shiftMean: round(mean(d), 4),
    shiftMedian: round(quantile(d, 0.5), 4),
    shiftP95: round(quantile(d, 0.95), 4),
  };
}

/** Decoded coordinates against the bank's geometric truth, per axis, projector pixels. */
function truthError(
  rc: RigContext,
  c: number,
  p: number,
  xs: readonly Correspondence[],
): { meanU: number; meanV: number; medianAbs: number; p95Abs: number } {
  const t = rc.bank.truth[c][p];
  const du: number[] = [];
  const dv: number[] = [];
  const abs: number[] = [];
  for (const x of xs) {
    const i = (x.camV - 0.5) * rc.bank.width + (x.camU - 0.5);
    const u = x.projU - t.projU[i];
    const v = x.projV - t.projV[i];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    du.push(u);
    dv.push(v);
    abs.push(Math.hypot(u, v));
  }
  const sorted = ascending(abs);
  return {
    meanU: mean(du),
    meanV: mean(dv),
    medianAbs: quantile(sorted, 0.5),
    p95Abs: quantile(sorted, 0.95),
  };
}

/** The share of a cyclic phase rotation `atan2(s, 1 - s)` a mean shift is, per axis. */
function biasRatio(shift: Shift, s: number): { u: number | null; v: number | null } {
  const cyclic = Math.atan2(s, 1 - s) / (2 * Math.PI);
  return {
    u: shift.meanU === null || s === 0 ? null : shift.meanU / (PERIOD_PX.u * cyclic),
    v: shift.meanV === null || s === 0 ? null : shift.meanV / (PERIOD_PX.v * cyclic),
  };
}

function roundShift(s: Shift): Record<string, number | null> {
  return {
    matched: s.matched,
    meanU: round(s.meanU, 5),
    meanV: round(s.meanV, 5),
    medianAbsU: round(s.medianAbsU, 5),
    medianAbsV: round(s.medianAbsV, 5),
    p95AbsU: round(s.p95AbsU, 5),
    p95AbsV: round(s.p95AbsV, 5),
    gross: s.gross,
    changed: s.changed,
    moved: s.moved,
    movedHalfPeriod: s.movedHalfPeriod,
  };
}

// ---------------------------------------------------------------------------
// q0 — today's page, as shipped; Q0b — the card's own folder shapes
// ---------------------------------------------------------------------------

/**
 * What made the page refuse, by the words `indexing.ts` and `readback.ts` write.
 *
 * The first eight are the bookends' and the complement check's, which the page
 * used when this experiment measured it and Q0b still calls. The rest are the
 * reader the page uses now, `indexPosition`: a projector's photographs lit with
 * no run found in them, a folder too short to be a position or dark
 * throughout, one with no run anywhere, runs whose projector numbers cannot be
 * told, a re-shoot that matches no projector, and a plan the reader cannot
 * read by. Its notes — unseen and barely seen projectors, photographs before
 * Play and after the black, replaced runs — are never problems and never
 * reach here.
 */
type ReasonClass =
  | 'margin'
  | 'count'
  | 'length'
  | 'kind'
  | 'broken'
  | 'unanswered'
  | 'leading'
  | 'clipping'
  | 'unfound'
  | 'short'
  | 'dark'
  | 'norun'
  | 'numbering'
  | 'reshoot'
  | 'plan';

export function reasonOf(problem: string): ReasonClass {
  if (/^The white and black frames cannot be reliably told/.test(problem)) return 'margin';
  if (/^Found \d+ projector runs and the capture should hold/.test(problem)) return 'count';
  if (/run holds \d+ photographs and should hold/.test(problem)) return 'length';
  if (/is the right length but frame \d+ looks like/.test(problem)) return 'kind';
  if (/were played as a pattern and its complement/.test(problem)) return 'broken';
  if (/could not be checked/.test(problem)) return 'unanswered';
  if (/sit before the first white frame/.test(problem)) return 'leading';
  if (/at the sensor's ceiling/.test(problem)) return 'clipping';
  if (/^Projector \d+'s photographs are lit, but no run of \d+ could be found/.test(problem)) return 'unfound';
  if (/^The folder holds \d+ photographs, and a whole camera position is/.test(problem)) return 'short';
  if (/^Every one of the \d+ photographs is dark/.test(problem)) return 'dark';
  if (/^No projector run could be found in the \d+ photographs/.test(problem)) return 'norun';
  if (
    /^The (run|\d+ runs) found (could be|does not fit|do not fit)/.test(problem) ||
    /lie between two runs, and -?\d+ photographs is not within \d+ of a whole number of runs/.test(problem) ||
    /^The run at photographs? [\d–]+ could be .* the photographs around it fit either reading/.test(problem) ||
    /^The run at photographs? [\d–]+ .*, and no reading of the folder fits the two/.test(problem) ||
    /^No run of this camera position could be read/.test(problem)
  ) {
    return 'numbering';
  }
  if (/^The run at photographs? [\d–]+, after the end of this camera position, /.test(problem)) return 'reshoot';
  if (
    /^The folder holds no photographs/.test(problem) ||
    /^Fingerprint \d+ says it is photograph \d+, and it is number \d+ in the list/.test(problem) ||
    /does not say which frames of a run are phase steps/.test(problem) ||
    /^This capture plan lists phase steps/.test(problem) ||
    /projectors, and a camera position needs at least one/.test(problem)
  ) {
    return 'plan';
  }
  // Thrown, not tallied as "other": a reworded refusal would otherwise fall
  // out of every count this stage reports.
  throw new Error(
    `experiment10: the page said something this experiment does not recognise: ${problem}`,
  );
}

export interface Q0Position {
  which: Which;
  rig: number;
  camera: number;
  total: number;
  placed: number;
  runsPlaced: number[];
  ok: boolean;
  problems: string[];
  reasons: ReasonClass[];
  /** `classify(litFractions(stats)).margin` over the whole position, as the page computes it. */
  margin: number;
  /** Frames the capture-wide classification calls the wrong kind. */
  wrongKinds: number;
  /** The diagnostic: each run classified ALONE, as per-run normalisation would. */
  perRun: { projector: number; margin: number; wrongKinds: number }[];
  description: string;
  clippedWorst: number;
}

export interface Q0bShape {
  rig: number;
  camera: number;
  shape: string;
  photographs: number;
  placed: number[];
  problems: string[];
}

export interface Q0Unit {
  positions: Q0Position[];
  shapes: Q0bShape[];
  /** F9, on the first rig's camera 0 only: the worth report the page would print. */
  worth: {
    usable: boolean;
    contributingCameras: number[];
    refusal: string | null;
    summary: string | null;
  } | null;
}

function q0Position(
  which: Which,
  k: number,
  c: number,
  summaries: readonly PhotoSummary[],
): Q0Position {
  const indexed = indexPhotographs(summaries, MANIFEST);
  const stats = summaries.map((s) => s.stats);
  const whole = classify(litFractions(stats));
  const perRun = [];
  for (let p = 0; p < PROJECTORS; p++) {
    const alone = classify(litFractions(stats.slice(p * FRAMES_PER_RUN, (p + 1) * FRAMES_PER_RUN)));
    perRun.push({
      projector: p,
      margin: alone.margin,
      wrongKinds: alone.kinds.filter((kind, f) => kind !== EXPECTED.kinds[f]).length,
    });
  }
  return {
    which,
    rig: k,
    camera: c,
    total: indexed.total,
    placed: indexed.placed,
    runsPlaced: indexed.runs.map((r) => r.projector),
    ok: indexed.ok,
    problems: indexed.problems,
    reasons: indexed.problems.map(reasonOf),
    margin: whole.margin,
    wrongKinds: whole.kinds.filter((kind, j) => kind !== EXPECTED.kinds[j % FRAMES_PER_RUN]).length,
    perRun,
    description: describeIndexing(indexed, PROJECTORS),
    clippedWorst: Math.max(...summaries.map((s) => s.clippedHigh)),
  };
}

/**
 * The folder shapes the card's own procedure produces (F7, F8), on clean
 * noiseless fingerprints and content observations: extra step-0 photographs
 * before the first (the intervalometer started before Play), extra dark ones
 * after the last, a re-shot run appended, and a re-shot run alone.
 */
function q0bShapes(bank: RigBank, k: number, c: number): Q0bShape[] {
  const lead = CLEAN[0];
  const dark: Photo = {
    filedStep: STEPS.length - 1,
    rows: [pageParts([{ step: STEPS.length, weight: 1 }], STEPS)],
  };
  const shapes: { name: string; photos: Photo[]; projector: number[] }[] = [];
  const folderProjector = (photos: readonly Photo[]): number[] =>
    photos.map((ph) => (ph === dark ? PROJECTORS - 1 : STEPS[ph.filedStep].projector));
  for (const leading of [0, 1, 3]) {
    for (const trailing of [0, 1, 2]) {
      const photos = [
        ...Array<Photo>(leading).fill(lead),
        ...CLEAN,
        ...Array<Photo>(trailing).fill(dark),
      ];
      shapes.push({
        name: `leading ${leading}, trailing ${trailing}`,
        photos,
        projector: folderProjector(photos),
      });
    }
  }
  for (let p = 0; p < PROJECTORS; p++) {
    const run = CLEAN.slice(p * FRAMES_PER_RUN, (p + 1) * FRAMES_PER_RUN);
    const appended = [...CLEAN, ...run];
    shapes.push({
      name: `projector ${p + 1} re-shot and appended`,
      photos: appended,
      projector: folderProjector(appended),
    });
    shapes.push({
      name: `projector ${p + 1} re-shot alone`,
      photos: run,
      projector: folderProjector(run),
    });
  }
  return shapes.map(({ name, photos, projector }) => {
    const prints = photos.map((photo, j) => photoFingerprint(bank, c, projector[j], photo, j));
    const result = indexByFingerprint(oracleObservations(photos, 'content'), prints, EXPECTED);
    return {
      rig: k,
      camera: c,
      shape: name,
      photographs: photos.length,
      placed: result.usableProjectors,
      problems: result.problems,
    };
  });
}

/**
 * The options Q0 photographs `cameras` of a rig with: the rig's own capture,
 * DEFAULT_SENSOR, and each camera's noise keyed by its index in the rig. A fine
 * unit photographs one camera, which rendered alone sits at position 0; keyed
 * by position it would draw camera 0's noise, while its twin is noised as the
 * camera it is (`noisyRun`), and the two would be different photographs.
 */
export function q0CaptureOptions(
  bank: RigBank,
  cameras: readonly number[],
  onCapture: CaptureOptions['onCapture'],
): CaptureOptions {
  const base = captureOptionsFor(bank.world, bank.scenario, runOptionsFor(bank), PLAN);
  if (JSON.stringify(base.conditions.sensor) !== JSON.stringify(DEFAULT_SENSOR)) {
    throw new Error(`experiment10: rig ${bank.k} (${bank.variant}) does not photograph with DEFAULT_SENSOR`);
  }
  return { ...base, noiseCameraIndices: [...cameras], onCapture };
}

export function stageQ0(ctx: RunContext): StageFile<Q0Unit> {
  const { plan } = ctx;
  return runUnits<Q0Unit>(ctx, 'q0', rigUnits(plan, ['main', 'spill', 'fine']), (unit) => {
    const { which, k, camera } = parseUnit(unit);
    const bank = bankOf(ctx, unit);
    const cameras = camera === null ? [...bank.cameras] : [camera];
    const summaries = new Map<number, PhotoSummary[]>(cameras.map((c) => [c, []]));
    const keepFor = which === 'main' && k === plan.rigs[0] ? 0 : -1;
    const kept: LinearImage[][] = [];
    // The renderer's own noisy frames, through the page's own encode and
    // summary, one photograph at a time; nothing of a frame is kept but its
    // summary, as the page keeps nothing else.
    captureAndDecode(
      bank.world.truthRig,
      cameras.map((c) => bank.world.cameras[c]),
      q0CaptureOptions(bank, cameras, (i, p, capture) => {
        const c = cameras[i];
        const frames = planOrder(capture);
        frames.forEach((img, f) => {
          const j = p * FRAMES_PER_RUN + f;
          (summaries.get(c) as PhotoSummary[])[j] = summarisePhoto(
            encodeSrgb8(img, ENCODE_FULL_SCALE),
            j,
            photoName(j),
            TRANSFER,
            FINGERPRINT_BLOCKS,
          );
        });
        if (c === keepFor) kept[p] = frames;
      }),
    );
    const positions = cameras.map((c) =>
      q0Position(which, k, c, summaries.get(c) as PhotoSummary[]),
    );
    let worth: Q0Unit['worth'] = null;
    if (keepFor === 0) {
      const reads = kept.map((frames, p) => pageRead(0, p, frames));
      const verdict = finishCapture(
        reads.map((r) => r.outcome),
        reads.flatMap((r) => (r.pair === null ? [] : [r.pair])),
        PROJECTORS,
      );
      worth = verdict.ok
        ? {
            usable: verdict.worth.usable,
            contributingCameras: verdict.worth.contributingCameras,
            refusal: verdict.worth.refusal,
            summary: verdict.worth.summary,
          }
        : { usable: false, contributingCameras: [], refusal: verdict.refusal, summary: null };
    }
    const shapes =
      which === 'main' && plan.designedRigs.includes(k)
        ? cameras.flatMap((c) => q0bShapes(bank, k, c))
        : [];
    for (const p of positions) {
      const reasons = [...new Set(p.reasons)].join(', ') || 'no problem';
      ctx.log(
        `    ${p.which} rig ${p.rig} camera ${p.camera}: placed ${p.placed}/${p.total}, ` +
          `margin ${p.margin.toFixed(3)} (${reasons})`,
      );
    }
    return { positions, shapes, worth };
  });
}

// ---------------------------------------------------------------------------
// bank — every rig's twins
// ---------------------------------------------------------------------------

export interface BankUnit {
  width: number;
  height: number;
  seed: number;
  twins: TwinCamera[];
}

export function stageBank(ctx: RunContext): StageFile<BankUnit> {
  const { plan } = ctx;
  return runUnits<BankUnit>(ctx, 'bank', rigUnits(plan, ['main', 'spill', 'fine']), (unit) => {
    const bank = bankOf(ctx, unit);
    const twins = bank.cameras.map((c) => computeTwin(bank, c).twin);
    for (const t of twins) {
      const places = t.placedContent.map((p) => p + 1).join(',') || 'nothing';
      const lit = t.runs.map((r) => (100 * r.litShare).toFixed(1)).join('/');
      const worst = t.runs.map((r) => (r.worstNoisy === null ? '-' : r.worstNoisy.toFixed(3)));
      ctx.log(
        `    ${unit} camera ${t.camera}: twin places ${places} ` +
          `(lit ${lit}%, worst ${worst.join('/')})`,
      );
    }
    return { width: bank.width, height: bank.height, seed: bank.seed, twins };
  });
}

// ---------------------------------------------------------------------------
// Solves, one line each in `solves.jsonl`
// ---------------------------------------------------------------------------

/** What a solve was asked to photograph. Its canonical string is the solve's id. */
export interface SolveSpec {
  kind: 'twin' | 'designed' | 'null' | 'position-null' | 'capture';
  rig: number;
  variant: RigVariant;
  /** A description that determines the straddle rendered: `none`, or which positions and why. */
  straddle: string;
  /** Pairs withheld from the solve, as `camera.projector`, sorted. */
  exclude: string[];
  /**
   * The capture seed of a re-shoot, or null for the scenario's own. A `null`
   * solve photographs every camera under it; a `position-null` only
   * {@link SolveSpec.reshotCamera}, and every other camera keeps the
   * scenario's own capture.
   */
  captureSeed: number | null;
  /** A `position-null`'s one re-shot camera. Absent from every other kind. */
  reshotCamera?: number;
}

export interface SolveRecord {
  schema: string;
  fingerprint: string;
  id: string;
  spec: SolveSpec;
  error: string | null;
  alignedRig: RigCalibration | null;
  /** `grid_displacement` against truth, from `runScenario`'s own metrics. */
  gridMm: number | null;
  gridCensored: boolean | null;
  /** `recovery.aligned.maxRotationDeg`. */
  rotationDeg: number | null;
  /** Correspondences the solve was handed, after the exclusions. */
  correspondences: number;
  /** The fast-path verdict against the frames the solve rendered, per straddled run. */
  audit: { runs: number; agree: number; disagreements: string[] } | null;
  /**
   * Against its twin: D_grid, the seams moved between the two aligned rigs, and how far the lenses
   * moved.
   */
  against: {
    twinId: string;
    dGridMm: number;
    p95Mm: number | null;
    rmsMm: number | null;
    censored: boolean;
    positionShiftMm: number;
  } | null;
}

export function solveId(spec: SolveSpec): string {
  const seed = spec.captureSeed === null ? 'own' : String(spec.captureSeed);
  const exclude = spec.exclude.join(',');
  const reshot = spec.reshotCamera === undefined ? '' : `/camera:${spec.reshotCamera}`;
  return (
    `${spec.kind}/${spec.variant}/k${spec.rig}/${spec.straddle}/x[${exclude}]/seed:${seed}` +
    reshot
  );
}

// ---------------------------------------------------------------------------
// gate — the complement check's mechanism
// ---------------------------------------------------------------------------

export interface Crossing {
  s: number | null;
  pair: number | null;
  nonMonotone: boolean;
}

export interface GateRun {
  camera: number;
  projector: number;
  litShare: number;
  /** Placed by the noisy twin: the runs every crossing statistic is taken over. */
  attributable: boolean;
  placedNoiseless: boolean;
  forward: Crossing;
  backward: Crossing;
  /** Each pair's own crossing, whole-position blend, in plan order (`u0` first). */
  pairsForward: (number | null)[];
  pairsBackward: (number | null)[];
  /** Pair u0's crossing from the quarter masses, beside the rendered one. */
  u0: { analytic: number | null; rendered: number | null; masses: number[] } | null;
}

/** One lone straddled frame's residuals, per frame of the run, at one smear. */
export interface SingleRecord {
  camera: number;
  projector: number;
  s: number;
  /** The residual of the pair the straddled frame belongs to; null for W, B and the phase steps. */
  own: (number | null)[];
  worst: (number | null)[];
}

export interface NoisyRecord {
  camera: number;
  direction: 'forward' | 'backward';
  s: number;
  runs: {
    projector: number;
    noisy: boolean;
    noiseless: boolean;
    worstNoisy: number | null;
    worstNoiseless: number | null;
  }[];
}

export interface HookRecord {
  camera: number;
  s: number;
  pixels: number;
  identical: number;
  worstSteps: number;
  verdictsAgree: boolean;
  placedHook: number[];
  placedFast: number[];
  /** Worst per-run mean shift between `readRun` on the hook's frames and on the fast path's, px. */
  biasU: number;
  biasV: number;
}

export interface RollingRecord {
  camera: number;
  projector: number;
  readoutOverExposure: number;
  crossing: Crossing;
}

export interface GainRecord {
  camera: number;
  sigma: number;
  s: number;
  /** Attributable runs times draws. */
  trials: number;
  refused: number;
  /** Runs whose verdict differs from the same position with no jitter. */
  flipped: number;
}

export interface EncodeRecord {
  camera: number;
  projector: number;
  s: number;
  worstLinear: number | null;
  worstEncoded: number | null;
  worstTone: number | null;
  /** Largest |R_encoded - R_linear| over the run's twelve pairs. */
  maxDelta: number | null;
  maxDeltaTone: number | null;
}

export interface EncodeCrossing {
  camera: number;
  projector: number;
  linear: number | null;
  encoded: number | null;
  tone: number | null;
}

export interface ShortRecord {
  camera: number;
  rowFraction: number;
  runs: { projector: number; attributable: boolean; outcome: RunOutcomeKind }[];
}

export interface GateUnit {
  runs: GateRun[];
  single: SingleRecord[];
  /** H1, H2 and H4, checked on every lone straddle this unit computed. */
  identities: {
    h1: { checked: number; failures: string[] };
    h2: { checked: number; failures: string[] };
    h4: { checked: number; failures: string[] };
  };
  noisy: NoisyRecord[];
  hook: HookRecord[];
  rolling: RollingRecord[];
  gain: GainRecord[];
  encode: EncodeRecord[];
  encodeCrossings: EncodeCrossing[];
  short: ShortRecord[];
}

/**
 * A run's pair residuals as a function of a whole-position smear, remembered, because the pair
 * crossings rescan the same grid.
 */
function residualCurve(
  bank: RigBank,
  c: number,
  p: number,
  dir: 'forward' | 'backward',
): (s: number) => (number | null)[] {
  const memo = new Map<number, (number | null)[]>();
  return (s) => {
    let r = memo.get(s);
    if (r === undefined) {
      r = pairResiduals(
        runFingerprints(
          bank,
          c,
          p,
          designedPhotos(dir, () => s, 1),
        ),
      );
      memo.set(s, r);
    }
    return r;
  };
}

/**
 * Where a verdict first refuses, near a crossing already known, bisected to
 * `GATE_SCAN.resolution`. Only for the 8-bit path, where one evaluation encodes
 * and summarises a whole run and `runCrossing`'s full scan would cost minutes a
 * run; the bracket is widened until it holds a placed and a refused smear, so
 * it cannot report a crossing it did not bracket.
 */
function crossingNear(refusedAt: (s: number) => boolean, guess: number): number | null {
  const memo = new Map<number, boolean>();
  const refused = (s: number): boolean => {
    let r = memo.get(s);
    if (r === undefined) {
      r = refusedAt(s);
      memo.set(s, r);
    }
    return r;
  };
  let lo = Math.max(0, guess - 0.01);
  let hi = Math.min(GATE_SCAN.max, guess + 0.01);
  while (lo > 0 && refused(lo)) lo = Math.max(0, lo - 0.02);
  if (refused(lo)) return 0;
  while (hi < GATE_SCAN.max && !refused(hi)) hi = Math.min(GATE_SCAN.max, hi + 0.02);
  if (!refused(hi)) return null;
  while (hi - lo > GATE_SCAN.resolution) {
    const mid = (lo + hi) / 2;
    if (refused(mid)) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

const PAIR_OF_FRAME: readonly number[] = SPECS.map((_, f) =>
  EXPECTED.complements.pairs.findIndex(([a, b]) => a === f || b === f),
);

/** Pair u0's crossing from the quarter masses, or null for a run with no modulation to spread. */
function u0Of(bank: RigBank, c: number, p: number, rendered: number | null): GateRun['u0'] {
  const masses = quarterMasses(bank.fingerprints[c][p]);
  const total = masses.reduce((a, x) => a + x, 0);
  return { analytic: total > 0 ? u0Crossing(masses) : null, rendered, masses };
}

function gateCrossings(
  bank: RigBank,
  c: number,
  p: number,
  twin: TwinCamera,
  withPairs: boolean,
): GateRun {
  const run = twin.runs[p];
  const fwd = residualCurve(bank, c, p, 'forward');
  const bwd = residualCurve(bank, c, p, 'backward');
  const forward = runCrossing(fwd);
  const backward = runCrossing(bwd);
  const pairs = (curve: (s: number) => (number | null)[]): (number | null)[] =>
    withPairs ? EXPECTED.complements.pairs.map((_, m) => runCrossing((s) => [curve(s)[m]]).s) : [];
  const pairsForward = pairs(fwd);
  return {
    camera: c,
    projector: p,
    litShare: run.litShare,
    attributable: run.placed,
    placedNoiseless: run.placedNoiseless,
    forward,
    backward,
    pairsForward,
    pairsBackward: pairs(bwd),
    u0: withPairs ? u0Of(bank, c, p, pairsForward[0]) : null,
  };
}

/**
 * Lone forward straddles of every frame of one run, and the harness identities they carry (H1, H2,
 * H4).
 */
function gateSingle(
  bank: RigBank,
  c: number,
  p: number,
  levels: readonly number[],
  identities: GateUnit['identities'],
): SingleRecord[] {
  const clean = runFingerprints(bank, c, p, CLEAN);
  const cleanResiduals = pairResiduals(clean);
  const lit = bank.lit[c][p] / (bank.width * bank.height);
  const out: SingleRecord[] = [];
  for (const s of levels) {
    const blended = designedPhotos('forward', () => s, 1);
    const own: (number | null)[] = [];
    const worst: (number | null)[] = [];
    for (let f = 0; f < FRAMES_PER_RUN; f++) {
      const k = p * FRAMES_PER_RUN + f;
      const run = clean.slice();
      run[f] = photoFingerprint(bank, c, p, blended[k], k);
      const r = pairResiduals(run);
      const m = PAIR_OF_FRAME[f];
      own.push(m < 0 ? null : r[m]);
      worst.push(worstOf(r));
      const where = `camera ${c} run ${p + 1} frame ${f + 1} (${FRAME_CLASSES[f]}) at s = ${s}`;
      if (SPECS[f].kind === 'gray') {
        identities.h1.checked++;
        if (!(r[m] !== null && r[m] <= s + 1e-6))
          identities.h1.failures.push(`${where}: R = ${r[m]}`);
        if (m === 0 && lit >= 0.01) {
          identities.h2.checked++;
          if (!(r[m] !== null && r[m] / s >= 0.95))
            identities.h2.failures.push(`${where}: R/s = ${r[m] === null ? null : r[m] / s}`);
        }
      }
      if (PHASE_FRAMES.includes(f)) {
        identities.h4.checked++;
        if (r.some((x, i) => x !== cleanResiduals[i]))
          identities.h4.failures.push(`${where}: a pair residual moved`);
      }
    }
    out.push({ camera: c, projector: p, s, own, worst });
  }
  return out;
}

function gateNoisy(rc: RigContext, plan: Exp10Plan, c: number): NoisyRecord[] {
  const { bank } = rc;
  const out: NoisyRecord[] = [];
  for (const direction of ['forward', 'backward'] as const) {
    for (const s of plan.noisyLevels) {
      if (s === 0 && direction === 'backward') continue;
      const photos = designedPhotos(direction, () => s, 1);
      const noiselessPrints = positionFingerprints(bank, c, photos);
      const noiseless = isolatedCheck(noiselessPrints, photos, 'content');
      const noisyPrints: FrameFingerprint[] = [];
      for (let p = 0; p < PROJECTORS; p++)
        noisyPrints.push(...runPrints(fastRun(bank, c, p, photos), p));
      const noisy = isolatedCheck(noisyPrints, photos, 'content');
      const slice = (fps: FrameFingerprint[], p: number) =>
        fps.slice(p * FRAMES_PER_RUN, (p + 1) * FRAMES_PER_RUN);
      out.push({
        camera: c,
        direction,
        s,
        runs: Array.from({ length: PROJECTORS }, (_, p) => ({
          projector: p,
          noisy: noisy.usableProjectors.includes(p),
          noiseless: noiseless.usableProjectors.includes(p),
          worstNoisy: worstOf(pairResiduals(slice(noisyPrints, p))),
          worstNoiseless: worstOf(pairResiduals(slice(noiselessPrints, p))),
        })),
      });
    }
  }
  return out;
}

/**
 * H8: the fast path against the renderer's own hook. The whole rig is
 * rendered, so the renderer's camera index is the rig's and the noise stream
 * is the one `noisyRun` walks; a straddle for camera `c` alone.
 */
function gateHook(rc: RigContext, plan: Exp10Plan, c: number): HookRecord[] {
  const { bank } = rc;
  const bits = DEFAULT_SENSOR.quantizationBits;
  if (bits === null) throw new Error('experiment10: DEFAULT_SENSOR no longer quantises');
  const step = DEFAULT_SENSOR.saturationRadiance / (2 ** bits - 1);
  const out: HookRecord[] = [];
  for (const s of plan.hookLevels) {
    const photos = designedPhotos('forward', () => s, 1);
    const base = captureOptionsFor(bank.world, bank.scenario, runOptionsFor(bank), PLAN);
    let pixels = 0;
    let identical = 0;
    let worstSteps = 0;
    let biasU = 0;
    let biasV = 0;
    const hookPrints: FrameFingerprint[] = [];
    const fastPrints: FrameFingerprint[] = [];
    captureAndDecode(bank.world.truthRig, bank.world.cameras, {
      ...base,
      conditions: { ...base.conditions, straddle: straddleForCamera(c, photos, null) },
      onCapture: (i, p, capture) => {
        if (i !== c) return;
        const hook = planOrder(capture);
        const fast = fastRun(bank, c, p, photos);
        for (let f = 0; f < FRAMES_PER_RUN; f++) {
          const a = hook[f].data;
          const b = fast[f].data;
          for (let x = 0; x < a.length; x++) {
            pixels++;
            if (a[x] === b[x]) identical++;
            else
              worstSteps = Math.max(
                worstSteps,
                Math.abs(Math.round(a[x] / step) - Math.round(b[x] / step)),
              );
          }
        }
        hookPrints.push(...runPrints(hook, p));
        fastPrints.push(...runPrints(fast, p));
        const shift = shiftBetween(
          pageRead(c, p, fast).correspondences,
          pageRead(c, p, hook).correspondences,
        );
        biasU = Math.max(biasU, Math.abs(shift.meanU ?? 0));
        biasV = Math.max(biasV, Math.abs(shift.meanV ?? 0));
      },
    });
    const hook = isolatedCheck(hookPrints, photos, 'content');
    const fast = isolatedCheck(fastPrints, photos, 'content');
    out.push({
      camera: c,
      s,
      pixels,
      identical,
      worstSteps,
      verdictsAgree:
        JSON.stringify(hook.usableProjectors) === JSON.stringify(fast.usableProjectors) &&
        JSON.stringify(hook.problems) === JSON.stringify(fast.problems),
      placedHook: hook.usableProjectors,
      placedFast: fast.usableProjectors,
      biasU,
      biasV,
    });
  }
  return out;
}

/**
 * The smear at camera row `row` of a rolling readout: `s̄` at the middle row, sloping by
 * readout/exposure.
 */
export function rollingSmear(
  midRow: number,
  readoutOverExposure: number,
  height: number,
): (row: number) => number {
  return (row) => clamp01(midRow + (row / (height - 1) - 0.5) * readoutOverExposure);
}

/**
 * A short exposure under a slow readout: the readout outlasts the exposure, so
 * the pattern change sweeps the frame. As P5b words it, the rows from
 * `rowFraction` down (read later) are wholly the next step; the band of E/ρ of
 * the height above them is mixed, its smear falling to nothing at the band's
 * top; and the rows above that are wholly the filed step.
 */
function shortSmear(rowFraction: number, height: number): (row: number) => number {
  const ratio = READOUT_S[1] / SHORT_EXPOSURE_S;
  return (row) => clamp01(1 + (row / (height - 1) - rowFraction) * ratio);
}

function gateGain(rc: RigContext, plan: Exp10Plan, k: number, c: number): GainRecord[] {
  const { bank } = rc;
  const twin = twinOf(rc, c);
  const attributable = twin.placedNoiseless;
  // One standard normal per photograph per draw, shared by every sigma (common
  // random numbers), from this experiment's own named stream.
  const z = Array.from({ length: plan.gainDraws }, (_, d) => {
    const rng = makeBenchRng(gainSeed(k, c, d));
    return Float64Array.from({ length: STEPS.length }, () => rng.gaussian());
  });
  const out: GainRecord[] = [];
  for (const s of [0, ...plan.gainLevels]) {
    const photos = designedPhotos('forward', () => s, 1);
    const base = positionFingerprints(bank, c, photos);
    const plain = isolatedCheck(base, photos, 'content').usableProjectors;
    for (const sigma of plan.gainSigmas) {
      let trials = 0;
      let refused = 0;
      let flipped = 0;
      for (const draw of z) {
        // Copied, never scaled in place: a lone part's fingerprint is the
        // bank's own array (`blendFingerprint`).
        const scaled = base.map((fp, j) => ({
          ...fp,
          values: Float32Array.from(fp.values, (v) => v * (1 + sigma * draw[j])),
        }));
        const placed = isolatedCheck(scaled, photos, 'content').usableProjectors;
        for (const p of attributable) {
          trials++;
          if (!placed.includes(p)) refused++;
          if (placed.includes(p) !== plain.includes(p)) flipped++;
        }
      }
      out.push({ camera: c, sigma, s, trials, refused, flipped });
    }
  }
  return out;
}

/**
 * The 8-bit page path against linear frames, on noiseless blends so the
 * difference is the encode's alone: `encodeSrgb8` then the page's own
 * `summarisePhoto`, against `fingerprint` on the same frames. At the main
 * preset also a camera whose tone curve the page does not undo (`TONE_CURVE`),
 * and where the crossing lands through each path.
 */
function gateEncode(
  rc: RigContext,
  plan: Exp10Plan,
  c: number,
  runs: readonly GateRun[],
  withTone: boolean,
): { records: EncodeRecord[]; crossings: EncodeCrossing[] } {
  const { bank } = rc;
  const records: EncodeRecord[] = [];
  const crossings: EncodeCrossing[] = [];
  const img = (data: Float32Array | Float64Array): LinearImage => ({
    width: bank.width,
    height: bank.height,
    channels: 1,
    data,
  });
  const residualsThrough = (
    p: number,
    s: number,
    path: 'linear' | 'encoded' | 'tone',
  ): (number | null)[] => {
    const frames = runFrames(
      bank,
      c,
      p,
      designedPhotos('forward', () => s, 1),
    );
    const prints: FrameFingerprint[] = [];
    for (let f = 0; f < FRAMES_PER_RUN; f++) {
      const j = p * FRAMES_PER_RUN + f;
      const linear = img(frames(f));
      prints.push(
        path === 'linear'
          ? fingerprint(linear, j, FINGERPRINT_BLOCKS)
          : summarisePhoto(
              encodeSrgb8(linear, ENCODE_FULL_SCALE, path === 'tone' ? TONE_CURVE.kappa : 0),
              j,
              photoName(j),
              TRANSFER,
              FINGERPRINT_BLOCKS,
            ).fingerprint,
      );
    }
    return pairResiduals(prints);
  };
  const maxDelta = (a: (number | null)[], b: (number | null)[]): number | null => {
    let worst: number | null = null;
    a.forEach((x, m) => {
      const y = b[m];
      if (x !== null && y !== null) worst = Math.max(worst ?? 0, Math.abs(x - y));
    });
    return worst;
  };
  for (const p of armRuns(plan, twinOf(rc, c))) {
    for (const s of [0, ...plan.encodeLevels]) {
      const lin = residualsThrough(p, s, 'linear');
      const enc = residualsThrough(p, s, 'encoded');
      const tone = withTone ? residualsThrough(p, s, 'tone') : null;
      records.push({
        camera: c,
        projector: p,
        s,
        worstLinear: worstOf(lin),
        worstEncoded: worstOf(enc),
        worstTone: tone === null ? null : worstOf(tone),
        maxDelta: maxDelta(enc, lin),
        maxDeltaTone: tone === null ? null : maxDelta(tone, lin),
      });
    }
    if (withTone) {
      const linear = runs.find((r) => r.camera === c && r.projector === p)?.forward.s ?? null;
      const near = (path: 'encoded' | 'tone'): number | null =>
        linear === null
          ? null
          : crossingNear((s) => failingPair(residualsThrough(p, s, path)) >= 0, linear);
      crossings.push({
        camera: c,
        projector: p,
        linear,
        encoded: near('encoded'),
        tone: near('tone'),
      });
    }
  }
  return { records, crossings };
}

export function stageGate(ctx: RunContext): StageFile<GateUnit> {
  const { plan } = ctx;
  const bankFile = needStage<BankUnit>(ctx, 'bank');
  return runUnits<GateUnit>(ctx, 'gate', rigUnits(plan, ['main', 'spill', 'fine']), (unit) => {
    const { which, k } = parseUnit(unit);
    const rc = rigContext(ctx, unit, bankFile);
    const { bank } = rc;
    const designed = which === 'main' && plan.designedRigs.includes(k);
    const out: GateUnit = {
      runs: [],
      single: [],
      identities: {
        h1: { checked: 0, failures: [] },
        h2: { checked: 0, failures: [] },
        h4: { checked: 0, failures: [] },
      },
      noisy: [],
      hook: [],
      rolling: [],
      gain: [],
      encode: [],
      encodeCrossings: [],
      short: [],
    };
    for (const c of bank.cameras) {
      if (plan.armCameras !== null && !plan.armCameras.includes(c)) continue;
      const twin = twinOf(rc, c);
      for (const p of crossingRuns(plan, twin))
        out.runs.push(gateCrossings(bank, c, p, twin, which === 'main'));
      if (which === 'main') {
        for (const p of armRuns(plan, twin))
          out.single.push(...gateSingle(bank, c, p, plan.singleLevels, out.identities));
      }
      if (designed) {
        out.noisy.push(...gateNoisy(rc, plan, c));
        for (const p of armRuns(plan, twin)) {
          for (const ratio of plan.rollingRatios) {
            const crossing = runCrossing((s) =>
              pairResiduals(
                runFingerprints(
                  bank,
                  c,
                  p,
                  designedPhotos('forward', rollingSmear(s, ratio, bank.height), bank.height),
                ),
              ),
            );
            out.rolling.push({ camera: c, projector: p, readoutOverExposure: ratio, crossing });
          }
        }
        out.gain.push(...gateGain(rc, plan, k, c));
        for (const rowFraction of plan.shortRowFractions) {
          const photos = designedPhotos(
            'forward',
            shortSmear(rowFraction, bank.height),
            bank.height,
          );
          const result = isolatedCheck(positionFingerprints(bank, c, photos), photos, 'content');
          out.short.push({
            camera: c,
            rowFraction,
            runs: runVerdicts(result, photos, twin.placedContent).map((o) => ({
              projector: o.projector,
              attributable: o.attributable,
              outcome: o.outcome,
            })),
          });
        }
      }
      if (which === 'main' && plan.hookRigs.includes(k) && plan.hookCameras.includes(c))
        out.hook.push(...gateHook(rc, plan, c));
      if ((which === 'main' || which === 'fine') && plan.encodeRigs.includes(k)) {
        const encoded = gateEncode(rc, plan, c, out.runs, which === 'main');
        out.encode.push(...encoded.records);
        out.encodeCrossings.push(...encoded.crossings);
      }
    }
    const attributable = out.runs
      .filter((r) => r.attributable && r.forward.s !== null)
      .map((r) => r.forward.s as number);
    const shown = attributable.map((s) => (100 * s).toFixed(2)).join(', ');
    ctx.log(`    ${unit}: forward crossings ${shown} %`);
    return out;
  });
}

/**
 * H3: the whole-run closed form in projector space, on the page's own block grid (T16's claim,
 * re-measured here).
 *
 * No checkpoint holds it, since it needs no rig and costs milliseconds, so the
 * assembly calls it each time it writes the document. It lives on this side of
 * the line all the same, because it measures: it builds the page's block grids
 * and blends and reads their residuals. The assembly only judges the result
 * against the bound.
 */
export function closedForm(): {
  levels: {
    s: number;
    u0: number | null;
    u0Want: number;
    othersWorst: number;
    othersWant: number;
  }[];
  worstError: number;
} {
  const grids = SPECS.map((spec) =>
    frameBlockGrid(spec, PLAN, FINGERPRINT_BLOCKS, PROJECTOR_RES.x, PROJECTOR_RES.y, 0),
  );
  const measured = new Uint8Array(FINGERPRINT_BLOCKS * FINGERPRINT_BLOCKS).fill(1);
  const grid = (state: 'dark' | { projector: number; frame: number }): FrameFingerprint => ({
    ordinal: -1,
    blocks: FINGERPRINT_BLOCKS,
    values: grids[state === 'dark' ? BLACK_FRAME : state.frame],
    measured,
  });
  const levels = [];
  let worstError = 0;
  for (const s of [0.05, 0.1, 0.15]) {
    const run = designedPhotos('forward', () => s, 1)
      .slice(0, FRAMES_PER_RUN)
      .map((photo, j) => blendFingerprint(photo.rows[0], j, grid));
    const r = pairResiduals(run);
    const u0Want = (2 * s) / (2 - 3 * s);
    const othersWant = (1.5 * s) / (2 - 3 * s);
    let othersWorst = 0;
    for (let m = 1; m < r.length; m++)
      othersWorst = Math.max(othersWorst, Math.abs((r[m] ?? Number.NaN) - othersWant));
    worstError = Math.max(worstError, Math.abs((r[0] ?? Number.NaN) - u0Want), othersWorst);
    levels.push({
      s,
      u0: round(r[0], 6),
      u0Want: round(u0Want, 6) as number,
      othersWorst: round(othersWorst, 8) as number,
      othersWant: round(othersWant, 6) as number,
    });
  }
  return { levels, worstError };
}

// ---------------------------------------------------------------------------
// decode — what a blend that passes does to a coordinate
// ---------------------------------------------------------------------------

/**
 * The smear the verdict quotes a bias at: the pose arms' 6%, below every
 * design-time crossing. Decoded beside the design's own noiseless levels so
 * the sentence's pixel and millimetre figures are measured, not scaled.
 */
export const VERDICT_S = 0.06;
if (!POSE_LEVELS.forward.includes(VERDICT_S))
  throw new Error('experiment10: the verdict smear is not a pose level');

/**
 * A decode's reject buckets on one half of the projector's u axis: `imageMask` keeps the decoder
 * itself doing the counting.
 */
export interface HalfStats {
  /**
   * Pixels of the half in view at all: the bank's geometric truth puts them on
   * this half of the raster. Most need not be lit.
   */
  inView: number;
  accepted: number;
  grayAmbiguous: number;
  lowModulation: number;
}

export interface DecodeLevel {
  direction: 'forward' | 'backward';
  s: number;
  accepted: number;
  statsDelta: Record<string, number>;
  /** Against the clean decode of the same pixels. */
  shift: Record<string, number | null>;
  ratioU: number | null;
  ratioV: number | null;
  /** Against the bank's geometric truth. */
  truth: {
    meanU: number | null;
    meanV: number | null;
    medianAbs: number | null;
    p95Abs: number | null;
  };
  mm: SphereMm;
  /**
   * Per half of the u raster: MSB dark (u < 960) and MSB lit. Only where the Gray onsets are asked
   * about.
   */
  halves: { dark: HalfStats; lit: HalfStats } | null;
  /** Gray-word changes against the clean decode, on the pixels both accept (H7's flip clause). */
  grayFlips: GrayFlips;
  /**
   * The shift's per-pixel signs on the same pixels, the SEAM apart: pixels the
   * projector whose light this direction's blend brings into the run also
   * lights. Forward that is the next projector, whose white follows the run's
   * last frame; backward the previous one, whose last frame precedes the run's
   * white. The run with no such neighbour (the dark follows the last run, step
   * 0 precedes the first) has no seam.
   */
  signs: { seam: SignTally; rest: SignTally };
}

export interface PageLevel {
  direction: 'forward' | 'backward';
  s: number;
  /** `readRun`'s own buckets and problems: question (a), in the page's units. */
  buckets: DecodeStats | null;
  /** The twin's page-path `stats.accepted` for the same run, the baseline the buckets move from. */
  twinAccepted: number;
  problems: string[];
  shift: Record<string, number | null>;
  /** Median sigma against the twin's, per axis: how much less sure the decoder is. */
  sigmaInflationU: number | null;
  sigmaInflationV: number | null;
  /**
   * The same noisy frames decoded linearly, without the 8-bit encode: the encode's own share of the
   * bias.
   */
  linearMeanU: number | null;
  linearMeanV: number | null;
}

export interface RollingDecode {
  readoutOverExposure: number;
  midRow: number;
  meanU: number | null;
  meanV: number | null;
  /** Least-squares slope of the per-row mean shift against the row, px per row. */
  slopeU: number | null;
  slopeV: number | null;
  rows: (number | null)[];
}

export interface ShortDecode {
  rowFraction: number;
  /** Rows wholly on the next step, and the gross errors decoded there. */
  nextRows: number;
  nextMatched: number;
  nextGross: number;
  mixedMatched: number;
  mixedGross: number;
  acceptedDelta: number;
}

export interface DecodeRun {
  camera: number;
  projector: number;
  accepted: number;
  cleanTruth: DecodeLevel['truth'];
  cleanMm: SphereMm;
  cleanHalves: { dark: HalfStats; lit: HalfStats };
  levels: DecodeLevel[];
  page: PageLevel[];
  rolling: RollingDecode[];
  short: ShortDecode[];
  ablation: {
    page: {
      meanU: number | null;
      meanV: number | null;
      sigmaU: number | null;
      sigmaV: number | null;
    };
    /**
     * A dimming control, not a successor ablation: every photograph blended
     * with the dark (see `decodeRunArms`).
     */
    dimmed: {
      meanU: number | null;
      meanV: number | null;
      sigmaU: number | null;
      sigmaV: number | null;
    };
  };
}

export interface SingleFrameDecode {
  camera: number;
  projector: number;
  frame: number;
  direction: 'forward' | 'backward';
  s: number;
  acceptedDelta: number;
  /** Every correspondence, all six solver-facing fields, bit for bit. */
  identical: boolean;
  matched: number;
  changed: number;
  moved: number;
  meanU: number | null;
  meanV: number | null;
  maxAbs: number;
}

export interface DecodeUnit {
  runs: DecodeRun[];
  single: SingleFrameDecode[];
}

export function halfMasks(
  bank: RigBank,
  c: number,
  p: number,
): { dark: Uint8Array; lit: Uint8Array } {
  const u = bank.truth[c][p].projU;
  const dark = new Uint8Array(u.length);
  const lit = new Uint8Array(u.length);
  for (let i = 0; i < u.length; i++) {
    if (Number.isNaN(u[i])) continue;
    if (u[i] < PROJECTOR_RES.x / 2) dark[i] = 1;
    else lit[i] = 1;
  }
  return { dark, lit };
}

/**
 * The decoder's own buckets on one half of the raster. `decodeCapture` counts a
 * pixel's low modulation BEFORE it consults the mask, so that bucket is
 * whole-frame; the half's share is recovered from the decoder's counts alone:
 * of the pixels that cleared the floor, the ones outside the half were counted
 * off-image, so the half's own low-modulation count is its size less the ones
 * that cleared.
 */
export function halves(
  c: number,
  p: number,
  frames: readonly LinearImage[],
  masks: { dark: Uint8Array; lit: Uint8Array },
): { dark: HalfStats; lit: HalfStats } {
  const on = (mask: Uint8Array): HalfStats => {
    const d = decodeRun(c, p, frames, {
      imageMask: (_camera: number, pixel: number) => mask[pixel] === 1,
    }).stats;
    let size = 0;
    for (let i = 0; i < mask.length; i++) size += mask[i];
    const cleared = d.considered - d.rejectedLowModulation - d.rejectedOffImage;
    return {
      inView: size,
      accepted: d.accepted,
      grayAmbiguous: d.rejectedGrayAmbiguous,
      lowModulation: size - cleared,
    };
  };
  return { dark: on(masks.dark), lit: on(masks.lit) };
}

function truthOf(
  rc: RigContext,
  c: number,
  p: number,
  xs: readonly Correspondence[],
): DecodeLevel['truth'] {
  const t = truthError(rc, c, p, xs);
  return {
    meanU: round(t.meanU, 5),
    meanV: round(t.meanV, 5),
    medianAbs: round(t.medianAbs, 5),
    p95Abs: round(t.p95Abs, 5),
  };
}

function sigmaMedians(xs: readonly Correspondence[]): {
  sigmaU: number | null;
  sigmaV: number | null;
} {
  return {
    sigmaU: round(median(xs.map((x) => x.sigmaU)), 6),
    sigmaV: round(median(xs.map((x) => x.sigmaV)), 6),
  };
}

/**
 * The projector whose light a whole-run blend in `direction` brings into run
 * `p`: the other projector named by any part of the run's own photographs, read
 * off the page's semantics ({@link designedPhotos}) rather than written as
 * `p ± 1`. Forward, the next projector's white follows the run's last frame;
 * backward, the previous projector's last frame precedes the run's white. Null
 * where there is none: the dark follows the last run, and step 0, lit before
 * Play, precedes the first.
 */
export function neighbourOf(p: number, direction: 'forward' | 'backward'): number | null {
  const others = new Set<number>();
  for (const photo of designedPhotos(direction, () => 0.5, 1).slice(
    p * FRAMES_PER_RUN,
    (p + 1) * FRAMES_PER_RUN,
  )) {
    for (const part of photo.rows[0]) {
      if (part.state !== 'dark' && part.state.projector !== p) others.add(part.state.projector);
    }
  }
  if (others.size > 1) {
    throw new Error(`experiment10: run ${p + 1} ${direction} blends in ${others.size} projectors`);
  }
  return others.size === 0 ? null : [...others][0];
}

export function decodeRunArms(rc: RigContext, plan: Exp10Plan, c: number, p: number): DecodeRun {
  const { bank } = rc;
  const cleanFrames = cleanRun(bank, c, p, CLEAN);
  const clean = decodeRun(c, p, cleanFrames);
  const cleanGray = decodeGrayOnly(c, p, cleanFrames).correspondences;
  const cleanSphere = decodedOnSphere(rc, p, clean.correspondences);
  const masks = halfMasks(bank, c, p);
  const seamOf = (direction: 'forward' | 'backward'): Uint8Array => {
    const q = neighbourOf(p, direction);
    return q === null ? new Uint8Array(bank.width * bank.height) : litMask(bank, c, q);
  };
  const levels: DecodeLevel[] = [];
  for (const direction of ['forward', 'backward'] as const) {
    const grid = [...plan.decodeNoiseless];
    if (direction === 'forward' && !grid.includes(VERDICT_S)) grid.push(VERDICT_S);
    const seam = seamOf(direction);
    for (const s of grid.sort((a, b) => a - b)) {
      const frames = cleanRun(
        bank,
        c,
        p,
        designedPhotos(direction, () => s, 1),
      );
      const treated = decodeRun(c, p, frames);
      const shift = shiftBetween(clean.correspondences, treated.correspondences);
      const ratio = biasRatio(shift, s);
      const tallies = pixelTallies(
        clean.correspondences,
        treated.correspondences,
        cleanGray,
        decodeGrayOnly(c, p, frames).correspondences,
        seam,
        bank.width,
      );
      levels.push({
        direction,
        s,
        accepted: treated.stats.accepted,
        statsDelta: statsDelta(clean.stats, treated.stats),
        shift: roundShift(shift),
        ratioU: round(ratio.u, 5),
        ratioV: round(ratio.v, 5),
        truth: truthOf(rc, c, p, treated.correspondences),
        mm: sphereMm(rc, c, cleanSphere, decodedOnSphere(rc, p, treated.correspondences)),
        // The Gray onsets (H7) sit at 3/7 and 1/2, so the halves are asked
        // about only around them.
        halves: s >= 0.3 ? halves(c, p, frames, masks) : null,
        grayFlips: tallies.grayFlips,
        signs: tallies.signs,
      });
    }
  }

  // The page's own path, noisy: 8-bit encode, `readRun`, against the twin's.
  const twinPage = twinDecode(rc, c, p);
  const twinSigma = sigmaMedians(twinPage);
  const twinLinearKey = `linear:${c}:${p}`;
  let twinLinear = rc.decodes.get(twinLinearKey);
  if (twinLinear === undefined) {
    twinLinear = decodeRun(c, p, fastRun(bank, c, p, CLEAN)).correspondences;
    rc.decodes.set(twinLinearKey, twinLinear);
  }
  const page: PageLevel[] = [];
  for (const direction of ['forward', 'backward'] as const) {
    for (const s of plan.decodeNoisy) {
      const frames = fastRun(
        bank,
        c,
        p,
        designedPhotos(direction, () => s, 1),
      );
      const read = pageRead(c, p, frames);
      const shift = shiftBetween(twinPage, read.correspondences);
      const linear = shiftBetween(twinLinear, decodeRun(c, p, frames).correspondences);
      const sigma = sigmaMedians(read.correspondences);
      page.push({
        direction,
        s,
        buckets: read.outcome.stats,
        twinAccepted: twinOf(rc, c).runs[p].accepted,
        problems: read.outcome.problems,
        shift: roundShift(shift),
        sigmaInflationU:
          sigma.sigmaU === null || twinSigma.sigmaU === null
            ? null
            : round(sigma.sigmaU / twinSigma.sigmaU, 5),
        sigmaInflationV:
          sigma.sigmaV === null || twinSigma.sigmaV === null
            ? null
            : round(sigma.sigmaV / twinSigma.sigmaV, 5),
        linearMeanU: round(linear.meanU, 5),
        linearMeanV: round(linear.meanV, 5),
      });
    }
  }

  // A rolling readout: the smear changes down the frame, so the bias should too.
  const cleanByPixel = new Map(clean.correspondences.map((x) => [pixelOf(x), x]));
  const rolling: RollingDecode[] = [];
  for (const ratio of plan.rollingDecode.ratios) {
    for (const midRow of plan.rollingDecode.midRow) {
      const treated = decodeRun(
        c,
        p,
        cleanRun(
          bank,
          c,
          p,
          designedPhotos('forward', rollingSmear(midRow, ratio, bank.height), bank.height),
        ),
      );
      const du: number[][] = Array.from({ length: bank.height }, () => []);
      const dv: number[][] = Array.from({ length: bank.height }, () => []);
      for (const y of treated.correspondences) {
        const x = cleanByPixel.get(pixelOf(y));
        if (x === undefined) continue;
        du[y.camV - 0.5].push(y.projU - x.projU);
        dv[y.camV - 0.5].push(y.projV - x.projV);
      }
      const fit = (per: number[][]): number | null => {
        const pts = per.flatMap((d, row) => (d.length >= 5 ? [[row, mean(d)]] : []));
        if (pts.length < 3) return null;
        const mx = mean(pts.map((q) => q[0]));
        const my = mean(pts.map((q) => q[1]));
        let sxy = 0;
        let sxx = 0;
        for (const [x, y] of pts) {
          sxy += (x - mx) * (y - my);
          sxx += (x - mx) * (x - mx);
        }
        return sxx > 0 ? sxy / sxx : null;
      };
      rolling.push({
        readoutOverExposure: ratio,
        midRow,
        meanU: round(mean(du.flat()), 5),
        meanV: round(mean(dv.flat()), 5),
        slopeU: round(fit(du), 7),
        slopeV: round(fit(dv), 7),
        rows: du.map((d) => (d.length >= 5 ? round(mean(d), 4) : null)),
      });
    }
  }

  // A short exposure under a slow readout: rows wholly on the next step.
  const short: ShortDecode[] = [];
  for (const rowFraction of plan.shortRowFractions) {
    const smear = shortSmear(rowFraction, bank.height);
    const treated = decodeRun(
      c,
      p,
      cleanRun(bank, c, p, designedPhotos('forward', smear, bank.height)),
    );
    const rec: ShortDecode = {
      rowFraction,
      nextRows: 0,
      nextMatched: 0,
      nextGross: 0,
      mixedMatched: 0,
      mixedGross: 0,
      acceptedDelta: treated.stats.accepted - clean.stats.accepted,
    };
    for (let row = 0; row < bank.height; row++) if (smear(row) === 1) rec.nextRows++;
    for (const y of treated.correspondences) {
      const x = cleanByPixel.get(pixelOf(y));
      if (x === undefined) continue;
      const s = smear(y.camV - 0.5);
      const gross =
        Math.abs(y.projU - x.projU) > GROSS_PX.u || Math.abs(y.projV - x.projV) > GROSS_PX.v;
      if (s === 1) {
        rec.nextMatched++;
        if (gross) rec.nextGross++;
      } else if (s > 0) {
        rec.mixedMatched++;
        if (gross) rec.mixedGross++;
      }
    }
    short.push(rec);
  }

  // A dimming control beside the forward smear: every photograph of the run
  // blended with the page's dark, which is this projector's own black, at the
  // same weight. That dims every frame toward black alike, which moves no Gray
  // bit and no phase, so the arm shows that a uniform dimming costs nothing.
  // It is NOT the spec's successor ablation, and it was first described as
  // one: it replaces every photograph's successor, not only the last frame's,
  // so it cannot isolate what the next projector's white contributes.
  const s = 0.1;
  const toDark: Photo[] = STEPS.map((_, k) => ({
    filedStep: k,
    rows: [
      pageParts(
        [
          { step: k, weight: 1 - s },
          { step: STEPS.length, weight: s },
        ],
        STEPS,
      ),
    ],
  }));
  const ablate = (photos: readonly Photo[]) => {
    const got = decodeRun(c, p, cleanRun(bank, c, p, photos)).correspondences;
    const shift = shiftBetween(clean.correspondences, got);
    return { meanU: round(shift.meanU, 5), meanV: round(shift.meanV, 5), ...sigmaMedians(got) };
  };

  return {
    camera: c,
    projector: p,
    accepted: clean.stats.accepted,
    cleanTruth: truthOf(rc, c, p, clean.correspondences),
    cleanMm: sphereMm(rc, c, cleanSphere, cleanSphere),
    cleanHalves: halves(c, p, cleanFrames, masks),
    levels,
    page,
    rolling,
    short,
    ablation: { page: ablate(designedPhotos('forward', () => s, 1)), dimmed: ablate(toDark) },
  };
}

/**
 * Every frame of a run straddled alone, both ways, decoded against the clean run (H5, and T19's
 * claim on full-size rigs).
 */
function decodeSingleFrames(
  rc: RigContext,
  plan: Exp10Plan,
  c: number,
  p: number,
): SingleFrameDecode[] {
  const { bank } = rc;
  const cleanFrames = cleanRun(bank, c, p, CLEAN);
  const clean = decodeRun(c, p, cleanFrames);
  const out: SingleFrameDecode[] = [];
  for (const direction of ['forward', 'backward'] as const) {
    for (const s of plan.singleFrameLevels) {
      const blended = designedPhotos(direction, () => s, 1);
      for (let f = 0; f < FRAMES_PER_RUN; f++) {
        const k = p * FRAMES_PER_RUN + f;
        const frames = noisyRun(
          bank,
          c,
          p,
          (g) => (g === f ? photoFrame(bank, c, p, blended[k]) : cleanFrames[g].data),
          null,
          bank.seed,
        );
        const got = decodeRun(c, p, frames);
        const shift = shiftBetween(clean.correspondences, got.correspondences);
        const identical =
          got.correspondences.length === clean.correspondences.length &&
          got.correspondences.every((y, i) => {
            const x = clean.correspondences[i];
            return (
              y.camU === x.camU &&
              y.camV === x.camV &&
              y.projU === x.projU &&
              y.projV === x.projV &&
              y.sigmaU === x.sigmaU &&
              y.sigmaV === x.sigmaV
            );
          });
        const was = new Map(clean.correspondences.map((x) => [pixelOf(x), x]));
        let maxAbs = 0;
        for (const y of got.correspondences) {
          const x = was.get(pixelOf(y));
          if (x !== undefined)
            maxAbs = Math.max(maxAbs, Math.abs(y.projU - x.projU), Math.abs(y.projV - x.projV));
        }
        out.push({
          camera: c,
          projector: p,
          frame: f,
          direction,
          s,
          acceptedDelta: got.stats.accepted - clean.stats.accepted,
          identical,
          matched: shift.matched,
          changed: shift.changed,
          moved: shift.moved,
          meanU: round(shift.meanU, 6),
          meanV: round(shift.meanV, 6),
          maxAbs: round(maxAbs, 6) as number,
        });
      }
    }
  }
  return out;
}

export function stageDecode(ctx: RunContext): StageFile<DecodeUnit> {
  const { plan } = ctx;
  const bankFile = needStage<BankUnit>(ctx, 'bank');
  const units = plan.designedRigs.map((k) => unitKey('main', k));
  return runUnits<DecodeUnit>(ctx, 'decode', units, (unit) => {
    const { k } = parseUnit(unit);
    const rc = rigContext(ctx, unit, bankFile);
    const out: DecodeUnit = { runs: [], single: [] };
    for (const c of rc.bank.cameras) {
      if (plan.armCameras !== null && !plan.armCameras.includes(c)) continue;
      // Runs worth decoding: attributable, and not MINOR (at least 200 clean
      // page-path correspondences), so a statistic is not one of twelve pixels.
      for (const p of armRuns(plan, twinOf(rc, c), true)) {
        out.runs.push(decodeRunArms(rc, plan, c, p));
        if (plan.singleFrameRigs.includes(k))
          out.single.push(...decodeSingleFrames(rc, plan, c, p));
      }
    }
    const f10 = out.runs.flatMap((r) =>
      r.levels.filter((l) => l.direction === 'forward' && l.s === 0.1),
    );
    const ratios = f10.map((l) => l.ratioU?.toFixed(3)).join(', ');
    ctx.log(`    ${unit}: forward s = 0.10 bias ratio u ${ratios}`);
    return out;
  });
}

// ---------------------------------------------------------------------------
// rescore and lateness — EXPERIMENT-9's photographs, scored
// ---------------------------------------------------------------------------

/**
 * The refine band every refined cell uses, and the only one. A run whose
 * noiseless worst pair lies within this of the limit ({@link inBand}) is
 * re-evaluated with noise, and its verdicts, the choices made from them and
 * the categories reported all come from that evaluation ({@link deciding}).
 *
 * It is the top of the spec's widening loop, which starts at `REFINE_MARGIN`
 * and widens in 0.01 steps until the refined verdicts agree with R1's fully
 * noisy ones on 98% of runs. R1 runs in the rescore stage and the lateness
 * cells run beside it, so no cell can wait for R1's answer. Every refined cell
 * is therefore scored at the widest band up front. The loop survives as the
 * document's diagnostic (`rescore.refine`): the agreement at this band, and at
 * each narrower margin.
 */
export const REFINE_CEILING = 0.05;

export interface CellSpec {
  id: string;
  arm: string;
  phase: StartPhase;
  exposureS: number;
  lateMs: number;
  vsync: boolean;
  readoutS: number;
  which: 'main' | 'spill';
  trials: number;
  /**
   * `noisy`: every touched run on the fast path; `refine`: noiseless, with runs near the limit
   * re-evaluated noisy.
   */
  mode: 'noisy' | 'refine';
  decode: 'all' | 'subsample' | 'none';
  solve: 'policies' | 'first-a' | 'none';
}

export function rescoreCells(plan: Exp10Plan): CellSpec[] {
  const base = {
    arm: 'intervalometer-100ppm',
    phase: 'uniform' as StartPhase,
    exposureS: EXPOSURE_S,
    lateMs: 0,
    vsync: false,
    readoutS: 0,
    which: 'main' as const,
    trials: plan.trials,
    mode: 'refine' as const,
    decode: 'subsample' as const,
    solve: 'none' as const,
  };
  return [
    { ...base, id: 'R1', mode: 'noisy', decode: 'all', solve: plan.pose ? 'policies' : 'none' },
    { ...base, id: 'R2', arm: 'intervalometer-20ppm' },
    { ...base, id: 'R3', exposureS: SHORT_EXPOSURE_S },
    { ...base, id: 'R4', arm: 'handheld-remote', trials: plan.handheldTrials },
    { ...base, id: 'R5', readoutS: READOUT_S[1] },
    { ...base, id: 'R6', which: 'spill' },
    { ...base, id: 'R7', vsync: true },
    { ...base, id: 'R8', phase: 'aimed', decode: 'none' },
  ];
}

export function latenessCells(plan: Exp10Plan): CellSpec[] {
  const out: CellSpec[] = [];
  for (const lateMs of plan.lateMsRendered) {
    for (const phase of ['aimed', 'uniform'] as const) {
      out.push({
        id: `L-${phase}-${lateMs}`,
        arm: 'intervalometer-100ppm',
        phase,
        exposureS: EXPOSURE_S,
        lateMs,
        vsync: false,
        readoutS: 0,
        which: 'main',
        trials: plan.trials,
        mode: 'refine',
        decode: 'subsample',
        // The design-time headless figure is the lateness a capture is solved at.
        solve:
          plan.pose && phase === 'aimed' && lateMs === HEADLESS_LATENESS_MS.hudTickOff
            ? 'first-a'
            : 'none',
      });
    }
  }
  return out;
}

function armOf(key: string): Arm {
  const arm = ARMS.find((a) => a.key === key);
  if (arm === undefined) throw new Error(`experiment10: EXPERIMENT-9 has no arm ${key}`);
  return arm;
}

/** Trial `t`'s rig: `t mod 24` over the main sweep, `t mod 8` over the spill rigs. */
function rigOfTrial(plan: Exp10Plan, which: 'main' | 'spill', t: number): number {
  const rigs = which === 'main' ? plan.rigs : plan.spillRigs;
  return rigs[t % rigs.length];
}

/**
 * The display's refresh waits for one trial, per position: `U(0, VSYNC_S)` per
 * step, not carried forward, each position a fresh emitter run. Drawn from
 * this experiment's own named stream, so turning them on moves no other draw.
 */
function vsyncJitters(label: string, t: number): ((m: number) => number)[] {
  const rng = makeBenchRng(vsyncSeed(label, t));
  return Array.from({ length: POSITIONS }, () => {
    const waits = Float64Array.from({ length: STEPS.length + 8 }, (_, m) =>
      m === 0 ? 0 : rng.uniform(0, VSYNC_S),
    );
    return (m: number): number => {
      if (!(m >= 1 && m < waits.length))
        throw new Error(`experiment10: no refresh wait drawn for step ${m}`);
      return waits[m];
    };
  });
}

function cellShots(cell: CellSpec, t: number): ShotTiming[] {
  const arm = armOf(cell.arm);
  return shotTimings(
    arm,
    cell.phase,
    DWELL_S,
    exp9TrialSeed(arm, cell.phase, DWELL_S, cell.exposureS, t),
  );
}

function cellPhotos(
  cell: CellSpec,
  shots: readonly ShotTiming[],
  t: number,
  pos: number,
  height: number,
): Photo[] {
  const jitter = cell.vsync ? vsyncJitters(cell.id, t)[pos] : null;
  return positionPhotos(
    shots,
    pos,
    cell.exposureS,
    DWELL_S,
    cell.lateMs / 1000,
    jitter,
    cell.readoutS,
    cell.readoutS > 0 ? height : 1,
  );
}

/** One run of one position, under the evaluations the cell made. */
export interface RunScore {
  /** On noiseless fingerprints. */
  o0: RunOutcomeKind;
  /**
   * With this run's photographs on the fast path's noisy fingerprints; null where it was not
   * re-evaluated.
   */
  on: RunOutcomeKind | null;
  pt0: boolean;
  ptn: boolean | null;
  fa0: boolean;
  fan: boolean | null;
  co0: boolean;
  con: boolean | null;
  /**
   * The pair a complement refusal named (index into the plan's pairs), on the evaluation that
   * decided the run.
   */
  bp: number | null;
  /**
   * The noiseless worst pair residual on the photographs the bookends placed here; 'x' where the
   * bookends refused the run.
   */
  w0: number | null | 'x';
}

export interface RunDecode {
  projector: number;
  phaseTouched: boolean;
  acceptedDelta: number;
  shift: Record<string, number | null>;
}

export interface PositionScore {
  pos: number;
  flagged: boolean;
  changed: boolean;
  touched: number[];
  content: RunScore[];
  filed: RunScore[];
  /**
   * The content footing's assignment on its best evaluation, kept where a touched run was placed.
   */
  assignment: (number | null)[] | null;
  /** The page's own reader on the whole position, where Q0 said it could place anything. */
  page: { placed: number[]; problems: string[] } | null;
  decodes: RunDecode[];
}

export interface CaptureScore {
  t: number;
  rig: number;
  positions: PositionScore[];
}

const PAIR_INDEX = (pair: readonly [number, number] | null): number | null =>
  pair === null
    ? null
    : EXPECTED.complements.pairs.findIndex(([a, b]) => a === pair[0] && b === pair[1]);

function decodeOne(
  rc: RigContext,
  c: number,
  p: number,
  photos: readonly Photo[],
  assignment: readonly (number | null)[] | null,
  phaseTouched: boolean,
): RunDecode {
  const read = pageRead(c, p, fastRun(rc.bank, c, p, photos, assignment));
  const twin = twinDecode(rc, c, p);
  const twinAccepted = twinOf(rc, c).runs[p].accepted;
  return {
    projector: p,
    phaseTouched,
    acceptedDelta: (read.outcome.stats?.accepted ?? 0) - twinAccepted,
    shift: roundShift(shiftBetween(twin, read.correspondences)),
  };
}

/**
 * The page's own reader on a whole treated position: the fast path's noisy frames, encoded and
 * summarised in folder order.
 */
function pagePath(
  rc: RigContext,
  c: number,
  photos: readonly Photo[],
  touched: readonly number[],
): { placed: number[]; problems: string[] } {
  const summaries: PhotoSummary[] = [];
  for (let q = 0; q < PROJECTORS; q++) {
    const frames = fastRun(rc.bank, c, q, touched.includes(q) ? photos : CLEAN);
    frames.forEach((img, f) => {
      const j = q * FRAMES_PER_RUN + f;
      summaries.push(
        summarisePhoto(
          encodeSrgb8(img, ENCODE_FULL_SCALE),
          j,
          photoName(j),
          TRANSFER,
          FINGERPRINT_BLOCKS,
        ),
      );
    });
  }
  const indexed = indexPhotographs(summaries, MANIFEST);
  return { placed: indexed.runs.map((r) => r.projector), problems: indexed.problems };
}

/**
 * One position of one trial, scored against its twin.
 *
 * Noiseless first, on the bank's linear predictor. Then noisy: every run in a
 * `noisy` cell, and in a `refine` cell only the runs whose noiseless worst pair
 * sits near the limit — within the twin's own noise floor plus
 * {@link REFINE_CEILING} below it and the ceiling above — or could not be
 * answered. A run's complement verdict reads only the photographs the bookends
 * placed in it, so re-evaluating some runs noisy leaves every other run's
 * verdict as it was, and one indexer call answers for all of them.
 *
 * The noisy fingerprints are the fast path's for every run a straddle touched,
 * and the twin's own for every run it did not: those frames are the twin's,
 * draw for draw, which is what makes a refusal attributable.
 */
function scorePosition(
  rc: RigContext,
  c: number,
  photos: readonly Photo[],
  flagged: boolean,
  cell: CellSpec,
  pageColumn: boolean,
): PositionScore {
  const touched: number[] = [];
  for (let p = 0; p < PROJECTORS; p++) {
    if (photos.slice(p * FRAMES_PER_RUN, (p + 1) * FRAMES_PER_RUN).some(contentChanged))
      touched.push(p);
  }
  const empty: PositionScore = {
    pos: c,
    flagged,
    changed: false,
    touched,
    content: [],
    filed: [],
    assignment: null,
    page: null,
    decodes: [],
  };
  if (touched.length === 0) return empty;
  const twin = twinOf(rc, c);
  const fps0 = positionFingerprints(rc.bank, c, photos);
  const noisyRuns = new Map<number, FrameFingerprint[]>();
  const noisyOf = (q: number): FrameFingerprint[] => {
    let got = noisyRuns.get(q);
    if (got === undefined) {
      got = touched.includes(q)
        ? runPrints(fastRun(rc.bank, c, q, photos), q)
        : twinPrints(rc, c).slice(q * FRAMES_PER_RUN, (q + 1) * FRAMES_PER_RUN);
      noisyRuns.set(q, got);
    }
    return got;
  };
  const noisyPrint = (j: number): FrameFingerprint =>
    noisyOf(Math.floor(j / FRAMES_PER_RUN))[j % FRAMES_PER_RUN];

  const evaluate = (
    footing: 'content' | 'filed',
  ): { runs: RunScore[]; best: IndexingResult; bestOutcomes: RunOutcome10[] } => {
    const observations = oracleObservations(photos, footing);
    const bookends = indexByBookends(observations, EXPECTED).assignment;
    const r0 = indexByFingerprint(observations, fps0, EXPECTED);
    const out0 = runVerdicts(r0, photos, twin.placedContent, { observations, fingerprints: fps0 });
    const starts = Array.from({ length: PROJECTORS }, (_, p) =>
      bookends.indexOf(p * FRAMES_PER_RUN),
    );
    const w0: (number | null | 'x')[] = starts.map((start) =>
      start < 0 ? 'x' : worstOf(pairResiduals(fps0.slice(start, start + FRAMES_PER_RUN))),
    );
    const noisy = new Set<number>();
    for (let p = 0; p < PROJECTORS; p++) {
      const w = w0[p];
      if (cell.mode === 'noisy') noisy.add(p);
      // A run the twin refuses anyway is left on its noiseless verdict: no
      // position or capture category reads a run that is not attributable, so
      // re-evaluating it — an invisible run's residual is null noiseless, and
      // every such run would qualify — costs a noisy render and decides nothing.
      else if (!twin.placedContent.includes(p)) continue;
      else if (inBand(w, twin.runs[p].noiseFloor, REFINE_CEILING)) noisy.add(p);
    }
    let rN: IndexingResult | null = null;
    let outN: RunOutcome10[] | null = null;
    if (noisy.size > 0) {
      let fpsN: FrameFingerprint[];
      if (cell.mode === 'noisy') {
        fpsN = photos.map((_, j) => noisyPrint(j));
      } else {
        fpsN = fps0.slice();
        for (const p of noisy) {
          if (starts[p] < 0) continue;
          for (let f = 0; f < FRAMES_PER_RUN; f++) fpsN[starts[p] + f] = noisyPrint(starts[p] + f);
        }
      }
      rN = indexByFingerprint(observations, fpsN, EXPECTED);
      outN = runVerdicts(rN, photos, twin.placedContent, { observations, fingerprints: fpsN });
    }
    const runs: RunScore[] = out0.map((o, p) => {
      const n = outN !== null && noisy.has(p) ? outN[p] : null;
      return {
        o0: o.outcome,
        on: n === null ? null : n.outcome,
        pt0: o.phaseTouched,
        ptn: n === null ? null : n.phaseTouched,
        fa0: o.falseAlarm,
        fan: n === null ? null : n.falseAlarm,
        co0: o.collateral,
        con: n === null ? null : n.collateral,
        bp: PAIR_INDEX((n ?? o).brokenPair),
        w0: w0[p],
      };
    });
    const bestOutcomes = out0.map((o, p) => (outN !== null && noisy.has(p) ? outN[p] : o));
    return { runs, best: rN ?? r0, bestOutcomes };
  };

  const content = evaluate('content');
  const filed = evaluate('filed');
  const placedTouched = touched.filter((p) => content.bestOutcomes[p].outcome === 'placed');
  const decodes =
    cell.decode === 'all'
      ? placedTouched.map((p) =>
          decodeOne(
            rc,
            c,
            p,
            photos,
            content.best.assignment,
            content.bestOutcomes[p].phaseTouched,
          ),
        )
      : [];
  return {
    pos: c,
    flagged,
    changed: true,
    touched,
    content: content.runs,
    filed: filed.runs,
    assignment: placedTouched.length > 0 ? content.best.assignment : null,
    page: pageColumn ? pagePath(rc, c, photos, touched) : null,
    decodes,
  };
}

/**
 * The evaluation that decides a run, for every purpose: its noisy verdict where
 * the stage computed one, its noiseless verdict elsewhere.
 *
 * "Where the stage computed one" is the refine band at its widest. A `noisy`
 * cell (R1) evaluates every run with noise. A `refine` cell evaluates with noise
 * the attributable runs whose noiseless worst pair lies within
 * {@link REFINE_CEILING} of the limit, and no others (see {@link scorePosition}).
 * Every choice a stage makes reads a run through this function and nothing
 * else: the runs a decode subsample draws from, the captures a lateness cell
 * solves, the positions a solve straddles and the pairs it withholds. So does
 * every category and tally the document reports.
 *
 * It is one function because two bands were once in use. The stages chose by
 * this one, while the document classified the refine cells at the narrower
 * margin R1 had validated (0.01 in quick). A solved capture's straddle or
 * exclusions could then disagree with the category it was reported under. The
 * narrower margins survive only as the diagnostic that shows this band is
 * sound: the refined verdict against the fully noisy one on R1, margin by
 * margin (the document's `rescore.refine`).
 */
export function deciding(run: RunScore): {
  noisy: boolean;
  outcome: RunOutcomeKind;
  phaseTouched: boolean;
  collateral: boolean;
  falseAlarm: boolean;
} {
  if (run.on === null) {
    return {
      noisy: false,
      outcome: run.o0,
      phaseTouched: run.pt0,
      collateral: run.co0,
      falseAlarm: run.fa0,
    };
  }
  return {
    noisy: true,
    outcome: run.on,
    phaseTouched: run.ptn as boolean,
    collateral: run.con as boolean,
    falseAlarm: run.fan as boolean,
  };
}

/** A position's outcomes on its deciding evaluation, rebuilt for the library's own classifiers. */
export function outcomesOf(
  score: PositionScore,
  footing: 'content' | 'filed',
  twin: TwinCamera,
): RunOutcome10[] {
  const runs = footing === 'content' ? score.content : score.filed;
  return runs.map((r, p) => {
    const d = deciding(r);
    return {
      projector: p,
      touched: score.touched.includes(p),
      attributable: twin.placedContent.includes(p),
      phaseTouched: d.phaseTouched,
      outcome: d.outcome,
      brokenPair: null,
      brokenPercent: null,
      brokenResidual: null,
      collateral: d.collateral,
      falseAlarm: d.falseAlarm,
    };
  });
}

/** The position's category, or UNTOUCHED / UNCHANGED for one no photograph of which changed. */
export function categoryOf(
  score: PositionScore,
  footing: 'content' | 'filed',
  twin: TwinCamera,
  excludeMinorMarginal: boolean,
): PositionCategory {
  if (!score.changed) return score.flagged ? 'UNCHANGED' : 'UNTOUCHED';
  return classifyPosition(outcomesOf(score, footing, twin), twinStatus(twin), {
    exp9Flagged: score.flagged,
    excludeMinorMarginal,
  });
}

/**
 * Whether a run's noiseless worst pair `w0` lies within `margin` of the limit:
 * in `[limit - b - margin, limit + margin]`, where b is its twin's noise floor
 * (asymmetric, because noise only raises a residual), or unanswered (null). A
 * run the bookends refused ('x') is in no band.
 *
 * The stage re-evaluates a refine cell's runs with noise inside the band at
 * {@link REFINE_CEILING}, and the document's diagnostic asks the same question
 * of narrower margins. It is one statement of the band for both.
 */
export function inBand(w0: number | null | 'x', noiseFloor: number | null, margin: number): boolean {
  if (w0 === 'x') return false;
  if (w0 === null) return true;
  const b = Math.max(0, noiseFloor ?? 0);
  return w0 >= COMPLEMENT_LIMIT - b - margin && w0 <= COMPLEMENT_LIMIT + margin;
}

export interface ScoreUnit {
  /** Touched captures per cell: any position EXPERIMENT-9 flagged or any photograph changed. */
  cells: Record<string, CaptureScore[]>;
}

function scoreCells(
  ctx: RunContext,
  rc: RigContext,
  cells: readonly CellSpec[],
  which: 'main' | 'spill',
  k: number,
  pageColumn: boolean,
): ScoreUnit {
  const out: ScoreUnit = { cells: {} };
  for (const cell of cells) {
    if (cell.which !== which) continue;
    const t0 = Date.now();
    const captures: CaptureScore[] = [];
    for (let t = 0; t < cell.trials; t++) {
      if (rigOfTrial(ctx.plan, which, t) !== k) continue;
      const shots = cellShots(cell, t);
      const positions: PositionScore[] = [];
      let touched = false;
      const photosOf: Photo[][] = [];
      for (let pos = 0; pos < POSITIONS; pos++) {
        const photos = cellPhotos(cell, shots, t, pos, rc.bank.height);
        photosOf.push(photos);
        const flagged = shots.some(
          (s) => s.position === pos && straddles(s.open, cell.exposureS, DWELL_S),
        );
        if (flagged || photos.some(contentChanged)) touched = true;
      }
      if (!touched) continue;
      for (let pos = 0; pos < POSITIONS; pos++) {
        const flagged = shots.some(
          (s) => s.position === pos && straddles(s.open, cell.exposureS, DWELL_S),
        );
        positions.push(scorePosition(rc, pos, photosOf[pos], flagged, cell, pageColumn));
      }
      captures.push({ t, rig: k, positions });
    }
    out.cells[cell.id] = captures;
    const changed = captures.flatMap((c) => c.positions).filter((p) => p.changed).length;
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    ctx.log(
      `    ${cell.id} rig ${k}: ${captures.length} touched captures, ` +
        `${changed} changed positions, ${seconds} s`,
    );
  }
  return out;
}

/**
 * Runs the decode subsample takes, chosen by this experiment's named stream from every placed
 * touched run of the cell.
 */
function decodeSelection(
  cell: CellSpec,
  units: readonly ScoreUnit[],
  size: number,
): { t: number; rig: number; pos: number; projector: number }[] {
  const pool: { t: number; rig: number; pos: number; projector: number; key: number }[] = [];
  const seed = subsampleSeed(cell.id);
  for (const u of units) {
    for (const cap of u.cells[cell.id] ?? []) {
      for (const pos of cap.positions) {
        if (pos.assignment === null) continue;
        pos.content.forEach((r, p) => {
          if (pos.touched.includes(p) && deciding(r).outcome === 'placed') {
            pool.push({
              t: cap.t,
              rig: cap.rig,
              pos: pos.pos,
              projector: p,
              key: deriveSeed(seed, `${cap.t}/${pos.pos}/${p}`),
            });
          }
        });
      }
    }
  }
  return pool
    .sort((a, b) => a.key - b.key || a.t - b.t || a.pos - b.pos || a.projector - b.projector)
    .slice(0, size)
    .map(({ t, rig, pos, projector }) => ({ t, rig, pos, projector }));
}

export interface DecodeSample {
  cell: string;
  t: number;
  pos: number;
  decode: RunDecode;
}

/** Pass B: the subsample's decodes, rig by rig. */
function decodeSamples(
  ctx: RunContext,
  rc: RigContext,
  cells: readonly CellSpec[],
  passA: Record<string, ScoreUnit>,
  which: 'main' | 'spill',
  k: number,
): DecodeSample[] {
  const out: DecodeSample[] = [];
  for (const cell of cells) {
    if (cell.decode !== 'subsample' || cell.which !== which) continue;
    const units = Object.entries(passA)
      .filter(([key]) => key.startsWith(`A:${which}:`))
      .map(([, u]) => u);
    for (const pick of decodeSelection(cell, units, ctx.plan.decodeSubsample)) {
      if (pick.rig !== k) continue;
      const cap = passA[`A:${which}:${k}`].cells[cell.id].find((x) => x.t === pick.t);
      const score = cap?.positions[pick.pos];
      if (score === undefined || score.assignment === null)
        throw new Error(`experiment10: ${cell.id} lost trial ${pick.t}`);
      const photos = cellPhotos(cell, cellShots(cell, pick.t), pick.t, pick.pos, rc.bank.height);
      const run = score.content[pick.projector];
      out.push({
        cell: cell.id,
        t: pick.t,
        pos: pick.pos,
        decode: decodeOne(
          rc,
          pick.pos,
          pick.projector,
          photos,
          score.assignment,
          deciding(run).phaseTouched,
        ),
      });
    }
  }
  return out;
}

/**
 * Every solve already on record: `solves.jsonl`, checked line by line against
 * this build.
 *
 * Only whole lines are read, and a line is whole once its newline is written.
 * Pose, rescore and lateness may run as separate processes, and one of them
 * can start, and read this file, while another is appending to it. Each
 * append is a single write, so lines never interleave. A read can still land
 * in the middle of a write, though. With three processes appending and a
 * fourth calling this function, 2 of 385,621 reads saw a cut-off last line,
 * and `JSON.parse` stopped the stage that was starting. An unfinished last
 * line is therefore another process's write in progress, and it is left for
 * the next read. At worst this process solves that id again, and the two
 * lines must then agree.
 */
export function loadSolves(ctx: RunContext): void {
  const text = ctx.store.read('solves.jsonl');
  if (text === null) return;
  const whole = text.slice(0, text.lastIndexOf('\n') + 1);
  for (const line of whole.split('\n')) {
    if (line.trim() === '') continue;
    const rec = JSON.parse(line) as SolveRecord;
    checkRecord(ctx, `solves.jsonl (${rec.id})`, rec);
    const had = ctx.solves.get(rec.id);
    if (had !== undefined) {
      // Two processes can solve the same twin side by side. Both are the same
      // deterministic solve, so the lines must agree; if they do not, something
      // in the solve path is not deterministic, and every paired number is off.
      if (JSON.stringify(had) !== JSON.stringify(rec))
        throw new Error(`experiment10: solves.jsonl holds two different records for ${rec.id}`);
      continue;
    }
    ctx.solves.set(rec.id, rec);
  }
}

/**
 * The pairs the page would not decode on the clean capture: every run the twin refuses, on every
 * camera.
 */
function cleanRefused(rc: RigContext): string[] {
  const out: string[] = [];
  for (const c of rc.bank.cameras) {
    const twin = twinOf(rc, c);
    for (let p = 0; p < PROJECTORS; p++) if (!twin.placedContent.includes(p)) out.push(`${c}.${p}`);
  }
  return out.sort();
}

function excludePairs(exclude: readonly string[]): { camera: number; projector: number }[] {
  return exclude.map((x) => {
    const [camera, projector] = x.split('.').map(Number);
    return { camera, projector };
  });
}

/** Straddles on several cameras at once, each camera's its own: the renderer asks by camera. */
function combined(byCamera: Map<number, ShutterStraddle>): ShutterStraddle {
  return { parts: (c, p, f, row) => byCamera.get(c)?.parts(c, p, f, row) ?? null };
}

interface AuditPlan {
  camera: number;
  photos: readonly Photo[];
  assignment: readonly (number | null)[] | null;
}

/**
 * D_grid: `computeGridDisplacement` with the TWIN's aligned rig as the
 * physical one and the treated as the content, as the spec writes it (§3.8).
 * Twin and treated share the noise stream and the solve seeds, so this is the
 * straddle's own effect on the seams.
 */
function gridBetween(
  bank: RigBank,
  twinRig: RigCalibration,
  treatedRig: RigCalibration,
): Omit<NonNullable<SolveRecord['against']>, 'twinId' | 'positionShiftMm'> {
  const report = computeGridDisplacement(
    twinRig,
    treatedRig,
    bank.world.scene.maskInterpretation,
    gateById(GATES, 'grid_displacement'),
    { convergence: false, measurementFloor: false },
    bank.preset.metricDensityScale,
  );
  return {
    dGridMm: report.metric.value,
    p95Mm: report.metric.detail.p95Mm ?? null,
    rmsMm: report.metric.detail.rmsMm ?? null,
    censored: report.metric.censored,
  };
}

/**
 * Camera `camera`'s pairs as a re-shoot under capture seed `seed` photographs
 * them: the whole rig rendered with `runScenario`'s own capture options under
 * that seed, and that camera's captures kept, frames and all. So they are the
 * very pairs a whole-capture re-shoot under `seed` decodes for that camera.
 *
 * The whole rig, not the one camera. A pair's noise stream is named by its
 * camera's index among the cameras rendered (`pairNoiseSeed`), and rendered
 * alone, camera 2 would draw camera 0's stream.
 */
export function reshotPairs(
  bank: RigBank,
  camera: number,
  seed: number,
): Map<number, PatternCapture> {
  const kept = new Map<number, PatternCapture>();
  const options = captureOptionsFor(
    bank.world,
    bank.scenario,
    { ...runOptionsFor(bank), captureSeed: seed },
    PLAN,
  );
  captureAndDecode(bank.world.truthRig, bank.world.cameras, {
    ...options,
    onCapture: (c, p, capture) => {
      if (c === camera) kept.set(p, capture);
    },
  });
  if (kept.size !== PROJECTORS) {
    throw new Error(
      `experiment10: re-shooting camera ${camera} rendered ${kept.size} of its pairs`,
    );
  }
  return kept;
}

/** Everything about a capture but its frames: which pair, and the sequences' layout. */
function captureShape(x: PatternCapture): string {
  return JSON.stringify([
    x.camera,
    x.projector,
    x.projectorRes,
    x.white !== null,
    x.black !== null,
    x.gray.map((g) => [g.axis, g.bits, g.stridePx, g.patterns.length, g.inverses.length]),
    x.phase.map((q) => [q.axis, q.steps, q.periodPx, q.frames.length]),
  ]);
}

/**
 * The `onCapture` of a one-position re-shoot: as each of camera `camera`'s pairs
 * is rendered, its frames are replaced by the re-shoot's ({@link reshotPairs})
 * before anything decodes them. Every other camera keeps the capture it was
 * rendered with.
 *
 * `capture.ts` hands `onCapture` the capture about to be decoded and says that
 * a callback changing it would change the decode (`CaptureOptions.onCapture`).
 * That is used here on purpose. It is the one way to merge one position's
 * re-shoot into a capture without editing the bench and without a second
 * statement of `runScenario`'s solve. `straddle.test.ts` holds the merged
 * capture to the two it merges, pair for pair.
 */
export function swapInReshoot(
  camera: number,
  reshot: ReadonlyMap<number, PatternCapture>,
): (c: number, p: number, capture: PatternCapture) => void {
  return (c, p, capture) => {
    if (c !== camera) return;
    const from = reshot.get(p);
    if (from === undefined || captureShape(from) !== captureShape(capture)) {
      throw new Error(
        `experiment10: the re-shoot of camera ${camera} has no pair like (${c}, ${p})`,
      );
    }
    capture.white = from.white;
    capture.black = from.black;
    capture.gray = from.gray;
    capture.phase = from.phase;
  };
}

/**
 * The options `runScenario` is handed for one solve, less its `onCapture`: the
 * bank's own, the pairs the spec withholds, and a whole-capture re-shoot's
 * capture seed. A position re-shoot is handed NO capture seed: it photographs
 * the scenario's own capture and swaps its one camera in as it is rendered
 * ({@link swapInReshoot}). Handed its seed, it would re-shoot every camera and
 * be a whole-capture null under another name.
 *
 * Throws on a spec that names a re-shot camera without being a position
 * re-shoot, or the reverse, or a position re-shoot with no seed to re-shoot at.
 */
export function solveRunOptions(bank: RigBank, spec: SolveSpec): RunOptions {
  const position = spec.kind === 'position-null';
  if (position !== (spec.reshotCamera !== undefined) || (position && spec.captureSeed === null)) {
    throw new Error(
      `experiment10: ${solveId(spec)} names a re-shot camera without being a position ` +
        're-shoot, or the reverse',
    );
  }
  return {
    ...runOptionsFor(bank),
    excludePairs: excludePairs(spec.exclude),
    ...(spec.captureSeed === null || position ? {} : { captureSeed: spec.captureSeed }),
  };
}

/**
 * One solve through `runScenario`, or the record of it when it is already on
 * disk. The scenario is the bank's own — the rig the frames were rendered
 * from — with only `degradation.straddle` set, so there is no second statement
 * of how a rig is built for the solve to drift from.
 *
 * A `position-null` photographs the scenario's own capture and swaps its one
 * re-shot camera's pairs in as they are rendered ({@link swapInReshoot}).
 */
function solveOnce(
  ctx: RunContext,
  bank: RigBank,
  spec: SolveSpec,
  straddle: ShutterStraddle | null,
  audits: readonly AuditPlan[],
  twin: SolveRecord | null,
): SolveRecord {
  const id = solveId(spec);
  const cached = ctx.solves.get(id);
  if (cached !== undefined) return cached;
  const t0 = Date.now();
  const options = solveRunOptions(bank, spec);
  const swap =
    spec.reshotCamera === undefined || spec.captureSeed === null
      ? null
      : swapInReshoot(spec.reshotCamera, reshotPairs(bank, spec.reshotCamera, spec.captureSeed));
  const scenario = { ...bank.scenario, degradation: { ...bank.scenario.degradation, straddle } };
  const rendered = new Map<string, FrameFingerprint[]>();
  const result = runScenario(scenario, {
    ...options,
    onCapture:
      audits.length === 0 && swap === null
        ? null
        : (c, p, capture) => {
            swap?.(c, p, capture);
            if (audits.some((a) => a.camera === c))
              rendered.set(`${c}:${p}`, runPrints(planOrder(capture), p));
          },
  });
  let audit: SolveRecord['audit'] = null;
  if (audits.length > 0) {
    audit = { runs: 0, agree: 0, disagreements: [] };
    for (const a of audits) {
      for (let p = 0; p < PROJECTORS; p++) {
        const got = rendered.get(`${a.camera}:${p}`);
        if (got === undefined)
          throw new Error(`experiment10: ${id} never rendered pair (${a.camera}, ${p})`);
        const solved = runPlaced(pairResiduals(got));
        const fast = runPlaced(
          pairResiduals(runPrints(fastRun(bank, a.camera, p, a.photos, a.assignment), p)),
        );
        audit.runs++;
        if (solved === fast) audit.agree++;
        else
          audit.disagreements.push(
            `camera ${a.camera} run ${p + 1}: rendered ${solved ? 'placed' : 'refused'}, ` +
              `fast path ${fast ? 'placed' : 'refused'}`,
          );
      }
    }
  }
  const grid = result.metrics?.metrics.find((m) => m.id === 'grid_displacement') ?? null;
  const record: SolveRecord = {
    schema: CHECKPOINT_SCHEMA,
    fingerprint: ctx.fingerprint,
    id,
    spec,
    error: result.error,
    alignedRig: result.alignedRig,
    gridMm: grid === null ? null : grid.value,
    gridCensored: grid === null ? null : grid.censored,
    rotationDeg: result.recovery === null ? null : result.recovery.aligned.maxRotationDeg,
    correspondences: result.capture.correspondences.filter(
      (x) => !spec.exclude.includes(`${x.camera}.${x.projector}`),
    ).length,
    audit,
    against: null,
  };
  if (twin !== null && twin.alignedRig !== null && record.alignedRig !== null) {
    const a = twin.alignedRig;
    const b = record.alignedRig;
    const shift = Math.max(
      ...a.projectors.map((q, i) => {
        const r = b.projectors[i].pose.position;
        return (
          1000 *
          Math.hypot(r.x - q.pose.position.x, r.y - q.pose.position.y, r.z - q.pose.position.z)
        );
      }),
    );
    record.against = { twinId: twin.id, ...gridBetween(bank, a, b), positionShiftMm: shift };
  }
  ctx.solves.set(id, record);
  ctx.store.append('solves.jsonl', JSON.stringify(record));
  ctx.log(
    `      solve ${id}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ` +
      `grid ${record.gridMm?.toFixed(3) ?? '-'} mm` +
      (record.against === null ? '' : `, D_grid ${record.against.dGridMm.toFixed(3)} mm`) +
      (record.error === null ? '' : `, ERROR ${record.error}`),
  );
  return record;
}

// ---------------------------------------------------------------------------
// pose — designed straddles, solved
// ---------------------------------------------------------------------------

export interface PoseLevel {
  label: string;
  direction: 'forward' | 'backward';
  s: number;
  readoutOverExposure: number;
  /** Runs of the straddled camera the isolated check refuses on the fast path's noisy frames. */
  refused: number[];
  allRefused: boolean;
  treated: string | null;
  twin: string | null;
}

export interface PoseUnit {
  rig: number;
  camera: number;
  plain: string;
  levels: PoseLevel[];
  /** Whole-capture re-shoots: every camera photographed again under `nullSeed(rig, i)`. */
  nulls: string[];
  /**
   * One-position re-shoots: only the straddled camera photographed again, under
   * the same seeds, so its pairs are exactly the whole re-shoots' and the two
   * yardsticks differ by the other cameras alone.
   */
  positionNulls: string[];
}

/**
 * The re-shoots designed rig `k` is measured against, `kNull` of each: whole
 * captures, every camera photographed again under `nullSeed(k, i)`; and the
 * straddled position alone, the rig's straddled camera photographed again under
 * the SAME seeds, so its pairs are exactly the whole re-shoots' and the two
 * yardsticks differ by the other cameras alone. Both withhold what the clean
 * capture refuses, as the plain twin they are measured against does.
 */
export function nullSpecs(
  k: number,
  variant: RigVariant,
  refusedClean: readonly string[],
  kNull: number,
): { whole: SolveSpec[]; position: SolveSpec[] } {
  const camera = straddledCamera(k);
  const base = { rig: k, variant, straddle: 'none', exclude: [...refusedClean] };
  return {
    whole: Array.from({ length: kNull }, (_, i) => ({
      ...base,
      kind: 'null' as const,
      captureSeed: nullSeed(k, i),
    })),
    position: Array.from({ length: kNull }, (_, i) => ({
      ...base,
      kind: 'position-null' as const,
      captureSeed: nullSeed(k, i),
      reshotCamera: camera,
    })),
  };
}

/**
 * Every re-shoot of {@link nullSpecs}, solved against the rig's plain twin: the
 * whole captures' ids, and the position re-shoots'. Exported so a test can hold
 * which list is which with every solve already on record.
 */
export function solveNulls(
  ctx: RunContext,
  bank: RigBank,
  specs: { whole: readonly SolveSpec[]; position: readonly SolveSpec[] },
  plain: SolveRecord,
): { nulls: string[]; positionNulls: string[] } {
  return {
    nulls: specs.whole.map((spec) => solveOnce(ctx, bank, spec, null, [], plain).id),
    positionNulls: specs.position.map((spec) => solveOnce(ctx, bank, spec, null, [], plain).id),
  };
}

export function stagePose(ctx: RunContext): StageFile<PoseUnit> | null {
  const { plan } = ctx;
  if (!plan.pose) {
    ctx.log('  pose: not run by this plan');
    return null;
  }
  const bankFile = needStage<BankUnit>(ctx, 'bank');
  loadSolves(ctx);
  return runUnits<PoseUnit>(
    ctx,
    'pose',
    plan.designedRigs.map((k) => unitKey('main', k)),
    (unit) => {
      const { k } = parseUnit(unit);
      const rc = rigContext(ctx, unit, bankFile);
      const { bank } = rc;
      const c = straddledCamera(k);
      const variant = variantOf(plan, 'main');
      const refusedClean = cleanRefused(rc);
      const plain = solveOnce(
        ctx,
        bank,
        {
          kind: 'twin',
          rig: k,
          variant,
          straddle: 'none',
          exclude: refusedClean,
          captureSeed: null,
        },
        null,
        [],
        null,
      );
      const arms: {
        label: string;
        direction: 'forward' | 'backward';
        s: number;
        ratio: number;
        photos: Photo[];
      }[] = [
        ...plan.poseLevels.forward.map((s) => ({
          label: `forward/${s}`,
          direction: 'forward' as const,
          s,
          ratio: 0,
          photos: designedPhotos('forward', () => s, 1),
        })),
        ...plan.poseLevels.backward.map((s) => ({
          label: `backward/${s}`,
          direction: 'backward' as const,
          s,
          ratio: 0,
          photos: designedPhotos('backward', () => s, 1),
        })),
        ...plan.poseLevels.rolling.midRow.map((s) => {
          const ratio = plan.poseLevels.rolling.readoutOverExposure;
          return {
            label: `rolling/${ratio}/${s}`,
            direction: 'forward' as const,
            s,
            ratio,
            photos: designedPhotos('forward', rollingSmear(s, ratio, bank.height), bank.height),
          };
        }),
      ];
      const twin = twinOf(rc, c);
      const levels: PoseLevel[] = [];
      for (const arm of arms) {
        const prints: FrameFingerprint[] = [];
        for (let p = 0; p < PROJECTORS; p++)
          prints.push(...runPrints(fastRun(bank, c, p, arm.photos), p));
        const verdict = isolatedCheck(prints, arm.photos, 'content');
        const refused = Array.from({ length: PROJECTORS }, (_, p) => p).filter(
          (p) => !verdict.usableProjectors.includes(p),
        );
        const allRefused = twin.placedContent.every((p) => refused.includes(p));
        const level: PoseLevel = {
          label: arm.label,
          direction: arm.direction,
          s: arm.s,
          readoutOverExposure: arm.ratio,
          refused,
          allRefused,
          treated: null,
          twin: null,
        };
        if (!allRefused) {
          const exclude = [
            ...new Set([...refusedClean, ...refused.map((p) => `${c}.${p}`)]),
          ].sort();
          const twinX =
            exclude.join() === refusedClean.join()
              ? plain
              : solveOnce(
                  ctx,
                  bank,
                  { kind: 'twin', rig: k, variant, straddle: 'none', exclude, captureSeed: null },
                  null,
                  [],
                  null,
                );
          const treated = solveOnce(
            ctx,
            bank,
            {
              kind: 'designed',
              rig: k,
              variant,
              straddle: `c${c}/${arm.label}`,
              exclude,
              captureSeed: null,
            },
            straddleForCamera(c, arm.photos, null),
            [{ camera: c, photos: arm.photos, assignment: null }],
            twinX,
          );
          level.treated = treated.id;
          level.twin = twinX.id;
        }
        levels.push(level);
      }
      // Two yardsticks. The whole-capture re-shoots renew every camera's
      // photons. A straddled position is what an operator would re-shoot, so
      // re-shooting that position alone is how far the seams move when the
      // remedy is applied and nothing was wrong; the first full run's verdict
      // set the straddle against the whole-capture re-shoots alone.
      const { nulls, positionNulls } = solveNulls(
        ctx,
        bank,
        nullSpecs(k, variant, refusedClean, plan.kNull),
        plain,
      );
      return { rig: k, camera: c, plain: plain.id, levels, nulls, positionNulls };
    },
  );
}

// ---------------------------------------------------------------------------
// The capture solves of the rescored cells
// ---------------------------------------------------------------------------

export interface CaptureSolve {
  cell: string;
  t: number;
  rig: number;
  /** Policy A: PLACED and MIXED positions straddled, the MIXED ones' refused runs withheld. */
  a: { treated: string; twin: string } | null;
  /** Policy P: only PLACED positions straddled; the refused ones re-shot clean. */
  p: { treated: string; twin: string } | null;
  /**
   * P's plan is A's (see {@link solvePlan}), so P's pair is A's solve: the same
   * ids, not a second solve of the same thing.
   */
  pIsA: boolean;
}

/** What one policy renders and withholds for one capture. */
export interface CapturePlan {
  /** Positions rendered straddled, ascending. Every other position is rendered clean. */
  positions: number[];
  /** Pairs withheld from the treated solve and from its twin alike, as `camera.projector`, sorted. */
  exclude: string[];
}

/**
 * Which positions a policy straddles, and which pairs it withholds.
 *
 * Policy P straddles the PLACED positions and re-shoots every other position
 * clean. Policy A also keeps a MIXED position's placed runs. Withheld, from the
 * treated solve and its twin alike, are two kinds of pair. First, every pair the
 * clean capture refuses (`refusedClean`, the twin's refusals on every camera).
 * Second, every run of a straddled position whose deciding outcome is not
 * `placed`, because the page would not decode it.
 *
 * The second kind means every such run, where §6 R1 of the spec withheld only a
 * MIXED position's refused runs. A collateral refusal is an untouched,
 * attributable run that the page refuses because a neighbour's slip moved the
 * bookends, and it can sit inside a PLACED position. Under the spec's rule the
 * treated solve was still handed that run, rendered clean. The page decodes
 * nothing of a refused run, so this is the amendment the document's caveats
 * record. The twin withholds the run too, so the pair still differs by the
 * straddle and nothing else.
 *
 * Categories and outcomes are read through {@link deciding}, the evaluation
 * the document reports them by. Null when the policy straddles nothing, which
 * leaves nothing silent to solve.
 */
export function capturePlan(
  cap: CaptureScore,
  twinAt: (camera: number) => TwinCamera,
  policy: 'A' | 'P',
  refusedClean: readonly string[],
): CapturePlan | null {
  const exclude = new Set(refusedClean);
  const positions: number[] = [];
  for (const pos of cap.positions) {
    const twin = twinAt(pos.pos);
    const cat = categoryOf(pos, 'content', twin, false);
    if (!(cat === 'PLACED' || (policy === 'A' && cat === 'MIXED'))) continue;
    positions.push(pos.pos);
    for (const o of outcomesOf(pos, 'content', twin))
      if (o.outcome !== 'placed') exclude.add(`${pos.pos}.${o.projector}`);
  }
  if (positions.length === 0) return null;
  return { positions: positions.sort((x, y) => x - y), exclude: [...exclude].sort() };
}

/**
 * The solves a capture takes under the policies a cell asks for.
 *
 * P's plan is A's whenever the capture has no MIXED position: the same
 * positions straddled and the same pairs withheld, hence the same solve id. P
 * then borrows A's solve, `pIsA`, whether or not the cell asked for P. The
 * lateness cell solves under A alone, and without the borrow every one of its
 * SILENT captures, which by definition hold no MIXED position, was reported
 * under P as SILENT-UNSOLVED beside the very solve that answered it. Where the
 * plans differ, P is solved only if it was asked for, and is otherwise
 * unsolved.
 */
export function solvePlan(
  cap: CaptureScore,
  twinAt: (camera: number) => TwinCamera,
  refusedClean: readonly string[],
  policies: readonly ('A' | 'P')[],
): { a: CapturePlan | null; p: CapturePlan | null; pIsA: boolean } {
  const a = policies.includes('A') ? capturePlan(cap, twinAt, 'A', refusedClean) : null;
  const p = capturePlan(cap, twinAt, 'P', refusedClean);
  const pIsA = a !== null && p !== null && JSON.stringify(a) === JSON.stringify(p);
  return { a, p: policies.includes('P') && !pIsA ? p : null, pIsA };
}

/**
 * Each policy's answer, given a capture's plans ({@link solvePlan}) and a way
 * to solve one plan: A's plan solved once, and P given A's own answer where
 * `pIsA`, its own solve where it has a plan of its own, and nothing otherwise.
 *
 * This is where the borrow is applied, and it is a function of its own so a
 * test can hold it without solving anything. Written inline in
 * `solveCapture`, the application sat below every test: with `pIsA` decided
 * correctly and then not applied, a lateness cell's SILENT captures went back
 * to SILENT-UNSOLVED under P, beside the very solve that answers them, and
 * nothing failed.
 */
export function policyAnswers<T>(
  plans: { a: CapturePlan | null; p: CapturePlan | null; pIsA: boolean },
  solve: (plan: CapturePlan) => T,
): { a: T | null; p: T | null } {
  const a = plans.a === null ? null : solve(plans.a);
  const p = plans.pIsA ? a : plans.p === null ? null : solve(plans.p);
  return { a, p };
}

/**
 * Solve one scored capture under the policies asked for. Every position is
 * rendered from the same timing the score came from, straddled with the
 * content footing's assignment — the photographs the page would decode — and
 * the pairs the page would not decode are withheld from the solve
 * ({@link capturePlan}).
 *
 * Exported for `straddle.test.ts`, which answers every solve it asks for from
 * a filled `ctx.solves`, so the policies' wiring is held without a solve.
 */
export function solveCapture(
  ctx: RunContext,
  rc: RigContext,
  cell: CellSpec,
  cap: CaptureScore,
  policies: readonly ('A' | 'P')[],
): CaptureSolve {
  const { bank } = rc;
  const variant = variantOf(ctx.plan, cell.which);
  const shots = cellShots(cell, cap.t);
  const refusedClean = cleanRefused(rc);
  const plans = solvePlan(cap, (c) => twinOf(rc, c), refusedClean, policies);
  const plainSpec: SolveSpec = {
    kind: 'twin',
    rig: cap.rig,
    variant,
    straddle: 'none',
    exclude: refusedClean,
    captureSeed: null,
  };
  const solve = (plan: CapturePlan): { treated: string; twin: string } => {
    const byCamera = new Map<number, ShutterStraddle>();
    const audits: AuditPlan[] = [];
    for (const c of plan.positions) {
      const pos = cap.positions[c];
      const photos = cellPhotos(cell, shots, cap.t, c, bank.height);
      byCamera.set(c, straddleForCamera(c, photos, pos.assignment));
      audits.push({ camera: c, photos, assignment: pos.assignment });
    }
    const plain = solveOnce(ctx, bank, plainSpec, null, [], null);
    const twin =
      plan.exclude.join() === refusedClean.join()
        ? plain
        : solveOnce(ctx, bank, { ...plainSpec, exclude: plan.exclude }, null, [], null);
    const treated = solveOnce(
      ctx,
      bank,
      {
        kind: 'capture',
        rig: cap.rig,
        variant,
        straddle: `${cell.id}/t${cap.t}/[${plan.positions.join(',')}]`,
        exclude: plan.exclude,
        captureSeed: null,
      },
      combined(byCamera),
      audits,
      twin,
    );
    return { treated: treated.id, twin: twin.id };
  };
  const { a, p } = policyAnswers(plans, solve);
  return { cell: cell.id, t: cap.t, rig: cap.rig, a, p, pIsA: plans.pIsA };
}

// ---------------------------------------------------------------------------
// The rescore and lateness stages
// ---------------------------------------------------------------------------

export interface AuditCell {
  arm: string;
  phase: StartPhase;
  exposureS: number;
  trials: number;
  /**
   * `runTrial` on each replayed seed, reduced here ({@link recountCell}), field for field against
   * the committed cell.
   */
  recount: Record<string, number>;
  /**
   * The recount is EXPERIMENT-9's own `summarise` at this trial count. Always true: the audit
   * throws otherwise.
   */
  summarised: boolean;
  committed: Record<string, number> | null;
  equal: boolean;
  reconciliation: {
    photographs: number;
    straddled: number;
    phantoms: number;
    contentChanged: number;
    whollyWrong: number;
    endingInDark: number;
  };
}

/**
 * EXPERIMENT-9's summary of one cell, recounted from the shots this experiment
 * replays.
 *
 * Each trial is EXPERIMENT-9's own `runTrial`, run on the seed
 * {@link exp9TrialSeed} names. That is the seed every rescored cell draws its
 * shots under, so what the audit holds to the committed file is exactly the
 * replay the re-scoring uses. Only the reduction over trials is written here.
 * `summarise` draws its own seeds and cannot be handed these, and
 * {@link stageAudit} holds this reduction to `summarise` itself. The function
 * once restated `runTrial`'s accounting as well, and a copied reducer is how
 * this project has published numbers its code did not compute.
 */
export function recountCell(
  arm: Arm,
  phase: StartPhase,
  exposureS: number,
  trials: number,
): { recount: Record<string, number>; reconciliation: AuditCell['reconciliation'] } {
  const runsPerCapture = POSITIONS * PROJECTORS;
  const rec = {
    capturesTouched: 0,
    straddledTotal: 0,
    worstStraddled: 0,
    worstBurst: 0,
    runsTouchedTotal: 0,
    capturesAllRunsTouched: 0,
    positionsTouchedTotal: 0,
    capturesLosingAWholePosition: 0,
  };
  const recon = {
    photographs: 0,
    straddled: 0,
    phantoms: 0,
    contentChanged: 0,
    whollyWrong: 0,
    endingInDark: 0,
  };
  for (let t = 0; t < trials; t++) {
    const seed = exp9TrialSeed(arm, phase, DWELL_S, exposureS, t);
    const r = runTrial(arm, phase, DWELL_S, exposureS, seed);
    if (r.straddled > 0) rec.capturesTouched++;
    rec.straddledTotal += r.straddled;
    rec.worstStraddled = Math.max(rec.worstStraddled, r.straddled);
    rec.worstBurst = Math.max(rec.worstBurst, r.longestBurst);
    rec.runsTouchedTotal += r.runsTouched;
    if (r.runsTouched === runsPerCapture) rec.capturesAllRunsTouched++;
    rec.positionsTouchedTotal += r.positionsTouched;
    if (r.positionsLostEndToEnd > 0) rec.capturesLosingAWholePosition++;
    // What the same shots integrated, on the page's semantics: the library's
    // reconciliation, on the shots `runTrial` just counted.
    const shots = shotTimings(arm, phase, DWELL_S, seed);
    if (shots.length > 0) {
      const x = reconcileShots(shots, exposureS, DWELL_S);
      recon.photographs += x.photographs;
      recon.straddled += x.straddled;
      recon.phantoms += x.phantoms;
      recon.contentChanged += x.contentChanged;
      recon.whollyWrong += x.whollyWrong;
      recon.endingInDark += x.endingInDark;
    }
  }
  return { recount: rec, reconciliation: recon };
}

/**
 * The R audit: every EXPERIMENT-9 cell at D = 2 s, E = 1/4 s, and the headline
 * arm's other exposures, recounted from the replayed shots and held to
 * EXPERIMENT-9 twice. At any trial count, the recount must be `summarise`'s own
 * figures, EXPERIMENT-9's reducer on EXPERIMENT-9's seeds, which pins this
 * module's reduction and {@link exp9TrialSeed} to it. At EXPERIMENT-9's own
 * trial count, the recount must also be the committed cell in
 * `experiments/experiment-9.json`. Either mismatch throws, rather than
 * re-scoring shots EXPERIMENT-9 never drew.
 */
export function stageAudit(plan: Exp10Plan): AuditCell[] {
  const committedPath = path.join(ROOT, 'experiments', 'experiment-9.json');
  const committed = JSON.parse(fs.readFileSync(committedPath, 'utf8')) as {
    cells: Record<string, unknown>[];
  };
  const cells: { arm: Arm; phase: StartPhase; exposureS: number }[] = [];
  for (const arm of ARMS)
    for (const phase of DESIGN.START_PHASES) cells.push({ arm, phase, exposureS: EXPOSURE_S });
  const headline = armOf('intervalometer-100ppm');
  for (const exposureS of [SHORT_EXPOSURE_S, 1 / 8, 1 / 2])
    cells.push({ arm: headline, phase: 'uniform', exposureS });
  return cells.map(({ arm, phase, exposureS }) => {
    const { recount, reconciliation } = recountCell(arm, phase, exposureS, plan.auditTrials);
    const own = summarise(arm, phase, DWELL_S, exposureS, plan.auditTrials, EXP9_SEED_ROOT);
    const ownFields = own as unknown as Record<string, number>;
    const differing = Object.keys(recount).filter((f) => recount[f] !== ownFields[f]);
    if (differing.length > 0) {
      throw new Error(
        `experiment10: the recount of ${arm.key}/${phase}/${exposureS} is not EXPERIMENT-9's own ` +
          `summarise at ${plan.auditTrials} trials, in ${differing.join(', ')}: ` +
          `${JSON.stringify(recount)} against ${JSON.stringify(own)}`,
      );
    }
    const found = committed.cells.find(
      (c) =>
        c.key === arm.key &&
        c.startPhase === phase &&
        c.dwellS === DWELL_S &&
        c.exposureS === exposureS,
    );
    if (found === undefined)
      throw new Error(
        `experiment10: experiment-9.json has no cell ${arm.key}/${phase}/${exposureS}`,
      );
    const fields = Object.keys(recount);
    const theirs: Record<string, number> = {};
    for (const f of fields) theirs[f] = found[f] as number;
    // At EXPERIMENT-9's own trial count the recount must BE the committed cell.
    // A thinner plan cannot compare with the file, and says so.
    const comparable = plan.auditTrials === (found.trials as number);
    const equal = comparable && fields.every((f) => recount[f] === theirs[f]);
    if (comparable && !equal) {
      throw new Error(
        `experiment10: the replay of ${arm.key}/${phase}/${exposureS} is not EXPERIMENT-9's: ` +
          `${JSON.stringify(recount)} against ${JSON.stringify(theirs)}`,
      );
    }
    return {
      arm: arm.key,
      phase,
      exposureS,
      trials: plan.auditTrials,
      recount,
      summarised: true,
      committed: comparable ? theirs : null,
      equal,
      reconciliation,
    };
  });
}

export interface RescoreUnit {
  audit?: AuditCell[];
  timing?: TimingCell[];
  score?: ScoreUnit;
  samples?: DecodeSample[];
  solves?: CaptureSolve[];
}

/**
 * Rigs whose clean positions the page placed a run of in Q0: the contingency's
 * page column. One statement, read by the stage that runs the page column and
 * by the document that reports whether it ran; the assembly once kept its own
 * copy of this loop.
 */
export function pageColumnRigsOf(q0: StageFile<Q0Unit>): Set<string> {
  const out = new Set<string>();
  for (const [unit, u] of Object.entries(q0.units)) {
    if (u.positions.some((p) => p.runsPlaced.length > 0))
      out.add(unit.split(':').slice(0, 2).join(':'));
  }
  return out;
}

function pageColumnRigs(ctx: RunContext): Set<string> {
  return pageColumnRigsOf(needStage<Q0Unit>(ctx, 'q0'));
}

/**
 * Pass A scores every cell rig by rig; pass B decodes each cell's subsample
 * once every rig's scores are in, because the subsample is drawn from all of
 * them; pass S solves the captures the cells solve. Each unit checkpoints.
 */
function scoreStage(
  ctx: RunContext,
  stage: 'rescore' | 'lateness',
  cells: readonly CellSpec[],
  extra: (units: string[]) => void,
): StageFile<RescoreUnit> {
  const { plan } = ctx;
  const bankFile = needStage<BankUnit>(ctx, 'bank');
  const pageRigs = pageColumnRigs(ctx);
  loadSolves(ctx);
  const kinds: ('main' | 'spill')[] = cells.some((c) => c.which === 'spill')
    ? ['main', 'spill']
    : ['main'];
  const rigsOf = (which: 'main' | 'spill') => (which === 'main' ? plan.rigs : plan.spillRigs);
  const units: string[] = [];
  extra(units);
  for (const which of kinds) for (const k of rigsOf(which)) units.push(`A:${which}:${k}`);
  for (const which of kinds) for (const k of rigsOf(which)) units.push(`B:${which}:${k}`);
  const solving = cells.filter((c) => c.solve !== 'none');
  if (solving.length > 0) for (const k of plan.rigs) units.push(`S:main:${k}`);
  let held: RigContext | null = null;
  const rigFor = (which: 'main' | 'spill', k: number): RigContext => {
    const key = unitKey(which, k);
    if (held === null || held.unit !== key) {
      held = null;
      held = rigContext(ctx, key, bankFile);
    }
    return held;
  };
  return runUnits<RescoreUnit>(ctx, stage, units, (unit, file) => {
    if (unit === 'audit') return { audit: stageAudit(plan) };
    if (unit === 'timing') return { timing: latenessTiming(plan) };
    const [pass, which, kText] = unit.split(':') as ['A' | 'B' | 'S', 'main' | 'spill', string];
    const k = Number(kText);
    const passA: Record<string, ScoreUnit> = {};
    for (const [key, u] of Object.entries(file.units))
      if (key.startsWith('A:') && u.score !== undefined) passA[key] = u.score;
    if (pass === 'A') {
      const rc = rigFor(which, k);
      return { score: scoreCells(ctx, rc, cells, which, k, pageRigs.has(unitKey(which, k))) };
    }
    if (pass === 'B') {
      const wanted = cells.some(
        (cell) =>
          cell.decode === 'subsample' &&
          cell.which === which &&
          decodeSelection(
            cell,
            Object.entries(passA)
              .filter(([key]) => key.startsWith(`A:${which}:`))
              .map(([, u]) => u),
            plan.decodeSubsample,
          ).some((x) => x.rig === k),
      );
      if (!wanted) return { samples: [] };
      return { samples: decodeSamples(ctx, rigFor(which, k), cells, passA, which, k) };
    }
    // Pass S: the solves.
    const solves: CaptureSolve[] = [];
    for (const cell of solving) {
      const caps = passA[`A:main:${k}`]?.cells[cell.id] ?? [];
      if (cell.solve === 'policies') {
        for (const cap of caps) {
          const rc = rigFor('main', k);
          const cats = cap.positions.map((pos) =>
            categoryOf(pos, 'content', twinOf(rc, pos.pos), false),
          );
          if (!cats.some((x) => x === 'PLACED' || x === 'MIXED')) continue;
          solves.push(solveCapture(ctx, rc, cell, cap, ['A', 'P']));
        }
      } else {
        // The first captures in trial order, over every rig, with a PLACED or
        // MIXED position on the deciding evaluation.
        const all = Object.values(passA)
          .flatMap((u) => u.cells[cell.id] ?? [])
          .sort((a, b) => a.t - b.t);
        const picked: CaptureScore[] = [];
        for (const cap of all) {
          if (picked.length >= plan.solveSubsample) break;
          const twins = bankFile.units[unitKey('main', cap.rig)].twins;
          const cats = cap.positions.map((pos) =>
            categoryOf(pos, 'content', twins.find((t) => t.camera === pos.pos) as TwinCamera, false),
          );
          if (cats.some((x) => x === 'PLACED' || x === 'MIXED')) picked.push(cap);
        }
        for (const cap of picked.filter((x) => x.rig === k))
          solves.push(solveCapture(ctx, rigFor('main', k), cell, cap, ['A']));
      }
    }
    return { solves };
  });
}

/**
 * The lateness sweep on timing alone: what a late emitter does to the photographs, before any is
 * rendered.
 */
export interface TimingCell {
  arm: string;
  phase: StartPhase;
  lateMs: number;
  vsync: boolean;
  trials: number;
  /** Captures with any photograph content-changed, on the page's semantics. */
  capturesTouched: number;
  /**
   * Captures EXPERIMENT-9's `straddles()` flags on the same shots, which assumes a perfect timer.
   */
  capturesFlagged: number;
  positionsTouched: number;
  /** Positions every photograph of which changed. */
  wholePositions: number;
  /**
   * Positions with a photograph that integrated a step BEFORE the one it is filed as: the emitter
   * fell behind.
   */
  positionsBackward: number;
  /**
   * Positions with a photograph wholly on another step: after the sweep, the folder is off by one.
   */
  positionsSlipTail: number;
  /**
   * Over touched positions, the mean of (largest - smallest) smear among the
   * position's changed photographs, where a photograph's smear is the share of
   * its exposure NOT on its filed step. Near 0 when every straddle of a
   * position has the same smear, as on a perfect timer; near 1 when the smear
   * sweeps from nothing to a whole step within the position.
   */
  meanSmearSpan: number | null;
  whollyWrong: number;
  changedPhotos: number;
}

function latenessTiming(plan: Exp10Plan): TimingCell[] {
  const out: TimingCell[] = [];
  const arms: { arm: Arm; phase: StartPhase; trials: number }[] = [
    { arm: armOf('intervalometer-100ppm'), phase: 'aimed', trials: plan.trials },
    { arm: armOf('intervalometer-100ppm'), phase: 'uniform', trials: plan.trials },
    { arm: armOf('handheld-remote'), phase: 'uniform', trials: plan.handheldTrials },
  ];
  for (const { arm, phase, trials } of arms) {
    for (const lateMs of plan.lateMsTiming) {
      for (const vsync of [false, true]) {
        const cell: TimingCell = {
          arm: arm.key,
          phase,
          lateMs,
          vsync,
          trials,
          capturesTouched: 0,
          capturesFlagged: 0,
          positionsTouched: 0,
          wholePositions: 0,
          positionsBackward: 0,
          positionsSlipTail: 0,
          meanSmearSpan: null,
          whollyWrong: 0,
          changedPhotos: 0,
        };
        const spans: number[] = [];
        const label = `timing/${arm.key}/${phase}/${lateMs}`;
        for (let t = 0; t < trials; t++) {
          const shots = shotTimings(
            arm,
            phase,
            DWELL_S,
            exp9TrialSeed(arm, phase, DWELL_S, EXPOSURE_S, t),
          );
          const jitters = vsync ? vsyncJitters(label, t) : null;
          let touched = false;
          if (shots.some((x) => straddles(x.open, EXPOSURE_S, DWELL_S))) cell.capturesFlagged++;
          for (let pos = 0; pos < POSITIONS; pos++) {
            const photos = positionPhotos(
              shots,
              pos,
              EXPOSURE_S,
              DWELL_S,
              lateMs / 1000,
              jitters === null ? null : jitters[pos],
              0,
              1,
            );
            const changed = photos.filter(contentChanged);
            if (changed.length === 0) continue;
            touched = true;
            cell.positionsTouched++;
            cell.changedPhotos += changed.length;
            if (changed.length === photos.length) cell.wholePositions++;
            if (changed.some((ph) => ph.rows[0].some((part) => part.step < ph.filedStep)))
              cell.positionsBackward++;
            const wholly = changed.filter((ph) => ph.rows[0].length === 1);
            cell.whollyWrong += wholly.length;
            if (wholly.length > 0) cell.positionsSlipTail++;
            const smears = changed.map(
              (ph) =>
                1 -
                ph.rows[0]
                  .filter((part) => part.step === ph.filedStep)
                  .reduce((a, part) => a + part.weight, 0),
            );
            spans.push(Math.max(...smears) - Math.min(...smears));
          }
          if (touched) cell.capturesTouched++;
        }
        cell.meanSmearSpan = spans.length === 0 ? null : round(mean(spans), 5);
        out.push(cell);
      }
    }
  }
  return out;
}

export function stageRescore(ctx: RunContext): StageFile<RescoreUnit> {
  return scoreStage(ctx, 'rescore', rescoreCells(ctx.plan), (units) => units.push('audit'));
}

export function stageLateness(ctx: RunContext): StageFile<RescoreUnit> {
  return scoreStage(ctx, 'lateness', latenessCells(ctx.plan), (units) => units.push('timing'));
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const RUNNERS: Record<Exclude<StageName, 'assemble'>, (ctx: RunContext) => unknown> = {
  q0: stageQ0,
  bank: stageBank,
  gate: stageGate,
  decode: stageDecode,
  pose: stagePose,
  rescore: stageRescore,
  lateness: stageLateness,
};

/** A run context over a store, with `solves.jsonl` read in. */
export function runContext(
  plan: Exp10Plan,
  store: Store,
  log: (line: string) => void,
  acceptStale = false,
): RunContext {
  return {
    plan,
    store,
    fingerprint: codeFingerprint(plan),
    acceptStale,
    staleAccepted: [],
    log,
    solves: new Map(),
    held: null,
  };
}

/**
 * Every stage in order, or the one asked for, each resuming from its
 * checkpoint. The document is not a stage of this module: `cli.ts` assembles
 * it afterwards from what these wrote.
 */
export function runStages(ctx: RunContext, only: StageName | null = null): void {
  for (const stage of STAGES) {
    if (stage === 'assemble' || (only !== null && only !== stage)) continue;
    const t0 = Date.now();
    ctx.log(`${stage}:`);
    RUNNERS[stage](ctx);
    ctx.log(`${stage}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
