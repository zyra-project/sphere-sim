// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 7's summarising half.
 *
 * What is worth pinning here is the POLICY, not the figures — a test that
 * asserted today's medians would fail the next time a seed is added and teach
 * nobody anything. The policy is which rows are allowed to reach a median at
 * all, and it is the part with a history: experiment 6 published a
 * non-converged solve as an arm's headline, on the reasoning that a median is
 * robust to outliers. A median is robust to an outlier's MAGNITUDE, not to its
 * presence in the middle, and the page refuses a solve that never converged —
 * so averaging one in publishes a calibration nobody would be allowed to
 * install.
 *
 * The other half is the confound bound. `radiusDeficitMm` is the number that
 * says how much of a mesh arm's gap could be the bodies differing rather than
 * the derivative, and a number used to argue "small" has to be right in the
 * direction it is used.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARMS } from '../src/tessellation/design.ts';
import type { PointRun } from '../src/tessellation/run.ts';
import { radiusDeficitMm } from '../src/tessellation/run.ts';
import {
  MECHANISM,
  mechanismRows,
  partialSeeds,
  signTestP,
  summarize,
} from '../src/tessellation/summarize.ts';

const RADIUS_M = 0.8636;

/**
 * Four projectors' worth of per-axis error, all equal unless a test says
 * otherwise. Values are deliberately uniform so a test that cares about an axis
 * sets exactly that axis and nothing else can explain its result.
 */
function projectors(over: Partial<PointRun['perProjector'][number]> = {}): PointRun['perProjector'] {
  return [0, 1, 2, 3].map((i) => ({
    id: `p${i}`,
    positionMm: 10,
    rotationDeg: 0.05,
    dxMm: 5,
    dyMm: 5,
    dzMm: 5,
    yawDeg: 0.03,
    pitchDeg: 0.02,
    rollDeg: 0.01,
    ...over,
  }));
}

/** One point, converged and unremarkable, unless a field is overridden. */
function point(arm: string, seed: number, over: Partial<PointRun> = {}): PointRun {
  const grid = ARMS.find((a) => a.key === arm)?.grid ?? null;
  return {
    arm,
    seed,
    documented: false,
    posePositionMm: 10,
    poseRotationDeg: 0.05,
    residualRmsPx: 0.27,
    converged: true,
    stopReason: 'cost',
    gaugeConstraints: 1,
    shiftKnown: ARMS.find((a) => a.key === arm)?.shiftKnown === true,
    iterations: 30,
    facets: grid === null ? 0 : grid.nLat * grid.nLon * 2,
    perProjector: projectors(),
    seconds: 40,
    ...over,
  };
}

/** Every arm at every seed, so nothing is dropped for being unfinished. */
function fullSweep(seeds: readonly number[], over: (arm: string, seed: number) => Partial<PointRun> = () => ({})): PointRun[] {
  return seeds.flatMap((s) => ARMS.map((a) => point(a.key, s, over(a.key, s))));
}

test('a seed where every arm converged reaches the medians', () => {
  const rows = summarize(fullSweep([1, 2, 3]));
  const all = rows.filter((r) => r.scope === 'all');
  assert.equal(all.length, ARMS.length);
  for (const r of all) {
    assert.equal(r.n, 3, `${r.arm} should count all three seeds`);
    assert.equal(r.seedsDropped, 0);
  }
});

test('a seed one arm never settled is dropped from EVERY arm, not just that one', () => {
  // The failure is in one mesh arm; the analytic control converged on all three.
  const runs = fullSweep([1, 2, 3], (arm, seed) =>
    arm === '64x128-smooth' && seed === 2 ? { converged: false, stopReason: 'lambda' } : {},
  );
  const all = summarize(runs).filter((r) => r.scope === 'all');
  for (const r of all) {
    assert.equal(r.n, 2, `${r.arm} should have lost seed 2 with the arm that failed`);
    assert.equal(r.seedsDropped, 1, `${r.arm} should report the drop`);
  }
  // Every figure in the table is a ratio against one of these, so a control that
  // kept a seed its mesh arms lost would compare the two over different rigs.
  const control = all.find((r) => r.arm === 'analytic');
  assert.ok(control !== undefined);
  assert.equal(control.notConverged, 0, 'the control itself never failed');
  assert.equal(control.n, 2, 'and it still loses the seed');
});

