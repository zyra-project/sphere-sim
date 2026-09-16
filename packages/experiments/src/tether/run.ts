// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * One capture's worth of shutter timings against one emitter's timer.
 *
 * The whole model is two clocks and a comparison. The emitter steps at
 * `k * dwell` on its own clock. The camera means to fire at the same instants
 * and does not, because its clock runs at a slightly different rate and because
 * each release scatters. A photograph straddles when a step falls inside the
 * interval the shutter is open.
 *
 * ## A capture is three runs, not one
 *
 * The emitter's sequence covers ONE camera position and then stops. A capture
 * is three of them with a tripod move in between, so the shutter's phase
 * against the emitter is drawn three times and each position is an independent
 * chance to start in the wrong place.
 *
 * The first version of this module ran all 408 frames as a single sequence with
 * a single start phase. It made the headline roughly half what it should be —
 * one draw of a 1-in-8 risk rather than three — and manufactured its own second
 * finding, since the only way to straddle from the first frame to the last is
 * for one start phase to cover the lot. See {@link design.POSITIONS}.
 *
 * ## Why the shots are placed mid-dwell
 *
 * An operator setting this up aims the shutter at the MIDDLE of a dwell, not at
 * its edge, because the edge is obviously where the change is. `emit.ts`'s tick
 * fires on the step, so the natural drill is "tick, then shoot", and the natural
 * offset is half a dwell. Starting the camera at the boundary would manufacture
 * the result.
 *
 * That choice is what makes drift interesting rather than fatal: a mid-dwell
 * shot has `(dwell - exposure) / 2` of slack on either side, so nothing goes
 * wrong until accumulated drift eats it. Which it eventually does, and then
 * keeps eating — see {@link runTrial}'s burst accounting.
 */

import { makeBenchRng, deriveSeed, type BenchRng } from '../../../bench/src/random.ts';

import {
  FRAMES,
  FRAMES_PER_POSITION,
  FRAMES_PER_RUN,
  POSITIONS,
  REACTION_S,
  type Arm,
  type StartPhase,
} from './design.ts';

export interface TrialResult {
  /** Photographs whose shutter was open across a pattern change. */
  straddled: number;
  /** The longest unbroken stretch of straddled photographs. */
  longestBurst: number;
  /**
   * Runs of 34 in which at least one photograph straddled.
   *
   * A run is one projector's sequence at one camera position, which is the unit
   * `assembleCapture` builds and `decodeCapture` reads. A single bad frame in a
   * run is a bad bit for every pixel that bit addresses, so counting affected
   * RUNS says more about a night's work than counting frames does.
   */
  runsTouched: number;
  /**
   * Camera positions, of {@link POSITIONS}, in which at least one photograph straddled.
   *
   * The unit that matters once the capture is modelled as three separate
   * emitter runs: each position is an independent draw of the start phase, so
   * this is how many of the operator's three trips to the tripod went wrong.
   */
  positionsTouched: number;
  /**
   * Camera positions in which EVERY photograph straddled.
   *
   * This is what "all-or-nothing" turns into once the phase is redrawn per
   * position. A position whose start lands inside the danger zone stays there
   * for all 136 of its frames — drift is far too small to walk back out — so
   * the whole position is lost, and the other two may be perfect.
   */
  positionsLostEndToEnd: number;
  /** The first frame index that straddled, or -1. Where the night went wrong. */
  firstStraddle: number;
}

/**
 * Whether the shutter, open from `open` for `exposure`, spans a step boundary.
 *
 * Boundaries sit at every multiple of `dwell` on the emitter's clock, and the
 * shutter spans one exactly when a boundary falls strictly inside the interval
 * it is open. Both endpoints are excluded, and each for its own reason: a
 * shutter that CLOSES at the instant the projector switches caught only the old
 * pattern, and one that OPENS at that instant catches only the new one. Neither
 * is a photograph of two patterns.
 *
 * `ceil` is wrong here and was the first version: when `open` lands exactly on
 * a boundary, `ceil(open / dwell) * dwell` is that same boundary, so the
 * comparison reports a straddle for the one shot that is perfectly aligned.
 * Taking `floor` and stepping forward names the next boundary in both cases.
 */
export function straddles(open: number, exposure: number, dwell: number): boolean {
  const next = Math.floor(open / dwell) * dwell + dwell;
  return next < open + exposure;
}

/**
 * Where the first shutter opens within the dwell, per {@link StartPhase}.
 *
 * Returned as a phase in `[0, dwell)`. Which of these an operator actually does
 * is unmeasured; see the type's docblock for why it is swept rather than
 * assumed.
 */
export function startPhase(phase: StartPhase, dwellS: number, rng: BenchRng): number {
  if (phase === 'uniform') return rng.uniform(0, dwellS);
  if (phase === 'on-tick') {
    // The tone fires AT the step, so a shutter tripped on it opens a reaction
    // time later — early in the dwell, which is the roomiest place to be.
    const react = rng.normal(REACTION_S.mean, REACTION_S.sd);
    return ((react % dwellS) + dwellS) % dwellS;
  }
  // `aimed`: the middle, give or take a quarter of a dwell.
  return dwellS / 2 + rng.uniform(-dwellS / 4, dwellS / 4);
}

/**
 * One capture, frame by frame.
 *
 * The camera's clock runs at `rate` times the emitter's, so an interval it
 * counts as `dwell` takes `dwell / rate` of EMITTER time — division, not
 * multiplication. The first version multiplied, which simulated the opposite
 * drift direction; review caught it, and it is not cosmetic, because an
 * exposure extends forward from its opening instant and so the two directions
 * meet a boundary after different amounts of travel.
 */
