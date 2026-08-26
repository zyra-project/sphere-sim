// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * impact — tokens to kilowatt-hours, litres, and kilograms of CO2e.
 *
 * ## Read this before quoting any number out of this file
 *
 * The cost side of this package is measurement. This side is not. Only the token
 * counts are measured; every constant below is either an industry figure or a
 * declared guess, and the guesses dominate. Model size, serving hardware, batch
 * size, fleet utilisation and datacentre siting are not public, and each moves
 * the answer more than the token counts do.
 *
 * That is the same structure as docs/PARAMETERS.md: geometric parameters are
 * `DOC`/`CFG`/`SOLVE` and trustworthy, photometric ones are `ASSUME`/`MEAS` and
 * gated. The rule there applies here — build it, test it, report the band, and
 * do not tune anything against it.
 *
 * ## Why three methods instead of one
 *
 * A single estimate here would be indistinguishable from a confident one. The
 * three below share no inputs of consequence, so their disagreement measures
 * something a within-method error bar cannot: how much of the answer is
 * unknowable from outside the operator.
 *
 *   A  Vendor-anchored. Take the per-query energy figures Google and OpenAI have
 *      published and rescale by this workload's shape. A FLOOR: those disclosures
 *      cover smaller models than the one used here.
 *   B  Bottom-up. FLOPs, memory traffic and watts from first principles. The most
 *      specific to this workload, because it is the only one that knows the
 *      contexts averaged 223k tokens.
 *   C  Cost-anchored. Walk the bill through gross margin to accelerator-hours to
 *      watts. Touches no token counts at all. A CEILING: it assumes every
 *      inference dollar buys power-proportional compute.
 *
 * ## The falsifiers, written before the numbers
 *
 *   F1  The three methods agree to within a factor of two. Then the unknowns do
 *       not matter much, the band should be reported as narrow, and the
 *       hand-wringing in this comment is unwarranted.
 *   F2  Method B reproduces the published per-query figures for a typical short
 *       query. Then B is calibrated, A is redundant, and B alone should be
 *       reported. (It does not: B runs about 5x high. See `shortQueryWh`.)
 *   F3  One term dominates so completely that the others are noise. Then the
 *       report should name that term and drop the rest.
 *   F4  Water or carbon turns out to be a fixed multiple of energy with a
 *       narrower band than energy itself. Then they are not separate findings
 *       and should be presented as unit conversions.
 */

import type { Uncertain } from './montecarlo.ts';
import { bandOf, makeRng, sample } from './montecarlo.ts';
import type { Band } from './montecarlo.ts';

/** The measured side. Everything here comes out of the transcripts. */
export interface Work {
  /** Tokens that had to be computed through the network: uncached input + cache writes. */
  readonly prefillTokens: number;
  /** Cache reads. These skipped prefill — that is what the cache bought. */
  readonly readTokens: number;
  readonly outputTokens: number;
  /** Sum over messages of context x output. Drives the attention term. */
  readonly contextOutputProduct: number;
  readonly requests: number;
  /** The bill, for method C. */
  readonly dollars: number;
}

/**
 * Every uncertain input, with its provenance.
 *
 * `PUB`     published by a vendor or operator; checkable
 * `IND`     an industry or government figure for a comparable facility
 * `ASSUME`  not published anywhere; chosen by us, and the reason the band is wide
 */
