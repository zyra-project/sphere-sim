// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The Experiment 1 results file: the raw numbers a reader checks the plots
 * against.
 *
 * packages/bench/README.md's three rules for a results file apply here without
 * modification, because they are rules about honesty rather than about the
 * bench:
 *
 *  - **A mean hides a bimodal failure.** Every cell carries median, mean, sd,
 *    min, max, quartiles AND every seed's own value.
 *  - **A pass rate hides which gate failed.** Every cell carries the §7 gate
 *    beside the measurement, and the derived block states pass/fail per gate
 *    rather than one verdict.
 *  - **A number with no provenance is an assertion.** Every cell carries the
 *    full input state — what was varied and what was held — so no plotted point
 *    depends on a caption to be interpretable.
 *
 * The file also carries `runs`: every (point, seed) individually. The aggregates
 * are derived from it and can be recomputed by a reader who disagrees with the
 * choice of median.
 */

import type { PointRun } from './point.ts';
import type { Dispersion } from './stats.ts';
import { disperse } from './stats.ts';

export const EXPERIMENT_SCHEMA = 'sphere-sim/experiment-1@1';

/**
 * The numeric fields aggregated per cell.
 *
 * `gate` is PARAMETERS.md §7's limit where one exists and null otherwise. It
 * lives here rather than in the plot so that the JSON and the SVG cannot
 * disagree about what the threshold is.
 */
export const TRACKED_FIELDS: {
  key: keyof PointRun;
  label: string;
  unit: string;
  gate: number | null;
  gateSource: string | null;
  lowerIsBetter: boolean;
}[] = [
  {
    key: 'posePositionMm',
    label: 'Pose position error, worst projector, gauge-aligned',
    unit: 'mm',
    gate: 2.0,
    gateSource: 'PARAMETERS.md §7',
    lowerIsBetter: true,
  },
  {
    key: 'poseRotationDeg',
    label: 'Pose rotation error, worst projector, gauge-aligned',
    unit: 'deg',
    gate: 0.05,
    gateSource: 'PARAMETERS.md §7',
    lowerIsBetter: true,
  },
  {
    key: 'gridDisplacementMm',
    label: 'Grid-line displacement across a blend region',
    unit: 'mm on sphere surface',
    gate: 1.0,
    gateSource: 'PARAMETERS.md §7',
    lowerIsBetter: true,
  },
  {
    key: 'hCenterErrorMm',
    label: 'Floor-to-sphere-centre recovery error',
    unit: 'mm',
    gate: 10.0,
    gateSource: "Not §7. PARAMETERS.md §1's sub-centimetre claim, held to the centimetre it names.",
    lowerIsBetter: true,
  },
  {
    key: 'fovErrorDeg',
    label: 'Recovered field of view minus truth, worst projector',
    unit: 'deg',
    gate: null,
    gateSource: null,
    lowerIsBetter: true,
  },
  {
    key: 'rmsResidualPx',
    label: 'RMS reprojection residual',
    unit: 'projector px',
    gate: null,
    gateSource: null,
    lowerIsBetter: true,
  },
  {
    key: 'poseRawPositionMm',
    label: 'Pose position error before gauge alignment',
    unit: 'mm',
    gate: null,
    gateSource: null,
    lowerIsBetter: true,
  },
  {
    key: 'correspondencesUsed',
    label: 'Correspondences used by the bundle',
    unit: 'count',
    gate: null,
    gateSource: null,
    lowerIsBetter: false,
  },
  {
    key: 'motionTranslationMm',
    label: 'Camera excursion over the sequence, worst camera',
    unit: 'mm',
    gate: null,
    gateSource: null,
    lowerIsBetter: false,
  },
  {
    key: 'fovSubtensePredictedMm',
    label: 'Position error predicted from the field-of-view error alone (A-18 subtense relation)',
    unit: 'mm',
    gate: null,
    gateSource: null,
    lowerIsBetter: true,
  },
  {
    key: 'gaugeUnconstrainedAngleDeg',
    label: 'Rotation an unconstrained gauge fit would have absorbed',
    unit: 'deg',
    gate: null,
    gateSource: null,
    lowerIsBetter: true,
  },
];

export interface Cell {
  figure: string;
  axis: string;
  series: string;
  level: string;
  x: number;
  n: number;
  seeds: number[];
  /** Everything held for this cell. A plotted point with no inputs is a rumour. */
  inputs: {
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
  };
  metrics: Record<string, Dispersion>;
  /** Seeds whose solve threw, by index. Empty in a healthy run. */
  failedSeeds: number[];
  /** Median wall clock, seconds. Reported so the budget claim is checkable. */
  medianSeconds: number;
}

export function aggregate(runs: readonly PointRun[]): Cell[] {
  const byCell = new Map<string, PointRun[]>();
  for (const r of runs) {
    const k = `${r.figure}|${r.series}|${r.level}`;
    const list = byCell.get(k);
    if (list === undefined) byCell.set(k, [r]);
    else list.push(r);
  }
  const cells: Cell[] = [];
  for (const [, list] of byCell) {
    const sorted = [...list].sort((a, b) => a.seedIndex - b.seedIndex);
    const first = sorted[0];
    const metrics: Record<string, Dispersion> = {};
    for (const f of TRACKED_FIELDS) {
      metrics[f.key as string] = disperse(sorted.map((r) => Number(r[f.key])));
    }
    cells.push({
      figure: first.figure,
      axis: first.axis,
      series: first.series,
      level: first.level,
      x: first.x,
      n: sorted.length,
      seeds: sorted.map((r) => r.seed),
      inputs: {
        cameraCount: first.cameraCount,
        resX: first.resX,
        resY: first.resY,
        floorSigmaM: first.floorSigmaM,
        floorReferenceCount: first.floorReferenceCount,
        ambient: first.ambient,
        sensorNoise: first.sensorNoise,
        motion: first.motion,
        rollingShutter: first.rollingShutter,
        maxCorrespondencesPerPair: first.maxCorrespondencesPerPair,
      },
      metrics,
      failedSeeds: sorted.filter((r) => r.error !== null).map((r) => r.seedIndex),
      medianSeconds:
        disperse(sorted.map((r) => r.wallClockMs)).median / 1000,
    });
  }
  // Stable order: figure, then series, then x. Key order in a results file is
  // part of the file — `tools/assert-deterministic.ts` compares it.
  cells.sort(
    (a, b) =>
      a.figure.localeCompare(b.figure) ||
      a.series.localeCompare(b.series) ||
      a.x - b.x ||
      a.level.localeCompare(b.level),
  );
  return cells;
}

export function findCell(
  cells: readonly Cell[],
  figure: string,
  series: string,
  level: string,
): Cell | undefined {
  return cells.find((c) => c.figure === figure && c.series === series && c.level === level);
}

export function seriesOf(cells: readonly Cell[], figure: string, series: string): Cell[] {
  return cells.filter((c) => c.figure === figure && c.series === series).sort((a, b) => a.x - b.x);
}
