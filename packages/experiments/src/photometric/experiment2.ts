/**
 * Experiment 2 — blend softness against geometric tolerance.
 *
 * **The hypothesis, from PARAMETERS.md §7:** "proper soft blending buys geometric
 * tolerance — a well-blended seam hides misregistration that a hard or naively-ramped
 * edge exposes. If it holds, the value proposition inverts from 'our alignment is
 * more accurate' to 'you need less alignment accuracy, because the blend absorbs
 * it.'"
 *
 * That is the commercially interesting claim in the project, which makes this the
 * experiment most exposed to motivated reasoning. So the falsifying outcomes are
 * written down here, before the numbers, and the results file records the verdict
 * against them mechanically:
 *
 *  - **F1.** The artifact does not fall with ramp width — a flat or rising
 *    `luminanceFraction` against `widthDeg` at fixed registration error.
 *  - **F2.** It falls, but so slowly that the tolerance bought over the whole
 *    plausible width range of `w_width` (5 to 40 degrees, docs/AMENDMENTS.md A-04's
 *    inferred range) is under a factor of two. A factor a site cannot use is not a
 *    value proposition.
 *  - **F3.** It falls, but the width that buys it moves the binding artifact into
 *    the grazing region §4.3 already calls degenerate — trading a seam nobody can
 *    see for a smear everybody can.
 *  - **F4.** It falls in a statistic that depends on the estimator's window, in
 *    which case there is no result at all, only a choice of window. (This one nearly
 *    happened: see `artifact.ts`.)
 *
 * Every number this module produces is **PROVISIONAL**. Every constant underneath it
 * is class ASSUME and nobody has measured any of them — docs/ARCHITECTURE.md's phase
 * gate. Nothing here is tuned, and the sweep is run once.
 */

import type { RampShape, RigCalibration } from '../../../calibration/src/index.ts';
import type { Scene, ShadingModel } from '../../../sim/src/index.ts';
import {
  RAMP_SHAPES,
  computePhotometricMetrics,
  computeRegistration,
  injectMisalignment,
} from '../../../sim/src/index.ts';
import { buildModel } from './model.ts';
import type { BlendProfile, MisregistrationArtifact } from './artifact.ts';
import { estimatorScan, measureBlendProfile, measureMisregistration } from './artifact.ts';
import { epsilonForMm, misregisteredRig, registrationMm } from './misregistration.ts';

/** §7's two seam gates, for scale. Neither is a threshold on a band — A-15. */
export const LUMINANCE_GATE = 0.02;
export const CHROMA_GATE = 1.0;

/**
 * Ramp widths swept, degrees.
 *
 * PARAMETERS.md §4.5 gives `w_width ~ 20 deg`, class ASSUME, "verify against a real
 * sphere", and states no range; `parameters.ts` infers 5 to 40 (A-04). The sweep runs
 * past that to **71 degrees**, which is not an arbitrary round number: at the equator
 * two adjacent projectors overlap over 70.8 degrees of longitude, and because
 * `coverage.ts` anchors each ramp at its own footprint edge, a width equal to the
 * overlap is exactly the setting at which the crossfade spans the whole overlap with
 * no clamped plateau in the middle. It is the widest blend this geometry has a
 * meaning for, so it belongs in the sweep as the limit case even though no site
 * would configure it from the spec as written.
 */
export const WIDTHS_DEG: readonly number[] = [5, 8, 12, 16, 20, 25, 30, 40, 50, 60, 71];

/**
 * Registration errors swept, millimetres of arc at the equator.
 *
 * Logarithmic from half of §7's 1.0 mm grid gate to 64 mm, which is 6.4% of the
 * sphere's radius and far past anything an installer would leave behind. The range
 * has to reach that far because the answer turns out to live there: the nominal blend
 * absorbs several millimetres before anything is measurable.
 */
export const REGISTRATION_MM: readonly number[] = [0.5, 1, 2, 4, 8, 16, 32, 64];

