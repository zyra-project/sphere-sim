// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Structured-light decode: camera images -> (camera pixel, projector pixel)
 * correspondences, each with an honest uncertainty.
 *
 * Two coding schemes, used together, because each covers the other's weakness:
 *
 *  - **Gray code** gives an unambiguous integer address with no unwrapping
 *    problem, and each bit is read by comparing a pattern against its own
 *    complement. That comparison is what makes it survive the sphere: the
 *    surface albedo, the ambient term (PARAMETERS.md §5, `E_amb` 0.01-0.15
 *    relative and unmeasured), and the cos-incidence falloff of §4.1 all scale
 *    the two frames identically and cancel in the difference. Only the sign
 *    survives, and the sign is the bit.
 *
 *  - **Phase shift** gives sub-pixel position but only modulo one fringe. The
 *    Gray code supplies the fringe order.
 *
 * Everything is decoded from LINEAR light. The images arrive as linear-light
 * float buffers, and the phase patterns are specified below as linear radiance
 * fractions, not as encoded signal. That is not a detail: conventions.ts §P
 * makes the projector's transfer `L = gain*((1-blackFloor)*V^gamma + blackFloor)`
 * with gamma per channel and class ASSUME, so a sinusoid emitted as *signal*
 * arrives at the sphere as a distorted sinusoid whose harmonics bias the phase
 * estimate. Specifying the pattern in linear radiance pushes that compensation
 * onto whoever generates the patterns, where the transfer is actually known,
 * and keeps an unmeasured photometric constant out of a geometric measurement.
 *
 * ---------------------------------------------------------------------------
 * PATTERN DEFINITION — normative for anyone generating input for this decoder.
 *
 * Let `s` be the projector-raster coordinate along the sequence's axis,
 * evaluated at the PIXEL CENTRE, so the first column's centre is s = 0.5
 * (conventions.ts §I).
 *
 * Gray, `bits` planes, MSB first, `stridePx = res / 2^bits`:
 *   code(s)      = clamp(floor(s / stridePx), 0, 2^bits - 1)
 *   gray(s)      = code XOR (code >> 1)
 *   pattern[j]   = 1 if bit (bits-1-j) of gray(s) is set, else 0
 *   inverse[j]   = 1 - pattern[j]
 *
 * Phase, `steps` frames, period `periodPx` projector pixels:
 *   frame[n](s)  = 0.5 + 0.5 * cos(2*pi*s/periodPx - 2*pi*n/steps)
 *
 * Use `steps >= 4`. An N-step estimator is blind to every harmonic except those
 * congruent to +/-1 mod N, so N=4 rejects the second and third harmonics that
 * any residual transfer nonlinearity produces, while N=3 rejects neither.
 *
 * Choose `periodPx` as an even multiple of `stridePx`, two being the natural
 * choice. The Gray address has to be FINER than one fringe or the fringe order
 * is not determined, and — less obviously — if `periodPx` equals `stridePx`
 * exactly then every Gray misread displaces the coarse estimate by a whole
 * number of fringes, the unwrap picks a different order, and the
 * Gray-versus-phase cross-check below can never fire. The cross-check is only
 * as good as the incommensurability between the two scales.
 *
 * CAPTURE ORDER. The frames are shot in the order they appear in a
 * `PatternCapture`: the white and black references first if present, then each
 * Gray sequence in array order with every plane immediately followed by its own
 * complement, then each phase sequence in array order. That order is normative
 * for the same reason the patterns are: a decoder that wants to know which of a
 * correspondence's two coordinates was photographed FIRST, and how far apart
 * they were — see `Correspondence.timeU` — can only get it from the structure
 * of its own input. Note that it is the ORDER and the SEPARATION that carry the
 * information a solver can use, not a wall clock: PARAMETERS.md §8 should be
 * asking for the pattern order rather than for frame timestamps, which is the
 * correction round 4 made to docs/AMENDMENTS.md A-34.
 * ---------------------------------------------------------------------------
 */

/** A linear-light image. `channels` is 1 (luminance) or 3 (RGB, interleaved). */
export interface LinearImage {
  width: number;
  height: number;
  channels: number;
  data: Float32Array | Float64Array;
}

export type DecodeAxis = 'u' | 'v';
export type DecodeChannel = 'luminance' | 'r' | 'g' | 'b';

export interface GraySequence {
  axis: DecodeAxis;
  bits: number;
  /** Projector pixels per code step. Normally `res / 2^bits`. */
  stridePx: number;
  /** MSB first. */
  patterns: LinearImage[];
  /** Complement of `patterns`, same order. */
  inverses: LinearImage[];
}

export interface PhaseSequence {
  axis: DecodeAxis;
  steps: number;
  periodPx: number;
  frames: LinearImage[];
}

/**
 * Everything one camera saw of one projector.
 *
 * One projector at a time is not a simplification, it is the capture protocol:
 * PARAMETERS.md §4.2 shows overlap multiplicity reaches 2 in the seams, and two
 * projectors patterning simultaneously would make the seam — the region the
 * whole exercise exists to align — the one region that cannot be decoded.
 */
export interface PatternCapture {
  camera: number;
  projector: number;
  projectorRes: { x: number; y: number };
  /** All-on and all-off frames. Optional; see `referencePlanes` for the fallback. */
  white: LinearImage | null;
  black: LinearImage | null;
  gray: GraySequence[];
  phase: PhaseSequence[];
}

