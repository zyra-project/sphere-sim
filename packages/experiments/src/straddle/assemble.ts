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


import { deriveSeed, makeBenchRng } from '../../../bench/src/random.ts';
import { COMPLEMENT_LIMIT, MIN_CLASSIFY_MARGIN } from '../../../solver/src/indexing.ts';
import {
  ENCODE_BOUNDS,
  EXP10_ROOT_SEED,
  EXPECTED,
  EXPOSURE_S,
  GATE_SCAN,
  GRID_GATE_MM,
  PERIOD_PX,
  PROJECTORS,
  PROJECTOR_RES,
  READOUT_S,
  REFINE_MARGIN,
  ROTATION_GATE_DEG,
} from './design.ts';
import { classifyCapture, classifyPosition, type CaptureClass, type Harm } from './run.ts';
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
  round,
  twinStatus,
  variantOf,
  type BankUnit,
  type CaptureScore,
  type CellSpec,
  type DecodeUnit,
  type Exp10Plan,
  type GateUnit,
  type HalfStats,
  type PoseUnit,
  type Q0Unit,
  type RescoreUnit,
  type RunContext,
  type RunScore,
  type SolveRecord,
  type StageFile,
  type StageName,
  type TwinCamera,
  type Which,
} from './stages.ts';

export const SCHEMA = 'sphere-sim/experiment-10@1';

/**
 * The refine band's diagnostic bar: the refined verdict agrees with the fully noisy one on at
 * least this share of R1's touched runs.
 */
export const REFINE_AGREEMENT = 0.98;

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
  /**
   * Under P: solved captures whose P plan is A's, so their P solve is A's
   * (`CaptureSolve.pIsA`). Every solved P capture of a cell that solves under A
   * alone is one of these.
   */
  sameSolveAsA: number;
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
        counts[categoryOf(pos, footing, twinOf(cap.rig, pos.pos), excl)]++;
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
        sameSolveAsA: 0,
      },
    };
    for (const name of CLASS_ORDER) out.byClass[name] = 0;
    for (const cap of captures) {
      if (!keep(cap)) continue;
      const cats = cap.positions.map((pos) =>
        categoryOf(pos, 'content', twinOf(cap.rig, pos.pos), false),
      );
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
        if (policy === 'P' && solve?.pIsA === true) s.sameSolveAsA++;
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
    sameSolveAsA: s.sameSolveAsA,
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
      // How far the scan looked: a run with no crossing was placed at every
      // smear up to here.
      scannedTo: GATE_SCAN.max,
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
  const tauValue = plan.pose ? tau.value : null;
  const rescoreDoc = {
    audit: (rescore.units.audit?.audit ?? []).map((a) => ({ ...a })),
    refine: refineDiagnostic(ev),
    cells: rescoreCells(plan).map((cell) => summariseCell(ev, cell, rescore, tauValue)),
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
    cells: latenessCells(plan).map((cell) => summariseCell(ev, cell, lateness, tauValue)),
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
      // The code that wrote this document from those checkpoints, which the
      // checkpoint fingerprint deliberately leaves out (stages.ts's header).
      assemblyFingerprint: assemblyFingerprint(),
      staleCheckpointsAccepted: ctx.staleAccepted,
      design: designConstants(plan),
      refineBand: REFINE_CEILING,
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
  pose:
    "Pose cost is the bench solver's. The page never solves, and its worth report cannot see a " +
    'straddle (precondition.q0.worth).',
};

export type VerdictDoc = {
  mode: string;
  precondition: { q0: { total: number; placedPositions: number; maxMargin: number | null } };
  gate: {
    crossings: {
      forward: { p10: number | null; median: number | null; p90: number | null };
      attributableRuns: number;
      scannedTo: number;
      neverRefused: { forward: number };
    };
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
 * template is the spec's §7 with three changes, each so the sentence stays true
 * whatever the cells say. The first clause is chosen by whether any clean
 * position was placed. The crossing figures name the runs the scan never
 * refused, which they cannot include. The headline counts every class, so its
 * parts add up to its whole. Without solves (a quick run) the pose clauses say
 * so.
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
    attributableRuns: doc.gate.crossings.attributableRuns ?? Number.NaN,
    neverRefused: doc.gate.crossings.neverRefused?.forward ?? Number.NaN,
    scannedTo: doc.gate.crossings.scannedTo ?? Number.NaN,
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
  // The crossing figures are percentiles over the runs the scan refused. A run
  // it never refused has no crossing to put in them, so it would drop out of
  // the sentence and the figures would read as every run's. The count is read
  // through `at` every time, not only when it is not zero, so a document
  // without it stops the sentence like any other missing cell. Where no run
  // was refused at all there are no figures to quote, and the sentence says so.
  const never = c('neverRefused') as number;
  const runs = c('attributableRuns') as number;
  const crossing =
    never > 0 && never === runs
      ? ` Given a reader whose bookends can place runs, the complement check refused none ` +
        `of the ${runs} attributable runs of a whole-position straddle at any smear up to ` +
        `s = ${c('scannedTo')}. `
      : ` Given a reader whose bookends can place runs, the complement check refuses a ` +
        `whole-position straddle run by run, from ${pct(c('p10') as number)}% to ` +
        `${pct(c('p90') as number)}% of the exposure (median ${pct(c('p50') as number)}%)` +
        (never > 0
          ? `; ${never} of the ${runs} attributable runs were never refused up to ` +
            `s = ${c('scannedTo')}, and are not in those figures. `
          : `. `);
  const second =
    crossing +
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
