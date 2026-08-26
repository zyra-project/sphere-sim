// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The parity check: does the GPU renderer agree with `packages/sim`?
 *
 * docs/ARCHITECTURE.md names the risk this file exists for. The harness renders
 * with GLSL and the bench renders on the CPU; those are two implementations of
 * the simulator's OWN model, and unlike the A/B duplication between `sim` and
 * `solver` — which is load-bearing and must never be removed — this one is an
 * accident of wanting a window. Its failure mode is silent drift: a term goes
 * into one and not the other, the picture still looks like a sphere, and a human
 * builds intuition from a model nothing scores.
 *
 * ## Three links, and only two of them can be executed here
 *
 * ```
 *   packages/sim  <--(1)-->  reference.ts  <--(2)-->  glsl.ts  <--(3)-->  a real GPU
 *      float64                  float64                 text              float32
 * ```
 *
 * (1) is this module: two independent implementations of the same model, both in
 *     Node, compared pixel by pixel. It runs in `node --test` with no GPU.
 * (2) is `test/glsl.test.ts`: the shader source is parsed for its function
 *     signatures and the reference must cover every one of them, both ways.
 *     Structure, not arithmetic.
 * (3) needs a GPU. It is measured at RUNTIME by `web/main.ts`, which reads the
 *     rendered framebuffer back, runs the same {@link comparePixels} against a
 *     `packages/sim` render of the same scene, and puts the number on screen
 *     where nobody can miss it. It is not measured in this container, and
 *     `packages/harness/README.md` says so in those words.
 *
 * ## Why there are two tolerances nine orders of magnitude apart
 *
 * {@link MODEL_TOLERANCE} governs (1). Both sides are float64 and both are
 * evaluating the same expressions, so the only thing separating them is
 * floating-point association order. Anything larger than that is a real
 * difference in the model and must fail.
 *
 * {@link GPU_TOLERANCE} governs (3). A GPU is float32, its texture filtering is
 * allowed reduced precision by the GL spec, and `pow`, `exp` and the inverse
 * trigonometric functions carry a few ULP of implementation freedom. 2e-3 of
 * relative radiance is roughly half a step of an 8-bit display code, which is the
 * point past which a disagreement would be visible rather than merely present.
 *
 * ## Why the verdict is not "max delta under tolerance"
 *
 * At the sphere's limb, at each projector's coverage boundary, and at the raster
 * edge, a difference of one ULP flips a hit into a miss and produces a
 * full-amplitude delta at that pixel. That is not drift, it is a boundary landing
 * between two samples, and a max-only verdict would make the check fail at random
 * as the viewer moves. So the verdict is taken on a high percentile, and the
 * count of full-amplitude boundary pixels is reported SEPARATELY with its own
 * allowance — visible, bounded, and never quietly folded into an average.
 */

import type { RgbImage } from '../../sim/src/equirect.ts';
import type { Scene, ViewerCamera } from '../../sim/src/render.ts';
import { blendedSignal, renderRoomView, sampleSurface } from '../../sim/src/render.ts';
import type { PreparedRig } from '../../sim/src/optics.ts';
import { pixelToRay, prepareRig } from '../../sim/src/optics.ts';
import { raySphereIntersect } from '../../sim/src/geometry.ts';
import type { RigCalibration } from '../../calibration/src/index.ts';
import type { ShadingModel } from '../../sim/src/shading.ts';
import type { ReferenceImage } from './reference.ts';
import { renderProjectorReference, renderRoomReference } from './reference.ts';
import { buildUniforms } from './uniforms.ts';

/**
 * Link (1): `reference.ts` against `packages/sim`, both float64.
 *
 * **Measured, then set — not chosen.** Across the six configurations in
 * `test/parity.test.ts` the observed delta is **exactly zero on every channel of
 * every pixel**, in the room track and in all four projector tracks. The two
 * implementations are arithmetically identical to float64 and then round to the
 * same float32.
 *
 * The tolerance is nevertheless 1e-6 rather than 0, for one reason worth writing
 * down: both images are `Float32Array`, matching `sim`'s `RgbImage`, so the
 * finest difference the comparison can even represent near a radiance of 1.0 is
 * one float32 ULP, 6e-8. A tolerance below that would be a statement about the
 * storage format, and the first time a compiler reassociated a sum it would fail
 * for a reason with no physical meaning. 1e-6 is about sixteen storage ULPs, four
 * orders of magnitude under PARAMETERS.md §7's tightest photometric gate (a 2%
 * seam step), and — measured — three orders above the observed zero.
 *
 * It is not a loose gate. Nudging `rampGamma` by one part in 100 000 already
 * moves the 99.9th percentile to 1.6e-6 and fails. A real model difference — a
 * dropped `(1 - blackFloor)`, a mask applied before normalization instead of
 * after — moves it by 1e-3 or more.
 */
export const MODEL_TOLERANCE = 1e-6;

/**
 * Link (3): a real GPU against `packages/sim`. float32 versus float64.
 *
 * 2e-3 of relative radiance. PARAMETERS.md §7's tightest photometric gate is a
 * 2% seam luminance step, so a renderer disagreeing by more than a tenth of that
 * is capable of moving a verdict and the harness must say so loudly.
 */
