// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the projectors emit during a capture, and in what order.
 *
 * Phase 1 of `docs/OPERATOR-PATH.md`: putting the structured-light sequence on a
 * real sphere, from a browser, with nothing installed. This module is the part
 * of that which is arithmetic rather than DOM — which quadrant of the display
 * each projector owns, which (projector, frame) pair is step N, and whether the
 * window the operator opened can carry the pattern at all — so it can be tested
 * in Node while the page around it cannot.
 *
 * ## Why a quadrant at all
 *
 * SOS drives its projectors as regions of ONE framebuffer, which is what makes
 * the no-install premise work: a browser window filling that framebuffer can
 * address every projector without touching the display pipeline. The developer
 * harness already proves the layout — it draws the four projector rasters as
 * quadrants of a single context — and {@link SOS_QUADRANT_VIEWPORTS} is the
 * table it uses.
 *
 * This is emphatically NOT the sphere-content path. Content is indexed by
 * position on the sphere; a structured-light frame is a function of the
 * projector's own raster coordinate, so it has to address the raster directly.
 * That distinction is the same one that stopped the patterns being a content
 * chip on the simulator page.
 *
 * ## Why it refuses rather than guessing
 *
 * PARAMETERS.md §2 supports 2- and 3-projector installs by letting quadrants go
 * dark, and `NOMINAL_SLOTS_BY_COUNT` records WHICH ones (A-06 settled N=2,
 * A-19 settled N=3). Above four there is no such convention: the simulator's
 * shader carries eight projectors, but nothing says where a fifth one's pixels
 * live in a framebuffer, because that is a property of a display pipeline nobody
 * here has seen.
 *
 * So {@link quadrantViewports} refuses above four instead of inventing a layout.
 * A tool that guessed would light the wrong projector and photograph it under
 * another one's name, and the resulting calibration would be confidently wrong
 * rather than obviously broken — which is the failure mode this project treats
 * as worse than stopping.
 *
 * ## The one place the pattern is allowed to be quantized
 *
 * `targetRadiance`'s docblock is explicit that the bench evaluates a pattern at
 * the continuous coordinate a camera pixel sees, and deliberately does not
 * quantize it to projector pixel centres, because the bench has no model of the
 * projector's pixel footprint (PARAMETERS.md §9 lists screen-door structure as
 * unmodelled) and a staircase without a footprint to blur it would be an
 * artifact no projector puts on a sphere.
 *
 * A real projector is the case that inverts that argument. Its raster IS a pixel
 * grid and it supplies its own footprint, so here the pattern must be sampled
 * once per emitted pixel — and it has to be sampled on the projector's grid
 * rather than on some scaled copy of it, which is what {@link rasterFit} is for.
 */

import { NOMINAL_SLOTS_BY_COUNT } from '../../calibration/src/conventions.ts';
import type { Viewport } from '../../calibration/src/index.ts';
import { SOS_QUADRANT_VIEWPORTS } from '../../sim/src/scene.ts';
import { planFrames, strideFor, type PatternPlan } from '../../bench/src/patterns.ts';

/** The most projectors this page can place, because §2's layout stops here. */
export const MAX_PLACEABLE_PROJECTORS = SOS_QUADRANT_VIEWPORTS.length;

/**
 * Which framebuffer quadrant each projector of an N-projector rig occupies.
 *
 * Indexed by the rig's own projector order and returning the SLOT, which is not
 * the same number: projector 1 of a two-projector install occupies slot 2,
 * because §2 darkens quadrants rather than respacing the projectors that remain.
 * `nominalRig` assigns `SOS_QUADRANT_VIEWPORTS[slot]` from the same table, so a
 * projector's quadrant here and its azimuth there come from one decision.
 *
 * The slot is also the projector's NAME. `nominalRig` ids projectors `P${slot+1}`,
 * so a two-projector rig is P1 and P3 — not P1 and P2 — and an operator writing
 * "P3" on a photograph is naming the same projector their config does.
 *
 * Throws above four, and the message says what would be needed rather than only
 * what is wrong: an operator reading it should learn that the missing thing is
 * their display's own layout, not a limit of the sequence.
 */
