// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The straddle model, and the two properties the experiment's reading rests on.
 *
 * Experiment 9's conclusion is not the straddle count — it is the SHAPE: that an
 * open-loop CAMERA POSITION is close to all-or-nothing, because the phase error
 * that decides it is constant across that position's 136 frames. A test that
 * only checked counts would let that reading rot silently.
 *
 * "Position" and not "capture" is the correction review forced: the emitter
 * stops at the end of each position and the operator starts it again, so a
 * capture is three independent draws of the thing that decides everything.
 *
 * EXPERIMENT-10 re-scores these same photographs by what they integrated rather
 * than by whether they straddled, so the last three tests pin the seam it reads
 * through: shotTimings is still this model's loop, exposureBlend is straddles()
 * made continuous, and the headline cell still regenerates from the committed
 * file.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeBenchRng } from '../../bench/src/random.ts';
import {
  ARMS,
  DEFAULT_DWELL_S,
  EXPERIMENT_ROOT_SEED,
  EXPOSURE_S,
  FRAMES,
  FRAMES_PER_POSITION,
  FRAMES_PER_RUN,
  POSITIONS,
  START_PHASES,
  TRIALS,
  type Arm,
  type StartPhase,
} from '../src/tether/design.ts';
import {
  exposureBlend,
  runTrial,
  shotTimings,
  startPhase,
  straddles,
  summarise,
  type ArmSummary,
  type BlendPart,
  type ShotTiming,
  type TrialResult,
} from '../src/tether/run.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('a boundary strictly inside the shutter is a straddle, and an endpoint is not', () => {
  // Boundaries at every 2 s. A shot from 0.9 to 1.15 sees no change.
  assert.equal(straddles(0.9, 0.25, 2), false);
  // From 1.9 to 2.15 the projector switched at 2.0, mid-exposure.
  assert.equal(straddles(1.9, 0.25, 2), true);

  // Both endpoints excluded, each for its own reason. A shutter that CLOSES at
  // the instant of the change caught only the old pattern...
  assert.equal(straddles(1.75, 0.25, 2), false);
  // ...and one that OPENS at it caught only the new one. This is the case the
  // first implementation got wrong: `ceil(2.0 / 2) * 2` is 2.0, which is not
  // strictly greater than the opening instant, so the perfectly aligned shot
  // was reported as the one that straddles.
  assert.equal(straddles(2.0, 0.25, 2), false);

  // An exposure longer than the dwell cannot avoid a change wherever it starts.
  assert.equal(straddles(0.1, 2.5, 2), true);
});

test('drift alone does not straddle at the default dwell, and that is the finding', () => {
  // The worry tethering is usually justified by. At the loosest crystal in the
  // sweep, one camera position accumulates ~27 ms against 875 ms of slack, so a
  // position that starts near the middle of a dwell finishes there. It is 27
  // and not 82 because the emitter stops at the end of each position and the
  // operator starts it again, which resets the accumulation twice.
  const loosest = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  assert.ok(loosest !== undefined);
  let touched = 0;
  for (let seed = 1; seed <= 200; seed++) {
    if (runTrial(loosest, 'aimed', 2, 1 / 4, seed).straddled > 0) touched++;
  }
  assert.equal(touched, 0, `${touched} of 200 captures straddled at a 2 s dwell`);
});

test('a crystal capture fails in one concentrated stretch, measured per capture', () => {
  // The claim the write-up rests on, stated to what the data supports. An
  // earlier version asserted "all-or-nothing" from maxima taken over DIFFERENT
  // seeds, which only shows some seed had a long burst and some seed had many
  // straddles. And the stronger readings are both false: straddles are not
  // strictly contiguous — the 2 ms per-shot jitter makes a capture sitting on
  // the edge flicker in and out — and not every touched capture spans the whole
  // sequence, because the phase can drift into the straddle zone partway.
  //
  // What IS true is concentration, and the three-position model makes it
  // sharper rather than weaker: a position whose start lands in the danger zone
  // stays there for all 136 of its frames, and the positions either side of it
  // can be untouched.
  const loosest = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  assert.ok(loosest !== undefined);
  const shares: number[] = [];
  let lostAWholePosition = 0;
  let exactlyOnePosition = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const r = runTrial(loosest, 'uniform', 2, 1 / 4, seed);
    if (r.straddled === 0) continue;
    shares.push(r.longestBurst / r.straddled);
    if (r.positionsLostEndToEnd > 0) lostAWholePosition++;
    if (r.positionsTouched === 1) exactlyOnePosition++;
  }
  assert.ok(shares.length > 100, `only ${shares.length} touched captures to measure`);
  shares.sort((a, b) => a - b);
  const median = shares[Math.floor(shares.length / 2)];
  assert.ok(median > 0.9, `median longest-burst share was ${median.toFixed(3)}`);
  // The characteristic failure: a whole sitting at the tripod, every frame of
  // it, with the rest of the night possibly fine. A majority, not all — a start
  // near the edge of the zone flickers out of it.
  assert.ok(
    lostAWholePosition > shares.length * 0.5,
    `${lostAWholePosition} of ${shares.length} lost a whole position`,
  );
  assert.ok(lostAWholePosition < shares.length, 'but not all of them, so do not say "always"');
  assert.ok(
    exactlyOnePosition > shares.length * 0.5,
    `only ${exactlyOnePosition} of ${shares.length} touched captures were confined to one position`,
  );
});

