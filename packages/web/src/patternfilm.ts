// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The structured-light sequence, as something a person can look at.
 *
 * ## Why this exists
 *
 * A calibration on this page renders 408 frames — `planFrames` × cameras ×
 * projectors — decodes them, and keeps none. `pipeline.ts` says why, and its
 * reason is sound as far as it goes:
 *
 * > No frames kept from the capture itself: a single structured-light frame is
 * > a crescent of one projector's light on one side of the ball and tells a
 * > reader nothing about where anybody stood.
 *
 * That is an argument against a STILL, and it was read as an argument against
 * showing the patterns at all. One Gray plane is a meaningless stripe. Twelve of
 * them in order, each followed by its own complement, are the whole idea: you
 * watch a binary search halve the raster six times, see why every plane is
 * paired with its inverse, and then watch four phase steps slide a fringe across
 * what the search narrowed to. The sequence explains itself; the frame cannot.
 *
 * So this module renders the sequence — not as a picture of the ball, but as the
 * images that go down the projector's cable, which is what the inspect card's
 * first tab already calls "its frame". A visitor can watch it without running a
 * calibration, which matters: the patterns are how the thing works, and making
 * somebody press Recalibrate and wait to find that out gets it backwards.
 *
 * ## Why it is not a picture of the sphere
 *
 * That would be the more striking image, and it is deliberately not what this
 * does. Emitted radiance at a raster coordinate is a pure function — the same
 * `compileFrame` the bench photographs through — so this module is exact by
 * construction and testable in Node. Putting the pattern ON the ball means
 * either re-running a capture (a ray cast per pixel per frame) or teaching the
 * display shader a new content source, and that shader sits inside the GPU↔CPU
 * parity chain. Neither cost buys accuracy; both buy drama. This is the honest
 * half, and it is the half that is cheap and provable.
 *
 * ## Linear in, encoded out, and why they are two functions
 *
 * {@link sampleFrame} returns TARGET LINEAR RADIANCE, which is what the pattern
 * definition in `solver/src/decode.ts` is normative about and what the physics
 * claims are true of: a Gray plane and its complement sum to exactly 1 at every
 * coordinate, and that identity is the reason the decode survives unmeasured
 * albedo and ambient. {@link encodeToRgba} then applies the display transfer so
 * it can be looked at — and that step BREAKS the identity, because encoding is
 * not linear. Keeping them apart is what lets a test assert the physics on the
 * numbers the physics is about, rather than on pixels that have been through a
 * gamma curve.
 */

import {
  compileFrame,
  planFrames,
  strideFor,
  type FrameSpec,
  type PatternPlan,
} from '../../bench/src/patterns.ts';

/**
 * What one frame is and why the sequence contains it.
 *
 * `why` is the part worth writing carefully. A caption that reads "Gray plane 3"
 * names the frame without explaining anything; the reason each frame is there is
 * the entire content of the view.
 */
export interface PatternFrameNote {
  /** Index into `planFrames(plan)`, which is also the capture order. */
  index: number;
  /** Short name for the frame. */
  label: string;
  /** What this frame is for. */
  why: string;
  /** The coordinate it varies along, or null for a flat field. */
  axis: 'u' | 'v' | null;
}

/** 'u' runs across the raster, 'v' down it. Said in words, for captions. */
function axisWord(axis: 'u' | 'v'): string {
  return axis === 'u' ? 'across' : 'down';
}

/**
 * Every frame in capture order, captioned.
 *
 * The order is `planFrames`' order and is not re-derived here: that function's
 * docblock explains why each Gray plane is adjacent to its own complement
 * (it minimises the interval over which the cancellation has to hold under
 * motion), and a second list that happened to agree today would be a second
 * place for that decision to live.
 */
export function describeSequence(plan: PatternPlan): PatternFrameNote[] {
  const specs = planFrames(plan);
  return specs.map((spec, index) => ({ index, axis: spec.axis, ...caption(spec, plan) }));
}