export const CONSTANTS = {
  activeParams: {
    name: 'activeParams',
    low: 100e9,
    high: 600e9,
    unit: 'parameters/token',
    provenance: 'ASSUME',
    note: 'Active parameters per token. Not published for any frontier model. The single largest unknown in method B.',
  },
  achievedFlops: {
    name: 'achievedFlops',
    low: 2.5e14,
    high: 7.0e14,
    unit: 'FLOP/s',
    provenance: 'ASSUME',
    note: 'Achieved (not peak) throughput per accelerator during prefill.',
  },
  acceleratorItWatts: {
    name: 'acceleratorItWatts',
    low: 0.9e3,
    high: 1.5e3,
    unit: 'W',
    provenance: 'IND',
    note: 'IT power per accelerator at load: the device plus its share of host, network and storage. EXCLUDES cooling and facility overhead — that is pue, because the cooling choice moves it.',
  },
  pue: {
    name: 'pue',
    low: 1.10,
    high: 1.70,
    unit: 'ratio',
    provenance: 'IND',
    note: 'Power usage effectiveness. Spans the cooling regimes: evaporative towers reach 1.1-1.3, dry air cooling costs 1.4-1.8, closed-loop liquid 1.05-1.2.',
  },
  fleetUtilisation: {
    name: 'fleetUtilisation',
    low: 0.3,
    high: 0.8,
    unit: 'fraction',
    provenance: 'ASSUME',
    note: 'Fraction of fleet-seconds doing useful work. Capacity is provisioned for peak, so at-load figures understate the real draw.',
  },
  kvBytesPerToken: {
    name: 'kvBytesPerToken',
    low: 8e3,
    high: 2e5,
    unit: 'bytes/token',
    provenance: 'ASSUME',
    note: 'Effective KV cache footprint. The range is two orders wide because sliding-window or latent-attention designs cut it roughly tenfold and nobody publishes which is in use.',
  },
  hbmBandwidth: {
    name: 'hbmBandwidth',
    low: 1.5e12,
    high: 3.5e12,
    unit: 'B/s',
    provenance: 'IND',
    note: 'Achieved high-bandwidth-memory throughput per accelerator.',
  },
  decodeBatch: {
    name: 'decodeBatch',
    low: 16,
    high: 256,
    unit: 'sequences',
    provenance: 'ASSUME',
    note: 'Concurrent sequences during decode. Amortises weight streaming but never the KV cache, which is per-sequence.',
  },
  bytesPerParam: {
    name: 'bytesPerParam',
    low: 1.0,
    high: 2.0,
    unit: 'bytes',
    provenance: 'ASSUME',
    note: 'Serving precision, fp8 through bf16.',
  },
  stagingBandwidth: {
    name: 'stagingBandwidth',
    low: 1.5e10,
    high: 1.5e11,
    unit: 'B/s',
    provenance: 'ASSUME',
    note: 'Rate at which a persisted KV cache is brought back into accelerator memory.',
  },

  publishedWhPerQuery: {
    name: 'publishedWhPerQuery',
    low: 0.24,
    high: 0.34,
    unit: 'Wh/query',
    provenance: 'PUB',
    note: 'Google, median Gemini text prompt, Aug 2025 (0.24). OpenAI, average ChatGPT query, Jun 2025 (0.34). Both are vendor self-reports for smaller models than this one, which is why method A is a floor.',
  },
  referenceQueryContext: {
    name: 'referenceQueryContext',
    low: 700,
    high: 1400,
    unit: 'tokens',
    provenance: 'ASSUME',
    note: 'Context length of the "typical query" the published figures describe. Neither vendor states it.',
  },
  referenceQueryOutput: {
    name: 'referenceQueryOutput',
    low: 200,
    high: 450,
    unit: 'tokens',
    provenance: 'ASSUME',
    note: 'Output length of that same typical query. Also unstated.',
  },

  grossMargin: {
    name: 'grossMargin',
    low: 0.35,
    high: 0.75,
    unit: 'fraction',
    provenance: 'ASSUME',
    note: 'Inference gross margin at list API prices.',
  },
  computeShareOfCogs: {
    name: 'computeShareOfCogs',
    low: 0.55,
    high: 0.85,
    unit: 'fraction',
    provenance: 'ASSUME',
    note: 'Share of cost of goods sold that is accelerator time, as opposed to storage, networking and operations.',
  },
  dollarsPerAcceleratorHour: {
    name: 'dollarsPerAcceleratorHour',
    low: 1.5,
    high: 4.0,
    unit: 'USD/hour',
    provenance: 'IND',
    note: 'Rental-equivalent price of one accelerator-hour. Already includes provisioning slack, so method C does not divide by fleetUtilisation.',
  },

  onSiteWue: {
    name: 'onSiteWue',
    low: 0.02,
    high: 3.0,
    unit: 'L/kWh(IT)',
    provenance: 'IND',
    note: 'Site water per kWh of IT energy (the Green Grid definition, hence per IT rather than per facility kWh). NOT a continuum: real facilities cluster into regimes two to three orders apart — evaporative towers 1.5-3.0, dry air cooling ~0.01, closed-loop liquid ~0.05 — so this wide band is a mixture, not a central estimate.',
  },
  gridWaterIntensity: {
    name: 'gridWaterIntensity',
    low: 0.8,
    high: 3.2,
    unit: 'L/kWh',
    provenance: 'IND',
    note: 'Water CONSUMED generating the electricity. Withdrawal is an order larger but mostly returned; consumption is the honest figure.',
  },

  gridCarbonLocation: {
    name: 'gridCarbonLocation',
    low: 80,
    high: 600,
    unit: 'gCO2e/kWh',
    provenance: 'IND',
    note: 'Location-based: the grid the facility physically draws from. Widened from an earlier 200-550, which was narrower than the published span of real datacentre regions (Oregon 79 to South Carolina 576) and so claimed more knowledge than "unknown region" has.',
  },
  gridCarbonMarket: {
    name: 'gridCarbonMarket',
    low: 20,
    high: 200,
    unit: 'gCO2e/kWh',
    provenance: 'IND',
    note: 'Market-based: after power purchase agreements and renewable certificates. Anchored on the 125 gCO2e/kWh implied by Google’s published per-prompt carbon and energy figures.',
  },
} as const satisfies Record<string, Uncertain>;

