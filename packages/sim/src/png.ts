// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Deterministic PNG encoding — the forward model's own copy.
 *
 * Zero runtime dependencies is a project rule, but there is a second reason to
 * write this by hand: the bench's determinism check compares output files byte
 * for byte across runs, and an encoder that picks filters adaptively, embeds a
 * timestamp, or lets zlib choose a strategy will produce different bytes for
 * identical pixels. Everything here is fixed: filter type 0 on every scanline, a
 * pinned compression level, no ancillary chunks.
 *
 * 16-bit output exists because the field maps in `progress/` carry values whose
 * interesting structure is finer than 1/255 — the coverage boundary of
 * PARAMETERS.md §4.3 moves 4 degrees of latitude between a projector meridian
 * and a seam, and quantizing an incidence map to 8 bits puts visible contours
 * across exactly that gradient.
 */

import * as zlib from 'node:zlib';
import type { ChannelTriplet } from '../../calibration/src/index.ts';
import type { RgbImage } from './equirect.ts';
import { clamp } from './vec.ts';

/**
 * Fixed compression level. Level 6 rather than 9: zlib's level 9 spends
 * disproportionate time for a percent or two on image data, and the bench writes
 * a lot of PNGs per round. What matters for determinism is only that the level
 * never changes, not what it is.
 */
const COMPRESSION_LEVEL = 6;

const CRC_TABLE = (((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}))();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assemble(width: number, height: number, bitDepth: 8 | 16, raw: Uint8Array): Buffer {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering (per-scanline byte, always 0 below)
  ihdr[12] = 0; // no interlace

  const idat = zlib.deflateSync(raw, { level: COMPRESSION_LEVEL });
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(idat.buffer, idat.byteOffset, idat.byteLength)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * The transfer applied at the final viewer-camera step, and nowhere else.
 *
 * conventions.ts §P is explicit that all blending, summation and metric
 * computation happen in linear light and that encoding happens only here. The
 * default exponent is 2.2, matching the nominal `gamma_R,G,B` of PARAMETERS.md
 * §3.2 — this is the camera's encoding, not any projector's, and it exists so a
 * rendered PNG looks approximately right on an ordinary display.
 */
export interface EncodeOptions {
  /** Linear multiplier applied before encoding. 1.0 = no exposure change. */
  exposure?: number;
  /** Encoding exponent. Output is `(exposure * L)^(1/displayGamma)`. */
  displayGamma?: number;
}

function encodeChannel(value: number, exposure: number, invGamma: number): number {
  const v = value * exposure;
  return v <= 0 ? 0 : Math.pow(v, invGamma);
}

/** Encode a linear float image to 8-bit RGB PNG bytes. */
export function encodePng8(img: RgbImage, options: EncodeOptions = {}): Buffer {
  const exposure = options.exposure ?? 1;
  const invGamma = 1 / (options.displayGamma ?? 2.2);
  const stride = img.width * 3 + 1;
  const raw = new Uint8Array(stride * img.height);
  for (let y = 0; y < img.height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type 0 (None), fixed for byte reproducibility
    for (let x = 0; x < img.width; x++) {
      const s = 3 * (y * img.width + x);
      for (let c = 0; c < 3; c++) {
        const e = encodeChannel(img.data[s + c], exposure, invGamma);
        raw[rowStart + 1 + x * 3 + c] = Math.round(clamp(e, 0, 1) * 255);
      }
    }
  }
  return assemble(img.width, img.height, 8, raw);
}

/** Encode a linear float image to 16-bit RGB PNG bytes (big-endian, per spec). */
export function encodePng16(img: RgbImage, options: EncodeOptions = {}): Buffer {
  const exposure = options.exposure ?? 1;
  const invGamma = 1 / (options.displayGamma ?? 2.2);
  const stride = img.width * 6 + 1;
  const raw = new Uint8Array(stride * img.height);
  for (let y = 0; y < img.height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < img.width; x++) {
      const s = 3 * (y * img.width + x);
      for (let c = 0; c < 3; c++) {
        const e = encodeChannel(img.data[s + c], exposure, invGamma);
        const v = Math.round(clamp(e, 0, 1) * 65535);
        const o = rowStart + 1 + (x * 3 + c) * 2;
        raw[o] = (v >> 8) & 0xff;
        raw[o + 1] = v & 0xff;
      }
    }
  }
  return assemble(img.width, img.height, 16, raw);
}

