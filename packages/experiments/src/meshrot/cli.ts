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
  // Integer, and no more than the design. A fraction is silently truncated by
  // `Array.from({ length })`, and a value ABOVE the design used to produce a
  // file that called itself complete — `provisional` compared the run count to
  // a constant derived from SEED_COUNT, so more points than designed cleared
  // the bar — while `generatedFrom.seedCount` still published 30. A result that
  // misdescribes its own provenance is worse than a short one that admits it.
  if (!Number.isInteger(seeds) || seeds < 1) {
    throw new Error('experiment6: --seeds must be a whole number >= 1');
  }
  if (seeds > SEED_COUNT) {
    throw new Error(
      `experiment6: --seeds is for SHORT runs; ${seeds} exceeds the design's ${SEED_COUNT}. ` +
        'Raise SEED_COUNT in design.ts instead, so the provenance moves with it.',
    );
  }
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
  report(assemble(runs));
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
/**
 * One arm's figures at one scope, computed once and rendered wherever needed.
 *
 * Named as a type rather than left inline because two callers read it — the
 * results file and the terminal report — and the whole point of the shape is
 * that they cannot disagree.
 */
interface Summary {
  scope: 'documented' | 'all';
  arm: string;
  question: string;
  n: number;
  seedsDropped: number;
  meshMedianRotDeg: number;
  sphereMedianRotDeg: number;
  meshWorstRotDeg: number;
  sphereWorstRotDeg: number;
  meshMedianPosMm: number;
  sphereMedianPosMm: number;
  meshMedianResidualPx: number;
  sphereMedianResidualPx: number;
  meshNotConverged: number;
  sphereNotConverged: number;
}

