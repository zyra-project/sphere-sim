// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Registration error: how far apart two projectors put the same texel, measured
 * in millimetres of arc along the sphere surface.
 *
 * ## What creates a registration error at all
 *
 * Nothing in the forward model, run against itself, can misregister. Every
 * projector traces its pixels through the real geometry and paints the
 * physically correct texel at every physically correct point, so two projectors
 * agree exactly wherever they overlap. That is not a limitation of the tracer —
 * it is what "the rig is what the software thinks it is" means.
 *
 * Real misregistration is a disagreement between TWO calibrations:
 *
 *   - the CONTENT calibration, which the compositor uses to decide what each
 *     projector pixel should show. In a real SOS install this is whatever the
 *     alignment procedure last wrote to the config; on the bench it is the
 *     nominal rig, or a rig the solver recovered.
 *   - the PHYSICAL calibration, which is where the lenses actually are.
 *
 * So the measurement is: the compositor decides, using the content calibration,
 * that projector `i`'s pixel `(u, v)` carries texel `T`. Physics then puts that
 * pixel somewhere on the sphere, using the physical calibration. Call that point
 * `Q_i(T)`. Projector `j` independently lands the same texel at `Q_j(T)`. The
 * registration error at `T` is the geodesic distance between them.
 *
 * With content == physical, `Q_i(T)` is the point with coordinates `T` for every
 * `i`, and the error is zero to floating-point. That is the aligned case, and
 * `test/metrics.test.ts` pins it.
 *
 * ## Millimetres of arc, not degrees
 *
 * PARAMETERS.md §7's gate is 1.0 mm on the sphere surface, justified as about
 * one arcminute at 2.5 m viewing distance. A displacement expressed in degrees
 * of latitude means a different physical distance at every latitude and a
 * different number again on a sphere of a different diameter, so it cannot be
 * compared against that gate. Everything here is `R * angle`, in millimetres.
 *
 * ## Why the error map matters as much as the number
 *
 * A single RMS says whether the rig is acceptable. It does not say whether the
 * error is a uniform blur (which reads as softness) or a hard displacement
 * concentrated in one seam near a pole (which reads as the doubled grid lines
 * PARAMETERS.md §1's note describes). Those want different remedies, so this
 * module returns the full equirectangular field alongside the statistics.
 */

import type { RigCalibration } from '../../../calibration/src/index.ts';
import type { Vec3 } from '../vec.ts';
import { DEG2RAD } from '../vec.ts';
import { angleBetweenDeg, latLonToWorld, raySphereIntersect } from '../geometry.ts';
import type { PreparedProjector, PreparedRig } from '../optics.ts';
import { pixelToRay, prepareRig, worldToPixel } from '../optics.ts';
import type { MaskInterpretation } from '../coverage.ts';
import { coverageAndWeights, isIlluminatedAt, polarMask } from '../coverage.ts';
import type { ConvergenceReport, CountField, MetricGate, MetricResult, ScalarField, SamplingReport } from './types.ts';
import { convergenceOf, createScalarField, makeMetric } from './types.ts';
import type { Stats } from './sampling.ts';
import { densityPair, equalAreaLattice, latticeWeightSr, summarise } from './sampling.ts';

export interface RegistrationOptions {
  /** Equal-area lattice size for the scalar statistics. */
  sampleCount?: number;
  /** Equirectangular error-map dimensions. Visualisation only — see the note. */
  fieldWidth?: number;
  fieldHeight?: number;
  /**
   * Below this normalized blend weight a projector's contribution is too faint
   * to judge, so its disagreement with a neighbour is reported separately as the
   * "visible" statistics. Geometric overlap is still reported in full.
   */
  visibleWeightFloor?: number;
  convergence?: boolean;
}

/** Where one projector physically lands a texel, and how far that is from truth. */
export interface ProjectorPlacementStats {
  id: string;
  index: number;
  /** Points this projector is responsible for, under the CONTENT calibration. */
  sampleCount: number;
  /** Geodesic displacement from the intended point, millimetres. */
  displacementMm: Stats;
}

export interface RegistrationSample {
  latDeg: number;
  lonDeg: number;
  projectorA: number;
  projectorB: number;
  errorMm: number;
  /** Smaller of the two normalized blend weights at this point. */
  minWeight: number;
}

export interface RegistrationReport {
  /** Statistics over every point at least two projectors geometrically reach. */
  overlap: Stats;
  /** The same, restricted to points where both contributions are visible. */
  visible: Stats;
  /** Fraction of the sphere with overlap multiplicity >= 2, area-weighted. */
  overlapAreaFraction: number;
  /** The single worst sample, for the report to name a location. */
  worst: RegistrationSample | null;
  perProjector: ProjectorPlacementStats[];
  /**
   * Millimetres of registration error per cell, `NaN` where fewer than two
   * projectors reach. Equirectangular, cell centres — see `ScalarField`.
   */
  field: ScalarField;
  /** Overlap multiplicity per cell of the same grid, for masking the map. */
  multiplicityField: CountField;
  /** Points where a projector's own placement could not be computed at all. */
  raysThatLeftTheSphere: number;
  metric: MetricResult;
  sampling: SamplingReport;
}

/**
 * The pixel the compositor assigns to a surface point, and where that pixel
 * physically lands.
 *
 * Returns `null` when the content calibration does not give this projector
 * responsibility for the point (behind the limb, or off the raster), and
 * `undefined`-like `null` too when the physical ray misses the sphere entirely —
 * which a grossly misaimed projector can do near the limb. The two cases are
 * distinguished by `escaped`, because one means "not this projector's job" and
 * the other means "this projector is throwing that texel into the room".
 */
function placeTexel(
  point: Vec3,
  content: PreparedProjector,
  physical: PreparedProjector,
  physicalRadiusM: number,
): { landed: Vec3 | null; responsible: boolean } {
  if (!isIlluminatedAt(point, content)) return { landed: null, responsible: false };
  const px = worldToPixel(content, point);
  if (px === null) return { landed: null, responsible: false };
  const ray = pixelToRay(physical, px.u, px.v);
  const hit = raySphereIntersect(physical.lens, ray, physicalRadiusM);
  if (hit === null) return { landed: null, responsible: true };
  return { landed: hit.point, responsible: true };
}

/** Geodesic distance between two points on a sphere of the given radius, mm. */
export function geodesicMm(a: Vec3, b: Vec3, radiusM: number): number {
  return angleBetweenDeg(a, b) * DEG2RAD * radiusM * 1000;
}

/** Where one projector lands one texel, and how far that is from the intent. */
export interface TexelPlacement {
  /** Physical landing point, or `null`. See {@link placeTexelAt}. */
  landed: Vec3 | null;
  /** True when the content calibration gives this projector the texel at all. */
  responsible: boolean;
  /** Geodesic distance from the intended point, millimetres. `NaN` if it escaped. */
  displacementMm: number;
}

/**
 * Where projector `index` physically lands the texel the content calibration
 * assigns to `(latDeg, lonDeg)`.
 *
 * The single-projector half of the registration measurement, exported because it
 * is what makes the metric falsifiable. A metric that only ever reports pairwise
 * disagreement can be self-consistent and still wrong by a constant factor;
 * `test/metrics.test.ts` pins this against a first-order perturbation
 * calculation done independently on paper, at a geometry where the answer has a
 * closed form. It is also what a progress page needs to draw per-projector
 * displacement arrows rather than a scalar field.
 */
export function placeTexelAt(
  latDeg: number,
  lonDeg: number,
  physical: PreparedRig,
  content: PreparedRig,
  index: number,
): TexelPlacement {
  const point = latLonToWorld(latDeg, lonDeg, content.radiusM);
  const r = placeTexel(point, content.projectors[index], physical.projectors[index], physical.radiusM);
  return {
    landed: r.landed,
    responsible: r.responsible,
    displacementMm: r.landed === null ? NaN : geodesicMm(r.landed, point, physical.radiusM),
  };
}

interface RegistrationCore {
  overlapErrors: number[];
  visibleErrors: number[];
  samples: RegistrationSample[];
  perProjectorDisplacement: number[][];
  litSamples: number;
  overlapSamples: number;
  escaped: number;
}

/**
 * The measurement itself, over one lattice. Split out from
 * {@link computeRegistration} so the convergence check can rerun it at a
 * different density without duplicating a line of the geometry.
 */
/**
 * Place one texel through every projector, filling `landed` and `responsible`.
 *
 * Shared by the statistic and the map. They carried two copies of this loop and
 * two copies of the worst-pair search below, so "which projector is responsible
 * for this texel" and "how far apart did two of them put it" each had two
 * definitions — and a change to either had to be made twice or the number and
 * the picture of that number would disagree.
 */
function placeAll(
  point: Vec3,
  physical: PreparedRig,
  content: PreparedRig,
  landed: (Vec3 | null)[],
  responsible: boolean[],
): number {
  let count = 0;
  for (let i = 0; i < content.projectors.length; i++) {
    const r = placeTexel(point, content.projectors[i], physical.projectors[i], physical.radiusM);
    landed[i] = r.landed;
    responsible[i] = r.responsible;
    if (r.responsible) count++;
  }
  return count;
}

/**
 * The two landed points that disagree most, or null when fewer than two landed.
 *
 * Strictly-greater comparison, so among equals the first pair in index order
 * wins — the tie-break both callers already had.
 */
function worstPair(
  landed: readonly (Vec3 | null)[],
  n: number,
  radiusM: number,
): { i: number; j: number; errorMm: number } | null {
  let bi = -1;
  let bj = -1;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const li = landed[i];
    if (li === null) continue;
    for (let j = i + 1; j < n; j++) {
      const lj = landed[j];
      if (lj === null) continue;
      const err = geodesicMm(li, lj, radiusM);
      if (err > best) {
        best = err;
        bi = i;
        bj = j;
      }
    }
  }
  return bi < 0 ? null : { i: bi, j: bj, errorMm: best };
}