test('a non-converged row cannot reach a median even when it is the middle value', () => {
  // Three seeds; the failed one sits between the other two, which is exactly the
  // case a median does NOT protect against and experiment 6 published.
  const runs = fullSweep([1, 2, 3], (arm, seed) => {
    if (arm !== '64x128') return seed === 1 ? { posePositionMm: 5 } : seed === 3 ? { posePositionMm: 30 } : {};
    if (seed === 1) return { posePositionMm: 5 };
    if (seed === 3) return { posePositionMm: 30 };
    return { posePositionMm: 17, converged: false, stopReason: 'maxIterations' };
  });
  const arm = summarize(runs).filter((r) => r.scope === 'all').find((r) => r.arm === '64x128');
  assert.ok(arm !== undefined);
  assert.notEqual(arm.medianPosMm, 17, 'the refused solve must not be the published median');
  assert.equal(arm.medianPosMm, 17.5, 'the two installable solves decide it');
  assert.equal(arm.notConverged, 1, 'and the failure stays visible rather than vanishing');
  assert.equal(arm.stops.maxIterations, 1, 'named by its reason, not just counted');
});

test('the unexcluded scope keeps the refused solve the headline scope drops', () => {
  // The drop policy removes seeds where an arm stalled, and the arms that stall
  // are the smooth ones — so the exclusion is pointed at the comparison the
  // experiment is for. This scope is how that stays checkable.
  const runs = fullSweep([1, 2, 3], (arm, seed) => {
    if (arm !== '64x128') return {};
    if (seed === 1) return { posePositionMm: 5 };
    if (seed === 3) return { posePositionMm: 30 };
    return { posePositionMm: 17, converged: false, stopReason: 'lambda' };
  });
  const rows = summarize(runs);
  const headline = rows.find((r) => r.scope === 'all' && r.arm === '64x128');
  const unexcluded = rows.find((r) => r.scope === 'all-including-refused' && r.arm === '64x128');
  assert.ok(headline !== undefined && unexcluded !== undefined);
  assert.equal(headline.n, 2);
  assert.equal(headline.medianPosMm, 17.5, 'the stalled row is out of the headline');
  assert.equal(unexcluded.n, 3);
  assert.equal(unexcluded.medianPosMm, 17, 'and back in the scope that excludes nothing');
  assert.equal(unexcluded.seedsDropped, 0, 'a scope that drops nothing must not claim a drop');
  // The control never failed, so the two scopes differ ONLY where a row did.
  const cHead = rows.find((r) => r.scope === 'all' && r.arm === 'analytic');
  const cAll = rows.find((r) => r.scope === 'all-including-refused' && r.arm === 'analytic');
  assert.equal(cHead?.n, 2, 'the control still loses the seed under the policy');
  assert.equal(cAll?.n, 3, 'and keeps it where nothing is excluded');
});

test('an unfinished seed is excluded from EVERY scope, the unexcluded one included', () => {
  // Convergence is a policy call; a missing arm is not a result at all, and a
  // ratio over arms that have not all run is not a comparison in any scope.
  const runs = [...fullSweep([1, 2]), ...ARMS.slice(0, 2).map((a) => point(a.key, 3))];
  for (const scope of ['all', 'all-including-refused'] as const) {
    for (const r of summarize(runs).filter((s) => s.scope === scope)) {
      assert.equal(r.n, 2, `${r.arm} in ${scope} should ignore the half-finished seed`);
    }
  }
});

test('a seed still missing an arm is unfinished, not dropped', () => {
  // A sweep interrupted mid-seed. Counting the gap as a policy exclusion would
  // let a half-run report a drop nobody made.
  const runs = [...fullSweep([1, 2]), ...ARMS.slice(0, 2).map((a) => point(a.key, 3))];
  const all = summarize(runs).filter((r) => r.scope === 'all');
  for (const r of all) {
    assert.equal(r.seedsDropped, 0, `${r.arm} should report no policy drop`);
    assert.equal(r.n, 2, `${r.arm} should count only the complete seeds`);
  }
});

