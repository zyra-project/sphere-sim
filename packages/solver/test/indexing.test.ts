// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Which photograph is which frame, and what each mechanism does when it is wrong.
 *
 * The properties here are the ones `docs/OPERATOR-PATH.md` says decide the phase,
 * and they are asserted as PROPERTIES rather than as outputs: how far a fault
 * spreads, and whether the mechanism notices. The plan is explicit that the
 * second matters more —
 *
 * > A mechanism that silently mis-indexes is worse than one that refuses — a
 * > mis-indexed Gray plane is a confidently wrong calibration.
 *
 * — so the test that matters most is the one asserting ordering alone stays
 * SILENT on a capture it has got wrong. That is not a bug being pinned; it is the
 * baseline's real behaviour, and the reason `docs/CALIBRATE.md` currently has to
 * tell an operator never to delete a frame.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLACK_CUT,
  COMPLEMENT_LIMIT,
  MIN_CLASSIFY_MARGIN,
  WHITE_CUT,
  bookendPrefix,
  classify,
  complementResidual,
  fingerprint,
  indexByBookends,
  indexByFingerprint,
  indexByOrder,
  observe,
  observeCapture,
  type ComplementPlan,
  type ExpectedSequence,
  type FrameFingerprint,
  type FrameKind,
  type FrameObservation,
} from '../src/indexing.ts';
import type { LinearImage } from '../src/decode.ts';

/** The page's own plan: white, black, then 32 patterned frames, per projector. */
const RUN: FrameKind[] = ['white', 'black', ...Array.from({ length: 32 }, () => 'patterned' as const)];
const EXPECTED: ExpectedSequence = { kinds: RUN, projectors: 4 };

/** A photograph, as a lit fraction and the frame it really is. */
interface Shot {
  lit: number;
  trueFrame: number;
}

function cleanCapture(expected: ExpectedSequence = EXPECTED): Shot[] {
  const shots: Shot[] = [];
  for (let p = 0; p < expected.projectors; p++) {
    for (let f = 0; f < expected.kinds.length; f++) {
      const kind = expected.kinds[f];
      shots.push({
        lit: kind === 'white' ? 1 : kind === 'black' ? 0 : 0.5,
        trueFrame: p * expected.kinds.length + f,
      });
    }
  }
  return shots;
}

function observationsOf(shots: readonly Shot[]): FrameObservation[] {
  return shots.map((s, i) => ({ ordinal: i, mean: s.lit, litFraction: s.lit }));
}

/** How many placed photographs were placed WRONG — the number that matters. */
function misplaced(assignment: readonly (number | null)[], shots: readonly Shot[]): number {
  let wrong = 0;
  for (let i = 0; i < assignment.length; i++) {
    if (assignment[i] !== null && assignment[i] !== shots[i].trueFrame) wrong++;
  }
  return wrong;
}

function image(values: readonly number[], width: number, channels = 1): LinearImage {
  const height = values.length / width;
  const data = new Float32Array(values.length * channels);
  for (let i = 0; i < values.length; i++) {
    for (let c = 0; c < channels; c++) data[i * channels + c] = values[i];
  }
  return { width, height, channels, data };
}

test('the capture sets one threshold, and no frame is measured against itself', () => {
  // THE test this module did not have, and the reason the first version of
  // `observe` was inverted rather than merely weak. It computed each frame's
  // mid-level from that frame's own extrema, so:
  //
  //   - a flat WHITE frame has nothing above its own midpoint     -> 0.0
  //   - an all-black frame with a hair of ambient, [0, e, 0, e],
  //     has half its pixels above its own midpoint                -> 0.5
  //
  // which classified a white-black-patterned folder as black-white-patterned.
  // Every other test here builds observations by hand and never called it, so
  // nothing failed. The threshold now comes from the capture's whole dynamic
  // range, which is the scale a per-image statistic cannot see.
  const obs = observeCapture([
    image([1, 1, 1, 1], 2), // white: flat, and the brightest thing in the folder
    image([0, 0.002, 0, 0.002], 2), // black, with the faint gradient a real room leaves
    image([0, 1, 0, 1], 2), // a Gray plane: half the crescent
    image([0.1, 0.9, 0.1, 0.9], 2), // a phase step: soft edges, still half
  ]);
  assert.equal(obs[0].litFraction, 1, 'white lights all of it');
  assert.equal(obs[1].litFraction, 0, 'black lights none of it');
  assert.equal(obs[2].litFraction, 0.5);
  assert.equal(obs[3].litFraction, 0.5);
  const c = classify(obs);
  assert.deepEqual(c.kinds, ['white', 'black', 'patterned', 'patterned']);
  assert.equal(c.margin, 0.5);
});

