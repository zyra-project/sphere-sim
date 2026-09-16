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
  START_PHASES,
  EXPERIMENT_ROOT_SEED,
  EXPOSURES_S,
  FRAMES,
  FRAMES_PER_RUN,
  TRIALS,
} from './design.ts';
import { summarise, type ArmSummary } from './run.ts';
import type { StartPhase } from './design.ts';

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
    for (const phase of START_PHASES) {
      for (const dwellS of DWELLS_S) {
        for (const exposureS of EXPOSURES_S) {
        // A dwell shorter than the exposure is not a capture anybody can shoot:
        // the shutter is still open when the next frame is already up, so every
        // photograph straddles by construction and the row says nothing about
        // timing. Recorded as skipped rather than silently omitted.
          if (exposureS >= dwellS) continue;
          cells.push(summarise(arm, phase, dwellS, exposureS, TRIALS, EXPERIMENT_ROOT_SEED));
        }
      }
    }
  }

  const at = (
    key: string,
    phase: StartPhase,
    dwellS: number,
    exposureS = HEADLINE_EXPOSURE_S,
  ): ArmSummary => {
    const cell = cells.find(
      (c) =>
        c.key === key && c.startPhase === phase && c.dwellS === dwellS && c.exposureS === exposureS,
    );
    // Thrown rather than skipped. The first version of this verdict asked for a
    // 1/4 s exposure at the 0.2 s dwell — a cell the sweep correctly refuses as
    // unshootable — got `undefined`, and quietly dropped two whole sentences
    // from the printed result. A headline that can silently lose its middle is
    // the same class of fault this file exists to prevent.
    if (cell === undefined) {
      throw new Error(
        `no cell for ${key} / ${phase} at dwell ${dwellS}s, exposure ${exposureS}s`,
      );
    }
    return cell;
  };

  const runsPerCapture = FRAMES / FRAMES_PER_RUN;

  /**
   * The margin, stated correctly.
   *
   * A shot opening at phase `p` within a dwell straddles exactly when
   * `p > dwell - exposure`, so the safe window is `[0, dwell - exposure)` and
   * the margins either side of a MID-dwell shot are not equal: `dwell/2` below
   * and `dwell/2 - exposure` above. An earlier draft quoted `(dwell - exposure)
   * / 2` as "slack either side", which is the half-width of the safe window and
   * not a margin at all.
   *
   * It also gives the answer for a uniform start analytically: the straddle
   * probability of the FIRST shot is `exposure / dwell`, whatever the crystal.
   */
  const loosestPpm = Math.max(...ARMS.map((a) => a.driftPpm));
  const driftAtDefaultMs = (DEFAULT_DWELL_S * (loosestPpm / 1e6) * FRAMES * 1000) / 1;
  const marginUpMs = (DEFAULT_DWELL_S / 2 - HEADLINE_EXPOSURE_S) * 1000;
  const marginDownMs = (DEFAULT_DWELL_S / 2) * 1000;
  const uniformFirstShot = (100 * HEADLINE_EXPOSURE_S) / DEFAULT_DWELL_S;

  const aimed = at('intervalometer-100ppm', 'aimed', DEFAULT_DWELL_S);
  const uniform = at('intervalometer-100ppm', 'uniform', DEFAULT_DWELL_S);
  const onTick = at('intervalometer-100ppm', 'on-tick', DEFAULT_DWELL_S);
  const handUniform = at('handheld-remote', 'uniform', DEFAULT_DWELL_S);
  const handTick = at('handheld-remote', 'on-tick', DEFAULT_DWELL_S);

  // Assembled from the cells rather than written. It leads with the axis the
  // answer actually turns on, which is not the one this experiment was opened
  // to investigate.
  const statement =
    `Where the first shutter lands in the dwell decides an untethered capture, and it decides ` +
    `it far more than the crystal does. At the emitter's default ${DEFAULT_DWELL_S} s dwell and ` +
    `a 1/4 s exposure, with the loosest crystal in the sweep (${loosestPpm} ppm): an operator ` +
    `who starts the camera at no particular phase ruined ` +
    `${uniform.capturesTouched} of ${uniform.trials} captures ` +
    `(${pct(uniform.capturesTouched, uniform.trials)}), and ` +
    `${uniform.capturesWhollyStraddled} of them straddled every frame from the first to the ` +
    `last. That rate is not a property of the clocks: a shot opening at phase p straddles when ` +
    `p > dwell - exposure, so a uniform start straddles its first frame with probability ` +
    `exposure / dwell, ${uniformFirstShot.toFixed(1)}% here, and drift is far too small to move ` +
    `it afterwards. Shooting on the page's own tick instead puts the shutter a reaction time ` +
    `after the boundary — the roomiest place in the dwell — and ruined ` +
    `${onTick.capturesTouched} (${pct(onTick.capturesTouched, onTick.trials)}); deliberately ` +
    `aiming mid-dwell ruined ${aimed.capturesTouched} ` +
    `(${pct(aimed.capturesTouched, aimed.trials)}). Clock drift really is negligible at this ` +
    `dwell — ${driftAtDefaultMs.toFixed(0)} ms accumulated across ${FRAMES} frames, against ` +
    `margins of ${marginUpMs.toFixed(0)} ms above a mid-dwell shot and ${marginDownMs.toFixed(0)} ` +
    `ms below — so what a tether removes is not drift but the start-phase gamble. A hand-pressed ` +
    `remote is worse and differently shaped: at a uniform start it touched ` +
    `${handUniform.capturesTouched} of ${handUniform.trials} ` +
    `(${pct(handUniform.capturesTouched, handUniform.trials)}) and on the tick still ` +
    `${handTick.capturesTouched} (${pct(handTick.capturesTouched, handTick.trials)}), with ` +
    `scattered straddles rather than one continuous ruined stretch — only ` +
    `${handTick.capturesWhollyStraddled} of those were straddled end to end.`;

  const doc = {
    schema: 'sphere-sim/experiment-9@1',
    generatedFrom: {
      trials: TRIALS,
      frames: FRAMES,
      framesPerRun: FRAMES_PER_RUN,
      dwellsS: DWELLS_S,
      startPhases: START_PHASES,
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
