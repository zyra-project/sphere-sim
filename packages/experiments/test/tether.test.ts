// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The straddle model, and the two properties the experiment's reading rests on.
 *
 * Experiment 9's conclusion is not the straddle count — it is the SHAPE: that an
 * open-loop capture is close to all-or-nothing, because the phase error that
 * decides it is constant across the capture. A test that only checked counts
 * would let that reading rot silently.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ARMS, FRAMES, FRAMES_PER_RUN } from '../src/tether/design.ts';
import { runTrial, straddles, summarise } from '../src/tether/run.ts';

test('a boundary strictly inside the shutter is a straddle, and an endpoint is not', () => {
  // Boundaries at every 2 s. A shot from 0.9 to 1.15 sees no change.
  assert.equal(straddles(0.9, 0.25, 2), false);
  // From 1.9 to 2.15 the projector switched at 2.0, mid-exposure.
  assert.equal(straddles(1.9, 0.25, 2), true);

  // Both endpoints excluded, each for its own reason. A shutter that CLOSES at
  // the instant of the change caught only the old pattern...
  assert.equal(straddles(1.75, 0.25, 2), false);
  // ...and one that OPENS at it caught only the new one. This is the case the
  // first implementation got wrong: `ceil(2.0 / 2) * 2` is 2.0, which is not
  // strictly greater than the opening instant, so the perfectly aligned shot
  // was reported as the one that straddles.
  assert.equal(straddles(2.0, 0.25, 2), false);

  // An exposure longer than the dwell cannot avoid a change wherever it starts.
  assert.equal(straddles(0.1, 2.5, 2), true);
});

test('drift alone does not straddle at the default dwell, and that is the finding', () => {
  // The worry tethering is usually justified by. At the loosest crystal in the
  // sweep, a whole capture accumulates ~82 ms against 875 ms of slack, so a
  // capture that starts near the middle of a dwell finishes there.
  const loosest = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  assert.ok(loosest !== undefined);
  let touched = 0;
  for (let seed = 1; seed <= 200; seed++) {
    if (runTrial(loosest, 2, 1 / 4, seed).straddled > 0) touched++;
  }
  assert.equal(touched, 0, `${touched} of 200 captures straddled at a 2 s dwell`);
});

test('when an open-loop capture goes wrong it goes wrong for a long stretch', () => {
  // The shape the write-up turns on. The phase error is fixed for the capture,
  // so a shot placed badly is placed badly every time — the failure does not
  // sprinkle, it sits.
  const loosest = ARMS.find((a) => a.key === 'intervalometer-100ppm');
  assert.ok(loosest !== undefined);
  let worstBurst = 0;
  let worstStraddled = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = runTrial(loosest, 0.5, 1 / 4, seed);
    worstBurst = Math.max(worstBurst, r.longestBurst);
    worstStraddled = Math.max(worstStraddled, r.straddled);
  }
  // Not "some frames": essentially the whole capture.
  assert.ok(worstBurst > FRAMES * 0.9, `longest burst was only ${worstBurst} of ${FRAMES}`);
  assert.equal(worstStraddled, worstBurst, 'a bad capture is bad from its first frame to its last');
});

test('a tethered capture cannot straddle, by construction rather than by luck', () => {
  const tethered = ARMS.find((a) => a.tethered);
  assert.ok(tethered !== undefined);
  // Every dwell and exposure in the sweep, including ones nobody would shoot.
  for (const dwell of [0.2, 0.5, 1, 2, 4]) {
    for (const exposure of [1 / 60, 1 / 8, 1 / 4, 1 / 2]) {
      const r = runTrial(tethered, dwell, exposure, 7);
      assert.equal(r.straddled, 0, `tethered straddled at dwell ${dwell}, exposure ${exposure}`);
    }
  }
});

test('runs are counted by the unit a decode actually fails in', () => {
  // `runsTouched` groups by 34, because that is one projector's sequence at one
  // camera position — what `assembleCapture` builds. Counting frames would
  // make a capture with 12 scattered bad frames look like one with 12 in a row,
  // and those are a ruined night and a ruined run respectively.
  const hand = ARMS.find((a) => a.key === 'handheld-remote');
  assert.ok(hand !== undefined);
  const r = runTrial(hand, 0.5, 1 / 4, 11);
  assert.ok(r.runsTouched <= FRAMES / FRAMES_PER_RUN);
  assert.ok(r.straddled >= r.runsTouched, 'a touched run needs at least one straddled frame');
  assert.ok(r.firstStraddle >= 0, 'a capture with straddles names where it started');
});

test('the sweep is deterministic for a given seed', () => {
  // The write-up quotes these cells, and `check:docs` compares the page against
  // the results file. Both rest on the sweep being reproducible.
  const hand = ARMS.find((a) => a.key === 'handheld-remote');
  assert.ok(hand !== undefined);
  const a = summarise(hand, 2, 1 / 4, 50, 0x9e5a1109);
  const b = summarise(hand, 2, 1 / 4, 50, 0x9e5a1109);
  assert.deepEqual(a, b);
});
