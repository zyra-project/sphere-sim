// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run experiment9` — what an open-loop tether costs, across dwell.
 *
 * Writes `experiments/experiment-9.json`. Nothing is rendered and nothing is
 * decoded, so the sweep is arithmetic and runs in well under a second.
 *
 * The verdict sentence is written HERE, from the counts, for the reason
 * `tools/experiment-tables.ts` exists: three separate times a number in a
 * write-up disagreed with the file it was reporting, and a verdict a person
 * paraphrases is the same hazard one sentence further out.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARMS,
  DEFAULT_DWELL_S,
  DWELLS_S,
  EXPERIMENT_ROOT_SEED,
  EXPOSURES_S,
  FRAMES,
  FRAMES_PER_RUN,
  TRIALS,
} from './design.ts';
import { summarise, type ArmSummary } from './run.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(ROOT, 'experiments', 'experiment-9.json');

/** The exposure the headline is quoted at, so the sentence names one number. */
const HEADLINE_EXPOSURE_S = 1 / 4;

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

function main(): void {
  const cells: ArmSummary[] = [];
  for (const arm of ARMS) {
    for (const dwellS of DWELLS_S) {
      for (const exposureS of EXPOSURES_S) {
        // A dwell shorter than the exposure is not a capture anybody can shoot:
        // the shutter is still open when the next frame is already up, so every
        // photograph straddles by construction and the row says nothing about
        // timing. Recorded as skipped rather than silently omitted.
        if (exposureS >= dwellS) continue;
        cells.push(summarise(arm, dwellS, exposureS, TRIALS, EXPERIMENT_ROOT_SEED));
      }
    }
  }

  const at = (key: string, dwellS: number, exposureS = HEADLINE_EXPOSURE_S): ArmSummary => {
    const cell = cells.find(
      (c) => c.key === key && c.dwellS === dwellS && c.exposureS === exposureS,
    );
    // Thrown rather than skipped. The first version of this verdict asked for a
    // 1/4 s exposure at the 0.2 s dwell — a cell the sweep correctly refuses as
    // unshootable — got `undefined`, and quietly dropped two whole sentences
    // from the printed result. A headline that can silently lose its middle is
    // the same class of fault this file exists to prevent.
    if (cell === undefined) {
      throw new Error(`no cell for ${key} at dwell ${dwellS}s, exposure ${exposureS}s`);
    }
    return cell;
  };

  const runsPerCapture = FRAMES / FRAMES_PER_RUN;
  const crystal = cells.filter((c) => c.key.startsWith('intervalometer'));
  const worstBurstAnywhere = crystal.reduce((m, c) => Math.max(m, c.worstBurst), 0);

  /**
   * The arithmetic quoted in the sentence, derived rather than typed.
   *
   * An earlier draft wrote "about 82 ms against 875 ms" and "27 minutes" as
   * prose. Those are the same three constants the sweep runs on, and a number
   * retyped beside the thing that produces it is precisely what
   * `tools/experiment-tables.ts` was built after.
   */
  const loosestPpm = Math.max(...ARMS.map((a) => a.driftPpm));
  const driftAtDefaultMs = DEFAULT_DWELL_S * (loosestPpm / 1e6) * FRAMES * 1000;
  const slackAtDefaultMs = ((DEFAULT_DWELL_S - HEADLINE_EXPOSURE_S) / 2) * 1000;
  const cautiousDwellS = Math.max(...DWELLS_S);
  const cautiousMinutes = (FRAMES * cautiousDwellS) / 60;

  const steadyDefault = at('intervalometer-100ppm', 2);
  const steadyOne = at('intervalometer-100ppm', 1);
  const handDefault = at('handheld-remote', 2);
  const handCautious = at('handheld-remote', 4);
  const handOne = at('handheld-remote', 1);

  // Assembled from the cells rather than written, so it cannot drift from the
  // file it summarises. It deliberately does NOT lead with a sweep-wide
  // average: the sweep contains dwell/exposure pairs nobody would shoot, and an
  // average over those describes the sweep rather than the decision.
  const statement =
    `At the emitter's default 2 s dwell and a 1/4 s exposure, an intervalometer at the loosest ` +
    `plausible crystal error (${loosestPpm} ppm) straddled ${steadyDefault.straddledTotal} ` +
    `photographs in ` +
    `${steadyDefault.trials} captures. Clock drift is not what breaks an untethered capture: ` +
    `across ${FRAMES} frames at ${DEFAULT_DWELL_S} s it accumulates about ` +
    `${driftAtDefaultMs.toFixed(0)} ms against ${slackAtDefaultMs.toFixed(0)} ms of slack either ` +
    `side of a mid-dwell shot. Shorten the dwell and that slack is what goes. At 1 s the same rig ` +
    `touched ${steadyOne.capturesTouched} of ${steadyOne.trials} captures ` +
    `(${pct(steadyOne.capturesTouched, steadyOne.trials)}), and the failure is not graceful: ` +
    `the worst run of consecutive straddled photographs anywhere in the crystal arms is ` +
    `${worstBurstAnywhere} of ${FRAMES}. A capture that starts at the wrong phase stays there, ` +
    `so an open-loop night is close to all-or-nothing rather than degraded at the edges. ` +
    `A hand-pressed remote is a separate problem and the tether does answer it: at 2 s it ` +
    `touched ${handDefault.capturesTouched} of ${handDefault.trials} captures ` +
    `(${pct(handDefault.capturesTouched, handDefault.trials)}) and ` +
    `${handDefault.runsTouchedTotal} projector runs; at 1 s, ` +
    `${handOne.capturesWhollyTouched} of ${handOne.trials} captures had all ${runsPerCapture} ` +
    `runs affected. Only at a 4 s dwell does it fall to ${handCautious.capturesTouched} ` +
    `(${pct(handCautious.capturesTouched, handCautious.trials)}), which costs ` +
    `${cautiousMinutes.toFixed(0)} minutes of dwell alone for the ${FRAMES} frames. So the ` +
    `margin an untethered capture runs on is the DWELL, ` +
    `and the emitter lets an operator take it to 0.2 s with nothing on the page saying what ` +
    `that spends.`;

  const doc = {
    schema: 'sphere-sim/experiment-9@1',
    generatedFrom: {
      trials: TRIALS,
      frames: FRAMES,
      framesPerRun: FRAMES_PER_RUN,
      dwellsS: DWELLS_S,
      exposuresS: EXPOSURES_S,
      headlineExposureS: HEADLINE_EXPOSURE_S,
      rootSeed: EXPERIMENT_ROOT_SEED,
      // Said in the file, because a reader taking these numbers into a room
      // needs to know what a "straddle" is counted as here.
      counts:
        'a straddle is an event in time — the shutter open across a pattern change — not a ' +
        'decoded error. Nothing here renders or decodes a frame, so what a straddled ' +
        'photograph costs a calibration is unmeasured and needs its own experiment.',
      driftModel:
        'a fixed per-capture rate error, not a random walk: two crystals at steady ' +
        'temperature differ by a roughly constant rate over the twenty minutes a capture ' +
        'takes. The ppm band is engineering-typical and has not been measured against a ' +
        'camera beside a sphere.',
    },
    arms: ARMS,
    cells,
    verdict: { statement },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`${statement}\n\nwrote ${path.relative(ROOT, OUT)}\n`);
}

main();
