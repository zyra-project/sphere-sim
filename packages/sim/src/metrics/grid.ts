// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Grid-line displacement across a blend region — the metric PARAMETERS.md §7
 * gates at 1.0 mm, and the one that corresponds to what an operator judges
 * during SOS Grid Alignment.
 *
 * ## What the operator sees, and what this reproduces
 *
 * PARAMETERS.md §1's note describes the failure directly: "vertical grid lines
 * diverge or crisscross in the overlap regions near the poles". Two projectors
 * are each drawing the same meridian; if their calibrations disagree, each puts
 * its copy of that line in a slightly different place, and in the overlap the
 * operator sees two lines instead of one. This module measures the gap between
 * those two copies, in millimetres of arc on the sphere.
 *
 * Note what is being compared. It is NOT the brightness profile of the blended
 * result — that is a photometric question, and scoring it would make a geometric
 * number depend on `w_width` and `gamma_blend`, both ASSUME-class (§4.5). It is
 * each projector's own copy of the line, localised independently in its own
 * raster, exactly as an operator does by turning one projector off and then the
 * other.
 *
 * ## Why sub-pixel localisation is not optional
 *
 * A projector pixel is about 1.3 mm across on the sphere at normal incidence
 * (34 degrees of horizontal field over 1920 pixels, at `d - R` = 4.32 m), and
 * several millimetres at the grazing incidence of a polar seam. The gate is
 * 1.0 mm. **The gate is finer than one projector pixel.** A localisation that
 * rounded to the nearest pixel could not distinguish a passing rig from one
 * failing by a factor of two.
 *
 * So each line is localised by the midpoint of its two half-height crossings,
 * scanned along the sphere surface perpendicular to the line. {@link localiseLine}
 * explains why that estimator and not the obvious intensity centroid. Measured
 * on the aligned nominal rig, where the true answer is zero, this reports a
 * worst case of 0.066 mm — under a tenth of the gate — against 0.54 mm for a
 * centroid.
 *
 * ## The pipeline this runs through
 *
 * For each projector, lazily:
 *
 *   1. CONTENT. Pixel centre `(i+0.5, j+0.5)` -> ray through the CONTENT
 *      calibration -> sphere -> texture coordinate -> graticule value. This is
 *      what the compositor writes into that pixel.
 *   2. PHYSICS. A surface point -> pixel coordinate through the PHYSICAL
 *      calibration -> bilinear reconstruction over the four surrounding pixel
 *      CENTRES of step 1.
 *
 * Step 1 area-averages over a sub-pixel grid, and step 2's reconstruction is
 * what a real projector does with its pixel grid; between them they are the only
 * quantization in the chain. The pattern itself is evaluated analytically
 * (`graticuleCoverage`, shared with the rasterizer in `equirect.ts`) rather than
 * sampled from a baked texture, so the measured displacement is a property of
 * the RIG and not of whatever resolution somebody chose for a source image.
 *
 * ## The metric's graticule is softer and fatter than the display one
 *
 * `gridAlignmentPattern`'s defaults draw a crisp line with a narrow
 * antialiasing skirt, which is what an operator wants to look at. This metric
 * asks for a 3-degree line with a fully triangular profile — no plateau, both
 * edges one long linear ramp. That is not cosmetic. The localiser's guarantee
 * requires the edge ramp to be RESOLVED by the projector, and at the grazing
 * incidence of a polar seam a projector pixel covers about 6 mm of sphere,
 * so a display-default ramp of 2 mm is a sub-pixel feature and the guarantee
 * evaporates. Widening the ramp to 22 mm restores it: the same rig measures
 * 0.51 mm with the display profile and 0.066 mm with this one, and the true
 * answer is zero. The line is a measuring instrument here, not content.
 *
 * ## Where the metric refuses to measure
 *
 * A measurement is taken only where BOTH projectors carry real blend weight AND
 * both see the point at `cos(incidence) >= 0.2` — PARAMETERS.md §4.3's own
 * usability threshold, "where resolution smear exceeds 5x and the image becomes
 * streaks". A line that has become streaks has no position to localise, and
 * admitting those points does real damage: the answer starts depending on which
 * sub-pixel phase the line happens to land on, so the apparatus floor swings
 * between 0.07 mm and 2.5 mm under a 2 mm lens shift that changed nothing else
 * about the geometry. With the cut in place the floor is 0.044 mm on the nominal
 * rig and stays under 0.06 mm across twelve independently perturbed ones. The
 * region it excludes is one §4.4 argues the bottom mask exists to hide anyway.
 *
 * ## Why the graticule is 45 degrees
 *
 * Two reasons, and the first one is not aesthetic. A 45-degree graticule on a
 * four-projector rig puts a meridian exactly on every SEAM (+/-45, +/-135) and
 * exactly on every projector's own meridian (0, +/-90, 180). On the seam the two
 * projectors view the line symmetrically, so both reach their best possible
 * incidence for a shared point at that latitude — which is what lets the
 * measurement follow the blend region up to latitude 56, stopping just short of
 * §4.3's seam-direction usable limit of 59.6 and of the 60-degree mask onset. A
 * 30-degree graticule has no line within 15 degrees of a seam, the far projector
 * is correspondingly more oblique, and the incidence rule above cuts the
 * measurement off at latitude 44 — losing precisely the polar overlap §1's note
 * is about.
 *
 * Second, meridians converge toward the poles: at latitude 80 a 15-degree
 * graticule puts neighbouring lines only 2.6 degrees of surface arc apart,
 * narrower than the scan window. Coarse spacing keeps them resolvable. The
 * measurement refuses rather than guesses when lines crowd the window, and every
 * refusal is counted in {@link GridReport.rejected} rather than quietly dropped.
 */

