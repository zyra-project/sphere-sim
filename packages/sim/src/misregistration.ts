// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The two-calibration room view: what a sphere looks like when the compositor is
 * wrong about where its own lenses are.
 *
 * ## Why one calibration is not enough
 *
 * `renderRoomView` takes ONE calibration and is therefore structurally incapable
 * of showing misregistration. A forward model run against itself paints the
 * physically correct texel at the physically correct point, every time, by
 * construction — the picture is perfect no matter how badly the rig is aimed,
 * because the aim is used both to place the pixel and to decide what goes in it.
 *
 * Real misalignment is a DISAGREEMENT between two calibrations: the one the
 * compositor draws with, and the one the lenses actually have.
 * `metrics/index.ts` already draws that distinction for the numbers. This module
 * draws it for the picture, so the image a reader looks at and the number a
 * reader reads describe the same thing.
 *
 * ## The trace, in four steps
 *
 *   1. Camera ray -> sphere -> surface point `X`.
 *   2. For each PHYSICAL projector that lights `X`: which of its pixels is that?
 *   3. What did the compositor write into that pixel? Trace the same pixel back
 *      out through the CONTENT calibration to `X'`, and read the content there.
 *   4. Emit that signal from the physical projector toward `X`, and shade.
 *
 * Step 3 is the whole thing. When the two calibrations agree, `X' = X` and the
 * image is correct. When they disagree, each projector paints the texel from
 * where it *believes* it is pointing — which is exactly what produces the
 * doubled and kinked grid lines PARAMETERS.md §1's note describes.
 *
 * ## One frame that asks no calibration at all
 *
 * A {@link RasterSource} replaces step 3 for the one thing a projector is ever
 * sent that is not content: a frame of the structured-light sequence, which the
 * emitter writes straight into each projector's raster. Its pixel carries the
 * frame's own value, so the trace stops at the physical pixel and neither the
 * content rig nor anything it decides is consulted. Steps 1, 2 and 4 are the
 * same arithmetic either way, which is what makes the two pictures comparable.
 *
 * ## Where this used to live
 *
 * `packages/bench/src/views.ts`, which still re-exports it so the bench's own
 * call sites did not have to move. It is here now because it is a renderer built
 * out of this package's primitives, and because two things outside the bench
 * need it: the browser app, which cannot import a module that opens `node:fs`,
 * and any future report that wants the picture without the PNG encoder. Nothing
 * about the arithmetic changed in the move. The content path is exercised here by
 * `test/content.test.ts` and `test/mesh-surface.test.ts`, and against the page's
 * shader by `packages/web/test/parity.test.ts` and `supersample.test.ts`;
 * `test/misregistration.test.ts` pins the raster-source path. (This paragraph
 * cited that file before it existed.)
 */

import type { ChannelTriplet, Vec3 } from '../../calibration/src/index.ts';
import type { RgbImage } from './equirect.ts';
import { createImage } from './equirect.ts';
import { worldLonToTextureLon } from './geometry.ts';
import { contentAt } from './render.ts';
import type { PreparedRig } from './optics.ts';
import { pixelToRay, worldToPixel } from './optics.ts';
import { coverageAndWeights, isIlluminatedAt, polarMask } from './coverage.ts';
import { blendModelApplies } from './surface.ts';
import type { ProjectorContribution } from './shading.ts';
import { lambertianShading } from './shading.ts';
import type { Scene, ViewerCamera } from './render.ts';
import { blendedSignal, gridSampleCount, gridSampleOffset, sampleOffset } from './render.ts';
import { add, cross, dot, normalize, scale, sub } from './vec.ts';
import { DEG2RAD } from './vec.ts';

const BLACK: ChannelTriplet = { r: 0, g: 0, b: 0 };

/**
 * There is no `drawFloor` here, and its absence is the point.
 *
 * This interface used to carry `drawFloor` and `floorRadiusM`. Neither was ever
 * read: the trace returns black on a sphere miss and there is no floor code
 * below. An option that silently does nothing is worse than no option, because
 * every caller that passes it believes it worked — and one did. The browser app
 * asked this renderer for a floor, got none, drew one on the GPU, and its
 * shader-versus-model check failed at 9.6% of pixels for a reason that had
 * nothing to do with either model.
 *
 * The floor is omitted on purpose, not by oversight. Its appearance is the
 * projector black-floor spill of PARAMETERS.md §3.2, which is class ASSUME, and
 * these images accompany geometric numbers. A photometric feature in a geometric
 * artifact is an invitation to read it as evidence. A caller that wants a room
 * with a floor wants `renderRoomView`, which models one and takes a single
 * calibration.
 */
