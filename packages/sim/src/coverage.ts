// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The coverage field: who lights what, how obliquely, how many at once, and how
 * the contributions are weighted.
 *
 * This module carries the project's load-bearing correctness checks. Three facts
 * from PARAMETERS.md §4.2 and §4.3 are counterintuitive enough that a wrong
 * implementation will look plausible on screen and still be wrong:
 *
 *   1. Overlap multiplicity is 1 or 2 everywhere. Never 3, never 4. Rev 1 of the
 *      spec asserted otherwise and §4.2 exists to correct it.
 *   2. The unlit polar region is four-lobed and scalloped, not a circular cap.
 *   3. The mask onset of 60 degrees is explained by grazing incidence, not by
 *      overlap brightness — there is no 4x pile-up to suppress.
 *
 * If a change here makes any of those false, the change is wrong, not the
 * assertion. See packages/sim/README.md.
 */

import type { BlendCalibration } from '../../calibration/src/index.ts';
import type { Vec3 } from './vec.ts';
import { DEG2RAD, RAD2DEG, clamp, dot, sub, wrapDeg180 } from './vec.ts';
import type { PreparedProjector, PreparedRig } from './optics.ts';
import { worldToPixel } from './optics.ts';
import { normalizeWeights, rampWeight } from './blend.ts';
import { blendModelApplies } from './surface.ts';
import { blendWidthM, footprintDistanceAt } from './footprint.ts';

// conventions.ts §B's ramp algebra lives in `blend.ts`, which knows nothing about
// the sphere. This module decides WHERE each projector's blend region is and how
// far across it a point sits; `blend.ts` turns that into a weight. Re-exported
// because `rampValue` is part of this module's published surface.
export { rampValue } from './blend.ts';

/**
 * Is this surface point lit by this projector?
 *
 * PARAMETERS.md §4.1 states the test in closed form for a rig whose lenses sit
 * on the equatorial plane at azimuth `phi_i`:
 *
 *     cos(lat) * cos(lon - phi_i) > R/d
 *
 * That form is only valid for that special case. The general statement is that
 * the surface point must face the lens — the lens must be above the local
 * horizon:
 *
 *     dot(normal, lensPosition - surfacePoint) > 0
 *
 * The two agree exactly for an equatorial lens (expand the dot product: it is
 * `d*cos(lat)*cos(lon - phi) - R`), and coverage.test.ts pins that agreement so
 * a future misalignment-injection change cannot quietly break the special case
 * the spec's arithmetic is written against.
 *
 * A point can also fail to be lit by falling outside the raster. For a rig built
 * by `intrinsicsFromThrow` this never binds, because the silhouette is inscribed
 * in the minor dimension with margin (docs/AMENDMENTS.md A-01) and the limb
 * *is* the silhouette. It binds immediately for a misaimed projector, which is
 * the whole point of the off-sphere-flux metric.
 */
export function isIlluminated(latDeg: number, lonDeg: number, projector: PreparedProjector): boolean {
  const point = projector.surface.pointAt({ latDeg, lonDeg });
  return isIlluminatedAt(point, projector.surface.normalAt(point), projector);
}

/**
 * {@link isIlluminated} for a point already in world coordinates.
 *
 * ## Three tests, cheapest first, and the order is load-bearing
 *
 *   1. **Facing.** Is the lens above this point's local horizon? A dot product.
 *   2. **Raster.** Does the point land inside the projector's frame? A
 *      projection and two comparisons.
 *   3. **Shadow.** Does the surface come between the point and the lens? On a
 *      sphere, free — a convex body cannot occlude itself. On a mesh, a
 *      hierarchy traversal, and by far the most expensive thing here.
 *
 * Running them in that order means the traversal only happens for points that
 * already face the lens and already land on the raster, which on a typical rig
 * is a minority. Reordering this is a performance bug that looks like a tidy-up.
 *
 * ## Why the normal is a parameter
 *
 * Until Phase 1 this function derived the normal from the point, because a
 * sphere centred on the world origin has them parallel. A mesh does not, so the
 * caller has to say. Making it a required argument rather than deriving it from
 * `projector.surface.normalAt(point)` is deliberate: on a mesh that call is a
 * hierarchy query, and a default that quietly costs one per projector per point
 * is the kind of hidden cost that only shows up as "the mesh path is slow" long
 * after anyone remembers why.
 */
