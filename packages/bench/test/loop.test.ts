// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The round runner.
 *
 * The two properties that matter are in tension and both are load bearing:
 * seeds must be FRESH every round so a builder cannot overfit to them, and any
 * round must be REPLAYABLE exactly so a before/after pair compares the same
 * rigs. A chain gives both; wall-clock entropy gives only the first.
 *
 * The stopping condition gets its own tests because it is the thing that ends
 * Phase 1, and a stopping rule that fires early or never is worse than no rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TRACKED,
  assertScorable,
  betterThan,
  classifyMovement,
  ROUNDS_SCHEMA,
  loadHistory,
  movementOf,
  nextRoundNumber,
  parseLoopArgs,
  rankRound,
  recordFromFile,
  runRound,
  seedForRound,
} from '../src/loop.ts';
import type { RoundRecord, RoundSeries } from '../src/loop.ts';
import { PRESETS } from '../src/scenarios.ts';
import type { BenchPreset } from '../src/scenarios.ts';
import type { BenchResults } from '../src/results.ts';

const TINY: BenchPreset = {
  ...PRESETS.quick,
  scenarioCount: 1,
  cameraResX: 160,
  cameraResY: 120,
  metricDensityScale: 0.15,
  metricConvergence: false,
  maxCorrespondencesPerPair: 500,
  renderSize: 96,
};

test('round seeds are fresh between rounds and reproducible within one', () => {
  const root = 20240001;
  const seeds = [0, 1, 2, 3, 4, 5].map((r) => seedForRound(root, r));
  assert.equal(new Set(seeds).size, seeds.length, 'a round reused a seed');
  for (const r of [0, 3, 5]) assert.equal(seedForRound(root, r), seeds[r]);
  // A different chain root gives a different series, so two people running the
  // loop independently do not silently share a corpus.
  assert.notEqual(seedForRound(root + 1, 0), seeds[0]);
});

function series(values: Record<string, [number, number]>): Record<string, RoundSeries> {
  const out: Record<string, RoundSeries> = {};
  for (const [k, [median, dispersionValue]] of Object.entries(values)) {
    out[k] = {
      median,
      p95: median,
      max: median,
      scatterAcrossScenarios: NaN,
      dispersion: dispersionValue,
      gateMax: 1,
      gateFraction: median,
    };
  }
  return out;
}

test('a change smaller than the round\'s own scatter is not an improvement', () => {
  const previous = series({ gridDisplacementMm: [1.0, 0.3] });
  const barelyBetter = series({ gridDisplacementMm: [0.85, 0.3] });
  const { movement, improving } = classifyMovement(barelyBetter, previous);
  // 0.15 mm better against a scatter of 0.3 mm across seeds: not evidence.
  assert.equal(movement.gridDisplacementMm, 'flat');
  assert.equal(improving, false);
});

test('a change larger than the scatter counts, in whichever direction', () => {
  const previous = series({ gridDisplacementMm: [1.0, 0.1] });
  const better = classifyMovement(series({ gridDisplacementMm: [0.5, 0.1] }), previous);
  assert.equal(better.movement.gridDisplacementMm, 'improved');
  assert.equal(better.improving, true);

  const worse = classifyMovement(series({ gridDisplacementMm: [1.6, 0.1] }), previous);
  assert.equal(worse.movement.gridDisplacementMm, 'regressed');
  // A regression is not an improvement, and it is also not a "non-improving
  // round" in the sense that counts toward three-and-stop: three rounds of
  // getting worse is not a converged Phase 1.
  assert.equal(worse.improving, false);
});

test('the first round is flat against nothing rather than improving against nothing', () => {
  const { movement, improving } = classifyMovement(series({ gridDisplacementMm: [1.0, 0.1] }), null);
  assert.equal(movement.gridDisplacementMm, 'flat');
  assert.equal(improving, false);
});

/**
 * The defect these four tests exist for.
 *
 * The loop used to rank rounds on the median grid displacement alone, and the
 * bench's own counterfactual attribution proves that metric is blind to pose
 * error: substituting the TRUE projector positions into a recovered calibration
 * makes grid displacement WORSE (61.18 mm against 1.058 mm as recovered),
 * because the recovered rig is internally self-consistent. So a round could
 * wreck pose recovery by tens of millimetres, nudge the seams, and be recorded
 * as an improvement and as the new best.
 */