export interface DecodeOptions {
  channel: DecodeChannel;
  /**
   * Absolute floor on the per-pixel (white - black) modulation. Below it the
   * pixel is off-sphere, shadowed, or past the limb, and nothing it reports is
   * meaningful. In the units of the input buffers, where conventions.ts §P
   * defines 1.0 as one projector's full output at the centre of its footprint.
   */
  minModulation: number;
  /** A Gray bit must separate by this fraction of the pixel's own modulation. */
  minBitSeparation: number;
  /** Phase amplitude must reach this fraction of the pixel's own modulation. */
  minPhaseModulation: number;
  /** Reject when Gray and phase disagree by more than this fraction of a period. */
  unwrapToleranceFrac: number;
  /** Assumed per-sample intensity noise when the fit cannot estimate one (steps < 4). */
  noiseSigma: number;
  /** Floor on reported sigma, projector pixels. */
  minSigmaPx: number;
  /**
   * How many signal-level bins the pooled intensity-noise estimate uses.
   * 0 falls back to estimating the noise from each pixel's own phase residual.
   *
   * The fallback is what this decoder used to do and it is statistically
   * indefensible with four phase steps. Fitting `A + B*cos(phi - 2*pi*n/N)` to
   * N samples leaves `N - 3` residual degrees of freedom, so at the recommended
   * N = 4 the per-pixel noise estimate is `sigma * |z|` for a standard normal
   * `z`: an unbiased-in-square estimate with a 100% relative standard error and
   * mass arbitrarily close to zero. The bundle then weights by `1/sigma^2`, so a
   * pixel that draws `|z| = 0.03` is handed a thousand times the weight it has
   * earned, and the outlier pass — which compares `|r|/sigma` against a
   * threshold — preferentially discards the pixels whose sigma came out
   * smallest, which is to say at random. Measured on this bench's corpus, the
   * per-pixel estimate spread a factor of thirty across its own deciles while
   * the actual decode error spread a factor of two, and the rank correlation
   * between the two was 0.05-0.20.
   *
   * The noise level is a property of the sensor and of the pixel's own signal
   * level, not of one pixel's luck, so it is pooled: bin every usable pixel by
   * its fitted DC level, take the median absolute residual in each bin, and
   * convert with the half-normal median (`sigma = median / 0.6745`). Binning by
   * DC rather than pooling one global number keeps the part of the variation
   * that is real — photon shot noise makes variance track signal — while
   * throwing away the part that is a one-degree-of-freedom draw. Sixteen bins
   * over tens of thousands of pixels leaves thousands of samples per bin.
   */
  noiseBins: number;
  /** Take every Nth camera pixel in each axis. */
  pixelStride: number;
  /** 0 = keep everything. Otherwise decimate deterministically to this count. */
  maxCorrespondences: number;
  /**
   * Whether to report WHEN each axis of a correspondence was measured, and on
   * what clock. See `Correspondence.timeU`.
   *
   *  - `off` reports 0 for both axes, i.e. declines to distinguish them.
   *  - `perCapture` counts frames from the start of each `PatternCapture`. This
   *    is right when every (camera, projector) sequence starts from the same
   *    point of the operator's motion, which is what `packages/bench` models.
   *  - `sequential` continues the count across captures in the order they are
   *    handed to `decodeAll`, which is what a real operator does: shoot one
   *    projector's 34 frames, then the next projector's, drifting throughout.
   *
   * **What the solver can actually use of this, stated because round 3 claimed
   * more.** Under `perCapture` — the default, and what this bench shoots —
   * `captureEpochs` returns the same two numbers for every capture, so every
   * pair's `u` and `v` are separated by the same four frames and the bundle's
   * differential pose is identified by the ORDER of the two blocks and their
   * fixed separation, not by any clock. Scaling every epoch by a constant is a
   * no-op to eight significant figures. `sequential` is the option that would
   * carry real timing information, and it is the one this bench's own capture
   * model makes wrong (docs/AMENDMENTS.md A-34).
   *
   * Nothing downstream reads these unless `BundleFreeFlags.cameraEpochPose` is
   * on, so this option is inert by itself — a property the tests pin rather
   * than assert.
   */
  frameEpochs: 'off' | 'perCapture' | 'sequential';

  /**
   * Reject a decoded correspondence that cannot be on the sphere. `null` — the
   * default — keeps every pixel that decoded, which is what every published
   * number was produced with.
   *
   * A PREDICATE rather than a geometry, on purpose. This file turns images into
   * correspondences and does not know what a sphere is: it has no imports at
   * all, and the one thing it would have to import to answer this question is
   * the ray-sphere intersection that `sphere.ts` owns. `sphereSegmenter` there
   * builds the test this option expects, and is the only implementation of it
   * in the repository.
   *
   * It runs INSIDE the decode loop rather than over the returned array, and
   * that ordering is the point. `decimate` thins the accepted set to
   * {@link DecodeOptions.maxCorrespondences} by a fixed stride; filtering
   * afterwards would mean the room's correspondences had already displaced
   * good ones from the retained set, and the segmentation would recover the
   * points' honesty without recovering their number.
   */
  segmentation: SegmentationTest | null;
  /**
   * Image-space segmentation. Off by default, like the geometric one.
   *
   * Applied immediately after the modulation gate and before any decoding,
   * because that is where a real implementation would put it: a pixel the
   * photograph says is the back wall should not cost a Gray decode, and the
   * ordering is also the honest one -- this test genuinely does not need the
   * decoded coordinate that `segmentation` cannot work without.
   */
  imageMask: ImageMask | null;
}

/**
 * `true` when a decoded correspondence could be on the sphere.
 *
 * `projector` is {@link PatternCapture.projector}; `u` and `v` are the decoded
 * projector-raster coordinates, at the same half-integer convention everything
 * else here uses.
 */