export function projectorSlots(count: number): readonly number[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`emit: ${count} projectors is not a whole number of projectors`);
  }
  if (count > MAX_PLACEABLE_PROJECTORS) {
    throw new Error(
      `emit: ${count} projectors cannot be placed. PARAMETERS.md §2 lays out at most ` +
        `${MAX_PLACEABLE_PROJECTORS} as quadrants of one framebuffer, and nothing documents where ` +
        `a fifth raster lives — that is a property of the display pipeline. The simulator's shader ` +
        `carries eight because it never has to address a real output. Supply the framebuffer ` +
        `layout and this can place them; guessing would light one projector under another's name.`,
    );
  }
  const slots = NOMINAL_SLOTS_BY_COUNT[count];
  if (slots === undefined) {
    throw new Error(`emit: no documented quadrant assignment for ${count} projectors`);
  }
  return slots;
}

/** Where each projector's raster sits in the framebuffer, as fractions. */
export function quadrantViewports(count: number): readonly Viewport[] {
  return projectorSlots(count).map((slot) => SOS_QUADRANT_VIEWPORTS[slot]);
}

/**
 * The quadrant in words, for a label an operator can act on.
 *
 * Said as the operator SEES it — "bottom-left" is the bottom-left of the picture
 * on the wall — which is why this reads the viewport rather than the slot index.
 * The config's own order is bottom-left, bottom-right, top-left, top-right, so
 * slot 2 is the TOP-left; a label derived from the index would say "third".
 */
export function quadrantName(v: Viewport): string {
  const vertical = v.y + v.h / 2 < 0.5 ? 'bottom' : 'top';
  const horizontal = v.x + v.w / 2 < 0.5 ? 'left' : 'right';
  return `${vertical}-${horizontal}`;
}

/** One step of the capture: this frame, on this projector, and nothing else lit. */
export interface EmitStep {
  /** The rig's own projector index, 0-based. */
  projector: number;
  /** Index into `planFrames(plan)`. */
  frame: number;
  /** 1-based position in the whole sequence, for the operator's counter. */
  ordinal: number;
}

/**
 * Every step of a capture, in the order a camera should see them.
 *
 * Grouped by projector rather than interleaved by frame, and that is not
 * cosmetic. The decoder reads a bit as the sign of the difference between a Gray
 * plane and its own complement, and `planFrames` puts those two ADJACENT
 * precisely so the interval over which that cancellation has to hold is as short
 * as possible. Interleaving projectors would put a whole rig between a pattern
 * and its complement and undo that on purpose.
 *
 * One projector is lit at a time because the patterns address each projector's
 * own raster: two lit at once put two different codes on the same patch of
 * sphere, and neither decodes.
 */
export function emitOrder(count: number, plan: PatternPlan): EmitStep[] {
  // Placement is validated here rather than at paint time, so a rig that cannot
  // be laid out fails before an operator has set up a tripod.
  projectorSlots(count);
  const frames = planFrames(plan).length;
  const out: EmitStep[] = [];
  for (let projector = 0; projector < count; projector++) {
    for (let frame = 0; frame < frames; frame++) {
      out.push({ projector, frame, ordinal: out.length + 1 });
    }
  }
  return out;
}