test('a round that regresses pose is never recorded as an improvement', () => {
  const previous = series({
    gridDisplacementMm: [1.0, 0.05],
    poseMaxPositionMmAligned: [20, 1],
    poseMaxRotationDegAligned: [0.05, 0.001],
    centerHeightErrorMm: [3, 0.1],
    offSphereFluxExcess: [0.001, 0.0001],
  });
  // Seams much better, pose much worse: the exact trade the old scalar ranking
  // could not see.
  const current = series({
    gridDisplacementMm: [0.4, 0.05],
    poseMaxPositionMmAligned: [79, 1],
    poseMaxRotationDegAligned: [0.05, 0.001],
    centerHeightErrorMm: [3, 0.1],
    offSphereFluxExcess: [0.001, 0.0001],
  });
  const { movement, improving, improved, regressed } = classifyMovement(current, previous);
  assert.equal(movement.gridDisplacementMm, 'improved');
  assert.equal(movement.poseMaxPositionMmAligned, 'regressed');
  assert.deepEqual(improved, ['gridDisplacementMm']);
  assert.deepEqual(regressed, ['poseMaxPositionMmAligned']);
  assert.equal(improving, false, 'a round that regressed pose was recorded as improving');

  // ...and it does not take the crown either.
  const comparison = betterThan(current, previous);
  assert.equal(comparison.verdict, 'mixed');
  assert.match(comparison.why, /regressed pose position/);
});

test('the comparison rule: better means better on something and worse on nothing', () => {
  const base = series({
    gridDisplacementMm: [1.0, 0.05],
    poseMaxPositionMmAligned: [20, 1],
    poseMaxRotationDegAligned: [0.05, 0.001],
    centerHeightErrorMm: [3, 0.1],
    offSphereFluxExcess: [0.001, 0.0001],
  });
  const move = (key: string, to: number): Record<string, RoundSeries> => ({
    ...base,
    [key]: { ...base[key], median: to },
  });

  assert.equal(betterThan(move('poseMaxPositionMmAligned', 4), base).verdict, 'better');
  assert.equal(betterThan(move('poseMaxPositionMmAligned', 40), base).verdict, 'worse');
  assert.equal(betterThan(base, base).verdict, 'flat');
  assert.equal(betterThan(base, null).verdict, 'better', 'the first round is the best by default');

  // A metric that stops being measurable has not improved.
  const lost = { ...base, gridDisplacementMm: { ...base.gridDisplacementMm, median: NaN } };
  assert.equal(betterThan(lost, base).verdict, 'worse');
  assert.equal(classifyMovement(lost, base).movement.gridDisplacementMm, 'lost');
});