export const GPU_TOLERANCE = 2e-3;

/**
 * Fraction of pixels allowed to exceed the tolerance because a geometric
 * boundary landed between two samples.
 *
 * A limb, a coverage edge and a raster edge each contribute roughly one pixel of
 * perimeter. On a 160x120 room view the sphere's outline is a few hundred pixels
 * out of 19 200, so 1% is generous for the real cause and far too tight to hide
 * an actual model difference, which would light up the interior rather than an
 * outline.
 */
export const BOUNDARY_PIXEL_ALLOWANCE = 0.01;

export interface PixelDelta {
  /** Worst single-channel absolute difference anywhere in the image. */
  maxAbs: number;
  /** Mean absolute difference over every channel of every pixel. */
  meanAbs: number;
  rms: number;
  /** 99.9th percentile of the per-pixel worst-channel difference. */
  p999: number;
  /** Per-pixel worst-channel difference, median. */
  median: number;
  /** Pixels whose worst-channel difference exceeds the tolerance. */
  pixelsOverTolerance: number;
  pixelCount: number;
  /** `pixelsOverTolerance / pixelCount`. */
  fractionOverTolerance: number;
  /** Where the worst pixel is, so a report can point at it. */
  worst: { x: number; y: number; channel: 'r' | 'g' | 'b'; a: number; b: number };
}

/** Compare two images of identical size, channel by channel. */
export function comparePixels(
  a: { width: number; height: number; data: Float32Array },
  b: { width: number; height: number; data: Float32Array },
  tolerance: number,
): PixelDelta {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `parity needs identical rasters: ${a.width}x${a.height} against ${b.width}x${b.height}. ` +
        `Comparing a resampled image would measure the resampler.`,
    );
  }
  const n = a.width * a.height;
  const perPixel = new Float64Array(n);
  let maxAbs = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let over = 0;
  const worst = { x: 0, y: 0, channel: 'r' as 'r' | 'g' | 'b', a: 0, b: 0 };
  const names: ('r' | 'g' | 'b')[] = ['r', 'g', 'b'];

  for (let i = 0; i < n; i++) {
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const av = a.data[3 * i + c];
      const bv = b.data[3 * i + c];
      const d = Math.abs(av - bv);
      sumAbs += d;
      sumSq += d * d;
      if (d > pixelMax) pixelMax = d;
      if (d > maxAbs) {
        maxAbs = d;
        worst.x = i % a.width;
        worst.y = Math.floor(i / a.width);
        worst.channel = names[c];
        worst.a = av;
        worst.b = bv;
      }
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
    rms: n === 0 ? 0 : Math.sqrt(sumSq / (3 * n)),
    p999: at(0.999),
    median: at(0.5),
    pixelsOverTolerance: over,
    pixelCount: n,
    fractionOverTolerance: n === 0 ? 0 : over / n,
    worst,
  };
}

export interface ParityTrack {
  /** `room` or `projector-N`. */
  id: string;
  /** What this track exercises that the others do not. */
  covers: string;
  delta: PixelDelta;
  tolerance: number;
  /** True when p999 is inside tolerance AND the boundary count is inside its allowance. */
  pass: boolean;
  /** Why it failed, or `''`. */
  reason: string;
}

export interface ParityReport {
  /** `model` for link (1), `gpu` for link (3). */
  link: 'model' | 'gpu';
  tolerance: number;
  tracks: ParityTrack[];
  pass: boolean;
  /** The worst p999 over every track — the single number the UI displays. */
  worstP999: number;
  worstMaxAbs: number;
  /** One sentence, ready to print. */
  summary: string;
}

function judge(id: string, covers: string, delta: PixelDelta, tolerance: number): ParityTrack {
  const percentileOk = delta.p999 <= tolerance;
  const boundaryOk = delta.fractionOverTolerance <= BOUNDARY_PIXEL_ALLOWANCE;
  const reasons: string[] = [];
  if (!percentileOk) {
    reasons.push(
      `p99.9 delta ${delta.p999.toExponential(3)} exceeds ${tolerance.toExponential(1)}`,
    );
  }
  if (!boundaryOk) {
    reasons.push(
      `${(delta.fractionOverTolerance * 100).toFixed(2)}% of pixels are over tolerance, above the ` +
        `${(BOUNDARY_PIXEL_ALLOWANCE * 100).toFixed(0)}% allowance for geometric boundaries`,
    );
  }
  return {
    id,
    covers,
    delta,
    tolerance,
    pass: percentileOk && boundaryOk,
    reason: reasons.join('; '),
  };
}

