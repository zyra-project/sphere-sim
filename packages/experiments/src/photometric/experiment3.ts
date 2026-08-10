/**
 * Experiment 3 — photometric sensitivity, as a work order for PARAMETERS.md §8.
 *
 * Sweep every ASSUME-class photometric constant across its plausible range, one at a
 * time, and rank them by how far each moves a §7 metric. The output is not a quality
 * statement about the simulator: it is a list of what to point a camera at during the
 * ground-truth visit, in priority order, and the ranking is worth exactly as much as
 * the ranges it is computed over.
 *
 * ## The honesty problem this experiment has, and what is done about it
 *
 * Each range in `parameters.ts` carries a `rangeSource`. `'stated'` means
 * PARAMETERS.md gives the range. `'inferred'` means we invented it
 * (docs/AMENDMENTS.md A-04). **A big swing across an invented range is a statement
 * about our invention, not about the world.** Mixing the two in one ranking would
 * produce a measurement priority driven by whichever ranges we happened to guess
 * wide, so:
 *
 *  - every row carries its `rangeSource` through to the results file and the plot;
 *  - the headline ranking is over STATED ranges only, and the inferred rows are
 *    ranked separately rather than interleaved;
 *  - the swing is also reported per unit of range travelled, which is the closest
 *    thing to a range-free sensitivity available and is what a reader should use when
 *    comparing a stated row against an inferred one.
 *
 * ## What is ranked against what
 *
 * §7 states five photometric numbers and four of them are gates this project scores.
 * Every response is divided by its own gate before ranking, so a ΔE2000 and a bare
 * fraction share a unit without anybody choosing a weight — the same rule
 * `packages/bench/src/loop.ts` uses, and for the same reason.
 *
 * Four further responses are reported and NOT included in the headline ranking:
 * §7 sets no threshold on them, and inventing one to make a ranking come out would be
 * inventing a requirement. They are there because the headline ranking without them
 * disagrees with §10 in a way that turns out to be about the gates rather than about
 * the physics — see `docs/EXPERIMENT-3.md`.
 *
 * Every number here is **PROVISIONAL**, and the sweep runs once.
 */

import { ASSUME_PHOTOMETRIC_IDS, GATES, PARAMETER_TABLE } from '../../../calibration/src/parameters.ts';
import type { ParamSpec } from '../../../calibration/src/parameters.ts';
import { computePhotometricMetrics } from '../../../sim/src/index.ts';
import type { Assignment } from './model.ts';
import { buildModel } from './model.ts';
import { measureBlendProfile } from './artifact.ts';

/** One measured quantity, with the gate it is normalized by when it has one. */
export interface ResponseSpec {
  id: string;
  label: string;
  unit: string;
  /** `null` where §7 states no threshold — those are reported, never ranked. */
  gateMax: number | null;
  /** True for the four §7 gates this project scores. */
  scored: boolean;
  note: string;
}

const gate = (id: string): number => {
  const g = GATES.find((x) => x.id === id);
  if (g === undefined) throw new Error(`no gate ${id}`);
  return g.max;
};

