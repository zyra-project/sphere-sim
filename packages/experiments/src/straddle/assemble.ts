// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * EXPERIMENT-10's document: `experiments/experiment-10.json` assembled from
 * finished checkpoints, and the verdict sentence built from its cells.
 *
 * ## Why this is a module of its own
 *
 * It sits outside the checkpoint fingerprint on purpose. The header of
 * `stages.ts` says where the line runs and why it is drawn. An edit here (a
 * field, what a table needs, the verdict's wording, how a prediction is
 * evaluated) re-assembles the document from the same measurements with
 * `--stage assemble`. It no longer costs four hours of measuring again. The
 * document still says which code wrote it: `generatedFrom.assemblyFingerprint`
 * hashes this file and `cli.ts`, beside the measurement fingerprint.
 *
 * What it may do is read finished checkpoints and compute from them: counts,
 * spreads, shares, bootstrap intervals, and pass or fail against a stated
 * bound. What it must not do is measure. It never renders, fingerprints,
 * indexes, decodes or solves, and it never writes a checkpoint. Every rule it
 * classifies by (a position's category, the refine band, a solve's plan) it
 * imports from `stages.ts`, where the stage that chose by that rule lives. A
 * rule restated here would be free to drift from the one the run was chosen
 * by, and nothing would re-measure to show it.
 *
 * ## Why the verdict is written here
 *
 * For the reason `tether/cli.ts` gives: three times a number in a write-up
 * disagreed with the file it reported, and a paraphrased verdict is the same
 * hazard one sentence further out. So the sentence is assembled from the
 * document's own cells through {@link at}, which throws on a cell that is not
 * there instead of printing a sentence with a hole in it.
 */


import * as fs from 'node:fs';

import { deriveSeed, makeBenchRng, type BenchRng } from '../../../bench/src/random.ts';
import { COMPLEMENT_LIMIT, MIN_CLASSIFY_MARGIN } from '../../../solver/src/indexing.ts';
import { startPhase } from '../tether/run.ts';
import {
  ARMS,
  DWELL_S,
  ENCODE_BOUNDS,
  EXP10_ROOT_SEED,
  EXPECTED,
  EXPOSURE_S,
  FRAMES_PER_RUN,
  GATE_SCAN,
  GRID_GATE_MM,
  HEADLESS_LATENESS_MS,
  PERIOD_PX,
  PROJECTORS,
  PROJECTOR_RES,
  READOUT_S,
  REFINE_MARGIN,
  RERUN_IDENTITIES,
  RERUN_PREDICTIONS,
  ROTATION_GATE_DEG,
  STEPS,
} from './design.ts';
import {
  classifyCapture,
  classifyPosition,
  decodedPhotographs,
  harmClass,
  isMarginal,
  isMinor,
  type CaptureCategory,
  type CaptureClass,
  type Harm,
  type HarmClass,
  type Photo,
  type PositionCategory,
  type RunOutcomeKind,
} from './run.ts';
import {
  FRAME_CLASSES,
  REFINE_CEILING,
  SPECS,
  VERDICT_S,
  ascending,
  assemblyFingerprint,
  categoryOf,
  closedForm,
  deciding,
  designConstants,
  inBand,
  latenessCells,
  loadSolves,
  mean,
  outcomesOf,
  pageColumnRigsOf,
  parseUnit,
  quantile,
  readStage,
  reasonOf,
  rescoreCells,
  rollingSmear,
  round,
  twinStatus,
  variantOf,
  type BankUnit,
  type CapturePlan,
  type CaptureScore,
  type CaptureSolve,
  type CellSpec,
  type DecodeLevel,
  type DecodeRun,
  type DecodeUnit,
  type Exp10Plan,
  type GateRun,
  type GateUnit,
  type HalfStats,
  type PagePosition,
  type PoseUnit,
  type PositionScore,
  type Q0Position,
  type Q0Unit,
  type RescoreUnit,
  type RunContext,
  type RunScore,
  type SignTally,
  type SolveRecord,
  type SolveSpec,
  type StageFile,
  type StageName,
  type TimingCell,
  type TwinCamera,
  type TwinRun,
  type Which,
} from './stages.ts';

export const SCHEMA = 'sphere-sim/experiment-10@1';

/**
 * The refine band's diagnostic bar: the refined verdict agrees with the fully noisy one on at
 * least this share of R1's touched runs.
 */
export const REFINE_AGREEMENT = 0.98;

/**
 * P2c's gap is reported for runs whose rendered pair-u0 crossing is at most
 * this, and beyond it: 0.20 is above every run's whole-position crossing (the
 * first full run's largest was 0.165), so the band holds every run on which
 * pair u0 could decide anything.
 */
const U0_BAND = 0.2;

/**
 * The backward crossing below which the verdict names the runs a backward
 * straddle refuses early, and says how little of the photograph they light: a
 * round figure under every forward crossing the first full run measured.
 */
const LOW_CROSSING = 0.05;

/** A pair's name in the page's plan: `u0` is the u axis's most significant Gray plane. */
const PAIR_NAMES: readonly string[] = EXPECTED.complements.pairs.map(
  ([a]) => `${SPECS[a].axis}${SPECS[a].index}`,
);

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
 * A capture's class as the document reports it: the library's classes, and one
 * the assembly adds. SILENT-UNJUDGEABLE is a SILENT capture that was solved and
 * whose harm cannot be read off the solve, because its D_grid is censored (a
 * lower bound) or its twin misses the seam gate on its own (see {@link harmOf}).
 * The first full run's document tallied three such solves as HARMLESS or BIASED.
 */
type ReportedClass = CaptureClass | 'SILENT-UNJUDGEABLE';

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
  loudSilentHarm: Record<HarmClass, number>;
  rotationFlips: number;
  over025: number;
  over05: number;
  dGridMm: number[];
  /**
   * Under P: solved captures whose P plan is A's, so their P solve is A's
   * (`CaptureSolve.pIsA`). Every solved P capture of a cell that solves under A
   * alone is one of these.
   */
  sameSolveAsA: number;
  /**
   * Solved captures whose D_grid is within re-shoot noise (`withinReshootNoise`),
   * and of those, the ones GATE-BREAKING anyway: the overlap `harmClass`
   * resolves in favour of the flip. Tallied because run.ts says it is reported,
   * and the first full run's document never read it.
   */
  withinReshootNoise: number;
  gateBreakingWithinNoise: number;
  /** Solves on record whose harm cannot be judged ({@link harmOf}); in no count above. */
  unjudgeable: number;
}

const CLASS_ORDER: readonly (ReportedClass | 'LOUD+SILENT')[] = [
  'LOUD',
  'LOUD+SILENT',
  'SILENT-HARMLESS',
  'SILENT-BIASED',
  'SILENT-GATE-BREAKING',
  'SILENT-UNJUDGEABLE',
  'SILENT-UNSOLVED',
  'INVISIBLE-ONLY',
  'UNCHANGED',
  'UNTOUCHED',
];

/** A position table's columns, in the order the first full run's document wrote them. */
const POSITION_ORDER: readonly PositionCategory[] = [
  'UNTOUCHED',
  'UNCHANGED',
  'INVISIBLE-ONLY',
  'REFUSED-ALL',
  'MIXED',
  'PLACED',
];

/** The same through the page, which has a category the counterfactual cannot: see QUIET. */
const PAGE_POSITION_ORDER: readonly PagePositionCategory[] = [...POSITION_ORDER, 'QUIET'];

/**
 * The page's capture classes, in the order its tallies name them
 * ({@link pageCaptureClass}): the counterfactual's, and QUIET, which follows
 * the SILENT classes as it does in the rule. LOUD+SILENT and LOUD+QUIET are
 * LOUD captures counted a second time for what else they carry, a PLACED
 * position or a QUIET one; a capture can be both.
 */
const PAGE_CLASS_ORDER: readonly string[] = [
  'LOUD',
  'LOUD+SILENT',
  'LOUD+QUIET',
  'SILENT-HARMLESS',
  'SILENT-BIASED',
  'SILENT-GATE-BREAKING',
  'SILENT-UNJUDGEABLE',
  'SILENT-UNSOLVED',
  'QUIET',
  'INVISIBLE-ONLY',
  'UNCHANGED',
  'UNTOUCHED',
];

/** Capture classes collapsed, for setting one reader's beside the other's. */
const CAPTURE_GROUPS: readonly string[] = ['LOUD', 'SILENT', 'INVISIBLE-ONLY', 'UNCHANGED', 'UNTOUCHED'];

/** The same through the page, which has a capture class the counterfactual cannot: see QUIET. */
const PAGE_CAPTURE_GROUPS: readonly string[] = ['LOUD', 'SILENT', 'QUIET', 'INVISIBLE-ONLY', 'UNCHANGED', 'UNTOUCHED'];

/** The SILENT classes: nothing refused, a PLACED position reached the calibration. */
const SILENT_CLASSES: readonly ReportedClass[] = [
  'SILENT-HARMLESS',
  'SILENT-BIASED',
  'SILENT-GATE-BREAKING',
  'SILENT-UNJUDGEABLE',
  'SILENT-UNSOLVED',
];

/**
 * Refusals the page words run by run (`indexing.ts`), against the two it words
 * for the whole position: a bookends count that is not the projector count,
 * and a classification that cannot tell the references apart.
 */
const PER_RUN_REFUSALS: readonly RunOutcomeKind[] = [
  'refused-complement',
  'refused-unanswered',
  'refused-bookends-length',
  'refused-bookends-kind',
];

/**
 * The per-run refusals whose words end "Re-shoot projector N." (`indexing.ts`:
 * the length and kind refusals of `indexByBookends`, the complement refusal of
 * `indexByFingerprint`). A run that "could not be checked" names no remedy.
 */
const RESHOOT_PROJECTOR_REFUSALS: readonly RunOutcomeKind[] = [
  'refused-complement',
  'refused-bookends-length',
  'refused-bookends-kind',
];

/** Everything the assembly reads, gathered once. */
export interface Evidence {
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

function solveOf(ev: Pick<Evidence, 'solves'>, id: string | null | undefined): SolveRecord | null {
  if (id === null || id === undefined) return null;
  const rec = ev.solves.get(id);
  if (rec === undefined)
    throw new Error(
      `experiment10: solve ${id} is named by a checkpoint and missing from solves.jsonl`,
    );
  return rec;
}

/** A null distribution of D_grid and what sets it. See {@link yardstick}. */
export interface Yardstick {
  /** The 95th percentile: τ, the line HARMLESS and BIASED are drawn at. */
  value: number | null;
  /** Its 95% interval, resampling rigs. */
  lo: number | null;
  hi: number | null;
  /** The median, which a straddle's median is set against, like for like. */
  median: number | null;
  samples: number;
  byRig: Record<string, number[]>;
  perRigRange: Record<string, [number, number]>;
  /** Which rigs supply the largest tenth of the samples: τ is a 95th percentile, so they set it */
  largest: { n: number; byRig: Record<string, number> };
  /**
   * How often a re-shoot alone takes the rotation gate from passing to failing
   * against its plain twin, and where the twins sit: the rate every straddle's
   * rotation-gate flips are read beside.
   */
  rotationFlips: { flips: number; of: number; twinDeg: [number, number] | null };
  /**
   * The same for the seam gate: how often a re-shoot alone takes the grid error
   * past GRID_GATE_MM where its plain twin kept it inside. A censored grid is
   * not read, as a pose case's is not. The first full run set a straddle's
   * seam-gate flips beside the rotation gate's null rate alone.
   */
  gridFlips: { flips: number; of: number };
}

/**
 * The re-shoots of each designed rig against that rig's plain twin: whole
 * captures (`nulls`), or the straddled position alone (`positionNulls`).
 *
 * The first full run quoted a straddle's MEDIAN D_grid against this
 * distribution's 95th percentile, which compares two different statistics.
 * So the median is here beside the percentile, and so is what sets the
 * percentile: each rig's range and the rigs its largest values come from.
 */
export function yardstick(
  ev: Pick<Evidence, 'pose' | 'solves'>,
  which: 'nulls' | 'positionNulls',
  label: string,
): Yardstick {
  const byRig: Record<string, number[]> = {};
  let flips = 0;
  let of = 0;
  const gridFlips = { flips: 0, of: 0 };
  const twinDeg: number[] = [];
  for (const u of Object.values(ev.pose?.units ?? {})) {
    const ids = u[which] ?? [];
    const plain = solveOf(ev, u.plain);
    byRig[String(u.rig)] = ids
      .map((id) => solveOf(ev, id)?.against?.dGridMm)
      .filter((x): x is number => x !== undefined && Number.isFinite(x));
    if (plain?.rotationDeg !== null && plain?.rotationDeg !== undefined && ids.length > 0) {
      twinDeg.push(plain.rotationDeg);
      for (const id of ids) {
        const rec = solveOf(ev, id);
        if (rec === null || rec.rotationDeg === null) continue;
        of++;
        if (plain.rotationDeg <= ROTATION_GATE_DEG && rec.rotationDeg > ROTATION_GATE_DEG) flips++;
      }
    }
    if (plain !== null && plain.gridMm !== null && plain.gridCensored === false) {
      for (const id of ids) {
        const rec = solveOf(ev, id);
        if (rec === null || rec.gridMm === null || rec.gridCensored !== false) continue;
        gridFlips.of++;
        if (plain.gridMm <= GRID_GATE_MM && rec.gridMm > GRID_GATE_MM) gridFlips.flips++;
      }
    }
  }
  const all = Object.values(byRig).flat();
  const perRigRange: Record<string, [number, number]> = {};
  for (const [k, xs] of Object.entries(byRig)) {
    if (xs.length > 0)
      perRigRange[k] = [round(Math.min(...xs), 5) as number, round(Math.max(...xs), 5) as number];
  }
  const n = Math.ceil(0.1 * all.length);
  const largestByRig: Record<string, number> = {};
  Object.entries(byRig)
    .flatMap(([k, xs]) => xs.map((x) => ({ k, x })))
    .sort((a, b) => b.x - a.x || Number(a.k) - Number(b.k))
    .slice(0, n)
    .forEach(({ k }) => {
      largestByRig[k] = (largestByRig[k] ?? 0) + 1;
    });
  const rotationFlips = {
    flips,
    of,
    twinDeg:
      twinDeg.length === 0
        ? null
        : ([round(Math.min(...twinDeg), 5), round(Math.max(...twinDeg), 5)] as [number, number]),
  };
  const base = {
    samples: all.length,
    byRig,
    perRigRange,
    largest: { n, byRig: largestByRig },
    rotationFlips,
    gridFlips,
  };
  if (all.length === 0) return { value: null, lo: null, hi: null, median: null, ...base };
  const rigs = Object.values(byRig).filter((xs) => xs.length > 0);
  const rng = makeBenchRng(deriveSeed(EXP10_ROOT_SEED, `exp10/bootstrap/${label}`));
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
    median: round(quantile(ascending(all), 0.5), 5),
    ...base,
  };
}

/**
 * What a capture's solve says, against its twin.
 *
 * `unjudgeable` where the solve is on record and its harm cannot be read off
 * it. A censored D_grid is a lower bound, so it cannot be set against τ, and a
 * twin that misses the seam gate on its own is a failed solve, so the seams it
 * places are no baseline to measure a straddle's movement from. Such a solve
 * is reported as unjudgeable, never as HARMLESS or BIASED. GATE-BREAKING needs
 * neither: it reads the two uncensored gate values against truth, not D_grid.
 */
function harmOf(
  ev: Evidence,
  pair: { treated: string; twin: string } | null,
  tau: number | null,
): { harm: Harm | null; error: string | null; unjudgeable: string | null } {
  if (pair === null || tau === null) return { harm: null, error: null, unjudgeable: null };
  const treated = solveOf(ev, pair.treated);
  const twin = solveOf(ev, pair.twin);
  if (treated === null || twin === null) {
    return { harm: null, error: 'missing solve', unjudgeable: null };
  }
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
      unjudgeable: null,
    };
  }
  const harm: Harm = {
    dGridMm: treated.against.dGridMm,
    tauNullMm: tau,
    gTwinMm: twin.gridMm,
    gTwinCensored: twin.gridCensored === true,
    gTreatedMm: treated.gridMm,
    gTreatedCensored: treated.gridCensored === true,
    rotationTwinDeg: twin.rotationDeg,
    rotationTreatedDeg: treated.rotationDeg,
  };
  if (harmClass(harm) !== 'GATE-BREAKING') {
    const why = treated.against.censored
      ? `D_grid is censored, a lower bound of ${round(harm.dGridMm, 3)} mm`
      : harm.gTwinMm > GRID_GATE_MM
        ? `the twin misses the ${GRID_GATE_MM} mm seam gate on its own ` +
          `(G ${round(harm.gTwinMm, 3)} mm)`
        : null;
    if (why !== null) return { harm: null, error: null, unjudgeable: why };
  }
  return { harm, error: null, unjudgeable: null };
}

type TwinOf = (rig: number, camera: number) => TwinCamera;

/**
 * Holds a cell's checkpoint to the band the document says it was scored at.
 *
 * The stage gave a run a noisy verdict exactly when the run is attributable and
 * in the band at {@link REFINE_CEILING} ({@link inBand}), and a `noisy` cell
 * gave every run one. A checkpoint that disagrees was scored at another band.
 * That can only happen under `EXP10_ACCEPT_STALE`, since the band is inside
 * the fingerprint. A document assembled from it would still name this band, so
 * it throws instead. Returns the attributable runs the band re-evaluated.
 */
