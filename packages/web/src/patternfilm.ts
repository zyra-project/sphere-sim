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
 * So this module renders the sequence twice over: as the images that go down the
 * projector's cable, which is what the inspect card's first tab already calls
 * "its frame", and — through {@link patternAtlas} — as the table the display
 * shader reads to put the same frames on the ball. A visitor can watch it
 * without running a calibration, which matters: the patterns are how the thing
 * works, and making somebody press Recalibrate and wait to find that out gets it
 * backwards.
 *
 * ## A picture of the sphere, too
 *
 * This section used to explain why it was not one. Putting the pattern ON the
 * ball meant teaching the display shader a new content source, inside the
 * GPU↔CPU parity chain, and that cost was judged to buy drama rather than
 * accuracy. For a presentation or a tutorial the drama is the point — the ball
 * is where people look, and a Gray plane crawling across it and flipping to its
 * complement IS the explanation — so the cost was paid, in a way that keeps the
 * reasons it looked expensive:
 *
 *  - **The pattern is still defined once.** The shader restates no Gray code:
 *    {@link patternAtlas} tabulates `compileFrame` at every pixel centre and the
 *    shader looks the value up, so what lands on the ball is what this module
 *    computes, and `test/patternfilm.test.ts` checks every pixel of every raster
 *    the page offers.
 *  - **It stays inside the parity chain.** `packages/sim`'s `RasterSource` lets
 *    the CPU renderer draw the same frame from the same numbers, so the check
 *    compares two renderers on one picture rather than exempting it.
 *  - **It is still not the camera's photograph.** The bench photographs these
 *    frames in luminance, through a sensor, with an idealised inverse transfer
 *    and an incidence cut-off. The ball on screen is lit through the display's
 *    own physics, like any content: it shows what lands on the sphere, not what
 *    a camera records of it.
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
  type CompiledFrame,
  type FrameSpec,
  type PatternPlan,
} from '../../bench/src/patterns.ts';
import type { RigCalibration } from '../../calibration/src/index.ts';
import type { RasterSource } from '../../sim/src/misregistration.ts';

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

/**
 * A frame's target at one PIXEL CENTRE of its raster: the value the emitter page
 * paints into that pixel, and the one number both of the page's renderers read
 * for it.
 *
 * `index` is clamped into the raster first. The display reconstructs over the
 * four pixel centres around a point, and within half a pixel of the raster's
 * edge one of them is off it, where there is no pixel to emit anything but the
 * edge's own value. `packages/sim`'s `RasterSource` is handed indices already
 * clamped the same way, and the shader's `patternTarget` clamps the same again.
 */
export function pixelCentreTarget(frame: CompiledFrame, res: number, index: number): number {
  if (frame.axis === null) return frame.at(0);
  const i = Math.min(res - 1, Math.max(0, index));
  return frame.at(i + 0.5);
}

/**
 * The frame's value at pixel (`column`, `row`), whichever axis it varies along.
 * What the model worker hands `RasterSource.at`.
 */
export function rasterTarget(
  frame: CompiledFrame,
  resX: number,
  resY: number,
  column: number,
  row: number,
): number {
  if (frame.axis === 'v') return pixelCentreTarget(frame, resY, row);
  return pixelCentreTarget(frame, resX, column);
}

/**
 * Texels in one row of the sequence texture.
 *
 * Not a choice made here: it is `glsl.ts`'s `PACK_WIDTH`, the row width the
 * shader's `packedTexel` divides by, and `test/patternfilm.test.ts` reads it out
 * of the shader source so the two cannot come apart.
 */
export const ATLAS_WIDTH = 1024;

/**
 * The most rows the table may take: WebGL2's guaranteed `MAX_TEXTURE_SIZE`. A
 * device may offer more; the page must run on one that offers exactly this.
 */
export const ATLAS_MAX_ROWS = 2048;

/** Where one frame of the sequence lives in the table. */
export interface AtlasRow {
  /** Texel index of the frame's value at pixel 0 — the shader's `uPatternRow`. */
  offset: number;
  /** 0 for a flat field, 1 when it varies across the raster (u), 2 down it (v). */
  axis: 0 | 1 | 2;
  /** Texels the frame occupies: 1, `resX` or `resY`. */
  length: number;
}

/**
 * Every frame of a plan, tabulated at every pixel centre, for the display shader.
 *
 * `plan`, `resX` and `resY` are what it was built from, kept beside it so a
 * caller can tell a table that fits the rig from one that does not — the shader
 * indexes by pixel, and a table built for another raster would light the right
 * stripes in the wrong places.
 */
export interface PatternAtlas {
  plan: PatternPlan;
  resX: number;
  resY: number;
  /** One per frame of `planFrames(plan)`, in capture order. */
  rows: readonly AtlasRow[];
  /** {@link ATLAS_WIDTH}. */
  width: number;
  height: number;
  /** `width * height` floats, one single-channel texel each. */
  data: Float32Array;
}

/**
 * The whole sequence as one small float texture.
 *
 * ## Why a table rather than a shader function
 *
 * `compileFrame`'s docblock says it plainly: the obvious way to make a pattern
 * fast is to inline the Gray arithmetic into the renderer, and then the
 * repository holds two statements of what a Gray plane is — the one the
 * documentation points at and the one that actually ran. A GLSL Gray code would
 * be that second statement, checkable only at runtime by a parity check that
 * reads blind on half the Gray frames at the page's default view. A table is
 * the definition itself, sampled where a projector samples it, and a Node test
 * can compare every entry against `compileFrame` exactly.
 *
 * One frame varies along one raster axis, so a frame is one row of values —
 * `resX` of them across, `resY` down, a single one for white and black — and the
 * whole default plan at 3840 × 2160 is 96 002 floats, 94 rows of
 * {@link ATLAS_WIDTH}. Values are stored as float32: the Gray planes and the flat
 * fields are 0 and 1 exactly, and a phase step is `compileFrame`'s double rounded
 * once, 3e-8 at worst.
 *
 * Built for every frame at once rather than for the one on screen, so moving to
 * the next frame — or asking the shader to draw an older one for the parity
 * check — is two integers and no upload.
 */
