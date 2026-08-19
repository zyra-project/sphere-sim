/**
 * Experiment 4's sweep. Pure: it returns one object and writes nothing.
 *
 * It never assembles the forward model and the solver itself. It builds a bench
 * `Scenario` through `makeScenario`, overrides exactly the two things under test
 * — the room, and the decoder's modulation floor — and hands it to
 * `packages/bench/src/run.ts`. The first time this and the bench disagreed
 * nobody would be able to say which was right.
 */

import { DEFAULT_ROOM_SPILL, roomHit } from '../../../bench/src/capture.ts';
import { deriveSeed } from '../../../bench/src/random.ts';
import { PRESETS, makeScenario } from '../../../bench/src/scenarios.ts';
import { runScenario } from '../../../bench/src/run.ts';
import { raySphereIntersect } from '../../../sim/src/geometry.ts';
import { cameraPixelToRay } from '../../../bench/src/camera.ts';
import { buildWorld } from '../../../bench/src/run.ts';
import type { CellSpec } from './design.ts';
import {
  ARCHETYPE_INDEX,
  CEILING_M,
  CUTS,
  EXPERIMENT_ROOT_SEED,
  MIN_MODULATION,
  SEED_COUNT,
  WALL_RADII,
  buildDesign,
  cellKey,
  spillFor,
} from './design.ts';

/** Everything one (cell, seed) produced. */
export interface PointRun {
  wallRadiusM: number | null;
  minModulation: number;
  seedIndex: number;
  seed: number;
  /** Correspondences the decoder accepted. */
  correspondences: number;
  /**
   * How many of them came from a camera ray that never touched the sphere.
   *
   * Computed here, from ground truth, and used for NOTHING but the report — the
   * solver never sees it. It is the mechanism the pose error is being explained
   * by, and without it the finding is a correlation.
   */
  offSphere: number;
  offSphereFrac: number;
  /**
   * Which surface each off-sphere correspondence came from.
   *
   * The mechanism, in the data rather than in the prose. A modulation floor is a
   * BRIGHTNESS test, so it can only separate two populations that differ in
   * brightness — and the floor and the ceiling are nearer their projectors than
   * the far wall is, so they come back about as bright as the ball. Which
   * surface survives a given floor is therefore the whole answer to F4, and it
   * should not have to be re-derived by whoever reads the results file.
   */
  offSphereWall: number;
  offSphereFloor: number;
  offSphereCeiling: number;
  rejectedLowModulation: number;
  posePositionMm: number;
  poseRotationDeg: number;
  /** `null` when the solve threw or the metric came back NaN. */
  gridMm: number | null;
  seconds: number;
}

export interface Cell {
  wallRadiusM: number | null;
  minModulation: number;
  n: number;
  runs: PointRun[];
  /** Median, and the observed range over seeds. A mean would hide a bimodal failure. */
  posePositionMm: Dispersion;
  poseRotationDeg: Dispersion;
  offSphereFrac: Dispersion;
  correspondences: Dispersion;
  /** Totals over the cell's seeds: which surface the contamination came from. */
  offSphereBySurface: { wall: number; floor: number; ceiling: number };
  /** How many seeds produced a usable grid metric at all. */
  gridUsable: number;
}

export interface Dispersion {
  median: number;
  min: number;
  max: number;
  values: number[];
}

function dispersion(values: number[]): Dispersion {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? NaN
      : sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, min: sorted[0] ?? NaN, max: sorted[sorted.length - 1] ?? NaN, values };
}

export interface Verdict {
  /** F1: the condition changed the correspondence set at all. */
  isInert: boolean;
  /** F2: the pose error moved when the correspondence set did. */
  lossAbsorbsIt: boolean;
  /** F3: a tighter room cost at least as much as a wider one. */
  monotoneInRoomSize: boolean;
  /** F4: some swept floor recovered the solve to within 2x of the clean baseline. */
  aThresholdSeparatesThem: boolean;
  /** The floor that did it, or null. */
  separatingModulation: number | null;
  /** What that floor costs a capture with no room in it, as a ratio to 0.02. */
  costToACleanCapture: number | null;
  statement: string;
}

export interface SpillExperimentResult {
  schema: 'sphere-sim/experiment-4@1';
  provisional: false;
  provisionalNote: string;
  generatedFrom: {
    rootSeed: number;
    seedCount: number;
    archetypeIndex: number;
    preset: string;
    wallRadiiM: readonly (number | null)[];
    ceilingM: number;
    minModulation: readonly number[];
    defaultRoomSpill: { wallRadiusM: number; ceilingM: number };
  };
  cells: Cell[];
  cuts: typeof CUTS;
  verdict: Verdict;
}

export interface RunOptions {
  onProgress?: (message: string) => void;
  /**
   * Fewer seeds and a coarser grid. For TESTS ONLY — the published run uses the
   * module constants and there is no flag on the CLI that reaches this.
   */
  reduced?: { seedCount: number; cells: CellSpec[] };
}

function seedFor(index: number): number {
  return deriveSeed(EXPERIMENT_ROOT_SEED, `exp4-seed:${index}`);
}

