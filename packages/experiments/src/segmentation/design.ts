/**
 * Experiment 5 — geometric segmentation against image-space segmentation.
 *
 * ## The question
 *
 * Experiment 4 established that a room behind the sphere is fatal (paired 146x)
 * and that rejecting correspondences whose projector ray misses the NOMINAL
 * sphere recovers most of it (paired 13.6x). It also named that mitigation's
 * structural weakness: the test uses the rig the solve is trying to correct, so
 * the correspondences it CANNOT reject are exactly the ones displaced by the
 * error being solved for. Experiment 4's own "cannot tell you" list calls an
 * image-space silhouette the most important untested alternative.
 *
 * This measures it. `packages/solver/src/silhouette.ts` reads the photograph and
 * nothing else — no rig, no pose, no radius, no camera model — so it cannot
 * inherit the dependence that limits the geometric test.
 *
 * ## The falsifiers, written before the sweep ran
 *
 *   G1  Image-space segmentation does not reduce contamination. If the fraction
 *       of accepted correspondences coming from off the sphere is not lower than
 *       the geometric test leaves, the premise is wrong and nothing else matters.
 *   G2  It does not beat the geometric test on pose, paired. If the paired
 *       geometric mean of (geometric / image) is not above 1, then it is a
 *       different way to reach the same place and the simpler test wins.
 *   G3  It costs a clean capture. If it makes the no-room case worse than the
 *       shipped baseline by more than the baseline's own seed range, it is a
 *       trade rather than a fix.
 *   G4  Its one assumption does not hold. The detector assumes the ball is
 *       framed and the room runs off the frame edge. If any capture reports no
 *       interior component, or two of similar size, the rule did not decide and
 *       the method needs a fallback this experiment has not built.
 *   G5  The improvement is not consistently signed. With 30 paired seeds, if
 *       image-space does not beat geometric on a clear majority, then the
 *       geometric mean is being carried by a handful of draws.
 *
 * ## Why thirty seeds
 *
 * Experiment 4 shipped at five and its every headline factor turned out to be a
 * ratio of two single seeds. That correction is the reason this number is 30
 * rather than 5, and the reason every comparison below is paired.
 */

/** Same root as experiment 4, so seed i is the same rig draw in both. */
export const EXPERIMENT_ROOT_SEED = 20260819;
export const SEED_COUNT = 30;
export const ARCHETYPE_INDEX = 1;
export const SHIPPED_MODULATION = 0.02;

import type { CellSpec } from '../spill/design.ts';
import { DEFAULT_ROOM_SPILL } from '../../../bench/src/capture.ts';

/** The room experiment 4 calls default: a 6 m wall with a 14 ft ceiling. */
export const WALL_RADIUS_M = DEFAULT_ROOM_SPILL.wallRadiusM;

export interface Arm {
  key: string;
  label: string;
  spec: CellSpec;
}

/**
 * Five arms. Four would answer G1 and G2; the fifth answers G3, which is the
 * question that decides whether this could ever be on by default.
 */
export const ARMS: readonly Arm[] = [
  {
    key: 'clean',
    label: 'no room, no segmentation',
    spec: { wallRadiusM: null, minModulation: SHIPPED_MODULATION, segmentMarginFrac: null },
  },
  {
    key: 'room',
    label: 'room, no segmentation',
    spec: { wallRadiusM: WALL_RADIUS_M, minModulation: SHIPPED_MODULATION, segmentMarginFrac: null },
  },
  {
    key: 'geometric',
    label: 'room, geometric segmentation at margin 0',
    spec: { wallRadiusM: WALL_RADIUS_M, minModulation: SHIPPED_MODULATION, segmentMarginFrac: 0 },
  },
  {
    key: 'image',
    label: 'room, image-space segmentation',
    spec: {
      wallRadiusM: WALL_RADIUS_M,
      minModulation: SHIPPED_MODULATION,
      segmentMarginFrac: null,
      segmentImage: true,
    },
  },
  {
    key: 'image-clean',
    label: 'no room, image-space segmentation',
    spec: {
      wallRadiusM: null,
      minModulation: SHIPPED_MODULATION,
      segmentMarginFrac: null,
      segmentImage: true,
    },
  },
];

/** Every place this design is thinner than it should be, and what it costs. */
export const CUTS: readonly { what: string; why: string; costsTheConclusion: string }[] = [
  {
    what: 'One seed was run before the falsifiers were written.',
    why: 'Wiring the detector into the bench needs at least one end-to-end run to know it works at all, and that run produced numbers.',
    costsTheConclusion:
      'G1 to G5 were written knowing that seed 0 gave 9.6 mm at 0.00% contamination. They are stated so that a single favourable draw cannot satisfy them — G5 asks for a majority over 30 — but they are not blind, and a reader should treat them as pre-registered against the OTHER 29 seeds rather than against all 30.',
  },
  {
    what: 'One archetype, one room size, one decoder threshold.',
    why: 'The comparison is between two segmentations, so everything that is not the segmentation is held fixed.',
    costsTheConclusion:
      'It says nothing about whether image-space segmentation survives the long-throw archetype, where the nominal rig is nearly a metre out. That is where the GEOMETRIC test should be expected to fail worst and where this one should not care at all — which makes it the obvious next measurement and not this one.',
  },
  {
    what: 'The detector gets an all-projectors-on frame by taking the max over the per-projector white frames.',
    why: 'A single projector lights a crescent of the ball, and a crescent is not separable from a lit patch of floor by shape.',
    costsTheConclusion:
      'A real capture would shoot one extra frame with everything on rather than synthesising it from four. The two are the same image up to the sensor noise of one exposure against four, so this flatters the detector very slightly.',
  },
  {
    what: 'No occlusion, no furniture, no second bounce — inherited from experiment 4.',
    why: 'Same capture model.',
    costsTheConclusion:
      'A real rail or plinth in front of the ball would break the one assumption this detector makes, and nothing here measures that. G4 counts how often the assumption fails in THIS room, which is a floor on how often it fails in a real one.',
  },
];