export const RESPONSES: readonly ResponseSpec[] = [
  {
    id: 'seam_luminance',
    label: 'Seam luminance discontinuity',
    unit: 'fraction of local mean',
    gateMax: gate('seam_luminance'),
    scored: true,
    note: '§7 gate. Measured at the hand-over, which is where §7 words it.',
  },
  {
    id: 'seam_chroma',
    label: 'Seam chromaticity discontinuity',
    unit: 'dE2000',
    gateMax: gate('seam_chroma'),
    scored: true,
    note: '§7 gate.',
  },
  {
    id: 'black_uplift',
    label: 'Black uplift ratio, overlap / single',
    unit: 'ratio',
    gateMax: gate('black_uplift'),
    scored: true,
    note: '§7 gate, ambient included. A-21: which reading §7 means is not stated.',
  },
  {
    id: 'black_uplift_chroma',
    label: 'Black uplift chromaticity shift',
    unit: 'dE2000',
    gateMax: gate('black_uplift_chroma'),
    scored: true,
    note: '§7 gate.',
  },
  {
    id: 'seam_divergence_luminance',
    label: 'Luminance shift from per-channel transfer divergence',
    unit: 'fraction',
    gateMax: null,
    scored: false,
    note:
      'UNSCORED. §7 sets no gate. This is §3.2\'s artifact measured directly, and it is the ' +
      'reading the two seam gates are blind to (A-15).',
  },
  {
    id: 'seam_divergence_chroma',
    label: 'Chromaticity shift from per-channel transfer divergence',
    unit: 'dE2000',
    gateMax: null,
    scored: false,
    note: 'UNSCORED. §3.2\'s "coloured band rather than a bright or dark one", in dE2000.',
  },
  {
    id: 'black_uplift_projector_only',
    label: 'Black uplift with ambient removed (§8 frames 8 minus 9)',
    unit: 'ratio',
    gateMax: null,
    scored: false,
    note: 'UNSCORED. Exactly the projector count by construction (A-21).',
  },
  {
    id: 'overlap_gradient',
    label: 'Steepest fractional luminance gradient in the overlap',
    unit: 'per degree of arc',
    gateMax: null,
    scored: false,
    note:
      'UNSCORED, and §7 has no equivalent. Experiment 2\'s scale-free measure of how ' +
      'abruptly the blend hands a point from one projector to the other.',
  },
  {
    id: 'smeared_area_fraction',
    label: 'Sphere area whose delivered light is below §4.3\'s cos(incidence) 0.2',
    unit: 'fraction',
    gateMax: null,
    scored: false,
    note: 'UNSCORED. §4.3 calls this region degenerate; §7 gates nothing about it.',
  },
];

export type ResponseVector = Record<string, number>;

/** Measure every response on one assignment. */
export function measureResponses(assignment: Assignment): ResponseVector {
  const built = buildModel(assignment);
  const set = computePhotometricMetrics(built.rig, built.scene, {
    shading: built.shading,
    convergence: false,
  });
  const out: ResponseVector = {};
  for (const m of set.metrics) out[m.id] = m.value;
  const profile = measureBlendProfile(built.rig, built.scene, { shading: built.shading });
  out.overlap_gradient = profile.maxLogGradientPerDeg;
  out.smeared_area_fraction = profile.smearedAreaFraction;
  return out;
}

/**
 * Levels a parameter is swept at.
 *
 * Logarithmic when the range spans a factor of four or more, linear otherwise. The
 * black floor spans 6.7x and ambient spans 15x, and sampling those linearly puts
 * seven of nine samples in the top half of the range and reports a sensitivity
 * dominated by where the samples were rather than by the physics. The nominal is
 * inserted if the grid misses it, so every sweep contains the value the rest of the
 * project runs at.
 */
export function levelsFor(spec: ParamSpec, count = 9): number[] {
  const useLog = spec.min > 0 && spec.max / spec.min >= 4;
  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    levels.push(useLog
      ? Math.exp(Math.log(spec.min) + t * (Math.log(spec.max) - Math.log(spec.min)))
      : spec.min + t * (spec.max - spec.min));
  }
  // The endpoints are set rather than computed. `exp(log(min))` is not `min` in
  // floating point, and a results file that says it swept ambient from
  // 0.010000000000000005 is a results file whose range nobody can grep for.
  levels[0] = spec.min;
  levels[levels.length - 1] = spec.max;

  // Snap-or-insert the nominal, so every sweep contains the exact value the rest of
  // the project runs at and `atNominal` can find it by identity.
  const tolerance = (spec.max - spec.min) * 1e-9;
  const near = levels.findIndex((v) => Math.abs(v - spec.nominal) <= tolerance);
  if (near >= 0) levels[near] = spec.nominal;
  else {
    levels.push(spec.nominal);
    levels.sort((a, b) => a - b);
  }
  return levels;
}

export interface SweepPoint {
  value: number;
  responses: ResponseVector;
}

export interface ResponseSensitivity {
  responseId: string;
  min: number;
  max: number;
  /** `max - min` across the swept range. */
  swing: number;
  /** `swing / gate`, or `NaN` where §7 states no gate. */
  swingOverGate: number;
  atRangeMin: number;
  atRangeMax: number;
  atNominal: number;
  /** True when the response never reverses direction across the sweep. */
  monotone: boolean;
  /** Parameter value at which the response first crosses its gate, or `NaN`. */
  gateCrossingValue: number;
}