function checkBand(cell: CellSpec, captures: readonly CaptureScore[], twin: TwinOf): number {
  let inside = 0;
  for (const cap of captures) {
    for (const pos of cap.positions) {
      const t = twin(cap.rig, pos.pos);
      const check = (runs: readonly RunScore[], footing: 'content' | 'filed'): void =>
        runs.forEach((run, p) => {
          const want =
            cell.mode === 'noisy' ||
            (t.placedContent.includes(p) && inBand(run.w0, t.runs[p].noiseFloor, REFINE_CEILING));
          if ((run.on !== null) !== want) {
            throw new Error(
              `experiment10: ${cell.id} trial ${cap.t} camera ${pos.pos} run ${p + 1} ` +
                `(${footing} footing) was ${run.on === null ? 'not ' : ''}evaluated noisy, ` +
                `which the refine band at ${REFINE_CEILING} ${want ? 'asks' : 'does not ask'} for`,
            );
          }
          if (footing === 'content' && want && cell.mode === 'refine') inside++;
        });
      check(pos.content, 'content');
      check(pos.filed, 'filed');
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// The page column: the page's own reader on every changed position
// ---------------------------------------------------------------------------
//
// The rescoring hands each changed position of a page-column rig whole to the
// page's own reader (`pagePath`), and keeps what it made of it
// (`PagePosition`). Below is what the document makes of those readings. The
// counterfactual's machinery is reused wherever its rule is the same one: the
// capture classes (`classifyCapture`), their intervals, the solves' harm and the
// yardsticks. Where the page's rule differs, it says so where it is stated.
// Nothing here is a stage's rule: pass S solves by the counterfactual's
// categories alone, so the page's are pure functions of what the stage
// recorded, and live in the assembly.

/** A bet registered before the re-run (`RERUN_PREDICTIONS`), by id. */
function rerunBet(id: string) {
  const b = RERUN_PREDICTIONS.find((x) => x.id === id);
  if (b === undefined) throw new Error(`experiment10: ${id} was never registered`);
  return b;
}

/** A harness identity registered with them (`RERUN_IDENTITIES`), by id. */
function rerunIdentity(id: string) {
  const x = RERUN_IDENTITIES.find((i) => i.id === id);
  if (x === undefined) throw new Error(`experiment10: the identity ${id} was never registered`);
  return x;
}

/**
 * The projector a problem the page wrote is about, zero-based, or null for a
 * problem about the folder: the page names one run's refusal "Projector N's …",
 * and nothing else starts so.
 *
 * `reader/acceptance.ts` reads the page's problems by the same rule, in a
 * `problemProjector` it keeps to itself. It cannot be imported from there
 * without editing that module, so it is stated again here, and
 * `straddle.test.ts` holds the two to each other on every problem the reduced
 * run's page column wrote.
 */
export function problemProjectorOf(problem: string): number | null {
  const m = /^Projector (\d+)'s/.exec(problem);
  return m === null ? null : Number(m[1]) - 1;
}

/**
 * What the page did with one run of a position it read.
 *
 *   - `placed`: the run is among the runs it placed.
 *   - `refused`: a problem names the run ({@link problemProjectorOf}); or the
 *     folder was refused, with nothing placed and problems written; or a
 *     problem about the folder stands and the run is none of the other
 *     three. The last is the one reading beside the brief's two:
 *     `indexPosition` places the runs before a stretch that is not whole runs,
 *     and says in one problem about the folder that the projectors after it
 *     "are not decoded", naming none of them the way it names a run.
 *   - `noted`: out of this camera's view or barely seen, and no problem names
 *     it. A note asks the operator for nothing: "nothing to re-shoot", "a
 *     re-shoot from here would see no more of it".
 *   - `crashed`: the reader threw on the folder (`PagePosition.crash`), so no
 *     run of it was read. The operator gets an error and no calibration, so a
 *     crashed run counts as refused wherever loudness is counted, and every
 *     crash is counted apart as well.
 *   - `unaccounted`: none of these. `indexPosition` gives every projector one
 *     of the others, so this is counted apart and should stay empty.
 */
export type PageRunVerdict = 'placed' | 'refused' | 'noted' | 'crashed' | 'unaccounted';

export const PAGE_RUN_VERDICTS: readonly PageRunVerdict[] = [
  'placed',
  'refused',
  'noted',
  'crashed',
  'unaccounted',
];

/** Every run's verdict in one reading, projector by projector. */
export function pageRunVerdicts(
  read: Pick<PagePosition, 'placed' | 'unseen' | 'barelySeen' | 'problems' | 'crash'>,
): PageRunVerdict[] {
  const named = new Set(read.problems.map(problemProjectorOf));
  const folder = (read.placed.length === 0 && read.problems.length > 0) || named.has(null);
  return Array.from({ length: PROJECTORS }, (_, p): PageRunVerdict => {
    if (read.crash !== null) return 'crashed';
    if (read.placed.includes(p)) return 'placed';
    if (named.has(p)) return 'refused';
    if (read.unseen.includes(p) || read.barelySeen.includes(p)) return 'noted';
    return folder ? 'refused' : 'unaccounted';
  });
}

/**
 * The problems that refuse one run: those naming it, or where none does, those
 * about the whole folder. Empty for a run that is not refused.
 */
export function problemsRefusing(
  read: Pick<PagePosition, 'problems'>,
  projector: number,
  verdict: PageRunVerdict,
): string[] {
  if (verdict !== 'refused') return [];
  const named = read.problems.filter((x) => problemProjectorOf(x) === projector);
  return named.length > 0 ? named : read.problems.filter((x) => problemProjectorOf(x) === null);
}

/**
 * The page's words, in classes: `reasonOf`'s, and within three of them the
 * finer cause the words give. `length` is split by where the page counted:
 * `length-extra`, a photograph after the run's last frame lighting only this
 * projector ("one more of this run"); `length-slot`, a run whose neighbours were
 * found and whose slot holds the wrong count; and `length` itself, the
 * bookends' count of a run's photographs, which the page's reader no longer
 * writes. `unfound-room` is a run not found whose light changes the way a
 * room's does; `numbering-gap` is a stretch between two runs that is not whole
 * runs. A sentence none of `reasonOf`'s patterns knows is `other`: counted,
 * named in the tables, and never a throw, since a document can be re-assembled
 * but the words are the stage's.
 */
export function pageWordsOf(problem: string): string {
  let reason: string;
  try {
    reason = reasonOf(problem);
  } catch {
    return 'other';
  }
  if (reason === 'unfound' && /changes the way a room changes/.test(problem)) return 'unfound-room';
  if (reason === 'length' && /after its last frame, lights only what this projector lights/.test(problem))
    return 'length-extra';
  if (reason === 'length' && /Its neighbours were found/.test(problem)) return 'length-slot';
  if (reason === 'numbering' && /lie between two runs/.test(problem)) return 'numbering-gap';
  return reason;
}

/** The runs the page twin places: what a page verdict can be attributed against. */
export function pageTwinPlaced(twin: Pick<TwinCamera, 'camera' | 'page'>): readonly number[] {
  if (twin.page === undefined) {
    throw new Error(
      `experiment10: camera ${twin.camera}'s twin has no page reading, so nothing the page ` +
        'column read of it can be attributed',
    );
  }
  return twin.page.placed;
}

/** One run of a position the page read. */
export interface PageRun {
  projector: number;
  touched: boolean;
  /** The page twin places it: a verdict on it counts against the straddle. */
  attributable: boolean;
  /** The counterfactual's twin places it (`TwinCamera.placedContent`). */
  counterfactualAttributable: boolean;
  verdict: PageRunVerdict;
  /** Its twin is minor or marginal: what `excludingMinorMarginal` leaves out, as the counterfactual's tables do. */
  minorOrMarginal: boolean;
}

/**
 * A changed position's runs as the page read them, each attributed against
 * the page's reading of the same clean frames ({@link pageTwinPlaced}). The
 * counterfactual attributes against its own verdict on them (`placedContent`),
 * and the two twins differ where the page notes a grazing run the
 * counterfactual places, or places one it refuses.
 */
export function pageRunsOf(score: PositionScore, twin: TwinCamera): PageRun[] {
  if (score.page === null) {
    throw new Error(`experiment10: camera ${score.pos}'s changed position has no page reading`);
  }
  const verdicts = pageRunVerdicts(score.page);
  const placedClean = pageTwinPlaced(twin);
  const status = twinStatus(twin);
  return verdicts.map((verdict, p) => {
    const t = status.find((x) => x.projector === p);
    if (t === undefined) throw new Error(`experiment10: camera ${twin.camera}'s twin has no run ${p + 1}`);
    return {
      projector: p,
      touched: score.touched.includes(p),
      attributable: placedClean.includes(p),
      counterfactualAttributable: twin.placedContent.includes(p),
      verdict,
      minorOrMarginal: isMinor(t) || isMarginal(t),
    };
  });
}

/**
 * A position's category through the page: `classifyPosition`'s categories,
 * and one it cannot have. `QUIET` is a position whose only non-placed
 * attributable runs are quiet drops — runs the page twin places that the
 * straddled reading only notes (P12) — so it is neither refused nor placed.
 *
 * Counted are the touched runs the page twin places, as `classifyPosition`
 * counts the ones the counterfactual's twin places. Then: none counted,
 * INVISIBLE-ONLY; none refused, PLACED when every one is placed and QUIET when
 * a quiet drop is among them; some refused, REFUSED-ALL when none is placed and
 * MIXED when some are. So a quiet drop beside a refusal leaves the position as
 * loud as the refusal makes it, and is counted apart. A crashed run counts as
 * refused ({@link PageRunVerdict}).
 */
export type PagePositionCategory = PositionCategory | 'QUIET';

export function classifyPagePosition(
  runs: readonly Pick<PageRun, 'touched' | 'attributable' | 'verdict' | 'minorOrMarginal'>[],
  options: { exp9Flagged?: boolean; excludeMinorMarginal?: boolean } = {},
): PagePositionCategory {
  if (runs.length !== PROJECTORS) throw new Error(`experiment10: ${runs.length} runs, not ${PROJECTORS}`);
  if (!runs.some((r) => r.touched)) return options.exp9Flagged === true ? 'UNCHANGED' : 'UNTOUCHED';
  const counted = runs.filter(
    (r) => r.touched && r.attributable && !(options.excludeMinorMarginal === true && r.minorOrMarginal),
  );
  if (counted.length === 0) return 'INVISIBLE-ONLY';
  const refused = counted.filter((r) => r.verdict === 'refused' || r.verdict === 'crashed').length;
  const placed = counted.filter((r) => r.verdict === 'placed').length;
  if (refused === 0) return placed === counted.length ? 'PLACED' : 'QUIET';
  return placed === 0 ? 'REFUSED-ALL' : 'MIXED';
}

/** {@link classifyPagePosition} of a scored position, UNTOUCHED or UNCHANGED where nothing changed. */
export function pageCategoryOf(
  score: PositionScore,
  twin: TwinCamera,
  excludeMinorMarginal: boolean,
): PagePositionCategory {
  if (!score.changed) return score.flagged ? 'UNCHANGED' : 'UNTOUCHED';
  return classifyPagePosition(pageRunsOf(score, twin), {
    exp9Flagged: score.flagged,
    excludeMinorMarginal,
  });
}

/** A capture's class through the page: the counterfactual's classes, and QUIET. */
export type PageCaptureClass = CaptureClass | 'QUIET';

export interface PageCaptureCategory extends Omit<CaptureCategory, 'class'> {
  class: PageCaptureClass;
  /**
   * LOUD, and some position QUIET: "LOUD with a quiet drop", counted as
   * LOUD+QUIET and never as LOUD+SILENT, which needs a PLACED position.
   */
  loudWithQuiet: boolean;
}

/**
 * A capture's class through the page, by the registered definitions
 * (docs/EXPERIMENT-10.md, "Loud and silent"), with one class the
 * counterfactual cannot have.
 *
 * LOUD when a touched attributable run is refused in any position (REFUSED-ALL
 * or MIXED); else SILENT when some position is PLACED, every such run placed;
 * else QUIET when some position is QUIET; else INVISIBLE-ONLY, UNCHANGED or
 * UNTOUCHED, as `classifyCapture` has them. A QUIET position is not PLACED by
 * those words: its quiet drop is noted, not decoded. So QUIET makes no
 * capture SILENT (P11 counts PLACED positions alone), and a QUIET capture has
 * no silent part and is given no harm. LOUD+SILENT is a LOUD capture that also
 * carries a PLACED position (under A a MIXED one too, as the counterfactual's
 * is); a LOUD capture with a QUIET position is `loudWithQuiet`, counted apart
 * from it. A SILENT capture with a QUIET position as well stays SILENT, and
 * the page block's `quiet` counts it too.
 */
export function pageCaptureClass(
  categories: readonly PagePositionCategory[],
  harm: Harm | null,
  policy: 'P' | 'A',
): PageCaptureCategory {
  const quiet = categories.includes('QUIET');
  const got = classifyCapture(
    categories.filter((c): c is PositionCategory => c !== 'QUIET'),
    harm,
    policy,
  );
  if (got.class === 'LOUD') return { ...got, loudWithQuiet: quiet };
  if (!quiet || got.class.startsWith('SILENT')) return { ...got, loudWithQuiet: false };
  return { ...got, class: 'QUIET', loudWithQuiet: false };
}

/**
 * What a policy renders and withholds for one capture read by the page:
 * `capturePlan`'s rule on the page's categories. Straddled are the PLACED and
 * QUIET positions, and under A the MIXED ones too; withheld are every run the
 * page twin does not place, on every camera of the rig, and every run of a
 * straddled position the page did not place. Null where nothing is straddled.
 * A QUIET position reaches the calibration with the runs it placed, so it is
 * in the plan of a capture that has one; a harm is read off the plan only for
 * a capture with a PLACED position ({@link pageCaptureClass}).
 */
export function pagePlanOf(
  cap: Pick<CaptureScore, 'positions'>,
  categories: readonly PagePositionCategory[],
  verdictsAt: (camera: number) => readonly PageRunVerdict[],
  twinPlacedAt: (camera: number) => readonly number[],
  cameras: readonly number[],
  policy: 'A' | 'P',
): CapturePlan | null {
  const exclude = new Set<string>();
  for (const c of cameras) {
    const placed = twinPlacedAt(c);
    for (let p = 0; p < PROJECTORS; p++) if (!placed.includes(p)) exclude.add(`${c}.${p}`);
  }
  const positions: number[] = [];
  cap.positions.forEach((pos, i) => {
    const cat = categories[i];
    if (!(cat === 'PLACED' || cat === 'QUIET' || (policy === 'A' && cat === 'MIXED'))) return;
    positions.push(pos.pos);
    verdictsAt(pos.pos).forEach((v, p) => {
      if (v !== 'placed') exclude.add(`${pos.pos}.${p}`);
    });
  });
  if (positions.length === 0) return null;
  return { positions: positions.sort((x, y) => x - y), exclude: [...exclude].sort() };
}

/** Every photograph filed in order: all of a folder `decodedPhotographs` reads. */
const FILED: readonly Photo[] = STEPS.map((_, j) => ({ filedStep: j, rows: [] }));

/**
 * Why a capture the page lets through takes a counterfactual solve's harm or
 * does not: `same plan`, or the nearest miss among the capture's solves —
 * `no solve`, then `positions`, `exclusions` and `placement`, each one step
 * nearer.
 */
export type PageHarmWhy = 'same plan' | 'no solve' | 'positions' | 'exclusions' | 'placement';

const HARM_MISSES: readonly PageHarmWhy[] = ['no solve', 'positions', 'exclusions', 'placement'];

/**
 * A counterfactual solve of this capture whose plan is the page's, placement
 * included, or null and the nearest miss.
 *
 * A solve's id records its straddled positions and its exclusions, not where
 * it placed each run: it renders a straddled position with the content
 * footing's assignment (`decodedPhotographs`). So the page's plan is that
 * solve's only if the positions and exclusions are the same and every run the
 * page placed and the plan keeps sits, frame for frame, at the photographs the
 * solve decoded as that run. Then the solve is the page's own, and its
 * HARMLESS, BIASED or GATE-BREAKING is the page's. No solve is made here.
 */
export function pageSolveOf(
  plan: CapturePlan,
  cap: Pick<CaptureScore, 'positions'>,
  candidates: readonly { treated: string; twin: string }[],
  specOf: (id: string) => Pick<SolveSpec, 'straddle' | 'exclude'> | null,
): { pair: { treated: string; twin: string } | null; why: PageHarmWhy } {
  const kept = (): boolean => {
    const excluded = new Set(plan.exclude);
    for (const c of plan.positions) {
      const pos = cap.positions.find((x) => x.pos === c);
      if (pos === undefined || pos.page === null) return false;
      const photoFor = decodedPhotographs(FILED, pos.assignment);
      const read = pos.page;
      for (let i = 0; i < read.placed.length; i++) {
        const q = read.placed[i];
        if (excluded.has(`${c}.${q}`)) continue;
        for (let f = 0; f < FRAMES_PER_RUN; f++) {
          if (photoFor[q * FRAMES_PER_RUN + f] !== read.starts[i] + f) return false;
        }
      }
    }
    return true;
  };
  let why: PageHarmWhy = 'no solve';
  for (const pair of candidates) {
    const spec = specOf(pair.treated);
    if (spec === null) continue;
    const m = /\/\[([\d,]*)\]$/.exec(spec.straddle);
    const positions = m === null || m[1] === '' ? null : m[1].split(',').map(Number);
    let miss: PageHarmWhy | null;
    if (positions === null || positions.join() !== plan.positions.join()) miss = 'positions';
    else if (spec.exclude.join() !== plan.exclude.join()) miss = 'exclusions';
    else miss = kept() ? null : 'placement';
    if (miss === null) return { pair, why: 'same plan' };
    if (HARM_MISSES.indexOf(miss) > HARM_MISSES.indexOf(why)) why = miss;
  }
  return { pair: null, why };
}

/**
 * The page's photographs filed under another step than the one holding more
 * than half their exposure (P10) are listed one by one up to this many in a
 * cell; past it a cell keeps the counts and the histogram.
 */
export const MISFILE_LIST_LIMIT = 200;

/**
 * A misfiled photograph whose majority step holds less than this share of its
 * exposure is a near-tie: filed under either step, two fifths or more of it
 * shows the other. The verdict calls a cell's misfiles near-ties only when every
 * one of them is, and otherwise counts those at this share or more, off the
 * histogram's written edges, of which it is one. A word for the report and not
 * a bet: P10 is falsified by any misfile, near-tie or not.
 */
export const NEAR_TIE_SHARE = 0.6;

/** Where a misfiled photograph's majority share falls: tenths of the half above a tie. */
function shareHistogram(shares: readonly number[]): { from: number; to: number; n: number }[] {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    from: round(0.5 + 0.05 * i, 2) as number,
    to: round(0.55 + 0.05 * i, 2) as number,
    n: 0,
  }));
  // Each share in the bin whose edges hold it, read off the edges as written:
  // (0.6 - 0.5) / 0.05 floors to 1 in binary, and 0.6 belongs to [0.6, 0.65).
  for (const s of shares) bins[bins.findIndex((b, i) => s < b.to || i === bins.length - 1)].n++;
  return bins;
}

/**
 * A page reading as the document keeps it: what it placed and where, what it
 * noted, and its words counted and classed ({@link pageWordsOf}). The words
 * themselves stay in the checkpoint: every refusal carries the page's
 * paragraph on handing a re-shoot in.
 */
export function pageBrief(read: PagePosition) {
  return {
    ok: read.ok,
    placed: read.placed,
    starts: read.starts,
    offsets: read.offsets,
    contentMisfiles: read.contentMisfiles,
    unseen: read.unseen,
    barelySeen: read.barelySeen,
    reshoots: read.reshoots,
    problems: read.problems.length,
    words: countBy(read.problems.map(pageWordsOf), (x) => x),
    crash: read.crash,
  };
}

/**
 * Whether two readings of one position also agree where H8-page does not
 * look: where each placed run starts, what it misfiles, and the problems
 * word for word. Reported beside the identity, never as part of it.
 */
export function pageAlsoAgree(a: PagePosition, b: PagePosition) {
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
  return {
    starts: same(a.starts, b.starts),
    contentMisfiles: same(a.contentMisfiles, b.contentMisfiles) && same(a.misfiled, b.misfiled),
    problemTexts: same(a.problems, b.problems),
  };
}

/** A clean position as `experiments/reader-acceptance.json` records the page's reading of it. */
interface AcceptancePosition {
  which: string;
  variant: string;
  rig: number;
  camera: number;
  placed: number[];
  unseen: number[];
  barelySeen: number[];
  problems: string[];
}

/**
 * I-page-twin: every page twin against the acceptance sweep's reading of the
 * same clean position, found by variant, rig and camera. Placed, unseen and
 * barely seen equal, and no problem on either side.
 *
 * The sweep photographed the published plan's variants. A twin of a variant it
 * never photographed (the quick plan's reduced main rigs) is counted apart,
 * not failed; a twin of a variant it did photograph, at a rig or camera the
 * file does not hold, is a file that does not cover the run, and throws.
 */
export function pageTwinIdentity(
  twins: readonly { which: Which; variant: string; rig: number; twin: Pick<TwinCamera, 'camera' | 'page'> }[],
  acceptance: unknown,
) {
  const file = acceptance as { schema?: unknown; commit?: unknown; positions?: unknown };
  if (file === null || typeof file !== 'object' || !Array.isArray(file.positions)) {
    throw new Error('experiment10: the acceptance sweep\'s file holds no positions[]');
  }
  const positions = file.positions as AcceptancePosition[];
  const swept = new Set(positions.map((p) => p.variant));
  const byKey = new Map(positions.map((p) => [`${p.variant}/${p.rig}/${p.camera}`, p]));
  const same = (x: readonly number[], y: readonly number[]): boolean =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  const notSwept: Record<string, number> = {};
  const differences: string[] = [];
  let compared = 0;
  for (const { which, variant, rig, twin } of twins) {
    if (!swept.has(variant)) {
      notSwept[variant] = (notSwept[variant] ?? 0) + 1;
      continue;
    }
    const where = `${which} rig ${rig} camera ${twin.camera} (${variant})`;
    const theirs = byKey.get(`${variant}/${rig}/${twin.camera}`);
    if (theirs === undefined) {
      throw new Error(
        `experiment10: experiments/reader-acceptance.json does not cover ${where}, a variant it swept`,
      );
    }
    compared++;
    const ours = twin.page;
    if (ours === undefined) {
      differences.push(`${where}: no page twin on record`);
      continue;
    }
    const wrong: string[] = [];
    if (!same(ours.placed, theirs.placed)) wrong.push(`placed [${ours.placed}] against [${theirs.placed}]`);
    if (!same(ours.unseen, theirs.unseen)) wrong.push(`unseen [${ours.unseen}] against [${theirs.unseen}]`);
    if (!same(ours.barelySeen, theirs.barelySeen))
      wrong.push(`barely seen [${ours.barelySeen}] against [${theirs.barelySeen}]`);
    if (ours.problems.length > 0 || ours.crash !== null)
      wrong.push(`the twin has ${ours.crash !== null ? 'a crash' : `${ours.problems.length} problems`}`);
    if (theirs.problems.length > 0) wrong.push(`the sweep has ${theirs.problems.length} problems`);
    if (wrong.length > 0) differences.push(`${where}: ${wrong.join('; ')}`);
  }
  return {
    measured: {
      file: { schema: file.schema ?? null, commit: file.commit ?? null },
      twins: twins.length,
      compared,
      agree: compared - differences.length,
      differences,
      notSwept,
    },
    pass: compared === 0 ? null : differences.length === 0,
  };
}

/**
 * Q0's page reader against the page twin, position by position (P13): the
 * renderer's photographs and the fast path's, read by the same reader.
 * Placed, unseen and barely seen equal, and neither with a problem. A
 * position without a twin page reading is not compared.
 */
export function q0AgainstPageTwin(
  positions: readonly Pick<
    Q0Position,
    'which' | 'rig' | 'camera' | 'runsPlaced' | 'unseen' | 'barelySeen' | 'problems'
  >[],
  twinAt: (which: Which, rig: number, camera: number) => Pick<TwinCamera, 'page'>,
) {
  const same = (x: readonly number[], y: readonly number[]): boolean =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  const differences: string[] = [];
  let compared = 0;
  for (const p of positions) {
    const twin = twinAt(p.which, p.rig, p.camera).page;
    if (twin === undefined) continue;
    compared++;
    const wrong: string[] = [];
    if (!same(p.runsPlaced, twin.placed)) wrong.push(`placed [${p.runsPlaced}] against [${twin.placed}]`);
    if (!same(p.unseen, twin.unseen)) wrong.push(`unseen [${p.unseen}] against [${twin.unseen}]`);
    if (!same(p.barelySeen, twin.barelySeen))
      wrong.push(`barely seen [${p.barelySeen}] against [${twin.barelySeen}]`);
    if (p.problems.length > 0) wrong.push(`Q0 has ${p.problems.length} problems`);
    if (twin.problems.length > 0 || twin.crash !== null)
      wrong.push(`the twin has ${twin.crash !== null ? 'a crash' : `${twin.problems.length} problems`}`);
    if (wrong.length > 0) differences.push(`${p.which} rig ${p.rig} camera ${p.camera}: ${wrong.join('; ')}`);
  }
  return { positions: positions.length, compared, differ: differences.length, differences };
}

/** The fields of a cell's page block the re-run's bets read. */
export interface PageBets {
  id: string;
  page:
    | { status: 'not run' }
    | {
        status: 'read' | 'nothing to read';
        read: { captures: number };
        classes: { P: { counts: Record<string, number> } };
        quiet: { runs: number; positions: number; captures: number };
        misfiles: {
          photographs: number;
          positions: number;
          ambiguous: number;
          share: { min: number | null; max: number | null };
          below055: number;
        };
      };
}

/**
 * P10–P13, the bets registered before the re-run (`RERUN_PREDICTIONS`), read
 * off the cells' page blocks and Q0 against the page twin. Each quotes its
 * registered text and threshold, and is falsified when what it counts exceeds
 * the threshold. A bet whose cells were never read is not evaluated (null),
 * never passed.
 */
