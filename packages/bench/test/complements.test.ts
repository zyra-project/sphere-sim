// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The measurement `COMPLEMENT_LIMIT` rests on, kept where it cannot drift away
 * from the thing it measures.
 *
 * `packages/solver/src/indexing.ts` can state the complement identity and check
 * it, and it cannot see the patterns: the solver may not import a `PatternPlan`.
 * The bench may import both, so this is the one place where the frames the
 * emitter actually plays can be put through the check the reader actually runs.
 *
 * Two things are established here and neither is asserted from argument:
 *
 *   1. **The gap.** Over every pairing a single drop-and-duplicate can produce
 *      in the page's own plan, a correct pair returns 0 and a broken one returns
 *      at least twice `COMPLEMENT_LIMIT`. If the plan changes shape, or somebody
 *      moves the constant, this fails.
 *   2. **The hole.** The faults the mechanism does NOT catch are exactly the
 *      ones that disturb no complementary pair — mostly, but not only, the
 *      phase frames moving among themselves. Asserted as an equality rather
 *      than a bound, so the claim in `docs/EXPERIMENT-8.md` cannot quietly
 *      become false in either direction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PATTERN_PLAN,
  compileFrame,
  complementPlan,
  frameBlockGrid,
  planFrames,
  type FrameSpec,
  type PatternPlan,
} from '../src/patterns.ts';
import {
  COMPLEMENT_LIMIT,
  complementResidual,
  indexByFingerprint,
  type ExpectedSequence,
  type FrameFingerprint,
  type FrameKind,
  type FrameObservation,
} from '../../solver/src/indexing.ts';

const RES_X = 1920;
const RES_Y = 1200;

/**
 * The plan's frames as fingerprints, reduced by the emitter's own block grid.
 *
 * `frameBlockGrid` rather than a copy of it: Experiment 8's sweep reduces
 * frames with the same function, and if this file and that one did it
 * differently they would stop certifying the same thing. Review found them
 * holding the same twenty lines twice.
 */
function fingerprintsFor(plan: PatternPlan, blocks: number, offset: number): FrameFingerprint[] {
  const measured = new Uint8Array(blocks * blocks).fill(1);
  return planFrames(plan).map((spec, i) => ({
    ordinal: i,
    blocks,
    values: frameBlockGrid(spec, plan, blocks, RES_X, RES_Y, offset),
    measured,
  }));
}

const kindOf = (spec: FrameSpec): FrameKind =>
  spec.kind === 'white' ? 'white' : spec.kind === 'black' ? 'black' : 'patterned';
const litOf = (spec: FrameSpec): number =>
  spec.kind === 'white' ? 1 : spec.kind === 'black' ? 0 : 0.5;

test('every pair the plan reports really is a Gray plane beside its own complement', () => {
  const plan = DEFAULT_PATTERN_PLAN;
  const specs = planFrames(plan);
  const { pairs, minBlocks } = complementPlan(plan);

  assert.equal(pairs.length, plan.grayBits * 2, 'one per Gray plane per axis');
  assert.equal(minBlocks, Math.pow(2, plan.grayBits));
  for (const [a, b] of pairs) {
    assert.equal(b, a + 1, 'the plan puts a complement next to its pattern; see planFrames');
    assert.equal(specs[a].kind, 'gray');
    assert.equal(specs[b].kind, 'grayInverse');
    assert.equal(specs[a].axis, specs[b].axis);
    assert.equal(specs[a].index, specs[b].index);
  }
  // And the phase frames are paired with nothing, which is the hole below.
  const paired = new Set(pairs.flatMap(([a, b]) => [a, b]));
  for (let i = 0; i < specs.length; i++) {
    if (specs[i].kind === 'phase') assert.equal(paired.has(i), false);
  }
});

test('an offset grid still only ever averages the raster the projector emits', () => {
  // Review found the last window of an offset grid reaching past the end of the
  // raster — at 64 blocks and 0.37, twelve of its thirty-two samples. Out there
  // the frame kinds stop agreeing: `compileFrame` clamps a Gray coordinate but
  // a phase frame is a cosine that keeps oscillating, so at 1931 px on a 1920
  // raster the Gray plane read 0 and the phase step read 0.7034 — neither of
  // them emitted by anything.
  //
  // It mattered because the sweep and the test below both reduce frames through
  // this one function, so the artifact would have sat on both sides of the
  // comparison and they would have agreed about a number neither had measured.
  //
  // The contract is now: each window is clipped to the raster. Pinned by
  // recomputing it here at a much finer sampling than the function uses.
  const plan = DEFAULT_PATTERN_PLAN;
  const { minBlocks } = complementPlan(plan);
  const specs = planFrames(plan);
  const phase = specs.find((sp) => sp.kind === 'phase' && sp.axis === 'u');
  assert.ok(phase !== undefined, 'the plan should hold a phase step on u');

  const offset = 0.37;
  const got = frameBlockGrid(phase, plan, minBlocks, RES_X, RES_Y, offset);
  const frame = compileFrame(phase, plan, RES_X, RES_Y);
  const per = RES_X / minBlocks;

  const clippedMean = (b: number): number => {
    const lo = Math.max(0, (b + offset) * per);
    const hi = Math.min(RES_X, (b + offset + 1) * per);
    let sum = 0;
    const n = 4096;
    for (let k = 0; k < n; k++) sum += frame.at(lo + ((k + 0.5) / n) * (hi - lo));
    return sum / n;
  };
  for (const b of [0, 1, minBlocks - 2, minBlocks - 1]) {
    assert.ok(
      Math.abs(got[b] - clippedMean(b)) < 2e-3,
      `block ${b}: ${got[b]} against the clipped mean ${clippedMean(b)}`,
    );
  }

  // And the last block really did move, so this test has something to catch.
  const unclipped = ((): number => {
    let sum = 0;
    const n = 4096;
    const lo = (minBlocks - 1 + offset) * per;
    for (let k = 0; k < n; k++) sum += frame.at(lo + ((k + 0.5) / n) * per);
    return sum / n;
  })();
  assert.ok(
    Math.abs(unclipped - clippedMean(minBlocks - 1)) > 1e-3,
    'the unclipped window must differ, or this test proves nothing',
  );
});

