// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * cost — a token ledger priced at published rates.
 *
 * This is the trustworthy half of the report. Both inputs are hard: the token
 * counts are measured from the transcripts and the rates are published. There
 * is no modelling here and no place for one to hide.
 *
 * The counterfactuals at the bottom exist because a cache line item is
 * meaningless in isolation. "You spent $1,709.66 on cache reads" reads like
 * waste until you compute what those same tokens would have cost uncached.
 */

import { CACHE_MULTIPLIER, ratesFor } from './rates.ts';
import type { Ledger, Tokens } from './transcripts.ts';
import { contextTokens, totalTokens } from './transcripts.ts';

export interface CostLine {
  readonly label: string;
  readonly tokens: number;
  /** Dollars per million tokens, after the cache multiplier. */
  readonly rate: number;
  readonly amount: number;
}

export interface CostReport {
  readonly modelId: string;
  readonly lines: readonly CostLine[];
  readonly total: number;
  readonly totalTokens: number;
  /** Per-bucket totals, for attribution. */
  readonly byBucket: Readonly<Record<string, number>>;
  /**
   * What the same tokens would have cost with caching switched off — every
   * cached token becomes a plain input token at base rate.
   */
  readonly withoutCaching: number;
  /** What the same tokens would have cost had every write taken the 1-hour TTL. */
  readonly allOneHourTtl: number;
  /** Share of the bill spent on cache reads. Usually the largest single line. */
  readonly cacheReadShare: number;
}

export function costOf(tokens: Tokens, modelId: string): number {
  const r = ratesFor(modelId);
  const m = CACHE_MULTIPLIER;
  return (
    (tokens.uncached / 1e6) * r.input * m.uncached +
    (tokens.write1h / 1e6) * r.input * m.write1h +
    (tokens.write5m / 1e6) * r.input * m.write5m +
    (tokens.read / 1e6) * r.input * m.read +
    (tokens.output / 1e6) * r.output
  );
}

export function priceLedger(ledger: Ledger, modelId: string): CostReport {
  const r = ratesFor(modelId);
  const m = CACHE_MULTIPLIER;
  const t = ledger.total;

  const lines: CostLine[] = [
    {
      label: 'Input — uncached',
      tokens: t.uncached,
      rate: r.input * m.uncached,
      amount: (t.uncached / 1e6) * r.input * m.uncached,
    },
    {
      label: 'Input — cache writes, 1-hour TTL',
      tokens: t.write1h,
      rate: r.input * m.write1h,
      amount: (t.write1h / 1e6) * r.input * m.write1h,
    },
    {
      label: 'Input — cache writes, 5-minute TTL',
      tokens: t.write5m,
      rate: r.input * m.write5m,
      amount: (t.write5m / 1e6) * r.input * m.write5m,
    },
    {
      label: 'Input — cache reads',
      tokens: t.read,
      rate: r.input * m.read,
      amount: (t.read / 1e6) * r.input * m.read,
    },
    {
      label: 'Output',
      tokens: t.output,
      rate: r.output,
      amount: (t.output / 1e6) * r.output,
    },
  ];

  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const byBucket: Record<string, number> = {};
  for (const [bucket, tokens] of Object.entries(ledger.byBucket)) {
    byBucket[bucket] = costOf(tokens, modelId);
  }

  const withoutCaching = (contextTokens(t) / 1e6) * r.input + (t.output / 1e6) * r.output;
  const allOneHourTtl = costOf(
    { ...t, write1h: t.write1h + t.write5m, write5m: 0 },
    modelId,
  );
  const readLine = lines[3];

  return {
    modelId,
    lines,
    total,
    totalTokens: totalTokens(t),
    byBucket,
    withoutCaching,
    allOneHourTtl,
    cacheReadShare: total > 0 ? readLine.amount / total : 0,
  };
}
