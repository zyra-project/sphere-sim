/**
 * One point of Experiment 1: one design cell at one seed.
 *
 * ## Why this calls the bench rather than reimplementing it
 *
 * `packages/bench/src/run.ts:runScenario` is the path `bench-results.json` is
 * produced by — build the rig, perturb it, photograph it through
 * `packages/sim`'s physics, decode and solve it with `packages/solver`, score
 * the two against each other. An experiment that assembled those pieces itself
 * would be a second pipeline, and the first time it disagreed with the bench
 * nobody would be able to say which one was right. So this module builds a
 * `Scenario`, overrides exactly the axis under test, and hands it to the bench.
 *
 * The consequence worth stating: every number this experiment reports is
 * directly comparable to the corresponding number in `bench-results.json`, and
 * a change to the bench moves both together.
 *
 * ## Pairing
 *
 * `makeScenario` draws the rig — `d_proj`, projector heights, the camera stand
 * distance and height — before the archetype's own overrides run, and those
 * draws do not depend on anything this module changes. So at a fixed seed every
 * level of every axis is the SAME rig photographed under a different condition,
 * which is the only kind of comparison that measures a knob rather than a
 * scenario. `test/experiment1.test.ts` pins that.
 */

import { PARAMETER_TABLE } from '../../../calibration/src/parameters.ts';
import { DEFAULT_CLOCK, DEFAULT_HANDHELD } from '../../../bench/src/camera.ts';
import { DEFAULT_SENSOR } from '../../../bench/src/capture.ts';
import { deriveSeed } from '../../../bench/src/random.ts';
import type { Scenario } from '../../../bench/src/scenarios.ts';
import { makeScenario } from '../../../bench/src/scenarios.ts';
import { buildWorld, runScenario } from '../../../bench/src/run.ts';
import type { PointSpec } from './design.ts';
import { EXPERIMENT_ROOT_SEED, experimentPreset } from './design.ts';

/** The scenario seed for replicate `i`. A pure function of the design's root. */
export function seedFor(seedIndex: number): number {
  return deriveSeed(EXPERIMENT_ROOT_SEED, `exp1-seed:${seedIndex}`);
}

/**
 * The base scenario every point starts from: the bench's `nominal` archetype.
 *
 * Archetype index 1. PARAMETERS.md §2 mount tolerances, four projectors, §5
 * nominal ambient, a real sensor, a tripod, four floor references at the 3 mm a
 * tape measure justifies, `fov_h` free per §3.1's SOLVE class.
 */
export const BASE_ARCHETYPE_INDEX = 1;

export function scenarioFor(spec: PointSpec, seedIndex: number): Scenario {
  const preset = experimentPreset(spec.maxCorrespondencesPerPair);
  const s = makeScenario(seedFor(seedIndex), BASE_ARCHETYPE_INDEX, preset);

  s.cameras.count = spec.cameraCount;
  s.cameras.resX = spec.resX;
  s.cameras.resY = spec.resY;

  s.floorSigmaM = spec.floorSigmaM;
  s.floorReferenceCount = Math.min(spec.floorReferenceCount, s.projectorCount);

  s.degradation.ambient = spec.degradation.ambient;
  s.degradation.sensor = spec.degradation.sensorNoise ? { ...DEFAULT_SENSOR } : null;
  s.degradation.handheld = spec.degradation.motion ? { ...DEFAULT_HANDHELD } : null;
  s.degradation.clock = { ...DEFAULT_CLOCK, rollingShutter: spec.degradation.rollingShutter };

  s.id = `exp1-${spec.figure}-${spec.series.replace(/[^a-z0-9]+/gi, '_')}-${spec.level.replace(/[^a-z0-9]+/gi, '_')}-s${seedIndex}`;
  s.archetype = `exp1:${spec.axis}`;
  s.question = `Experiment 1, axis ${spec.axis}, series ${spec.series}, level ${spec.level}.`;
  return s;
}

/** Everything one point produces. Deliberately flat: this is what gets plotted. */
export interface PointRun {
  key: string;
  figure: string;
  axis: string;
  series: string;
  level: string;
  x: number;
  seedIndex: number;
  seed: number;

  cameraCount: number;
  resX: number;
  resY: number;
  floorSigmaM: number;
  floorReferenceCount: number;
  ambient: number;
  sensorNoise: boolean;
  motion: boolean;
  rollingShutter: boolean;
  maxCorrespondencesPerPair: number;

  /** null when the solve threw. Everything else is then NaN. */
  error: string | null;

  // --- the gate-facing numbers, identical in definition to bench/results.ts ---
  /** §7: <= 2 mm. Worst projector, after gauge alignment (A-09). */
  posePositionMm: number;
  /** §7: <= 0.05 deg. Worst projector, after gauge alignment. */
  poseRotationDeg: number;
  /** §7: <= 1.0 mm on the sphere surface. NaN where there is no seam to measure. */
  gridDisplacementMm: number;
  /** §1's note holds this to the centimetre it claims. */
  hCenterErrorMm: number;

  // --- diagnostics a reader needs to interpret the above ---
  poseRmsPositionMm: number;
  poseRawPositionMm: number;
  /** Recovered field of view minus truth, worst projector. A-18's causal chain. */
  fovErrorDeg: number;
  rmsResidualPx: number;
  correspondencesUsed: number;
  correspondencesDecoded: number;
  decodeAccepted: number;
  decodeConsidered: number;
  converged: boolean;
  stopReason: string;
  /** True where the floor references made rig tilt observable. */
  centerHeightObserved: boolean;
  gaugeAngleDeg: number;
  gaugeUnconstrainedAngleDeg: number;
  /** Handheld excursion over the sequence, worst camera. 0 with a tripod. */
  motionTranslationMm: number;
  motionRotationDeg: number;
  wallClockMs: number;

