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

import { FRAMES, FRAMES_PER_RUN, REACTION_S, type Arm, type StartPhase } from './design.ts';

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
  /** The first frame index that straddled, or -1. Where the night went wrong. */
  firstStraddle: number;
  /**
   * True when this ONE capture straddled every frame from the first to the last.
   *
   * The literal reading of "all-or-nothing", evaluated per capture rather than
   * inferred from maxima taken across different seeds.
   */
  straddledFromFirstToLast: boolean;
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
      firstStraddle: -1,
      straddledFromFirstToLast: false,
    };
  }

  const rng = makeBenchRng(seed);
  // Sign per capture: two crystals are equally likely to be fast or slow
  // relative to each other, and the margins either side of a mid-dwell shot are
  // not equal, so sampling one sign measured half the band.
  const signed = rng.nextFloat() < 0.5 ? -arm.driftPpm : arm.driftPpm;
  const rate = 1 + signed / 1e6;
  const start = startPhase(phase, dwellS, rng);

  let straddled = 0;
  let longestBurst = 0;
  let burst = 0;
  let firstStraddle = -1;
  let lastStraddle = -1;
  const touched = new Set<number>();

  for (let k = 0; k < FRAMES; k++) {
    // The camera's k-th release on the EMITTER's clock.
    const nominal = (k * dwellS) / rate + start;
    const open = nominal + (arm.jitterS > 0 ? rng.normal(0, arm.jitterS) : 0);
    if (straddles(open, exposureS, dwellS)) {
      straddled++;
      burst++;
      if (burst > longestBurst) longestBurst = burst;
      if (firstStraddle < 0) firstStraddle = k;
      lastStraddle = k;
      touched.add(Math.floor(k / FRAMES_PER_RUN));
    } else {
      burst = 0;
    }
  }

  return {
    straddled,
    longestBurst,
    runsTouched: touched.size,
    firstStraddle,
    // A PER-CAPTURE property, which is what "all-or-nothing" has to mean. The
    // first version compared a maximum burst against a maximum straddle count
    // taken over DIFFERENT seeds and read the coincidence as this.
    straddledFromFirstToLast: straddled > 0 && longestBurst === straddled && firstStraddle === 0
      && lastStraddle === FRAMES - 1,
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
  /** Captures straddled from the first frame to the last. */
  capturesWhollyStraddled: number;
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
  let capturesWhollyStraddled = 0;

  for (let t = 0; t < trials; t++) {
    const seed = deriveSeed(rootSeed, `${arm.key}:${phase}:${dwellS}:${exposureS}:${t}`);
    const r = runTrial(arm, phase, dwellS, exposureS, seed);
    if (r.straddled > 0) capturesTouched++;
    straddledTotal += r.straddled;
    if (r.straddled > worstStraddled) worstStraddled = r.straddled;
    if (r.longestBurst > worstBurst) worstBurst = r.longestBurst;
    runsTouchedTotal += r.runsTouched;
    if (r.runsTouched === runsPerCapture) capturesAllRunsTouched++;
    if (r.straddledFromFirstToLast) capturesWhollyStraddled++;
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
    capturesWhollyStraddled,
  };
}