export type SegmentationTest = (projector: number, u: number, v: number) => boolean;

/**
 * Is this camera pixel on the sphere?
 *
 * Camera space, not projector space, and asked BEFORE the pixel is decoded --
 * which is the whole difference between this and `segmentation`. That one needs
 * a decoded projector coordinate and a rig to cast it through; this one needs
 * the photograph. A caller builds it from `silhouette.ts` and the decoder never
 * learns how.
 */
export type ImageMask = (camera: number, pixel: number) => boolean;

export const DEFAULT_DECODE_OPTIONS: DecodeOptions = {
  channel: 'luminance',
  // 2% of a projector's full output. Comfortably above the black floor
  // (PARAMETERS.md §3.2 puts it near 1/800) and below anything a lit, non-grazing
  // surface returns.
  minModulation: 0.02,
  minBitSeparation: 0.25,
  minPhaseModulation: 0.15,
  // Two fifths of a fringe. The bound has to sit between two numbers: a CORRECT
  // decode disagrees by at most half a Gray stride, i.e. `stride / (2*period)`
  // of a fringe, and a wrong fringe order disagrees by at least half a fringe.
  // With the recommended `period = 2 * stride` those are 0.25 and 0.5, so 0.4
  // clears ordinary noise comfortably and still catches the order error.
  unwrapToleranceFrac: 0.4,
  noiseSigma: 0.01,
  // Sub-hundredth-pixel correspondences are not credible from any real camera,
  // and an unbounded 1/sigma weight lets one lucky pixel dominate the normal
  // equations.
  minSigmaPx: 0.01,
  noiseBins: 16,
  pixelStride: 1,
  maxCorrespondences: 0,
  frameEpochs: 'perCapture',
  // Off. Every published number was produced without it, and a segmentation
  // that switched itself on would move all of them.
  segmentation: null,
  // Off. Every number published before this existed was produced without it.
  imageMask: null,
};

/** One decoded camera-pixel-to-projector-pixel correspondence. */
export interface Correspondence {
  camera: number;
  projector: number;
  /** Camera pixel CENTRE, continuous coordinates (conventions.ts §I). */
  camU: number;
  camV: number;
  /** Decoded projector pixel, continuous. */
  projU: number;
  projV: number;
  /** One-sigma uncertainty in projector pixels, per axis. */
  sigmaU: number;
  sigmaV: number;
  /** Fringe amplitude over the pixel's white-black reference. Diagnostic. */
  modulation: number;
  /**
   * WHEN `projU` was measured, in pattern frames on the clock
   * `DecodeOptions.frameEpochs` selects. `timeV` is the same for `projV`.
   *
   * A correspondence is not one observation. Its two coordinates are read from
   * two disjoint sets of frames, photographed at different times, and under a
   * handheld capture the camera is not in the same place for both. Reporting
   * the two epochs is what lets a bundle model that; a solver that ignores them
   * behaves exactly as it did before they existed.
   *
   * **The epoch is the phase sequence's, not the Gray sequence's**, and the
   * approximation that buys is bounded rather than hoped for. The Gray planes
   * are photographed earlier and contribute only the integer fringe ORDER, so a
   * displacement between the Gray frames and the phase frames does not move the
   * decoded coordinate at all until it reaches half a fringe — and the
   * cross-check in `decodeAxis` DROPS the correspondence at
   * `unwrapToleranceFrac` of a period (0.4 of 60 projector pixels, with the
   * recommended plan) rather than mis-attributing it. The inter-frame bias this
   * whole mechanism exists for is 3 to 11 pixels, comfortably inside that.
   *
   * What is NOT modelled: the N phase frames of one axis are themselves spread
   * over N frame intervals, and this reports their mean. That is exact for a
   * pose moving linearly over the window and wrong for hand tremor at 9 Hz,
   * which completes almost two cycles inside it. Tremor is the smallest of the
   * three motion components (`packages/bench/src/camera.ts`: 0.4 mm against
   * 1.5 mm of sway), and it is what the residual keeps.
   */
  timeU: number;
  timeV: number;
}

export interface DecodeStats {
  considered: number;
  accepted: number;
  rejectedLowModulation: number;
  rejectedGrayAmbiguous: number;
  rejectedPhaseWeak: number;
  rejectedDisagreement: number;
  rejectedOutOfRange: number;
  rejectedMissingAxis: number;
  /**
   * Decoded cleanly and then rejected because it cannot be on the sphere. Zero
   * unless {@link DecodeOptions.segmentation} is on. Counted separately from
   * every other rejection because it is the only one that is about GEOMETRY
   * rather than about signal, and conflating the two would hide whether a
   * capture was dim or full of room.
   */
  rejectedOffSphere: number;
  /** Rejected by the image-space mask, before any decoding was attempted. */
  rejectedOffImage: number;
}

export function emptyStats(): DecodeStats {
  return {
    considered: 0,
    accepted: 0,
    rejectedLowModulation: 0,
    rejectedGrayAmbiguous: 0,
    rejectedPhaseWeak: 0,
    rejectedDisagreement: 0,
    rejectedOutOfRange: 0,
    rejectedMissingAxis: 0,
    rejectedOffSphere: 0,
    rejectedOffImage: 0,
  };
}

// ---------------------------------------------------------------------------
// Gray code arithmetic
// ---------------------------------------------------------------------------

export function binaryToGray(v: number): number {
  return v ^ (v >>> 1);
}

export function grayToBinary(g: number, bits: number): number {
  let b = g;
  for (let shift = 1; shift < bits; shift <<= 1) b ^= b >>> shift;
  // Mask because the unrolled XOR can leave high bits set for inputs wider than
  // `bits`, which a noisy decode can produce.
  return b & ((1 << bits) - 1);
}