export function evaluateRerunBets(
  cells: readonly PageBets[],
  counterfactualSilentR1: number | null,
  q0VsTwin: ReturnType<typeof q0AgainstPageTwin>,
) {
  const bet = (id: string) => {
    const b = rerunBet(id);
    return { id: b.id, falsifiedIf: b.falsifiedIf, threshold: b.threshold };
  };
  const read = cells.flatMap((c) => (c.page.status === 'not run' ? [] : [{ id: c.id, page: c.page }]));
  const sum = (f: (x: (typeof read)[number]) => number): number => read.reduce((a, x) => a + f(x), 0);
  const shares = read.flatMap((x) =>
    [x.page.misfiles.share.min, x.page.misfiles.share.max].filter((s): s is number => s !== null),
  );
  const p10 = bet('P10');
  const photographs = sum((x) => x.page.misfiles.photographs);
  const p12 = bet('P12');
  const quietRuns = sum((x) => x.page.quiet.runs);
  const p11 = bet('P11');
  const r1 = read.find((x) => x.id === 'R1') ?? null;
  const silentR1 =
    r1 === null ? null : SILENT_CLASSES.reduce((a, name) => a + (r1.page.classes.P.counts[name] ?? 0), 0);
  const quietR1 = r1 === null ? null : r1.page.classes.P.counts.QUIET;
  if (quietR1 === undefined) throw new Error("experiment10: R1's page block has no QUIET count");
  const p13 = bet('P13');
  return [
    {
      ...p10,
      measured:
        read.length === 0
          ? null
          : {
              cells: read.length,
              photographs,
              positions: sum((x) => x.page.misfiles.positions),
              ambiguous: sum((x) => x.page.misfiles.ambiguous),
              share: {
                min: shares.length === 0 ? null : Math.min(...shares),
                max: shares.length === 0 ? null : Math.max(...shares),
              },
              below055: sum((x) => x.page.misfiles.below055),
              byCell: Object.fromEntries(read.map((x) => [x.id, x.page.misfiles.photographs])),
            },
      falsified: read.length === 0 ? null : photographs > p10.threshold,
    },
    {
      ...p11,
      measured:
        r1 === null
          ? null
          : {
              silent: silentR1,
              counterfactualSilent: counterfactualSilentR1,
              capturesTouched: r1.page.read.captures,
              quiet: quietR1,
              // Beside the registered count, never in its place: a QUIET
              // capture read as a kept one, as a PLACED position is. It is
              // not the registration's reading, whose SILENT needs a
              // position PLACED, and P11 is not held or falsified on it.
              quietCountedAsKept: {
                reading:
                  'not the registration\'s: a QUIET capture counted as SILENT, as if a quiet drop were ' +
                  'a placed run; P11 is read on the registered SILENT alone',
                silent: (silentR1 as number) + (quietR1 as number),
              },
            },
      falsified: silentR1 === null ? null : silentR1 > p11.threshold,
    },
    {
      ...p12,
      measured:
        read.length === 0
          ? null
          : {
              cells: read.length,
              runs: quietRuns,
              positions: sum((x) => x.page.quiet.positions),
              captures: sum((x) => x.page.quiet.captures),
              byCell: Object.fromEntries(read.map((x) => [x.id, x.page.quiet.runs])),
            },
      falsified: read.length === 0 ? null : quietRuns > p12.threshold,
    },
    {
      ...p13,
      measured: q0VsTwin,
      falsified: q0VsTwin.compared === 0 ? null : q0VsTwin.differ > p13.threshold,
    },
  ];
}

/**
 * One scored cell, summarised: its captures and positions by category, both
 * policies, both footings, with and without minor and marginal runs, and the
 * run-level tallies behind them.
 *
 * Every run is read on its deciding evaluation ({@link deciding}), the one its
 * stage chose by: the fully noisy verdict in R1, and the refine band at
 * {@link REFINE_CEILING} in every other cell. This function once took the band
 * as an argument, and the refined cells were classified at R1's validated
 * margin (0.01 in quick) while their solves and decodes had been chosen at
 * 0.05. A solve's straddle could then disagree with its capture's category.
 */
export function summariseCell(
  ev: Evidence,
  cell: CellSpec,
  file: StageFile<RescoreUnit>,
  tau: number | null,
  yardsticks: { tauLo: number | null; tauHi: number | null; positionTau: number | null } = {
    tauLo: null,
    tauHi: null,
    positionTau: null,
  },
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
  const twinOf: TwinOf = (rig, camera) => twinFor(ev, which, rig, camera);
  const runsInBand = checkBand(cell, captures, twinOf);
  // A position table: every position of every capture kept, by a reader's category.
  const tableOf = <C extends string>(
    categories: readonly C[],
    categoryAt: (cap: CaptureScore, pos: PositionScore) => C,
    keep: (cap: CaptureScore) => boolean = () => true,
  ): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const name of categories) counts[name] = 0;
    for (const cap of captures) {
      if (!keep(cap)) continue;
      for (const pos of cap.positions) counts[categoryAt(cap, pos)]++;
    }
    return counts;
  };
  const positionTable = (footing: 'content' | 'filed', excl: boolean): Record<string, number> =>
    tableOf(POSITION_ORDER, (cap, pos) => categoryOf(pos, footing, twinOf(cap.rig, pos.pos), excl));
  type PolicyClasses = Classes & {
    solveErrors: string[];
    unjudgeable: string[];
    solved: SolvedTally;
    /** The harms of the SILENT captures judged, for the yardstick sensitivity. */
    silentHarms: Harm[];
  };
  const solveFor = (cap: CaptureScore): CaptureSolve | null =>
    solves.find((x) => x.t === cap.t) ?? null;
  // What a reader makes of a capture, for the class tally: its class under a
  // policy given a harm, the solve that judges its silent part, and whether
  // that solve is the one policy A was given too.
  interface Reader {
    classify: (cap: CaptureScore, harm: Harm | null, policy: 'P' | 'A') => PageCaptureCategory;
    pair: (cap: CaptureScore, policy: 'P' | 'A') => { treated: string; twin: string } | null;
    sameSolveAsA: (cap: CaptureScore) => boolean;
    /** The classes its tally names, in order. */
    order: readonly string[];
  }
  const counterfactual: Reader = {
    classify: (cap, harm, policy) => ({
      ...classifyCapture(
        cap.positions.map((pos) => categoryOf(pos, 'content', twinOf(cap.rig, pos.pos), false)),
        harm,
        policy,
      ),
      loudWithQuiet: false,
    }),
    pair: (cap, policy) => {
      const solve = solveFor(cap);
      return solve === null ? null : policy === 'A' ? solve.a : solve.p;
    },
    sameSolveAsA: (cap) => solveFor(cap)?.pIsA === true,
    order: CLASS_ORDER,
  };
  const classesFor = (
    policy: 'P' | 'A',
    keep: (cap: CaptureScore) => boolean = () => true,
    reader: Reader = counterfactual,
  ): PolicyClasses => {
    const out: PolicyClasses = {
      captures: 0,
      byClass: {},
      loudAndSilent: 0,
      byRig: {},
      solveErrors: [],
      unjudgeable: [],
      solved: {
        captures: 0,
        loudSilentHarm: { HARMLESS: 0, BIASED: 0, 'GATE-BREAKING': 0 },
        rotationFlips: 0,
        over025: 0,
        over05: 0,
        dGridMm: [],
        sameSolveAsA: 0,
        withinReshootNoise: 0,
        gateBreakingWithinNoise: 0,
        unjudgeable: 0,
      },
      silentHarms: [],
    };
    for (const name of reader.order) out.byClass[name] = 0;
    for (const cap of captures) {
      if (!keep(cap)) continue;
      const { harm, error, unjudgeable } = harmOf(ev, reader.pair(cap, policy), tau);
      if (error !== null) out.solveErrors.push(`trial ${cap.t}: ${error}`);
      const got = reader.classify(cap, harm, policy);
      let reported: ReportedClass | 'QUIET' = got.class;
      if (unjudgeable !== null) {
        out.unjudgeable.push(`trial ${cap.t}: ${unjudgeable}`);
        out.solved.unjudgeable++;
        // Solved, so not SILENT-UNSOLVED; and not judged. A LOUD capture stays LOUD.
        if (reported === 'SILENT-UNSOLVED') reported = 'SILENT-UNJUDGEABLE';
      }
      // LOUD captures counted a second time, for a PLACED position or a QUIET one.
      const also = [
        ...(got.loudAndSilent ? ['LOUD+SILENT'] : []),
        ...(got.loudWithQuiet ? ['LOUD+QUIET'] : []),
      ];
      for (const name of [reported, ...also]) {
        if (!(name in out.byClass)) {
          throw new Error(`experiment10: ${cell.id} has a class ${name} its reader's tally does not name`);
        }
      }
      out.captures++;
      out.byClass[reported]++;
      if (got.loudAndSilent) out.loudAndSilent++;
      for (const name of also) out.byClass[name]++;
      if (harm !== null && got.harm !== null) {
        const s = out.solved;
        s.captures++;
        if (got.class === 'LOUD') s.loudSilentHarm[got.harm]++;
        else out.silentHarms.push(harm);
        if (got.rotationGateFlipped === true) s.rotationFlips++;
        if (harm.dGridMm > 0.25) s.over025++;
        if (harm.dGridMm > 0.5) s.over05++;
        s.dGridMm.push(harm.dGridMm);
        if (policy === 'P' && reader.sameSolveAsA(cap)) s.sameSolveAsA++;
        if (got.withinReshootNoise === true) {
          s.withinReshootNoise++;
          if (got.harm === 'GATE-BREAKING') s.gateBreakingWithinNoise++;
        }
      }
      const rig = String(cap.rig);
      out.byRig[rig] ??= {};
      out.byRig[rig][reported] = (out.byRig[rig][reported] ?? 0) + 1;
      out.byRig[rig].captures = (out.byRig[rig].captures ?? 0) + 1;
      for (const name of also) out.byRig[rig][name] = (out.byRig[rig][name] ?? 0) + 1;
    }
    return out;
  };
  const cellRigs = cell.which === 'main' ? ev.plan.rigs : ev.plan.spillRigs;
  // Each class's share with its interval, resampling the rigs given, on a
  // stream named off the cell (and off the reader, for any but the first).
  const withIntervals = (
    c: Classes,
    rigs: readonly number[] = cellRigs,
    stream = cell.id,
    order: readonly string[] = CLASS_ORDER,
  ) => {
    const shares: Record<string, ReturnType<typeof clusteredShare>> = {};
    for (const name of order) {
      if (name === 'UNTOUCHED') continue;
      shares[name] = clusteredShare(
        rigs.map((k) => ({
          num: c.byRig[String(k)]?.[name] ?? 0,
          den: c.byRig[String(k)]?.captures ?? 0,
        })),
        `${stream}/${name}`,
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
    sameSolveAsA: s.sameSolveAsA,
    withinReshootNoise: s.withinReshootNoise,
    gateBreakingWithinNoise: s.gateBreakingWithinNoise,
    unjudgeable: s.unjudgeable,
  });
  // The SILENT captures judged again at every yardstick the document reports:
  // how many HARMLESS, BIASED and GATE-BREAKING, and how many exceed the
  // yardstick at all. GATE-BREAKING reads the gate against truth and does not
  // move; HARMLESS and BIASED trade places as the line moves. τ's interval
  // bounds how far the count can be trusted, and the one-position re-shoot is
  // the smaller null a re-shot position actually faces.
  const silentAgainst = (harms: readonly Harm[]) => {
    const at = (tauMm: number | null) => {
      if (tauMm === null) return null;
      const counts: Record<HarmClass, number> = { HARMLESS: 0, BIASED: 0, 'GATE-BREAKING': 0 };
      let exceedTau = 0;
      for (const h of harms) {
        counts[harmClass({ ...h, tauNullMm: tauMm })]++;
        if (h.dGridMm > tauMm) exceedTau++;
      }
      return { tauMm, judged: harms.length, ...counts, exceedTau };
    };
    return {
      tau: at(tau),
      tauLo: at(yardsticks.tauLo),
      tauHi: at(yardsticks.tauHi),
      positionTau: at(yardsticks.positionTau),
    };
  };
  // What a LOUD capture's operator reads from the counterfactual reader. A
  // position refused whole says "Found N projector runs", and re-shooting the
  // position is a remedy it reads back. A run refused on its own says, for the
  // three kinds in RESHOOT_PROJECTOR_REFUSALS, "Re-shoot projector N": a folder
  // the counterfactual then refuses whole, because it holds one run too many
  // (Q0b), where the page's reader reads the re-shoot. Read on the runs that
  // make the capture loud: the touched attributable runs of its REFUSED-ALL and
  // MIXED positions, on their deciding evaluation.
  const loud = (() => {
    const out = {
      captures: 0,
      wholePositionOnly: 0,
      runByRun: 0,
      reshootNamed: 0,
      // Told the cause is a dropped frame and a duplicated one: the complement
      // refusal ("what a dropped frame and a duplicated one look like") and the
      // kind refusal ("A drop and a duplicate in the same run").
      dropAndDuplicate: 0,
    };
    for (const cap of captures) {
      const kinds = new Set<RunOutcomeKind>();
      let isLoud = false;
      for (const pos of cap.positions) {
        const twin = twinOf(cap.rig, pos.pos);
        const cat = categoryOf(pos, 'content', twin, false);
        if (cat !== 'REFUSED-ALL' && cat !== 'MIXED') continue;
        isLoud = true;
        for (const o of outcomesOf(pos, 'content', twin)) {
          if (o.touched && o.attributable && o.outcome !== 'placed') kinds.add(o.outcome);
        }
      }
      if (!isLoud) continue;
      out.captures++;
      if ([...kinds].some((k) => PER_RUN_REFUSALS.includes(k))) out.runByRun++;
      else out.wholePositionOnly++;
      if ([...kinds].some((k) => RESHOOT_PROJECTOR_REFUSALS.includes(k))) out.reshootNamed++;
      if (kinds.has('refused-complement') || kinds.has('refused-bookends-kind'))
        out.dropAndDuplicate++;
    }
    if (out.captures !== P.byClass.LOUD) {
      throw new Error(
        `experiment10: ${cell.id} has ${P.byClass.LOUD} LOUD captures and ${out.captures} ` +
          'with a loud position',
      );
    }
    return out;
  })();
  const pastGate = (c: PolicyClasses) => ({
    silent: c.byClass['SILENT-GATE-BREAKING'],
    loudSilent: c.solved.loudSilentHarm['GATE-BREAKING'],
    total: c.byClass['SILENT-GATE-BREAKING'] + c.solved.loudSilentHarm['GATE-BREAKING'],
  });

  // Run-level tallies, content footing, on the deciding evaluation.
  //
  // `outcomes` and `brokenPairs` are the tables compared across cells, so they
  // take ATTRIBUTABLE touched runs only: the one group every cell evaluates
  // alike, fully noisy in R1 and by the refine band R1 validates elsewhere.
  // Runs the twin refuses anyway are counted apart, in `notAttributable`. R1
  // evaluates those with noise, while the refined cells never re-evaluate them
  // and leave them on their noiseless verdict. Tallied together, as they first
  // were, R1's showed refused-complement where R7's, on the same rigs, showed
  // refused-unanswered, and the two cells could not be compared.
  let touchedRuns = 0;
  let attributableTouched = 0;
  let refusedAttributable = 0;
  let falseAlarms = 0;
  let collateral = 0;
  let placedPhaseTouched = 0;
  const broken: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const notAttributable = {
    touched: 0,
    evaluatedNoisy: 0,
    outcomes: {} as Record<string, number>,
  };
  let phasePlacedPositions = 0;
  let touchedPositions = 0;
  for (const cap of captures) {
    for (const pos of cap.positions) {
      if (!pos.changed && !pos.flagged) continue;
      touchedPositions++;
      if (!pos.changed) continue;
      const twin = twinOf(cap.rig, pos.pos);
      const os = outcomesOf(pos, 'content', twin);
      const cat = classifyPosition(os, twinStatus(twin), { exp9Flagged: pos.flagged });
      let phasePlaced = false;
      os.forEach((o, p) => {
        const run = pos.content[p];
        if (o.collateral) collateral++;
        if (!o.touched) return;
        touchedRuns++;
        if (!o.attributable) {
          notAttributable.touched++;
          if (deciding(run).noisy) notAttributable.evaluatedNoisy++;
          notAttributable.outcomes[o.outcome] = (notAttributable.outcomes[o.outcome] ?? 0) + 1;
          return;
        }
        attributableTouched++;
        outcomes[o.outcome] = (outcomes[o.outcome] ?? 0) + 1;
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

  // ----- the page column: the page's own reader on each changed position
  const page = (() => {
    // The rigs Q0 put in the page column, by the rule the stage ran it by.
    // Hand-built evidence (T26, T34) carries no Q0 and no page reading.
    const pageRigs = ev.q0 === undefined ? new Set<string>() : pageColumnRigsOf(ev.q0);
    const inColumn = (rig: number): boolean => pageRigs.has(`${which}:${rig}`);
    // What the stage wrote must be what Q0 decided: a reading of every changed
    // position of a page-column rig, and of nothing else.
    for (const cap of captures) {
      for (const pos of cap.positions) {
        const wrong = inColumn(cap.rig) ? pos.changed && pos.page === null : pos.page !== null;
        if (wrong) {
          throw new Error(
            `experiment10: ${cell.id} trial ${cap.t} camera ${pos.pos} ` +
              (pos.page === null
                ? 'changed and was not read by the page column, though its rig is in the column'
                : 'was read by the page column, though its rig is not in the column'),
          );
        }
      }
    }
    const columnRigs = cellRigs.filter(inColumn);
    const rigs = { column: columnRigs.length, of: cellRigs.length };
    // Q0 put none of this cell's rigs in the column: it did not run here, which
    // is not the same as running and finding nothing to read (R8, L-aimed-2).
    if (columnRigs.length === 0) return { status: 'not run' as const, rigs };
    const keep = (cap: CaptureScore): boolean => inColumn(cap.rig);
    const read = captures.filter(keep);
    const readings = read.flatMap((cap) => cap.positions.filter((pos) => pos.page !== null));

    // Each capture's runs and categories through the page, worked out once.
    const analysed = new Map<CaptureScore, { runs: (PageRun[] | null)[]; cats: PagePositionCategory[] }>();
    const analyse = (cap: CaptureScore) => {
      let got = analysed.get(cap);
      if (got === undefined) {
        const runs = cap.positions.map((pos) =>
          pos.changed ? pageRunsOf(pos, twinOf(cap.rig, pos.pos)) : null,
        );
        const cats = cap.positions.map((pos, i): PagePositionCategory => {
          const r = runs[i];
          if (r === null) return pos.flagged ? 'UNCHANGED' : 'UNTOUCHED';
          return classifyPagePosition(r, { exp9Flagged: pos.flagged });
        });
        got = { runs, cats };
        analysed.set(cap, got);
      }
      return got;
    };
    const camerasOf = (rig: number): number[] =>
      Object.entries(ev.bank.units)
        .filter(([key]) => {
          const u = parseUnit(key);
          return u.which === which && u.k === rig;
        })
        .flatMap(([, u]) => u.twins.map((t) => t.camera))
        .sort((a, b) => a - b);
    // The counterfactual solve whose plan is the page's, placement included,
    // where one exists ({@link pageSolveOf}); nothing is solved for the page.
    const matched = new Map<string, ReturnType<typeof pageSolveOf> | null>();
    const matchOf = (cap: CaptureScore, policy: 'P' | 'A') => {
      const key = `${cap.t}/${policy}`;
      if (!matched.has(key)) {
        const { runs, cats } = analyse(cap);
        const verdictsAt = (camera: number): PageRunVerdict[] => {
          const i = cap.positions.findIndex((pos) => pos.pos === camera);
          return (runs[i] ?? []).map((r) => r.verdict);
        };
        const plan = pagePlanOf(
          cap,
          cats,
          verdictsAt,
          (camera) => pageTwinPlaced(twinOf(cap.rig, camera)),
          camerasOf(cap.rig),
          policy,
        );
        const solve = solveFor(cap);
        const candidates: { treated: string; twin: string }[] = [];
        for (const pair of solve === null ? [] : policy === 'A' ? [solve.a, solve.p] : [solve.p, solve.a]) {
          if (pair !== null && !candidates.some((x) => x.treated === pair.treated)) candidates.push(pair);
        }
        matched.set(
          key,
          plan === null ? null : pageSolveOf(plan, cap, candidates, (id) => solveOf(ev, id)?.spec ?? null),
        );
      }
      return matched.get(key) ?? null;
    };
    // Harm is read only for a capture with a silent part, a PLACED position
    // that reaches the calibration: SILENT, and LOUD+SILENT. A QUIET capture
    // has none ({@link pageCaptureClass}), so no solve is looked up for it.
    const silentPartOf = (got: PageCaptureCategory): boolean =>
      got.class.startsWith('SILENT') || got.loudAndSilent;
    const pageReader: Reader = {
      classify: (cap, harm, policy) => pageCaptureClass(analyse(cap).cats, harm, policy),
      pair: (cap, policy) =>
        silentPartOf(pageCaptureClass(analyse(cap).cats, null, policy))
          ? (matchOf(cap, policy)?.pair ?? null)
          : null,
      sameSolveAsA: (cap) => {
        const pair = matchOf(cap, 'P')?.pair ?? null;
        return pair !== null && pair.treated === solveFor(cap)?.a?.treated;
      },
      order: PAGE_CLASS_ORDER,
    };
    const PP = classesFor('P', keep, pageReader);

    // Harm, where it can be read at all: the captures whose silent part reaches
    // the calibration, and whether a counterfactual solve is of the page's plan.
    const harm = {
      silentPart: 0,
      samePlan: 0,
      notSolved: 0,
      why: { 'no solve': 0, positions: 0, exclusions: 0, placement: 0 } as Record<string, number>,
    };
    // The capture classes of the two readers, crossed: each collapsed to LOUD,
    // SILENT, INVISIBLE-ONLY or UNCHANGED under policy P, and the page's QUIET,
    // a column only (the counterfactual has no such class).
    const collapse = (c: PageCaptureCategory): string =>
      c.class === 'LOUD' ? 'LOUD' : c.class.startsWith('SILENT') ? 'SILENT' : c.class;
    const vsCounterfactual: Record<string, Record<string, number>> = {};
    for (const a of CAPTURE_GROUPS) {
      vsCounterfactual[a] = {};
      for (const b of PAGE_CAPTURE_GROUPS) vsCounterfactual[a][b] = 0;
    }
    // Quiet drops (P12): touched runs the page twin places that the straddled
    // reading only notes, with no problem naming them, in whatever position;
    // the SILENT captures that carry a QUIET position as well; and the
    // captures with no PLACED position in which a QUIET position places
    // another touched attributable run. That run reaches the calibration
    // straddled, and no class counts it: a QUIET position is not PLACED, so
    // such a capture is QUIET, or LOUD+QUIET and not LOUD+SILENT.
    const quiet = { runs: 0, positions: 0, captures: 0, silentWithQuiet: 0, quietPlacingTouched: 0 };
    // What a LOUD capture's operator reads from the page, as `loud` counts the
    // counterfactual's: the problems refusing the touched attributable runs of
    // its REFUSED-ALL and MIXED positions.
    const loud = {
      captures: 0,
      runByRun: 0,
      wholePositionOnly: 0,
      crashOnly: 0,
      reshootNamed: 0,
      // Told "what a dropped frame and a duplicated one look like": the page's
      // complement refusal, the one sentence of its that says so.
      dropAndDuplicate: 0,
    };
    for (const cap of read) {
      const { runs, cats } = analyse(cap);
      const got = pageCaptureClass(cats, null, 'P');
      if (silentPartOf(got)) {
        harm.silentPart++;
        const m = matchOf(cap, 'P');
        if (m !== null && m.pair !== null) harm.samePlan++;
        else {
          harm.notSolved++;
          harm.why[m === null ? 'no solve' : m.why]++;
        }
      }
      const row = vsCounterfactual[collapse(counterfactual.classify(cap, null, 'P'))];
      if (row === undefined || row[collapse(got)] === undefined) {
        throw new Error(`experiment10: ${cell.id} trial ${cap.t} crosses into no group`);
      }
      row[collapse(got)]++;
      let quietHere = false;
      runs.forEach((rs) => {
        const n = (rs ?? []).filter((r) => r.touched && r.attributable && r.verdict === 'noted').length;
        if (n === 0) return;
        quiet.runs += n;
        quiet.positions++;
        quietHere = true;
      });
      if (quietHere) quiet.captures++;
      if (cats.includes('QUIET') && got.class.startsWith('SILENT')) quiet.silentWithQuiet++;
      if (
        !cats.includes('PLACED') &&
        cats.some(
          (c, i) =>
            c === 'QUIET' && (runs[i] ?? []).some((r) => r.touched && r.attributable && r.verdict === 'placed'),
        )
      ) {
        quiet.quietPlacingTouched++;
      }
      if (got.class !== 'LOUD') continue;
      let named = false;
      let folder = false;
      const words: string[] = [];
      cap.positions.forEach((pos, i) => {
        if (cats[i] !== 'REFUSED-ALL' && cats[i] !== 'MIXED') return;
        for (const r of runs[i] ?? []) {
          if (!(r.touched && r.attributable && r.verdict === 'refused')) continue;
          const own = problemsRefusing(pos.page as PagePosition, r.projector, r.verdict);
          if (own.some((x) => problemProjectorOf(x) === r.projector)) named = true;
          else if (own.length > 0) folder = true;
          words.push(...own);
        }
      });
      loud.captures++;
      if (named) loud.runByRun++;
      else if (folder) loud.wholePositionOnly++;
      else loud.crashOnly++;
      if (words.some(namesReshoot)) loud.reshootNamed++;
      if (words.some((x) => pageWordsOf(x) === 'broken')) loud.dropAndDuplicate++;
    }
    if (loud.captures !== PP.byClass.LOUD) {
      throw new Error(
        `experiment10: ${cell.id} has ${PP.byClass.LOUD} LOUD captures through the page and ` +
          `${loud.captures} with a loud position`,
      );
    }

    // Run by run, on the changed positions read: the page's verdict, crossed
    // with the counterfactual's deciding outcome, apart by which twins place
    // the run; and the page's words on each refused attributable run.
    const crossOf = () =>
      Object.fromEntries(PAGE_RUN_VERDICTS.map((v) => [v, {} as Record<string, number>])) as Record<
        PageRunVerdict,
        Record<string, number>
      >;
    const tally = {
      touched: 0,
      attributable: 0,
      placed: 0,
      refused: 0,
      noted: 0,
      crashed: 0,
      unaccounted: 0,
      // Untouched runs the page twin places that the straddled reading does
      // not: a neighbour's straddle cost them.
      collateral: 0,
      // Runs the straddled reading places that the page twin does not: they
      // reach the calibration, and no category counts them.
      placedNotAttributable: 0,
      both: crossOf(),
      counterfactualOnly: crossOf(),
      pageOnly: crossOf(),
      neither: 0,
    };
    const words = { runs: 0, byClass: {} as Record<string, number> };
    for (const cap of read) {
      const { runs } = analyse(cap);
      cap.positions.forEach((pos, i) => {
        const rs = runs[i];
        if (rs === null) return;
        for (const r of rs) {
          if (!r.touched && r.attributable && r.verdict !== 'placed') tally.collateral++;
          if (r.verdict === 'placed' && !r.attributable) tally.placedNotAttributable++;
          if (!r.touched) continue;
          tally.touched++;
          const cf = deciding(pos.content[r.projector]).outcome;
          const into =
            r.attributable && r.counterfactualAttributable
              ? tally.both
              : r.counterfactualAttributable
                ? tally.counterfactualOnly
                : r.attributable
                  ? tally.pageOnly
                  : null;
          if (into === null) tally.neither++;
          else into[r.verdict][cf] = (into[r.verdict][cf] ?? 0) + 1;
          if (!r.attributable) continue;
          tally.attributable++;
          tally[r.verdict]++;
          if (r.verdict !== 'refused') continue;
          words.runs++;
          const classes = new Set(
            problemsRefusing(pos.page as PagePosition, r.projector, r.verdict).map(pageWordsOf),
          );
          for (const c of classes) words.byClass[c] = (words.byClass[c] ?? 0) + 1;
        }
      });
    }

    // Misfiles (P10): every photograph a placed run files under another step
    // than the one holding more than half its exposure, with that share.
    const shares: number[] = [];
    const list: { t: number; pos: number; photo: number; filedStep: number; contentStep: number; share: number }[] = [];
    let misfiledPositions = 0;
    let misfilingRuns = 0;
    let ambiguous = 0;
    for (const cap of read) {
      for (const pos of cap.positions) {
        if (pos.page === null || pos.page.crash !== null) continue;
        ambiguous += pos.page.ambiguous.reduce((a, n) => a + n, 0);
        misfilingRuns += pos.page.contentMisfiles.filter((n) => n > 0).length;
        if (pos.page.misfiled.length > 0) misfiledPositions++;
        for (const m of pos.page.misfiled) {
          shares.push(m.share);
          list.push({
            t: cap.t,
            pos: pos.pos,
            photo: m.photo,
            filedStep: m.filedStep,
            contentStep: m.contentStep,
            share: round(m.share, 5) as number,
          });
        }
      }
    }
    return {
      status: readings.length === 0 ? ('nothing to read' as const) : ('read' as const),
      rigs,
      read: {
        captures: read.length,
        positions: readings.length,
        crashes: readings.filter((pos) => pos.page !== null && pos.page.crash !== null).length,
        placedAny: readings.filter((pos) => pos.page !== null && pos.page.placed.length > 0).length,
      },
      positions: {
        all: tableOf(
          PAGE_POSITION_ORDER,
          (cap, pos) => pageCategoryOf(pos, twinOf(cap.rig, pos.pos), false),
          keep,
        ),
        excludingMinorMarginal: tableOf(
          PAGE_POSITION_ORDER,
          (cap, pos) => pageCategoryOf(pos, twinOf(cap.rig, pos.pos), true),
          keep,
        ),
      },
      classes: {
        P: {
          counts: PP.byClass,
          shares: withIntervals(PP, columnRigs, `${cell.id}/page`, PAGE_CLASS_ORDER),
          solveErrors: PP.solveErrors,
          unjudgeable: PP.unjudgeable,
          solved: solvedOf(PP.solved),
          silentAgainst: silentAgainst(PP.silentHarms),
          pastGate: pastGate(PP),
          harm,
          vsCounterfactual,
        },
      },
      quiet,
      loud,
      words,
      runs: tally,
      misfiles: {
        photographs: shares.length,
        positions: misfiledPositions,
        runs: misfilingRuns,
        ambiguous,
        share: {
          min: shares.length === 0 ? null : round(Math.min(...shares), 5),
          max: shares.length === 0 ? null : round(Math.max(...shares), 5),
        },
        below055: shares.filter((s) => s < 0.55).length,
        histogram: shareHistogram(shares),
        list: shares.length <= MISFILE_LIST_LIMIT ? list : null,
      },
    };
  })();

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
        unjudgeable: P.unjudgeable,
        solved: solvedOf(P.solved),
        silentAgainst: silentAgainst(P.silentHarms),
        pastGate: pastGate(P),
      },
      A: {
        counts: A.byClass,
        shares: withIntervals(A),
        solveErrors: A.solveErrors,
        unjudgeable: A.unjudgeable,
        solved: solvedOf(A.solved),
        silentAgainst: silentAgainst(A.silentHarms),
        pastGate: pastGate(A),
      },
      byOrigin,
    },
    // LOUD captures by what the counterfactual reader tells the operator; the
    // same captures under either policy, since LOUD reads only the positions.
    loud,
    solved: solves.length > 0,
    solves: solves.length,
    // Which evaluation decided this cell's runs, and for a refined cell how
    // many attributable runs (content footing, touched or not) the band sent to
    // the noisy one.
    refineBand: {
      margin: cell.mode === 'refine' ? REFINE_CEILING : null,
      evaluation: cell.mode === 'refine' ? 'refine band' : 'fully noisy',
      runsReEvaluated: cell.mode === 'refine' ? runsInBand : null,
    },
    runs: {
      touched: touchedRuns,
      attributableTouched,
      refusedAttributable,
      falseAlarms,
      collateral,
      placedPhaseTouched,
      outcomes,
      brokenPairs: broken,
      notAttributable,
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
    // The page's own reader on the same captures: see the page column above.
    page,
  };
}

/**
 * The refine band's diagnostic, on R1 (§6). It decides nothing.
 *
 * Every R1 run was computed both fully noisy and noiseless, so the refined
 * verdict at margin m can be held to the fully noisy one: noisy inside the band
 * at m, noiseless outside it. That is asked at every margin from
 * {@link REFINE_MARGIN} to {@link REFINE_CEILING}, the band every refined cell
 * is scored, chosen and classified at ({@link deciding}), over the touched
 * attributable runs a category is made of. `atBand.sound` is the question that
 * matters: does the approximation the refined cells rest on agree with the
 * fully noisy reader on at least {@link REFINE_AGREEMENT} of runs?
 * `smallestSound` is where the spec's widening loop would have stopped. It is
 * kept on the record because that margin once decided the reported categories,
 * while the stages chose at the ceiling.
 */
function refineDiagnostic(ev: Evidence): {
  band: number;
  agreementRequired: number;
  atBand: { agree: number; runs: number; share: number | null; sound: boolean | null };
  ladder: { margin: number; agree: number; runs: number; share: number | null }[];
  smallestSound: number | null;
} {
  const captures = Object.entries(ev.rescore.units)
    .filter(([key]) => key.startsWith('A:main:'))
    .flatMap(([, u]) => u.score?.cells.R1 ?? []);
  const agreement = (margin: number): { agree: number; runs: number; share: number | null } => {
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
          const refined = inBand(run.w0, twin.runs[p].noiseFloor, margin) ? run.on : run.o0;
          runs++;
          if ((refined === 'placed') === (run.on === 'placed')) agree++;
        }
      }
    }
    return { agree, runs, share: runs === 0 ? null : round(agree / runs, 5) };
  };
  const ladder = [];
  for (let m = REFINE_MARGIN; m < REFINE_CEILING - 1e-9; m = round(m + 0.01, 4) as number)
    ladder.push({ margin: m, ...agreement(m) });
  const top = agreement(REFINE_CEILING);
  ladder.push({ margin: REFINE_CEILING, ...top });
  const sound = (x: { share: number | null }): boolean | null =>
    x.share === null ? null : x.share >= REFINE_AGREEMENT;
  return {
    band: REFINE_CEILING,
    agreementRequired: REFINE_AGREEMENT,
    atBand: { ...top, sound: sound(top) },
    ladder,
    smallestSound: ladder.find((x) => sound(x) === true)?.margin ?? null,
  };
}