test('the ranking vector covers every scored geometric gate, in gate units', () => {
  const results = {
    aggregate: {
      gridDisplacementMm: { median: 0.5, p95: 1, max: 2, iqr: 0.2 },
      poseMaxPositionMmAligned: { median: 4, p95: 8, max: 9, iqr: 1 },
      poseMaxRotationDegAligned: { median: 0.1, p95: 0.2, max: 0.3, iqr: 0.02 },
      centerHeightErrorMm: { median: 5, p95: 6, max: 7, iqr: 0.5 },
      cameraMaxRotationDeg: { median: 0.035, p95: 0.07, max: 0.1, iqr: 0.01 },
      offSphereFluxExcess: { median: 0.002, p95: 0.003, max: 0.004, iqr: 0.001 },
    },
    gates: {
      gates: [
        { id: 'grid_displacement', max: 1.0, provisional: false },
        { id: 'pose_position', max: 2.0, provisional: false },
        { id: 'pose_rotation', max: 0.05, provisional: false },
        { id: 'h_center_recovery', max: 10.0, provisional: false },
        { id: 'camera_pose_rotation', max: 0.07, provisional: false },
        { id: 'off_sphere_flux_excess', max: 0.01, provisional: false },
      ],
    },
  } as unknown as BenchResults;

  const ranked = rankRound(results);
  // Six components, each in units of its own gate — which is what lets one
  // vector hold millimetres, degrees and a bare fraction without a weight.
  assert.equal(Object.keys(ranked).length, 6);
  assert.equal(ranked.gridDisplacementMm.gateFraction, 0.5);
  assert.equal(ranked.poseMaxPositionMmAligned.gateFraction, 2);
  assert.equal(ranked.poseMaxRotationDegAligned.gateFraction, 2);
  assert.equal(ranked.centerHeightErrorMm.gateFraction, 0.5);
  assert.equal(ranked.offSphereFluxExcess.gateFraction, 0.2);
  // Half the IQR is the SCATTER ACROSS SCENARIOS, and it keeps that name. It is
  // a true statement about how much the twelve archetypes differ; it is not seed
  // noise, and it used to be used as the round-over-round bar.
  assert.equal(ranked.poseMaxPositionMmAligned.scatterAcrossScenarios, 0.5);
  // The bar itself is unmeasured unless somebody measured it.
  assert.ok(
    Number.isNaN(ranked.poseMaxPositionMmAligned.dispersion),
    'an unmeasured across-seed dispersion must be NaN, not a number derived from one run',
  );

  // ...and it is what gets used when it IS supplied.
  const measured = rankRound(results, undefined, { poseMaxPositionMmAligned: 0.125 });
  assert.equal(measured.poseMaxPositionMmAligned.dispersion, 0.125);
  assert.equal(measured.poseMaxPositionMmAligned.scatterAcrossScenarios, 0.5);
});

test('a round the loop cannot qualify is unqualified, not flat, and does not end Phase 1', () => {
  // The finding, stated as a property. On the shipped corpus the old bar for
  // grid displacement was 2.52 mm against a 1 mm gate, so a round that took the
  // headline geometric gate from 3.5x its limit to exactly its limit came back
  // 'flat'. Across all five rounds this project has run, every metric was 'flat',
  // improved and regressed were empty, and consecutiveNonImproving marched to 5.
  const series = (median: number, dispersion: number): RoundSeries => ({
    median,
    p95: median,
    max: median,
    scatterAcrossScenarios: 2.521,
    dispersion,
    gateMax: 1,
    gateFraction: median,
  });

  // No measured dispersion on either side: the loop cannot say, and says so.
  assert.equal(movementOf(series(1.0, NaN), series(3.507, NaN)), 'unqualified');
  // One side measured is still not enough — the bar is the larger of the two.
  assert.equal(movementOf(series(1.0, 0.1), series(3.507, NaN)), 'unqualified');
  // With both measured, a 2.5 mm fall against a 0.1 mm noise floor is an
  // improvement, which is what the old code could never report.
  assert.equal(movementOf(series(1.0, 0.1), series(3.507, 0.1)), 'improved');
  // And the scatter across scenarios never acts as the bar, however large.
  assert.equal(movementOf(series(3.4, 0.1), series(3.507, 0.1)), 'improved');
});

test('an unqualified round does not count toward the three that end Phase 1', () => {
  const s = (median: number): RoundSeries => ({
    median,
    p95: median,
    max: median,
    scatterAcrossScenarios: 1,
    dispersion: NaN,
    gateMax: 1,
    gateFraction: median,
  });
  const now: Record<string, RoundSeries> = {};
  const before: Record<string, RoundSeries> = {};
  for (const t of TRACKED) {
    now[t.key] = s(1);
    before[t.key] = s(5);
  }
  const classified = classifyMovement(now, before);
  for (const t of TRACKED) assert.equal(classified.movement[t.key], 'unqualified');
  assert.equal(classified.improving, false, 'unqualified is not improving');
  assert.deepEqual(classified.regressed, [], 'nor is it a regression');
  assert.equal(
    classified.qualified,
    false,
    'the round is not qualified, which is what stops it counting toward the three',
  );
});

