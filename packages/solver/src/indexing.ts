// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Which photograph is which frame — the question nothing in this project could
 * answer.
 *
 * Phase 2 of `docs/OPERATOR-PATH.md`, and the phase the plan calls the crux:
 * if software can work out which pattern a photograph shows, tethering leaves
 * the critical path and an operator shoots however they like and drops the files
 * in. If it cannot, every operator needs a camera SDK working on their own
 * machine, and most will stop there.
 *
 * Phase 1's emitter counts its own steps. Nothing connects that count to the
 * files on a camera card, so today the shooting ORDER is the only record of what
 * a photograph shows — which is why `docs/CALIBRATE.md` has to tell an operator
 * never to patch a run and never to delete a photograph. This module is what
 * makes those rules softer, and it is deliberately not what makes them disappear.
 *
 * ## What it is allowed to look at
 *
 * Image statistics, and nothing else. Indexing runs BEFORE the solve, so it
 * cannot use the geometry, the poses, or the decode — all three are downstream
 * of knowing which frame is which. A mechanism that needed the calibration to
 * recover the indexing, and the indexing to recover the calibration, would be
 * a circle with no entry point.
 *
 * ## The three mechanisms here, and the one that is not
 *
 * The plan names three candidates and says the phase **picks by measurement,
 * not by argument**. Two of them are implemented here, and a third that the
 * plan named only in passing:
 *
 *   1. {@link indexByOrder} — the order is the index. Cheap, needs nothing, and
 *      gives no way to detect that it broke.
 *   2. {@link indexByBookends} — the white and black frames that open each
 *      projector's run are separable from every patterned frame, so they mark
 *      the boundaries and the count between them is checkable.
 *   3. {@link indexByFingerprint} — the bookends, plus a check that each Gray
 *      plane and the frame beside it are still complements of one another. This
 *      is not one of the plan's three candidates; it is the cheap fourth the
 *      plan named in passing while measuring the others, and Experiment 8 is
 *      what established it was worth building.
 *
 * And a fifth, which is the one the page uses: {@link indexPosition} reads a
 * whole camera position from its fingerprints alone. The first three rest on
 * {@link classify}, whose premise — every patterned frame lights about half of
 * what the camera sees — holds for a projector's raster and fails for a sphere
 * seen from one place: the coarse Gray planes light all of a visible crescent
 * or none of it, some projectors are out of sight altogether, and one capture
 * holds crescents of very different sizes. `docs/EXPERIMENT-10.md` measured the
 * page refusing every clean bench position at that step. So the fifth finds
 * each run by its own white, black and phase frames, and never asks the
 * capture as a whole what "half" is. See its own docblock for what that buys
 * and what it still refuses.
 *
 * The plan's third candidate — projecting a frame index into the frame itself —
 * is still **not built, on purpose.** It spends raster area, and its real risk
 * is photometric: a marker has to survive an oblique sphere in a room whose
 * ambient term PARAMETERS.md §5 leaves unmeasured between 1% and 15%, and there
 * is no single region of a sphere every camera position can see. That is the
 * expensive option, and building it before measuring the cheap ones would be
 * paying for a mechanism nobody had shown was needed. `docs/EXPERIMENT-8.md` is
 * the measurement that decides whether it is still needed at all.
 *
 * ## The hole the first two leave, and the third mechanism that closes most of it
 *
 * Neither {@link indexByOrder} nor {@link indexByBookends} can see **a drop and
 * a duplicate that cancel inside one run, both landing on patterned frames.**
 * The count between the bookends is unchanged and every frame's kind is
 * unchanged, because {@link observe} cannot tell one Gray plane from another —
 * every patterned frame in the plan lights about half the crescent, which is
 * exactly what makes the references separable and exactly what makes the
 * patterned frames interchangeable.
 *
 * That is the boundary of what a per-frame BRIGHTNESS statistic can do, and it
 * is not the boundary of what a per-frame statistic can do. {@link
 * indexByFingerprint} is the third mechanism here, and it closes most of that
 * hole for the cost of a thumbnail per photograph — without spending any raster
 * area, which is what makes it cheaper than the projected index the plan calls
 * mechanism 3. It rests on an identity the emitter already guarantees and the
 * decoder already relies on:
 *
 *     gray_j(x) + grayInverse_j(x) = white(x) + black(x)
 *
 * at every pixel, for every plane `j`. See {@link complementResidual} for why
 * that survives the camera, and {@link indexByFingerprint} for what it still
 * cannot see — a cancelling fault that disturbs no pair at all, the phase
 * frames being the ones the plan pairs with nothing.
 *
 * ## Refusing is a result
 *
 * Every function here can return a refusal, and the plan is explicit about why
 * that outranks a guess: *a mechanism that silently mis-indexes is worse than
 * one that refuses — a mis-indexed Gray plane is a confidently wrong
 * calibration.* So a refusal carries what was expected, what was seen, and where
 * the disagreement is, rather than a boolean.
 */

import type { LinearImage } from './decode.ts';
import { DEFAULT_DECODE_OPTIONS } from './decode.ts';

/** What a frame is, as an indexer can tell from a photograph without decoding it. */
export type FrameKind = 'white' | 'black' | 'patterned';

/**
 * The shape the capture was supposed to have.
 *
 * Stated as a list of KINDS rather than as a pattern plan, because this package
 * may not import one: `packages/solver` reaches only `packages/calibration`, and
 * the plan type lives in the bench. That restriction turns out to be the right
 * shape anyway — an indexer that is told what kind each frame is needs to know
 * that a run opens white, black and then thirty-two patterned frames, and needs
 * to know nothing whatever about Gray bits or phase steps.
 *
 * {@link indexPosition} is not told what kind each frame is — it has to find
 * where a run starts — and so it is the one mechanism that also reads which
 * positions pair up ({@link complements}) and which are phase steps
 * ({@link phases}). Both still arrive as positions, never as a plan.
 */
export interface ExpectedSequence {
  /** The kind of each frame in ONE projector's run, in capture order. */
  kinds: readonly FrameKind[];
  /** How many projector runs the folder should hold, shot back to back. */
  projectors: number;
  /**
   * Which frames of a run the emitter played as complementary pairs, for
   * {@link indexByFingerprint}. Absent for a plan that has none.
   *
   * This is the one piece of plan knowledge the kinds list cannot carry, and it
   * is carried as POSITIONS rather than as a plan for the same reason the kinds
   * are: this package cannot see a `PatternPlan`. The producer lives beside
   * `planFrames`, which is where the pairing is defined.
   */
  complements?: ComplementPlan;
  /**
   * Which frames of a run are phase steps: one list per axis, each in step
   * order, for {@link indexPosition}. Absent for a caller of the older
   * mechanisms, which never read it.
   *
   * The second piece of plan knowledge the kinds list cannot carry, carried as
   * positions for {@link complements}' reason and produced beside it
   * (`phaseSets` in `packages/bench/src/patterns.ts`). {@link indexPosition}
   * needs it because it finds a run by what its phase frames show: the steps
   * of one axis are samples of one cosine about half the run's own white, so
   * they sum to a known multiple of white plus black, and with an even step
   * count each step and the one half a cycle on are complements exactly as a
   * Gray plane and its inverse are. Both are statements about WHICH frames are
   * the steps of which axis, in what order — which "patterned" does not say.
   */
  phases?: readonly (readonly number[])[];
}

/**
 * The complementary pairs in one run, and what it takes to still see them.
 *
 * The two travel together because either alone is a trap. Pairs without
 * {@link minBlocks} would let a caller run the check at a resolution that
 * cannot resolve the finest plane, where a duplicated frame paired with itself
 * comes back looking exactly like a correct pair — see {@link minBlocks}.
 */
export interface ComplementPlan {
  /**
   * `[a, b]` positions within one run that the emitter played as complements.
   *
   * The plan makes them adjacent (`b === a + 1`) and says why: the comparison
   * cancels albedo and ambient only to the extent that both frames saw the same
   * scene, so the complement goes next to its pattern. Nothing here requires
   * adjacency — the check is the same for any two positions — but that is what
   * makes the pairs worth checking at all, because an adjacent pair is exactly
   * what a drop or a duplicate inside the run pulls apart.
   */
  pairs: readonly (readonly [number, number])[];
  /**
   * Blocks per axis a fingerprint needs before this plan's finest pattern
   * survives being averaged into it.
   *
   * `2^grayBits`, and it is a floor rather than a preference. A fingerprint
   * coarser than the finest Gray plane averages that plane to a flat one-half
   * in every block, and then a frame paired with a duplicate OF ITSELF sums to
   * exactly the reference and the check passes on a run it should reject. That
   * is not a tuning observation: it was measured, it is silent, and it is why
   * {@link indexByFingerprint} refuses a fingerprint coarser than this rather
   * than reporting a clean run.
   *
   * The worst case is a grid that lands exactly IN STEP with the pattern, where
   * each block covers a whole number of periods and the average is exactly one
   * half. Offsetting the grid breaks the resonance and restores the signal, so
   * a warped projection onto a real sphere would rarely hit it — which is
   * precisely why it cannot be relied on, and why the floor is stated instead.
   */
  minBlocks: number;
}

/**
 * What one photograph says about itself, before the capture's scale is known.
 *
 * Deliberately NOT a finished measurement. Review caught the first version of
 * this computing each frame's mid-level from that frame's own extrema, which
 * throws away the one thing the classification needs — the brightness scale
 * shared across the capture — and the result was not merely weak, it was
 * inverted. An all-black frame carrying a hair of ambient gradient,
 * `[0, 0.002, 0, 0.002]`, scored a lit fraction of 0.5, exactly like a Gray
 * plane; a flat white frame scored 0, because nothing in it is above its own
 * midpoint. The folder came back classified white-white-black for a
 * black-patterned-white sequence.
 *
 * The tests did not catch it because they built `FrameObservation`s by hand and
 * never called this. So the fix is two-part by construction: this reports what
 * one photograph contains, and {@link litFractions} decides the threshold once
 * for the whole capture.
 */
export interface FrameStats {
  /** Position in the folder: the only ordering a filesystem guarantees. */
  ordinal: number;
  /** Mean value over the measured pixels. */
  mean: number;
  /** Darkest and brightest measured pixel. */
  lo: number;
  hi: number;
  /** Pixel counts over {@link HISTOGRAM_BINS} equal bins spanning `[lo, hi]`. */
  histogram: Uint32Array;
  /** Pixels actually measured, after the mask. */
  pixels: number;
}

/**
 * Bins kept per frame, so the capture-wide threshold can be applied without a
 * second pass over the pixels.
 *
 * The alternative is holding every photograph until the threshold is known,
 * which for 136 frames of a 4000x3000 sensor is several gigabytes — on a laptop
 * standing next to a sphere. 64 bins put the threshold within 1/64 of a frame's
 * own range, against populations separated by about half of full scale, so the
 * quantisation is two orders below the thing being measured.
 */
export const HISTOGRAM_BINS = 64;

/**
 * Measure one photograph.
 *
 * Channel 0 throughout, matching `decode.ts`'s own convention and for its
 * reason: the detector wants radiance rather than colour, and the renderer
 * writes the same value to every channel for a white frame.
 *
 * `mask` selects the pixels that are the sphere, when something upstream knows.
 * It is optional because the whole point of this phase is to run on a folder
 * nobody has segmented — and running without one is the harder case, since the
 * unlit background then dilutes every frame equally. That dilution scales the
 * fractions without reordering them, which is the property {@link classify}
 * rests on.
 */
export function observe(image: LinearImage, ordinal: number, mask?: Uint8Array): FrameStats {
  const stride = image.channels;
  const n = image.width * image.height;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let pixels = 0;
  for (let i = 0; i < n; i++) {
    if (mask !== undefined && mask[i] !== 1) continue;
    const v = image.data[i * stride];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
    pixels++;
  }
  const histogram = new Uint32Array(HISTOGRAM_BINS);
  if (pixels === 0) {
    return { ordinal, mean: 0, lo: 0, hi: 0, histogram, pixels: 0 };
  }
  if (hi > lo) {
    const scale = HISTOGRAM_BINS / (hi - lo);
    for (let i = 0; i < n; i++) {
      if (mask !== undefined && mask[i] !== 1) continue;
      const v = image.data[i * stride];
      if (!Number.isFinite(v)) continue;
      const b = Math.min(HISTOGRAM_BINS - 1, Math.floor((v - lo) * scale));
      histogram[b]++;
    }
  } else {
    // A flat frame has no spread to bin. It is also the most important case to
    // get right — the white and black references ARE flat — so it is handled
    // explicitly in `litFractions` from `lo` rather than from these counts.
    histogram[0] = pixels;
  }
  return { ordinal, mean: sum / pixels, lo, hi, histogram, pixels };
}

/** What one photograph says about itself, against the whole capture's scale. */
export interface FrameObservation {
  /** Position in the folder: the only ordering a filesystem guarantees. */
  ordinal: number;
  /** Mean value over the measured pixels. */
  mean: number;
  /** Fraction of this frame's pixels above the CAPTURE's mid-level. */
  litFraction: number;
}

/**
 * One threshold for the whole capture, and every frame measured against it.
 *
 * The threshold is the midpoint of the capture's own dynamic range — darkest
 * pixel of the darkest frame to brightest pixel of the brightest — which is the
 * scale a per-image statistic cannot see. Against it a white frame lights all of
 * one projector's crescent, a Gray plane about half of it, and a black frame
 * none, which is the whole basis on which the references are separable.
 *
 * The fraction is of the WHOLE frame rather than of the crescent, so it carries
 * a factor of how much of the picture the sphere fills. That factor is the same
 * for every frame of a capture and divides out in {@link classify}, which
 * normalises by the brightest frame.
 *
 * **It divides out only while every projector lights a crescent of the same
 * size, and a sphere seen from one position does not give that.** One
 * projector's white can light a sliver at the limb while another's lights most
 * of the picture, so a dim or grazing projector's white normalises to a fraction
 * of the brightest one and reads as patterned — and the one midpoint for the
 * whole capture can sit above every pixel a dim projector lights.
 * `docs/EXPERIMENT-10.md` measured the page refusing every clean bench position
 * at this step. The function is unchanged, because Experiments 8 and 10
 * measured it as it is; {@link indexPosition} does not use it.
 */
export function litFractions(stats: readonly FrameStats[]): FrameObservation[] {
  let captureLo = Number.POSITIVE_INFINITY;
  let captureHi = Number.NEGATIVE_INFINITY;
  for (const f of stats) {
    if (f.pixels === 0) continue;
    if (f.lo < captureLo) captureLo = f.lo;
    if (f.hi > captureHi) captureHi = f.hi;
  }
  if (!(captureHi > captureLo)) {
    // Every frame identical: a lens cap, or a folder of one frame repeated.
    return stats.map((f) => ({ ordinal: f.ordinal, mean: f.mean, litFraction: 0 }));
  }
  const mid = (captureLo + captureHi) / 2;
  return stats.map((f) => {
    if (f.pixels === 0) return { ordinal: f.ordinal, mean: f.mean, litFraction: 0 };
    if (f.hi <= f.lo) {
      // Flat: every pixel is `lo`, so the count is all or nothing.
      return { ordinal: f.ordinal, mean: f.mean, litFraction: f.lo > mid ? 1 : 0 };
    }
    if (mid >= f.hi) return { ordinal: f.ordinal, mean: f.mean, litFraction: 0 };
    if (mid < f.lo) return { ordinal: f.ordinal, mean: f.mean, litFraction: 1 };
    // Bins wholly above `mid`, plus the share of the straddling bin above it.
    // Interpolating inside that bin rather than rounding to its edge keeps the
    // estimator unbiased instead of systematically low by half a bin.
    const t = ((mid - f.lo) / (f.hi - f.lo)) * HISTOGRAM_BINS;
    const k = Math.floor(t);
    let above = 0;
    for (let b = k + 1; b < HISTOGRAM_BINS; b++) above += f.histogram[b];
    if (k >= 0 && k < HISTOGRAM_BINS) above += f.histogram[k] * (1 - (t - k));
    return { ordinal: f.ordinal, mean: f.mean, litFraction: above / f.pixels };
  });
}

/** Measure a folder end to end, for a caller that can hold every image at once. */
export function observeCapture(
  images: readonly LinearImage[],
  mask?: Uint8Array,
): FrameObservation[] {
  return litFractions(images.map((img, i) => observe(img, i, mask)));
}

/**
 * A photograph reduced to a coarse grid of block means — enough to compare two
 * frames PIXELWISE without keeping either of them.
 *
 * Separate from {@link FrameStats} rather than folded into it, because it costs
 * memory that only {@link indexByFingerprint} needs and {@link FrameStats} is
 * what every caller pays for. A capture read with the bookends alone should not
 * carry thumbnails it never looks at.
 */
export interface FrameFingerprint {
  /** Position in the folder: the only ordering a filesystem guarantees. */
  ordinal: number;
  /** Blocks per axis. The grid is `blocks * blocks` over the whole frame. */
  blocks: number;
  /** Block means, row-major. Blocks with nothing measured in them hold 0. */
  values: Float32Array;
  /** 1 where the block held at least one measured pixel, 0 where it held none. */
  measured: Uint8Array;
}

/**
 * Reduce one photograph to a block grid.
 *
 * `blocks` has no default on purpose. The count that works is a property of the
 * pattern plan — see {@link ComplementPlan.minBlocks} — and a default here would
 * be a number chosen by whoever did not think about it, silently producing a
 * fingerprint too coarse to see the fault it was added to catch.
 *
 * Channel 0 and the optional mask, both for {@link observe}'s reasons. A block
 * with no measured pixel is marked unmeasured rather than given a zero, because
 * zero is a legitimate block value — a black frame is all of them — and the two
 * cases have to stay distinguishable for {@link complementResidual} to skip the
 * right ones.
 */
export function fingerprint(
  image: LinearImage,
  ordinal: number,
  blocks: number,
  mask?: Uint8Array,
): FrameFingerprint {
  if (!Number.isInteger(blocks) || blocks < 1) {
    throw new Error(`fingerprint: blocks must be a whole number >= 1, got ${blocks}`);
  }
  const values = new Float32Array(blocks * blocks);
  const counts = new Uint32Array(blocks * blocks);
  const measured = new Uint8Array(blocks * blocks);
  const stride = image.channels;
  const sums = new Float64Array(blocks * blocks);
  // Column index per x, built once. It depends only on x, and computing it
  // inside the pixel loop costs a divide and a floor per pixel — 24 million of
  // each per frame on a 24 MP photograph, in a function whose whole
  // justification is being cheap enough to run on every one of them.
  //
  // Clamped rather than rounded, so the last row and column cannot land one
  // past the end on a frame whose dimensions do not divide the grid.
  const columnOf = new Uint32Array(image.width);
  for (let x = 0; x < image.width; x++) {
    columnOf[x] = Math.min(blocks - 1, Math.floor((x * blocks) / image.width));
  }
  for (let y = 0; y < image.height; y++) {
    const row = Math.min(blocks - 1, Math.floor((y * blocks) / image.height)) * blocks;
    const base = y * image.width;
    for (let x = 0; x < image.width; x++) {
      const i = base + x;
      if (mask !== undefined && mask[i] !== 1) continue;
      const v = image.data[i * stride];
      if (!Number.isFinite(v)) continue;
      const b = row + columnOf[x];
      sums[b] += v;
      counts[b]++;
    }
  }
  for (let b = 0; b < values.length; b++) {
    if (counts[b] === 0) continue;
    values[b] = sums[b] / counts[b];
    measured[b] = 1;
  }
  return { ordinal, blocks, values, measured };
}

