// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run experiment8` — the fault-tolerance sweep for Phase 2's indexing.
 *
 * Writes `experiments/experiment-8.json`. Nothing is rendered and nothing is
 * solved, so the whole sweep runs in under a second and there is no checkpoint
 * machinery: re-running it from scratch is cheaper than resuming it.
 *
 * The verdict sentence at the end of the file is written HERE, from the counts,
 * rather than by a person reading them. `tools/experiment-tables.ts` exists
 * because three separate times a number in a write-up disagreed with the file it
 * was reporting; a verdict a human paraphrases is the same hazard one sentence
 * further out.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARMS,
  EXPERIMENT_ROOT_SEED,
  FRAMES_PER_PROJECTOR,
  PROJECTORS,
  TRIALS,
} from './design.ts';
import { expectedSequence, runTrial, type Outcome, type TrialResult } from './run.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(ROOT, 'experiments', 'experiment-8.json');

interface MechanismSummary {
  clean: number;
  refused: number;
  silent: number;
  /** Photographs filed under the wrong frame, summed over every trial. */
  misplacedTotal: number;
  /** The worst single trial, which is what a bad night looks like. */
  misplacedWorst: number;
  /** Mean projector runs that survived, out of `PROJECTORS`. */
  usableRunsMean: number;
  /** Trials that handed back a usable run holding a misplaced photograph. */
  trialsWithBadUsableRun: number;
  /**
   * Projector runs handed back as usable while holding a misplaced photograph,
   * summed over every trial.
   *
   * The operational number, and the one the phase turns on. It counts runs that
   * would go into a bundle adjustment carrying a wrong answer with a clean bill
   * of health — which is not the same as `silent`, because a mechanism can
   * REFUSE a capture as a whole and still offer a bad run inside it. The sweep
   * found exactly that and it is why this field exists.
   */
  badUsableRunsTotal: number;
}

function summarize(rows: readonly TrialResult[]): MechanismSummary {
  const count = (o: Outcome): number => rows.filter((r) => r.outcome === o).length;
  return {
    clean: count('clean'),
    refused: count('refused'),
    silent: count('silent'),
    misplacedTotal: rows.reduce((a, r) => a + r.misplaced, 0),
    misplacedWorst: rows.reduce((a, r) => Math.max(a, r.misplaced), 0),
    usableRunsMean: rows.reduce((a, r) => a + r.usableRuns, 0) / Math.max(1, rows.length),
    trialsWithBadUsableRun: rows.filter((r) => r.badUsableRuns > 0).length,
    badUsableRunsTotal: rows.reduce((a, r) => a + r.badUsableRuns, 0),
  };
}

function main(): void {
  const trials = Number(process.env.TRIALS ?? TRIALS);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`experiment8: TRIALS must be a whole number >= 1, got ${trials}`);
  }
  const expected = expectedSequence();
  const arms = ARMS.map((arm) => {
    const rows: TrialResult[] = [];
    for (let t = 0; t < trials; t++) rows.push(...runTrial(arm, t, expected));
    return {
      key: arm.key,
      drops: arm.drops,
      dupes: arm.dupes,
      story: arm.story,
      order: summarize(rows.filter((r) => r.mechanism === 'order')),
      bookends: summarize(rows.filter((r) => r.mechanism === 'bookends')),
    };
  });

  // The numbers the phase turns on, taken from the arms rather than chosen.
  //
  // The headline is POISONED RUNS, not the silent-trial rate, and the difference
  // is a finding rather than a presentation choice: a mechanism can refuse a
  // capture as a whole — so `silent` does not count it — and still hand back an
  // individual run that is mis-indexed. That run goes into a solve. Leading with
  // `silent` would have understated the bookends' real exposure by three times.
  const faulty = arms.filter((a) => a.drops + a.dupes > 0);
  const faultyTrials = faulty.length * trials;
  const runsOffered = faultyTrials * PROJECTORS;
  const orderBad = faulty.reduce((a, x) => a + x.order.badUsableRunsTotal, 0);
  const bookendsBad = faulty.reduce((a, x) => a + x.bookends.badUsableRunsTotal, 0);
  const orderSilent = faulty.reduce((a, x) => a + x.order.silent, 0);
  const bookendsSilent = faulty.reduce((a, x) => a + x.bookends.silent, 0);
  const cancel = arms.find((a) => a.key === 'cancel');
  const drop1 = arms.find((a) => a.key === 'drop1');
  const pct = (n: number, d: number): string => `${((100 * n) / d).toFixed(1)}%`;

  const statement =
    `Over ${faultyTrials} faulty captures of ${PROJECTORS} projector runs each, ordering alone ` +
    `handed back ${orderBad} mis-indexed runs as usable (${pct(orderBad, runsOffered)} of every ` +
    `run offered) and the bookends ${bookendsBad} (${pct(bookendsBad, runsOffered)}) — a factor ` +
    `of ${(orderBad / Math.max(1, bookendsBad)).toFixed(1)}. Counting whole captures instead, ` +
    `ordering was silently wrong ${pct(orderSilent, faultyTrials)} of the time and the bookends ` +
    `${pct(bookendsSilent, faultyTrials)}, but that reading flatters the bookends: a capture they ` +
    `refuse can still contain a run they got wrong and offered. ` +
    (cancel === undefined
      ? ''
      : `Both are blind to one case and the bookends only to that case — a drop and a duplicate ` +
        `cancelling inside one run, where the count still adds up and every frame is still a ` +
        `patterned frame: ordering is silently wrong in ${pct(cancel.order.silent, trials)} of ` +
        `those and the bookends in ${pct(cancel.bookends.silent, trials)}. `) +
    (drop1 === undefined
      ? ''
      : `With no cancelling pair the bookends were never silently wrong and never offered a bad ` +
        `run at all: on a single dropped frame they kept ` +
        `${drop1.bookends.usableRunsMean.toFixed(2)} of ${PROJECTORS} runs, every one of them ` +
        `correct, where ordering kept ${drop1.order.usableRunsMean.toFixed(2)}.`);

  const doc = {
    schema: 'sphere-sim/experiment-8@1',
    generatedFrom: {
      trials,
      projectors: PROJECTORS,
      framesPerProjector: FRAMES_PER_PROJECTOR,
      rootSeed: EXPERIMENT_ROOT_SEED,
      // Said in the file, because a reader who takes these numbers into a room
      // needs to know classification was exact by construction here.
      classification: 'exact by construction; this arm does not render frames',
    },
    arms,
    verdict: { statement },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`${statement}\n\nwrote ${path.relative(ROOT, OUT)}\n`);
}

main();
