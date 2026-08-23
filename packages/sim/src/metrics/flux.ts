/**
 * Off-sphere flux — the Red Ball equivalent. What fraction of what each
 * projector emits misses the sphere and lands on the room.
 *
 * ## Read docs/AMENDMENTS.md A-01 and A-03 before touching the gate
 *
 * PARAMETERS.md §7 gates this at 52% against a floor it puts at "~51% from
 * raster geometry", i.e. a **one percentage point** budget for misaim. That is a
 * well-chosen gate if the floor is right for the hardware, and unpassable if it
 * is not:
 *
 *   - The Red Ball procedure masks each projector's content to the sphere's
 *     silhouette from its own position. A circle inscribed in a rectangle leaves
 *     `1 - (pi/4)*(minor/major)` of the raster dark-but-thrown: **50.9% at
 *     16:10, 55.8% at 16:9, 41.1% at 4:3**.
 *   - §7's "~51%" matches 16:10 almost exactly and matches nothing about 16:9.
 *     A-01 takes that as evidence the figure was computed for a 16:10 projector.
 *   - So on a 16:9 raster the floor ALONE is 55.8% and the 52% gate can never
 *     pass, no matter how well aligned the rig is. That is A-03.
 *
 * This module therefore reports three numbers and scores the third:
 *
 *   1. `absoluteFraction`   — what the rig actually throws past the sphere.
 *   2. `aspectFloor`        — A-01's tabulated floor for the raster's aspect
 *                             ratio, the number §7's 52% was set against.
 *   3. `configuredFloor`    — the floor a PERFECTLY AIMED projector with these
 *                             exact intrinsics and this exact lens distance
 *                             would achieve.
 *
 * The scored quantity is `absoluteFraction - configuredFloor`, against A-03's
 * proposed restatement of the gate: "off-sphere flux <= analytic raster floor +
 * 1.0 percentage point". That preserves §7's intent (catch gross misaim) and is
 * invariant to the projector's aspect ratio.
 *
 * ## Why `configuredFloor` and not just `aspectFloor`
 *
 * `intrinsicsFromThrow` inscribes the silhouette in the raster's minor dimension
 * with a 2% margin, because a silhouette on the exact raster edge makes the
 * coverage test and the raster test disagree at the last ulp and coverage grows
 * a ragged fringe (see `optics.ts`). That margin shrinks the lit circle by 2% in
 * radius and therefore by 3.9% in area — **1.7 percentage points of off-sphere
 * flux, more than the entire 1-point misaim budget**, from a construction
 * detail that has nothing to do with alignment. Scoring against `aspectFloor`
 * would spend the whole budget on that margin and report every correctly-built
 * rig as failing. `configuredFloor` folds the margin (and any lens zoom error)
 * in, so the excess is misaim and only misaim.
 *
 * ## How the measurement is done
 *
 * Not by Monte Carlo. The silhouette of a sphere in a pinhole raster is a convex
 * region, so for each raster row the set of columns that hit the sphere is an
 * interval, and both endpoints can be found by bisection to machine precision.
 * Summing exact row spans converges far faster than sampling an area, which
 * matters when the gate's whole budget is one percentage point: a 512x288
 * stratified sample would carry several tenths of a point of boundary error on
 * its own.
 *
 * The convexity assumption is checked, not assumed — a row whose coarse scan
 * shows more than one run of hits is counted in `nonConvexRows`, and a nonzero
 * count is reported rather than swallowed.
 */

import type { ProjectorIntrinsics, RigCalibration } from '../../../calibration/src/index.ts';
import { raySphereIntersect } from '../geometry.ts';
import type { PreparedProjector } from '../optics.ts';
import { analyticOffSphereFloor, pixelToRay, prepareRig } from '../optics.ts';
import { dot } from '../vec.ts';
import type { ConvergenceReport, MetricGate, MetricResult, SamplingReport } from './types.ts';
import { convergenceOf, makeMetric } from './types.ts';

export interface FluxOptions {
  /** Raster rows scanned per projector. */
  rowSamples?: number;
  /** Columns in the coarse hit-finding scan that seeds each row's bisection. */
  coarseColumns?: number;
  /** Grid size for the secondary solid-angle-weighted reading. */
  solidAngleGrid?: number;
  convergence?: boolean;
}

