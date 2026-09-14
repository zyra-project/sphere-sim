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
  MIN_CLASSIFY_MARGIN,
  WHITE_CUT,
  bookendPrefix,
  classify,
  indexByBookends,
  indexByOrder,
  observe,
  type ExpectedSequence,
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

test('a photograph reports the fraction of itself that is lit', () => {
  // Four pixels: all on, all off, half on. The fraction is what separates a
  // white frame from a Gray plane, and it is the one that does not move with
  // how much of the picture the sphere happens to fill.
  assert.equal(observe(image([1, 1, 1, 1], 2), 0).litFraction, 0);
  assert.equal(observe(image([0, 0, 0, 0], 2), 0).litFraction, 0);
  const half = observe(image([1, 1, 0, 0], 2), 0);
  assert.equal(half.litFraction, 0.5);
  assert.equal(half.mean, 0.5);
  // A flat frame has no mid-level to be above, which is why a folder is
  // classified against its own BRIGHTEST frame rather than against each frame.
  const lit = observe(image([1, 1, 0, 0, 0, 0, 0, 0], 4), 0);
  assert.equal(lit.litFraction, 0.25);
  // Channel 0 only, matching decode.ts — a three-channel white frame reads the
  // same as a one-channel one rather than three times as bright.
  assert.equal(observe(image([1, 1, 0, 0], 2, 3), 0).mean, 0.5);
  // A mask measures the sphere and not the wall behind it.
  const mask = new Uint8Array([1, 1, 0, 0]);
  assert.equal(observe(image([1, 1, 0, 0], 2), 0, mask).mean, 1);
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
  // So this is the hole that decides what Phase 2 needs next, and it is the
  // reason `docs/EXPERIMENT-8.md` measures how often it bites rather than
  // arguing about it. Closing it needs something that distinguishes patterned
  // frames FROM EACH OTHER: the projected index the plan calls mechanism 3, or a
  // cheap per-frame fingerprint that can test whether a Gray plane and its
  // neighbour are still complements.
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