export interface Experiment2Cell {
  shape: RampShape;
  widthDeg: number;
  /** Registration error between adjacent projectors at the equator, mm of arc. */
  registrationMm: number;
  /** The rotation that produces it, degrees of longitude. */
  epsilonDeg: number;
  /** Max `|Y_actual - Y_ideal| / Y_ideal`. PROVISIONAL, unscored. See artifact.ts. */
  misregLuminance: number;
  /** Max ΔE2000 between the two renders. PROVISIONAL, unscored. */
  misregChroma: number;
  /** Max `|sum of blend weights - 1|` — the artifact with no optics in it. */
  blendResidual: number;
  /** Arc width of the artifact at half its peak, degrees. */
  fwhmDeg: number;
  peakLatDeg: number;
  peakLonDeg: number;
  /** Best `cos(incidence)` where the artifact peaks. §4.3's degeneracy check. */
  peakIncidenceCos: number;
  /** Delivered-light-weighted `cos(incidence)` at the same point. */
  peakIncidenceCosWeighted: number;
  /** §7's seam luminance gate AS SHIPPED, measured at the hand-over. */
  seamLuminance: number;
  /** §7's seam chromaticity gate as shipped. */
  seamChroma: number;
  /** The §7 estimator's own noise floor on this field, from its per-track control. */
  seamEstimatorFloor: number;
}

export interface Experiment2Baseline {
  shape: RampShape;
  widthDeg: number;
  /** §7's gates on the perfectly registered rig. */
  seamLuminance: number;
  seamChroma: number;
  seamEstimatorFloor: number;
  profile: BlendProfile;
  /**
   * The rejected windowed estimator at three window sizes, at perfect registration.
   * Present so the scale dependence that disqualified it stays reproducible.
   */
  scanByWindow: { guardDeg: number; windowDeg: number; degree: number; luminanceFraction: number }[];
}

export interface Experiment2Contour {
  shape: RampShape;
  widthDeg: number;
  /** Registration error at which `misregLuminance` reaches §7's 2%, mm. */
  luminanceToleranceMm: number;
  /** Registration error at which `misregChroma` reaches ΔE2000 1.0, mm. */
  chromaToleranceMm: number;
  /** Log-log slope of `misregLuminance` against registration error. 1 = linear. */
  luminanceSlope: number;
}

export interface Experiment2Realistic {
  seed: number;
  /** Multiplier on every `DEFAULT_MISALIGNMENT` magnitude. */
  scale: number;
  widthDeg: number;
  /** RMS, p95 and max pairwise registration error over the overlap, mm. */
  registrationRmsMm: number;
  registrationP95Mm: number;
  registrationMaxMm: number;
  misregLuminance: number;
  misregChroma: number;
  /** What the canonical sweep predicts at this rig's p95 registration error. */
  canonicalAtP95: number;
}

export interface Experiment2Verdict {
  /** Factor by which the artifact falls from the narrowest to the widest ramp. */
  toleranceGainOverInferredRange: number;
  toleranceGainOverFullSweep: number;
  /** F1: does the artifact fall monotonically with width at every registration error? */
  fallsWithWidth: boolean;
  /** F2: is the gain over A-04's inferred 5-40 degree range at least a factor of 2? */
  gainIsUsable: boolean;
  /** F3: does the binding artifact stay out of §4.3's smear region as width grows? */
  staysOutOfGrazing: boolean;
  /** F4: is the statistic the verdict rests on scale-free? */
  estimatorIsScaleFree: boolean;
  holds: boolean;
  statement: string;
}

export interface Experiment2Result {
  schema: 'sphere-sim/experiment-2@1';
  provisional: true;
  /** Copied into every consumer so a plot cannot lose it. */
  provisionalNote: string;
  generatedFrom: {
    widthsDeg: readonly number[];
    registrationMm: readonly number[];
    shapes: readonly RampShape[];
    rampGamma: number;
    latitudesDeg: number[];
    sampleSpacingDeg: number;
    projectorCount: number;
  };
  baselines: Experiment2Baseline[];
  cells: Experiment2Cell[];
  contours: Experiment2Contour[];
  /** The same sweep at four values of §4.5's DOC-class `gamma_blend`, at nominal width. */
  rampGammaSweep: { rampGamma: number; registrationMm: number; misregLuminance: number; blendResidual: number }[];
  realistic: Experiment2Realistic[];
  verdict: Experiment2Verdict;
}

