// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 4 — what the room behind the sphere costs a calibration.
 *
 * ## The question
 *
 * Until now an off-sphere pixel in a simulated capture was one constant. It is
 * hoisted above both the frame loop and the pixel loop in `bench/src/capture.ts`,
 * so it is frame-invariant, so `white - black` there is exactly zero plus two
 * sensor draws, and the decoder rejects it on modulation without ever being
 * asked a hard question.
 *
 * A real capture is not like that. PARAMETERS.md §7 gates off-sphere flux at 52%
 * and amendment A-03 measures the floor on a 16:9 chip near 56%, so more than
 * half of every projector's light lands on the room — and what lands is the
 * structured-light pattern. Those pixels carry real modulation, decode to a real
 * projector coordinate, and are at the wrong depth.
 *
 * `RoomSpill` puts that light where it goes. This experiment asks what it costs,
 * and whether the decoder's own modulation floor can reject it.
 *
 * ## The falsifiers, before any number
 *
 * These are written here so the verdict is evaluated against criteria that
 * existed before the sweep ran, and `judge()` in `run.ts` reads exactly these.
 *
 *   F1  The condition is inert. The wall never clears `minModulation`, the
 *       correspondence set does not change, and the model gained nothing. If
 *       this triggers, the switch is decoration and should be deleted rather
 *       than shipped.
 *   F2  The robust loss absorbs it. Off-sphere correspondences appear but the
 *       recovered pose does not move. That would be a real robustness property
 *       of the solver and the headline would be a reassurance, not a warning.
 *   F3  The cost is not monotone in how close the room is. A tighter room puts
 *       more light on the wall at a shorter throw, so a smaller `wallRadiusM`
 *       must not help; if it does, the knob is measuring something other than
 *       spill.
 *   F4  No modulation floor separates the two populations. If every threshold
 *       that rejects the wall also rejects the sphere, the finding has no
 *       mitigation from the decoder's own gates and the conclusion is that this
 *       pipeline needs segmentation rather than a threshold.
 *   F5  Segmentation does not recover the solve either. If rejecting the
 *       correspondences whose projector ray misses the nominal sphere still
 *       leaves the room costing more than twice the clean baseline, then the
 *       conclusion of F4 was wrong too and the problem is not one the geometry
 *       can be asked about.
 *   F6  Segmentation costs a clean capture. If it makes the no-room case worse
 *       — by rejecting genuine points at the limb, where the nominal silhouette
 *       and the true one differ most — then it is a trade rather than a fix and
 *       has to be reported as one.
 *
 * ## What this is not
 *
 * It is not a claim about a real gallery. The room is a cylinder with two
 * ASSUME constants in it and nobody has measured a building. It is a claim about
 * what happens to THIS solver when off-sphere pixels stop being constant, which
 * is a thing that is true of every real capture.
 */

import type { RoomSpill } from '../../../bench/src/capture.ts';

/**
 * One documented root seed, so "which run was this" has an answer that is not
 * "the one on my laptop". The date this experiment was designed.
 */
export const EXPERIMENT_ROOT_SEED = 20260819;

/** Replicates per cell. Five is Experiment 1's count and the reason is the same. */
export const SEED_COUNT = 5;

/**
 * The archetype every cell is run against.
 *
 * Index 1 rather than 0: archetype 0 is `clean`, which sets ambient to zero and
 * the sensor to null, and a spill experiment on a capture with no noise in it
 * would be measuring one thing while claiming another.
 */
export const ARCHETYPE_INDEX = 1;

/**
 * How close the room is, in metres of wall radius. `null` is the condition off,
 * which is how every published number was produced.
 *
 * 9 m is a hall; 6 m is `DEFAULT_ROOM_SPILL`, about the tightest room that still
 * has the §2 lens ring at 5.36 m inside it; 4 m is tighter than the ring, which
 * is not a room anybody would build and is here as the monotonicity check F3
 * needs. The ceiling is held at fourteen feet throughout.
 */
export const CEILING_M = 4.27;
export const WALL_RADII: readonly (number | null)[] = [null, 9, 6, 4];

/**
 * The decoder's absolute modulation floor, swept.
 *
 * 0.02 is `DEFAULT_DECODE_OPTIONS` and every published number. The rest are the
 * mitigation axis: the wall is further from its projector than the sphere is, so
 * it comes back dimmer, and a floor between the two populations would reject it.
 * Whether such a floor exists is F4 and is the only actionable thing this
 * experiment can produce.
 */
export const MIN_MODULATION: readonly number[] = [0.02, 0.1, 0.2, 0.4];

/** The decoder's shipped floor, and the threshold every segmentation cell holds. */
export const SHIPPED_MODULATION = 0.02;

/**
 * How far the segmentation inflates its test sphere. `null` is segmentation off.
 *
 * Swept rather than chosen, because the obvious reasoning and the measurement
 * disagree: inflating buys back genuine points at the limb, and it admits the
 * rays that graze past the ball and land on the far wall. Which of those
 * dominates is the question, and a single seed cannot answer it — every axis in
 * this experiment has produced a seed-to-seed range spanning four orders of
 * magnitude.
 */
export const SEGMENT_MARGINS: readonly (number | null)[] = [null, 0, 0.05, 0.15];

