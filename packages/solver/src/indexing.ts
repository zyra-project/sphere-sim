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
 * not to delete, skip or re-shoot a single frame. This module is what makes that
 * rule softer, and it is deliberately not what makes it disappear.
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

/** What a frame is, as an indexer can tell from a photograph without decoding it. */
export type FrameKind = 'white' | 'black' | 'patterned';

/**
 * The shape the capture was supposed to have.
 *
 * Stated as a list of KINDS rather than as a pattern plan, because this package
 * may not import one: `packages/solver` reaches only `packages/calibration`, and
 * the plan type lives in the bench. That restriction turns out to be the right
 * shape anyway — an indexer needs to know that a run opens white, black and then
 * thirty-two patterned frames, and needs to know nothing whatever about Gray
 * bits or phase steps.
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

  const usable = (i: number): boolean =>
    a.measured[i] === 1 &&
    b.measured[i] === 1 &&
    white.measured[i] === 1 &&
    black.measured[i] === 1;

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
 * is 0.3961 on an offset grid and 0.5000 on an aligned one, while a matched
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
