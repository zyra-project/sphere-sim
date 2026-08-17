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
 * Fraction of pixels allowed past the tolerance because a geometric boundary
 * landed between two samples.
 *
 * **Measured, then set — not estimated.** The first version of this file
 * reasoned its way to 2% from the sphere's perimeter in pixels, and the estimate
 * was four times too large. The measurement that replaced it is in
 * `test/parity.test.ts`: render the scene, render it again with the camera
 * nudged by a hundredth of a degree, and count the pixels that changed by more
 * than the tolerance. Only pixels straddling a discontinuity can — a limb, a
 * coverage edge, the mask edge, the floor disc. The answer is **0.2% to 0.6%**
 * at both 128×96 and 256×192, and it barely moves with raster size because the
 * count scales with perimeter while the total scales with area.
 *
 * 1% is twice the measured worst case. That headroom matters in the other
 * direction too: at 2% the check could not distinguish edge noise from a
 * misalignment, because a full 1× mount error moves 1.7% of pixels past
 * tolerance at this raster. The over-generous allowance would have made the
 * check unable to fail for a difference the size of the entire problem this
 * project exists to solve. Both facts are pinned by tests.
 */
export const BOUNDARY_PIXEL_ALLOWANCE = 0.01;

/**
 * The percentile the verdict is taken at — and it is DERIVED from the allowance
 * rather than chosen beside it.
 *
 * Two criteria that both look reasonable can be quietly inconsistent, and this
 * pair was. An allowance saying "up to 2% of pixels may be over tolerance" and a
 * verdict taken at the 99.5th percentile cannot both bind: once 2% of pixels are
 * over, the 98th percentile is already over, so the percentile fires first and
 * the allowance can never be the reason for anything. One of the two criteria
 * would be dead code that reads like a safeguard. `test/parity.test.ts` catches
 * it by spoiling half the allowance and requiring a pass.
 *
 * So the two are one statement with two halves: *everything outside the allowed
 * boundary fraction is within tolerance, AND the boundary fraction is inside its
 * allowance.* The percentile is therefore `1 - allowance` exactly.
 */
export const VERDICT_PERCENTILE = 1 - BOUNDARY_PIXEL_ALLOWANCE;

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
}

export interface ParityVerdict {
  delta: ParityDelta;
  tolerance: number;
  pass: boolean;
  /** Why it failed, or `''`. */
  reason: string;
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
  let maxAbs = 0;
  let sumAbs = 0;
  let over = 0;

  for (let i = 0; i < n; i++) {
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[3 * i + c] - b.data[3 * i + c]);
      sumAbs += d;
      if (d > pixelMax) pixelMax = d;
      if (d > maxAbs) maxAbs = d;
    }
    perPixel[i] = pixelMax;
    if (pixelMax > tolerance) over++;
  }

  const sorted = Float64Array.from(perPixel).sort();
  const at = (q: number): number =>
    n === 0 ? 0 : sorted[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];

  return {
    maxAbs,
    meanAbs: n === 0 ? 0 : sumAbs / (3 * n),
    verdictPercentileValue: at(VERDICT_PERCENTILE),
    median: at(0.5),
    pixelsOverTolerance: over,
    pixelCount: n,
    fractionOverTolerance: n === 0 ? 0 : over / n,
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

  const percentileOk = delta.verdictPercentileValue <= tolerance;
  const boundaryOk = delta.fractionOverTolerance <= BOUNDARY_PIXEL_ALLOWANCE;
  const pct = (VERDICT_PERCENTILE * 100).toFixed(0);
  const reasons: string[] = [];
  if (!percentileOk) {
    reasons.push(
      `p${pct} delta ${delta.verdictPercentileValue.toExponential(2)} exceeds ` +
        `${tolerance.toExponential(1)}`,
    );
  }
  if (!boundaryOk) {
    reasons.push(
      `${(delta.fractionOverTolerance * 100).toFixed(2)}% of pixels are over tolerance, above the ` +
        `${(BOUNDARY_PIXEL_ALLOWANCE * 100).toFixed(0)}% allowance for geometric boundaries`,
    );
  }
  const pass = percentileOk && boundaryOk;
  const readback = floatReadback ? '' : ' (8-bit read-back — this device has no float framebuffer)';
  return {
    delta,
    tolerance,
    pass,
    reason: reasons.join('; '),
    summary: pass
      ? `The picture and the model agree to ${delta.verdictPercentileValue.toExponential(2)} of ` +
        `relative radiance across all but the outer ${(BOUNDARY_PIXEL_ALLOWANCE * 100).toFixed(0)}% ` +
        `of pixels${readback}.`
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