/**
 * Colormaps for the field maps.
 *
 * Perceptually uniform, because a field map is read by eye and a rainbow
 * colormap invents boundaries where the data has none — which for a coverage or
 * incidence map means inventing exactly the kind of structure the map exists to
 * rule out. PARAMETERS.md §4.2's whole point is that a previous reading saw
 * 3- and 4-way overlap that was not there.
 *
 * Two maps, for two kinds of quantity:
 *   - `viridis`  — sequential, for magnitudes with a natural zero (coverage,
 *                  incidence cosine, blend weight).
 *   - `diverging` — blue/white/red about a midpoint, for signed quantities
 *                  (registration error components, luminance difference).
 *
 * The viridis anchors are the published control points of the matplotlib
 * colormap, sampled at 9 stops and linearly interpolated in between. That is not
 * bit-exact against matplotlib's 256-entry table, and does not need to be: the
 * property that matters is monotone lightness, which the anchors preserve.
 */
const VIRIDIS_ANCHORS: readonly ChannelTriplet[] = [
  { r: 0.267, g: 0.005, b: 0.329 },
  { r: 0.283, g: 0.141, b: 0.458 },
  { r: 0.254, g: 0.265, b: 0.53 },
  { r: 0.207, g: 0.372, b: 0.553 },
  { r: 0.164, g: 0.471, b: 0.558 },
  { r: 0.128, g: 0.567, b: 0.551 },
  { r: 0.135, g: 0.659, b: 0.518 },
  { r: 0.267, g: 0.749, b: 0.441 },
  { r: 0.478, g: 0.821, b: 0.318 },
  { r: 0.741, g: 0.873, b: 0.15 },
  { r: 0.993, g: 0.906, b: 0.144 },
];

const DIVERGING_ANCHORS: readonly ChannelTriplet[] = [
  { r: 0.23, g: 0.299, b: 0.754 },
  { r: 0.55, g: 0.62, b: 0.9 },
  { r: 0.86, g: 0.86, b: 0.86 },
  { r: 0.93, g: 0.6, b: 0.5 },
  { r: 0.706, g: 0.016, b: 0.15 },
];

function rampLookup(anchors: readonly ChannelTriplet[], t: number): ChannelTriplet {
  const x = clamp(t, 0, 1) * (anchors.length - 1);
  const i = Math.min(anchors.length - 2, Math.floor(x));
  const f = x - i;
  const a = anchors[i];
  const b = anchors[i + 1];
  return {
    r: a.r + (b.r - a.r) * f,
    g: a.g + (b.g - a.g) * f,
    b: a.b + (b.b - a.b) * f,
  };
}

/** Sequential colormap. `t` in [0, 1]. Returns DISPLAY-referred RGB. */
export function viridis(t: number): ChannelTriplet {
  return rampLookup(VIRIDIS_ANCHORS, t);
}

/** Diverging colormap. `t` in [0, 1] with 0.5 as the neutral midpoint. */
export function diverging(t: number): ChannelTriplet {
  return rampLookup(DIVERGING_ANCHORS, t);
}

export type Colormap = (t: number) => ChannelTriplet;

/**
 * Turn a scalar field into an image ready for {@link encodePng8}.
 *
 * The colormap returns display-referred values, so they are un-encoded back into
 * linear here. Without that step the PNG encoder's gamma would be applied on top
 * of a colormap that is already perceptually spaced, and the carefully uniform
 * lightness ramp would come out crushed at the dark end — which is where a
 * coverage map puts its unlit region.
 */
export function colorizeField(
  field: Float32Array,
  width: number,
  height: number,
  lo: number,
  hi: number,
  map: Colormap = viridis,
  displayGamma = 2.2,
): RgbImage {
  const data = new Float32Array(width * height * 3);
  const span = hi - lo;
  for (let i = 0; i < width * height; i++) {
    const t = span === 0 ? 0 : (field[i] - lo) / span;
    const c = map(t);
    data[3 * i] = Math.pow(clamp(c.r, 0, 1), displayGamma);
    data[3 * i + 1] = Math.pow(clamp(c.g, 0, 1), displayGamma);
    data[3 * i + 2] = Math.pow(clamp(c.b, 0, 1), displayGamma);
  }
  return { width, height, data };
}
