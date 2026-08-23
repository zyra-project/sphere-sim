/**
 * rates — the price card, and the multipliers that make cache accounting
 * different from ordinary token accounting.
 *
 * Everything in this file is `PUB`: published by the vendor, checkable against
 * the pricing page, and wrong only if the page changed. That is the entire
 * reason the cost half of this analysis is trustworthy and the environmental
 * half is not — see docs/USAGE-ACCOUNTING.md.
 *
 * The three cache multipliers are the part people get wrong. A cache write is
 * MORE expensive than a plain input token, not less; the saving comes later, on
 * the reads. A 1-hour write costs double base input and a 5-minute write costs
 * 1.25x, so a workload that writes long-TTL caches it never reads again is
 * strictly worse off than one that never cached at all.
 */

/** Dollars per million tokens, before any cache multiplier. */
export interface ModelRates {
  readonly id: string;
  readonly input: number;
  readonly output: number;
}

/**
 * Rate cards, keyed by the model id the transcripts record.
 *
 * Only models this repository has actually been run against are listed. Adding
 * a model means adding its published rates, not interpolating from a nearby one.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  'claude-opus-5': { id: 'claude-opus-5', input: 5.0, output: 25.0 },
  'claude-sonnet-5': { id: 'claude-sonnet-5', input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { id: 'claude-haiku-4-5', input: 1.0, output: 5.0 },
};

/** Multipliers on the base input rate, per token class. */
export const CACHE_MULTIPLIER = {
  /** A plain input token that missed the cache. */
  uncached: 1.0,
  /** Written with a 1-hour TTL. Twice base input. */
  write1h: 2.0,
  /** Written with the default 5-minute TTL. */
  write5m: 1.25,
  /** Served from cache. A tenth of base input — the whole point of the feature. */
  read: 0.1,
} as const;

export function ratesFor(modelId: string): ModelRates {
  const rates = MODEL_RATES[modelId];
  if (rates === undefined) {
    const known = Object.keys(MODEL_RATES).join(', ');
    throw new Error(
      `No published rate card for "${modelId}". Known: ${known}. ` +
        'Add its rates to MODEL_RATES rather than substituting a similar model.',
    );
  }
  return rates;
}
