// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run experiment6` — 4 arms x 2 bodies x 33 seeds = 264 solves.
 *
 * Appends each point to a JSONL file as it lands and skips points already in
 * it, so an interrupted sweep costs the point it was in the middle of and
 * nothing else. Re-invoking resumes; `--fresh` starts over.
 *
 *   node .../cli.ts              every arm, resuming
 *   node .../cli.ts --arm free   just that arm
 *   node .../cli.ts --seeds 6    a short run, for plumbing
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Body } from './design.ts';
import { ARMS, BODIES, DOCUMENTED_SEEDS, EXPERIMENT_ROOT_SEED, SEED_COUNT } from './design.ts';
import type { PointRun } from './run.ts';
import { median, runPoint, seedFor, worst } from './run.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(ROOT, 'experiments');
const FILE = path.join(OUT, 'experiment-6-meshrot.jsonl');

function parseArgs(argv: string[]): { arm: string | null; seeds: number; fresh: boolean } {
  let arm: string | null = null;
  let seeds = SEED_COUNT;
  let fresh = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arm') arm = argv[++i];
    else if (argv[i] === '--seeds') seeds = Number(argv[++i]);
    else if (argv[i] === '--fresh') fresh = true;
    else throw new Error(`experiment6: unknown argument '${argv[i]}'`);
  }
  if (!Number.isFinite(seeds) || seeds < 1) throw new Error('experiment6: --seeds must be >= 1');
  return { arm, seeds, fresh };
}

function load(): PointRun[] {
  if (!fs.existsSync(FILE)) return [];
  return fs
    .readFileSync(FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as PointRun);
}

const key = (arm: string, body: string, seed: number): string => `${arm}|${body}|${seed}`;

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT, { recursive: true });
  if (opts.fresh && fs.existsSync(FILE)) fs.rmSync(FILE);

  const done = new Set(load().map((r) => key(r.arm, r.body, r.seed)));
  const arms = opts.arm === null ? ARMS : ARMS.filter((a) => a.key === opts.arm);
  if (arms.length === 0) throw new Error(`experiment6: no arm named '${opts.arm}'`);

  // The documented seeds first and flagged, so the sweep reproduces the number
  // it set out to explain before it averages over anything.
  const seeds: { seed: number; documented: boolean }[] = [
    ...DOCUMENTED_SEEDS.map((s) => ({ seed: s, documented: true })),
    ...Array.from({ length: opts.seeds }, (_, i) => ({ seed: seedFor(i), documented: false })),
  ];

  const total = arms.length * BODIES.length * seeds.length;
  let n = 0;
  for (const arm of arms) {
    for (const { seed, documented } of seeds) {
      for (const body of BODIES) {
        n++;
        if (done.has(key(arm.key, body, seed))) continue;
        const r = runPoint(arm, body as Body, seed, documented);
        fs.appendFileSync(FILE, `${JSON.stringify(r)}\n`);
        process.stdout.write(
          `[${String(n).padStart(3)}/${total}] ${arm.key.padEnd(14)} ${body.padEnd(8)} ` +
            `seed ${String(seed).padEnd(10)} rot ${r.poseRotationDeg.toFixed(4)} ` +
            `pos ${r.posePositionMm.toFixed(1).padStart(7)} resid ${r.residualRmsPx.toFixed(4)} ` +
            `${r.converged ? '' : 'NOT-CONVERGED '}${r.seconds.toFixed(0)}s\n`,
        );
      }
    }
  }
  const runs = load();
  assemble(runs);
  report(runs);
}

const RESULT = path.join(OUT, 'experiment-6.json');
const SCHEMA = 'sphere-sim/experiment-6@1';

/**
 * The assembled result, which is the tracked artefact.
 *
 * The JSONL beside it is a resumable POINT LOG and is ignored by git, the same
 * split experiment 5 makes between `.experiment-5-partial/` and
 * `experiment-5.json`: a checkpoint is a place to resume from, not a
 * measurement anybody should cite.
 */
