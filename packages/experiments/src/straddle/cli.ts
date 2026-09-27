// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run experiment10` — what a photograph taken across a pattern change
 * costs a calibration, with today's page.
 *
 * Writes `experiments/experiment-10.json`. The spec budgeted three hours in one
 * process; the unit costs measured while this was built (a default rig 1.5 s to
 * bank, a noisy run 0.25 s, a crossing scan with its twelve pair scans 1.8 s, a
 * solve about 10 s) put it nearer four, most of it the gate stage's scans and
 * the solves. Once the first four stages are on disk, `--stage pose`,
 * `--stage rescore` and `--stage lateness` can run side by side, then
 * `--stage assemble`; the re-scoring, about an hour and a half, is then the
 * longest of the three.
 *
 *   node .../cli.ts                   every stage in order, resuming, then assemble
 *   node .../cli.ts --stage gate      one stage, resuming from its checkpoint
 *   node .../cli.ts --stage assemble  write the file from finished checkpoints only
 *   node .../cli.ts --quick           the plumbing (or EXP10_QUICK=1): 4 rigs at the
 *                                     reduced preset, 300 trials, no solves; about
 *                                     ten minutes, not the spec's five
 *   node .../cli.ts --smoke           the solve path on one rig, a handful of solves
 *
 * Neither `--quick` nor `--smoke` ever writes the committed file. They write
 * beside their own checkpoints, under `experiments/.experiment-10-partial/`, and
 * the document they write says what it is in its first field.
 *
 * ## The stages, and what each is for
 *
 *   q0        Today's page, as shipped: clean positions, rendered with noise,
 *             encoded to 8-bit sRGB and handed to `summarisePhoto` and
 *             `indexPhotographs`. Then Q0b: the folder shapes the card itself
 *             produces (extra photographs at either end, a re-shot run).
 *   bank      Every rig's clean frames once, and each camera's TWIN — the clean
 *             position through the renderer's own sensor and noise stream — whose
 *             verdicts decide what a later refusal can be blamed on.
 *   gate      The complement check's mechanism: where each run starts to be
 *             refused as the smear rises, and everything that could move that.
 *   decode    The decoder's mechanism: what a blend that passes does to a
 *             coordinate, in projector pixels and in millimetres on the sphere.
 *   pose      Designed straddles solved through `runScenario`, with twins and
 *             re-shoots, so the harm has a noise floor to be judged against.
 *   rescore   EXPERIMENT-9's photographs, replayed exactly and re-scored.
 *   lateness  The same with the emitter running late, as the page's does.
 *   assemble  The document, and the verdict sentence built from its cells.
 *
 * ## Checkpoints, and why they carry a fingerprint
 *
 * Each stage writes one JSON checkpoint per stage (and every solve one line of
 * `solves.jsonl`), and a re-run resumes from them rig by rig. A checkpoint is a
 * measurement taken by one build against one design, so each carries a schema
 * tag and a fingerprint of the design constants and the bytes of every source
 * file that decides what a stage measures (`segmentation/cli.ts`'s rule). A
 * mismatch refuses to resume rather than publish old measurements under this
 * build's provenance. That list includes THIS file, which the spec left out:
 * the stages live here, so this file decides what a checkpoint holds.
 * `EXP10_ACCEPT_STALE=1` resumes anyway, and the document then says so.
 *
 * ## Why the verdict is written here
 *
 * For the reason `tether/cli.ts` gives: three times a number in a write-up
 * disagreed with the file it reported, and a paraphrased verdict is the same
 * hazard one sentence further out. So the sentence is assembled from the
 * document's own cells through {@link at}, which throws on a cell that is not
 * there instead of printing a sentence with a hole in it.
 *
 * ## What this does NOT establish
 *
 * Everything is bench photometry — flat albedo, constant ambient, Gaussian shot
 * noise, one grey channel — and every loud/silent split is the verdict of a
 * COUNTERFACTUAL reader: the page's own complement check handed exact lit
 * fractions, because today's page refuses clean bench positions before the
 * check runs (the q0 stage measures that). The emitter is EXPERIMENT-9's
 * perfect timer except where the lateness stage says otherwise, and the
 * lateness it sweeps was measured headless, not on a display machine.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SENSOR,
  captureAndDecode,
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
import type { Correspondence, DecodeStats, LinearImage } from '../../../solver/src/decode.ts';
import {
  COMPLEMENT_LIMIT,
  MIN_CLASSIFY_MARGIN,
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
import { shotTimings, straddles, type ShotTiming } from '../tether/run.ts';
import type { Arm, StartPhase } from '../tether/design.ts';
import * as DESIGN from './design.ts';
import {
  ARMS,
  DECODE_LEVELS,
  DESIGNED_RIGS,
  DWELL_S,
  ENCODE_BOUNDS,
  ENCODE_FULL_SCALE,
  EXP10_ROOT_SEED,
  EXPECTED,
  EXPOSURE_S,
  FINGERPRINT_BLOCKS,
  FRAMES_PER_RUN,
  GAIN_JITTER,
  GATE_SCAN,
  GRID_GATE_MM,
  GROSS_PX,
  HANDHELD_TRIALS,
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
  REFINE_MARGIN,
  RIGS,
  ROTATION_GATE_DEG,
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
  classifyCapture,
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
  type CaptureClass,
  type Harm,
  type Photo,
  type PositionCategory,
  type RunOutcome10,
  type RunOutcomeKind,
  type TwinStatus,
} from './run.ts';
import {
  buildRig,
  decodeRun,
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
const WORK = path.join(ROOT, 'experiments', '.experiment-10-partial');
const OUT = path.join(ROOT, 'experiments', 'experiment-10.json');

export const SCHEMA = 'sphere-sim/experiment-10@1';
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
  lateMsTiming: [0, 7.5],
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
  lateMsTiming: [0, 7.5],
  lateMsRendered: [7.5],
};

// ---------------------------------------------------------------------------
// Small arithmetic, stated once
// ---------------------------------------------------------------------------

/** Linear-interpolated quantile of an ascending array (type 7); NaN when empty. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function ascending(xs: readonly number[]): number[] {
  return xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

function median(xs: readonly number[]): number {
  return quantile(ascending(xs), 0.5);
}

function mean(xs: readonly number[]): number {
  const f = xs.filter((x) => Number.isFinite(x));
  return f.length === 0 ? Number.NaN : f.reduce((a, x) => a + x, 0) / f.length;
}

/** For the document only, never for a decision: numbers a reader can read. */
function round(x: number | null, digits = 4): number | null {
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

/**
 * A share with a bootstrap 95% interval that resamples CLUSTERS — rigs — not
 * the units inside them: every capture on one rig shares its cameras,
 * projectors and placement, so they are not independent draws, and resampling
 * them would understate the interval. The seed is named off this experiment's
 * root by a label, so the interval is the same number every run.
 */
export function clusteredShare(
  clusters: readonly { num: number; den: number }[],
  label: string,
  replicates = 2000,
): { num: number; den: number; share: number | null; lo: number | null; hi: number | null } {
  const num = clusters.reduce((a, c) => a + c.num, 0);
  const den = clusters.reduce((a, c) => a + c.den, 0);
  if (den === 0 || clusters.length === 0) return { num, den, share: null, lo: null, hi: null };
  const rng = makeBenchRng(deriveSeed(EXP10_ROOT_SEED, `exp10/bootstrap/${label}`));
  const shares: number[] = [];
  for (let b = 0; b < replicates; b++) {
    let n = 0;
    let d = 0;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[rng.int(0, clusters.length - 1)];
      n += c.num;
      d += c.den;
    }
    if (d > 0) shares.push(n / d);
  }
  const sorted = ascending(shares);
  return {
    num,
    den,
    share: num / den,
    lo: round(quantile(sorted, 0.025)),
    hi: round(quantile(sorted, 0.975)),
  };
}

/** A pair's name in the page's plan: `u0` is the u axis's most significant Gray plane. */
const SPECS = planFrames(PLAN);
const PAIR_NAMES: readonly string[] = EXPECTED.complements.pairs.map(
  ([a]) => `${SPECS[a].axis}${SPECS[a].index}`,
);
/** A frame's class: W, B, G_u0..., C_u0..., then the phase steps φ_u0... */
const FRAME_CLASSES: readonly string[] = SPECS.map((s) =>
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
      // `solves.jsonl` without interleaving a line.
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
 * Every source file that decides what a stage measures, per the spec's list,
 * plus this file (see the header). The document assembly is in this file too,
 * so an edit to the verdict's wording invalidates the checkpoints as well;
 * `EXP10_ACCEPT_STALE=1` is the deliberate way past that, and it is recorded.
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
  'packages/experiments/src/straddle/design.ts',
  'packages/experiments/src/straddle/run.ts',
  'packages/experiments/src/straddle/bank.ts',
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
 * The design constants — every value `design.ts` exports, which is what the
 * document's `generatedFrom` repeats — and the plan, as one canonical string.
 */
function designConstants(plan: Exp10Plan): Record<string, unknown> {
  const constants: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(DESIGN)) {
    if (typeof value !== 'function') constants[name] = value;
  }
  return { constants, plan };
}

export function codeFingerprint(plan: Exp10Plan): string {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(designConstants(plan)));
  for (const rel of MEASUREMENT_SOURCES) {
    const files = sourceFiles(path.join(ROOT, rel));
    if (files.length === 0) throw new Error(`experiment10: nothing to fingerprint at ${rel}`);
    for (const file of files) {
      h.update(path.relative(ROOT, file));
      h.update(fs.readFileSync(file));
    }
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

interface StageFile<T> {
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

function readStage<T>(ctx: RunContext, stage: StageName): StageFile<T> {
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

type Which = 'main' | 'spill' | 'fine';

function variantOf(plan: Exp10Plan, which: Which): RigVariant {
  return which === 'main' ? plan.variant : which === 'spill' ? 'spill' : plan.fineVariant;
}

function unitKey(which: Which, k: number, camera?: number): string {
  return camera === undefined ? `${which}:${k}` : `${which}:${k}:${camera}`;
}

function parseUnit(unit: string): { which: Which; k: number; camera: number | null } {
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

function twinStatus(t: TwinCamera): TwinStatus[] {
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
function computeTwin(bank: RigBank, c: number): { twin: TwinCamera; prints: FrameFingerprint[] } {
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
interface RigContext {
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
   * Matched pixels moved by at least a Gray stride, half a period, on either
   * axis: a wrong fringe order, which is what a confidently flipped Gray bit
   * produces. `gross` also counts phase errors between a quarter and half a
   * period, which the unwrap tolerance lets through with the order right.
   */
  wrongFringe: number;
}

function shiftBetween(before: readonly Correspondence[], after: readonly Correspondence[]): Shift {
  const was = new Map(before.map((x) => [pixelOf(x), x]));
  const du: number[] = [];
  const dv: number[] = [];
  let gross = 0;
  let changed = 0;
  let moved = 0;
  let wrongFringe = 0;
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
    if (Math.abs(u) >= PERIOD_PX.u / 2 || Math.abs(v) >= PERIOD_PX.v / 2) wrongFringe++;
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
    wrongFringe,
  };
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
    wrongFringe: s.wrongFringe,
  };
}

// ---------------------------------------------------------------------------
// q0 — today's page, as shipped; Q0b — the card's own folder shapes
// ---------------------------------------------------------------------------

/** What made the page refuse, by the words `indexing.ts` and `readback.ts` write. */
type ReasonClass =
  | 'margin'
  | 'count'
  | 'length'
  | 'kind'
  | 'broken'
  | 'unanswered'
  | 'leading'
  | 'clipping';

function reasonOf(problem: string): ReasonClass {
  if (/^The white and black frames cannot be reliably told/.test(problem)) return 'margin';
  if (/^Found \d+ projector runs and the capture should hold/.test(problem)) return 'count';
  if (/run holds \d+ photographs and should hold/.test(problem)) return 'length';
  if (/is the right length but frame \d+ looks like/.test(problem)) return 'kind';
  if (/were played as a pattern and its complement/.test(problem)) return 'broken';
  if (/could not be checked/.test(problem)) return 'unanswered';
  if (/sit before the first white frame/.test(problem)) return 'leading';
  if (/at the sensor's ceiling/.test(problem)) return 'clipping';
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

export function stageQ0(ctx: RunContext): StageFile<Q0Unit> {
  const { plan } = ctx;
  return runUnits<Q0Unit>(ctx, 'q0', rigUnits(plan, ['main', 'spill', 'fine']), (unit) => {
    const { which, k, camera } = parseUnit(unit);
    const bank = bankOf(ctx, unit);
    const cameras = camera === null ? [...bank.cameras] : [camera];
    const base = captureOptionsFor(bank.world, bank.scenario, runOptionsFor(bank), PLAN);
    if (JSON.stringify(base.conditions.sensor) !== JSON.stringify(DEFAULT_SENSOR)) {
      throw new Error(`experiment10: ${unit} does not photograph with DEFAULT_SENSOR`);
    }
    const summaries = new Map<number, PhotoSummary[]>(cameras.map((c) => [c, []]));
    const keepFor = which === 'main' && k === plan.rigs[0] ? 0 : -1;
    const kept: LinearImage[][] = [];
    // The renderer's own noisy frames, through the page's own encode and
    // summary, one photograph at a time; nothing of a frame is kept but its
    // summary, as the page keeps nothing else.
    captureAndDecode(
      bank.world.truthRig,
      cameras.map((c) => bank.world.cameras[c]),
      {
        ...base,
        onCapture: (i, p, capture) => {
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
        },
      },
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
  kind: 'twin' | 'designed' | 'null' | 'capture';
  rig: number;
  variant: RigVariant;
  /** A description that determines the straddle rendered: `none`, or which positions and why. */
  straddle: string;
  /** Pairs withheld from the solve, as `camera.projector`, sorted. */
  exclude: string[];
  /** The capture seed of a re-shoot, or null for the scenario's own. */
  captureSeed: number | null;
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
  return `${spec.kind}/${spec.variant}/k${spec.rig}/${spec.straddle}/x[${exclude}]/seed:${seed}`;
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
function rollingSmear(
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

// ---------------------------------------------------------------------------
// decode — what a blend that passes does to a coordinate
// ---------------------------------------------------------------------------

/**
 * The smear the verdict quotes a bias at: the pose arms' 6%, below every
 * design-time crossing. Decoded beside the design's own noiseless levels so
 * the sentence's pixel and millimetre figures are measured, not scaled.
 */
const VERDICT_S = 0.06;
if (!POSE_LEVELS.forward.includes(VERDICT_S))
  throw new Error('experiment10: the verdict smear is not a pose level');

/**
 * A decode's reject buckets on one half of the projector's u axis: `imageMask` keeps the decoder
 * itself doing the counting.
 */
interface HalfStats {
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
    dark: {
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

function halfMasks(rc: RigContext, c: number, p: number): { dark: Uint8Array; lit: Uint8Array } {
  const u = rc.bank.truth[c][p].projU;
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
function halves(
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

function decodeRunArms(rc: RigContext, plan: Exp10Plan, c: number, p: number): DecodeRun {
  const { bank } = rc;
  const cleanFrames = cleanRun(bank, c, p, CLEAN);
  const clean = decodeRun(c, p, cleanFrames);
  const cleanSphere = decodedOnSphere(rc, p, clean.correspondences);
  const masks = halfMasks(rc, c, p);
  const levels: DecodeLevel[] = [];
  for (const direction of ['forward', 'backward'] as const) {
    const grid = [...plan.decodeNoiseless];
    if (direction === 'forward' && !grid.includes(VERDICT_S)) grid.push(VERDICT_S);
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

  // The successor ablation: the same forward smear, with the page's own next
  // step and with its dark. A blend into black scales a fringe and moves no
  // phase, so what separates the two is the successor's content.
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
    ablation: { page: ablate(designedPhotos('forward', () => s, 1)), dark: ablate(toDark) },
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
 * How far past `REFINE_MARGIN` the noisy re-evaluation reaches. The refine
 * band is validated on R1 and widened in steps of 0.01 until the refined
 * verdicts agree with the fully noisy ones on 98% of runs; R1 runs in the
 * rescore stage and the lateness cells run beside it, so every refined cell
 * computes noisy verdicts out to this ceiling up front, and the assembly
 * applies whatever margin R1 validated. A margin past the ceiling is reported,
 * not silently capped.
 */
export const REFINE_CEILING = 0.05;
/**
 * The validation's own bar: the refined verdict agrees with the fully noisy one on at least this
 * share of R1's touched runs.
 */
export const REFINE_AGREEMENT = 0.98;

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
        solve: plan.pose && phase === 'aimed' && lateMs === 7.5 ? 'first-a' : 'none',
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
  const floor = twin.runs.map((r) => Math.max(0, r.noiseFloor ?? 0));
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
      else if (
        w === null ||
        (w !== 'x' &&
          w >= COMPLEMENT_LIMIT - floor[p] - REFINE_CEILING &&
          w <= COMPLEMENT_LIMIT + REFINE_CEILING)
      )
        noisy.add(p);
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

/** A position's outcomes under one evaluation, rebuilt for the library's own classifiers. */
export function outcomesOf(
  score: PositionScore,
  footing: 'content' | 'filed',
  twin: TwinCamera,
  useNoisy: (run: RunScore, p: number) => boolean,
): RunOutcome10[] {
  const runs = footing === 'content' ? score.content : score.filed;
  return runs.map((r, p) => {
    const noisy = r.on !== null && useNoisy(r, p);
    return {
      projector: p,
      touched: score.touched.includes(p),
      attributable: twin.placedContent.includes(p),
      phaseTouched: noisy ? (r.ptn as boolean) : r.pt0,
      outcome: noisy ? (r.on as RunOutcomeKind) : r.o0,
      brokenPair: null,
      brokenPercent: null,
      brokenResidual: null,
      collateral: noisy ? (r.con as boolean) : r.co0,
      falseAlarm: noisy ? (r.fan as boolean) : r.fa0,
    };
  });
}

/** The position's category, or UNTOUCHED / UNCHANGED for one no photograph of which changed. */
export function categoryOf(
  score: PositionScore,
  footing: 'content' | 'filed',
  twin: TwinCamera,
  useNoisy: (run: RunScore, p: number) => boolean,
  excludeMinorMarginal: boolean,
): PositionCategory {
  if (!score.changed) return score.flagged ? 'UNCHANGED' : 'UNTOUCHED';
  return classifyPosition(outcomesOf(score, footing, twin, useNoisy), twinStatus(twin), {
    exp9Flagged: score.flagged,
    excludeMinorMarginal,
  });
}

/**
 * Whether a run in a refined cell takes its noisy verdict at refine margin
 * `margin`: its noiseless worst pair within `[limit - b - margin, limit +
 * margin]`, where b is its twin's noise floor, or unanswered. (Only runs the
 * twin placed were re-evaluated; see {@link scorePosition}.)
 */
export function inBand(run: RunScore, noiseFloor: number | null, margin: number): boolean {
  if (run.w0 === 'x') return false;
  if (run.w0 === null) return true;
  const b = Math.max(0, noiseFloor ?? 0);
  return run.w0 >= COMPLEMENT_LIMIT - b - margin && run.w0 <= COMPLEMENT_LIMIT + margin;
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
          const outcome = r.on ?? r.o0;
          if (pos.touched.includes(p) && outcome === 'placed') {
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
          run.ptn ?? run.pt0,
        ),
      });
    }
  }
  return out;
}

/** Every solve already on record: `solves.jsonl`, checked line by line against this build. */
function loadSolves(ctx: RunContext): void {
  const text = ctx.store.read('solves.jsonl');
  if (text === null) return;
  for (const line of text.split('\n')) {
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
 * One solve through `runScenario`, or the record of it when it is already on
 * disk. The scenario is the bank's own — the rig the frames were rendered
 * from — with only `degradation.straddle` set, so there is no second statement
 * of how a rig is built for the solve to drift from.
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
  const scenario = { ...bank.scenario, degradation: { ...bank.scenario.degradation, straddle } };
  const rendered = new Map<string, FrameFingerprint[]>();
  const result = runScenario(scenario, {
    ...runOptionsFor(bank),
    excludePairs: excludePairs(spec.exclude),
    ...(spec.captureSeed === null ? {} : { captureSeed: spec.captureSeed }),
    onCapture:
      audits.length === 0
        ? null
        : (c, p, capture) => {
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
  nulls: string[];
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
      const nulls: string[] = [];
      for (let i = 0; i < plan.kNull; i++) {
        nulls.push(
          solveOnce(
            ctx,
            bank,
            {
              kind: 'null',
              rig: k,
              variant,
              straddle: 'none',
              exclude: refusedClean,
              captureSeed: nullSeed(k, i),
            },
            null,
            [],
            plain,
          ).id,
        );
      }
      return { rig: k, camera: c, plain: plain.id, levels, nulls };
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
}

/**
 * Solve one scored capture under the policies asked for. Every position is
 * rendered from the same timing the score came from, straddled with the
 * content footing's assignment — the photographs the page would decode — and
 * the pairs the page would not decode are withheld from the solve.
 */
function solveCapture(
  ctx: RunContext,
  rc: RigContext,
  cell: CellSpec,
  cap: CaptureScore,
  policies: readonly ('A' | 'P')[],
  useNoisy: (run: RunScore) => boolean,
): CaptureSolve {
  const { bank } = rc;
  const variant = variantOf(ctx.plan, cell.which);
  const shots = cellShots(cell, cap.t);
  const cats = cap.positions.map((pos) =>
    categoryOf(pos, 'content', twinOf(rc, pos.pos), (r) => useNoisy(r), false),
  );
  const refusedClean = cleanRefused(rc);
  const plainSpec: SolveSpec = {
    kind: 'twin',
    rig: cap.rig,
    variant,
    straddle: 'none',
    exclude: refusedClean,
    captureSeed: null,
  };
  const out: CaptureSolve = { cell: cell.id, t: cap.t, rig: cap.rig, a: null, p: null };
  for (const policy of policies) {
    const straddled = cap.positions.filter(
      (_, i) => cats[i] === 'PLACED' || (policy === 'A' && cats[i] === 'MIXED'),
    );
    if (straddled.length === 0) continue;
    const exclude = new Set(refusedClean);
    const byCamera = new Map<number, ShutterStraddle>();
    const audits: AuditPlan[] = [];
    for (const pos of straddled) {
      const photos = cellPhotos(cell, shots, cap.t, pos.pos, bank.height);
      byCamera.set(pos.pos, straddleForCamera(pos.pos, photos, pos.assignment));
      audits.push({ camera: pos.pos, photos, assignment: pos.assignment });
      if (cats[pos.pos] === 'MIXED') {
        const outcomes = outcomesOf(pos, 'content', twinOf(rc, pos.pos), (r) => useNoisy(r));
        for (const o of outcomes)
          if (o.outcome !== 'placed') exclude.add(`${pos.pos}.${o.projector}`);
      }
    }
    const excl = [...exclude].sort();
    const plain = solveOnce(ctx, bank, plainSpec, null, [], null);
    const twin =
      excl.join() === refusedClean.join()
        ? plain
        : solveOnce(ctx, bank, { ...plainSpec, exclude: excl }, null, [], null);
    const treated = solveOnce(
      ctx,
      bank,
      {
        kind: 'capture',
        rig: cap.rig,
        variant,
        straddle: `${cell.id}/t${cap.t}/[${straddled.map((x) => x.pos).join(',')}]`,
        exclude: excl,
        captureSeed: null,
      },
      combined(byCamera),
      audits,
      twin,
    );
    const pair = { treated: treated.id, twin: twin.id };
    if (policy === 'A') out.a = pair;
    else out.p = pair;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rescore and lateness stages
// ---------------------------------------------------------------------------

export interface AuditCell {
  arm: string;
  phase: StartPhase;
  exposureS: number;
  trials: number;
  /** The recount from `shotTimings` and `straddles`, field for field against the committed cell. */
  recount: Record<string, number>;
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
 * EXPERIMENT-9's own summary of one cell, recounted from the replayed shots.
 * Its accounting is `runTrial`'s, restated on purpose: the point is to hold
 * `shotTimings` and this experiment's seed expression to the committed file,
 * and a mismatch throws rather than re-scoring shots EXPERIMENT-9 never drew.
 */
function recountCell(
  arm: Arm,
  phase: StartPhase,
  exposureS: number,
  trials: number,
): { recount: Record<string, number>; reconciliation: AuditCell['reconciliation'] } {
  const perPosition = STEPS.length;
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
    const shots = shotTimings(
      arm,
      phase,
      DWELL_S,
      exp9TrialSeed(arm, phase, DWELL_S, exposureS, t),
    );
    let straddled = 0;
    let longest = 0;
    let lost = 0;
    let touchedPositions = 0;
    const runs = new Set<number>();
    for (let pos = 0; pos < POSITIONS && shots.length > 0; pos++) {
      let burst = 0;
      let here = 0;
      for (let j = 0; j < perPosition; j++) {
        const k = pos * perPosition + j;
        if (straddles(shots[k].open, exposureS, DWELL_S)) {
          straddled++;
          here++;
          burst++;
          longest = Math.max(longest, burst);
          runs.add(Math.floor(k / FRAMES_PER_RUN));
        } else {
          burst = 0;
        }
      }
      if (here > 0) touchedPositions++;
      if (here === perPosition) lost++;
    }
    if (straddled > 0) rec.capturesTouched++;
    rec.straddledTotal += straddled;
    rec.worstStraddled = Math.max(rec.worstStraddled, straddled);
    rec.worstBurst = Math.max(rec.worstBurst, longest);
    rec.runsTouchedTotal += runs.size;
    if (runs.size === POSITIONS * PROJECTORS) rec.capturesAllRunsTouched++;
    rec.positionsTouchedTotal += touchedPositions;
    if (lost > 0) rec.capturesLosingAWholePosition++;
    if (shots.length > 0) {
      const r = reconcileShots(shots, exposureS, DWELL_S);
      recon.photographs += r.photographs;
      recon.straddled += r.straddled;
      recon.phantoms += r.phantoms;
      recon.contentChanged += r.contentChanged;
      recon.whollyWrong += r.whollyWrong;
      recon.endingInDark += r.endingInDark;
    }
  }
  return { recount: rec, reconciliation: recon };
}

function stageAudit(plan: Exp10Plan): AuditCell[] {
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

/** Rigs whose clean positions the page placed a run of in Q0: the contingency's page column. */
function pageColumnRigs(ctx: RunContext): Set<string> {
  const q0 = needStage<Q0Unit>(ctx, 'q0');
  const out = new Set<string>();
  for (const [unit, u] of Object.entries(q0.units)) {
    if (u.positions.some((p) => p.runsPlaced.length > 0))
      out.add(unit.split(':').slice(0, 2).join(':'));
  }
  return out;
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
            categoryOf(pos, 'content', twinOf(rc, pos.pos), () => true, false),
          );
          if (!cats.some((x) => x === 'PLACED' || x === 'MIXED')) continue;
          solves.push(solveCapture(ctx, rc, cell, cap, ['A', 'P'], () => true));
        }
      } else {
        // The first captures in trial order, over every rig, with a PLACED or
        // MIXED position on the widest band's verdict.
        const all = Object.values(passA)
          .flatMap((u) => u.cells[cell.id] ?? [])
          .sort((a, b) => a.t - b.t);
        const picked: CaptureScore[] = [];
        for (const cap of all) {
          if (picked.length >= plan.solveSubsample) break;
          const twins = bankFile.units[unitKey('main', cap.rig)].twins;
          const cats = cap.positions.map((pos) =>
            categoryOf(
              pos,
              'content',
              twins.find((t) => t.camera === pos.pos) as TwinCamera,
              (r) => r.on !== null,
              false,
            ),
          );
          if (cats.some((x) => x === 'PLACED' || x === 'MIXED')) picked.push(cap);
        }
        for (const cap of picked.filter((x) => x.rig === k))
          solves.push(solveCapture(ctx, rigFor('main', k), cell, cap, ['A'], (r) => r.on !== null));
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
// assemble — the document, from finished checkpoints only
// ---------------------------------------------------------------------------

/**
 * The median of the crossings with every run the scan never refused counted as
 * crossing above everything measured, so the statistic cannot improve by
 * leaving the worst runs out. Infinity when half or more never crossed.
 */
function medianCountingNever(crossings: readonly number[], runs: number): number | null {
  if (runs === 0) return null;
  const sorted = ascending(crossings);
  const at = (i: number): number => (i < sorted.length ? sorted[i] : Number.POSITIVE_INFINITY);
  const h = (runs - 1) / 2;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const v = lo === hi ? at(lo) : (at(lo) + at(hi)) / 2;
  return Number.isFinite(v) ? round(v, 5) : Number.POSITIVE_INFINITY;
}

/** A distribution in one line: count, extremes, deciles, median, mean. */
function spread(
  xs: readonly number[],
  digits = 4,
): {
  n: number;
  min: number | null;
  p10: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
} {
  const sorted = ascending(xs);
  if (sorted.length === 0)
    return { n: 0, min: null, p10: null, median: null, p90: null, max: null, mean: null };
  return {
    n: sorted.length,
    min: round(sorted[0], digits),
    p10: round(quantile(sorted, 0.1), digits),
    median: round(quantile(sorted, 0.5), digits),
    p90: round(quantile(sorted, 0.9), digits),
    max: round(sorted[sorted.length - 1], digits),
    mean: round(mean(sorted), digits),
  };
}

function countBy<T>(xs: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

/**
 * H3: the whole-run closed form in projector space, on the page's own block grid (T16's claim,
 * re-measured here).
 */
function closedForm(): {
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

interface Classes {
  captures: number;
  byClass: Record<string, number>;
  loudAndSilent: number;
  /** Per rig, for the clustered interval. */
  byRig: Record<string, Record<string, number>>;
}

/**
 * What a cell's solves say beyond the class counts, over every capture whose
 * silent part was solved under the policy: SILENT, and LOUD+SILENT.
 *
 * Kept because the counts cannot carry it. A LOUD+SILENT capture is LOUD
 * whatever its solve found, so without `loudSilentHarm` the solves policy P
 * adds for exactly those captures (§6 R1) reached no number in the document;
 * and §3.7 flags rotation-gate flips separately and §3.8 asks for D_grid
 * sensitivity at 0.25 and 0.5 mm, neither of which a class records.
 */
interface SolvedTally {
  captures: number;
  loudSilentHarm: Record<'HARMLESS' | 'BIASED' | 'GATE-BREAKING', number>;
  rotationFlips: number;
  over025: number;
  over05: number;
  dGridMm: number[];
}

const CLASS_ORDER: readonly (CaptureClass | 'LOUD+SILENT')[] = [
  'LOUD',
  'LOUD+SILENT',
  'SILENT-HARMLESS',
  'SILENT-BIASED',
  'SILENT-GATE-BREAKING',
  'SILENT-UNSOLVED',
  'INVISIBLE-ONLY',
  'UNCHANGED',
  'UNTOUCHED',
];

/** Everything the assembly reads, gathered once. */
interface Evidence {
  plan: Exp10Plan;
  q0: StageFile<Q0Unit>;
  bank: StageFile<BankUnit>;
  gate: StageFile<GateUnit>;
  decode: StageFile<DecodeUnit>;
  pose: StageFile<PoseUnit> | null;
  rescore: StageFile<RescoreUnit>;
  lateness: StageFile<RescoreUnit>;
  solves: Map<string, SolveRecord>;
}

function twinFor(ev: Evidence, which: Which, rig: number, camera: number): TwinCamera {
  const units = Object.entries(ev.bank.units).filter(([key]) => {
    const u = parseUnit(key);
    return u.which === which && u.k === rig && (u.camera === null || u.camera === camera);
  });
  for (const [, u] of units) {
    const t = u.twins.find((x) => x.camera === camera);
    if (t !== undefined) return t;
  }
  throw new Error(`experiment10: no twin for ${which} rig ${rig} camera ${camera}`);
}

function solveOf(ev: Evidence, id: string | null | undefined): SolveRecord | null {
  if (id === null || id === undefined) return null;
  const rec = ev.solves.get(id);
  if (rec === undefined)
    throw new Error(
      `experiment10: solve ${id} is named by a checkpoint and missing from solves.jsonl`,
    );
  return rec;
}

/**
 * τ_null: the 95th percentile of D_grid between each designed rig's twin and its re-shoots, with a
 * rig-clustered interval.
 */
function tauNull(ev: Evidence): {
  value: number | null;
  lo: number | null;
  hi: number | null;
  samples: number;
  byRig: Record<string, number[]>;
} {
  const byRig: Record<string, number[]> = {};
  for (const u of Object.values(ev.pose?.units ?? {})) {
    byRig[String(u.rig)] = u.nulls
      .map((id) => solveOf(ev, id)?.against?.dGridMm)
      .filter((x): x is number => x !== undefined && Number.isFinite(x));
  }
  const all = Object.values(byRig).flat();
  if (all.length === 0) return { value: null, lo: null, hi: null, samples: 0, byRig };
  const rigs = Object.values(byRig);
  const rng = makeBenchRng(deriveSeed(EXP10_ROOT_SEED, 'exp10/bootstrap/tau-null'));
  const reps: number[] = [];
  for (let b = 0; b < 2000; b++) {
    const pool: number[] = [];
    for (let i = 0; i < rigs.length; i++) pool.push(...rigs[rng.int(0, rigs.length - 1)]);
    reps.push(quantile(ascending(pool), 0.95));
  }
  const sorted = ascending(reps);
  return {
    value: round(quantile(ascending(all), 0.95), 5),
    lo: round(quantile(sorted, 0.025), 5),
    hi: round(quantile(sorted, 0.975), 5),
    samples: all.length,
    byRig,
  };
}

function harmOf(
  ev: Evidence,
  pair: { treated: string; twin: string } | null,
  tau: number | null,
): { harm: Harm | null; error: string | null } {
  if (pair === null || tau === null) return { harm: null, error: null };
  const treated = solveOf(ev, pair.treated);
  const twin = solveOf(ev, pair.twin);
  if (treated === null || twin === null) return { harm: null, error: 'missing solve' };
  if (
    treated.error !== null ||
    twin.error !== null ||
    treated.against === null ||
    treated.gridMm === null ||
    twin.gridMm === null ||
    treated.rotationDeg === null ||
    twin.rotationDeg === null
  ) {
    return {
      harm: null,
      error: treated.error ?? twin.error ?? 'a solve produced no aligned rig or metric',
    };
  }
  return {
    harm: {
      dGridMm: treated.against.dGridMm,
      tauNullMm: tau,
      gTwinMm: twin.gridMm,
      gTwinCensored: twin.gridCensored === true,
      gTreatedMm: treated.gridMm,
      gTreatedCensored: treated.gridCensored === true,
      rotationTwinDeg: twin.rotationDeg,
      rotationTreatedDeg: treated.rotationDeg,
    },
    error: null,
  };
}

/**
 * One scored cell, summarised: its captures and positions by category, both
 * policies, both footings, with and without minor and marginal runs, and the
 * run-level tallies behind them. `useNoisy` says which evaluation decides
 * each run: the fully noisy one for R1, the validated refine band elsewhere.
 */
function summariseCell(
  ev: Evidence,
  cell: CellSpec,
  file: StageFile<RescoreUnit>,
  useNoisy: (run: RunScore, noiseFloor: number | null) => boolean,
  tau: number | null,
) {
  const captures = Object.entries(file.units)
    .filter(([key]) => key.startsWith('A:'))
    .flatMap(([, u]) => u.score?.cells[cell.id] ?? [])
    .sort((a, b) => a.t - b.t);
  const solves = Object.values(file.units)
    .flatMap((u) => u.solves ?? [])
    .filter((x) => x.cell === cell.id);
  const samples = Object.values(file.units)
    .flatMap((u) => u.samples ?? [])
    .filter((x) => x.cell === cell.id);
  const which: Which = cell.which;
  const positionTable = (footing: 'content' | 'filed', excl: boolean): Record<string, number> => {
    const counts: Record<string, number> = {
      UNTOUCHED: 0,
      UNCHANGED: 0,
      'INVISIBLE-ONLY': 0,
      'REFUSED-ALL': 0,
      MIXED: 0,
      PLACED: 0,
    };
    for (const cap of captures) {
      for (const pos of cap.positions) {
        const twin = twinFor(ev, which, cap.rig, pos.pos);
        const cat = categoryOf(
          pos,
          footing,
          twin,
          (r, p) => useNoisy(r, twin.runs[p].noiseFloor),
          excl,
        );
        counts[cat]++;
      }
    }
    return counts;
  };
  type PolicyClasses = Classes & { solveErrors: string[]; solved: SolvedTally };
  const classesFor = (
    policy: 'P' | 'A',
    keep: (cap: CaptureScore) => boolean = () => true,
  ): PolicyClasses => {
    const out: PolicyClasses = {
      captures: 0,
      byClass: {},
      loudAndSilent: 0,
      byRig: {},
      solveErrors: [],
      solved: {
        captures: 0,
        loudSilentHarm: { HARMLESS: 0, BIASED: 0, 'GATE-BREAKING': 0 },
        rotationFlips: 0,
        over025: 0,
        over05: 0,
        dGridMm: [],
      },
    };
    for (const name of CLASS_ORDER) out.byClass[name] = 0;
    for (const cap of captures) {
      if (!keep(cap)) continue;
      const cats = cap.positions.map((pos) => {
        const twin = twinFor(ev, which, cap.rig, pos.pos);
        return categoryOf(
          pos,
          'content',
          twin,
          (r, p) => useNoisy(r, twin.runs[p].noiseFloor),
          false,
        );
      });
      const solve = solves.find((x) => x.t === cap.t) ?? null;
      const { harm, error } = harmOf(
        ev,
        solve === null ? null : policy === 'A' ? solve.a : solve.p,
        tau,
      );
      if (error !== null) out.solveErrors.push(`trial ${cap.t}: ${error}`);
      const got = classifyCapture(cats, harm, policy);
      out.captures++;
      out.byClass[got.class]++;
      if (got.loudAndSilent) {
        out.loudAndSilent++;
        out.byClass['LOUD+SILENT']++;
      }
      if (harm !== null && got.harm !== null) {
        const s = out.solved;
        s.captures++;
        if (got.class === 'LOUD') s.loudSilentHarm[got.harm]++;
        if (got.rotationGateFlipped === true) s.rotationFlips++;
        if (harm.dGridMm > 0.25) s.over025++;
        if (harm.dGridMm > 0.5) s.over05++;
        s.dGridMm.push(harm.dGridMm);
      }
      const rig = String(cap.rig);
      out.byRig[rig] ??= {};
      out.byRig[rig][got.class] = (out.byRig[rig][got.class] ?? 0) + 1;
      out.byRig[rig].captures = (out.byRig[rig].captures ?? 0) + 1;
      if (got.loudAndSilent)
        out.byRig[rig]['LOUD+SILENT'] = (out.byRig[rig]['LOUD+SILENT'] ?? 0) + 1;
    }
    return out;
  };
  const withIntervals = (c: Classes) => {
    const rigs = cell.which === 'main' ? ev.plan.rigs : ev.plan.spillRigs;
    const shares: Record<string, ReturnType<typeof clusteredShare>> = {};
    for (const name of CLASS_ORDER) {
      if (name === 'UNTOUCHED') continue;
      shares[name] = clusteredShare(
        rigs.map((k) => ({
          num: c.byRig[String(k)]?.[name] ?? 0,
          den: c.byRig[String(k)]?.captures ?? 0,
        })),
        `${cell.id}/${name}`,
      );
    }
    return shares;
  };
  const P = classesFor('P');
  const A = classesFor('A');
  // §6 R5 scores EXPERIMENT-9's touched set and reports the captures only this
  // cell's timing touched separately; the counts above take both together, so
  // they are split here by where a capture came from. At R1 the second is
  // empty: on EXPERIMENT-9's own timer every changed photograph is flagged.
  const isFlagged = (cap: CaptureScore): boolean => cap.positions.some((p) => p.flagged);
  const byOrigin = {
    flagged: {
      P: classesFor('P', isFlagged).byClass,
      A: classesFor('A', isFlagged).byClass,
    },
    newlyTouched: {
      P: classesFor('P', (cap) => !isFlagged(cap)).byClass,
      A: classesFor('A', (cap) => !isFlagged(cap)).byClass,
    },
  };
  const solvedOf = (s: SolvedTally) => ({
    captures: s.captures,
    loudSilentHarm: s.loudSilentHarm,
    rotationFlips: s.rotationFlips,
    over025: s.over025,
    over05: s.over05,
    dGridMm: spread(s.dGridMm, 5),
  });

  // Run-level tallies, content footing, on the deciding evaluation.
  let touchedRuns = 0;
  let attributableTouched = 0;
  let refusedAttributable = 0;
  let falseAlarms = 0;
  let collateral = 0;
  let placedPhaseTouched = 0;
  const broken: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  let phasePlacedPositions = 0;
  let touchedPositions = 0;
  for (const cap of captures) {
    for (const pos of cap.positions) {
      if (!pos.changed && !pos.flagged) continue;
      touchedPositions++;
      if (!pos.changed) continue;
      const twin = twinFor(ev, which, cap.rig, pos.pos);
      const os = outcomesOf(pos, 'content', twin, (r, p) => useNoisy(r, twin.runs[p].noiseFloor));
      const cat = classifyPosition(os, twinStatus(twin), { exp9Flagged: pos.flagged });
      let phasePlaced = false;
      os.forEach((o, p) => {
        const run = pos.content[p];
        if (o.collateral) collateral++;
        if (!o.touched) return;
        touchedRuns++;
        outcomes[o.outcome] = (outcomes[o.outcome] ?? 0) + 1;
        if (!o.attributable) return;
        attributableTouched++;
        if (o.outcome !== 'placed') {
          refusedAttributable++;
          if (o.falseAlarm) falseAlarms++;
          if (o.outcome === 'refused-complement' && run.bp !== null)
            broken[PAIR_NAMES[run.bp]] = (broken[PAIR_NAMES[run.bp]] ?? 0) + 1;
        } else if (o.phaseTouched) {
          placedPhaseTouched++;
          phasePlaced = true;
        }
      });
      if (phasePlaced && (cat === 'PLACED' || cat === 'MIXED')) phasePlacedPositions++;
    }
  }
  const decodes =
    cell.decode === 'all'
      ? captures.flatMap((c) => c.positions.flatMap((p) => p.decodes))
      : samples.map((x) => x.decode);
  const flagged = captures.filter((c) => c.positions.some((p) => p.flagged)).length;
  const changed = captures.filter((c) => c.positions.some((p) => p.changed)).length;
  return {
    id: cell.id,
    spec: cell,
    trials: cell.trials,
    capturesFlagged: flagged,
    capturesChanged: changed,
    capturesRecorded: captures.length,
    newlyTouched: captures.filter(
      (c) => !c.positions.some((p) => p.flagged) && c.positions.some((p) => p.changed),
    ).length,
    touchedPositions,
    positions: {
      content: {
        all: positionTable('content', false),
        excludingMinorMarginal: positionTable('content', true),
      },
      filed: {
        all: positionTable('filed', false),
        excludingMinorMarginal: positionTable('filed', true),
      },
    },
    classes: {
      P: {
        counts: P.byClass,
        shares: withIntervals(P),
        solveErrors: P.solveErrors,
        solved: solvedOf(P.solved),
      },
      A: {
        counts: A.byClass,
        shares: withIntervals(A),
        solveErrors: A.solveErrors,
        solved: solvedOf(A.solved),
      },
      byOrigin,
    },
    solved: solves.length > 0,
    solves: solves.length,
    runs: {
      touched: touchedRuns,
      attributableTouched,
      refusedAttributable,
      falseAlarms,
      collateral,
      placedPhaseTouched,
      outcomes,
      brokenPairs: broken,
    },
    positionsPlacedWithPhase: phasePlacedPositions,
    decode: {
      runs: decodes.length,
      biasU: spread(decodes.map((d) => d.shift.meanU).filter((x): x is number => x !== null)),
      biasV: spread(decodes.map((d) => d.shift.meanV).filter((x): x is number => x !== null)),
      phaseTouchedBiasU: spread(
        decodes
          .filter((d) => d.phaseTouched)
          .map((d) => d.shift.meanU)
          .filter((x): x is number => x !== null),
      ),
      gross: decodes.reduce((a, d) => a + (d.shift.gross ?? 0), 0),
      acceptedDelta: spread(decodes.map((d) => d.acceptedDelta)),
    },
    page: captures.some((c) => c.positions.some((p) => p.page !== null))
      ? {
          positions: captures.flatMap((c) => c.positions.filter((p) => p.page !== null)).length,
          placedAny: captures.flatMap((c) =>
            c.positions.filter((p) => p.page !== null && p.page.placed.length > 0),
          ).length,
        }
      : null,
  };
}

/**
 * The refine band, validated on R1 (§6): every R1 run was computed fully
 * noisy and noiseless, so the refined verdict at margin M — noisy inside the
 * band, noiseless outside — can be held to the fully noisy one. Widened in
 * 0.01 steps until 98% of touched attributable runs agree: the runs a
 * category is made of.
 */
function validateRefine(ev: Evidence): {
  margin: number | null;
  steps: { margin: number; agree: number; runs: number; share: number | null }[];
  ceilingReached: boolean;
} {
  const captures = Object.entries(ev.rescore.units)
    .filter(([key]) => key.startsWith('A:main:'))
    .flatMap(([, u]) => u.score?.cells.R1 ?? []);
  const steps = [];
  for (let m = REFINE_MARGIN; m <= REFINE_CEILING + 1e-9; m = round(m + 0.01, 4) as number) {
    let agree = 0;
    let runs = 0;
    for (const cap of captures) {
      for (const pos of cap.positions) {
        if (!pos.changed) continue;
        const twin = twinFor(ev, 'main', cap.rig, pos.pos);
        for (const p of pos.touched) {
          if (!twin.placedContent.includes(p)) continue;
          const run = pos.content[p];
          if (run.on === null) throw new Error('experiment10: an R1 run was not evaluated noisy');
          const refined = inBand(run, twin.runs[p].noiseFloor, m) ? run.on : run.o0;
          runs++;
          if ((refined === 'placed') === (run.on === 'placed')) agree++;
        }
      }
    }
    steps.push({ margin: m, agree, runs, share: runs === 0 ? null : round(agree / runs, 5) });
    if (runs === 0 || agree / runs >= REFINE_AGREEMENT)
      return { margin: m, steps, ceilingReached: false };
  }
  return { margin: REFINE_CEILING, steps, ceilingReached: true };
}

/** A missing cell stops the sentence rather than printing a hole in it. */
export function at<T>(cells: Record<string, T>, key: string): T {
  const v = cells[key];
  if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) {
    throw new Error(
      `experiment10: the verdict needs cell '${key}', and the document does not have it`,
    );
  }
  return v;
}

export function assemble(ctx: RunContext): Record<string, unknown> | null {
  const { plan } = ctx;
  const missing: string[] = [];
  const need = <T>(stage: StageName): StageFile<T> | null => {
    const f = readStage<T>(ctx, stage);
    if (!f.complete) {
      missing.push(stage);
      return null;
    }
    return f;
  };
  const q0 = need<Q0Unit>('q0');
  const bank = need<BankUnit>('bank');
  const gate = need<GateUnit>('gate');
  const decode = need<DecodeUnit>('decode');
  const pose = plan.pose ? need<PoseUnit>('pose') : null;
  const rescore = need<RescoreUnit>('rescore');
  const lateness = need<RescoreUnit>('lateness');
  if (
    q0 === null ||
    bank === null ||
    gate === null ||
    decode === null ||
    (plan.pose && pose === null) ||
    rescore === null ||
    lateness === null
  ) {
    ctx.log(`\nnot writing a results file: stages still missing — ${missing.join(', ')}`);
    return null;
  }
  loadSolves(ctx);
  const ev: Evidence = {
    plan,
    q0,
    bank,
    gate,
    decode,
    pose,
    rescore,
    lateness,
    solves: ctx.solves,
  };

  // ----- precondition: Q0, Q0b, the twins
  const q0Positions = Object.values(q0.units).flatMap((u) => u.positions);
  const byWhich = (which: Which) => {
    const ps = q0Positions.filter((p) => p.which === which);
    return {
      positions: ps.length,
      placedPositions: ps.filter((p) => p.runsPlaced.length > 0).length,
      photographs: ps.reduce((a, p) => a + p.total, 0),
      placedPhotographs: ps.reduce((a, p) => a + p.placed, 0),
      margin: spread(ps.map((p) => p.margin)),
      reasons: countBy(
        ps.flatMap((p) => [...new Set(p.reasons)]),
        (r) => r,
      ),
      perRunAlone: {
        runs: ps.length * PROJECTORS,
        margin: spread(ps.flatMap((p) => p.perRun.map((r) => r.margin))),
        wrongKinds: spread(ps.flatMap((p) => p.perRun.map((r) => r.wrongKinds))),
        // A run per-run normalisation would rescue: separable, and every frame the right kind.
        rescued: ps
          .flatMap((p) => p.perRun)
          .filter((r) => r.margin >= MIN_CLASSIFY_MARGIN && r.wrongKinds === 0).length,
      },
    };
  };
  const worth = Object.values(q0.units).find((u) => u.worth !== null)?.worth ?? null;
  const contingencyRigs = [...pageColumnRigsOf(q0)];
  const shapes = Object.values(q0.units).flatMap((u) => u.shapes);
  const baseline = (rig: number, camera: number) =>
    shapes.find((x) => x.rig === rig && x.camera === camera && x.shape === 'leading 0, trailing 0');
  const shapeNames = [...new Set(shapes.map((x) => x.shape))];
  const q0b = shapeNames.map((shape) => {
    const these = shapes.filter((x) => x.shape === shape);
    return {
      shape,
      positions: these.length,
      runsPlaced: these.reduce((a, x) => a + x.placed.length, 0),
      runsPlacedClean: these.reduce(
        (a, x) => a + (baseline(x.rig, x.camera)?.placed.length ?? 0),
        0,
      ),
      wholeRefused: these.filter((x) => x.placed.length === 0).length,
      reasons: countBy(
        these.flatMap((x) => x.problems.map(reasonOf)),
        (r) => r,
      ),
      // Verbatim, from the first rig's first camera: the words an operator would read.
      problems: these[0]?.problems ?? [],
    };
  });
  const twinsOf = (which: Which) =>
    Object.entries(bank.units)
      .filter(([key]) => parseUnit(key).which === which)
      .flatMap(([, u]) => u.twins);
  const twinSummary = (which: Which) => {
    const runs = twinsOf(which).flatMap((t) => t.runs);
    return {
      cameras: twinsOf(which).length,
      runs: runs.length,
      attributable: runs.filter((r) => r.placed).length,
      refusedClean: runs.filter((r) => !r.placed).length,
      refusedCleanShare:
        runs.length === 0 ? null : round(runs.filter((r) => !r.placed).length / runs.length, 5),
      invisible: runs.filter((r) => r.litShare === 0).length,
      invisibleRefused: runs.filter((r) => r.litShare === 0 && !r.placed).length,
      minor: runs.filter((r) => r.placed && r.minor).length,
      marginal: runs.filter((r) => r.marginal).length,
      noiseFloor: spread(runs.filter((r) => r.placed).map((r) => r.noiseFloor ?? Number.NaN)),
      worthUsable: twinsOf(which).filter((t) => t.worthUsable).length,
    };
  };
  const precondition = {
    q0: {
      main: byWhich('main'),
      spill: byWhich('spill'),
      fine: byWhich('fine'),
      total: q0Positions.length,
      placedPositions: q0Positions.filter((p) => p.runsPlaced.length > 0).length,
      maxMargin: round(Math.max(...q0Positions.map((p) => p.margin)), 4),
      positions: q0Positions.map((p) => ({
        which: p.which,
        rig: p.rig,
        camera: p.camera,
        placed: p.placed,
        total: p.total,
        runsPlaced: p.runsPlaced,
        margin: round(p.margin, 4),
        wrongKinds: p.wrongKinds,
        perRun: p.perRun.map((r) => ({ margin: round(r.margin, 4), wrongKinds: r.wrongKinds })),
        problems: p.problems,
        description: p.description,
      })),
      worth,
      contingency: { triggered: contingencyRigs.length > 0, rigs: contingencyRigs },
    },
    q0b,
    twins: { main: twinSummary('main'), spill: twinSummary('spill'), fine: twinSummary('fine') },
  };

  // ----- gate
  const gateUnits = Object.entries(gate.units);
  const gateRuns = (which: Which) =>
    gateUnits
      .filter(([key]) => parseUnit(key).which === which)
      .flatMap(([key, u]) => u.runs.map((r) => ({ ...r, rig: parseUnit(key).k })));
  const mainRuns = gateRuns('main');
  const attributable = mainRuns.filter((r) => r.attributable);
  const crossed = (dir: 'forward' | 'backward') =>
    attributable.filter((r) => r[dir].s !== null).map((r) => r[dir].s as number);
  const positionsSpread: number[] = [];
  const byPosition = new Map<string, number[]>();
  for (const r of attributable) {
    if (r.forward.s === null) continue;
    const key = `${r.rig}:${r.camera}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), r.forward.s]);
  }
  for (const xs of byPosition.values())
    if (xs.length >= 2) positionsSpread.push(Math.max(...xs) - Math.min(...xs));
  const bindingForward = countBy(
    attributable.filter((r) => r.forward.pair !== null),
    (r) => PAIR_NAMES[r.forward.pair as number],
  );
  const u0Runs = mainRuns.filter(
    (r) =>
      r.attributable &&
      r.litShare >= 0.01 &&
      r.u0 !== null &&
      r.u0.analytic !== null &&
      r.u0.rendered !== null,
  );
  const u0Errors = u0Runs.map((r) =>
    Math.abs((r.u0?.analytic as number) - (r.u0?.rendered as number)),
  );
  const singles = gateUnits.flatMap(([key, u]) =>
    u.single.map((x) => ({ ...x, rig: parseUnit(key).k })),
  );
  const singleByClass = SPECS.map((_, f) => ({
    frame: f,
    class: FRAME_CLASSES[f],
    levels: plan.singleLevels.map((s) => {
      const these = singles.filter((x) => x.s === s);
      return {
        s,
        own: spread(these.map((x) => x.own[f]).filter((x): x is number => x !== null)),
        worst: spread(these.map((x) => x.worst[f]).filter((x): x is number => x !== null)),
      };
    }),
  }));
  const identities = {
    h1: { checked: 0, failures: [] as string[] },
    h2: { checked: 0, failures: [] as string[] },
    h4: { checked: 0, failures: [] as string[] },
  };
  for (const [, u] of gateUnits) {
    for (const id of ['h1', 'h2', 'h4'] as const) {
      identities[id].checked += u.identities[id].checked;
      identities[id].failures.push(...u.identities[id].failures);
    }
  }
  const noisy = gateUnits.flatMap(([key, u]) =>
    u.noisy.map((x) => ({ ...x, rig: parseUnit(key).k })),
  );
  const noisyAgreement = (() => {
    let runs = 0;
    let agree = 0;
    const disagreements: string[] = [];
    for (const rec of noisy) {
      const twin = twinFor(ev, 'main', rec.rig, rec.camera);
      for (const r of rec.runs) {
        if (!twin.placedContent.includes(r.projector)) continue;
        runs++;
        if (r.noisy === r.noiseless) agree++;
        else
          disagreements.push(
            `rig ${rec.rig} camera ${rec.camera} run ${r.projector + 1} ${rec.direction} ` +
              `${rec.s}: noisy ${r.noisy ? 'placed' : 'refused'}, noiseless ` +
              `${r.noiseless ? 'placed' : 'refused'} (worst ${round(r.worstNoisy, 4)} / ` +
              `${round(r.worstNoiseless, 4)})`,
          );
      }
    }
    return { runs, agree, share: runs === 0 ? null : round(agree / runs, 5), disagreements };
  })();
  const topNoisy = Math.max(...plan.noisyLevels);
  const noisyTop = noisy
    .filter((x) => x.s === topNoisy)
    .flatMap((x) =>
      x.runs.filter((r) =>
        twinFor(ev, 'main', x.rig, x.camera).placedContent.includes(r.projector),
      ),
    );
  const hooks = gateUnits.flatMap(([key, u]) =>
    u.hook.map((x) => ({ ...x, rig: parseUnit(key).k })),
  );
  const rolling = gateUnits.flatMap(([key, u]) =>
    u.rolling.map((x) => ({ ...x, rig: parseUnit(key).k })),
  );
  const rollingShift = (ratio: number) => {
    const shifts: number[] = [];
    for (const r of rolling.filter((x) => x.readoutOverExposure === ratio)) {
      const global =
        mainRuns.find(
          (g) => g.rig === r.rig && g.camera === r.camera && g.projector === r.projector,
        )?.forward.s ?? null;
      if (global !== null && r.crossing.s !== null) shifts.push(r.crossing.s - global);
    }
    return {
      readoutOverExposure: round(ratio, 4),
      runs: shifts.length,
      shift: spread(shifts),
      movedOver002: shifts.filter((x) => Math.abs(x) > 0.02).length,
    };
  };
  const gain = gateUnits.flatMap(([, u]) => u.gain);
  const gainTable = plan.gainSigmas.map((sigma) => ({
    sigma,
    levels: [0, ...plan.gainLevels].map((s) => {
      const these = gain.filter((g) => g.sigma === sigma && g.s === s);
      const trials = these.reduce((a, g) => a + g.trials, 0);
      const refused = these.reduce((a, g) => a + g.refused, 0);
      const flipped = these.reduce((a, g) => a + g.flipped, 0);
      return {
        s,
        trials,
        refused,
        refusedShare: trials === 0 ? null : round(refused / trials, 5),
        flipped,
      };
    }),
  }));
  const encodeOf = (which: Which) =>
    gateUnits.filter(([key]) => parseUnit(key).which === which).flatMap(([, u]) => u.encode);
  const encodeSummary = (which: Which) => {
    const rs = encodeOf(which);
    return {
      records: rs.length,
      maxDelta: round(Math.max(0, ...rs.map((r) => r.maxDelta ?? 0)), 6),
      byLevel: [0, ...plan.encodeLevels].map((s) => ({
        s,
        maxDelta: round(Math.max(0, ...rs.filter((r) => r.s === s).map((r) => r.maxDelta ?? 0)), 6),
      })),
      toneFloor: round(Math.max(0, ...rs.filter((r) => r.s === 0).map((r) => r.worstTone ?? 0)), 6),
      toneMaxDelta: round(Math.max(0, ...rs.map((r) => r.maxDeltaTone ?? 0)), 6),
    };
  };
  const encodeCrossings = gateUnits.flatMap(([, u]) => u.encodeCrossings);
  const fineRuns = gateRuns('fine');
  const resolution = fineRuns
    .filter((r) => r.attributable)
    .map((r) => {
      const base = mainRuns.find(
        (g) => g.rig === r.rig && g.camera === r.camera && g.projector === r.projector,
      );
      return {
        rig: r.rig,
        camera: r.camera,
        projector: r.projector,
        fine: r.forward.s,
        base: base?.forward.s ?? null,
        fineBackward: r.backward.s,
        baseBackward: base?.backward.s ?? null,
      };
    });
  const spillRuns = gateRuns('spill');
  const shorts = gateUnits.flatMap(([, u]) => u.short);
  const shortTable = plan.shortRowFractions.map((rowFraction) => {
    const runs = shorts
      .filter((x) => x.rowFraction === rowFraction)
      .flatMap((x) => x.runs.filter((r) => r.attributable));
    return {
      rowFraction,
      attributable: runs.length,
      refused: runs.filter((r) => r.outcome !== 'placed').length,
      outcomes: countBy(runs, (r) => r.outcome),
    };
  });
  const gateDoc = {
    crossings: {
      attributableRuns: attributable.length,
      neverRefused: {
        forward: attributable.filter((r) => r.forward.s === null).length,
        backward: attributable.filter((r) => r.backward.s === null).length,
      },
      refusedClean: attributable.filter((r) => r.forward.s === 0).length,
      forward: spread(crossed('forward')),
      backward: spread(crossed('backward')),
      // Over every attributable run: one the scan never refused counts as a
      // crossing above the limit, not as a run that is not there.
      belowLimitShare:
        attributable.length === 0
          ? null
          : round(
              crossed('forward').filter((s) => s < COMPLEMENT_LIMIT).length / attributable.length,
              5,
            ),
      medianCountingNever: medianCountingNever(crossed('forward'), attributable.length),
      bindingPairForward: bindingForward,
      bindingU0Share: (() => {
        const bound = attributable.filter((r) => r.forward.pair !== null);
        return bound.length === 0
          ? null
          : round(bound.filter((r) => r.forward.pair === 0).length / bound.length, 5);
      })(),
      withinPositionSpread: {
        positions: positionsSpread.length,
        spread: spread(positionsSpread),
        atLeast002: positionsSpread.filter((x) => x >= 0.02).length,
      },
      nonMonotone: attributable.filter((r) => r.forward.nonMonotone || r.backward.nonMonotone)
        .length,
      u0: { runs: u0Runs.length, error: spread(u0Errors, 6) },
      pairsForward: PAIR_NAMES.map((name, m) => ({
        pair: name,
        crossing: spread(
          attributable.map((r) => r.pairsForward[m]).filter((x): x is number => x !== null),
        ),
      })),
      runs: mainRuns.map((r) => ({
        rig: r.rig,
        camera: r.camera,
        projector: r.projector,
        lit: round(r.litShare, 5),
        attributable: r.attributable,
        forward: round(r.forward.s, 5),
        forwardPair: r.forward.pair === null ? null : PAIR_NAMES[r.forward.pair],
        backward: round(r.backward.s, 5),
        backwardPair: r.backward.pair === null ? null : PAIR_NAMES[r.backward.pair],
        u0Analytic: round(r.u0?.analytic ?? null, 5),
        u0Rendered: round(r.u0?.rendered ?? null, 5),
      })),
    },
    single: { byFrame: singleByClass },
    noisy: {
      levels: plan.noisyLevels,
      agreement: noisyAgreement,
      top: {
        s: topNoisy,
        attributable: noisyTop.length,
        refused: noisyTop.filter((r) => !r.noisy).length,
      },
      noiseFloor: precondition.twins.main.noiseFloor,
    },
    hook: hooks.map((h) => ({
      ...h,
      identicalShare: round(h.identical / h.pixels, 7),
      biasU: round(h.biasU, 7),
      biasV: round(h.biasV, 7),
    })),
    rolling: plan.rollingRatios.map(rollingShift),
    spill: {
      runs: spillRuns.length,
      attributable: spillRuns.filter((r) => r.attributable).length,
      forward: spread(
        spillRuns
          .filter((r) => r.attributable && r.forward.s !== null)
          .map((r) => r.forward.s as number),
      ),
      clean: precondition.twins.spill,
    },
    gain: gainTable,
    encoding: {
      main: encodeSummary('main'),
      fine: encodeSummary('fine'),
      crossings: encodeCrossings.map((x) => ({
        ...x,
        linear: round(x.linear, 5),
        encoded: round(x.encoded, 5),
        tone: round(x.tone, 5),
      })),
      toneShift: spread(
        encodeCrossings
          .filter((x) => x.tone !== null && x.encoded !== null)
          .map((x) => (x.tone as number) - (x.encoded as number)),
      ),
      encodeShift: spread(
        encodeCrossings
          .filter((x) => x.linear !== null && x.encoded !== null)
          .map((x) => (x.encoded as number) - (x.linear as number)),
      ),
    },
    resolution: {
      runs: resolution.length,
      forwardShift: spread(
        resolution
          .filter((r) => r.fine !== null && r.base !== null)
          .map((r) => (r.fine as number) - (r.base as number)),
      ),
      backwardShift: spread(
        resolution
          .filter((r) => r.fineBackward !== null && r.baseBackward !== null)
          .map((r) => (r.fineBackward as number) - (r.baseBackward as number)),
      ),
      pairs: resolution,
    },
    short: shortTable,
  };

  // ----- decode
  const decodeRuns = Object.entries(decode.units).flatMap(([key, u]) =>
    u.runs.map((r) => ({ ...r, rig: parseUnit(key).k })),
  );
  const levelKeys = [
    ...new Set(decodeRuns.flatMap((r) => r.levels.map((l) => `${l.direction}:${l.s}`))),
  ];
  const curve = levelKeys
    .map((key) => {
      const [direction, sText] = key.split(':');
      const s = Number(sText);
      const ls = decodeRuns.flatMap((r) =>
        r.levels.filter((l) => l.direction === direction && l.s === s),
      );
      return {
        direction,
        s,
        runs: ls.length,
        meanU: spread(ls.map((l) => l.shift.meanU as number).filter((x) => x !== null)),
        meanV: spread(ls.map((l) => l.shift.meanV as number).filter((x) => x !== null)),
        ratioU: spread(ls.map((l) => l.ratioU as number).filter((x) => x !== null)),
        ratioV: spread(ls.map((l) => l.ratioV as number).filter((x) => x !== null)),
        fractionOfPeriodU: spread(
          ls.map((l) =>
            l.shift.meanU === null ? Number.NaN : (l.shift.meanU as number) / PERIOD_PX.u,
          ),
        ),
        medianAbsU: spread(ls.map((l) => l.shift.medianAbsU as number).filter((x) => x !== null)),
        p95AbsU: spread(ls.map((l) => l.shift.p95AbsU as number).filter((x) => x !== null)),
        truthMedianAbs: spread(
          ls.map((l) => l.truth.medianAbs as number).filter((x) => x !== null),
        ),
        mmError: spread(ls.map((l) => l.mm.errorMedian as number).filter((x) => x !== null)),
        mmShift: spread(ls.map((l) => l.mm.shiftMedian as number).filter((x) => x !== null)),
        gross: ls.reduce((a, l) => a + ((l.shift.gross as number) ?? 0), 0),
        wrongFringe: ls.reduce((a, l) => a + ((l.shift.wrongFringe as number) ?? 0), 0),
        matched: ls.reduce((a, l) => a + ((l.shift.matched as number) ?? 0), 0),
        acceptedDelta: spread(ls.map((l) => l.statsDelta.accepted)),
        grayAmbiguousDelta: spread(ls.map((l) => l.statsDelta.rejectedGrayAmbiguous)),
      };
    })
    .sort((a, b) => (a.direction === b.direction ? a.s - b.s : a.direction < b.direction ? 1 : -1));
  const pageLevels = [
    ...new Set(decodeRuns.flatMap((r) => r.page.map((l) => `${l.direction}:${l.s}`))),
  ].map((key) => {
    const [direction, sText] = key.split(':');
    const s = Number(sText);
    const ls = decodeRuns.flatMap((r) =>
      r.page.filter((l) => l.direction === direction && l.s === s),
    );
    const deltas = ls.map((l) =>
      Math.max(
        Math.abs(((l.shift.meanU as number) ?? 0) - (l.linearMeanU ?? 0)),
        Math.abs(((l.shift.meanV as number) ?? 0) - (l.linearMeanV ?? 0)),
      ),
    );
    return {
      direction,
      s,
      runs: ls.length,
      biasU: spread(ls.map((l) => l.shift.meanU as number).filter((x) => x !== null)),
      linearBiasU: spread(ls.map((l) => l.linearMeanU as number).filter((x) => x !== null)),
      encodeBiasDelta: spread(deltas, 6),
      sigmaInflationU: spread(ls.map((l) => l.sigmaInflationU as number).filter((x) => x !== null)),
      sigmaInflationV: spread(ls.map((l) => l.sigmaInflationV as number).filter((x) => x !== null)),
      acceptedDelta: spread(ls.map((l) => (l.buckets?.accepted ?? 0) - l.twinAccepted)),
      problems: countBy(
        ls.flatMap((l) => l.problems),
        (x) => x,
      ),
    };
  });
  const singleDecodes = Object.entries(decode.units).flatMap(([key, u]) =>
    u.single.map((x) => ({ ...x, rig: parseUnit(key).k })),
  );
  const singleClasses = SPECS.map((_, f) =>
    ['forward', 'backward'].flatMap((direction) =>
      plan.singleFrameLevels.map((s) => {
        const these = singleDecodes.filter(
          (x) => x.frame === f && x.direction === direction && x.s === s,
        );
        return {
          frame: f,
          class: FRAME_CLASSES[f],
          direction,
          s,
          runs: these.length,
          identical: these.filter((x) => x.identical).length,
          moved: these.reduce((a, x) => a + x.moved, 0),
          matched: these.reduce((a, x) => a + x.matched, 0),
          meanU: spread(
            these.map((x) => x.meanU as number).filter((x) => x !== null),
            6,
          ),
          acceptedDelta: spread(these.map((x) => x.acceptedDelta)),
        };
      }),
    ),
  ).flat();
  const verdictLevel = decodeRuns.flatMap((r) =>
    r.levels.filter((l) => l.direction === 'forward' && l.s === VERDICT_S),
  );
  const decodeDoc = {
    runs: decodeRuns.length,
    curve,
    verdictLevel: {
      s: VERDICT_S,
      runs: verdictLevel.length,
      absMeanU: spread(verdictLevel.map((l) => Math.abs(l.shift.meanU as number))),
      mmShift: spread(
        verdictLevel.map((l) => l.mm.shiftMedian as number).filter((x) => x !== null),
      ),
    },
    page: pageLevels,
    single: singleClasses,
    rolling: plan.rollingDecode.ratios.flatMap((ratio) =>
      plan.rollingDecode.midRow.map((midRow) => {
        const these = decodeRuns.flatMap((r) =>
          r.rolling.filter((x) => x.readoutOverExposure === ratio && x.midRow === midRow),
        );
        return {
          readoutOverExposure: round(ratio, 4),
          midRow,
          runs: these.length,
          meanU: spread(these.map((x) => x.meanU as number).filter((x) => x !== null)),
          slopeU: spread(
            these.map((x) => x.slopeU as number).filter((x) => x !== null),
            7,
          ),
          slopeV: spread(
            these.map((x) => x.slopeV as number).filter((x) => x !== null),
            7,
          ),
        };
      }),
    ),
    short: plan.shortRowFractions.map((rowFraction) => {
      const these = decodeRuns.flatMap((r) => r.short.filter((x) => x.rowFraction === rowFraction));
      return {
        rowFraction,
        runs: these.length,
        nextRows: these[0]?.nextRows ?? null,
        nextMatched: these.reduce((a, x) => a + x.nextMatched, 0),
        nextGross: these.reduce((a, x) => a + x.nextGross, 0),
        mixedMatched: these.reduce((a, x) => a + x.mixedMatched, 0),
        mixedGross: these.reduce((a, x) => a + x.mixedGross, 0),
        acceptedDelta: spread(these.map((x) => x.acceptedDelta)),
      };
    }),
    ablation: {
      s: 0.1,
      pageSuccessor: {
        meanU: spread(
          decodeRuns.map((r) => r.ablation.page.meanU as number).filter((x) => x !== null),
        ),
        sigmaU: spread(
          decodeRuns.map((r) => r.ablation.page.sigmaU as number).filter((x) => x !== null),
        ),
      },
      darkSuccessor: {
        meanU: spread(
          decodeRuns.map((r) => r.ablation.dark.meanU as number).filter((x) => x !== null),
        ),
        sigmaU: spread(
          decodeRuns.map((r) => r.ablation.dark.sigmaU as number).filter((x) => x !== null),
        ),
      },
    },
  };

  // ----- pose
  const tau = tauNull(ev);
  const poseCases = Object.values(pose?.units ?? {}).flatMap((u) =>
    u.levels.map((l) => {
      const treated = solveOf(ev, l.treated);
      const twin = solveOf(ev, l.twin);
      const gridFlip =
        treated !== null &&
        twin !== null &&
        treated.gridMm !== null &&
        twin.gridMm !== null &&
        treated.gridCensored === false &&
        twin.gridCensored === false
          ? twin.gridMm <= GRID_GATE_MM && treated.gridMm > GRID_GATE_MM
          : null;
      const rotationFlip =
        treated !== null &&
        twin !== null &&
        treated.rotationDeg !== null &&
        twin.rotationDeg !== null
          ? twin.rotationDeg <= ROTATION_GATE_DEG && treated.rotationDeg > ROTATION_GATE_DEG
          : null;
      return {
        rig: u.rig,
        camera: u.camera,
        label: l.label,
        direction: l.direction,
        s: l.s,
        readoutOverExposure: l.readoutOverExposure,
        refused: l.refused,
        allRefused: l.allRefused,
        dGridMm: round(treated?.against?.dGridMm ?? null, 5),
        p95Mm: round(treated?.against?.p95Mm ?? null, 5),
        rmsMm: round(treated?.against?.rmsMm ?? null, 5),
        dGridCensored: treated?.against?.censored ?? null,
        gTwinMm: round(twin?.gridMm ?? null, 5),
        gTreatedMm: round(treated?.gridMm ?? null, 5),
        gTwinCensored: twin?.gridCensored ?? null,
        gTreatedCensored: treated?.gridCensored ?? null,
        gridFlip,
        rotationFlip,
        positionShiftMm: round(treated?.against?.positionShiftMm ?? null, 4),
        audit: treated?.audit ?? null,
        errors: [treated?.error, twin?.error].filter((x) => x !== null && x !== undefined),
      };
    }),
  );
  const poseLevelKeys = [...new Set(poseCases.map((x) => x.label))];
  const poseDoc = {
    solved: plan.pose,
    tauNull: {
      value: tau.value,
      lo: tau.lo,
      hi: tau.hi,
      samples: tau.samples,
      perRig: Object.fromEntries(
        Object.entries(tau.byRig).map(([k, xs]) => [k, xs.map((x) => round(x, 5))]),
      ),
    },
    levels: poseLevelKeys.map((label) => {
      const these = poseCases.filter((x) => x.label === label);
      const solved = these.filter((x) => x.dGridMm !== null);
      return {
        label,
        cases: these.length,
        allRefused: these.filter((x) => x.allRefused).length,
        dGridMm: spread(solved.map((x) => x.dGridMm as number)),
        overTau:
          tau.value === null
            ? null
            : solved.filter((x) => (x.dGridMm as number) > (tau.value as number)).length,
        over025: solved.filter((x) => (x.dGridMm as number) > 0.25).length,
        over05: solved.filter((x) => (x.dGridMm as number) > 0.5).length,
        gridFlips: these.filter((x) => x.gridFlip === true).length,
        rotationFlips: these.filter((x) => x.rotationFlip === true).length,
      };
    }),
    cases: poseCases,
    auditDisagreements: poseCases.flatMap((x) => x.audit?.disagreements ?? []),
  };

  // ----- rescore and lateness
  const refine = validateRefine(ev);
  const margin = refine.margin ?? REFINE_MARGIN;
  const refined = (run: RunScore, floor: number | null): boolean => inBand(run, floor, margin);
  const tauValue = plan.pose ? tau.value : null;
  const rescoreDoc = {
    audit: (rescore.units.audit?.audit ?? []).map((a) => ({ ...a })),
    refine: { ...refine, ceiling: REFINE_CEILING, agreementRequired: REFINE_AGREEMENT },
    cells: rescoreCells(plan).map((cell) =>
      summariseCell(ev, cell, rescore, cell.mode === 'noisy' ? () => true : refined, tauValue),
    ),
  };
  const timing = lateness.units.timing?.timing ?? [];
  const firstTouched = (vsync: boolean): number | null => {
    const hit = timing
      .filter(
        (x) =>
          x.arm === 'intervalometer-100ppm' &&
          x.phase === 'aimed' &&
          x.vsync === vsync &&
          x.capturesTouched / x.trials >= 0.01,
      )
      .map((x) => x.lateMs);
    return hit.length === 0 ? null : Math.min(...hit);
  };
  const latenessDoc = {
    timing,
    aimedFirstTouchedMs: { vsyncOff: firstTouched(false), vsyncOn: firstTouched(true) },
    cells: latenessCells(plan).map((cell) => summariseCell(ev, cell, lateness, refined, tauValue)),
  };

  // ----- harness identities (must hold on correct code; recorded, not predicted)
  const closed = closedForm();
  const forward10 = decodeRuns.flatMap((r) =>
    r.levels.filter((l) => l.direction === 'forward' && l.s === 0.1).map((l) => ({ r, l })),
  );
  const h6Ratios = forward10
    .flatMap(({ l }) => [l.ratioU, l.ratioV])
    .filter((x): x is number => x !== null);
  const h5Rows = singleDecodes.filter((x) => x.s <= 0.4);
  const h7 = (() => {
    const failures: string[] = [];
    let checked = 0;
    const below = plan.decodeNoiseless.filter((s) => s < 3 / 7);
    const above = plan.decodeNoiseless.filter((s) => s >= 3 / 7);
    for (const r of decodeRuns) {
      for (const direction of ['forward', 'backward'] as const) {
        if (direction === 'backward' && r.projector !== 0) continue;
        for (const l of r.levels.filter((x) => x.direction === direction && x.halves !== null)) {
          checked++;
          const clean = r.cleanHalves.dark.grayAmbiguous;
          const got = (l.halves as { dark: HalfStats }).dark.grayAmbiguous;
          if (below.includes(l.s) && got !== clean)
            failures.push(
              `rig ${r.rig} camera ${r.camera} run ${r.projector + 1} ${direction} ${l.s}: ` +
                `${got - clean} Gray-ambiguous pixels on the MSB-dark half below 3/7`,
            );
          if (above.includes(l.s) && got <= clean)
            failures.push(
              `rig ${r.rig} camera ${r.camera} run ${r.projector + 1} ${direction} ${l.s}: ` +
                `no Gray-ambiguous pixels on the MSB-dark half at or above 3/7`,
            );
        }
      }
      // A confident flip is a Gray bit read wrong AND trusted: the decode lands
      // in another fringe, a stride or more from where it was. Counted as
      // such, not as `gross` (a quarter period), which also takes in phase
      // errors the unwrap tolerance lets through with the fringe order right.
      for (const l of r.levels.filter((x) => x.s < 5 / 9)) {
        checked++;
        if ((l.shift.wrongFringe as number) > 0)
          failures.push(
            `rig ${r.rig} camera ${r.camera} run ${r.projector + 1} ${l.direction} ${l.s}: ` +
              `${l.shift.wrongFringe} wrong-fringe decodes below 5/9`,
          );
      }
      for (const l of r.levels.filter(
        (x) => x.direction === 'forward' && x.s === 0.5 && x.halves !== null,
      )) {
        checked++;
        if ((l.halves as { lit: HalfStats }).lit.accepted !== 0)
          failures.push(
            `rig ${r.rig} camera ${r.camera} run ${r.projector + 1}: ` +
              `${(l.halves as { lit: HalfStats }).lit.accepted} pixels still accepted on the ` +
              `MSB-lit half at s = 0.5`,
          );
      }
    }
    return { checked, failures };
  })();
  const harness = [
    {
      id: 'H1',
      claim: 'A lone straddled Gray plane reads at most its smear (own pair, noiseless).',
      measured: { checked: identities.h1.checked, failures: identities.h1.failures.slice(0, 20) },
      pass: identities.h1.checked > 0 ? identities.h1.failures.length === 0 : null,
    },
    {
      id: 'H2',
      claim:
        'A lone straddled G_u0 reads at least 0.95 of its smear on runs lighting at least 1% of ' +
        'the photograph.',
      measured: { checked: identities.h2.checked, failures: identities.h2.failures.slice(0, 20) },
      pass: identities.h2.checked > 0 ? identities.h2.failures.length === 0 : null,
    },
    {
      id: 'H3',
      claim:
        'Projector space, aligned 64-block grid: pair u0 reads 2s/(2-3s) and every other pair ' +
        '1.5s/(2-3s) under a whole-run forward blend.',
      measured: closed,
      pass: closed.worstError <= 1e-4,
    },
    {
      id: 'H4',
      claim: 'Straddles confined to the phase frames leave every pair residual bit-identical.',
      measured: { checked: identities.h4.checked, failures: identities.h4.failures.slice(0, 20) },
      pass: identities.h4.checked > 0 ? identities.h4.failures.length === 0 : null,
    },
    {
      id: 'H5',
      claim:
        'Lone straddles of frames 2-25 at s <= 0.4 leave every correspondence bit-identical; of ' +
        'frames 0-1, every coordinate on the common set.',
      measured: {
        checked: h5Rows.length,
        grayNotIdentical: h5Rows
          .filter((x) => x.frame >= 2 && x.frame <= 25 && !x.identical)
          .map(
            (x) =>
              `rig ${x.rig} camera ${x.camera} run ${x.projector + 1} frame ${x.frame + 1} ` +
              `${x.direction} ${x.s}`,
          )
          .slice(0, 20),
        referenceMoved: h5Rows
          .filter((x) => x.frame <= 1 && x.moved > 0)
          .map(
            (x) =>
              `rig ${x.rig} camera ${x.camera} run ${x.projector + 1} frame ${x.frame + 1} ` +
              `${x.direction} ${x.s}: ${x.moved} moved`,
          )
          .slice(0, 20),
      },
      pass:
        h5Rows.length > 0
          ? h5Rows.every((x) =>
              x.frame >= 2 && x.frame <= 25 ? x.identical : x.frame <= 1 ? x.moved === 0 : true,
            )
          : null,
    },
    {
      id: 'H6',
      claim:
        'A whole-run forward blend at s = 0.10 moves the decoded coordinate by 0.70-0.80 of the ' +
        'cyclic shift atan2(s, 1-s)·P/2π, per axis. SIGNED: the recovered coordinate moves ' +
        'toward LOWER projector coordinates, so the measured ratio is negative and the identity ' +
        'is -ratio in [0.70, 0.80] (the spec states the band unsigned).',
      measured: { ratios: spread(h6Ratios, 5), runs: forward10.length },
      pass: h6Ratios.length > 0 ? h6Ratios.every((x) => -x >= 0.7 && -x <= 0.8) : null,
    },
    {
      id: 'H7',
      claim:
        'Noiseless Gray onsets: Gray-ambiguous from s = 3/7 on the MSB-dark half (forward; ' +
        'backward for run 0); no confident flip below 5/9, counted as a decode a Gray stride ' +
        '(half a period) or more from the clean one; the MSB-lit half lost to low modulation ' +
        'at s = 0.5.',
      measured: {
        checked: h7.checked,
        failures: h7.failures.slice(0, 40),
        failureCount: h7.failures.length,
        // Beside it, the spec's own gross count (a quarter period), which below
        // 5/9 is phase error, not a flip: kept so the difference is on record.
        grossBelow59: decodeRuns
          .flatMap((r) => r.levels.filter((l) => l.s < 5 / 9))
          .reduce((a, l) => a + ((l.shift.gross as number) ?? 0), 0),
      },
      pass: plan.decodeNoiseless.some((s) => s >= 0.3) ? h7.failures.length === 0 : null,
    },
    {
      id: 'H8',
      claim:
        'The fast path equals the hook render: at least 99.9% of pixels identical, the rest ' +
        'within one 12-bit step, identical verdicts, readRun bias within 0.005 px.',
      measured: gateDoc.hook,
      pass:
        hooks.length > 0
          ? hooks.every(
              (h) =>
                h.identical / h.pixels >= 0.999 &&
                h.worstSteps <= 1 &&
                h.verdictsAgree &&
                h.biasU <= 0.005 &&
                h.biasV <= 0.005,
            )
          : null,
    },
  ];

  // ----- predictions (pre-registered; each can fail)
  const r1 = rescoreDoc.cells.find((c) => c.id === 'R1');
  const aimed75 = latenessDoc.cells.find((c) => c.id === 'L-aimed-7.5') ?? null;
  const fwd = crossed('forward');
  const bwd = crossed('backward');
  const r1Positions = r1?.positions.content.all ?? null;
  const r1Touched = r1 === undefined ? 0 : r1.touchedPositions;
  const share = (n: number | undefined, d: number): number | null =>
    d === 0 || n === undefined ? null : round(n / d, 5);
  const posShares =
    r1Positions === null
      ? null
      : {
          refusedAll: share(r1Positions['REFUSED-ALL'], r1Touched),
          mixed: share(r1Positions.MIXED, r1Touched),
          placed: share(r1Positions.PLACED, r1Touched),
        };
  const poseAt = (label: string) =>
    poseCases.filter((x) => x.label === label && x.dGridMm !== null);
  const silent = r1 === undefined ? null : r1.classes.P.counts;
  const silentSolved =
    silent === null
      ? 0
      : silent['SILENT-HARMLESS'] + silent['SILENT-BIASED'] + silent['SILENT-GATE-BREAKING'];
  const aimedTiming = (lateMs: number) =>
    timing.find(
      (x) =>
        x.arm === 'intervalometer-100ppm' && x.phase === 'aimed' && x.lateMs === lateMs && !x.vsync,
    ) ?? null;
  const rolling12 =
    gateDoc.rolling.find(
      (x) => Math.abs((x.readoutOverExposure as number) - READOUT_S[1] / EXPOSURE_S) < 1e-9,
    ) ?? null;
  const predictions = [
    {
      id: 'P1',
      falsifiedIf:
        "Any attributable run's forward or backward crossing is at or above 3/7 (0.4286), with " +
        'DEFAULT_SENSOR, on any of the 24 rigs.',
      measured: {
        maxForward: round(Math.max(...fwd), 5),
        maxBackward: round(Math.max(...bwd), 5),
        neverRefused: gateDoc.crossings.neverRefused,
        noisyTop: gateDoc.noisy.top,
      },
      falsified:
        fwd.length + bwd.length === 0
          ? null
          : Math.max(...fwd, ...bwd) >= 3 / 7 ||
            gateDoc.crossings.neverRefused.forward + gateDoc.crossings.neverRefused.backward > 0,
    },
    {
      id: 'P2',
      falsifiedIf:
        'The median forward s*_run is outside [0.07, 0.15], or fewer than 50% of attributable ' +
        'runs cross below 0.15.',
      measured: {
        median: gateDoc.crossings.medianCountingNever,
        belowLimitShare: gateDoc.crossings.belowLimitShare,
        neverRefused: gateDoc.crossings.neverRefused.forward,
      },
      falsified:
        gateDoc.crossings.medianCountingNever === null
          ? null
          : gateDoc.crossings.medianCountingNever < 0.07 ||
            gateDoc.crossings.medianCountingNever > 0.15 ||
            (gateDoc.crossings.belowLimitShare ?? 0) < 0.5,
    },
    {
      id: 'P2b',
      falsifiedIf:
        'The median within-position spread of s*_run is under 0.02, or the binding pair is u0 ' +
        'in more than 80% of attributable runs.',
      measured: {
        medianSpread: gateDoc.crossings.withinPositionSpread.spread.median,
        bindingU0Share: gateDoc.crossings.bindingU0Share,
      },
      falsified:
        gateDoc.crossings.withinPositionSpread.spread.median === null ||
        gateDoc.crossings.bindingU0Share === null
          ? null
          : gateDoc.crossings.withinPositionSpread.spread.median < 0.02 ||
            gateDoc.crossings.bindingU0Share > 0.8,
    },
    {
      id: 'P2c',
      falsifiedIf:
        '|analytic - rendered pair-u0 crossing| > 0.005 on any attributable run with at least ' +
        '1% of the photo lit.',
      measured: gateDoc.crossings.u0,
      falsified:
        gateDoc.crossings.u0.runs === 0 ? null : (gateDoc.crossings.u0.error.max as number) > 0.005,
    },
    {
      id: 'P3',
      falsifiedIf:
        'At designed forward s = 0.03, D_grid <= tau_null in more than 2 of 8 designed ' +
        'rig/camera cases. Or at forward s = 0.06, the grid gate flips (G_twin <= 1.0 < ' +
        'G_treated, uncensored) in fewer than 4 of 8.',
      measured: {
        tauNull: tau.value,
        at003: {
          cases: poseAt('forward/0.03').length,
          withinTau:
            tau.value === null
              ? null
              : poseAt('forward/0.03').filter((x) => (x.dGridMm as number) <= (tau.value as number))
                  .length,
        },
        at006: {
          cases: poseAt('forward/0.06').length,
          gridFlips: poseAt('forward/0.06').filter((x) => x.gridFlip === true).length,
        },
      },
      falsified:
        !plan.pose || tau.value === null
          ? null
          : poseAt('forward/0.03').filter((x) => (x.dGridMm as number) <= (tau.value as number))
              .length > 2 || poseAt('forward/0.06').filter((x) => x.gridFlip === true).length < 4,
    },
    {
      id: 'P4',
      falsifiedIf:
        'At the headline cell, of touched positions, REFUSED-ALL outside [0.65, 0.82], MIXED ' +
        'outside [0.04, 0.14] or PLACED outside [0.10, 0.24]. (P4 as the task stated it is ' +
        'falsified if MIXED > 0 or PLACED is outside [0.15, 0.30].)',
      measured: { touchedPositions: r1Touched, shares: posShares, footing: 'content, all runs' },
      falsified:
        posShares === null || posShares.refusedAll === null
          ? null
          : (posShares.refusedAll as number) < 0.65 ||
            (posShares.refusedAll as number) > 0.82 ||
            (posShares.mixed as number) < 0.04 ||
            (posShares.mixed as number) > 0.14 ||
            (posShares.placed as number) < 0.1 ||
            (posShares.placed as number) > 0.24,
      originalP4Falsified:
        posShares === null || posShares.mixed === null
          ? null
          : (posShares.mixed as number) > 0 ||
            (posShares.placed as number) < 0.15 ||
            (posShares.placed as number) > 0.3,
    },
    {
      id: 'P4b',
      falsifiedIf:
        'Fewer than 50% of SILENT captures have D_grid > tau_null, or GATE-BREAKING is outside ' +
        '[5%, 50%] of SILENT captures.',
      measured:
        silent === null
          ? null
          : {
              silentSolved,
              biased: silent['SILENT-BIASED'],
              gateBreaking: silent['SILENT-GATE-BREAKING'],
              unsolved: silent['SILENT-UNSOLVED'],
            },
      falsified:
        silent === null || silentSolved === 0
          ? null
          : (silent['SILENT-BIASED'] + silent['SILENT-GATE-BREAKING']) / silentSolved < 0.5 ||
            silent['SILENT-GATE-BREAKING'] / silentSolved < 0.05 ||
            silent['SILENT-GATE-BREAKING'] / silentSolved > 0.5,
    },
    {
      id: 'P5a',
      falsifiedIf:
        'More than 10% of attributable runs move their crossing by more than 0.02 at rho/E = ' +
        '0.12. Or D_grid(rho/E = 0.3) is outside ±30% of D_grid(global) at s̄ = 0.06 in more ' +
        'than 2 of 8 designed cases.',
      measured: {
        gate: rolling12,
        pose: poseAt(`rolling/${plan.poseLevels.rolling.readoutOverExposure}/0.06`).map((x) => {
          const g = poseAt('forward/0.06').find((y) => y.rig === x.rig);
          return { rig: x.rig, rolling: x.dGridMm, global: g?.dGridMm ?? null };
        }),
      },
      falsified: (() => {
        const gatePart =
          rolling12 === null || rolling12.runs === 0
            ? null
            : rolling12.movedOver002 / rolling12.runs > 0.1;
        if (!plan.pose) return gatePart;
        const pairs = poseAt(`rolling/${plan.poseLevels.rolling.readoutOverExposure}/0.06`)
          .map(
            (x) =>
              [
                x.dGridMm as number,
                poseAt('forward/0.06').find((y) => y.rig === x.rig)?.dGridMm ?? null,
              ] as const,
          )
          .filter((x) => x[1] !== null && (x[1] as number) > 0);
        const posePart =
          pairs.length === 0
            ? null
            : pairs.filter(([r, g]) => Math.abs(r / (g as number) - 1) > 0.3).length > 2;
        return gatePart === true || posePart === true
          ? true
          : gatePart === null && posePart === null
            ? null
            : false;
      })(),
    },
    {
      id: 'P5b',
      falsifiedIf:
        'Fewer than 95% of attributable runs are refused at r0 = 0.25, 0.5 and 0.75 (E = 1/60, ' +
        'rho = 30 ms).',
      measured: gateDoc.short,
      falsified: gateDoc.short.every((x) => x.attributable === 0)
        ? null
        : gateDoc.short.some((x) => x.attributable > 0 && x.refused / x.attributable < 0.95),
    },
    {
      id: 'P6',
      falsifiedIf:
        'Any of the default, spill or fine clean positions places at least one run (which ' +
        'triggers the page-column contingency).',
      measured: {
        positions: precondition.q0.total,
        placedPositions: precondition.q0.placedPositions,
        maxMargin: precondition.q0.maxMargin,
        reasons: {
          main: precondition.q0.main.reasons,
          spill: precondition.q0.spill.reasons,
          fine: precondition.q0.fine.reasons,
        },
      },
      falsified: precondition.q0.placedPositions > 0,
    },
    {
      id: 'P7',
      falsifiedIf:
        'At delta = 3 ms more than 1% of aimed captures are touched; at delta = 7.5 ms fewer ' +
        'than 50% are; or at (aimed, 7.5 ms) PLACED + MIXED positions with phase-touched placed ' +
        'runs are under 20% of touched positions.',
      measured: {
        at3ms:
          aimedTiming(3) === null
            ? null
            : { touched: aimedTiming(3)?.capturesTouched, trials: aimedTiming(3)?.trials },
        at75ms:
          aimedTiming(7.5) === null
            ? null
            : { touched: aimedTiming(7.5)?.capturesTouched, trials: aimedTiming(7.5)?.trials },
        placedWithPhase:
          aimed75 === null
            ? null
            : {
                positions: aimed75.positionsPlacedWithPhase,
                touchedPositions: aimed75.touchedPositions,
              },
      },
      falsified: (() => {
        const t3 = aimedTiming(3);
        const t75 = aimedTiming(7.5);
        if (t3 === null || t75 === null || aimed75 === null) return null;
        return (
          t3.capturesTouched / t3.trials > 0.01 ||
          t75.capturesTouched / t75.trials < 0.5 ||
          aimed75.touchedPositions === 0 ||
          aimed75.positionsPlacedWithPhase / aimed75.touchedPositions < 0.2
        );
      })(),
    },
    {
      id: 'P8',
      falsifiedIf:
        'On SPILL_RIGS the share of clean runs refused is not lower than on the same rigs ' +
        'without spill.',
      measured: (() => {
        const spillTwins = twinsOf('spill');
        const same = Object.entries(bank.units)
          .filter(
            ([key]) => parseUnit(key).which === 'main' && plan.spillRigs.includes(parseUnit(key).k),
          )
          .flatMap(([, u]) => u.twins);
        const refusedShare = (ts: TwinCamera[]) => {
          const runs = ts.flatMap((t) => t.runs);
          return runs.length === 0
            ? null
            : round(runs.filter((r) => !r.placed).length / runs.length, 5);
        };
        return {
          spill: refusedShare(spillTwins),
          sameRigsNoSpill: refusedShare(same),
          spillVariant: variantOf(plan, 'spill'),
          mainVariant: variantOf(plan, 'main'),
        };
      })(),
      falsified: null as boolean | null,
    },
    {
      id: 'P9',
      falsifiedIf:
        '|dR| > 0.005 or |d bias| > 0.02 px at any designed level. Or fast-path pixels match ' +
        'hook pixels on fewer than 99.9% of pixels (the rest within one 12-bit step), or any ' +
        'verdict differs.',
      measured: {
        encodeMaxDelta: Math.max(
          gateDoc.encoding.main.maxDelta ?? 0,
          gateDoc.encoding.fine.maxDelta ?? 0,
        ),
        pageBiasMaxDelta: Math.max(0, ...pageLevels.map((x) => x.encodeBiasDelta.max ?? 0)),
        hook: harness.find((h) => h.id === 'H8')?.pass ?? null,
      },
      falsified: null as boolean | null,
    },
  ];
  const p8 = predictions.find((x) => x.id === 'P8') as {
    measured: { spill: number | null; sameRigsNoSpill: number | null };
    falsified: boolean | null;
  };
  p8.falsified =
    p8.measured.spill === null || p8.measured.sameRigsNoSpill === null
      ? null
      : !(p8.measured.spill < p8.measured.sameRigsNoSpill);
  const p9 = predictions.find((x) => x.id === 'P9') as {
    measured: { encodeMaxDelta: number; pageBiasMaxDelta: number; hook: boolean | null };
    falsified: boolean | null;
  };
  p9.falsified =
    p9.measured.encodeMaxDelta > ENCODE_BOUNDS.residual ||
    p9.measured.pageBiasMaxDelta > ENCODE_BOUNDS.biasPx ||
    p9.measured.hook === false;

  const doc = {
    schema: SCHEMA,
    mode: plan.mode,
    notice:
      plan.mode === 'full'
        ? null
        : `A ${plan.mode.toUpperCase()} run: the plumbing, at reduced size. Not the ` +
          'committed result; no number here is quoted.',
    generatedFrom: {
      codeFingerprint: ctx.fingerprint,
      staleCheckpointsAccepted: ctx.staleAccepted,
      design: designConstants(plan),
      refineCeiling: REFINE_CEILING,
      refineAgreement: REFINE_AGREEMENT,
      verdictSmear: VERDICT_S,
      caveats: CAVEATS,
    },
    precondition,
    gate: gateDoc,
    decode: decodeDoc,
    pose: poseDoc,
    rescore: rescoreDoc,
    lateness: latenessDoc,
    harness,
    predictions,
    verdict: { statement: '' },
  };
  doc.verdict.statement = verdictStatement(doc as unknown as VerdictDoc);
  return doc;
}

function pageColumnRigsOf(q0: StageFile<Q0Unit>): Set<string> {
  const out = new Set<string>();
  for (const [unit, u] of Object.entries(q0.units)) {
    if (u.positions.some((p) => p.runsPlaced.length > 0))
      out.add(unit.split(':').slice(0, 2).join(':'));
  }
  return out;
}

/**
 * Said in the file, because a reader who takes these numbers into a room needs them beside the
 * numbers.
 */
export const CAVEATS = {
  reader:
    "Every loud/silent split is the verdict of a COUNTERFACTUAL reader: the page's own " +
    "complement check (indexByFingerprint) handed exact oracle lit fractions, because today's " +
    'page refuses clean bench positions at classify before the check runs (precondition.q0). No ' +
    'fix to the page is implied.',
  footings:
    'content footing (primary): a photograph observes as the kind of the part holding more than ' +
    'half its exposure, the filed kind on a tie; filed footing (secondary): the kind of the ' +
    'step it is filed as.',
  timer:
    "The emitter is EXPERIMENT-9's perfect timer except in the lateness stage and R7, whose " +
    'lateness was measured headless (SwiftShader), not on a display machine.',
  photometry:
    'Bench photometry: flat albedo, constant ambient, Gaussian shot noise, point-sampled ' +
    'patterns, one grey channel, no defocus, no JPEG. Q0 margins, clean residual floors and ' +
    'invisible-run refusals are bench numbers.',
  folder:
    'F136: a position is exactly 136 photographs, the first the first release after Play. The ' +
    "card's own extra end photographs are measured separately (precondition.q0b).",
  fastPath:
    "Noisy frames come from the fast path — a bank blend through the renderer's own sensor and " +
    'noise stream — validated against hook renders in gate.hook (H8).',
  reshoot: 'Policy P assumes the re-shoot after a refusal is clean, which is optimistic.',
  pose:
    "Pose cost is the bench solver's. The page never solves, and its worth report cannot see a " +
    'straddle (precondition.q0.worth).',
};

export type VerdictDoc = {
  mode: string;
  precondition: { q0: { total: number; placedPositions: number; maxMargin: number | null } };
  gate: {
    crossings: { forward: { p10: number | null; median: number | null; p90: number | null } };
  };
  decode: {
    curve: { direction: string; s: number; ratioU: { median: number | null } }[];
    verdictLevel: { absMeanU: { median: number | null }; mmShift: { median: number | null } };
  };
  pose: {
    solved: boolean;
    tauNull: { value: number | null };
    levels: { label: string; dGridMm: { median: number | null } }[];
  };
  rescore: { cells: ReturnType<typeof summariseCell>[] };
  lateness: {
    cells: ReturnType<typeof summariseCell>[];
    aimedFirstTouchedMs: { vsyncOff: number | null };
  };
};

/**
 * The verdict, assembled from the document's own cells and nothing else. The
 * template is the spec's §7 with two changes, each so the sentence stays true
 * whatever the cells say: the first clause is chosen by whether any clean
 * position was placed, and the headline counts every class, so its parts add
 * up to its whole. Without solves (a quick run) the pose clauses say so.
 */
export function verdictStatement(doc: VerdictDoc): string {
  const pct = (x: number): string => `${(100 * x).toFixed(1)}`;
  // The two cells whole sentences are built from are looked up through `at`
  // like every number in them. Guarded by `=== undefined` instead, as they
  // first were, a missing headline cell printed the verdict without its
  // EXPERIMENT-9 sentence, and a missing lateness cell without its lateness
  // one, with nothing to say so: the failure `at` exists to stop.
  const byId = <T extends { id: string }>(xs: readonly T[]): Record<string, T> =>
    Object.fromEntries(xs.map((x) => [x.id, x]));
  const r1 = at(byId(doc.rescore.cells), 'R1');
  const aimed = at(byId(doc.lateness.cells), 'L-aimed-7.5');
  const ratioCell = doc.decode.curve.find((c) => c.direction === 'forward' && c.s === 0.1);
  const pose06 = doc.pose.levels.find((l) => l.label === 'forward/0.06');
  const cells: Record<string, number | string> = {
    'q0.total': doc.precondition.q0.total,
    'q0.placed': doc.precondition.q0.placedPositions,
    'q0.maxMargin': doc.precondition.q0.maxMargin ?? Number.NaN,
    p10: doc.gate.crossings.forward.p10 ?? Number.NaN,
    p50: doc.gate.crossings.forward.median ?? Number.NaN,
    p90: doc.gate.crossings.forward.p90 ?? Number.NaN,
    ratio: ratioCell?.ratioU.median ?? Number.NaN,
    px: doc.decode.verdictLevel.absMeanU.median ?? Number.NaN,
    mm: doc.decode.verdictLevel.mmShift.median ?? Number.NaN,
  };
  {
    const n = r1.classes.P.counts;
    cells.touched = r1.capturesFlagged;
    cells.recorded = r1.capturesRecorded;
    cells.loud = n.LOUD;
    cells.loudSilent = n['LOUD+SILENT'];
    cells.silent =
      n['SILENT-HARMLESS'] + n['SILENT-BIASED'] + n['SILENT-GATE-BREAKING'] + n['SILENT-UNSOLVED'];
    cells.harmless = n['SILENT-HARMLESS'];
    cells.biased = n['SILENT-BIASED'];
    cells.gate = n['SILENT-GATE-BREAKING'];
    cells.unsolved = n['SILENT-UNSOLVED'];
    cells.invisible = n['INVISIBLE-ONLY'];
    cells.unchanged = n.UNCHANGED;
    cells.trials = r1.trials;
  }
  {
    const n = aimed.classes.P.counts;
    cells.aimedTouched = aimed.capturesRecorded;
    cells.aimedTrials = aimed.trials;
    cells.aimedLoud = n.LOUD;
    cells.aimedSilent =
      n['SILENT-HARMLESS'] + n['SILENT-BIASED'] + n['SILENT-GATE-BREAKING'] + n['SILENT-UNSOLVED'];
  }
  // Null is a measurement, not a hole: no lateness swept touched 1% of aimed
  // captures. The sentence says so rather than ending early.
  const aimedFirst = doc.lateness.aimedFirstTouchedMs.vsyncOff;
  if (aimedFirst !== null) cells.aimedFirstMs = aimedFirst;
  if (doc.pose.solved) {
    cells.dgrid06 = pose06?.dGridMm.median ?? Number.NaN;
    cells.tau = doc.pose.tauNull.value ?? Number.NaN;
  }
  const c = (key: string): number | string => at(cells, key);
  const n = (key: string, digits = 2): string => (c(key) as number).toFixed(digits);
  const placed = c('q0.placed') as number;
  const first =
    placed === 0
      ? `Today's page placed none of the ${c('q0.total')} clean camera positions rendered ` +
        `from the card's three marks (classify margin at most ${n('q0.maxMargin', 3)}, ` +
        `against ${MIN_CLASSIFY_MARGIN}), so on the bench every capture is refused before ` +
        `the complement check runs, straddled or not.`
      : `Today's page placed a run in ${placed} of the ${c('q0.total')} clean camera ` +
        `positions rendered from the card's three marks (classify margin at most ` +
        `${n('q0.maxMargin', 3)}, against ${MIN_CLASSIFY_MARGIN}), and refused the rest ` +
        `before the complement check runs, straddled or not.`;
  const ratio = c('ratio') as number;
  const toward = ratio < 0 ? 'lower' : 'higher';
  const second =
    ` Given a reader whose bookends can place runs, the complement check refuses a ` +
    `whole-position straddle run by run, from ${pct(c('p10') as number)}% to ` +
    `${pct(c('p90') as number)}% of the exposure (median ${pct(c('p50') as number)}%). ` +
    `What it lets through decodes to the right fringe carrying a one-signed phase bias ` +
    `of about ${Math.abs(ratio).toFixed(2)} of atan2(s, 1−s)·P/2π, toward ${toward} ` +
    `projector coordinates for a forward straddle (${n('px')} px at the ` +
    `${PROJECTOR_RES.x} raster, ${n('mm')} mm on the sphere at s = ${VERDICT_S})` +
    (doc.pose.solved
      ? `, which moves the seams by a median ${n('dgrid06', 3)} mm, against ` +
        `${n('tau', 3)} mm for a re-shoot.`
      : `; this run solved nothing, so what that does to the seams is not measured here.`);
  const recordedNote =
    c('recorded') !== c('touched')
      ? ` (${c('recorded')} with any photograph changed or flagged)`
      : '';
  const unsolvedNote =
    (c('unsolved') as number) > 0 ? `, and ${c('unsolved')} could not be solved` : '';
  const third =
    ` Of EXPERIMENT-9's ${c('touched')} touched captures at the page's defaults under ` +
    `its perfect-timer model${recordedNote}: ${c('loud')} are refused loudly (the page ` +
    `blames a dropped and duplicated frame and asks for one projector to be re-shot, ` +
    `which it cannot read back; ${c('loudSilent')} of them also carry a silent ` +
    `position); ${c('silent')} pass silently` +
    (doc.pose.solved
      ? `, of which ${c('harmless')} move the seams within re-shoot noise, ` +
        `${c('biased')} beyond it, and ${c('gate')} past the ${GRID_GATE_MM} mm seam ` +
        `gate${unsolvedNote}`
      : ` (not solved in this run)`) +
    `; ${c('invisible')} touched only runs the page refuses anyway; ` +
    `${c('unchanged')} changed no photograph.`;
  const fourth =
    ` If the emitter runs 7.5 ms late per step, as it did headless, ` +
    `${c('aimedTouched')}/${c('aimedTrials')} captures started by the card's aimed rule ` +
    `are touched (${c('aimedLoud')} loud, ${c('aimedSilent')} silent). The aimed rule ` +
    `protects only while the emitter's lateness stays below about 3.7 ms per step` +
    (aimedFirst === null
      ? `; no lateness swept touched 1% of aimed captures.`
      : `; the smallest lateness swept at which 1% of aimed captures were touched was ` +
        `${c('aimedFirstMs')} ms.`);
  return first + second + third + fourth;
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
 * Every stage in order, each resuming from its checkpoint, then the document.
 * Returns null when a stage is missing, which only happens when one was asked
 * for alone; T24 runs this twice on {@link TEST_PLAN} and compares.
 */
export function runExperiment10(
  ctx: RunContext,
  only: StageName | null = null,
): Record<string, unknown> | null {
  for (const stage of STAGES) {
    if (stage === 'assemble' || (only !== null && only !== stage)) continue;
    const t0 = Date.now();
    ctx.log(`${stage}:`);
    RUNNERS[stage](ctx);
    ctx.log(`${stage}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  if (only !== null && only !== 'assemble') return null;
  return assemble(ctx);
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i < 0 ? null : (argv[i + 1] ?? '');
  };
  // Every argument must be one this knows, as `tessellation/cli.ts` requires.
  // Ignored instead, as it first was, a mistyped `--quick` or a `--stage=gate`
  // started the full run, which ends hours later by writing the committed file.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stage') i++;
    else if (argv[i] !== '--quick' && argv[i] !== '--smoke') {
      process.stderr.write(`experiment10: unknown argument '${argv[i]}'\n`);
      return 2;
    }
  }
  const quick = argv.includes('--quick') || process.env.EXP10_QUICK === '1';
  const smoke = argv.includes('--smoke') || process.env.EXP10_SMOKE === '1';
  const stageArg = flag('--stage');
  if (stageArg !== null && !(STAGES as readonly string[]).includes(stageArg)) {
    process.stderr.write(`--stage must be one of ${STAGES.join(', ')}; got '${stageArg}'\n`);
    return 2;
  }
  const plan = smoke ? SMOKE_PLAN : quick ? QUICK_PLAN : FULL_PLAN;
  const dir = plan.mode === 'full' ? WORK : path.join(WORK, plan.mode);
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const ctx = runContext(plan, fileStore(dir), log, process.env.EXP10_ACCEPT_STALE === '1');
  log(
    `experiment 10, ${plan.mode} plan; checkpoints in ${ctx.store.where}; ` +
      `design and measurement code ${ctx.fingerprint}`,
  );
  const t0 = Date.now();
  let doc: Record<string, unknown> | null;
  try {
    doc = runExperiment10(ctx, stageArg as StageName | null);
  } catch (e) {
    if (e instanceof StaleCheckpoint) {
      process.stderr.write(`\n${e.message}\n\n    rm -rf ${ctx.store.where}\n\n`);
      return 1;
    }
    throw e;
  }
  if (doc !== null) {
    // The committed file only from the published plan; a quick or smoke run
    // writes beside its own checkpoints, where nothing reads it as the result.
    const out = plan.mode === 'full' ? OUT : path.join(dir, `experiment-10.${plan.mode}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
    const statement = (doc.verdict as { statement: string }).statement;
    log(
      `\nexperiment 10 verdict (${plan.mode}): ${statement}\n\nwrote ${path.relative(ROOT, out)}`,
    );
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return 0;
}

// Only when invoked directly, so a test can import this module without
// running an experiment — the guard `segmentation/cli.ts` uses, for its reason.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exitCode = main();
}
