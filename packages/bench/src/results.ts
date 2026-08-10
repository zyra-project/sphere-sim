/**
 * `bench-results.json` — the primary artifact critics read.
 *
 * docs/ARCHITECTURE.md: "Critics read `bench-results.json` and the rendered
 * views. They never read the builder's reasoning, its commit message, or its
 * explanation — only its output." That makes the schema part of the argument
 * rather than a serialisation detail, and it is designed against three specific
 * ways a results file can mislead:
 *
 *  - **A mean hides a bimodal failure.** docs/ARCHITECTURE.md's G2 signature is
 *    "most scenarios excellent, a few catastrophic", which is exactly what a
 *    mean erases. Every aggregate here carries min, p05, median, p95, max,
 *    standard deviation, interquartile range AND the raw per-scenario values,
 *    so a reader can see the shape rather than a summary of it.
 *  - **A pass rate hides which gate failed and why.** The `gates` block names
 *    every gate, how many scenarios it was scored on, the worst offender, and —
 *    for a failing gate — the single largest contributor, MEASURED by
 *    substituting ground truth one parameter group at a time rather than
 *    inferred from a ranking.
 *  - **A number with no provenance is an assertion.** Every metric carries its
 *    gate, its unit, whether it was scored, whether it is provisional, the
 *    sampling scheme it was computed on and that scheme's convergence check.
 *    Those fields come straight from `packages/sim/src/metrics`, which already
 *    made the same argument; this file must not flatten them on the way out.
 *
 * ## Determinism and the volatile block
 *
 * Two runs with the same seed must produce byte-identical output, and the
 * things that cannot be — a wall clock, a git hash, a duration — are confined to
 * exactly two places: the top-level `env` object and each scenario's `timings`.
 * `tools/assert-deterministic.ts` strips those two paths and compares the rest
 * byte for byte, and it CROSS-CHECKS the `volatile` array below against its own
 * hardcoded copy so that a future exclusion cannot be added quietly by editing
 * only the producer.
 */

import type { MetricResult, MetricSet } from '../../sim/src/metrics/index.ts';
import type { ResidualSample } from '../../calibration/src/index.ts';
import { CONVENTIONS_VERSION } from '../../calibration/src/conventions.ts';
import { GATES } from '../../calibration/src/parameters.ts';
import type { ScenarioResult } from './run.ts';
import type { BenchPreset, Scenario } from './scenarios.ts';

export const RESULTS_SCHEMA = 'sphere-sim/bench-results@1';

/**
 * Serialise the results.
 *
 * `JSON.stringify(x, null, 2)` puts every array element on its own line, which
 * for the full residual list means ten thousand lines of a single number
 * surrounded by six spaces. That is three quarters of the file, it is unreadable
 * by a human, and it is not what a plotting library wants either. So numeric
 * arrays are written inline and everything else is indented normally: the same
 * data, a third of the bytes, and a residual column that fits on a screen.
 *
 * Non-finite numbers become `null`, exactly as `JSON.stringify` does. Several
 * metrics legitimately produce `NaN` — an empty statistic, a relative change
 * against a zero baseline — and silently turning those into `0` would be a lie
 * about a missing measurement.
 */
export function stringifyResults(value: unknown): string {
  const out: string[] = [];
  write(value, 0, out);
  out.push('\n');
  return out.join('');
}

function scalar(value: unknown): string | null {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (t === 'boolean') return String(value);
  if (t === 'string') return JSON.stringify(value);
  if (t === 'undefined') return 'null';
  return null;
}

function isNumericArray(a: readonly unknown[]): boolean {
  for (const v of a) {
    if (typeof v !== 'number' && v !== null) return false;
  }
  return true;
}

