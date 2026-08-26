// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * How Experiment 2 measures a seam artifact, and the two estimators it rejected on
 * the way to the one it uses.
 *
 * ## The problem, stated once
 *
 * PARAMETERS.md §7 gates a seam DISCONTINUITY and `packages/sim` measures exactly
 * that, at the longitude where two projectors hand over. On this rig that estimator
 * cannot see a misregistration at all, and the reason is geometric rather than
 * statistical. `coverage.ts` anchors each projector's ramp at its own footprint edge,
 * so at §4.5's nominal 20-degree width both projectors' raw weights are clamped at 1
 * across a 31-degree plateau in the middle of the overlap and the hand-over sits in
 * the middle of that plateau. Both normalized weights are 0.5 there, and 0.5 stays
 * 0.5 when you displace it: the derivative of a constant is zero, so no
 * misregistration of any size produces a step at the place the gate looks. The
 * artifact lives in the two ramp bands 15 to 25 degrees either side — outside the
 * estimator's entire window. Measured: a 16 mm misregistration moves §7's seam
 * luminance reading from 1.37e-3 to 1.76e-3, against a 2e-2 gate and a 2.2e-3
 * estimator noise floor, while the field carries a 5.2% band.
 *
 * ## Estimator 1, rejected: point §7's estimator at the whole overlap
 *
 * The obvious fix is to slide the same trend-subtraction estimator along the whole
 * overlap and take the worst window. {@link estimatorScan} does that, and it produces
 * a beautiful result — 14.3% at a 10-degree ramp falling to 0.41% at a 71-degree one
 * — which is why it is in this file with its own falsification attached rather than
 * in the finding. **The reading is not scale-free.** On the same rig at perfect
 * registration:
 *
 * | ramp width | (guard 1, window 3, deg 3) | (2, 6, 3) — §7's own | (4, 12, 5) |
 * | --- | --- | --- | --- |
 * | 10 deg | 3.1% | 14.3% | 56.0% |
 * | 20 deg | 0.7% | 2.6% | 14.2% |
 * | 40 deg | 0.2% | 0.6% | 3.8% |
 *
 * A factor of eighteen between the narrowest and widest window. That is the
 * signature of an estimator measuring CURVATURE rather than a step: the departure of
 * a smooth function from a degree-`d` polynomial over a window `W` scales as
 * `W^(d+1)`, so any window choice yields a different "percentage" and none of them is
 * the artifact's size. §7's window was chosen (and validated by its control) for a
 * field that is locally smooth with a possible step in it; the ramp band is neither.
 * Quoting a scale-dependent number against §7's 2% gate would be inventing a
 * verdict. This is docs/AMENDMENTS.md A-15's point arriving from the geometric side:
 * a band needs a threshold with a spatial frequency in it, and that is a
 * psychophysical measurement PARAMETERS.md §8 has to supply.
 *
 * ## Estimator 2, rejected: difference against the nominal rig
 *
 * Render the misregistered rig and the NOMINAL rig and subtract. Wrong, and
 * quietly so: those are two different PHYSICAL rigs, so the difference contains the
 * change in incidence and distance from having moved the lenses, which at the ramp
 * band is about 1.4% before any blend error at all. It reports a floor that is not
 * an artifact.
 *
 * ## The estimator used: the same physical rig, calibrated and not
 *
 * {@link measureMisregistration} renders one physical rig twice: once with the
 * compositor holding the content calibration it actually has, and once with the
 * compositor holding the truth. Same lenses, same incidence, same falloff, same
 * transfer, same shading, same everything — the ONLY difference is what the software
 * believed, which is the definition of a registration error. The difference is
 * therefore exactly the artifact recalibration would remove, it is zero by
 * construction when the two calibrations agree, and it needs no window, no
 * polynomial and no scale.
 *
 * It is a differential between two simulations, which no photograph can produce.
 * That puts it in the same class as `metrics/photometric.ts`'s divergence readings,
 * and it gets the same treatment: reported, never scored, PROVISIONAL, and quoted
 * beside §7's gate for scale rather than against it.
 */

import type { ChannelTriplet, RigCalibration } from '../../../calibration/src/index.ts';
import type { FieldSample, Scene, ShadingModel, StepOptions, Vec3 } from '../../../sim/src/index.ts';
import {
  DEFAULT_STEP,
  deltaE2000,
  equalAreaLattice,
  estimateStep,
  latLonToWorld,
  linearRgbToLab,
  makeFieldSampler,
  polarMask,
  prepareRig,
} from '../../../sim/src/index.ts';