const LATITUDES = [-50, -25, 0, 25, 50];
const SPACING = 0.25;

function seamMetrics(
  rig: RigCalibration,
  contentRig: RigCalibration,
  scene: Scene,
  shading: ShadingModel,
): { luminance: number; chroma: number; floor: number } {
  const set = computePhotometricMetrics(rig, scene, {
    contentRig,
    shading,
    convergence: false,
    // The black-uplift and divergence readings are not used by this experiment, so
    // they run at the cheapest density that still produces a number rather than
    // being switched off — a metric set with holes in it invites being quoted.
    black: { sampleCount: 400, convergence: false },
    seams: { latitudesDeg: LATITUDES, sampleSpacingDeg: SPACING },
  });
  const find = (id: string): number => set.metrics.find((m) => m.id === id)?.value ?? NaN;
  return {
    luminance: find('seam_luminance'),
    chroma: find('seam_chroma'),
    floor: set.seams.estimatorFloorFraction,
  };
}

function artifactOf(
  physical: RigCalibration,
  content: RigCalibration,
  scene: Scene,
  shading: ShadingModel,
): MisregistrationArtifact {
  return measureMisregistration(physical, content, scene, {
    latitudesDeg: LATITUDES,
    sampleSpacingDeg: SPACING,
    shading,
  });
}

/**
 * Where a response crosses a threshold, by log-log interpolation between the two
 * bracketing sweep points.
 *
 * Log-log because the response is very close to a power law in the registration
 * error — the sweep measures the exponent rather than assuming it — and because a
 * linear interpolation between decade-spaced samples of a power law is wrong by tens
 * of percent. Returns `0` when the threshold is already exceeded at the smallest
 * error swept, and `Infinity` when it is not reached at the largest.
 */
export function thresholdCrossing(
  xs: readonly number[],
  ys: readonly number[],
  threshold: number,
): number {
  if (xs.length === 0) return NaN;
  if (ys[0] >= threshold) return 0;
  for (let i = 1; i < xs.length; i++) {
    if (ys[i] >= threshold) {
      const x0 = Math.log(xs[i - 1]);
      const x1 = Math.log(xs[i]);
      const y0 = Math.log(ys[i - 1]);
      const y1 = Math.log(ys[i]);
      if (!(y1 > y0)) return xs[i];
      const t = (Math.log(threshold) - y0) / (y1 - y0);
      return Math.exp(x0 + t * (x1 - x0));
    }
  }
  return Infinity;
}

/** Least-squares log-log slope of `ys` against `xs`, ignoring non-positive entries. */
export function logLogSlope(xs: readonly number[], ys: readonly number[]): number {
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > 0 && ys[i] > 0) {
      px.push(Math.log(xs[i]));
      py.push(Math.log(ys[i]));
    }
  }
  if (px.length < 2) return NaN;
  const mx = px.reduce((a, b) => a + b, 0) / px.length;
  const my = py.reduce((a, b) => a + b, 0) / py.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < px.length; i++) {
    num += (px[i] - mx) * (py[i] - my);
    den += (px[i] - mx) * (px[i] - mx);
  }
  return den > 0 ? num / den : NaN;
}

export interface RunOptions {
  /** Progress line per completed shape. */
  onProgress?: (message: string) => void;
}