/** Bit `j` (0 = MSB) of the Gray code of `index`, as the pattern generator emits it. */
export function grayPatternBit(index: number, bits: number, j: number): number {
  return (binaryToGray(index) >>> (bits - 1 - j)) & 1;
}

// ---------------------------------------------------------------------------
// Pixel sampling
// ---------------------------------------------------------------------------

/**
 * Rec.709 linear luminance coefficients.
 *
 * The decode runs on luminance by default because it is the highest-SNR
 * combination of a three-channel capture and because PARAMETERS.md §3.2 warns
 * the channels diverge in gamma, gain and black floor — all of which cancel in a
 * pattern-minus-complement comparison but none of which are worth inviting into
 * a geometric measurement. A single channel can be selected when a rig has a
 * known channel problem.
 */
const LUM_R = 0.2126;
const LUM_G = 0.7152;
const LUM_B = 0.0722;

function scalarAt(img: LinearImage, pixel: number, channel: DecodeChannel): number {
  const d = img.data;
  if (img.channels === 1) return d[pixel];
  const base = pixel * img.channels;
  switch (channel) {
    case 'r':
      return d[base];
    case 'g':
      return d[base + 1];
    case 'b':
      return d[base + 2];
    default:
      return LUM_R * d[base] + LUM_G * d[base + 1] + LUM_B * d[base + 2];
  }
}

function assertSameSize(a: LinearImage, b: LinearImage, what: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `decode: ${what} has ${b.width}x${b.height}, expected ${a.width}x${a.height}`,
    );
  }
}

/** Every frame in a capture, in a fixed order, so validation and fallbacks agree. */
function allFrames(capture: PatternCapture): LinearImage[] {
  const frames: LinearImage[] = [];
  for (const g of capture.gray) {
    for (const f of g.patterns) frames.push(f);
    for (const f of g.inverses) frames.push(f);
  }
  for (const p of capture.phase) for (const f of p.frames) frames.push(f);
  return frames;
}

/**
 * Per-pixel white and black references.
 *
 * When the capture carries explicit all-on and all-off frames those are used
 * directly. When it does not, the Gray sequences supply them for free: every
 * pattern is paired with its exact complement, so for any pixel at least one
 * frame is fully lit and at least one is fully dark, and the per-pixel max and
 * min over the Gray frames ARE the white and black references. That fallback
 * costs two frames of capture time and loses nothing, which is worth knowing
 * when someone is standing in a dark room with a tethered camera and 35 frames
 * to shoot (PARAMETERS.md §8).
 */
function referencePlanes(
  capture: PatternCapture,
  opts: DecodeOptions,
): { white: Float64Array; black: Float64Array; width: number; height: number } {
  const frames = allFrames(capture);
  if (frames.length === 0) throw new Error('decode: capture contains no pattern frames');
  const first = capture.white ?? frames[0];
  const n = first.width * first.height;

  for (const f of frames) assertSameSize(first, f, 'pattern frame');
  if (capture.white) assertSameSize(first, capture.white, 'white frame');
  if (capture.black) assertSameSize(first, capture.black, 'black frame');

  const white = new Float64Array(n);
  const black = new Float64Array(n);

  if (capture.white && capture.black) {
    for (let i = 0; i < n; i++) {
      white[i] = scalarAt(capture.white, i, opts.channel);
      black[i] = scalarAt(capture.black, i, opts.channel);
    }
    return { white, black, width: first.width, height: first.height };
  }

  white.fill(-Infinity);
  black.fill(Infinity);
  for (const f of frames) {
    for (let i = 0; i < n; i++) {
      const s = scalarAt(f, i, opts.channel);
      if (s > white[i]) white[i] = s;
      if (s < black[i]) black[i] = s;
    }
  }
  return { white, black, width: first.width, height: first.height };
}

// ---------------------------------------------------------------------------
// Per-axis decode
// ---------------------------------------------------------------------------

interface AxisResult {
  ok: boolean;
  coord: number;
  sigma: number;
  modulation: number;
  reason: 'ok' | 'gray' | 'phase' | 'disagree' | 'range' | 'missing';
}

const FAIL: (reason: AxisResult['reason']) => AxisResult = (reason) => ({
  ok: false,
  coord: NaN,
  sigma: NaN,
  modulation: 0,
  reason,
});

/**
 * Read one Gray sequence at one pixel.
 *
 * Each bit is `pattern > inverse`. The confidence in a bit is how far apart the
 * two frames were; the weakest bit in the word governs, because a single
 * flipped bit is not a small error — flip the MSB and the decoded address moves
 * half a raster.
 */
function decodeGrayAt(
  seq: GraySequence,
  pixel: number,
  modulation: number,
  opts: DecodeOptions,
): { ok: boolean; index: number } {
  let gray = 0;
  const threshold = opts.minBitSeparation * modulation;
  for (let j = 0; j < seq.bits; j++) {
    const p = scalarAt(seq.patterns[j], pixel, opts.channel);
    const q = scalarAt(seq.inverses[j], pixel, opts.channel);
    if (Math.abs(p - q) < threshold) return { ok: false, index: 0 };
    gray = (gray << 1) | (p > q ? 1 : 0);
  }
  return { ok: true, index: grayToBinary(gray, seq.bits) };
}

interface PhaseFit {
  /** Wrapped phase in [0, 2*pi). */
  phase: number;
  /** Fringe amplitude, same units as the input. */
  amplitude: number;
  /** One-sigma phase uncertainty, radians. */
  sigmaPhase: number;
}

