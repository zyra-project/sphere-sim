/**
 * impact.mjs — tokens to kilowatt-hours, litres, and kilograms of CO2e.
 *
 * READ THIS BEFORE QUOTING ANY NUMBER FROM HERE. The pricing half of this
 * toolkit is measurement. This half is not. Only the token counts are known;
 * model size, serving hardware, batch size, fleet utilisation and datacentre
 * siting are non-public and each moves the answer more than the tokens do.
 *
 * WHY THREE METHODS. A single estimate would be indistinguishable from a
 * confident one. These three share no inputs of consequence, so their
 * disagreement measures something no within-method error bar can: how much of
 * the answer is unknowable from outside the operator.
 *
 *   A  Vendor-anchored — published per-query energy rescaled by this workload's
 *      shape. A FLOOR: those disclosures cover smaller models.
 *   B  Bottom-up — FLOPs, memory traffic, watts. The only one that knows this
 *      workload's actual context lengths.
 *   C  Cost-anchored — bill through gross margin to accelerator-hours. Touches
 *      no token counts at all. A CEILING.
 *
 * They are POOLED, NOT AVERAGED: the reported band is the three concatenated
 * with equal weight, so the between-method spread survives into the result.
 *
 * FALSIFIERS, written before any number was produced:
 *   F1  the three agree within 2x        -> the wide band is unjustified
 *   F2  B reproduces published figures    -> method A is redundant
 *   F3  one term is >90% of the energy    -> name it and drop the rest
 *   F4  water/carbon narrower than energy -> they are unit conversions
 * None fires the way that would simplify the report. F2 is the uncomfortable
 * one and is surfaced rather than buried — see `shortQueryWh`.
 */

/** mulberry32 — deterministic, so a rerun distinguishes a model change from noise. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function standardNormal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const Z90 = 1.6448536269514722;

/**
 * A lognormal declared by the 90% interval you would actually bet on.
 *
 * Positive quantities known to within a multiplicative factor, which is every
 * quantity here. The median falls out as the geometric mean rather than being
 * chosen, so declaring a range cannot smuggle in a central estimate.
 */
export function sample(u, rng) {
  if (!(u.low > 0) || !(u.high > 0)) throw new Error(`${u.name}: bounds must be positive`);
  if (u.high < u.low) throw new Error(`${u.name}: high below low`);
  const mu = Math.log(Math.sqrt(u.low * u.high));
  const sigma = Math.log(u.high / u.low) / (2 * Z90);
  return Math.exp(mu + sigma * standardNormal(rng));
}

export function percentile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(q * (sorted.length - 1))];
}

export const bandOf = (v) => ({
  p5: percentile(v, 0.05),
  p10: percentile(v, 0.1),
  p50: percentile(v, 0.5),
  p90: percentile(v, 0.9),
  p95: percentile(v, 0.95),
});

/**
 * Provenance, same discipline the rest of this toolkit uses:
 *   PUB     published by a vendor or operator; checkable
 *   IND     an industry or government figure for a comparable facility
 *   ASSUME  not published anywhere; chosen by us, and why the band is wide
 */