export interface ProjectorFlux {
  id: string;
  index: number;
  /** Fraction of raster AREA whose ray misses the sphere. */
  absoluteFraction: number;
  /** The same weighted by per-pixel solid angle. Diagnostic — see the note. */
  solidAngleFraction: number;
  /** A-01's tabulated floor from the aspect ratio alone. */
  aspectFloor: number;
  /** The floor this projector's own intrinsics and distance imply. */
  configuredFloor: number;
  /** `absoluteFraction - configuredFloor`. Negative means better than the floor. */
  excessAboveConfiguredFloor: number;
  /** False when the silhouette does not fit inside the raster. */
  silhouetteFitsRaster: boolean;
  /** Rows whose hit set was not a single run. Should be zero. */
  nonConvexRows: number;
  /** Angular radius of the sphere's silhouette from this lens, degrees. */
  silhouetteRadiusDeg: number;
}

export interface FluxReport {
  perProjector: ProjectorFlux[];
  /** Mean over projectors — each emits the same total flux. */
  absoluteFraction: number;
  solidAngleFraction: number;
  aspectFloor: number;
  configuredFloor: number;
  excessAboveConfiguredFloor: number;
  /** The scored metric (excess) and the reference metric (absolute). */
  metric: MetricResult;
  absoluteMetric: MetricResult;
  sampling: SamplingReport;
}

/**
 * A-03's proposed restatement of the §7 gate, synthesised here rather than added
 * to `GATES`.
 *
 * `packages/calibration/src/parameters.ts` is a transcription of PARAMETERS.md,
 * and PARAMETERS.md does not contain this gate — A-03 *proposes* it and its
 * status is OPEN. Writing it into the transcription would be editing the spec by
 * the back door. So it lives here, labelled, next to the code that uses it.
 */
export const OFF_SPHERE_EXCESS_GATE: MetricGate = {
  id: 'off_sphere_flux_excess',
  metric: 'Off-sphere flux above the analytic raster floor',
  max: 0.01,
  unit: 'fraction (percentage points / 100)',
  klass: 'DERIVED',
  phase: 'geometry',
  basis:
    'docs/AMENDMENTS.md A-03, PROPOSED not published: restate §7 as "off-sphere flux <= analytic ' +
    'raster floor + 1.0 percentage point". Preserves §7\'s 1-point budget for misaim while being ' +
    "invariant to the projector's aspect ratio, which §7's absolute 52% is not.",
};

function hits(proj: PreparedProjector, u: number, v: number, radiusM: number): boolean {
  return raySphereIntersect(proj.lens, pixelToRay(proj, u, v), radiusM) !== null;
}