/**
 * How far two frames are from being complements of one another, against the
 * run's own white and black.
 *
 * ## The identity, and why it survives a camera
 *
 * The emitter plays each Gray plane with its own complement, so in the
 * PROJECTOR the two add to a flat field: `gray + grayInverse = 1` at every
 * raster position, by construction. What a camera records is not that field but
 *
 *     value(p) = a(p) * target(p) + b(p)
 *
 * where `a` gathers albedo, the cosine falloff, the projector gain and the
 * exposure, and `b` gathers ambient and the black floor. Every one of those is a
 * per-pixel unknown this module has no way to measure — and every one of them
 * cancels, because the mapping is AFFINE in the target and the two frames were
 * shot back to back through the same one:
 *
 *     gray(p) + grayInverse(p) = a(p) + 2 b(p) = white(p) + black(p)
 *
 * So the run's own white and black frames are the reference, and no photometric
 * constant has to be known for the comparison to mean something. That is the
 * whole reason this is cheap enough to be worth having: it asks the capture
 * about itself.
 *
 * Two frames that are NOT a complementary pair do not satisfy it. Two different
 * Gray planes disagree over about half the raster, and a frame paired with a
 * duplicate of itself disagrees over all of it — so the residual lands near a
 * half or near one rather than near zero.
 *
 * ## What block averaging does to it
 *
 * Nothing, on the matched side: the identity is pointwise and linear, so it
 * survives averaging over any region exactly. Measured across grids from 16 to
 * 512 blocks, aligned and offset, a matched pair returns 0 to within floating
 * point every time.
 *
 * On the mismatched side averaging does cost, and it is why
 * {@link ComplementPlan.minBlocks} exists — a plane finer than one block
 * averages to a flat half and stops being distinguishable from anything.
 *
 * ## Which blocks count, and why a bare `white > black` is not enough
 *
 * Only blocks carrying real modulation — at least {@link MODULATION_FLOOR} of
 * the brightest block in the run. A block the projector never reached holds no
 * evidence about the pairing, because its two frames agree for a reason that
 * has nothing to do with whether they are complements.
 *
 * The first version of this admitted any block with `white > black`, and review
 * showed that is not a filter but half of one: on an unsegmented frame the
 * background blocks pass it whenever noise happens to land the right way up,
 * and they then contribute the full size of their noise to the deviation while
 * contributing only its positive half to the modulation. So a CORRECT pair's
 * residual climbs with how much of the photograph is background — measured at
 * 0.0400 with the sphere filling the frame, 0.0950 at a quarter, and 0.2432 at
 * a twentieth, which is a false refusal. The bias is in the framing, which is
 * exactly the thing this statistic is supposed to be independent of.
 *
 * The floor is relative to the run's own brightest block rather than absolute,
 * unlike `decode.ts`'s `minModulation`, and it has to be: these are block means
 * of whatever the ingest produced, so there is no scale here to state an
 * absolute number in. Normalising by the brightest thing in the capture is what
 * {@link classify} already does, for the same reason.
 *
 * Returns null when the question cannot be asked: grids that disagree, or no
 * block clearing the floor.
 */
export function complementResidual(
  a: FrameFingerprint,
  b: FrameFingerprint,
  white: FrameFingerprint,
  black: FrameFingerprint,
): number | null {
  const n = a.blocks;
  if (b.blocks !== n || white.blocks !== n || black.blocks !== n) return null;
  // The arrays have to be the size the grid claims. Review found that only the
  // `blocks` fields were compared, so a fingerprint whose `values` were short of
  // its own mask read `undefined` past the end, the arithmetic produced NaN, and
  // NaN is neither null nor greater than COMPLEMENT_LIMIT — so the caller's two
  // branches both missed and the run went out as clean. Reproduced before fixing.
  const want = n * n;
  for (const f of [a, b, white, black]) {
    if (f.values.length !== want || f.measured.length !== want) return null;
  }

  const usable = (i: number): boolean =>
    a.measured[i] === 1 &&
    b.measured[i] === 1 &&
    white.measured[i] === 1 &&
    black.measured[i] === 1 &&
    // Belt and braces against the same failure arriving as a NaN already stored
    // in a fingerprint rather than as a short array.
    Number.isFinite(a.values[i]) &&
    Number.isFinite(b.values[i]) &&
    Number.isFinite(white.values[i]) &&
    Number.isFinite(black.values[i]);

  // The brightest block sets the scale, so the floor is a property of this run
  // rather than a constant in units nothing here owns.
  let peak = 0;
  for (let i = 0; i < a.values.length; i++) {
    if (!usable(i)) continue;
    const m = white.values[i] - black.values[i];
    if (m > peak) peak = m;
  }
  if (!(peak > 0)) return null;
  const floor = MODULATION_FLOOR * peak;

  let deviation = 0;
  let modulation = 0;
  for (let i = 0; i < a.values.length; i++) {
    if (!usable(i)) continue;
    const m = white.values[i] - black.values[i];
    if (!(m >= floor)) continue;
    deviation += Math.abs(a.values[i] + b.values[i] - (white.values[i] + black.values[i]));
    modulation += m;
  }
  return modulation > 0 ? deviation / modulation : null;
}

/**
 * How much modulation a block needs before it is evidence, as a fraction of the
 * brightest block in the run.
 *
 * A tenth is well above anything noise produces on a block mean — a block is an
 * average over thousands of pixels, so its noise is smaller than a pixel's by
 * the square root of that — and well below the limb of the sphere, where real
 * modulation falls off with the cosine but stays a large fraction of the peak
 * until the very edge. What it excludes is the background, which is the whole
 * point.
 */
export const MODULATION_FLOOR = 0.1;

/**
 * How far a pair may drift from the identity before the run is refused.
 *
 * Measured rather than picked, and `packages/bench/test/complements.test.ts`
 * holds the measurement so it cannot drift — that file rather than this
 * package's own tests, because the sweep needs the real pattern plan and
 * `packages/solver` may not import one. Over every pairing a single
 * drop-and-duplicate can put in a pair slot of the page's own plan, at the grid
 * {@link ComplementPlan.minBlocks} requires, the faintest a broken pair returns
 * is 0.3957 on an offset grid and 0.5000 on an aligned one, while a matched
 * pair returns 0. This sits below half of the smaller, so a broken pair has to
 * lose more than half its signal before it reads as a good one.
 *
 * An earlier version of this comment pointed at `test/indexing.test.ts`, which
 * only exercises a four-block toy plan, and quoted 0.31 — a figure from a
 * scratch sweep over every PAIRING OF ANY TWO FRAMES, which is a superset of
 * what a shift can actually produce and so understates the real margin. Review
 * caught it, and caught that this PR fixes exactly that class of error in
 * `patterns.ts` while introducing it here.
 *
 * **What is not measured is the other side of the gap.** A matched pair returns
 * exactly 0 only with exact photometry. On real photographs it returns whatever
 * sensor noise, a moved camera and a flickering room leave behind, and nothing
 * in this repository has ever measured that — the same standing of
 * {@link MIN_CLASSIFY_MARGIN}, and said here for the same reason. What this
 * number is NOT is a tuned threshold sitting close to a distribution somebody
 * has seen. It is the midpoint of a gap whose far edge is known exactly and
 * whose near edge is unknown.
 */
export const COMPLEMENT_LIMIT = 0.15;

/** Where the thresholds sat and how much room there was around them. */
export interface Classification {
  kinds: FrameKind[];
  /**
   * How far apart the three populations actually came out, as a fraction of the
   * brightest frame's lit fraction.
   *
   * This is the photometric health of the whole capture in one number. It falls
   * when the sphere is a small part of the frame, when the room is bright enough
   * to lift the black frames, or when the exposure clips the whites — and below
   * {@link MIN_CLASSIFY_MARGIN} the bookends stop being reliably separable and
   * this module says so rather than guessing.
   *
   * It measures the GAP BETWEEN THE GROUPS rather than each frame's distance
   * from a cut, and the difference is not academic — it is a bug this had until
   * a test caught it. Distance-to-cut is large and reassuring in exactly the case
   * that matters most: a capture whose frames are all within a percent of each
   * other lands entirely on one side of both cuts, every frame sits comfortably
   * far from both, and the number said the capture was healthy while the
   * classification had collapsed to a single class. A gap between groups is zero
   * when a group is empty, which is what that collapse actually is.
   */
  margin: number;
}

/**
 * The fractions the three kinds are expected to sit at, and where the cuts go.
 *
 * Not tuned. A white frame lights the crescent, a black frame lights none, and
 * every patterned frame in `planFrames` lights about half of it — a Gray plane
 * is one code bit, so it is high on half the raster by construction, and a phase
 * step is a cosine, which is above its own mid-level on half its period. So the
 * three populations sit near 1, 0 and 0.5 of the brightest frame, and the cuts
 * are the midpoints of those gaps.
 *
 * **Half the RASTER, which is not half of what one camera sees of it.** A
 * camera sees part of one projector's raster, and the coarsest Gray planes split
 * the whole raster in two, so from one position they light all of the visible
 * crescent or none of it and land beyond these cuts — the finding
 * `docs/EXPERIMENT-10.md` reports, where no per-run rescaling rescued a single
 * run. The argument holds for a phase step only while its fringe is fine against
 * the crescent, which is why {@link indexPosition} uses these cuts on the phase
 * frames only for a plan with an odd step count, and otherwise holds the phase
 * frames to identities that do not depend on the fringe at all. The values are
 * unchanged, because {@link classify} is what Experiments 8 and 10 measured.
 */
export const WHITE_CUT = 0.75;
export const BLACK_CUT = 0.25;

/**
 * How far apart the groups must stay before a classification is trusted.
 *
 * Nominally the gaps are 0.5 each — the populations sit at 1, 0.5 and 0 of the
 * brightest frame — so 0.15 is well under a third of the clean separation and
 * still an order of magnitude above the noise on a frame-wide pixel count.
 *
 * It is a threshold on a quantity this project has never measured on a real
 * sphere, and **nothing measures what it costs.** Experiment 8 renders no
 * images, so it never exercises this check at all; its trials supply exact
 * fractions and the margin is always 0.5 there. Said plainly because the first
 * version of this comment claimed the experiment measured it, which review
 * caught: what a margin costs on real photographs is open, and it is one of the
 * two things Phase 2 needs a real sphere for.
 */
export const MIN_CLASSIFY_MARGIN = 0.15;

/**
 * Every frame's kind, from its lit fraction against the capture's brightest.
 *
 * What the bookends, and so the fingerprint mechanism, stand on. It assumes
 * everything {@link litFractions} and the cuts above say they assume — one
 * crescent size for the whole capture, and patterned frames near half of it —
 * and on a sphere photographed from one position neither holds; see those
 * docblocks. Kept exactly as Experiments 8 and 10 measured it.
 */
export function classify(observations: readonly FrameObservation[]): Classification {
  const peak = observations.reduce((m, o) => Math.max(m, o.litFraction), 0);
  if (peak <= 0) {
    return { kinds: observations.map(() => 'black' as const), margin: 0 };
  }
  const fractions = observations.map((o) => o.litFraction / peak);
  const kinds = fractions.map((f) =>
    f > WHITE_CUT ? ('white' as const) : f < BLACK_CUT ? ('black' as const) : ('patterned' as const),
  );

  // The gap on each side of the classification, measured on the frames as they
  // actually landed. An empty group has no gap to measure and scores zero: a
  // capture with no black frames at all is not a well-separated capture, it is
  // one whose references were never found.
  const lowestOf = (want: FrameKind): number =>
    fractions.reduce((m, f, i) => (kinds[i] === want ? Math.min(m, f) : m), Number.POSITIVE_INFINITY);
  const highestOf = (want: FrameKind): number =>
    fractions.reduce((m, f, i) => (kinds[i] === want ? Math.max(m, f) : m), Number.NEGATIVE_INFINITY);
  const gapWhite = lowestOf('white') - highestOf('patterned');
  const gapBlack = lowestOf('patterned') - highestOf('black');
  const margin = Math.min(gapWhite, gapBlack);
  return { kinds, margin: Number.isFinite(margin) ? Math.max(0, margin) : 0 };
}

/**
 * What an indexer concluded.
 *
 * `assignment[i]` is the frame number the i-th photograph carries, counted
 * across the whole capture — so projector `p`'s frame `f` is
 * `p * kinds.length + f`. `null` entries are photographs the indexer could place
 * no better than a guess; they are dropped rather than assigned, because an
 * unplaced frame costs one frame and a wrongly placed one costs the calibration.
 */
export interface IndexingResult {
  /** True when every photograph the caller must have was placed. */
  ok: boolean;
  /** Frame number per photograph, or null where it could not be placed. */
  assignment: (number | null)[];
  /** Which projector runs came out complete and trustworthy. */
  usableProjectors: number[];
  /** Empty when `ok`. Each entry says what disagreed, in an operator's terms. */
  problems: string[];
  /** The mechanism that produced this, for a capture record. */
  mechanism: 'order' | 'bookends' | 'fingerprint';
}

function totalFrames(expected: ExpectedSequence): number {
  return expected.kinds.length * expected.projectors;
}

/**
 * Mechanism 1 — the order is the index.
 *
 * The whole mechanism is `assignment[i] = i`, which is why it is worth having in
 * the measurement at all: it is what the project does TODAY, it is what
 * `docs/CALIBRATE.md`'s shooting rules exist to protect, and it is the baseline
 * any other mechanism has to beat.
 *
 * Its one check is the total count, and the plan's description of the weakness
 * is exact: a drop and a duplicate in the same capture leave the count right and
 * every frame after the first fault wrong. This function cannot tell that from a
 * clean capture, and `problems` says so only when the count itself disagrees.
 */
export function indexByOrder(
  observations: readonly FrameObservation[],
  expected: ExpectedSequence,
): IndexingResult {
  const want = totalFrames(expected);
  const problems: string[] = [];
  if (observations.length !== want) {
    problems.push(
      `The folder holds ${observations.length} photographs and the capture should have ${want} — ` +
        `${expected.projectors} projectors of ${expected.kinds.length} frames. Ordering alone ` +
        `cannot say which one is missing or extra, only that the count is wrong, so every frame ` +
        `after the fault is indexed as its neighbour.`,
    );
  }
  const assignment = observations.map((_, i) => (i < want ? i : null));
  return {
    ok: problems.length === 0,
    assignment,
    usableProjectors:
      problems.length === 0 ? Array.from({ length: expected.projectors }, (_, p) => p) : [],
    problems,
    mechanism: 'order',
  };
}

/** The leading non-patterned frames of a run — what marks a boundary. */
export function bookendPrefix(expected: ExpectedSequence): FrameKind[] {
  const prefix: FrameKind[] = [];
  for (const k of expected.kinds) {
    if (k === 'patterned') break;
    prefix.push(k);
  }
  return prefix;
}

/**
 * Mechanism 2 — find the bookends, then check the count between them.
 *
 * The structural claim underneath it: a white frame lights the whole of one
 * projector's crescent and a black frame lights none, so both are separable from
 * every patterned frame in the plan, which lights about half. That separation is
 * measured rather than assumed — {@link classify} reports its margin and this
 * refuses below {@link MIN_CLASSIFY_MARGIN}, because a capture where the
 * bookends cannot be told apart is one where this mechanism has nothing to stand
 * on and should say so rather than segment on noise.
 *
 * ## What it buys over ordering, and it is not a small thing
 *
 * **A fault stops spreading.** Under ordering, one frame dropped from the first
 * projector's run mis-indexes every frame of every projector after it — the
 * whole capture is wrong and nothing says so. Here each run is re-synchronised
 * by its own bookends, so a fault inside run 1 costs run 1 and leaves runs 2, 3
 * and 4 correctly indexed and usable. That is structural, not statistical: it
 * follows from re-finding the boundary rather than counting from the start.
 *
 * ## What it does not buy
 *
 * **Recovery within a run.** A run that should hold 34 frames and holds 33 is a
 * run with a hole in an unknown place, and this refuses the run rather than
 * guessing which frame is missing. `usableProjectors` says how much of the
 * capture survived rather than whether it was perfect.
 *
 * **A guarantee about `usableProjectors`.** It does not have one, and the
 * measurement is what established that rather than a reading of the code:
 * `ok: false` means some run was refused, NOT that every run still offered is
 * sound. A capture carrying a drop in one run and a cancelling drop-and-
 * duplicate pair in another is refused for the first and offers the second,
 * which is wrong. Experiment 8 found the bookends doing exactly that in 630
 * trials where the whole-capture verdict looked safe, which is why its headline
 * counts POISONED RUNS rather than silent captures. A caller taking
 * `usableProjectors` inherits the blind spot above; there is no way to read
 * around it from this module's output.
 *
 * **A lost boundary.** If both of a run's bookends are dropped, its frames glue
 * to the previous run and the count of runs comes out short — and since nothing
 * then says which run is which projector, this refuses the whole capture rather
 * than assign every later run to the wrong projector. A photograph filed under
 * the wrong projector is the failure this project treats as worse than stopping,
 * and it is worth paying a whole capture to avoid.
 */
