// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Does the display shader agree with the model?
 *
 * ## Why this number is on screen and not in a test
 *
 * The page renders with GLSL and reasons with `packages/sim`. Those are two
 * implementations of the same trace, and the failure mode is silent drift: a
 * term goes into one and not the other, the picture still looks like a sphere,
 * and a person builds intuition from a renderer nothing scores.
 *
 * `packages/harness` guards its own shader with a headless chain — a
 * line-for-line TypeScript transliteration, a structural test, a CPU comparison
 * in CI. That chain proves the SOURCE is the same math. What no headless test
 * can prove is that a real GL driver compiled that text into that arithmetic, in
 * float32, on the machine in front of you. So this page measures the last link
 * where it actually lives: in the browser, at runtime, against the CPU model,
 * with the answer displayed rather than logged.
 *
 * ## The verdict is not "max delta under tolerance"
 *
 * At the sphere's limb, at each projector's coverage boundary and at the raster
 * edge, one ULP flips a hit into a miss and produces a full-amplitude delta at
 * that pixel. That is a boundary landing between two samples, not drift, and a
 * max-only verdict would fail at random as the viewer orbits. The verdict is
 * therefore taken on a high percentile, and the count of full-amplitude boundary
 * pixels is reported SEPARATELY with its own allowance — visible, bounded, and
 * never quietly folded into an average.
 *
 * The construction, the two-tolerance reasoning and the percentile choice are
 * `packages/harness/src/parity.ts`'s; this is the two-calibration case of the
 * same idea, kept here so the app does not pull the harness's single-rig shader
 * reference into its bundle to reuse forty lines of statistics.
 */

import type { ChannelTriplet } from '../../calibration/src/index.ts';
import type { RgbImage } from '../../sim/src/equirect.ts';

/**
 * float32 against float64, plus eight Newton steps against an adaptive loop,
 * plus a texture unit the GL spec permits reduced precision in.
 *
 * 2e-3 of relative radiance is roughly half a step of an 8-bit display code —
 * the point past which a disagreement would be visible rather than merely
 * present — and a tenth of PARAMETERS.md §7's tightest photometric gate, so a
 * renderer disagreeing by more than this is capable of moving a verdict.
 */
export const DISPLAY_TOLERANCE = 2e-3;

