// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The per-channel transfer model — conventions.ts §P and PARAMETERS.md §3.2.
 *
 *     L = gain * ((1 - blackFloor) * V^gamma + blackFloor)      per channel
 *
 * Everything in this file is relative linear radiance: `1.0` is a single
 * projector's full output in that channel at the centre of its own footprint,
 * measured at the sphere surface (PARAMETERS.md, Conventions → Radiometry).
 *
 * ## Why the terms are per channel, and per projector
 *
 * §3.2 is unusually direct about this: "Rev 1 modeled gamma and black floor as
 * scalars. That was wrong, and it made the simulator structurally incapable of
 * reproducing the most visible real-world seam artifact: a colored band rather than
 * a bright or dark one." So there are **twelve gammas, twelve black floors and
 * twelve gains** across a four-projector rig, and a model that collapses any of the
 * three to a scalar cannot produce the artifact the project exists to study. The
 * worked example, reproduced in `test/photometry.test.ts`: two projectors each
 * asked for 0.5 linear encode it as `0.5^(1/2.2)` = 0.730; a blue channel running
 * γ = 2.4 emits `0.730^2.4` = 0.469 apiece, summing to 0.938 against 1.000 in red.
 * A 6% blue deficit that reads as a yellow band, and no scalar gamma can correct it.
 *
 * ## Every constant here is class ASSUME or MEAS
 *
 * Not one of the thirty-six numbers this module consumes has been measured. §10
 * ranks per-channel gamma divergence the single highest photometric risk in the
 * project and the black floor second, with a plausible range spanning 6x.
 * PARAMETERS.md §8 items 10-12 are the eighteen frames that would settle them.
 *
 * The consequence for this module is a rule rather than a caveat: **nothing here
 * has a default that injects divergence.** {@link nominalTransferSet} produces
 * §3.2's nominals — identical across projectors and channels — and
 * {@link divergentTransferSet} produces divergence only in the amounts a caller
 * states explicitly, from a seed, deterministically. A model that shipped a
 * plausible-looking divergence by default would put a guess inside every metric and
 * then report the metric as a result.
 */

import type { ChannelTriplet, ProjectorTransfer } from '../../calibration/src/index.ts';
import type { ColorMatrix } from './color.ts';
import { REC709_D65_RGB_TO_XYZ, cctFromChromaticity, linearRgbToXyz } from './color.ts';
import { makeRng } from './random.ts';

/** The three channel names, in the order every triple in this project is written. */
export const CHANNELS: readonly (keyof ChannelTriplet)[] = ['r', 'g', 'b'];

/**
 * conventions.ts §P for one channel.
 *
 *     L = gain * ((1 - blackFloor) * V^gamma + blackFloor)
 *
 * The black floor is ADDITIVE and survives `V = 0`, which is the entire mechanism
 * behind the overlap uplift of PARAMETERS.md §3.2 and §7: two projectors overlapping
 * in black content emit two black floors and the region reads as a brighter
 * rectangle. §10 ranks `L_black` the second highest photometric risk precisely
 * because so much SOS content is dark.
 *
 * The `(1 - blackFloor)` factor is what keeps full white at exactly 1.0 no matter
 * what the floor is, so the floor raises the black end without also raising the
 * white end. Dropping it — a common simplification — makes every projector 0.125%
 * too bright at nominal and breaks the definition of 1.0 in the Radiometry
 * convention.
 *
 * `V` is clamped to [0, 1] rather than allowed through, because a negative base
 * with a fractional exponent is NaN and one NaN poisons an entire render.
 */
export function emittedRadiance(
  signal: number,
  gamma: number,
  blackFloor: number,
  gain: number,
): number {
  const v = signal < 0 ? 0 : signal > 1 ? 1 : signal;
  return gain * ((1 - blackFloor) * Math.pow(v, gamma) + blackFloor);
}

/** {@link emittedRadiance} for all three channels of one projector. */
export function emittedRadianceRgb(signal: ChannelTriplet, t: ProjectorTransfer): ChannelTriplet {
  return {
    r: emittedRadiance(signal.r, t.gamma.r, t.blackFloor.r, t.gain.r),
    g: emittedRadiance(signal.g, t.gamma.g, t.blackFloor.g, t.gain.g),
    b: emittedRadiance(signal.b, t.gamma.b, t.blackFloor.b, t.gain.b),
  };
}