function assemble(runs: PointRun[]): Summary[] {
  const complete = ARMS.length * BODIES.length * (DOCUMENTED_SEEDS.length + SEED_COUNT);
  const summary: Summary[] = [];
  for (const scope of ['documented', 'all'] as const) {
    const rows = scope === 'documented' ? runs.filter((r) => r.documented) : runs;
    for (const arm of ARMS) {
      const allMesh = rows.filter((r) => r.arm === arm.key && r.body === 'mesh');
      const allSphere = rows.filter((r) => r.arm === arm.key && r.body === 'nominal');
      if (allMesh.length === 0 || allSphere.length === 0) continue;

      // A SEED COUNTS ONLY IF BOTH ITS BODIES SETTLED, and the rule is not
      // fastidiousness. The page refuses a solve that stopped at its iteration
      // cap — `solveInstalled` in packages/web/src/display.ts — so a
      // non-converged endpoint is a calibration nobody would be allowed to
      // install, and averaging it in publishes a refused solve as the arm's
      // result. That is not hypothetical here: seed 286650231 failed to
      // converge in `nominal-tight`/`mesh` and its value WAS the published
      // median for that arm, 0.1518 against the converged-only 0.1583. An
      // earlier draft of this file said medians made that safe. A median is
      // robust to an outlier's MAGNITUDE, not to its presence in the middle.
      //
      // Both bodies, because the headline is a RATIO. Dropping a failed mesh
      // while keeping its sphere would compare the two over different seed
      // sets, which is the paired-comparison rule this whole design rests on —
      // `bench/test/scenarios.test.ts` enforces the same pairing upstream.
      const failed = new Set<number>();
      for (const r of [...allMesh, ...allSphere]) if (!r.converged) failed.add(r.seed);
      const mesh = allMesh.filter((r) => !failed.has(r.seed));
      const sphere = allSphere.filter((r) => !failed.has(r.seed));
      if (mesh.length === 0 || sphere.length === 0) continue;
      summary.push({
        scope,
        arm: arm.key,
        question: arm.question,
        n: mesh.length,
        /** Seeds dropped because one body or the other never settled. */
        seedsDropped: failed.size,
        meshMedianRotDeg: median(mesh.map((r) => r.poseRotationDeg)),
        sphereMedianRotDeg: median(sphere.map((r) => r.poseRotationDeg)),
        meshWorstRotDeg: worst(mesh.map((r) => r.poseRotationDeg)),
        sphereWorstRotDeg: worst(sphere.map((r) => r.poseRotationDeg)),
        meshMedianPosMm: median(mesh.map((r) => r.posePositionMm)),
        sphereMedianPosMm: median(sphere.map((r) => r.posePositionMm)),
        meshMedianResidualPx: median(mesh.map((r) => r.residualRmsPx)),
        sphereMedianResidualPx: median(sphere.map((r) => r.residualRmsPx)),
        // Zero by construction now; kept so the file states the policy held
        // rather than leaving a reader to infer it from the counts.
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
          // The DESIGN's count, and beside it what this file actually holds.
          // They agree on a full run and differ on a short one, and a reader
          // should not have to count `runs` to find out which they have.
          seedCount: SEED_COUNT,
          seedsPresent: new Set(runs.map((r) => r.seed)).size,
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
  return summary;
}

function report(summary: Summary[]): void {
  // RENDERS what `assemble` computed; it does not recompute it.
  //
  // These were two independent passes over the runs, and they disagreed the
  // moment a policy was added to one: `assemble` learned to drop seeds where a
  // body never settled, and this went on printing medians that still included
  // them — a refused solve on screen beside the corrected figure in the file
  // the document cites. That is the same divergence `solveInstalled` and the
  // drift cells had, in a third place, and the fix is the same one: a single
  // producer, and everything else a reader of it.
  const out: string[] = [''];
  out.push("EXPERIMENT 6 — what the ellipsoid's extra rotation is made of", '');
  for (const scope of ['documented', 'all'] as const) {
    const rows = summary.filter((r) => r.scope === scope);
    if (rows.length === 0) continue;
    const n = rows[0].n;
    out.push(
      `## ${scope === 'documented' ? "the document's own three seeds" : `all seeds`}`,
      '',
      'arm             body      median rot    worst rot   median pos   median resid     n  dropped',
    );
    for (const r of rows) {
      for (const [body, rot, wrst, pos, res] of [
        ['nominal', r.sphereMedianRotDeg, r.sphereWorstRotDeg, r.sphereMedianPosMm, r.sphereMedianResidualPx],
        ['mesh', r.meshMedianRotDeg, r.meshWorstRotDeg, r.meshMedianPosMm, r.meshMedianResidualPx],
      ] as const) {
        out.push(
          `${r.arm.padEnd(15)} ${body.padEnd(9)} ${rot.toFixed(4).padStart(10)} ` +
            `${wrst.toFixed(4).padStart(12)} ${pos.toFixed(1).padStart(12)} ` +
            `${res.toFixed(4).padStart(14)} ${String(r.n).padStart(5)} ` +
            `${String(r.seedsDropped).padStart(8)}`,
        );
      }
    }
    out.push('', 'arm             mesh/sphere median rot     mesh rot vs its own free arm');
    const free = rows.find((r) => r.arm === 'free');
    for (const r of rows) {
      const removed = free === undefined ? NaN : (1 - r.meshMedianRotDeg / free.meshMedianRotDeg) * 100;
      out.push(
        `${r.arm.padEnd(15)} ${(r.meshMedianRotDeg / r.sphereMedianRotDeg).toFixed(2).padStart(20)}x ` +
          `${removed.toFixed(1).padStart(28)}% removed`,
      );
    }
    // Said once per scope rather than left for a reader to notice `n` < seeds.
    const dropped = rows.reduce((a, r) => a + r.seedsDropped, 0);
    if (dropped > 0) {
      out.push(
        '',
        `${dropped} arm-seed(s) excluded: a body did not converge, and the page would refuse`,
        'that calibration, so averaging it in would publish a refused solve as a result.',
      );
    }
    out.push('');
  }
  process.stdout.write(out.join('\n'));
}

main();