/**
 * Pooled intensity noise as a function of a pixel's own DC level.
 *
 * See `DecodeOptions.noiseBins` for why this exists. `levels` is ascending and
 * the two arrays are parallel; `noiseAt` interpolates between them and clamps
 * outside the observed range, because extrapolating a noise model past the
 * signal levels that produced it is how a confident number gets invented.
 */
export interface PhaseNoiseModel {
  levels: Float64Array;
  sigmas: Float64Array;
}

/** median(|N(0, sigma)|) = 0.6745 * sigma. The chi median at one degree of freedom. */
const HALF_NORMAL_MEDIAN = 0.674489750196082;

/**
 * Regularised lower incomplete gamma P(a, x), series below the diagonal and
 * continued fraction above it — the standard split, because the series
 * converges slowly exactly where the fraction converges fast.
 *
 * Here only to locate the median of a chi-squared distribution; nothing else in
 * the package needs it.
 */
function gammaP(a: number, x: number): number {
  if (!(x > 0)) return 0;
  const lg = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lg);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lg) * h;
}

/** Lanczos log-gamma, g = 7, n = 9. Accurate to about 1e-15 for the a values used here. */
function lnGamma(a: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  const z = a - 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * median of chi_dof, the scale a median absolute residual has to be divided by
 * to recover sigma.
 *
 * `phaseResidualAt` returns the ROOT SUM OF SQUARES over all N frames of a
 * three-parameter fit, so it is `sigma * chi_(N-3)` — one degree of freedom at
 * the four steps this project ships, and more at any other count. Dividing by
 * the fixed half-normal constant is therefore right at N = 4 and wrong
 * everywhere else: at eight steps it inflates every sigma by a factor of three,
 * which shrinks the standardised residuals in the bundle by the same factor,
 * and Huber's threshold and the rejection floor both stop biting. `patterns.ts`
 * makes `phaseSteps` a configurable field, so 'everywhere else' is reachable
 * from the outside.
 *
 * Bisection on the chi-squared CDF rather than a closed form, because there
 * isn't one; the two cases that do have one are asserted against it in the tests.
 */
export function chiMedian(dof: number): number {
  if (dof === 1) return HALF_NORMAL_MEDIAN;
  // The median of chi-squared_k is within a few percent of k(1 - 2/(9k))^3, so
  // bracket generously around that and bisect to full double precision.
  let lo = 0;
  let hi = Math.max(4, 4 * dof);
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (gammaP(dof / 2, mid / 2) < 0.5) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(0.5 * (lo + hi));
}

/** Fewer than this many pixels in a bin and the bin's median is not worth having. */
const MIN_SAMPLES_PER_BIN = 64;

export function noiseAt(model: PhaseNoiseModel, dc: number): number {
  const n = model.levels.length;
  if (n === 0) return NaN;
  if (n === 1 || dc <= model.levels[0]) return model.sigmas[0];
  if (dc >= model.levels[n - 1]) return model.sigmas[n - 1];
  let hi = 1;
  while (hi < n - 1 && model.levels[hi] < dc) hi++;
  const lo = hi - 1;
  const span = model.levels[hi] - model.levels[lo];
  const t = span > 0 ? (dc - model.levels[lo]) / span : 0;
  return model.sigmas[lo] + t * (model.sigmas[hi] - model.sigmas[lo]);
}

/** One pixel's DC level and the magnitude of what the N-step fit left over. */
function phaseResidualAt(
  seq: PhaseSequence,
  pixel: number,
  channel: DecodeChannel,
): { dc: number; residual: number } {
  const n = seq.steps;
  let sum = 0;
  let sc = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const v = scalarAt(seq.frames[i], pixel, channel);
    const e = (2 * Math.PI * i) / n;
    sum += v;
    sc += v * Math.cos(e);
    ss += v * Math.sin(e);
  }
  const a = sum / n;
  const bc = (2 / n) * sc;
  const bs = (2 / n) * ss;
  let ss2 = 0;
  for (let i = 0; i < n; i++) {
    const v = scalarAt(seq.frames[i], pixel, channel);
    const e = (2 * Math.PI * i) / n;
    const model = a + bc * Math.cos(e) + bs * Math.sin(e);
    ss2 += (v - model) * (v - model);
  }
  return { dc: a, residual: Math.sqrt(ss2) };
}

/**
 * Estimate the intensity noise by pooling every usable pixel of the capture.
 *
 * The population pooled over is exactly the population the decode will run on —
 * pixels that clear `minModulation` — and not every pixel in the frame. An
 * off-sphere pixel carries read noise and nothing else, and letting it into the
 * low-signal bins would tell the decoder that its worst, most oblique
 * correspondences are its most certain ones.
 *
 * Returns null when there is not enough data to beat the per-pixel estimate,
 * in which case the caller falls back to it rather than to a made-up constant.
 */