test('the loop refuses to score a round on a provisional metric', () => {
  // docs/ARCHITECTURE.md has claimed this for months and nothing implemented it.
  const results = {
    aggregate: { gridDisplacementMm: { median: 0.5, p95: 1, max: 2, iqr: 0.2 } },
    gates: {
      gates: [
        { id: 'grid_displacement', max: 1.0, provisional: true },
        { id: 'pose_position', max: 2.0, provisional: false },
        { id: 'pose_rotation', max: 0.05, provisional: false },
        { id: 'h_center_recovery', max: 10.0, provisional: false },
        { id: 'camera_pose_rotation', max: 0.07, provisional: false },
        { id: 'off_sphere_flux_excess', max: 0.01, provisional: false },
      ],
    },
  } as unknown as BenchResults;
  assert.throws(() => assertScorable(results), /PROVISIONAL/);
  assert.throws(() => rankRound(results), /grid displacement/);

  // A ranked metric whose gate the run did not produce is refused too: a
  // ranking that silently drops a component is how the pose blindness happened.
  const missing = {
    aggregate: {},
    gates: { gates: [{ id: 'grid_displacement', max: 1.0, provisional: false }] },
  } as unknown as BenchResults;
  assert.throws(() => assertScorable(missing), /did not produce/);
});