export function isIlluminatedAt(
  point: Vec3,
  normal: Vec3,
  projector: PreparedProjector,
): boolean {
  const surface = projector.surface;
  if (!surface.facesLens(point, normal, projector.lens)) return false;
  if (worldToPixel(projector, point) === null) return false;
  return !surface.shadowed(point, projector.lens);
}

/**
 * `cos(incidence)` in closed form, PARAMETERS.md §4.1:
 *
 *     cos(incidence) = (d*cos(theta) - R) / sqrt(d*d - 2*d*R*cos(theta) + R*R)
 *
 * where `theta` is the angular distance from the projector's sub-projector
 * point. Equals 1 at theta = 0 and falls to 0 at `cos(theta) = R/d`, i.e. at
 * `theta_max = acos(R/d)` = 80.4 degrees for d = 5.18 m.
 *
 * Kept as its own function so {@link incidenceCosineAt} — the general vector
 * form the renderer actually uses — can be checked against the spec's arithmetic
 * to 1e-12 rather than against itself.
 */
export function incidenceCosineClosed(cosTheta: number, distanceM: number, radiusM: number): number {
  const d = distanceM;
  const r = radiusM;
  const denom = Math.sqrt(d * d - 2 * d * r * cosTheta + r * r);
  if (denom === 0) return 0;
  return (d * cosTheta - r) / denom;
}

/**
 * `cos(incidence)` for an arbitrary lens position — the general form, valid for
 * the perturbed rigs `injectMisalignment` produces, where no lens is exactly on
 * the equatorial plane any more.
 *
 * Negative results mean the point faces away from the lens; callers that want
 * the coverage test should use {@link isIlluminated}, which also checks the
 * raster.
 */
export function incidenceCosineAt(point: Vec3, normal: Vec3, lensPosition: Vec3): number {
  const dx = lensPosition.x - point.x;
  const dy = lensPosition.y - point.y;
  const dz = lensPosition.z - point.z;
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return 0;
  return (normal.x * dx + normal.y * dy + normal.z * dz) / len;
}

/** {@link incidenceCosineAt} from latitude and longitude. */
export function incidenceCosine(
  latDeg: number,
  lonDeg: number,
  projector: PreparedProjector,
): number {
  const point = projector.surface.pointAt({ latDeg, lonDeg });
  const normal = projector.surface.normalAt(point);
  return incidenceCosineAt(point, normal, projector.lens);
}

/**
 * How many projectors light this point.
 *
 * PARAMETERS.md §4.2: this is 1 or 2 everywhere and never more, and the argument
 * is worth restating because it is the thing rev 1 of the spec got wrong.
 * Three-way overlap needs a point within `acos(R/d)` = 80.4 degrees of three
 * equatorial directions spaced 90 apart. Any three of the four nominal
 * directions include an antipodal pair, and no point is within 80.4 degrees of
 * two antipodal directions at once. The poles, the only candidate region, sit
 * exactly 90 degrees from every lens — outside the limit, which is also why
 * there is an unlit polar region at all.
 *
 * The count is computed by asking each projector, not by trusting the argument.
 */
export function overlapMultiplicity(latDeg: number, lonDeg: number, rig: PreparedRig): number {
  const point = rig.surface.pointAt({ latDeg, lonDeg });
  const normal = rig.surface.normalAt(point);
  let n = 0;
  for (const p of rig.projectors) if (isIlluminatedAt(point, normal, p)) n++;
  return n;
}