/** Bisect between a known miss and a known hit; returns the boundary column. */
function edgeBetween(
  proj: PreparedProjector,
  v: number,
  radiusM: number,
  uMiss: number,
  uHit: number,
): number {
  let lo = uMiss;
  let hi = uHit;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (hits(proj, mid, v, radiusM)) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/** Lit span of one raster row, in pixels, or `0` when the row misses entirely. */
function rowLitWidth(
  proj: PreparedProjector,
  v: number,
  radiusM: number,
  coarse: number,
): { width: number; contiguous: boolean } {
  const resX = proj.cal.intrinsics.resX;
  const flags = new Uint8Array(coarse);
  let first = -1;
  let last = -1;
  for (let k = 0; k < coarse; k++) {
    const u = ((k + 0.5) / coarse) * resX;
    if (hits(proj, u, v, radiusM)) {
      flags[k] = 1;
      if (first < 0) first = k;
      last = k;
    }
  }
  if (first < 0) return { width: 0, contiguous: true };

  let runs = 0;
  for (let k = 0; k < coarse; k++) if (flags[k] === 1 && (k === 0 || flags[k - 1] === 0)) runs++;

  const uAt = (k: number): number => ((k + 0.5) / coarse) * resX;
  // Left edge. If the first coarse hit is the leftmost sample the silhouette may
  // run off the raster, so the raster edge itself has to be tested.
  const left =
    first === 0
      ? hits(proj, 0, v, radiusM)
        ? 0
        : edgeBetween(proj, v, radiusM, 0, uAt(0))
      : edgeBetween(proj, v, radiusM, uAt(first - 1), uAt(first));
  // `edgeBetween` maintains "lo is a miss, hi is a hit" and so works with the
  // miss on either side of the hit; the right edge just passes them the other
  // way round.
  const right =
    last === coarse - 1
      ? hits(proj, resX, v, radiusM)
        ? resX
        : edgeBetween(proj, v, radiusM, resX, uAt(last))
      : edgeBetween(proj, v, radiusM, uAt(last + 1), uAt(last));

  return { width: Math.max(0, right - left), contiguous: runs === 1 };
}

/** Fraction of one projector's raster AREA that misses the sphere. */
function offSphereByRasterArea(
  proj: PreparedProjector,
  radiusM: number,
  rows: number,
  coarse: number,
): { fraction: number; nonConvexRows: number } {
  const it = proj.cal.intrinsics;
  let lit = 0;
  let nonConvexRows = 0;
  for (let r = 0; r < rows; r++) {
    const v = ((r + 0.5) / rows) * it.resY;
    const row = rowLitWidth(proj, v, radiusM, coarse);
    if (!row.contiguous) nonConvexRows++;
    lit += row.width / it.resX;
  }
  return { fraction: 1 - lit / rows, nonConvexRows };
}

/**
 * The same fraction weighted by per-pixel solid angle rather than raster area.
 *
 * A pinhole with a flat image plane spreads `cos^3(theta)` less solid angle per
 * unit raster area toward the corners, so raster area and emitted flux are not
 * the same weighting. Across this rig's 34-degree horizontal field the two
 * differ by about 1.4x corner to centre, which is not negligible — but the
 * documented floor of §7 and A-01 is an AREA ratio, so the area reading is the
 * one the gate is stated against and the one that gets scored. This is reported
 * beside it so nobody has to wonder whether the difference was considered.
 *
 * A plain grid, not row bisection: this is a diagnostic and half a percent of
 * boundary error is immaterial to it.
 */
function offSphereBySolidAngle(proj: PreparedProjector, radiusM: number, grid: number): number {
  const it = proj.cal.intrinsics;
  const cols = grid;
  const rows = Math.max(1, Math.round((grid * it.resY) / it.resX));
  let total = 0;
  let missed = 0;
  for (let r = 0; r < rows; r++) {
    const v = ((r + 0.5) / rows) * it.resY;
    for (let c = 0; c < cols; c++) {
      const u = ((c + 0.5) / cols) * it.resX;
      const ray = pixelToRay(proj, u, v);
      const cos = dot(ray, proj.axis);
      const w = cos > 0 ? cos * cos * cos : 0;
      total += w;
      if (raySphereIntersect(proj.lens, ray, radiusM) === null) missed += w;
    }
  }
  return total > 0 ? missed / total : NaN;
}

/**
 * The floor this projector's own configuration implies, assuming perfect aim.
 *
 * The silhouette of a sphere at angular radius `sigma = asin(R/d)` seen down the
 * optical axis is the circle `x^2 + y^2 = tan^2(sigma)` in the normalized image
 * coordinates of conventions.ts §I, which maps to an ellipse of semi-axes
 * `fx*tan(sigma)` by `fy*tan(sigma)` pixels. Its area over the raster's is the
 * lit fraction.
 *
 * Reduces to A-01's `1 - (pi/4)*(minor/major)` exactly when the silhouette is
 * inscribed with no margin, which is the identity `test/metrics.test.ts` checks.
 */
export function configuredOffSphereFloor(
  it: ProjectorIntrinsics,
  distanceM: number,
  radiusM: number,
): { floor: number; fits: boolean; sigmaDeg: number } {
  const sigma = Math.asin(Math.min(1, distanceM > 0 ? radiusM / distanceM : 1));
  const fx = it.resX / 2 / Math.tan(((it.fovHDeg * Math.PI) / 180) / 2);
  const fy = fx * it.pixelAspect;
  const a = fx * Math.tan(sigma);
  const b = fy * Math.tan(sigma);
  const litFraction = Math.min(1, (Math.PI * a * b) / (it.resX * it.resY));
  const cx = it.resX / 2 + it.shiftH * (it.resX / 2);
  const cy = it.resY / 2 - it.shiftV * (it.resY / 2);
  const fits = a <= Math.min(cx, it.resX - cx) && b <= Math.min(cy, it.resY - cy);
  return { floor: 1 - litFraction, fits, sigmaDeg: (sigma * 180) / Math.PI };
}

export function computeOffSphereFlux(
  physicalRig: RigCalibration,
  absoluteGate: MetricGate,
  options: FluxOptions = {},
  densityScale = 1,
): FluxReport {
  const rig = prepareRig(physicalRig);
  const rows = Math.max(8, Math.round((options.rowSamples ?? 540) * densityScale));
  const coarse = options.coarseColumns ?? 256;
  const solidGrid = Math.max(16, Math.round((options.solidAngleGrid ?? 128) * densityScale));
  const wantConvergence = options.convergence ?? true;

  const perProjector: ProjectorFlux[] = rig.projectors.map((p) => {
    const it = p.cal.intrinsics;
    const area = offSphereByRasterArea(p, rig.radiusM, rows, coarse);
    const cfg = configuredOffSphereFloor(it, p.distanceM, rig.radiusM);
    return {
      id: p.cal.id,
      index: p.index,
      absoluteFraction: area.fraction,
      solidAngleFraction: offSphereBySolidAngle(p, rig.radiusM, solidGrid),
      aspectFloor: analyticOffSphereFloor(it.resX / it.resY),
      configuredFloor: cfg.floor,
      excessAboveConfiguredFloor: area.fraction - cfg.floor,
      silhouetteFitsRaster: cfg.fits,
      nonConvexRows: area.nonConvexRows,
      silhouetteRadiusDeg: cfg.sigmaDeg,
    };
  });

  const n = Math.max(1, perProjector.length);
  const mean = (pick: (p: ProjectorFlux) => number): number =>
    perProjector.reduce((acc, p) => acc + pick(p), 0) / n;

  const absoluteFraction = mean((p) => p.absoluteFraction);
  const configuredFloor = mean((p) => p.configuredFloor);
  const aspectFloor = mean((p) => p.aspectFloor);
  const solidAngleFraction = mean((p) => p.solidAngleFraction);
  const excess = absoluteFraction - configuredFloor;

  let convergence: ConvergenceReport | null = null;
  if (wantConvergence) {
    const coarseRows = Math.max(8, Math.round(rows / 4));
    const coarseAbs =
      rig.projectors.reduce(
        (acc, p) => acc + offSphereByRasterArea(p, rig.radiusM, coarseRows, coarse).fraction,
        0,
      ) / n;
    // A tenth of the one-point misaim budget.
    convergence = convergenceOf(excess, coarseAbs - configuredFloor, coarseRows, 0.001);
  }

  const nonConvex = perProjector.reduce((acc, p) => acc + p.nonConvexRows, 0);
  const sampling: SamplingReport = {
    scheme: 'raster-row-bisection',
    description:
      `${rows} raster rows per projector; each row's lit span found by a ${coarse}-column coarse ` +
      `scan followed by 50-step bisection on both edges, so the span is exact to machine ` +
      `precision and only the row quadrature contributes error. Solid-angle reading from a ` +
      `${solidGrid}-column grid. ${nonConvex} row(s) had a non-contiguous hit set (expected 0: the ` +
      `silhouette of a sphere in a pinhole raster is convex).`,
    count: rows * rig.projectors.length,
    densityPerSr: null,
    convergence,
  };

  const detail: Record<string, number> = {
    absoluteFraction,
    aspectFloorFromAmendmentA01: aspectFloor,
    configuredFloor,
    solidAngleWeightedFraction: solidAngleFraction,
    documentedGate: absoluteGate.max,
    nonConvexRows: nonConvex,
  };

  const metric = makeMetric({
    id: 'off_sphere_flux_excess',
    label: 'Off-sphere flux above the analytic raster floor',
    value: excess,
    unit: 'fraction of emitted raster area',
    gate: OFF_SPHERE_EXCESS_GATE,
    scored: true,
    note:
      'THE SCORED READING. Two numbers describe off-sphere flux and only one of them is about ' +
      `alignment. The rig throws ${(absoluteFraction * 100).toFixed(2)}% of each projector's raster ` +
      `past the sphere; ${(configuredFloor * 100).toFixed(2)}% of that is the geometric floor for a ` +
      'perfectly-aimed projector with these intrinsics, because the Red Ball procedure masks ' +
      'content to a circular silhouette inscribed in a rectangular raster. The excess is what ' +
      'misaim costs. Scoring the absolute figure instead would grade the projector\'s aspect ratio: ' +
      "A-01 shows §7's ~51% floor matches a 16:10 raster and that at 16:9 the floor ALONE is 55.8%, " +
      'so the published 52% gate is unpassable there regardless of alignment quality (A-03). The ' +
      'gate applied here is A-03\'s PROPOSED restatement and is not published in PARAMETERS.md.',
    sampling,
    detail: { ...detail, excessPercentagePoints: excess * 100 },
  });

  const absoluteMetric = makeMetric({
    id: 'off_sphere_flux',
    label: 'Off-sphere flux, absolute (Red Ball equivalent)',
    value: absoluteFraction,
    unit: 'fraction of emitted raster area',
    gate: absoluteGate,
    // Unscored on purpose. See the note; A-03 is the whole argument.
    scored: false,
    note:
      'REFERENCE ONLY, NOT SCORED. This is the figure §7 states its 52% gate against, reported so ' +
      'the published gate is visible. It is confounded by the raster aspect ratio: the analytic ' +
      `floor for this raster is ${(aspectFloor * 100).toFixed(1)}% before any margin, versus §7's ` +
      "assumed ~51%. Read the excess metric for the alignment answer. Do not read a failure here " +
      'as misaim without checking `off_sphere_flux_excess` first — see docs/AMENDMENTS.md A-01 ' +
      'and A-03.',
    sampling,
    detail,
  });

  return {
    perProjector,
    absoluteFraction,
    solidAngleFraction,
    aspectFloor,
    configuredFloor,
    excessAboveConfiguredFloor: excess,
    metric,
    absoluteMetric,
    sampling,
  };
}