export function runExperiment2(options: RunOptions = {}): Experiment2Result {
  const log = options.onProgress ?? ((): void => {});
  const cells: Experiment2Cell[] = [];
  const baselines: Experiment2Baseline[] = [];
  const contours: Experiment2Contour[] = [];

  for (const shape of RAMP_SHAPES) {
    for (const widthDeg of WIDTHS_DEG) {
      const built = buildModel({ w_width: widthDeg }, { rampShape: shape });
      const content = built.rig;
      const scene = built.scene;
      const shading = built.shading;

      const base = seamMetrics(content, content, scene, shading);
      baselines.push({
        shape,
        widthDeg,
        seamLuminance: base.luminance,
        seamChroma: base.chroma,
        seamEstimatorFloor: base.floor,
        profile: measureBlendProfile(content, scene, {
          latitudesDeg: LATITUDES,
          sampleSpacingDeg: SPACING,
          shading,
        }),
        scanByWindow: [
          { guardDeg: 1, windowDeg: 3, degree: 3 },
          { guardDeg: 2, windowDeg: 6, degree: 3 },
          { guardDeg: 4, windowDeg: 12, degree: 5 },
        ].map((step) => ({
          ...step,
          luminanceFraction: estimatorScan(content, content, scene, {
            latitudesDeg: LATITUDES,
            sampleSpacingDeg: SPACING,
            shading,
            step,
          }).luminanceFraction,
        })),
      });

      const luminances: number[] = [];
      const chromas: number[] = [];
      for (const mm of REGISTRATION_MM) {
        const epsilonDeg = epsilonForMm(mm, content.sphere.radiusM);
        const physical = misregisteredRig(content, epsilonDeg);
        const artifact = artifactOf(physical, content, scene, shading);
        const seams = seamMetrics(physical, content, scene, shading);
        luminances.push(artifact.luminanceFraction);
        chromas.push(artifact.chromaDeltaE);
        cells.push({
          shape,
          widthDeg,
          registrationMm: mm,
          epsilonDeg,
          misregLuminance: artifact.luminanceFraction,
          misregChroma: artifact.chromaDeltaE,
          blendResidual: artifact.blendResidual,
          fwhmDeg: artifact.fullWidthHalfMaxDeg,
          peakLatDeg: artifact.luminancePeak?.latDeg ?? NaN,
          peakLonDeg: artifact.luminancePeak?.lonDeg ?? NaN,
          peakIncidenceCos: artifact.luminancePeak?.incidenceCos ?? NaN,
          peakIncidenceCosWeighted: artifact.luminancePeak?.incidenceCosWeighted ?? NaN,
          seamLuminance: seams.luminance,
          seamChroma: seams.chroma,
          seamEstimatorFloor: seams.floor,
        });
      }

      contours.push({
        shape,
        widthDeg,
        luminanceToleranceMm: thresholdCrossing(REGISTRATION_MM, luminances, LUMINANCE_GATE),
        chromaToleranceMm: thresholdCrossing(REGISTRATION_MM, chromas, CHROMA_GATE),
        luminanceSlope: logLogSlope(REGISTRATION_MM, luminances),
      });
    }
    log(`experiment 2: ${shape} ramp done`);
  }

  // §4.5's gamma_blend is the one DOC-class photometric constant in PARAMETERS.md
  // and conventions.ts §B applies it to the WEIGHT, where normalization means it
  // cannot create a luminance step on its own. Swept here so that claim is measured
  // rather than asserted.
  const rampGammaSweep: Experiment2Result['rampGammaSweep'] = [];
  for (const rampGamma of [0.5, 0.8, 1.0, 1.5]) {
    const built = buildModel({ w_width: 20, gamma_blend: rampGamma });
    for (const mm of REGISTRATION_MM) {
      const physical = misregisteredRig(built.rig, epsilonForMm(mm, built.rig.sphere.radiusM));
      const artifact = artifactOf(physical, built.rig, built.scene, built.shading);
      rampGammaSweep.push({
        rampGamma,
        registrationMm: mm,
        misregLuminance: artifact.luminanceFraction,
        blendResidual: artifact.blendResidual,
      });
    }
  }
  log('experiment 2: gamma_blend sweep done');

  const realistic = runRealisticCrossCheck(cells);
  log('experiment 2: realistic-misalignment cross-check done');

  return {
    schema: 'sphere-sim/experiment-2@1',
    provisional: true,
    provisionalNote:
      'PROVISIONAL. Every photometric constant behind these numbers is class ASSUME and ' +
      'none has been measured (PARAMETERS.md §10, docs/ARCHITECTURE.md phase gate). The 2% ' +
      'and ΔE2000 1.0 lines are §7 gates on a DISCONTINUITY, shown here for scale against a ' +
      'BAND, which docs/AMENDMENTS.md A-15 argues needs a different threshold that only the ' +
      '§8 visit can supply.',
    generatedFrom: {
      widthsDeg: WIDTHS_DEG,
      registrationMm: REGISTRATION_MM,
      shapes: RAMP_SHAPES,
      rampGamma: 0.8,
      latitudesDeg: LATITUDES,
      sampleSpacingDeg: SPACING,
      projectorCount: 4,
    },
    baselines,
    cells,
    contours,
    rampGammaSweep,
    realistic,
    verdict: judge(cells, contours, baselines),
  };
}