import type { RigCalibration } from '../../../calibration/src/index.ts';
import type { Vec3 } from '../vec.ts';
import { DEG2RAD } from '../vec.ts';
import { worldLonToTextureLon } from '../geometry.ts';
import { graticuleCoverage } from '../equirect.ts';
import type { PreparedRig } from '../optics.ts';
import { pixelToRay, prepareRig, worldToPixel } from '../optics.ts';
import type { MaskInterpretation } from '../coverage.ts';
import { coverageAndWeights, incidenceCosineAt, isIlluminatedAt, polarMask } from '../coverage.ts';
import type { ConvergenceReport, MetricGate, MetricResult, SamplingReport } from './types.ts';
import { convergenceOf, makeMetric } from './types.ts';
import type { Stats } from './sampling.ts';
import { summarise } from './sampling.ts';

export type LineOrientation = 'meridian' | 'parallel';

export interface GridOptions {
  /** Degrees between graticule lines. See the module note on why 45. */
  spacingDeg?: number;
  /** Line width in degrees of arc on the sphere. */
  lineWidthDeg?: number;
  /** Latitude step for meridian measurements, degrees. */
  latStepDeg?: number;
  /** Latitude range for meridian measurements, degrees. */
  latMinDeg?: number;
  latMaxDeg?: number;
  /** Longitude offsets from each seam at which parallels are measured. */
  seamOffsetsDeg?: number[];
  /** Samples across each line profile. Odd, so the nominal centre is sampled. */
  profileSamples?: number;
  /**
   * Sub-pixel grid used to area-average the pattern into each projector pixel,
   * per axis. See {@link lazyRaster} — this is what makes sub-pixel localisation
   * work at all, and 1 (point sampling) is a demonstrably wrong answer.
   */
  contentSupersample?: number;
  /**
   * Fraction of each line's half-width that is edge ramp rather than plateau.
   * See {@link localiseLine} — the localiser needs a RESOLVED linear ramp, and
   * `equirect.ts`'s display default of 0.2 puts the whole ramp inside a pixel or
   * two at grazing incidence.
   */
  lineFeatherFrac?: number;
  /**
   * Both projectors must carry at least this normalized blend weight for the
   * point to count as inside the blend region. Below it, one projector's copy of
   * the line is too faint to be part of what an operator judges.
   */
  minWeight?: number;
  /**
   * Both projectors must reach at least this `cos(incidence)`. PARAMETERS.md
   * §4.3's own usability threshold; see the rejection site for why it is load
   * bearing rather than cosmetic.
   */
  minIncidenceCos?: number;
  convergence?: boolean;
  /**
   * Internal. Set false on the self-calibration pass that establishes
   * {@link GridReport.measurementFloorMm}, so the pass does not recurse.
   */
  measurementFloor?: boolean;
}

/** One localised line, seen by two projectors. */
export interface GridMeasurement {
  projectorA: number;
  projectorB: number;
  orientation: LineOrientation;
  /** Longitude of the meridian, or latitude of the parallel, degrees. */
  lineDeg: number;
  /** Where along the line the profile was scanned. */
  latDeg: number;
  lonDeg: number;
  /** Each projector's localised line centre, mm of arc from the nominal position. */
  offsetAMm: number;
  offsetBMm: number;
  /** `|offsetA - offsetB|`, the discontinuity an operator sees. */
  displacementMm: number;
  weightA: number;
  weightB: number;
  maskValue: number;
}

/** Why candidate measurements were dropped. Reported, never silent. */
export interface GridRejections {
  notInBlendRegion: number;
  /** One projector sees this point below §4.3's cos(incidence) = 0.2 line. */
  incidenceTooGrazing: number;
  linesTooCrowded: number;
  /** The scan window could not be made to fit inside both projectors' coverage. */
  windowDoesNotFit: number;
  profileNotLocalisable: number;
  /**
   * A projector's copy of the line was displaced further than the scan window
   * could measure.
   *
   * The one rejection that CORRELATES with the quantity being measured, which is
   * why it is counted apart from {@link GridRejections.profileNotLocalisable}: a
   * maximum taken after dropping these has dropped the largest values, and any
   * non-zero count here makes the reported value a lower bound rather than a
   * worst case. {@link MakeMetricInput.censored} carries that to the verdict.
   */
  displacedBeyondWindow: number;
}

export interface GridReport {
  measurements: GridMeasurement[];
  all: Stats;
  meridians: Stats;
  parallels: Stats;
  worst: GridMeasurement | null;
  rejected: GridRejections;
  /** Seam longitudes derived from the PHYSICAL lens azimuths, degrees. */
  seamLonsDeg: number[];
  /**
   * The apparatus's own floor: this same measurement run on a rig whose content
   * calibration IS its physical one, so any displacement it finds is the
   * measurement, not the rig. Nothing below this is meaningful. See the note on
   * {@link GridReport.metric} — it is reported, never subtracted.
   */
  measurementFloorMm: number;
  metric: MetricResult;
  sampling: SamplingReport;
}