test('a hand-pressed remote fails in scattered frames, which refutes stating it generally', () => {
  // The other half, and the half that stops "concentrated" being said of the
  // whole experiment: jitter an order of magnitude larger produces isolated
  // straddles, so a touched handheld capture is nothing like one long stretch.
  const hand = ARMS.find((a) => a.key === 'handheld-remote');
  assert.ok(hand !== undefined);
  const shares: number[] = [];
  let lostAWholePosition = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const r = runTrial(hand, 'on-tick', 2, 1 / 4, seed);
    if (r.straddled === 0) continue;
    shares.push(r.longestBurst / r.straddled);
    if (r.positionsLostEndToEnd > 0) lostAWholePosition++;
  }
  assert.ok(shares.length > 100);
  shares.sort((a, b) => a - b);
  const median = shares[Math.floor(shares.length / 2)];
  assert.ok(median < 0.2, `median longest-burst share was ${median.toFixed(3)}`);
  assert.equal(lostAWholePosition, 0, 'no handheld position is lost from end to end');
});

test('where the first shutter lands matters more than the crystal', () => {
  // The experiment's actual finding, and the one its first version hid inside a
  // sampling rule. Same clock, same dwell, same exposure — only the start.
  const loosest = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  assert.ok(loosest !== undefined);
  const touchedUnder = (phase: 'aimed' | 'uniform' | 'on-tick'): number => {
    let n = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      if (runTrial(loosest, phase, 2, 1 / 4, seed).straddled > 0) n++;
    }
    return n;
  };
  const uniform = touchedUnder('uniform');
  const tick = touchedUnder('on-tick');
  const aimed = touchedUnder('aimed');
  assert.ok(uniform > 100, `a uniform start should ruin captures, got ${uniform}`);
  assert.ok(tick < uniform, 'the page tick puts the shutter somewhere roomier');
  assert.equal(aimed, 0, 'and a deliberately centred shutter has room to spare');
});

test('a tethered capture cannot straddle, by construction rather than by luck', () => {
  const tethered = ARMS.find((a) => a.tethered);
  assert.ok(tethered !== undefined);
  // Every dwell and exposure in the sweep, including ones nobody would shoot.
  for (const dwell of [0.2, 0.5, 1, 2, 4]) {
    for (const exposure of [1 / 60, 1 / 8, 1 / 4, 1 / 2]) {
      const r = runTrial(tethered, 'uniform', dwell, exposure, 7);
      assert.equal(r.straddled, 0, `tethered straddled at dwell ${dwell}, exposure ${exposure}`);
    }
  }
});

test('a capture is three separate emitter runs, which is three chances to start badly', () => {
  // The defect review found in the first version of this module, pinned so it
  // cannot come back quietly. `emit.ts` plans 136 steps and calls them one
  // camera position; `advance()` stops when they run out. So the start phase is
  // drawn three times per capture, and the capture-level risk is the compound
  // of three draws rather than one.
  //
  // The arithmetic is exact enough to test against: at a uniform start a
  // position straddles its first frame with probability exposure / dwell, so a
  // capture escapes only by getting away with it three times running.
  const loosest = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  assert.ok(loosest !== undefined);
  const dwell = 2;
  const exposure = 1 / 4;
  const single = exposure / dwell;
  const compound = 1 - (1 - single) ** POSITIONS;

  let touched = 0;
  for (let seed = 1; seed <= 4000; seed++) {
    if (runTrial(loosest, 'uniform', dwell, exposure, seed).straddled > 0) touched++;
  }
  const rate = touched / 4000;
  assert.ok(
    Math.abs(rate - compound) < 0.05,
    `capture rate ${rate.toFixed(3)} should sit near the three-draw compound ` +
      `${compound.toFixed(3)}, not the single-draw ${single.toFixed(3)}`,
  );
  // And stated as the inequality that fails if POSITIONS is ever folded back
  // into a single run: one draw is not enough to explain what is measured.
  assert.ok(rate > single * 1.5, `${rate.toFixed(3)} is not distinguishable from one draw`);
});