test('a lit fraction survives the sphere being a small part of the picture', () => {
  // The crescent covering a quarter of the frame scales every fraction by a
  // quarter and reorders nothing, which is the property `classify` rests on when
  // it normalises by the brightest frame. Eight pixels, two of them sphere.
  const bg = [0, 0, 0, 0, 0, 0];
  const obs = observeCapture([
    image([1, 1, ...bg], 4),
    image([0, 0, ...bg], 4),
    image([1, 0, ...bg], 4),
  ]);
  assert.equal(obs[0].litFraction, 0.25, 'white lights the whole crescent, a quarter of the frame');
  assert.equal(obs[1].litFraction, 0);
  assert.equal(obs[2].litFraction, 0.125);
  assert.deepEqual(classify(obs).kinds, ['white', 'black', 'patterned']);
});

test('one photograph reports what it holds, and honours a mask', () => {
  // Channel 0 only, matching decode.ts — a three-channel white frame reads the
  // same as a one-channel one rather than three times as bright.
  assert.equal(observe(image([1, 1, 0, 0], 2, 3), 0).mean, 0.5);
  // A mask measures the sphere and not the wall behind it.
  const mask = new Uint8Array([1, 1, 0, 0]);
  const masked = observe(image([1, 1, 0, 0], 2), 0, mask);
  assert.equal(masked.mean, 1);
  assert.equal(masked.pixels, 2);
  assert.equal(masked.lo, 1);
  assert.equal(masked.hi, 1);
  // A frame with nothing to measure reports so rather than dividing by zero.
  const empty = observe(image([1, 1, 0, 0], 2), 0, new Uint8Array([0, 0, 0, 0]));
  assert.equal(empty.pixels, 0);
  assert.equal(observeCapture([image([1, 1, 0, 0], 2)])[0].litFraction, 0.5);
});

test('the three kinds separate, and the margin says by how much', () => {
  const c = classify(observationsOf(cleanCapture()));
  assert.deepEqual(c.kinds.slice(0, 4), ['white', 'black', 'patterned', 'patterned']);
  assert.equal(c.kinds.filter((k) => k === 'white').length, 4, 'one white per projector');
  assert.equal(c.kinds.filter((k) => k === 'black').length, 4, 'one black per projector');
  // The populations sit at 1, 0.5 and 0 of the brightest frame, so both gaps are
  // a half. The margin is the GAP BETWEEN GROUPS, not each frame's distance from
  // a cut — see the degenerate case below, which the distance measure called
  // healthy while the classification had collapsed to one class.
  assert.ok(Math.abs(c.margin - 0.5) < 1e-12, `margin ${c.margin}`);
  assert.ok(c.margin > MIN_CLASSIFY_MARGIN);
  assert.ok(WHITE_CUT > BLACK_CUT);
});

test('a clean capture indexes identically under both mechanisms', () => {
  const shots = cleanCapture();
  const obs = observationsOf(shots);
  const order = indexByOrder(obs, EXPECTED);
  const bookends = indexByBookends(obs, EXPECTED);
  assert.equal(order.ok, true, order.problems.join(' '));
  assert.equal(bookends.ok, true, bookends.problems.join(' '));
  assert.deepEqual(order.assignment, bookends.assignment);
  assert.equal(misplaced(order.assignment, shots), 0);
  assert.equal(misplaced(bookends.assignment, shots), 0);
  assert.deepEqual(bookends.usableProjectors, [0, 1, 2, 3]);
});