/**
 * §P inverted: the encoded value that produces a wanted linear radiance.
 *
 * This is what a compositor would have to write if it knew the projector's real
 * transfer — which is exactly the knowledge PARAMETERS.md says nobody has. It is
 * used to prove the forward model round-trips, and to express what a
 * per-projector, per-channel correction WOULD look like if the §8 measurements
 * existed. It is not used in the render path: `render.ts` encodes with the
 * compositor's ASSUMED gamma (`Scene.encodeGamma`), and the gap between the assumed
 * and the actual is the artifact under investigation.
 *
 * Returns NaN for targets the projector cannot reach — below `gain * blackFloor`
 * (it cannot emit less than its own leak) or above `gain`.
 */
export function encodedSignalFor(
  targetLinear: number,
  gamma: number,
  blackFloor: number,
  gain: number,
): number {
  if (!(gain > 0)) return NaN;
  const normalized = targetLinear / gain;
  const above = (normalized - blackFloor) / (1 - blackFloor);
  if (!(above >= 0) || above > 1) return NaN;
  return Math.pow(above, 1 / gamma);
}

/**
 * What `n` projectors emit into an overlap when their normalized blend weights sum
 * to one and the content is full white — the closed form behind the black-uplift
 * gate of PARAMETERS.md §7.
 *
 * Summing §P over `n` projectors that share one black floor `b` and whose weights
 * total 1:
 *
 *     sum = (1 - b) * SUM(w_i) + n*b = 1 + (n - 1) * b
 *
 * So the uplift is **`(n-1)` black floors, not `n`**: the `(1 - b)` factor scales
 * the signal down by exactly the one floor a single projector already carries. At
 * n = 2 and the nominal b = 1/800 that is 1.00125 — 0.125%, comfortably inside §7's
 * 2% seam-luminance gate, and a real property of the hardware rather than a
 * modelling artifact.
 *
 * Off-by-one here is the difference between a correct model and one that reports a
 * 0.25% seam step; both look fine on screen.
 */
export function overlapWhiteSum(n: number, blackFloor: number): number {
  return 1 + (n - 1) * blackFloor;
}

/**
 * The black-uplift ratio in DARK content, before any geometry or ambient:
 * `n` equal projectors each emitting their floor, over one projector's floor.
 *
 * This is exactly `n`, for any floor and any gain. That is worth stating as a
 * function rather than as a comment, because it is the reason §7's black-uplift
 * gate cannot be read as a statement about the projectors alone: at n = 2 the
 * emitted ratio is 2.00 against a gate of 1.20, always, no matter what any of the
 * twelve black floors turn out to be. What makes the observed ratio finite and
 * interesting is everything §7 leaves implicit — ambient light in the room, and the
 * fact that on a SPHERE the overlap sits exactly where both projectors are at their
 * most oblique. `metrics/photometric.ts` measures the observed ratio and reports
 * this one beside it.
 */
export function emittedBlackUpliftRatio(n: number): number {
  return n;
}

/**
 * The observed black-uplift ratio once a floor of ambient light is present:
 * `(ambient + overlapFromProjectors) / (ambient + singleFromProjectors)`.
 *
 * All three arguments are radiance in the same relative units, already through
 * reflectance and geometry. With `ambient = 0` this collapses to the emitted ratio
 * above. With PARAMETERS.md §5's nominal `E_amb` = 0.04 and a black floor delivered
 * at grazing incidence it is a few percent. Which of those two numbers §7's 1.20
 * gate was written against is not stated, and the difference decides whether the
 * gate passes — see the note on the metric.
 */
export function observedBlackUpliftRatio(
  ambient: number,
  overlapFromProjectors: number,
  singleFromProjectors: number,
): number {
  const denominator = ambient + singleFromProjectors;
  if (!(denominator > 0)) return NaN;
  return (ambient + overlapFromProjectors) / denominator;
}

/** PARAMETERS.md §3.2 nominals: gamma 2.2, black floor 1/800, unit gain, 6500 K. */
export function nominalTransfer(overrides: Partial<ProjectorTransfer> = {}): ProjectorTransfer {
  return {
    gamma: overrides.gamma ?? { r: 2.2, g: 2.2, b: 2.2 },
    blackFloor: overrides.blackFloor ?? { r: 1 / 800, g: 1 / 800, b: 1 / 800 },
    gain: overrides.gain ?? { r: 1, g: 1, b: 1 },
    whitePointK: overrides.whitePointK ?? 6500,
  };
}