function registrationOver(
  physical: PreparedRig,
  content: PreparedRig,
  count: number,
  maskInterpretation: MaskInterpretation,
  visibleWeightFloor: number,
  keepSamples: boolean,
): RegistrationCore {
  const lattice = equalAreaLattice(count);
  const n = content.projectors.length;
  const core: RegistrationCore = {
    overlapErrors: [],
    visibleErrors: [],
    samples: [],
    perProjectorDisplacement: Array.from({ length: n }, () => [] as number[]),
    litSamples: 0,
    overlapSamples: 0,
    escaped: 0,
  };

  const landed: (Vec3 | null)[] = new Array<Vec3 | null>(n).fill(null);
  const responsibleFlags: boolean[] = new Array<boolean>(n).fill(false);

  for (const s of lattice) {
    const point = latLonToWorld(s.latDeg, s.lonDeg, content.radiusM);
    // A fully masked point shows nothing at all, so a disagreement there is not
    // an artifact anybody can see. PARAMETERS.md §4.4: "The simulator must model
    // the mask, or seam metrics will report failures in a region nobody projects
    // onto." That sentence is about exactly this.
    if (polarMask(s.latDeg, content.blend, maskInterpretation) <= 0) continue;

    const responsible = placeAll(point, physical, content, landed, responsibleFlags);
    for (let i = 0; i < n; i++) {
      if (!responsibleFlags[i]) continue;
      const li = landed[i];
      if (li === null) core.escaped++;
      else core.perProjectorDisplacement[i].push(geodesicMm(li, point, physical.radiusM));
    }
    if (responsible >= 1) core.litSamples++;
    if (responsible < 2) continue;
    core.overlapSamples++;

    // Blend weights come from the CONTENT calibration: they are what the
    // compositor computed, not a property of the physical rig.
    const weights = coverageAndWeights(point, content).weights;

    const worst = worstPair(landed, n, physical.radiusM);
    if (worst === null) continue;
    const worstMinW = Math.min(weights[worst.i], weights[worst.j]);

    core.overlapErrors.push(worst.errorMm);
    if (worstMinW >= visibleWeightFloor) core.visibleErrors.push(worst.errorMm);
    if (keepSamples) {
      core.samples.push({
        latDeg: s.latDeg,
        lonDeg: s.lonDeg,
        projectorA: worst.i,
        projectorB: worst.j,
        errorMm: worst.errorMm,
        minWeight: worstMinW,
      });
    }
  }
  return core;
}