function write(value: unknown, depth: number, out: string[]): void {
  const s = scalar(value);
  if (s !== null) {
    out.push(s);
    return;
  }
  const pad = '  '.repeat(depth);
  const padInner = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push('[]');
      return;
    }
    if (isNumericArray(value)) {
      out.push('[');
      for (let i = 0; i < value.length; i++) {
        if (i > 0) out.push(', ');
        out.push(scalar(value[i]) ?? 'null');
      }
      out.push(']');
      return;
    }
    out.push('[\n');
    for (let i = 0; i < value.length; i++) {
      out.push(padInner);
      write(value[i], depth + 1, out);
      out.push(i + 1 < value.length ? ',\n' : '\n');
    }
    out.push(`${pad}]`);
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) {
    out.push('{}');
    return;
  }
  out.push('{\n');
  for (let i = 0; i < entries.length; i++) {
    out.push(`${padInner}${JSON.stringify(entries[i][0])}: `);
    write(entries[i][1], depth + 1, out);
    out.push(i + 1 < entries.length ? ',\n' : '\n');
  }
  out.push(`${pad}}`);
}

/**
 * JSON paths excluded from the determinism comparison. Kept in sync with
 * `tools/assert-deterministic.ts`, which fails if the two disagree.
 */
export const VOLATILE_PATHS: string[] = ['env', 'scenarios[].timings'];

// ---------------------------------------------------------------------------
// Dispersion
// ---------------------------------------------------------------------------

export interface Dispersion {
  count: number;
  mean: number;
  median: number;
  p05: number;
  p95: number;
  min: number;
  max: number;
  /** Population standard deviation. */
  stdDev: number;
  /** p75 - p25. Robust to the one catastrophic scenario a mean would smear. */
  iqr: number;
  /** Every value, in scenario order. The only summary that cannot mislead. */
  values: number[];
}

const EMPTY_DISPERSION: Dispersion = {
  count: 0,
  mean: NaN,
  median: NaN,
  p05: NaN,
  p95: NaN,
  min: NaN,
  max: NaN,
  stdDev: NaN,
  iqr: NaN,
  values: [],
};

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

export function dispersion(values: readonly number[]): Dispersion {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { ...EMPTY_DISPERSION, values: [...values] };
  let sum = 0;
  for (const v of finite) sum += v;
  const mean = sum / finite.length;
  let varSum = 0;
  for (const v of finite) varSum += (v - mean) * (v - mean);
  const sorted = finite.slice().sort((a, b) => a - b);
  return {
    count: finite.length,
    mean,
    median: quantile(sorted, 0.5),
    p05: quantile(sorted, 0.05),
    p95: quantile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev: Math.sqrt(varSum / finite.length),
    iqr: quantile(sorted, 0.75) - quantile(sorted, 0.25),
    values: [...values],
  };
}

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/**
 * Round for serialisation.
 *
 * Applied to the residual list only, where it turns a 3 MB scenario into a
 * 600 kB one. Everything else is written at full precision — a rounded metric
 * is a metric somebody will later compare against a gate and find mysteriously
 * off. Residuals are plotted, not compared, and 1e-6 of a projector pixel is
 * four orders of magnitude below anything the scatter can show.
 *
 * `Object.is(-0, 0)` is false and `JSON.stringify(-0)` is `0`, so negative zero
 * is normalised here rather than left to differ between a value and its
 * round trip.
 */