/**
 * Fraction of LIT pixels allowed past the tolerance because a geometric boundary
 * landed between two samples.
 *
 * **The population this allows for has been counted, and on a correct renderer it
 * is empty.** Measured against a real GL driver -- the paired read-backs behind
 * `packages/harness/README.md`'s link-(3) table, at its 96x72 room and 64x36
 * projector grids, on an analytic sphere, a tessellated sphere and two plates:
 * **0 of 10 298 lit pixels over {@link DISPLAY_TOLERANCE}**, pooled over four
 * correct frames. The worst single pixel anywhere is 3.13e-4, six times under the
 * tolerance, and none reaches a fifth of it. Strays are not a near-miss
 * phenomenon here; the distribution has a hard ceiling.
 *
 * So this number is NOT sized by boundary noise, because there is none to size it
 * by. It is sized by what it must still CATCH.
 *
 * ## What it must catch, and what 0.06 did with it
 *
 * The one real GPU bug this project has found is the self-shadow acne of
 * `packages/sim/src/mesh/bvh.ts`, and this check is what found it. On the room
 * track -- the view geometry the app's own parity patch is -- it moves **1.187%**
 * of lit pixels on a tessellated sphere and **2.198%** on two plates.
 *
 * The value this replaced was 0.06, and at 0.06 the verdict printed
 *
 *     The picture and the model agree to 2.52e-5 of relative radiance across all
 *     but the outer 6% of the 4212 lit pixels.
 *
 * on the frame carrying it. A defect touching 1.187% of pixels hides entirely
 * inside the 6% the percentile discards, however wrong those pixels are: the worst
 * of them differs by 3.85e-1, which is 193x the tolerance. Over the thirteen dumps
 * -- five injected severities of the bug and its fixes, two tracks each -- 0.06
 * catches 3 of the 14 judgeable cells. 0.002 catches 13. Not one allowance in the
 * sweep from 0.06 down to 0.0002 false-alarms on a correct frame.
 *
 * | allowance | false alarms | buggy cells caught, of 14 |
 * | --- | --- | --- |
 * | 0.06 | 0 | 3 |
 * | 0.01 | 0 | 11 |
 * | 0.002 | 0 | 13 |
 * | 0.0005 | 0 | 14 |
 *
 * ## Why 0.002 of that window, which is judgement and not measurement
 *
 * Measurement gives a window and not a value. The upper bound is hard: the
 * allowance must sit under 1.187e-2 to see the weakest room-track signature of a
 * real defect. The lower bound is the stray rate, and zero events in 10 298 lit
 * pixels puts a 95% upper bound of 2.91e-4 on it by the rule of three. 0.002 is
 * 6.9x above that bound and 5.9x below the defect it must see. Any value in
 * [0.001, 0.005] is defensible on this data; what picks 0.002 within it is the
 * shed at large lit counts, and that reason is a preference rather than a
 * measurement.
 *
 * ## The consequence at the widest view, which is deliberate and worth knowing
 *
 * The shed is a FRACTION, so it scales with the patch: 24 pixels at the seam
 * close-up's 12 116 lit, and `0.002 x 178 = 0.36` -- which rounds to **zero** --
 * at the 178 lit pixels `PERFECT_PRESET` carries there, the preset the app opens
 * on. (`BOULDER_PRESET`, which the tests render, carries 170 at the same
 * framing; the shed floors to zero either way, and the preset is named here
 * because the two numbers are otherwise easy to read as a disagreement.) At that
 * view one stray full-amplitude pixel
 * fails the check. Measured, that never happens; at the 95% bound on the stray
 * rate it would happen in about 5% of frames there. If a hardware driver turns
 * out to produce strays, the answer is an absolute floor on the shed
 * (`litOver > max(SHED, allowance * N)`) rather than a larger fraction, because
 * the fraction is exactly what let 727 pixels be shed at the seam close-up.
 *
 * ## The measurement this has NOT had
 *
 * Every correct-renderer frame above is SwiftShader, a software rasteriser, at
 * one framing. {@link DISPLAY_TOLERANCE} names "a texture unit the GL spec
 * permits reduced precision in", and SwiftShader is the driver least likely to
 * exhibit it. One read-back from a hardware GPU at the three framings settles it.
 *
 * ## And a 0.02-degree camera nudge is not a model of this
 *
 * It moves 12-16% of lit pixels on the plain analytic sphere where the driver
 * moves 0.000%: it displaces the surface by about 0.28 mm where float32 displaces
 * it by about 5e-8 m. `test/parity.test.ts` uses the nudge to test the
 * DENOMINATOR, which is what it is good for, and this constant must never be
 * sized against it.
 */
export const BOUNDARY_LIT_ALLOWANCE = 0.002;

/**
 * Percentages as a reader wants them, for constants that are no longer whole.
 *
 * `(0.002 * 100).toFixed(0)` is `'0'`, and a verdict that offers a "0% allowance"
 * or reports `p100` of the lit pixels is worse than one that offers no number.
 */
function pctText(fraction: number): string {
  return String(Number((fraction * 100).toFixed(3)));
}

/**
 * A fraction as a percentage, with enough precision to be compared against
 * {@link ALLOWANCE_LABEL}.
 *
 * Exported because the readout prints the observed value beside the allowance,
 * and at one decimal the two collapse: 25 of 12 116 lit pixels is 0.206%, which
 * `toFixed(1)` renders as "0.2% of the lit pixels are over tolerance, above the
 * 0.2% allowance" -- a sentence that reads as a contradiction and hides why the
 * verdict failed. Three decimals, trailing zeros dropped, so a round number
 * still prints round.
 */
export function percentLabel(fraction: number): string {
  return pctText(fraction);
}

/** The allowance as it is printed: `0.2%`. */
export const ALLOWANCE_LABEL = `${pctText(BOUNDARY_LIT_ALLOWANCE)}%`;