/** Which projectors light this point, by index. */
export function contributors(latDeg: number, lonDeg: number, rig: PreparedRig): number[] {
  const point = rig.surface.pointAt({ latDeg, lonDeg });
  const normal = rig.surface.normalAt(point);
  const out: number[] = [];
  for (const p of rig.projectors) if (isIlluminatedAt(point, normal, p)) out.push(p.index);
  return out;
}

/**
 * How PARAMETERS.md §4.4's `set bottommask 60,70` is read.
 *
 * docs/AMENDMENTS.md A-02: the latitude reading is inferred, not published, and
 * it governs the domain of §7's only gate with no tolerance ("unlit fraction
 * within the mask boundary: 0%"). Both readings are implemented so the bench can
 * report the gate under each and the difference is visible rather than assumed.
 *
 * - `latitude`   — 60 and 70 are absolute latitudes. Masked region is 6.7% of
 *                  the sphere per pole.
 * - `colatitude` — 60 and 70 are degrees from the pole, so the onset is at
 *                  |lat| = 90 - 70 = 20 and full mask at |lat| = 90 - 60 = 30.
 *                  Masked region is 25% of the sphere, roughly triple.
 */
export type MaskInterpretation = 'latitude' | 'colatitude';

/**
 * Polar mask attenuation in [0, 1]. 1 = fully visible, 0 = fully masked.
 *
 * conventions.ts §M: cosine feather between `maskLoDeg` and `maskHiDeg` on
 * ABSOLUTE latitude, applied at the south pole only when `bottomOnly`.
 *
 * The asymmetry is hardware, not taste: PARAMETERS.md §1 and §4.4 explain that
 * the sphere hangs from a ceiling mount which physically occludes the north
 * polar cap, so only the exposed bottom needs a software mask.
 *
 * A cosine feather rather than a linear one because the mask multiplies a signal
 * that is already being ramped by the blend; a C1-continuous falloff at both
 * ends keeps the product from developing a visible crease at the onset latitude,
 * which is 60 degrees — squarely inside the region a viewer standing at the
 * guard rail can see (PARAMETERS.md §6).
 */
export function polarMask(
  latDeg: number,
  blend: BlendCalibration,
  interpretation: MaskInterpretation = 'latitude',
): number {
  const onset = interpretation === 'latitude' ? blend.maskLoDeg : 90 - blend.maskHiDeg;
  const full = interpretation === 'latitude' ? blend.maskHiDeg : 90 - blend.maskLoDeg;

  if (blend.bottomOnly && latDeg >= 0) return 1;
  const a = Math.abs(latDeg);
  if (a <= onset) return 1;
  if (a >= full) return 0;
  if (full === onset) return 0;
  const t = (a - onset) / (full - onset);
  return 0.5 + 0.5 * Math.cos(Math.PI * t);
}

/**
 * Blend weights per projector, conventions.ts §B, normalized to sum to one
 * wherever at least one projector contributes.
 *
 * ## What `t` is measured against
 *
 * §B defines `t` as the normalized position across a projector's blend region
 * but leaves the region's geometry to the implementation — PARAMETERS.md §4.5
 * only gives its angular width (`w_width ~ 20 deg`, class ASSUME, "verify
 * against a real sphere").
 *
 * Here `t` ramps inward from each projector's own footprint edge, which is the
 * sphere's limb as seen from that lens:
 *
 *     t_i = (theta_max_i - theta_i) / widthDeg,  clamped to [0, 1]
 *
 * with `theta_i` the angular distance from the sub-projector point and
 * `theta_max_i = acos(R/d_i)` the limb. That is what a soft-edge blend actually
 * does — each projector fades out toward the edge of what it can reach — and it
 * makes the seam a crossfade without either projector needing to know the
 * other exists. It also feathers the polar limb, which is desirable: the
 * alternative is a hard edge at exactly the latitude where incidence is worst.
 *
 * At the equator between two adjacent projectors the overlap spans about 71
 * degrees of longitude, so a 20-degree ramp gives a 20-degree crossfade at each
 * end and a plateau in the middle where both weights are 1 and normalization
 * splits the signal 50/50 — matching the arithmetic PARAMETERS.md §4.5 works
 * through for the blend gamma.
 *
 * `rampGamma` is applied to the WEIGHT, never to the signal (§B). Applying it to
 * the signal instead would be a per-projector gamma adjustment, which is a
 * different and much more visible thing, and it would make the weights stop
 * summing to one.
 */
