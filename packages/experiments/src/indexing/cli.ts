// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run experiment8` — the fault-tolerance sweep for Phase 2's indexing.
 *
 * Writes `experiments/experiment-8.json`. Nothing is rendered and nothing is
 * solved, so there is no checkpoint machinery: re-running the sweep from scratch
 * is cheaper than resuming it. It takes about 16 seconds, nearly all of it in
 * the complement fingerprint — 12 pairs compared over a 64x64 grid, for every
 * run of every trial. That is a property of running 18 000 trials rather than of
 * the mechanism: one real capture costs one such check, which is microseconds.
 * (It ran in under a second with two mechanisms, and this docblock said so until
 * the third one landed.)
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
  FINGERPRINT_BLOCKS,
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
  /**
   * Projector runs handed back as usable, summed over every trial.
   *
   * The denominator for "of the runs it offered, how many were wrong" — and it
   * is mechanism-specific, which review had to point out. The first version
   * divided by every run in the sweep, so a mechanism that refuses more was
   * silently credited for the runs it never offered.
   */
  runsOfferedTotal: number;
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
    runsOfferedTotal: rows.reduce((a, r) => a + r.usableRuns, 0),
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
      fingerprint: summarize(rows.filter((r) => r.mechanism === 'fingerprint')),
    };
  });

  // The numbers the phase turns on, taken from the arms rather than chosen.
  //
  // TWO rates, because they answer different questions and review caught the
  // first version conflating them under one label:
  //
  //   - CONDITIONAL — of the runs a mechanism actually handed back, how many
  //     were wrong. This is what a caller experiences, and its denominator is
  //     that mechanism's own offered total, not every run in the sweep.
  //   - EXPOSURE — bad runs per run the capture contained. This is what a whole
  //     session costs, and it is smaller for a mechanism that refuses a lot.
  //
  // Ordering scores far worse on the conditional rate than on exposure, and the
  // reason is worth reading rather than smoothing over: on a faulty capture it
  // offers runs ONLY in the arms where it noticed nothing, so nearly everything
  // it hands back in those arms is wrong.
  const faulty = arms.filter((a) => a.drops + a.dupes > 0);
  const faultyTrials = faulty.length * trials;
  const runsIn = faultyTrials * PROJECTORS;
  const sum = (pick: (x: (typeof arms)[number]) => number): number =>
    faulty.reduce((a, x) => a + pick(x), 0);
  const orderBad = sum((x) => x.order.badUsableRunsTotal);
  const bookendsBad = sum((x) => x.bookends.badUsableRunsTotal);
  const printBad = sum((x) => x.fingerprint.badUsableRunsTotal);
  const orderOffered = sum((x) => x.order.runsOfferedTotal);
  const bookendsOffered = sum((x) => x.bookends.runsOfferedTotal);
  const printOffered = sum((x) => x.fingerprint.runsOfferedTotal);
  const orderSilent = sum((x) => x.order.silent);
  const bookendsSilent = sum((x) => x.bookends.silent);
  const printSilent = sum((x) => x.fingerprint.silent);
  const cancel = arms.find((a) => a.key === 'cancel');
  const drop1 = arms.find((a) => a.key === 'drop1');
  const pct = (n: number, d: number): string =>
    d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;

  const statement =
    `Over ${faultyTrials} faulty captures of ${PROJECTORS} projector runs each: ordering alone ` +
    `handed back ${orderOffered} runs and ${orderBad} of them were mis-indexed ` +
    `(${pct(orderBad, orderOffered)}); the bookends handed back ${bookendsOffered} and ` +
    `${bookendsBad} were mis-indexed (${pct(bookendsBad, bookendsOffered)}); the complement ` +
    `fingerprint handed back ${printOffered} and ${printBad} were mis-indexed ` +
    `(${pct(printBad, printOffered)}). Measured instead ` +
    `against every run the captures contained, that is ${pct(orderBad, runsIn)}, ` +
    `${pct(bookendsBad, runsIn)} and ${pct(printBad, runsIn)} of ${runsIn}. Ordering is worse ` +
    `on the first rate than the ` +
    `second because on a faulty capture it offers runs only where it noticed nothing. Counting ` +
    `whole captures, ordering was silently wrong ${pct(orderSilent, faultyTrials)} of the time, ` +
    `the bookends ${pct(bookendsSilent, faultyTrials)} and the fingerprint ` +
    `${pct(printSilent, faultyTrials)} — but that reading flatters the ` +
    `bookends, because a capture they refuse can still contain a run they got wrong and offered. ` +
    (cancel === undefined
      ? ''
      : `The case that separates them is a drop and a duplicate cancelling inside one run, ` +
        `where the count still adds up and every frame is still a patterned frame: ordering is ` +
        `silently wrong in ${pct(cancel.order.silent, trials)} of those, the bookends in ` +
        `${pct(cancel.bookends.silent, trials)} and the fingerprint in ` +
        `${pct(cancel.fingerprint.silent, trials)}. What the fingerprint has left is the part of ` +
        `that case which disturbs no complementary pair, which is the phase block moving within ` +
        `itself. `) +
    (drop1 === undefined
      ? ''
      : `With no cancelling pair the bookends were never silently wrong and never offered a bad ` +
        `run at all: on a single dropped frame they kept ` +
        `${drop1.bookends.usableRunsMean.toFixed(2)} of ${PROJECTORS} runs, every one of them ` +
        `correct, where ordering kept ${drop1.order.usableRunsMean.toFixed(2)} and the ` +
        `fingerprint ${drop1.fingerprint.usableRunsMean.toFixed(2)}.`);

  const doc = {
    schema: 'sphere-sim/experiment-8@1',
    generatedFrom: {
      trials,
      projectors: PROJECTORS,
      framesPerProjector: FRAMES_PER_PROJECTOR,
      rootSeed: EXPERIMENT_ROOT_SEED,
      fingerprintBlocks: FINGERPRINT_BLOCKS,
      // Said in the file, because a reader who takes these numbers into a room
      // needs to know classification was exact by construction here.
      classification:
        'exact by construction; this arm renders no frames, so these are an ' +
        'ideal-classification baseline rather than an upper bound on room behaviour',
      // Same standing, said separately because it is a separate mechanism's
      // separate assumption. A reader who discounts one should discount both.
      fingerprints:
        'computed from the pattern plan in projector space with no sphere, warp or albedo ' +
        'between the emitter and the number, so the complement residuals are exact and these ' +
        'are an ideal-fingerprint baseline on the same footing as the classification above',
    },
    arms,
    verdict: { statement },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`${statement}\n\nwrote ${path.relative(ROOT, OUT)}\n`);
}

main();
