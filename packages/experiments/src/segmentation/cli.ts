/**
 * `npm run experiment5` — 150 solves.
 *
 * Runs one arm at a time and checkpoints after each, because a twenty-minute
 * process is not a safe unit of work in every environment this has to run in.
 * Re-invoking picks up whatever is already on disk, so an interrupted sweep
 * costs the arm it was in the middle of and nothing else.
 *
 *   node .../cli.ts             every arm, resuming from checkpoints
 *   node .../cli.ts --arm image just that arm
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compact } from '../photometric/cli.ts';
import type { Cell, PointRun } from '../spill/run.ts';
import { runPoint } from '../spill/run.ts';
import { ARMS, SEED_COUNT } from './design.ts';
import { assemble, buildResult } from './run.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(ROOT, 'experiments');
const WORK = path.join(OUT, '.experiment-5-partial');

const only = process.argv.includes('--arm')
  ? process.argv[process.argv.indexOf('--arm') + 1]
  : null;

fs.mkdirSync(WORK, { recursive: true });

const t0 = Date.now();
for (const arm of ARMS) {
  if (only !== null && arm.key !== only) continue;
  const file = path.join(WORK, `${arm.key}.json`);
  if (fs.existsSync(file)) {
    const have = JSON.parse(fs.readFileSync(file, 'utf8')) as PointRun[];
    if (have.length >= SEED_COUNT) {
      process.stdout.write(`  ${arm.key}: ${have.length} seeds already on disk, skipping\n`);
      continue;
    }
  }
  const runs: PointRun[] = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    runs.push(runPoint(arm.spec, i));
    process.stdout.write(`  ${arm.key} ${i + 1}/${SEED_COUNT}\n`);
  }
  fs.writeFileSync(file, `${JSON.stringify(runs)}\n`);
  process.stdout.write(`  ${arm.key}: wrote ${runs.length} seeds\n`);
}

// Assemble only when every arm is present, so a partial sweep never writes a
// results file that looks complete.
const cells: Record<string, Cell> = {};
const missing: string[] = [];
for (const arm of ARMS) {
  const file = path.join(WORK, `${arm.key}.json`);
  if (!fs.existsSync(file)) {
    missing.push(arm.key);
    continue;
  }
  const runs = JSON.parse(fs.readFileSync(file, 'utf8')) as PointRun[];
  if (runs.length < SEED_COUNT) missing.push(arm.key);
  else cells[arm.key] = assemble(runs);
}

if (missing.length > 0) {
  process.stdout.write(`\nnot writing a results file: arms still missing — ${missing.join(', ')}\n`);
} else {
  const result = buildResult(cells);
  fs.writeFileSync(
    path.join(OUT, 'experiment-5.json'),
    `${JSON.stringify(compact(result), null, 1)}\n`,
  );
  process.stdout.write(`\nexperiment 5 verdict: ${result.verdict.statement}\n`);
}
process.stdout.write(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