export type ConstantName = keyof typeof CONSTANTS;

/** One sample of every constant. Exported so tests can exercise a single draw. */
export type Draw = Record<ConstantName, number>;

/** Sample every constant once from `rng`. */
export function drawConstants(rng: () => number): Draw {
  return drawAll(rng);
}

function drawAll(rng: () => number): Draw {
  const out = {} as Draw;
  for (const key of Object.keys(CONSTANTS) as ConstantName[]) {
    out[key] = sample(CONSTANTS[key], rng);
  }
  return out;
}

const JOULES_PER_KWH = 3.6e6;

/** The four energy terms of method B, in kWh, before the utilisation divisor. */
export interface Terms {
  /** Running fresh tokens through the network. Cache reads skip this entirely. */
  readonly prefill: number;
  /** Streaming weights out of memory once per generated token, amortised over the batch. */
  readonly decode: number;
  /** Re-reading the whole KV cache once per generated token. Sharding cancels. */
  readonly attention: number;
  /** Bringing a persisted KV cache back into accelerator memory. */
  readonly staging: number;
}

export function bottomUpTerms(w: Work, d: Draw): Terms {
  const perJ = (d.acceleratorItWatts * d.pue) / JOULES_PER_KWH;
  return {
    prefill: ((2 * d.activeParams * w.prefillTokens) / d.achievedFlops) * perJ,
    decode:
      ((d.activeParams * d.bytesPerParam) / (d.decodeBatch * d.hbmBandwidth)) *
      perJ *
      w.outputTokens,
    attention: ((w.contextOutputProduct * d.kvBytesPerToken) / d.hbmBandwidth) * perJ,
    staging: ((w.readTokens * d.kvBytesPerToken) / d.stagingBandwidth) * perJ,
  };
}

export function bottomUpKwh(w: Work, d: Draw): number {
  const t = bottomUpTerms(w, d);
  return (t.prefill + t.decode + t.attention + t.staging) / d.fleetUtilisation;
}

/**
 * What method B predicts for one typical short query.
 *
 * This exists to be compared against `publishedWhPerQuery`, not to be reported.
 * It is how method A gets its scale factor, and it is also falsifier F2: if this
 * matched the published figures, method A would be redundant. It does not match —
 * B runs roughly 5x high — and holding that discrepancy visible is the point.
 */
export function shortQueryWh(d: Draw): number {
  const ctx = d.referenceQueryContext;
  const out = d.referenceQueryOutput;
  const perJ = (d.acceleratorItWatts * d.pue) / JOULES_PER_KWH;
  const kwh =
    (((2 * d.activeParams * ctx) / d.achievedFlops) * perJ +
      ((d.activeParams * d.bytesPerParam) / (d.decodeBatch * d.hbmBandwidth)) * perJ * out +
      ((ctx * out * d.kvBytesPerToken) / d.hbmBandwidth) * perJ) /
    d.fleetUtilisation;
  return kwh * 1000;
}

/** Method B's shape, rescaled so a typical query matches what vendors publish. */
export function vendorAnchoredKwh(w: Work, d: Draw): number {
  const predicted = shortQueryWh(d);
  if (!(predicted > 0)) return 0;
  return bottomUpKwh(w, d) * (d.publishedWhPerQuery / predicted);
}

/** Method C. Never touches a token count. */
export function costAnchoredKwh(w: Work, d: Draw): number {
  const acceleratorHours =
    (w.dollars * (1 - d.grossMargin) * d.computeShareOfCogs) / d.dollarsPerAcceleratorHour;
  return acceleratorHours * ((d.acceleratorItWatts * d.pue) / 1000);
}