test('a shift-known arm is scored against the shift-known floor, not the free one', () => {
  // The free control is made twice as bad as the pinned one. An arm scored
  // against the wrong control would fold the degeneracy's own removal into the
  // number meant to isolate the derivative.
  const runs = fullSweep([1, 2, 3], (arm) =>
    arm === 'analytic' ? { posePositionMm: 20 } : arm === 'analytic-shift-known' ? { posePositionMm: 10 } : {},
  );
  const all = summarize(runs).filter((r) => r.scope === 'all');
  const free = all.find((r) => r.arm === '64x128');
  const pinned = all.find((r) => r.arm === '64x128-shift-known');
  assert.ok(free !== undefined && pinned !== undefined);
  assert.equal(free.control, 'analytic');
  assert.equal(pinned.control, 'analytic-shift-known');
  // Same 10 mm arm, two controls: 0.5x of the free floor and 1.0x of the pinned.
  assert.equal(free.posVsControl, 0.5);
  assert.equal(pinned.posVsControl, 1);
});

test('the documented scope holds only the flagged seed', () => {
  const runs = [
    ...fullSweep([1]).map((r) => ({ ...r, documented: true })),
    ...fullSweep([2, 3]),
  ];
  const rows = summarize(runs);
  for (const r of rows.filter((s) => s.scope === 'documented')) assert.equal(r.n, 1);
  for (const r of rows.filter((s) => s.scope === 'all')) assert.equal(r.n, 3);
});

test('the facet deficit falls as the square of the refinement', () => {
  // Every vertex of `ellipsoidMesh` lies exactly on the sphere, so every facet
  // lies inside it and a chord's sagitta goes as the square of its angle. If
  // this stopped holding, the bound the design uses to call the control confound
  // small would be measuring something else.
  const coarse = radiusDeficitMm({ nLat: 64, nLon: 128 }, RADIUS_M);
  const fine = radiusDeficitMm({ nLat: 128, nLon: 256 }, RADIUS_M);
  assert.ok(coarse.mean > 0 && fine.mean > 0, 'a facet is inside the sphere, never outside');
  assert.ok(coarse.max >= coarse.mean, 'the deepest centroid is at least the average one');
  const ratio = coarse.mean / fine.mean;
  assert.ok(ratio > 3.8 && ratio < 4.2, `halving the spacing should quarter the deficit, got ${ratio}`);
});

test('the deficit is under a millimetre at every grid the experiment runs', () => {
  // The design argues the bodies differ by far less than the pose errors being
  // compared. That argument is only as good as this number.
  for (const arm of ARMS) {
    if (arm.grid === null) continue;
    const d = radiusDeficitMm(arm.grid, RADIUS_M);
    assert.ok(d.max < 1, `${arm.key} deepest deficit ${d.max} mm is not a bounded confound`);
  }
});

test('a recovered fraction is withheld when the facet arm sits on its control', () => {
  // The denominator is the facet arm's excess over its control, and it goes to
  // zero — with lens shift pinned at truth the coarse facet arm lands on the
  // analytic floor. A first draft divided by it anyway and printed -8484%.
  const runs = fullSweep([1, 2, 3], (arm) => {
    if (arm === 'analytic') return { posePositionMm: 11, poseRotationDeg: 0.048 };
    if (arm === '64x128') return { posePositionMm: 11.02, poseRotationDeg: 0.0756 };
    if (arm === '64x128-smooth') return { posePositionMm: 17.8, poseRotationDeg: 0.0191 };
    return {};
  });
  const rows = mechanismRows(summarize(runs).filter((r) => r.scope === 'all'), runs);
  const coarse = rows.find((r) => r.facetArm === '64x128');
  assert.ok(coarse !== undefined);
  assert.equal(coarse.posRecoveredPercent, null, 'no excess in position, so no fraction of one');
  assert.ok(
    coarse.rotRecoveredPercent !== null && coarse.rotRecoveredPercent > 100,
    'rotation has a real excess and smooth clears the control, which is not guarded away',
  );
});

