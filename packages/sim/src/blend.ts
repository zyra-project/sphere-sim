/**
 * The blend ramp — conventions.ts §B, and the arithmetic PARAMETERS.md §4.5 works
 * through to justify its one DOC-class photometric constant.
 *
 * This module owns the ramp SHAPE and the weight algebra. It knows nothing about
 * the sphere: `coverage.ts` decides where each projector's blend region is and how
 * far across it a point sits, and calls in here for the rest. Keeping the two apart
 * is what lets Experiment 2 — "does soft blending buy geometric tolerance?" — sweep
 * the ramp without touching a line of geometry.
 *
 * ## §B, restated, because two of its four clauses are easy to get backwards
 *
 * Let `t` in [0, 1] be the normalized position across a projector's blend region,
 * `t = 0` at the outer edge where it contributes nothing, `t = 1` at the inner edge
 * where it contributes fully. Then:
 *
 *  1. The unnormalized ramp is one of four shapes.
 *  2. `rampGamma` is applied to the **weight**: `w_final = w ^ rampGamma`.
 *  3. Weights across all contributing projectors are normalized to sum to one
 *     wherever at least one projector contributes.
 *  4. (render.ts, not here) the normalized weight multiplies the target radiance in
 *     LINEAR light, and the product is encoded afterwards.
 *
 * Clause 2 is the one that looks like a typo and is not. Applying the exponent to
 * the signal instead would be a per-projector gamma adjustment — a different and
 * much more visible operation — and it would break clause 3, because the weights
 * would no longer be the thing being normalized. Clause 3 is what makes the
 * exponent's effect subtle rather than catastrophic: raising both weights to 0.8
 * and renormalizing changes the SHAPE of the crossfade but leaves the sum at
 * exactly one, so no ramp exponent can create or remove a luminance step on its own.
 *
 * ## On the value 0.8, before you implement anything against it
 *
 * `γ_blend = 0.8` is class DOC — the one photometric number in PARAMETERS.md that
 * comes from a real config file, with the comment "default gamma setting for
 * projectors to facilitate edge blending". §4.5 then reads it as an inverse display
 * gamma: for two projectors to sum to unity each must emit 0.5 linear, encoded as
 * `0.5^(1/γ)`, so an exponent of 0.8 implies `γ ≈ 1.25`.
 *
 * **That reading and conventions.ts §B are not the same operation.** §4.5's 0.8 is
 * an exponent on a SIGNAL; §B's `rampGamma` is an exponent on a WEIGHT. The first
 * changes how bright the overlap is, the second cannot (clause 3 above). Both
 * readings are defensible from the config comment alone, and this package
 * implements §B because §B is the contract `packages/solver` was written against —
 * but a reader comparing simulator output to a real SOS install should know that
 * one number in the config may be doing the other job. {@link
 * displayGammaImpliedByBlendGamma} states §4.5's reading explicitly so it is
 * available to a report without anybody having to re-derive it.
 *
 * §4.5 also disposes of the obvious explanation for why 0.8 is so far from
 * `1/2.2 = 0.4545`: ambient light does not account for it. That arithmetic is
 * {@link continuityEncodedValue}, and `test/blend.test.ts` asserts it.
 */

import type { RampShape } from '../../calibration/src/index.ts';
import { clamp } from './vec.ts';

export type { RampShape };

/** Every ramp shape conventions.ts §B defines, in the order §B lists them. */
export const RAMP_SHAPES: readonly RampShape[] = ['linear', 'cosine', 'smoothstep', 'gaussian'];

/**
 * The four unnormalized ramp shapes of conventions.ts §B, evaluated at `t` in
 * [0, 1] where `t = 0` is the outer edge (this projector contributes nothing) and
 * `t = 1` the inner edge (it contributes fully).
 *
 * The gaussian is the only one that needs its endpoints forced: `exp(-4.5*(1-t)^2)`
 * is 0.0111 at t = 0, not 0, so §B specifies it normalized to hit exactly 0 and 1.
 * Skipping that renormalization leaves each projector emitting about 1% of full
 * signal past its own footprint edge, which is invisible in a bright scene and
 * reads as a rectangular halo in a dark one.
 */
export function rampValue(shape: RampShape, t: number): number {
  const x = clamp(t, 0, 1);
  switch (shape) {
    case 'linear':
      return x;
    case 'cosine':
      return 0.5 - 0.5 * Math.cos(Math.PI * x);
    case 'smoothstep':
      return x * x * (3 - 2 * x);
    case 'gaussian': {
      const g0 = Math.exp(-4.5);
      const g = Math.exp(-4.5 * (1 - x) * (1 - x));
      return (g - g0) / (1 - g0);
    }
  }
}