const DEG2RAD = Math.PI / 180;

/** PARAMETERS.md §4.3's usability threshold: below this, "the image becomes streaks". */
export const SMEAR_INCIDENCE_COS = 0.2;

export interface TrackOptions {
  /**
   * Latitudes to walk. Default `[-50, -25, 0, 25, 50]` — the same five
   * `metrics/photometric.ts` crosses each seam at, so the readings are taken on the
   * same tracks and any difference between them is the estimator and nothing else.
   */
  latitudesDeg?: number[];
  /** Arc spacing along a track, degrees. Default 0.25, as §7's metric. */
  sampleSpacingDeg?: number;
  /** Flat content level, LINEAR. Default 0.5 — §8 item 13's mid-gray. */
  level?: number;
  shading?: ShadingModel;
  /** Lab reference white. Defaults to `scene.reflectance`, as §7's metric does. */
  whiteRgb?: ChannelTriplet;
}

/** One point on a walked parallel, with both calibrations evaluated at it. */
interface WalkPoint {
  latDeg: number;
  lonDeg: number;
  /** Arc distance along the parallel from its start, degrees. */
  s: number;
  actual: FieldSample;
}

/**
 * Walk every parallel in `latitudesDeg` at a uniform ARC spacing, keeping the points
 * that are unmasked and reached by at least `minContributors` projectors.
 *
 * Arc rather than longitude because every threshold in this file is stated in
 * degrees of arc on the sphere surface, and a degree of longitude is only a degree of
 * arc at the equator — at latitude 50 it is 0.64 of one.
 */
function walk(
  sample: (point: Vec3) => FieldSample,
  radiusM: number,
  blend: RigCalibration['blend'],
  maskInterpretation: Scene['maskInterpretation'],
  options: TrackOptions,
  minContributors: number,
): WalkPoint[] {
  const latitudes = options.latitudesDeg ?? [-50, -25, 0, 25, 50];
  const spacing = options.sampleSpacingDeg ?? 0.25;
  const out: WalkPoint[] = [];
  for (const latDeg of latitudes) {
    const cosLat = Math.cos(latDeg * DEG2RAD);
    if (!(cosLat > 1e-6)) continue;
    if (polarMask(latDeg, blend, maskInterpretation) <= 0) continue;
    const lonStep = spacing / cosLat;
    for (let lonDeg = -180; lonDeg < 180 - 1e-9; lonDeg += lonStep) {
      const point = latLonToWorld(latDeg, lonDeg, radiusM);
      const actual = sample(point);
      if (actual.mask <= 0) continue;
      if (actual.contributors < minContributors) continue;
      out.push({ latDeg, lonDeg, s: (lonDeg + 180) * cosLat, actual });
    }
  }
  return out;
}

export interface ArtifactPeak {
  latDeg: number;
  lonDeg: number;
  /** `|Y_actual - Y_ideal| / Y_ideal` at this point. */
  luminanceFraction: number;
  deltaE: number;
  /** `sum(weights) - 1` at this point: the blend arithmetic, with no optics in it. */
  weightError: number;
  /** Best available `cos(incidence)` — how oblique the geometry is here at all. */
  incidenceCos: number;
  /** Delivered-light-weighted `cos(incidence)` — how oblique the light actually is. */
  incidenceCosWeighted: number;
}

export interface MisregistrationArtifact {
  /** Max over the walked overlap of `|Y_actual - Y_ideal| / Y_ideal`. Not a gate. */
  luminanceFraction: number;
  /** Max over the same points of ΔE2000 between the two renders. Not a gate. */
  chromaDeltaE: number;
  /**
   * Max over the same points of `|sum of applied blend weights - 1|` — the artifact
   * in pure blend arithmetic, with no optics, no transfer and no shading in it.
   * Exactly zero on a registered rig at any width and any shape.
   */
  blendResidual: number;
  luminancePeak: ArtifactPeak | null;
  chromaPeak: ArtifactPeak | null;
  /**
   * Arc width, degrees, of the contiguous run around the luminance peak where the
   * artifact exceeds half its peak value, measured on the peak's own parallel.
   *
   * Reported because amplitude alone cannot say whether an artifact is visible: a
   * 2% departure spread over 40 degrees of arc and a 2% step are the same number and
   * not the same thing to an eye. §7's gate is for the second; this experiment
   * produces the first; PARAMETERS.md §8 is what would supply a threshold that knows
   * the difference. `NaN` when the run reaches the edge of the overlap.
   */
  fullWidthHalfMaxDeg: number;
  overlapSamples: number;
}

