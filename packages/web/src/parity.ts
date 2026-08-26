// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

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
 * **Of lit pixels, and that word is the whole point.** This started as a fraction
 * of the whole frame, and as a fraction of the whole frame it is not a property
 * of the renderers at all — it is a property of how much of the window the sphere
 * happens to fill. Measured at three framings, from a 2.6 m seam close-up to a
 * 10.2 m room shot, against the frame:
 *
 * | framing | boundary | a full 1x mount error |
 * | --- | --- | --- |
 * | 2.6 m, 34 deg | 6.0% | 40.1% |
 * | 6.2 m, 50 deg | 0.50% | 4.65% |
 * | 10.2 m, 71 deg | 0.073% | 0.70% |
 *
 * Two orders of magnitude, for the same two renderers disagreeing by the same
 * amount. A 1%-of-frame allowance happens to sit between the two columns at 6.2 m
 * and nowhere else: at the room shot a COMPLETE misalignment moves 0.70% of the
 * frame and would have passed. The check was silently blind at any wide view.
 *
 * The same measurements against the count of lit pixels:
 *
 * | framing | boundary | a full 1x mount error |
 * | --- | --- | --- |
 * | 2.6 m, 34 deg | 2.4% | 40.6% |
 * | 6.2 m, 50 deg | 2.4% | 48.6% |
 * | 10.2 m, 71 deg | 2.0% | 47.8% |
 *
 * Flat, because both quantities scale with the image of the sphere and so does
 * the denominator. 6% is more than twice the measured worst case, the same
 * doubling rule the frame-fraction version used, and it means the same thing at
 * every zoom. `test/parity.test.ts` pins all six numbers.
 *
 * The boundary column used to read 5-6% and the allowance 12%. What halved it
 * was moving the graticule out of the content texture: a line rasterised into an
 * equirect is reconstructed by two different bilinear samplers on the two sides
 * — a GPU texture unit and `sampleEquirect` — and every pixel of every line was
 * a place they could disagree. Evaluated analytically from the same formula on
 * both sides, the only disagreement left is the geometry the check is for.
 */
export const BOUNDARY_LIT_ALLOWANCE = 0.06;

/**
 * A pixel counts as lit when either image puts anything there at all.
 *
 * Deliberately either and not both: a difference that turns a lit pixel black, or
 * a black one lit, is exactly the kind the check exists to catch, and requiring
 * both to be lit would drop it from the denominator AND from the numerator.
 */
export const LIT_THRESHOLD = 2e-3;

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
  /** Pixels either image puts light in. The denominator that matters. */
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
): ParityDelta {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `parity needs identical rasters: ${a.width}×${a.height} against ${b.width}×${b.height}. ` +
        `Comparing a resampled image would measure the resampler.`,
    );
  }
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
      if (x > LIT_THRESHOLD || y > LIT_THRESHOLD) lit = true;
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
  options: { tolerance?: number; floatReadback?: boolean; cpuMs?: number } = {},
): ParityVerdict {
  // An 8-bit read-back cannot resolve better than 1/255, so holding it to the
  // float tolerance would fail for a reason that has nothing to do with the
  // model. Say so in the summary rather than silently widening the bar.
  const floatReadback = options.floatReadback ?? true;
  const tolerance = options.tolerance ?? (floatReadback ? DISPLAY_TOLERANCE : 1 / 255);
  const delta = compareImages(gpu, cpu, tolerance);

  const pct = (VERDICT_PERCENTILE * 100).toFixed(0);
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
      `p${pct} of the lit pixels differs by ${delta.verdictPercentileValue.toExponential(2)}, over ` +
        `${tolerance.toExponential(1)}`,
    );
  }
  if (!boundaryOk) {
    reasons.push(
      `${(delta.fractionOfLitOverTolerance * 100).toFixed(1)}% of the lit pixels are over ` +
        `tolerance, above the ${(BOUNDARY_LIT_ALLOWANCE * 100).toFixed(0)}% allowance for ` +
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
        `${(BOUNDARY_LIT_ALLOWANCE * 100).toFixed(0)}% of the ${delta.litPixelCount} lit ` +
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
