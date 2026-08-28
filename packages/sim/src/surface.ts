// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The surface the light lands on — the one place the forward model is allowed
 * to know what shape it is lighting.
 *
 * ## What this is for, and what it deliberately is not yet
 *
 * Every renderer and every metric in this package asks the same four questions
 * of the sphere: where does this ray meet it, which way does it face there,
 * where does that point sit in the content's coordinates, and give me points
 * spread evenly over it. Until now each caller answered them by naming the
 * sphere directly — `raySphereIntersect`, `worldToLatLon`, `latLonToWorld`,
 * `point / radius` — which meant the shape was decided in forty-odd places
 * rather than one.
 *
 * This module collects those four questions behind an interface. Phase 0 shipped
 * it with exactly one implementation — {@link SphereSurface}, which delegates to
 * the same functions in `geometry.ts` the callers used to call themselves.
 * **That was a seam, not a feature**, and it had to be: a refactor that moved a
 * number would not have been a seam at all. Phase 1 adds `mesh/surface.ts`'s
 * `MeshSurface`, which is what turns the interface from a rename into an
 * abstraction — and its own header records the two places the interface fitted
 * badly, which is the finding an abstraction with one implementor cannot produce. Nothing here renders anything new, nothing here can
 * load a file, and there is no mesh. `docs/ARBITRARY-SHAPES.md` is the plan this
 * is Phase 0 of, and its acceptance test is the one that matters: the bench must
 * produce a BYTE-IDENTICAL `bench-results.json` across this change. A seam that
 * moved a number would not be a seam, it would be a rewrite wearing one.
 *
 * ## Why the interface is this small
 *
 * It carries what the call sites use and nothing else. An interface with a
 * method nobody calls is a claim that the model does something it does not, and
 * the next person to implement it has no way to tell which methods are real.
 * The mesh will need more — a bounding volume hierarchy, per-triangle UVs, a
 * shadow query that is not just "is the point facing the lens" — and those go in
 * when there is a mesh to exercise them, not before.
 *
 * ## Where the sphere still shows through, on purpose
 *
 * {@link SurfaceCoord} is a latitude and a longitude. On a sphere that is the
 * content parameterization, exactly; on a mesh it will have to become the
 * surface's own UV, because a mesh has no latitude. Widening it now would mean
 * inventing a coordinate no implementation uses and converting the sphere into
 * and out of it for no reason — and the conversion would move the arithmetic,
 * which is precisely what the byte-identity gate forbids. So it stays lat/lon,
 * named as a surface coordinate rather than as a geographic one, and
 * `docs/ARBITRARY-SHAPES.md` Phase 1 widens it against a mesh that can show what
 * the widening costs.
 *
 * `PreparedRig.radiusM` and `PreparedProjector.radiusM` survive for the same
 * reason: they are load-bearing in the closed-form incidence arithmetic
 * PARAMETERS.md §4.1 states, which is a statement about a sphere and is checked
 * against the spec's own numbers. They are not the renderer's route to the
 * shape any more — {@link PreparedRig.surface} is — but deleting a field the
 * spec's arithmetic is written against would be a different change from this one.
 */

import type { Vec3 } from '../../calibration/src/index.ts';
import type { LatLon, SphereHit } from './geometry.ts';
import { latLonToWorld, raySphereIntersect, worldToLatLon } from './geometry.ts';
import { equalAreaLattice } from './metrics/sampling.ts';
import { scale } from './vec.ts';

/**
 * Which shape an implementation is.
 *
 * `'mesh'` arrived with `docs/ARBITRARY-SHAPES.md` Phase 1 and is the reason
 * this field is not dead weight: Phase 0 could reasonably have been accused of
 * adding a discriminant nothing discriminates on. The GPU is where it earns its
 * keep, because a sphere is an analytic intersection in GLSL and a mesh is a
 * traversal, and no amount of interface hides that difference.
 */
export type SurfaceKind = 'sphere' | 'mesh';

/**
 * Where a ray met the surface.
 *
 * Structurally identical to {@link SphereHit}, and that is deliberate: the
 * sphere implementation returns the hit `raySphereIntersect` produced, by
 * reference, rather than copying it into a new object. A copy would be a second
 * place for the three numbers to be assembled, and assembling a float twice is
 * how two renderers that agree on the maths stop agreeing on the bits.
 */
export interface SurfaceHit {
  /** Parametric distance along the (unit) ray direction, metres. */
  t: number;
  /** World-frame intersection point. */
  point: Vec3;
  /** Outward unit normal at the intersection. */
  normal: Vec3;
}

/**
 * Where a surface point sits in the CONTENT's own coordinates.
 *
 * A latitude and a longitude today, because the only surface is a sphere and on
 * a sphere that is the content parameterization rather than an approximation of
 * one. See the module note: this is the field Phase 1 has to widen, and it is
 * named for the job it does rather than for the shape it currently describes.
 */