export function patternAtlas(plan: PatternPlan, resX: number, resY: number): PatternAtlas {
  if (!(Number.isInteger(resX) && Number.isInteger(resY) && resX > 0 && resY > 0)) {
    throw new Error(`patternAtlas: ${resX} × ${resY} is not a projector raster`);
  }
  const frames = planFrames(plan).map((spec) => compileFrame(spec, plan, resX, resY));
  const rows: AtlasRow[] = [];
  let total = 0;
  for (const frame of frames) {
    const axis = frame.axis === null ? 0 : frame.axis === 'u' ? 1 : 2;
    const length = axis === 0 ? 1 : axis === 1 ? resX : resY;
    rows.push({ offset: total, axis, length });
    total += length;
  }
  const height = Math.max(1, Math.ceil(total / ATLAS_WIDTH));
  if (height > ATLAS_MAX_ROWS) {
    throw new Error(
      `patternAtlas: ${frames.length} frames at ${resX} × ${resY} need ${height} rows of texture, ` +
        `past the ${ATLAS_MAX_ROWS} every WebGL2 device must support`,
    );
  }
  const data = new Float32Array(ATLAS_WIDTH * height);
  for (let f = 0; f < frames.length; f++) {
    const { offset, axis, length } = rows[f];
    const res = axis === 2 ? resY : resX;
    for (let i = 0; i < length; i++) data[offset + i] = pixelCentreTarget(frames[f], res, i);
  }
  return { plan: { ...plan }, resX, resY, rows, width: ATLAS_WIDTH, height, data };
}

/**
 * The frame the CPU renderer draws for the parity check: `compileFrame` asked at
 * each pixel centre directly, per projector, for the rig the worker built.
 *
 * Not {@link patternAtlas}: the table is a float32 texture for the GPU, and
 * passing it across the worker boundary would be a table to keep in step with a
 * second one. Both are {@link pixelCentreTarget} over the same frame, so the two
 * renderers read the same numbers — exactly for the Gray planes and the flat
 * fields, and to float32's rounding of a phase step, 3e-8 at worst.
 */
export function patternRasterSource(
  plan: PatternPlan,
  frame: number,
  mask: number,
  rig: RigCalibration,
): RasterSource {
  const spec = planFrames(plan)[frame];
  if (spec === undefined) {
    const n = planFrames(plan).length;
    throw new Error(`calibration frame ${frame} is not one of the ${n} this plan has`);
  }
  const frames = rig.projectors.map((p) => ({
    frame: compileFrame(spec, plan, p.intrinsics.resX, p.intrinsics.resY),
    resX: p.intrinsics.resX,
    resY: p.intrinsics.resY,
  }));
  return {
    mask,
    at: (index, column, row) => {
      const f = frames[index];
      return rasterTarget(f.frame, f.resX, f.resY, column, row);
    },
  };
}

/** One step of the sequence as the emitter plays it: whose run, and which frame of it. */
export interface SequenceStep {
  /** 0-based position in the whole sequence, after wrapping. */
  step: number;
  /** Steps in the whole sequence: frames per run × projectors. */
  total: number;
  /** Frames in one projector's run: `planFrames(plan).length`. */
  framesPerRun: number;
  /**
   * The projector whose run this is, as the emitter counts them: 0 to N − 1 in
   * panel order, whether or not its lamp is on. The page's tab name is `P{slot+1}`.
   */
  slot: number;
  /** Index into `planFrames(plan)`. */
  frame: number;
}

/**
 * Step `n` of the emitter's order for `projectors` projectors, wrapping both ways
 * so the sequence loops and stepping back from the first frame lands on the last.
 *
 * Projector-major, frame-minor — `src/emit.ts`'s `emitOrder`, which puts every
 * Gray plane beside its own complement and the rest of the rig outside that
 * pair; `test/patternfilm.test.ts` holds the two to the same order. Computed
 * rather than taken from `emitOrder` because that function refuses a rig above
 * four, which it must — nothing documents a fifth quadrant — and the simulator
 * can be handed a placed rig of up to eight.
 */
export function sequenceStep(n: number, projectors: number, plan: PatternPlan): SequenceStep {
  const framesPerRun = planFrames(plan).length;
  const total = framesPerRun * Math.max(1, Math.round(projectors));
  const step = ((Math.round(n) % total) + total) % total;
  const slot = Math.floor(step / framesPerRun);
  return { step, total, framesPerRun, slot, frame: step % framesPerRun };
}

/**
 * The shader's and the worker's mask for a run on panel slot `slot`, given which
 * slot each rig projector came from.
 *
 * Zero when that slot is switched off at the wall: it is not in the rig, so no
 * lamp that is on is sent this frame — they are all sent black, which is what
 * the emitter's other quadrants are while its run plays to a dark projector.
 */
export function patternMask(slots: readonly number[], slot: number): number {
  const i = slots.indexOf(slot);
  return i < 0 || i >= 31 ? 0 : 1 << i;
}