/**
 * The misregistration artifact: one physical rig rendered twice, once with the
 * content calibration it has and once with the truth.
 *
 * See the module note for why this comparison and not either of the two obvious
 * ones. `contentRig` is what the compositor believes; `physicalRig` is where the
 * lenses are. Passing the same object gives exactly zero, at any ramp width and any
 * shape, which `test/artifact.test.ts` pins.
 */
export function measureMisregistration(
  physicalRig: RigCalibration,
  contentRig: RigCalibration,
  scene: Scene,
  options: TrackOptions = {},
): MisregistrationArtifact {
  const whiteRgb = options.whiteRgb ?? scene.reflectance;
  const actualSampler = makeFieldSampler(physicalRig, scene, {
    contentRig,
    shading: options.shading,
    level: options.level ?? 0.5,
  });
  const idealSampler = makeFieldSampler(physicalRig, scene, {
    contentRig: physicalRig,
    shading: options.shading,
    level: options.level ?? 0.5,
  });

  const points = walk(
    actualSampler,
    physicalRig.sphere.radiusM,
    contentRig.blend,
    scene.maskInterpretation,
    options,
    2,
  );

  const perPoint: { p: WalkPoint; fraction: number; deltaE: number }[] = [];
  let luminancePeak: ArtifactPeak | null = null;
  let chromaPeak: ArtifactPeak | null = null;
  let blendResidual = 0;

  for (const p of points) {
    const ideal = idealSampler(latLonToWorld(p.latDeg, p.lonDeg, physicalRig.sphere.radiusM));
    if (!(ideal.luminance > 0)) continue;
    const fraction = Math.abs(p.actual.luminance - ideal.luminance) / ideal.luminance;
    const deltaE = deltaE2000(
      linearRgbToLab(p.actual.rgb, whiteRgb),
      linearRgbToLab(ideal.rgb, whiteRgb),
    );
    perPoint.push({ p, fraction, deltaE });

    const residual = Math.abs(p.actual.weightSum - 1);
    if (residual > blendResidual) blendResidual = residual;

    const peak: ArtifactPeak = {
      latDeg: p.latDeg,
      lonDeg: p.lonDeg,
      luminanceFraction: fraction,
      deltaE,
      weightError: p.actual.weightSum - 1,
      incidenceCos: p.actual.bestIncidenceCos,
      incidenceCosWeighted: p.actual.incidenceCosWeighted,
    };
    if (luminancePeak === null || fraction > luminancePeak.luminanceFraction) luminancePeak = peak;
    if (chromaPeak === null || deltaE > chromaPeak.deltaE) chromaPeak = { ...peak };
  }

  return {
    luminanceFraction: luminancePeak === null ? 0 : luminancePeak.luminanceFraction,
    chromaDeltaE: chromaPeak === null ? 0 : chromaPeak.deltaE,
    blendResidual,
    luminancePeak,
    chromaPeak,
    fullWidthHalfMaxDeg: halfMaxWidth(perPoint, luminancePeak, options.sampleSpacingDeg ?? 0.25),
    overlapSamples: perPoint.length,
  };
}

/**
 * Arc width of the contiguous above-half-peak run containing the peak.
 *
 * Contiguity is checked in arc, not by array index: a parallel carries several
 * disjoint overlaps, and walking off the end of one into the next would report the
 * gap between two seams as the width of one artifact.
 */
function halfMaxWidth(
  perPoint: readonly { p: WalkPoint; fraction: number }[],
  peak: ArtifactPeak | null,
  spacingDeg: number,
): number {
  if (peak === null || !(peak.luminanceFraction > 0)) return NaN;
  const onTrack = perPoint.filter((x) => x.p.latDeg === peak.latDeg).sort((a, b) => a.p.s - b.p.s);
  const at = onTrack.findIndex((x) => x.p.lonDeg === peak.lonDeg);
  if (at < 0) return NaN;
  const half = peak.luminanceFraction / 2;
  const adjacent = (i: number, j: number): boolean =>
    Math.abs(onTrack[i].p.s - onTrack[j].p.s) <= spacingDeg * 1.5;
  let lo = at;
  let hi = at;
  while (lo > 0 && adjacent(lo, lo - 1) && onTrack[lo - 1].fraction >= half) lo--;
  while (hi < onTrack.length - 1 && adjacent(hi, hi + 1) && onTrack[hi + 1].fraction >= half) hi++;
  // A run that reaches the edge of its own overlap is a lower bound, not a width,
  // and saying NaN is better than quoting the sampling extent as a result.
  if (lo === 0 || hi === onTrack.length - 1) return NaN;
  if (!adjacent(lo, lo - 1) || !adjacent(hi, hi + 1)) return NaN;
  return onTrack[hi].p.s - onTrack[lo].p.s;
}