export type SurfaceCoord = LatLon;

/**
 * One equal-area sample of the surface: a point, the normal there, and its
 * content coordinate.
 *
 * Not `SurfaceSample` — `render.ts` already exports that name for a much richer
 * per-point record (weights, coverage, target radiance) and both reach the
 * package barrel.
 */
export interface SurfaceAreaSample {
  point: Vec3;
  normal: Vec3;
  coord: SurfaceCoord;
}

/**
 * What the forward model needs to know about the shape it is lighting.
 *
 * Every method is a pure function of its arguments and the surface's own
 * definition. No caching, no mutable state, no seed: the determinism guarantee
 * in packages/sim/README.md runs straight through here.
 */
export interface Surface {
  /**
   * Which implementation this is.
   *
   * A discriminant rather than an `instanceof`, so a worker can be handed one
   * across a structured clone and still branch on it. Nothing in this package
   * branches on it today — the interface is the point — but the display shader
   * will have to, because a sphere is an analytic intersection in GLSL and a
   * mesh is a traversal.
   */
  readonly kind: SurfaceKind;

  /**
   * Radius of a world-frame bounding sphere centred on the world origin.
   *
   * conventions.ts §W puts the origin at the sphere centre, so for the sphere
   * this IS the surface rather than a bound on it. It is what the limb constant
   * `R/d` of PARAMETERS.md §4.1 is built from, and for a mesh it becomes the
   * bounding radius that the same constant generalizes to.
   */
  readonly boundsRadiusM: number;

  /**
   * Nearest intersection with a ray, or `null`.
   *
   * `dir` must be unit length; callers normalize once and reuse the ray many
   * times, so re-normalizing in the innermost loop would be wasted work.
   */
  intersect(origin: Vec3, dir: Vec3, tMin?: number): SurfaceHit | null;

  /** Content coordinate of a point on the surface. */
  coordAt(point: Vec3): SurfaceCoord;

  /** The surface point at a content coordinate — the inverse of {@link coordAt}. */
  pointAt(coord: SurfaceCoord): Vec3;

  /** Outward unit normal at a point known to be ON the surface. */
  normalAt(point: Vec3): Vec3;

  /**
   * `n` points spread evenly over the surface, each standing for the same area.
   *
   * Equal-area rather than equal-parameter, and the distinction is the whole
   * reason `metrics/sampling.ts` exists: with equal weights an ordinary mean is
   * already an area-weighted mean and an ordinary percentile is already the
   * area-weighted percentile, so there is no weight for a metric to forget.
   */
  sampleArea(n: number): SurfaceAreaSample[];

  /**
   * Is the lens above this point's local horizon?
   *
   * Half of the visibility test, and the cheap half. `coverage.ts` runs it
   * first, then the raster test, then {@link Surface.shadowed} — cheapest
   * rejection first, because on a mesh the third one costs a hierarchy
   * traversal and the first two throw most points out before it runs.
   */
  facesLens(point: Vec3, normal: Vec3, lens: Vec3): boolean;

  /**
   * Does the surface come between this point and the lens?
   *
   * The other half, and the one a sphere does not have. `SphereSurface` answers
   * `false` unconditionally and that is not a stub — a convex body cannot come
   * between a point on itself and anything outside it, which is exactly why
   * `coverage.ts` got away with a facing test for the whole of Phase 0.
   *
   * `packages/sim/src/mesh/surface.ts` said this method would join the interface
   * "in the commit that makes that change measurable" rather than
   * speculatively. This is that commit.
   */
  shadowed(point: Vec3, lens: Vec3): boolean;
}

/**
 * The sphere of PARAMETERS.md §1, centred on the world origin per
 * conventions.ts §W.
 *
 * Every method delegates to the function the call sites used to call directly,
 * with the same arguments in the same order, so the arithmetic is not merely
 * equivalent — it is the same arithmetic. `test/surface.test.ts` pins that
 * against the free functions rather than trusting this sentence.
 */
export class SphereSurface implements Surface {
  readonly kind = 'sphere' as const;

  // Declared and assigned rather than written as a constructor parameter
  // property: tsconfig sets `erasableSyntaxOnly`, so `constructor(readonly x)`
  // is a compile error in this repo. Node runs the TypeScript directly and
  // parameter properties are the one class feature that needs emitting.
  readonly radiusM: number;

  constructor(radiusM: number) {
    if (!(radiusM > 0) || !Number.isFinite(radiusM)) {
      throw new Error(`sphere radius must be finite and positive, got ${radiusM}`);
    }
    this.radiusM = radiusM;
  }

  get boundsRadiusM(): number {
    return this.radiusM;
  }

  intersect(origin: Vec3, dir: Vec3, tMin = 1e-9): SurfaceHit | null {
    return raySphereIntersect(origin, dir, this.radiusM, tMin);
  }