export interface ParameterSensitivity {
  id: string;
  symbol: string;
  section: string;
  klass: string;
  rangeSource: 'stated' | 'inferred';
  nominal: number;
  min: number;
  max: number;
  unit: string;
  note: string;
  levels: number[];
  sweep: SweepPoint[];
  responses: ResponseSensitivity[];
  /** Max over the four SCORED §7 gates of `swingOverGate`. The headline rank key. */
  scoreScored: number;
  /** The response that produced `scoreScored`. */
  scoreScoredResponse: string;
  /** The same over the unscored readings, normalized by the gate shown for scale. */
  scoreUnscored: number;
  scoreUnscoredResponse: string;
  /** `scoreScored` per unit of range travelled, for comparing across range widths. */
  scorePerUnitRange: number;
  /** True when some response crosses its gate somewhere inside the plausible range. */
  flipsAVerdict: boolean;
}

export interface InteractionResult {
  a: string;
  b: string;
  responseId: string;
  /** Half the difference between the two levels of `a`, averaged over `b`. */
  mainA: number;
  mainB: number;
  /** Half the second difference: how much the two constants compound. */
  interaction: number;
  /** `|interaction| / max(|mainA|, |mainB|)`. Above ~0.2 is a real compounding. */
  compounding: number;
  corners: { a: number; b: number; value: number }[];
}

export interface Experiment3Result {
  schema: 'sphere-sim/experiment-3@1';
  provisional: true;
  provisionalNote: string;
  responses: readonly ResponseSpec[];
  nominal: ResponseVector;
  parameters: ParameterSensitivity[];
  /** Ids in rank order, stated ranges only. The headline. */
  rankedStated: string[];
  /** Ids in rank order, inferred ranges only. Reported separately, never merged. */
  rankedInferred: string[];
  interactions: InteractionResult[];
  /** How the ranking compares with PARAMETERS.md §10's "highest-risk four". */
  section10: {
    group: string;
    ids: string[];
    bestRankStated: number | null;
    bestRankOverall: number;
    agrees: boolean;
    comment: string;
  }[];
}

const SCORED_IDS = RESPONSES.filter((r) => r.scored).map((r) => r.id);

function sensitivityOf(
  responseId: string,
  spec: ParamSpec,
  sweep: readonly SweepPoint[],
): ResponseSensitivity {
  const values = sweep.map((p) => p.responses[responseId]);
  const finite = values.filter((v) => Number.isFinite(v));
  const min = finite.length > 0 ? Math.min(...finite) : NaN;
  const max = finite.length > 0 ? Math.max(...finite) : NaN;
  const swing = max - min;
  const response = RESPONSES.find((r) => r.id === responseId);
  const gateMax = response?.gateMax ?? null;

  let monotone = true;
  let direction = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    // A tenth of a percent of the swing is below the sampling noise of a max over a
    // lattice, and calling that a reversal would mark almost everything non-monotone.
    if (Math.abs(d) < swing * 1e-3) continue;
    const s = d > 0 ? 1 : -1;
    if (direction === 0) direction = s;
    else if (s !== direction) monotone = false;
  }

  let gateCrossingValue = NaN;
  if (gateMax !== null) {
    for (let i = 0; i < sweep.length; i++) {
      if (values[i] > gateMax) {
        gateCrossingValue = sweep[i].value;
        break;
      }
    }
  }

  const nominalIndex = sweep.findIndex((p) => p.value === spec.nominal);
  return {
    responseId,
    min,
    max,
    swing,
    swingOverGate: gateMax === null ? NaN : swing / gateMax,
    atRangeMin: values[0],
    atRangeMax: values[values.length - 1],
    atNominal: nominalIndex >= 0 ? values[nominalIndex] : NaN,
    monotone,
    gateCrossingValue,
  };
}

export interface RunOptions {
  onProgress?: (message: string) => void;
  /** Levels per parameter. Nine unless a caller is smoke-testing. */
  levels?: number;
}