test('a mechanism pair is a pair of arms, not a pair of bodies', () => {
  // The guarantee the whole experiment rests on: each pair differs in the
  // derivative and in nothing else, so both halves must carry the same facets
  // and the same shift condition.
  const sweep = fullSweep([1, 2]);
  const rows = mechanismRows(summarize(sweep).filter((r) => r.scope === 'all'), sweep);
  assert.ok(rows.length >= 3, 'every designed pair should be present');
  const summary = summarize(fullSweep([1, 2])).filter((r) => r.scope === 'all');
  for (const m of rows) {
    const f = summary.find((r) => r.arm === m.facetArm);
    const g = summary.find((r) => r.arm === m.smoothArm);
    assert.ok(f !== undefined && g !== undefined);
    assert.equal(f.facets, g.facets, `${m.label}: the two arms must be the same tessellation`);
    assert.equal(f.shiftKnown, g.shiftKnown, `${m.label}: and the same shift condition`);
    assert.equal(f.control, g.control, `${m.label}: and scored against the same control`);
  }
});

test('every smooth arm is paired, and paired with its own facet twin', () => {
  // The mechanism table is the only comparison in this experiment that isolates
  // the derivative, and its pair list is maintained by hand beside ARMS. An arm
  // added without a pair does not fail anything — it just stops being measured.
  const smooth = ARMS.filter((a) => a.meshNormal === 'smooth');
  assert.ok(smooth.length > 0, 'the experiment has smooth arms at all');
  for (const arm of smooth) {
    const pairs = MECHANISM.filter((m) => m.smooth === arm.key);
    assert.equal(pairs.length, 1, `${arm.key} should appear in exactly one mechanism pair`);
    const twin = ARMS.find((a) => a.key === pairs[0].facet);
    assert.ok(twin !== undefined, `${arm.key} is paired with an arm that does not exist`);
    assert.equal(twin.meshNormal, 'facet', `${arm.key}'s twin must be the facet mode`);
    assert.deepEqual(twin.grid, arm.grid, `${arm.key}'s twin must be the same tessellation`);
    assert.equal(
      twin.shiftKnown === true,
      arm.shiftKnown === true,
      `${arm.key}'s twin must be under the same shift condition`,
    );
  }
  for (const m of MECHANISM) {
    assert.ok(ARMS.some((a) => a.key === m.facet), `pair names a missing facet arm ${m.facet}`);
    assert.ok(ARMS.some((a) => a.key === m.smooth), `pair names a missing smooth arm ${m.smooth}`);
  }
});

test('every arm key is distinct, and every control a pair names exists', () => {
  // A duplicated key would have two arms silently share a row; a control that is
  // not an arm would make every ratio in its column NaN.
  assert.equal(new Set(ARMS.map((a) => a.key)).size, ARMS.length, 'arm keys must be unique');
  const rows = summarize(fullSweep([1, 2])).filter((r) => r.scope === 'all');
  for (const r of rows) {
    assert.ok(ARMS.some((a) => a.key === r.control), `${r.arm} names a control that is not an arm`);
    assert.ok(Number.isFinite(r.posVsControl), `${r.arm} has no finite ratio against ${r.control}`);
  }
});

test('the sign test is exact at the sizes this experiment runs', () => {
  // Against hand-computable values, because a normal approximation is worst
  // exactly where n is small and n here is thirteen.
  assert.equal(signTestP(0, 0), 1, 'no pairs is no evidence');
  assert.equal(signTestP(5, 10), 1, 'an even split cannot be evidence of anything');
  // 13 of 13: two tails of 0.5^13 each.
  assert.ok(Math.abs(signTestP(13, 13) - 2 * Math.pow(0.5, 13)) < 1e-12);
  // 12 of 13: (1 + 13) tail terms each side.
  assert.ok(Math.abs(signTestP(12, 13) - 2 * 14 * Math.pow(0.5, 13)) < 1e-12);
  assert.equal(signTestP(1, 13), signTestP(12, 13), 'two-sided: direction cannot matter');
  assert.ok(signTestP(10, 13) > signTestP(12, 13), 'a weaker split is weaker evidence');
});