test('a burst does not run across a tripod move', () => {
  // Minutes of moving the tripod sit between the last frame of one position and
  // the first of the next, so the two cannot be one unbroken stretch whatever
  // the arithmetic says. The bound is the check: no burst can exceed a position.
  const loosest = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  assert.ok(loosest !== undefined);
  let sawAFullPosition = false;
  for (let seed = 1; seed <= 500; seed++) {
    const r = runTrial(loosest, 'uniform', 2, 1 / 4, seed);
    assert.ok(
      r.longestBurst <= FRAMES_PER_POSITION,
      `burst of ${r.longestBurst} exceeds the ${FRAMES_PER_POSITION} frames of a position`,
    );
    assert.ok(r.positionsTouched <= POSITIONS);
    assert.ok(r.positionsLostEndToEnd <= r.positionsTouched);
    if (r.longestBurst === FRAMES_PER_POSITION) sawAFullPosition = true;
  }
  // The bound has to be reachable, or it is only testing that nothing happens.
  assert.ok(sawAFullPosition, 'no capture lost a full position, so the bound proves nothing');
});

test('runs are counted by the unit a decode actually fails in', () => {
  // `runsTouched` groups by 34, because that is one projector's sequence at one
  // camera position — what `assembleCapture` builds. Counting frames would
  // make a capture with 12 scattered bad frames look like one with 12 in a row,
  // and those are a ruined night and a ruined run respectively.
  const hand = ARMS.find((a) => a.key === 'handheld-remote');
  assert.ok(hand !== undefined);
  const r = runTrial(hand, 'uniform', 0.5, 1 / 4, 11);
  assert.ok(r.runsTouched <= FRAMES / FRAMES_PER_RUN);
  assert.ok(r.straddled >= r.runsTouched, 'a touched run needs at least one straddled frame');
  assert.ok(r.firstStraddle >= 0, 'a capture with straddles names where it started');
});

test('the sweep is deterministic for a given seed', () => {
  // The write-up quotes these cells, and `check:docs` compares the page against
  // the results file. Both rest on the sweep being reproducible.
  const hand = ARMS.find((a) => a.key === 'handheld-remote');
  assert.ok(hand !== undefined);
  const a = summarise(hand, 'uniform', 2, 1 / 4, 50, 0x9e5a1109);
  const b = summarise(hand, 'uniform', 2, 1 / 4, 50, 0x9e5a1109);
  assert.deepEqual(a, b);
});

/**
 * runTrial's draw loop as it stood before shotTimings was extracted from it
 * (run.ts:157-199 at 40a51dd, the code `experiments/experiment-9.json` was
 * generated by), with the accounting taken out and every draw left in place.
 *
 * Frozen here on purpose. runTrial now reads its shots FROM shotTimings, so a
 * test that only checks the two against each other cannot see the draw order
 * change: both sides move together and still agree. This copy is the one part
 * of the comparison that does not move.
 */
function drawsAsExperiment9Made(arm: Arm, phase: StartPhase, dwellS: number, seed: number): ShotTiming[] {
  const rng = makeBenchRng(seed);
  const signed = rng.nextFloat() < 0.5 ? -arm.driftPpm : arm.driftPpm;
  const rate = 1 + signed / 1e6;
  const shots: ShotTiming[] = [];
  for (let pos = 0; pos < POSITIONS; pos++) {
    const start = startPhase(phase, dwellS, rng);
    for (let j = 0; j < FRAMES_PER_POSITION; j++) {
      const nominal = (j * dwellS) / rate + start;
      const open = nominal + (arm.jitterS > 0 ? rng.normal(0, arm.jitterS) : 0);
      shots.push({ position: pos, filedStep: j, open });
    }
  }
  return shots;
}