/** Energy with caching switched off: every cached token re-prefilled every turn. */
export function noCacheKwh(w: Work, d: Draw): number {
  return bottomUpKwh({ ...w, prefillTokens: w.prefillTokens + w.readTokens, readTokens: 0 }, d);
}

export interface MethodResult {
  readonly key: 'A' | 'B' | 'C';
  readonly name: string;
  readonly role: string;
  readonly kwh: Band;
}

export interface ImpactReport {
  readonly draws: number;
  readonly seed: number;
  readonly methods: readonly MethodResult[];
  /** The three methods concatenated — an equal-weight mixture, not an average. */
  readonly pooled: {
    readonly kwh: Band;
    readonly litres: Band;
    readonly kgCo2eLocation: Band;
    readonly kgCo2eMarket: Band;
  };
  /** Mean share of method B's energy by term. Sums to 1. */
  readonly termShares: Terms;
  /** Median of method B's prediction for one typical query, in Wh. Falsifier F2. */
  readonly shortQueryWhMedian: number;
  /** Median energy had prompt caching been off, in kWh. */
  readonly noCacheKwhMedian: number;
}

export function runImpact(w: Work, draws = 200_000, seed = 20260823): ImpactReport {
  const rng = makeRng(seed);
  const energyA: number[] = [];
  const energyB: number[] = [];
  const energyC: number[] = [];
  const litres: number[] = [];
  const carbonLoc: number[] = [];
  const carbonMkt: number[] = [];
  const shortQ: number[] = [];
  const noCache: number[] = [];
  const shareSum: { prefill: number; decode: number; attention: number; staging: number } = {
    prefill: 0,
    decode: 0,
    attention: 0,
    staging: 0,
  };

  for (let i = 0; i < draws; i++) {
    const d = drawAll(rng);
    const terms = bottomUpTerms(w, d);
    const bare = terms.prefill + terms.decode + terms.attention + terms.staging;
    if (bare > 0) {
      shareSum.prefill += terms.prefill / bare;
      shareSum.decode += terms.decode / bare;
      shareSum.attention += terms.attention / bare;
      shareSum.staging += terms.staging / bare;
    }

    const b = bare / d.fleetUtilisation;
    const predicted = shortQueryWh(d);
    const a = predicted > 0 ? b * (d.publishedWhPerQuery / predicted) : 0;
    const c = costAnchoredKwh(w, d);
    energyA.push(a);
    energyB.push(b);
    energyC.push(c);
    shortQ.push(predicted);
    noCache.push(noCacheKwh(w, d));

    // Water and carbon are conditioned on the SAME draw as the energy they scale,
    // and each method contributes one sample, so the pooled band inherits the
    // between-method spread rather than smoothing it away.
    // onSiteWue is per kWh of IT energy while `e` is facility energy, so the
    // site term divides by PUE. Skipping that charges a high-PUE facility extra
    // site water for the very overhead that replaced its evaporation.
    const waterPerKwh = d.onSiteWue / d.pue + d.gridWaterIntensity;
    for (const e of [a, b, c]) {
      litres.push(e * waterPerKwh);
      carbonLoc.push((e * d.gridCarbonLocation) / 1000);
      carbonMkt.push((e * d.gridCarbonMarket) / 1000);
    }
  }

  const pooledEnergy = [...energyA, ...energyB, ...energyC];
  return {
    draws,
    seed,
    methods: [
      {
        key: 'A',
        name: 'Vendor-anchored',
        role: 'floor — published figures cover smaller models',
        kwh: bandOf(energyA),
      },
      {
        key: 'B',
        name: 'Bottom-up hardware',
        role: 'most specific to this workload',
        kwh: bandOf(energyB),
      },
      {
        key: 'C',
        name: 'Cost-anchored',
        role: 'ceiling — assumes every dollar buys power-proportional compute',
        kwh: bandOf(energyC),
      },
    ],
    pooled: {
      kwh: bandOf(pooledEnergy),
      litres: bandOf(litres),
      kgCo2eLocation: bandOf(carbonLoc),
      kgCo2eMarket: bandOf(carbonMkt),
    },
    termShares: {
      prefill: shareSum.prefill / draws,
      decode: shareSum.decode / draws,
      attention: shareSum.attention / draws,
      staging: shareSum.staging / draws,
    },
    shortQueryWhMedian: bandOf(shortQ).p50,
    noCacheKwhMedian: bandOf(noCache).p50,
  };
}