const MM_PER_M = 1000;

/** A projector's framebuffer content, evaluated on demand and cached. */
interface LazyRaster {
  /** Bilinear reconstruction at a fractional pixel coordinate, or `NaN`. */
  value(u: number, v: number): number;
  /** Pixels actually evaluated, for the cost report. */
  evaluated(): number;
}

/**
 * Build a lazy raster for one projector.
 *
 * Rendering all four 1920x1080 rasters to measure a few hundred line profiles
 * would be eight million rays for a few thousand pixels' worth of answer. The
 * pipeline is identical either way — this evaluates it lazily, so the metric
 * costs what it uses. A plain closure rather than a class because nothing else
 * in this package is a class and the toolchain forbids parameter properties.
 *
 * ## Each pixel is an AREA AVERAGE, and that is load-bearing
 *
 * One sample per pixel centre is the obvious implementation and it destroys the
 * metric. Sub-pixel line localisation works because an antialiased line encodes
 * its position in the grey levels of the pixels it partially covers; a point
 * sample throws that information away and quantises the recovered line position
 * to the pixel grid. At the grazing incidence of a polar seam a projector pixel
 * covers several millimetres of sphere, so a perfectly aligned rig measured that
 * way reports up to 2 mm of displacement — twice the gate — purely as a
 * rasterization artifact. Measured, not guessed: with `contentSupersample = 1`
 * the aligned rig scores 1.996 mm, and with a 4x4 box it scores under 0.01 mm.
 *
 * There is theory behind the size of that improvement. A box prefilter exactly
 * one pixel wide has zeros in its transfer function at every multiple of the
 * sampling frequency, so it annihilates the aliasing terms that shift a discrete
 * centroid. Point sampling has no such prefilter and all of them survive.
 *
 * A regular sub-pixel grid rather than the jittered Halton set `render.ts` uses
 * for supersampling: the tracer wants decorrelated noise so edges do not moire,
 * but a metric wants a clean box filter and no noise at all, because here the
 * noise would land directly on the number being gated.
 */
function lazyRaster(
  content: PreparedRig,
  index: number,
  spacingDeg: number,
  lineWidthDeg: number,
  featherFrac: number,
  supersample: number,
): LazyRaster {
  const cache = new Map<number, number>();
  const proj = content.projectors[index];
  const it = proj.cal.intrinsics;
  const sub = Math.max(1, Math.floor(supersample));
  const subCount = sub * sub;

  /** The pattern value along one ray out of the lens. */
  const sampleAt = (u: number, v: number): number => {
    const surface = content.surface.intersect(proj.lens, pixelToRay(proj, u, v));
    if (surface === null) return 0;
    const ll = content.surface.coordAt(surface.point);
    const texLon = worldLonToTextureLon(ll.lonDeg, content.rotationOffsetDeg);
    // emphasizeAxes off: the doubled-width equator and prime meridian have a
    // different profile from the rest of the graticule, and near longitude 0 the
    // emphasized line merges with the graticule line, giving the centroid two
    // peaks to average.
    return graticuleCoverage(ll.latDeg, texLon, spacingDeg, lineWidthDeg, false, featherFrac);
  };

  const pixel = (i: number, j: number): number => {
    const key = j * 65536 + i;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let acc = 0;
    // conventions.ts §I: pixel centres sit at half-integer coordinates, so with
    // sub = 1 this is exactly (i + 0.5, j + 0.5) and the box degenerates to the
    // pixel centre.
    for (let sy = 0; sy < sub; sy++) {
      for (let sx = 0; sx < sub; sx++) {
        acc += sampleAt(i + (sx + 0.5) / sub, j + (sy + 0.5) / sub);
      }
    }
    const value = acc / subCount;
    cache.set(key, value);
    return value;
  };

  return {
    value(u: number, v: number): number {
      const fu = u - 0.5;
      const fv = v - 0.5;
      const i0 = Math.floor(fu);
      const j0 = Math.floor(fv);
      if (i0 < 0 || j0 < 0 || i0 + 1 >= it.resX || j0 + 1 >= it.resY) return NaN;
      const tu = fu - i0;
      const tv = fv - j0;
      return (
        pixel(i0, j0) * (1 - tu) * (1 - tv) +
        pixel(i0 + 1, j0) * tu * (1 - tv) +
        pixel(i0, j0 + 1) * (1 - tu) * tv +
        pixel(i0 + 1, j0 + 1) * tu * tv
      );
    },
    evaluated(): number {
      return cache.size;
    },
  };
}

