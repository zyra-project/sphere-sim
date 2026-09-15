// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Real photographs into the linear light the decoder works in.
 *
 * Phase 3 of `docs/OPERATOR-PATH.md`, first half. Every image the bundle
 * adjustment has ever been given was rendered by this project, in linear
 * radiance, with no sensor in the way. A camera file is none of those things: it
 * is integers, encoded through a transfer curve, clipped at both ends, and
 * carrying noise the renderer never had.
 *
 * ## The transfer is stated, never assumed
 *
 * `decode.ts` works in linear light for a reason it gives itself — a
 * gamma-encoded sinusoid biases the phase estimate — so something has to undo
 * the camera's encoding, and that something has to be TOLD which encoding. There
 * is no default here and {@link linearise} refuses without one.
 *
 * That refusal is the point rather than an inconvenience. A JPEG out of a
 * consumer camera is sRGB; a 16-bit TIFF from the same camera may be linear; a
 * file that has been through an editor may be neither. Guessing sRGB would be
 * right often enough to look fine and wrong often enough to poison a
 * calibration, and the failure would appear as a phase bias nobody could trace
 * back to a file format.
 *
 * ## What clipping costs, and why it is counted rather than judged
 *
 * The decoder reads a bit as the SIGN of the difference between a Gray plane and
 * its complement. Where both frames are clipped to the sensor's ceiling that
 * difference is zero and the bit is noise — and the white reference, which sets
 * the modulation every later frame is read against, is the frame most likely to
 * clip because it is the brightest thing in the capture.
 *
 * So this counts clipped pixels and reports the fraction. It does NOT decide
 * what fraction is too much, because nobody here has measured that on a real
 * sphere and a threshold invented now would be a number the whole pipeline then
 * rested on. The one case it does refuse is the one that is broken by
 * arithmetic rather than by degree: a reference frame with no range left at all.
 */

import type { LinearImage } from './decode.ts';

/**
 * How a file's integers relate to the light that fell on the sensor.
 *
 * Named rather than parameterised by a single exponent because sRGB is not a
 * pure power law — its toe is linear below 0.04045, and treating it as
 * `v^2.2` misplaces exactly the dark end where the black reference lives.
 */
export type Transfer =
  | { kind: 'srgb' }
  | { kind: 'gamma'; exponent: number }
  | { kind: 'linear' };

