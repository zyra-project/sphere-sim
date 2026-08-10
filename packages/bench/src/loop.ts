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
 * Implemented literally. The comparison is between MEDIANS, not means — a mean
 * hides the bimodal failure docs/ARCHITECTURE.md's G2 signature describes — and
 * the dispersion it must beat is half the interquartile range of the round's own
 * scenario values. Both halves matter: a change smaller than the scatter between
 * seeds is not evidence, and a metric that got WORSE by more than the scatter is
 * a regression rather than a non-improvement, so it is reported as such and does
 * not count toward the three.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliOptions } from './cli.ts';
import { formatSummary, runBench } from './cli.ts';
import type { BenchResults, Dispersion } from './results.ts';
import { stringifyResults } from './results.ts';
import { deriveSeed } from './random.ts';
import { PRESETS } from './scenarios.ts';
import type { BenchPreset } from './scenarios.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HISTORY_PATH = path.join(REPO_ROOT, 'progress', 'rounds.json');

/**
 * The metrics a round is judged on.
 *
 * Every one is gate-facing: it has a limit somewhere in PARAMETERS.md §7 or, for
 * `h_center`, in §1's prose. `direction` is always "lower is better" here, but
 * it is named rather than assumed so that adding a metric where it is not
 * cannot silently invert the verdict.
 */
export const TRACKED: { key: string; label: string; unit: string }[] = [
  { key: 'gridDisplacementMm', label: 'grid displacement', unit: 'mm' },
  { key: 'poseMaxPositionMmAligned', label: 'pose position (aligned)', unit: 'mm' },
  { key: 'poseMaxRotationDegAligned', label: 'pose rotation (aligned)', unit: 'deg' },
  { key: 'centerHeightErrorMm', label: 'h_center error', unit: 'mm' },
  { key: 'offSphereFluxExcess', label: 'off-sphere flux excess', unit: 'fraction' },
];

export interface RoundSeries {
  median: number;
  p95: number;
  max: number;
  /** Half the interquartile range. The bar a change has to clear to count. */
  dispersion: number;
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
  /** Per tracked metric: improved, regressed, or neither. */
  movement: Record<string, 'improved' | 'regressed' | 'flat'>;
  improving: boolean;
  consecutiveNonImproving: number;
  resultsPath: string;
  /** True when this round became the new best. */
  best: boolean;
}

export interface RoundHistory {
  schema: 'sphere-sim/rounds@1';
  /** The chain root. Round N's seed derives from this and N. */
  rootSeed: number;
  rounds: RoundRecord[];
  best: { round: number; seed: number; score: number } | null;
}

function emptyHistory(rootSeed: number): RoundHistory {
  return { schema: 'sphere-sim/rounds@1', rootSeed, rounds: [], best: null };
}

export function loadHistory(file = HISTORY_PATH, rootSeed = 20240001): RoundHistory {
  if (!fs.existsSync(file)) return emptyHistory(rootSeed);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RoundHistory;
    if (parsed.schema !== 'sphere-sim/rounds@1') return emptyHistory(rootSeed);
    return parsed;
  } catch {
    return emptyHistory(rootSeed);
  }
}

export function seedForRound(rootSeed: number, round: number): number {
  return deriveSeed(rootSeed, `round:${round}`);
}

function seriesOf(d: Dispersion | undefined): RoundSeries {
  if (d === undefined) return { median: NaN, p95: NaN, max: NaN, dispersion: NaN };
  return { median: d.median, p95: d.p95, max: d.max, dispersion: d.iqr / 2 };
}

/**
 * The single number a round is ranked by, for "keep the previous best".
 *
 * Grid displacement alone, because it is the only scored geometric gate that is
 * a function of the recovered calibration — the other two are properties of
 * where the lenses physically point and no solver can move them. Combining it
 * with pose error into a weighted score would need weights, the weights would be
 * arbitrary, and an arbitrary weight is how a loop starts optimising the score
 * instead of the thing. Pose error is still tracked, still reported, and still
 * decides `movement`; it just does not get a vote in a single-number ranking it
 * cannot share a unit with.
 */
export function roundScore(results: BenchResults): number {
  const d = results.aggregate.gridDisplacementMm;
  return d === undefined || !Number.isFinite(d.median) ? Number.POSITIVE_INFINITY : d.median;
}