export function blendWeights(latDeg: number, lonDeg: number, rig: PreparedRig): number[] {
  const point = rig.surface.pointAt({ latDeg, lonDeg });
  return blendWeightsAt(point, rig);
}

/** {@link blendWeights} for a point already in world coordinates. */
export function blendWeightsAt(point: Vec3, rig: PreparedRig): number[] {
  return coverageAndWeights(point, rig.surface.normalAt(point), rig).weights;
}

/**
 * Blend weights AND raw coverage, in one pass.
 *
 * The two are different questions and the renderer needs both. A projector can
 * illuminate a point while carrying blend weight zero — that is what the outer
 * edge of its ramp means — and it is still emitting its black floor there.
 * Dropping those zero-weight contributions loses exactly the black-floor uplift
 * that PARAMETERS.md §3.2 and §7 are about, and it does so in the region where
 * the uplift matters most.
 */
export function coverageAndWeights(
  point: Vec3,
  normal: Vec3,
  rig: PreparedRig,
): { weights: number[]; lit: boolean[] } {
  const n = rig.projectors.length;
  const weights = new Array<number>(n).fill(0);
  const lit = new Array<boolean>(n).fill(false);
  const blend = rig.blend;
  const width = blend.widthDeg > 0 ? blend.widthDeg : 1e-9;
  const sector = blend.region === 'sector';
  // Refused rather than approximated on anything but a sphere. See
  // `blendModelApplies` for why a crossfade derived from a bounding sphere would
  // be a false statement rather than a rough one.
  const blended = blendModelApplies(rig.surface);
  // One lookup for every projector: the footprint fields are all indexed by the
  // same vertices, so locating the point once serves them all. `null` on a
  // sphere, where nothing below runs.
  const location = blended ? null : rig.surface.locate(point);
  const widthM = blended ? 0 : blendWidthM(blend.widthDeg, rig.surface.extentRadiusM);
  // Each projector's share of the circle, from where its NEIGHBOURS actually are
  // rather than from `360 / n`.
  //
  // The even-ring answer is the same — four projectors get 90° each and the seams
  // land at ±45° — but a rig is not always an even ring. Switch one of four off
  // and `360 / n` would hand the three survivors 120° apiece, silently widening
  // their wedges to cover a gap they cannot physically reach. The two projectors
  // either side of the hole should keep their own halves of it and no more.
  const half = sector ? sectorHalfWidths(rig) : null;

  for (let i = 0; i < n; i++) {
    const p = rig.projectors[i];
    if (!isIlluminatedAt(point, normal, p)) continue;
    lit[i] = true;

    if (!blended) {
      // The general blend: how deep inside this projector's own footprint the
      // point sits, measured in its raster by `footprint.ts`. It replaces the
      // limb ramp on any surface that has no limb, and it handles the raster
      // edge, the terminator and a shadow edge with one rule because all three
      // are edges of the same set.
      //
      // Falls back to an equal share only when no field was built, which means
      // a caller assembled a `PreparedRig` by hand. Better a hard seam than a
      // silent zero.
      const field = rig.footprints?.[i] ?? null;
      if (field === null || location === null) {
        // No field, or a point the surface could not place on a face. Better a
        // hard seam than a silent zero.
        weights[i] = 1;
        continue;
      }
      const d = footprintDistanceAt(field, location);
      // A lit point the field cannot place inside the footprint.
      //
      // The field is per-VERTEX, so it resolves nothing below one triangle. A
      // triangle whose three corners are all unlit interpolates to distance 0
      // everywhere inside it — while a point in its interior can still pass
      // `isIlluminatedAt`, because a footprint smaller than one face lands
      // between the vertices that measure it. The ramp then returns 0 for a
      // point this function has ALREADY established is lit, and if every
      // projector reaching it says the same, `normalizeWeights` leaves the set
      // alone and the surface renders black exactly where light falls.
      //
      // So the same rule as a missing field applies: better a hard seam than a
      // silent zero. A seam is a visible statement that the tessellation is
      // coarser than the footprint; a black patch is indistinguishable from
      // being unlit, which is the one thing it is not.
      if (!(d > 0)) {
        weights[i] = 1;
        continue;
      }
      weights[i] = rampWeight(blend.rampShape, d / widthM, blend.rampGamma);
      continue;
    }

    // theta: angular distance from the sub-projector point. The surface normal
    // is point/R and the sub-projector direction is the lens direction, so the
    // angle between them is theta directly (PARAMETERS.md §4.1).
    const cosTheta = clamp(
      (point.x * p.lens.x + point.y * p.lens.y + point.z * p.lens.z) / (p.radiusM * p.distanceM),
      -1,
      1,
    );
    const thetaDeg = Math.acos(cosTheta) * RAD2DEG;
    const thetaMaxDeg = Math.acos(p.limbCos) * RAD2DEG;

    // Where `t` is measured from. See docs/AMENDMENTS.md A-37 — the two readings
    // model different systems, and the default is the one every scored number in
    // bench-results.json was produced under.
    let t: number;
    if (sector && half) {
      // Longitude wedge: this projector owns the ground between the midpoints to
      // its two neighbours, and crossfades across `width/2` either side of each
      // boundary. `t = 1` well inside, falling to 0 outside.
      const lonDeg = Math.atan2(point.y, point.x) * RAD2DEG;
      const meridianDeg = Math.atan2(p.lens.y, p.lens.x) * RAD2DEG;
      const dLon = wrapDeg180(lonDeg - meridianDeg);
      const edge = dLon >= 0 ? half[i].plus : half[i].minus;
      t = (edge + width / 2 - Math.abs(dLon)) / width;
      // Still bounded by what the projector can physically reach: a wedge that
      // outran the limb would claim light nobody is emitting, and §4.3's unlit
      // polar region would quietly vanish from the model.
      t = Math.min(t, (thetaMaxDeg - thetaDeg) / width);
    } else {
      t = (thetaMaxDeg - thetaDeg) / width;
    }
    weights[i] = rampWeight(blend.rampShape, t, blend.rampGamma);
  }

  normalizeWeights(weights);
  return { weights, lit };
}

