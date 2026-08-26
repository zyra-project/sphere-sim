// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Pricing.
 *
 * This is the half of the report that claims to be measurement, so the tests are
 * about arithmetic being exactly right rather than about plausibility. The cache
 * multipliers get the most attention because they are the part that is
 * counter-intuitive: a cache WRITE costs more than an ordinary input token, and a
 * workload that writes long-TTL caches it never reads is worse off than one that
 * never cached.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costOf, priceLedger } from '../src/cost.ts';
import { CACHE_MULTIPLIER, ratesFor } from '../src/rates.ts';
import type { Ledger, Tokens } from '../src/transcripts.ts';
import { zeroTokens } from '../src/transcripts.ts';

const OPUS = 'claude-opus-5';

function ledgerOf(total: Tokens, extra: Partial<Ledger> = {}): Ledger {
  return {
    total,
    byBucket: { main: total, subagent: zeroTokens(), workflow: zeroTokens() },
    messages: { main: 1, subagent: 0, workflow: 0 },
    agents: { subagent: 0, workflow: 0 },
    rawLines: 1,
    uniqueMessages: 1,
    files: 1,
    activeDays: 1,
    firstAt: '2026-08-10T00:00:00Z',
    lastAt: '2026-08-10T00:00:00Z',
    contextOutputProduct: 0,
    ...extra,
  };
}

test('each token class is billed at its published multiple of base input', () => {
  const r = ratesFor(OPUS);
  assert.equal(costOf({ ...zeroTokens(), uncached: 1e6 }, OPUS), r.input);
  assert.equal(costOf({ ...zeroTokens(), write1h: 1e6 }, OPUS), r.input * 2);
  assert.equal(costOf({ ...zeroTokens(), write5m: 1e6 }, OPUS), r.input * 1.25);
  assert.equal(costOf({ ...zeroTokens(), read: 1e6 }, OPUS), r.input * 0.1);
  assert.equal(costOf({ ...zeroTokens(), output: 1e6 }, OPUS), r.output);
});

test('a cache write costs MORE than the input token it replaces', () => {
  // The saving is on the reads, never on the write. Getting this backwards would
  // make every caching recommendation in the report wrong.
  assert.ok(CACHE_MULTIPLIER.write5m > CACHE_MULTIPLIER.uncached);
  assert.ok(CACHE_MULTIPLIER.write1h > CACHE_MULTIPLIER.write5m);
  assert.ok(CACHE_MULTIPLIER.read < CACHE_MULTIPLIER.uncached);
});

test('a cache written once and never read is a loss', () => {
  const written = costOf({ ...zeroTokens(), write1h: 1e6 }, OPUS);
  const plain = costOf({ ...zeroTokens(), uncached: 1e6 }, OPUS);
  assert.ok(written > plain, 'writing a 1h cache costs double what not caching would have');
});

test('the without-caching counterfactual reprices every cached token at base input', () => {
  const total: Tokens = { uncached: 100, write1h: 200, write5m: 300, read: 1e6, output: 50 };
  const report = priceLedger(ledgerOf(total), OPUS);
  const r = ratesFor(OPUS);
  const expected = ((100 + 200 + 300 + 1e6) / 1e6) * r.input + (50 / 1e6) * r.output;
  assert.ok(Math.abs(report.withoutCaching - expected) < 1e-12);
  assert.ok(report.withoutCaching > report.total, 'caching must come out ahead on a read-heavy load');
});

test('the all-1h counterfactual moves 5-minute writes to the 1-hour rate and nothing else', () => {
  const total: Tokens = { ...zeroTokens(), write5m: 1e6, read: 1e6 };
  const report = priceLedger(ledgerOf(total), OPUS);
  const moved = costOf({ ...zeroTokens(), write1h: 1e6, read: 1e6 }, OPUS);
  assert.equal(report.allOneHourTtl, moved);
  assert.ok(report.allOneHourTtl > report.total);
});

test('line amounts sum to the total', () => {
  const total: Tokens = { uncached: 12345, write1h: 6789, write5m: 4321, read: 987654, output: 5432 };
  const report = priceLedger(ledgerOf(total), OPUS);
  const summed = report.lines.reduce((a, l) => a + l.amount, 0);
  assert.ok(Math.abs(summed - report.total) < 1e-9);
});

test('bucket costs sum to the total', () => {
  const a: Tokens = { uncached: 10, write1h: 20, write5m: 30, read: 40, output: 50 };
  const b: Tokens = { uncached: 1, write1h: 2, write5m: 3, read: 4, output: 5 };
  const total: Tokens = {
    uncached: 11, write1h: 22, write5m: 33, read: 44, output: 55,
  };
  const report = priceLedger(
    ledgerOf(total, { byBucket: { main: a, subagent: b, workflow: zeroTokens() } }),
    OPUS,
  );
  const summed = Object.values(report.byBucket).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(summed - report.total) < 1e-9);
});

test('an unknown model refuses rather than substituting a similar one', () => {
  // Silently pricing an unlisted model at Opus rates would produce a number that
  // looks authoritative and is not. The rate card is PUB or it is nothing.
  assert.throws(() => costOf(zeroTokens(), 'claude-not-a-model'), /No published rate card/);
});

test('an empty ledger prices to zero without dividing by it', () => {
  const report = priceLedger(ledgerOf(zeroTokens()), OPUS);
  assert.equal(report.total, 0);
  assert.equal(report.cacheReadShare, 0, 'not NaN');
});
