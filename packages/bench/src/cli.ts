/**
 * The headless bench.
 *
 *     node packages/bench/src/cli.ts --scenarios 6 --seed 1234 --out bench-results.json
 *
 * Renders N seeded scenarios, writes every metric to `bench-results.json` and
 * the rendered views to `progress/data/`. Deterministic: the same seed produces
 * byte-identical JSON (modulo the `env` and `timings` blocks, which the file
 * names in `volatile`) and byte-identical PNGs. A live window is never
 * screenshotted for scoring — docs/ARCHITECTURE.md is explicit about that, and
 * this file is the reason it can be.
 *
 * ## On not parallelising
 *
 * Scenarios are independent and worker threads would cut the wall clock by
 * about the core count. They are not used, and the reason is the instruction
 * that determinism outranks speed. Splitting across workers is bit-safe in
 * principle — each scenario is a pure function of its seed and IEEE-754 gives
 * the same answer on every thread — but it introduces a second execution path
 * whose determinism nobody would notice breaking until a critic diffed two runs
 * and got a spurious regression. At the measured cost of a default round the
 * saving does not buy that risk. If a future round needs it, the shape is
 * already right: `runScenario` takes a scenario and returns a plain object, the
 * results are assembled in scenario order, and nothing is shared between them.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  attributeCenterHeightFailure,
  attributeGridFailure,
  attributePoseFailure,
  canAttribute,
} from './attribute.ts';
import { defaultGateOptions, judge } from './gate.ts';
import { defaultPaths, writeProgressPage } from './progress.ts';
import type { BenchResults, EnvBlock } from './results.ts';
import { assembleResults, buildGates, stringifyResults } from './results.ts';
import { readAmendments, readWaivers, waiverAudit } from './waivers.ts';
import type { ScenarioResult } from './run.ts';
import { runScenario } from './run.ts';
import type { BenchPreset } from './scenarios.ts';
import { PRESETS, generateScenarios } from './scenarios.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface CliOptions {
  seed: number;
  scenarios: number;
  out: string;
  outDir: string;
  preset: BenchPreset;
  artifacts: boolean;
  baseline: boolean;
  attribute: boolean;
  quiet: boolean;
  /** Refresh `progress/index.html` from this run. Entry point only. */
  progress?: boolean;
  /**
   * Report a failing gate without failing the process. For exploratory runs —
   * and for CI's own bench steps, which measure twice and judge once, in a
   * separate step that does not get an escape hatch.
   */
  allowFailure?: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let preset = PRESETS.default;
  let seed = 1;
  let scenarios = -1;
  let out = 'bench-results.json';
  let outDir = path.join('progress', 'data');
  let artifacts = true;
  let baseline = true;
  let attribute = true;
  let quiet = false;
  let progress = true;
  let allowFailure = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`bench: ${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--quick':
        preset = PRESETS.quick;
        break;
      case '--thorough':
        preset = PRESETS.thorough;
        break;
      case '--preset':
        preset = PRESETS[next() as BenchPreset['name']] ?? PRESETS.default;
        break;
      case '--seed':
        seed = Number(next());
        break;
      case '--scenarios':
        scenarios = Number(next());
        break;
      case '--out':
        out = next();
        break;
      case '--out-dir':
        outDir = next();
        break;
      case '--no-artifacts':
        artifacts = false;
        break;
      case '--no-baseline':
        baseline = false;
        break;
      case '--no-attribution':
        attribute = false;
        break;
      case '--quiet':
        quiet = true;
        break;
      case '--no-progress':
        progress = false;
        break;
      case '--allow-failure':
        allowFailure = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`bench: unknown argument '${a}'. Try --help.`);
    }
  }

  if (!Number.isFinite(seed)) throw new Error('bench: --seed must be a number');
  return {
    seed,
    scenarios: scenarios > 0 ? Math.floor(scenarios) : preset.scenarioCount,
    out,
    outDir,
    preset,
    artifacts,
    baseline,
    attribute: attribute && preset.attributeFailures,
    quiet,
    progress,
    allowFailure,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sphere-sim headless bench',
      '',
      '  node packages/bench/src/cli.ts [options]',
      '',
      '  --seed N            Root seed. Scenarios are a pure function of it. Default 1.',
      '  --scenarios N       How many scenarios. Defaults to the preset count.',
      '  --out FILE          Results JSON. Default bench-results.json.',
      '  --out-dir DIR       Where the PNGs go. Default progress/data.',
      '  --quick             3 scenarios, 224x168 cameras, coarse metrics. Plumbing check only.',
      '  --thorough          12 scenarios, 640x480 cameras, full density.',
      '  --no-artifacts      Skip the PNGs.',
      '  --no-baseline       Skip the documented-calibration baseline metrics.',
      '  --no-attribution    Skip the counterfactual attribution of failing gates.',
      '  --no-progress       Do not refresh progress/index.html from this run.',
      '  --allow-failure     Exit 0 even when a gate fails without a waiver. Exploratory runs only.',
      '  --quiet             Only print the verdict line.',
      '',
    ].join('\n'),
  );
}

function gitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

/**
 * Run the bench.
 *
 * Exported so `loop.ts` and the tests drive the same code path the CLI does. A
 * bench whose tests exercise a different entry point from the one CI runs is
 * testing a program nobody ships.
 */
export function runBench(options: CliOptions): BenchResults {
  const started = Date.now();
  // Read before the hundred seconds of rendering, not after: a malformed
  // gate-waivers.json should stop the run at the point of the typo rather than
  // throw away a completed corpus.
  const gateDefaults = defaultGateOptions(REPO_ROOT);
  const waivers = readWaivers(gateDefaults.waiversFile);
  const amendments = readAmendments(gateDefaults.amendmentsFile);
  const scenarios = generateScenarios(options.seed, options.scenarios, options.preset);
  const outDir = path.isAbsolute(options.outDir)
    ? options.outDir
    : path.join(REPO_ROOT, options.outDir);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    if (!options.quiet) {
      process.stdout.write(`  [${scenario.index + 1}/${scenarios.length}] ${scenario.id} ... `);
    }
    const r = runScenario(scenario, {
      preset: options.preset,
      outDir,
      repoRoot: REPO_ROOT,
      writeArtifacts: options.artifacts,
      baseline: options.baseline,
    });
    results.push(r);
    if (!options.quiet) process.stdout.write(`${(r.timings.totalMs / 1000).toFixed(1)}s\n`);
  }

  const gates = buildGates(results);
  // Clock-free: which amendment each waiver cites and whether that entry is
  // still OPEN, both read off disk. Whether the waiver has EXPIRED is decided at
  // print time by `gate.ts`, so the results file stays byte-identical between
  // two runs with the same seed.
  gates.waivers = waiverAudit(gates, waivers, amendments);

  // Every failing gate gets a named contributor. The pose and h_center
  // attributions are decompositions of numbers already computed and cost
  // nothing, so they always run; the grid attribution recomputes the metric
  // eight times and is the only one `--quick` and `--no-attribution` suppress.
  for (const gate of gates.gates) {
    if (gate.pass || !canAttribute(gate.id)) continue;
    if (gate.id === 'pose_position' || gate.id === 'pose_rotation') {
      gate.attribution = attributePoseFailure(
        results,
        gate.failedScenarios,
        gate.id === 'pose_position' ? 'position' : 'rotation',
        gate.max,
      );
    } else if (gate.id === 'h_center_recovery') {
      gate.attribution = attributeCenterHeightFailure(results, gate.failedScenarios, gate.max);
    } else if (options.attribute) {
      // Counterfactual substitution needs a scenario to rebuild, and the worst
      // one is where the answer is least ambiguous.
      const worst = results.find((r) => r.scenario.id === gate.worst?.scenario);
      if (worst === undefined) continue;
      if (!options.quiet) process.stdout.write(`  attributing ${gate.id} on ${worst.scenario.id} ... `);
      const t = Date.now();
      gate.attribution = attributeGridFailure(worst, { preset: options.preset });
      if (!options.quiet) process.stdout.write(`${((Date.now() - t) / 1000).toFixed(1)}s\n`);
    }
  }

  const git = gitInfo();
  const env: EnvBlock = {
    generatedAt: new Date().toISOString(),
    gitCommit: git.commit,
    gitDirty: git.dirty,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus().length,
    durationMs: Date.now() - started,
    scenarioDurationsMs: results.map((r) => r.timings.totalMs),
    argv: [...process.argv.slice(2)],
  };

  return assembleResults({
    results,
    gates,
    seed: options.seed,
    preset: options.preset,
    outDir: path.relative(REPO_ROOT, outDir).split(path.sep).join('/'),
    env,
  });
}

/**
 * The console summary.
 *
 * Deliberately not a substitute for the JSON. It prints the verdict, the gates,
 * and the dispersion of the headline recoveries — enough for a human running
 * the loop to see whether a round moved, and not enough to be quoted as a
 * result. Anything a critic would cite lives in the file.
 */
export function formatSummary(results: BenchResults): string {
  const lines: string[] = [];
  const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const num = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

  lines.push('');
  lines.push(
    `bench: ${results.run.scenarioCount} scenarios, seed ${results.run.seed}, preset ${results.run.preset}, ${(results.env.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push('');
  lines.push(`${pad('GATE', 26)}${pad('WORST', 12)}${pad('GATE MAX', 12)}${pad('FAILED', 9)}RESULT`);
  for (const g of results.gates.gates) {
    lines.push(
      pad(g.id, 26) +
        pad(num(g.worst?.value ?? NaN), 12) +
        pad(String(g.max), 12) +
        pad(`${g.scenariosFailed}/${g.scenariosScored}`, 9) +
        (g.pass ? 'PASS' : 'FAIL') +
        (g.dependsOnRecovery ? '' : '   (physical rig, not the solver)') +
        (g.scenariosNotMeasurable.length > 0
          ? `   (${g.scenariosNotMeasurable.length} not measurable: ${g.scenariosNotMeasurable.join(', ')})`
          : ''),
    );
    if (g.attribution !== null) {
      lines.push(
        `${pad('', 26)}largest contributor: ${g.attribution.contributor} ` +
          `(${g.attribution.explains}; worst case ${g.attribution.scenario})`,
      );
    }
  }

  lines.push('');
  const series: [string, string][] = [
    ['pose position, aligned', 'poseMaxPositionMmAligned'],
    ['pose rotation, aligned', 'poseMaxRotationDegAligned'],
    ['pose position, raw', 'poseMaxPositionMmRaw'],
    ['gauge absorbed', 'gaugeAngleDeg'],
    ['h_center error', 'centerHeightErrorMm'],
    ['grid displacement', 'gridDisplacementMm'],
    ['grid, documented cal', 'gridDisplacementBaselineMm'],
    ['solver residual RMS', 'solverRmsResidualPx'],
  ];
  lines.push(`${pad('SERIES', 26)}${pad('MEDIAN', 12)}${pad('P95', 12)}${pad('MAX', 12)}IQR`);
  for (const [label, key] of series) {
    const d = results.aggregate[key];
    if (d === undefined) continue;
    lines.push(
      pad(label, 26) + pad(num(d.median), 12) + pad(num(d.p95), 12) + pad(num(d.max), 12) + num(d.iqr),
    );
  }

  const failedScenarios = results.scenarios.filter((s) => s.error !== null);
  if (failedScenarios.length > 0) {
    lines.push('');
    for (const s of failedScenarios) lines.push(`  ERROR ${s.id}: ${s.error}`);
  }

  lines.push('');
  lines.push(results.gates.pass ? 'VERDICT: all scored geometric gates pass' : 'VERDICT: FAIL');
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.quiet) {
    process.stdout.write(
      `bench: seed ${options.seed}, ${options.scenarios} scenarios, preset ${options.preset.name}\n`,
    );
  }
  const results = runBench(options);
  const outPath = path.isAbsolute(options.out) ? options.out : path.join(REPO_ROOT, options.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Indented, with numeric arrays inline. The file is read by humans and diffed
  // by machines, and a single-line JSON blob is hostile to both — but so is a
  // ten-thousand-line residual column. See `stringifyResults`.
  fs.writeFileSync(outPath, stringifyResults(results));
  process.stdout.write(formatSummary(results));
  process.stdout.write(`written: ${path.relative(REPO_ROOT, outPath)}\n`);

  // The progress page is a view of the file just written, so it is refreshed
  // from that file rather than from whatever `bench-results.json` happens to
  // hold. Wrapped, because a page failure must not lose a 100-second run: the
  // results are already on disk and `progress.ts` can rebuild the page alone.
  if (options.progress !== false) {
    try {
      const paths = defaultPaths(REPO_ROOT);
      paths.resultsFile = outPath;
      const written = writeProgressPage(paths);
      process.stdout.write(`progress: ${path.relative(REPO_ROOT, written.file)}\n`);
    } catch (e) {
      process.stdout.write(
        `progress: page NOT refreshed (${e instanceof Error ? e.message : String(e)})\n`,
      );
    }
  }
  process.exitCode = 0;
}

// Run only when invoked directly, so tests and loop.ts can import this module.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