function assemble(runs: PointRun[]): void {
  const complete = ARMS.length * BODIES.length * (DOCUMENTED_SEEDS.length + SEED_COUNT);
  const summary: Record<string, unknown>[] = [];
  for (const scope of ['documented', 'all'] as const) {
    const rows = scope === 'documented' ? runs.filter((r) => r.documented) : runs;
    for (const arm of ARMS) {
      const mesh = rows.filter((r) => r.arm === arm.key && r.body === 'mesh');
      const sphere = rows.filter((r) => r.arm === arm.key && r.body === 'nominal');
      if (mesh.length === 0 || sphere.length === 0) continue;
      summary.push({
        scope,
        arm: arm.key,
        question: arm.question,
        n: mesh.length,
        meshMedianRotDeg: median(mesh.map((r) => r.poseRotationDeg)),
        sphereMedianRotDeg: median(sphere.map((r) => r.poseRotationDeg)),
        meshWorstRotDeg: worst(mesh.map((r) => r.poseRotationDeg)),
        sphereWorstRotDeg: worst(sphere.map((r) => r.poseRotationDeg)),
        meshMedianPosMm: median(mesh.map((r) => r.posePositionMm)),
        sphereMedianPosMm: median(sphere.map((r) => r.posePositionMm)),
        meshMedianResidualPx: median(mesh.map((r) => r.residualRmsPx)),
        sphereMedianResidualPx: median(sphere.map((r) => r.residualRmsPx)),
        meshNotConverged: mesh.filter((r) => !r.converged).length,
        sphereNotConverged: sphere.filter((r) => !r.converged).length,
      });
    }
  }
  fs.writeFileSync(
    RESULT,
    `${JSON.stringify(
      {
        schema: SCHEMA,
        // Says so in the file rather than only in whatever prose cites it.
        provisional: runs.length < complete,
        provisionalNote:
          runs.length < complete
            ? `${runs.length} of ${complete} points. An arm short of its seeds is not a result.`
            : '',
        generatedFrom: {
          rootSeed: EXPERIMENT_ROOT_SEED,
          seedCount: SEED_COUNT,
          documentedSeeds: DOCUMENTED_SEEDS,
          arms: ARMS,
          bodies: BODIES,
        },
        summary,
        runs,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\nwritten: ${path.relative(ROOT, RESULT)}\n`);
}

function report(runs: PointRun[]): void {
  const out: string[] = [];
  out.push('');
  out.push('EXPERIMENT 6 — what the ellipsoid\'s extra rotation is made of');
  out.push('');
  for (const scope of ['documented', 'all'] as const) {
    const rows = scope === 'documented' ? runs.filter((r) => r.documented) : runs;
    if (rows.length === 0) continue;
    const seeds = new Set(rows.map((r) => r.seed)).size;
    out.push(`## ${scope === 'documented' ? "the document's own three seeds" : `all ${seeds} seeds`}`);
    out.push('');
    out.push('arm             body      median rot   worst rot   median pos   median resid    n');
    for (const arm of ARMS) {
      for (const body of BODIES) {
        const rs = rows.filter((r) => r.arm === arm.key && r.body === body);
        if (rs.length === 0) continue;
        out.push(
          `${arm.key.padEnd(15)} ${body.padEnd(9)} ` +
            `${median(rs.map((r) => r.poseRotationDeg)).toFixed(4).padStart(10)} ` +
            `${worst(rs.map((r) => r.poseRotationDeg)).toFixed(4).padStart(11)} ` +
            `${median(rs.map((r) => r.posePositionMm)).toFixed(1).padStart(12)} ` +
            `${median(rs.map((r) => r.residualRmsPx)).toFixed(4).padStart(14)} ` +
            `${String(rs.length).padStart(4)}`,
        );
      }
    }
    out.push('');
    // THE ANSWER, stated as the ratio the question was asked in.
    out.push('arm             mesh/sphere median rot     mesh rot vs its own free arm');
    const freeMesh = median(
      rows.filter((r) => r.arm === 'free' && r.body === 'mesh').map((r) => r.poseRotationDeg),
    );
    for (const arm of ARMS) {
      const m = median(
        rows.filter((r) => r.arm === arm.key && r.body === 'mesh').map((r) => r.poseRotationDeg),
      );
      const s = median(
        rows.filter((r) => r.arm === arm.key && r.body === 'nominal').map((r) => r.poseRotationDeg),
      );
      if (!Number.isFinite(m) || !Number.isFinite(s)) continue;
      out.push(
        `${arm.key.padEnd(15)} ${(m / s).toFixed(2).padStart(20)}x ` +
          `${((1 - m / freeMesh) * 100).toFixed(1).padStart(28)}% removed`,
      );
    }
    out.push('');
  }
  process.stdout.write(out.join('\n'));
}

main();