export const CONSTANTS = {
  activeParams: { name: 'activeParams', low: 100e9, high: 600e9, unit: 'params/token', provenance: 'ASSUME',
    note: 'Active parameters per token. Not published for any frontier model. The single largest unknown.' },
  achievedFlops: { name: 'achievedFlops', low: 2.5e14, high: 7.0e14, unit: 'FLOP/s', provenance: 'ASSUME',
    note: 'Achieved (not peak) throughput per accelerator during prefill.' },
  acceleratorWatts: { name: 'acceleratorWatts', low: 1.0e3, high: 2.2e3, unit: 'W', provenance: 'IND',
    note: 'Per accelerator at load, including its share of host, network, storage and PUE.' },
  fleetUtilisation: { name: 'fleetUtilisation', low: 0.3, high: 0.8, unit: 'fraction', provenance: 'ASSUME',
    note: 'Fraction of fleet-seconds doing useful work. Capacity is provisioned for peak.' },
  kvBytesPerToken: { name: 'kvBytesPerToken', low: 8e3, high: 2e5, unit: 'bytes/token', provenance: 'ASSUME',
    note: 'Effective KV cache footprint. Two orders wide because sliding-window or latent attention cuts it ~10x.' },
  hbmBandwidth: { name: 'hbmBandwidth', low: 1.5e12, high: 3.5e12, unit: 'B/s', provenance: 'IND',
    note: 'Achieved high-bandwidth-memory throughput per accelerator.' },
  decodeBatch: { name: 'decodeBatch', low: 16, high: 256, unit: 'sequences', provenance: 'ASSUME',
    note: 'Concurrent sequences during decode. Amortises weights, never the per-sequence KV cache.' },
  bytesPerParam: { name: 'bytesPerParam', low: 1.0, high: 2.0, unit: 'bytes', provenance: 'ASSUME',
    note: 'Serving precision, fp8 through bf16.' },
  stagingBandwidth: { name: 'stagingBandwidth', low: 1.5e10, high: 1.5e11, unit: 'B/s', provenance: 'ASSUME',
    note: 'Rate at which a persisted KV cache is restored to accelerator memory.' },
  publishedWhPerQuery: { name: 'publishedWhPerQuery', low: 0.24, high: 0.34, unit: 'Wh/query', provenance: 'PUB',
    note: 'Google median Gemini text prompt Aug 2025 (0.24); OpenAI average ChatGPT query Jun 2025 (0.34). Both smaller models than a frontier coding model, so method A is a floor.' },
  referenceQueryContext: { name: 'referenceQueryContext', low: 700, high: 1400, unit: 'tokens', provenance: 'ASSUME',
    note: 'Context length of the typical query those figures describe. Neither vendor states it.' },
  referenceQueryOutput: { name: 'referenceQueryOutput', low: 200, high: 450, unit: 'tokens', provenance: 'ASSUME',
    note: 'Output length of that same query. Also unstated.' },
  grossMargin: { name: 'grossMargin', low: 0.35, high: 0.75, unit: 'fraction', provenance: 'ASSUME',
    note: 'Inference gross margin at list API prices.' },
  computeShareOfCogs: { name: 'computeShareOfCogs', low: 0.55, high: 0.85, unit: 'fraction', provenance: 'ASSUME',
    note: 'Share of cost of goods sold that is accelerator time rather than storage, network, operations.' },
  dollarsPerAcceleratorHour: { name: 'dollarsPerAcceleratorHour', low: 1.5, high: 4.0, unit: 'USD/h', provenance: 'IND',
    note: 'Rental-equivalent accelerator-hour. Already includes provisioning slack, so method C does not divide by utilisation.' },
  onSiteWue: { name: 'onSiteWue', low: 0.05, high: 1.5, unit: 'L/kWh', provenance: 'IND',
    note: 'Water evaporated on site for cooling. Closed-loop near zero to conventional evaporative towers.' },
  gridWaterIntensity: { name: 'gridWaterIntensity', low: 0.8, high: 3.2, unit: 'L/kWh', provenance: 'IND',
    note: 'Water CONSUMED generating the electricity. Withdrawal is an order larger but mostly returned.' },
  gridCarbonLocation: { name: 'gridCarbonLocation', low: 200, high: 550, unit: 'gCO2e/kWh', provenance: 'IND',
    note: 'Location-based: the grid the facility physically draws from. Most of the range is regional spread.' },
  gridCarbonMarket: { name: 'gridCarbonMarket', low: 20, high: 200, unit: 'gCO2e/kWh', provenance: 'IND',
    note: 'Market-based: after power purchase agreements. Anchored on ~125 gCO2e/kWh implied by Google per-prompt disclosures.' },
};

/**
 * Grid presets, for when the user actually knows where the work ran.
 *
 * Siting moves carbon by roughly an order of magnitude, so this is the one
 * interview answer that reliably changes the headline. `unknown` is the honest
 * default and deliberately stays wide.
 */
export const GRID_PRESETS = {
  unknown: { label: 'Unknown / global default', overrides: {} },
  'us-average': {
    label: 'US average grid',
    overrides: {
      gridCarbonLocation: { low: 320, high: 450 },
      gridWaterIntensity: { low: 1.4, high: 2.8 },
    },
  },
  'low-carbon': {
    label: 'Low-carbon grid (Nordic, French, Québécois hydro/nuclear)',
    overrides: {
      gridCarbonLocation: { low: 15, high: 90 },
      gridCarbonMarket: { low: 5, high: 50 },
      gridWaterIntensity: { low: 0.3, high: 2.0 },
    },
  },
  'coal-heavy': {
    label: 'Coal-heavy grid',
    overrides: {
      gridCarbonLocation: { low: 550, high: 900 },
      gridCarbonMarket: { low: 200, high: 700 },
      gridWaterIntensity: { low: 1.8, high: 4.0 },
    },
  },
  'closed-loop-cooling': {
    label: 'Closed-loop cooled facility (little or no on-site evaporation)',
    overrides: { onSiteWue: { low: 0.01, high: 0.15 } },
  },
};

/** Apply named preset(s) and any explicit per-constant overrides. */
export function resolveConstants(presets = [], overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(CONSTANTS)) out[k] = { ...v };
  for (const name of presets) {
    const preset = GRID_PRESETS[name];
    if (preset === undefined) throw new Error(`unknown grid preset "${name}"`);
    for (const [k, v] of Object.entries(preset.overrides)) out[k] = { ...out[k], ...v, source: name };
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (out[k] === undefined) throw new Error(`unknown constant "${k}"`);
    out[k] = { ...out[k], ...v, provenance: 'ASSUME', source: 'user' };
  }
  return out;
}