/**
 * Does the canonical knob generalise?
 *
 * The sweep moves one thing: a pure across-seam displacement, equal at every seam.
 * A real installation is misaligned in eleven degrees of freedom at once, most of
 * which displace texels in directions a blend does not care about. So a handful of
 * seeded rigs from `sim/scene.ts`'s own `injectMisalignment` are measured the same
 * way, their registration error is read off `packages/sim`'s registration metric
 * rather than assumed, and the pair is reported next to what the canonical sweep
 * predicts at the same error. Canonical is the worst case; realistic should sit at or
 * below it, and if it sits above, the canonical knob is not the worst case and the
 * contour is optimistic.
 */
function runRealisticCrossCheck(cells: readonly Experiment2Cell[]): Experiment2Realistic[] {
  const out: Experiment2Realistic[] = [];
  for (const widthDeg of [10, 20, 40]) {
    const built = buildModel({ w_width: widthDeg });
    const content = built.rig;
    for (const scale of [0.25, 1, 4]) {
      for (const seed of [11, 22, 33]) {
        const physical = injectMisalignment(content, seed, {
          azimuthDeg: 0.75 * scale,
          distanceM: 0.03 * scale,
          heightM: 0.02 * scale,
          yawDeg: 0.3 * scale,
          pitchDeg: 0.3 * scale,
          rollDeg: 0.5 * scale,
          fovHDeg: 0.15 * scale,
          shiftH: 0.01 * scale,
          shiftV: 0.01 * scale,
          k1: 0.005 * scale,
          k2: 0.001 * scale,
          centerHeightM: 0.0254 * scale,
        }).rig;

        const registration = computeRegistration(
          physical,
          content,
          built.scene.maskInterpretation,
          null,
          { sampleCount: 4000, fieldWidth: 8, fieldHeight: 4, convergence: false },
        );
        const artifact = artifactOf(physical, content, built.scene, built.shading);
        const p95 = registration.overlap.p95;
        out.push({
          seed,
          scale,
          widthDeg,
          registrationRmsMm: registration.overlap.rms,
          registrationP95Mm: p95,
          registrationMaxMm: registration.overlap.max,
          misregLuminance: artifact.luminanceFraction,
          misregChroma: artifact.chromaDeltaE,
          canonicalAtP95: canonicalPrediction(cells, widthDeg, p95),
        });
      }
    }
  }
  return out;
}

/** The canonical sweep's `misregLuminance` at an arbitrary error, by log-log interpolation. */
function canonicalPrediction(
  cells: readonly Experiment2Cell[],
  widthDeg: number,
  errorMm: number,
): number {
  const column = cells
    .filter((c) => c.shape === 'cosine' && c.widthDeg === widthDeg)
    .sort((a, b) => a.registrationMm - b.registrationMm);
  if (column.length < 2 || !(errorMm > 0)) return NaN;
  const xs = column.map((c) => c.registrationMm);
  const ys = column.map((c) => c.misregLuminance);
  if (errorMm <= xs[0]) return ys[0] * (errorMm / xs[0]);
  for (let i = 1; i < xs.length; i++) {
    if (errorMm <= xs[i]) {
      const t = (Math.log(errorMm) - Math.log(xs[i - 1])) / (Math.log(xs[i]) - Math.log(xs[i - 1]));
      return Math.exp(Math.log(ys[i - 1]) + t * (Math.log(ys[i]) - Math.log(ys[i - 1])));
    }
  }
  return ys[ys.length - 1] * (errorMm / xs[xs.length - 1]);
}