test('paired wins are matched by seed, never zipped by position', () => {
  // Two arms filtered out of one log can differ in length and order the moment a
  // point is missing. Zipping would then score one seed's smooth solve against
  // another seed's facet solve.
  const runs = fullSweep([1, 2, 3], (arm, seed) => {
    // Smooth is better on seeds 1 and 3, worse on seed 2.
    if (arm === '64x128') return { poseRotationDeg: seed === 2 ? 0.01 : 0.09 };
    if (arm === '64x128-smooth') return { poseRotationDeg: seed === 2 ? 0.09 : 0.01 };
    return {};
  });
  // Drop one arm's seed-2 row so the two lists are neither equal in length nor
  // aligned; the surviving comparison is seeds 1 and 3, both smooth wins.
  const holed = runs.filter((r) => !(r.arm === '64x128' && r.seed === 2));
  const m = mechanismRows(
    summarize(holed).filter((r) => r.scope === 'all-including-refused'),
    holed,
  ).find((x) => x.facetArm === '64x128');
  assert.ok(m !== undefined);
  assert.equal(m.pairs, 2, 'only the seeds present in both arms are pairs');
  assert.equal(m.rotSmoothWins, 2, 'and both of them are smooth wins');
});

test('an empty point log yields no pairs and no medians, never borrowed ones', () => {
  // `runs` is required now, but an empty array is still reachable. It must not
  // produce a row whose medians came from the summary and whose counts came from
  // nowhere — that row would look computed and be two populations.
  const summary = summarize(fullSweep([1, 2, 3])).filter((r) => r.scope === 'all');
  const m = mechanismRows(summary, []).find((x) => x.facetArm === '64x128');
  assert.ok(m !== undefined);
  assert.equal(m.pairs, 0, 'no pairs were counted');
  assert.ok(Number.isNaN(m.facetMedianPosMm), 'and no median was invented for them');
  assert.equal(m.rotSignP, 1, 'the test over zero pairs is vacuous');
});

test('a mechanism pair keeps a seed that only an unrelated arm lost', () => {
  // The arms table takes ratios across every arm, so one failure anywhere costs
  // the seed everywhere. A pair reads three arms and should not pay for the
  // other seven — on the real sweep that rule cost 7 of 13 seeds and left the
  // sign tests at p=0.22.
  const runs = fullSweep([1, 2, 3], (arm, seed) =>
    arm === '192x384' && seed === 2 ? { converged: false, stopReason: 'maxIterations' } : {},
  );
  const summary = summarize(runs).filter((r) => r.scope === 'all');
  assert.equal(summary[0].n, 2, 'the arms table loses the seed, as it must');

  const coarse = mechanismRows(summary, runs).find((m) => m.facetArm === '64x128');
  assert.ok(coarse !== undefined);
  assert.equal(coarse.pairs, 3, 'the coarse pair never reads 192x384 and keeps all three seeds');

  // And the pair that DOES read the failing arm still loses it.
  const fine = mechanismRows(summary, runs).find((m) => m.facetArm === '192x384');
  assert.ok(fine !== undefined);
  assert.equal(fine.pairs, 2, 'the pair containing the failure pays for it');
});