/**
 * One cell, one seed. A pure function of `(spec, seedIndex)` — the same rig at
 * every level of every axis at a fixed seed, so a difference between two cells
 * is the axis and not the draw.
 */
export function runPoint(spec: CellSpec, seedIndex: number): PointRun {
  const t0 = Date.now();
  const preset = PRESETS.default;
  const seed = seedFor(seedIndex);
  const scenario = makeScenario(seed, ARCHETYPE_INDEX, preset);
  scenario.degradation.roomSpill = spillFor(spec);
  const result = runScenario(scenario, {
    preset,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
    decode: { minModulation: spec.minModulation },
  });

  // The mechanism, measured against ground truth and reported only. Rebuilding
  // the world is cheap and exactly reproducible; it is the same construction
  // `runScenario` made from the same scenario.
  const world = buildWorld(scenario);
  const radiusM = world.truthRig.sphere.radiusM;
  const spill = spillFor(spec);
  const floorZ = -world.truthRig.sphere.centerHeightM;
  let offSphere = 0;
  let offWall = 0;
  let offFloor = 0;
  let offCeiling = 0;
  for (const c of result.capture.correspondences) {
    const cam = world.cameras[c.camera];
    const dir = cameraPixelToRay(cam, c.camU, c.camV);
    if (raySphereIntersect(cam.pose.position, dir, radiusM) !== null) continue;
    offSphere++;
    if (spill === null) continue;
    const p = roomHit(cam.pose.position, dir, spill, floorZ);
    if (p === null) continue;
    if (Math.abs(p.z - floorZ) < 1e-6) offFloor++;
    else if (Math.abs(p.z - (floorZ + spill.ceilingM)) < 1e-6) offCeiling++;
    else offWall++;
  }

  const n = result.capture.correspondences.length;
  const grid = result.metrics?.grid.metric.value;
  return {
    wallRadiusM: spec.wallRadiusM,
    minModulation: spec.minModulation,
    seedIndex,
    seed,
    correspondences: n,
    offSphere,
    offSphereFrac: n === 0 ? 0 : offSphere / n,
    offSphereWall: offWall,
    offSphereFloor: offFloor,
    offSphereCeiling: offCeiling,
    rejectedLowModulation: result.capture.stats.rejectedLowModulation,
    posePositionMm: result.recovery?.aligned.maxPositionMm ?? NaN,
    poseRotationDeg: result.recovery?.aligned.maxRotationDeg ?? NaN,
    gridMm: grid !== undefined && Number.isFinite(grid) ? grid : null,
    seconds: (Date.now() - t0) / 1000,
  };
}

const BASELINE_MODULATION = 0.02;

/** The cell every other cell is compared against: no room, the shipped floor. */
function baselineOf(cells: Cell[]): Cell | undefined {
  return cells.find((c) => c.wallRadiusM === null && c.minModulation === BASELINE_MODULATION);
}

/**
 * The verdict, computed from the cells rather than written by a human. It
 * evaluates exactly the four falsifiers `design.ts` states, in that order.
 */