export function estimatePhaseNoise(
  capture: PatternCapture,
  white: Float64Array,
  black: Float64Array,
  opts: DecodeOptions,
): PhaseNoiseModel | null {
  const bins = Math.floor(opts.noiseBins);
  if (bins <= 0 || capture.phase.length === 0) return null;
  if (capture.phase[0].steps <= 3) return null;

  // The SAME stride the decode uses. The docstring above says the pooled
  // population is the one the decode runs on, and it was not: this loop visited
  // every pixel whatever `pixelStride` said, so setting a stride of 8 to make
  // the decode sixty-four times cheaper left the noise estimate at full price —
  // on a 1920x1080 capture, four million short-lived objects and a
  // four-million-element sort for a model the docstring says needs 'tens of
  // thousands'. At the shipped stride of 1 nothing changes.
  const stride = Math.max(1, Math.floor(opts.pixelStride));
  // Two flat arrays and an index sort rather than an array of objects: the
  // allocation was the cost here, not the comparison.
  const dcs: number[] = [];
  const residuals: number[] = [];
  for (const seq of capture.phase) {
    for (let i = 0; i < white.length; i += stride) {
      if (!(white[i] - black[i] >= opts.minModulation)) continue;
      const s = phaseResidualAt(seq, i, opts.channel);
      if (!Number.isFinite(s.dc) || !Number.isFinite(s.residual)) continue;
      dcs.push(s.dc);
      residuals.push(s.residual);
    }
  }
  if (dcs.length < MIN_SAMPLES_PER_BIN) return null;

  const usable = Math.max(1, Math.min(bins, Math.floor(dcs.length / MIN_SAMPLES_PER_BIN)));
  // Sorting by DC and cutting into equal-count bins rather than equal-width
  // ones: the DC histogram of a sphere lit by one projector is heavily skewed,
  // and equal-width bins would put nearly every pixel in one of them.
  const order = Array.from(dcs.keys()).sort((a, b) =>
    dcs[a] === dcs[b] ? residuals[a] - residuals[b] : dcs[a] - dcs[b],
  );

  // Three parameters fitted per pixel — the DC and the two quadrature terms — so
  // the residual carries `steps - 3` degrees of freedom, whatever `steps` is.
  const chiScale = chiMedian(capture.phase[0].steps - 3);

  const levels = new Float64Array(usable);
  const sigmas = new Float64Array(usable);
  for (let b = 0; b < usable; b++) {
    const lo = Math.floor((b * order.length) / usable);
    const hi = Math.floor(((b + 1) * order.length) / usable);
    const res = Float64Array.from(order.slice(lo, hi), (i) => residuals[i]);
    res.sort();
    levels[b] = dcs[order[lo + Math.floor((hi - lo) / 2)]];
    sigmas[b] = Math.max(res[Math.floor(res.length / 2)] / chiScale, opts.noiseSigma * 1e-3);
  }
  return { levels, sigmas };
}

/**
 * N-step phase estimate at one pixel, with its uncertainty.
 *
 * The model is `I_n = A + B*cos(phi - 2*pi*n/N)`. Projecting onto cos and sin of
 * the step angles gives `B*cos(phi)` and `B*sin(phi)` directly, because the step
 * angles are equally spaced and their cross-products vanish — that is the whole
 * reason N-step phase shifting is written this way rather than as a general
 * least-squares fit.
 *
 * The uncertainty is the textbook `sigma_phi = sqrt(2/N) * sigma_I / B`.
 * Measuring `sigma_I` instead of assuming it matters here: PARAMETERS.md gives
 * no sensor noise figure at all, so an assumed constant would be one more
 * unmeasured number propagating into the weights of the bundle adjustment.
 *
 * WHERE the measurement comes from is the part that took a round to get right.
 * `sigma_I` is now read off the capture's pooled noise model (see
 * `DecodeOptions.noiseBins`), at this pixel's own DC level. It used to be
 * estimated from this pixel's own residual alone, which at the recommended four
 * phase steps is one degree of freedom — an estimate that is `sigma * |z|` for a
 * standard normal `z` and therefore worthless as a weight. `noiseBins: 0`
 * restores the old behaviour for anyone who wants to reproduce it.
 *
 * Note what falls out for free either way. At grazing incidence one camera pixel
 * covers a long, foreshortened strip of sphere, the fringe is averaged along it,
 * and B collapses. So `sigma_phi` grows exactly where the geometry is genuinely
 * least certain, with no explicit obliquity term anywhere in this function.
 */
function decodePhaseAt(
  seq: PhaseSequence,
  pixel: number,
  opts: DecodeOptions,
  noise: PhaseNoiseModel | null,
): PhaseFit {
  const n = seq.steps;
  let sum = 0;
  let sc = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const v = scalarAt(seq.frames[i], pixel, opts.channel);
    const e = (2 * Math.PI * i) / n;
    sum += v;
    sc += v * Math.cos(e);
    ss += v * Math.sin(e);
  }
  const a = sum / n;
  const bc = (2 / n) * sc;
  const bs = (2 / n) * ss;
  const amplitude = Math.hypot(bc, bs);
  let phase = Math.atan2(bs, bc);
  if (phase < 0) phase += 2 * Math.PI;

  let sigmaI = opts.noiseSigma;
  if (noise !== null) {
    sigmaI = noiseAt(noise, a);
  } else if (n > 3) {
    let ss2 = 0;
    for (let i = 0; i < n; i++) {
      const v = scalarAt(seq.frames[i], pixel, opts.channel);
      const e = (2 * Math.PI * i) / n;
      const model = a + bc * Math.cos(e) + bs * Math.sin(e);
      ss2 += (v - model) * (v - model);
    }
    sigmaI = Math.sqrt(ss2 / (n - 3));
  }
  // Floor at a fraction of the assumed noise so a noiseless synthetic capture
  // reports a small-but-finite sigma rather than zero, which would be an
  // infinite weight.
  sigmaI = Math.max(sigmaI, opts.noiseSigma * 1e-3);

  const sigmaPhase =
    amplitude > 0 ? Math.sqrt(2 / n) * (sigmaI / amplitude) : Number.POSITIVE_INFINITY;
  return { phase, amplitude, sigmaPhase };
}