function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.pow(10, decimals);
  const r = Math.round(value * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * The full residual list, columnar.
 *
 * The requirement is the FULL list — a critic reading docs/ARCHITECTURE.md's
 * G3 and G4 signatures ("residuals structured — radial or quadrant patterns",
 * "growing with image radius") needs the scatter, and a summary statistic
 * cannot show a pattern. Columnar rather than an array of records because the
 * records repeat six key names ten thousand times: the same data is about a
 * third the size and is what a plotting library wants anyway.
 */
export interface ResidualColumns {
  count: number;
  projector: number[];
  camera: number[];
  u: number[];
  v: number[];
  du: number[];
  dv: number[];
}

export function residualColumns(residuals: readonly ResidualSample[]): ResidualColumns {
  const cols: ResidualColumns = {
    count: residuals.length,
    projector: [],
    camera: [],
    u: [],
    v: [],
    du: [],
    dv: [],
  };
  for (const r of residuals) {
    cols.projector.push(r.projector);
    cols.camera.push(r.camera);
    cols.u.push(round(r.u, 3));
    cols.v.push(round(r.v, 3));
    cols.du.push(round(r.du, 6));
    cols.dv.push(round(r.dv, 6));
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * What the counterfactual attribution found.
 *
 * `contributor` names the parameter group whose ground-truth substitution
 * removed the most failure. `explainedFraction` is how much of the excess over
 * the gate that substitution removed, and `allGroupsExplain` is how much
 * substituting the entire calibration removes — if that is well under 1, the
 * failure is not in the recovered calibration at all and no amount of solver
 * work will fix it.
 */
export interface GateAttribution {
  scenario: string;
  method: string;
  contributor: string;
  /**
   * What `explainedFraction` MEANS, in words, because it means different things
   * for different methods. A counterfactual substitution explains a fraction of
   * the excess over the gate; an error decomposition explains a fraction of the
   * error's energy; an observability split counts scenarios. Printing "94% of
   * the excess" next to all three would be wrong twice out of three times.
   */
  explains: string;
  explainedFraction: number;
  allGroupsExplain: number;
  /** Metric value with each group taken from ground truth, in group order. */
  byGroup: { group: string; value: number }[];
  note: string;
}

export interface GateSummary {
  id: string;
  metric: string;
  unit: string;
  max: number;
  klass: string;
  phase: string;
  basis: string;
  /** True when every scenario that scored this gate passed it. */
  pass: boolean;
  scenariosScored: number;
  scenariosFailed: number;
  /** Which scenarios failed, by id. */
  failedScenarios: string[];
  worst: { scenario: string; value: number } | null;
  distribution: Dispersion;
  /**
   * Scenarios where the metric had NOTHING to measure, listed rather than
   * counted as failures.
   *
   * The case that forced this: an antipodal two-projector install (AMENDMENTS
   * A-06) has no blend region at all. Each lens reaches 80.4 degrees from its
   * own sub-projector point and the other lens is 180 degrees away, so no
   * surface point is lit by both and grid-line displacement — a measurement of
   * the gap between two projectors' copies of one line — has zero measurements.
   * `sim/metrics` correctly reports NaN, and `makeMetric` correctly fails a NaN
   * because a metric that could not be computed is not a metric that passed.
   * But rolling that into the gate's failure count would say a two-projector
   * install fails the seam gate, when what is true is that it has no seams. The
   * distinction matters to the loop: one is a solver to fix, the other is a
   * sentence to write in §7.
   */
  scenariosNotMeasurable: string[];
  /**
   * Whether the metric's value depends on the RECOVERED calibration at all.
   * Off-sphere flux and unlit-within-the-mask are properties of where the
   * lenses physically point; no solver can move them, and a summary that let a
   * reader believe otherwise would misdirect the loop.
   */
  dependsOnRecovery: boolean;
  attribution: GateAttribution | null;
}

export interface GatesBlock {
  /** True when every scored gate passed on every scenario that scored it. */
  pass: boolean;
  gates: GateSummary[];
  /** Gates reported but excluded from the verdict, with the reason. */
  unscored: { id: string; reason: string }[];
}

/** Gate ids whose metric is a function of the recovered calibration. */
const RECOVERY_DEPENDENT = new Set<string>([
  'grid_displacement',
  'pose_position',
  'pose_rotation',
  'h_center_recovery',
]);

/**
 * Gates the bench evaluates that `sim/metrics` does not produce.
 *
 * Two of them are straight out of PARAMETERS.md §7 and are only here because
 * they are scored against ground truth the metrics module deliberately does not
 * have — it measures a rig, and pose recovery is a comparison between two rigs.
 * Their limits are §7's, restated in millimetres because a reader comparing
 * 0.0234 against 0.002 makes mistakes that a reader comparing 23.4 against 2.0
 * does not.
 *
 * The third is not from §7 at all, and that is stated in its basis rather than
 * blurred. PARAMETERS.md §1's note calls recovering `h_center` "to
 * sub-centimeter accuracy from camera views ... a concrete improvement over the
 * existing procedure and ... worth calling out separately in the invention
 * disclosure". That is a claim this project makes about itself, and a claim
 * nobody checks is a claim nobody should believe, so it is checked at the
 * centimetre the prose names. Marked class DERIVED and sourced to §1, so nobody
 * later mistakes it for a published tolerance.
 */
export interface RecoveryGateSpec {
  id: string;
  metric: string;
  unit: string;
  max: number;
  klass: string;
  basis: string;
  value(r: ScenarioResult): number;
}

export const RECOVERY_GATES: RecoveryGateSpec[] = [
  {
    id: 'pose_position',
    metric: 'Pose recovery position error, worst projector, after gauge alignment',
    unit: 'mm',
    max: 2.0,
    klass: 'DERIVED',
    basis:
      'PARAMETERS.md §7, stated as 2 mm. Chosen so geometric error is dominated by other terms. Scored after removing the unobservable global rotation — see docs/AMENDMENTS.md A-09.',
    value: (r) => r.recovery?.aligned.maxPositionMm ?? NaN,
  },
  {
    id: 'pose_rotation',
    metric: 'Pose recovery rotation error, worst projector, after gauge alignment',
    unit: 'deg',
    max: 0.05,
    klass: 'DERIVED',
    basis: 'PARAMETERS.md §7. Scored after removing the unobservable global rotation.',
    value: (r) => r.recovery?.aligned.maxRotationDeg ?? NaN,
  },
  {
    id: 'h_center_recovery',
    metric: 'Floor-to-sphere-centre recovery error',
    unit: 'mm',
    max: 10.0,
    klass: 'DERIVED',
    basis:
      "NOT a §7 gate. PARAMETERS.md §1's note claims sub-centimetre h_center recovery is a concrete improvement over NOAA's add-or-subtract-an-inch loop; this holds that claim to the centimetre it names. The documented correction step is 25.4 mm.",
    value: (r) => r.recovery?.centerHeight.errorMm ?? NaN,
  },
];

function buildRecoveryGates(results: readonly ScenarioResult[]): GateSummary[] {
  const out: GateSummary[] = [];
  for (const spec of RECOVERY_GATES) {
    const values: number[] = [];
    const failed: string[] = [];
    let worst: { scenario: string; value: number } | null = null;
    for (const r of results) {
      const v = spec.value(r);
      values.push(v);
      if (!Number.isFinite(v) || v > spec.max) failed.push(r.scenario.id);
      if (Number.isFinite(v) && (worst === null || v > worst.value)) {
        worst = { scenario: r.scenario.id, value: v };
      }
    }
    const scored = values.filter((v) => Number.isFinite(v)).length;
    out.push({
      id: spec.id,
      metric: spec.metric,
      unit: spec.unit,
      max: spec.max,
      klass: spec.klass,
      phase: 'geometry',
      basis: spec.basis,
      pass: failed.length === 0,
      scenariosScored: scored,
      scenariosFailed: failed.length,
      failedScenarios: failed,
      worst,
      distribution: dispersion(values),
      scenariosNotMeasurable: [],
      dependsOnRecovery: true,
      attribution: null,
    });
  }
  return out;
}

function metricsById(set: MetricSet | null): Map<string, MetricResult> {
  const out = new Map<string, MetricResult>();
  if (set === null) return out;
  for (const m of set.metrics) out.set(m.id, m);
  return out;
}

export function buildGates(results: readonly ScenarioResult[]): GatesBlock {
  const gates: GateSummary[] = buildRecoveryGates(results);
  const unscored = new Map<string, string>();

  for (const gate of GATES) {
    if (gate.phase !== 'geometry') continue;
    // Pose recovery is scored above, against ground truth `sim/metrics` does
    // not hold: it measures a rig, and pose recovery compares two of them.
    if (gate.id === 'pose_position' || gate.id === 'pose_rotation') continue;
    const values: number[] = [];
    const failed: string[] = [];
    const notMeasurable: string[] = [];
    let scored = 0;
    let worst: { scenario: string; value: number } | null = null;
    for (const r of results) {
      const m = metricsById(r.metrics).get(gate.id);
      if (m === undefined) continue;
      if (!m.scored) {
        unscored.set(m.id, m.note);
        continue;
      }
      if (m.sampling.count === 0) {
        notMeasurable.push(r.scenario.id);
        continue;
      }
      scored++;
      values.push(m.value);
      if (m.pass === false) failed.push(r.scenario.id);
      if (worst === null || m.value > worst.value) {
        worst = { scenario: r.scenario.id, value: m.value };
      }
    }
    if (scored === 0 && values.length === 0 && notMeasurable.length === 0) continue;
    gates.push({
      id: gate.id,
      metric: gate.metric,
      unit: gate.unit,
      max: gate.max,
      klass: gate.klass,
      phase: gate.phase,
      basis: gate.basis,
      pass: failed.length === 0,
      scenariosScored: scored,
      scenariosFailed: failed.length,
      failedScenarios: failed,
      worst,
      distribution: dispersion(values),
      scenariosNotMeasurable: notMeasurable,
      dependsOnRecovery: RECOVERY_DEPENDENT.has(gate.id),
      attribution: null,
    });
  }

  // Metrics reported outside the GATES table — `sim/metrics/flux.ts` defines an
  // excess-above-floor gate of its own, per AMENDMENTS A-03 — are picked up
  // from whatever the scenarios actually produced rather than from the table.
  for (const r of results) {
    for (const m of r.metrics?.metrics ?? []) {
      if (!m.scored) unscored.set(m.id, m.note);
    }
  }
  const extraIds = new Set<string>();
  for (const r of results) {
    for (const m of r.metrics?.metrics ?? []) {
      if (m.scored && m.gate !== null && !gates.some((g) => g.id === m.id)) extraIds.add(m.id);
    }
  }
  for (const id of [...extraIds].sort()) {
    const values: number[] = [];
    const failed: string[] = [];
    const notMeasurable: string[] = [];
    let worst: { scenario: string; value: number } | null = null;
    let template: MetricResult | null = null;
    for (const r of results) {
      const m = metricsById(r.metrics).get(id);
      if (m === undefined || m.gate === null) continue;
      template = m;
      if (m.sampling.count === 0) {
        notMeasurable.push(r.scenario.id);
        continue;
      }
      values.push(m.value);
      if (m.pass === false) failed.push(r.scenario.id);
      if (worst === null || m.value > worst.value) worst = { scenario: r.scenario.id, value: m.value };
    }
    if (template === null || template.gate === null) continue;
    gates.push({
      id,
      metric: template.gate.metric,
      unit: template.gate.unit,
      max: template.gate.max,
      klass: template.gate.klass,
      phase: template.gate.phase,
      basis: template.gate.basis,
      pass: failed.length === 0,
      scenariosScored: values.length,
      scenariosFailed: failed.length,
      failedScenarios: failed,
      worst,
      distribution: dispersion(values),
      scenariosNotMeasurable: notMeasurable,
      dependsOnRecovery: RECOVERY_DEPENDENT.has(id),
      attribution: null,
    });
  }

  return {
    pass: gates.every((g) => g.pass),
    gates,
    unscored: [...unscored.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([id, reason]) => ({ id, reason })),
  };
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface EnvBlock {
  generatedAt: string;
  gitCommit: string;
  gitDirty: boolean;
  node: string;
  platform: string;
  cpus: number;
  durationMs: number;
  /** Per-scenario wall clock, in scenario order. Volatile, hence here. */
  scenarioDurationsMs: number[];
  /**
   * The command line, verbatim.
   *
   * In `env` rather than in `run`, and the reason is a bug this file's own
   * determinism check found. CI runs the bench twice with the same seed and
   * different `--out` filenames, so `argv` differs between two runs that
   * computed exactly the same thing — and a comparison that included it would
   * fail every time, forever, for a reason that has nothing to do with
   * determinism. `run` records what was COMPUTED (seed, scenario count, preset);
   * `env` records how the file came to exist. The output filename is the second
   * kind.
   */
  argv: string[];
}

export interface RunBlock {
  seed: number;
  scenarioCount: number;
  preset: string;
  conventions: string;
  parametersRev: string;
  outDir: string;
}

export interface ScenarioJson {
  index: number;
  id: string;
  archetype: string;
  question: string;
  seed: number;
  inputs: Record<string, unknown>;
  capture: Record<string, unknown>;
  solver: Record<string, unknown> | null;
  recovery: Record<string, unknown> | null;
  metrics: MetricResult[];
  metricsPass: boolean | null;
  /** The documented-calibration baseline: what the metrics read before solving. */
  baseline: { pass: boolean; metrics: MetricResult[] } | null;
  artifacts: Record<string, string> | null;
  error: string | null;
  timings: Record<string, number>;
}

export interface BenchResults {
  schema: typeof RESULTS_SCHEMA;
  volatile: string[];
  env: EnvBlock;
  run: RunBlock;
  gates: GatesBlock;
  aggregate: Record<string, Dispersion>;
  scenarios: ScenarioJson[];
  notes: string[];
}

function scenarioInputs(s: Scenario, r: ScenarioResult): Record<string, unknown> {
  return {
    projectorCount: s.projectorCount,
    slots: s.slots,
    distanceM: s.distanceM,
    projectorHeightM: s.projectorHeightM,
    centerHeightM: s.centerHeightM,
    projectorRes: { x: s.projectorResX, y: s.projectorResY },
    misalignmentScale: s.misalignmentScale,
    misalignmentMagnitudes: s.misalignment,
    // Exactly what was done to the rig, from `sim/scene.ts`. This is ground
    // truth the solver never saw, and printing it is what lets a reader check
    // that a recovery of 3 mm was recovering a 30 mm error rather than a 3 mm
    // one — the number is meaningless without the thing it was measured against.
    injected: {
      centerHeightMm: r.perturbation.centerHeightM * 1000,
      projectors: r.perturbation.projectors.map((p) => ({
        id: p.id,
        positionErrorMm: p.positionErrorM * 1000,
        azimuthDeg: p.azimuthDeg,
        yawDeg: p.yawDeg,
        pitchDeg: p.pitchDeg,
        rollDeg: p.rollDeg,
        fovHDeg: p.fovHDeg,
        shiftH: p.shiftH,
        shiftV: p.shiftV,
        k1: p.k1,
        k2: p.k2,
      })),
    },
    maskInterpretation: s.maskInterpretation,
    freeFov: s.freeFov,
    floorReferenceCount: s.floorReferenceCount,
    floorSigmaM: s.floorSigmaM,
    cameras: {
      count: s.cameras.count,
      distanceM: s.cameras.distanceM,
      heightM: s.cameras.heightM,
      res: { x: s.cameras.resX, y: s.cameras.resY },
      fovHDeg: s.cameras.fovHDeg,
      k1: s.cameras.k1,
      k2: s.cameras.k2,
      nominalPositionErrorM: s.cameraNominalPositionErrorM,
      nominalAngleErrorDeg: s.cameraNominalAngleErrorDeg,
    },
    degradation: {
      ambient: s.degradation.ambient,
      sensor: s.degradation.sensor,
      handheld: s.degradation.handheld,
      clock: s.degradation.clock,
    },
    pattern: { ...s.pattern, grayBits: r.patternBits },
    projectorPixelsPerCameraPixel: r.projPxPerCamPx,
  };
}

function scenarioJson(r: ScenarioResult): ScenarioJson {
  const s = r.scenario;
  const inputs = scenarioInputs(s, r);

  const capture: Record<string, unknown> = {
    framesRendered: r.capture.framesRendered,
    cameraPixelsTraced: r.capture.pixelsTraced,
    correspondences: r.capture.correspondences.length,
    decode: r.capture.stats,
    perPair: r.capture.perPair,
    motionExcursion: r.capture.motionExcursion,
  };

  const solver: Record<string, unknown> | null =
    r.solver === null
      ? null
      : {
          converged: r.solver.diagnostics.converged,
          stopReason: r.solver.extra.stopReason,
          iterations: r.solver.diagnostics.iterations,
          rmsResidualPx: r.solver.diagnostics.rmsResidualPx,
          perProjectorRmsPx: r.solver.diagnostics.perProjectorRmsPx,
          correspondencesUsed: r.solver.diagnostics.correspondencesUsed,
          correspondencesRejected: r.solver.diagnostics.correspondencesRejected,
          bootstrapDistanceM: r.solver.extra.bootstrapDistanceM,
          bootstrapProjectorSource: r.solver.extra.bootstrapProjectorSource,
          gaugeConstraints: r.solver.extra.gaugeConstraints,
          gaugeFreeAxes: r.solver.extra.gaugeFreeAxes,
          centerHeightObserved: r.solver.extra.centerHeightObserved,
          // Empty when no parameter prior was declared, which is the default.
          // Reported unconditionally so a reader can tell "no prior" from "a
          // prior that happened to sit at zero sigmas" — those are different
          // claims about where the answer came from.
          priorResiduals: r.solver.extra.priorResiduals,
          cameraResidualScale: r.solver.extra.cameraResidualScale,
          residuals: residualColumns(r.solver.diagnostics.residuals),
        };

  const recovery: Record<string, unknown> | null =
    r.recovery === null
      ? null
      : {
          preAlignment: {
            perProjector: r.recovery.raw.perProjector,
            maxPositionMm: r.recovery.raw.maxPositionMm,
            maxRotationDeg: r.recovery.raw.maxRotationDeg,
            rmsPositionMm: r.recovery.raw.rmsPositionMm,
            rmsRotationDeg: r.recovery.raw.rmsRotationDeg,
          },
          gauge: r.recovery.gauge,
          postAlignment: {
            perProjector: r.recovery.aligned.perProjector,
            maxPositionMm: r.recovery.aligned.maxPositionMm,
            maxRotationDeg: r.recovery.aligned.maxRotationDeg,
            rmsPositionMm: r.recovery.aligned.rmsPositionMm,
            rmsRotationDeg: r.recovery.aligned.rmsRotationDeg,
          },
          gates: {
            positionMaxM: 0.002,
            positionPass: r.recovery.aligned.maxPositionMm <= 2.0,
            rotationMaxDeg: 0.05,
            rotationPass: r.recovery.aligned.maxRotationDeg <= 0.05,
          },
          intrinsics: r.recovery.intrinsics,
          cameras: r.recovery.cameras,
          centerHeight: r.recovery.centerHeight,
        };

  return {
    index: s.index,
    id: s.id,
    archetype: s.archetype,
    question: s.question,
    seed: s.seed,
    inputs,
    capture,
    solver,
    recovery,
    metrics: r.metrics === null ? [] : r.metrics.metrics,
    metricsPass: r.metrics === null ? null : r.metrics.pass,
    baseline:
      r.baseline === null ? null : { pass: r.baseline.pass, metrics: r.baseline.metrics },
    artifacts: r.artifacts === null ? null : { ...r.artifacts },
    error: r.error,
    timings: { ...r.timings },
  };
}

/**
 * The aggregate block.
 *
 * Every series here is a per-scenario number, in scenario order, so a reader can
 * line up `aggregate.poseMaxPositionMm.values[3]` with `scenarios[3]`. Keeping
 * that correspondence is why nothing is filtered out: a scenario whose solve
 * threw contributes `NaN` rather than disappearing and silently shortening every
 * other series.
 */
export function buildAggregate(results: readonly ScenarioResult[]): Record<string, Dispersion> {
  const pick = (fn: (r: ScenarioResult) => number): Dispersion =>
    dispersion(results.map(fn));
  const metric = (id: string) => (r: ScenarioResult): number => {
    const m = r.metrics?.metrics.find((x) => x.id === id);
    return m === undefined ? NaN : m.value;
  };
  return {
    poseMaxPositionMmAligned: pick((r) => r.recovery?.aligned.maxPositionMm ?? NaN),
    poseMaxRotationDegAligned: pick((r) => r.recovery?.aligned.maxRotationDeg ?? NaN),
    poseMaxPositionMmRaw: pick((r) => r.recovery?.raw.maxPositionMm ?? NaN),
    poseMaxRotationDegRaw: pick((r) => r.recovery?.raw.maxRotationDeg ?? NaN),
    gaugeAngleDeg: pick((r) => r.recovery?.gauge.angleDeg ?? NaN),
    centerHeightErrorMm: pick((r) => r.recovery?.centerHeight.errorMm ?? NaN),
    fovErrorDeg: pick((r) => r.recovery?.intrinsics.maxFovHDeg ?? NaN),
    shiftError: pick((r) => r.recovery?.intrinsics.maxShift ?? NaN),
    k1Error: pick((r) => r.recovery?.intrinsics.maxK1 ?? NaN),
    k2Error: pick((r) => r.recovery?.intrinsics.maxK2 ?? NaN),
    cameraMaxPositionMm: pick((r) => r.recovery?.cameras.maxPositionMm ?? NaN),
    solverRmsResidualPx: pick((r) => r.solver?.diagnostics.rmsResidualPx ?? NaN),
    solverIterations: pick((r) => r.solver?.diagnostics.iterations ?? NaN),
    correspondences: pick((r) => r.capture.correspondences.length),
    gridDisplacementMm: pick(metric('grid_displacement')),
    gridDisplacementBaselineMm: pick((r) => {
      const m = r.baseline?.metrics.find((x) => x.id === 'grid_displacement');
      return m === undefined ? NaN : m.value;
    }),
    offSphereFluxExcess: pick(metric('off_sphere_flux_excess')),
    offSphereFluxAbsolute: pick(metric('off_sphere_flux')),
    unlitInMask: pick(metric('unlit_in_mask')),
    registrationRmsMm: pick((r) => r.metrics?.registration.overlap.rms ?? NaN),
    registrationMaxMm: pick((r) => r.metrics?.registration.overlap.max ?? NaN),
    // No timing series here. Wall clock belongs in `env`, which the determinism
    // check strips; a duration in `aggregate` would make every run differ and
    // the check would have to be widened to accommodate it — which is exactly
    // the erosion the two-copy volatile list exists to prevent. It was in this
    // block for about an hour, and the determinism test caught it.
  };
}

export interface AssembleInput {
  results: readonly ScenarioResult[];
  gates: GatesBlock;
  seed: number;
  preset: BenchPreset;
  outDir: string;
  env: EnvBlock;
}

export function assembleResults(input: AssembleInput): BenchResults {
  return {
    schema: RESULTS_SCHEMA,
    volatile: [...VOLATILE_PATHS],
    env: input.env,
    run: {
      seed: input.seed,
      scenarioCount: input.results.length,
      preset: input.preset.name,
      conventions: CONVENTIONS_VERSION,
      parametersRev: 'PARAMETERS.md rev 2',
      outDir: input.outDir,
    },
    gates: input.gates,
    aggregate: buildAggregate(input.results),
    scenarios: input.results.map(scenarioJson),
    notes: [
      'Pose recovery is scored AFTER removing the global rotation the solver could not observe (docs/AMENDMENTS.md A-09). Pre-alignment numbers are in scenarios[].recovery.preAlignment; the size of what was removed is in recovery.gauge.',
      'The gauge fit is restricted to the axes the solver reported as unobservable in gaugeFreeAxes. recovery.gauge.unconstrainedAngleDeg is the same fit with all three axes free, i.e. how much an unconstrained score would have absorbed.',
      'Grid-line displacement is gauge invariant: it compares two projectors\' copies of the same line, and a global rotation moves both together. The other geometric gates are properties of the physical rig and no solver can move them; gates[].dependsOnRecovery says which is which.',
      'Photometric metrics (seam luminance, seam chromaticity, black uplift) are NOT computed. PARAMETERS.md §10 and docs/ARCHITECTURE.md put them behind the ground-truth visit; every metric here sets provisional=false and means it.',
      'The camera model, the sensor noise model and the handheld motion model have no PARAMETERS.md section. Their constants are recorded in scenarios[].inputs rather than assumed, and they are class ASSUME in the spec\'s sense.',
      'Not modelled, each making a real capture harder than this one: projector depth of field (§3.3, §9), inter-reflection off the room (§9), the guard rail and its shadow (§9), and the projector\'s own pixel structure (§9).',
    ],
  };
}