export function judge(cells: Cell[]): Verdict {
  const base = baselineOf(cells);
  const spiltAtDefault = cells.find(
    (c) => c.wallRadiusM === DEFAULT_ROOM_SPILL.wallRadiusM && c.minModulation === BASELINE_MODULATION,
  );
  if (!base || !spiltAtDefault) {
    return {
      isInert: false,
      lossAbsorbsIt: false,
      monotoneInRoomSize: false,
      aThresholdSeparatesThem: false,
      separatingModulation: null,
      costToACleanCapture: null,
      statement: 'The grid did not contain the cells the verdict is defined against.',
    };
  }

  // F1: did the condition change the correspondence set at all?
  const isInert = spiltAtDefault.offSphereFrac.median <= 0;

  // F2: did the pose error move with it? "Absorbed" is within 2x of the clean
  // baseline, which is the same tolerance F4 uses for recovery.
  const ratio = spiltAtDefault.posePositionMm.median / base.posePositionMm.median;
  const lossAbsorbsIt = !isInert && ratio < 2;

  // F3: a tighter room must not help. Compared at the shipped floor.
  const byRoom = cells
    .filter((c) => c.minModulation === BASELINE_MODULATION && c.wallRadiusM !== null)
    .sort((a, b) => (b.wallRadiusM ?? 0) - (a.wallRadiusM ?? 0));
  let monotoneInRoomSize = true;
  for (let i = 1; i < byRoom.length; i++) {
    // Tighter rooms come later and must be at least as bad as the one before.
    // Compared on the MEDIAN with no tolerance: the seed-to-seed range here
    // spans four orders of magnitude, so any tolerance drawn from it would
    // accept everything and the criterion would be decorative.
    if (byRoom[i].posePositionMm.median < byRoom[i - 1].posePositionMm.median) {
      monotoneInRoomSize = false;
    }
  }

  // F4: is there a floor that recovers the solve with the room present?
  const atDefaultRoom = cells
    .filter((c) => c.wallRadiusM === DEFAULT_ROOM_SPILL.wallRadiusM)
    .sort((a, b) => a.minModulation - b.minModulation);
  const recovered = atDefaultRoom.find(
    (c) => c.posePositionMm.median < 2 * base.posePositionMm.median,
  );
  const separatingModulation =
    recovered && recovered.minModulation > BASELINE_MODULATION ? recovered.minModulation : null;
  const cleanAtThatFloor =
    separatingModulation === null
      ? undefined
      : cells.find((c) => c.wallRadiusM === null && c.minModulation === separatingModulation);
  const costToACleanCapture =
    cleanAtThatFloor === undefined
      ? null
      : cleanAtThatFloor.posePositionMm.median / base.posePositionMm.median;

  const statement = isInert
    ? 'The room is inert: no correspondence came from off the sphere, so this condition changes ' +
      'nothing and should be deleted rather than shipped.'
    : lossAbsorbsIt
      ? `The room puts ${(spiltAtDefault.offSphereFrac.median * 100).toFixed(1)}% of the ` +
        'accepted correspondences off the sphere and the solver absorbs them: recovered pose ' +
        `moved from ${base.posePositionMm.median.toFixed(1)} mm to ` +
        `${spiltAtDefault.posePositionMm.median.toFixed(1)} mm. That is a robustness property, ` +
        'not a warning.'
      : `The room puts ${(spiltAtDefault.offSphereFrac.median * 100).toFixed(1)}% of the ` +
        'accepted correspondences off the sphere, and that is enough to destroy the solve: ' +
        `recovered pose goes from ${base.posePositionMm.median.toFixed(1)} mm to ` +
        `${spiltAtDefault.posePositionMm.median.toFixed(0)} mm, a factor of ` +
        `${ratio.toFixed(0)}. ` +
        (separatingModulation === null
          ? 'No modulation floor in the sweep separated the room from the sphere. A floor is a ' +
            'brightness test, and what survives the high floors is not the far wall but the ' +
            'FLOOR and the CEILING, which are nearer their projectors than the sphere is and come ' +
            'back at least as bright — so the two populations do not differ in the quantity the ' +
            'threshold measures. This pipeline needs segmentation, not a tuned threshold.'
          : `Raising the decoder's modulation floor from ${BASELINE_MODULATION} to ` +
            `${separatingModulation} recovers it, and costs a capture with no room in it a ` +
            `factor of ${(costToACleanCapture ?? NaN).toFixed(2)} on the same measure.`);

  return {
    isInert,
    lossAbsorbsIt,
    monotoneInRoomSize,
    aThresholdSeparatesThem: separatingModulation !== null,
    separatingModulation,
    costToACleanCapture,
    statement,
  };
}

export function runSpillExperiment(options: RunOptions = {}): SpillExperimentResult {
  const specs = options.reduced?.cells ?? buildDesign();
  const seedCount = options.reduced?.seedCount ?? SEED_COUNT;
  const report = options.onProgress ?? ((): void => {});

  const cells: Cell[] = [];
  let done = 0;
  const total = specs.length * seedCount;
  for (const spec of specs) {
    const runs: PointRun[] = [];
    for (let s = 0; s < seedCount; s++) {
      runs.push(runPoint(spec, s));
      done++;
      report(`${done}/${total}  ${cellKey(spec)}  seed ${s}`);
    }
    cells.push({
      wallRadiusM: spec.wallRadiusM,
      minModulation: spec.minModulation,
      n: runs.length,
      runs,
      posePositionMm: dispersion(runs.map((r) => r.posePositionMm)),
      poseRotationDeg: dispersion(runs.map((r) => r.poseRotationDeg)),
      offSphereFrac: dispersion(runs.map((r) => r.offSphereFrac)),
      correspondences: dispersion(runs.map((r) => r.correspondences)),
      offSphereBySurface: {
        wall: runs.reduce((a, r) => a + r.offSphereWall, 0),
        floor: runs.reduce((a, r) => a + r.offSphereFloor, 0),
        ceiling: runs.reduce((a, r) => a + r.offSphereCeiling, 0),
      },
      gridUsable: runs.filter((r) => r.gridMm !== null).length,
    });
  }

  return {
    schema: 'sphere-sim/experiment-4@1',
    provisional: false,
    provisionalNote:
      'Purely geometric. The measurement is a recovered pose against ground truth, and no ' +
      'photometric constant enters it — the room’s two constants decide where light lands, not ' +
      'how bright the answer is. The Phase 2 gate does not apply.',
    generatedFrom: {
      rootSeed: EXPERIMENT_ROOT_SEED,
      seedCount,
      archetypeIndex: ARCHETYPE_INDEX,
      preset: 'default',
      wallRadiiM: options.reduced ? [...new Set(specs.map((s) => s.wallRadiusM))] : WALL_RADII,
      ceilingM: CEILING_M,
      minModulation: options.reduced
        ? [...new Set(specs.map((s) => s.minModulation))]
        : MIN_MODULATION,
      defaultRoomSpill: { ...DEFAULT_ROOM_SPILL },
    },
    cells,
    cuts: CUTS,
    verdict: judge(cells),
  };
}
