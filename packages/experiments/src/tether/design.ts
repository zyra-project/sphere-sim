// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 9 — what an open-loop tether costs, in photographs of two patterns.
 *
 * `docs/OPERATOR-PATH.md` Phase 5 is the only phase in the plan with **no "Done
 * when"**. It argues tethering is a convenience now that Phase 2 has landed —
 * "the laptop advances the pattern and trips the shutter" — and says it is
 * deliberately last because camera SDKs are per-vendor, per-platform and
 * hostile. What it never says is what the alternative costs. This experiment is
 * an attempt to put a number on that, so the phase can be given a done-when
 * that is about an outcome rather than about a feature existing.
 *
 * ## The hazard, which is not a dropped frame
 *
 * `packages/web/web/emit.ts` already advances on a timer, with an audible tick,
 * because "an operator running the sequence on a timer beside a camera has no
 * way to know it advanced". That is an OPEN LOOP: the projector steps on the
 * laptop's clock and the shutter fires on the camera's, and neither reads the
 * other.
 *
 * When those two clocks disagree, the failure is not a missing photograph. It
 * is a photograph taken while the projector was CHANGING — the shutter open
 * across the boundary, so the frame holds part of one pattern and part of the
 * next. Call it a straddle.
 *
 * A straddle is worse than a drop for one specific reason, and it is the reason
 * this is worth measuring rather than assuming:
 *
 *   - a DROP changes the number of photographs, and Phase 2's structural
 *     bookends catch it by counting between the references;
 *   - a STRADDLE changes nothing structural. The count is right, every frame is
 *     present, and a blend of two patterns still lights about half the crescent
 *     — which is exactly the property `classify` uses to call a frame
 *     "patterned". So the bookends see a healthy capture.
 *
 * `docs/EXPERIMENT-8.md` measured the blind spot in Phase 2 to be a cancelling
 * drop-and-duplicate inside one run. This is a second way into the same blind
 * spot, reached without anybody deleting a file.
 *
 * ## What this measures, and what it does NOT
 *
 * It measures **exposure to the hazard**: how many of a capture's photographs
 * are straddled, and how they are distributed. It does not measure what a
 * straddled photograph does to a decoded coordinate. Nothing here renders a
 * frame or decodes one; a straddle is counted as an event in time, not as a
 * corrupted image.
 *
 * That boundary is deliberate and it is where an earlier draft of this file
 * overreached. Saying "a straddled frame decodes wrong" would be an argument,
 * and Phase 2's whole lesson was that this project picks by measurement. The
 * decode consequence needs its own experiment with rendered blends, and until
 * somebody runs it the honest claim is the narrow one: this many photographs of
 * a 408-frame capture are not photographs of the pattern they are filed under.
 *
 * ## Where the numbers come from, and which one is invented
 *
 * - **408 frames** is `planFrames(DEFAULT_PATTERN_PLAN)` at 34 frames per
 *   projector per camera position, four projectors, three positions — the
 *   figure `docs/PARAMETERS.md` and the smoke test both use.
 * - **Dwell** is swept from the emitter page's floor to four times its default.
 *   It is the axis the answer turns on; see {@link DWELLS_S}.
 * - **Clock drift** is the invented part, and it is invented from a real
 *   engineering range rather than from nothing: uncompensated consumer quartz
 *   is commonly specified around ±20 to ±100 ppm, and the arms below sweep
 *   that band with the SIGN drawn per capture. The DISTRIBUTION is a fixed
 *   rate per capture, not a random walk, because two crystals at fixed
 *   temperature differ by a roughly constant rate over the twenty minutes a
 *   capture takes.
 * - **Where the first shutter lands in the dwell** is swept as
 *   {@link START_PHASES} rather than assumed, because it turned out to matter
 *   more than the crystal and the first version buried it in a constant.
 * - **Jitter** is the other invented term: per-shot scatter in when the shutter
 *   actually opens. A remote release pressed by hand is worse than an
 *   intervalometer by an order of magnitude, and both arms are here.
 *
 * ## The emitter is modelled as a perfect timer, and it is not one
 *
 * `emit.ts` chains `setTimeout` after `go()` has painted, so each step runs a
 * little late and the lateness accumulates — a drift of the emitter's own, in a
 * known direction, of an unmeasured size. This model puts the projector's steps
 * at exact multiples of the dwell.
 *
 * That is stated rather than modelled because the alternative is inventing a
 * fourth number, and this experiment already rests on three. Its direction is
 * worth knowing though: a real emitter is slower than this one, which widens
 * the gap between the two clocks rather than narrowing it, so the straddle
 * rates here are optimistic.
 *
 * Stated plainly so a reader can discount it: nobody has measured any of these
 * terms against a real camera beside a real sphere.
 */

