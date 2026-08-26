// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The Phase 1 round runner.
 *
 *     node packages/bench/src/loop.ts            # next round, fresh seed
 *     node packages/bench/src/loop.ts --seed S   # a named round, reproducible
 *     node packages/bench/src/loop.ts --replay 3 # re-run round 3 exactly
 *
 * docs/ARCHITECTURE.md defines the protocol this implements, and two parts of
 * it are easy to get subtly wrong.
 *
 * ## Fresh seeds, and reproducible ones
 *
 * "Scenarios regenerate with fresh seeds every round. A piece that improves on
 * round n's seeds and regresses on round n+1's did not improve; it overfit."
 * And, from the bench's own requirements, a specific scenario has to be
 * reproducible exactly so a before/after pair can be rendered from the same seed
 * and the same camera.
 *
 * Wall-clock entropy satisfies the first and destroys the second. A chain
 * satisfies both: round N's seed is `splitmix(round 0's seed, N)`, which is
 * decorrelated from round N-1's — the builder cannot overfit to it because it
 * has not been seen — and is a pure function of the history, so any round can be
 * replayed by number. The chain root is stored in the history file, so a fresh
 * clone reproduces the whole series. `--seed` overrides for a one-off, and the
 * seed actually used is recorded either way.
 *
 * ## Stopping, defined rather than eyeballed
 *
 * "A round is non-improving when no gate-facing metric's round-over-round
 * change exceeds its own run-to-run dispersion across seeds. Three consecutive
 * non-improving rounds ends Phase 1."
 *
 * The comparison is between MEDIANS, not means — a mean hides the bimodal
 * failure docs/ARCHITECTURE.md's G2 signature describes. A metric that got WORSE
 * by more than its bar is a regression rather than a non-improvement, so it is
 * reported as such and does not count toward the three.
 *
 * ## The bar, and why this file used to compute the wrong one
 *
 * "Run-to-run dispersion across seeds" means: hold the code still, change only
 * the seed, and see how far the number wanders. That is the noise floor a
 * round-over-round change has to clear to be evidence of anything.
 *
 * This file used to use half the interquartile range of ONE round's values
 * ACROSS SCENARIOS, and called it the same thing. It is not the same thing. The
 * corpus is twelve deliberately heterogeneous archetypes — a canary rig beside a
 * two-projector install beside a long-throw one — so that IQR measures how much
 * archetypes differ from each other, which is a design choice, not measurement
 * noise. On a twelve-scenario corpus run it puts the bar for `grid_displacement`
 * at 2.52 mm when the gate itself is 1 mm: a round that took the headline geometric
 * gate from three and a half times its limit to exactly its limit registered as
 * 'flat'.
 *
 * It was not a near miss. Across all five rounds this project has run, every
 * tracked metric came back 'flat', `improved` and `regressed` were empty every
 * time, and `consecutiveNonImproving` marched 1, 2, 3, 4, 5 — while PHASE-1.md
 * records round 3 taking grid displacement from 18.9 mm to 4.9 mm and rotation
 * from 7.06 to 0.31 degrees. The rule never registered motion in either
 * direction, and still accumulated evidence that Phase 1 was finished.
 *
 * So the bar is no longer invented. `dispersion` is the measured across-seed
 * figure when one has been supplied and `NaN` when it has not, the scenario
 * scatter keeps its own name (`scatterAcrossScenarios`) because it is genuinely
 * informative about the corpus, and a round the loop cannot qualify is reported
 * `unqualified` rather than `flat`. An unqualified round does not count toward
 * the three: "non-improving" is a claim, and this one needs a measurement
 * nobody has taken. `experiments/paired/dispersion.py` is how you take it.
 *
 * ## Ranking on a vector, and why a scalar was wrong
 *
 * This runner used to rank rounds on ONE number: the median grid displacement.
 * The argument for it is in the git history and it was not stupid — grid
 * displacement is the only scored geometric gate that is a function of the
 * recovered calibration, and combining metrics needs weights, and arbitrary
 * weights are how a loop starts optimising its own score.
 *
 * It was still wrong, and the bench's own attribution proves it. Substituting
 * the TRUE projector positions into a recovered calibration makes grid
 * displacement WORSE — 61.18 mm against the 1.058 mm the recovered rig scores —
 * because the recovered rig is internally self-consistent: every projector is
 * wrong in a way that agrees with every other projector, so their copies of a
 * grid line still land on top of each other. A 59 mm pose error costs that
 * ranking nothing. Rank on it alone and a round that quietly wrecked pose
 * recovery while nudging the seams is recorded as an improvement.
 *
 * So a round is ranked on a VECTOR of gate-facing metrics, one per scored
 * geometric gate, each divided by its own gate limit so the components share a
 * unit ("fractions of the gate") without anybody choosing a weight. The
 * comparison rule is stated in `betterThan` and is Pareto dominance with a
 * deadband: to be better, a round must be better on something by more than the
 * scatter and worse on NOTHING by more than the scatter. There is no trade. A
 * round that improves seams and regresses pose is `mixed`, and mixed never wins.
 *
 * ## And it refuses to score a provisional metric
 *
 * docs/ARCHITECTURE.md says "the loop runner refuses to score a round on a
 * provisional metric". It said it for months and did not do it. `assertScorable`
 * does it: a ranked metric whose gate is marked provisional stops the round with
 * an error naming the metric, rather than letting a number that rests on an
 * unmeasured constant (PARAMETERS.md §10 counts 31 of them) decide whether a
 * round was an improvement.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliOptions } from './cli.ts';
import { formatSummary, reportGates, runBench } from './cli.ts';
import type { BenchResults, Dispersion } from './results.ts';
import { stringifyResults } from './results.ts';
import { defaultPaths, writeProgressPage } from './progress.ts';
import { deriveSeed } from './random.ts';
import { PRESETS } from './scenarios.ts';
import type { BenchPreset } from './scenarios.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HISTORY_PATH = path.join(REPO_ROOT, 'progress', 'rounds.json');

/**
 * The metrics a round is judged on — the ranking vector.
 *
 * Every one is gate-facing: it has a limit somewhere in PARAMETERS.md §7 or, for
 * `h_center` and the camera, in a derivation stated in that gate's own `basis`,
 * and `gateId` names the gate so the limit is read from the run rather than
 * copied here. `direction` is "lower" for all six, but it is named rather than
 * assumed so that adding a metric where it is not cannot silently invert the
 * verdict.
 *
 * The four recovery entries are the ones a scalar grid-displacement ranking was
 * blind to. They stay in the vector even though two of §7's pose gates cannot be
 * met today (docs/AMENDMENTS.md A-18, and `gate-waivers.json`): a gate being
 * unreachable in absolute terms says nothing about whether a round moved it, and
 * "moved it" is the only question this file asks.
 *
 * The camera entry is the newest and the one with the least documentary
 * standing: PARAMETERS.md never mentions the metrology camera, so its limit is
 * derived from this repository's own measurements rather than read off a spec.
 * It is in the vector because leaving it out is the more expensive mistake —
 * for two rounds it was the strongest single predictor of the failing gate and
 * no round-over-round comparison could see it.
 */
export interface TrackedMetric {
  key: string;
  label: string;
  unit: string;
  /** Gate id in `results.gates.gates`, for the limit and the provisional flag. */
  gateId: string;
  direction: 'lower';
}

export const TRACKED: TrackedMetric[] = [
  {
    key: 'gridDisplacementMm',
    label: 'grid displacement',
    unit: 'mm',
    gateId: 'grid_displacement',
    direction: 'lower',
  },
  {
    key: 'poseMaxPositionMmAligned',
    label: 'pose position (aligned)',
    unit: 'mm',
    gateId: 'pose_position',
    direction: 'lower',
  },
  {
    key: 'poseMaxRotationDegAligned',
    label: 'pose rotation (aligned)',
    unit: 'deg',
    gateId: 'pose_rotation',
    direction: 'lower',
  },
  {
    key: 'centerHeightErrorMm',
    label: 'h_center error',
    unit: 'mm',
    gateId: 'h_center_recovery',
    direction: 'lower',
  },
  {
    // Round 2's critic established this as the term that separates a passing
    // scenario from a failing one: perfect separation over 30 instances at
    // three seeds, r = 0.70-0.89 against grid displacement, 20-39 mm/deg. A
    // quantity that predicts the worst-failing gate that well while being
    // invisible to the round-ranking rule is the same defect as ranking on
    // median grid displacement, one level up — so it is in the vector.
    key: 'cameraMaxRotationDeg',
    label: 'camera rotation (aligned)',
    unit: 'deg',
    gateId: 'camera_pose_rotation',
    direction: 'lower',
  },
  {
    key: 'offSphereFluxExcess',
    label: 'off-sphere flux excess',
    unit: 'fraction',
    gateId: 'off_sphere_flux_excess',
    direction: 'lower',
  },
];

/**
 * Which tracked metrics may never regress without the round being disqualified
 * from "improved".
 *
 * All of them, and the list exists to say so explicitly rather than by omission.
 * The two pose entries are the reason this file was rewritten: they are what a
 * median-grid-displacement ranking could not see.
 */
export const NEVER_REGRESS: readonly string[] = TRACKED.map((t) => t.key);

export interface RoundSeries {
  median: number;
  p95: number;
  max: number;
  /** Half the interquartile range. The bar a change has to clear to count. */
  /**
   * Half the interquartile range of this round's values ACROSS SCENARIOS.
   *
   * Kept, because it says something true and useful — how much the twelve
   * archetypes differ from each other on this metric. It is NOT seed noise and
   * must never be used as the round-over-round bar; that mistake is what this
   * field's rename records.
   */
  scatterAcrossScenarios: number;
  /**
   * Measured run-to-run dispersion across SEEDS, or NaN when nobody has measured
   * it for this metric.
   *
   * The only number `movementOf` will accept as a bar. `NaN` is the honest
   * default: this project has never run the corpus at several seeds with the
   * code held still, which is what `experiments/paired/dispersion.py` exists to
   * do, so every round it has recorded is `unqualified`.
   */
  dispersion: number;
  /** The gate limit this metric is measured against, in the metric's own unit. */
  gateMax: number;
  /**
   * `median / gateMax` — the metric in units of its own gate, which is what
   * makes five metrics in three units comparable without anybody choosing a
   * weight. `Infinity` when the gate limit is zero (the hard unlit gate).
   */
  gateFraction: number;
}

export interface RoundRecord {
  round: number;
  seed: number;
  /** Not compared to anything; a round history is a log, not an artifact. */
  at: string;
  preset: string;
  scenarioCount: number;
  gitCommit: string;
  pass: boolean;
  gates: { id: string; pass: boolean; failed: number; scored: number; worst: number }[];
  series: Record<string, RoundSeries>;
  /** Per tracked metric, against the PREVIOUS round. */
  movement: Record<string, Movement>;
  /** Which metrics regressed against the previous round. Empty when none did. */
  regressed: string[];
  improving: boolean;
  consecutiveNonImproving: number;
  /** How this round compared against the incumbent BEST, and why. */
  comparison: Comparison;
  resultsPath: string;
  /** True when this round became the new best. */
  best: boolean;
  /**
   * How this record came to exist.
   *
   * `recorded` — written by `loop.ts` as the round actually ran.
   * `replayed` — reconstructed afterwards by `tools/replay-rounds.ts`, which
   *   checks the round's own commit out and runs its own bench at a fixed seed.
   *
   * Rounds 0-3 are necessarily `replayed`: the recorder did not exist until
   * round 4 and their results files were gitignored and overwritten. A replay is
   * the more CONTROLLED comparison — one seed, one corpus size, across every
   * round — but it is not the same thing as a measurement taken at the time, and
   * a reader has to be able to tell which they are looking at.
   */
  provenance?: 'recorded' | 'replayed';
  /** What shipped in this round, one line. Set by the replay tool. */
  shipped?: string;
}

export const ROUNDS_SCHEMA = 'sphere-sim/rounds@2';

export interface RoundHistory {
  /**
   * `@2` because the best round now carries its whole ranking vector rather
   * than one scalar score. An `@1` history is not upgraded in place — it is
   * treated as absent, so a stale best cannot be compared against a vector it
   * never had.
   */
  schema: typeof ROUNDS_SCHEMA;
  /** The chain root. Round N's seed derives from this and N. */
  rootSeed: number;
  rounds: RoundRecord[];
  /**
   * The incumbent best, with the vector it won on. Keeping the series here is
   * what lets a later round be compared against the best rather than against
   * whatever happened to run last.
   */
  best: { round: number; seed: number; series: Record<string, RoundSeries> } | null;
}

function emptyHistory(rootSeed: number): RoundHistory {
  return { schema: ROUNDS_SCHEMA, rootSeed, rounds: [], best: null };
}

export function loadHistory(file = HISTORY_PATH, rootSeed = 20240001): RoundHistory {
  if (!fs.existsSync(file)) return emptyHistory(rootSeed);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RoundHistory;
    if (parsed.schema !== ROUNDS_SCHEMA) return emptyHistory(rootSeed);
    return parsed;
  } catch {
    return emptyHistory(rootSeed);
  }
}

/**
 * The number the NEXT round gets.
 *
 * One past the highest round already recorded, not the count of records. The
 * two agree only while the history is dense, and it need not be: `--round`
 * records a results file under any number the caller names, and a round can be
 * removed from `progress/rounds.json` by hand. On a history holding rounds
 * 0, 1, 2 and 4, the count is 4 — so the next round would have been numbered 4
 * as well, and `recordRound` filters out the record whose number matches before
 * appending, which means the existing round 4 would have been DELETED and
 * replaced without a word. The seed would have collided too, since
 * `seedForRound` is a function of the round number: the "fresh" round would
 * have re-run the scenarios of the one it overwrote.
 *
 * Monotone by construction, so the auto-numbered path cannot collide with
 * anything. Deliberate replacement still exists — it is what `--replay` and an
 * explicit `--round` are for.
 */
export function nextRoundNumber(history: RoundHistory): number {
  return history.rounds.reduce((max, r) => Math.max(max, r.round), -1) + 1;
}

export function seedForRound(rootSeed: number, round: number): number {
  return deriveSeed(rootSeed, `round:${round}`);
}

function seriesOf(
  d: Dispersion | undefined,
  gateMax: number,
  /**
   * Measured across-seed dispersion for this metric, if anybody has measured it.
   * Threaded in rather than derived, because it cannot be derived from a single
   * seeded run — which is the entire finding this signature records.
   */
  measuredDispersion: number | undefined,
): RoundSeries {
  const dispersion = measuredDispersion !== undefined && Number.isFinite(measuredDispersion)
    ? measuredDispersion
    : Number.NaN;
  if (d === undefined) {
    return {
      median: NaN,
      p95: NaN,
      max: NaN,
      scatterAcrossScenarios: NaN,
      dispersion,
      gateMax,
      gateFraction: NaN,
    };
  }
  return {
    median: d.median,
    p95: d.p95,
    max: d.max,
    scatterAcrossScenarios: d.iqr / 2,
    dispersion,
    gateMax,
    gateFraction: gateMax === 0 ? Number.POSITIVE_INFINITY : d.median / gateMax,
  };
}

/**
 * Refuse to score a round on a metric that rests on an unmeasured constant.
 *
 * docs/ARCHITECTURE.md's phase gate, mechanically. Phase 2's metrics — seam
 * luminance, seam chromaticity, black uplift — are functions of `γ_B`, `L_black`
 * and `E_amb`, which PARAMETERS.md §10 ranks as the top three unmeasured risks.
 * A loop that ranked rounds on one of them would be optimising against a guess
 * and reporting the result as progress. Every metric in the corpus today sets
 * `provisional: false` and means it, so this throws only when somebody adds a
 * Phase 2 metric to `TRACKED` — which is exactly when it should.
 *
 * A ranked metric whose gate is missing from the run is also refused: ranking on
 * a metric with no limit means the vector silently loses a component, and a
 * ranking that quietly drops a term is how the pose blindness happened.
 */
export function assertScorable(results: BenchResults, only?: readonly string[]): void {
  const problems: string[] = [];
  for (const t of TRACKED) {
    if (only !== undefined && !only.includes(t.key)) continue;
    const gate = results.gates.gates.find((g) => g.id === t.gateId);
    if (gate === undefined) {
      problems.push(
        `${t.label} (${t.key}) ranks against gate '${t.gateId}', which this run did not produce`,
      );
      continue;
    }
    if (gate.provisional) {
      problems.push(
        `${t.label} (${t.key}) is PROVISIONAL — gate '${t.gateId}' depends on a constant nobody has ` +
          'measured, so it cannot decide whether a round improved',
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `loop: refusing to score this round.\n  ${problems.join('\n  ')}\n` +
        'docs/ARCHITECTURE.md: "the loop runner refuses to score a round on a provisional metric". ' +
        'Report it, mark it, and leave it out of TRACKED.',
    );
  }
}

/**
 * The ranking vector for a round: every tracked metric, in gate units.
 *
 * `only` narrows the vector to a named subset. It exists for ONE caller —
 * `tools/replay-rounds.ts`, which ranks rounds whose code predates a gate this
 * project later added, and must compare them on the metrics they all produced.
 * Narrowing is legitimate there and dishonest anywhere else: dropping a term
 * from the vector during the loop is how the pose blindness happened, which is
 * why `assertScorable` refuses a missing gate rather than skipping it. A caller
 * that passes `only` is asserting the omission is a property of the DATA, not a
 * preference about the result.
 */
/**
 * Measured across-seed dispersion, keyed by tracked-metric key.
 *
 * Supplied by whoever took the measurement — run the corpus at three or more
 * seeds with the code held still and feed the per-metric spread through
 * `experiments/paired/dispersion.py`. Absent keys mean "not measured", which is
 * the honest state of every metric in this repository today.
 */
export type SeedDispersion = Readonly<Record<string, number>>;

export function rankRound(
  results: BenchResults,
  only?: readonly string[],
  seedDispersion: SeedDispersion = {},
): Record<string, RoundSeries> {
  assertScorable(results, only);
  const series: Record<string, RoundSeries> = {};
  for (const t of TRACKED) {
    if (only !== undefined && !only.includes(t.key)) continue;
    const gate = results.gates.gates.find((g) => g.id === t.gateId);
    series[t.key] = seriesOf(results.aggregate[t.key], gate?.max ?? NaN, seedDispersion[t.key]);
  }
  return series;
}

export type Movement =
  | 'improved'
  | 'regressed'
  | 'flat'
  | 'lost'
  /**
   * The metric moved, and this loop cannot say whether that means anything.
   *
   * Reported when no measured across-seed dispersion is available for it. NOT
   * the same as `flat`, and the difference is the whole point: `flat` asserts
   * the change was smaller than the noise, which is a measurement; this says
   * nobody has taken that measurement. An unqualified round does not count
   * toward the three non-improving rounds that end Phase 1.
   */
  | 'unqualified';

/**
 * How one metric moved between two rounds, with the deadband applied.
 *
 * The bar is the LARGER of the two rounds' MEASURED across-seed dispersions, so
 * a change has to clear the noise of both things being compared. A change that
 * does not clear it is not evidence of anything, whichever way it points — and
 * when either round has no measured dispersion, neither is the change: that is
 * `unqualified`, not `flat`.
 *
 * `lost` is its own answer: a metric that was measurable and now is not has not
 * improved, however tempting the empty series looks. It counts as a regression
 * everywhere a regression counts.
 */
export function movementOf(now: RoundSeries | undefined, before: RoundSeries | undefined): Movement {
  if (before === undefined || !Number.isFinite(before.median)) return 'flat';
  if (now === undefined || !Number.isFinite(now.median)) return 'lost';
  // Both rounds must carry a measured across-seed dispersion. Falling back to
  // whatever number happens to be lying around is exactly what this function
  // used to do, and the fallback it used was larger than the gate.
  const haveNow = Number.isFinite(now.dispersion);
  const haveBefore = Number.isFinite(before.dispersion);
  if (!haveNow || !haveBefore) return 'unqualified';

  const bar = Math.max(
    now.dispersion > 0 ? now.dispersion : 0,
    before.dispersion > 0 ? before.dispersion : 0,
  );
  const delta = now.median - before.median;
  if (delta < -bar) return 'improved';
  if (delta > bar) return 'regressed';
  return 'flat';
}

/**
 * Classify a whole round against the previous one.
 *
 * `improving` — the flag docs/ARCHITECTURE.md's three-non-improving-rounds
 * stopping condition counts — now requires BOTH that something improved by more
 * than its scatter AND that nothing regressed by more than its scatter. The
 * second half is the fix: a round that halved the seam error while doubling the
 * pose error used to be recorded as an improvement, because the ranking could
 * not see pose at all.
 */
export function classifyMovement(
  current: Record<string, RoundSeries>,
  previous: Record<string, RoundSeries> | null,
): {
  movement: Record<string, Movement>;
  improving: boolean;
  improved: string[];
  regressed: string[];
  /**
   * Whether this comparison could be qualified at all.
   *
   * False when any tracked metric came back `unqualified` — no measured
   * across-seed dispersion, so the loop has no noise floor to judge it against.
   * The stopping condition reads this: three consecutive NON-IMPROVING rounds
   * ends Phase 1, and a round nobody could qualify is not a round that was found
   * to be non-improving. It is a round that was not assessed.
   */
  qualified: boolean;
} {
  const movement: Record<string, Movement> = {};
  const improved: string[] = [];
  const regressed: string[] = [];
  let unqualified = 0;
  for (const t of TRACKED) {
    const m = movementOf(current[t.key], previous?.[t.key]);
    movement[t.key] = m;
    if (m === 'improved') improved.push(t.key);
    if (m === 'regressed' || m === 'lost') regressed.push(t.key);
    if (m === 'unqualified') unqualified++;
  }
  return {
    movement,
    improving: improved.length > 0 && regressed.length === 0,
    improved,
    regressed,
    qualified: unqualified === 0,
  };
}

export interface Comparison {
  /** `better`, `worse`, `mixed` or `flat`. Only `better` displaces a best. */
  verdict: 'better' | 'worse' | 'mixed' | 'flat';
  improved: string[];
  regressed: string[];
  /** One sentence, for the round log. Always says which metrics decided it. */
  why: string;
}

/**
 * THE ROUND-COMPARISON RULE, stated once, here.
 *
 * A round is BETTER than another when, over the whole ranking vector:
 *
 *   1. no tracked metric is worse by more than the scatter of the two rounds
 *      being compared (`NEVER_REGRESS` is every one of them, and pose recovery
 *      is in it), and
 *   2. at least one tracked metric is better by more than that same scatter.
 *
 * Anything else is `mixed` (some better, some worse), `worse` (only regressions)
 * or `flat` (nothing cleared the noise). Only `better` displaces the incumbent
 * best, so a tie or a trade leaves the crown where it was.
 *
 * There is deliberately no trade-off arithmetic — no weighted sum, no
 * lexicographic order, no "pose may regress if seams improve enough". A weight
 * is an editorial judgement about which failure matters, and the loop is not
 * entitled to make it: PARAMETERS.md §7 sets five limits and does not rank them.
 * Refusing to trade means the loop can only record a round as progress when it
 * is progress on every axis the spec names, which is a stronger claim and a
 * rarer one. That is the intended cost.
 */
export function betterThan(
  current: Record<string, RoundSeries>,
  incumbent: Record<string, RoundSeries> | null,
): Comparison {
  if (incumbent === null) {
    return {
      verdict: 'better',
      improved: [],
      regressed: [],
      why: 'first round on record: nothing to compare against, so it is the best by default.',
    };
  }
  const { improved, regressed } = classifyMovement(current, incumbent);
  const label = (keys: string[]): string =>
    keys.map((k) => TRACKED.find((t) => t.key === k)?.label ?? k).join(', ');

  if (regressed.length > 0 && improved.length > 0) {
    return {
      verdict: 'mixed',
      improved,
      regressed,
      why:
        `improved ${label(improved)} but regressed ${label(regressed)}. A trade is not an improvement: ` +
        'the best round is unchanged.',
    };
  }
  if (regressed.length > 0) {
    return {
      verdict: 'worse',
      improved,
      regressed,
      why: `regressed ${label(regressed)} and improved nothing.`,
    };
  }
  if (improved.length > 0) {
    return {
      verdict: 'better',
      improved,
      regressed,
      why: `improved ${label(improved)} with no regression anywhere in the vector.`,
    };
  }
  return {
    verdict: 'flat',
    improved,
    regressed,
    why: 'nothing moved by more than the scatter across seeds. The best round is unchanged.',
  };
}

export interface LoopOptions {
  preset: BenchPreset;
  scenarios: number;
  seed: number | null;
  replay: number | null;
  historyPath: string;
  outDir: string;
  quiet: boolean;
  /**
   * Record a round from a bench run that ALREADY HAPPENED, instead of running
   * one — the path to its results JSON.
   *
   * This exists because for three rounds `progress/rounds.json` did not exist at
   * all. The machinery above was written, edited by three rounds, and never
   * executed, because a round is regenerated with `packages/bench/src/cli.ts`
   * (twelve scenarios, a fresh seed, several minutes) and `runRound` re-runs
   * that same corpus rather than reading it. Nobody was going to pay for the
   * corpus twice, so the ranking never ran and the history the loop compares
   * against stayed empty. A ranking rule that has never ranked anything is not a
   * rule, and this is the smallest change that makes the two entry points meet.
   *
   * The round is ranked exactly as `runRound` ranks it: same `rankRound`, same
   * `classifyMovement`, same `betterThan`, same history file.
   */
  record: string | null;
  /**
   * Which round number a `--record` is. Defaults to the next one in the
   * history, which is what a fresh chain wants; give it explicitly when the
   * history starts late, as it does here — Phase 1's rounds 0 to 3 ran before
   * anything wrote this file, and numbering this round 0 would make the
   * history disagree with docs/PHASE-1.md about which round is which.
   *
   * Ignored unless `record` is set: a live round's number comes from the
   * history or from `--replay`, and letting a flag rename it would make
   * "round 3" ambiguous.
   */
  round: number | null;
}

export function parseLoopArgs(argv: readonly string[]): LoopOptions {
  let preset = PRESETS.default;
  let scenarios = -1;
  let seed: number | null = null;
  let replay: number | null = null;
  let historyPath = HISTORY_PATH;
  let outDir = path.join('progress', 'data');
  let quiet = false;
  let record: string | null = null;
  let round: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`loop: ${a} needs a value`);
      return v;
    };
    // A round number is an index into the history and a filename. `Number('x')`
    // is NaN, and a NaN round survives every comparison in `recordRound`
    // (`NaN !== NaN`, so it replaces nothing and sorts nowhere) before landing
    // in `progress/data/round-NaN.json`.
    const index = (): number => {
      // Digits only, on the RAW text. `Number('')` and `Number(' ')` are both
      // 0, so a numeric check alone would silently turn a missing value into
      // round 0 and overwrite the first round of the history.
      const raw = next();
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new Error(`loop: ${a} needs a non-negative whole number, got '${raw}'`);
      }
      return Number(raw);
    };
    switch (a) {
      case '--quick':
        preset = PRESETS.quick;
        break;
      case '--thorough':
        preset = PRESETS.thorough;
        break;
      case '--scenarios':
        scenarios = Number(next());
        break;
      case '--seed':
        seed = Number(next());
        break;
      case '--replay':
        replay = index();
        break;
      case '--history':
        historyPath = path.resolve(REPO_ROOT, next());
        break;
      case '--out-dir':
        outDir = next();
        break;
      case '--quiet':
        quiet = true;
        break;
      case '--record':
        record = next();
        break;
      case '--round':
        round = index();
        break;
      default:
        throw new Error(`loop: unknown argument '${a}'`);
    }
  }
  return {
    preset,
    scenarios: scenarios > 0 ? Math.floor(scenarios) : preset.scenarioCount,
    seed,
    replay,
    historyPath,
    outDir,
    quiet,
    record,
    round,
  };
}

export interface RoundOutcome {
  record: RoundRecord;
  results: BenchResults;
  history: RoundHistory;
  summary: string;
}

/**
 * Rank one finished bench run and fold it into the history.
 *
 * Pure: it reads a `BenchResults` and a `RoundHistory` and returns the next
 * history. Whether the run happened just now (`runRound`) or an hour ago
 * (`--record`) makes no difference to how it is judged, which is the property
 * that lets the corpus be regenerated once per round instead of twice.
 */
export function recordRound(
  results: BenchResults,
  history: RoundHistory,
  round: number,
  seed: number,
  presetName: string,
  resultsPath: string,
  only?: readonly string[],
): RoundOutcome {
  // Throws rather than ranking on a provisional metric. Before the results are
  // used for anything, so a Phase 2 metric cannot sneak into a verdict.
  const series = rankRound(results, only);
  const priorRounds = history.rounds.filter((r) => r.round < round);
  const previous = priorRounds.length > 0 ? priorRounds[priorRounds.length - 1] : null;
  const { movement, improving, regressed, qualified } = classifyMovement(
    series,
    previous?.series ?? null,
  );
  // Three consecutive NON-IMPROVING rounds ends Phase 1 — a claim that requires
  // having assessed them. A round the loop could not qualify carries the count
  // forward unchanged rather than incrementing it: not evidence of improvement,
  // and not evidence of its absence either.
  const consecutive = improving
    ? 0
    : qualified
      ? (previous?.consecutiveNonImproving ?? 0) + 1
      : (previous?.consecutiveNonImproving ?? 0);

  // Against the incumbent BEST, not against the last round: "keep the best" is a
  // different question from "did this round move", and answering it with the
  // previous round's numbers is how a slow drift downhill keeps its crown.
  const comparison = betterThan(series, history.best?.series ?? null);
  const isBest = comparison.verdict === 'better';

  const record: RoundRecord = {
    round,
    seed,
    at: results.env.generatedAt,
    preset: presetName,
    scenarioCount: results.run.scenarioCount,
    gitCommit: results.env.gitCommit,
    pass: results.gates.pass,
    gates: results.gates.gates.map((g) => ({
      id: g.id,
      pass: g.pass,
      failed: g.scenariosFailed,
      scored: g.scenariosScored,
      worst: g.worst?.value ?? NaN,
    })),
    series,
    movement,
    regressed,
    improving,
    consecutiveNonImproving: consecutive,
    comparison,
    resultsPath,
    best: isBest,
  };

  // A replay replaces its own record rather than appending; anything else would
  // make "round 3" ambiguous the moment somebody re-ran it.
  const rounds = history.rounds.filter((r) => r.round !== round);
  rounds.push(record);
  rounds.sort((a, b) => a.round - b.round);
  const nextHistory: RoundHistory = {
    schema: ROUNDS_SCHEMA,
    rootSeed: history.rootSeed,
    rounds,
    best: isBest ? { round, seed, series } : history.best,
  };

  return { record, results, history: nextHistory, summary: formatRound(record, previous, results) };
}

export function runRound(options: LoopOptions): RoundOutcome {
  const history = loadHistory(options.historyPath);
  const round = options.replay !== null ? options.replay : nextRoundNumber(history);
  const seed =
    options.seed !== null
      ? options.seed
      : options.replay !== null
        ? (history.rounds.find((r) => r.round === options.replay)?.seed ??
          seedForRound(history.rootSeed, options.replay))
        : seedForRound(history.rootSeed, round);

  const resultsPath = path.join(options.outDir, `round-${String(round).padStart(3, '0')}.json`);
  const cli: CliOptions = {
    seed,
    scenarios: options.scenarios,
    out: resultsPath,
    outDir: options.outDir,
    preset: options.preset,
    artifacts: true,
    baseline: true,
    attribute: options.preset.attributeFailures,
    quiet: options.quiet,
  };
  const results = runBench(cli);
  return recordRound(results, history, round, seed, options.preset.name, resultsPath);
}

/**
 * Record a round from a results file the bench already wrote.
 *
 * The seed, the scenario count and the preset are read from the file rather
 * than from the command line, so a recorded round cannot claim to be a run it
 * was not. The round NUMBER is the next one in the history unless `--replay`
 * names an existing one.
 */
export function recordFromFile(options: LoopOptions): RoundOutcome {
  if (options.record === null) throw new Error('loop: recordFromFile needs --record');
  const file = path.resolve(REPO_ROOT, options.record);
  if (!fs.existsSync(file)) throw new Error(`loop: --record ${options.record}: no such file`);
  const results = JSON.parse(fs.readFileSync(file, 'utf8')) as BenchResults;
  if (results.run === undefined || results.gates === undefined) {
    throw new Error(`loop: --record ${options.record}: not a bench results file`);
  }
  const history = loadHistory(options.historyPath);
  const round =
    options.round !== null
      ? options.round
      : options.replay !== null
        ? options.replay
        : nextRoundNumber(history);
  return recordRound(
    results,
    history,
    round,
    results.run.seed,
    results.run.preset,
    path.relative(REPO_ROOT, file),
  );
}

export function formatRound(
  record: RoundRecord,
  previous: RoundRecord | null,
  results: BenchResults,
): string {
  const lines: string[] = [];
  const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const num = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : 'n/a');

  lines.push('');
  lines.push(
    `ROUND ${record.round} — seed ${record.seed}, ${record.scenarioCount} scenarios, preset ${record.preset}`,
  );
  lines.push('');
  lines.push(
    `${pad('METRIC', 26)}${pad('MEDIAN', 12)}${pad('PREV', 12)}${pad('SCATTER', 12)}${pad('x GATE', 10)}MOVEMENT`,
  );
  for (const t of TRACKED) {
    const s = record.series[t.key];
    // A replayed round can legitimately lack a tracked metric: rounds whose code
    // predates a gate never produced it. `rankRound`'s `only` narrows the vector
    // for exactly that case, so print the omission rather than assuming it away.
    if (s === undefined) {
      lines.push(pad(t.label, 26) + 'not produced by this round');
      continue;
    }
    const p = previous?.series[t.key];
    lines.push(
      pad(t.label, 26) +
        pad(num(s.median), 12) +
        pad(p === undefined ? '-' : num(p.median), 12) +
        pad(num(s.dispersion), 12) +
        // The whole ranking vector, in the one unit its five components share.
        pad(Number.isFinite(s.gateFraction) ? `${s.gateFraction.toFixed(2)}x` : 'n/a', 10) +
        record.movement[t.key],
    );
  }
  lines.push('');
  for (const g of results.gates.gates) {
    if (g.pass) continue;
    const who = g.attribution === null ? 'unattributed' : g.attribution.contributor;
    lines.push(`  FAIL ${pad(g.id, 22)} worst ${num(g.worst?.value ?? NaN)} / ${g.max}  -> ${who}`);
  }
  lines.push('');
  if (record.improving) {
    lines.push('Round IMPROVED: something moved past its scatter and NOTHING regressed past its own.');
  } else if (record.regressed.length > 0) {
    lines.push(
      `Round non-improving (${record.consecutiveNonImproving} consecutive). REGRESSED: ` +
        `${record.regressed.map((k) => TRACKED.find((t) => t.key === k)?.label ?? k).join(', ')}. ` +
        'A round that regresses a gate-facing metric is never recorded as an improvement, whatever else it moved.',
    );
  } else {
    lines.push(`Round non-improving (${record.consecutiveNonImproving} consecutive). Three ends Phase 1.`);
  }
  lines.push(
    record.best
      ? `New best (vs the incumbent best round): ${record.comparison.why}`
      : `Best round unchanged: ${record.comparison.why}`,
  );
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const options = parseLoopArgs(process.argv.slice(2));

  // Recording an existing run writes the history and stops. It deliberately
  // does NOT rewrite the results file or the progress page: it did not produce
  // them, and a recorder that re-serialised somebody else's run would be one
  // more place for the file on disk and the round on record to disagree.
  if (options.record !== null) {
    const outcome = recordFromFile(options);
    fs.mkdirSync(path.dirname(options.historyPath), { recursive: true });
    fs.writeFileSync(options.historyPath, `${JSON.stringify(outcome.history, null, 2)}\n`);
    process.stdout.write(outcome.summary);
    process.stdout.write(
      `recorded round ${outcome.record.round} from ${options.record} ` +
        `into ${path.relative(REPO_ROOT, options.historyPath)}\n`,
    );
    return;
  }

  const outcome = runRound(options);
  const outDir = path.isAbsolute(options.outDir)
    ? options.outDir
    : path.join(REPO_ROOT, options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, path.basename(outcome.record.resultsPath));
  fs.writeFileSync(resultsFile, stringifyResults(outcome.results));

  fs.mkdirSync(path.dirname(options.historyPath), { recursive: true });
  fs.writeFileSync(options.historyPath, `${JSON.stringify(outcome.history, null, 2)}\n`);

  // The progress page is refreshed BEFORE the best-round bookkeeping below, and
  // the order is the whole point: at this moment `best-results.json` and
  // `progress/data/best/` still hold the PREVIOUS best, so the page's
  // before/after pair compares this round against the one it is trying to beat.
  // Refreshing after would compare a winning round against itself.
  refreshProgressPage(resultsFile, options.historyPath, outDir);

  // The best round's results are kept under a stable name so the before/after
  // pair can always be rebuilt from it — and, because the record carries the
  // seed, so can every scenario in it, camera placement included. Its renders
  // are COPIED rather than referenced: `progress/data` is overwritten in place
  // every round, so a pair built from those paths would be this round twice.
  if (outcome.record.best) {
    fs.writeFileSync(path.join(outDir, 'best-results.json'), stringifyResults(outcome.results));
    const bestDir = path.join(outDir, 'best');
    fs.mkdirSync(bestDir, { recursive: true });
    for (const scenario of outcome.results.scenarios) {
      for (const rel of Object.values(scenario.artifacts ?? {})) {
        if (rel === '') continue;
        const from = path.join(REPO_ROOT, rel);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(bestDir, path.basename(rel)));
      }
    }
  }

  process.stdout.write(formatSummary(outcome.results));
  // The gate verdict, with citations, reported but never fatal: a Phase 1 round
  // that fails a gate is the normal state of Phase 1, and a loop that exited
  // non-zero on it would be unusable. CI judges; the loop iterates.
  reportGates(resultsFile, true);
  process.stdout.write(outcome.summary);
  process.stdout.write(
    `history: ${path.relative(REPO_ROOT, options.historyPath)}   results: ${path.relative(REPO_ROOT, resultsFile)}\n`,
  );
}

/**
 * Rebuild `progress/index.html` from the round that just finished.
 *
 * Wrapped so a page failure cannot lose a round. The results file and the
 * history are on disk before this runs; the page is a view of them and can
 * always be rebuilt with `node packages/bench/src/progress.ts`.
 */
function refreshProgressPage(resultsFile: string, historyPath: string, outDir: string): void {
  try {
    const paths = defaultPaths(REPO_ROOT);
    paths.resultsFile = resultsFile;
    paths.roundsFile = historyPath;
    // The previous best lives beside this round's output, not at the default
    // location, so a run with `--out-dir` compares against its own history
    // rather than against whatever the repository happens to hold.
    paths.previousResultsFile = path.join(outDir, 'best-results.json');
    paths.previousImageDir = path.join(outDir, 'best');
    const written = writeProgressPage(paths);
    process.stdout.write(
      `progress: ${path.relative(REPO_ROOT, written.file)} (${(written.bytes / 1024 / 1024).toFixed(2)} MB)\n`,
    );
  } catch (e) {
    process.stdout.write(
      `progress: page NOT refreshed (${e instanceof Error ? e.message : String(e)}). The round itself is written.\n`,
    );
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