export interface RoomViewOptions {
  samplesPerPixel?: number;
  seed?: number;
  /**
   * Where inside the pixel the samples go.
   *
   * `halton` — the default, and what an offline render wants — is the
   * Cranley-Patterson rotated set of `sampleOffset`: better convergence, and
   * decorrelated between pixels so what is left reads as noise rather than as a
   * moire that could be mistaken for misregistration.
   *
   * `grid` is the regular n x n set of `gridSampleOffset`, and it exists so the
   * browser's display shader can place the identical samples. `seed` is unused
   * in that mode; the offsets are the same in every pixel by construction. See
   * `gridSampleOffset` for why parity forces the choice.
   */
  sampleLattice?: 'halton' | 'grid';
  /**
   * A frame in each projector's own raster instead of content. Absent or `null`
   * is the content trace, unchanged. See {@link RasterSource}.
   */
  raster?: RasterSource | null;
}

/**
 * A frame that addresses each projector's own raster, where content addresses
 * the sphere.
 *
 * The structured-light sequence is the one thing a projector is ever sent that
 * is not content. The emitter page paints it straight into the projector's
 * quadrant of the framebuffer, so no calibration is asked anything on the way:
 * pixel (column, row) carries the frame's value at that pixel, whatever anybody
 * believes about where the lens points. The trace therefore stops at the
 * PHYSICAL projector's own pixel. There is no second ray through the content
 * rig, no blend weight, no polar mask and no graticule — `packages/bench`'s
 * capture turns the blend and the mask off for the same reason, and the warp is
 * exactly what the emitter goes around.
 *
 * What stays is everything that is physics rather than content: which pixel the
 * point is lit from, the reconstruction over that projector's pixel grid, the
 * compositor's encode (the emitter encodes at the same 2.2), the projector's own
 * transfer curve, and the shading. A frame of the sequence and a picture of the
 * Earth are lit by the same light and differ only in where the value in the
 * pixel came from.
 *
 * The frame arrives as a function because this package may import
 * `packages/calibration` and nothing else (`tools/boundary-lint.ts`, R1), and
 * the pattern definition lives in `packages/bench`. The browser app hands in
 * `compileFrame` sampled at pixel centres — the same numbers its shader reads.
 */
export interface RasterSource {
  /**
   * Which projectors are emitting this frame: bit `i` for rig projector `i`.
   *
   * The rest are sent black, which is not the same as being absent. A projector
   * sent black still leaks its black floor, exactly as the other quadrants do
   * while one projector runs its sequence on the emitter page.
   */
  mask: number;
  /**
   * Target LINEAR radiance at the centre of pixel (`column`, `row`) of rig
   * projector `index`'s own raster. Both indices are inside the raster; a
   * reconstruction corner that falls off its edge is clamped before this is
   * asked, because there is no pixel out there to emit anything.
   */
  at(index: number, column: number, row: number): number;
}

/**
 * A viewer camera looking at a sphere whose content was generated against a
 * different calibration from the one its lenses have.
 */
export function renderTwoRigRoomView(
  physical: PreparedRig,
  content: PreparedRig,
  scene: Scene,
  camera: ViewerCamera,
  options: RoomViewOptions = {},
): RgbImage {
  const grid = options.sampleLattice === 'grid';
  const asked = Math.max(1, Math.floor(options.samplesPerPixel ?? 1));
  // A grid renders the nearest perfect square, because a grid with a hole in it
  // is not a grid. `gridSampleCount` is where both renderers round.
  const samples = grid ? gridSampleCount(asked) : asked;
  const seed = options.seed ?? 0;
  const shading = lambertianShading();
  const raster = options.raster ?? null;

  const forward = normalize(sub(camera.target, camera.position));
  const upHint = camera.upHint ?? { x: 0, y: 0, z: 1 };
  let right = cross(forward, upHint);
  if (dot(right, right) < 1e-18) right = cross(forward, { x: 1, y: 0, z: 0 });
  right = normalize(right);
  const up = cross(right, forward);
  const halfW = Math.tan((camera.fovHDeg * DEG2RAD) / 2);
  const halfH = (halfW * camera.height) / camera.width;
  // See `ViewerCamera.imageShift`: a principal-point offset, not an aim.
  const shift = camera.imageShift ?? 0;

  const img = createImage(camera.width, camera.height);
  for (let y = 0; y < camera.height; y++) {
    for (let x = 0; x < camera.width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let s = 0; s < samples; s++) {
        const [ox, oy] = grid
          ? gridSampleOffset(s, samples)
          : sampleOffset(x, y, s, samples, seed);
        const sx = ((x + ox) / camera.width) * 2 - 1;
        const sy = 1 - ((y + oy) / camera.height) * 2 + shift;
        const dir = normalize(add(forward, add(scale(right, sx * halfW), scale(up, sy * halfH))));
        const c = traceTwoRig(camera.position, dir, physical, content, scene, shading, raster);
        r += c.r;
        g += c.g;
        b += c.b;
      }
      const i = 3 * (y * camera.width + x);
      img.data[i] = r / samples;
      img.data[i + 1] = g / samples;
      img.data[i + 2] = b / samples;
    }
  }
  return img;
}