test('every complement pair the plan reports lands inside the run it describes', () => {
  // The invariant `expectedSequence` used to be able to break: it took a
  // `framesPerProjector` override while the pairs still came from the whole
  // plan, so a shorter run left pair positions pointing past the end of `kinds`
  // and the indexer refused everything. The override is gone; this pins the
  // property it was violating, for any plan rather than just the default.
  for (const grayBits of [1, 4, 6, 8]) {
    const plan: PatternPlan = { grayBits, phaseSteps: 4, phasePeriodStrides: 2, includeWhiteBlack: true };
    const frames = planFrames(plan).length;
    for (const [a, b] of complementPlan(plan).pairs) {
      assert.ok(a >= 0 && b < frames, `grayBits ${grayBits}: pair [${a},${b}] outside 0..${frames - 1}`);
    }
  }
});

test('a correct pair returns zero and a broken one misses by at least twice the limit', () => {
  // The gap COMPLEMENT_LIMIT sits in the middle of, measured over every pairing
  // a one-position shift can produce, on both an aligned grid and an offset one.
  const plan = DEFAULT_PATTERN_PLAN;
  const { pairs, minBlocks } = complementPlan(plan);
  const specs = planFrames(plan);
  const whiteAt = specs.findIndex((s) => s.kind === 'white');
  const blackAt = specs.findIndex((s) => s.kind === 'black');

  for (const offset of [0, 0.37]) {
    const f = fingerprintsFor(plan, minBlocks, offset);
    const w = f[whiteAt];
    const k = f[blackAt];

    let matchedWorst = 0;
    for (const [a, b] of pairs) {
      const r = complementResidual(f[a], f[b], w, k);
      assert.ok(r !== null);
      matchedWorst = Math.max(matchedWorst, r);
    }
    assert.ok(matchedWorst < 1e-6, `matched pairs should return 0, worst was ${matchedWorst}`);

    // What a one-position shift actually puts in a pair slot: the frame after
    // the one that belongs there, on one side or the other.
    let brokenBest = Number.POSITIVE_INFINITY;
    let where = '';
    for (const [a, b] of pairs) {
      for (const [x, y] of [
        [a, b + 1],
        [a - 1, b - 1],
        [a, a],
        [b, b],
      ]) {
        if (x < 0 || y < 0 || x >= specs.length || y >= specs.length) continue;
        const r = complementResidual(f[x], f[y], w, k);
        assert.ok(r !== null);
        if (r < brokenBest) {
          brokenBest = r;
          where = `${x}+${y}`;
        }
      }
    }
    assert.ok(
      brokenBest >= 2 * COMPLEMENT_LIMIT,
      `offset ${offset}: the faintest broken pair (${where}) returned ${brokenBest.toFixed(4)}, ` +
        `which leaves no room under COMPLEMENT_LIMIT=${COMPLEMENT_LIMIT}`,
    );
  }
});

test('a grid coarser than the plan needs passes a run it should reject', () => {
  // Why ComplementPlan.minBlocks is a floor rather than a preference, shown
  // rather than argued. At half the required grid, IN STEP with the pattern,
  // the finest plane averages to a flat half in every block — so a frame
  // against a duplicate of itself satisfies the identity exactly.
  const plan = DEFAULT_PATTERN_PLAN;
  const { pairs, minBlocks } = complementPlan(plan);
  const specs = planFrames(plan);
  const whiteAt = specs.findIndex((s) => s.kind === 'white');
  const blackAt = specs.findIndex((s) => s.kind === 'black');
  const finest = pairs[pairs.length - 1][0];

  const coarse = fingerprintsFor(plan, minBlocks / 2, 0);
  const doubled = complementResidual(
    coarse[finest],
    coarse[finest],
    coarse[whiteAt],
    coarse[blackAt],
  );
  assert.ok(doubled !== null);
  assert.ok(
    doubled < COMPLEMENT_LIMIT,
    `the point of the floor is that this passes: got ${doubled.toFixed(4)}`,
  );

  // At the required grid the same fault is unmissable.
  const fine = fingerprintsFor(plan, minBlocks, 0);
  const seen = complementResidual(fine[finest], fine[finest], fine[whiteAt], fine[blackAt]);
  assert.ok(seen !== null && seen > 2 * COMPLEMENT_LIMIT, `got ${String(seen)}`);
});

