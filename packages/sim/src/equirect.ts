// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Equirectangular source imagery: sampling it, and generating the patterns an
 * operator actually looks at.
 *
 * Everything in here is LINEAR light (conventions.ts §P). Nothing is encoded
 * until png.ts, at the very end of the pipeline. A texture loaded from an 8-bit
 * file has to be linearized on the way in; a procedural pattern is authored in
 * linear directly and never round-trips through an encoding at all.
 */

import type { ChannelTriplet } from '../../calibration/src/index.ts';
import type { PreparedRig } from './optics.ts';
import { clamp, wrapDeg180 } from './vec.ts';

/**
 * A float RGB raster. Row 0 is the TOP.
 *
 * `Float32Array` rather than `Float64Array`: the whole pipeline is relative
 * radiance in roughly [0, 4], where float32's 24-bit mantissa is far more
 * precision than the 16-bit PNG output can carry, and halving the memory keeps a
 * 3840x2160 framebuffer under 100 MB.
 */
export interface RgbImage {
  width: number;
  height: number;
  /** `3 * (y * width + x)` gives the red component. Linear light. */
  data: Float32Array;
}

/**
 * An equirectangular texture. Same layout as {@link RgbImage}; the alias exists
 * to make signatures say what they mean.
 *
 * conventions.ts §S: the image spans a full 360 by 180 degrees, column 0 is
 * texture longitude -180, and row 0 is latitude +90.
 */
export type EquirectImage = RgbImage;

export function createImage(width: number, height: number): RgbImage {
  return { width, height, data: new Float32Array(width * height * 3) };
}

export function setPixel(img: RgbImage, x: number, y: number, c: ChannelTriplet): void {
  const i = 3 * (y * img.width + x);
  img.data[i] = c.r;
  img.data[i + 1] = c.g;
  img.data[i + 2] = c.b;
}

export function getPixel(img: RgbImage, x: number, y: number): ChannelTriplet {
  const i = 3 * (y * img.width + x);
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] };
}

/**
 * Bilinear sample of an equirectangular image at a texture latitude/longitude.
 *
 * Longitude WRAPS and latitude CLAMPS, and the asymmetry is not a shortcut: the
 * texture is periodic in longitude (column `width-1` is adjacent to column 0, so
 * a seam appears down the prime meridian if you clamp instead) and is not
 * periodic in latitude (the rows above +90 and below -90 do not exist, and
 * wrapping there would fold the north pole onto the south).
 *
 * Texel centres sit at half-integer coordinates, the same convention
 * conventions.ts §I fixes for projector pixels — one convention for the whole
 * package rather than two that differ by half a texel.
 */
export function sampleEquirect(img: EquirectImage, latDeg: number, lonDeg: number): ChannelTriplet {
  const lon = wrapDeg180(lonDeg);
  // Continuous texel coordinates with the half-texel centre offset removed.
  const fx = ((lon + 180) / 360) * img.width - 0.5;
  const fy = ((90 - clamp(latDeg, -90, 90)) / 180) * img.height - 0.5;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const xa = wrapIndex(x0, img.width);
  const xb = wrapIndex(x0 + 1, img.width);
  const ya = clampIndex(y0, img.height);
  const yb = clampIndex(y0 + 1, img.height);

  const w = img.width;
  const ia = 3 * (ya * w + xa);
  const ib = 3 * (ya * w + xb);
  const ic = 3 * (yb * w + xa);
  const id = 3 * (yb * w + xb);
  const d = img.data;

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  return {
    r: d[ia] * w00 + d[ib] * w10 + d[ic] * w01 + d[id] * w11,
    g: d[ia + 1] * w00 + d[ib + 1] * w10 + d[ic + 1] * w01 + d[id + 1] * w11,
    b: d[ia + 2] * w00 + d[ib + 2] * w10 + d[ic + 2] * w01 + d[id + 2] * w11,
  };
}

function wrapIndex(i: number, n: number): number {
  const m = i % n;
  return m < 0 ? m + n : m;
}