/**
 * Combine the Gray address and the wrapped phase for one axis into a continuous
 * projector coordinate.
 *
 * The Gray code lands the pixel inside a stride-wide bin; the phase says where
 * inside a fringe it sits. Unwrapping picks the fringe order `k` that puts the
 * phase position nearest the Gray position, and then — this is the part worth
 * keeping — CHECKS it. If the two disagree by an appreciable fraction of a
 * fringe, one of them is wrong and the correspondence is dropped rather than
 * averaged. A wrong fringe order is a whole-period outlier, which is exactly
 * the kind of gross error that a robust loss can absorb but should not have to.
 */
/** The gray and phase sequences for one axis. Fixed for a capture; see `axisSequences`. */
interface AxisSequences {
  gray: GraySequence | null;
  phase: PhaseSequence | null;
}

/**
 * Which sequences belong to an axis — resolved ONCE per capture.
 *
 * `decodeAxis` used to run `capture.gray.find(...)` and `capture.phase.find(...)`
 * itself, on every pixel of every axis, in the hottest loop in the package: two
 * closure allocations and two linear scans per pixel to look up two objects that
 * cannot change while a capture is being decoded. At 1920x1080 that is about
 * eight million of each, for nothing.
 */
function axisSequences(capture: PatternCapture, axis: DecodeAxis): AxisSequences {
  return {
    gray: capture.gray.find((g) => g.axis === axis) ?? null,
    phase: capture.phase.find((p) => p.axis === axis) ?? null,
  };
}

