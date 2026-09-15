// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 8 — what a dropped photograph costs, and whether anything notices.
 *
 * `docs/OPERATOR-PATH.md` Phase 2 names three candidate mechanisms for working
 * out which frame a photograph shows, and is explicit that the phase **picks by
 * measurement, not by argument** — because the failure mode of choosing on
 * plausibility is a capture that works in a dark room in one building and not in
 * another. It names the measurement too:
 *
 * > capture a real sequence with deliberate drops and duplicates, and score each
 * > mechanism on how often it recovers the right indexing and, more importantly,
 * > how often it *notices* that it has not.
 *
 * ## The one thing this cannot measure, said first
 *
 * Nobody has run a real sphere. Every capture this project has ever scored was
 * rendered by it. So this experiment measures the half that does not depend on a
 * real room — a drop is a drop whether the photograph came off a sensor or a ray
 * tracer — and **nothing here measures the photometric half.** No frame is
 * rendered; every trial supplies exact lit fractions, so `classify` is never
 * wrong and `MIN_CLASSIFY_MARGIN` is never approached.
 *
 * An earlier draft of this comment described a "classification arm" that renders
 * frames and checks the references stay separable. There is no such arm: it was
 * planned, cut for scope, and left standing in the prose, where review caught
 * it. What the results below are is an **ideal-classification baseline**, and
 * the photometric question is open.
 *
 * Also genuinely unmeasured is mechanism 3, the projected frame index.
 * Its risk is entirely photometric: a marker has to survive an oblique sphere in
 * a room whose ambient PARAMETERS.md §5 leaves unmeasured across 1%–15%, and
 * there is no one region of a sphere every camera position can see. This
 * experiment is what decides whether that cost is worth paying, and it can only
 * do so by showing what the cheap mechanisms leave on the table.
 *
 * ## Why the fault model is uniform and independent
 *
 * A real operator's mistakes are not uniform — a spoiled frame is more likely at
 * the start of a run while they are still settling, and a duplicate is most
 * likely from a double-tapped remote. Modelling that would mean inventing a
 * distribution nobody has measured, and then the headline number would be a
 * property of the invention. Uniform and independent is the assumption that adds
 * the least, and it is stated here rather than buried so a reader can discount
 * it.
 */

/** Every fault the sweep injects, as (frames removed, frames duplicated). */
export interface Arm {
  key: string;
  drops: number;
  dupes: number;
  /** What an operator did to produce this. */
  story: string;
}

export const ARMS: readonly Arm[] = [
  { key: 'clean', drops: 0, dupes: 0, story: 'nothing went wrong' },
  { key: 'drop1', drops: 1, dupes: 0, story: 'one frame deleted off the card' },
  { key: 'drop2', drops: 2, dupes: 0, story: 'two frames deleted' },
  { key: 'dupe1', drops: 0, dupes: 1, story: 'the remote double-tapped once' },
  {
    key: 'cancel',
    drops: 1,
    dupes: 1,
    // The arm the whole experiment exists for: the count comes out right, so the
    // one check ordering has passes, and the capture is wrong from the fault
    // onward with nothing saying so.
    story: 'one frame deleted and one shot twice — the count still adds up',
  },
  { key: 'messy', drops: 2, dupes: 2, story: 'a thoroughly bad session' },
];

/** Four projectors, 34 frames each, which is the page's own plan. */
export const PROJECTORS = 4;
export const FRAMES_PER_PROJECTOR = 34;

/**
 * Trials per arm.
 *
 * 2000 rather than the 30-ish the solve experiments use, and the reason is that
 * a trial here costs microseconds rather than minutes: nothing is rendered and
 * nothing is solved, so the sample size is set by what makes the rare outcomes
 * legible rather than by the compute budget. The outcome that decides the phase
 * is the silent one, and at 2000 trials a rate of 1% is 20 events rather than
 * one.
 */
export const TRIALS = 2000;

export const EXPERIMENT_ROOT_SEED = 0x1d2e3f48;