test('one dropped frame costs ordering the whole capture and bookends one run', () => {
  // THE headline property, and it is structural rather than statistical: the
  // bookends re-synchronise at each run, so a fault cannot propagate past the
  // next boundary. Drop a patterned frame from projector 1's run.
  const shots = cleanCapture();
  shots.splice(10, 1);
  const obs = observationsOf(shots);

  const order = indexByOrder(obs, EXPECTED);
  assert.equal(order.ok, false, 'the count is short, so this much ordering does see');
  // Every frame after the hole is indexed as its neighbour — 125 of them.
  assert.equal(misplaced(order.assignment, shots), shots.length - 10);

  const bookends = indexByBookends(obs, EXPECTED);
  assert.equal(bookends.ok, false);
  assert.equal(misplaced(bookends.assignment, shots), 0, 'nothing placed wrong');
  assert.deepEqual(bookends.usableProjectors, [1, 2, 3], 'three runs still usable');
  assert.match(bookends.problems.join(' '), /Projector 1's run holds 33/);
  assert.match(bookends.problems.join(' '), /Re-shoot projector 1/);
});

test('a drop and a duplicate that cancel are invisible to BOTH mechanisms', () => {
  // The case the plan says ordering "gives no way to detect" — and the finding
  // this test exists to pin is that mechanism 2 does not detect it either, when
  // both faults land on patterned frames inside one run.
  //
  // The reason is exact rather than incidental. Bookends check two things: the
  // number of photographs between boundaries, and the KIND of each frame in a
  // run. A drop and a duplicate in the same run leave the count unchanged, and a
  // patterned frame replaced by another patterned frame leaves every kind
  // unchanged, because `litFraction` cannot tell one Gray plane from another —
  // every patterned frame in the plan lights about half the crescent.
  //
  // So this is the hole that decided what Phase 2 needed next, and it is the
  // reason `docs/EXPERIMENT-8.md` measures how often it bites rather than
  // arguing about it. Closing it needs something that distinguishes patterned
  // frames FROM EACH OTHER, and the cheap one is now built: see
  // `indexByFingerprint` and the tests at the bottom of this file. This test
  // stays exactly as it is, because what it pins is what the FIRST TWO
  // mechanisms do, and a third one existing does not change that.
  const shots = cleanCapture();
  shots.splice(10, 1);
  shots.splice(20, 0, { ...shots[20] });

  const order = indexByOrder(observationsOf(shots), EXPECTED);
  assert.equal(order.ok, true, 'the count matches, so ordering says the capture is fine');
  assert.equal(order.problems.length, 0);
  assert.ok(misplaced(order.assignment, shots) > 0, 'and it is wrong');

  const bookends = indexByBookends(observationsOf(shots), EXPECTED);
  assert.equal(bookends.ok, true, 'the run length and every kind still check out');
  assert.ok(misplaced(bookends.assignment, shots) > 0, 'and it is wrong in the same way');
});

test('the same pair of faults IS caught once one of them moves a reference', () => {
  // The other side of the hole, and what bounds it: mechanism 2 is blind only
  // while the substitution is patterned-for-patterned. Drop a patterned frame
  // and duplicate the white one, and the count is still right while the kinds
  // are not — which the run's kind check reads straight off.
  const shots = cleanCapture();
  shots.splice(10, 1);
  shots.splice(0, 0, { lit: 1, trueFrame: -1 });

  const order = indexByOrder(observationsOf(shots), EXPECTED);
  assert.equal(order.ok, true, 'ordering still sees nothing');
  assert.ok(misplaced(order.assignment, shots) > 0);

  const bookends = indexByBookends(observationsOf(shots), EXPECTED);
  assert.equal(bookends.ok, false);
  assert.equal(misplaced(bookends.assignment, shots), 0, 'nothing placed wrong');
  assert.deepEqual(bookends.usableProjectors, [1, 2, 3], 'the later runs still stand');
});

test('a duplicated frame lands in the run it came from, not the one after', () => {
  const shots = cleanCapture();
  shots.splice(15, 0, { ...shots[15] });
  const bookends = indexByBookends(observationsOf(shots), EXPECTED);
  assert.equal(bookends.ok, false);
  assert.equal(misplaced(bookends.assignment, shots), 0);
  assert.deepEqual(bookends.usableProjectors, [1, 2, 3]);
  assert.match(bookends.problems.join(' '), /holds 35/);
});

test('a duplicated WHITE frame does not invent a run', () => {
  // [white, white, black] — only the second white opens a run, which is what
  // leaves the spare inside the previous run where the length check finds it.
  const shots = cleanCapture();
  shots.splice(34, 0, { lit: 1, trueFrame: -1 });
  const obs = observationsOf(shots);
  const { kinds } = classify(obs);
  assert.equal(kinds.filter((k) => k === 'white').length, 5, 'five white-looking frames');
  const bookends = indexByBookends(obs, EXPECTED);
  assert.equal(bookends.usableProjectors.length, 3, 'still four runs, one of them long');
  assert.equal(misplaced(bookends.assignment, shots), 0);
});

test('a lost boundary refuses the capture rather than misfile a projector', () => {
  // Both of projector 2's bookends dropped. Its frames glue to projector 1's
  // run, three boundaries are found where four are expected, and nothing then
  // says which run is which projector. Filing 32 photographs under the wrong
  // projector is the failure this project treats as worse than stopping.
  const shots = cleanCapture();
  shots.splice(34, 2);
  const bookends = indexByBookends(observationsOf(shots), EXPECTED);
  assert.equal(bookends.ok, false);
  assert.deepEqual(bookends.usableProjectors, []);
  assert.equal(misplaced(bookends.assignment, shots), 0, 'nothing placed at all');
  assert.match(bookends.problems.join(' '), /Found 3 projector runs/);
  assert.match(bookends.problems.join(' '), /which run is which projector/);
});

test('a capture whose bookends cannot be separated says so instead of segmenting noise', () => {
  // Every frame nearly the same brightness: a sphere that fills too little of
  // the picture, or a room bright enough to lift the black frames. PARAMETERS.md
  // §5 leaves the ambient term unmeasured between 1% and 15%, so this is the
  // failure the phase most needs to refuse rather than survive by luck.
  const obs = cleanCapture().map((s, i) => ({
    ordinal: i,
    mean: 0.5,
    litFraction: 0.5 + 0.02 * (s.lit - 0.5),
  }));
  const bookends = indexByBookends(obs, EXPECTED);
  assert.equal(bookends.ok, false);
  assert.deepEqual(bookends.usableProjectors, []);
  assert.match(bookends.problems.join(' '), /cannot be reliably told/);
  assert.match(bookends.problems.join(' '), /sphere fills too little/);
});

test('a plan with no references says what is missing rather than failing oddly', () => {
  const noRefs: ExpectedSequence = {
    kinds: Array.from({ length: 32 }, () => 'patterned' as const),
    projectors: 4,
  };
  assert.deepEqual(bookendPrefix(noRefs), []);
  assert.deepEqual(bookendPrefix(EXPECTED), ['white', 'black']);
  const r = indexByBookends(observationsOf(cleanCapture(noRefs)), noRefs);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /includeWhiteBlack off/);
});