  coordAt(point: Vec3): SurfaceCoord {
    return worldToLatLon(point);
  }

  pointAt(coord: SurfaceCoord): Vec3 {
    return latLonToWorld(coord.latDeg, coord.lonDeg, this.radiusM);
  }

  normalAt(point: Vec3): Vec3 {
    return scale(point, 1 / this.radiusM);
  }

  /**
   * The facing test, in the expression the call sites used before `Surface`
   * existed — and `normal` is deliberately unused.
   *
   * A sphere centred on the world origin (conventions.ts §W) has its outward
   * normal parallel to its own position, so `dot(point, lens - point)` and
   * `dot(normal, lens - point)` differ by the positive factor `1/R` and can
   * never differ in SIGN. The sign is all this returns.
   *
   * They can, however, differ in the last bit, and there is one place in this
   * package where that matters: `coverageBoundaryLatitude` bisects sixty times
   * to find the latitude at which this test flips, converging to within about
   * 1e-18 of the terminator. That is exactly the neighbourhood where two
   * algebraically identical expressions can round to opposite sides of zero —
   * and the boundary it finds feeds `unlitPolarAreaFraction`, which feeds
   * `bench-results.json`, which is byte-compared.
   *
   * So the original expression stays. Using the passed normal here would be
   * tidier, equally correct as mathematics, and would put a plausible-looking
   * diff in a number that `docs/ARBITRARY-SHAPES.md` Phase 0 exists to hold
   * still.
   */
  facesLens(point: Vec3, _normal: Vec3, lens: Vec3): boolean {
    return point.x * (lens.x - point.x) + point.y * (lens.y - point.y) + point.z * (lens.z - point.z) > 0;
  }

  /**
   * Never. A sphere is convex, so no part of it lies between a point on its
   * surface and anything outside it.
   *
   * Not a stub: this IS the sphere's answer, and it is the reason the whole of
   * Phase 0 could treat "faces the lens" as the entire visibility test.
   */
  shadowed(_point: Vec3, _lens: Vec3): boolean {
    return false;
  }

  sampleArea(n: number): SurfaceAreaSample[] {
    const lattice = equalAreaLattice(n);
    const out = new Array<SurfaceAreaSample>(lattice.length);
    for (let i = 0; i < lattice.length; i++) {
      const s = lattice[i];
      out[i] = {
        // The lattice's `unit` IS the outward normal on a sphere, and reusing it
        // rather than recomputing `point / R` keeps the normal handed to a
        // metric bit-identical to the one it got before this seam existed.
        normal: s.unit,
        point: latLonToWorld(s.latDeg, s.lonDeg, this.radiusM),
        coord: { latDeg: s.latDeg, lonDeg: s.lonDeg },
      };
    }
    return out;
  }
}

/** {@link SphereSurface}, for callers that would rather not write `new`. */
export function sphereSurface(radiusM: number): Surface {
  return new SphereSurface(radiusM);
}

/**
 * Does PARAMETERS.md's blend-and-mask model mean anything on this surface?
 *
 * It is written for a sphere, in two places that both stop being defined the
 * moment the surface is not one:
 *
 *  - **The blend ramp.** `coverage.ts` measures `t` inward from
 *    `theta_max = acos(R/d)` — the sphere's LIMB. An arbitrary mesh has no
 *    single limb angle, and a `MeshSurface` would hand back the angular radius
 *    of its BOUNDING SPHERE, which is a number rather than an answer: it is not
 *    the distance to the edge of the projector's footprint, which is what a
 *    crossfade needs. The `'sector'` reading is worse — it assigns longitude
 *    wedges from lens azimuth, which presumes a ring of lenses around a
 *    rotationally symmetric object.
 *  - **The polar mask.** `set bottommask 60,70` is a fact about a sphere hanging
 *    from a ceiling mount that occludes its north cap. On a mesh the latitude it
 *    keys on is a UV coordinate wearing a latitude's name, so the mask would
 *    attenuate by texture row.
 *
 * So on anything but a sphere both are REFUSED rather than approximated: every
 * projector that reaches a point contributes equally, and the mask is 1.
 *
 * That produces hard seams where each projector's footprint ends, and that is
 * the point. A crossfade computed from a bounding sphere would look like a
 * blend, photograph like a blend, and be a claim about a shape nobody measured —
 * which is the failure `docs/ARBITRARY-SHAPES.md` exists to prevent. A visible
 * seam is a true statement about coverage; a smooth gradient would be a false
 * one.
 *
 * Phase 3 replaces this with a screen-space distance to the footprint edge,
 * which is what projection-mapping software actually does and which must
 * degenerate to the limb ramp on a sphere. This predicate is the single place
 * that decision is made, so that is the one line Phase 3 changes.
 */
export function blendModelApplies(surface: Surface): boolean {
  return surface.kind === 'sphere';
}
