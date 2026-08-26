// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The live metrics panel, as data.
 *
 * ## Every photometric metric here is marked PROVISIONAL, and that is enforced
 *
 * docs/ARCHITECTURE.md's phase gate: geometric metrics rest on `DOC`, `CFG` and
 * `SOLVE` constants and are trustworthy today; photometric metrics rest on
 * `ASSUME` and `MEAS` constants and nobody has measured one of them. A panel
 * that printed a seam ΔE next to an unlit fraction in the same typeface would
 * lend the first the credibility of the second, which is the exact failure the
 * phase gate exists to prevent.
 *
 * So `provisional` is not a field a caller sets — {@link photometricMetrics}
 * hard-codes it true on everything it returns, and `test/metrics.test.ts`
 * asserts that no metric from that function ever comes back false. The UI is
 * required to render the flag.
 *
 * ## Why the numbers come from `packages/sim` rather than from the GPU
 *
 * The harness's job is to check that the metrics track what the eye sees. If the
 * metrics were computed from the GPU render, a shared bug would move the picture
 * and the number together and the check would be worthless. They are therefore
 * computed by the same CPU code the bench runs, on the same rig the GPU is
 * drawing — and the parity number is what says the two renderers agree, so a
 * human can trust that the number and the picture describe one thing.
 *
 * ## Density
 *
 * Every reading is computed at a reduced sampling density, because this runs on
 * a slider drag rather than in a batch job. The density is reported alongside
 * the numbers rather than buried: a metric whose value depends on a sample count
 * a reader cannot see is a metric a reader cannot check.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import { GATES } from '../../calibration/src/parameters.ts';
import type { Scene } from '../../sim/src/render.ts';
import type { MetricGate } from '../../sim/src/metrics/index.ts';
import { gateById } from '../../sim/src/metrics/index.ts';
import { computeCoverageStats } from '../../sim/src/metrics/coverage-stats.ts';
import { computeOffSphereFlux, OFF_SPHERE_EXCESS_GATE } from '../../sim/src/metrics/flux.ts';
import { computeUnlitInMask } from '../../sim/src/metrics/unlit.ts';
import { computePhotometricMetrics } from '../../sim/src/metrics/photometric.ts';
import type { ShadingModel } from '../../sim/src/shading.ts';

export interface PanelMetric {
  id: string;
  label: string;
  /** PARAMETERS.md section this comes from. */
  section: string;
  value: number;
  unit: string;
  /** Inclusive upper bound, or `null` when §7 sets none. */
  gateMax: number | null;
  pass: boolean | null;
  /** Whether pass/fail counts toward a verdict, or the reading is reference-only. */
  scored: boolean;
  /** True for everything resting on an ASSUME or MEAS constant. */
  provisional: boolean;
  /** Significant digits to print. */
  digits: number;
  note: string;
}

export interface MetricPanel {
  geometry: PanelMetric[];
  photometry: PanelMetric[];
  /** Sample-count scale these were computed at, relative to the bench's default. */
  densityScale: number;
  /** Wall-clock cost of the computation, milliseconds. Shown so a user can see the price. */
  computeMs: number;
  /** True when every SCORED, NON-PROVISIONAL metric passes. */
  geometryPass: boolean;
  /** Never used for a verdict. See the module note and docs/ARCHITECTURE.md. */
  photometryPass: boolean;
}

function metric(
  input: Omit<PanelMetric, 'pass' | 'scored' | 'provisional' | 'digits'> &
    Partial<Pick<PanelMetric, 'pass' | 'scored' | 'provisional' | 'digits'>>,
): PanelMetric {
  const gateMax = input.gateMax;
  return {
    ...input,
    digits: input.digits ?? 4,
    scored: input.scored ?? true,
    provisional: input.provisional ?? false,
    pass:
      input.pass !== undefined
        ? input.pass
        : gateMax === null
          ? null
          : Number.isFinite(input.value) && input.value <= gateMax,
  };
}

function gateMaxOf(gate: MetricGate): number {
  return gate.max;
}

export interface PanelOptions {
  /** Scales every sample count. 1 is the bench's default; the harness uses 0.15. */
  densityScale?: number;
  shading?: ShadingModel;
  specWeight?: number;
  specAlpha?: number;
  /** Skip the photometric half, which is the expensive one. */
  includePhotometry?: boolean;
}