/**
 * runTrial's accounting, re-derived from the shots alone: what EXPERIMENT-10's
 * audit does with shotTimings and straddles. It walks the shots flat rather
 * than in runTrial's nested loops, so the check is not one piece of code
 * compared with itself.
 */
function recount(shots: readonly ShotTiming[], exposureS: number, dwellS: number): TrialResult {
  let straddled = 0;
  let longestBurst = 0;
  let firstStraddle = -1;
  let burst = 0;
  let position = -1;
  const runs = new Set<number>();
  const perPosition = new Map<number, number>();
  for (const shot of shots) {
    // A tripod move sits between two positions, so a burst ends there.
    if (shot.position !== position) {
      position = shot.position;
      burst = 0;
    }
    if (!straddles(shot.open, exposureS, dwellS)) {
      burst = 0;
      continue;
    }
    const k = shot.position * FRAMES_PER_POSITION + shot.filedStep;
    straddled++;
    burst++;
    longestBurst = Math.max(longestBurst, burst);
    if (firstStraddle < 0) firstStraddle = k;
    runs.add(Math.floor(k / FRAMES_PER_RUN));
    perPosition.set(shot.position, (perPosition.get(shot.position) ?? 0) + 1);
  }
  const counts = [...perPosition.values()];
  return {
    straddled,
    longestBurst,
    runsTouched: runs.size,
    positionsTouched: counts.length,
    positionsLostEndToEnd: counts.filter((n) => n === FRAMES_PER_POSITION).length,
    firstStraddle,
  };
}

test("shotTimings is runTrial's loop: the draws EXPERIMENT-9 made, and runTrial only counts them", () => {
  // EXPERIMENT-10 re-scores EXPERIMENT-9's photographs by what they
  // integrated, and that is only a re-scoring if they are the same
  // photographs. A replay that drew the same things in a different order
  // would be a fresh sample under EXPERIMENT-9's name. Its touched captures
  // would not be the 728 the write-up counts, and nothing downstream could
  // tell.
  //
  // The check has two halves. The draws are held to the frozen loop, bit for
  // bit, because a draw order shows only in the values it produces. The count
  // is held to runTrial, so what EXPERIMENT-10 re-derives from shotTimings and
  // straddles is what EXPERIMENT-9 published.
  let compared = 0;
  let touched = 0;
  for (const arm of ARMS.filter((a) => !a.tethered)) {
    for (const phase of START_PHASES) {
      for (let seed = 1; seed <= 200; seed++) {
        const label = `${arm.key} / ${phase} / seed ${seed}`;
        const shots = shotTimings(arm, phase, DEFAULT_DWELL_S, seed);
        assert.deepEqual(shots, drawsAsExperiment9Made(arm, phase, DEFAULT_DWELL_S, seed), label);
        const result = runTrial(arm, phase, DEFAULT_DWELL_S, EXPOSURE_S, seed);
        assert.deepEqual(recount(shots, EXPOSURE_S, DEFAULT_DWELL_S), result, label);
        compared++;
        if (result.straddled > 0) touched++;
      }
    }
  }
  // An all-zero result agrees with any accounting whatever, so the comparison
  // has to include captures that straddled.
  assert.ok(touched > 500, `only ${touched} of ${compared} compared captures straddled at all`);

  const tethered = ARMS.find((a) => a.tethered);
  assert.ok(tethered !== undefined);
  assert.deepEqual(shotTimings(tethered, 'uniform', DEFAULT_DWELL_S, 7), [], 'one clock, no shutter timings');
});

