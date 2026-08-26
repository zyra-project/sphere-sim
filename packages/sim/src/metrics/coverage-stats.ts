// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The coverage summary: who lights what, how many at once, how obliquely, and
 * how much of each pole nobody reaches.
 *
 * Not a gate — a description. But it is the description that makes every other
 * geometric metric readable. A registration RMS of 3 mm means one thing if the
 * overlap is a broad well-lit band and another entirely if the overlap has
 * shrunk to a sliver at grazing incidence, and only this report distinguishes
 * them.
 *
 * ## The multiplicity assertion
 *
 * PARAMETERS.md §4.2 exists to correct rev 1 of the spec, which claimed overlap
 * goes 2-way then 3-way then 4-way toward the poles. It does not. Three-way
 * overlap needs a point within `acos(R/d)` = 80.4 degrees of three of the four
 * equatorial directions, and any three of the four contain an antipodal pair —
 * which would need `2 * 80.4 >= 180`. It is not close: 160.8 against 180, with
 * nineteen degrees to spare, so the conclusion survives the +/-2 degree mount
 * tolerance of §2 and the whole 5.0-6.5 m `d_proj` prior with room left over.
 *
 * So a multiplicity of 3 is not a rig that needs reporting, it is arithmetic
 * that has stopped working — and every area-weighted number downstream is then
 * meaningless. This module throws rather than reporting it, because a metric set
 * that quietly carries on after its own geometry has failed is worse than no
 * metric set. `assertMultiplicity: false` is available for anyone deliberately
 * exploring a pathological rig.
 *
 * ## Incidence, and why the distribution rather than a mean
 *
 * §4.3 puts the practically usable limit at `cos(incidence) < 0.2`, "where
 * resolution smear exceeds 5x and the image becomes streaks". That is a
 * threshold, not an average, and the interesting question is what FRACTION of
 * the sphere is past it — which is what justifies the bottom mask at all
 * (§4.4: the mask hides the degenerate grazing region, it does not suppress
 * overlap brightness, because §4.2 shows there is no pile-up to suppress).
 */

import type { RigCalibration } from '../../../calibration/src/index.ts';
import { latLonToWorld } from '../geometry.ts';
import type { Vec3 } from '../vec.ts';
import type { PreparedRig } from '../optics.ts';
import { prepareRig } from '../optics.ts';
import type { MaskInterpretation } from '../coverage.ts';
import {
  coverageBoundaryLatitude,
  incidenceCosineAt,
  isIlluminatedAt,
  polarMask,
  unlitPolarAreaFraction,
  usableLatitude,
} from '../coverage.ts';
import { createScalarField } from './types.ts';
import type { ConvergenceReport, CountField, SamplingReport, ScalarField } from './types.ts';
import { convergenceOf } from './types.ts';
import type { Stats } from './sampling.ts';
import { densityPair, equalAreaLattice, latticeWeightSr, percentile, summarise } from './sampling.ts';

export interface CoverageStatsOptions {
  sampleCount?: number;
  /** Longitudes used for the polar-area integral and the boundary profile. */
  boundarySamples?: number;
  fieldWidth?: number;
  fieldHeight?: number;
  /** Throw on a multiplicity above 2. Default true — see the module note. */
  assertMultiplicity?: boolean;
  convergence?: boolean;
}

export interface CoverageStatsReport {
  /**
   * Area fraction of the sphere at each overlap multiplicity, indexed by count.
   * Entry 0 is unlit, 1 is single-projector, 2 is the seams. Entries above 2
   * must be zero — PARAMETERS.md §4.2.
   */
  multiplicityAreaFraction: number[];
  maxMultiplicity: number;
  /** Distribution of the best available `cos(incidence)` over LIT points. */
  incidence: Stats;
  /** Area-weighted quantiles of `cos(incidence)` over lit points. */
  incidenceQuantiles: { p05: number; p25: number; p50: number; p75: number; p95: number };
  /** Lit area fraction whose best incidence is below §4.3's 0.2 usability line. */
  belowUsableIncidenceFraction: number;
  /** §4.3's unlit polar region, integrated over its true scalloped boundary. */
  unlitPolarAreaFractionNorth: number;
  unlitPolarAreaFractionSouth: number;
  /** Coverage boundary latitude per longitude, north then south. Degrees. */
  boundaryLatitudeNorthDeg: number[];
  boundaryLatitudeSouthDeg: number[];
  /** §4.3's usable limits along a projector meridian and in a seam, degrees. */
  usableLatitudeMeridianDeg: number;
  usableLatitudeSeamDeg: number;
  /** Field maps for the progress page. */
  incidenceField: ScalarField;
  multiplicityField: CountField;
  sampling: SamplingReport;
}