test('photographs before the first reference are reported, not silently absorbed', () => {
  const shots = cleanCapture();
  shots.unshift({ lit: 0.5, trueFrame: -1 });
  const bookends = indexByBookends(observationsOf(shots), EXPECTED);
  assert.match(bookends.problems.join(' '), /sit before the first white frame/);
  assert.equal(bookends.assignment[0], null, 'and the stray is not placed');
});

test('a refusal does not promise the runs it still offers are sound', () => {
  // The limitation experiment 8 found and this pins, because it is the one a
  // caller is most likely to assume away: `ok: false` says SOME run was refused,
  // not that every run still in `usableProjectors` is right.
  //
  // Projector 1's run loses a frame, so it is flagged on length. Projector 2's
  // run loses one and gains a duplicate of another, so its length and its kinds
  // both still check out and it is offered — mis-indexed. A caller that read
  // `ok` and then trusted `usableProjectors` would put projector 2's wrong
  // answer into a bundle adjustment with a clean bill of health.
  const shots = cleanCapture();
  shots.splice(5, 1); // inside run 0 -> caught by the length check
  shots.splice(45, 1); // inside run 1 ...
  shots.splice(50, 0, { ...shots[50] }); // ... and cancelled, so it is not

  const r = indexByBookends(observationsOf(shots), EXPECTED);
  assert.equal(r.ok, false, 'run 0 is refused, so the capture is refused');
  assert.ok(r.usableProjectors.includes(1), 'and run 1 is offered anyway');
  assert.ok(misplaced(r.assignment, shots) > 0, 'while being wrong');

  // Which is what makes the poisoned-run count the honest headline, rather than
  // the share of captures that came back without a complaint.
  const placedWrongInOfferedRun = r.assignment.filter(
    (got, i) => got !== null && got !== shots[i].trueFrame,
  ).length;
  assert.ok(placedWrongInOfferedRun > 0);
});