/** Undo one transfer. Input and output both normalised to [0, 1]. */
export function decodeTransfer(v: number, transfer: Transfer): number {
  if (transfer.kind === 'linear') return v;
  if (transfer.kind === 'gamma') return Math.pow(Math.max(0, v), transfer.exponent);
  // IEC 61966-2-1. The toe matters here more than anywhere else in the project:
  // a black reference sits in it, and a pure power law puts that frame at a
  // different level than the camera did.
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** One photograph as it arrived, before anything has been undone. */
export interface EncodedImage {
  width: number;
  height: number;
  /**
   * Interleaved samples: 1 (grey), 2 (grey + alpha), 3 (RGB) or 4 (RGBA).
   *
   * Colour survives {@link linearise}. Alpha does not — it is not light, and
   * putting it through a transfer curve would make it look like light.
   */
  channels: number;
  /** Integer samples as the file stores them. */
  data: Uint8Array | Uint16Array;
  /** The largest value `data` can hold: 255 for 8-bit, 65535 for 16-bit. */
  maxValue: number;
}

/** What the ingest found in one photograph, beyond its pixels. */
export interface IngestReport {
  /** Fraction of pixels sitting at the sensor's ceiling. */
  clippedHigh: number;
  /** Fraction sitting at its floor. */
  clippedLow: number;
  /** Mean linear value, after the transfer. */
  mean: number;
  /** Darkest and brightest linear value. */
  lo: number;
  hi: number;
}

export interface IngestResult {
  image: LinearImage;
  report: IngestReport;
}

/**
 * One photograph into linear light.
 *
 * `transfer` has no default and the type makes omitting it a compile error,
 * which is deliberate: see the module docblock. A caller who genuinely does not
 * know what its files are encoded with does not have a capture yet, it has a
 * folder of pictures.
 */
export function linearise(encoded: EncodedImage, transfer: Transfer): IngestResult {
  const n = encoded.width * encoded.height;
  const stride = encoded.channels;
  const max = encoded.maxValue;
  if (!(max > 0)) throw new Error(`ingest: maxValue must be positive, got ${max}`);
  if (!Number.isInteger(stride) || stride < 1 || stride > 4) {
    throw new Error(`ingest: ${stride} channels is not an image this can read`);
  }
  /**
   * Colour is kept, because throwing it away here would quietly override the
   * decoder's own default.
   *
   * `decode.ts` reads Rec.709 luminance unless a caller asks for one channel,
   * and its docblock gives two reasons: luminance is the highest-SNR
   * combination of a three-channel capture, and PARAMETERS.md §3.2 warns the
   * channels diverge in gamma, gain and black floor. Handing it a one-channel
   * image made that choice for it — every photograph silently became its red
   * plane, which is both the noisiest channel of a Bayer sensor and the one
   * most likely to be the odd one out. Selecting a channel is still available;
   * it is just no longer decided here, by accident, for everyone.
   *
   * Alpha is dropped rather than carried: it is coverage, not light, and a
   * transfer curve applied to it produces a number that looks like light.
   */
  const keep = stride >= 3 ? 3 : 1;
  const out = new Float32Array(n * keep);
  let clippedHigh = 0;
  let clippedLow = 0;
  let sum = 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const src = i * stride;
    const dst = i * keep;
    // A pixel counts as clipped when ANY channel it keeps is at a rail: the
    // decoder forms one number out of the three, so one railed channel is
    // enough to make that number the sensor's limit rather than the scene's.
    let high = false;
    let low = false;
    for (let c = 0; c < keep; c++) {
      const raw = encoded.data[src + c];
      if (raw >= max) high = true;
      if (raw <= 0) low = true;
      const v = decodeTransfer(raw / max, transfer);
      out[dst + c] = v;
      sum += v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (high) clippedHigh++;
    if (low) clippedLow++;
  }
  return {
    image: { width: encoded.width, height: encoded.height, channels: keep, data: out },
    report: {
      clippedHigh: n === 0 ? 0 : clippedHigh / n,
      clippedLow: n === 0 ? 0 : clippedLow / n,
      mean: n === 0 ? 0 : sum / (n * keep),
      lo: n === 0 ? 0 : lo,
      hi: n === 0 ? 0 : hi,
    },
  };
}

/**
 * Whether a pair of reference frames leaves the decoder anything to work with.
 *
 * The one thing here that is a refusal rather than a measurement, because it is
 * broken by arithmetic and not by degree: `decode.ts` reads every later frame as
 * a fraction of `white - black`, so if that difference is zero the modulation is
 * zero and nothing downstream means anything. A capture where the white frame
 * clipped flat and the black frame did too has no range at all, and reporting a
 * pose from it would be the empty-capture failure the page's own guard exists to
 * prevent, one layer further upstream.
 *
 * Everything else — a white frame 3% clipped, a black frame lifted by a bright
 * room — is reported as a number and left to the caller, because what those cost
 * on real photographs is unmeasured and a threshold invented here would become
 * the thing the pipeline rested on.
 */
export function referenceRange(white: IngestReport, black: IngestReport): {
  range: number;
  usable: boolean;
  problem: string | null;
} {
  const range = white.mean - black.mean;
  if (!(range > 0)) {
    return {
      range,
      usable: false,
      problem:
        `The white reference is not brighter than the black one — their mean linear values are ` +
        `${white.mean.toFixed(4)} and ${black.mean.toFixed(4)}. Every later frame is read as a ` +
        `fraction of that difference, so there is nothing to read them against. Either the two ` +
        `frames are the wrong way round, or the projector was not on, or the exposure clipped ` +
        `both flat (${(100 * white.clippedHigh).toFixed(1)}% of the white frame is at the ` +
        `sensor ceiling).`,
    };
  }
  return { range, usable: true, problem: null };
}