/**
 * conventions.ts §B clause 2: the ramp with `rampGamma` applied to the WEIGHT.
 *
 * `Math.pow(0, 0)` is 1 in IEEE arithmetic, which would make a zero-width or
 * zero-exponent ramp emit full signal past its own edge. `rampGamma <= 0` is
 * therefore rejected rather than quietly producing a rig with no blend at all.
 */
export function rampWeight(shape: RampShape, t: number, rampGamma: number): number {
  if (!(rampGamma > 0) || !Number.isFinite(rampGamma)) {
    throw new Error(
      `rampGamma must be a positive finite number (PARAMETERS.md §4.5 nominal 0.8); got ${rampGamma}`,
    );
  }
  const w = rampValue(shape, t);
  return w === 0 ? 0 : Math.pow(w, rampGamma);
}

/**
 * conventions.ts §B clause 3, in place: normalize to sum to one wherever at least
 * one projector contributes, and leave an all-zero set alone.
 *
 * Returns the pre-normalization sum, which is the only thing that distinguishes
 * "one projector at full weight" from "two projectors at half weight" after the
 * fact — and which {@link crossfadeSum} needs to make the point that the sum is not
 * one before normalization whenever `rampGamma != 1`.
 */
export function normalizeWeights(weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i];
  if (sum > 0) for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return sum;
}

/**
 * The raw sum of a symmetric two-projector crossfade at position `t`, BEFORE
 * normalization: `w(t)^γ + w(1-t)^γ`.
 *
 * This is 1 at every `t` for a linear ramp at `rampGamma = 1`, and is not 1
 * anywhere else — 1.149 at the midpoint of a linear ramp at §4.5's γ = 0.8, falling
 * back to 1 at both ends, because an exponent below 1 raises every weight below 1.
 * That excess is exactly what §B's normalization removes, and it is why the
 * normalization is a clause of the contract rather than an implementation detail:
 * without it, every ramp shape except linear-at-γ=1 puts a bright or dark band down
 * the middle of every seam, and the band's depth is a function of a constant nobody
 * has measured.
 */
export function crossfadeSum(shape: RampShape, rampGamma: number, t: number): number {
  return rampWeight(shape, t, rampGamma) + rampWeight(shape, 1 - t, rampGamma);
}

/**
 * The normalized weight one of two symmetric crossfading projectors carries at
 * position `t`. Always sums with its partner to exactly one; see {@link crossfadeSum}
 * for the quantity that does not.
 */
export function crossfadeWeight(shape: RampShape, rampGamma: number, t: number): number {
  const a = rampWeight(shape, t, rampGamma);
  const b = rampWeight(shape, 1 - t, rampGamma);
  const sum = a + b;
  return sum > 0 ? a / sum : 0;
}

/**
 * PARAMETERS.md §4.5's continuity arithmetic, with an additive floor.
 *
 * "For two projectors to sum to unity in the overlap, each must emit 0.5 linear,
 * encoded as `0.5^(1/γ)`." Including an additive floor `f` — ambient, or a black
 * floor, or both — each projector emits `(1-f)·V^γ + f` and continuity requires
 *
 *     2·[(1-f)·V^γ + f] = 1     =>     V^γ = (1 - 2f) / (2·(1 - f))
 *
 * which is the identity §4.5 states. The conclusion §4.5 draws from it is the
 * important part: at γ = 2.2 the encoded value moves from 0.730 with no floor to
 * about 0.71 with a generous one — a shift of about 2% — so **ambient light does
 * not explain the blend gamma of 0.8**. An exponent of 0.8 implies an effective
 * display transfer near 1.25 (see {@link displayGammaImpliedByBlendGamma}), which
 * is nowhere near 2.2, and a 2% nudge cannot bridge that.
 *
 * `n` generalizes §4.5's pair to an n-way overlap; PARAMETERS.md §4.2 proves n
 * never exceeds 2 on this rig, so the default is 2 and anything else is a
 * hypothetical. Returns NaN when the floors alone already exceed unity, which is
 * the honest answer: no encoded value makes that overlap sum to one.
 */
export function continuityEncodedValue(gamma: number, floor = 0, n = 2): number {
  const numerator = 1 - n * floor;
  const denominator = n * (1 - floor);
  if (!(denominator > 0) || numerator < 0) return NaN;
  return Math.pow(numerator / denominator, 1 / gamma);
}

/**
 * §4.5's reading of `γ_blend`: the display transfer exponent an encoding exponent
 * of `rampGamma` would imply, i.e. `1 / rampGamma`.
 *
 * 0.8 gives 1.25. See the module note — this is NOT what conventions.ts §B does
 * with the number, and the function exists so a report can quote §4.5's inference
 * beside the simulator's behaviour instead of one silently standing in for the
 * other. §4.5's own two candidate explanations both survive this arithmetic: a
 * projector running a flat high-brightness curve near 1.25, or an empirical
 * shaping constant tuned until the band went away.
 */
export function displayGammaImpliedByBlendGamma(rampGamma: number): number {
  return 1 / rampGamma;
}