/** The verdict, computed from the numbers rather than written by hand. */
function judge(
  cells: readonly Experiment2Cell[],
  contours: readonly Experiment2Contour[],
  baselines: readonly Experiment2Baseline[],
): Experiment2Verdict {
  const at = (shape: RampShape, widthDeg: number, mm: number): Experiment2Cell | undefined =>
    cells.find((c) => c.shape === shape && c.widthDeg === widthDeg && c.registrationMm === mm);

  // F1: monotonicity in width, checked at every registration error and every shape.
  let fallsWithWidth = true;
  for (const shape of RAMP_SHAPES) {
    for (const mm of REGISTRATION_MM) {
      let previous = Infinity;
      for (const widthDeg of WIDTHS_DEG) {
        const cell = at(shape, widthDeg, mm);
        if (cell === undefined) continue;
        // A 1% tolerance, because the peak is a max over a sampled field and can move
        // between two nearly equal maxima from one width to the next.
        if (cell.misregLuminance > previous * 1.01) fallsWithWidth = false;
        previous = cell.misregLuminance;
      }
    }
  }

  const toleranceAt = (widthDeg: number): number =>
    contours.find((c) => c.shape === 'cosine' && c.widthDeg === widthDeg)?.luminanceToleranceMm ?? NaN;
  const inferredGain = toleranceAt(40) / toleranceAt(5);
  const fullGain = toleranceAt(WIDTHS_DEG[WIDTHS_DEG.length - 1]) / toleranceAt(WIDTHS_DEG[0]);

  // F3: as the ramp widens, does the binding artifact move into §4.3's smear region?
  let staysOutOfGrazing = true;
  for (const shape of RAMP_SHAPES) {
    for (const widthDeg of WIDTHS_DEG) {
      if (widthDeg > 40) continue; // Outside A-04's inferred range; reported, not judged.
      const cell = at(shape, widthDeg, 16);
      if (cell === undefined) continue;
      if (cell.peakIncidenceCosWeighted < 0.2) staysOutOfGrazing = false;
    }
  }

  // F4 is a property of the estimator, not of the sweep: the reported statistic is a
  // point-for-point difference between two renders of one physical rig, with no
  // window and no polynomial in it. The windowed alternative is measured in every
  // baseline precisely so the difference between the two is on the record.
  const scanSpread = baselines
    .filter((b) => b.shape === 'cosine')
    .map((b) => {
      const values = b.scanByWindow.map((s) => s.luminanceFraction).filter((v) => v > 0);
      return values.length > 1 ? Math.max(...values) / Math.min(...values) : 1;
    });
  const worstScanSpread = scanSpread.length > 0 ? Math.max(...scanSpread) : 1;

  const gainIsUsable = inferredGain >= 2;
  const holds = fallsWithWidth && gainIsUsable && staysOutOfGrazing;

  return {
    toleranceGainOverInferredRange: inferredGain,
    toleranceGainOverFullSweep: fullGain,
    fallsWithWidth,
    gainIsUsable,
    staysOutOfGrazing,
    estimatorIsScaleFree: true,
    holds,
    statement: holds
      ? `HOLDS, provisionally. Over w_width's inferred 5-40 degree range the registration ` +
        `error a 2% artifact tolerates rises by ${inferredGain.toFixed(2)}x. The windowed ` +
        `alternative estimator, reported in every baseline, spans ${worstScanSpread.toFixed(1)}x ` +
        `across three window choices and is why the verdict does not rest on it.`
      : `DOES NOT HOLD as stated: falls-with-width=${fallsWithWidth}, ` +
        `gain=${inferredGain.toFixed(2)}x, stays-out-of-grazing=${staysOutOfGrazing}.`,
  };
}