/**
 * Localise one projector's copy of a line along a scan path across the sphere.
 *
 * Returns the line centre as an offset in millimetres of arc from the scan's
 * midpoint (the nominal line position), or `NaN` when the profile is not a clean
 * isolated line — no peak worth localising, or non-zero signal at a window edge,
 * which means the window clipped this line or caught a neighbouring one. Both
 * would bias the centroid silently, and a silently biased sub-millimetre
 * measurement is worse than a missing one.
 *
 * ## Half-height crossings, not the first moment
 *
 * The obvious estimator is the intensity-weighted centroid, and it is the wrong
 * one here. It is unbiased only when the profile is symmetric, and this profile
 * is asymmetric in BOTH available coordinate systems:
 *
 *   - On the sphere, the pattern's line is symmetric but the blur is not. A
 *     projector pixel's footprint on the surface grows as `1/cos(incidence)`, so
 *     the box that area-averages the pattern into a pixel becomes a WEDGE on the
 *     sphere, wider on the side away from the sub-projector point. Convolving
 *     with a wedge drags the first moment outward — and two projectors sharing a
 *     seam drag their copies in opposite directions, so the bias does not
 *     cancel, it doubles.
 *   - In the raster, the blur is symmetric but the line is not: a line of
 *     constant width on the sphere images to a raster profile that is narrower
 *     on the far side.
 *
 * Measured on the aligned nominal rig, where the true answer is zero, the
 * sphere-space centroid reports up to 0.54 mm and the raster-space centroid
 * 0.39 mm. Against a 1.0 mm gate that is a third to half the budget, spent on
 * the measurement rather than the rig.
 *
 * The half-height crossing has none of that. `equirect.ts` draws each line with
 * a linear ramp on both edges, so the unblurred profile crosses half its height
 * at exactly `+/-(halfWidth - feather/2)` from the line centre — symmetric by
 * construction. Convolving a step or a linear ramp with ANY symmetric kernel
 * leaves the half-height point exactly where it was, whatever the kernel's
 * width, so each crossing survives the blur in place. The midpoint of the two
 * crossings is then the line centre, and the asymmetries above cancel because
 * they act on the two edges equally and oppositely.
 *
 * The estimator needs no knowledge of the kernel, which is the point: it stays
 * unbiased as the incidence changes across the sphere, which is exactly where a
 * centroid stops being trustworthy.
 */
interface Localisation {
  /** Offset in mm of arc from the scan midpoint, or `NaN` when not localised. */
  mm: number;
  /**
   * The line this window was placed to find is not centred in it — either
   * nothing above the peak threshold anywhere in the window, or a run that
   * reaches a window edge.
   *
   * Distinct from every other reason localisation fails, and the distinction is
   * the whole point: this one means the projector's copy of the line has moved
   * FURTHER than the window can measure, so dropping the sample removes exactly
   * the largest displacements from a statistic whose job is to report the
   * largest displacement. The others — two lines in the window, a bright skirt
   * at the ends — are crowding and apparatus, uncorrelated with how far the rig
   * has moved.
   */
  outOfWindow: boolean;
}

const NOT_LOCALISED: Localisation = { mm: NaN, outOfWindow: false };
const DISPLACED_OUT: Localisation = { mm: NaN, outOfWindow: true };

function localiseLine(
  pointAt: (sMm: number) => Vec3,
  halfWindowMm: number,
  samples: number,
  physical: PreparedRig,
  raster: LazyRaster,
  k: number,
): Localisation {
  const proj = physical.projectors[k];

  /** The reconstructed profile at arc-length offset `s`, or `NaN` off-raster. */
  const profileAt = (sMm: number): number => {
    const point = pointAt(sMm);
    if (!isIlluminatedAt(point, proj)) return NaN;
    const px = worldToPixel(proj, point);
    if (px === null) return NaN;
    return raster.value(px.u, px.v);
  };

  const offsetOf = (i: number): number =>
    -halfWindowMm + (2 * halfWindowMm * i) / (samples - 1);

  const values: number[] = new Array<number>(samples);
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const value = profileAt(offsetOf(i));
    if (!Number.isFinite(value)) return NOT_LOCALISED;
    values[i] = value;
    if (value > peak) peak = value;
  }

  // The graticule's line colour is 1.0 and its background 0.0, so a genuine line
  // reconstructs to a clear peak. Anything less means this projector's copy of
  // the line is not in this window at all — it has been displaced past it.
  if (peak < 0.25) return DISPLACED_OUT;

  // Validity is judged against the HALF-HEIGHT level, not against the tails.
  // The estimator does not integrate the profile, so a long blurred skirt is
  // harmless — and insisting the window ends reach near-zero would throw away
  // exactly the measurements that matter most, the ones near a pole where the
  // overlap is narrow and one projector's footprint is several millimetres
  // wide. What must hold is that the window contains ONE line, whole:
  //
  //   - exactly one contiguous run above half height (two runs is two lines,
  //     which means a neighbouring graticule line got into the window);
  //   - that run strictly interior, so both crossings are bracketed rather than
  //     clipped by the window edge;
  //   - genuine background at both ends, well below the half-height level, so
  //     the crossings sit on this line's own edges.
  const half = 0.5 * peak;
  let first = -1;
  let last = -1;
  let runs = 0;
  for (let i = 0; i < samples; i++) {
    if (values[i] >= half) {
      if (first < 0) first = i;
      if (i === 0 || values[i - 1] < half) runs++;
      last = i;
    }
  }
  // Two runs is two lines: a neighbouring graticule line got into the window.
  // Crowding, not displacement.
  if (runs !== 1) return NOT_LOCALISED;
  // The run reaches a window edge, so the line is partly outside it and the
  // crossings are clipped rather than bracketed. Same class as no line at all:
  // the copy has moved further than this window can measure.
  if (first <= 0 || last >= samples - 1) return DISPLACED_OUT;
  if (values[0] > 0.35 * peak || values[samples - 1] > 0.35 * peak) return NOT_LOCALISED;

  /**
   * The crossing, to a hundredth of a micrometre.
   *
   * Bisection on the reconstructed profile rather than linear interpolation
   * between the two bracketing samples. The blurred edge is smooth but not
   * straight, so interpolating across a whole sample step leaves a residual that
   * differs between the two edges — they sit at different incidences and are
   * therefore blurred by different amounts — and so does NOT cancel in the
   * midpoint. It showed up as several tenths of a millimetre of spurious
   * displacement at high latitude. Bisection costs about thirty profile
   * evaluations per crossing, nearly all of them cache hits.
   */
  const crossingAt = (sIn: number, sOut: number): number => {
    let inside = sIn;
    let outside = sOut;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (inside + outside);
      const v = profileAt(mid);
      if (!Number.isFinite(v)) return NaN;
      if (v >= half) inside = mid;
      else outside = mid;
    }
    return 0.5 * (inside + outside);
  };
  const rising = crossingAt(offsetOf(first), offsetOf(first - 1));
  const falling = crossingAt(offsetOf(last), offsetOf(last + 1));
  if (!Number.isFinite(rising) || !Number.isFinite(falling)) return NOT_LOCALISED;
  return { mm: 0.5 * (rising + falling), outOfWindow: false };
}