test('a mechanism row computes every figure over its own pairs, borrowing none', () => {
  // The block must describe ONE population. The arms table's medians are over a
  // stricter seed set, so a row that borrowed one of them would report medians
  // from one population beside win counts from another.
  //
  // Seed 2 is made an outlier in the coarse facet arm AND failed in an unrelated
  // arm. The arms table drops it; the pair keeps it; so the pair's facet median
  // must be the three-seed one, not the arms table's two-seed one.
  const runs = fullSweep([1, 2, 3], (arm, seed) => {
    if (arm === '192x384' && seed === 2) return { converged: false, stopReason: 'maxIterations' };
    if (arm === '64x128') return { posePositionMm: seed === 2 ? 100 : seed === 1 ? 10 : 20 };
    return {};
  });
  const summary = summarize(runs).filter((r) => r.scope === 'all');
  assert.equal(summary.find((r) => r.arm === '64x128')?.medianPosMm, 15, 'arms table: seeds 1 and 3');
  const coarse = mechanismRows(summary, runs).find((m) => m.facetArm === '64x128');
  assert.equal(coarse?.facetMedianPosMm, 20, 'the pair sees all three, so its median is the middle one');
});

test('the gauge count is summarised per arm, over the counted rows only', () => {
  // The claim it supports is that a tessellation frees nothing the analytic
  // control does not — so a row excluded from the medians must not contribute a
  // gauge value the medians never saw.
  const runs = fullSweep([1, 2, 3], (arm, seed) =>
    arm === '64x128' && seed === 2
      ? { converged: false, stopReason: 'lambda', gaugeConstraints: 7 }
      : {},
  );
  const rows = summarize(runs);
  const headline = rows.find((r) => r.scope === 'all' && r.arm === '64x128');
  const unexcluded = rows.find((r) => r.scope === 'all-including-refused' && r.arm === '64x128');
  assert.deepEqual(headline?.gaugeConstraints, [1], 'the dropped row cannot contribute its 7');
  assert.deepEqual(unexcluded?.gaugeConstraints, [1, 7], 'and does where nothing is dropped');
});

test('the axis attribution finds the axis that actually moved', () => {
  // Yaw is made better in the smooth arm on every seed and the other two axes
  // are held identical, so a correct attribution names yaw and only yaw.
  const runs = fullSweep([1, 2, 3], (arm) => {
    if (arm === '64x128') return { perProjector: projectors({ yawDeg: 0.09 }) };
    if (arm === '64x128-smooth') return { perProjector: projectors({ yawDeg: 0.01 }) };
    return {};
  });
  const m = mechanismRows(
    summarize(runs).filter((r) => r.scope === 'all'),
    runs,
  ).find((x) => x.facetArm === '64x128');
  assert.ok(m !== undefined);
  const yaw = m.axes.find((a) => a.axis === 'yaw');
  const pitch = m.axes.find((a) => a.axis === 'pitch');
  const roll = m.axes.find((a) => a.axis === 'roll');
  assert.equal(yaw?.smoothWins, 3, 'yaw moved on every seed');
  assert.equal(yaw?.facetMedianDeg, 0.09);
  assert.equal(yaw?.smoothMedianDeg, 0.01);
  assert.equal(pitch?.smoothWins, 0, 'pitch did not move');
  assert.equal(roll?.smoothWins, 0, 'roll did not move');
  // A tie is not a loss: with every seed tied, the sign test has no pairs and
  // must be vacuous rather than reading as evidence the axis got worse.
  assert.equal(pitch?.signP, 1);
});

test('an axis error is taken in absolute value, so a rig erring one way still registers', () => {
  // Four projectors point four ways, so a real yaw error carries both signs —
  // but a fixture that MIXES signs cannot test this, because a max seeded at
  // zero finds the positive one either way. The first draft of this test made
  // exactly that mistake and passed with `Math.abs` removed.
  //
  // So every projector errs NEGATIVE here. Without the absolute value the max
  // stays at its zero seed and the arm reports no yaw error at all.
  const runs = fullSweep([1, 2, 3], (arm) => {
    const allNegative = (v: number): PointRun['perProjector'] =>
      projectors().map((p) => ({ ...p, yawDeg: -v }));
    if (arm === '64x128') return { perProjector: allNegative(0.08) };
    if (arm === '64x128-smooth') return { perProjector: allNegative(0.02) };
    return {};
  });
  const m = mechanismRows(
    summarize(runs).filter((r) => r.scope === 'all'),
    runs,
  ).find((x) => x.facetArm === '64x128');
  const yaw = m?.axes.find((a) => a.axis === 'yaw');
  assert.equal(yaw?.facetMedianDeg, 0.08, 'a rig erring -0.08 everywhere carries 0.08 of error');
  assert.equal(yaw?.smoothMedianDeg, 0.02);
  assert.equal(yaw?.smoothWins, 3);
});

