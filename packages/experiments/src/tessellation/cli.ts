// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run experiment7` — 10 arms x 13 seeds = 130 solves.
 *
 * Appends each point to a JSONL file as it lands and skips points already in
 * it, so an interrupted sweep costs the point it was in the middle of and
 * nothing else. Re-invoking resumes; `--fresh` starts over.
 *
 *   node .../cli.ts                    every arm, resuming
 *   node .../cli.ts --arm 64x128       just that arm
 *   node .../cli.ts --seeds 2          a short run, for plumbing
 *   node .../cli.ts --report-only      re-assemble the checkpoint, solve nothing
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARMS, DOCUMENTED_SEEDS, EXPERIMENT_ROOT_SEED, SEED_COUNT } from './design.ts';
import type { PointRun } from './run.ts';
import { runPoint, seedFor } from './run.ts';
import type { Summary } from './summarize.ts';
import { COMPLETE_POINTS, mechanismRows, report, summarize } from './summarize.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(ROOT, 'experiments');
const FILE = path.join(OUT, 'experiment-7-tessellation.jsonl');

function parseArgs(argv: string[]): {
  arm: string | null;
  seeds: number;
  fresh: boolean;
  reportOnly: boolean;
} {
  let arm: string | null = null;
  let seeds = SEED_COUNT;
  let fresh = false;
  let reportOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arm') arm = argv[++i];
    else if (argv[i] === '--seeds') seeds = Number(argv[++i]);
    else if (argv[i] === '--fresh') fresh = true;
    // Re-assemble from the checkpoint and solve nothing. For reading a sweep
    // that is still running, and for regenerating the results file after a
    // change to how it is summarised — neither of which should cost an hour.
    else if (argv[i] === '--report-only') reportOnly = true;
    else throw new Error(`experiment7: unknown argument '${argv[i]}'`);
  }
  // Integer, and no more than the design — experiment 6's lesson, where a value
  // above SEED_COUNT produced a file that called itself complete while its
  // stated provenance still published the design's number.
  if (!Number.isInteger(seeds) || seeds < 1) {
    throw new Error('experiment7: --seeds must be a whole number >= 1');
  }
  if (seeds > SEED_COUNT) {
    throw new Error(
      `experiment7: --seeds is for SHORT runs; ${seeds} exceeds the design's ${SEED_COUNT}. ` +
        'Raise SEED_COUNT in design.ts instead, so the provenance moves with it.',
    );
  }
  if (reportOnly && fresh) {
    throw new Error('experiment7: --report-only reads the checkpoint; --fresh deletes it');
  }
  return { arm, seeds, fresh, reportOnly };
}

function load(): PointRun[] {
  if (!fs.existsSync(FILE)) return [];
  const lines = fs
    .readFileSync(FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const out: PointRun[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]) as PointRun);
    } catch (err) {
      // A TORN LAST LINE is expected and survivable: `--report-only` exists to
      // read this file while a sweep is still appending to it, and a reader can
      // catch the moment between a write starting and finishing. The point is
      // simply not there yet, and the next invocation will solve it again
      // because `done` will not contain it.
      //
      // Anywhere ELSE in the file is corruption, not a race, and resuming over
      // it would silently skip whatever points followed.
      if (i !== lines.length - 1) {
        throw new Error(`experiment7: ${path.basename(FILE)} line ${i + 1} is not JSON: ${String(err)}`);
      }
    }
  }
  return out;
}

const key = (arm: string, seed: number): string => `${arm}|${seed}`;

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT, { recursive: true });
  if (opts.fresh && fs.existsSync(FILE)) fs.rmSync(FILE);

  if (opts.reportOnly) {
    const existing = load();
    report(write(summarize(existing), existing), existing);
    return;
  }

  const done = new Set(load().map((r) => key(r.arm, r.seed)));
  const arms = opts.arm === null ? ARMS : ARMS.filter((a) => a.key === opts.arm);
  if (arms.length === 0) throw new Error(`experiment7: no arm named '${opts.arm}'`);

  // The documented seed first and flagged, so the sweep reproduces the number
  // it set out to explain before it averages over anything.
  const seeds: { seed: number; documented: boolean }[] = [
    ...DOCUMENTED_SEEDS.map((s) => ({ seed: s, documented: true })),
    ...Array.from({ length: opts.seeds }, (_, i) => ({ seed: seedFor(i), documented: false })),
  ];

  // SEED-MAJOR, not arm-major. Every comparison in this table is paired across
  // arms on one seed, and the drop policy needs a seed present in all of them;
  // finishing seeds rather than arms means an interrupted sweep leaves whole
  // usable seeds behind instead of one complete arm and five partial ones.
  const total = arms.length * seeds.length;
  let n = 0;
  for (const { seed, documented } of seeds) {
    for (const arm of arms) {
      n++;
      if (done.has(key(arm.key, seed))) continue;
      const r = runPoint(arm, seed, documented);
      fs.appendFileSync(FILE, `${JSON.stringify(r)}\n`);
      process.stdout.write(
        `[${String(n).padStart(3)}/${total}] ${arm.key.padEnd(15)} ` +
          `seed ${String(seed).padEnd(10)} pos ${r.posePositionMm.toFixed(1).padStart(7)} ` +
          `rot ${r.poseRotationDeg.toFixed(4)} resid ${r.residualRmsPx.toFixed(4)} ` +
          `iters ${String(r.iterations).padStart(3)} gauge ${r.gaugeConstraints} ` +
          `${r.converged ? '' : `STOPPED:${r.stopReason} `}${r.seconds.toFixed(0)}s\n`,
      );
    }
  }
  const runs = load();
  report(write(summarize(runs), runs), runs);
}

const RESULT = path.join(OUT, 'experiment-7.json');
const SCHEMA = 'sphere-sim/experiment-7@1';

/**
 * Write the assembled result and hand back what was summarised.
 *
 * The tracked artefact. The JSONL beside it is a resumable POINT LOG and is
 * ignored by git — the same split experiment 5 makes between
 * `.experiment-5-partial/` and `experiment-5.json`: a checkpoint is a place to
 * resume from, not a measurement anybody should cite.
 */
function write(summary: Summary[], runs: readonly PointRun[]): Summary[] {
  fs.writeFileSync(
    RESULT,
    `${JSON.stringify(
      {
        schema: SCHEMA,
        // Says so in the file rather than only in whatever prose cites it.
        provisional: runs.length < COMPLETE_POINTS,
        provisionalNote:
          runs.length < COMPLETE_POINTS
            ? `${runs.length} of ${COMPLETE_POINTS} points. An arm short of its seeds is not a result.`
            : '',
        generatedFrom: {
          rootSeed: EXPERIMENT_ROOT_SEED,
          seedCount: SEED_COUNT,
          seedsPresent: new Set(runs.map((r) => r.seed)).size,
          documentedSeeds: DOCUMENTED_SEEDS,
          arms: ARMS,
        },
        /**
         * The numbers the experiment was designed around, stated rather than
         * left to a reader to divide two rows: for each pair, how much of what
         * the facet arm costs over its control the smooth normal takes back.
         * 100% means the derivative was the whole of it, 0% that it was none of
         * it, and a negative number that smoothing made it worse.
         */
        mechanism: mechanismRows(
          summary.filter((s) => s.scope === 'all'),
          runs,
        ),
        summary,
        runs,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\nwritten: ${path.relative(ROOT, RESULT)}\n`);
  return summary;
}

main();