/**
 * One ray. Exported because the browser app's parity check needs to compare a
 * shader against this exact function at a scatter of points rather than over a
 * whole raster, and re-deriving "the same trace, at a point" is how the two
 * quietly stop being the same trace.
 *
 * `raster`, when given, is what each projector sends instead of content — see
 * {@link RasterSource}. `null`, the default, is the content trace exactly as it
 * was before the parameter existed.
 */
export function traceTwoRig(
  origin: Vec3,
  dir: Vec3,
  physical: PreparedRig,
  content: PreparedRig,
  scene: Scene,
  shading: ReturnType<typeof lambertianShading> = lambertianShading(),
  raster: RasterSource | null = null,
): ChannelTriplet {
  const hit = physical.surface.intersect(origin, dir);
  if (hit === null) return BLACK;
  const point = hit.point;
  const normal = hit.normal;
  // Whether the sphere's two texture conventions apply: the mechanical rotation
  // offset and the polar mask. `render.ts` and `warp.ts` both gate on this and
  // this path did not, so it disagreed with its own shader about every pixel of
  // a model whenever either was non-zero.
  const blended = blendModelApplies(content.surface);

  const contributions: ProjectorContribution[] = [];
  for (let i = 0; i < physical.projectors.length; i++) {
    const phys = physical.projectors[i];
    if (!isIlluminatedAt(point, normal, phys, null)) continue;
    const px = worldToPixel(phys, point);
    if (px === null) continue;

    // What the compositor wrote into that pixel: trace it back out through the
    // calibration the compositor believed it had.
    const cProj = content.projectors[i];
    let signal: ChannelTriplet = BLACK;
    let weight = 0;
    if (raster !== null) {
      // Or what the emitter wrote there, which is the frame itself. No content
      // rig, no weight, no mask: see `RasterSource`. A projector outside the
      // mask keeps signal zero and still contributes, as its black floor.
      if (emits(raster, i)) {
        signal = rasterSignal(raster, i, px.u, px.v, phys.cal.intrinsics, scene.encodeGamma);
        weight = 1;
      }
    } else if (cProj !== undefined) {
      // Reconstructed over the projector's PIXEL GRID, not resampled
      // continuously. The compositor writes one value per pixel, at its centre,
      // and a projector cannot draw anything finer; sampling the content at a
      // continuous coordinate gave every projector infinite resolution, so a
      // 1024x768 rig and a 4K one drew the same picture.
      //
      // Bilinear over the four surrounding centres — the same reconstruction
      // `metrics/grid.ts` uses, and for the same stated reason: it is what a
      // real projector does with its grid. The lens spot, which overlaps its
      // neighbours and would soften this further, is still not modelled.
      const fu = px.u - 0.5;
      const fv = px.v - 0.5;
      const i0 = Math.floor(fu);
      const j0 = Math.floor(fv);
      const tu = fu - i0;
      const tv = fv - j0;
      let acc: ChannelTriplet = BLACK;
      for (let c = 0; c < 4; c++) {
        const du = c === 1 || c === 3 ? 1 : 0;
        const dv = c >= 2 ? 1 : 0;
        const w = (du ? tu : 1 - tu) * (dv ? tv : 1 - tv);
        if (w <= 0) continue;
        const ray = pixelToRay(cProj, i0 + du + 0.5, j0 + dv + 0.5);
        const back = content.surface.intersect(cProj.lens, ray);
        if (back === null) continue;
        // `back.location`, not the point alone. Every other consumer was moved
        // onto the face the hit carries; this one kept re-finding it by the
        // radial search, which is exact only for a star-shaped body and finds
        // NOTHING for a flat wall. On a mesh that put the whole surface on one
        // content coordinate with a normal at right angles to itself, inside the
        // one view whose job is to show two rigs disagreeing.
        const ll = content.surface.coordAt(back.point, back.location);
        // Image plus the analytic graticule. See `Scene.graticule`: the pattern
        // the gate measures must not be displayed at the resolution of whatever
        // texture it was baked into.
        // The sphere's texture is anchored to the world by a mechanical
        // rotation; a mesh's UV is anchored by its own unwrap and has no such
        // offset. `render.ts` and `warp.ts` both make this exception and this
        // path did not, so the shader -- which does -- disagreed with it about
        // every pixel of a model whenever the offset was non-zero.
        const target = contentAt(
          scene,
          ll.latDeg,
          blended ? worldLonToTextureLon(ll.lonDeg, content.rotationOffsetDeg) : ll.lonDeg,
        );
        // The polar mask attenuates the exposed south cap because the mount
        // occludes the north one. A dropped model has neither, so it is refused
        // rather than approximated -- `blendModelApplies` is the same gate
        // `coverage.ts` and `warp.ts` use.
        const wHere =
          coverageAndWeights(back.point, back.normal, content, back.location).weights[i] *
          (blended ? polarMask(ll.latDeg, content.blend, scene.maskInterpretation) : 1);
        if (wHere > weight) weight = wHere;
        const s = blendedSignal(target, wHere, scene.encodeGamma);
        acc = { r: acc.r + w * s.r, g: acc.g + w * s.g, b: acc.b + w * s.b };
      }
      signal = acc;
    }

    const toLensVec = sub(phys.lens, point);
    const distanceM = Math.hypot(toLensVec.x, toLensVec.y, toLensVec.z);
    contributions.push({
      projector: i,
      signal,
      weight,
      incidenceCos: dot(normal, toLensVec) / distanceM,
      distanceM,
      toLens: scale(toLensVec, 1 / distanceM),
      transfer: phys.cal.transfer,
      referenceDistanceM: phys.referenceDistanceM,
    });
  }

  return shading.shade({
    point,
    normal,
    viewDir: scale(dir, -1),
    contributions,
    reflectance: scene.reflectance,
    ambient: scene.ambient,
  });
}