/**
 * How far above the ambient floor a pixel must read to count as lit.
 *
 * Deliberately either image and not both: a difference that turns a lit pixel
 * black, or a black one lit, is exactly the kind the check exists to catch, and
 * requiring both to be lit would drop it from the denominator AND from the
 * numerator.
 *
 * **Above the AMBIENT FLOOR, and that phrase is the whole of this fix.** This
 * used to read "a pixel counts as lit when either image puts anything there at
 * all", and measured against a real GL driver that sentence selected every pixel
 * the surface covers: `lambertianShading` starts each shaded point at
 * `scene.ambient` before any projector contributes, so at the nominal ambient of
 * 0.04 every hit reads about 18x this threshold whether a lens reaches it or not.
 * On the three real-driver frames the two sets were not merely similar, they were
 * identical -- 4232/4232, 4212/4212 and 819/819 pixels.
 *
 * That is harmless on a sphere, which is convex and ringed by four projectors, and
 * it is not harmless in general. Ambient is additive and rig-independent, so it
 * cancels exactly in every difference: an ambient-only pixel can never enter a
 * numerator and only ever inflates the denominator. Give the check geometry where
 * much of the silhouette is out of every projector's reach -- two panels 30 mm
 * apart, the repo's own `twoPlates` idiom at a fortieth of its separation -- and
 * the denominator fills with pixels that agree by construction. {@link judgeParity}
 * then reports a rig in pieces as a rig in agreement.
 *
 * The floor is computed rather than guessed, because it is exactly computable:
 * `scene.reflectance` and `scene.roomAlbedo` are scene constants, not textures,
 * so an unreached surface pixel reads exactly `ambient x reflectance` and an
 * unreached floor pixel exactly `ambient x roomAlbedo`. See {@link ambientFloorOf}.
 *
 * Excluding a pixel that agrees can only shrink the denominator while leaving the
 * numerator alone, so every effect of this is to make the check STRICTER. It
 * cannot manufacture a pass; where it removes everything, the verdict goes blind,
 * which is the honest answer for a patch no projector lights.
 */
export const LIT_THRESHOLD = 2e-3;

/**
 * The radiance a pixel shows when no projector reaches it.
 *
 * `lambertianShading` returns `(ambient + sum of contributions) x reflectance`, and
 * `shadeFloor` returns `(ambient + black-floor leak) x roomAlbedo`. With no
 * contribution and no leak those collapse to `ambient x reflectance` and
 * `ambient x roomAlbedo`, and both are exact rather than bounded because
 * reflectance and roomAlbedo are single scene values -- `render.ts` passes
 * `scene.reflectance` into every `ShadeInput` -- and not a per-pixel texture.
 *
 * The larger of the two is taken so that one floor serves both populations. Where
 * that over-excludes -- a surface pixel under a very dim lens when `roomAlbedo`
 * exceeds `reflectance` -- it drops a pixel carrying almost no projector light,
 * which is the safe direction: see {@link LIT_THRESHOLD}.
 */
export function ambientFloorOf(
  ambient: ChannelTriplet,
  reflectance: ChannelTriplet,
  roomAlbedo: number,
): ChannelTriplet {
  return {
    r: ambient.r * Math.max(reflectance.r, roomAlbedo),
    g: ambient.g * Math.max(reflectance.g, roomAlbedo),
    b: ambient.b * Math.max(reflectance.b, roomAlbedo),
  };
}

/**
 * The floor for a comparison with no ambient in it at all.
 *
 * Named rather than written as three zeros at each call site, so that a test
 * comparing synthetic images says what it means and cannot be mistaken for a
 * caller that forgot to pass the scene's real ambient.
 */
export const NO_AMBIENT: ChannelTriplet = { r: 0, g: 0, b: 0 };

/**
 * Below this many lit pixels the patch cannot support a percentile and the
 * verdict is withheld rather than granted.
 *
 * A check that cannot see anything must not report agreement. At the widest view
 * the sphere covers about 180 of the patch's 12 288 pixels, which is enough; a
 * viewer who zooms out past that gets "too little on screen to judge" instead of
 * a green tick earned by a frame full of matching black.
 */
export const MIN_LIT_PIXELS = 60;

export const VERDICT_PERCENTILE = 1 - BOUNDARY_LIT_ALLOWANCE;

/** The verdict percentile as it is printed: `p99.8`, not `p100`. */
export const VERDICT_PERCENTILE_LABEL = `p${pctText(VERDICT_PERCENTILE)}`;