export interface CellSpec {
  wallRadiusM: number | null;
  minModulation: number;
  /** `null` is segmentation off. Otherwise the test sphere's inflation. */
  segmentMarginFrac: number | null;
  /**
   * Segment in the image instead of, or as well as, in the geometry.
   *
   * Optional so every cell written before this axis existed means the same
   * thing it did then, and so the 28-cell design above is untouched.
   */
  segmentImage?: boolean;
  /**
   * Which bench archetype to draw the rig from. Defaults to `ARCHETYPE_INDEX`.
   *
   * Optional, so every cell written before this axis existed still means what it
   * meant. Experiment 5 uses it to reach `long-throw`, whose documented projector
   * distance is nearly a metre out — the case where a segmentation that consults
   * the nominal rig should be expected to struggle and one that reads pixels
   * should not notice.
   */
  archetypeIndex?: number;
}

/**
 * Every cell, enumerated up front. Nothing downstream chooses what to run.
 *
 * Two arms rather than one full factorial. Crossing four rooms by four
 * thresholds by four margins is 320 solves and most of it answers nothing: the
 * threshold sweep is about whether the DECODER's own gates can separate the two
 * populations, and the margin sweep is about whether the GEOMETRY can. Holding
 * the other axis at its shipped value in each arm keeps every comparison a
 * one-axis comparison, which is the rule the rest of this design follows.
 */
export function buildDesign(): CellSpec[] {
  const out: CellSpec[] = [];
  // Arm 1: what the room costs, and whether the decoder's own floor can help.
  for (const wallRadiusM of WALL_RADII) {
    for (const minModulation of MIN_MODULATION) {
      out.push({ wallRadiusM, minModulation, segmentMarginFrac: null });
    }
  }
  // Arm 2: whether segmentation can, at the shipped floor.
  for (const wallRadiusM of WALL_RADII) {
    for (const segmentMarginFrac of SEGMENT_MARGINS) {
      if (segmentMarginFrac === null) continue; // already in arm 1
      out.push({ wallRadiusM, minModulation: SHIPPED_MODULATION, segmentMarginFrac });
    }
  }
  return out;
}

export function spillFor(spec: CellSpec): RoomSpill | null {
  return spec.wallRadiusM === null ? null : { wallRadiusM: spec.wallRadiusM, ceilingM: CEILING_M };
}

export function cellKey(spec: CellSpec): string {
  const room = spec.wallRadiusM === null ? 'off' : spec.wallRadiusM;
  const seg = spec.segmentMarginFrac === null ? 'noseg' : `seg${spec.segmentMarginFrac}`;
  // Appended only when set, so every key the 28-cell design produces is the
  // string it was before this axis existed and the published file still reads.
  const img = spec.segmentImage === true ? '|image' : '';
  const arch =
    spec.archetypeIndex === undefined || spec.archetypeIndex === ARCHETYPE_INDEX
      ? ''
      : `|a${spec.archetypeIndex}`;
  return `${room}|${spec.minModulation}|${seg}${img}${arch}`;
}

/**
 * Every place this design is thinner than it should be, why, and what the
 * omission costs the conclusion. Written into the results file and quoted in
 * docs/EXPERIMENT-4.md; a test asserts all three fields are present.
 */
export const CUTS: { what: string; why: string; costsTheConclusion: string }[] = [
  {
    what: 'One archetype, not the bench corpus.',
    why:
      'Eighty solves at the default preset is nine minutes; the full corpus crossed with this ' +
      'grid is hours, and the experiment is about a mechanism rather than a survey.',
    costsTheConclusion:
      'The magnitudes are this archetype’s. A rig with a different camera count or a ' +
      'different projector raster will put a different fraction of its frame on the wall, so the ' +
      'threshold that separates the two populations may sit elsewhere.',
  },
  {
    what: 'The room is a cylinder with a flat floor and ceiling, and no furniture.',
    why:
      'It is the smallest closed surface that puts the pattern where the pattern goes, and its ' +
      'two constants are already one more assumption than PARAMETERS.md supports.',
    costsTheConclusion:
      'A real gallery has a floor that is not the sphere’s own plane, doors, plinths and the ' +
      'guard rail, all of which are nearer than the wall and would spill harder. This is a floor ' +
      'on the effect, not a bound.',
  },
  {
    what: 'No second bounce.',
    why: 'Inter-reflection was already on `capture.ts`’s list of things it does not model.',
    costsTheConclusion:
      'Light that reaches the room and comes back onto the ball would raise the sphere’s own ' +
      'floor and narrow whatever threshold window this finds.',
  },
  {
    what: 'The segmentation tested is geometric, not image-space.',
    why:
      'It asks whether a decoded projector pixel’s own ray reaches the nominal sphere, which uses ' +
      'only what the solver already holds — §1’s radius, §W’s origin, and the nominal rig. An ' +
      'image-space silhouette detector would be a component this project has not built.',
    costsTheConclusion:
      'It inherits a dependence on the nominal being roughly right, and this design never tests ' +
      'a rig whose documented calibration is badly wrong. A capture where the nominal is a metre ' +
      'out — the bench’s own `long-throw` archetype — could segment much worse, and is untested.',
  },
  {
    what: 'The two mitigations are swept in separate arms, not crossed.',
    why:
      'Crossing four rooms by four thresholds by four margins is 320 solves, and the cross terms ' +
      'answer a question nobody asked: each arm holds the other axis at its shipped value so ' +
      'every comparison stays a one-axis comparison.',
    costsTheConclusion:
      'If a raised modulation floor and a segmentation margin interact — if, say, the floor ' +
      'removes exactly the annulus the margin admits — this design cannot see it.',
  },
];
