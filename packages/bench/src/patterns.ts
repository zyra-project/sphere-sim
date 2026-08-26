// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The structured-light pattern sequence, generated against the normative
 * definition at the top of `packages/solver/src/decode.ts`.
 *
 * That definition is a CONTRACT, not shared code: it is prose describing what a
 * projector must put on the sphere, in the same way conventions.ts describes
 * what a `RigCalibration`'s numbers mean. The bench implements the emitter side
 * of it here and the solver implements the reader side there, and if the two
 * disagree the decode collapses and the bench reports it. What would be
 * circular is the bench importing the solver's *decoder* to build its patterns;
 * what is merely correct is both sides implementing the same written spec.
 *
 * ## Patterns are specified in LINEAR RADIANCE, and that has a consequence
 * ## worth stating
 *
 * decode.ts requires it: a sinusoid emitted as an encoded *signal* arrives at
 * the sphere distorted by the projector's per-channel gamma (conventions.ts §P,
 * PARAMETERS.md §3.2, every term class ASSUME), and its harmonics bias the phase
 * estimate. Pushing the transfer compensation onto the generator keeps an
 * unmeasured photometric constant out of a geometric measurement.
 *
 * Work the inversion through and something useful falls out. §P says
 *
 *     L = gain * ((1 - blackFloor) * V^gamma + blackFloor)
 *
 * so to deliver a target linear radiance `T` the generator emits
 *
 *     V = ((T/gain - blackFloor) / (1 - blackFloor)) ^ (1/gamma)
 *
 * and substituting straight back gives `L = T` exactly, for every `T` the
 * projector can actually reach. Outside that range `V` clamps and the emitted
 * radiance clamps with it. So the whole per-channel transfer collapses to
 *
 *     emitted(T) = clamp(T, gain*blackFloor, gain)
 *
 * — no `pow`, no gamma, no dependence on any ASSUME-class exponent. `gamma`
 * genuinely drops out of the capture, which is precisely the property decode.ts
 * asks for and the reason it asks for it. What does NOT drop out is the black
 * floor: a projector commanded to emit zero still leaks `gain * blackFloor`,
 * and that leak is what sets the modulation floor the decoder rejects on.
 * {@link emittedRadianceForTarget} is that one-line result, and
 * `test/patterns.test.ts` checks it against `packages/sim`'s own forward
 * transfer rather than against itself.
 */

import type { ProjectorTransfer } from '../../calibration/src/index.ts';

export type PatternAxis = 'u' | 'v';

export interface PatternPlan {
  /**
   * Gray planes per axis. The Gray stride is `res / 2^bits`, so more bits means
   * a finer address and a finer fringe — but the finest feature has to survive
   * being imaged by the camera. See {@link grayBitsForCamera}.
   */
  grayBits: number;
  /**
   * Phase steps. decode.ts: an N-step estimator rejects every harmonic except
   * those congruent to +/-1 mod N, so 4 rejects the second and third and 3
   * rejects neither. Four is the floor, not a default to drift below.
   */
  phaseSteps: number;
  /**
   * Fringe period as a multiple of the Gray stride. decode.ts requires an even
   * multiple, two being the natural choice: the Gray address must be finer than
   * one fringe or the fringe order is undetermined, and if the two scales were
   * EQUAL then every Gray misread would displace the coarse estimate by a whole
   * fringe, the unwrap would silently agree, and the cross-check could never
   * fire.
   */
  phasePeriodStrides: number;
  /**
   * Explicit all-on and all-off frames (PARAMETERS.md §8 items 6-9). The decoder
   * can synthesise them from the Gray pattern/complement pairs at no cost, so
   * this buys robustness rather than capability — but it is what a real capture
   * shoots, and shooting it makes the modulation reference independent of the
   * pattern set.
   */
  includeWhiteBlack: boolean;
}

export const DEFAULT_PATTERN_PLAN: PatternPlan = {
  grayBits: 6,
  phaseSteps: 4,
  phasePeriodStrides: 2,
  includeWhiteBlack: true,
};

/**
 * How many Gray planes a camera of this resolution can actually read.
 *
 * The failure this prevents is quiet. A 1920-pixel projector with 7 Gray planes
 * has a 15-pixel stride; a 320-pixel camera 2.6 m from a sphere lit from 5.18 m
 * covers about 6.4 projector pixels per camera pixel, so that stride is barely
 * two camera pixels wide and the finest Gray plane is at the camera's Nyquist
 * limit. It decodes — badly, and in a way that looks like decoder noise rather
 * than like an under-resolved pattern.
 *
 * So the plane count is derived from the geometry instead of picked: choose the
 * largest `bits` whose stride still spans `minCameraPixelsPerStride` camera
 * pixels, given the ratio of angular pixel pitches. A real operator makes the
 * same choice with the same arithmetic, which is why it belongs in the capture
 * rather than in a constant.
 *
 * `projPxPerCamPx` is measured at the sub-camera point of the sphere, where the
 * camera's pixels are smallest — the conservative end.
 */