// ---------------------------------------------------------------------------
// Mechanism 4 — the complement fingerprint
// ---------------------------------------------------------------------------

/**
 * A run small enough to read, with the same SHAPE as the page's own plan: two
 * references, then Gray planes each followed by its own complement, then phase
 * steps paired with nothing.
 *
 * Four blocks per frame. `minBlocks` is 4 because the finest plane here flips
 * once per block — the same `2^grayBits` rule, at two bits instead of six.
 */
const BLOCKS = 4;
const TOY: Record<string, number[]> = {
  white: [1, 1, 1, 1],
  black: [0, 0, 0, 0],
  gray0: [1, 1, 0, 0],
  grayInv0: [0, 0, 1, 1],
  gray1: [1, 0, 1, 0],
  grayInv1: [0, 1, 0, 1],
  phase0: [1, 0.5, 0, 0.5],
  phase1: [0.5, 0, 0.5, 1],
};
/** Capture order, as `planFrames` would emit this plan. */
const TOY_ORDER = ['white', 'black', 'gray0', 'grayInv0', 'gray1', 'grayInv1', 'phase0', 'phase1'];
const TOY_KINDS: FrameKind[] = [
  'white',
  'black',
  ...Array.from({ length: 6 }, () => 'patterned' as const),
];
const TOY_COMPLEMENTS: ComplementPlan = {
  pairs: [
    [2, 3],
    [4, 5],
  ],
  minBlocks: BLOCKS,
};
const TOY_EXPECTED: ExpectedSequence = {
  kinds: TOY_KINDS,
  projectors: 2,
  complements: TOY_COMPLEMENTS,
};

function fp(ordinal: number, values: readonly number[], blocks = BLOCKS): FrameFingerprint {
  return {
    ordinal,
    blocks,
    values: Float32Array.from(values),
    measured: Uint8Array.from(values.map(() => 1)),
  };
}

/** The lit fraction each toy frame would report — what the bookends see. */
function litOf(name: string): number {
  return name === 'white' ? 1 : name === 'black' ? 0 : 0.5;
}

/** A whole capture from a per-run list of frame names, as shot. */
function toyCapture(runs: readonly (readonly string[])[]): {
  observations: FrameObservation[];
  fingerprints: FrameFingerprint[];
} {
  const observations: FrameObservation[] = [];
  const fingerprints: FrameFingerprint[] = [];
  let i = 0;
  for (const run of runs) {
    for (const name of run) {
      observations.push({ ordinal: i, mean: litOf(name), litFraction: litOf(name) });
      fingerprints.push(fp(i, TOY[name]));
      i++;
    }
  }
  return { observations, fingerprints };
}

test('a block grid is the frame averaged, and an unmeasured block says so', () => {
  // Four 2x2 blocks over a 4x4 image, the top-left one entirely masked out. A
  // block with nothing in it has to stay distinguishable from a block that
  // genuinely averaged to zero, because a black frame is all of the latter.
  const values = [
    1, 1, 0, 0,
    1, 1, 0, 0,
    0.5, 0.5, 0, 0,
    0.5, 0.5, 0, 0,
  ];
  const mask = Uint8Array.from(values.map((_, i) => (i % 4 < 2 && i < 8 ? 0 : 1)));
  const f = fingerprint(image(values, 4), 0, 2, mask);
  assert.equal(f.blocks, 2);
  assert.deepEqual([...f.measured], [0, 1, 1, 1], 'the masked block is unmeasured, not zero');
  assert.equal(f.values[1], 0, 'the top-right block is genuinely zero');
  assert.equal(f.values[2], 0.5);
  assert.equal(f.values[0], 0, 'an unmeasured block holds no value to report');
});

test('a grid that does not divide the frame still covers it, with nothing off the end', () => {
  // 5 pixels across a 2-block grid: the naive `floor(x * blocks / width)` is
  // fine, but `floor(x / (width / blocks))` puts the last pixel at index 2 of a
  // 2-block row. Asserted because an out-of-range block index writes into the
  // next row's first block and nothing would look wrong about the output.
  const f = fingerprint(image([0, 0, 1, 1, 1, 0, 0, 1, 1, 1], 5), 0, 2);
  assert.equal(f.values.length, 4);
  assert.deepEqual([...f.measured], [1, 1, 1, 1], 'every block got pixels');
});