// ---------------------------------------------------------------------------
// What the blend does on its own, at perfect registration
// ---------------------------------------------------------------------------

export interface BlendProfile {
  /**
   * Steepest fractional luminance gradient anywhere on the walked parallels,
   * `|d ln Y / ds|` per degree of arc.
   *
   * The hand-over on a sphere is not free: at the ramp band the blend is trading
   * light from a projector that is nearly head-on for light from one that is at its
   * own limb, and the delivered luminance falls by about 43% across the overlap
   * whatever the blend does. What the ramp width sets is how ABRUPTLY. A derivative
   * is the scale-free way to say that — unlike the windowed statistic
   * {@link estimatorScan} produces, it does not depend on anybody's choice of window.
   */
  maxLogGradientPerDeg: number;
  maxLogGradientLatDeg: number;
  maxLogGradientLonDeg: number;
  /** Max over min luminance along the walked parallels. Geometry, not blend. */
  dynamicRange: number;
  /**
   * Area fraction of the unmasked lit sphere whose DELIVERED light arrives at a mean
   * `cos(incidence)` below §4.3's 0.2 — where "resolution smear exceeds 5x and the
   * image becomes streaks".
   */
  smearedAreaFraction: number;
  /**
   * The same computed from each point's BEST projector, which is what §4.3's own
   * arithmetic assumes and is independent of the blend. The gap between the two is
   * the sharpness the blend is spending.
   */
  smearedAreaFractionBest: number;
  /** Area-weighted mean of `bestIncidenceCos - incidenceCosWeighted` over the lit sphere. */
  meanIncidenceLoss: number;
  latticeSamples: number;
}

/**
 * What the blend costs at perfect registration: how steep its hand-over is, and how
 * much of the sphere it hands to a projector that cannot resolve it.
 */
export function measureBlendProfile(
  rig: RigCalibration,
  scene: Scene,
  options: TrackOptions & { latticeCount?: number } = {},
): BlendProfile {
  const sampler = makeFieldSampler(rig, scene, {
    shading: options.shading,
    level: options.level ?? 0.5,
  });
  const points = walk(
    sampler,
    rig.sphere.radiusM,
    rig.blend,
    scene.maskInterpretation,
    options,
    1,
  );

  let maxGradient = 0;
  let maxLatDeg = NaN;
  let maxLonDeg = NaN;
  let minY = Infinity;
  let maxY = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.latDeg !== b.latDeg) continue;
    if (b.actual.contributors < 2 && a.actual.contributors < 2) continue;
    const ds = b.s - a.s;
    if (!(ds > 0)) continue;
    if (!(a.actual.luminance > 0) || !(b.actual.luminance > 0)) continue;
    const g = Math.abs(Math.log(b.actual.luminance / a.actual.luminance)) / ds;
    if (g > maxGradient) {
      maxGradient = g;
      maxLatDeg = b.latDeg;
      maxLonDeg = b.lonDeg;
    }
    if (b.actual.luminance < minY) minY = b.actual.luminance;
    if (b.actual.luminance > maxY) maxY = b.actual.luminance;
  }

  const count = options.latticeCount ?? 4000;
  const lattice = equalAreaLattice(count);
  const prepared = prepareRig(rig);
  let lit = 0;
  let smeared = 0;
  let smearedBest = 0;
  let lossSum = 0;
  for (const s of lattice) {
    const f = sampler(latLonToWorld(s.latDeg, s.lonDeg, prepared.radiusM));
    if (f.mask <= 0 || f.contributors < 1) continue;
    lit++;
    if (f.incidenceCosWeighted < SMEAR_INCIDENCE_COS) smeared++;
    if (f.bestIncidenceCos < SMEAR_INCIDENCE_COS) smearedBest++;
    if (Number.isFinite(f.incidenceCosWeighted)) {
      lossSum += f.bestIncidenceCos - f.incidenceCosWeighted;
    }
  }

  return {
    maxLogGradientPerDeg: maxGradient,
    maxLogGradientLatDeg: maxLatDeg,
    maxLogGradientLonDeg: maxLonDeg,
    dynamicRange: minY > 0 && Number.isFinite(minY) ? maxY / minY : NaN,
    smearedAreaFraction: lit > 0 ? smeared / lit : NaN,
    smearedAreaFractionBest: lit > 0 ? smearedBest / lit : NaN,
    meanIncidenceLoss: lit > 0 ? lossSum / lit : NaN,
    latticeSamples: lit,
  };
}