function clampIndex(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/**
 * Evaluate a scalar function of position over a lat/lon grid.
 *
 * This is how every diagnostic field in the project gets made: coverage,
 * incidence cosine, overlap multiplicity, registration error. The grid is the
 * same equirectangular parameterization as the source imagery, so a field map
 * and the content it describes can be laid on top of each other directly.
 *
 * Samples land at CELL CENTRES, not at cell corners. At the poles a
 * corner-sampled grid puts a whole row of samples at exactly latitude +90, where
 * longitude is undefined and every projector's coverage test returns the same
 * answer — which makes the four-lobed structure of PARAMETERS.md §4.3 disappear
 * from the top row of the map for purely parametric reasons.
 */
export function fieldMap(
  rig: PreparedRig,
  width: number,
  height: number,
  fn: (latDeg: number, lonDeg: number, rig: PreparedRig) => number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    for (let x = 0; x < width; x++) {
      const lon = -180 + ((x + 0.5) / width) * 360;
      out[y * width + x] = fn(lat, lon, rig);
    }
  }
  return out;
}

/** {@link fieldMap} for a function that returns colour. */
export function fieldMapRgb(
  rig: PreparedRig,
  width: number,
  height: number,
  fn: (latDeg: number, lonDeg: number, rig: PreparedRig) => ChannelTriplet,
): RgbImage {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    for (let x = 0; x < width; x++) {
      const lon = -180 + ((x + 0.5) / width) * 360;
      setPixel(img, x, y, fn(lat, lon, rig));
    }
  }
  return img;
}

/**
 * Solid-angle weight of a cell in a `fieldMap` grid, for area-weighted
 * reductions.
 *
 * Averaging an equirectangular field without this weight over-counts the poles
 * by a factor of `1/cos(lat)` — unbounded as the pole is approached. Every
 * "fraction of the sphere" number in this project (unlit area, off-sphere flux,
 * coverage) is wrong by 30% or more if it is computed as a plain mean over the
 * grid, and it is wrong in the direction that flatters the polar results.
 */
export function cellSolidAngleWeight(latDeg: number): number {
  return Math.cos((latDeg * Math.PI) / 180);
}

export interface GridPatternOptions {
  width: number;
  height: number;
  /** Degrees between graticule lines. SOS grid alignment uses coarse spacing. */
  spacingDeg?: number;
  /** Line width in DEGREES, not pixels, so the pattern is resolution-independent. */
  lineWidthDeg?: number;
  /** Linear-light colour of the graticule lines. */
  lineColor?: ChannelTriplet;
  /** Linear-light colour of the background. */
  backgroundColor?: ChannelTriplet;
  /** Emphasize the equator and the prime meridian with a wider, brighter line. */
  emphasizeAxes?: boolean;
  /**
   * Tint each projector's quadrant of longitude differently, so a room
   * photograph shows at a glance which projector drew which part of a seam.
   * Off by default: it is a debugging aid, not what SOS displays.
   */
  quadrantTint?: ChannelTriplet[];
}

/**
 * The graticule as a CONTINUOUS function of position — line coverage in [0, 1]
 * at one point on the sphere, before any colour is applied.
 *
 * Factored out of {@link gridAlignmentPattern} rather than duplicated, because
 * `metrics/grid.ts` needs to evaluate the same pattern at arbitrary sub-texel
 * positions. The grid-displacement gate of PARAMETERS.md §7 is 1.0 mm on a
 * sphere whose projector pixels are ~1.3 mm across, so the metric cannot afford
 * to inherit the resolution of whatever texture the raster happened to be
 * baked into: it evaluates the pattern analytically and lets the PROJECTOR
 * raster be the only quantization in the chain. One definition, two consumers,
 * so the number the metric reports is a property of the pattern an operator
 * actually sees.
 *
 * Line width is in DEGREES rather than pixels for two reasons. It makes the
 * pattern independent of the texture resolution, and — more importantly — a line
 * of constant angular width has a constant width on the SPHERE, so a measured
 * displacement in millimetres of arc means the same thing everywhere. A
 * constant-pixel-width line in an equirectangular map narrows as `cos(lat)` in
 * the direction that matters, right where the poles need the most care.
 *
 * Meridian lines are measured against angular distance along the parallel
 * (`delta_lon * cos(lat)`), for the same reason: otherwise every meridian fans
 * out into a wedge as it approaches the pole and the pattern turns into a solid
 * disc there.
 */
export function graticuleCoverage(
  latDeg: number,
  lonDeg: number,
  spacingDeg: number,
  lineWidthDeg: number,
  emphasizeAxes: boolean,
  featherFrac = DEFAULT_FEATHER_FRAC,
): number {
  const half = lineWidthDeg / 2;
  const cosLat = Math.max(1e-6, Math.cos((latDeg * Math.PI) / 180));
  const dLat = distanceToNearestMultiple(latDeg, spacingDeg);
  const dLon = distanceToNearestMultiple(wrapDeg180(lonDeg), spacingDeg) * cosLat;

  let coverage = Math.max(
    lineCoverage(dLat, half, featherFrac),
    lineCoverage(dLon, half, featherFrac),
  );
  if (emphasizeAxes) {
    coverage = Math.max(
      coverage,
      lineCoverage(Math.abs(latDeg), half * 2, featherFrac),
      lineCoverage(Math.abs(wrapDeg180(lonDeg)) * cosLat, half * 2, featherFrac),
    );
  }
  return coverage;
}