test('a complementary pair adds up to white plus black, whatever the room did to it', () => {
  // The identity the whole mechanism rests on. `gray + grayInverse = 1` holds in
  // the PROJECTOR; what a camera records is `a*target + b` with `a` carrying
  // albedo, the cosine falloff and the exposure, and `b` carrying ambient. The
  // claim is that every one of those cancels because the map is affine, so this
  // applies a different `a` and `b` to every block and asserts the residual is
  // still zero.
  const gain = [0.2, 1.4, 0.75, 0.9];
  const ambient = [0.05, 0.3, 0.01, 0.12];
  const shot = (name: string): FrameFingerprint =>
    fp(0, TOY[name].map((v, i) => gain[i] * v + ambient[i]));

  const matched = complementResidual(
    shot('gray0'),
    shot('grayInv0'),
    shot('white'),
    shot('black'),
  );
  assert.ok(matched !== null);
  assert.ok(
    matched < 1e-6,
    `a real pair should satisfy the identity exactly, got ${String(matched)}`,
  );

  // And the same two frames under a UNIFORM scene, to show the test above is
  // not passing because the numbers happened to be small.
  const flat = complementResidual(fp(0, TOY.gray0), fp(1, TOY.grayInv0), fp(2, TOY.white), fp(3, TOY.black));
  assert.ok(flat !== null && flat < 1e-6);
});

test('two frames that are not a pair miss it by half, and a frame doubled misses by all of it', () => {
  const w = fp(0, TOY.white);
  const k = fp(1, TOY.black);
  const mismatch = complementResidual(fp(2, TOY.gray0), fp(3, TOY.gray1), w, k);
  const doubled = complementResidual(fp(2, TOY.gray0), fp(3, TOY.gray0), w, k);
  assert.equal(mismatch, 0.5, 'two different planes disagree over half the raster');
  assert.equal(doubled, 1, 'a frame against a copy of itself disagrees over all of it');
  assert.ok(
    (mismatch ?? 0) > COMPLEMENT_LIMIT && (doubled ?? 0) > COMPLEMENT_LIMIT,
    'both are the kind of fault this is meant to catch',
  );
});

test('a straddled frame misses the identity by exactly how much of it is the wrong pattern', () => {
  // `docs/EXPERIMENT-9.md` calls a straddle — a shutter that opens across a
  // frame change, so the photograph is a blend of two patterns — "a second way
  // into the same blind spot" as a cancelling drop-and-duplicate, because the
  // count is right and every frame still lights about half the crescent.
  //
  // It is not the same blind spot for THIS mechanism, and the response is
  // proportional rather than all-or-nothing. A Gray plane's temporal neighbour
  // is its own complement, so a frame that is a fraction `a` of the pattern and
  // `1 - a` of the complement misses the identity by exactly `1 - a`. Measured
  // here rather than derived in prose, because the number is what decides
  // whether it matters.
  //
  // What this does NOT establish is how often a straddle is large enough to be
  // caught. That is Experiment 9's sweep and it has not been re-run against this
  // mechanism.
  const w = fp(0, TOY.white);
  const k = fp(1, TOY.black);
  for (const blend of [0.5, 0.75, 0.85, 0.9, 0.95]) {
    const straddled = TOY.gray0.map((v, i) => blend * v + (1 - blend) * TOY.grayInv0[i]);
    const r = complementResidual(fp(2, straddled), fp(3, TOY.grayInv0), w, k);
    assert.ok(r !== null);
    assert.ok(
      Math.abs(r - (1 - blend)) < 1e-6,
      `a ${(100 * (1 - blend)).toFixed(0)}% straddle should read ${1 - blend}, got ${r}`,
    );
  }
  // So the limit says where the response crosses into a refusal, and it is a
  // straddle of roughly a seventh of the exposure rather than a coin flip.
  const caught = 1 - COMPLEMENT_LIMIT;
  assert.ok(caught > 0.8 && caught < 0.9, `COMPLEMENT_LIMIT puts the crossing at ${caught}`);
});