export function runTrial(
  arm: Arm,
  phase: StartPhase,
  dwellS: number,
  exposureS: number,
  seed: number,
): TrialResult {
  if (arm.tethered) {
    // One clock. The emitter does not advance until the frame is in, so there
    // is no interval for a boundary to fall inside. Zero by construction, not
    // by measurement — the arm exists to make the others legible.
    return {
      straddled: 0,
      longestBurst: 0,
      runsTouched: 0,
      positionsTouched: 0,
      positionsLostEndToEnd: 0,
      firstStraddle: -1,
    };
  }

  const rng = makeBenchRng(seed);
  // Sign per capture: two crystals are equally likely to be fast or slow
  // relative to each other, and the margins either side of a mid-dwell shot are
  // not equal, so sampling one sign measured half the band.
  //
  // Drawn ONCE for the capture and not per position, because it is a property
  // of the two crystals rather than of the sitting. Moving the tripod does not
  // give the camera a different oscillator.
  const signed = rng.nextFloat() < 0.5 ? -arm.driftPpm : arm.driftPpm;
  const rate = 1 + signed / 1e6;

  let straddled = 0;
  let longestBurst = 0;
  let firstStraddle = -1;
  let positionsTouched = 0;
  let positionsLostEndToEnd = 0;
  const touched = new Set<number>();

  for (let pos = 0; pos < POSITIONS; pos++) {
    // A fresh start of the emitter, so a fresh phase and no inherited drift:
    // `advance()` stopped the sequence at the end of the last position and the
    // operator pressed start again after moving the tripod. Both resets follow
    // from the same fact and neither is a modelling convenience.
    const start = startPhase(phase, dwellS, rng);
    let burst = 0;
    let straddledHere = 0;

    for (let j = 0; j < FRAMES_PER_POSITION; j++) {
      const k = pos * FRAMES_PER_POSITION + j;
      // The camera's j-th release of THIS position, on the emitter's clock.
      const nominal = (j * dwellS) / rate + start;
      const open = nominal + (arm.jitterS > 0 ? rng.normal(0, arm.jitterS) : 0);
      if (straddles(open, exposureS, dwellS)) {
        straddled++;
        straddledHere++;
        burst++;
        if (burst > longestBurst) longestBurst = burst;
        if (firstStraddle < 0) firstStraddle = k;
        touched.add(Math.floor(k / FRAMES_PER_RUN));
      } else {
        burst = 0;
      }
    }

    // `burst` is deliberately not carried across this boundary. Minutes of
    // tripod moving sit between the last frame of one position and the first of
    // the next, so calling them one unbroken stretch would be false whatever
    // the arithmetic says.
    if (straddledHere > 0) positionsTouched++;
    if (straddledHere === FRAMES_PER_POSITION) positionsLostEndToEnd++;
  }

  return {
    straddled,
    longestBurst,
    runsTouched: touched.size,
    positionsTouched,
    positionsLostEndToEnd,
    firstStraddle,
  };
}

export interface ArmSummary {
  key: string;
  startPhase: StartPhase;
  dwellS: number;
  exposureS: number;
  trials: number;
  /** Captures with at least one straddled photograph. */
  capturesTouched: number;
  /** Straddled photographs, summed over every trial. */
  straddledTotal: number;
  /** The worst single capture, which is what a bad night looks like. */
  worstStraddled: number;
  worstBurst: number;
  /** Runs of 34 touched, summed over every trial. */
  runsTouchedTotal: number;
  /** Captures in which every run held at least one straddled frame. */
  capturesAllRunsTouched: number;
  /** Camera positions touched, summed over every trial. */
  positionsTouchedTotal: number;
  /**
   * Captures that lost at least one camera position from its first frame to its last.
   *
   * The headline catastrophe, and the one an operator can actually picture: a
   * whole sitting at the tripod in which every photograph was taken across a
   * pattern change, with the other positions possibly perfect. It replaces a
   * count of captures straddled end to end over all 408 frames, which the
   * three-position model makes very nearly impossible and which was therefore
   * measuring the old model's single start phase rather than the procedure.
   */
  capturesLosingAWholePosition: number;
}

export function summarise(
  arm: Arm,
  phase: StartPhase,
  dwellS: number,
  exposureS: number,
  trials: number,
  rootSeed: number,
): ArmSummary {
  const runsPerCapture = FRAMES / FRAMES_PER_RUN;
  let capturesTouched = 0;
  let straddledTotal = 0;
  let worstStraddled = 0;
  let worstBurst = 0;
  let runsTouchedTotal = 0;
  let capturesAllRunsTouched = 0;
  let positionsTouchedTotal = 0;
  let capturesLosingAWholePosition = 0;

  for (let t = 0; t < trials; t++) {
    const seed = deriveSeed(rootSeed, `${arm.key}:${phase}:${dwellS}:${exposureS}:${t}`);
    const r = runTrial(arm, phase, dwellS, exposureS, seed);
    if (r.straddled > 0) capturesTouched++;
    straddledTotal += r.straddled;
    if (r.straddled > worstStraddled) worstStraddled = r.straddled;
    if (r.longestBurst > worstBurst) worstBurst = r.longestBurst;
    runsTouchedTotal += r.runsTouched;
    if (r.runsTouched === runsPerCapture) capturesAllRunsTouched++;
    positionsTouchedTotal += r.positionsTouched;
    if (r.positionsLostEndToEnd > 0) capturesLosingAWholePosition++;
  }

  return {
    key: arm.key,
    startPhase: phase,
    dwellS,
    exposureS,
    trials,
    capturesTouched,
    straddledTotal,
    worstStraddled,
    worstBurst,
    runsTouchedTotal,
    capturesAllRunsTouched,
    positionsTouchedTotal,
    capturesLosingAWholePosition,
  };
}