function caption(spec: FrameSpec, plan: PatternPlan): { label: string; why: string } {
  const bits = plan.grayBits;
  switch (spec.kind) {
    case 'white':
      return {
        label: 'All white',
        why:
          'The bright reference. Together with the black frame it bounds what this projector can ' +
          'put on this patch of sphere, so every later frame is read as a fraction of a range ' +
          'measured here rather than as an absolute brightness nobody knows.',
      };
    case 'black':
      return {
        label: 'All black',
        why:
          'The dark reference: what the camera sees from the room alone, with this projector ' +
          'giving nothing. Room light is unmeasured — PARAMETERS.md §5 puts it anywhere from 1% ' +
          'to 15% — so it is measured here instead of assumed.',
      };
    case 'gray':
      return {
        label: `Gray plane ${spec.index + 1} of ${bits}${spec.axis === null ? '' : `, ${axisWord(spec.axis)}`}`,
        why:
          `Bit ${bits - spec.index} of the projector's own coordinate, most significant first. ` +
          `Each plane halves the raster again, so ${bits} of them address ` +
          `${Math.pow(2, bits)} strips — a binary search the camera watches happen. Gray code ` +
          'rather than plain binary because adjacent strips then differ in exactly one bit, so a ' +
          'misread at a boundary is off by one strip and never by half the raster.',
      };
    case 'grayInverse':
      return {
        label: `Gray plane ${spec.index + 1} inverted${spec.axis === null ? '' : `, ${axisWord(spec.axis)}`}`,
        why:
          'The same plane with black and white exchanged, shot immediately after it. The decoder ' +
          'does not threshold either frame — it reads the bit as the SIGN of the difference ' +
          'between the two. Surface paint, room light and the cosine falloff scale both frames ' +
          'identically and cancel in that subtraction; only the sign survives, and the sign is ' +
          'the bit. This is why the method works on a real sphere nobody has photometrically ' +
          'characterised.',
      };
    default:
      return {
        label: `Phase step ${spec.index + 1} of ${plan.phaseSteps}${spec.axis === null ? '' : `, ${axisWord(spec.axis)}`}`,
        why:
          `A sinusoid, shifted ${spec.index}/${plan.phaseSteps} of a period from the first step. ` +
          'The Gray planes ' +
          'narrow the answer to one strip; these place the camera pixel WITHIN that strip to a ' +
          'fraction of it. Phase alone would be ambiguous between strips, and the planes alone ' +
          'would be quantised to strip width — each supplies exactly what the other lacks.',
      };
  }
}

/**
 * One frame as target linear radiance, resampled to an `outW × outH` preview.
 *
 * Supersampled along the varying axis rather than point-sampled. At the plans
 * this page uses the finest Gray stride is many preview pixels wide — that is
 * `grayBitsForCamera`'s whole job — so this changes nothing today. It is here
 * because point sampling a square wave is the kind of thing that looks correct
 * until somebody raises `grayBits`, and then draws a moiré that is an artifact
 * of the preview rather than anything the projector emits.
 *
 * A flat field ignores the coordinate, exactly as `compileFrame` specifies.
 */
export function sampleFrame(
  spec: FrameSpec,
  plan: PatternPlan,
  resX: number,
  resY: number,
  outW: number,
  outH: number,
  samples = 4,
): Float32Array {
  const frame = compileFrame(spec, plan, resX, resY);
  const out = new Float32Array(outW * outH);
  if (frame.axis === null) {
    out.fill(frame.at(0));
    return out;
  }
  // Only the varying axis needs resolving, so the other one is walked once and
  // the row (or column) is copied. A full 2-D supersample would do the same
  // arithmetic outW or outH times over for an identical answer.
  const alongX = frame.axis === 'u';
  const n = alongX ? outW : outH;
  const res = alongX ? resX : resY;
  const line = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let s = 0; s < samples; s++) {
      // The centre of the s-th sub-interval of this preview pixel, mapped into
      // the projector's raster. decode.ts evaluates at pixel centres; this is
      // the same convention taken to sub-pixels.
      acc += frame.at((((i + (s + 0.5) / samples) * res) / n));
    }
    line[i] = acc / samples;
  }
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      out[y * outW + x] = alongX ? line[x] : line[y];
    }
  }
  return out;
}

/**
 * Linear radiance to 8-bit RGBA, ready for `putImageData`.
 *
 * `displayGamma` defaults to 2.2, which is what `png.ts` encodes bench artifacts
 * with and what the page's own read-backs use, so a pattern frame and a rendered
 * room are graded the same way rather than being two differently-lit pictures of
 * one rig.
 */
export function encodeToRgba(
  linear: Float32Array,
  displayGamma = 2.2,
  // Pinned to `ArrayBuffer` rather than left as the default `ArrayBufferLike`:
  // `ImageData` refuses a view that might be over a `SharedArrayBuffer`, and the
  // widened type is what a bare `Uint8ClampedArray` annotation means.
): Uint8ClampedArray<ArrayBuffer> {
  const inv = 1 / displayGamma;
  const out = new Uint8ClampedArray(linear.length * 4);
  for (let i = 0; i < linear.length; i++) {
    const v = linear[i];
    const e = v <= 0 ? 0 : Math.pow(v, inv);
    const byte = Math.round(Math.min(1, e) * 255);
    out[4 * i] = byte;
    out[4 * i + 1] = byte;
    out[4 * i + 2] = byte;
    out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * How wide one addressed strip is, in projector pixels, for the finest plane.
 *
 * Surfaced because it is the number that decides whether the sequence can be
 * decoded at all: the camera has to resolve a strip, and `grayBitsForCamera`
 * picks the bit count from exactly this. A caption that says "64 strips" without
 * saying how wide one is leaves out the part that couples to the camera.
 */
export function strideInfo(plan: PatternPlan, resX: number, resY: number): {
  strips: number;
  strideXPx: number;
  strideYPx: number;
} {
  return {
    strips: Math.pow(2, plan.grayBits),
    strideXPx: strideFor(resX, plan.grayBits),
    strideYPx: strideFor(resY, plan.grayBits),
  };
}