/** A rectangle of the canvas, in device pixels, origin top-left. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The viewport in canvas device pixels — and the flip, which is the whole point.
 *
 * `Viewport` is normalized to the framebuffer with its ORIGIN AT BOTTOM-LEFT
 * (conventions.ts §V), matching the SOS config's own `projectorInfo(viewport)`
 * values. A 2-D canvas has its origin at the TOP-left. So slot 0 — the quadrant
 * `{0, 0, 0.5, 0.5}`, which §3.4 calls the bottom-left and which is P1, the
 * projector nearest the SOS computer — is the LOWER half of the canvas, and a
 * function that passed `v.y` straight through would put it in the upper half.
 *
 * That failure is silent and it is the expensive one: the pattern still looks
 * right, the operator still photographs it, and every frame is filed under the
 * wrong projector. It is worth stating rather than only testing, because the
 * harness does the same flip for the opposite reason — GL's viewport origin is
 * bottom-left too, so there the two conventions agree and no flip appears.
 *
 * Edges are rounded so adjacent quadrants MEET: the top edge of a bottom
 * quadrant and the bottom edge of the top one are the same rounded expression,
 * so an odd framebuffer height cannot leave a one-pixel unlit band across the
 * middle or overlap two rasters by one. A row of a projector's raster that
 * nothing emits is a band of the sphere nothing addresses.
 */