/**
 * The equirectangular error map.
 *
 * This grid is NOT equal-area and is not used for any statistic — it is an
 * image, and an image of the sphere has to be in the sphere's own
 * parameterization to be readable. Every number in {@link RegistrationReport}
 * comes from the lattice. Keeping the two apart is the whole point: the map
 * shows WHERE, the lattice says HOW MUCH.
 */
function registrationField(
  physical: PreparedRig,
  content: PreparedRig,
  width: number,
  height: number,
  maskInterpretation: MaskInterpretation,
): { field: ScalarField; multiplicity: CountField } {
  const field = createScalarField(width, height, NaN);
  const multiplicity: CountField = { width, height, data: new Uint8Array(width * height) };
  const n = content.projectors.length;
  const landed: (Vec3 | null)[] = new Array<Vec3 | null>(n).fill(null);
  const responsibleFlags: boolean[] = new Array<boolean>(n).fill(false);

  for (let y = 0; y < height; y++) {
    const latDeg = 90 - ((y + 0.5) / height) * 180;
    for (let x = 0; x < width; x++) {
      const lonDeg = -180 + ((x + 0.5) / width) * 360;
      const idx = y * width + x;
      const point = latLonToWorld(latDeg, lonDeg, content.radiusM);
      if (polarMask(latDeg, content.blend, maskInterpretation) <= 0) continue;

      const responsible = placeAll(point, physical, content, landed, responsibleFlags);
      multiplicity.data[idx] = responsible;
      if (responsible < 2) continue;

      const worst = worstPair(landed, n, physical.radiusM);
      if (worst !== null) field.data[idx] = worst.errorMm;
    }
  }
  return { field, multiplicity };
}