// ---------------------------------------------------------------------------
// The rejected estimator, kept so the rejection is reproducible
// ---------------------------------------------------------------------------

export interface EstimatorScanResult {
  /** Max over every window of §7's seam-luminance statistic. SCALE-DEPENDENT. */
  luminanceFraction: number;
  latDeg: number;
  lonDeg: number;
  windows: number;
  step: Required<StepOptions>;
}

/**
 * §7's seam estimator slid along every walked parallel instead of evaluated at the
 * hand-over.
 *
 * **Do not quote this against §7's 2% gate.** It is here so the module note's table
 * can be regenerated: run it at several `(guardDeg, windowDeg, degree)` triples and
 * watch the answer move by a factor of eighteen, which is what disqualified it.
 */
export function estimatorScan(
  physicalRig: RigCalibration,
  contentRig: RigCalibration,
  scene: Scene,
  options: TrackOptions & { step?: StepOptions; centreStrideDeg?: number } = {},
): EstimatorScanResult {
  const guardDeg = options.step?.guardDeg ?? DEFAULT_STEP.guardDeg;
  const windowDeg = options.step?.windowDeg ?? DEFAULT_STEP.windowDeg;
  const degree = options.step?.degree ?? DEFAULT_STEP.degree;
  const stride = options.centreStrideDeg ?? 0.5;

  const sampler = makeFieldSampler(physicalRig, scene, {
    contentRig,
    shading: options.shading,
    level: options.level ?? 0.5,
  });
  const points = walk(
    sampler,
    physicalRig.sphere.radiusM,
    contentRig.blend,
    scene.maskInterpretation,
    options,
    2,
  );

  let best = 0;
  let latDeg = NaN;
  let lonDeg = NaN;
  let windows = 0;
  const byLat = new Map<number, WalkPoint[]>();
  for (const p of points) {
    const list = byLat.get(p.latDeg);
    if (list === undefined) byLat.set(p.latDeg, [p]);
    else list.push(p);
  }

  for (const list of byLat.values()) {
    // Contiguity matters: a parallel carries several disjoint overlaps, and a window
    // spanning the gap between two of them would fit a trend across a region the
    // field never occupied.
    const runs: WalkPoint[][] = [];
    let run: WalkPoint[] = [];
    const spacing = options.sampleSpacingDeg ?? 0.25;
    for (const p of list) {
      if (run.length > 0 && p.s - run[run.length - 1].s > spacing * 1.5) {
        runs.push(run);
        run = [];
      }
      run.push(p);
    }
    if (run.length > 0) runs.push(run);

    for (const segment of runs) {
      if (segment.length < 2) continue;
      const span = segment[segment.length - 1].s - segment[0].s;
      if (!(span > 2 * windowDeg)) continue;
      for (
        let centre = segment[0].s + windowDeg;
        centre <= segment[segment.length - 1].s - windowDeg + 1e-9;
        centre += stride
      ) {
        const win = segment.filter((q) => Math.abs(q.s - centre) <= windowDeg + 1e-9);
        const est = estimateStep(
          win.map((q) => ({ s: q.s - centre, value: q.actual.luminance })),
          { guardDeg, windowDeg, degree },
        );
        if (est === null) continue;
        windows++;
        if (est.fraction > best) {
          best = est.fraction;
          let nearest = win[0];
          for (const q of win) {
            if (Math.abs(q.s - centre) < Math.abs(nearest.s - centre)) nearest = q;
          }
          latDeg = nearest.latDeg;
          lonDeg = nearest.lonDeg;
        }
      }
    }
  }

  return {
    luminanceFraction: best,
    latDeg,
    lonDeg,
    windows,
    step: { guardDeg, windowDeg, degree },
  };
}