/**
 * Where in a dwell the operator's first shutter lands.
 *
 * This was a hidden constant and it was the load-bearing assumption of the
 * whole experiment. The first version drew the start offset from the middle
 * half of the dwell, on the reasoning that "an operator aims at the middle" —
 * which excluded every boundary-adjacent start, which is precisely the risk a
 * tether removes. The headline zero was substantially a property of that
 * sampling rule rather than of the rig, and review caught it.
 *
 * So the assumption is now an axis, swept and reported:
 *
 *   - `aimed` — the old rule, kept so the change is visible rather than
 *     quietly replaced. An operator who deliberately centres the shutter.
 *   - `uniform` — no procedure at all. The first shot lands anywhere in the
 *     dwell with equal probability, which is what happens when somebody starts
 *     an intervalometer without reference to the projector.
 *   - `on-tick` — `emit.ts` plays a tone AT each step, so the natural drill is
 *     "tick, then shoot". That puts the shutter just AFTER a boundary, by a
 *     human reaction time — which is the safest place in the dwell, and is the
 *     one case where the page's existing feedback is doing real work.
 *
 * Nobody has measured which of these an operator actually does. They are three
 * stated procedures, and the point of sweeping them is that the answer depends
 * on which one far more than it depends on the crystal.
 */
export type StartPhase = 'aimed' | 'uniform' | 'on-tick';

export const START_PHASES: readonly StartPhase[] = ['aimed', 'uniform', 'on-tick'];

/** Human reaction time after the tick, seconds: mean and spread. */
export const REACTION_S = { mean: 0.25, sd: 0.08 };

/** One way of running the shutter against the emitter's timer. */
export interface Arm {
  key: string;
  /**
   * Magnitude of the relative rate error between the two clocks, in ppm.
   *
   * The SIGN is drawn per capture rather than fixed. Two crystals are equally
   * likely to be fast or slow relative to each other, and the sign is not
   * cosmetic here: an exposure extends FORWARD from its opening instant, so a
   * shot drifting later meets the next boundary after `dwell - exposure` of
   * travel while one drifting earlier has to cross zero, a different distance.
   * Sampling only the positive sign measured one of the two directions and
   * reported it as the band.
   */
  driftPpm: number;
  /** Standard deviation of per-shot timing scatter, seconds. */
  jitterS: number;
  /** True when the emitter trips the shutter, so there are no two clocks. */
  tethered: boolean;
  /** What an operator did to produce this. */
  story: string;
}

/**
 * The arms, ordered from the thing Phase 5 would build to the thing it replaces.
 *
 * `tethered` is not a drift value of zero. It is a structurally different
 * arrangement — one clock instead of two — and it is in the sweep as the
 * baseline that makes every other row legible, not as a measurement of
 * anything. A tethered capture cannot straddle because the emitter does not
 * advance until the frame is in.
 */
export const ARMS: readonly Arm[] = [
  {
    key: 'tethered',
    driftPpm: 0,
    jitterS: 0,
    tethered: true,
    story: 'the laptop trips the shutter and waits for the frame — Phase 5, built',
  },
  {
    key: 'intervalometer-20ppm',
    driftPpm: 20,
    jitterS: 0.002,
    tethered: false,
    story: 'a good intervalometer, two clocks near the tight end of the quartz band',
  },
  {
    key: 'intervalometer-50ppm',
    driftPpm: 50,
    jitterS: 0.002,
    tethered: false,
    story: 'the same rig with an ordinary crystal',
  },
  {
    key: 'intervalometer-100ppm',
    driftPpm: 100,
    jitterS: 0.002,
    tethered: false,
    story: 'the loose end of the band, or a warm camera against a cold laptop',
  },
  {
    key: 'handheld-remote',
    driftPpm: 50,
    jitterS: 0.25,
    tethered: false,
    story: 'somebody pressing a remote release on the tick, for 408 frames',
  },
];

/** Frames in one full capture: 34 per projector per position, 4 projectors, 3 positions. */
export const FRAMES = 408;

/** Frames belonging to one projector's run, which is the unit a decode fails in. */
export const FRAMES_PER_RUN = 34;

/** The emitter page's own default dwell, seconds. */
export const DEFAULT_DWELL_S = 2;

/**
 * The dwells swept, and the reason this is the axis that matters.
 *
 * The first arithmetic done for this experiment swept clock drift and found
 * nothing: at 100 ppm — the loose end of the consumer quartz band — a whole
 * 408-frame capture accumulates 81.6 ms of error, against 875 ms of slack on
 * each side of a mid-dwell shot at the default dwell. Drift never gets near the
 * boundary. The worry tethering is usually justified by is not the one that
 * bites.
 *
 * What does bite is the dwell itself. The slack is `(dwell - exposure) / 2`, so
 * it collapses as an operator shortens the step to get 408 frames done sooner —
 * and `packages/web/web/emit.ts` lets them take it to `MIN_DWELL_S`, 0.2 s,
 * with nothing on the page saying what that spends.
 *
 * 0.2 is that floor. 0.5 and 1 are what somebody in a hurry types. 2 is the
 * page's default. 4 is the cautious choice.
 */
export const DWELLS_S: readonly number[] = [0.2, 0.5, 1, 2, 4];

/**
 * Shutter open time, seconds.
 *
 * A structured-light frame in a darkened room at a working aperture: this is the
 * order `docs/PARAMETERS.md` §7 assumes for the ground-truth visit. It is the
 * term the straddle probability scales with almost linearly, so it is a
 * parameter of the sweep rather than a constant — see `EXPOSURES_S`.
 */
export const EXPOSURE_S = 1 / 4;

/** The exposures swept, because the answer is mostly a statement about this. */
export const EXPOSURES_S: readonly number[] = [1 / 60, 1 / 8, 1 / 4, 1 / 2];

export const TRIALS = 2000;

/** Fixed so the sweep is byte-identical across runs. */
export const EXPERIMENT_ROOT_SEED = 0x9e5a1109;
