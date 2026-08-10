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
  assertScorable,
  betterThan,
  classifyMovement,
  loadHistory,
  rankRound,
  runRound,
  seedForRound,
} from '../src/loop.ts';
import type { RoundSeries } from '../src/loop.ts';
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
      offSphereFluxExcess: { median: 0.002, p95: 0.003, max: 0.004, iqr: 0.001 },
    },
    gates: {
      gates: [
        { id: 'grid_displacement', max: 1.0, provisional: false },
        { id: 'pose_position', max: 2.0, provisional: false },
        { id: 'pose_rotation', max: 0.05, provisional: false },
        { id: 'h_center_recovery', max: 10.0, provisional: false },
        { id: 'off_sphere_flux_excess', max: 0.01, provisional: false },
      ],
    },
  } as unknown as BenchResults;

  const ranked = rankRound(results);
  // Five components, each in units of its own gate — which is what lets one
  // vector hold millimetres, degrees and a bare fraction without a weight.
  assert.equal(Object.keys(ranked).length, 5);
  assert.equal(ranked.gridDisplacementMm.gateFraction, 0.5);
  assert.equal(ranked.poseMaxPositionMmAligned.gateFraction, 2);
  assert.equal(ranked.poseMaxRotationDegAligned.gateFraction, 2);
  assert.equal(ranked.centerHeightErrorMm.gateFraction, 0.5);
  assert.equal(ranked.offSphereFluxExcess.gateFraction, 0.2);
  assert.equal(ranked.poseMaxPositionMmAligned.dispersion, 0.5, 'the deadband is half the IQR');
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