/**
 * Where the card's aimed start stops protecting, derived from the design
 * rather than written down.
 *
 * The aimed rule's band is read off EXPERIMENT-9's own `startPhase`, by asking
 * it for its two ends. An aimed start at the band's lower edge has that much
 * margin before the step its photograph should catch begins, and lateness
 * eats it one step at a time: the last photograph of a position is filed
 * `STEPS.length - 1` steps after the first, so its step starts that many δ
 * late. A camera clock running `ppm` fast releases each photograph
 * `DWELL_S·(1 − 1/(1 + ppm/1e6))` earlier per step (`shotTimings` divides by
 * the rate), which eats the same margin.
 *
 * The first full run's verdict wrote "about 3.7 ms" as a literal. That is the
 * matched-clock figure, and it leaves out the drift of the very arm the
 * sentence was quoting, whose camera runs fast in half its captures.
 */
export function aimedThreshold() {
  const end = (pick: 'lo' | 'hi'): number => {
    const refuse = (): never => {
      throw new Error('experiment10: the aimed start draws something other than one uniform');
    };
    const rng: BenchRng = {
      uniform: (lo, hi) => (pick === 'lo' ? lo : hi),
      nextUint32: refuse,
      nextFloat: refuse,
      gaussian: refuse,
      normal: refuse,
      int: refuse,
      fork: refuse,
    };
    return startPhase('aimed', DWELL_S, rng);
  };
  const arm = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  if (arm === undefined) throw new Error("experiment10: EXPERIMENT-9's headline arm is gone");
  const band = { lo: end('lo'), hi: end('hi') };
  const steps = STEPS.length - 1;
  const ms = (ppm: number): number =>
    1000 * (band.lo / steps - DWELL_S * (1 - 1 / (1 + ppm / 1e6)));
  return {
    aimBandS: [band.lo, band.hi],
    steps,
    driftPpm: arm.driftPpm,
    matchedClocksMs: round(ms(0), 4),
    fastCameraMs: round(ms(arm.driftPpm), 4),
  };
}

/** One decode run as H7 reads it: which run, its clean halves, its levels. */
export type H7Run = Pick<DecodeRun, 'camera' | 'projector' | 'cleanHalves' | 'levels'> & {
  rig: number;
};

/**
 * H7, clause by clause, from the decode stage's runs. A check that cannot test
 * the identity is counted apart, as untestable, and never as a pass or a
 * failure. An MSB-dark onset
 * check on a run whose clean decode accepts no MSB-dark pixel has nothing to
 * turn ambiguous: "none at or above 3/7" is then true of it by construction,
 * and "none below" too. The first full run counted 48 such checks as
 * failures and 32 as passes, and listed its failures cut at 40, which hid
 * one rig's nine. Every failing and untestable run is listed here, one line
 * each. The flip clause counts Gray words (`DecodeLevel.grayFlips`); the
 * displacement the first run counted instead is reported beside it for what
 * it is.
 */
export function evaluateH7(decodeRuns: readonly H7Run[], decodeNoiseless: readonly number[]) {
  type R = H7Run;
  interface Clause {
    checks: number;
    untestable: number;
    failures: number;
    failing: Map<string, string[]>;
    untestableRuns: Map<string, { why: string; checks: number }>;
  }
  const clause = (): Clause => ({
    checks: 0,
    untestable: 0,
    failures: 0,
    failing: new Map(),
    untestableRuns: new Map(),
  });
  const darkOnset = clause();
  const flips = clause();
  const litLoss = clause();
  const name = (r: R): string => `rig ${r.rig} camera ${r.camera} run ${r.projector + 1}`;
  const fail = (c: Clause, r: R, what: string): void => {
    c.failures++;
    c.failing.set(name(r), [...(c.failing.get(name(r)) ?? []), what]);
  };
  const skip = (c: Clause, r: R, why: string): void => {
    c.untestable++;
    const had = c.untestableRuns.get(name(r));
    c.untestableRuns.set(name(r), { why, checks: (had?.checks ?? 0) + 1 });
  };
  const noPixels = (h: HalfStats, half: string): string | null =>
    h.accepted > 0
      ? null
      : h.inView === undefined
        ? `its clean decode accepts no ${half} pixel`
        : h.inView === 0
          ? `no ${half} pixel is in view`
          : `its clean decode accepts none of the ${h.inView} ${half} pixels in view`;
  const displacementCases: string[] = [];
  let displaced = 0;
  for (const r of decodeRuns) {
    const darkWhy = noPixels(r.cleanHalves.dark, 'MSB-dark');
    for (const direction of ['forward', 'backward'] as const) {
      if (direction === 'backward' && r.projector !== 0) continue;
      for (const l of r.levels.filter((x) => x.direction === direction && x.halves !== null)) {
        darkOnset.checks++;
        if (darkWhy !== null) {
          skip(darkOnset, r, darkWhy);
          continue;
        }
        const clean = r.cleanHalves.dark.grayAmbiguous;
        const got = (l.halves as { dark: HalfStats }).dark.grayAmbiguous;
        if (l.s < 3 / 7 && got !== clean)
          fail(darkOnset, r, `${direction} ${l.s}: ${got - clean} more Gray-ambiguous below 3/7`);
        if (l.s >= 3 / 7 && got <= clean)
          fail(darkOnset, r, `${direction} ${l.s}: no more Gray-ambiguous at or above 3/7`);
      }
    }
    for (const l of r.levels.filter((x) => x.s < 5 / 9)) {
      flips.checks++;
      if (l.grayFlips === undefined) {
        skip(flips, r, 'its checkpoint predates the Gray-word count');
        continue;
      }
      if (l.grayFlips.either > 0)
        fail(
          flips,
          r,
          `${l.direction} ${l.s}: ${l.grayFlips.either} Gray words changed ` +
            `(u ${l.grayFlips.u}, v ${l.grayFlips.v})`,
        );
      const moved = (l.shift.movedHalfPeriod as number | null) ?? 0;
      if (moved > 0) {
        displaced += moved;
        displacementCases.push(
          `${name(r)} ${l.direction} ${l.s}: ${moved} moved half a period or more, ` +
            `${l.grayFlips.either} Gray words changed`,
        );
      }
    }
    const litWhy = noPixels(r.cleanHalves.lit, 'MSB-lit');
    for (const l of r.levels.filter(
      (x) => x.direction === 'forward' && x.s === 0.5 && x.halves !== null,
    )) {
      litLoss.checks++;
      if (litWhy !== null) {
        skip(litLoss, r, litWhy);
        continue;
      }
      const left = (l.halves as { lit: HalfStats }).lit.accepted;
      if (left !== 0)
        fail(litLoss, r, `${left} pixels still accepted on the MSB-lit half at s = 0.5`);
    }
  }
  const report = (c: Clause) => ({
    checks: c.checks,
    testable: c.checks - c.untestable,
    untestable: c.untestable,
    failures: c.failures,
    failingRuns: [...c.failing].map(([k, xs]) => `${k}: ${xs.join('; ')}`),
    untestableRuns: [...c.untestableRuns].map(
      ([k, x]) => `${k}: ${x.checks} check${x.checks === 1 ? '' : 's'}; ${x.why}`,
    ),
  });
  const clauses = { darkOnset: report(darkOnset), flips: report(flips), litLoss: report(litLoss) };
  const all = Object.values(clauses);
  const top = Math.max(...decodeNoiseless);
  return {
    checks: all.reduce((a, c) => a + c.checks, 0),
    testable: all.reduce((a, c) => a + c.testable, 0),
    untestable: all.reduce((a, c) => a + c.untestable, 0),
    failures: all.reduce((a, c) => a + c.failures, 0),
    clauses,
    everyClauseTested: all.every((c) => c.testable > 0),
    // Flips are claimed only FROM 5/9, and no smear that high is decoded, so
    // what is measured is their absence below it; the onset itself is not
    // bracketed.
    flipOnset: {
      claimedFrom: round(5 / 9, 4),
      highestDecoded: top,
      bracketed: top >= 5 / 9,
    },
    displacements: {
      what:
        'decodes moved half a period or more — a displacement bound, not a Gray-flip count',
      belowFiveNinths: displaced,
      cases: displacementCases,
    },
  };
}

/**
 * Where a reader that classifies before it counts — the reader the page
 * replaced, as Q0 keeps it — stopped each clean position it placed nothing of:
 * at classify (the references cannot be told from the patterns), at the run
 * count (the bookends found the wrong number of runs), or elsewhere. The first
 * full run's verdict quoted one "classify margin at most" over every position,
 * 0.201, which is above the 0.15 classify needs: it belonged to a position that
 * cleared classify and was refused at the run count.
 */
export function refusedAtOf(
  positions: readonly Pick<Q0Position, 'runsPlaced' | 'reasons' | 'margin' | 'problems'>[],
) {
  const unplaced = positions.filter((p) => p.runsPlaced.length === 0);
  const classify = unplaced.filter((p) => p.reasons.includes('margin'));
  const count = unplaced.filter(
    (p) => !p.reasons.includes('margin') && p.reasons.includes('count'),
  );
  const found = count.flatMap((p) =>
    p.problems.flatMap((x) => {
      const m = x.match(/^Found (\d+) projector runs and the capture should hold \d+\./);
      return m === null ? [] : [Number(m[1])];
    }),
  );
  return {
    classify: {
      positions: classify.length,
      maxMargin:
        classify.length === 0 ? null : round(Math.max(...classify.map((p) => p.margin)), 4),
    },
    count: {
      positions: count.length,
      margin: spread(count.map((p) => p.margin)),
      runsFound: found.length === 0 ? null : { min: Math.min(...found), max: Math.max(...found) },
    },
    other: unplaced.length - classify.length - count.length,
  };
}

/**
 * Whether a refusal tells the operator to "Re-shoot projector N", in the words
 * `indexing.ts` writes for both readers: the counterfactual's length, kind and
 * complement refusals do, as do the page's refusals of one run it found or
 * could not find; a run that could not be checked, and a whole position or
 * folder refused, do not.
 */
export function namesReshoot(problem: string): boolean {
  return /Re-shoot projector \d+\./.test(problem);
}

/** Clean positions on which the counterfactual reader itself says "Re-shoot projector N". */
export function reshootNamedOf(twins: readonly Pick<TwinCamera, 'problems'>[]): number {
  return twins.filter((t) => t.problems.some(namesReshoot)).length;
}

/**
 * Where the quarter-mass formula's gap lives (P2c). It is exact only while no
 * block crosses the check's re-derived floor (`u0Crossing`), which matters least
 * where pair u0 crosses early and binds, and most on runs whose u0 crossing is
 * late because their modulation sits where pair u0 cannot deviate. So the gap
 * is reported by the rendered u0 crossing, either side of {@link U0_BAND}, and
 * on the runs pair u0 actually binds.
 */