/**
 * The lat/lon graticule an operator sees during SOS Grid Alignment.
 *
 * The whole point of this pattern is that misregistration between two projectors
 * shows up as a doubled or kinked line, which is the failure mode PARAMETERS.md
 * §1's note describes ("vertical grid lines diverge or crisscross in the overlap
 * regions near the poles") and which the grid-displacement gate in §7 quantifies.
 *
 * Rasterizes {@link graticuleCoverage} at cell centres and applies colour.
 */
export function gridAlignmentPattern(options: GridPatternOptions): EquirectImage {
  const {
    width,
    height,
    spacingDeg = 15,
    lineWidthDeg = 0.35,
    lineColor = { r: 1, g: 1, b: 1 },
    backgroundColor = { r: 0, g: 0, b: 0 },
    emphasizeAxes = true,
    quadrantTint,
  } = options;

  const img = createImage(width, height);

  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180;

    for (let x = 0; x < width; x++) {
      const lon = -180 + ((x + 0.5) / width) * 360;
      const coverage = graticuleCoverage(lat, lon, spacingDeg, lineWidthDeg, emphasizeAxes);

      let tint: ChannelTriplet = lineColor;
      if (quadrantTint && quadrantTint.length > 0) {
        // Nearest nominal projector azimuth: 0, 90, 180, 270 mapped into
        // (-180, 180]. PARAMETERS.md §2 counts counterclockwise from P1.
        const idx = Math.round(wrapDeg180(lon) / 90);
        const q = ((idx % quadrantTint.length) + quadrantTint.length) % quadrantTint.length;
        const t = quadrantTint[q];
        tint = { r: lineColor.r * t.r, g: lineColor.g * t.g, b: lineColor.b * t.b };
      }

      setPixel(img, x, y, {
        r: backgroundColor.r + coverage * (tint.r - backgroundColor.r),
        g: backgroundColor.g + coverage * (tint.g - backgroundColor.g),
        b: backgroundColor.b + coverage * (tint.b - backgroundColor.b),
      });
    }
  }
  return img;
}

/** Signed distance in degrees from `value` to the nearest multiple of `step`. */
function distanceToNearestMultiple(value: number, step: number): number {
  const m = value / step;
  return Math.abs(value - Math.round(m) * step);
}

/**
 * How much of the half-width is edge ramp rather than plateau. 0.2 gives a
 * crisp line with a narrow antialiasing skirt, 1.0 gives a triangular profile
 * with no plateau at all.
 */
export const DEFAULT_FEATHER_FRAC = 0.2;

/**
 * Antialiased line coverage: 1 inside the line, 0 outside, with a linear ramp
 * `featherFrac` of the half-width wide.
 *
 * A hard edge here would alias badly once the pattern is resampled onto a
 * projector raster and then onto a camera, and the resulting shimmer would be
 * indistinguishable from the registration error the pattern exists to measure.
 *
 * The ramp is exactly LINEAR, which `metrics/grid.ts` depends on: its line
 * localiser finds each edge's half-height crossing, and a symmetric blur kernel
 * leaves the half-height point of a linear ramp exactly where it was. That is
 * what makes sub-pixel localisation unbiased as the incidence angle — and
 * therefore the size of the blur — changes across the sphere.
 */
function lineCoverage(
  distanceDeg: number,
  halfWidthDeg: number,
  featherFrac = DEFAULT_FEATHER_FRAC,
): number {
  const feather = Math.max(1e-6, halfWidthDeg * featherFrac);
  const t = (halfWidthDeg - distanceDeg) / feather;
  return clamp(t, 0, 1);
}

/**
 * A flat field of one linear value. PARAMETERS.md §8 items 6-9 and 13-14 are all
 * flat fields; this is the source image for every one of them.
 */
export function flatField(width: number, height: number, color: ChannelTriplet): EquirectImage {
  const img = createImage(width, height);
  for (let i = 0; i < width * height; i++) {
    img.data[3 * i] = color.r;
    img.data[3 * i + 1] = color.g;
    img.data[3 * i + 2] = color.b;
  }
  return img;
}
