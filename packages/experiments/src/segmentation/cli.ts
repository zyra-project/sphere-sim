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

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compact } from '../photometric/cli.ts';
import type { Cell, PointRun } from '../spill/run.ts';
import { runPoint } from '../spill/run.ts';
import {
  ARCHETYPE_INDEX,
  ARMS,
  EXPERIMENT_ROOT_SEED,
  SEED_COUNT,
  WALL_RADIUS_M,
} from './design.ts';
import { renderSegmentationSvg } from './plot.ts';
import { assemble, buildResult } from './run.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(ROOT, 'experiments');
const WORK = path.join(OUT, '.experiment-5-partial');

const CHECKPOINT_SCHEMA = 'sphere-sim/experiment-5-checkpoint@1';

/** A checkpoint says what produced it, not only what it holds. */
interface Checkpoint {
  schema: string;
  /** The design constants and the code that turn a seed index into a run. */
  fingerprint: string;
  arm: string;
  runs: PointRun[];
}

/**
 * Everything a resumed seed has to agree with.
 *
 * A checkpoint is a measurement taken by a particular build against a particular
 * design, and a directory of them is trusted for its arm names and its counts
 * alone unless something records which build that was. Change the root seed, an
 * arm's spec, or anything in the render/solve path, and the surviving files
 * would be published under the CURRENT `generatedFrom` — the run would carry
 * provenance for code that did not produce it, and a sweep interrupted across a
 * change would mix two builds inside one arm.
 *
 * So: the design values, plus the bytes of every source file that decides what a
 * run is. The plot and the aggregation are deliberately NOT in it — they read
 * the measurements afterwards and cannot change them, and invalidating fifty
 * minutes of solves over an edit to an axis label would teach the operator to
 * delete this check.
 */
const MEASUREMENT_SOURCES = [
  'packages/sim/src',
  'packages/solver/src',
  'packages/bench/src',
  'packages/calibration/src',
  'packages/experiments/src/spill/run.ts',
  'packages/experiments/src/segmentation/design.ts',
];

function fingerprint(): string {
  const h = crypto.createHash('sha256');
  h.update(
    JSON.stringify({
      rootSeed: EXPERIMENT_ROOT_SEED,
      seedCount: SEED_COUNT,
      archetypeIndex: ARCHETYPE_INDEX,
      wallRadiusM: WALL_RADIUS_M,
      arms: ARMS.map((a) => ({ key: a.key, spec: a.spec })),
    }),
  );
  for (const rel of MEASUREMENT_SOURCES) {
    for (const file of sourceFiles(path.join(ROOT, rel))) {
      h.update(path.relative(ROOT, file));
      h.update(fs.readFileSync(file));
    }
  }
  return h.digest('hex').slice(0, 16);
}

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
 * Read one arm's checkpoint, or refuse.
 *
 * Refusing means stopping the whole sweep rather than starting the arm again:
 * these files cost about six minutes each and only the person at the keyboard
 * knows whether the old ones are still wanted. `EXPERIMENT5_ACCEPT_STALE=1` says
 * they are, deliberately, and then the mixing is on the record instead of silent.
 */
function readCheckpoint(file: string, arm: string, want: string): PointRun[] {
  if (!fs.existsSync(file)) return [];
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stale = (why: string): PointRun[] => {
    if (process.env.EXPERIMENT5_ACCEPT_STALE === '1') {
      process.stdout.write(`  ${arm}: ${why} — accepted anyway (EXPERIMENT5_ACCEPT_STALE=1)\n`);
      return Array.isArray(raw) ? (raw as PointRun[]) : ((raw as Checkpoint).runs ?? []);
    }
    process.stderr.write(
      `\n${path.relative(ROOT, file)}: ${why}.\n\n` +
        `  These are measurements from a different build or a different design, and resuming\n` +
        `  would publish them under this one's provenance. Delete the checkpoint directory to\n` +
        `  re-measure, or set EXPERIMENT5_ACCEPT_STALE=1 to use them knowing what they are:\n\n` +
        `    rm -rf ${path.relative(ROOT, WORK)}\n\n`,
    );
    process.exit(1);
  };

  if (Array.isArray(raw)) return stale('a checkpoint with no schema or fingerprint');
  const cp = raw as Partial<Checkpoint>;
  if (cp.schema !== CHECKPOINT_SCHEMA) return stale(`schema ${String(cp.schema)}, expected ${CHECKPOINT_SCHEMA}`);
  if (cp.arm !== arm) return stale(`arm ${String(cp.arm)}, expected ${arm}`);
  if (cp.fingerprint !== want) return stale(`fingerprint ${String(cp.fingerprint)}, expected ${want}`);
  return cp.runs ?? [];
}

function writeCheckpoint(file: string, arm: string, want: string, runs: PointRun[]): void {
  const cp: Checkpoint = { schema: CHECKPOINT_SCHEMA, fingerprint: want, arm, runs };
  fs.writeFileSync(file, `${JSON.stringify(cp)}\n`);
}

export function main(): void {
  const only = process.argv.includes('--arm')
    ? process.argv[process.argv.indexOf('--arm') + 1]
    : null;

  fs.mkdirSync(WORK, { recursive: true });

  const want = fingerprint();
  process.stdout.write(`design and measurement code: ${want}\n`);

  const t0 = Date.now();
  for (const arm of ARMS) {
    if (only !== null && arm.key !== only) continue;
    const file = path.join(WORK, `${arm.key}.json`);
    // Per SEED, not per arm. A long-throw arm is nearly nine minutes of solves,
    // and losing all of it to an interrupted process was a real cost paid twice
    // before this loop was written this way.
    const runs: PointRun[] = readCheckpoint(file, arm.key, want);
    if (runs.length >= SEED_COUNT) {
      process.stdout.write(`  ${arm.key}: ${runs.length} seeds already on disk, skipping\n`);
      continue;
    }
    if (runs.length > 0) {
      process.stdout.write(`  ${arm.key}: resuming at seed ${runs.length}\n`);
    }
    for (let i = runs.length; i < SEED_COUNT; i++) {
      runs.push(runPoint(arm.spec, i));
      writeCheckpoint(file, arm.key, want, runs);
      process.stdout.write(`  ${arm.key} ${i + 1}/${SEED_COUNT}\n`);
    }
    process.stdout.write(`  ${arm.key}: ${runs.length} seeds\n`);
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
    const runs = readCheckpoint(file, arm.key, want);
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
    fs.writeFileSync(path.join(OUT, 'experiment-5.svg'), renderSegmentationSvg(result));
    process.stdout.write(`\nexperiment 5 verdict: ${result.verdict.statement}\n`);
  }
  process.stdout.write(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
}

// Only when invoked directly, so the dispatcher can import `main` without
// running it — the same guard `spill/cli.ts` uses and for the same reason.
if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main();
}