const J_PER_KWH = 3.6e6;

export function bottomUpTerms(w, d) {
  const perJ = d.acceleratorWatts / J_PER_KWH;
  return {
    prefill: ((2 * d.activeParams * w.prefillTokens) / d.achievedFlops) * perJ,
    decode: ((d.activeParams * d.bytesPerParam) / (d.decodeBatch * d.hbmBandwidth)) * perJ * w.outputTokens,
    // Attention re-reads the whole KV cache once per generated token. Tensor-
    // parallel sharding cancels: each of G accelerators reads 1/G of it.
    attention: ((w.contextOutputProduct * d.kvBytesPerToken) / d.hbmBandwidth) * perJ,
    staging: ((w.readTokens * d.kvBytesPerToken) / d.stagingBandwidth) * perJ,
  };
}

const sumTerms = (t) => t.prefill + t.decode + t.attention + t.staging;

/**
 * Method B's prediction for one typical short query, in Wh.
 *
 * Exists to be compared against publishedWhPerQuery, not reported. It is how
 * method A gets its scale, and it is falsifier F2.
 */
export function shortQueryWh(d) {
  const ctx = d.referenceQueryContext;
  const out = d.referenceQueryOutput;
  const perJ = d.acceleratorWatts / J_PER_KWH;
  const kwh =
    (((2 * d.activeParams * ctx) / d.achievedFlops) * perJ +
      ((d.activeParams * d.bytesPerParam) / (d.decodeBatch * d.hbmBandwidth)) * perJ * out +
      ((ctx * out * d.kvBytesPerToken) / d.hbmBandwidth) * perJ) /
    d.fleetUtilisation;
  return kwh * 1000;
}

export function runImpact(work, options = {}) {
  const draws = options.draws ?? 200_000;
  const seed = options.seed ?? 20260823;
  const constants = resolveConstants(options.presets ?? [], options.overrides ?? {});
  const rng = makeRng(seed);
  const keys = Object.keys(constants);

  const eA = [], eB = [], eC = [], litres = [], carbonLoc = [], carbonMkt = [], shortQ = [], noCache = [];
  const shares = { prefill: 0, decode: 0, attention: 0, staging: 0 };

  for (let i = 0; i < draws; i++) {
    const d = {};
    for (const k of keys) d[k] = sample(constants[k], rng);

    const terms = bottomUpTerms(work, d);
    const bare = sumTerms(terms);
    if (bare > 0) for (const k of Object.keys(shares)) shares[k] += terms[k] / bare;

    const b = bare / d.fleetUtilisation;
    const predicted = shortQueryWh(d);
    const a = predicted > 0 ? b * (d.publishedWhPerQuery / predicted) : 0;
    const c =
      ((work.dollars * (1 - d.grossMargin) * d.computeShareOfCogs) / d.dollarsPerAcceleratorHour) *
      (d.acceleratorWatts / 1000);

    eA.push(a); eB.push(b); eC.push(c);
    shortQ.push(predicted);
    noCache.push(
      sumTerms(bottomUpTerms({ ...work, prefillTokens: work.prefillTokens + work.readTokens, readTokens: 0 }, d)) /
        d.fleetUtilisation,
    );

    // Water and carbon share the draw with the energy they scale, and each
    // method contributes one sample, so the pooled band inherits the
    // between-method spread rather than smoothing it away.
    const waterPerKwh = d.onSiteWue + d.gridWaterIntensity;
    for (const e of [a, b, c]) {
      litres.push(e * waterPerKwh);
      carbonLoc.push((e * d.gridCarbonLocation) / 1000);
      carbonMkt.push((e * d.gridCarbonMarket) / 1000);
    }
  }

  return {
    draws,
    seed,
    presets: options.presets ?? [],
    methods: [
      { key: 'A', name: 'Vendor-anchored', role: 'floor — published figures cover smaller models', kwh: bandOf(eA) },
      { key: 'B', name: 'Bottom-up hardware', role: 'most specific to this workload', kwh: bandOf(eB) },
      { key: 'C', name: 'Cost-anchored', role: 'ceiling — assumes every dollar buys power-proportional compute', kwh: bandOf(eC) },
    ],
    pooled: {
      kwh: bandOf([...eA, ...eB, ...eC]),
      litres: bandOf(litres),
      kgCo2eLocation: bandOf(carbonLoc),
      kgCo2eMarket: bandOf(carbonMkt),
    },
    termShares: {
      prefill: shares.prefill / draws,
      decode: shares.decode / draws,
      attention: shares.attention / draws,
      staging: shares.staging / draws,
    },
    shortQueryWhMedian: bandOf(shortQ).p50,
    noCacheKwhMedian: bandOf(noCache).p50,
  };
}