export function grayBitsForCamera(
  projectorRes: number,
  projPxPerCamPx: number,
  minCameraPixelsPerStride = 4,
  maxBits = 8,
): number {
  const minStridePx = minCameraPixelsPerStride * projPxPerCamPx;
  let bits = 1;
  for (let b = 1; b <= maxBits; b++) {
    if (projectorRes / Math.pow(2, b) >= minStridePx) bits = b;
  }
  return bits;
}

/** One frame of the sequence. The order of this list IS the capture order. */
export interface FrameSpec {
  kind: 'white' | 'black' | 'gray' | 'grayInverse' | 'phase';
  axis: PatternAxis | null;
  /** Gray plane index, 0 = MSB. Or phase step index. */
  index: number;
}

export function strideFor(res: number, bits: number): number {
  return res / Math.pow(2, bits);
}

/**
 * Every frame, in capture order: white, black, then per axis the Gray planes
 * MSB first each immediately followed by its complement, then the phase steps.
 *
 * Pairing each Gray plane with its own complement ADJACENTLY is not cosmetic.
 * The decoder reads a bit as `pattern > inverse`, and that comparison is what
 * cancels albedo, ambient and the cos-incidence falloff — but only to the extent
 * that the two frames saw the same scene. Under handheld motion the scene drifts
 * with time, so putting the complement next to its pattern minimises the
 * interval over which the cancellation has to hold. Shooting all the patterns
 * and then all the complements would be the same frames in an order that
 * maximises it.
 */
export function planFrames(plan: PatternPlan, axes: PatternAxis[] = ['u', 'v']): FrameSpec[] {
  const out: FrameSpec[] = [];
  if (plan.includeWhiteBlack) {
    out.push({ kind: 'white', axis: null, index: 0 });
    out.push({ kind: 'black', axis: null, index: 0 });
  }
  for (const axis of axes) {
    for (let j = 0; j < plan.grayBits; j++) {
      out.push({ kind: 'gray', axis, index: j });
      out.push({ kind: 'grayInverse', axis, index: j });
    }
  }
  for (const axis of axes) {
    for (let n = 0; n < plan.phaseSteps; n++) {
      out.push({ kind: 'phase', axis, index: n });
    }
  }
  return out;
}

/** `code ^ (code >> 1)`, the standard binary-reflected Gray code. */
export function binaryToGray(v: number): number {
  return v ^ (v >>> 1);
}

/**
 * One frame's pattern, with every constant already resolved.
 *
 * The target radiance of a frame depends on exactly one raster coordinate — or
 * on none at all, for the white and black frames — so a frame compiles down to
 * an axis and a scalar function of that coordinate. The renderer calls this
 * once per frame and then walks a hundred thousand pixels through `at`, which
 * is the difference between recomputing `Math.pow(2, bits)` thirty million
 * times and computing it thirty-four.
 *
 * More importantly it means the pattern is DEFINED once. The obvious way to
 * make the render loop fast is to inline the Gray arithmetic into it, and then
 * the repository contains two statements of what a Gray plane is — the one the
 * documentation points at and the one that actually ran.
 */
export interface CompiledFrame {
  /** The coordinate this frame varies along, or null when it is a flat field. */
  axis: PatternAxis | null;
  /** Target linear radiance. Constant frames ignore the argument. */
  at(coord: number): number;
}

export function compileFrame(
  spec: FrameSpec,
  plan: PatternPlan,
  resX: number,
  resY: number,
): CompiledFrame {
  if (spec.kind === 'white') return { axis: null, at: (): number => 1 };
  if (spec.kind === 'black') return { axis: null, at: (): number => 0 };

  const axis = spec.axis === 'u' ? 'u' : 'v';
  const res = axis === 'u' ? resX : resY;
  const stride = strideFor(res, plan.grayBits);

  if (spec.kind === 'gray' || spec.kind === 'grayInverse') {
    const codeMax = Math.pow(2, plan.grayBits) - 1;
    const shift = plan.grayBits - 1 - spec.index;
    const inverted = spec.kind === 'grayInverse';
    return {
      axis,
      at(coord: number): number {
        let code = Math.floor(coord / stride);
        if (code < 0) code = 0;
        else if (code > codeMax) code = codeMax;
        const bit = (binaryToGray(code) >>> shift) & 1;
        return inverted ? 1 - bit : bit;
      },
    };
  }

  const omega = (2 * Math.PI) / (stride * plan.phasePeriodStrides);
  const phase = (2 * Math.PI * spec.index) / plan.phaseSteps;
  return { axis, at: (coord: number): number => 0.5 + 0.5 * Math.cos(omega * coord - phase) };
}