/**
 * Seam longitudes, from the PHYSICAL lens azimuths rather than from the nominal
 * 0/90/180/270 of PARAMETERS.md §2.
 *
 * A misaligned rig's seams are not where the documentation puts them, and a
 * metric that measured at the nominal longitudes would sample slightly off the
 * crossfade it is supposed to be judging. Deriving them keeps the measurement
 * attached to the rig in front of it.
 */
function seamLongitudes(physical: PreparedRig): number[] {
  const az = physical.projectors.map((p) => (Math.atan2(p.lens.y, p.lens.x) * 180) / Math.PI);
  const sorted = az.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const last = i + 1 === sorted.length;
    const a = sorted[i];
    const b = sorted[last ? 0 : i + 1] + (last ? 360 : 0);
    out.push(((0.5 * (a + b) + 540) % 360) - 180);
  }
  return out;
}

/** Distance in degrees from `value` to the nearest multiple of `step`. */
function distanceToNearestMultiple(value: number, step: number): number {
  return Math.abs(value - Math.round(value / step) * step);
}

interface Candidate {
  orientation: LineOrientation;
  /** Longitude of the meridian, or latitude of the parallel. */
  lineDeg: number;
  latDeg: number;
  lonDeg: number;
}

/**
 * Grid-line displacement across every blend region of the rig.
 *
 * `physicalRig` is where the lenses are; `contentRig` is the calibration the
 * compositor drew with. Equal for a perfectly aligned system, in which case the
 * only residual is the difference between two projectors' resampling of the same
 * line — which the tests pin at well under a tenth of the gate.
 */