export interface ParityDelta {
  /** Worst single-channel absolute difference anywhere in the patch. */
  maxAbs: number;
  meanAbs: number;
  /**
   * Per-pixel worst-channel difference at {@link VERDICT_PERCENTILE}. This is
   * the number the verdict is taken on.
   */
  verdictPercentileValue: number;
  median: number;
  pixelsOverTolerance: number;
  pixelCount: number;
  fractionOverTolerance: number;
  /**
   * Pixels either image lights ABOVE the ambient floor. The denominator that
   * matters, and see {@link LIT_THRESHOLD} for why the floor is in that sentence.
   */
  litPixelCount: number;
  /** Of those, how many are over tolerance. */
  litOverTolerance: number;
  fractionOfLitOverTolerance: number;
}

export interface ParityVerdict {
  delta: ParityDelta;
  tolerance: number;
  pass: boolean;
  /** Why it failed, or `''`. */
  reason: string;
  /** True when there was too little on screen to judge. Never a pass. */
  blind: boolean;
  /** One sentence ready to print. */
  summary: string;
  /** True when the read-back was float rather than 8-bit. */
  floatReadback: boolean;
  /** Milliseconds the CPU side cost. Shown so a reader can see the price. */
  cpuMs: number;
}

export function compareImages(
  a: { width: number; height: number; data: Float32Array },
  b: { width: number; height: number; data: Float32Array },
  tolerance: number,
  ambientFloor: ChannelTriplet,
): ParityDelta {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `parity needs identical rasters: ${a.width}×${a.height} against ${b.width}×${b.height}. ` +
        `Comparing a resampled image would measure the resampler.`,
    );
  }
  const floor = [ambientFloor.r, ambientFloor.g, ambientFloor.b];
  const n = a.width * a.height;
  const perPixel = new Float64Array(n);
  const litDeltas: number[] = [];
  let maxAbs = 0;
  let sumAbs = 0;
  let over = 0;
  let litOver = 0;

  for (let i = 0; i < n; i++) {
    let pixelMax = 0;
    let lit = false;
    for (let c = 0; c < 3; c++) {
      const x = a.data[3 * i + c];
      const y = b.data[3 * i + c];
      const d = Math.abs(x - y);
      sumAbs += d;
      if (d > pixelMax) pixelMax = d;
      if (d > maxAbs) maxAbs = d;
      const bar = floor[c] + LIT_THRESHOLD;
      if (x > bar || y > bar) lit = true;
    }
    perPixel[i] = pixelMax;
    if (pixelMax > tolerance) over++;
    if (lit) {
      litDeltas.push(pixelMax);
      if (pixelMax > tolerance) litOver++;
    }
  }

  const sortedLit = Float64Array.from(litDeltas).sort();
  const m = sortedLit.length;
  // The verdict percentile is taken over the lit pixels only; see the note on
  // VERDICT_PERCENTILE for why the whole frame is the wrong denominator.
  const atLit = (q: number): number =>
    m === 0 ? 0 : sortedLit[Math.min(m - 1, Math.max(0, Math.floor(q * (m - 1))))];

  return {
    maxAbs,
    meanAbs: n === 0 ? 0 : sumAbs / (3 * n),
    verdictPercentileValue: atLit(VERDICT_PERCENTILE),
    median: atLit(0.5),
    pixelsOverTolerance: over,
    pixelCount: n,
    fractionOverTolerance: n === 0 ? 0 : over / n,
    litPixelCount: m,
    litOverTolerance: litOver,
    fractionOfLitOverTolerance: m === 0 ? 0 : litOver / m,
  };
}