test('a block the projector never reached is not evidence either way', () => {
  // Background carries no modulation, so including it would dilute the residual
  // by however much of the photograph is not sphere — a property of the framing
  // rather than of the capture. Here the last two blocks are unlit in every
  // frame; the pair is genuinely broken in the two that ARE lit.
  const dark = (v: readonly number[]): number[] => [v[0], v[1], 0, 0];
  const r = complementResidual(
    fp(0, dark(TOY.gray0)),
    fp(1, dark(TOY.gray1)),
    fp(2, dark(TOY.white)),
    fp(3, dark(TOY.black)),
  );
  // Blocks 0 and 1: gray0 is [1,1], gray1 is [1,0], reference [1,1]. The
  // deviation is 0 and 1 over a modulation of 1 and 1 -> 0.5, undiluted.
  assert.equal(r, 0.5, 'the unlit half neither hides the fault nor is counted as agreement');
  assert.equal(
    complementResidual(fp(0, [0, 0, 0, 0]), fp(1, [0, 0, 0, 0]), fp(2, [0, 0, 0, 0]), fp(3, [0, 0, 0, 0])),
    null,
    'a capture with no modulation anywhere cannot answer the question at all',
  );
});

test('the cancelling pair the bookends cannot see is caught here — the point of the mechanism', () => {
  // `docs/EXPERIMENT-8.md`'s blind spot, exactly: run 1 loses `gray0` and shoots
  // `grayInv1` twice. The count is right, every frame is still a patterned
  // frame, and the bookends hand the run back with a clean bill of health.
  const broken = ['white', 'black', 'grayInv0', 'gray1', 'grayInv1', 'grayInv1', 'phase0', 'phase1'];
  const { observations, fingerprints } = toyCapture([broken, TOY_ORDER]);

  const bookends = indexByBookends(observations, TOY_EXPECTED);
  assert.equal(bookends.ok, true, 'the bookends see nothing wrong — this is the blind spot');
  assert.deepEqual(bookends.usableProjectors, [0, 1], 'and offer the broken run');

  const fingerprinted = indexByFingerprint(observations, fingerprints, TOY_EXPECTED);
  assert.equal(fingerprinted.ok, false);
  assert.deepEqual(fingerprinted.usableProjectors, [1], 'the broken run is dropped, the good one kept');
  assert.match(fingerprinted.problems[0] ?? '', /frames 3 and 4/, 'and the pair is named');
  assert.match(fingerprinted.problems[0] ?? '', /Re-shoot projector 1/);
  // The undamaged run is still placed, which is the bookends' property inherited
  // rather than re-derived: a fault stops at the next boundary.
  for (let i = 0; i < 8; i++) assert.equal(fingerprinted.assignment[i], null);
  for (let i = 8; i < 16; i++) assert.equal(fingerprinted.assignment[i], i);
});

test('a clean capture is still clean, and the mechanism says which one it was', () => {
  const { observations, fingerprints } = toyCapture([TOY_ORDER, TOY_ORDER]);
  const r = indexByFingerprint(observations, fingerprints, TOY_EXPECTED);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.usableProjectors, [0, 1]);
  assert.equal(r.mechanism, 'fingerprint');
  assert.deepEqual(r.assignment, Array.from({ length: 16 }, (_, i) => i));
});

test('a cancelling pair inside the phase block is NOT caught, and that is the documented limit', () => {
  // Not a defect being pinned: the plan pairs Gray planes with their complements
  // and pairs the phase steps with nothing, so a drop and a duplicate that both
  // land among the phase frames shift only frames this check does not look at.
  // Asserted so the claim in `indexByFingerprint`'s docblock and in
  // `docs/EXPERIMENT-8.md` cannot quietly stop being true.
  const phaseOnly = ['white', 'black', 'gray0', 'grayInv0', 'gray1', 'grayInv1', 'phase1', 'phase1'];
  const { observations, fingerprints } = toyCapture([phaseOnly, TOY_ORDER]);
  const r = indexByFingerprint(observations, fingerprints, TOY_EXPECTED);
  assert.equal(r.ok, true, 'every Gray pair is still a pair, so nothing here fires');
  assert.deepEqual(r.usableProjectors, [0, 1], 'and the run is offered with a phase step missing');
});