  // --- ground truth kept for A-18's subtense check ------------------------
  /** True horizontal field of view of projector 1, degrees. */
  truthFovHDeg: number;
  /** True sphere-centre-to-lens distance for projector 1, metres. */
  truthDistanceM: number;
  /**
   * Position error the measured field-of-view error predicts, in millimetres.
   *
   * docs/AMENDMENTS.md A-18 step 3: a long-throw lens sees the sphere subtend
   * about 19 degrees, so field of view and distance trade against each other
   * almost exactly and a field-of-view error becomes a RADIAL position error
   * through `delta_d / d = delta_fov / (2 tan(fov/2))`. A-18 measured that on
   * three scenarios and two seeds. Recording it per point turns it into a
   * prediction this experiment tests on every point of every axis — and a
   * prediction that holds across a hundred and ninety-seven solves is a
   * mechanism rather than a coincidence.
   *
   * Both terms are worst-projector maxima and can in principle land on
   * different projectors, so agreement is expected to be good rather than
   * exact.
   */
  fovSubtensePredictedMm: number;
}

function metricValue(
  metrics: { metrics: { id: string; value: number }[] } | null,
  id: string,
): number {
  if (metrics === null) return Number.NaN;
  const m = metrics.metrics.find((x) => x.id === id);
  return m === undefined ? Number.NaN : m.value;
}

export function runPoint(spec: PointSpec, seedIndex: number, repoRoot: string): PointRun {
  const scenario = scenarioFor(spec, seedIndex);
  const t0 = Date.now();
  const r = runScenario(scenario, {
    preset: experimentPreset(spec.maxCorrespondencesPerPair),
    outDir: repoRoot,
    repoRoot,
    // No PNGs: this experiment's deliverable is a curve, and a hundred and
    // eighty room views nobody will open is a hundred and eighty seconds.
    writeArtifacts: false,
    // No documented-calibration baseline either: the experiment compares
    // recovered against truth, and the "before" picture is the bench's job.
    baseline: false,
  });
  const wallClockMs = Date.now() - t0;

  const rec = r.recovery;
  const motion = r.capture.motionExcursion;

  // Ground truth for the subtense check. `buildWorld` is a pure function of the
  // scenario and costs tens of milliseconds — no render, no solve — so rebuilding
  // it is cheaper and safer than threading the world out of `runScenario` and
  // relying on nothing downstream having mutated it.
  const world = buildWorld(scenario);
  const p0 = world.truthRig.projectors[0];
  const truthFovHDeg = p0.intrinsics.fovHDeg;
  const truthDistanceM = Math.hypot(
    p0.pose.position.x,
    p0.pose.position.y,
    p0.pose.position.z,
  );
  const fovErrDeg = rec?.intrinsics.maxFovHDeg ?? Number.NaN;
  const halfFovRad = (truthFovHDeg * Math.PI) / 360;
  const fovSubtensePredictedMm =
    (truthDistanceM * ((fovErrDeg * Math.PI) / 180) * 1000) / (2 * Math.tan(halfFovRad));

  return {
    key: `${spec.figure}|${spec.series}|${spec.level}|${seedIndex}`,
    figure: spec.figure,
    axis: spec.axis,
    series: spec.series,
    level: spec.level,
    x: spec.x,
    seedIndex,
    seed: scenario.seed,

    cameraCount: spec.cameraCount,
    resX: spec.resX,
    resY: spec.resY,
    floorSigmaM: spec.floorSigmaM,
    floorReferenceCount: scenario.floorReferenceCount,
    ambient: spec.degradation.ambient,
    sensorNoise: spec.degradation.sensorNoise,
    motion: spec.degradation.motion,
    rollingShutter: spec.degradation.rollingShutter,
    maxCorrespondencesPerPair: spec.maxCorrespondencesPerPair,

    error: r.error,

    posePositionMm: rec?.aligned.maxPositionMm ?? Number.NaN,
    poseRotationDeg: rec?.aligned.maxRotationDeg ?? Number.NaN,
    gridDisplacementMm: metricValue(r.metrics, 'grid_displacement'),
    hCenterErrorMm: rec?.centerHeight.errorMm ?? Number.NaN,

    poseRmsPositionMm: rec?.aligned.rmsPositionMm ?? Number.NaN,
    poseRawPositionMm: rec?.raw.maxPositionMm ?? Number.NaN,
    fovErrorDeg: rec?.intrinsics.maxFovHDeg ?? Number.NaN,
    rmsResidualPx: r.solver?.diagnostics.rmsResidualPx ?? Number.NaN,
    correspondencesUsed: r.solver?.diagnostics.correspondencesUsed ?? 0,
    correspondencesDecoded: r.capture.correspondences.length,
    decodeAccepted: r.capture.stats.accepted,
    decodeConsidered: r.capture.stats.considered,
    converged: r.solver?.diagnostics.converged ?? false,
    stopReason: r.solver?.extra.stopReason ?? 'threw',
    centerHeightObserved: r.solver?.extra.centerHeightObserved ?? false,
    gaugeAngleDeg: rec?.gauge.angleDeg ?? Number.NaN,
    gaugeUnconstrainedAngleDeg: rec?.gauge.unconstrainedAngleDeg ?? Number.NaN,
    motionTranslationMm: motion.reduce((a, m) => Math.max(a, m.translationMm), 0),
    motionRotationDeg: motion.reduce((a, m) => Math.max(a, m.rotationDeg), 0),
    wallClockMs,

    truthFovHDeg,
    truthDistanceM,
    fovSubtensePredictedMm,
  };
}
