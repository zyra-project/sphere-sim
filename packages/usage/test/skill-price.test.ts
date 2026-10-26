// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The skill's rate card, where one model's cache reads differ from the rest.
 *
 * Claude Opus 5.5 bills cache reads at 0.05x base input, half the usual 0.1x.
 * Cache reads are usually the largest token class in an agentic run, so pricing
 * them at the shared multiplier would double the biggest line on the bill while
 * still looking authoritative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const PRICE = path.resolve(import.meta.dirname, '../../../skills/usage-report/scripts/price.mjs');

interface Rates {
  input: number;
  output: number;
  read: number;
}
interface Tokens {
  uncached: number;
  write1h: number;
  write5m: number;
  read: number;
  output: number;
}

const price = (await import(pathToFileURL(PRICE).href)) as {
  CACHE_MULTIPLIER: { read: number };
  ratesFor: (cls: { model: string; speed?: string; tier?: string }, asOf?: string | null) => Rates | null;
  costOf: (tokens: Tokens, rates: Rates) => number;
  priceLedger: (ledger: unknown) => { total: number; lines: { label: string; rate: number }[] };
};

const readsOnly = (n: number): Tokens => ({ uncached: 0, write1h: 0, write5m: 0, read: n, output: 0 });

test('Claude Opus 5.5 cache reads price at $0.20 per million', () => {
  const rates = price.ratesFor({ model: 'claude-opus-5-5' });
  assert.ok(rates);
  assert.equal(rates.input, 4);
  assert.equal(rates.output, 20);
  assert.equal(price.costOf(readsOnly(1e6), rates), 0.2);
});

test('other models keep the shared 0.1x read multiplier', () => {
  const rates = price.ratesFor({ model: 'claude-opus-5' });
  assert.ok(rates);
  assert.equal(rates.read, price.CACHE_MULTIPLIER.read);
  assert.equal(price.costOf(readsOnly(1e6), rates), 0.5);
});

test('the read rate survives fast mode, batch and introductory pricing', () => {
  const fast = price.ratesFor({ model: 'claude-opus-5-5', speed: 'fast' });
  const batch = price.ratesFor({ model: 'claude-opus-5-5', tier: 'batch' });
  const intro = price.ratesFor({ model: 'claude-sonnet-5' }, '2026-08-01');
  assert.equal(fast?.read, 0.05);
  assert.equal(batch?.read, 0.05);
  assert.equal(intro?.read, price.CACHE_MULTIPLIER.read);
});

test('the cache-read line on a mixed-model bill blends each model at its own rate', () => {
  const tokens = (read: number): Tokens => ({ uncached: 0, write1h: 0, write5m: 0, read, output: 0 });
  const ledger = {
    firstAt: '2026-10-20T00:00:00Z',
    byClass: [
      { model: 'claude-opus-5-5', speed: 'standard', tier: 'standard', tokens: tokens(1e6) },
      { model: 'claude-opus-5', speed: 'standard', tier: 'standard', tokens: tokens(1e6) },
    ],
    byBucket: {},
  };
  const bill = price.priceLedger(ledger);
  const reads = bill.lines.find((l) => l.label === 'Input — cache reads');
  assert.ok(reads);
  // $0.20 + $0.50 over two million reads.
  assert.equal(reads.rate, 0.35);
  assert.ok(Math.abs(bill.total - 0.7) < 1e-12);
});