interface CoverageCore {
  multiplicityCounts: number[];
  incidences: number[];
  belowUsable: number;
  lit: number;
  maxMultiplicity: number;
}

/**
 * How many projectors light one point, and the best incidence among them.
 *
 * One definition, used by both the scalar statistic and the field it is drawn
 * against. They were two copies of this loop, which is the drift this metric set
 * exists to surface: a change to what "lit" or "best incidence" means had to
 * land in both or the number and the picture would quietly stop agreeing.
 */
function pointStats(
  point: Vec3,
  normal: Vec3,
  projectors: PreparedRig['projectors'],
): { multiplicity: number; bestIncidence: number } {
  let multiplicity = 0;
  let bestIncidence = 0;
  for (const p of projectors) {
    if (!isIlluminatedAt(point, p)) continue;
    multiplicity++;
    const c = incidenceCosineAt(point, normal, p.lens);
    if (c > bestIncidence) bestIncidence = c;
  }
  return { multiplicity, bestIncidence };
}

function coverageOver(rig: PreparedRig, count: number): CoverageCore {
  const lattice = equalAreaLattice(count);
  const n = rig.projectors.length;
  const multiplicityCounts = new Array<number>(n + 1).fill(0);
  const incidences: number[] = [];
  let belowUsable = 0;
  let lit = 0;
  let maxMultiplicity = 0;

  for (const s of lattice) {
    const point = latLonToWorld(s.latDeg, s.lonDeg, rig.radiusM);
    const { multiplicity: m, bestIncidence: best } = pointStats(point, s.unit, rig.projectors);
    multiplicityCounts[m]++;
    if (m > maxMultiplicity) maxMultiplicity = m;
    if (m > 0) {
      lit++;
      incidences.push(best);
      // §4.3: below cos(incidence) = 0.2 "resolution smear exceeds 5x and the
      // image becomes streaks".
      if (best < 0.2) belowUsable++;
    }
  }
  return { multiplicityCounts, incidences, belowUsable, lit, maxMultiplicity };
}

/** Equirectangular maps of incidence and multiplicity, for the progress page. */
function coverageFields(
  rig: PreparedRig,
  width: number,
  height: number,
  maskInterpretation: MaskInterpretation,
): { incidenceField: ScalarField; multiplicityField: CountField } {
  const incidenceField = createScalarField(width, height, NaN);
  const multiplicityField: CountField = { width, height, data: new Uint8Array(width * height) };
  const invR = 1 / rig.radiusM;
  for (let y = 0; y < height; y++) {
    const latDeg = 90 - ((y + 0.5) / height) * 180;
    for (let x = 0; x < width; x++) {
      const lonDeg = -180 + ((x + 0.5) / width) * 360;
      const idx = y * width + x;
      const point = latLonToWorld(latDeg, lonDeg, rig.radiusM);
      const normal = { x: point.x * invR, y: point.y * invR, z: point.z * invR };
      const { multiplicity: m, bestIncidence: best } = pointStats(point, normal, rig.projectors);
      multiplicityField.data[idx] = m;
      // The mask is carried into the map so a reader is not misled into thinking
      // a grazing-incidence south polar band is a problem; it is hidden.
      if (m > 0) incidenceField.data[idx] = best * polarMask(latDeg, rig.blend, maskInterpretation);
    }
  }
  return { incidenceField, multiplicityField };
}