export function classifyMovement(
  current: Record<string, RoundSeries>,
  previous: Record<string, RoundSeries> | null,
): { movement: Record<string, 'improved' | 'regressed' | 'flat'>; improving: boolean } {
  const movement: Record<string, 'improved' | 'regressed' | 'flat'> = {};
  let improving = false;
  for (const t of TRACKED) {
    const now = current[t.key];
    const before = previous?.[t.key];
    if (before === undefined || !Number.isFinite(now?.median) || !Number.isFinite(before.median)) {
      movement[t.key] = 'flat';
      continue;
    }
    const delta = now.median - before.median;
    // The bar is this round's own scatter across seeds. A change that does not
    // clear it is not evidence of anything, whichever direction it points.
    const bar = Number.isFinite(now.dispersion) && now.dispersion > 0 ? now.dispersion : 0;
    if (delta < -bar) {
      movement[t.key] = 'improved';
      improving = true;
    } else if (delta > bar) {
      movement[t.key] = 'regressed';
    } else {
      movement[t.key] = 'flat';
    }
  }
  return { movement, improving };
}

export interface LoopOptions {
  preset: BenchPreset;
  scenarios: number;
  seed: number | null;
  replay: number | null;
  historyPath: string;
  outDir: string;
  quiet: boolean;
}

export function parseLoopArgs(argv: readonly string[]): LoopOptions {
  let preset = PRESETS.default;
  let scenarios = -1;
  let seed: number | null = null;
  let replay: number | null = null;
  let historyPath = HISTORY_PATH;
  let outDir = path.join('progress', 'data');
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`loop: ${a} needs a value`);
      return v;
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
        replay = Number(next());
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
  };
}

export interface RoundOutcome {
  record: RoundRecord;
  results: BenchResults;
  history: RoundHistory;
  summary: string;
}

export function runRound(options: LoopOptions): RoundOutcome {
  const history = loadHistory(options.historyPath);
  const round = options.replay !== null ? options.replay : history.rounds.length;
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

  const series: Record<string, RoundSeries> = {};
  for (const t of TRACKED) series[t.key] = seriesOf(results.aggregate[t.key]);
  const previous = history.rounds.length > 0 ? history.rounds[history.rounds.length - 1] : null;
  const { movement, improving } = classifyMovement(series, previous?.series ?? null);
  const consecutive = improving ? 0 : (previous?.consecutiveNonImproving ?? 0) + 1;

  const score = roundScore(results);
  const isBest = history.best === null || score < history.best.score;

  const record: RoundRecord = {
    round,
    seed,
    at: results.env.generatedAt,
    preset: options.preset.name,
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
    improving,
    consecutiveNonImproving: consecutive,
    resultsPath,
    best: isBest,
  };

  // A replay replaces its own record rather than appending; anything else would
  // make "round 3" ambiguous the moment somebody re-ran it.
  const rounds = history.rounds.filter((r) => r.round !== round);
  rounds.push(record);
  rounds.sort((a, b) => a.round - b.round);
  const nextHistory: RoundHistory = {
    schema: 'sphere-sim/rounds@1',
    rootSeed: history.rootSeed,
    rounds,
    best: isBest ? { round, seed, score } : history.best,
  };

  return { record, results, history: nextHistory, summary: formatRound(record, previous, results) };
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
    `${pad('METRIC', 26)}${pad('MEDIAN', 12)}${pad('PREV', 12)}${pad('SCATTER', 12)}MOVEMENT`,
  );
  for (const t of TRACKED) {
    const s = record.series[t.key];
    const p = previous?.series[t.key];
    lines.push(
      pad(t.label, 26) +
        pad(num(s.median), 12) +
        pad(p === undefined ? '-' : num(p.median), 12) +
        pad(num(s.dispersion), 12) +
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
  lines.push(
    record.improving
      ? 'Round IMPROVED at least one gate-facing metric by more than its own scatter.'
      : `Round non-improving (${record.consecutiveNonImproving} consecutive). Three ends Phase 1.`,
  );
  if (record.best) lines.push(`New best: grid displacement median ${num(record.series.gridDisplacementMm.median)} mm.`);
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const options = parseLoopArgs(process.argv.slice(2));
  const outcome = runRound(options);
  const outDir = path.isAbsolute(options.outDir)
    ? options.outDir
    : path.join(REPO_ROOT, options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, path.basename(outcome.record.resultsPath));
  fs.writeFileSync(resultsFile, stringifyResults(outcome.results));

  // The best round's results are kept under a stable name so the before/after
  // pair can always be rebuilt from it — and, because the record carries the
  // seed, so can every scenario in it, camera placement included.
  if (outcome.record.best) {
    fs.writeFileSync(path.join(outDir, 'best-results.json'), stringifyResults(outcome.results));
  }

  fs.mkdirSync(path.dirname(options.historyPath), { recursive: true });
  fs.writeFileSync(options.historyPath, `${JSON.stringify(outcome.history, null, 2)}\n`);

  process.stdout.write(formatSummary(outcome.results));
  process.stdout.write(outcome.summary);
  process.stdout.write(
    `history: ${path.relative(REPO_ROOT, options.historyPath)}   results: ${path.relative(REPO_ROOT, resultsFile)}\n`,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