/**
 * The geometric readings. None of these is provisional — that is a claim about
 * provenance, not a formality: every one depends on `R` (DOC), `d_proj` (SOLVE,
 * and conflicted, which the note says), the raster (CFG) and the pose (SOLVE).
 *
 * The blend and mask configuration is ASSUME and does appear, but only as a
 * DOMAIN: it decides which points are inside the masked region, never scales a
 * measured distance. That is the same line `packages/sim/src/metrics/index.ts`
 * draws and for the same reason.
 */
export function geometricMetrics(
  rig: RigCalibration,
  scene: Scene,
  densityScale: number,
): PanelMetric[] {
  const coverage = computeCoverageStats(
    rig,
    scene.maskInterpretation,
    {
      sampleCount: 20000,
      boundarySamples: 180,
      fieldWidth: 8,
      fieldHeight: 4,
      // The harness lets a human drag a rig into shapes the bench never builds.
      // `computeCoverageStats` throws on a multiplicity above 2 because in a
      // batch run that means the arithmetic has stopped working — here it would
      // take the whole panel down, so the reading is surfaced as a metric with a
      // gate of 2 instead. Same information, and it stays on screen.
      assertMultiplicity: false,
      convergence: false,
    },
    densityScale,
  );
  const flux = computeOffSphereFlux(
    rig,
    gateById(GATES, 'off_sphere_flux'),
    { convergence: false },
    densityScale,
  );
  const unlit = computeUnlitInMask(
    rig,
    scene.maskInterpretation,
    gateById(GATES, 'unlit_in_mask'),
    { convergence: false, boundarySamples: 180 },
    densityScale,
  );

  return [
    metric({
      id: 'max_multiplicity',
      label: 'Max overlap multiplicity',
      section: '§4.2',
      value: coverage.maxMultiplicity,
      unit: 'projectors',
      gateMax: 2,
      digits: 0,
      note:
        'PARAMETERS.md §4.2 corrects rev 1: N is 1 or 2 everywhere, never 3 or 4. Three-way overlap would ' +
        'need a point within 80.4° of three equatorial directions 90° apart, and any three of the four ' +
        'contain an antipodal pair. A 3 here is not a rig worth reporting, it is arithmetic that has stopped working.',
    }),
    metric({
      id: 'unlit_in_mask',
      label: 'Unlit fraction inside the mask',
      section: '§7',
      value: unlit.primary.unlitFractionOfDomain,
      unit: 'fraction of the masked domain',
      gateMax: gateMaxOf(gateById(GATES, 'unlit_in_mask')),
      digits: 5,
      note:
        '§7’s only gate with no tolerance, computed inside `mask_lo`. Its DOMAIN depends on whether ' +
        '`set bottommask 60,70` is latitude or colatitude, which docs/AMENDMENTS.md A-02 records as inferred. ' +
        'Below four projectors this cannot reach zero — that is A-10, a property of the install, not a defect.',
    }),
    metric({
      id: 'unlit_in_mask_other',
      label: 'Unlit fraction under the OTHER mask reading',
      section: 'A-02',
      value: unlit.secondary.unlitFractionOfDomain,
      unit: 'fraction of the masked domain',
      gateMax: null,
      scored: false,
      digits: 5,
      note:
        'The same gate under the reading of `bottommask` the scene is NOT using. Reported so the size of ' +
        'A-02’s ambiguity is visible instead of assumed.',
    }),
    metric({
      id: 'boundary_margin',
      label: 'Coverage margin at the mask edge (worst pole)',
      section: '§4.3',
      value: Math.min(unlit.primary.boundaryMarginNorthDeg, unlit.primary.boundaryMarginSouthDeg),
      unit: 'deg latitude',
      gateMax: null,
      scored: false,
      digits: 3,
      note:
        'Degrees of latitude between the mask onset and the unlit polar region, found by bisection rather ' +
        'than by sampling. A positive margin and a zero unlit fraction are two independent ways of saying ' +
        'the same thing; a point sample can only find a hole bigger than its own spacing.',
    }),
    metric({
      id: 'off_sphere_excess',
      label: 'Off-sphere flux above the analytic floor',
      section: '§7 / A-01',
      value: flux.excessAboveConfiguredFloor,
      unit: 'fraction',
      gateMax: OFF_SPHERE_EXCESS_GATE.max,
      digits: 5,
      note:
        'A-03: §7’s absolute 52% gate is unpassable on a 16:9 raster at ANY alignment quality, because the ' +
        'floor alone is 55.8%. This is the restatement A-03 proposes — excess over the raster’s own floor — ' +
        'so the number measures misaim rather than the projector’s aspect ratio. The gate is not in ' +
        'PARAMETERS.md; A-03 proposes it and its status is OPEN.',
    }),
    metric({
      id: 'off_sphere_absolute',
      label: 'Off-sphere flux, absolute',
      section: '§7',
      value: flux.absoluteFraction,
      unit: 'fraction of raster area',
      gateMax: gateMaxOf(gateById(GATES, 'off_sphere_flux')),
      scored: false,
      digits: 4,
      note:
        '§7’s gate as literally written, against a documented floor of ~51%. Reported and NOT scored: it is ' +
        'confounded by the projector’s aspect ratio (A-01, A-03), so failing a build on it would be failing ' +
        'on a hardware choice.',
    }),
    metric({
      id: 'unlit_polar_north',
      label: 'Unlit polar area, north pole',
      section: '§4.3',
      value: coverage.unlitPolarAreaFractionNorth,
      unit: 'fraction of the sphere',
      gateMax: null,
      scored: false,
      digits: 5,
      note:
        'Integrated over the true scalloped boundary, not approximated by a cap. §4.3 says "roughly 1.4–2.8% ' +
        'per pole"; the integrated figure at the spec’s own d = 5.18 m is 0.89%, which is docs/AMENDMENTS.md ' +
        'A-05 — 1.4% is the seam-direction cap, i.e. the strict UPPER bound, and 2.8% is that doubled.',
    }),
    metric({
      id: 'usable_meridian',
      label: 'Usable latitude along a projector meridian',
      section: '§4.3',
      value: coverage.usableLatitudeMeridianDeg,
      unit: 'deg',
      gateMax: null,
      scored: false,
      digits: 2,
      note: '§4.3 puts this at ≈69°, taking cos(incidence) < 0.2 as the point where the image becomes streaks.',
    }),
    metric({
      id: 'usable_seam',
      label: 'Usable latitude in a seam direction',
      section: '§4.3',
      value: coverage.usableLatitudeSeamDeg,
      unit: 'deg',
      gateMax: null,
      scored: false,
      digits: 2,
      note:
        '§4.3 puts this at ≈59°. §4.4 observes that `set bottommask 60,70`’s onset of 60 matches it almost ' +
        'exactly, which is the evidence that the mask hides the grazing region rather than suppressing overlap ' +
        'brightness — §4.2 shows there is no pile-up to suppress.',
    }),
    metric({
      id: 'below_usable',
      label: 'Lit area below the usability line',
      section: '§4.3',
      value: coverage.belowUsableIncidenceFraction,
      unit: 'fraction of lit area',
      gateMax: null,
      scored: false,
      digits: 4,
      note: 'Fraction of the lit sphere whose best incidence cosine is under §4.3’s 0.2.',
    }),
    metric({
      id: 'seam_area',
      label: 'Two-projector overlap area',
      section: '§4.2',
      value: coverage.multiplicityAreaFraction[2] ?? 0,
      unit: 'fraction of the sphere',
      gateMax: null,
      scored: false,
      digits: 4,
      note:
        'How much of the sphere is in a seam at all. A registration RMS means one thing when the overlap is a ' +
        'broad well-lit band and another when it has shrunk to a sliver at grazing incidence.',
    }),
  ];
}