/**
 * The target LINEAR radiance this frame asks for at projector coordinate
 * `(u, v)`, both continuous and in the projector's own raster.
 *
 * Evaluated at the coordinate the camera pixel actually sees rather than at a
 * projector pixel centre. That is a deliberate omission of the projector's own
 * pixel quantization, and it is the right omission here: this bench does not
 * model the projector's pixel footprint or its fill factor (PARAMETERS.md §9
 * lists screen-door structure as unmodelled), so quantizing the pattern without
 * also blurring it by the footprint would add a staircase that no real
 * projector puts on a sphere. The pattern's finest feature is kept several
 * camera pixels wide by {@link grayBitsForCamera} precisely so that this
 * distinction stays below the measurement.
 */
export function targetRadiance(
  spec: FrameSpec,
  u: number,
  v: number,
  plan: PatternPlan,
  resX: number,
  resY: number,
): number {
  const frame = compileFrame(spec, plan, resX, resY);
  return frame.at(frame.axis === 'v' ? v : u);
}

/**
 * Linear radiance actually emitted, per channel, for a target `T`.
 *
 * See the module note: inverting §P exactly makes this `clamp(T, gain*floor,
 * gain)` and nothing more. Returned as a triple because PARAMETERS.md §3.2 gives
 * twelve black floors and twelve gains across a four-projector rig, and a
 * divergent floor tints the residual leak — which is the mechanism §3.2 is
 * about, even though the geometric capture only feels it as a modulation floor.
 */
export function emittedRadianceForTarget(
  target: number,
  transfer: ProjectorTransfer,
): { r: number; g: number; b: number } {
  const one = (gain: number, floor: number): number => {
    const lo = gain * floor;
    const hi = gain;
    return target < lo ? lo : target > hi ? hi : target;
  };
  return {
    r: one(transfer.gain.r, transfer.blackFloor.r),
    g: one(transfer.gain.g, transfer.blackFloor.g),
    b: one(transfer.gain.b, transfer.blackFloor.b),
  };
}

/**
 * The signal the compositor would write for a target radiance — the actual
 * inversion of §P, used only to prove {@link emittedRadianceForTarget} in
 * `test/patterns.test.ts` by running it back through `packages/sim`'s forward
 * transfer.
 *
 * Not on the render path. If it were, every pattern pixel would cost three
 * `pow` calls to produce a number the closed form already gives exactly.
 */
export function signalForTarget(
  target: number,
  gamma: number,
  blackFloor: number,
  gain: number,
): number {
  const inner = (target / gain - blackFloor) / (1 - blackFloor);
  if (!(inner > 0)) return 0;
  if (inner >= 1) return 1;
  return Math.pow(inner, 1 / gamma);
}

/**
 * Rec.709 linear luminance weights.
 *
 * The capture is rendered as a single luminance channel, matching the decoder's
 * default (`decode.ts`, `DecodeChannel = 'luminance'`) and its reasoning: it is
 * the highest-SNR combination of a three-channel capture, and every per-channel
 * term PARAMETERS.md §3.2 warns about cancels in a pattern-versus-complement
 * comparison anyway. Rendering three channels would triple the cost of the
 * hottest loop in the bench to carry information the decoder immediately
 * collapses.
 */
export const LUMINANCE_WEIGHTS = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/**
 * The Gray plane kept as an artifact: coarse enough to read in a thumbnail,
 * fine enough to show the sphere's curvature bending it.
 *
 * Found by SEARCHING the frame plan rather than by computing an offset into it.
 * An offset would be a second place that knows the capture order, and the first
 * place to notice they had drifted apart would be a PNG that looked slightly
 * wrong to nobody in particular.
 *
 * It lives here, beside `planFrames`, for the same reason: the bench keeps one
 * of these frames as a PNG artifact and the browser app shows one per camera, so
 * a copy in each would be two places that know the capture order.
 */
export function previewFrameIndex(plan: PatternPlan): number {
  const specs = planFrames(plan);
  const wanted = Math.min(3, Math.max(0, plan.grayBits - 3));
  const i = specs.findIndex((s) => s.kind === 'gray' && s.axis === 'u' && s.index === wanted);
  return i >= 0 ? i : 0;
}