/**
 * Registration error over the sphere.
 *
 * `physicalRig` is where the lenses are. `contentRig` is what the compositor
 * believes; pass the same object for a perfectly aligned system.
 */
export function computeRegistration(
  physicalRig: RigCalibration,
  contentRig: RigCalibration,
  maskInterpretation: MaskInterpretation,
  gate: MetricGate | null,
  options: RegistrationOptions = {},
  densityScale = 1,
): RegistrationReport {
  const physical = prepareRig(physicalRig);
  const content = prepareRig(contentRig);
  const { fine, coarse } = densityPair(options.sampleCount ?? 20000, densityScale);
  const visibleWeightFloor = options.visibleWeightFloor ?? 0.05;
  const wantConvergence = options.convergence ?? true;

  const core = registrationOver(physical, content, fine, maskInterpretation, visibleWeightFloor, true);
  const overlap = summarise(core.overlapErrors);
  const visible = summarise(core.visibleErrors);

  let worst: RegistrationSample | null = null;
  for (const s of core.samples) if (worst === null || s.errorMm > worst.errorMm) worst = s;

  const perProjector: ProjectorPlacementStats[] = physical.projectors.map((p, i) => ({
    id: p.cal.id,
    index: i,
    sampleCount: core.perProjectorDisplacement[i].length,
    displacementMm: summarise(core.perProjectorDisplacement[i]),
  }));

  let convergence: ConvergenceReport | null = null;
  if (wantConvergence) {
    const coarseCore = registrationOver(
      physical,
      content,
      coarse,
      maskInterpretation,
      visibleWeightFloor,
      false,
    );
    convergence = convergenceOf(
      overlap.rms,
      summarise(coarseCore.overlapErrors).rms,
      coarse,
      // A tenth of the §7 grid gate. Convergence finer than that cannot change
      // any verdict, and demanding more would only report noise.
      0.1,
    );
  }

  const sampling: SamplingReport = {
    scheme: 'fibonacci-equal-area',
    description:
      `${fine}-point Fibonacci lattice over the whole sphere, each point standing for ` +
      `${latticeWeightSr(fine).toExponential(3)} sr. Equal-area, so the reported RMS and p95 are ` +
      `area-weighted without a weight array. Fully masked points are excluded.`,
    count: fine,
    densityPerSr: fine / (4 * Math.PI),
    convergence,
  };

  const { field, multiplicity } = registrationField(
    physical,
    content,
    options.fieldWidth ?? 360,
    options.fieldHeight ?? 180,
    maskInterpretation,
  );

  const metric = makeMetric({
    id: 'registration_error',
    label: 'Registration error between overlapping projectors',
    value: overlap.rms,
    unit: 'mm on sphere surface',
    gate,
    // PARAMETERS.md §7 lists no numeric registration gate. Showing the grid gate
    // beside this number is useful; letting it decide the build would invent a
    // requirement the spec does not state, and would double-count the same
    // physical error that grid.ts already scores against that gate properly.
    scored: false,
    note:
      'RMS over every point at least two projectors reach, area-weighted. PARAMETERS.md §7 sets ' +
      'no numeric gate on registration error itself — the nearest published figure is the 1.0 mm ' +
      'grid-line displacement gate, shown here for reference and SCORED by the grid metric, which ' +
      'measures what an operator actually judges. This metric is unscored to avoid inventing a ' +
      'requirement and to avoid counting the same error twice. Zero by construction when the ' +
      'content calibration equals the physical one.',
    sampling,
    detail: {
      p95Mm: overlap.p95,
      maxMm: overlap.max,
      meanMm: overlap.mean,
      visibleRmsMm: visible.rms,
      visibleP95Mm: visible.p95,
      visibleMaxMm: visible.max,
      overlapAreaFraction: fine > 0 ? core.overlapSamples / fine : NaN,
      overlapSampleCount: core.overlapSamples,
      visibleWeightFloor,
      raysThatLeftTheSphere: core.escaped,
    },
  });

  return {
    overlap,
    visible,
    overlapAreaFraction: fine > 0 ? core.overlapSamples / fine : NaN,
    worst,
    perProjector,
    field,
    multiplicityField: multiplicity,
    raysThatLeftTheSphere: core.escaped,
    metric,
    sampling,
  };
}