test('exposureBlend agrees with straddles: more than one part exactly when a boundary falls inside', () => {
  // EXPERIMENT-10 decides which photographs changed from exposureBlend, and
  // audits its count against EXPERIMENT-9's from straddles. If the two
  // disagreed on one boundary case, the audit would report a photograph
  // EXPERIMENT-9 never counted, or lose one it did, and the gap would read as
  // a finding. The endpoint cases include the one straddles() itself once got
  // wrong.
  const D = DEFAULT_DWELL_S;
  const E = EXPOSURE_S;
  const expectParts = (
    parts: readonly BlendPart[],
    want: readonly (readonly [number, number])[],
    tolerance: number,
    what: string,
  ): void => {
    assert.deepEqual(
      parts.map((p) => p.step),
      want.map(([step]) => step),
      `${what}: steps`,
    );
    parts.forEach((p, i) =>
      assert.ok(
        Math.abs(p.weight - want[i][1]) <= tolerance,
        `${what}: step ${p.step} has weight ${p.weight}, not ${want[i][1]}`,
      ),
    );
  };

  // The straddles() cases at the top of this file, now with what the shutter saw.
  const cases: { open: number; exposure: number; want: [number, number][] }[] = [
    { open: 0.9, exposure: E, want: [[0, 1]] },
    // Open from 0.1 s before the change until 0.15 s after it.
    { open: 1.9, exposure: E, want: [[0, 0.4], [1, 0.6]] },
    // Closes as the projector switches: the old pattern, and no sliver of the new.
    { open: 1.75, exposure: E, want: [[0, 1]] },
    // Opens as it switches: the new pattern only.
    { open: 2.0, exposure: E, want: [[1, 1]] },
    // Longer than the dwell: every step it spans, in order.
    { open: 0.1, exposure: 4.5, want: [[0, 1.9 / 4.5], [1, 2 / 4.5], [2, 0.6 / 4.5]] },
  ];
  for (const c of cases) {
    const parts = exposureBlend(c.open, c.exposure, D);
    const what = `open ${c.open} s for ${c.exposure} s`;
    assert.equal(parts.length > 1, straddles(c.open, c.exposure, D), what);
    expectParts(parts, c.want, 1e-12, what);
  }

  // The exception exposureBlend's docblock states, pinned so the docblock
  // cannot drift from it. At 0.2 s, which is not a power of two, straddles()
  // computes the end of step 5 as exactly 1.2, so it counts a shot opening at
  // 1.2 s as straddling the change it opened on. exposureBlend puts that shot
  // wholly in step 6, not in a part of no length on step 5.
  assert.equal(straddles(1.2, 1 / 60, 0.2), true);
  expectParts(exposureBlend(1.2, 1 / 60, 0.2), [[6, 1]], 1e-12, 'on the boundary straddles() rounds onto');

  // Every shot EXPERIMENT-9 drew for seeds 1..50, in every arm that has shots.
  const disagreements: string[] = [];
  let shots = 0;
  let straddled = 0;
  for (const arm of ARMS.filter((a) => !a.tethered)) {
    for (const phase of START_PHASES) {
      for (let seed = 1; seed <= 50; seed++) {
        for (const { position, filedStep, open } of shotTimings(arm, phase, D, seed)) {
          const parts = exposureBlend(open, E, D);
          const sum = parts.reduce((s, p) => s + p.weight, 0);
          const inOrder = parts.every((p, i) => p.step === Math.floor(open / D) + i && p.weight > 0);
          if (parts.length > 1 !== straddles(open, E, D) || Math.abs(sum - 1) > 1e-12 || !inOrder) {
            disagreements.push(
              `${arm.key} / ${phase} / seed ${seed} / position ${position} step ${filedStep}: ` +
                `open ${open}, parts ${JSON.stringify(parts)}`,
            );
          }
          shots++;
          if (parts.length > 1) straddled++;
        }
      }
    }
  }
  assert.deepEqual(disagreements.slice(0, 5), [], `${disagreements.length} of ${shots} shots disagree`);
  // Agreement on shots that straddle nothing is agreement about nothing.
  assert.ok(straddled > 1000, `only ${straddled} of ${shots} shots straddled`);

  // Lateness moves step m to m·(D + lateS), and the move accumulates: at 7.5 ms
  // a step, step 135 starts 1.0125 s late, more than the half dwell of room
  // below a shot aimed mid-dwell.
  for (const lateS of [0.001, 0.0075]) {
    for (const m of [1, 2, 68, 135]) {
      const boundary = m * (D + lateS);
      const what = `${lateS * 1000} ms late, step ${m}`;
      const across = exposureBlend(boundary - 0.1, E, D, lateS);
      const after = exposureBlend(boundary + 0.01, E, D, lateS);
      const before = exposureBlend(boundary - E - 0.01, E, D, lateS);
      expectParts(across, [[m - 1, 0.4], [m, 0.6]], 1e-9, `${what}, across it`);
      expectParts(after, [[m, 1]], 1e-9, `${what}, just after`);
      expectParts(before, [[m - 1, 1]], 1e-9, `${what}, just before`);
    }
  }
  // And a shot across where the perfect timer put that change is now clean.
  expectParts(exposureBlend(135 * D - 0.1, E, D, 0.0075), [[134, 1]], 1e-9, 'the perfect-timer boundary');

  // A refresh wait delays one step alone. Step 3 shown 0.25 s late: a shot
  // opening at 6.0625 s, after step 3's timer fired, still caught step 2 for
  // most of its exposure, and step 4 starts on time because a wait is not
  // carried forward. The times are dyadic, so every weight is exact.
  const stepThreeLate = (m: number): number => (m === 3 ? 0.25 : 0);
  expectParts(exposureBlend(6.0625, E, D, 0, stepThreeLate), [[2, 0.75], [3, 0.25]], 0, 'step 3 held back');
  expectParts(exposureBlend(7.9375, E, D, 0, stepThreeLate), [[3, 0.25], [4, 0.75]], 0, 'step 4 on time');
  // Play is the one boundary nothing delays: T_0 = 0 whatever the wait says.
  expectParts(exposureBlend(-0.0625, E, D, 0, () => 0.25), [[-1, 0.25], [0, 0.75]], 0, 'Play');
  // ...and step 1 is the first one a wait does delay. With every step 0.25 s
  // late to the screen, the first change after Play shows at 2.25 s, not 2.
  // The Play case alone cannot tell "no wait at T_0" from "no wait at T_0 or
  // T_1", because that shot closes long before T_1.
  expectParts(exposureBlend(2.125, E, D, 0, () => 0.25), [[0, 0.5], [1, 0.5]], 0, 'step 1 waits');
  // A wait just inside the range check can still round step 1's start onto
  // step 2's: 2 + (2 - 2^-52) rounds to 4. Step 1 is then on screen for no
  // time, so it is not a part at all, rather than one of weight 0.
  const justUnderAStep = (m: number): number => (m === 1 ? D - 2 ** -52 : 0);
  expectParts(exposureBlend(3.875, E, D, 0, justUnderAStep), [[0, 0.5], [2, 0.5]], 0, 'a step rounded away');

  // Inputs that would otherwise come back as weights that look plausible.
  assert.throws(() => exposureBlend(1, 0, D), /exposureBlend/);
  assert.throws(() => exposureBlend(Number.NaN, E, D), /exposureBlend/);
  assert.throws(() => exposureBlend(1, E, D, -D), /exposureBlend/);
  assert.throws(() => exposureBlend(1.9, E, D, 0, () => -0.01), /waits/);
  assert.throws(() => exposureBlend(1.9, E, D, 0, () => D), /waits/);
  // Each finite and their sum not: the close would be Infinity, and the walk
  // over finite step ends toward it would never stop.
  assert.throws(() => exposureBlend(Number.MAX_VALUE, Number.MAX_VALUE, D), /not finite/);
});

