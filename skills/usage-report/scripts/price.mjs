// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * price.mjs — a token ledger at published rates.
 *
 * This is the half of the report that is measurement rather than modelling, so
 * the job here is arithmetic being exactly right, not plausible.
 *
 * Three things make it more than a multiply:
 *
 *  1. CACHE MULTIPLIERS. A cache WRITE costs more than the input token it
 *     replaces — 1.25x at the 5-minute TTL, 2x at the 1-hour TTL. The saving is
 *     entirely on the reads, at 0.1x. A workload that writes long-TTL caches it
 *     never reads again is strictly worse off than one that never cached.
 *
 *  2. BILLING CLASS IS PER MESSAGE, NOT PER RUN. Fast mode is the same model at
 *     premium pricing and a batch request is the same model at half, and both
 *     are recorded per message. A session that delegated to a Haiku subagent
 *     prices correctly without anyone passing a flag.
 *
 *  3. INTRODUCTORY PRICING EXPIRES. Rates carry an optional window. Pricing
 *     August 2026 Sonnet 5 traffic at the post-intro rate overstates it by 50%.
 *
 * Rates are dollars per million tokens. Update RATE_CARD from the pricing page;
 * see references/rate-cards.md.
 */

export const CACHE_MULTIPLIER = { uncached: 1.0, write1h: 2.0, write5m: 1.25, read: 0.1 };

/** Batch requests bill at half. Applied on top of everything else. */
export const BATCH_MULTIPLIER = 0.5;

export const RATE_CARD = {
  'claude-opus-5': { input: 5, output: 25, fast: { input: 10, output: 50 } },
  'claude-opus-4-8': { input: 5, output: 25, fast: { input: 10, output: 50 } },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-sonnet-5': {
    input: 3,
    output: 15,
    // Introductory rate, published as running through 2026-08-31.
    intro: { input: 2, output: 10, until: '2026-08-31' },
  },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * Base rates for one billing class, or null if the model is unknown.
 *
 * Returning null rather than throwing is deliberate: a single unrecognised model
 * should not sink the whole report. The caller surfaces it as UNPRICED so the
 * gap is visible instead of silently folded into a plausible-looking total.
 */
export function ratesFor(cls, asOf = null) {
  const card = RATE_CARD[cls.model];
  if (card === undefined) return null;
  let base = { input: card.input, output: card.output };
  if (card.intro && asOf && asOf.slice(0, 10) <= card.intro.until) {
    base = { input: card.intro.input, output: card.intro.output };
  }
  if (cls.speed === 'fast' && card.fast) base = { ...card.fast };
  if (cls.tier === 'batch') base = { input: base.input * BATCH_MULTIPLIER, output: base.output * BATCH_MULTIPLIER };
  return base;
}

export function costOf(tokens, rates) {
  const m = CACHE_MULTIPLIER;
  return (
    (tokens.uncached / 1e6) * rates.input * m.uncached +
    (tokens.write1h / 1e6) * rates.input * m.write1h +
    (tokens.write5m / 1e6) * rates.input * m.write5m +
    (tokens.read / 1e6) * rates.input * m.read +
    (tokens.output / 1e6) * rates.output
  );
}

const zero = () => ({ uncached: 0, write1h: 0, write5m: 0, read: 0, output: 0 });
const add = (into, from) => {
  for (const k of Object.keys(into)) into[k] += from[k];
};

/**
 * Price a ledger.
 *
 * Bucket attribution is apportioned by each bucket's share of the priced
 * classes. Where a run is single-model — the common case — that is exact.
 */
export function priceLedger(ledger) {
  const asOf = ledger.firstAt;
  const priced = [];
  const unpriced = [];
  const billable = zero();

  for (const cls of ledger.byClass) {
    const rates = ratesFor(cls, asOf);
    if (rates === null) {
      unpriced.push({ ...cls, reason: `no rate card for "${cls.model}"` });
      continue;
    }
    priced.push({ ...cls, rates, amount: costOf(cls.tokens, rates) });
    add(billable, cls.tokens);
  }

  const total = priced.reduce((sum, p) => sum + p.amount, 0);

  // One blended rate stands in for the mix when attributing buckets and
  // counterfactuals. With a single class it is that class's rate exactly.
  const inputTokens = billable.uncached + billable.write1h + billable.write5m + billable.read;
  const blended = {
    input: inputTokens > 0
      ? priced.reduce((s, p) => s + p.rates.input * (p.tokens.uncached + p.tokens.write1h + p.tokens.write5m + p.tokens.read), 0) / inputTokens
      : 0,
    output: billable.output > 0
      ? priced.reduce((s, p) => s + p.rates.output * p.tokens.output, 0) / billable.output
      : 0,
  };

  const lines = [
    ['Input — uncached', billable.uncached, blended.input * CACHE_MULTIPLIER.uncached],
    ['Input — cache writes, 1-hour TTL', billable.write1h, blended.input * CACHE_MULTIPLIER.write1h],
    ['Input — cache writes, 5-minute TTL', billable.write5m, blended.input * CACHE_MULTIPLIER.write5m],
    ['Input — cache reads', billable.read, blended.input * CACHE_MULTIPLIER.read],
    ['Output', billable.output, blended.output],
  ].map(([label, tokens, rate]) => ({ label, tokens, rate, amount: (tokens / 1e6) * rate }));

  const byBucket = {};
  for (const [bucket, tokens] of Object.entries(ledger.byBucket)) {
    byBucket[bucket] = costOf(tokens, blended);
  }

  const withoutCaching =
    ((billable.uncached + billable.write1h + billable.write5m + billable.read) / 1e6) * blended.input +
    (billable.output / 1e6) * blended.output;
  const allOneHourTtl = costOf(
    { ...billable, write1h: billable.write1h + billable.write5m, write5m: 0 },
    blended,
  );

  return {
    lines,
    total,
    billable,
    totalTokens: inputTokens + billable.output,
    priced,
    unpriced,
    blended,
    byBucket,
    withoutCaching,
    allOneHourTtl,
    cacheReadShare: total > 0 ? lines[3].amount / total : 0,
  };
}