/**
 * The photometric readings. **Every one is PROVISIONAL and this function will
 * not let a caller say otherwise.**
 *
 * PARAMETERS.md §10 ranks per-channel gamma divergence the single highest
 * photometric risk in the project and says plainly that these metrics are "not
 * trustworthy until the ground-truth visit happens". The phase gate says build
 * them, mark them, and do not optimize against them.
 */
export function photometricMetrics(
  rig: RigCalibration,
  scene: Scene,
  densityScale: number,
  shading?: ShadingModel,
): PanelMetric[] {
  const set = computePhotometricMetrics(rig, scene, {
    densityScale,
    convergence: false,
    ...(shading ? { shading } : {}),
    black: { sampleCount: 3000 },
    seams: { latitudesDeg: [-40, 0, 40], sampleSpacingDeg: 0.5 },
  });

  const byId = new Map(set.metrics.map((m) => [m.id, m]));
  const pick = (id: string, section: string, digits: number): PanelMetric | null => {
    const m = byId.get(id);
    if (!m) return null;
    return metric({
      id: m.id,
      label: m.label,
      section,
      value: m.value,
      unit: m.unit,
      gateMax: m.gateMax,
      scored: m.scored,
      // Not read from `m.provisional`. The phase gate is a property of the
      // PHASE, and this panel is the photometric half of it; taking the flag
      // from the data would let a future metric arrive unmarked.
      provisional: true,
      digits,
      note: m.note,
    });
  };

  const out: PanelMetric[] = [];
  for (const [id, section, digits] of [
    ['seam_luminance', '§7 / §3.2', 5],
    ['seam_chroma', '§7 / §3.2', 4],
    ['black_uplift', '§7 / §3.2', 4],
    ['black_uplift_chroma', '§7 / §3.2', 4],
  ] as [string, string, number][]) {
    const m = pick(id, section, digits);
    if (m) out.push(m);
  }

  // docs/AMENDMENTS.md A-15: §7's seam gates are worded as DISCONTINUITIES, and
  // §3.2's headline artifact is a BAND with no discontinuity anywhere in it. The
  // two divergence readings are the band, reported beside the gate for scale and
  // never allowed to decide anything, because §7 sets no gate on them.
  out.push(
    metric({
      id: 'divergence_luminance',
      label: 'Luminance shift from per-channel divergence (band, A-15)',
      section: 'A-15',
      value: set.divergence.luminanceFraction,
      unit: 'fraction',
      gateMax: null,
      scored: false,
      provisional: true,
      digits: 5,
      note:
        'The field rendered twice — once with the rig’s real thirty-six transfer terms, once with every ' +
        'channel forced to agree — and differenced. A simulation-only counterfactual no photograph can ' +
        'produce. A-15 measured a rig carrying §3.2’s worked artifact passing every scored §7 gate while ' +
        'this reading moved by 3.88 ΔE.',
    }),
    metric({
      id: 'divergence_chroma',
      label: 'Chromaticity shift from per-channel divergence (band, A-15)',
      section: 'A-15',
      value: set.divergence.deltaE,
      unit: 'dE2000',
      gateMax: null,
      scored: false,
      provisional: true,
      digits: 4,
      note:
        'The same differential in colour. This is the number §3.2’s yellow band actually moves. Setting a ' +
        'gate for it needs the §8 visit — it is a psychophysical threshold for a gradient of unknown size on ' +
        'a surface of unknown gloss under lighting of unknown colour, and inventing one now is exactly what ' +
        'the phase gate forbids.',
    }),
    metric({
      id: 'seam_estimator_floor',
      label: 'Seam estimator’s own noise floor (CONTROL)',
      section: 'A-15',
      value: set.seams.estimatorFloorFraction,
      unit: 'fraction',
      gateMax: null,
      scored: false,
      provisional: true,
      digits: 6,
      note:
        'What the step estimator reports where there is demonstrably no seam. A seam luminance figure at or ' +
        'below this is the estimator talking, not the rig.',
    }),
  );

  return out;
}

export function computeMetricPanel(
  rig: RigCalibration,
  scene: Scene,
  options: PanelOptions = {},
): MetricPanel {
  const densityScale = options.densityScale ?? 0.15;
  const started = Date.now();
  const geometry = geometricMetrics(rig, scene, densityScale);
  const photometry = (options.includePhotometry ?? true)
    ? photometricMetrics(rig, scene, densityScale, options.shading)
    : [];
  return {
    geometry,
    photometry,
    densityScale,
    computeMs: Date.now() - started,
    geometryPass: geometry.every((m) => !m.scored || m.pass === true),
    photometryPass: photometry.every((m) => !m.scored || m.pass === true),
  };
}
