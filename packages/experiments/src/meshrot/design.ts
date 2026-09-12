// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 6: what makes the ellipsoid's projector rotation worse than the
 * sphere's, on the same rig and the same photons.
 *
 * ## The finding this starts from
 *
 * `docs/ARBITRARY-SHAPES.md` reports the `mesh` archetype recovering projector
 * rotation at 0.171 / 0.042 / 0.116 degrees against `nominal`'s 0.038 / 0.035 /
 * 0.051 on root seeds 1234, 77 and 20240001 — two to four times worse on two
 * seeds of three. It records that as "inside A-12's shift/pointing degeneracy
 * (0.01 of shift is 0.172 degrees of yaw) ... and NOT YET ATTRIBUTED". Parking a
 * number next to a plausible mechanism is not attributing it, and the document
 * says so. This measures it.
 *
 * ## Why the obvious test is the wrong one
 *
 * A-18 convicted A-16 of holding a parameter at a value it knew to be wrong:
 * "Holding a parameter at a known-wrong value measures whether the wrong value
 * hurts. It says nothing about whether the parameter is degenerate." That trap
 * is live here. §3.1's nominal lens shift is ZERO, `injectMisalignment` draws
 * the truth from N(0, 0.01 · misalignmentScale), and `solve` centres its shift
 * prior on the nominal it is handed. So the reflex test — turn `shiftSigma` up
 * and watch the rotation fall — pins shift at a value that is wrong by
 * construction, and A-16's mistake is repeated exactly.
 *
 * Hence three arms rather than two. `nominal-tight` is A-16's test, kept as a
 * CONTROL rather than discarded: if it behaves differently from `truth-tight`
 * then A-18's methodological point is reproduced here on data it never saw, and
 * if it does not, A-18 is wrong about this parameter and that is worth knowing.
 */

/** Root seed for this experiment's own scenario seeds. Never a bench seed. */
export const EXPERIMENT_ROOT_SEED = 20260911;

/**
 * How many seeds.
 *
 * Thirty, and the count is not arbitrary. Earlier in this project a five-seed
 * sweep produced a confident decision that thirty seeds on the right body
 * reversed. The per-seed scatter here is the same order as the effect being
 * measured — `nominal` alone spans 0.035 to 0.051 across the three documented
 * seeds — so a handful of draws cannot separate a real gap from the scatter.
 */
export const SEED_COUNT = 30;

/**
 * The three root seeds the document reports, run first and reported separately.
 *
 * A sweep that cannot reproduce the number it set out to explain has not
 * explained it, so these are measured on their own terms before the wider set
 * is allowed to average over them.
 */
export const DOCUMENTED_SEEDS = [1234, 77, 20240001] as const;

/**
 * The tight arm's width: one order of magnitude below the truth's own spread.
 *
 * `ParameterPrior` rejects a zero width — "a zero-width prior is a hold, not a
 * prior" — so the tightest available statement is a narrow one. 1e-3 against
 * the N(0, 0.01) the truth is drawn from is a factor of ten, ONE order, and it
 * is a soft penalty rather than a hold: the residual is (value - mean) / sigma
 * added to the objective, so the data can still move the parameter if it has
 * enough to say. Calling it "effectively held" is shorthand for how little it
 * travels in practice, not a claim that it cannot.
 */
export const TIGHT_SIGMA = 1e-3;

/**
 * A-12's own width, in its own units: the shift worth one degree of pointing,
 * against §2's stated 1-2 degree mount tolerance. Included because the REMEDY
 * A-12 proposes is an operator reading the shift off the projector's menu,
 * which produces a measurement with a width and not a constant — so this arm is
 * the realistic version of `truth-tight`, and the gap between the two is what
 * the remedy would actually cost.
 */
export const LOOSE_SIGMA = 0.058;

export interface Arm {
  key: string;
  /** What this arm tells the solver about lens shift. */
  question: string;
  shiftSigma: number;
  shiftFromTruth: boolean;
}

/**
 * The ladder between the two widths the first round measured.
 *
 * Round 1 measured 0.001 and 0.058 and found 75% of the error removed at one
 * and 2.8% at the other, then said plainly that two points do not locate a
 * knee. This is the sweep that does. It is the number A-12 actually needs: the
 * amendment proposes "a plausible range in §3.1, in the same spirit as §2's
 * ±1-2° mount tolerance", and whether such a range is worth stating depends
 * entirely on where the benefit appears.
 *
 * Geometric, not linear. The candidate answers span nearly two orders, and a
 * linear ladder would spend most of its points in the half that is already
 * known to do nothing.
 */
const LADDER = [0.003, 0.008, 0.021, 0.038] as const;

export const ARMS: readonly Arm[] = [
  {
    key: 'free',
    question: 'Shipped. Lens shift is free and the rotation gate wears the result.',
    shiftSigma: 0,
    shiftFromTruth: false,
  },
  {
    key: 'nominal-tight',
    question: "A-16's test: shift pinned at §3.1's nominal of zero, which is wrong by construction.",
    shiftSigma: TIGHT_SIGMA,
    shiftFromTruth: false,
  },
  {
    key: 'truth-tight',
    question: "A-18's test: shift pinned at TRUTH, as a diagnostic the solver could never run.",
    shiftSigma: TIGHT_SIGMA,
    shiftFromTruth: true,
  },
  {
    key: 'truth-loose',
    question: "A-12's remedy, priced: the installer read the shift off the menu, to a width.",
    shiftSigma: LOOSE_SIGMA,
    shiftFromTruth: true,
  },
  // The ladder. Same shape as `truth-tight` and `truth-loose`, which are its
  // endpoints, so the seven widths read as one curve rather than as two
  // measurements with a gap between them.
  ...LADDER.map((sigma) => ({
    key: `truth-${sigma}`,
    question: `The ladder between 0.001 and 0.058: how precise must a shift reading be, at sigma ${sigma}?`,
    shiftSigma: sigma,
    shiftFromTruth: true,
  })),
];

/** The two bodies, paired by construction — see bench/test/scenarios.test.ts. */
export const BODIES = ['nominal', 'mesh'] as const;
export type Body = (typeof BODIES)[number];