test('the headline cell replays exactly from the committed experiment-9.json', () => {
  // The cell EXPERIMENT-10 re-scores, and the figures its verdict repeats: 728
  // captures touched, 102,873 photographs straddled, 849 positions touched,
  // 589 captures losing a whole position. Nothing in CI regenerates
  // experiment-9.json, so without this a change to the draws would leave the
  // file describing a model the code no longer runs, and EXPERIMENT-10 would
  // re-score captures that do not add up to the figures it cites.
  const doc = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'experiments', 'experiment-9.json'), 'utf8'),
  ) as { cells: ArmSummary[] };
  const loosest = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  assert.ok(loosest !== undefined);
  const committed = doc.cells.find(
    (c) =>
      c.key === loosest.key &&
      c.startPhase === 'uniform' &&
      c.dwellS === DEFAULT_DWELL_S &&
      c.exposureS === EXPOSURE_S,
  );
  assert.ok(committed !== undefined, 'the committed file has no headline cell');

  const replayed = summarise(loosest, 'uniform', DEFAULT_DWELL_S, EXPOSURE_S, TRIALS, EXPERIMENT_ROOT_SEED);
  // Field for field, so a count that moved cannot hide behind one that did not.
  assert.deepEqual(replayed, committed);
  // And the figures themselves, so that regenerating the file cannot carry
  // them away with it unnoticed.
  assert.deepEqual(
    [
      replayed.straddledTotal,
      replayed.capturesTouched,
      replayed.positionsTouchedTotal,
      replayed.capturesLosingAWholePosition,
      replayed.runsTouchedTotal,
    ],
    [102873, 728, 849, 589, 3158],
  );
});