export function computeCoverageStats(
  physicalRig: RigCalibration,
  maskInterpretation: MaskInterpretation,
  options: CoverageStatsOptions = {},
  densityScale = 1,
): CoverageStatsReport {
  const rig = prepareRig(physicalRig);
  const { fine, coarse } = densityPair(options.sampleCount ?? 20000, densityScale);
  const boundarySamples = Math.max(36, Math.round((options.boundarySamples ?? 360) * densityScale));
  const assertMultiplicity = options.assertMultiplicity ?? true;
  const wantConvergence = options.convergence ?? true;

  const core = coverageOver(rig, fine);

  if (assertMultiplicity && core.maxMultiplicity > 2) {
    const at = core.multiplicityCounts
      .map((c, i) => `${i}-way: ${c}`)
      .join(', ');
    throw new Error(
      `overlap multiplicity reached ${core.maxMultiplicity} (${at}). PARAMETERS.md §4.2 states ` +
        `it is 1 or 2 everywhere and never more: three-way overlap would need a point within ` +
        `acos(R/d) = 80.4 deg of three equatorial directions 90 deg apart, and any three of the ` +
        `four contain an antipodal pair. If this fires, the geometry is broken and every ` +
        `area-weighted number in this metric set is meaningless. Pass ` +
        `\`assertMultiplicity: false\` only to explore a deliberately pathological rig.`,
    );
  }

  const multiplicityAreaFraction = core.multiplicityCounts.map((c) => c / fine);
  const sortedIncidence = core.incidences.slice().sort((a, b) => a - b);

  let convergence: ConvergenceReport | null = null;
  if (wantConvergence) {
    const coarseCore = coverageOver(rig, coarse);
    convergence = convergenceOf(
      multiplicityAreaFraction[0],
      coarseCore.multiplicityCounts[0] / coarse,
      coarse,
      // A tenth of a percent of the sphere. The unlit fraction is around 1.8%
      // (both poles), so this bounds the discretisation well inside the digit
      // §4.3 and A-05 argue about.
      0.001,
    );
  }

  const { incidenceField, multiplicityField } = coverageFields(
    rig,
    options.fieldWidth ?? 360,
    options.fieldHeight ?? 180,
    maskInterpretation,
  );

  const boundaryLatitudeNorthDeg: number[] = [];
  const boundaryLatitudeSouthDeg: number[] = [];
  for (let i = 0; i < boundarySamples; i++) {
    const lon = -180 + (360 * i) / boundarySamples;
    boundaryLatitudeNorthDeg.push(coverageBoundaryLatitude(lon, rig, 1));
    boundaryLatitudeSouthDeg.push(coverageBoundaryLatitude(lon, rig, -1));
  }

  const sampling: SamplingReport = {
    scheme: 'fibonacci-equal-area',
    description:
      `${fine}-point Fibonacci lattice, each point standing for ` +
      `${latticeWeightSr(fine).toExponential(3)} sr, so every fraction here is area-weighted with ` +
      `no weight array. The polar area figures do NOT come from this lattice: they integrate the ` +
      `bisected coverage boundary over ${boundarySamples} longitudes, which resolves the scalloped ` +
      `lobe of §4.3 far better than any practical point sampling of a 0.9%-of-the-sphere region.`,
    count: fine,
    densityPerSr: fine / (4 * Math.PI),
    convergence,
  };

  return {
    multiplicityAreaFraction,
    maxMultiplicity: core.maxMultiplicity,
    incidence: summarise(core.incidences),
    incidenceQuantiles: {
      p05: percentile(sortedIncidence, 0.05),
      p25: percentile(sortedIncidence, 0.25),
      p50: percentile(sortedIncidence, 0.5),
      p75: percentile(sortedIncidence, 0.75),
      p95: percentile(sortedIncidence, 0.95),
    },
    belowUsableIncidenceFraction: core.lit > 0 ? core.belowUsable / core.lit : NaN,
    unlitPolarAreaFractionNorth: unlitPolarAreaFraction(rig, boundarySamples, 1),
    unlitPolarAreaFractionSouth: unlitPolarAreaFraction(rig, boundarySamples, -1),
    boundaryLatitudeNorthDeg,
    boundaryLatitudeSouthDeg,
    usableLatitudeMeridianDeg: usableLatitude(0, rig, 0.2, 1),
    usableLatitudeSeamDeg: usableLatitude(45, rig, 0.2, 1),
    incidenceField,
    multiplicityField,
    sampling,
  };
}