export function computeGridDisplacement(
  physicalRig: RigCalibration,
  contentRig: RigCalibration,
  maskInterpretation: MaskInterpretation,
  gate: MetricGate,
  options: GridOptions = {},
  densityScale = 1,
): GridReport {
  const spacingDeg = options.spacingDeg ?? 45;
  // 3 degrees of arc is about 45 mm on the sphere. With a fully triangular
  // profile that is a 22 mm ramp on each edge: about 17 projector pixels at
  // normal incidence and still 4 at the grazing incidence of a polar seam, which
  // is what {@link localiseLine} needs. Halving it triples the apparatus floor
  // (0.066 mm -> 0.24 mm on a 1920x1080 rig).
  const lineWidthDeg = options.lineWidthDeg ?? 3;
  const latStepDeg = Math.max(0.5, (options.latStepDeg ?? 4) / Math.max(0.05, densityScale));
  const latMinDeg = options.latMinDeg ?? -68;
  const latMaxDeg = options.latMaxDeg ?? 80;
  const seamOffsetsDeg = options.seamOffsetsDeg ?? [-20, -10, 0, 10, 20];
  // Only enough samples to bracket the two half-height crossings and to prove
  // the window holds exactly one whole line; the crossings themselves are then
  // bisected on the continuous reconstruction, so this number sets robustness
  // rather than precision.
  const profileSamples = options.profileSamples ?? 129;
  const minWeight = options.minWeight ?? 0.05;
  const minIncidenceCos = options.minIncidenceCos ?? 0.2;
  const supersample = options.contentSupersample ?? 4;
  // 1 = fully triangular: no plateau, so both edges are one long linear ramp and
  // the half-height crossing sits in the middle of it. See the module note.
  const featherFrac = options.lineFeatherFrac ?? 1;
  const wantConvergence = options.convergence ?? true;
  const wantFloor = options.measurementFloor ?? true;

  const physical = prepareRig(physicalRig);
  const content = prepareRig(contentRig);
  const radiusMm = physical.radiusM * MM_PER_M;
  const rasters = content.projectors.map((_, k) =>
    lazyRaster(content, k, spacingDeg, lineWidthDeg, featherFrac, supersample),
  );
  const seamLonsDeg = seamLongitudes(physical);

  const candidatesFor = (latStep: number): Candidate[] => {
    const out: Candidate[] = [];
    // Meridians, scanned along a parallel. §1's "vertical grid lines".
    const meridianCount = Math.max(1, Math.round(360 / spacingDeg));
    for (let m = 0; m < meridianCount; m++) {
      const lineLon = -180 + m * spacingDeg;
      for (let lat = latMinDeg; lat <= latMaxDeg + 1e-9; lat += latStep) {
        out.push({ orientation: 'meridian', lineDeg: lineLon, latDeg: lat, lonDeg: lineLon });
      }
    }
    // Parallels, scanned along a meridian, taken across each seam.
    const parallelCount = Math.floor(90 / spacingDeg);
    for (const seam of seamLonsDeg) {
      for (const off of seamOffsetsDeg) {
        const lon = ((seam + off + 540) % 360) - 180;
        for (let p = -parallelCount; p <= parallelCount; p++) {
          const lineLat = p * spacingDeg;
          if (lineLat < latMinDeg || lineLat > latMaxDeg) continue;
          out.push({ orientation: 'parallel', lineDeg: lineLat, latDeg: lineLat, lonDeg: lon });
        }
      }
    }
    return out;
  };

  const measure = (latStep: number, reject: GridRejections): GridMeasurement[] => {
    const out: GridMeasurement[] = [];
    for (const cand of candidatesFor(latStep)) {
      const point = content.surface.pointAt({ latDeg: cand.latDeg, lonDeg: cand.lonDeg });
      const normal = content.surface.normalAt(point);
      // PARAMETERS.md §4.4: "The simulator must model the mask, or seam metrics
      // will report failures in a region nobody projects onto."
      const mask = polarMask(cand.latDeg, content.blend, maskInterpretation);
      if (mask <= 0) {
        reject.notInBlendRegion++;
        continue;
      }
      const weights = coverageAndWeights(point, content).weights;
      const ranked = weights
        .map((w, i) => ({ w, i }))
        .filter((e) => e.w >= minWeight)
        .sort((a, b) => b.w - a.w || a.i - b.i);
      if (ranked.length < 2) {
        reject.notInBlendRegion++;
        continue;
      }
      const a = ranked[0];
      const b = ranked[1];

      // Both projectors must actually RESOLVE the line here. PARAMETERS.md §4.3
      // puts the practically usable limit at cos(incidence) = 0.2, "where
      // resolution smear exceeds 5x and the image becomes streaks" — and a line
      // that has become streaks has no position to localise. Admitting those
      // points makes the apparatus floor depend on which sub-pixel phase the
      // line happens to land on, which is how a 0.07 mm floor turns into 2.5 mm
      // under a 2 mm lens shift that changed nothing else. This is the spec's
      // own threshold, not a tuned one.
      const worstIncidence = Math.min(
        incidenceCosineAt(point, normal, physical.projectors[a.i].lens),
        incidenceCosineAt(point, normal, physical.projectors[b.i].lens),
      );
      if (worstIncidence < minIncidenceCos) {
        reject.incidenceTooGrazing++;
        continue;
      }

      // Window: wide enough to contain the whole profile with clear background at
      // both ends, narrow enough to exclude the neighbouring graticule line.
      // Meridians crowd as cos(lat); parallels do not.
      const cosLat = Math.cos(cand.latDeg * DEG2RAD);
      const neighbourDeg =
        cand.orientation === 'meridian' ? spacingDeg * Math.max(1e-6, cosLat) : spacingDeg;
      let halfWindowDeg = Math.min(2 * lineWidthDeg, 0.4 * neighbourDeg);
      // The profile needs background at both ends, and the line's support is
      // +/- lineWidth/2, so anything past 0.75 * lineWidth has margin to spare.
      const minHalfWindowDeg = 0.75 * lineWidthDeg;
      if (halfWindowDeg < minHalfWindowDeg) {
        reject.linesTooCrowded++;
        continue;
      }

      // Clearance from the PERPENDICULAR family. The graticule is a max of two
      // line sets, so a meridian scanned where it crosses a parallel runs along
      // the inside of that parallel and the profile is a plateau rather than a
      // line; likewise a parallel scanned on top of a meridian.
      //
      // The clearance needed is only the line's own half-width plus slack, not
      // the whole scan window. A parallel's coverage depends on latitude alone,
      // which is CONSTANT along a meridian scan, so a parallel either sits
      // inside the window everywhere or nowhere — it never rides across it. The
      // slack covers the pixel footprint, since the content is sampled where
      // each pixel's ray lands rather than exactly on the scan path. Requiring
      // the full window instead would reject latitudes 54 to 66 outright, which
      // is precisely the polar seam band §1's note is about.
      const clearanceDeg = lineWidthDeg;
      const crossingDeg =
        cand.orientation === 'meridian'
          ? distanceToNearestMultiple(cand.latDeg, spacingDeg)
          : // A meridian's surface distance from the scan DOES shrink as
            // cos(lat) as the scan climbs, so take the worst case over the
            // latitudes the window reaches.
            distanceToNearestMultiple(((cand.lonDeg + 540) % 360) - 180, spacingDeg) *
            Math.cos(Math.min(89.9, Math.abs(cand.latDeg) + halfWindowDeg) * DEG2RAD);
      if (crossingDeg < clearanceDeg) {
        reject.linesTooCrowded++;
        continue;
      }

      const pointAt =
        cand.orientation === 'meridian'
          ? (sMm: number): Vec3 =>
              content.surface.pointAt({
                latDeg: cand.latDeg,
                lonDeg: cand.lineDeg + sMm / (radiusMm * Math.max(1e-6, cosLat)) / DEG2RAD,
              })
          : (sMm: number): Vec3 =>
              content.surface.pointAt({
                latDeg: cand.lineDeg + sMm / radiusMm / DEG2RAD,
                lonDeg: cand.lonDeg,
              });

      // Shrink the window until both ends lie inside BOTH projectors' coverage.
      // Toward the poles the overlap between two projectors narrows faster than
      // the graticule does, so a fixed window walks off the limb and the
      // localiser returns nothing — which would silently delete latitudes above
      // about 56 degrees from the report, i.e. exactly the polar seams
      // PARAMETERS.md §1's note is about. Shrinking is safe: the estimator needs
      // background at both ends and nothing more.
      const fits = (halfDeg: number): boolean => {
        const halfMm = radiusMm * halfDeg * DEG2RAD;
        for (const s of [-halfMm, halfMm]) {
          const p = pointAt(s);
          if (!isIlluminatedAt(p, physical.projectors[a.i])) return false;
          if (!isIlluminatedAt(p, physical.projectors[b.i])) return false;
        }
        return true;
      };
      while (!fits(halfWindowDeg) && halfWindowDeg > minHalfWindowDeg) {
        halfWindowDeg = Math.max(minHalfWindowDeg, halfWindowDeg * 0.8);
      }
      if (!fits(halfWindowDeg)) {
        reject.windowDoesNotFit++;
        continue;
      }
      const halfWindowMm = radiusMm * halfWindowDeg * DEG2RAD;

      const ca = localiseLine(pointAt, halfWindowMm, profileSamples, physical, rasters[a.i], a.i);
      const cb = localiseLine(pointAt, halfWindowMm, profileSamples, physical, rasters[b.i], b.i);
      // Counted apart, because the two mean opposite things about the rig. A
      // sample dropped because the window held two lines or a bright skirt is
      // missing for a reason unrelated to how far anything moved. A sample
      // dropped because a projector's copy of the line is not IN the window is
      // missing precisely BECAUSE it moved a long way — and this statistic is a
      // MAXIMUM, so dropping those silently removes the largest displacements
      // from the number whose job is to report the largest displacement.
      //
      // Measured on the interactive page: yaw one projector of a perfect rig by
      // 2 degrees and all sixteen seam samples that involve it drop out, leaving
      // the sixteen that do not. The reported worst then reads 0.0082 mm —
      // bit-identical to an untouched rig — while registration error is 174 mm.
      // The censoring is not merely lossy, it is signed: it always reports
      // better.
      if (ca.outOfWindow || cb.outOfWindow) {
        reject.displacedBeyondWindow++;
        continue;
      }
      if (!Number.isFinite(ca.mm) || !Number.isFinite(cb.mm)) {
        reject.profileNotLocalisable++;
        continue;
      }

      out.push({
        projectorA: a.i,
        projectorB: b.i,
        orientation: cand.orientation,
        lineDeg: cand.lineDeg,
        latDeg: cand.latDeg,
        lonDeg: cand.lonDeg,
        offsetAMm: ca.mm,
        offsetBMm: cb.mm,
        displacementMm: Math.abs(ca.mm - cb.mm),
        weightA: a.w,
        weightB: b.w,
        maskValue: mask,
      });
    }
    return out;
  };

  const rejected: GridRejections = {
    notInBlendRegion: 0,
    incidenceTooGrazing: 0,
    linesTooCrowded: 0,
    windowDoesNotFit: 0,
    profileNotLocalisable: 0,
    displacedBeyondWindow: 0,
  };
  const measurements = measure(latStepDeg, rejected);

  const all = summarise(measurements.map((m) => m.displacementMm));
  const meridians = summarise(
    measurements.filter((m) => m.orientation === 'meridian').map((m) => m.displacementMm),
  );
  const parallels = summarise(
    measurements.filter((m) => m.orientation === 'parallel').map((m) => m.displacementMm),
  );

  let worst: GridMeasurement | null = null;
  for (const m of measurements) {
    if (worst === null || m.displacementMm > worst.displacementMm) worst = m;
  }

  let convergence: ConvergenceReport | null = null;
  if (wantConvergence) {
    const coarseRejected: GridRejections = {
      notInBlendRegion: 0,
      incidenceTooGrazing: 0,
      linesTooCrowded: 0,
      windowDoesNotFit: 0,
      profileNotLocalisable: 0,
      displacedBeyondWindow: 0,
    };
    const coarse = measure(latStepDeg * 2, coarseRejected);
    convergence = convergenceOf(
      all.max,
      summarise(coarse.map((m) => m.displacementMm)).max,
      coarse.length,
      // A tenth of the gate: below that, a change in where the metric sampled
      // cannot change the verdict. Expect this check to report DRIFT on a badly
      // misaligned rig and that is correct rather than alarming — the reported
      // value is a MAXIMUM over a spatially varying field, and where the maximum
      // lands genuinely depends on where you looked. It is the aligned case,
      // where the field is flat and the max must be stable, that this is
      // watching.
      0.1,
    );
  }

  // Self-calibration. The same measurement on a rig whose content calibration is
  // its own physical one has, by definition, nothing to find; whatever it
  // reports is the apparatus. It is not subtracted from the result — a floor you
  // subtract is a floor you stop noticing, and this one grows as the geometry
  // gets more oblique, which is exactly when a reader most needs to see it.
  const measurementFloorMm = wantFloor
    ? contentRig === physicalRig
      ? all.max
      : computeGridDisplacement(physicalRig, physicalRig, maskInterpretation, gate, {
          ...options,
          convergence: false,
          measurementFloor: false,
        }, densityScale).all.max
    : all.max;

  const sampling: SamplingReport = {
    scheme: 'graticule-line-centroid',
    description:
      `${measurements.length} line localisations. A ${spacingDeg}-degree graticule with ` +
      `${lineWidthDeg}-degree lines, scanned at ${profileSamples} points across each line along the ` +
      `sphere surface and localised by intensity centroid. Meridians every ` +
      `${latStepDeg.toFixed(1)} deg of latitude from ${latMinDeg} to ${latMaxDeg}; parallels at ` +
      `${seamOffsetsDeg.join(', ')} deg from each of ${seamLonsDeg.length} seams. Both projectors ` +
      `must carry normalized blend weight >= ${minWeight}, must see the point at cos(incidence) ` +
      `>= ${minIncidenceCos}, and the polar mask must not be total. ` +
      `${rasters.reduce((n, r) => n + r.evaluated(), 0)} projector pixels evaluated.`,
    count: measurements.length,
    densityPerSr: null,
    convergence,
  };

  const metric = makeMetric({
    id: 'grid_displacement',
    label: 'Grid-line displacement across a blend region',
    // The worst case, not the average. §7's basis is that an experienced
    // operator judges the image continuous, and that judgement is a worst-case
    // judgement: one visibly doubled line fails the alignment no matter how
    // clean the other three seams are.
    value: all.max,
    unit: 'mm on sphere surface',
    gate,
    scored: true,
    // A maximum taken after dropping the samples that moved furthest is a lower
    // bound, not a worst case, and it cannot certify anything under a gate.
    censored: rejected.displacedBeyondWindow > 0,
    note:
      (rejected.displacedBeyondWindow > 0
        ? `INCOMPLETE: ${rejected.displacedBeyondWindow} of ` +
          `${measurements.length + rejected.displacedBeyondWindow} otherwise-measurable seam ` +
          'samples had a projector\'s copy of the line displaced further than the scan window ' +
          'could measure, so this value is a LOWER BOUND over the seams that could still be read ' +
          'and the gate is not applied to it. The rejection is not neutral: it removes exactly ' +
          'the largest displacements from a statistic that reports the largest displacement, so ' +
          'the number it leaves behind is biased toward passing. '
        : '') +
      "Worst single line discontinuity. §7's basis is an operator judging the image continuous, " +
      'and one visible doubled line fails that judgement, so the gate is applied to the maximum; ' +
      'RMS and p95 are in `detail`. Each projector\'s copy of the line is localised in its own ' +
      'raster by sub-pixel centroid — a projector pixel is about 1.3 mm on the sphere, WIDER than ' +
      'the 1.0 mm gate, so a whole-pixel estimate could not resolve this. Blend weights are ' +
      'deliberately not applied to the profiles: including them would make a geometric number ' +
      'depend on w_width and gamma_blend, both ASSUME-class (§4.5). Measured only where both ' +
      "projectors see the point at cos(incidence) >= 0.2, §4.3's own line for where the image " +
      'becomes streaks — a streak has no position to localise. The apparatus floor for this ' +
      `geometry is ${measurementFloorMm.toFixed(3)} mm — the same measurement on a rig whose ` +
      'content calibration IS its physical one, so whatever it finds is the apparatus — and it is ' +
      "reported rather than subtracted. It is the forward model's own resolution limit and it " +
      'falls as the raster gets finer, which is how it was identified as such rather than as a bug.',
    sampling,
    detail: {
      measurementFloorMm,
      rmsMm: all.rms,
      p95Mm: all.p95,
      meanMm: all.mean,
      meridianMaxMm: meridians.max,
      parallelMaxMm: parallels.max,
      measurementCount: measurements.length,
      rejectedNotInBlendRegion: rejected.notInBlendRegion,
      rejectedIncidenceTooGrazing: rejected.incidenceTooGrazing,
      rejectedLinesTooCrowded: rejected.linesTooCrowded,
      rejectedWindowDoesNotFit: rejected.windowDoesNotFit,
      rejectedNotLocalisable: rejected.profileNotLocalisable,
      rejectedDisplacedBeyondWindow: rejected.displacedBeyondWindow,
      worstLatDeg: worst ? worst.latDeg : NaN,
      worstLonDeg: worst ? worst.lonDeg : NaN,
    },
  });

  return {
    measurements,
    all,
    meridians,
    parallels,
    worst,
    rejected,
    seamLonsDeg,
    measurementFloorMm,
    metric,
    sampling,
  };
}