export function runExperiment3(options: RunOptions = {}): Experiment3Result {
  const log = options.onProgress ?? ((): void => {});
  const levelCount = options.levels ?? 9;
  const nominal = measureResponses({});

  const parameters: ParameterSensitivity[] = [];
  for (const id of ASSUME_PHOTOMETRIC_IDS) {
    const spec = PARAMETER_TABLE[id];
    if (spec === undefined) throw new Error(`ASSUME_PHOTOMETRIC_IDS names ${id}, PARAMETER_TABLE does not`);
    const levels = levelsFor(spec, levelCount);
    const sweep: SweepPoint[] = levels.map((value) => ({
      value,
      responses: measureResponses({ [id]: value }),
    }));
    const responses = RESPONSES.map((r) => sensitivityOf(r.id, spec, sweep));

    let scoreScored = 0;
    let scoreScoredResponse = '';
    let scoreUnscored = 0;
    let scoreUnscoredResponse = '';
    for (const r of responses) {
      if (SCORED_IDS.includes(r.responseId)) {
        if (Number.isFinite(r.swingOverGate) && r.swingOverGate > scoreScored) {
          scoreScored = r.swingOverGate;
          scoreScoredResponse = r.responseId;
        }
      } else {
        // The unscored readings have no gate of their own. Normalizing them by the
        // §7 gate their metric is reported beside — which is what
        // `metrics/photometric.ts` already does for scale — keeps them comparable
        // with the scored rows without pretending §7 gates them.
        const reference =
          r.responseId === 'seam_divergence_luminance'
            ? gate('seam_luminance')
            : r.responseId === 'seam_divergence_chroma'
              ? gate('seam_chroma')
              : r.responseId === 'black_uplift_projector_only'
                ? gate('black_uplift')
                : NaN;
        const scaled = Number.isFinite(reference) ? r.swing / reference : NaN;
        if (Number.isFinite(scaled) && scaled > scoreUnscored) {
          scoreUnscored = scaled;
          scoreUnscoredResponse = r.responseId;
        }
      }
    }

    const rangeWidth = spec.max - spec.min;
    parameters.push({
      id,
      symbol: spec.symbol,
      section: spec.section,
      klass: spec.klass,
      rangeSource: spec.rangeSource,
      nominal: spec.nominal,
      min: spec.min,
      max: spec.max,
      unit: spec.unit,
      note: spec.note,
      levels,
      sweep,
      responses,
      scoreScored,
      scoreScoredResponse,
      scoreUnscored,
      scoreUnscoredResponse,
      scorePerUnitRange: rangeWidth > 0 ? scoreScored / rangeWidth : NaN,
      flipsAVerdict: responses.some((r) => Number.isFinite(r.gateCrossingValue)),
    });
    log(`experiment 3: ${id} swept at ${levels.length} levels`);
  }

  const byScore = (a: ParameterSensitivity, b: ParameterSensitivity): number =>
    b.scoreScored - a.scoreScored;
  const rankedStated = parameters
    .filter((p) => p.rangeSource === 'stated')
    .sort(byScore)
    .map((p) => p.id);
  const rankedInferred = parameters
    .filter((p) => p.rangeSource === 'inferred')
    .sort(byScore)
    .map((p) => p.id);

  const interactions = runInteractions(parameters, log);

  return {
    schema: 'sphere-sim/experiment-3@1',
    provisional: true,
    provisionalNote:
      'PROVISIONAL. Every constant swept here is class ASSUME and none has been measured ' +
      '(PARAMETERS.md §10, docs/ARCHITECTURE.md phase gate). A row whose rangeSource is ' +
      '"inferred" is being swept across a range this project invented (A-04): its swing is a ' +
      'statement about our invention, not about a projector.',
    responses: RESPONSES,
    nominal,
    parameters,
    rankedStated,
    rankedInferred,
    interactions,
    section10: compareWithSection10(parameters, rankedStated),
  };
}

/**
 * PARAMETERS.md §10's highest-risk list is per GROUP — "gamma divergence", "the
 * black floor" — while the sweep is per channel. A group's rank is its best-ranked
 * member, because §10's claim is that measuring the group matters.
 */