export function u0Gaps(runs: readonly Pick<GateRun, 'u0' | 'forward'>[]) {
  const gap = (keep: (r: Pick<GateRun, 'u0' | 'forward'>) => boolean) => {
    const xs = runs
      .filter((r) => r.u0 !== null && r.u0.analytic !== null && r.u0.rendered !== null)
      .filter(keep)
      .map((r) => Math.abs((r.u0?.analytic as number) - (r.u0?.rendered as number)));
    return { runs: xs.length, maxError: xs.length === 0 ? null : round(Math.max(...xs), 6) };
  };
  return {
    byRenderedCrossing: [
      { upTo: U0_BAND, ...gap((r) => (r.u0?.rendered as number) <= U0_BAND) },
      { above: U0_BAND, ...gap((r) => (r.u0?.rendered as number) > U0_BAND) },
    ],
    u0Bound: gap((r) => r.forward.pair === 0),
  };
}

/**
 * The runs a backward straddle refuses early, below {@link LOW_CROSSING}: how
 * many, how much of the photograph the brightest of them lights, and the
 * earliest crossing. Attributable runs only, as every crossing figure is: a run
 * the clean capture already refuses has no straddle of its own to be refused.
 */
export function lowBackward(
  runs: readonly Pick<GateRun, 'attributable' | 'backward' | 'litShare'>[],
) {
  const low = runs.filter(
    (r) => r.attributable && r.backward.s !== null && (r.backward.s as number) < LOW_CROSSING,
  );
  return {
    below: LOW_CROSSING,
    runs: low.length,
    maxLit: low.length === 0 ? null : round(Math.max(...low.map((r) => r.litShare)), 5),
    lowest: low.length === 0 ? null : round(Math.min(...low.map((r) => r.backward.s as number)), 5),
  };
}

/** One designed pose level's cases, as the pose table and the verdict read them. */
export interface PoseCase {
  allRefused: boolean;
  dGridMm: number | null;
  gridFlip: boolean | null;
  rotationFlip: boolean | null;
}

/**
 * A designed pose level, summarised against both yardsticks: how many cases
 * move the seams further than each null's 95th percentile, beside the grid and
 * rotation gate flips. Each gate's flips are read beside the rate at which a
 * clean re-shoot alone flips it (`tauNull.gridFlips`, `tauNull.rotationFlips`).
 */
export function poseLevel(
  label: string,
  these: readonly PoseCase[],
  tau: number | null,
  tauPosition: number | null,
) {
  const solved = these.filter((x) => x.dGridMm !== null);
  const over = (line: number | null): number | null =>
    line === null ? null : solved.filter((x) => (x.dGridMm as number) > line).length;
  return {
    label,
    cases: these.length,
    allRefused: these.filter((x) => x.allRefused).length,
    dGridMm: spread(solved.map((x) => x.dGridMm as number)),
    overTau: over(tau),
    overTauPosition: over(tauPosition),
    over025: solved.filter((x) => (x.dGridMm as number) > 0.25).length,
    over05: solved.filter((x) => (x.dGridMm as number) > 0.5).length,
    gridFlips: these.filter((x) => x.gridFlip === true).length,
    rotationFlips: these.filter((x) => x.rotationFlip === true).length,
  };
}

/**
 * The aimed rule's crossing on the swept lateness grid: the first lateness that
 * touches any aimed capture, the first that touches 1%, and the swept values
 * either side of that, so the document names the bracket it was measured in.
 * The first full run swept whole milliseconds and could only say "somewhere in
 * (3, 4]".
 */
export function aimedCrossing(
  timing: readonly Pick<
    TimingCell,
    'arm' | 'phase' | 'vsync' | 'lateMs' | 'capturesTouched' | 'trials'
  >[],
  vsync: boolean,
) {
  const cells = timing
    .filter((x) => x.arm === 'intervalometer-100ppm' && x.phase === 'aimed' && x.vsync === vsync)
    .slice()
    .sort((a, b) => a.lateMs - b.lateMs);
  const any = cells.find((x) => x.capturesTouched > 0) ?? null;
  const onePercent = cells.find((x) => x.capturesTouched / x.trials >= 0.01) ?? null;
  const below =
    onePercent === null
      ? null
      : ([...cells].reverse().find((x) => x.lateMs < onePercent.lateMs) ?? null);
  return {
    firstTouchedMs: any?.lateMs ?? null,
    onePercentMs: onePercent?.lateMs ?? null,
    // The 1% crossing lies in (below, at], on this grid.
    bracketMs:
      onePercent === null
        ? null
        : ([below?.lateMs ?? null, onePercent.lateMs] as [number | null, number]),
    grid: cells.map((x) => ({ lateMs: x.lateMs, touched: x.capturesTouched, trials: x.trials })),
  };
}

/**
 * How P3's verdict turns on its yardstick, beside the verdict and never in its
 * place. P3 falsifies when three or more cases at s = 0.03 sit within τ, so it
 * holds for any τ below the third-smallest D_grid there; and a case that moves
 * the seams further than every one of its own rig's re-shoots is beyond noise
 * on any reading.
 */
export function p3Bookkeeping(
  at003: readonly { rig: number; dGridMm: number | null }[],
  tau: Pick<Yardstick, 'lo' | 'hi' | 'byRig' | 'largest'>,
  positionTau: number | null,
) {
  const within = (line: number | null): number | null =>
    line === null ? null : at003.filter((x) => (x.dGridMm as number) <= line).length;
  const ds = ascending(at003.map((x) => x.dGridMm as number));
  return {
    withinTauAt: { lo: within(tau.lo), hi: within(tau.hi), positionTau: within(positionTau) },
    holdsForTauBelowMm: ds.length < 3 ? null : round(ds[2], 5),
    exceedOwnRigNulls: at003.filter((x) => {
      const own = tau.byRig[String(x.rig)] ?? [];
      return own.length > 0 && (x.dGridMm as number) > Math.max(...own);
    }).length,
    largestNulls: tau.largest,
  };
}

/**
 * P5a's rolling cases paired with the global ones, rig by rig. The rolling arm
 * refuses its own runs, so its solve can withhold other pairs than the global
 * one's; like for like is the pairs whose exclusions agree.
 */
export function p5aPairs(
  rolling: readonly { rig: number; dGridMm: number | null; refused: number[] }[],
  global: readonly { rig: number; dGridMm: number | null; refused: number[] }[],
) {
  const pairs = rolling.map((x) => {
    const g = global.find((y) => y.rig === x.rig);
    return {
      rig: x.rig,
      rolling: x.dGridMm,
      global: g?.dGridMm ?? null,
      ratio:
        g === undefined || g.dGridMm === null || g.dGridMm === 0 || x.dGridMm === null
          ? null
          : round(x.dGridMm / g.dGridMm, 4),
      sameExclusions:
        g === undefined ? null : JSON.stringify(x.refused) === JSON.stringify(g.refused),
    };
  });
  const like = pairs.filter((x) => x.sameExclusions === true && x.ratio !== null);
  return {
    pairs,
    likeForLike: {
      cases: like.length,
      outside30: like.filter((x) => Math.abs((x.ratio as number) - 1) > 0.3).length,
    },
  };
}

/**
 * The mean over camera rows of the rolling arm's designed smear: clamped at 0
 * on the rows that would be negative, so above the mid-row smear. Part of the
 * rolling arm's larger D_grid is a larger dose.
 */
export function meanRowSmear(midRow: number, readoutOverExposure: number, height: number): number {
  const smear = rollingSmear(midRow, readoutOverExposure, height);
  return round(mean(Array.from({ length: height }, (_, row) => smear(row))), 5) as number;
}

/**
 * P9's encode records by the run they came from: the minor and the dim runs
 * apart, and every record over the bound named.
 */
export function encodeBookkeeping(
  records: readonly {
    which: string;
    rig: number;
    camera: number;
    projector: number;
    s: number;
    maxDelta: number | null;
    twin: Pick<TwinRun, 'minor' | 'litShare'>;
  }[],
) {
  const max = (xs: typeof records): number | null =>
    xs.length === 0 ? null : round(Math.max(0, ...xs.map((r) => r.maxDelta ?? 0)), 6);
  return {
    encodeMaxDeltaNonMinor: max(records.filter((r) => !r.twin.minor)),
    encodeMaxDeltaLitOnePercent: max(records.filter((r) => r.twin.litShare >= 0.01)),
    recordsOverBound: records
      .filter((r) => (r.maxDelta ?? 0) > ENCODE_BOUNDS.residual)
      .map(
        (r) =>
          `${r.which} rig ${r.rig} camera ${r.camera} run ${r.projector + 1} s = ${r.s}: ` +
          `${round(r.maxDelta, 6)} (lit ${round(100 * r.twin.litShare, 2)}%, ` +
          `${r.twin.minor ? 'minor' : 'not minor'})`,
      ),
  };
}

/**
 * H7's verdict: failed by any testable failure, passed only when every clause
 * had a testable check and none failed, and otherwise not established. An
 * untestable check never passes or fails it.
 */