/** `count` projectors, all carrying PARAMETERS.md §3.2's nominal transfer. */
export function nominalTransferSet(
  count: number,
  overrides: Partial<ProjectorTransfer> = {},
): ProjectorTransfer[] {
  return Array.from({ length: count }, () => nominalTransfer(overrides));
}

/**
 * How far apart to spread the twelve gammas, twelve floors and twelve gains.
 *
 * Every field defaults to ZERO. That is the whole design of this type: asking for
 * divergence is an explicit act with a stated magnitude and a stated seed, so that
 * no metric anywhere in the project can quietly become a statement about a number
 * somebody invented. PARAMETERS.md §8 items 10-12 are what would replace it.
 */
export interface TransferDivergence {
  /**
   * Peak-to-peak spread of the transfer exponent across the twelve channels.
   * §3.2: "Real projectors diverge 0.1-0.3 between channels." A stated RANGE, not
   * a sigma, so it is applied as a uniform draw across the full width.
   */
  gammaSpread?: number;
  /**
   * Multiplicative spread of the black floor, as a factor. §3.2's plausible range
   * is 1/2000 to 1/300 around a nominal 1/800, i.e. roughly a factor of 2.7 either
   * way; a value of 2.7 here draws each of the twelve floors log-uniformly in
   * [nominal/2.7, nominal*2.7]. Log-uniform rather than uniform because the range
   * is stated as a ratio and because a floor cannot go negative.
   */
  blackFloorFactor?: number;
  /**
   * Peak-to-peak spread of channel gain. §3.2: "Lamp aging diverges between
   * projectors. Four lamps at different hour counts give four different white
   * points." No range is published — docs/AMENDMENTS.md A-04 records that gap.
   */
  gainSpread?: number;
  /** Seed. Two calls with the same seed and spreads must produce identical sets. */
  seed?: number;
}

/**
 * `count` projector transfers with per-channel divergence drawn deterministically
 * from `divergence`, around the §3.2 nominals.
 *
 * Draw order is fixed and is the order the fields are declared — gamma r/g/b, then
 * black floor r/g/b, then gain r/g/b, projector by projector. Reordering the draws
 * changes every scenario in a corpus even though no magnitude changed, so treat the
 * order as part of the interface, exactly as `scene.ts` does for misalignment.
 *
 * With no argument this returns {@link nominalTransferSet}: identical transfers, no
 * chromatic seam possible. That is not a convenient default, it is the honest one —
 * §3.2's artifact requires divergence, and the amount of divergence is unmeasured.
 */
export function divergentTransferSet(
  count: number,
  divergence: TransferDivergence = {},
): ProjectorTransfer[] {
  const gammaSpread = divergence.gammaSpread ?? 0;
  const blackFloorFactor = divergence.blackFloorFactor ?? 1;
  const gainSpread = divergence.gainSpread ?? 0;
  const rng = makeRng(divergence.seed ?? 0);
  const base = nominalTransfer();

  const out: ProjectorTransfer[] = [];
  for (let i = 0; i < count; i++) {
    const gamma = drawTriplet(() => base.gamma.r + gammaSpread * (rng.nextFloat() - 0.5));
    const logFactor = Math.log(blackFloorFactor > 0 ? blackFloorFactor : 1);
    const blackFloor = drawTriplet(
      () => base.blackFloor.r * Math.exp(logFactor * (2 * rng.nextFloat() - 1)),
    );
    const gain = drawTriplet(() => base.gain.r + gainSpread * (rng.nextFloat() - 0.5));
    out.push({ gamma, blackFloor, gain, whitePointK: base.whitePointK });
  }
  return out;
}

function drawTriplet(draw: () => number): ChannelTriplet {
  const r = draw();
  const g = draw();
  const b = draw();
  return { r, g, b };
}

/**
 * A transfer set with every channel of every projector forced to agree — the
 * channel-matched counterfactual.
 *
 * `reference` picks whose numbers everybody copies; the default is projector 0's
 * red channel. This is the rig on which a chromatic seam is impossible by
 * construction, so the difference between a field rendered with the real set and
 * one rendered with this set isolates the effect of §3.2's divergence from every
 * geometric term at once. `metrics/photometric.ts` uses it for exactly that, and
 * says plainly that it is a simulation-only differential no photograph can produce.
 */