test('a fingerprint too coarse to resolve the finest plane is refused, not run', () => {
  // The silent case: at one block the finest plane averages to a flat half, a
  // frame paired with a duplicate of itself sums to exactly the reference, and
  // the check passes on a run it should reject. Measured, not argued — the same
  // capture is run at both resolutions here and the coarse one comes back clean
  // when the refusal is removed.
  const broken = ['white', 'black', 'grayInv0', 'gray1', 'grayInv1', 'grayInv1', 'phase0', 'phase1'];
  const { observations } = toyCapture([broken, TOY_ORDER]);
  const coarse = [...broken, ...TOY_ORDER].map((name, i) => {
    const v = TOY[name];
    return fp(i, [v.reduce((a, b) => a + b, 0) / v.length], 1);
  });

  const refused = indexByFingerprint(observations, coarse, TOY_EXPECTED);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.usableProjectors, [], 'nothing is offered on an untrustworthy check');
  assert.match(refused.problems[0] ?? '', /1 blocks across and this plan needs at least 4/);

  // And the reason the refusal is not merely cautious: at that resolution the
  // broken pair really does satisfy the identity.
  const flatPair = complementResidual(coarse[2], coarse[3], coarse[0], coarse[1]);
  assert.ok(
    flatPair !== null && flatPair < COMPLEMENT_LIMIT,
    `a coarse grid passes the broken run: residual ${String(flatPair)}`,
  );
});

test('asked for a check the plan cannot support, it refuses rather than impersonating the bookends', () => {
  const { observations, fingerprints } = toyCapture([TOY_ORDER, TOY_ORDER]);
  const noPairs: ExpectedSequence = { kinds: TOY_KINDS, projectors: 2 };
  const r = indexByFingerprint(observations, fingerprints, noPairs);
  assert.equal(r.ok, false);
  assert.deepEqual(r.usableProjectors, []);
  assert.match(r.problems[0] ?? '', /lists no complementary pairs/);
});

test('fingerprints on different grids are refused with the reason that is true', () => {
  // `complementResidual` returns null for two different causes, and the run-level
  // refusal names only one of them ("no modulation to measure against"). A mixed
  // grid reaches it through the other, so it is ruled out first — otherwise the
  // refusal would be a confidently wrong diagnosis, which is the one thing this
  // module is built not to produce.
  const { observations, fingerprints } = toyCapture([TOY_ORDER, TOY_ORDER]);
  const mixed = fingerprints.map((f, i) =>
    i === 5 ? fp(i, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 3) : f,
  );
  const r = indexByFingerprint(observations, mixed, TOY_EXPECTED);
  assert.equal(r.ok, false);
  assert.deepEqual(r.usableProjectors, []);
  assert.match(r.problems[0] ?? '', /not all the same grid/);
  assert.doesNotMatch(
    r.problems.join(' '),
    /no modulation to measure against/,
    'the wrong reason must not be the one reported',
  );
});

test('the pair a refusal names is the pair that broke, adjacent or not', () => {
  // The message used to print `at + 1` and `at + 2`, which is the right answer
  // only because the plan happens to pair adjacent frames — and `ComplementPlan`
  // says in as many words that adjacency is not required. A plan that paired
  // anything else would have been given frame numbers that were not in the pair.
  const spread: ExpectedSequence = {
    kinds: TOY_KINDS,
    projectors: 1,
    complements: { pairs: [[2, 5]], minBlocks: BLOCKS },
  };
  const run = ['white', 'black', 'gray0', 'grayInv0', 'gray1', 'gray1', 'phase0', 'phase1'];
  const { observations, fingerprints } = toyCapture([run]);
  const r = indexByFingerprint(observations, fingerprints, spread);
  assert.equal(r.ok, false);
  assert.match(r.problems[0] ?? '', /frames 3 and 6/, 'the two positions the plan actually paired');
});

test('one fingerprint per photograph, or the two lists are not the same capture', () => {
  const { observations, fingerprints } = toyCapture([TOY_ORDER, TOY_ORDER]);
  const r = indexByFingerprint(observations, fingerprints.slice(0, 15), TOY_EXPECTED);
  assert.equal(r.ok, false);
  assert.match(r.problems[0] ?? '', /15 fingerprints were supplied for 16/);
});

test('what the bookends refuse outright, this refuses too', () => {
  // Composition rather than reimplementation: a lost run boundary is refused by
  // `indexByBookends` before any pair is looked at, and the reason travels.
  const short = TOY_ORDER.slice(2);
  const { observations, fingerprints } = toyCapture([short, TOY_ORDER]);
  const r = indexByFingerprint(observations, fingerprints, TOY_EXPECTED);
  assert.equal(r.ok, false);
  assert.deepEqual(r.usableProjectors, []);
  assert.match(r.problems.join(' '), /Found 1 projector runs and the capture should hold 2/);
});
