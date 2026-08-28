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
 * ## Where this used to live
 *
 * `packages/bench/src/views.ts`, which still re-exports it so the bench's own
 * call sites did not have to move. It is here now because it is a renderer built
 * out of this package's primitives, and because two things outside the bench
 * need it: the browser app, which cannot import a module that opens `node:fs`,
 * and any future report that wants the picture without the PNG encoder. Nothing
 * about the arithmetic changed in the move; `test/misregistration.test.ts` pins
 * it against the constructions the bench relied on.
 */

import type { ChannelTriplet, Vec3 } from '../../calibration/src/index.ts';
import type { RgbImage } from './equirect.ts';
import { createImage } from './equirect.ts';
import { worldLonToTextureLon } from './geometry.ts';
import { contentAt } from './render.ts';
import type { PreparedRig } from './optics.ts';
import { pixelToRay, worldToPixel } from './optics.ts';
import { coverageAndWeights, isIlluminatedAt, polarMask } from './coverage.ts';
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
        const c = traceTwoRig(camera.position, dir, physical, content, scene, shading);
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
 */
export function traceTwoRig(
  origin: Vec3,
  dir: Vec3,
  physical: PreparedRig,
  content: PreparedRig,
  scene: Scene,
  shading: ReturnType<typeof lambertianShading> = lambertianShading(),
): ChannelTriplet {
  const hit = physical.surface.intersect(origin, dir);
  if (hit === null) return BLACK;
  const point = hit.point;
  const normal = hit.normal;

  const contributions: ProjectorContribution[] = [];
  for (let i = 0; i < physical.projectors.length; i++) {
    const phys = physical.projectors[i];
    if (!isIlluminatedAt(point, normal, phys)) continue;
    const px = worldToPixel(phys, point);
    if (px === null) continue;

    // What the compositor wrote into that pixel: trace it back out through the
    // calibration the compositor believed it had.
    const cProj = content.projectors[i];
    let signal: ChannelTriplet = BLACK;
    let weight = 0;
    if (cProj !== undefined) {
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
        const ll = content.surface.coordAt(back.point);
        // Image plus the analytic graticule. See `Scene.graticule`: the pattern
        // the gate measures must not be displayed at the resolution of whatever
        // texture it was baked into.
        const target = contentAt(
          scene,
          ll.latDeg,
          worldLonToTextureLon(ll.lonDeg, content.rotationOffsetDeg),
        );
        const wHere =
          coverageAndWeights(back.point, content.surface.normalAt(back.point), content).weights[i] *
          polarMask(ll.latDeg, content.blend, scene.maskInterpretation);
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
      referenceDistanceM: phys.distanceM - physical.radiusM,
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