test('a round appends to the history and a replay of it reproduces the same seed', { timeout: 600_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-loop-'));
  const historyPath = path.join(dir, 'rounds.json');
  const base = {
    preset: TINY,
    scenarios: 1,
    seed: null,
    replay: null,
    historyPath,
    outDir: dir,
    quiet: true,
    record: null,
    round: null,
  };

  const first = runRound(base);
  assert.equal(first.record.round, 0);
  assert.equal(first.record.consecutiveNonImproving, 1, 'round 0 has nothing to improve on');
  assert.equal(first.record.best, true, 'the first round is always the best so far');
  fs.writeFileSync(historyPath, `${JSON.stringify(first.history, null, 2)}\n`);

  const second = runRound(base);
  assert.equal(second.record.round, 1);
  assert.notEqual(second.record.seed, first.record.seed, 'round 1 reused round 0\'s seed');
  fs.writeFileSync(historyPath, `${JSON.stringify(second.history, null, 2)}\n`);
  assert.equal(loadHistory(historyPath).rounds.length, 2);

  // A replay must land on the recorded seed, or the before/after pair the loop
  // protocol asks for would be comparing two different corpora.
  const replay = runRound({ ...base, replay: 0 });
  assert.equal(replay.record.seed, first.record.seed);
  assert.equal(replay.record.round, 0);
  // And it replaces round 0 rather than appending a second one.
  assert.equal(replay.history.rounds.filter((r) => r.round === 0).length, 1);
  assert.equal(replay.history.rounds.length, 2);

  // Same seed, same scenarios: the replayed round's headline number must match.
  assert.equal(
    replay.record.series.gridDisplacementMm.median,
    first.record.series.gridDisplacementMm.median,
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a round can be RECORDED from a bench run that already happened', { timeout: 600_000 }, () => {
  // The defect this fixes: `progress/rounds.json` did not exist after three
  // rounds. The ranking machinery was written and edited and never executed,
  // because a round's corpus is regenerated with `cli.ts` and `runRound` re-runs
  // it rather than reading it — so nobody paid for the corpus twice and the
  // history stayed empty. A ranking rule that has never ranked anything is not
  // a rule.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-record-'));
  const historyPath = path.join(dir, 'rounds.json');
  const base = {
    preset: TINY,
    scenarios: 1,
    seed: null,
    replay: null,
    historyPath,
    outDir: dir,
    quiet: true,
    record: null,
    round: null,
  };

  // Run one round the normal way to get a results file on disk.
  const ran = runRound(base);
  const resultsFile = path.join(dir, 'run.json');
  fs.writeFileSync(resultsFile, JSON.stringify(ran.results));

  // Recording it must produce the same ranking vector as running it did — same
  // seed, same scenario count, same series — because it is the same run.
  const recorded = recordFromFile({ ...base, record: resultsFile });
  assert.equal(recorded.record.seed, ran.record.seed);
  assert.equal(recorded.record.scenarioCount, ran.record.scenarioCount);
  assert.deepEqual(recorded.record.series, ran.record.series);
  assert.equal(recorded.record.round, 0);
  assert.equal(recorded.record.best, true, 'the first round on record is the best by default');

  // And it lands in the history, which is the whole point.
  fs.writeFileSync(historyPath, `${JSON.stringify(recorded.history, null, 2)}\n`);
  const history = loadHistory(historyPath);
  assert.equal(history.rounds.length, 1);
  assert.equal(history.best?.round, 0);

  // A second recording of the same file appends round 1 and compares against
  // round 0 rather than against nothing: identical numbers must read `flat`,
  // not `better`, or the history would record progress for re-reading a file.
  const again = recordFromFile({ ...base, record: resultsFile });
  assert.equal(again.record.round, 1);
  assert.equal(again.record.comparison.verdict, 'flat');
  assert.equal(again.record.best, false);
  assert.equal(again.record.improving, false);

  // An explicit round number is honoured, which is what a history that starts
  // late needs: Phase 1's first three rounds ran before this file existed, so
  // recording round 4 as round 0 would make the history disagree with
  // docs/PHASE-1.md about which round is which.
  const numbered = recordFromFile({ ...base, record: resultsFile, round: 4 });
  assert.equal(numbered.record.round, 4);

  // A history with a HOLE in it must not renumber on top of an existing round.
  // Build 0, 1, 2, 4 — the shape `--round` produces, and the shape
  // docs/PHASE-1.md's late-started history would have had if a round were ever
  // dropped — and record one more. The count is 4 and the highest round is 4,
  // so numbering by the count would hand the new round the number 4, and
  // `recordRound` filters out the record whose number matches before appending:
  // round 4 would be deleted and replaced without a word, having also re-run
  // its seed, since `seedForRound` is a function of the round number.
  let sparse = recorded.history;
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(historyPath, `${JSON.stringify(sparse, null, 2)}\n`);
    sparse = recordFromFile({ ...base, record: resultsFile }).history;
  }
  fs.writeFileSync(historyPath, `${JSON.stringify(sparse, null, 2)}\n`);
  sparse = recordFromFile({ ...base, record: resultsFile, round: 4 }).history;
  fs.writeFileSync(historyPath, `${JSON.stringify(sparse, null, 2)}\n`);
  assert.deepEqual(
    loadHistory(historyPath).rounds.map((r) => r.round),
    [0, 1, 2, 4],
    'the history under test really does have a hole in it',
  );

  const afterHole = recordFromFile({ ...base, record: resultsFile });
  assert.equal(afterHole.record.round, 5, 'one past the highest round, not the count');
  assert.deepEqual(
    afterHole.history.rounds.map((r) => r.round),
    [0, 1, 2, 4, 5],
    'and round 4 is still there',
  );

  assert.throws(
    () => recordFromFile({ ...base, record: path.join(dir, 'nope.json') }),
    /no such file/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the next round number is one past the highest, not the number of records', () => {
  const at = (rounds: readonly number[]): ReturnType<typeof loadHistory> => ({
    schema: ROUNDS_SCHEMA,
    rootSeed: 1,
    rounds: rounds.map((round) => ({ round }) as unknown as RoundRecord),
    best: null,
  });

  assert.equal(nextRoundNumber(at([])), 0, 'an empty history starts at round 0');
  assert.equal(nextRoundNumber(at([0, 1, 2])), 3, 'a dense history is unaffected');
  assert.equal(nextRoundNumber(at([0, 1, 2, 4])), 5, 'a hole does not pull the number back');
  assert.equal(nextRoundNumber(at([4])), 5, 'a history that starts late keeps counting from there');
  assert.equal(nextRoundNumber(at([2, 0, 1])), 3, 'and the answer does not depend on the order');
});

test('a round number that is not a whole number is refused, not turned into NaN', () => {
  // `Number('x')` is NaN, and a NaN round survives every comparison in
  // `recordRound` — `NaN !== NaN`, so it replaces nothing and sorts nowhere —
  // before landing in a results file called `round-NaN.json`.
  for (const bad of ['x', '1.5', '-1', '']) {
    assert.throws(
      () => parseLoopArgs(['--round', bad]),
      /needs a non-negative whole number/,
      `--round ${bad}`,
    );
    assert.throws(
      () => parseLoopArgs(['--replay', bad]),
      /needs a non-negative whole number/,
      `--replay ${bad}`,
    );
  }
  assert.equal(parseLoopArgs(['--round', '4']).round, 4);
  assert.equal(parseLoopArgs(['--replay', '0']).replay, 0);
});