test('the axis figures never purport to decompose the total rotation', () => {
  // Guards the docblock's caution with a number: three Euler differences do not
  // sum to the angle between two rotation matrices, and a future summary that
  // started adding them would be wrong in a way nothing else here would catch.
  const runs = fullSweep([1]);
  const m = mechanismRows(summarize(runs).filter((r) => r.scope === 'all'), runs).find(
    (x) => x.facetArm === '64x128',
  );
  assert.ok(m !== undefined);
  const summed = m.axes.reduce((a, x) => a + x.facetMedianDeg, 0);
  assert.notEqual(
    Number(summed.toFixed(4)),
    Number(m.facetMedianRotDeg.toFixed(4)),
    'the fixture is built so the sum and the total differ; nothing may equate them',
  );
});

test('a crashed solve scores no axis at all, rather than scoring zero on every axis', () => {
  // `runPoint` records an empty `perProjector` when the solve threw, because
  // there are no projector errors to record — while every scalar beside it
  // records NaN. A maximum seeded at zero turns that absence into a PERFECT
  // score, and the crashed arm then wins every axis comparison it is in.
  // Smooth is genuinely better on yaw everywhere, so seeds 1 and 3 are real
  // wins and the comparison is not a row of ties that would come out vacuous
  // either way. Seed 2's smooth solve crashed.
  const runs = fullSweep([1, 2, 3], (arm, seed) => {
    if (arm === '64x128') return { perProjector: projectors({ yawDeg: 0.09 }) };
    if (arm !== '64x128-smooth') return {};
    if (seed !== 2) return { perProjector: projectors({ yawDeg: 0.01 }) };
    return {
      converged: false,
      stopReason: 'no-solve',
      perProjector: [],
      posePositionMm: Number.NaN,
      poseRotationDeg: Number.NaN,
    };
  });
  // The unexcluded scope is where a refused solve still reaches the figures, so
  // that is where this could do damage.
  const m = mechanismRows(
    summarize(runs).filter((r) => r.scope === 'all-including-refused'),
    runs,
  ).find((x) => x.facetArm === '64x128');
  assert.ok(m !== undefined);
  assert.equal(m.pairs, 3, 'the crashed seed is still a pair in this scope');
  const yaw = m.axes.find((a) => a.axis === 'yaw');
  assert.ok(yaw !== undefined);
  assert.equal(yaw.smoothWins, 2, 'the two real wins, and NOT the crashed seed as a third');
  // The denominator drops the uncomparable pair rather than keeping it: two
  // comparable pairs, both won.
  assert.equal(yaw.signP, signTestP(2, 2));
  // The axes nothing touched are ties on the comparable seeds, so their test is
  // vacuous — and the crashed seed must not turn that into a win either.
  for (const a of m.axes.filter((x) => x.axis !== 'yaw')) {
    assert.equal(a.smoothWins, 0, `${a.axis} did not move, so nothing may win on it`);
  }
});

test('a single-arm checkpoint is incomplete, not complete', () => {
  // `--arm 64x128` is a supported run and produces a log with one arm. Deciding
  // completeness from the arms the LOG contains makes every seed in it look
  // finished, so a partial checkpoint publishes medians and cross-arm ratios as
  // if the whole design had run. The count has to come from the design.
  const oneArm = [1, 2, 3].map((sd) => point('64x128', sd));
  assert.deepEqual(
    [...partialSeeds(oneArm)].sort((a, b) => a - b),
    [1, 2, 3],
    'every seed is short of nine arms',
  );
  const rows = summarize(oneArm).filter((r) => r.scope === 'all');
  assert.equal(rows.length, 0, 'a one-arm log supports no arms table at all');
});