function compareWithSection10(
  parameters: readonly ParameterSensitivity[],
  rankedStated: readonly string[],
): Experiment3Result['section10'] {
  const groups: { group: string; ids: string[] }[] = [
    { group: '1. gamma_R,G,B divergence', ids: ['gamma_R', 'gamma_G', 'gamma_B'] },
    { group: '2. L_black_R,G,B', ids: ['L_black_R', 'L_black_G', 'L_black_B'] },
    { group: '3. E_amb and its colour temperature', ids: ['E_amb', 'E_amb_chroma'] },
    { group: '4. rho_R,G,B', ids: ['rho_R', 'rho_G', 'rho_B'] },
  ];
  const overall = [...parameters].sort((a, b) => b.scoreScored - a.scoreScored).map((p) => p.id);

  return groups.map((g, index) => {
    const statedRanks = g.ids
      .map((id) => rankedStated.indexOf(id))
      .filter((r) => r >= 0)
      .map((r) => r + 1);
    const overallRanks = g.ids.map((id) => overall.indexOf(id) + 1).filter((r) => r > 0);
    const bestRankStated = statedRanks.length > 0 ? Math.min(...statedRanks) : null;
    const bestRankOverall = overallRanks.length > 0 ? Math.min(...overallRanks) : NaN;
    const expected = index + 1;
    const observed = bestRankStated ?? bestRankOverall;
    const agrees = Math.abs(observed - expected) <= 1;
    return {
      group: g.group,
      ids: g.ids,
      bestRankStated,
      bestRankOverall,
      agrees,
      comment: agrees
        ? `§10 ranks this ${expected}; measured rank ${observed} on the scored §7 gates.`
        : `§10 ranks this ${expected}; measured rank ${observed} on the scored §7 gates. A disagreement is a finding, not a correction — see docs/EXPERIMENT-3.md.`,
    };
  });
}

/**
 * Pairwise 2-level factorial over the constants that matter most, plus §10's four.
 *
 * A ranking of one-at-a-time sweeps says nothing about whether two constants compound
 * — and §10's highest-risk list is exactly the set most likely to. Four corners per
 * pair, at each constant's range extremes, is the smallest design that separates the
 * two main effects from the interaction between them.
 */
function runInteractions(
  parameters: readonly ParameterSensitivity[],
  log: (message: string) => void,
): InteractionResult[] {
  const top = [...parameters].sort((a, b) => b.scoreScored - a.scoreScored).slice(0, 6).map((p) => p.id);
  const section10 = ['gamma_B', 'L_black_B', 'E_amb', 'rho_B'];
  const ids: string[] = [];
  for (const id of [...top, ...section10]) if (!ids.includes(id)) ids.push(id);

  const cache = new Map<string, ResponseVector>();
  const at = (assignment: Assignment): ResponseVector => {
    const key = JSON.stringify(assignment);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = measureResponses(assignment);
    cache.set(key, value);
    return value;
  };

  const out: InteractionResult[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = PARAMETER_TABLE[ids[i]];
      const b = PARAMETER_TABLE[ids[j]];
      const corners = [
        { a: a.min, b: b.min },
        { a: a.max, b: b.min },
        { a: a.min, b: b.max },
        { a: a.max, b: b.max },
      ].map((c) => ({ ...c, responses: at({ [ids[i]]: c.a, [ids[j]]: c.b }) }));

      for (const response of RESPONSES) {
        const v = corners.map((c) => c.responses[response.id]);
        if (!v.every((x) => Number.isFinite(x))) continue;
        const mainA = (v[1] + v[3] - v[0] - v[2]) / 2;
        const mainB = (v[2] + v[3] - v[0] - v[1]) / 2;
        const interaction = (v[3] - v[1] - v[2] + v[0]) / 2;
        const largest = Math.max(Math.abs(mainA), Math.abs(mainB));
        out.push({
          a: ids[i],
          b: ids[j],
          responseId: response.id,
          mainA,
          mainB,
          interaction,
          compounding: largest > 0 ? Math.abs(interaction) / largest : NaN,
          corners: corners.map((c, k) => ({ a: c.a, b: c.b, value: v[k] })),
        });
      }
    }
    log(`experiment 3: interactions for ${ids[i]} done`);
  }
  return out;
}
