// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `computeGeometricMetrics` — one call, every geometric metric of
 * PARAMETERS.md §7, each with its gate status and the field maps a report needs
 * to show WHERE the error is rather than only how much of it there is.
 *
 * ## Two calibrations, not one
 *
 * A forward model run against itself cannot misregister: every projector paints
 * the physically correct texel at the physically correct point. Real
 * misalignment is a disagreement between the calibration the COMPOSITOR draws
 * with and the calibration the LENSES actually have. So `rig` is the physical
 * truth and `opts.contentRig` is what the software believes; omit it and the two
 * are identical, which is the perfectly-aligned case and scores zero.
 *
 * On the bench, `contentRig` is the nominal rig from PARAMETERS.md §2 (or the
 * one a solver recovered) and `rig` is the perturbed one `injectMisalignment`
 * produced. That ordering matters and getting it backwards produces numbers of
 * roughly the right size that are answering the wrong question.
 *
 * ## What "not provisional" means here
 *
 * Every metric carries `provisional`, and every metric in this file sets it
 * false. That is a claim, not a formality: no number below depends on an
 * ASSUME-class photometric constant. They depend on `R` (DOC), `d_proj`
 * (SOLVE, conflicted, and the report says so), the raster geometry (CFG), and
 * the pose (SOLVE). PARAMETERS.md's central conclusion is that this half of the
 * parameter set is trustworthy today and the photometric half is not, and the
 * flag exists so the Phase 2 metrics can say the opposite in the same report
 * without a type change.
 *
 * The blend and mask configuration is ASSUME-class and does appear here — but
 * only as a DOMAIN, never as a weight. It decides which points are inside a
 * blend region and which are masked away; it never scales a measured distance.
 * `grid.ts` explains why that line is drawn where it is.
 *
 * ## Viewer independence
 *
 * PARAMETERS.md §6 is explicit that metric values must not depend on `fov_eye`.
 * `opts.viewer` therefore exists and is deliberately inert: it is recorded in
 * the provenance block so a report can say which renders accompany these
 * numbers, and `test/metrics.test.ts` computes the whole set at 35, 50 and 70
 * degrees and asserts every value is identical. An inert field that a test can
 * vary is a stronger guarantee than an absent one, which would make the
 * assertion vacuous.
 */

import type { RigCalibration } from '../../../calibration/src/index.ts';
import { CONVENTIONS_VERSION } from '../../../calibration/src/conventions.ts';
import { GATES } from '../../../calibration/src/parameters.ts';
import type { Scene, ViewerCamera } from '../render.ts';
import { fovVDeg, throwRatioOf } from '../optics.ts';
import type { MetricResult } from './types.ts';
import { gateById } from './types.ts';
import type { RegistrationOptions, RegistrationReport } from './registration.ts';
import { computeRegistration } from './registration.ts';
import type { GridOptions, GridReport } from './grid.ts';
import { computeGridDisplacement } from './grid.ts';
import type { FluxOptions, FluxReport } from './flux.ts';
import { computeOffSphereFlux } from './flux.ts';
import type { UnlitOptions, UnlitReport } from './unlit.ts';
import { computeUnlitInMask } from './unlit.ts';
import type { CoverageStatsOptions, CoverageStatsReport } from './coverage-stats.ts';
import { computeCoverageStats } from './coverage-stats.ts';

export * from './types.ts';
export * from './sampling.ts';
export * from './registration.ts';
export * from './grid.ts';
export * from './flux.ts';
export * from './unlit.ts';
export * from './coverage-stats.ts';
export * from './photometric.ts';

export interface GeometricMetricOptions {
  /**
   * The calibration the CONTENT was generated against. Defaults to `rig`, i.e.
   * a perfectly aligned system. See the module note.
   */
  contentRig?: RigCalibration;
  /**
   * Scales every sampling density at once. 1 is the documented default; the
   * tests use less where they are checking invariance rather than accuracy.
   */
  densityScale?: number;
  /** Run every convergence check. Default true; roughly a 40% cost. */
  convergence?: boolean;
  /**
   * Inert. PARAMETERS.md §6: no metric value may depend on the viewer camera.
   * Recorded in provenance; asserted invariant by the tests.
   */
  viewer?: ViewerCamera;
  registration?: RegistrationOptions;
  grid?: GridOptions;
  flux?: FluxOptions;
  unlit?: UnlitOptions;
  coverage?: CoverageStatsOptions;
}

/** Everything a report needs to draw the sphere rather than tabulate it. */
export interface MetricFields {
  /** Registration error in mm, `NaN` outside the overlap. */
  registrationMm: RegistrationReport['field'];
  /** Overlap multiplicity, 0/1/2. PARAMETERS.md §4.2. */
  multiplicity: RegistrationReport['multiplicityField'];
  /** Best available `cos(incidence)`, mask applied. `NaN` where unlit. */
  incidenceCos: CoverageStatsReport['incidenceField'];
  /** Every grid-line measurement, for a scatter overlay on the error map. */
  gridSamples: { latDeg: number; lonDeg: number; displacementMm: number }[];
}