test('an interrupted sweep keeps every whole seed and loses only the partial one', () => {
  // This is the case the completeness rule exists for, and the runner is
  // seed-major so it is the shape an interruption actually takes: whole seeds,
  // then one seed part-way through its arms.
  const runs = [...fullSweep([1, 2, 3]), ...ARMS.slice(0, 4).map((a) => point(a.key, 4))];
  assert.deepEqual([...partialSeeds(runs)], [4], 'only the half-finished seed is partial');
  const rows = summarize(runs).filter((r) => r.scope === 'all');
  assert.equal(rows.length, ARMS.length, 'every arm still has a row');
  for (const r of rows) assert.equal(r.n, 3, `${r.arm}: the three whole seeds`);
  // And here the two tables DIVERGE, by design rather than by accident. The
  // half-finished seed happens to carry all three arms the coarse pair reads
  // (analytic, 64x128, 64x128-smooth are the first three of ARMS), so that pair
  // legitimately counts it — a pair pays for its own three arms and not for the
  // other seven. The fine pair, whose arms seed 4 never reached, does not.
  const mech = mechanismRows(rows, runs);
  assert.equal(
    mech.find((x) => x.facetArm === '64x128')?.pairs,
    4,
    'the coarse pair has all three of its arms on seed 4, so it keeps it',
  );
  assert.equal(
    mech.find((x) => x.facetArm === '192x384')?.pairs,
    3,
    'the fine pair never got its arms on seed 4',
  );
});

test('a log short of an arm on every seed produces no tables at all', () => {
  // Not a limitation to route around: `--arm` plumbing is not a result, and
  // both tables go, because the mechanism rows read their control off a summary
  // row. A previous version of the policy comment claimed otherwise.
  const three = ['analytic', '64x128', '64x128-smooth'];
  const runs = [1, 2, 3].flatMap((sd) => three.map((a) => point(a, sd)));
  const rows = summarize(runs).filter((r) => r.scope === 'all-including-refused');
  assert.equal(rows.length, 0, 'no arms table');
  assert.equal(mechanismRows(rows, runs).length, 0, 'and no mechanism rows either');
});

test('a seed that is both failed and unfinished is not reported as a policy drop', () => {
  // It was excluded for being INCOMPLETE. Counting it as a drop has a half-run
  // sweep announcing a decision it never reached.
  const runs = [
    ...fullSweep([1, 2]),
    // Seed 3 has two arms, one of which also failed.
    point('analytic', 3),
    point('64x128', 3, { converged: false, stopReason: 'lambda' }),
  ];
  for (const r of summarize(runs).filter((x) => x.scope === 'all')) {
    assert.equal(
      r.seedsDropped,
      0,
      `${r.arm}: seed 3 was unfinished, so its failure was never eligible for exclusion`,
    );
    assert.equal(r.n, 2, `${r.arm}: only the two complete seeds count`);
  }
});

test('a seed that failed on a COMPLETE set is reported as a policy drop', () => {
  // The other side of the same rule, so the fix above cannot be satisfied by
  // never reporting a drop at all.
  const runs = fullSweep([1, 2, 3], (arm, seed) =>
    arm === '64x128' && seed === 2 ? { converged: false, stopReason: 'lambda' } : {},
  );
  for (const r of summarize(runs).filter((x) => x.scope === 'all')) {
    assert.equal(r.seedsDropped, 1, `${r.arm}: seed 2 failed on a complete set`);
  }
});

test('seedsDropped counts seeds, not rows', () => {
  // A duplicated point in the log is exactly when a count that says "seeds" must
  // not quietly mean "rows".
  const runs = fullSweep([1, 2, 3], (arm, seed) =>
    arm === '64x128' && seed === 2 ? { converged: false, stopReason: 'lambda' } : {},
  );
  const dup = [...runs, ...runs.filter((r) => r.arm === '64x128' && r.seed === 2)];
  const coarse = summarize(dup)
    .filter((x) => x.scope === 'all')
    .find((r) => r.arm === '64x128');
  assert.equal(coarse?.seedsDropped, 1, 'one seed dropped, however many rows carry it');
});