/**
 * Half the angular gap to each neighbour, per projector, in degrees.
 *
 * A lone projector owns the whole circle (180° each way). Otherwise each
 * boundary sits at the midpoint between two adjacent lenses, so two projectors
 * that disagree about where the seam is cannot leave a gap or an overlap in the
 * wedges — whatever one gives up, the other takes.
 */
function sectorHalfWidths(rig: PreparedRig): { plus: number; minus: number }[] {
  const az = rig.projectors.map((p) => Math.atan2(p.lens.y, p.lens.x) * RAD2DEG);
  return az.map((a, i) => {
    let plus = 180;
    let minus = 180;
    for (let j = 0; j < az.length; j++) {
      if (j === i) continue;
      // Positive-going and negative-going gaps, measured the short way round.
      const d = ((az[j] - a) % 360 + 360) % 360;
      if (d > 0 && d / 2 < plus) plus = d / 2;
      const e = 360 - d;
      if (e > 0 && e / 2 < minus) minus = e / 2;
    }
    return { plus, minus };
  });
}

/**
 * The latitude at which coverage ends, as a function of longitude — the boundary
 * of PARAMETERS.md §4.3's scalloped unlit region.
 *
 * Found by bisection on the general {@link isIlluminated} test rather than from
 * the closed form, so the answer stays meaningful for a perturbed rig and so the
 * agreement with §4.3's `cos(lat)*cos(45) = R/d` is a real check rather than a
 * restatement.
 *
 * `sign` selects which pole: +1 for north, -1 for south. Returns 90 when the
 * pole itself is lit (no unlit region in that direction) and the equator-side
 * bound when nothing is lit at all.
 */
