/**
 * The gate step — the thing that actually fails the build.
 *
 *     node packages/bench/src/gate.ts bench-results.json
 *     node packages/bench/src/gate.ts bench-results.json --allow-failure
 *
 * Separate from `cli.ts` on purpose, and the separation is the argument: the
 * bench MEASURES, this JUDGES. CI runs the bench twice (the second time to check
 * determinism) and neither run should decide anything; one judgement, made once,
 * on the file that was written, is easier to reason about than two runs that
 * each carry an exit code. It also means a judgement can be re-made — against a
 * different waiver file, on an older results file, in a review — without
 * spending a hundred seconds re-rendering the corpus.
 *
 * Exit codes:
 *   0  every scored, non-provisional gate passed or is covered by a waiver
 *      that is in force (see `waivers.ts`), or `--allow-failure` was given.
 *   1  at least one such gate failed uncovered, or a waiver stopped being an
 *      accurate statement (expired, amendment resolved, ceiling exceeded,
 *      scenario out of scope, citation unresolvable).
 *   2  the results file or the waiver file could not be read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchResults } from './results.ts';
import type { Evaluation } from './waivers.ts';
import { evaluateGates, formatEvaluation, readAmendments, readWaivers } from './waivers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface GateOptions {
  resultsFile: string;
  waiversFile: string;
  amendmentsFile: string;
  allowFailure: boolean;
  now: Date;
}

export function defaultGateOptions(repoRoot = REPO_ROOT): GateOptions {
  return {
    resultsFile: path.join(repoRoot, 'bench-results.json'),
    waiversFile: path.join(repoRoot, 'gate-waivers.json'),
    amendmentsFile: path.join(repoRoot, 'docs', 'AMENDMENTS.md'),
    allowFailure: false,
    now: new Date(),
  };
}

export function parseGateArgs(argv: readonly string[], repoRoot = REPO_ROOT): GateOptions {
  const options = defaultGateOptions(repoRoot);
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`gate: ${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--allow-failure':
        options.allowFailure = true;
        break;
      case '--waivers':
        options.waiversFile = path.resolve(repoRoot, next());
        break;
      case '--amendments':
        options.amendmentsFile = path.resolve(repoRoot, next());
        break;
      // A fixed clock, so a CI run and a local run judge the same waivers, and
      // so the tests do not go red on their own one morning.
      case '--as-of':
        options.now = new Date(`${next()}T12:00:00Z`);
        break;
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        if (a.startsWith('-')) throw new Error(`gate: unknown argument '${a}'. Try --help.`);
        if (positional > 0) throw new Error('gate: pass exactly one results file');
        options.resultsFile = path.resolve(repoRoot, a);
        positional++;
    }
  }
  if (!Number.isFinite(options.now.getTime())) throw new Error('gate: --as-of must be YYYY-MM-DD');
  return options;
}

const HELP = [
  'sphere-sim gate — judge a bench results file against PARAMETERS.md §7 and gate-waivers.json',
  '',
  '  node packages/bench/src/gate.ts [results.json] [options]',
  '',
  '  --allow-failure     Report, do not fail. For exploratory runs only.',
  '  --waivers FILE      Waiver file. Default gate-waivers.json.',
  '  --amendments FILE   Default docs/AMENDMENTS.md. A waiver cites an entry in it.',
  '  --as-of YYYY-MM-DD  Judge waiver expiry against this date rather than today.',
  '',
].join('\n');

/** Judge a results file. Exported so `cli.ts` and the tests share one code path. */
export function judge(options: GateOptions): { evaluation: Evaluation; text: string } {
  const results = JSON.parse(fs.readFileSync(options.resultsFile, 'utf8')) as BenchResults;
  const waivers = readWaivers(options.waiversFile);
  const amendments = readAmendments(options.amendmentsFile);
  const archetypeById = new Map<string, string>(
    (results.scenarios ?? []).map((s) => [s.id, s.archetype]),
  );
  const evaluation = evaluateGates({
    gates: results.gates,
    archetypeById,
    waivers,
    amendments,
    now: options.now,
  });
  return { evaluation, text: formatEvaluation(evaluation, options.allowFailure) };
}

function main(): void {
  let options: GateOptions;
  try {
    options = parseGateArgs(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
    return;
  }
  let judged: { evaluation: Evaluation; text: string };
  try {
    judged = judge(options);
  } catch (e) {
    process.stdout.write(
      `gate: cannot judge ${path.relative(REPO_ROOT, options.resultsFile)}: ` +
        `${e instanceof Error ? e.message : String(e)}\n`,
    );
    // Distinct from a gate failure. "The bar could not be read" and "the bar was
    // not met" are different sentences and a reader must not have to guess.
    process.exitCode = 2;
    return;
  }
  process.stdout.write(judged.text);
  process.exitCode = judged.evaluation.ok || options.allowFailure ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