export function summarize(link: 'model' | 'gpu', tracks: ParityTrack[], tolerance: number): ParityReport {
  const pass = tracks.every((t) => t.pass);
  const worstP999 = tracks.reduce((m, t) => Math.max(m, t.delta.p999), 0);
  const worstMaxAbs = tracks.reduce((m, t) => Math.max(m, t.delta.maxAbs), 0);
  const which = link === 'model' ? 'GLSL reference vs packages/sim' : 'GPU vs packages/sim';
  const summary = pass
    ? `${which}: agree to ${worstP999.toExponential(2)} at p99.9 (tolerance ${tolerance.toExponential(1)}).`
    : `${which}: DISAGREE. ${tracks
        .filter((t) => !t.pass)
        .map((t) => `${t.id} — ${t.reason}`)
        .join('. ')}`;
  return { link, tolerance, tracks, pass, worstP999, worstMaxAbs, summary };
}

export interface ParityOptions {
  width?: number;
  height?: number;
  /** Sample grid across each projector's raster. See {@link projectorTrack}. */
  projectorWidth?: number;
  projectorHeight?: number;
  tolerance?: number;
  drawFloor?: boolean;
  floorRadiusM?: number;
  shading?: ShadingModel;
  specWeight?: number;
  specAlpha?: number;
  /** Which projectors to check. Defaults to all of them. */
  projectors?: number[];
}

/**
 * `sim`'s `renderProjectorView` inner loop, evaluated at an arbitrary sample
 * grid rather than at every pixel of a 1920x1080 raster.
 *
 * Rendering two megapixels through a CPU tracer on every parity check would take
 * minutes and prove nothing the subsample does not — the question is whether the
 * two models agree at a point. `test/parity.test.ts` pins the shortcut by
 * building a small rig where the sample grid IS the raster and asserting this
 * function reproduces `renderProjectorView` exactly, so the convenience cannot
 * quietly become a different calculation.
 */
export function simProjectorSamples(
  prepared: PreparedRig,
  index: number,
  scene: Scene,
  width: number,
  height: number,
): RgbImage {
  const proj = prepared.projectors[index];
  if (!proj) throw new Error(`no projector at index ${index}`);
  const it = proj.cal.intrinsics;
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width) * it.resX;
      const v = ((y + 0.5) / height) * it.resY;
      const ray = pixelToRay(proj, u, v);
      const hit = raySphereIntersect(proj.lens, ray, prepared.radiusM);
      const o = 3 * (y * width + x);
      if (!hit) continue;
      const surf = sampleSurface(hit.point, prepared, scene);
      const sig = blendedSignal(surf.target, surf.weights[index], scene.encodeGamma);
      data[o] = sig.r;
      data[o + 1] = sig.g;
      data[o + 2] = sig.b;
    }
  }
  return { width, height, data };
}

/**
 * Link (1), headless: render the same scene through `reference.ts` and through
 * `packages/sim`, and report the delta.
 *
 * Two tracks, because they exercise disjoint halves of the model. The room view
 * never calls `pixelToRay` and therefore never touches the distortion inversion;
 * the projector views never call the shading model, the transfer curve, the
 * floor or the ambient term. A parity check on either alone would leave half the
 * shader unmeasured, and it would be the half whose bugs are hardest to see.
 */
export function checkModelParity(
  rig: RigCalibration,
  scene: Scene,
  camera: ViewerCamera,
  options: ParityOptions = {},
): ParityReport {
  const width = options.width ?? camera.width;
  const height = options.height ?? camera.height;
  const tolerance = options.tolerance ?? MODEL_TOLERANCE;
  const pw = options.projectorWidth ?? 96;
  const ph = options.projectorHeight ?? 54;
  const prepared = prepareRig(rig);

  const roomCamera: ViewerCamera = { ...camera, width, height };
  const uniformsRoom = buildUniforms(rig, scene, roomCamera, {
    mode: 'room',
    drawFloor: options.drawFloor ?? true,
    floorRadiusM: options.floorRadiusM ?? 8,
    displayGamma: 0,
    specWeight: options.specWeight ?? 0,
    specAlpha: options.specAlpha ?? 0.4,
  });

  const simRoom = renderRoomView(prepared, scene, roomCamera, {
    samplesPerPixel: 1,
    drawFloor: options.drawFloor ?? true,
    floorRadiusM: options.floorRadiusM ?? 8,
    ...(options.shading ? { shading: options.shading } : {}),
  });
  const refRoom: ReferenceImage = renderRoomReference(uniformsRoom, width, height);

  const tracks: ParityTrack[] = [
    judge(
      'room',
      'ray-sphere, coverage, blend weights, polar mask, per-channel transfer, shading, floor black-floor spill',
      comparePixels(refRoom, simRoom, tolerance),
      tolerance,
    ),
  ];

  const indices = options.projectors ?? rig.projectors.map((_, i) => i);
  for (const i of indices) {
    const uniformsProj = buildUniforms(rig, scene, roomCamera, {
      mode: 'projector',
      projIndex: i,
      displayGamma: 0,
    });
    const refProj: ReferenceImage = renderProjectorReference(uniformsProj, i, pw, ph);
    const simProj = simProjectorSamples(prepared, i, scene, pw, ph);
    tracks.push(
      judge(
        `projector-${i}`,
        'pixel -> ray, Brown-Conrady inversion, lens shift, raster bounds, blend weight of one projector',
        comparePixels(refProj, simProj, tolerance),
        tolerance,
      ),
    );
  }

  return summarize('model', tracks, tolerance);
}