export interface MetricProvenance {
  conventions: string;
  /** True when the content and physical calibrations are the same object. */
  perfectlyAligned: boolean;
  maskInterpretation: Scene['maskInterpretation'];
  sphereRadiusM: number;
  projectors: {
    id: string;
    /** Lens to sphere centre, metres. PARAMETERS.md §2 `d_proj`, CONFLICTED. */
    distanceM: number;
    fovHDeg: number;
    fovVDeg: number;
    /** Conventional distance-over-width throw ratio, for §3.1's T ~ 3.0:1. */
    throwRatio: number;
    resX: number;
    resY: number;
  }[];
  /** Recorded, never used. See the module note on viewer independence. */
  viewerFovHDeg: number | null;
  densityScale: number;
}

export interface MetricSet {
  schema: 'sphere-sim/metrics@1';
  phase: 'geometry';
  /** Every metric, in a stable order. */
  metrics: MetricResult[];
  /** True when every SCORED metric passes. */
  pass: boolean;
  /** Metric ids that are reported but excluded from `pass`, with the reason. */
  unscored: { id: string; reason: string }[];
  registration: RegistrationReport;
  grid: GridReport;
  flux: FluxReport;
  unlit: UnlitReport;
  coverage: CoverageStatsReport;
  fields: MetricFields;
  provenance: MetricProvenance;
}

/**
 * Every geometric metric of PARAMETERS.md §7, computed on a deterministic
 * equal-area sampling of the sphere.
 *
 * `rig` is the physical rig. `scene` supplies the mask interpretation (and
 * nothing else — the grid metric generates its own graticule, because the gate
 * is about the alignment pattern an operator judges and not about whatever
 * content happens to be playing).
 */
export function computeGeometricMetrics(
  rig: RigCalibration,
  scene: Scene,
  opts: GeometricMetricOptions = {},
): MetricSet {
  const contentRig = opts.contentRig ?? rig;
  const densityScale = opts.densityScale ?? 1;
  const maskInterpretation = scene.maskInterpretation;
  const convergence = opts.convergence ?? true;

  const withConvergence = <T extends { convergence?: boolean }>(o: T | undefined): T =>
    ({ ...(o ?? ({} as T)), convergence: o?.convergence ?? convergence });

  const registration = computeRegistration(
    rig,
    contentRig,
    maskInterpretation,
    gateById(GATES, 'grid_displacement'),
    withConvergence(opts.registration),
    densityScale,
  );
  const grid = computeGridDisplacement(
    rig,
    contentRig,
    maskInterpretation,
    gateById(GATES, 'grid_displacement'),
    withConvergence(opts.grid),
    densityScale,
  );
  const flux = computeOffSphereFlux(
    rig,
    gateById(GATES, 'off_sphere_flux'),
    withConvergence(opts.flux),
    densityScale,
  );
  const unlit = computeUnlitInMask(
    rig,
    maskInterpretation,
    gateById(GATES, 'unlit_in_mask'),
    withConvergence(opts.unlit),
    densityScale,
  );
  const coverage = computeCoverageStats(
    rig,
    maskInterpretation,
    withConvergence(opts.coverage),
    densityScale,
  );

  // Order is fixed and is the order a report prints: the gated metrics first,
  // then the reference readings that explain them.
  const metrics: MetricResult[] = [
    grid.metric,
    flux.metric,
    unlit.metric,
    registration.metric,
    flux.absoluteMetric,
    unlit.secondaryMetric,
  ];

  const unscored = metrics
    .filter((m) => !m.scored)
    .map((m) => ({ id: m.id, reason: m.note }));
  const pass = metrics.every((m) => !m.scored || m.pass === true);

  const provenance: MetricProvenance = {
    conventions: CONVENTIONS_VERSION,
    perfectlyAligned: contentRig === rig,
    maskInterpretation,
    sphereRadiusM: rig.sphere.radiusM,
    projectors: rig.projectors.map((p) => ({
      id: p.id,
      distanceM: Math.hypot(p.pose.position.x, p.pose.position.y, p.pose.position.z),
      fovHDeg: p.intrinsics.fovHDeg,
      fovVDeg: fovVDeg(p.intrinsics),
      throwRatio: throwRatioOf(p.intrinsics),
      resX: p.intrinsics.resX,
      resY: p.intrinsics.resY,
    })),
    viewerFovHDeg: opts.viewer ? opts.viewer.fovHDeg : null,
    densityScale,
  };

  return {
    schema: 'sphere-sim/metrics@1',
    phase: 'geometry',
    metrics,
    pass,
    unscored,
    registration,
    grid,
    flux,
    unlit,
    coverage,
    fields: {
      registrationMm: registration.field,
      multiplicity: registration.multiplicityField,
      incidenceCos: coverage.incidenceField,
      gridSamples: grid.measurements.map((m) => ({
        latDeg: m.latDeg,
        lonDeg: m.lonDeg,
        displacementMm: m.displacementMm,
      })),
    },
    provenance,
  };
}
