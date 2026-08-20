/**
 * Experiment 5's runner. The verdict is computed, never written by hand.
 *
 * Every comparison here is PAIRED. `seedFor` in the spill runner depends only on
 * the seed index, so arm `image` seed 7 and arm `geometric` seed 7 are the same
 * rig draw, and the difference between them is the segmentation and nothing
 * else. Experiment 4 had that property and threw it away by dividing medians;
 * this does not.
 */

import type { Cell, PointRun } from '../spill/run.ts';
import { paired, runPoint } from '../spill/run.ts';
import type { Paired } from '../spill/run.ts';
import {
  ARCHETYPE_INDEX,
  ARMS,
  CUTS,
  EXPERIMENT_ROOT_SEED,
  SEED_COUNT,
  WALL_RADIUS_M,
} from './design.ts';

function dispersion(values: number[]): { median: number; min: number; max: number; values: number[] } {
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

/** Aggregate one arm's per-seed runs into a cell. */
export function assemble(runs: PointRun[]): Cell {
  const first = runs[0];
  return {
    wallRadiusM: first.wallRadiusM,
    minModulation: first.minModulation,
    segmentMarginFrac: first.segmentMarginFrac,
    n: runs.length,
    runs,
    posePositionMm: dispersion(runs.map((r) => r.posePositionMm)),
    poseRotationDeg: dispersion(runs.map((r) => r.poseRotationDeg)),
    offSphereFrac: dispersion(runs.map((r) => r.offSphereFrac)),
    correspondences: dispersion(runs.map((r) => r.correspondences)),
    offSphereBySurface: {
      wall: runs.reduce((s, r) => s + r.offSphereWall, 0),
      floor: runs.reduce((s, r) => s + r.offSphereFloor, 0),
      ceiling: runs.reduce((s, r) => s + r.offSphereCeiling, 0),
    },
    gridUsable: runs.filter((r) => r.gridMm !== null).length,
  };
}

export interface SegmentationVerdict {
  /** G1: image-space did NOT reduce contamination below the geometric test. */
  noContaminationGain: boolean;
  geometricOffSphereFrac: number;
  imageOffSphereFrac: number;
  /** G2: image-space did NOT beat the geometric test on pose, paired. */
  noPoseGain: boolean;
  imageOverGeometric: Paired | null;
  /** G3: image-space cost a clean capture more than the baseline's own spread. */
  costsACleanCapture: boolean;
  cleanCostFactor: number;
  /** G4: the detector's framing assumption failed somewhere. */
  assumptionFailed: boolean;
  silhouetteFailures: number;
  /** G5: the win is not consistently signed over the seeds. */
  notConsistentlySigned: boolean;
  /** What each segmentation buys against the unsegmented room, paired. */
  geometricVsRoom: Paired | null;
  imageVsRoom: Paired | null;
  statement: string;
}

export function judgeSegmentation(cells: Record<string, Cell>): SegmentationVerdict {
  const clean = cells.clean;
  const room = cells.room;
  const geometric = cells.geometric;
  const image = cells.image;
  const imageClean = cells['image-clean'];
  const usable = clean.posePositionMm.max;

  const geometricOffSphereFrac = geometric.offSphereFrac.median;
  const imageOffSphereFrac = image.offSphereFrac.median;
  const noContaminationGain = !(imageOffSphereFrac < geometricOffSphereFrac);

  const imageOverGeometric = paired(geometric, image, usable);
  const noPoseGain = !(imageOverGeometric.geometricMean > 1);

  // "Costs a clean capture" means worse than the baseline's own worst seed, the
  // same data-defined bar experiment 4 uses. A constant would be a constant with
  // no provenance.
  const cleanCostFactor = imageClean.posePositionMm.median / clean.posePositionMm.median;
  const costsACleanCapture = imageClean.posePositionMm.median > usable;

  const silhouetteFailures = [...image.runs, ...imageClean.runs].reduce(
    (s, r) => s + r.silhouetteFailures,
    0,
  );
  const assumptionFailed = silhouetteFailures > 0;

  const notConsistentlySigned = imageOverGeometric.improved <= imageOverGeometric.n / 2;

  const geometricVsRoom = paired(room, geometric, usable);
  const imageVsRoom = paired(room, image, usable);

  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
  const statement =
    `Against the same ${imageOverGeometric.n} rig draws, image-space segmentation leaves ` +
    `${pct(imageOffSphereFrac)} of accepted correspondences off the sphere where the geometric ` +
    `test leaves ${pct(geometricOffSphereFrac)}. Paired against the unsegmented room it is worth ` +
    `a geometric mean of ${(imageVsRoom.geometricMean ?? NaN).toFixed(1)}, against ` +
    `${(geometricVsRoom.geometricMean ?? NaN).toFixed(1)} for the geometric test; head to head it ` +
    `is ${imageOverGeometric.geometricMean.toFixed(2)} and it wins on ` +
    `${imageOverGeometric.improved} of ${imageOverGeometric.n} seeds. Solves no worse than the ` +
    `worst clean solve go from ${imageVsRoom.usableBefore} to ${imageVsRoom.usableAfter} of ` +
    `${imageVsRoom.n}. On a capture with no room in it it costs a factor of ` +
    `${cleanCostFactor.toFixed(2)}. The detector's framing assumption failed on ` +
    `${silhouetteFailures} capture(s).`;

  return {
    noContaminationGain,
    geometricOffSphereFrac,
    imageOffSphereFrac,
    noPoseGain,
    imageOverGeometric,
    costsACleanCapture,
    cleanCostFactor,
    assumptionFailed,
    silhouetteFailures,
    notConsistentlySigned,
    geometricVsRoom,
    imageVsRoom,
    statement,
  };
}

export interface SegmentationResult {
  schema: 'sphere-sim/experiment-5@1';
  provisional: false;
  provisionalNote: string;
  generatedFrom: {
    rootSeed: number;
    seedCount: number;
    archetypeIndex: number;
    wallRadiusM: number;
    arms: { key: string; label: string }[];
  };
  cells: Record<string, Cell>;
  cuts: typeof CUTS;
  verdict: SegmentationVerdict;
}

/** Wrap assembled cells into the published result. Shared with the CLI. */
export function buildResult(cells: Record<string, Cell>, seedCount: number = SEED_COUNT): SegmentationResult {
  return {
    schema: 'sphere-sim/experiment-5@1',
    provisional: false,
    provisionalNote:
      'The pose metric is geometric, so the Phase 2 gate does not apply to it. As in experiment 4, ' +
      'how much contamination exists at all is scaled by rho_room (PARAMETERS.md, 0.3, class ' +
      'ASSUME) — but note that this experiment COMPARES two segmentations against the same ' +
      'contamination, so rho_room moves both arms together and the comparison is far less ' +
      'sensitive to it than experiment 4 was.',
    generatedFrom: {
      rootSeed: EXPERIMENT_ROOT_SEED,
      seedCount,
      archetypeIndex: ARCHETYPE_INDEX,
      wallRadiusM: WALL_RADIUS_M,
      arms: ARMS.map((a) => ({ key: a.key, label: a.label })),
    },
    cells,
    cuts: CUTS,
    verdict: judgeSegmentation(cells),
  };
}

export function runSegmentationExperiment(
  onProgress?: (done: number, total: number, label: string) => void,
  seedCount: number = SEED_COUNT,
): SegmentationResult {
  const cells: Record<string, Cell> = {};
  const total = ARMS.length * seedCount;
  let done = 0;
  for (const arm of ARMS) {
    const runs: PointRun[] = [];
    for (let i = 0; i < seedCount; i++) {
      runs.push(runPoint(arm.spec, i));
      done++;
      onProgress?.(done, total, `${arm.key} seed ${i}`);
    }
    cells[arm.key] = assemble(runs);
  }
  return buildResult(cells, seedCount);
}