export function judgeParity(
  gpu: { width: number; height: number; data: Float32Array },
  cpu: RgbImage,
  options: {
    /**
     * Required, with no default. A default of zero would silently restore the
     * denominator this parameter exists to fix, and the caller always knows its
     * own scene: {@link ambientFloorOf} turns three scene fields into it, and
     * {@link NO_AMBIENT} says so for a comparison that genuinely has none.
     */
    ambientFloor: ChannelTriplet;
    tolerance?: number;
    floatReadback?: boolean;
    cpuMs?: number;
  },
): ParityVerdict {
  // An 8-bit read-back cannot resolve better than 1/255, so holding it to the
  // float tolerance would fail for a reason that has nothing to do with the
  // model. Say so in the summary rather than silently widening the bar.
  const floatReadback = options.floatReadback ?? true;
  const tolerance = options.tolerance ?? (floatReadback ? DISPLAY_TOLERANCE : 1 / 255);
  const delta = compareImages(gpu, cpu, tolerance, options.ambientFloor);

  const readback = floatReadback ? '' : ' (8-bit read-back — this device has no float framebuffer)';

  // Too little on screen to judge is not agreement. Reported as its own state so
  // a viewer who has zoomed the sphere down to nothing gets told the check went
  // blind rather than handed a tick earned by matching black.
  if (delta.litPixelCount < MIN_LIT_PIXELS) {
    return {
      delta,
      tolerance,
      pass: false,
      blind: true,
      reason: `only ${delta.litPixelCount} of ${delta.pixelCount} pixels show anything`,
      summary:
        `Too little of the sphere is on screen to compare — ${delta.litPixelCount} lit pixels ` +
        `in the ${delta.pixelCount}-pixel patch, under the ${MIN_LIT_PIXELS} this needs. ` +
        `Move closer${readback}.`,
      floatReadback,
      cpuMs: options.cpuMs ?? 0,
    };
  }

  const percentileOk = delta.verdictPercentileValue <= tolerance;
  const boundaryOk = delta.fractionOfLitOverTolerance <= BOUNDARY_LIT_ALLOWANCE;
  const reasons: string[] = [];
  if (!percentileOk) {
    reasons.push(
      `${VERDICT_PERCENTILE_LABEL} of the lit pixels differs by ${delta.verdictPercentileValue.toExponential(2)}, over ` +
        `${tolerance.toExponential(1)}`,
    );
  }
  if (!boundaryOk) {
    reasons.push(
      `${percentLabel(delta.fractionOfLitOverTolerance)}% of the lit pixels are over ` +
        `tolerance, above the ${ALLOWANCE_LABEL} allowance for ` +
        `geometric boundaries`,
    );
  }
  const pass = percentileOk && boundaryOk;
  return {
    delta,
    tolerance,
    pass,
    blind: false,
    reason: reasons.join('; '),
    summary: pass
      ? `The picture and the model agree to ${delta.verdictPercentileValue.toExponential(2)} of ` +
        `relative radiance across all but the outer ` +
        `${ALLOWANCE_LABEL} of the ${delta.litPixelCount} lit ` +
        `pixels${readback}.`
      : `The picture and the model DISAGREE: ${reasons.join('; ')}${readback}.`,
    floatReadback,
    cpuMs: options.cpuMs ?? 0,
  };
}

/**
 * The patch the parity check runs on.
 *
 * Small on purpose. The CPU tracer costs about a millisecond per hundred pixels
 * at this geometry, so a full-window comparison would take seconds and prove
 * nothing the patch does not: the question is whether the two implementations
 * agree at a point, and 12 288 points sampled from the SAME view the user is
 * looking at covers the limb, the seams, the mask edge and the floor.
 *
 * It is a downscale of the live camera rather than a fixed canonical view, which
 * matters — a fixed view would stop exercising whatever the user just dragged.
 */
export const PARITY_WIDTH = 128;
export const PARITY_HEIGHT = 96;

/**
 * Supersampling does NOT shrink this patch, and the first attempt at it did.
 *
 * The check runs the CPU model at whatever sample count the display shader is
 * using — anything else and the number measures the sampling pattern instead of
 * the two renderers — and the obvious worry is that the count multiplies the CPU
 * side directly. Rescaling the raster to hold the trace budget fixed looks like
 * the careful move and is the wrong one: this view is a room shot, the sphere is
 * 1.5% of the frame, and 12 288 pixels contain only about 180 LIT ones. Quarter
 * the raster and that is 52, under {@link MIN_LIT_PIXELS}, and the check reports
 * itself blind rather than reporting a comparison. The browser smoke run said so
 * out loud.
 *
 * The cost it was protecting against is not there either. Measured on this rig,
 * the patch takes 32 ms at one sample and 42 ms at 3 x 3 — the trace is dominated
 * by the pixels that MISS the sphere, and a miss costs the same whatever the
 * sample count. So the patch is fixed and the sample count rides on top of it.
 */
