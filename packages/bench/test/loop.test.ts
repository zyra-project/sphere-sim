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

import { classifyMovement, loadHistory, roundScore, runRound, seedForRound } from '../src/loop.ts';
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
    out[k] = { median, p95: median, max: median, dispersion: dispersionValue };
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

test('roundScore ranks on the one scored gate a solver can actually move', () => {
  const make = (median: number): BenchResults =>
    ({ aggregate: { gridDisplacementMm: { median } } }) as unknown as BenchResults;
  assert.ok(roundScore(make(0.4)) < roundScore(make(0.9)));
  assert.equal(roundScore({ aggregate: {} } as unknown as BenchResults), Number.POSITIVE_INFINITY);
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
