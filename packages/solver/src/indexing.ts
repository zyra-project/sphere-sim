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
 * ## The two mechanisms here, and the one that is not
 *
 * The plan names three candidates and says the phase **picks by measurement,
 * not by argument**. Two of them are implemented here:
 *
 *   1. {@link indexByOrder} — the order is the index. Cheap, needs nothing, and
 *      gives no way to detect that it broke.
 *   2. {@link indexByBookends} — the white and black frames that open each
 *      projector's run are separable from every patterned frame, so they mark
 *      the boundaries and the count between them is checkable.
 *
 * The third — projecting a frame index into the frame itself — is **not built
 * yet, on purpose.** It spends raster area, and its real risk is photometric: a
 * marker has to survive an oblique sphere in a room whose ambient term
 * PARAMETERS.md §5 leaves unmeasured between 1% and 15%, and there is no single
 * region of a sphere every camera position can see. That is the expensive
 * option, and building it before measuring the cheap ones would be paying for a
 * mechanism nobody had shown was needed. `docs/EXPERIMENT-8.md` is the
 * measurement that decides whether it is.
 *
 * ## The hole, stated before anyone finds it by accident
 *
 * Neither mechanism here can see **a drop and a duplicate that cancel inside one
 * run, both landing on patterned frames.** The count between the bookends is
 * unchanged and every frame's kind is unchanged, because {@link observe} cannot
 * tell one Gray plane from another — every patterned frame in the plan lights
 * about half the crescent, which is exactly what makes the references separable
 * and exactly what makes the patterned frames interchangeable.
 *
 * That is not a defect to be apologised for; it is the boundary of what a
 * per-frame brightness statistic can do, and it is what decides whether Phase 2
 * needs to spend anything more. Closing it requires telling patterned frames
 * apart FROM EACH OTHER — either the projected index the plan calls mechanism 3,
 * or a cheap per-frame fingerprint that can ask whether a Gray plane and its
 * neighbour are still complements of one another. `docs/EXPERIMENT-8.md`
 * measures how often the hole is reached under drops and duplicates — with
 * classification taken as exact, which it never is in a room.
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
  mechanism: 'order' | 'bookends';
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