export function h7Pass(h: { failures: number; everyClauseTested: boolean }): boolean | null {
  return h.failures > 0 ? false : h.everyClauseTested ? true : null;
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

/**
 * Files the assembly reads besides the checkpoints, each by a path its caller
 * names: `readerAcceptance` is `experiments/reader-acceptance.json`, the
 * acceptance sweep's committed record of the page's reader on every clean
 * position, which the identity I-page-twin holds the page twins to.
 */
export interface AssemblySources {
  readerAcceptance: string;
}

export function assemble(ctx: RunContext, sources: AssemblySources): Record<string, unknown> | null {
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
  //
  // Q0 reads each clean position twice, from the same summaries: with the
  // page's reader, and with the reader it replaced, which this experiment first
  // measured refusing every clean position before its complement check ran
  // (`replacedIndexPhotographs`). Each reader's figures sit under its own name,
  // `page` and `replaced`. The classify margins are the replaced reader's first
  // step, which the page's reader no longer takes.
  const q0Positions = Object.values(q0.units).flatMap((u) => u.positions);
  const pageFigures = (ps: readonly Q0Position[]) => ({
    placedPositions: ps.filter((p) => p.runsPlaced.length > 0).length,
    runs: ps.length * PROJECTORS,
    runsPlaced: ps.reduce((a, p) => a + p.runsPlaced.length, 0),
    unseen: ps.reduce((a, p) => a + p.unseen.length, 0),
    barelySeen: ps.reduce((a, p) => a + p.barelySeen.length, 0),
    problems: ps.reduce((a, p) => a + p.problems.length, 0),
    positionsWithProblems: ps.filter((p) => p.problems.length > 0).length,
    placedPhotographs: ps.reduce((a, p) => a + p.placed, 0),
    reasons: countBy(
      ps.flatMap((p) => [...new Set(p.reasons)]),
      (r) => r,
    ),
  });
  const byWhich = (which: Which) => {
    const ps = q0Positions.filter((p) => p.which === which);
    return {
      positions: ps.length,
      photographs: ps.reduce((a, p) => a + p.total, 0),
      page: pageFigures(ps),
      replaced: {
        placedPositions: ps.filter((p) => p.replaced.runsPlaced.length > 0).length,
        placedPhotographs: ps.reduce((a, p) => a + p.replaced.placed, 0),
        reasons: countBy(
          ps.flatMap((p) => [...new Set(p.replaced.reasons)]),
          (r) => r,
        ),
        margin: spread(ps.map((p) => p.margin)),
        perRunAlone: {
          runs: ps.length * PROJECTORS,
          margin: spread(ps.flatMap((p) => p.perRun.map((r) => r.margin))),
          wrongKinds: spread(ps.flatMap((p) => p.perRun.map((r) => r.wrongKinds))),
          // A run per-run normalisation would rescue: separable, and every frame the right kind.
          rescued: ps
            .flatMap((p) => p.perRun)
            .filter((r) => r.margin >= MIN_CLASSIFY_MARGIN && r.wrongKinds === 0).length,
        },
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
      // Verbatim, from the first rig's first camera: the counterfactual reader's
      // words, which Q0b reads every folder shape with.
      problems: these[0]?.problems ?? [],
    };
  });
  const twinsOf = (which: Which) =>
    Object.entries(bank.units)
      .filter(([key]) => parseUnit(key).which === which)
      .flatMap(([, u]) => u.twins);
  const twinSummary = (which: Which) => {
    const runs = twinsOf(which).flatMap((t) => t.runs);
    const unit = Object.entries(bank.units).find(([key]) => parseUnit(key).which === which)?.[1];
    return {
      cameras: twinsOf(which).length,
      raster: unit === undefined ? null : { width: unit.width, height: unit.height },
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
      // Clean positions on which the counterfactual reader itself tells the
      // operator "Re-shoot projector N", in the words the page's former reader
      // wrote: mostly an invisible run, whose noise the check reads as a broken
      // pair. So a straddled capture's refusal by it is loud only against its
      // clean twin, which no operator sees.
      reshootNamed: reshootNamedOf(twinsOf(which)),
    };
  };
  // The page twin: the page's own reader on each camera's clean frames through
  // the fast path, which the page column attributes every verdict against.
  const pageTwinSummary = (which: Which) => {
    const twins = twinsOf(which);
    const counts = { both: 0, counterfactualOnly: 0, pageOnly: 0, neither: 0 };
    let placed = 0;
    let unseen = 0;
    let barelySeen = 0;
    let refused = 0;
    for (const t of twins) {
      if (t.page === undefined) continue;
      const verdicts = pageRunVerdicts(t.page);
      for (let p = 0; p < PROJECTORS; p++) {
        const byPage = t.page.placed.includes(p);
        const byCounterfactual = t.placedContent.includes(p);
        if (byPage && byCounterfactual) counts.both++;
        else if (byCounterfactual) counts.counterfactualOnly++;
        else if (byPage) counts.pageOnly++;
        else counts.neither++;
      }
      placed += t.page.placed.length;
      unseen += t.page.unseen.length;
      barelySeen += t.page.barelySeen.length;
      refused += verdicts.filter((v) => v === 'refused' || v === 'crashed').length;
    }
    const read = twins.filter((t) => t.page !== undefined);
    return {
      cameras: twins.length,
      read: read.length,
      runs: read.length * PROJECTORS,
      placed,
      unseen,
      barelySeen,
      refused,
      problems: read.reduce((a, t) => a + (t.page as PagePosition).problems.length, 0),
      crashes: read.filter((t) => (t.page as PagePosition).crash !== null).length,
      againstCounterfactual: counts,
    };
  };
  const refusedAt = refusedAtOf(
    q0Positions.map((p) => ({
      runsPlaced: p.replaced.runsPlaced,
      reasons: p.replaced.reasons,
      margin: p.margin,
      problems: p.replaced.problems,
    })),
  );
  const precondition = {
    q0: {
      main: byWhich('main'),
      spill: byWhich('spill'),
      fine: byWhich('fine'),
      total: q0Positions.length,
      // The page's reader, as it reads a clean position now.
      page: pageFigures(q0Positions),
      // The reader it replaced, on the same summaries: where it stopped each position.
      replaced: {
        placedPositions: q0Positions.filter((p) => p.replaced.runsPlaced.length > 0).length,
        maxMargin: round(Math.max(...q0Positions.map((p) => p.margin)), 4),
        minClassifyMargin: MIN_CLASSIFY_MARGIN,
        refusedAt,
      },
      // Each position with both readers' verdicts. The replaced reader's are
      // kept whole, with the classify fields, for the identity I-replaced,
      // which holds them to 754147f's committed file field for field.
      positions: q0Positions.map((p) => ({
        which: p.which,
        rig: p.rig,
        camera: p.camera,
        total: p.total,
        margin: round(p.margin, 4),
        wrongKinds: p.wrongKinds,
        perRun: p.perRun.map((r) => ({ margin: round(r.margin, 4), wrongKinds: r.wrongKinds })),
        page: {
          ok: p.ok,
          placed: p.placed,
          runsPlaced: p.runsPlaced,
          unseen: p.unseen,
          barelySeen: p.barelySeen,
          problems: p.problems,
          reasons: p.reasons,
          description: p.description,
        },
        replaced: {
          ok: p.replaced.ok,
          placed: p.replaced.placed,
          runsPlaced: p.replaced.runsPlaced,
          problems: p.replaced.problems,
        },
      })),
      worth,
      contingency: { triggered: contingencyRigs.length > 0, rigs: contingencyRigs },
    },
    q0b,
    twins: { main: twinSummary('main'), spill: twinSummary('spill'), fine: twinSummary('fine') },
    pageTwins: {
      main: pageTwinSummary('main'),
      spill: pageTwinSummary('spill'),
      fine: pageTwinSummary('fine'),
    },
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
  const u0Detail = u0Gaps(u0Runs);
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
      // How far the scan looked: a run with no crossing was placed at every
      // smear up to here.
      scannedTo: GATE_SCAN.max,
      neverRefused: {
        forward: attributable.filter((r) => r.forward.s === null).length,
        backward: attributable.filter((r) => r.backward.s === null).length,
      },
      refusedClean: attributable.filter((r) => r.forward.s === 0).length,
      // Five places, as the runs carry them: a percentile quoted to 0.1% of the
      // exposure is not then a rounding of a rounding.
      forward: spread(crossed('forward'), 5),
      backward: spread(crossed('backward'), 5),
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
      u0: { runs: u0Runs.length, error: spread(u0Errors, 6), ...u0Detail },
      lowBackward: lowBackward(mainRuns),
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
    // The page's two readings of each hook position are kept whole in the
    // checkpoint; here they are reduced to what they place and where, with the
    // words counted and classed rather than copied.
    hook: hooks.map(({ pageHook, pageFast, ...h }) => ({
      ...h,
      identicalShare: round(h.identical / h.pixels, 7),
      biasU: round(h.biasU, 7),
      biasV: round(h.biasV, 7),
      pageHook: pageBrief(pageHook),
      pageFast: pageBrief(pageFast),
      pageAlsoAgree: pageAlsoAgree(pageHook, pageFast),
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
  // Per-pixel signs, pooled over a set of run-levels: every pixel both decodes
  // accept counts once, the seam (the neighbour projector lights it too) apart
  // from the rest. Null where a checkpoint predates the tally.
  const pooledSigns = (ls: readonly DecodeLevel[]) => {
    if (ls.some((l) => l.signs === undefined)) return null;
    const sum = (parts: readonly ('seam' | 'rest')[]) => {
      const t: SignTally = {
        pixels: 0,
        uPos: 0,
        uNeg: 0,
        vPos: 0,
        vNeg: 0,
        maxAbsU: 0,
        maxAbsV: 0,
      };
      for (const l of ls) {
        for (const part of parts) {
          const x = l.signs[part];
          t.pixels += x.pixels;
          t.uPos += x.uPos;
          t.uNeg += x.uNeg;
          t.vPos += x.vPos;
          t.vNeg += x.vNeg;
          t.maxAbsU = Math.max(t.maxAbsU, x.maxAbsU);
          t.maxAbsV = Math.max(t.maxAbsV, x.maxAbsV);
        }
      }
      const share = (n: number): number | null => (t.pixels === 0 ? null : round(n / t.pixels, 5));
      return {
        ...t,
        uPosShare: share(t.uPos),
        uNegShare: share(t.uNeg),
        vPosShare: share(t.vPos),
        vNegShare: share(t.vNeg),
      };
    };
    return { seam: sum(['seam']), rest: sum(['rest']), all: sum(['seam', 'rest']) };
  };
  // Gray-word changes, summed over a set of run-levels (H7's flip clause).
  const grayFlipsOf = (ls: readonly DecodeLevel[]) =>
    ls.some((l) => l.grayFlips === undefined)
      ? null
      : {
          matched: ls.reduce((a, l) => a + l.grayFlips.matched, 0),
          u: ls.reduce((a, l) => a + l.grayFlips.u, 0),
          v: ls.reduce((a, l) => a + l.grayFlips.v, 0),
          either: ls.reduce((a, l) => a + l.grayFlips.either, 0),
        };
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
        p95AbsV: spread(ls.map((l) => l.shift.p95AbsV as number).filter((x) => x !== null)),
        truthMedianAbs: spread(
          ls.map((l) => l.truth.medianAbs as number).filter((x) => x !== null),
        ),
        mmError: spread(ls.map((l) => l.mm.errorMedian as number).filter((x) => x !== null)),
        mmShift: spread(ls.map((l) => l.mm.shiftMedian as number).filter((x) => x !== null)),
        gross: ls.reduce((a, l) => a + ((l.shift.gross as number) ?? 0), 0),
        movedHalfPeriod: ls.reduce((a, l) => a + ((l.shift.movedHalfPeriod as number) ?? 0), 0),
        grayFlips: grayFlipsOf(ls),
        signs: pooledSigns(ls),
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
  // Whether the bias's MEAN is one-signed, run by run: forward run-levels whose
  // mean shift is not negative, per axis. The sign of a mean says nothing about
  // the pixels under it; `signs` does.
  const forwardLevels = decodeRuns.flatMap((r) =>
    r.levels.filter((l) => l.direction === 'forward'),
  );
  const nonNegative = (axis: 'meanU' | 'meanV'): number =>
    forwardLevels.filter((l) => l.shift[axis] !== null && (l.shift[axis] as number) >= 0).length;
  const decodeDoc = {
    runs: decodeRuns.length,
    // What three of the curve's fields count, because two of them were misread.
    legend: {
      grayFlips:
        'Gray-word changes against the clean decode, per axis, on the pixels both decodes ' +
        "accept: the decoder's own Gray address, read with the phase withheld. H7's flip clause.",
      movedHalfPeriod:
        'decodes moved half a period or more on either axis: a displacement bound, not a ' +
        'Gray-flip count. A correct Gray word with a phase error can move a decode up to 0.65 of ' +
        'a period. The first full run named this field wrongFringe and read it as flips.',
      signs:
        "per-pixel signs of Δu and Δv on the same pixels. 'seam': pixels the projector whose " +
        "light the blend brings into the run also lights (the next projector forward, the " +
        "previous one backward); 'rest': the others.",
    },
    curve,
    forwardMeans: {
      runLevels: forwardLevels.length,
      nonNegativeU: nonNegative('meanU'),
      nonNegativeV: nonNegative('meanV'),
    },
    // Every Gray word changed below 5/9, over every run and level: H7's flip
    // clause in one number, and the smear the decode stopped at.
    grayFlipsBelowFiveNinths: grayFlipsOf(
      decodeRuns.flatMap((r) => r.levels.filter((l) => l.s < 5 / 9)),
    ),
    highestDecoded: Math.max(...plan.decodeNoiseless, VERDICT_S),
    verdictLevel: {
      s: VERDICT_S,
      runs: verdictLevel.length,
      absMeanU: spread(verdictLevel.map((l) => Math.abs(l.shift.meanU as number))),
      absMeanV: spread(verdictLevel.map((l) => Math.abs(l.shift.meanV as number))),
      // The largest per-run 95th percentile is the `max` of these.
      p95AbsU: spread(verdictLevel.map((l) => l.shift.p95AbsU as number).filter((x) => x !== null)),
      p95AbsV: spread(verdictLevel.map((l) => l.shift.p95AbsV as number).filter((x) => x !== null)),
      // Each run's MEDIAN movement on the sphere, both axes together, and this
      // is their spread over runs: the verdict's millimetres are a median of
      // per-run medians.
      mmShift: spread(
        verdictLevel.map((l) => l.mm.shiftMedian as number).filter((x) => x !== null),
      ),
      grayFlips: grayFlipsOf(verdictLevel),
      signs: pooledSigns(verdictLevel),
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
      // Not the spec's successor ablation, and first reported as one. It blends
      // EVERY photograph with the dark, which dims every frame toward this
      // projector's black alike, so it shows that a uniform dimming moves
      // nothing. It does not replace only the last frame's successor, so it
      // cannot isolate what the next projector's white contributes.
      dimmingControl: {
        what:
          'every photograph blended with the dark at s: a uniform dimming, not a successor ' +
          'ablation',
        meanU: spread(
          decodeRuns.map((r) => r.ablation.dimmed.meanU as number).filter((x) => x !== null),
        ),
        sigmaU: spread(
          decodeRuns.map((r) => r.ablation.dimmed.sigmaU as number).filter((x) => x !== null),
        ),
      },
    },
  };

  // ----- pose
  const tau = yardstick(ev, 'nulls', 'tau-null');
  const tauPosition = yardstick(ev, 'positionNulls', 'tau-position');
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
  const yardstickDoc = (y: Yardstick, what: string) => ({
    what,
    value: y.value,
    lo: y.lo,
    hi: y.hi,
    median: y.median,
    samples: y.samples,
    perRig: Object.fromEntries(
      Object.entries(y.byRig).map(([k, xs]) => [k, xs.map((x) => round(x, 5))]),
    ),
    perRigRange: y.perRigRange,
    largest: y.largest,
    rotationFlips: y.rotationFlips,
    gridFlips: y.gridFlips,
  });
  const poseDoc = {
    solved: plan.pose,
    // τ: re-shooting the whole capture, every camera's photons renewed.
    tauNull: yardstickDoc(
      tau,
      're-shooting the whole capture: every camera photographed again under a fresh capture ' +
        'seed, against the rig\'s plain twin',
    ),
    // Re-shooting only the straddled position: the remedy an operator applies.
    tauPosition: yardstickDoc(
      tauPosition,
      're-shooting only the straddled position: its camera photographed again under the same ' +
        'seeds as the whole-capture re-shoots, every other camera kept, against the plain twin',
    ),
    levels: poseLevelKeys.map((label) =>
      poseLevel(
        label,
        poseCases.filter((x) => x.label === label),
        tau.value,
        tauPosition.value,
      ),
    ),
    cases: poseCases,
    auditDisagreements: poseCases.flatMap((x) => x.audit?.disagreements ?? []),
  };

  // ----- rescore and lateness
  const tauValue = plan.pose ? tau.value : null;
  const yardsticks = {
    tauLo: plan.pose ? tau.lo : null,
    tauHi: plan.pose ? tau.hi : null,
    positionTau: plan.pose ? tauPosition.value : null,
  };
  const rescoreDoc = {
    audit: (rescore.units.audit?.audit ?? []).map((a) => ({ ...a })),
    refine: refineDiagnostic(ev),
    cells: rescoreCells(plan).map((cell) =>
      summariseCell(ev, cell, rescore, tauValue, yardsticks),
    ),
  };
  const timing = lateness.units.timing?.timing ?? [];
  const latenessDoc = {
    timing,
    aimed: {
      vsyncOff: aimedCrossing(timing, false),
      vsyncOn: aimedCrossing(timing, true),
      threshold: aimedThreshold(),
    },
    cells: latenessCells(plan).map((cell) =>
      summariseCell(ev, cell, lateness, tauValue, yardsticks),
    ),
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
  const h7 = evaluateH7(decodeRuns, plan.decodeNoiseless);
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
        'backward for run 0); no Gray word flipped below 5/9, counted as Gray-word changes on ' +
        'the pixels both decodes accept; the MSB-lit half lost to low modulation at s = 0.5. A ' +
        'check on a run whose clean decode accepts no pixel of the half it asks about cannot ' +
        'test the identity, and is counted apart as untestable.',
      measured: {
        ...h7,
        // Beside it, the spec's own gross count (a quarter period), which below
        // 5/9 is phase error, not a flip: kept so the difference is on record.
        grossBelow59: decodeRuns
          .flatMap((r) => r.levels.filter((l) => l.s < 5 / 9))
          .reduce((a, l) => a + ((l.shift.gross as number) ?? 0), 0),
      },
      pass: h7Pass(h7),
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
    // The re-run's own identities (`RERUN_IDENTITIES`), registered with its
    // bets. I-replaced is held outside the document, against 754147f's
    // committed file, which the run overwrites: the document carries the
    // replaced reader's verdicts it compares (precondition.q0.positions[]).
    {
      id: 'H8-page',
      claim: rerunIdentity('H8-page').holds,
      measured: {
        records: hooks.length,
        agree: hooks.filter((h) => h.pageAgree).length,
        disagreements: hooks
          .filter((h) => !h.pageAgree)
          .map(
            (h) =>
              `rig ${h.rig} camera ${h.camera} s = ${h.s}: the hook's frames read placed ` +
              `[${h.pageHook.placed}], unseen [${h.pageHook.unseen}], barely seen ` +
              `[${h.pageHook.barelySeen}], ${h.pageHook.problems.length} problems; the fast path's ` +
              `[${h.pageFast.placed}], [${h.pageFast.unseen}], [${h.pageFast.barelySeen}], ` +
              `${h.pageFast.problems.length}`,
          ),
        // Beside the identity and not part of it: whether the two readings
        // also place each run at the same photographs, misfile the same ones,
        // and word their problems alike.
        alsoAgree: {
          starts: hooks.filter((h) => pageAlsoAgree(h.pageHook, h.pageFast).starts).length,
          contentMisfiles: hooks.filter((h) => pageAlsoAgree(h.pageHook, h.pageFast).contentMisfiles)
            .length,
          problemTexts: hooks.filter((h) => pageAlsoAgree(h.pageHook, h.pageFast).problemTexts).length,
        },
      },
      pass: hooks.length > 0 ? hooks.every((h) => h.pageAgree) : null,
    },
    {
      id: 'I-page-twin',
      claim: rerunIdentity('I-page-twin').holds,
      restsOn: rerunIdentity('I-page-twin').restsOn,
      ...pageTwinIdentity(
        Object.entries(bank.units).flatMap(([key, u]) => {
          const { which, k } = parseUnit(key);
          return u.twins.map((twin) => ({ which, variant: variantOf(plan, which), rig: k, twin }));
        }),
        (() => {
          if (!fs.existsSync(sources.readerAcceptance)) {
            throw new Error(
              `experiment10: I-page-twin holds the page twins to ${sources.readerAcceptance}, ` +
                'which is not there',
            );
          }
          return JSON.parse(fs.readFileSync(sources.readerAcceptance, 'utf8')) as unknown;
        })(),
      ),
    },
  ];

  // ----- predictions (pre-registered; each can fail)
  const r1 = rescoreDoc.cells.find((c) => c.id === 'R1');
  const aimed75 =
    latenessDoc.cells.find((c) => c.id === `L-aimed-${HEADLESS_LATENESS_MS.hudTickOff}`) ?? null;
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
  // Bookkeeping beside the registered predictions. None of it changes a
  // verdict; each item says how far a verdict turns on the yardstick, the
  // population or the pairing it was read on, which the first full run's
  // verification had to work out by hand.
  const p3Book = p3Bookkeeping(poseAt('forward/0.03'), tau, tauPosition.value);
  const p5a = p5aPairs(
    poseAt(`rolling/${plan.poseLevels.rolling.readoutOverExposure}/0.06`),
    poseAt('forward/0.06'),
  );
  const mainHeight = Object.entries(bank.units).find(
    ([key]) => parseUnit(key).which === 'main',
  )?.[1].height;
  const encode = encodeBookkeeping(
    gateUnits.flatMap(([key, u]) => {
      const unit = parseUnit(key);
      return u.encode.map((r) => ({
        ...r,
        which: unit.which,
        rig: unit.k,
        twin: twinFor(ev, unit.which, unit.k, r.camera).runs[r.projector],
      }));
    }),
  );
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
        bookkeeping: p3Book,
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
              // Solved and not judged, so in no count here (`harmOf`).
              unjudgeable: silent['SILENT-UNJUDGEABLE'],
              exceedTau: r1?.classes.P.silentAgainst.tau?.exceedTau ?? null,
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
        pose: p5a.pairs,
        likeForLike: p5a.likeForLike,
        meanRowSmear:
          mainHeight === undefined
            ? null
            : meanRowSmear(0.06, plan.poseLevels.rolling.readoutOverExposure, mainHeight),
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
      note: rerunBet('P6').note ?? null,
      measured: {
        positions: precondition.q0.total,
        // The page's reader, which decides the bet as it decided it before:
        // a clean position it places falsifies it.
        placedPositions: precondition.q0.page.placedPositions,
        // The reader the bet was registered against, and where it stopped each
        // position: a margin over 0.15 belongs to a position that cleared
        // classify and was refused at the run count.
        replaced: {
          placedPositions: precondition.q0.replaced.placedPositions,
          maxMargin: precondition.q0.replaced.maxMargin,
          refusedAt: precondition.q0.replaced.refusedAt,
          reasons: {
            main: precondition.q0.main.replaced.reasons,
            spill: precondition.q0.spill.replaced.reasons,
            fine: precondition.q0.fine.replaced.reasons,
          },
        },
      },
      falsified: precondition.q0.page.placedPositions > 0,
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
        ...encode,
        // Noiseless blends only: nobody compared the encode on noisy frames (followUps).
        frames: 'noiseless',
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
  // The re-run's bets on the page column, registered before any of its output
  // existed (design.ts), read off every rescore and lateness cell's page block
  // and Q0 against the page twin.
  const bets = evaluateRerunBets(
    [...rescoreDoc.cells, ...latenessDoc.cells],
    silent === null ? null : SILENT_CLASSES.reduce((a, name) => a + (silent[name] ?? 0), 0),
    q0AgainstPageTwin(q0Positions, (which, rig, camera) => twinFor(ev, which, rig, camera)),
  );

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
      // The code that wrote this document from those checkpoints, which the
      // checkpoint fingerprint deliberately leaves out (stages.ts's header).
      assemblyFingerprint: assemblyFingerprint(),
      staleCheckpointsAccepted: ctx.staleAccepted,
      design: designConstants(plan),
      refineBand: REFINE_CEILING,
      refineAgreement: REFINE_AGREEMENT,
      verdictSmear: VERDICT_S,
      caveats: {} as Record<string, string>,
    },
    precondition,
    gate: gateDoc,
    decode: decodeDoc,
    pose: poseDoc,
    rescore: rescoreDoc,
    lateness: latenessDoc,
    harness,
    predictions: [...predictions, ...bets],
    followUps: followUps(plan, precondition.q0.page.placedPositions),
    verdict: { statement: '' },
  };
  doc.generatedFrom.caveats = caveats(doc as unknown as VerdictDoc);
  doc.verdict.statement = verdictStatement(doc as unknown as VerdictDoc);
  return doc;
}

/**
 * What this experiment still has not measured, each a measurement somebody
 * could make next. Kept in the document so a reader of the results reads the
 * gaps beside them, and so a gap closed later has somewhere to be crossed out.
 */
export function followUps(plan: Exp10Plan, placedPositions: number): string[] {
  const out = [
    "P0, the emitter's lateness: tools/emitter-timing.ts was never built, so δ has been " +
      'measured only by a design-time probe in a headless, software-rendered browser, and never ' +
      'on a display machine. Every lateness this document renders at is an input, not a result.',
    'P9 on noisy frames: the 8-bit sRGB page path is compared with linear frames on noiseless ' +
      "blends only. The page column reads the fast path's noisy frames through encodeSrgb8 and " +
      'summarisePhoto, but sets no linear fingerprint beside them, so P9 says nothing about ' +
      'noise and the encode together.',
    'Clearance: the document carries no camera azimuth and no clearance from a projector axis ' +
      'or seam, so nothing is reported by clearance bin and a site cannot place itself by one.',
    "The successor ablation proper: only each run's last frame's successor replaced by the " +
      "dark, to isolate what the next projector's white contributes. decode.ablation." +
      'dimmingControl dims every photograph instead.',
    'A re-shoot that straddles again: policy P assumes every re-shoot after a refusal is clean. ' +
      'Nothing here draws a fresh start for it.',
    "EXPERIMENT-9's timing model, inherited and not validated: its drift band, its per-shot " +
      "jitter, its start procedures and the aimed rule's ±D/4 band were never measured against " +
      'a camera beside a sphere.',
  ];
  const top = Math.max(...plan.decodeNoiseless);
  if (top < 5 / 9) {
    out.push(
      `The Gray flip onset at 5/9: no smear above ${top} was decoded, so what is measured is ` +
        'the absence of flips below 5/9, not the onset.',
    );
  }
  const solving = latenessCells(plan).filter((x) => x.solve !== 'none');
  out.push(
    solving.length === 0 || plan.solveSubsample === 0
      ? 'Lateness solves: this plan solves no lateness capture, so no lateness cell says how ' +
          'far its silent captures move the seams.'
      : `Lateness solves: only ${solving.map((x) => x.id).join(', ')} solves captures, the ` +
          `first ${plan.solveSubsample} in trial order with a PLACED or MIXED position, under ` +
          "policy A. Policy P borrows A's solve where its plan is A's, which it is wherever " +
          'the capture has no MIXED position, so a LOUD+SILENT capture whose loud positions ' +
          'are all REFUSED-ALL is solved under P; a capture with a MIXED position is not, and ' +
          "at every other lateness nothing is: the lateness cells' past-gate counts cover the " +
          'solved captures alone.',
  );
  if (placedPositions === 0) {
    out.push(
      "The page's reader on a straddled position: it placed no clean position (P6), so the " +
        "rescoring's page column did not run, and every loud/silent split here is the " +
        "counterfactual's.",
    );
  } else {
    out.push(
      "The page's own harm: a capture the page lets through takes a counterfactual solve's " +
        "harm only where the page's plan, placement included, is that solve's " +
        '(page.classes.P.harm). No capture was solved on a plan of the page\'s own, so every ' +
        'other one is not solved, and past-gate counts through the page cover the reused ' +
        'solves alone.',
      "The page's decode: the page column reads which runs the page places and where, and " +
        'decodes none. What a straddle does to the coordinates of a run as the page files it is ' +
        'not measured: one only the page places, re-filed by what its photographs show or ' +
        "refused by the counterfactual's bookends, and one holding a photograph filed under " +
        "another step than the one it mostly shows (P10's misfiles). The decode subsamples " +
        "draw from the counterfactual's placed runs.",
    );
  }
  return out;
}

/** The design constants the document carries, read back like any cell. */
function constant(doc: VerdictDoc, name: string): unknown {
  return at(doc.generatedFrom.design.constants as Record<string, unknown>, name);
}

/** Element `i` of an array the document carries, through {@link at}. */
function nth(xs: readonly number[], i: number): number {
  return at(Object.fromEntries(xs.map((x, j) => [String(j), x])), String(i));
}

/**
 * Said in the file, because a reader who takes these numbers into a room needs
 * them beside the numbers. Built from the document's own cells through
 * {@link at}, like the verdict: the first full run's caveats were fixed strings,
 * and two of them said less than its data did.
 */
export function caveats(doc: VerdictDoc): Record<string, string> {
  const q0 = doc.precondition.q0;
  const hook = doc.harness.find((h) => h.id === 'H8-page')?.measured as
    | { records?: number; agree?: number }
    | undefined;
  const cells: Record<string, number> = {
    total: q0.total,
    placed: q0.page.placedPositions,
    replacedPlaced: q0.replaced.placedPositions,
    classify: q0.replaced.refusedAt.classify.positions,
    count: q0.replaced.refusedAt.count.positions,
    other: q0.replaced.refusedAt.other,
    reshootNamed: doc.precondition.twins.main.reshootNamed,
    twinPositions: doc.precondition.twins.main.cameras,
    pageTwinRuns: doc.precondition.pageTwins.main.runs,
    pageTwinUnseen: doc.precondition.pageTwins.main.unseen,
    hookRecords: hook?.records ?? Number.NaN,
    hookAgree: hook?.agree ?? Number.NaN,
  };
  const c = (key: string): number => at(cells, key);
  const plan = doc.generatedFrom.design.plan;
  const raster = (which: 'main' | 'fine'): string => {
    const r = doc.precondition.twins[which].raster;
    if (r === null) return '';
    const perBlock = (r.width * r.height) / (constant(doc, 'FINGERPRINT_BLOCKS') as number) ** 2;
    return (
      `${r.width}x${r.height}, where a fingerprint cell holds about ` +
      `${Math.round(perBlock)} pixels`
    );
  };
  const late = constant(doc, 'HEADLESS_LATENESS_MS') as Record<string, number>;
  const grid = constant(doc, 'LATE_MS_TIMING') as number[];
  const vsyncHz = Math.round(1 / (constant(doc, 'VSYNC_S') as number));
  const counterfactual =
    "Each cell's classes, loud, positions and runs are a COUNTERFACTUAL reader's: the " +
    "complement check the page's former reader ended in (indexByFingerprint), handed exact " +
    'oracle lit fractions and linear fingerprints, and attributed against its own verdict on ' +
    'the clean twin (precondition.twins). It tells the operator ' +
    `'Re-shoot projector N' on ${c('reshootNamed')} of ${c('twinPositions')} clean positions ` +
    '(precondition.twins.main.reshootNamed), mostly for a projector the camera cannot see, so ' +
    "its 'loud' is loud against the clean twin, which the operator never sees.";
  return {
    reader:
      c('placed') === 0
        ? `${counterfactual} The page's own reader placed none of the ${c('total')} clean bench ` +
          'positions (precondition.q0.page), so the page column did not run, and every loud/silent ' +
          "split here is the counterfactual's."
        : `Two readers are reported. ${counterfactual} Each cell's page block is the page's own ` +
          'reader (indexPhotographs) on the same photographs, encoded to 8-bit sRGB and summarised ' +
          "as the page reads them, and attributed against its own reading of the same clean frames " +
          '(precondition.pageTwins), which notes a projector the camera cannot see out of view ' +
          `instead: ${c('pageTwinUnseen')} of the ${c('pageTwinRuns')} runs of the sweep ` +
          '(precondition.pageTwins.main.unseen).',
    stopped:
      c('replacedPlaced') === 0
        ? 'The reader the page replaced refused every clean bench position before its complement ' +
          `check ran: ${c('classify')} of ${c('total')} at classify and ${c('count')} at the run ` +
          'count' +
          (c('other') > 0 ? `, ${c('other')} for other reasons` : '') +
          " (precondition.q0.replaced.refusedAt). Q0 keeps its verdict on every position beside " +
          "the page's reader's, on the same photographs (precondition.q0.positions[].replaced)."
        : `The reader the page replaced placed a run in ${c('replacedPlaced')} of ${c('total')} ` +
          'clean bench positions and refused the rest before its complement check ran ' +
          '(precondition.q0.replaced.refusedAt). Q0 keeps its verdict on every position beside ' +
          "the page's reader's, on the same photographs (precondition.q0.positions[].replaced).",
    footings:
      'content footing (primary): a photograph observes as the kind of the part holding more ' +
      'than half its exposure, the filed kind on a tie; filed footing (secondary): the kind of ' +
      'the step it is filed as.',
    timer:
      "The emitter is EXPERIMENT-9's perfect timer except in two places. The lateness stage " +
      `sweeps δ from ${nth(grid, 0)} to ${nth(grid, grid.length - 1)} ms per step. Of ` +
      `those values ${at(late, 'hudTickOff')} ms is the mean of a design-time probe in headless ` +
      "Chromium on SwiftShader's software GL, in HUD mode with the tick off; armed with the tick " +
      `on, the same setup ran about ${at(late, 'armedTickOn')} ms late when the first full ` +
      `run's verification re-ran it. ${at(late, 'pureJsLowerBound')} ms is the pure-JS lower ` +
      "bound. Neither is a display machine's number, and this experiment re-measured neither: " +
      `the spec's P0 (tools/emitter-timing.ts) was never built. R7 adds an assumed ${vsyncHz} Hz ` +
      'refresh wait with no lateness.',
    inherited:
      "EXPERIMENT-9's drift band, per-shot jitter and start procedures are inherited, not " +
      "validated (EXPERIMENT-9.md), and the aimed rule's ±D/4 aim band is unmeasured. Hand-held " +
      "release jitter is assumed symmetric. The intervalometer's own re-arm rule (an interval " +
      'counted from one release, or from the end of an exposure) is not modelled.',
    photometry:
      'Bench photometry: flat albedo, constant ambient, Gaussian shot noise, point-sampled ' +
      'patterns, one grey channel, no defocus, no JPEG. Q0 margins, clean residual floors and ' +
      'invisible-run refusals are bench numbers. Gain repeatability (GAIN_JITTER) and the ' +
      'mismatched tone curve (TONE_CURVE) are ASSUME-class sensitivities, not measurements.',
    projection:
      "Neither a DLP projector's sub-frames nor a display's scan-out is modelled, so the smear " +
      'never varies with projector row. Sub-frames matter at E = 1/60 s, where P5b uses the ' +
      'idealised model.',
    placement:
      `Placement: ${(at(plan as Record<string, unknown>, 'rigs') as number[]).length} azimuth ` +
      'offsets of one camera set, one height and ' +
      `distance draw per rig, the ${constant(doc, 'CAMERAS')} cameras exactly ` +
      `${360 / (constant(doc, 'CAMERAS') as number)}° apart. Nothing is reported by clearance ` +
      'bin; the document carries no camera azimuth or clearance (followUps).',
    resolution:
      `The main sweep renders at ${raster('main')}. ` +
      (doc.precondition.twins.fine.raster === null
        ? 'No finer preset was rendered.'
        : `The check at ${raster('fine')} (gate.resolution) bounds only the gate side of that.`),
    folder:
      'F136: a position is exactly 136 photographs, the first the first release after Play. The ' +
      "card's own extra end photographs and re-shot runs are measured for the counterfactual " +
      'reader alone (precondition.q0b); the page column reads the 136 and nothing else.',
    fastPath:
      'Noisy frames come from the fast path — a bank blend through the renderer\'s own sensor ' +
      'and noise stream — validated against hook renders in gate.hook: the pixels, the ' +
      "counterfactual's verdicts and the decode bias by H8, and the page's reading of the whole " +
      'straddled position by H8-page' +
      (c('hookRecords') === 0
        ? '; this run rendered no hook position, so neither is established.'
        : ` (${c('hookAgree')} of ${c('hookRecords')} readings agree).`),
    pageColumn:
      "Each cell's page block reads every changed position of a page-column rig whole, from the " +
      "fast path's noisy frames. A run counts against the straddle only where the page's " +
      'reading of the clean twin places it. A run that reading places and the straddled one ' +
      'only notes out of view or barely seen is a quiet drop (P12): neither refused nor placed. ' +
      'A position holding one with nothing refused is QUIET, which is not PLACED, so it makes ' +
      'no capture SILENT: with nothing refused, a capture is SILENT when a position is PLACED ' +
      'and QUIET when none is and one is QUIET, a class the counterfactual reader cannot have, ' +
      'since it refuses every run it does not place. A LOUD capture with a QUIET position is ' +
      'counted as LOUD+QUIET, not LOUD+SILENT. A QUIET position can still place another touched ' +
      'run, which reaches the calibration straddled; in a capture with no PLACED position no ' +
      'class counts it (page.quiet.quietPlacingTouched). A crash counts as a refusal and is ' +
      "counted apart. A SILENT capture, and a LOUD+SILENT one's PLACED part, takes a " +
      "counterfactual solve's harm only where the page's plan, placement included, is that " +
      "solve's, and is otherwise not solved (page.classes.P.harm); a QUIET capture is given no " +
      'harm. A misfile is a photograph a placed run files under another step than the one ' +
      'holding more than half its exposure (P10).',
    reshoot:
      'Policy P assumes the re-shoot after a refusal is clean, which is optimistic: a fresh ' +
      'start can straddle again (followUps).',
    yardsticks:
      `Two nulls of D_grid, each ${at(plan, 'kNull')} re-shoots of each of ` +
      `${(at(plan as Record<string, unknown>, 'designedRigs') as number[]).length} designed rigs ` +
      'against the plain twin: the ' +
      'whole capture re-shot (pose.tauNull), and only the straddled position re-shot under the ' +
      'same seeds (pose.tauPosition). HARMLESS and BIASED are drawn at τ, the whole-capture ' +
      '95th percentile, set by the few rigs that supply its largest values ' +
      '(pose.tauNull.largest). A ' +
      "straddle's median is set against each null's median; a 95th percentile is quoted beside " +
      'it, never instead of it.',
    unjudgeable:
      'A solve whose D_grid is censored (a lower bound) or whose twin misses the seam gate on ' +
      'its own is reported as unjudgeable, never HARMLESS or BIASED: SILENT-UNJUDGEABLE when the ' +
      'capture is silent, and in solved.unjudgeable when it is loud.',
    refineBand:
      'One evaluation decides every run, for every purpose: the fully noisy verdict in R1, and ' +
      'in every other rescore and lateness cell the refine band at generatedFrom.refineBand ' +
      '(runs whose noiseless worst pair lies within it of the limit are re-evaluated with ' +
      'noise). The same band chose the decode subsamples and the solved captures and classifies ' +
      'every position. rescore.refine is a diagnostic only: on R1 it holds the band, and the ' +
      'narrower margins, to the fully noisy reader.',
    solveExclusions:
      'SPEC AMENDMENT (spec §6 R1 and L solves): a solve withholds every run of a straddled ' +
      "position whose outcome is not 'placed', from the treated solve and its twin alike, " +
      'together with every run the clean capture refuses. The spec withheld only a MIXED ' +
      "position's refused runs. A collateral refusal inside a PLACED position (an untouched " +
      "run the page refuses because a neighbour's slip moved the bookends) was therefore still " +
      'handed to the treated solve, rendered clean, though the page decodes nothing of a run ' +
      'it refuses. The twin withholds it too, so the pair still differs by the straddle alone.',
    runTallies:
      "A cell's runs.outcomes and runs.brokenPairs tally ATTRIBUTABLE touched runs only, the " +
      'one group every cell evaluates alike, so they compare across cells. Runs the twin ' +
      'refuses anyway are reported apart in runs.notAttributable and do not compare: R1 ' +
      'evaluates them with noise, and the other cells leave them on their noiseless verdict.',
    decodeControls:
      'decode.ablation.dimmingControl blends every photograph with the dark: a uniform dimming, ' +
      "which moves nothing. It is not the spec's successor ablation (followUps). " +
      'decode.curve[].movedHalfPeriod bounds how far decodes moved and counts no Gray flip; ' +
      'decode.curve[].grayFlips counts them.',
    pose:
      "Pose cost is the bench solver's. The page never solves, and its worth report cannot see a " +
      'straddle (precondition.q0.worth).',
  };
}

type Spread = {
  n: number;
  min: number | null;
  p10: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
};
type Signs = {
  pixels: number;
  uPos: number;
  vPos: number;
  uPosShare: number | null;
  vPosShare: number | null;
  maxAbsU: number;
  maxAbsV: number;
};

export type VerdictDoc = {
  mode: string;
  generatedFrom: {
    design: {
      constants: Record<string, unknown>;
      plan: { rigs: number[]; designedRigs: number[]; kNull: number };
    };
  };
  precondition: {
    q0: {
      total: number;
      page: {
        placedPositions: number;
        runs: number;
        unseen: number;
        barelySeen: number;
        positionsWithProblems: number;
      };
      replaced: {
        placedPositions: number;
        minClassifyMargin: number;
        refusedAt: {
          classify: { positions: number; maxMargin: number | null };
          count: {
            positions: number;
            margin: Spread;
            runsFound: { min: number; max: number } | null;
          };
          other: number;
        };
      };
    };
    q0b: { shape: string; positions: number; wholeRefused: number }[];
    twins: {
      main: {
        cameras: number;
        reshootNamed: number;
        raster: { width: number; height: number } | null;
      };
      fine: { raster: { width: number; height: number } | null };
    };
    pageTwins: { main: { runs: number; unseen: number; barelySeen: number } };
  };
  harness: { id: string; pass: boolean | null; measured: unknown }[];
  /**
   * The bets as the document evaluates them. The verdict reads the re-run's
   * (P10–P13) for held or falsified, and holds what each measured to the cells
   * it quotes beside it.
   */
  predictions: { id: string; falsified: boolean | null; measured: unknown }[];
  gate: {
    crossings: {
      forward: Spread;
      backward: Spread;
      attributableRuns: number;
      scannedTo: number;
      neverRefused: { forward: number; backward: number };
      lowBackward: { below: number; runs: number; maxLit: number | null; lowest: number | null };
    };
  };
  decode: {
    curve: { direction: string; s: number; ratioU: { median: number | null } }[];
    forwardMeans: { runLevels: number; nonNegativeU: number; nonNegativeV: number };
    grayFlipsBelowFiveNinths: { either: number } | null;
    highestDecoded: number;
    verdictLevel: {
      runs: number;
      absMeanU: Spread;
      absMeanV: Spread;
      p95AbsV: Spread;
      mmShift: Spread;
      signs: { seam: Signs; rest: Signs; all: Signs } | null;
    };
  };
  pose: {
    solved: boolean;
    tauNull: {
      value: number | null;
      lo: number | null;
      hi: number | null;
      median: number | null;
      samples: number;
      rotationFlips: { flips: number; of: number };
      gridFlips: { flips: number; of: number };
    };
    tauPosition: {
      value: number | null;
      lo: number | null;
      hi: number | null;
      median: number | null;
      samples: number;
    };
    levels: {
      label: string;
      cases: number;
      dGridMm: Spread;
      gridFlips: number;
      rotationFlips: number;
    }[];
  };
  rescore: { cells: ReturnType<typeof summariseCell>[] };
  lateness: {
    cells: ReturnType<typeof summariseCell>[];
    aimed: {
      vsyncOff: {
        firstTouchedMs: number | null;
        onePercentMs: number | null;
        bracketMs: [number | null, number] | null;
      };
      vsyncOn: { firstTouchedMs: number | null; onePercentMs: number | null };
      threshold: {
        aimBandS: number[];
        steps: number;
        driftPpm: number;
        matchedClocksMs: number | null;
        fastCameraMs: number | null;
      };
    };
  };
};

/**
 * The verdict, assembled from the document's own cells and nothing else: every
 * number in it is read through {@link at}, so a document without one stops the
 * sentence instead of printing it with a hole.
 *
 * The wording is the first full run's verification's, clause by clause, so the
 * sentence says only what its cells hold. Where it clarifies the spec's §7
 * template: the clean positions are read by the page's reader and by the one it
 * replaced, whose refusals are split by where they stopped; the crossings
 * are named as forward percentiles from the noiseless predictor, with their
 * range and the backward figures beside them; the bias is one-signed in its
 * MEAN, with the per-pixel signs beside it; a straddle's median is set against
 * each null's median, with the 95th percentile quoted beside it and never in
 * its place; the headline names its start, timer and policy, splits the loud
 * captures by what the operator reads, and counts every capture that ends past
 * the gate; the lateness is labelled with where it came from, its parts add up
 * to its whole, and the aimed threshold is derived and bracketed.
 *
 * The re-run with the page's reader adds what that reader did with the same
 * straddled captures, set beside the counterfactual's: loud and silent, what
 * the loud were told, which captures the two readers class differently, and
 * across every cell the page read, its quiet drops and its misfiles.
 */
export function verdictStatement(doc: VerdictDoc): string {
  const pct = (x: number): string => `${(100 * x).toFixed(1)}`;
  // A share that is small and not nothing keeps its figures: 0.014% is not 0.0%.
  const pctSmall = (x: number): string =>
    x === 0 ? '0' : x < 0.001 ? (100 * x).toFixed(3) : x < 0.01 ? (100 * x).toFixed(2) : pct(x);
  const byId = <T extends { id: string }>(xs: readonly T[]): Record<string, T> =>
    Object.fromEntries(xs.map((x) => [x.id, x]));
  const byLabel = <T extends { label: string }>(xs: readonly T[]): Record<string, T> =>
    Object.fromEntries(xs.map((x) => [x.label, x]));
  const r1 = at(byId(doc.rescore.cells), 'R1');
  const r8 = at(byId(doc.rescore.cells), 'R8');
  const late = at(constant(doc, 'HEADLESS_LATENESS_MS') as Record<string, number>, 'hudTickOff');
  const aimed = at(byId(doc.lateness.cells), `L-aimed-${late}`);
  const q0 = doc.precondition.q0;
  const crossings = doc.gate.crossings;
  const vl = doc.decode.verdictLevel;
  const cells: Record<string, number | string> = {
    'q0.total': q0.total,
    'q0.placed': q0.page.placedPositions,
    'q0.unseen': q0.page.unseen,
    'q0.barely': q0.page.barelySeen,
    'q0.problemPositions': q0.page.positionsWithProblems,
    'replaced.placed': q0.replaced.placedPositions,
    minMargin: q0.replaced.minClassifyMargin,
    classify: q0.replaced.refusedAt.classify.positions,
    count: q0.replaced.refusedAt.count.positions,
    other: q0.replaced.refusedAt.other,
    projectors: constant(doc, 'PROJECTORS') as number,
    attributableRuns: crossings.attributableRuns,
    neverRefused: crossings.neverRefused?.forward ?? Number.NaN,
    neverBackward: crossings.neverRefused?.backward ?? Number.NaN,
    scannedTo: crossings.scannedTo,
    forwardN: crossings.forward.n,
    backwardN: crossings.backward.n,
    lowRuns: crossings.lowBackward.runs,
    ratio:
      doc.decode.curve.find((x) => x.direction === 'forward' && x.s === 0.1)?.ratioU.median ??
      Number.NaN,
    runLevels: doc.decode.forwardMeans.runLevels,
    nonNegU: doc.decode.forwardMeans.nonNegativeU,
    nonNegV: doc.decode.forwardMeans.nonNegativeV,
    grayFlips: doc.decode.grayFlipsBelowFiveNinths?.either ?? Number.NaN,
    highestDecoded: doc.decode.highestDecoded,
    runs06: vl.runs,
    pxU: vl.absMeanU.median ?? Number.NaN,
    pxV: vl.absMeanV.median ?? Number.NaN,
    p95V: vl.p95AbsV.max ?? Number.NaN,
    mm: vl.mmShift.median ?? Number.NaN,
    mmN: vl.mmShift.n,
    mmMin: vl.mmShift.min ?? Number.NaN,
    mmMax: vl.mmShift.max ?? Number.NaN,
    resX: PROJECTOR_RES.x,
    resY: PROJECTOR_RES.y,
  };
  const c = (key: string): number | string => at(cells, key);
  const num = (key: string): number => c(key) as number;
  const n = (key: string, digits = 2): string => num(key).toFixed(digits);
  const orNaN = (x: number | null | undefined): number =>
    x === null || x === undefined ? Number.NaN : x;

  // ----- the clean positions: the page's reader, then the reader it replaced
  const placed = num('q0.placed');
  const pageCells = [...doc.rescore.cells, ...doc.lateness.cells];
  const pageRan = pageCells.some((x) => x.page.status !== 'not run');
  if (placed === 0 && pageRan) {
    throw new Error(
      "experiment10: the page's reader placed no clean position, and a cell has a page column",
    );
  }
  let first =
    placed === 0
      ? `The page's reader placed none of the ${c('q0.total')} clean camera positions rendered ` +
        `from the card's three marks.`
      : `The page's reader placed a run in ${placed} of the ${c('q0.total')} clean camera ` +
        `positions rendered from the card's three marks, noting ${c('q0.unseen')} runs out of ` +
        `view and ${c('q0.barely')} barely seen` +
        (num('q0.problemPositions') === 0
          ? ` and refusing nothing.`
          : `, with a problem at ${c('q0.problemPositions')} of them.`);
  const replacedPlaced = num('replaced.placed');
  first +=
    replacedPlaced === 0
      ? ` The reader it replaced placed none of them:`
      : ` The reader it replaced placed a run in ${replacedPlaced} of them:`;
  if (num('classify') > 0) {
    cells.classifyMax = orNaN(q0.replaced.refusedAt.classify.maxMargin);
    first +=
      ` ${c('classify')} were refused at classify (margin at most ${n('classifyMax', 3)}, ` +
      `against ${c('minMargin')}).`;
  }
  if (num('count') > 0) {
    const m = q0.replaced.refusedAt.count.margin;
    const found = q0.replaced.refusedAt.count.runsFound;
    cells.countMin = orNaN(m.min);
    cells.countMax = orNaN(m.max);
    cells.foundMin = orNaN(found?.min);
    cells.foundMax = orNaN(found?.max);
    const margins =
      num('count') === 1
        ? `margin ${n('countMax', 3)}`
        : `margins ${n('countMin', 3)}-${n('countMax', 3)}`;
    const runsFound =
      num('foundMin') === num('foundMax')
        ? `${c('foundMin')}`
        : `${c('foundMin')}-${c('foundMax')}`;
    first +=
      ` ${num('classify') > 0 ? 'The other ' : ''}${c('count')} cleared classify (${margins}) ` +
      `but were refused at the run count, having found ${runsFound} of ${c('projectors')} ` +
      `projector runs.`;
  }
  if (num('other') > 0) first += ` ${c('other')} were refused for other reasons.`;
  if (num('classify') + num('count') + num('other') === 0) first += ` it refused none.`;
  first += pageRan
    ? ` The rescoring put every straddled position of those rigs through the page's reader as well.`
    : ` So no straddled capture was put through the page's reader.`;

  // ----- the re-run's bets, as the document evaluates them: held, falsified or not evaluated
  const bets = byId(doc.predictions);
  const outcome = (id: string, falsifies: string, holds: string): string => {
    const falsified = at(bets, id).falsified;
    return falsified === true ? falsifies : falsified === false ? holds : `${id} is not evaluated`;
  };
  {
    const p13 = at(bets, 'P13').measured as { compared?: number; differ?: number } | null;
    cells.p13Compared = p13?.compared ?? Number.NaN;
    cells.p13Differ = p13?.differ ?? Number.NaN;
    if (num('p13Compared') > 0) {
      first +=
        ` Each camera's clean twin, which the rescoring attributes against, reads as Q0 does` +
        (num('p13Differ') === 0
          ? ` at all ${c('p13Compared')} positions, ${outcome('P13', 'which falsifies P13', 'so P13 holds')}.`
          : ` at all but ${c('p13Differ')} of the ${c('p13Compared')} positions, ` +
            `${outcome('P13', 'which falsifies P13', 'so P13 holds')}.`);
    }
  }

  // ----- where the complement check refuses a straddle
  const never = num('neverRefused');
  const runs = num('attributableRuns');
  let crossing: string;
  if (never > 0 && never === runs) {
    crossing =
      ` Handed every frame's kind (the counterfactual reader), the complement check refused none ` +
      `of the ${runs} attributable runs of a whole-position straddle at any smear up to ` +
      `s = ${c('scannedTo')}. `;
  } else {
    cells.p10 = orNaN(crossings.forward.p10);
    cells.p50 = orNaN(crossings.forward.median);
    cells.p90 = orNaN(crossings.forward.p90);
    cells.fMin = orNaN(crossings.forward.min);
    cells.fMax = orNaN(crossings.forward.max);
    const over = num('forwardN') === runs ? `all ${runs}` : `${c('forwardN')} of the ${runs}`;
    crossing =
      ` Handed every frame's kind (the counterfactual reader), the complement check first ` +
      `refuses a ` +
      `forward whole-position straddle at between ${pct(num('p10'))}% and ${pct(num('p90'))}% ` +
      `of the exposure, depending on the run. These are the 10th and 90th percentiles over ` +
      `${over} attributable runs, from ` +
      `the noiseless linear predictor: median ${pct(num('p50'))}%, full range ` +
      `${pct(num('fMin'))}-${pct(num('fMax'))}%` +
      (never > 0
        ? `; ${never} of the ${runs} attributable runs were never refused up to ` +
          `s = ${c('scannedTo')}, and are not in those figures. `
        : `. `);
    if (num('backwardN') > 0) {
      cells.b10 = orNaN(crossings.backward.p10);
      cells.b50 = orNaN(crossings.backward.median);
      cells.b90 = orNaN(crossings.backward.p90);
      crossing +=
        `A backward straddle is first refused at between ${pct(num('b10'))}% and ` +
        `${pct(num('b90'))}% (median ${pct(num('b50'))}%)`;
      if (num('neverBackward') > 0)
        crossing += `, and ${c('neverBackward')} runs were never refused backward`;
      if (num('lowRuns') > 0) {
        cells.lowBelow = crossings.lowBackward.below;
        cells.lowLit = orNaN(crossings.lowBackward.maxLit);
        cells.lowest = orNaN(crossings.lowBackward.lowest);
        crossing +=
          `; ${c('lowRuns')} runs, each lighting at most ${pct(num('lowLit'))}% of the ` +
          `photograph, are refused below ${pct(num('lowBelow'))}% backward, the lowest at ` +
          `${(100 * num('lowest')).toFixed(2)}%`;
      }
      crossing += '. ';
    }
  }

  // ----- what passes: Gray words, then the phase bias
  const ratio = num('ratio');
  const toward = ratio < 0 ? 'lower' : 'higher';
  const flips = num('grayFlips');
  let bias =
    flips === 0
      ? `What it lets through keeps its Gray words: at every smear decoded, up to s = ` +
        `${c('highestDecoded')}, no pixel both decodes accept changed its Gray address. `
      : `What it lets through changes ${flips} Gray words below s = 5/9 on pixels both ` +
        `decodes accept. `;
  const oneSigned = num('nonNegU') + num('nonNegV') === 0;
  bias +=
    `It carries a phase bias whose mean is one-signed: about ${Math.abs(ratio).toFixed(2)} of ` +
    `atan2(s, 1−s)·P/2π, toward ${toward} projector coordinates for a forward straddle` +
    (oneSigned
      ? `, and every run's mean Δu and mean Δv is negative at every forward smear decoded.`
      : `; ${num('nonNegU') + num('nonNegV')} run-level means of the ${c('runLevels')} ` +
        `per axis are not negative.`) +
    ` At s = ${VERDICT_S} that is ${n('pxU')} px along u and ${n('pxV')} px along v at the ` +
    `${c('resX')}×${c('resY')} raster, the medians over ${c('runs06')} runs of each run's mean.`;
  if (vl.signs !== null) {
    const { seam, rest, all } = vl.signs;
    cells.uPos = all.uPos;
    cells.uPosShare = orNaN(all.uPosShare);
    cells.seamPixels = seam.pixels;
    cells.seamVPos = orNaN(seam.vPosShare);
    cells.restPixels = rest.pixels;
    cells.restVPos = orNaN(rest.vPosShare);
    cells.maxAbsV = all.maxAbsV;
    bias +=
      ` Per pixel, ` +
      (num('uPos') === 0
        ? `no pixel moves positive along u`
        : `${pctSmall(num('uPosShare'))}% of pixels move positive along u`) +
      (num('seamPixels') > 0
        ? `; along v, ${pctSmall(num('seamVPos'))}% of the ${c('seamPixels')} pixels where the ` +
          `next projector also lights move positive, against ${pctSmall(num('restVPos'))}% of ` +
          `the ${c('restPixels')} others`
        : `; along v, ${pctSmall(num('restVPos'))}% of pixels move positive`) +
      `, and |Δv| reaches ${n('maxAbsV')} px against the ${n('pxV')} px mean (the largest ` +
      `run's 95th percentile is ${n('p95V')} px).`;
  }
  bias +=
    ` On the sphere, a median ${n('mm')} mm counting both axes: the median of ${c('mmN')} ` +
    `per-run medians, which span ${n('mmMin')}-${n('mmMax')} mm.`;

  // ----- what that does to a solve, against both re-shoots
  let pose: string;
  if (doc.pose.solved) {
    const at06 = at(byLabel(doc.pose.levels), `forward/${VERDICT_S}`);
    const whole = doc.pose.tauNull;
    const position = doc.pose.tauPosition;
    Object.assign(cells, {
      d06: orNaN(at06.dGridMm.median),
      n06: at06.dGridMm.n,
      cases06: at06.cases,
      min06: orNaN(at06.dGridMm.min),
      max06: orNaN(at06.dGridMm.max),
      flips06: at06.gridFlips,
      rot06: at06.rotationFlips,
      nullRot: whole.rotationFlips.flips,
      nullRotOf: whole.rotationFlips.of,
      nullGrid: whole.gridFlips.flips,
      nullGridOf: whole.gridFlips.of,
      wholeMedian: orNaN(whole.median),
      tau: orNaN(whole.value),
      tauLo: orNaN(whole.lo),
      tauHi: orNaN(whole.hi),
      posMedian: orNaN(position.median),
      posTau: orNaN(position.value),
      posLo: orNaN(position.lo),
      posHi: orNaN(position.hi),
    });
    pose =
      ` Solved through the bench, a forward straddle at s = ${VERDICT_S} moves the worst seam ` +
      `point by a median ${n('d06')} mm over ${c('n06')} designed rigs (range ${n('min06')}-` +
      `${n('max06')} mm). The ${GRID_GATE_MM} mm seam gate flips in ${c('flips06')} of ` +
      `${c('cases06')} and the ${ROTATION_GATE_DEG}° rotation gate in ${c('rot06')}; clean ` +
      `whole-capture re-shoots flip them in ${c('nullGrid')} of ${c('nullGridOf')} and ` +
      `${c('nullRot')} of ${c('nullRotOf')}. That is ` +
      `${(num('d06') / num('wholeMedian')).toFixed(1)} times the median ${n('wholeMedian')} mm ` +
      `by which re-shooting the whole capture moves it (95th percentile ${n('tau')} mm, 95% CI ` +
      `${n('tauLo')}-${n('tauHi')}), and ${(num('d06') / num('posMedian')).toFixed(1)} times ` +
      `the median ${n('posMedian')} mm by which re-shooting only the straddled position moves ` +
      `it (95th percentile ${n('posTau')} mm, 95% CI ${n('posLo')}-${n('posHi')}).`;
  } else {
    pose = ` This run solved nothing, so what that does to the seams is not measured here.`;
  }

  // ----- EXPERIMENT-9's headline, re-scored
  {
    const k = r1.classes.P.counts;
    const silentOf = (x: Record<string, number>): number =>
      SILENT_CLASSES.reduce((a, name) => a + (x[name] ?? 0), 0);
    // The folders an operator following 'Re-shoot projector N' can end up with:
    // the re-shot run kept beside the others (the card says keep both), or alone.
    const reshot = doc.precondition.q0b.filter((x) =>
      / re-shot (and appended|alone)$/.test(x.shape),
    );
    Object.assign(cells, {
      touched: r1.capturesFlagged,
      recorded: r1.capturesRecorded,
      dwell: constant(doc, 'DWELL_S') as number,
      exposureDen: Math.round(1 / r1.spec.exposureS),
      loud: k.LOUD,
      runByRun: r1.loud.runByRun,
      reshootNamed: r1.loud.reshootNamed,
      dropDup: r1.loud.dropAndDuplicate,
      wholeOnly: r1.loud.wholePositionOnly,
      reshotFolders: reshot.reduce((a, x) => a + x.positions, 0),
      reshotRefused: reshot.reduce((a, x) => a + x.wholeRefused, 0),
      loudSilent: k['LOUD+SILENT'],
      silent: silentOf(k),
      unsolved: k['SILENT-UNSOLVED'],
      unjudgeable: k['SILENT-UNJUDGEABLE'],
      invisible: k['INVISIBLE-ONLY'],
      unchanged: k.UNCHANGED,
      r8: r8.capturesRecorded,
      r8Trials: r8.trials,
    });
  }
  const recordedNote =
    c('recorded') !== c('touched')
      ? ` (${c('recorded')} with any photograph changed or flagged)`
      : '';
  let headline =
    ` Of EXPERIMENT-9's ${c('touched')} touched captures at the page's defaults ` +
    `(${c('dwell')} s dwell, 1/${c('exposureDen')} s exposure), with an un-aimed (uniform) ` +
    `start, under its perfect-timer model and policy P (a refused position is re-shot whole, ` +
    `and the re-shoot is assumed clean)${recordedNote}, the counterfactual reader refuses ` +
    `${c('loud')} ` +
    `loudly: ${c('runByRun')} run by run, ` +
    (num('reshootNamed') === num('runByRun') ? '' : `${c('reshootNamed')} of them `) +
    `with 'Re-shoot projector N'` +
    (num('dropDup') > 0 ? ` (${c('dropDup')} blaming a dropped and a duplicated frame)` : '') +
    `, a remedy that produces a folder the counterfactual reader refuses whole` +
    (num('reshotFolders') > 0
      ? ` (${c('reshotRefused')} of ${c('reshotFolders')} such folders in Q0b, the re-shot run ` +
        `kept beside the others or alone)`
      : '') +
    `; and ${c('wholeOnly')} only as a whole position ('Found N projector runs …'), whose ` +
    `remedy, re-shooting the position, it can read.`;
  if (doc.pose.solved) {
    const against = r1.classes.P.silentAgainst;
    const tauAt = against.tau;
    if (tauAt === null) {
      throw new Error(
        "experiment10: the verdict needs cell 'silentAgainst.tau', and the document does not " +
          'have it',
      );
    }
    Object.assign(cells, {
      lsGate: r1.classes.P.solved.loudSilentHarm['GATE-BREAKING'],
      harmless: tauAt.HARMLESS,
      biased: tauAt.BIASED,
      gateSilent: tauAt['GATE-BREAKING'],
      judged: tauAt.judged,
      exceed: tauAt.exceedTau,
      harmlessAtLo: against.tauLo?.HARMLESS ?? Number.NaN,
      harmlessAtHi: against.tauHi?.HARMLESS ?? Number.NaN,
      harmlessAtPosition: against.positionTau?.HARMLESS ?? Number.NaN,
      pastGate: r1.classes.P.pastGate.total,
    });
    const across =
      num('harmlessAtLo') === num('harmlessAtHi')
        ? `${c('harmlessAtLo')}`
        : `${c('harmlessAtLo')}-${c('harmlessAtHi')}`;
    headline +=
      ` ${c('loudSilent')} of the loud captures also carry a silent position` +
      (num('loudSilent') > 0
        ? `, and in ${c('lsGate')} of those the seams still end past the ${GRID_GATE_MM} mm ` +
          `gate after the refused positions are re-shot clean.`
        : '.') +
      ` ${c('silent')} pass silently: ${c('harmless')} ` +
      `keep the gate and move the worst seam point no further than 95% of whole-capture re-shoots do ` +
      `(${across} across τ's 95% CI, and ${c('harmlessAtPosition')} against the one-position ` +
      `re-shoot), ${c('biased')} move it further without breaking the gate, and ` +
      `${c('gateSilent')} break it` +
      (num('unjudgeable') > 0 ? `; ${c('unjudgeable')} cannot be judged from their solves` : '') +
      (num('unsolved') > 0 ? `; ${c('unsolved')} were not solved` : '') +
      `. In all, ${c('pastGate')} of the ${c('touched')} end past the gate under policy P, and ` +
      `${c('exceed')} of the ${c('judged')} silent captures judged move the seams further than τ.`;
  } else {
    // A position count, not a solve: said whether or not anything was solved,
    // as 379bb2f's verdict said it.
    headline +=
      ` ${c('loudSilent')} of the loud captures also carry a silent position. ` +
      `${c('silent')} pass silently (not solved in this run).`;
  }
  headline +=
    ` ${c('invisible')} touched only runs that the counterfactual reader also refuses on the ` +
    `clean capture; ${c('unchanged')} changed no photograph. With the card's aimed start and a ` +
    `perfect timer, ${c('r8')} of ${c('r8Trials')} captures are touched (R8).`;

  // ----- the same captures through the page's own reader
  const silentOf = (x: Record<string, number>): number =>
    SILENT_CLASSES.reduce((a, name) => a + (x[name] ?? 0), 0);
  let pageClause: string;
  if (r1.page.status === 'not run') {
    pageClause =
      ` The page's own reader read none of these captures: the page column did not run on ` +
      `R1's rigs.`;
  } else {
    const pg = r1.page;
    const k = pg.classes.P.counts;
    const vs = pg.classes.P.vsCounterfactual;
    Object.assign(cells, {
      pRead: pg.read.captures,
      pLoud: k.LOUD,
      pRunByRun: pg.loud.runByRun,
      pReshoot: pg.loud.reshootNamed,
      pWhole: pg.loud.wholePositionOnly,
      pLoudSilent: k['LOUD+SILENT'],
      pLoudQuiet: k['LOUD+QUIET'],
      pSilent: silentOf(k),
      pSilentQuiet: pg.quiet.silentWithQuiet,
      pQuiet: k.QUIET,
      pQuietPlacing: pg.quiet.quietPlacingTouched,
      pHarmless: k['SILENT-HARMLESS'],
      pBiased: k['SILENT-BIASED'],
      pGate: k['SILENT-GATE-BREAKING'],
      pUnjudgeable: k['SILENT-UNJUDGEABLE'],
      pUnsolved: k['SILENT-UNSOLVED'],
      pInvisible: k['INVISIBLE-ONLY'],
      pUnchanged: k.UNCHANGED,
      loudToSilent: vs.LOUD?.SILENT ?? Number.NaN,
      loudToQuiet: vs.LOUD?.QUIET ?? Number.NaN,
      silentToLoud: vs.SILENT?.LOUD ?? Number.NaN,
    });
    pageClause =
      ` Through the page's own reader, each run attributed against its reading of the same ` +
      `clean frames, the ${c('pRead')} captures come out ${c('pLoud')} loud (${c('pRunByRun')} ` +
      `run by run, ` +
      (num('pReshoot') === num('pRunByRun') ? '' : `${c('pReshoot')} of them `) +
      `told 'Re-shoot projector N', and ${c('pWhole')} only as a whole position; ` +
      `${c('pLoudSilent')} of them also carrying a silent position` +
      (num('pLoudQuiet') > 0 ? ` and ${c('pLoudQuiet')} a quiet one` : '') +
      `), ${c('pSilent')} silent (` +
      (doc.pose.solved
        ? `${c('pHarmless')} harmless, ${c('pBiased')} biased and ${c('pGate')} past the ` +
          `gate by a counterfactual solve of the same plan` +
          (num('pUnjudgeable') > 0 ? `, ${c('pUnjudgeable')} unjudgeable` : '') +
          `, and ${c('pUnsolved')} not solved`
        : `not solved in this run`) +
      (num('pSilentQuiet') > 0 ? `; ${c('pSilentQuiet')} of them with a quiet position too` : '') +
      `) and ${c('pQuiet')} quiet: a touched run its clean reading places only noted, and no ` +
      `position refused or placed; ${c('pInvisible')} touch only runs its clean reading does ` +
      `not place, and ${c('pUnchanged')} changed no photograph.` +
      (num('pQuietPlacing') > 0
        ? ` In ${c('pQuietPlacing')} of the captures with no position placed, a quiet position ` +
          `still places another touched run, which reaches the calibration straddled and no ` +
          `class counts.`
        : '') +
      ` Of the counterfactual reader's ${c('loud')} loud captures the page passes ` +
      `${c('loudToSilent')} silently` +
      (num('loudToQuiet') > 0 ? ` and ${c('loudToQuiet')} quietly` : '') +
      `, and of its ${c('silent')} silent ones the page refuses ${c('silentToLoud')} loudly.`;
    // P11, on the registered SILENT, with the looser reading beside it and
    // never in its place. What it counts is the clause's own cells, held to
    // what the document evaluated the bet on.
    const p11 = at(bets, 'P11').measured as {
      silent?: number;
      counterfactualSilent?: number;
      quietCountedAsKept?: { silent?: number };
    } | null;
    cells.p11Silent = p11?.silent ?? Number.NaN;
    cells.p11Counterfactual = p11?.counterfactualSilent ?? Number.NaN;
    cells.p11Looser = p11?.quietCountedAsKept?.silent ?? Number.NaN;
    if (num('p11Silent') !== num('pSilent') || num('p11Counterfactual') !== num('silent')) {
      throw new Error("experiment10: P11's measured silent counts are not R1's, which the verdict quotes");
    }
    const more = num('pSilent') - num('silent');
    pageClause +=
      ` The page's ${c('pSilent')} silent captures are ` +
      (more === 1
        ? 'one more than'
        : more > 1
          ? `${more} more than`
          : more === 0
            ? 'as many as'
            : `${-more} fewer than`) +
      ` the counterfactual reader's ${c('silent')}, ` +
      outcome('P11', 'which falsifies P11', 'so P11 holds') +
      (num('pQuiet') === 0
        ? `; none is quiet, so counting a quiet capture as kept gives ${c('p11Looser')} too.`
        : `; counting its ${c('pQuiet')} quiet captures as kept, a reading beside the ` +
          `registration's and not in its place, gives ${c('p11Looser')}.`);
  }
  // ----- across every cell the page read: its quiet drops (P12) and its misfiles (P10)
  const withCaptures = pageCells.filter((x) => x.page.status === 'read');
  if (pageCells.some((x) => x.page.status !== 'not run')) {
    const pageOf = (x: (typeof pageCells)[number]) => {
      if (x.page.status !== 'read') throw new Error(`experiment10: ${x.id} has no page reading`);
      return x.page;
    };
    Object.assign(cells, {
      cellsRead: withCaptures.length,
      allQuiet: withCaptures.reduce((a, x) => a + pageOf(x).quiet.runs, 0),
      allMisfiled: withCaptures.reduce((a, x) => a + pageOf(x).misfiles.photographs, 0),
      allMisfiledPositions: withCaptures.reduce((a, x) => a + pageOf(x).misfiles.positions, 0),
    });
    const p12 = at(bets, 'P12').measured as { runs?: number } | null;
    const p10 = at(bets, 'P10').measured as { photographs?: number; positions?: number } | null;
    cells.p12Runs = p12?.runs ?? Number.NaN;
    cells.p10Photographs = p10?.photographs ?? Number.NaN;
    cells.p10Positions = p10?.positions ?? Number.NaN;
    if (num('p12Runs') !== num('allQuiet')) {
      throw new Error("experiment10: P12's quiet drops are not the cells' own, which the verdict quotes");
    }
    if (num('p10Photographs') !== num('allMisfiled') || num('p10Positions') !== num('allMisfiledPositions')) {
      throw new Error("experiment10: P10's misfiles are not the cells' own, which the verdict quotes");
    }
    // Each cell with a quiet drop, the most first.
    const quietCells = withCaptures
      .filter((x) => pageOf(x).quiet.runs > 0)
      .sort((a, b) => pageOf(b).quiet.runs - pageOf(a).quiet.runs);
    for (const x of quietCells) cells[`quiet:${x.id}`] = pageOf(x).quiet.runs;
    const listed = quietCells.map((x) => `${c(`quiet:${x.id}`)} in ${x.id}`);
    pageClause +=
      ` Across the ${c('cellsRead')} rescore and lateness cells with a touched capture to read, ` +
      (num('allQuiet') === 0
        ? `the page quietly drops none of the runs its clean reading places, `
        : `the page quietly drops ${c('allQuiet')} runs its clean reading places, noting them ` +
          `out of view or barely seen with no problem naming them ` +
          `(${listed.length === 1 ? listed[0] : `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`}), `) +
      `${outcome('P12', 'which falsifies P12', 'so P12 holds')}.`;
    // Each cell with a misfile, the most first: a near-tie cell says so, and
    // any other counts its misfiles at the near-tie share or more, so a
    // photograph of another step placed in a run never reads as a tie.
    const misCells = withCaptures
      .filter((x) => pageOf(x).misfiles.photographs > 0)
      .sort((a, b) => pageOf(b).misfiles.photographs - pageOf(a).misfiles.photographs);
    const phrases = misCells.map((x) => {
      const m = pageOf(x).misfiles;
      const key = (k: string) => `misfiles:${x.id}:${k}`;
      Object.assign(cells, {
        [key('n')]: m.photographs,
        [key('positions')]: m.positions,
        [key('lo')]: orNaN(m.share.min),
        [key('hi')]: orNaN(m.share.max),
        [key('atLeast')]: m.histogram
          .filter((b) => b.from >= NEAR_TIE_SHARE)
          .reduce((a, b) => a + b.n, 0),
      });
      const count = num(key('n'));
      const range =
        num(key('lo')) === num(key('hi'))
          ? n(key('lo'), 3)
          : `${n(key('lo'), 3)}-${n(key('hi'), 3)}`;
      const where = num(key('positions')) === count ? '' : ` in ${c(key('positions'))} positions`;
      // Which way each was filed from the step it mostly shows, where the cell lists them.
      const off =
        m.list === null || m.list.length === 0
          ? []
          : [...new Set(m.list.map((y) => y.filedStep - y.contentStep))].sort((a, b) => a - b);
      const filed =
        off.length === 0
          ? ''
          : off.join() === '1'
            ? ' filed one step after it'
            : off.join() === '-1'
              ? ' filed one step before it'
              : off.join() === '-1,1'
                ? ' filed one step before or after it'
                : ` filed up to ${Math.max(...off.map(Math.abs))} steps from it`;
      if (num(key('hi')) < NEAR_TIE_SHARE) {
        return count === 1
          ? `in ${x.id}, 1, a near-tie (${range})${filed}`
          : `in ${x.id}, ${count}${where}, each a near-tie (that step's share ${range})${filed}`;
      }
      return (
        `in ${x.id} (${x.spec.arm}), ${count}${where}, that step's share ${range} and ` +
        `${c(key('atLeast'))} of them at ${NEAR_TIE_SHARE} or more,${filed}: runs placed holding a ` +
        `photograph of another step`
      );
    });
    pageClause +=
      ` Its placed runs file ` +
      (num('allMisfiled') === 0
        ? `every photograph under the step holding more than half its exposure, `
        : `${c('allMisfiled')} photographs, in ${c('allMisfiledPositions')} positions, under a step ` +
          `other than the one holding more than half their exposure, `) +
      outcome('P10', 'which falsifies P10', 'so P10 holds') +
      (phrases.length === 0
        ? '.'
        : `: ${phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join('; ')}; and ${phrases[phrases.length - 1]}`}.`);
  }

  // ----- a late emitter against the aimed rule
  {
    const k = aimed.classes.P.counts;
    const threshold = doc.lateness.aimed.threshold;
    const off = doc.lateness.aimed.vsyncOff;
    Object.assign(cells, {
      late: aimed.spec.lateMs,
      armed: at(constant(doc, 'HEADLESS_LATENESS_MS') as Record<string, number>, 'armedTickOn'),
      aimedTouched: aimed.capturesRecorded,
      aimedTrials: aimed.trials,
      aimedLoud: k.LOUD,
      aimedLoudSilent: k['LOUD+SILENT'],
      aimedSilent: silentOf(k),
      aimedSolved: silentOf(k) - k['SILENT-UNSOLVED'],
      aimedGate: k['SILENT-GATE-BREAKING'],
      aimedInvisible: k['INVISIBLE-ONLY'],
      bandLo: nth(threshold.aimBandS, 0),
      steps: threshold.steps,
      ppm: threshold.driftPpm,
      thrMatched: orNaN(threshold.matchedClocksMs),
      thrFast: orNaN(threshold.fastCameraMs),
    });
    let lateSentence =
      ` If the emitter runs ${c('late')} ms late per step, ${c('aimedTouched')} of ` +
      `${c('aimedTrials')} captures started by the card's aimed rule are touched: ` +
      `${c('aimedLoud')} loud, ${c('aimedLoudSilent')} of them also carrying a silent ` +
      `position; ${c('aimedSilent')} silent, ${c('aimedSolved')} of them solved and ` +
      `${c('aimedGate')} of those past the seam gate; and ${c('aimedInvisible')} touching only ` +
      `runs that are refused anyway.`;
    if (aimed.page.status !== 'not run') {
      const pk = aimed.page.classes.P.counts;
      Object.assign(cells, {
        aimedPageRead: aimed.page.read.captures,
        aimedPageLoud: pk.LOUD,
        aimedPageSilent: silentOf(pk),
        aimedPageQuiet: pk.QUIET,
      });
      lateSentence +=
        ` Through the page's own reader the same ${c('aimedPageRead')} captures are ` +
        `${c('aimedPageLoud')} loud` +
        (num('aimedPageQuiet') > 0
          ? `, ${c('aimedPageSilent')} silent and ${c('aimedPageQuiet')} quiet.`
          : ` and ${c('aimedPageSilent')} silent.`);
    }
    lateSentence +=
      ` ${c('late')} ms is the mean of a design-time probe in a ` +
      `headless, software-rendered (SwiftShader) browser in HUD mode with the tick off; armed ` +
      `with the tick on, the same setup ran about ${c('armed')} ms late. This experiment did ` +
      `not re-measure it, and the display machine's lateness is unmeasured. The aimed rule's ` +
      `margin is the lower edge of its modelled aim band, ${c('bandLo')} s spread over ` +
      `${c('steps')} steps: about ${n('thrMatched')} ms per step with matched clocks, and ` +
      `${n('thrFast')} ms for the half of captures whose camera clock runs ${c('ppm')} ppm fast.`;
    if (off.onePercentMs === null) {
      lateSentence += ` No lateness swept touched 1% of aimed captures.`;
    } else {
      cells.firstMs = orNaN(off.firstTouchedMs);
      cells.onePctMs = off.onePercentMs;
      const below = off.bracketMs?.[0] ?? null;
      lateSentence +=
        ` On the swept grid the first aimed capture is touched at ${c('firstMs')} ms, and 1% ` +
        `are touched from ${c('onePctMs')} ms`;
      if (below === null) {
        lateSentence += `, the smallest lateness swept`;
      } else {
        cells.belowMs = below;
        lateSentence += `, a crossing the sweep finds in (${c('belowMs')}, ${c('onePctMs')}] ms`;
      }
      const on = doc.lateness.aimed.vsyncOn;
      if (on.onePercentMs !== null) {
        cells.firstMsV = orNaN(on.firstTouchedMs);
        cells.onePctMsV = on.onePercentMs;
        cells.vsyncHz = Math.round(1 / (constant(doc, 'VSYNC_S') as number));
        lateSentence +=
          `; with a ${c('vsyncHz')} Hz refresh wait, ${c('firstMsV')} and ${c('onePctMsV')} ms`;
      }
      lateSentence += '.';
    }
    return first + crossing + bias + pose + headline + pageClause + lateSentence;
  }
}