export function indexByBookends(
  observations: readonly FrameObservation[],
  expected: ExpectedSequence,
): IndexingResult {
  const runLength = expected.kinds.length;
  const problems: string[] = [];
  const assignment: (number | null)[] = observations.map(() => null);
  const refuse = (): IndexingResult => ({
    ok: false,
    assignment,
    usableProjectors: [],
    problems,
    mechanism: 'bookends',
  });

  const prefix = bookendPrefix(expected);
  if (prefix.length === 0) {
    problems.push(
      'This capture has no white or black frames to find the boundaries with — the pattern plan ' +
        'was built with includeWhiteBlack off. Nothing here can segment it; shoot the references.',
    );
    return refuse();
  }

  const { kinds, margin } = classify(observations);
  if (margin < MIN_CLASSIFY_MARGIN) {
    problems.push(
      `The white and black frames cannot be reliably told from the patterned ones: the closest ` +
        `two groups are ${margin.toFixed(3)} apart, under the ${MIN_CLASSIFY_MARGIN} this needs. ` +
        `That usually means the sphere fills too little of the frame, the room is bright enough ` +
        `to lift the black frames, or the exposure is clipping the white ones. Nothing below this ` +
        `line would be a measurement; it would be a segmentation of noise.`,
    );
    return refuse();
  }

  // Run starts, scanning left to right. A duplicated white gives [white, white,
  // black] and only the SECOND one matches, which is what leaves the spare in
  // the previous run where the length check finds it.
  const starts: number[] = [];
  for (let i = 0; i + prefix.length <= kinds.length; ) {
    let hit = true;
    for (let j = 0; j < prefix.length; j++) {
      if (kinds[i + j] !== prefix[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      starts.push(i);
      i += prefix.length;
    } else {
      i++;
    }
  }

  if (starts.length !== expected.projectors) {
    problems.push(
      `Found ${starts.length} projector runs and the capture should hold ${expected.projectors}. ` +
        (starts.length < expected.projectors
          ? 'A run whose white and black frames are both missing merges into the one before it, ' +
            'and nothing then says which run is which projector — so this refuses the capture ' +
            'rather than file every later run under the wrong projector.'
          : 'An extra boundary means a frame was classified as a reference that is not one, so ' +
            'the segmentation below it cannot be trusted.'),
    );
    return refuse();
  }
  if (starts[0] !== 0) {
    problems.push(
      `${starts[0]} photograph(s) sit before the first white frame. They belong to no run — a ` +
        'lens cap shot, a test frame, or the tail of an earlier attempt.',
    );
  }

  const usableProjectors: number[] = [];
  for (let p = 0; p < starts.length; p++) {
    const from = starts[p];
    const to = p + 1 < starts.length ? starts[p + 1] : observations.length;
    const length = to - from;
    if (length !== runLength) {
      problems.push(
        `Projector ${p + 1}'s run holds ${length} photographs and should hold ${runLength}. ` +
          `Its boundaries are sound, so the fault is inside it and there is no way to say which ` +
          `frame — this run is dropped and the rest of the capture is unaffected. Re-shoot ` +
          `projector ${p + 1}.`,
      );
      continue;
    }
    // The kinds inside the run have to match too. A run of the right LENGTH
    // whose frames are the wrong kinds is a drop and a duplicate cancelling in
    // the count, which is precisely the case ordering alone cannot see at all.
    let mismatch = -1;
    for (let f = 0; f < runLength; f++) {
      if (kinds[from + f] !== expected.kinds[f]) {
        mismatch = f;
        break;
      }
    }
    if (mismatch >= 0) {
      problems.push(
        `Projector ${p + 1}'s run is the right length but frame ${mismatch + 1} looks like a ` +
          `${kinds[from + mismatch]} frame where the sequence expects a ${expected.kinds[mismatch]} ` +
          `one. A drop and a duplicate in the same run leave the count right and the order wrong. ` +
          `Re-shoot projector ${p + 1}.`,
      );
      continue;
    }
    for (let f = 0; f < runLength; f++) assignment[from + f] = p * runLength + f;
    usableProjectors.push(p);
  }

  return {
    ok: problems.length === 0,
    assignment,
    usableProjectors,
    problems,
    mechanism: 'bookends',
  };
}

/**
 * Mechanism 4 — the bookends, and then ask whether each pair is still a pair.
 *
 * Strictly {@link indexByBookends} plus one check, and built by CALLING it
 * rather than by reimplementing the segmentation: everything the bookends buy —
 * a fault stopping at the next boundary, a whole capture refused when a run
 * boundary is lost — is inherited rather than re-derived, and a run this
 * refuses is one the bookends had already accepted.
 *
 * ## What it closes
 *
 * The blind spot named at the top of this module: a drop and a duplicate that
 * cancel inside one run, both landing on patterned frames. The count between
 * the boundaries is unchanged and every frame's KIND is unchanged, so the
 * bookends see nothing. But the fault shifts every frame between the two by one
 * position, and a Gray plane that has moved by one position is no longer beside
 * its own complement — so {@link complementResidual} on the run's own pairs
 * comes back near a half instead of near zero, and the run is refused.
 *
 * ## What it does not close, and it is one case rather than a margin
 *
 * **A cancelling pair that disturbs no complementary pair.** The plan pairs the
 * Gray planes with their complements and pairs the phase steps with nothing, so
 * a fault whose whole effect lands among the phase frames shifts only frames
 * this check does not look at. Every Gray pair is still a pair, the residual is
 * still zero, and the run is offered with a phase step missing and another shot
 * twice.
 *
 * **Said that way rather than as "both faults inside the phase block", because
 * that narrower wording is false and the sweep said so.** Of the 64 faults
 * missed in the page's own plan, 8 duplicate a Gray frame — the last one, whose
 * copy lands in the first phase slot — while dropping a phase frame. No Gray
 * pair moves, so nothing fires. What decides it is whether the fault disturbs a
 * pair, not where the operator's two mistakes fell.
 *
 * That is not a threshold that could be tightened. It is the shape of the plan:
 * `planFrames` emits `phaseSteps` frames per axis with no complement among
 * them. Closing it needs a different identity — the phase steps of one axis sum
 * to a flat field the same way a complementary pair does, which is the obvious
 * next thing to measure and is deliberately not built here. It is a weaker
 * signal than this one for a reason worth knowing before anybody builds it: a
 * fringe is finer than most of the Gray planes, so it is the first thing a
 * coarse fingerprint stops resolving.
 *
 * **Anything photometric.** Every residual this compares is exact in the one
 * place it has been measured, because that place renders no images. See
 * {@link COMPLEMENT_LIMIT}.
 */
export function indexByFingerprint(
  observations: readonly FrameObservation[],
  fingerprints: readonly FrameFingerprint[],
  expected: ExpectedSequence,
): IndexingResult {
  const base = indexByBookends(observations, expected);
  const problems = [...base.problems];
  const refuse = (): IndexingResult => ({
    ok: false,
    assignment: base.assignment.map(() => null),
    usableProjectors: [],
    problems,
    mechanism: 'fingerprint',
  });

  const plan = expected.complements;
  if (plan === undefined || plan.pairs.length === 0) {
    // Asked for the complement check by a caller whose plan has no complements
    // to check. Refusing rather than quietly behaving like the bookends: a
    // caller that chose this mechanism believes it is getting a check, and
    // handing back a clean result it never performed is the exact failure the
    // whole module is built to avoid.
    problems.push(
      'This capture plan lists no complementary pairs, so there is nothing for the fingerprint ' +
        'to check and this mechanism would be the bookends wearing its name. Every plan this ' +
        'page emits pairs each Gray plane with its complement, so a plan without them did not ' +
        'come from here.',
    );
    return refuse();
  }
  if (fingerprints.length !== observations.length) {
    problems.push(
      `${fingerprints.length} fingerprints were supplied for ${observations.length} ` +
        'photographs. They are matched by position, so a mismatch means one of the two lists is ' +
        'not the capture.',
    );
    return refuse();
  }
  // Both lists carry an ordinal and nothing used to read either, so a caller
  // whose fingerprints came back out of order — a worker pool resolving as it
  // pleases, a sort by filename applied to one list and not the other — passed
  // the length check and then had every pair compared against the wrong frames.
  // Correct pairs read as broken, broken ones can read as correct, and the
  // refusal names frames that were never in the pair. One comparison closes it.
  const disordered = fingerprints.findIndex((f, i) => f.ordinal !== observations[i]?.ordinal);
  if (disordered >= 0) {
    problems.push(
      `Fingerprint ${disordered + 1} says it is photograph ${fingerprints[disordered].ordinal} ` +
        `and the observation in that position says ${observations[disordered]?.ordinal}. The two ` +
        'lists are matched by position, so one of them has been reordered and every comparison ' +
        'below it would be against the wrong frame.',
    );
    return refuse();
  }

  const runLength = expected.kinds.length;
  const misshapen = fingerprints.findIndex(
    (f) => f.values.length !== f.blocks * f.blocks || f.measured.length !== f.blocks * f.blocks,
  );
  if (misshapen >= 0) {
    // Named separately from the grid mismatch below so the refusal is the true
    // one. A fingerprint that disagrees with its own `blocks` is a caller bug,
    // not a capture that came out badly.
    const f = fingerprints[misshapen];
    problems.push(
      `Fingerprint ${misshapen + 1} says it is ${f.blocks} blocks across, which needs ` +
        `${f.blocks * f.blocks} values, and carries ${f.values.length} values and ` +
        `${f.measured.length} measured flags. It does not describe the grid it claims.`,
    );
    return refuse();
  }
  const grid = fingerprints[0]?.blocks;
  if (grid !== undefined && fingerprints.some((f) => f.blocks !== grid)) {
    // Ruled out here so that the only remaining reason `complementResidual` can
    // decline to answer is the one the refusal below names. It returns null for
    // two different causes — grids that disagree, and no modulation to measure
    // against — and a message that asserts the second while the first is what
    // happened would be exactly the confident wrong answer this module exists to
    // refuse.
    problems.push(
      'The fingerprints are not all the same grid, so they cannot be compared with each other. ' +
        'They come from one capture read in one pass, so a mixture means two passes have been ' +
        'spliced together.',
    );
    return refuse();
  }
  const coarsest = fingerprints.reduce((m, f) => Math.min(m, f.blocks), Number.POSITIVE_INFINITY);
  if (fingerprints.length > 0 && coarsest < plan.minBlocks) {
    // The silent case, refused loudly. See ComplementPlan.minBlocks: below this
    // the finest Gray plane averages to a flat half in every block, a frame
    // paired with a duplicate of itself sums to exactly the reference, and the
    // check reports a clean run it should have rejected.
    problems.push(
      `The fingerprints are ${coarsest} blocks across and this plan needs at least ` +
        `${plan.minBlocks}. Below that the finest Gray plane averages to a flat half in every ` +
        'block, and a frame paired with a duplicate of itself then looks exactly like a correct ' +
        'pair — so this refuses rather than run a check that cannot fail.',
    );
    return refuse();
  }

  // Every pair has to name positions inside the run. These used to be skipped
  // one at a time, which is a silent no-op rather than a lenient check: a plan
  // whose pairs all fell outside the run checked NOTHING, found no fault, and
  // returned `ok: true` with `mechanism: 'fingerprint'` on a run carrying a
  // cancelling drop and duplicate — the exact "bookends wearing its name"
  // outcome the empty-pairs branch above refuses. Reachable through a caller
  // that truncates `kinds` while passing the full plan's pairs through.
  const outside = plan.pairs.find(
    ([a, b]) => a < 0 || b < 0 || a >= runLength || b >= runLength,
  );
  if (outside !== undefined) {
    problems.push(
      `This capture plan pairs frames ${outside[0] + 1} and ${outside[1] + 1} of a run, and a ` +
        `run here holds ${runLength}. The pairs and the frame kinds describe different runs, so ` +
        'one of the two did not come from the plan that was shot.',
    );
    return refuse();
  }

  const whiteAt = expected.kinds.indexOf('white');
  const blackAt = expected.kinds.indexOf('black');
  if (whiteAt < 0 || blackAt < 0) {
    problems.push(
      'A run of this capture has no white frame, no black frame, or neither, and those two are ' +
        'the reference every complementary pair is compared against. Without them the identity ' +
        'has nothing to be checked against.',
    );
    return refuse();
  }

  const assignment = base.assignment.slice();
  const usableProjectors: number[] = [];
  for (const p of base.usableProjectors) {
    const start = assignment.indexOf(p * runLength);
    if (start < 0) continue;
    const white = fingerprints[start + whiteAt];
    const black = fingerprints[start + blackAt];
    // The FIRST pair that fails and ITS OWN residual, rather than the first
    // failure reported with the run's worst number beside it. They are usually
    // the same pair and the message reads identically when they are; when they
    // are not, a sentence naming one pair's frames and another pair's
    // disagreement is a sentence nobody can act on.
    let broken: { a: number; b: number; residual: number } | null = null;
    let unanswered = false;
    for (const [a, b] of plan.pairs) {
      const residual = complementResidual(
        fingerprints[start + a],
        fingerprints[start + b],
        white,
        black,
      );
      if (residual === null) {
        unanswered = true;
        continue;
      }
      if (residual > COMPLEMENT_LIMIT) {
        // First failure ends the run's check. Nothing below reads a later pair:
        // a broken pair is reported ahead of an unanswerable one, so carrying on
        // would cost a pass over every remaining pair to reach the same words.
        broken = { a, b, residual };
        break;
      }
    }
    if (broken !== null) {
      problems.push(
        `Projector ${p + 1}'s frames ${broken.a + 1} and ${broken.b + 1} were played as a ` +
          `pattern and its complement, and they no longer add up to one: they miss the run's ` +
          `own white and black by ${(100 * broken.residual).toFixed(0)}% of its modulation, ` +
          `against the ${(100 * COMPLEMENT_LIMIT).toFixed(0)}% this allows. The count and the ` +
          `frame kinds are both right, which is what a dropped frame and a duplicated one look ` +
          `like when they cancel inside one run. Re-shoot projector ${p + 1}.`,
      );
      continue;
    }
    if (unanswered) {
      // Deliberately does NOT name a cause. Two remain once the grid mismatch is
      // ruled out above — no block clearing the modulation floor, and a frame
      // whose fingerprint is entirely unmeasured — and this cannot tell them
      // apart. Asserting either would be the confidently wrong diagnosis that
      // the grid check was added to stop producing.
      problems.push(
        `Projector ${p + 1}'s run could not be checked: somewhere in it a pattern and its ` +
          'complement had nothing to be compared over — either no part of the frame carries ' +
          'enough modulation to measure against, or one of the photographs came back with no ' +
          'readable pixels at all. The run is dropped rather than passed untested.',
      );
      continue;
    }
    usableProjectors.push(p);
  }

  for (let i = 0; i < assignment.length; i++) {
    const got = assignment[i];
    if (got === null) continue;
    if (!usableProjectors.includes(Math.floor(got / runLength))) assignment[i] = null;
  }

  return {
    ok: problems.length === 0,
    assignment,
    usableProjectors,
    problems,
    mechanism: 'fingerprint',
  };
}

// ---------------------------------------------------------------------------
// Mechanism 5 — a whole camera position, read from what each run shows
// ---------------------------------------------------------------------------

/**
 * How far above the folder's own floor a block has to rise before a photograph
 * counts as lit there.
 *
 * The decoder's modulation floor, `DEFAULT_DECODE_OPTIONS.minModulation` in
 * `decode.ts`, imported rather than restated so the two cannot drift: a block
 * whose mean does not clear it carries less modulation than the decoder reads
 * one pixel by, so a photograph none of whose blocks clears it holds nothing a
 * run can be found by. It is an absolute number where {@link MODULATION_FLOOR}
 * is relative, and that is not the inconsistency it looks like: the decoder
 * already applies this one to the same linearised pixels these fingerprints
 * average.
 *
 * Such a photograph is not always empty to the decoder, which reads pixels one
 * at a time. A projector grazing the limb lights a line of them too thin to
 * lift any block's mean past this. `tools/reader-acceptance.ts`, over every
 * clean position EXPERIMENT-10 photographed, found six runs like that, whose
 * brightest block rose 0.0055 to 0.016 above its slot's own dark: each is
 * called out of view, and would have decoded 1 to 112 correspondences, fewer
 * than the 200 below which EXPERIMENT-10 calls a run minor. Every slot of a
 * projector that lit no pixel at all rose at most 0.0027 (80 slots, the room on
 * and off, at three presets), and the dimmest run placed had its brightest
 * block 0.026 above its black.
 */
export const DARK_LIMIT = DEFAULT_DECODE_OPTIONS.minModulation;

/**
 * The quantile of each block, across a stretch of photographs, taken as that
 * block's unlit level there.
 *
 * Over a slot no run was found in, it is the slot's own dark: a projector the
 * camera cannot see leaves every photograph of its slot at it, and a run that
 * could not be found lights its crescent above it in its white and in half of
 * every Gray pair. Over the whole folder, it stands for dark where nothing
 * nearer does. A quarter, because far more than a quarter of a camera position
 * is unlit at any block. A block one projector reaches is dark in every other
 * projector's run, which is three quarters of the page's four-projector
 * position, and in its own run's black. A block two projectors reach is dark in
 * the other two runs, in both blacks and in the dark frame of each Gray pair
 * coarse enough to resolve there. The median would sit on lit values in that
 * second case; a lower quantile would take one noise excursion for the floor
 * and call ordinary dark photographs lit.
 */
export const FLOOR_QUANTILE = 0.25;

/**
 * How far from a whole number of runs the photographs between two runs may be.
 *
 * Three: room for the page's own small faults — a white shot twice before its
 * run, a dark photograph dropped or doubled, a stray test shot — and far inside
 * half a run, so a gap within it rounds to one number of runs only (half a run
 * is 17 photographs on the page's plan). It is also the allowance for missing
 * photographs in the folder-length and end counts below. A gap further out is
 * not a folder with a stray in it, and the projector numbers after it are
 * refused rather than rounded.
 */
export const SLOT_SLACK = 3;

/**
 * The smallest crescent, in fingerprint blocks, whose run is checked and
 * decoded.
 *
 * A projector that lights fewer is "barely seen": a note rather than a refusal,
 * and not decoded — a handful of blocks is too little for the complement check
 * to mean anything, and a re-shoot would see no more of it. It counts blocks of
 * whatever grid the plan asks for, so it is a smaller patch of sphere at a
 * finer grid.
 *
 * Eight stands on `tools/reader-acceptance.ts`, which read every clean position
 * EXPERIMENT-10 photographed: no crescent there has 8 or 9 blocks, so it sits
 * between the largest noted barely seen, 7, and the smallest placed, 10. What
 * it gives up is small. The 18 runs noted barely seen light 4 to 176 pixels,
 * four of them only the room behind the sphere, and would have decoded 4 to
 * 176 correspondences each. The complement check passes every one of them,
 * which says it does not refuse them for noise, not that it could find a fault
 * in so few blocks — and that is what this guards.
 */
export const MIN_CRESCENT_BLOCKS = 8;

/**
 * The share of a photograph's light that has to fall where a run lights before
 * the photograph is taken for more of that run.
 *
 * Nine tenths, the plan's figure. A frame of this run lights nothing its own
 * white does not, so all of its light falls inside — less the noise of blocks
 * at the edge. The next projector's white, which is what normally follows a
 * run, lights where that projector reaches, and in a sphere lit by projectors
 * at quarter turns that is a region overlapping this one rather than inside it.
 * Measured in `position.test.ts`'s model: where the next projector's white
 * reads a third of this run's range or more over its crescent, 0.43 to 0.87 of
 * its light falls inside — and where more than nine tenths does, it covers
 * little of the crescent ({@link PHASE_COVERAGE}).
 */
export const LIGHT_INSIDE = 0.9;

/**
 * The share of a run's crescent the photograph after it has to cover, at a
 * quarter of the run's range or more, before it is taken for more of the run.
 *
 * Half. The frame a duplicate pushes out of a run is its last phase step, and
 * the check that asks for this is the one that matters where the fingerprint
 * cannot resolve the fringe — there a phase step reads a half in every block and
 * covers the whole crescent. The next projector's white, the other thing that
 * can follow a run and light only where it lights, covers only where the two
 * overlap. Measured in `position.test.ts`'s sphere model at every 10° of camera
 * azimuth: wherever the next projector's white fell 80% or more inside this
 * run's light, it covered 0 to 0.36 of the crescent. Without this the run
 * before a broken one was refused along with it whenever the broken one's white
 * fell inside its light.
 */
export const PHASE_COVERAGE = 0.5;

/**
 * The most contrast one axis's phase steps may show over a crescent, as a
 * fraction of the run's own white minus black.
 *
 * A phase step is `0.5 + 0.5 cos(...)` of the projector's range, so one axis's
 * steps are samples of a single cosine whose amplitude is at most half of white
 * minus black; averaging over a crescent can only lower it. Frames from another
 * run that happen to pair up — a white and a black, or a coarse Gray plane lit
 * across the crescent beside one lit nowhere — show 0.64 to 0.71 when they land
 * in the phase slots of a window that is not a run, which is how a projector
 * overlapping this one almost completely gets past the complement identity
 * alone. The bound is the half, plus 0.05 for noise on levels averaged over a
 * crescent of at least {@link MIN_CRESCENT_BLOCKS} blocks.
 *
 * This is the fringe-independent form of the "about half" cut: at a fine fringe
 * every step reads a half and the amplitude is near zero, and at a coarse one
 * the steps spread towards 0 and 1 and the amplitude towards a half — both
 * legitimately.
 */
export const PHASE_CONTRAST_LIMIT = 0.55;

/**
 * The share of a run's modulation by which, over its crescent, at least one of
 * its Gray planes has to differ from its complement.
 *
 * Half. The complement identity says a plane and its complement add up to the
 * run's white and black; it does not say they differ, and two copies of one
 * photograph halfway between a window's white and black add up to them too. A
 * run's planes separate: the coarsest lights the crescent on one side of its
 * edge and its complement the other side, so the two differ by the run's whole
 * modulation in every block but the few the edge crosses. It happened: test
 * shots of projector 1's white bracketed about the exposure — one over, one
 * under — then copies of it at the exposure, 34 photographs from the first
 * bracket shot to Play, made a window whose white was the shot over, whose
 * black the shot under, and whose every pair was the white twice. Every
 * identity held, it was placed as projector 1, and every run after it was filed
 * a projector late with the page saying all was well. In `position.test.ts`'s
 * model such windows separate by 0.013 to 0.08 of their modulation, bracketed
 * from twice the exposure and half to a tenth either side, and every run with
 * a crescent photographed from 384 camera placements on the page's plan and the
 * cheap one — 1315 runs — by 0.938 or more. On the bench's own photographs,
 * every clean position `tools/reader-acceptance.ts` reads, the 345 runs with a
 * crescent separate by 0.72 or more, the least of them with the room on.
 */
export const PAIR_SEPARATION = 0.5;

/** Where a re-shot run came from, and which run it replaced. */
export interface ReshootProvenance {
  /** Zero-based projector. */
  projector: number;
  /** Folder position of the re-shot run's first photograph, its white. */
  used: number;
  /**
   * Folder position of the original run's first photograph, or of the first
   * photograph of the stretch it occupied when it could not be read as a run.
   */
  replaced: number;
}

/**
 * What {@link indexPosition} made of one camera position.
 *
 * Its own type rather than {@link IndexingResult}. That one's `mechanism` union
 * is copied by `packages/experiments/src/indexing/run.ts`, which scores
 * Experiment 8's arms, and widening it would reach into an experiment that never
 * runs this mechanism.
 */
export interface PositionIndexing {
  /** True when every run this camera could see was placed and nothing was refused. */
  ok: boolean;
  /** Frame number per photograph, `p * kinds.length + f`, or null where not placed. */
  assignment: (number | null)[];
  /** Projectors whose runs were placed, ascending. */
  usableProjectors: number[];
  /** Projectors this camera could not see: every photograph of their slot dark. */
  unseenProjectors: number[];
  /** Projectors that lit fewer than {@link MIN_CRESCENT_BLOCKS} blocks: noted, not decoded. */
  barelySeenProjectors: number[];
  /** Runs placed from a re-shoot appended to the position, and what they replaced. */
  reshoots: ReshootProvenance[];
  /** Refusals, in an operator's terms. Empty when `ok`. */
  problems: string[];
  /**
   * What was noticed and stopped nothing: pre-roll, trailing, unseen, barely
   * seen, replaced, and a re-shoot that did not pass after a run that did.
   */
  notes: string[];
  mechanism: 'position';
}

/** A candidate run: its references, and what they light. */
interface RunWindow {
  /** Folder position of the run's first frame. */
  start: number;
  white: FrameFingerprint;
  black: FrameFingerprint;
  /** Blocks carrying real modulation, the way {@link complementResidual} counts it. */
  crescent: number[];
  /** Sum of white minus black over the crescent. */
  modulation: number;
  /** 1 where white minus black clears {@link DARK_LIMIT}: all this run lights, limb included. */
  lit: Uint8Array;
}

/** What one run found in the folder came to, before it has a projector number. */
type RunVerdict =
  | { kind: 'ok' }
  | { kind: 'barely'; blocks: number }
  | { kind: 'broken'; a: number; b: number; residual: number }
  | { kind: 'unanswered' }
  | { kind: 'extra'; at: number };

function usableBlock(f: FrameFingerprint, i: number): boolean {
  return f.measured[i] === 1 && Number.isFinite(f.values[i]);
}

/**
 * The value that would sit at index `k` of `buf[lo..hi]` sorted, reordering
 * that range. Hoare selection with a median-of-three pivot.
 */
function selectInPlace(buf: Float64Array, lo: number, hi: number, k: number): number {
  while (lo < hi) {
    const x = buf[lo];
    const y = buf[(lo + hi) >>> 1];
    const z = buf[hi];
    const pivot = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (buf[i] < pivot) i++;
      while (buf[j] > pivot) j--;
      if (i <= j) {
        const t = buf[i];
        buf[i] = buf[j];
        buf[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return buf[k];
  }
  return buf[k];
}

/** Each block's {@link FLOOR_QUANTILE} across the folder. NaN where nothing was measured. */
function folderFloor(fps: readonly FrameFingerprint[], cells: number): Float64Array {
  // Gathered block-major in one pass over each photograph, rather than one
  // photograph per block per pass: a position is 136 grids of 4096 blocks, and
  // walking them the other way round was most of this function's time.
  const n = fps.length;
  const byBlock = new Float64Array(cells * n);
  const counts = new Int32Array(cells);
  for (const f of fps) {
    const { values, measured } = f;
    for (let i = 0; i < cells; i++) {
      const v = values[i];
      if (measured[i] === 1 && Number.isFinite(v)) byBlock[i * n + counts[i]++] = v;
    }
  }
  const floor = new Float64Array(cells).fill(Number.NaN);
  for (let i = 0; i < cells; i++) {
    const count = counts[i];
    if (count === 0) continue;
    const lo = i * n;
    floor[i] = selectInPlace(byBlock, lo, lo + count - 1, lo + Math.floor(FLOOR_QUANTILE * (count - 1)));
  }
  return floor;
}

/** How many blocks of `f` clear the floor by {@link DARK_LIMIT}. */
function litCountOf(f: FrameFingerprint, floor: Float64Array): number {
  const { values, measured } = f;
  let count = 0;
  for (let i = 0; i < floor.length; i++) {
    if (measured[i] === 1 && values[i] - floor[i] >= DARK_LIMIT) count++;
  }
  return count;
}

/** Adds the blocks of `f` that clear the floor by {@link DARK_LIMIT} to `into`. */
function addLitBlocks(f: FrameFingerprint, floor: Float64Array, into: Set<number>): void {
  const { values, measured } = f;
  for (let i = 0; i < floor.length; i++) {
    if (measured[i] === 1 && values[i] - floor[i] >= DARK_LIMIT) into.add(i);
  }
}

/**
 * The references at `start`, or null when they light nothing — or when the
 * black outshines the white.
 *
 * A run's white is its brightest photograph and its black the page's black, so
 * wherever the two differ the white is the brighter. Nine tenths of what they
 * differ by has to be the white's — the share {@link LIGHT_INSIDE} asks of a
 * photograph's light before it is taken for part of a run — which leaves the
 * room's light room to shift between two photographs. A window that starts on a
 * Gray plane has that plane for its white and the plane's complement for its
 * black, lit wherever the plane is dark, and every later pair still adds up to
 * the two, so the complement identity cannot tell it from a run. It happened:
 * one run's second phase step photographed three times put that run's phase
 * frames back in the phase slots of a window two photographs in, the phase
 * identities held, and the window was placed with the run's frames a slot or
 * two out while the page said every frame was found. In `position.test.ts`'s
 * model the black of each such window took 0.72 to 0.95 of what it and its
 * white differed by, and over 1316 runs photographed from 384 camera
 * placements no run's black was brighter than its white in any block. What
 * this cannot see is a coarse plane that lights all of what the camera sees of
 * its projector: that plane is then the run's white in every block, and its
 * complement the run's black.
 */
function runWindowAt(
  fps: readonly FrameFingerprint[],
  start: number,
  whiteAt: number,
  blackAt: number,
): RunWindow | null {
  return referenceWindow(fps[start + whiteAt], fps[start + blackAt], start);
}

/** {@link runWindowAt} for any two photographs taken as a white and a black. */
function referenceWindow(white: FrameFingerprint, black: FrameFingerprint, start: number): RunWindow | null {
  const cells = white.values.length;
  let peak = 0;
  let whiter = 0;
  let blacker = 0;
  for (let i = 0; i < cells; i++) {
    if (!usableBlock(white, i) || !usableBlock(black, i)) continue;
    const m = white.values[i] - black.values[i];
    if (m > peak) peak = m;
    if (m >= DARK_LIMIT) whiter += m;
    else if (-m >= DARK_LIMIT) blacker -= m;
  }
  if (!(peak >= DARK_LIMIT)) return null;
  if (!(whiter >= LIGHT_INSIDE * (whiter + blacker))) return null;
  const cut = Math.max(DARK_LIMIT, MODULATION_FLOOR * peak);
  const crescent: number[] = [];
  const lit = new Uint8Array(cells);
  let modulation = 0;
  for (let i = 0; i < cells; i++) {
    if (!usableBlock(white, i) || !usableBlock(black, i)) continue;
    const m = white.values[i] - black.values[i];
    if (m >= DARK_LIMIT) lit[i] = 1;
    if (m >= cut) {
      crescent.push(i);
      modulation += m;
    }
  }
  return { start, white, black, crescent, modulation, lit };
}

/** How far up from the run's black to its white `f` sits, averaged over the crescent. */
function levelOn(f: FrameFingerprint, w: RunWindow): number {
  let num = 0;
  let den = 0;
  for (const i of w.crescent) {
    if (!usableBlock(f, i)) continue;
    const b = w.black.values[i];
    num += f.values[i] - b;
    den += w.white.values[i] - b;
  }
  return den > 0 ? num / den : Number.NaN;
}

/**
 * The share of `f`'s light, counted up from the run's own black, that falls
 * where the run lights. Null when `f` has no light above that black at all.
 */
function lightInside(f: FrameFingerprint, w: RunWindow): number | null {
  let total = 0;
  let inside = 0;
  for (let i = 0; i < f.values.length; i++) {
    if (!usableBlock(f, i) || !usableBlock(w.black, i)) continue;
    const l = f.values[i] - w.black.values[i];
    if (!(l >= DARK_LIMIT)) continue;
    total += l;
    if (w.lit[i] === 1) inside += l;
  }
  return total > 0 ? inside / total : null;
}

/**
 * The share of the crescent, weighted by modulation, over which `f` stands at
 * least {@link BLACK_CUT} of the way from the run's black to its white.
 *
 * What tells a phase frame of this run from another projector's white when both
 * light only where this run lights: at a fringe fine against the fingerprint's
 * blocks a phase step reads half in every block, so it covers the whole
 * crescent, while a white overlapping part of it covers that part and no more.
 */
function coverage(f: FrameFingerprint, w: RunWindow): number {
  let covered = 0;
  for (const i of w.crescent) {
    if (!usableBlock(f, i)) continue;
    const b = w.black.values[i];
    const m = w.white.values[i] - b;
    if (f.values[i] - b >= BLACK_CUT * m) covered += m;
  }
  return w.modulation > 0 ? covered / w.modulation : 0;
}

/**
 * Whether `f` is another photograph of the same frame `g` of this run: within
 * {@link COMPLEMENT_LIMIT} of it over the crescent — the tolerance a matched
 * pair is held to, applied to the identity `f = g` — and lit where the run is.
 */
function copiesFrame(f: FrameFingerprint, g: FrameFingerprint, w: RunWindow): boolean {
  if (!(w.modulation > 0)) return false;
  const budget = COMPLEMENT_LIMIT * w.modulation;
  let deviation = 0;
  for (const i of w.crescent) {
    if (!usableBlock(f, i) || !usableBlock(g, i)) return false;
    deviation += Math.abs(f.values[i] - g.values[i]);
    if (deviation > budget) return false;
  }
  const inside = lightInside(f, w);
  return inside !== null && inside >= LIGHT_INSIDE;
}

/**
 * Whether frame `g` of run `w` reads flat across the crescent: within what
 * {@link copiesFrame} allows a copy of the run's own white dimmed to the level
 * that comes nearest it — the modulation-weighted median of `g`'s level, block
 * by block. That dimmed white is a test shot of the exposure, and it copies
 * `g`, so a copy of `g` says nothing about which frame or which run a
 * photograph is. A phase step at a fringe finer than the fingerprint's blocks
 * reads a half in every block, and so does the finest Gray plane at the page's
 * grid: a white a stop under copies either.
 */
function readsFlat(g: FrameFingerprint, w: RunWindow): boolean {
  const levels: { level: number; m: number }[] = [];
  for (const i of w.crescent) {
    if (!usableBlock(g, i)) continue;
    const b = w.black.values[i];
    const m = w.white.values[i] - b;
    levels.push({ level: (g.values[i] - b) / m, m });
  }
  levels.sort((a, b) => a.level - b.level);
  let total = 0;
  for (const { m } of levels) total += m;
  let below = 0;
  let median = 0;
  for (const { level, m } of levels) {
    below += m;
    median = level;
    if (below >= total / 2) break;
  }
  let deviation = 0;
  for (const { level, m } of levels) deviation += m * Math.abs(level - median);
  return deviation <= COMPLEMENT_LIMIT * w.modulation;
}

/**
 * Two runs with the same references: the same projector, photographed from the
 * same place. {@link complementResidual} with one run's white and black as the
 * pair and the other's as the reference, both ways round, each within
 * {@link COMPLEMENT_LIMIT} — so the two agree over both crescents, not just one.
 *
 * "The same place" is as near as the limit makes it, and no limit makes it
 * nearer. Measured by `tools/reader-acceptance.ts` on the bench's own
 * photographs: a run shot again from where it stood reproduces its original to
 * 0.002–0.056 over every run placed in EXPERIMENT-10's clean positions, and to
 * 0.022–0.088 with the re-shoot's exposure 2% off; two projectors of one
 * position are at least 0.79 apart. With the camera set turned between the two
 * — EXPERIMENT-10's designed rigs at the reduced preset — a run reproduces its
 * original to 0.009–0.155 at half a degree, 139 of 140 runs within the limit,
 * and to 0.059–2.0 at five, 67 of 140 still within it. A large crescent seen
 * from half a degree away is closer than a grazing one seen again from the same
 * spot, so no one number tells the two apart. What keeps a re-shoot from a
 * camera that moved out of a position is the tripod staying where it stood, not
 * this.
 */
function sameReferences(a: RunWindow, b: RunWindow): boolean {
  const ab = complementResidual(b.white, b.black, a.white, a.black);
  const ba = complementResidual(a.white, a.black, b.white, b.black);
  return ab !== null && ba !== null && ab <= COMPLEMENT_LIMIT && ba <= COMPLEMENT_LIMIT;
}

/**
 * Whether the frames in a window's phase slots are this run's phase steps.
 *
 * With an even step count, step `k` and step `k + N/2` are half a cycle apart,
 * so they are complements exactly as a Gray plane and its inverse are: they sum
 * to white plus black at every pixel whatever the fringe period, and
 * {@link complementResidual} checks that unchanged. Then the steps' contrast
 * over the crescent must be one a cosine can have ({@link PHASE_CONTRAST_LIMIT}).
 *
 * With an odd count there is no step half a cycle from another, so each step
 * has to read between {@link BLACK_CUT} and {@link WHITE_CUT} of the run's own
 * range over its crescent, and the steps together must sum to `N/2` of it
 * block by block. The first holds only while the fringe is fine against the
 * crescent; a coarse odd-step plan is refused rather than read.
 */
function phaseFramesHold(
  fps: readonly FrameFingerprint[],
  w: RunWindow,
  phases: readonly (readonly number[])[],
): boolean {
  for (const set of phases) {
    const n = set.length;
    const frames = set.map((j) => fps[w.start + j]);
    if (n % 2 === 0) {
      const levels = frames.map((f) => levelOn(f, w));
      if (!levels.every(Number.isFinite)) return false;
      // Cheapest first, and never stricter than the identity: two complements
      // sum to white plus black in every block, so their levels over the
      // crescent sum to one whatever else is true. Most windows that are not a
      // run fail here, before the block-by-block check below is asked.
      for (let k = 0; k < n / 2; k++) {
        if (!(Math.abs(levels[k] + levels[k + n / 2] - 1) <= COMPLEMENT_LIMIT)) return false;
      }
      let re = 0;
      let im = 0;
      for (let k = 0; k < n; k++) {
        re += levels[k] * Math.cos((2 * Math.PI * k) / n);
        im -= levels[k] * Math.sin((2 * Math.PI * k) / n);
      }
      if (!((2 / n) * Math.hypot(re, im) <= PHASE_CONTRAST_LIMIT)) return false;
      for (let k = 0; k < n / 2; k++) {
        const r = complementResidual(frames[k], frames[k + n / 2], w.white, w.black);
        if (r === null || r > COMPLEMENT_LIMIT) return false;
      }
      continue;
    }
    for (const f of frames) {
      const level = levelOn(f, w);
      if (!(level >= BLACK_CUT && level <= WHITE_CUT)) return false;
    }
    let deviation = 0;
    let modulation = 0;
    for (const i of w.crescent) {
      if (!frames.every((f) => usableBlock(f, i))) continue;
      const b = w.black.values[i];
      const m = w.white.values[i] - b;
      let sum = 0;
      for (const f of frames) sum += f.values[i] - b;
      deviation += Math.abs(sum - (n / 2) * m);
      modulation += m;
    }
    if (!(modulation > 0 && deviation <= COMPLEMENT_LIMIT * modulation)) return false;
  }
  return true;
}

/**
 * Whether one of the window's Gray pairs separates over the crescent by
 * {@link PAIR_SEPARATION} of its modulation: the plane lit where its
 * complement is not, as a run's coarsest plane always is.
 */
function pairsSeparate(
  fps: readonly FrameFingerprint[],
  w: RunWindow,
  pairs: readonly (readonly [number, number])[],
): boolean {
  for (const [a, b] of pairs) {
    const f = fps[w.start + a];
    const g = fps[w.start + b];
    let apart = 0;
    for (const i of w.crescent) if (usableBlock(f, i) && usableBlock(g, i)) apart += Math.abs(f.values[i] - g.values[i]);
    if (apart >= PAIR_SEPARATION * w.modulation) return true;
  }
  return false;
}

/**
 * The plan and the fingerprints, checked before anything is read from them.
 *
 * Every check {@link indexByFingerprint} also makes is made here in the same
 * words, so a caller moving from one mechanism to the other sees the same
 * refusal for the same fault. `position.test.ts` holds the two to that. The
 * checks that are new are the ones only this mechanism needs.
 */
function positionPlanProblem(
  fingerprints: readonly FrameFingerprint[],
  expected: ExpectedSequence,
): string | null {
  const plan = expected.complements;
  if (plan === undefined || plan.pairs.length === 0) {
    return (
      'This capture plan lists no complementary pairs, so there is nothing for the fingerprint ' +
      'to check and this mechanism would be the bookends wearing its name. Every plan this ' +
      'page emits pairs each Gray plane with its complement, so a plan without them did not ' +
      'come from here.'
    );
  }
  if (!Number.isInteger(expected.projectors) || expected.projectors < 1) {
    return `This capture plan says ${expected.projectors} projectors, and a camera position needs at least one.`;
  }
  const disordered = fingerprints.findIndex((f, i) => f.ordinal !== i);
  if (disordered >= 0) {
    return (
      `The fingerprint at place ${disordered + 1} in the list says it is photograph ` +
      `${fingerprints[disordered].ordinal + 1}. This reader takes the list to be the folder ` +
      'in the order it was shot, so a list that has been reordered would put every run it ' +
      'finds in the wrong place.'
    );
  }
  const runLength = expected.kinds.length;
  const misshapen = fingerprints.findIndex(
    (f) => f.values.length !== f.blocks * f.blocks || f.measured.length !== f.blocks * f.blocks,
  );
  if (misshapen >= 0) {
    const f = fingerprints[misshapen];
    return (
      `Fingerprint ${misshapen + 1} says it is ${f.blocks} blocks across, which needs ` +
      `${f.blocks * f.blocks} values, and carries ${f.values.length} values and ` +
      `${f.measured.length} measured flags. It does not describe the grid it claims.`
    );
  }
  const grid = fingerprints[0]?.blocks;
  if (grid !== undefined && fingerprints.some((f) => f.blocks !== grid)) {
    return (
      'The fingerprints are not all the same grid, so they cannot be compared with each other. ' +
      'They come from one capture read in one pass, so a mixture means two passes have been ' +
      'spliced together.'
    );
  }
  const coarsest = fingerprints.reduce((m, f) => Math.min(m, f.blocks), Number.POSITIVE_INFINITY);
  if (fingerprints.length > 0 && coarsest < plan.minBlocks) {
    return (
      `The fingerprints are ${coarsest} blocks across and this plan needs at least ` +
      `${plan.minBlocks}. Below that the finest Gray plane averages to a flat half in every ` +
      'block, and a frame paired with a duplicate of itself then looks exactly like a correct ' +
      'pair — so this refuses rather than run a check that cannot fail.'
    );
  }
  const outside = plan.pairs.find(([a, b]) => a < 0 || b < 0 || a >= runLength || b >= runLength);
  if (outside !== undefined) {
    return (
      `This capture plan pairs frames ${outside[0] + 1} and ${outside[1] + 1} of a run, and a ` +
      `run here holds ${runLength}. The pairs and the frame kinds describe different runs, so ` +
      'one of the two did not come from the plan that was shot.'
    );
  }
  if (expected.kinds.indexOf('white') < 0 || expected.kinds.indexOf('black') < 0) {
    return (
      'A run of this capture has no white frame, no black frame, or neither, and those two are ' +
      'the reference every complementary pair is compared against. Without them the identity ' +
      'has nothing to be checked against.'
    );
  }
  const phases = expected.phases;
  if (phases === undefined || phases.length === 0) {
    return (
      'This capture plan does not say which frames of a run are phase steps. This reader finds ' +
      'where each run starts by what its phase frames show, so without that it cannot find a ' +
      'run at all.'
    );
  }
  const seen = new Set<number>();
  for (const [a, b] of plan.pairs) {
    seen.add(a);
    seen.add(b);
  }
  seen.add(expected.kinds.indexOf('white'));
  seen.add(expected.kinds.indexOf('black'));
  for (const set of phases) {
    const bad =
      set.length < 3 ||
      set.some((j) => !Number.isInteger(j) || j < 0 || j >= runLength || seen.has(j) || expected.kinds[j] !== 'patterned');
    if (bad) {
      return (
        `This capture plan lists phase steps ${set.map((j) => j + 1).join(', ')} of a run, and ` +
        'they are not three or more patterned frames of a run that no pair and no reference ' +
        'already uses. The phase steps and the rest of the plan describe different runs.'
      );
    }
    for (const j of set) seen.add(j);
  }
  return null;
}

/** "photograph 7" or "photographs 7–40", counted from one. */
function photographs(from: number, to: number): string {
  return to - from <= 1 ? `photograph ${from + 1}` : `photographs ${from + 1}–${to}`;
}

/** "1, 2 and 4". */
function listed(xs: readonly number[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * How to hand in a re-shoot, said with every refusal that asks for one.
 *
 * Play does not stop after the projector asked for: the page plays every later
 * projector's run and then goes black. So what an operator following this adds
 * to the folder is, unless they stop the camera, runs N to P and the dark
 * photographs after them — and that is read: each later run is matched to its
 * projector the same way, and each projector's latest run that passes is used.
 * `position.test.ts` enumerates both shapes. Pausing the page instead of
 * stopping the camera is not the same: the camera photographs the run's last
 * frame again, which is what a frame doubled inside the run looks like.
 */
function handIn(projector: number): string {
  return (
    `To hand the re-shoot in, step the emitter to projector ${projector}'s white (Home goes to ` +
    "the first projector's white and ] to the next projector's), press Play, and add the new " +
    "photographs to the end of this camera position's folder: a re-shot run is matched to its " +
    'projector by comparing it with the photographs already there. Do that only while the camera ' +
    'has not moved since this position was shot, because that comparison cannot tell a camera ' +
    'that moved; once the tripod has moved, shoot the whole camera position again, into a new ' +
    'folder, and read it under the same camera number. The page can be left to play ' +
    "to the end — every later projector's run it shoots again is matched the same way, and each " +
    "projector's latest run that passes is the one used — or the camera stopped once projector " +
    `${projector}'s run is done. Stop the camera, not the page: a paused page is photographed ` +
    "again on the run's last frame, and that reads as one photograph too many."
  );
}

/** Why a run that was found did not pass, without a remedy: for a note, where none is needed. */
function verdictReason(v: RunVerdict, runLength: number): string {
  if (v.kind === 'broken') {
    return (
      `its frames ${v.a + 1} and ${v.b + 1}, a pattern and its complement, miss its own white and ` +
      `black by ${(100 * v.residual).toFixed(0)}% of its modulation, against the ` +
      `${(100 * COMPLEMENT_LIMIT).toFixed(0)}% allowed`
    );
  }
  if (v.kind === 'extra') {
    return (
      `${photographs(v.at, v.at + 1)}, after its last frame, lights only what this projector ` +
      `lights, so it holds ${runLength + 1} photographs where it should hold ${runLength}`
    );
  }
  return 'somewhere in it a pattern and its complement had nothing to be compared over';
}

/** The refusal for a run that was found and did not pass, in the words the older mechanisms use. */
function verdictProblem(v: RunVerdict, projector: number, runLength: number, reshot: boolean): string {
  const who = `Projector ${projector}'s`;
  if (v.kind === 'broken') {
    return (
      `${who} ${reshot ? 're-shot ' : ''}frames ${v.a + 1} and ${v.b + 1} were played as a ` +
      `pattern and its complement, and they no longer add up to one: they miss the run's ` +
      `own white and black by ${(100 * v.residual).toFixed(0)}% of its modulation, ` +
      `against the ${(100 * COMPLEMENT_LIMIT).toFixed(0)}% this allows. The count and the ` +
      `frame kinds are both right, which is what a dropped frame and a duplicated one look ` +
      `like when they cancel inside one run. Re-shoot projector ${projector}. ${handIn(projector)}`
    );
  }
  if (v.kind === 'unanswered') {
    return (
      `${who} ${reshot ? 're-shot ' : ''}run could not be checked: somewhere in it a pattern and its ` +
      'complement had nothing to be compared over — either no part of the frame carries ' +
      'enough modulation to measure against, or one of the photographs came back with no ' +
      'readable pixels at all. The run is dropped rather than passed untested.'
    );
  }
  if (v.kind === 'extra') {
    return (
      `${who} ${reshot ? 're-shot ' : ''}run holds ${runLength + 1} photographs and should hold ` +
      `${runLength}: ${photographs(v.at, v.at + 1)}, after its last frame, lights only what this ` +
      'projector lights, so it is one more of this run rather than the next one, and there is ' +
      'no way to say which of its photographs is the extra. The run is dropped and the rest of ' +
      `the position is unaffected. Re-shoot projector ${projector}. ${handIn(projector)}`
    );
  }
  return '';
}

/**
 * Mechanism 5 — read a whole camera position from its fingerprints alone.
 *
 * The page's reader. It is handed every photograph one camera took, in the
 * order the folder holds them, and works out which run each belongs to and
 * which projector each run is — without classifying the capture as a whole,
 * which is where every earlier mechanism stood and where a sphere seen from one
 * position knocks them over (see {@link classify}).
 *
 * ## How a run is found
 *
 * By content and by the fixed run length, scanning left to right. A window of
 * one run's length is a run when its white and black light a crescent and its
 * phase frames are that crescent's phase steps ({@link phaseFramesHold}). Only
 * the phase frames are asked, because they are the only patterned frames that
 * hold still against the crescent: every Gray plane, and above all the coarse
 * ones, lights whatever share of a crescent the raster happens to put there.
 * After a run is found the scan jumps a whole run, so the windows inside it —
 * which a coarse Gray pair can make look like a start — are never asked.
 *
 * A window that starts anywhere but at a run's white pulls the next run's
 * photographs, or dark ones, into its phase slots, and those are not this
 * crescent's phase steps. That is also how a dropped frame inside a run is
 * seen: the run's window then ends one photograph into the next run.
 *
 * ## How a run is accepted
 *
 * Through {@link complementResidual}, unchanged, over the plan's pairs and in
 * the order {@link indexByFingerprint} asks them, so a run it would refuse for
 * a broken pair this refuses in the same words; and then by asking whether the
 * photograph after the run is more of it ({@link LIGHT_INSIDE}), which is where
 * a duplicated frame inside the run pushes one. A crescent smaller than
 * {@link MIN_CRESCENT_BLOCKS} is noted as barely seen and not checked.
 *
 * ## How runs get their projector numbers
 *
 * From the gaps between runs — `k` runs apart is `k` projectors apart, within
 * {@link SLOT_SLACK} — and from both ends of the folder. Photographs before the
 * first run (not counting copies of its own white, the step the page shows
 * before Play) number `R·a` for the `a` projectors before it, plus a pre-roll;
 * photographs after the last run number `R` per projector after it, plus the
 * dark ones taken after the screen went black. Those counts are held to lower
 * bounds only, and every first projector they allow is a reading of the folder:
 * forty-two dark photographs at one end can hide a projector out of view as
 * well as not, and an upper bound there would exclude the true numbering and
 * leave a false one alone to be used. A numbering is used only if it is the
 * only one the ends allow AND its extras keep inside the page's allowance
 * for them — under a run each, overrun by a further quarter of a run, since
 * forty at one end with one lost at the other reads, by count, exactly like a
 * folder numbered a projector over. A folder allowing more than one is refused
 * rather than guessed at; so is a folder that counts only with more extras
 * than that, which is also what a lost run looks like.
 *
 * The ends are looked at as well as counted. A photograph there is an extra
 * when something says what it is: dark beside the run next to it; a copy of
 * the white of a run found — the page's step 0 shown before Play, a test shot
 * of the exposure, the white a re-shoot starts from; a copy of a frame of the
 * run next to it, or after the last run of any run found. Lit photographs
 * nothing accounts for, more than {@link SLOT_SLACK} strays, that lead straight
 * into a numbering's first run or follow straight on from its last, are a run
 * the page was playing there where they show a run's structure: two of them
 * each lit, by the decoder's floor, where the other is not, over as many
 * blocks as the smallest crescent this reads — a Gray plane and its
 * complement, two planes, two phase steps. Then that numbering is not used: it
 * took the end of a run the camera was started in the middle of for
 * photographs before Play, or a run it could not find for photographs after
 * the black, and every run was filed a projector over. Light that changes only
 * in level between photographs — the room's switched on or off, a lamp
 * warming, a door, a white bracketed about the exposure — moves every block
 * the same way, and is set aside; light that stays on under a run cancels
 * between two of its photographs, and hides nothing. Such a numbering still
 * takes part in the disagreement below, as does one kept out by the allowance,
 * so it can refuse a folder but never be the numbering used.
 *
 * Between numbered runs, a stretch of `R` dark photographs is a projector the
 * camera could not see — a note, never a refusal — and one with light in it is
 * a run that could not be found, refused loudly with the projector it belongs
 * to, or noted barely seen where it lights fewer than
 * {@link MIN_CRESCENT_BLOCKS} blocks. Not the slot the front of the folder cuts
 * short, though: a camera started after Play took its white first, the run's
 * brightest photograph, and what is left cannot say the projector lights too
 * little to find, so lit at all it is refused. Dark there is judged against the stretch's own photographs, block by
 * block, and the folder's end against the last run's black — the page painting
 * every quadrant black, photographed by this camera — never against the folder
 * as a whole: room light that came on or went off elsewhere in the folder, or
 * a slow drift across it, then moves neither. A stretch whose light brightens
 * the same part of the picture by about the same amount in every lit
 * photograph is refused with the room's light named as the likely cause: a
 * projector's patterns light its crescent in turn, and at different levels. A
 * stretch that is not within {@link SLOT_SLACK} of whole runs ends the count:
 * the runs before it keep their numbers, and nothing after it is used or said
 * to be out of view.
 *
 * ## Re-shoots
 *
 * A run whose white and black match an earlier run's ({@link sameReferences})
 * is that projector again: on a sphere no two projectors photograph alike, so
 * two runs with the same references are never two projectors. After the
 * position it is a re-shoot added to the folder, matched to its original by
 * references (one match only) or — when the original was too broken to be
 * found — by the photographs of the original's stretch that copy its frames,
 * each placed to within {@link SLOT_SLACK} of a slot's edge. Inside the
 * position it is the page stepped back to that projector and played on (Pause,
 * `[`, Play): the count goes on from the projector it repeats, every run after
 * it that repeats another has to be where the count puts it, and a run that
 * repeats nothing cannot land on a projector the earlier pass already holds a
 * run of. The latest run of a projector that passes is used, and a replaced
 * original is noted; a re-shoot after the run used that did not pass is noted
 * too, since the run used passed and there is nothing to re-shoot. A run that
 * matches nothing, or more than one projector, is refused: the usual reason is
 * that the camera moved between the two; with a whole camera position's worth
 * of photographs after it, the folder holds two positions and is told to be
 * split. A reading that takes such a run for a re-shoot added after the
 * position is not used where the run follows the one before it straight on,
 * with no dark photograph between — its own white shown before Play set aside:
 * the page ends a position by painting black, and a run where the next one
 * would stand is more likely the position's own, counted past its end. A
 * folder too short to be a camera position — a re-shoot handed in on
 * its own — is refused with how to hand it in, and one whose every run found
 * repeats a run that could not be read has nothing to number a re-shoot by,
 * and is refused too.
 *
 * The page does not stop after the projector a refusal asks for: Play runs on
 * through every later projector and then goes black. So what a re-shoot adds is
 * usually runs N to P, the later projectors dark where this camera cannot see
 * them, with photographs of N's white before them and dark ones after — and
 * every run of it is matched the same way. `position.test.ts` enumerates that
 * shape, the one where the camera was stopped after N's run, and the in-line
 * re-shoot.
 *
 * Which runs are re-shoots is decided by trying every reading — the last `t`
 * runs found as re-shoots added after the position, for every `t`, each with
 * every first projector the ends allow — and keeping those that fit: the
 * position's runs numbered, each re-shoot matched or past the position's end,
 * and no run copied by photographs in another projector's place. A copy says
 * where a run belongs only inside a slot, and only of a frame with a pattern at
 * the fingerprint's resolution: a frame that reads flat across the crescent —
 * a phase step, and on the page's plan the finest Gray planes — is copied by
 * a white at another exposure. Before the first slot the camera was being set
 * up, and the few photographs there that copy a run are test shots, of any
 * frame at any exposure, set aside; more than {@link SLOT_SLACK} copying one
 * run are that run played, and name the first slot, since before Play the page
 * plays only the first projector's run. Content alone would do on a sphere;
 * counting alone would file a re-shoot whose projectors in between were out of
 * view under one of them. When the readings that fit disagree about a run, none
 * is used. A reading whose count has a stretch that is not whole runs is set
 * aside for one without — a re-shoot added after the position always leaves
 * such a stretch before it, read as the position's — except where that one
 * takes a run it cannot match for a re-shoot after the position's end: then
 * both are asked, since that is also how a genuine run looks once the count has
 * put it there.
 *
 * ## What it still refuses, and what it cannot see
 *
 * Everything the complement check cannot see, it cannot see either: a drop and
 * a duplicate cancelling inside the phase block at a fringe finer than the
 * fingerprint's blocks leave every identity intact (see
 * {@link indexByFingerprint}). Two more cancelling pairs pass because nothing
 * that reads photographs could refuse them. A photograph that matches the one
 * it displaced over the crescent — a black standing in for a Gray plane that
 * lights none of it — is the same run to within what the complement check
 * allows. And a black shot twice with the first Gray plane's complement
 * dropped, where that plane lights the whole crescent, swaps the plane and its
 * complement: photographically, the same run seen from the other half of the
 * raster. `position.test.ts` pins how rare each is.
 *
 * It trusts the photographs to be one camera's, every one of them, in shooting
 * order. A camera that moved between runs is a different position, and nothing
 * here can tell. A run deleted from the folder is invisible too: the runs after
 * it count one projector early, and when the extras at the ends absorb the
 * missing run's photographs — a re-shoot appended in its place, or thirty-odd
 * dark photographs after the black — they are filed under the wrong projectors
 * with nothing in the folder to say so. Counting is the only thing that numbers
 * a run, so the page tells the operator never to delete a photograph. Two
 * projectors that photograph alike — stacked on one mount — are outside it as
 * well: the second reads as the first shot again, which no reading of a
 * position fits, and the folder is refused.
 *
 * Nor can it tell how many photographs an end lost where the end is dark: a
 * projector this camera cannot see there, or the page's black, looks the same
 * cut short or whole. A position that lost four or more photographs at a dark
 * end — its camera started after Play, or stopped before the page's end, which
 * from here can look like the sphere going dark while a projector it cannot see
 * plays on — and that holds thirty-one or more dark extras at the other end, a
 * run and the allowance at most, reads, by count, exactly like one numbered a
 * projector over, and it is filed wrongly. (Extras lit by the page's first
 * step, shot before Play, put light where that numbering needs a projector out
 * of view, and it is refused.) One with a run's worth of dark photographs added
 * inside — a projector this camera cannot see played twice, or the page paused
 * a minute in its run — is filed wrongly too when the last projector is out of
 * view as well: its dark run reads as photographs taken after the black, with
 * no extras needed at all. And a remnant of three photographs or fewer at an
 * end is taken for strays. Nothing in the photographs says otherwise, so the
 * page's instructions are the defence: start the camera before Play, stop it
 * only at the page's end tone — not when the sphere goes dark on the camera's
 * side — and stop the camera rather than pause the page.
 */
export function indexPosition(
  fingerprints: readonly FrameFingerprint[],
  expected: ExpectedSequence,
): PositionIndexing {
  const n = fingerprints.length;
  const runLength = expected.kinds.length;
  const projectors = expected.projectors;
  const problems: string[] = [];
  const notes: string[] = [];
  const refuse = (): PositionIndexing => ({
    ok: false,
    assignment: fingerprints.map(() => null),
    usableProjectors: [],
    unseenProjectors: [],
    barelySeenProjectors: [],
    reshoots: [],
    problems,
    notes,
    mechanism: 'position',
  });

  const invalid = positionPlanProblem(fingerprints, expected);
  if (invalid !== null) {
    problems.push(invalid);
    return refuse();
  }
  const pairs = (expected.complements as ComplementPlan).pairs;
  const phases = expected.phases as readonly (readonly number[])[];
  const whiteAt = expected.kinds.indexOf('white');
  const blackAt = expected.kinds.indexOf('black');

  if (n === 0) {
    problems.push(
      'The folder holds no photographs, so there is nothing to index. A camera position is ' +
        `every projector's run shot back to back — ${projectors} of them, ${runLength} frames each.`,
    );
    return refuse();
  }
  const minimum = runLength * projectors - SLOT_SLACK;
  if (n < minimum) {
    problems.push(
      `The folder holds ${n} photographs, and a whole camera position is ${projectors} ` +
        `projector runs of ${runLength} — at least ${minimum} even with a few missing. This looks ` +
        'like part of a position: a re-shoot of one projector handed in on its own, or a ' +
        'position missing photographs. A re-shot run is matched to its projector by comparing ' +
        "it with the position's own photographs, so it has to be added to the end of that " +
        "camera position's folder, not handed in alone. Hand in every photograph the camera " +
        'took, the dark ones included: they are how the projectors this camera cannot see are ' +
        'counted. And if the camera was started after Play, or stopped before the page had ' +
        "played to its end — the sphere goes dark on the camera's side while a projector this " +
        'camera cannot see is playing — shoot the whole camera position again, into a folder of ' +
        'its own, and read it under the same camera number.',
    );
    return refuse();
  }

  // ---- dark, judged where it is looked at
  //
  // A run is found by its own white against its own black, a slot with no run
  // is judged against its own photographs, and the photographs after the last
  // run against that run's black, so light that comes and goes in the room
  // elsewhere in the folder moves none of them. The folder's floor is left to a
  // folder with no run in it at all, and to a slot too short to have a floor
  // of its own.
  const cells = fingerprints[0].values.length;
  // Worked out when first asked for: most folders never need it.
  let floorOnce: Float64Array | null = null;
  const folderDark = (): Float64Array => (floorOnce ??= folderFloor(fingerprints, cells));
  let litOnce: number[] | null = null;
  const isLit = (x: number): boolean => (litOnce ??= fingerprints.map((f) => litCountOf(f, folderDark())))[x] > 0;
  /**
   * Whether photograph x is dark beside a run's black: the page painting every
   * quadrant black, photographed by this camera at that time. The nearest
   * dark this camera is known to have seen, so room light elsewhere in the
   * folder, or a slow drift across it, does not decide it.
   */
  const darkBeside = (x: number, w: RunWindow): boolean => {
    const f = fingerprints[x];
    for (let i = 0; i < cells; i++) {
      if (usableBlock(f, i) && usableBlock(w.black, i) && f.values[i] - w.black.values[i] >= DARK_LIMIT) return false;
    }
    return true;
  };

  // ---- runs, found by content, left to right
  const found: RunWindow[] = [];
  for (let s = 0; s + runLength <= n; ) {
    const w = runWindowAt(fingerprints, s, whiteAt, blackAt);
    if (
      w === null ||
      w.crescent.length === 0 ||
      !phaseFramesHold(fingerprints, w, phases) ||
      !pairsSeparate(fingerprints, w, pairs)
    ) {
      s++;
      continue;
    }
    found.push(w);
    s += runLength;
  }

  if (found.length === 0) {
    if (!fingerprints.some((_, x) => isLit(x))) {
      problems.push(
        `Every one of the ${n} photographs is the same picture, to within ${DARK_LIMIT} of the ` +
          "folder's own floor, so no projector's sequence was photographed: the page was not " +
          "playing while the camera ran, no projector was in this camera's view, or the lens cap " +
          'was on.',
      );
    } else {
      problems.push(
        `No projector run could be found in the ${n} photographs: nowhere do a white, a black ` +
          `and the plan's phase frames sit where a run of ${runLength} puts them. That is what a ` +
          'folder from another plan, a camera that moved during the run, or photographs not in ' +
          'the order they were shot look like. Nothing is filed under a projector rather than ' +
          'guessed at.',
      );
    }
    return refuse();
  }

  // ---- each found run's own verdict
  const startsAt = new Set(found.map((w) => w.start));
  const verdictOf = (w: RunWindow, i: number): RunVerdict => {
    if (w.crescent.length < MIN_CRESCENT_BLOCKS) return { kind: 'barely', blocks: w.crescent.length };
    let unanswered = false;
    for (const [a, b] of pairs) {
      const residual = complementResidual(
        fingerprints[w.start + a],
        fingerprints[w.start + b],
        w.white,
        w.black,
      );
      if (residual === null) {
        unanswered = true;
        continue;
      }
      if (residual > COMPLEMENT_LIMIT) return { kind: 'broken', a, b, residual };
    }
    if (unanswered) return { kind: 'unanswered' };
    // Not more of this run: the photograph after it is normally the next run's
    // white, dark, or the end of the folder. One that lights only what this run
    // lights, and lights most of the crescent the way a phase step does, is the
    // frame a duplicate inside the run pushed out of it — at a fingerprint too
    // coarse to resolve the fringe, which is the only place a duplicated phase
    // frame gets past the phase-step identities, a phase step covers the whole
    // crescent at half its range.
    const after = w.start + runLength;
    if (after < n && !startsAt.has(after)) {
      // Copies of the next run's white leading straight to it are that white
      // shot more than once — before Play, for a re-shoot of this run — and
      // not a spare frame of this one, however much of this run's light the
      // next projector's white falls inside.
      const next = found[i + 1];
      let x = after;
      if (next !== undefined) while (x < next.start && copiesFrame(fingerprints[x], next.white, next)) x++;
      if (next === undefined || x !== next.start) {
        const f = fingerprints[after];
        const inside = lightInside(f, w);
        if (
          inside !== null &&
          inside >= LIGHT_INSIDE &&
          levelOn(f, w) >= BLACK_CUT &&
          coverage(f, w) >= PHASE_COVERAGE
        ) {
          return { kind: 'extra', at: after };
        }
      }
    }
    return { kind: 'ok' };
  };
  const verdicts = found.map(verdictOf);

  // ---- which runs repeat an earlier one
  const inWindow = new Uint8Array(n);
  for (const w of found) for (let f = 0; f < runLength; f++) inWindow[w.start + f] = 1;
  const matchedBy: number[][] = found.map(() => []);
  for (let j = 0; j < found.length; j++) {
    for (let i = 0; i < j; i++) if (sameReferences(found[i], found[j])) matchedBy[j].push(i);
  }
  // A run whose white and black match an earlier run's is that projector
  // again: on a sphere two projectors never photograph alike. After the
  // position it is a re-shoot added to the folder; inside it, the page stepped
  // back to that projector and played on — an in-line re-shoot — and the count
  // of projectors goes on from it.
  const repeats = found.map((_, j) => matchedBy[j].length > 0);
  // Photographs outside every run found that copy one of run j's frames: the
  // stretch of an original too broken to be found, when j is its re-shoot.
  // Copies of j's white straight before it are its pre-roll, and every copy of
  // its white before the first run found is the page's step 0 shown before
  // Play, for the first run, or a test shot of the exposure, for a later one —
  // neither says where run j belongs. Nor does a copy of a frame that reads
  // flat across the crescent: a test shot of any projector's white at another
  // exposure copies it, and on the page's plan a white a stop under copies
  // every phase step and the finest Gray planes.
  /**
   * Each run's frames a copy of it would show: its white, and the pairs and
   * phase steps that light its crescent in a pattern no dimmed white copies.
   */
  const distinctiveOf = found.map((w) => [
    w.white,
    ...[...new Set([...pairs.flat(), ...phases.flat()])]
      .map((f) => fingerprints[w.start + f])
      .filter((g) => levelOn(g, w) >= BLACK_CUT && !readsFlat(g, w)),
  ]);
  const evidence: number[][] = found.map((w, j) => {
    let firstOwn = w.start;
    while (firstOwn > 0 && copiesFrame(fingerprints[firstOwn - 1], w.white, w)) firstOwn--;
    const out: number[] = [];
    for (let x = 0; x < firstOwn; x++) {
      // A copy lights something above this run's black, as copiesFrame asks;
      // a photograph dark beside it copies nothing, and is not asked.
      if (inWindow[x] === 1 || darkBeside(x, w)) continue;
      if (x < found[0].start && copiesFrame(fingerprints[x], w.white, w)) continue;
      if (distinctiveOf[j].some((g) => copiesFrame(fingerprints[x], g, w))) out.push(x);
    }
    return out;
  });
  /**
   * A photograph before the first run that copies run j's white: a test shot of
   * that projector's white, taken while the exposure was set. Like the page's
   * step 0 it says nothing about where run j belongs, so no run's evidence holds
   * one; it is counted for the note that sets it aside.
   */
  const testShot = (x: number, j: number): boolean =>
    x < found[0].start && copiesFrame(fingerprints[x], found[j].white, found[j]);

  /**
   * Whether lit photographs changed the way a room changes rather than the way
   * a projector's patterns do. A run lights its crescent in turn and at
   * different levels — a pattern, then its complement; the white at full, the
   * phase steps about half — so its photographs share few lit blocks, and those
   * at levels a factor of two apart. Light that brightens the same part of the
   * picture in every photograph that is lit at all, by about the same amount,
   * is the room's. `dark` is what each block reads unlit there.
   */
  const roomLike = (litPhotos: readonly { f: FrameFingerprint; blocks: Set<number> }[], dark: ArrayLike<number>): boolean => {
    const lit = new Set<number>();
    for (const { blocks } of litPhotos) for (const b of blocks) lit.add(b);
    let shared = litPhotos.length >= 2 ? new Set(litPhotos[0].blocks) : new Set<number>();
    for (const { blocks } of litPhotos.slice(1)) shared = new Set([...shared].filter((b) => blocks.has(b)));
    const rises = litPhotos.map(({ f }) => {
      let sum = 0;
      for (const b of shared) sum += f.values[b] - dark[b];
      return sum / Math.max(1, shared.size);
    });
    return shared.size > 0 && 2 * shared.size >= lit.size && Math.max(...rises) <= 1.5 * Math.min(...rises);
  };

  // ---- what lies at the ends of the folder
  //
  // Photographs before the first run and after the last are extras only when
  // something says what they are: dark beside the run next to them — the page's
  // black, or a projector this camera cannot see — a copy of a white of a run
  // found (the page's step 0 shown before Play, a test shot of the exposure, the
  // white a re-shoot starts from), a copy of any frame of the run next to them
  // (an attempt at it the page was stepped back from, a page paused on one of
  // its frames), or after the last run a copy of any frame of any run found (a
  // re-shoot of that run which did not pass). What is left is lit, and it is
  // part of a run the reader could not find only where it shows a run's
  // structure (showsARun): light that changes only in level is the room's, or
  // a test shot's. Before the first run, a copy of a later run's frame is that
  // run's original, too broken to be found.
  /**
   * The lit photographs in `[from, to)` that nothing above accounts for; `near`
   * is the run next to them, and `anyRun` whether a copy of any run's frame is
   * set aside or only of `near`'s.
   */
  const unexplainedLit = (from: number, to: number, near: RunWindow, anyRun: boolean): number[] => {
    const lit: number[] = [];
    const framesOf = anyRun ? found.map((_, j) => j) : [found.indexOf(near)];
    for (let x = from; x < to; x++) {
      if (inWindow[x] === 1 || darkBeside(x, near)) continue;
      const f = fingerprints[x];
      const copy =
        found.some((w) => copiesFrame(f, w.white, w)) ||
        framesOf.some((j) => distinctiveOf[j].some((g) => copiesFrame(f, g, found[j])));
      if (!copy) lit.push(x);
    }
    return lit;
  };
  const frontLit = unexplainedLit(0, found[0].start, found[0], false);
  /**
   * Whether photographs show a run's structure: two of them, no more than a
   * run apart, each lighting {@link MIN_CRESCENT_BLOCKS} blocks or more at
   * least {@link DARK_LIMIT} above the other — a Gray plane and its complement,
   * two planes, two phase steps, lighting different parts of a crescent. Light
   * that changes only in level between photographs — the room's switched on or
   * off, a lamp warming up, a door opening on the same wall, a test shot of a
   * white at another exposure — brightens every block the same way from one
   * photograph to the next, and light that stays on, the room's under a run,
   * cancels in the difference.
   */
  const showsARun = (xs: readonly number[]): boolean => {
    for (let a = 0; a < xs.length; a++) {
      const f = fingerprints[xs[a]];
      for (let b = a + 1; b < xs.length && xs[b] - xs[a] < runLength; b++) {
        const g = fingerprints[xs[b]];
        let brighter = 0;
        let dimmer = 0;
        for (let i = 0; i < cells; i++) {
          if (!usableBlock(f, i) || !usableBlock(g, i)) continue;
          const d = f.values[i] - g.values[i];
          if (d >= DARK_LIMIT) brighter++;
          else if (-d >= DARK_LIMIT) dimmer++;
        }
        if (brighter >= MIN_CRESCENT_BLOCKS && dimmer >= MIN_CRESCENT_BLOCKS) return true;
      }
    }
    return false;
  };

  // ---- how the position's runs are numbered
  //
  // From the gaps between runs — `k` runs apart is `k` projectors apart, within
  // SLOT_SLACK — and from both ends of the folder. The ends are judged by lower
  // bounds only: the photographs before the first run and after the last must
  // be enough for the projectors before and after, and nothing caps how many
  // more there may be. Every first projector those bounds allow is a reading of
  // the folder, so a folder whose extras overrun at one end is read both ways
  // and refused, rather than the overrun excluding the true numbering and
  // leaving a false one unique. A numbering is used only if it is the only one
  // AND its extras keep inside the page's allowance for photographs before
  // Play and after the screen goes black, overrun by a further quarter of a
  // run: forty photographs at one end with one lost at the other read, by
  // count, exactly like a folder numbered a projector over.
  const allowance = runLength - 1 + Math.floor(runLength / 4);
  interface Count {
    t: number;
    /** The position's runs from the start of the folder. */
    pass1: RunWindow[];
    /**
     * From the first run that repeats an earlier one to run `t`: the page
     * stepped back to that projector and played on. Its runs are numbered on
     * from the run it repeats.
     */
    pass2: RunWindow[];
    /** Each numbered run's projector, counted from pass 1's first run. */
    rel: Map<RunWindow, number>;
    /** Pass-1 runs numbered; those after a stretch that is not whole runs are not. */
    numberedCount: number;
    gapProblem: string | null;
    /** The first run's projectors the ends allow, by their lower bounds. */
    candidates: number[];
    /** Those whose extras also keep inside the allowance. */
    within: number[];
    /** Where the stretch after the last numbered run ends: the next run found, the first re-shoot, or the end of the folder. */
    backLimit: number;
    /** The last numbered run in shooting order, from which the end is counted. */
    last: RunWindow;
    /** Photographs before the first run, copies of its white left out, and after the last. */
    before: number;
    after: number;
  }
  // Every reading's first run is the first run found.
  let whiteCopiesBeforeFirst = 0;
  for (let x = 0; x < found[0].start; x++) {
    if (copiesFrame(fingerprints[x], found[0].white, found[0])) whiteCopiesBeforeFirst++;
  }
  const countPosition = (t: number): Count | null => {
    const runs = found.slice(0, t);
    const restart = runs.findIndex((_, j) => repeats[j]);
    const pass1 = restart < 0 ? runs : runs.slice(0, restart);
    const pass2 = restart < 0 ? [] : runs.slice(restart);
    const rel = new Map<RunWindow, number>([[pass1[0], 0]]);
    let numberedCount = pass1.length;
    let gapProblem: string | null = null;
    let gapExcess = 0;
    for (let j = 1; j < pass1.length; j++) {
      const gap = pass1[j].start - pass1[j - 1].start;
      const k = Math.round(gap / runLength);
      if (Math.abs(gap - runLength * k) > SLOT_SLACK) {
        gapExcess = Math.abs(gap - runLength * k);
        const from = pass1[j - 1].start + runLength;
        const stretch = photographs(from, pass1[j].start);
        // Finished where it is pushed, which knows the projectors it cost.
        gapProblem =
          `${stretch[0].toUpperCase()}${stretch.slice(1)} lie between two runs, and ` +
          `${gap - runLength} photographs is not within ${SLOT_SLACK} of a whole number of runs ` +
          `of ${runLength}, so the projector numbers after ${photographs(from, from + 1)} ` +
          'cannot be worked out';
        numberedCount = j;
        break;
      }
      rel.set(pass1[j], (rel.get(pass1[j - 1]) as number) + k);
    }
    if (pass2.length > 0) {
      // Nothing is counted across a stretch that is not whole runs, and a pass
      // played on from inside it would have to be.
      if (numberedCount < pass1.length) return null;
      // The page stepped back to the projector the first repeat repeats — one
      // projector, or the repeat is not one.
      const anchor = new Set(matchedBy[restart].map((i) => rel.get(found[i])));
      if (anchor.size !== 1 || anchor.has(undefined)) return null;
      rel.set(pass2[0], [...anchor][0] as number);
      const held = new Set(pass1.map((w) => rel.get(w)));
      for (let j = 1; j < pass2.length; j++) {
        const gap = pass2[j].start - pass2[j - 1].start;
        const k = Math.round(gap / runLength);
        if (Math.abs(gap - runLength * k) > SLOT_SLACK) return null;
        const slot = (rel.get(pass2[j - 1]) as number) + k;
        const i = found.indexOf(pass2[j]);
        // A repeat has to be where the count puts the run it repeats, and a run
        // that repeats nothing cannot be a projector pass 1 already holds a run
        // of: the page does not play two projectors' runs in one slot.
        if (repeats[i] ? !matchedBy[i].every((m) => rel.get(found[m]) === slot) : held.has(slot)) return null;
        rel.set(pass2[j], slot);
      }
    }
    const numbered1 = pass1.slice(0, numberedCount);
    const last = pass2.length > 0 ? pass2[pass2.length - 1] : numbered1[numbered1.length - 1];
    const lastRel = rel.get(last) as number;
    let span = 0;
    for (const v of rel.values()) span = Math.max(span, v);
    const before = found[0].start - whiteCopiesBeforeFirst;
    const tailStart = t < found.length ? found[t].start : null;
    const lastEnd = last.start + runLength;
    const backLimit = numberedCount < pass1.length ? pass1[numberedCount].start : tailStart ?? n;
    // The position's photographs run to the first re-shoot or the end of the
    // folder. Past a stretch that is not whole runs they are still the later
    // projectors' — what is lost is where each one starts, by the stretch's
    // excess, which the end's count is then allowed.
    const after = (tailStart ?? n) - lastEnd;
    // Light after the last numbered run is a run that could not be found, which
    // the count after it cannot tell from projectors this camera does not see —
    // so then the end is not held to the allowance either.
    let backIsDark = tailStart === null;
    for (let x = lastEnd; backIsDark && x < n; x++) if (!darkBeside(x, last)) backIsDark = false;
    const candidates: number[] = [];
    const within: number[] = [];
    for (let a = 0; a + span <= projectors - 1; a++) {
      const front = before - runLength * a;
      const back = after - runLength * (projectors - 1 - (a + lastRel));
      if (front < -SLOT_SLACK || back < -SLOT_SLACK - gapExcess) continue;
      candidates.push(a);
      if (front <= allowance && (!backIsDark || back <= allowance)) within.push(a);
    }
    return { t, pass1, pass2, rel, numberedCount, gapProblem, candidates, within, backLimit, last, before, after };
  };

  // ---- readings: which runs are the position's own and which are re-shoots
  //
  // Every reading is tried — the last `t` runs found as re-shoots added after
  // the position, for every `t`, and each first projector the ends allow — and
  // kept where it fits: the position's runs numbered, each re-shoot matched to
  // one projector or starting after the position's photographs end, and no run
  // copied by photographs in another projector's place. If the readings that
  // fit disagree about any run, none is used.
  /**
   * What keeps a reading that fits from being used: the ends allow another
   * numbering, its extras overrun the allowance, lit photographs no run was
   * found in lead straight into its first run or follow straight on from its
   * last, or its first re-shoot matches nothing and follows the position with
   * no black between.
   */
  type Doubt =
    | { kind: 'count' }
    | { kind: 'allowance' }
    | { kind: 'front' | 'back'; strays: number[] }
    | { kind: 'tail'; run: RunWindow };
  interface Reading {
    t: number;
    /** Null where no run of the position was found: it is everything before the first run. */
    count: Count | null;
    a0: number;
    /**
     * The only numbering the ends allow, inside the allowance, and nothing at an
     * end or before a re-shoot it cannot match that says the count is a run out.
     */
    acceptable: boolean;
    /** Why a reading is not acceptable: what a refusal of it names. Null when it is. */
    doubt: Doubt | null;
    slotOf: Map<RunWindow, number>;
    /** The position's runs that repeat an earlier run: in-line re-shoots. */
    inLine: Set<RunWindow>;
    /** Where each projector's photographs are — the latest the page showed — by the runs either side. */
    range: ({ from: number; to: number } | null)[];
    /** Where the position's photographs end and a re-shoot's may begin. */
    positionEnd: number;
    /** Each re-shot run's projector, or null where it matches none or several. */
    tailProjector: Map<RunWindow, number | null>;
    tailWhy: Map<RunWindow, string>;
  }
  const layout = (c: Count, a0: number): Pick<Reading, 'slotOf' | 'inLine' | 'range' | 'positionEnd'> => {
    const slotOf = new Map<RunWindow, number>();
    for (const [w, r] of c.rel) slotOf.set(w, a0 + r);
    const inLine = new Set(c.pass2.filter((w) => repeats[found.indexOf(w)]));
    const range: ({ from: number; to: number } | null)[] = Array.from({ length: projectors }, () => null);
    // Each pass lays out its own slots: its runs, the slots between them and,
    // for the pass the page played to the end, the slots after its last run.
    // Pass 2 comes second, so where both hold a slot, its photographs — the
    // latest the page showed — are the ones kept.
    const lay = (runs: readonly RunWindow[], toEnd: boolean): void => {
      for (const w of runs) range[slotOf.get(w) as number] = { from: w.start, to: w.start + runLength };
      for (let j = 0; j + 1 < runs.length; j++) {
        const from = runs[j].start + runLength;
        const to = runs[j + 1].start;
        const s0 = slotOf.get(runs[j]) as number;
        const missing = (slotOf.get(runs[j + 1]) as number) - s0 - 1;
        for (let t = 0; t < missing; t++) {
          range[s0 + 1 + t] = { from: from + t * runLength, to: t === missing - 1 ? to : from + (t + 1) * runLength };
        }
      }
      if (!toEnd) return;
      const lastSlot = slotOf.get(runs[runs.length - 1]) as number;
      const lastEnd = runs[runs.length - 1].start + runLength;
      for (let q = lastSlot + 1; q < projectors; q++) {
        range[q] = {
          from: Math.min(c.backLimit, lastEnd + (q - lastSlot - 1) * runLength),
          to: Math.min(c.backLimit, lastEnd + (q - lastSlot) * runLength),
        };
      }
    };
    const numbered1 = c.pass1.slice(0, c.numberedCount);
    // Before the first run the slots are laid back from it.
    const first = numbered1[0];
    for (let q = 0; q < a0; q++) {
      range[q] = {
        from: Math.max(0, first.start - (a0 - q) * runLength),
        to: Math.max(0, first.start - (a0 - q - 1) * runLength),
      };
    }
    // After a stretch that is not whole runs nothing says where the later
    // slots are, so they are left without a place rather than given a wrong
    // one: a slot laid out there would call a run that was found but not
    // numbered out of view, or broken.
    lay(numbered1, c.pass2.length === 0 && c.numberedCount === c.pass1.length);
    if (c.pass2.length > 0) lay(c.pass2, true);
    const lastSlot = slotOf.get(c.last) as number;
    return { slotOf, inLine, range, positionEnd: c.last.start + runLength + (projectors - 1 - lastSlot) * runLength };
  };
  const slotIn = (range: Reading['range'], x: number): number | null => {
    for (let q = 0; q < projectors; q++) {
      const r = range[q];
      if (r !== null && x >= r.from && x < r.to) return q;
    }
    return null;
  };
  /**
   * The slot a photograph copying run j's frames names in a reading: the one it
   * lies in, or none. Before the first slot the page showed step 0 while the
   * camera was set up, and a few copies there are test shots, which say nothing
   * about where run j belongs — a focus shot of its stripes, a test of the
   * exposure. More than {@link SLOT_SLACK} of them are run j played, and before
   * the position the page plays only the first projector's run — step 0 is its
   * white, and Play starts from it — so they name the first slot: an attempt at
   * that run the page was stepped back from or, in a reading that has put run j
   * somewhere else, its original. A broken first run's own photographs lie
   * inside the first slot, and name it as they stand.
   */
  const slotOfCopy = (range: Reading['range'], j: number, x: number): number | null => {
    const q = slotIn(range, x);
    const first = range[0];
    if (q !== null || first === null || x >= first.from) return q;
    return evidence[j].filter((y) => y < first.from).length > SLOT_SLACK ? 0 : null;
  };
  const matchTail = (
    tail: readonly RunWindow[],
    where: Pick<Reading, 'slotOf' | 'range' | 'positionEnd'>,
  ): Pick<Reading, 'tailProjector' | 'tailWhy'> | null => {
    const tailProjector = new Map<RunWindow, number | null>();
    const tailWhy = new Map<RunWindow, string>();
    for (const w of tail) {
      const j = found.indexOf(w);
      const byRef = [
        ...new Set(
          matchedBy[j]
            .map((i) => found[i])
            .map((q) => (where.slotOf.has(q) ? where.slotOf.get(q) : tailProjector.get(q)))
            .filter((q): q is number => q !== undefined && q !== null),
        ),
      ];
      let projector: number | null = null;
      let why = 'matches no projector';
      if (byRef.length === 1) projector = byRef[0];
      else if (byRef.length > 1) why = 'matches more than one projector';
      else {
        // The original is where the photographs that copy this run lie. One
        // within SLOT_SLACK of a slot's edge could be either side's: a broken
        // run is that many photographs longer or shorter than a slot, and the
        // layout gives a stretch's excess to its last slot. So each photograph
        // names the slots near it, and the original is the one they all name.
        // A photograph in no slot at all — between the passes of a position
        // stepped back, or past its end — names none and is not asked.
        const near = evidence[j]
          .map((x) => {
            const slots = new Set<number>();
            for (let d = -SLOT_SLACK; d <= SLOT_SLACK; d++) {
              const q = slotOfCopy(where.range, j, x + d);
              if (q !== null) slots.add(q);
            }
            return slots;
          })
          .filter((slots) => slots.size > 0);
        if (near.length > 0) {
          const shared = [...near[0]].filter((q) => near.every((slots) => slots.has(q)));
          if (shared.length === 1) {
            const q = shared[0];
            if ([...where.slotOf.values()].includes(q)) {
              why = 'copies photographs of a projector whose own run it does not match';
            } else projector = q;
          } else why = 'copies photographs of more than one projector';
        }
      }
      // A run that cannot be matched is a re-shoot only where a re-shoot can be.
      if (projector === null && w.start < where.positionEnd - SLOT_SLACK) return null;
      tailProjector.set(w, projector);
      tailWhy.set(w, why);
    }
    return { tailProjector, tailWhy };
  };
  /** The window of the brightest photograph within SLOT_SLACK of `x0` before the first run: a slot's white, where its run starts there. */
  const whiteNear = (x0: number): RunWindow | null => {
    const black = found[0].black;
    let best = -1;
    let most = 0;
    for (let y = Math.max(0, x0 - SLOT_SLACK); y <= x0 + SLOT_SLACK && y < found[0].start; y++) {
      const f = fingerprints[y];
      let light = 0;
      for (let i = 0; i < cells; i++) {
        if (usableBlock(f, i) && usableBlock(black, i)) light += Math.max(0, f.values[i] - black.values[i]);
      }
      if (light > most) {
        most = light;
        best = y;
      }
    }
    return best < 0 ? null : referenceWindow(fingerprints[best], black, best);
  };
  const backLitOf = new Map<number, number[]>();
  /**
   * Lit photographs no run was found in, straight before a numbering's first
   * slot or straight after its last, more of them than SLOT_SLACK strays and
   * showing a run's structure (showsARun): a run the page was playing there,
   * so the count has a run it has no room for.
   * A camera started after Play leaves the end of a run before the first found
   * — "taken before Play" by the count, which then numbers every run a
   * projector early; a run lost after the position's last found one, with a
   * run's worth of dark photographs inside the position the count took for a
   * projector out of view, sits after the last slot as photographs "taken after
   * the screen went black", and the runs were filed a projector late. Where
   * the slot at an end has no run found, its own run may be up to SLOT_SLACK
   * longer, and those photographs are its.
   */
  const endDoubt = (c: Count, a0: number, where: Pick<Reading, 'slotOf' | 'positionEnd'>): Doubt | null => {
    const x0 = found[0].start - a0 * runLength;
    const before = a0 > 0 ? SLOT_SLACK : 0;
    let front = frontLit.filter((x) => x < x0 - before);
    if (a0 > 0 && front.length > SLOT_SLACK) {
      // Where the first slot's run was not found, the photographs before it
      // that copy its white are the page's step 0 all the same.
      const w0 = whiteNear(x0);
      if (w0 !== null) front = front.filter((x) => !copiesFrame(fingerprints[x], w0.white, w0));
    }
    if (front.length > SLOT_SLACK && front[front.length - 1] >= x0 - before - SLOT_SLACK && showsARun(front)) {
      return { kind: 'front', strays: front };
    }
    // Past a stretch that is not whole runs the runs after it are the later
    // projectors', and the end is counted as the stretch allows.
    if (c.numberedCount < c.pass1.length) return null;
    let lit = backLitOf.get(c.t);
    if (lit === undefined) {
      lit = unexplainedLit(c.last.start + runLength, c.backLimit, c.last, true);
      backLitOf.set(c.t, lit);
    }
    const after = where.slotOf.get(c.last) === projectors - 1 ? 0 : SLOT_SLACK;
    const back = lit.filter((x) => x >= where.positionEnd + after);
    if (back.length > SLOT_SLACK && back[0] < where.positionEnd + after + SLOT_SLACK && showsARun(back)) {
      return { kind: 'back', strays: back };
    }
    return null;
  };
  /**
   * A reading whose first re-shoot matches nothing takes the position to have
   * ended before it, and the page ends a position by painting black: a camera
   * running then photographs it, and a re-shoot comes later. One that follows
   * the run before it with no dark photograph between — its own white shown
   * before Play set aside — is where the page's next run would be, and more
   * likely the position's own run, counted a projector past the end.
   */
  const tailDoubt = (c: Count, tail: readonly RunWindow[], matched: Pick<Reading, 'tailProjector'>): Doubt | null => {
    const w = tail[0];
    if (w === undefined || matched.tailProjector.get(w) !== null) return null;
    let x = w.start - 1;
    while (x >= 0 && inWindow[x] !== 1 && copiesFrame(fingerprints[x], w.white, w)) x--;
    return x >= 0 && inWindow[x] !== 1 && darkBeside(x, c.last) ? null : { kind: 'tail', run: w };
  };
  const readAs = (t: number): Reading[] => {
    const tail = found.slice(t);
    if (t === 0) {
      // No run of the position was found: it is everything before the first
      // run, which has to be long enough to have been one, and has to hold
      // photographs that a run found repeats — the run too broken to be found
      // that it re-shoots. A long wait before Play holds none, whatever it
      // shows, and read as a position whose every run was lost it made a clean
      // position's every run a re-shoot of a run that could not be read.
      if (found[0].start < runLength * projectors - SLOT_SLACK) return [];
      if (!evidence.some((e) => e.some((x) => x < found[0].start))) return [];
      const where = {
        slotOf: new Map<RunWindow, number>(),
        inLine: new Set<RunWindow>(),
        range: Array.from({ length: projectors }, (): { from: number; to: number } | null => null),
        positionEnd: found[0].start,
      };
      const matched = matchTail(tail, where);
      return matched === null ? [] : [{ t, count: null, a0: 0, acceptable: true, doubt: null, ...where, ...matched }];
    }
    const c = countPosition(t);
    if (c === null) return [];
    const out: Reading[] = [];
    for (const a0 of c.candidates) {
      const where = layout(c, a0);
      const matched = matchTail(tail, where);
      if (matched === null) continue;
      // A run of the position is where the photographs copying it are, or
      // those photographs are its pre-roll or test shots: a run copied in
      // another projector's place is a re-shoot or a folder out of order, never
      // two projectors.
      const misplacedCopy = found.slice(0, t).some((w, j) => {
        const q = where.slotOf.get(w);
        if (q === undefined || where.inLine.has(w)) return false;
        return evidence[j].some((x) => {
          const o = slotOfCopy(where.range, j, x);
          return o !== null && o !== q;
        });
      });
      if (misplacedCopy) continue;
      const doubt: Doubt | null =
        c.candidates.length !== 1
          ? { kind: 'count' }
          : !c.within.includes(a0)
            ? { kind: 'allowance' }
            : endDoubt(c, a0, where) ?? tailDoubt(c, tail, matched);
      out.push({ t, count: c, a0, acceptable: doubt === null, doubt, ...where, ...matched });
    }
    return out;
  };
  const readings: Reading[] = [];
  for (let t = found.length; t >= 0; t--) readings.push(...readAs(t));
  // A gap between two of the position's runs that is not whole runs is a
  // reading's own admission that something else is going on, and such a
  // reading is set aside for one without — a re-shoot added after the position
  // always leaves one before it, read as the position's. But not for a reading
  // that takes a run it cannot match for a re-shoot after the position's end:
  // that is also what a genuine run looks like once the count has put it past
  // the end, and preferring it filed the runs before it a projector over while
  // the reading with the honest gap, the true one, was never asked. Then every
  // reading that fits takes part in the disagreement below.
  /** A reading without a stretch that is not whole runs: the kind used, where one fits. */
  const whole = (r: Reading): boolean => r.count === null || r.count.gapProblem === null;
  const matchesEvery = (r: Reading): boolean => found.slice(r.t).every((w) => r.tailProjector.get(w) !== null);
  const wholes = readings.filter(whole);
  const pool = wholes.length > 0 && wholes.every(matchesEvery) ? wholes : readings;
  const positionAdvice =
    "A camera position is every projector's run back to back, from the first: start the camera " +
    'before Play and stop it only once the page has played to its end, not when the sphere goes ' +
    "dark on the camera's side, as it does while a projector this camera cannot see is playing; " +
    'keep every dark photograph, since they are how such projectors are counted; and keep the ' +
    'photographs taken before Play and after the screen goes black to a few.';
  const runsFound = (k: number): string => (k === 1 ? 'run' : `${k} runs`);
  if (pool.length === 0) {
    // The runs number, so what no reading fits is a run that repeats another
    // somewhere no re-shoot can be; or they do not number at all.
    const j = found.findIndex((_, k) => matchedBy[k].length > 0 || evidence[k].length > 0);
    if (j < 0) {
      problems.push(
        `The ${runsFound(found.length)} found ${found.length === 1 ? 'does' : 'do'} not fit ` +
          `${projectors} projectors with the photographs before the first run and after the last, ` +
          'and a run filed under the wrong projector is worse than one not used, so none is. ' +
          positionAdvice,
      );
      return refuse();
    }
    const w = found[j];
    const what =
      matchedBy[j].length > 0
        ? `shows the same white and black as the run at ` +
          `${photographs(found[matchedBy[j][0]].start, found[matchedBy[j][0]].start + runLength)}`
        : `is copied by ${photographs(evidence[j][0], evidence[j][0] + 1)}, where no run was found`;
    problems.push(
      `The run at ${photographs(w.start, w.start + runLength)} ${what}, and no reading of the ` +
        'folder fits the two: a re-shoot is added after the whole camera position, or played ' +
        'from the projector it repeats on to the end. That is what photographs out of the order ' +
        'they were shot look like, and a run filed under the wrong projector is worse than one ' +
        'not used, so none is.',
    );
    return refuse();
  }
  // A folder that holds a whole camera position's worth of photographs after
  // the runs of this one, with runs in them that match nothing here, is more
  // than one position — the camera's card handed in whole — not a re-shoot.
  const anotherPositionAt = (r: Reading): RunWindow[] | null => {
    const unmatched = found.slice(r.t).filter((w) => {
      const q = r.tailProjector.get(w);
      return q === undefined || q === null;
    });
    return unmatched.length > 0 && n - unmatched[0].start >= runLength * projectors - SLOT_SLACK ? unmatched : null;
  };
  const anotherPositionProblem = (unmatched: readonly RunWindow[]): string => {
    const at = unmatched[0].start;
    return (
      `From ${photographs(at, at + 1)} on, the folder holds ` +
      `${unmatched.length === 1 ? 'a run' : `${unmatched.length} runs`} that match no projector of ` +
      'this camera position, and room for a whole camera position: another position, shot into ' +
      'the same folder. The page reads one camera position per folder: split the folder at ' +
      `${photographs(at, at + 1)} and hand each position in on its own, with its own camera number.`
    );
  };
  const statusOf = (r: Reading, w: RunWindow): string => {
    if (r.slotOf.has(w)) {
      const q = (r.slotOf.get(w) as number) + 1;
      return r.inLine.has(w) ? `a re-shoot of projector ${q}` : `projector ${q}`;
    }
    const q = r.tailProjector.get(w);
    return q === undefined || q === null ? 'no projector' : `a re-shoot of projector ${q + 1}`;
  };
  /** The position's own runs in a reading, each once: its originals. */
  const originalsOf = (r: Reading): RunWindow[] =>
    found.filter((w) => r.slotOf.has(w) && !r.inLine.has(w));
  const names = (r: Reading): string => {
    const own = originalsOf(r).map((w) => (r.slotOf.get(w) as number) + 1);
    return `projector${own.length === 1 ? '' : 's'} ${listed(own)}`;
  };
  const noRun =
    'No run of this camera position could be read — every run found repeats photographs of ' +
    'a run that could not be — so there is nothing to count projectors from: a re-shoot is ' +
    "numbered by the position's own runs, and it has none. Shoot the whole camera position " +
    'again, into a folder of its own, and read it under the same camera number.';
  const contested = found.find((w) => pool.some((r) => statusOf(r, w) !== statusOf(pool[0], w)));
  if (contested !== undefined) {
    // Where one reading is that no run of the position was found at all, the
    // others count the position from a re-shoot and a run's worth or more of
    // photographs before it: nothing is there to number anything by.
    if (pool.some((r) => r.count === null)) {
      problems.push(noRun);
      return refuse();
    }
    const cards = pool.map(anotherPositionAt);
    if (cards.every((u) => u !== null)) {
      problems.push(anotherPositionProblem(cards[0] as RunWindow[]));
      return refuse();
    }
    if (pool.every((r) => r.t === pool[0].t && r.count !== null)) {
      // One reading of which runs are the position's, numbered from more than
      // one first projector: the ends do not settle it.
      const k = originalsOf(pool[0]).length;
      problems.push(
        `The ${runsFound(k)} found could be ${[...new Set(pool.map(names))].join(' or ')}: the ` +
          'photographs before the first run and after the last do not settle which, and a run ' +
          'filed under the wrong projector is worse than one not used, so none is. ' +
          positionAdvice,
      );
      return refuse();
    }
    const readsAs = [...new Set(pool.map((r) => statusOf(r, contested)))];
    // Advice about re-shoots only where a run repeats another: a reading that
    // takes an unmatched run for one is a count that does not settle.
    const reshotSomewhere = pool.some(
      (r) => r.inLine.size > 0 || [...r.tailProjector.values()].some((q) => q !== null),
    );
    problems.push(
      `The run at ${photographs(contested.start, contested.start + runLength)} could be ` +
        `${readsAs.join(' or ')}: the photographs around it fit either reading, and a run ` +
        'filed under the wrong projector is worse than one not used, so none is. ' +
        (reshotSomewhere
          ? 'A re-shoot belongs after the whole camera position, dark photographs and all.'
          : positionAdvice),
    );
    return refuse();
  }
  const reading = pool.find((r) => whole(r) && r.acceptable) ?? pool.find((r) => r.acceptable);
  if (reading === undefined) {
    // Every reading that fits agrees, and none can be used: the ends allow
    // another numbering, the folder counts only with more photographs at an end
    // than the page's procedure makes — which is also what a lost run looks
    // like — or the photographs say the count is a run out.
    const r = pool.find(whole) ?? pool[0];
    const c = r.count as Count;
    const doubt = r.doubt as Doubt;
    const could = `The ${runsFound(originalsOf(r).length)} found could be ${names(r)}`;
    const worse = 'a run filed under the wrong projector is worse than one not used, so none is.';
    const wholeAgain =
      'Shoot the whole camera position again, into a folder of its own, and read it under the same ' +
      'camera number: start the camera before Play, and stop it only once the page has played to its ' +
      "end — not when the sphere goes dark on the camera's side, as it does while a projector this " +
      'camera cannot see is playing.';
    if (doubt.kind === 'front' || doubt.kind === 'back') {
      const lit = photographs(doubt.strays[0], doubt.strays[doubt.strays.length - 1] + 1);
      problems.push(
        doubt.kind === 'front'
          ? `${could} only if ${lit}, lit and in no run found, were taken before Play. They lead ` +
              'straight into the first run, as the end of a run does where the camera was started ' +
              'after Play, and a run the folder holds only the end of leaves nothing to count the ' +
              `projectors before it by: ${worse} ${wholeAgain}`
          : `${could} only if ${lit}, lit and in no run found, were taken after the screen went ` +
              "black. They follow straight on from the position's last run, as a run that could not " +
              'be found does, and leave the count with a run more than it has room for: ' +
              `${worse} ${wholeAgain}`,
      );
      return refuse();
    }
    if (doubt.kind === 'tail') {
      const w = doubt.run;
      problems.push(
        `${could} only if the run at ${photographs(w.start, w.start + runLength)}, which matches ` +
          'no projector, is a re-shoot added after the position. It follows the run before it with ' +
          "no dark photograph between, where the page's next run would be, so it is more likely " +
          `this position's own and the count a run out: ${worse} ${wholeAgain}`,
      );
      return refuse();
    }
    if (doubt.kind === 'count') {
      // The ends allow another first projector, whose reading did not fit.
      problems.push(
        `${could}, and the photographs before the first run and after the last allow another ` +
          `first projector as well: ${worse} ${positionAdvice}`,
      );
      return refuse();
    }
    const lastSlot = r.slotOf.get(c.last) as number;
    const front = c.before - runLength * r.a0;
    const back = c.after - runLength * (projectors - 1 - lastSlot);
    const ends = [
      ...(front > allowance ? [`${front} photographs taken before Play`] : []),
      ...(back > allowance ? [`${back} taken after the screen went black`] : []),
    ];
    problems.push(
      `${could} only with ${ends.join(' and ')}, more than the page's instructions leave room for, ` +
        `and ${worse} ${positionAdvice}`,
    );
    return refuse();
  }
  if (reading.count === null) {
    problems.push(noRun);
    return refuse();
  }
  const c = reading.count;
  if (c.gapProblem !== null) {
    const later = c.pass1.length - c.numberedCount;
    const lost = reading.range.flatMap((q, p) => (q === null ? [p + 1] : []));
    problems.push(
      `${c.gapProblem}: the ${later === 1 ? 'run' : `${later} runs`} found ` +
        `after it ${later === 1 ? 'is' : 'are'} not used` +
        (lost.length === 0
          ? ''
          : `, and projector${lost.length === 1 ? '' : 's'} ${listed(lost)} ` +
            `${lost.length === 1 ? 'is' : 'are'} not decoded`) +
        '. Shoot the whole camera position again, into a folder of its own, and read it under the ' +
        'same camera number: a re-shoot added to this folder is matched against the runs around ' +
        'it, and the runs after this stretch have no projector number to match.',
    );
  }
  const a0 = reading.a0;
  const backLimit = c.backLimit;
  const first = c.pass1[0];
  const { slotOf, inLine, range } = reading;
  const tail = found.slice(reading.t);
  const tailProjector = new Map<RunWindow, number>();
  const unmatchedTail = tail.filter((w) => {
    const q = reading.tailProjector.get(w);
    return q === undefined || q === null;
  });
  const another = anotherPositionAt(reading);
  const anotherPosition = another !== null;
  if (another !== null) problems.push(anotherPositionProblem(another));
  for (const w of tail) {
    const q = reading.tailProjector.get(w);
    if (q !== undefined && q !== null) {
      tailProjector.set(w, q);
      continue;
    }
    if (anotherPosition) continue;
    problems.push(
      `The run at ${photographs(w.start, w.start + runLength)}, after the end of this camera ` +
        `position, ${reading.tailWhy.get(w)}, so it cannot be told which projector it re-shoots. ` +
        "A re-shot run is matched by its white and black against the original's, and a " +
        'mismatch usually means the camera moved between the two: shoot the whole camera ' +
        'position again, into a folder of its own, and read it under the same camera number, ' +
        'rather than one projector.',
    );
  }
  // Where a re-shoot added to this folder could not be matched, asking for
  // another one to be added the same way is the remedy that just failed.
  const remedy = (p: number): string =>
    unmatchedTail.length > 0 && !anotherPosition
      ? `Re-shoot projector ${p}. A re-shoot added to this folder could not be matched, so shoot ` +
        'the whole camera position again, into a folder of its own, and read it under the same ' +
        'camera number, rather than adding another.'
      : `Re-shoot projector ${p}. ${handIn(p)}`;

  // ---- each projector: its run, the latest one that passes, or why not
  const assignment: (number | null)[] = fingerprints.map(() => null);
  const usableProjectors: number[] = [];
  const unseenProjectors: number[] = [];
  const barelySeenProjectors: number[] = [];
  const reshoots: ReshootProvenance[] = [];
  const positionRuns = found.slice(0, reading.t).filter((w) => slotOf.has(w));
  /**
   * The light in a slot no run was found in, judged against its own
   * photographs: their low quantile, block by block, is what dark is there.
   * So room light that came or went elsewhere in the folder, or a slow drift
   * across it, does not light a slot the camera cannot see. The slot's first
   * and last SLOT_SLACK photographs are left out, which a neighbour's spare
   * photograph can fall in; the folder's floor stands in only where the slot is
   * too short to have one of its own.
   */
  type SlotLight = { lit: Set<number>; litPhotos: { f: FrameFingerprint; blocks: Set<number> }[]; dark: Float64Array };
  const slotLights = new Map<string, SlotLight>();
  const slotLight = (r: { from: number; to: number }): SlotLight => {
    const key = `${r.from}:${r.to}`;
    let got = slotLights.get(key);
    if (got === undefined) {
      got = slotLightOf(r);
      slotLights.set(key, got);
    }
    return got;
  };
  const slotLightOf = (r: { from: number; to: number }): SlotLight => {
    let core = { from: r.from + SLOT_SLACK, to: r.to - SLOT_SLACK };
    if (core.to <= core.from) core = { from: r.from, to: r.to };
    const own: FrameFingerprint[] = [];
    for (let x = core.from; x < core.to; x++) if (inWindow[x] !== 1) own.push(fingerprints[x]);
    const dark = own.length >= 4 ? folderFloor(own, cells) : folderDark();
    const lit = new Set<number>();
    const litPhotos: { f: FrameFingerprint; blocks: Set<number> }[] = [];
    for (const f of own) {
      const blocks = new Set<number>();
      addLitBlocks(f, dark, blocks);
      if (blocks.size === 0) continue;
      litPhotos.push({ f, blocks });
      for (const b of blocks) lit.add(b);
    }
    return { lit, litPhotos, dark };
  };
  /** The runs of one pass, in shooting order, numbered. */
  const passes = [c.pass1.slice(0, c.numberedCount), c.pass2].filter((runs) => runs.length > 0);
  for (let p = 0; p < projectors; p++) {
    const here = positionRuns.filter((w) => slotOf.get(w) === p);
    const original = here.find((w) => !inLine.has(w)) ?? null;
    const reshot = [...here.filter((w) => inLine.has(w)), ...tail.filter((w) => tailProjector.get(w) === p)];
    const runs = [...(original === null ? [] : [original]), ...reshot];
    const passing = runs.filter((w) => verdicts[found.indexOf(w)].kind === 'ok');
    const used = passing.length > 0 ? passing[passing.length - 1] : null;
    // A slot after a stretch that is not whole runs has no place; its
    // problem says so.
    const r = range[p];
    if (r === null) continue;
    if (used !== null) {
      for (let f = 0; f < runLength; f++) assignment[used.start + f] = p * runLength + f;
      usableProjectors.push(p);
      if (used !== original) {
        reshoots.push({ projector: p, used: used.start, replaced: original?.start ?? r.from });
        notes.push(
          `Projector ${p + 1}'s run` +
            (original === null ? '' : ` at ${photographs(original.start, original.start + runLength)}`) +
            ` was replaced by its re-shoot at ${photographs(used.start, used.start + runLength)}.`,
        );
      }
      // A re-shoot after the one used that did not pass is said, but as a
      // note: the run used passed, so there is nothing to re-shoot. A page
      // played on past the projector it was asked for shoots every later one
      // again, and one of those runs straddling is no reason to ask for it.
      for (const w of reshot) {
        if (w.start <= used.start) continue;
        const v = verdicts[found.indexOf(w)];
        if (v.kind === 'barely') continue;
        notes.push(
          `Projector ${p + 1}'s re-shoot at ${photographs(w.start, w.start + runLength)} did not ` +
            `pass, so its earlier run, which did, is used: ${verdictReason(v, runLength)}.`,
        );
      }
      continue;
    }
    if (runs.length > 0) {
      const verdictsHere = runs.map((w) => verdicts[found.indexOf(w)]);
      if (verdictsHere.every((v) => v.kind === 'barely')) {
        const blocks = Math.max(...verdictsHere.map((v) => (v.kind === 'barely' ? v.blocks : 0)));
        barelySeenProjectors.push(p);
        notes.push(
          `Projector ${p + 1} lit only ${blocks} fingerprint block${blocks === 1 ? '' : 's'} ` +
            'from this camera position — too little to check, so its run is not decoded. A ' +
            're-shoot from here would see no more of it.',
        );
        continue;
      }
      runs.forEach((w, k) => {
        const v = verdictsHere[k];
        if (v.kind === 'barely') return;
        problems.push(verdictProblem(v, p + 1, runLength, w !== original));
      });
      continue;
    }
    // No run found for this projector: dark, barely lit, or broken.
    const { lit, litPhotos, dark } = slotLight(r);
    if (lit.size === 0) {
      unseenProjectors.push(p);
      notes.push(
        `Projector ${p + 1} was not in this camera's view: every photograph of its run is dark. ` +
          'Nothing to decode, and nothing to re-shoot.',
      );
      continue;
    }
    // A slot the front of the folder cuts short lost its first photographs to
    // a camera started after Play, and a run's first photograph is its white,
    // its brightest: what is left cannot say the projector lights too little to
    // find, and lit at all it is a run that could not be found. On the bench a
    // run lit only by the room behind the sphere, placed whole, lit 1 to 3
    // blocks without its white and was noted barely seen, with a note that a
    // re-shoot from there would see no more of it. Inside the position a slot
    // short of a run is a photograph dropped, any of its 34, and is judged as
    // it stands. Light with no pattern in it at all is dark against the slot's
    // own photographs wherever the slot is, and reads as out of view.
    const cutByLateStart = r.from === 0 && r.to - r.from < runLength;
    if (lit.size < MIN_CRESCENT_BLOCKS && !cutByLateStart) {
      barelySeenProjectors.push(p);
      notes.push(
        `Projector ${p + 1} lit only ${lit.size} fingerprint block${lit.size === 1 ? '' : 's'} ` +
          'from this camera position — too little to find its run by, so it is not decoded. A ' +
          're-shoot from here would see no more of it.',
      );
      continue;
    }
    if (roomLike(litPhotos, dark)) {
      problems.push(
        `Projector ${p + 1}'s photographs are lit, but no run of ${runLength} could be found ` +
          'among them, and the light in them changes the way a room changes rather than the way ' +
          "a projector's patterns do: the same part of the picture brightens in every photograph " +
          "that is lit. Most likely the room's light changed while they were shot — a lamp, a " +
          'door, daylight — so shoot the whole camera position again, into a folder of its own, ' +
          "with the room's light as it will stay, and read it under the same camera number. If it " +
          `did not change, a dropped or doubled photograph did this: ${remedy(p + 1)}`,
      );
      continue;
    }
    // The count is known only between two runs of one pass that were found,
    // with every other projector in that stretch dark.
    let count: number | null = null;
    for (const runsOfPass of passes) {
      const left = runsOfPass.filter((w) => (slotOf.get(w) as number) < p).pop();
      const right = runsOfPass.find((w) => (slotOf.get(w) as number) > p);
      if (left === undefined || right === undefined) continue;
      if (runsOfPass.indexOf(right) !== runsOfPass.indexOf(left) + 1) continue;
      const inStretch = range
        .map((q, idx) => ({ q, idx }))
        .filter(({ idx }) => idx > (slotOf.get(left) as number) && idx < (slotOf.get(right) as number));
      const othersDark = inStretch.every(({ q, idx }) => idx === p || q === null || slotLight(q).lit.size === 0);
      if (othersDark) count = right.start - (left.start + runLength) - runLength * (inStretch.length - 1);
    }
    problems.push(
      (count !== null && count !== runLength
        ? `Projector ${p + 1}'s run holds ${count} photographs and should hold ${runLength}. Its ` +
          'neighbours were found, so the fault is inside it and there is no way to say which ' +
          'photograph is missing or extra'
        : `Projector ${p + 1}'s photographs are lit, but no run of ${runLength} could be found ` +
          'among them: its white and black, or its phase frames, are not where a run of this plan ' +
          'puts them, which is what a dropped, doubled or out-of-order photograph looks like') +
        ` — this run is dropped and the rest of the position is unaffected. ${remedy(p + 1)}`,
    );
  }
  // ---- what the folder held besides runs
  const leadEnd = range[0]?.from ?? 0;
  if (leadEnd > 0) {
    const tests = Array.from({ length: leadEnd }, (_, x) => x).filter((x) =>
      positionRuns.some((w) => w !== first && testShot(x, found.indexOf(w))),
    ).length;
    const copies = Array.from({ length: leadEnd }, (_, x) => x).filter((x) =>
      copiesFrame(fingerprints[x], first.white, first),
    ).length;
    if (tests > 0) {
      notes.push(
        `${tests} photograph${tests === 1 ? '' : 's'} before the first run ` +
          `cop${tests === 1 ? 'ies' : 'y'} a later projector's white — a test shot of the ` +
          'exposure, most likely; not used.',
      );
    }
    const rest = leadEnd - tests;
    if (rest > 0) {
      notes.push(
        copies === rest && a0 === 0
          ? `${rest} photograph${rest === 1 ? '' : 's'} before projector 1's run ` +
              `${rest === 1 ? 'is a copy' : 'are copies'} of its white, taken before Play; not used.`
          : `${rest} photograph${rest === 1 ? '' : 's'} before the first run ` +
              `${rest === 1 ? 'was' : 'were'} taken before Play or belong to no run; not used.`,
      );
    }
  }
  if (c.pass2.length > 0) {
    // Between the passes of a position the page was stepped back: what the
    // camera took meanwhile belongs to no run.
    const from = c.pass1[c.pass1.length - 1].start + runLength;
    const to = c.pass2[0].start;
    const strays = Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k).filter(
      (x) => slotIn(range, x) === null,
    ).length;
    notes.push(
      `The page was stepped back to projector ${(slotOf.get(c.pass2[0]) as number) + 1} and played ` +
        `again from ${photographs(c.pass2[0].start, c.pass2[0].start + 1)}: a run shot again there ` +
        'replaces the earlier one where it passes' +
        (strays > 0
          ? `, and the ${strays} photograph${strays === 1 ? '' : 's'} taken before it ` +
            `${strays === 1 ? 'belongs' : 'belong'} to no run; not used.`
          : '.'),
    );
  }
  const trailFrom = range[projectors - 1]?.to ?? backLimit;
  if (backLimit > trailFrom) {
    const k = backLimit - trailFrom;
    const darkAfter = Array.from({ length: k }, (_, t) => trailFrom + t).every((x) => darkBeside(x, c.last));
    notes.push(
      `${k} ${darkAfter ? 'dark ' : ''}photograph${k === 1 ? '' : 's'} after the last projector's run ` +
        `${darkAfter ? `${k === 1 ? 'was' : 'were'} taken after the screen went black` : 'belong to no run'}; not used.`,
    );
  }
  if (tail.length > 0 && !anotherPosition) {
    const extra = Array.from({ length: n - tail[0].start }, (_, t) => tail[0].start + t).filter(
      (x) => !tail.some((w) => x >= w.start && x < w.start + runLength),
    ).length;
    if (extra > 0) {
      notes.push(
        `${extra} photograph${extra === 1 ? '' : 's'} around the re-shot runs ` +
          `${extra === 1 ? 'belongs' : 'belong'} to none of them; not used.`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    assignment,
    usableProjectors,
    unseenProjectors,
    barelySeenProjectors,
    reshoots,
    problems,
    notes,
    mechanism: 'position',
  };
}