test('every cancelling drop-and-duplicate is caught except the ones that disturb no pair', () => {
  // The exhaustive version of Experiment 8's `cancel` arm: instead of sampling
  // faults at random, put one drop and one duplicate at EVERY pair of positions
  // in a single run and ask what the mechanism does. The misses are asserted as
  // an exact set rather than a rate, because "mostly caught" is not a claim
  // anybody can act on.
  const plan = DEFAULT_PATTERN_PLAN;
  const complements = complementPlan(plan);
  const specs = planFrames(plan);
  const expected: ExpectedSequence = {
    kinds: specs.map(kindOf),
    projectors: 1,
    complements,
  };
  const clean = fingerprintsFor(plan, complements.minBlocks, 0.37);
  const firstPhase = specs.findIndex((s) => s.kind === 'phase');
  assert.ok(firstPhase > 0);

  let caught = 0;
  const missed: [number, number][] = [];
  /** Faults after which every Gray position still holds the frame it should. */
  const undisturbed: [number, number][] = [];
  for (let drop = 0; drop < specs.length; drop++) {
    if (kindOf(specs[drop]) !== 'patterned') continue;
    for (let dupe = 0; dupe < specs.length; dupe++) {
      if (kindOf(specs[dupe]) !== 'patterned' || dupe === drop) continue;

      // Drop first, then duplicate what is left — Experiment 8's own ordering.
      const order = specs.map((_, i) => i).filter((i) => i !== drop);
      const at = order.indexOf(dupe);
      order.splice(at, 0, dupe);
      assert.equal(order.length, specs.length, 'the count still adds up — that is the fault');

      const observations: FrameObservation[] = order.map((frame, i) => ({
        ordinal: i,
        mean: litOf(specs[frame]),
        litFraction: litOf(specs[frame]),
      }));
      const fingerprints = order.map((frame, i) => ({ ...clean[frame], ordinal: i }));
      if (order.slice(0, firstPhase).every((frame, i) => frame === i)) {
        undisturbed.push([drop, dupe]);
      }

      const result = indexByFingerprint(observations, fingerprints, expected);
      if (result.usableProjectors.length === 0) caught++;
      else missed.push([drop, dupe]);
    }
  }

  const total = caught + missed.length;
  assert.ok(total > 500, `the sweep should be exhaustive, ran ${total}`);

  // The characterisation, and it is an EQUIVALENCE rather than a bound. The
  // first version of this test asserted that every miss had both its faults
  // inside the phase block, and the sweep found a counter-example immediately:
  // dropping the first phase frame while duplicating the last Gray frame leaves
  // every Gray position holding the frame it should, so nothing this mechanism
  // looks at has moved — even though one of the two faults is a Gray frame.
  //
  // What actually decides it is whether the fault DISTURBS a pair, not where
  // the operator's two mistakes nominally landed. Stated that way it is exact
  // in both directions, which is what makes it a claim rather than a rate.
  assert.deepEqual(
    missed.map((m) => m.join('+')).sort(),
    undisturbed.map((m) => m.join('+')).sort(),
    'the mechanism misses a fault exactly when the fault leaves every Gray pair intact',
  );
  assert.ok(missed.length > 0, 'and the hole is real rather than a case that cannot arise');
  assert.ok(
    caught / total > 0.9,
    `caught ${caught} of ${total}, which is below what the docs claim`,
  );

  // Not every miss is two phase frames, and saying so is the difference between
  // a claim and a slogan. Some duplicate a GRAY frame whose copy lands in the
  // first phase slot, so no pair moves and nothing fires. The docs said "both
  // faults inside the phase block" in four places; review found that wording
  // survived here as the printed summary even after the assertion above was
  // corrected to the equivalence.
  const grayDuplicates = missed.filter(([, dupe]) => dupe < firstPhase);
  assert.ok(
    grayDuplicates.length > 0,
    'the counter-example class must be present, or the wording below overstates the hole',
  );
  assert.ok(
    grayDuplicates.every(([, dupe]) => dupe === firstPhase - 1),
    'and it is the LAST Gray frame, whose copy lands in the first phase slot',
  );
  process.stdout.write(
    `    complement fingerprint: caught ${caught} of ${total} cancelling pairs ` +
      `(${((100 * caught) / total).toFixed(1)}%); the ${missed.length} it misses are exactly ` +
      `those that disturb no Gray pair — ${missed.length - grayDuplicates.length} of them the ` +
      `${specs.length - firstPhase}-frame phase block moving within itself, and ` +
      `${grayDuplicates.length} duplicating the last Gray frame into the first phase slot\n`,
  );
});