export function viewportPixels(v: Viewport, width: number, height: number): PixelRect {
  const x0 = Math.round(v.x * width);
  const x1 = Math.round((v.x + v.w) * width);
  // 1 - (y + h) is the viewport's top edge measured down from the top.
  const y0 = Math.round((1 - (v.y + v.h)) * height);
  const y1 = Math.round((1 - v.y) * height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Whether the window the operator opened can actually carry the pattern.
 *
 * The quadrant a browser hands this page is whatever the window happens to be,
 * and the projector's raster is whatever the rig says. When those agree, every
 * emitted pixel is one projector pixel and the Gray edges land exactly where the
 * pattern says they do. When they do not, the browser resamples, and the
 * calibration measures the resampling along with the optics.
 *
 * `scale` is the number to read: 1 is exact, 0.5 means the window is half the
 * framebuffer the rig implies — the usual cause being a window that is not
 * full-screen, or a display scaling factor the operator does not know is on.
 */
export interface RasterFit {
  /** Canvas pixels per projector pixel, across and down. 1 is exact. */
  scaleX: number;
  scaleY: number;
  /** True when this quadrant is exactly one projector raster. */
  exact: boolean;
  /** The finest Gray stride on whichever grid carries it worst. */
  finestStridePx: number;
  /** Which grid that was — the one to change. */
  binding: 'window' | 'raster';
  /** True when the pattern cannot be represented on that grid at all. */
  fatal: boolean;
  /** null when exact; otherwise what is wrong, with the numbers. */
  problem: string | null;
}

/**
 * The floor on the finest Gray stride, in pixels of the narrowest grid.
 *
 * Set by the FRINGE rather than by the planes. `phasePeriodStrides` is 2, so one
 * sinusoid period is two Gray strides; at a stride of 2 pixels a period is 4,
 * which is the coarsest sampling at which a cosine is still a cosine rather than
 * a triangle. The Gray planes themselves survive a stride of 1 — a one-pixel
 * strip still has edges — so a threshold derived from them would pass a rig that
 * emits a usable address and an unusable fringe, and the phase estimate is the
 * half that supplies sub-strip position.
 */
export const MIN_STRIDE_PX = 2;

/**
 * Both grids are checked, and the narrower one binds.
 *
 * Review caught this: the first version measured the CANVAS only, so a 100-pixel
 * projector shown in a 128-pixel quadrant passed on a canvas stride of 2 while
 * its native stride was 1.56 — and the display pipeline resamples the window
 * down onto that raster on its way out, so the projector emits the undersampled
 * signal this check exists to refuse. The pattern has to survive every grid it
 * passes through, and the page lets an operator name both.
 */
export function rasterFit(
  quad: { w: number; h: number },
  resX: number,
  resY: number,
  plan: PatternPlan,
): RasterFit {
  const scaleX = quad.w / resX;
  const scaleY = quad.h / resY;
  const exact = quad.w === resX && quad.h === resY;
  // On each grid the stride is that grid's extent / 2^bits, because the quadrant
  // IS the whole raster however it is scaled. The binding axis is the shorter.
  const window = Math.min(strideFor(quad.w, plan.grayBits), strideFor(quad.h, plan.grayBits));
  const raster = Math.min(strideFor(resX, plan.grayBits), strideFor(resY, plan.grayBits));
  const finestStridePx = Math.min(window, raster);
  const binding: 'window' | 'raster' = raster <= window ? 'raster' : 'window';
  const fatal = finestStridePx < MIN_STRIDE_PX;

  let problem: string | null = null;
  if (fatal) {
    const where =
      binding === 'raster'
        ? `the ${resX}×${resY} raster you named`
        : `this ${quad.w}×${quad.h} window`;
    problem =
      `The finest Gray strip is ${finestStridePx.toFixed(2)} pixels wide on ${where}, under the ` +
      `${MIN_STRIDE_PX} this needs. One fringe period is two strips, so the phase steps would be ` +
      `sampled below four pixels a cycle and would not be sinusoids by the time they left the ` +
      `machine. ` +
      (binding === 'raster'
        ? `A larger window cannot fix this — the display resamples down onto that raster on the ` +
          `way out. Drop to ${Math.max(1, plan.grayBits - 1)} Gray planes`
        : `Open a larger window, or drop to ${Math.max(1, plan.grayBits - 1)} Gray planes`) +
      ` and record that you did — the decode has to be told the same plan the capture used.`;
  } else if (!exact) {
    problem =
      `This quadrant is ${quad.w}×${quad.h} canvas pixels but the rig says the raster is ` +
      `${resX}×${resY} — ${scaleX.toFixed(3)}× across and ${scaleY.toFixed(3)}× down. The browser ` +
      `will resample every frame, so the Gray edges land off the projector's own pixel grid and ` +
      `the calibration measures that displacement along with the optics. Full-screen on the ` +
      `framebuffer that drives the projectors is what makes this 1.000.`;
  }
  return { scaleX, scaleY, exact, finestStridePx, binding, fatal, problem };
}

/** The fit of every projector in a rig, and the one worth showing. */
export interface RigFit {
  /** One entry per projector, in the rig's own order. */
  perProjector: RasterFit[];
  /** The entry the page should report: fatal first, then merely inexact. */
  worst: RasterFit;
  /** Which projector {@link worst} belongs to, 0-based. */
  worstProjector: number;
  /** True when every quadrant is exactly one raster. */
  allExact: boolean;
  /** True when any quadrant cannot carry the pattern. */
  anyFatal: boolean;
}

/**
 * Every projector's fit, not just the first one's.
 *
 * Review caught this too, and it is the same odd-framebuffer arithmetic the
 * tiling test already covers from the other side: `viewportPixels` rounds, so on
 * a framebuffer 1281 pixels wide the left quadrants come out 641 and the right
 * ones 640. Reporting only projector 0 could therefore say "exactly one raster"
 * while the projector beside it was being resampled — a verdict that is true of
 * the quadrant it measured and false of the rig.
 */
export function rigFit(
  count: number,
  framebufferW: number,
  framebufferH: number,
  resX: number,
  resY: number,
  plan: PatternPlan,
): RigFit {
  const perProjector = quadrantViewports(count).map((v) =>
    rasterFit(viewportPixels(v, framebufferW, framebufferH), resX, resY, plan),
  );
  let worstProjector = 0;
  for (let i = 1; i < perProjector.length; i++) {
    const a = perProjector[worstProjector];
    const b = perProjector[i];
    if ((b.fatal && !a.fatal) || (b.fatal === a.fatal && !b.exact && a.exact)) worstProjector = i;
  }
  return {
    perProjector,
    worst: perProjector[worstProjector],
    worstProjector,
    allExact: perProjector.every((f) => f.exact),
    anyFatal: perProjector.some((f) => f.fatal),
  };
}