function decodeAxis(
  sequences: AxisSequences,
  pixel: number,
  modulation: number,
  res: number,
  opts: DecodeOptions,
  noise: PhaseNoiseModel | null,
): AxisResult {
  const { gray, phase } = sequences;
  if (!gray && !phase) return FAIL('missing');

  let coarse = NaN;
  let coarseSigma = NaN;
  if (gray) {
    const g = decodeGrayAt(gray, pixel, modulation, opts);
    if (!g.ok) return FAIL('gray');
    // The address names a bin; without phase, the best estimate is its centre
    // and the uncertainty is that of a uniform distribution over the bin.
    coarse = (g.index + 0.5) * gray.stridePx;
    coarseSigma = gray.stridePx / Math.sqrt(12);
  }

  if (!phase) {
    if (coarse < 0 || coarse > res) return FAIL('range');
    return {
      ok: true,
      coord: coarse,
      sigma: Math.max(coarseSigma, opts.minSigmaPx),
      modulation,
      reason: 'ok',
    };
  }

  const fit = decodePhaseAt(phase, pixel, opts, noise);
  if (!(fit.amplitude >= opts.minPhaseModulation * modulation)) return FAIL('phase');

  const frac = (fit.phase / (2 * Math.PI)) * phase.periodPx;
  let coord: number;
  if (gray) {
    const k = Math.round((coarse - frac) / phase.periodPx);
    coord = k * phase.periodPx + frac;
    if (Math.abs(coord - coarse) > opts.unwrapToleranceFrac * phase.periodPx) {
      return FAIL('disagree');
    }
  } else {
    // No Gray sequence: the only unambiguous case is a single fringe spanning
    // the whole raster, where the fringe order is necessarily zero.
    if (phase.periodPx < res) return FAIL('missing');
    coord = frac;
  }

  if (coord < 0 || coord > res) return FAIL('range');

  const sigma = Math.max(
    (phase.periodPx / (2 * Math.PI)) * fit.sigmaPhase,
    opts.minSigmaPx,
  );
  return { ok: true, coord, sigma, modulation: fit.amplitude / modulation, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Frame epochs
// ---------------------------------------------------------------------------

export interface CaptureEpochs {
  /** Mean frame index of the frames that determine the `u` coordinate. */
  u: number;
  v: number;
  /** Frames in this capture, so a caller can continue the count into the next. */
  frames: number;
}

/**
 * When each axis of this capture was photographed, in frames from its own
 * first frame.
 *
 * Read off the capture's own structure using the order the module header makes
 * normative. The epoch of an axis is the mean frame index of its PHASE
 * sequence, because the phase is what carries the sub-pixel position; the Gray
 * planes only choose the fringe order, and a capture with no phase sequence at
 * all falls back to the mean of its Gray frames because then the Gray planes
 * are the whole measurement.
 */
export function captureEpochs(capture: PatternCapture): CaptureEpochs {
  let cursor = 0;
  if (capture.white) cursor++;
  if (capture.black) cursor++;
  const gray: { u: number; v: number } = { u: NaN, v: NaN };
  const phase: { u: number; v: number } = { u: NaN, v: NaN };
  for (const g of capture.gray) {
    const n = g.patterns.length + g.inverses.length;
    if (n > 0) gray[g.axis] = cursor + (n - 1) / 2;
    cursor += n;
  }
  for (const p of capture.phase) {
    const n = p.frames.length;
    if (n > 0) phase[p.axis] = cursor + (n - 1) / 2;
    cursor += n;
  }
  const pick = (axis: DecodeAxis): number => {
    if (Number.isFinite(phase[axis])) return phase[axis];
    if (Number.isFinite(gray[axis])) return gray[axis];
    return 0;
  };
  return { u: pick('u'), v: pick('v'), frames: cursor };
}

// ---------------------------------------------------------------------------
// Capture decode
// ---------------------------------------------------------------------------

export interface DecodeResult {
  correspondences: Correspondence[];
  stats: DecodeStats;
  /** Frames in the decoded capture(s), for a caller continuing the epoch count. */
  frames: number;
}

/** Decode one camera's view of one projector. */
export function decodeCapture(
  capture: PatternCapture,
  options: Partial<DecodeOptions> = {},
  /**
   * Frames already shot before this capture, added to both epochs. Zero for
   * `perCapture` timing; the running total for `sequential`.
   */
  timeOffset = 0,
): DecodeResult {
  const opts: DecodeOptions = { ...DEFAULT_DECODE_OPTIONS, ...options };
  const stats = emptyStats();
  const ref = referencePlanes(capture, opts);
  const epochs = captureEpochs(capture);
  const off = opts.frameEpochs === 'off';
  const timeU = off ? 0 : epochs.u + timeOffset;
  const timeV = off ? 0 : epochs.v + timeOffset;
  // Built once per capture, before the pixel loop: the noise level is a
  // property of the sensor and the signal, so estimating it per pixel throws
  // away the tens of thousands of samples that make it estimable at all.
  const noise = estimatePhaseNoise(capture, ref.white, ref.black, opts);
  const out: Correspondence[] = [];
  const stride = Math.max(1, Math.floor(opts.pixelStride));
  // Resolved once, not per pixel. See `axisSequences`.
  const seqU = axisSequences(capture, 'u');
  const seqV = axisSequences(capture, 'v');

  for (let py = 0; py < ref.height; py += stride) {
    for (let px = 0; px < ref.width; px += stride) {
      const pixel = py * ref.width + px;
      stats.considered++;

      const modulation = ref.white[pixel] - ref.black[pixel];
      if (!(modulation >= opts.minModulation)) {
        stats.rejectedLowModulation++;
        continue;
      }

      // The photograph, before the decode. Nothing here knows where anything is.
      if (opts.imageMask !== null && !opts.imageMask(capture.camera, pixel)) {
        stats.rejectedOffImage++;
        continue;
      }

      const ru = decodeAxis(seqU, pixel, modulation, capture.projectorRes.x, opts, noise);
      const rv = decodeAxis(seqV, pixel, modulation, capture.projectorRes.y, opts, noise);
      if (!ru.ok || !rv.ok) {
        const reason = !ru.ok ? ru.reason : rv.reason;
        if (reason === 'gray') stats.rejectedGrayAmbiguous++;
        else if (reason === 'phase') stats.rejectedPhaseWeak++;
        else if (reason === 'disagree') stats.rejectedDisagreement++;
        else if (reason === 'range') stats.rejectedOutOfRange++;
        else stats.rejectedMissingAxis++;
        continue;
      }

      // Geometry, last: a pixel that decoded cleanly and cannot be on the ball.
      // See `DecodeOptions.segmentation` for why this is here rather than over
      // the returned array.
      if (opts.segmentation !== null && !opts.segmentation(capture.projector, ru.coord, rv.coord)) {
        stats.rejectedOffSphere++;
        continue;
      }

      out.push({
        camera: capture.camera,
        projector: capture.projector,
        // Pixel centres are at half-integers, conventions.ts §I.
        camU: px + 0.5,
        camV: py + 0.5,
        projU: ru.coord,
        projV: rv.coord,
        sigmaU: ru.sigma,
        sigmaV: rv.sigma,
        modulation: Math.min(ru.modulation, rv.modulation),
        timeU,
        timeV,
      });
      stats.accepted++;
    }
  }

  return {
    correspondences: decimate(out, opts.maxCorrespondences),
    stats,
    frames: epochs.frames,
  };
}

/**
 * Deterministic uniform decimation.
 *
 * A 12-megapixel phone frame decodes to millions of correspondences, and the
 * bundle adjustment gains nothing from the last factor of a hundred — the
 * normal equations are 100x100 no matter how many rows feed them. Decimation is
 * by a fixed fractional stride rather than by sampling, so the retained set
 * stays spatially uniform (a random subset would clump) and identical between
 * runs.
 */
function decimate(items: Correspondence[], max: number): Correspondence[] {
  if (max <= 0 || items.length <= max) return items;
  const kept: Correspondence[] = [];
  const step = items.length / max;
  for (let i = 0; i < max; i++) kept.push(items[Math.floor(i * step)]);
  return kept;
}

/**
 * Decode every capture, concatenating in input order so the result is
 * deterministic.
 *
 * Input order is also the CAPTURE order — the sequences were shot one after
 * another, one projector at a time — which is what `frameEpochs: 'sequential'`
 * reads. Under `perCapture` the running offset stays at zero and every capture
 * is timed from its own first frame.
 */
export function decodeAll(
  captures: readonly PatternCapture[],
  options: Partial<DecodeOptions> = {},
): DecodeResult {
  const all: Correspondence[] = [];
  const stats = emptyStats();
  const sequential =
    (options.frameEpochs ?? DEFAULT_DECODE_OPTIONS.frameEpochs) === 'sequential';
  let elapsed = 0;
  for (const capture of captures) {
    const r = decodeCapture(capture, options, sequential ? elapsed : 0);
    elapsed += r.frames;
    for (const c of r.correspondences) all.push(c);
    stats.considered += r.stats.considered;
    stats.accepted += r.stats.accepted;
    stats.rejectedLowModulation += r.stats.rejectedLowModulation;
    stats.rejectedGrayAmbiguous += r.stats.rejectedGrayAmbiguous;
    stats.rejectedPhaseWeak += r.stats.rejectedPhaseWeak;
    stats.rejectedDisagreement += r.stats.rejectedDisagreement;
    stats.rejectedOutOfRange += r.stats.rejectedOutOfRange;
    stats.rejectedMissingAxis += r.stats.rejectedMissingAxis;
    stats.rejectedOffSphere += r.stats.rejectedOffSphere;
    stats.rejectedOffImage += r.stats.rejectedOffImage;
  }
  return { correspondences: all, stats, frames: elapsed };
}