/** Is rig projector `i` one of the projectors a raster frame is lit on? */
function emits(raster: RasterSource, i: number): boolean {
  // Bits 0 to 30 only. Past them a shift count wraps modulo 32 and lights a
  // projector nobody asked for, and bit 31 is the sign of a mask built with `<<`.
  // The page's shader has room for eight.
  return i < 31 && ((raster.mask >>> i) & 1) === 1;
}

/**
 * One projector's raster frame at a point it lights from pixel coordinate
 * (`u`, `v`): the four surrounding pixel centres, bilinear, each encoded as the
 * emitter encodes it.
 *
 * The same reconstruction the content path above uses, and for its reason — a
 * projector draws nothing finer than one value per pixel. What differs is where
 * a centre's value comes from: the frame, asked directly, rather than a second
 * trace through the compositor's belief. The weight is 1 because nothing blends
 * a calibration frame; the encode is `blendedSignal` at that weight so the frame
 * and content go through one expression on the way to the transfer curve.
 */
function rasterSignal(
  raster: RasterSource,
  index: number,
  u: number,
  v: number,
  it: { resX: number; resY: number },
  encodeGamma: ChannelTriplet,
): ChannelTriplet {
  const fu = u - 0.5;
  const fv = v - 0.5;
  const i0 = Math.floor(fu);
  const j0 = Math.floor(fv);
  const tu = fu - i0;
  const tv = fv - j0;
  let acc: ChannelTriplet = BLACK;
  for (let c = 0; c < 4; c++) {
    const du = c === 1 || c === 3 ? 1 : 0;
    const dv = c >= 2 ? 1 : 0;
    const w = (du ? tu : 1 - tu) * (dv ? tv : 1 - tv);
    if (w <= 0) continue;
    // A point within half a pixel of the raster's edge has a corner off it. The
    // edge pixel stands in, which is what the shader's `clamp` does too; there
    // is no pixel beyond it to emit anything else.
    const column = Math.min(it.resX - 1, Math.max(0, i0 + du));
    const row = Math.min(it.resY - 1, Math.max(0, j0 + dv));
    const t = raster.at(index, column, row);
    const s = blendedSignal({ r: t, g: t, b: t }, 1, encodeGamma);
    acc = { r: acc.r + w * s.r, g: acc.g + w * s.g, b: acc.b + w * s.b };
  }
  return acc;
}