export function channelMatchedTransferSet(
  set: readonly ProjectorTransfer[],
  reference = 0,
): ProjectorTransfer[] {
  const ref = set[reference];
  if (!ref) throw new Error(`no projector at index ${reference} to match against`);
  const flat: ProjectorTransfer = {
    gamma: { r: ref.gamma.r, g: ref.gamma.r, b: ref.gamma.r },
    blackFloor: { r: ref.blackFloor.r, g: ref.blackFloor.r, b: ref.blackFloor.r },
    gain: { r: ref.gain.r, g: ref.gain.r, b: ref.gain.r },
    whitePointK: ref.whitePointK,
  };
  return set.map(() => ({
    gamma: { ...flat.gamma },
    blackFloor: { ...flat.blackFloor },
    gain: { ...flat.gain },
    whitePointK: flat.whitePointK,
  }));
}

/**
 * PARAMETERS.md §3.2's `wp_i`: "White point (CCT) ... Derived from `g`; tracked
 * separately for reporting."
 *
 * The three gains ARE a white point — full white through the transfer is the gain
 * triple — so this converts that triple to a correlated colour temperature rather
 * than trusting `ProjectorTransfer.whitePointK`, which the spec describes as
 * reported rather than applied. A rig whose stored `whitePointK` disagrees with the
 * one its gains imply is over-specified, and this is how a report notices.
 *
 * Meaningful only near the Planckian locus; the chromaticity is returned alongside
 * so a caller can see how far off it is.
 */
export function whitePointOfTransfer(
  t: ProjectorTransfer,
  m: ColorMatrix = REC709_D65_RGB_TO_XYZ,
): { cctK: number; x: number; y: number } {
  const xyz = linearRgbToXyz(t.gain, m);
  const sum = xyz.X + xyz.Y + xyz.Z;
  if (!(sum > 0)) return { cctK: NaN, x: NaN, y: NaN };
  const xy = { x: xyz.X / sum, y: xyz.Y / sum };
  return { cctK: cctFromChromaticity(xy), x: xy.x, y: xy.y };
}

/** Min, max and spread of one transfer term over a whole rig. */
export interface TermSpread {
  min: number;
  max: number;
  /** `max - min` for gamma and gain; `max / min` for the black floor. */
  spread: number;
  /** How many distinct values the rig carries for this term. */
  distinct: number;
}

/** Every per-channel term across a rig, summarised. Twelve values per row. */
export interface TransferSummary {
  projectorCount: number;
  /** `3 * projectorCount` — the count §3.2 calls out as "12 values across the rig". */
  valuesPerTerm: number;
  gamma: TermSpread;
  blackFloor: TermSpread;
  gain: TermSpread;
  /** True when every channel of every projector agrees on all three terms. */
  channelMatched: boolean;
}

/**
 * Summarise a rig's transfer set, so a report can say "twelve gammas spanning
 * 2.15 to 2.31" instead of printing thirty-six numbers or, worse, one.
 */
export function summariseTransfers(set: readonly ProjectorTransfer[]): TransferSummary {
  const gammas: number[] = [];
  const floors: number[] = [];
  const gains: number[] = [];
  for (const t of set) {
    for (const c of CHANNELS) {
      gammas.push(t.gamma[c]);
      floors.push(t.blackFloor[c]);
      gains.push(t.gain[c]);
    }
  }
  const gamma = spreadOf(gammas, 'difference');
  const blackFloor = spreadOf(floors, 'ratio');
  const gain = spreadOf(gains, 'difference');
  return {
    projectorCount: set.length,
    valuesPerTerm: gammas.length,
    gamma,
    blackFloor,
    gain,
    channelMatched: gamma.distinct === 1 && blackFloor.distinct === 1 && gain.distinct === 1,
  };
}

function spreadOf(values: number[], kind: 'difference' | 'ratio'): TermSpread {
  if (values.length === 0) return { min: NaN, max: NaN, spread: NaN, distinct: 0 };
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const distinct = new Set(values).size;
  const spread = kind === 'ratio' ? (min > 0 ? max / min : NaN) : max - min;
  return { min, max, spread, distinct };
}