export function coverageBoundaryLatitude(
  lonDeg: number,
  rig: PreparedRig,
  sign: 1 | -1 = 1,
  iterations = 60,
): number {
  const lit = (lat: number): boolean => {
    for (const p of rig.projectors) if (isIlluminated(lat, lonDeg, p)) return true;
    return false;
  };
  if (lit(sign * 90)) return 90;
  let lo = 0;
  let hi = 90;
  if (!lit(sign * lo)) return 0;
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (lo + hi);
    if (lit(sign * mid)) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Fraction of the WHOLE sphere that is unlit near one pole, integrated over the
 * true scalloped boundary rather than approximated by a cap.
 *
 * The solid angle above a boundary latitude `lat_b(lon)` is
 * `integral (1 - sin(lat_b)) dlon`, so the fraction of the sphere is that
 * divided by `4*pi`. Trapezoid over a uniform longitude grid, which is spectrally
 * accurate here because the integrand is periodic and smooth.
 *
 * PARAMETERS.md §4.3 says "roughly 1.4-2.8% of the sphere by area, per pole".
 * The value this returns at the spec's own d = 5.18 m is 0.89%. See
 * docs/AMENDMENTS.md A-05: the boundary latitudes §4.3 states (80.4 along a
 * meridian, 76.3 in a seam) bound the answer between the two circular caps those
 * latitudes cut, 0.70% and 1.41%, so no implementation that reproduces §4.3's
 * own latitudes can land in the stated range. 1.4% is the seam-direction cap,
 * i.e. the strict upper bound, and 2.8% is that doubled.
 */
export function unlitPolarAreaFraction(rig: PreparedRig, samples = 720, sign: 1 | -1 = 1): number {
  let acc = 0;
  for (let i = 0; i < samples; i++) {
    const lon = -180 + (360 * i) / samples;
    const latB = coverageBoundaryLatitude(lon, rig, sign);
    acc += 1 - Math.sin(latB * DEG2RAD);
  }
  // (mean over longitude) * 2*pi / (4*pi) = mean / 2.
  return acc / samples / 2;
}

/**
 * The `cos(incidence) < 0.2` limit PARAMETERS.md §4.3 calls the practically
 * usable boundary — where resolution smear exceeds 5x and the image becomes
 * streaks. Latitude, found by bisection along a meridian at the given longitude.
 */
export function usableLatitude(
  lonDeg: number,
  rig: PreparedRig,
  minIncidenceCos = 0.2,
  sign: 1 | -1 = 1,
  iterations = 60,
): number {
  const best = (lat: number): number => {
    let m = -1;
    for (const p of rig.projectors) {
      if (!isIlluminated(lat, lonDeg, p)) continue;
      const c = incidenceCosine(lat, lonDeg, p);
      if (c > m) m = c;
    }
    return m;
  };
  let lo = 0;
  let hi = 90;
  if (best(sign * lo) < minIncidenceCos) return 0;
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (lo + hi);
    if (best(sign * mid) >= minIncidenceCos) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Best available incidence cosine at a point, over all projectors that light it. */
export function bestIncidenceCosine(latDeg: number, lonDeg: number, rig: PreparedRig): number {
  let m = 0;
  for (const p of rig.projectors) {
    if (!isIlluminated(latDeg, lonDeg, p)) continue;
    const c = incidenceCosine(latDeg, lonDeg, p);
    if (c > m) m = c;
  }
  return m;
}

/** Degrees to radians, re-exported so callers of this module need one import. */
export const DEG_TO_RAD = DEG2RAD;
