// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Frames, sphere intersection, and pose composition — the forward model's own
 * independent implementation of conventions.ts §W, §S and §R.
 *
 * The solver implements the same prose separately. Where the two disagree the
 * bench's pose-recovery error explodes, which is the alarm working. Nothing in
 * here may be imported by `packages/solver`.
 */

import type { ProjectorPose, Vec3 } from '../../calibration/src/index.ts';
import type { Mat3 } from './vec.ts';
import {
  DEG2RAD,
  RAD2DEG,
  addScaled,
  dot,
  matMul,
  matVec,
  normalize,
  rotX,
  rotY,
  rotZ,
  safeAcos,
  scale,
  sub,
  wrapDeg180,
} from './vec.ts';

/** A latitude/longitude pair in degrees. conventions.ts §S. */
export interface LatLon {
  latDeg: number;
  lonDeg: number;
}

/**
 * Sphere surface point from latitude and longitude, conventions.ts §S:
 * `p = R * (cos(lat)cos(lon), cos(lat)sin(lon), sin(lat))`.
 *
 * `(0, 0)` lands on `+X` — PARAMETERS.md's Conventions section ties that to
 * SOS's requirement that source imagery is centred on the prime meridian, so
 * getting this wrong rotates every rendered map by a whole quadrant and the
 * mistake is invisible on a symmetric test pattern.
 */
export function latLonToWorld(latDeg: number, lonDeg: number, radiusM: number): Vec3 {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const cl = Math.cos(lat);
  return {
    x: radiusM * cl * Math.cos(lon),
    y: radiusM * cl * Math.sin(lon),
    z: radiusM * Math.sin(lat),
  };
}

/**
 * Inverse of {@link latLonToWorld}. Radius is not returned: callers that care
 * about it already know it, and returning it invites code that trusts a
 * ray-traced hit point to be exactly on the sphere.
 *
 * `atan2(0, 0)` is 0 in IEEE-754, so both poles report longitude 0 rather than
 * NaN. That is a convention, not an accident: the polar region is where
 * PARAMETERS.md §4.3's scalloped unlit lobe lives and a NaN there would
 * silently poison the coverage integral.
 */
export function worldToLatLon(p: Vec3): LatLon {
  const r = Math.hypot(p.x, p.y, p.z);
  if (r === 0) return { latDeg: 0, lonDeg: 0 };
  return {
    latDeg: Math.asin(Math.max(-1, Math.min(1, p.z / r))) * RAD2DEG,
    lonDeg: Math.atan2(p.y, p.x) * RAD2DEG,
  };
}

/**
 * Texture longitude -> world longitude, conventions.ts §S:
 * `lon_world = lon_texture + rotationOffsetDeg`.
 *
 * The direction matters and is easy to invert by accident. `rotationOffsetDeg`
 * describes how far the *sphere* has been rotated mechanically (PARAMETERS.md
 * §1, `theta_rot`, class CFG). Rotating the physical sphere eastward carries the
 * painted texture eastward with it, so a texel that was authored at texture
 * longitude 0 now sits at world longitude `+rotationOffsetDeg`. The renderer
 * needs the other direction — given a world point, which texel? — so it calls
 * {@link worldLonToTextureLon}.
 */
export function applySphereRotation(textureLonDeg: number, rotationOffsetDeg: number): number {
  return wrapDeg180(textureLonDeg + rotationOffsetDeg);
}

/** Inverse of {@link applySphereRotation}: world longitude -> texture longitude. */
export function worldLonToTextureLon(worldLonDeg: number, rotationOffsetDeg: number): number {
  return wrapDeg180(worldLonDeg - rotationOffsetDeg);
}

/** A ray hit against the sphere. */
export interface SphereHit {
  /** Parametric distance along the (unit) ray direction, metres. */
  t: number;
  /** World-frame intersection point. */
  point: Vec3;
  /** Outward unit normal at the intersection. */
  normal: Vec3;
}

/**
 * Nearest intersection of a ray with the sphere centred on the world origin,
 * or `null`.
 *
 * `dir` must be unit length; the tracer normalizes once and reuses the ray many
 * times, so re-normalizing here would be wasted work in the innermost loop.
 *
 * ## Why this is not the quadratic formula from a textbook
 *
 * The projector sits ~6 sphere radii from the centre, so `dot(o, o)` is about
 * 26.8 m^2 while `dot(o, dir)^2` is about the same number. The discriminant
 * written as `b*b - 4ac` is then a difference of two large, nearly equal
 * quantities and loses roughly half the available mantissa exactly where
 * PARAMETERS.md §4.3 needs precision: at grazing incidence near the limb, which
 * is the boundary of the scalloped unlit polar region.
 *
 * So the discriminant is formed geometrically instead. With `h = dot(o, dir)`,
 * the vector `m = o - h*dir` is the perpendicular offset from the sphere centre
 * to the ray line. Its squared length is small (0 to R^2) and is computed
 * without any large cancellation, and `disc = R^2 - |m|^2` is then a difference
 * of two same-magnitude small numbers — well conditioned all the way to the
 * tangent, where it goes to zero smoothly.
 *
 * The roots themselves use the sign-stable form `q = -(h + sign(h)*sqrt(disc))`,
 * `t = {q, c/q}`, so the near root never comes out of a cancelling subtraction
 * either.
 */
export function raySphereIntersect(
  origin: Vec3,
  dir: Vec3,
  radiusM: number,
  tMin = 1e-9,
): SphereHit | null {
  const h = dot(origin, dir);
  // Perpendicular offset of the sphere centre from the ray line.
  const mx = origin.x - h * dir.x;
  const my = origin.y - h * dir.y;
  const mz = origin.z - h * dir.z;
  const disc = radiusM * radiusM - (mx * mx + my * my + mz * mz);
  if (disc < 0) return null;

  const sq = Math.sqrt(disc);
  const c = dot(origin, origin) - radiusM * radiusM;
  // sign(h) with sign(0) := +1, so q never lands on zero for a ray that starts
  // outside and points at the sphere.
  const q = -(h + (h >= 0 ? sq : -sq));

  let t0: number;
  let t1: number;
  if (q === 0) {
    // Degenerate: ray origin sits on the sphere centre plane through the
    // tangent. Fall back to the direct roots; there is no cancellation left to
    // avoid because h is zero.
    t0 = -sq;
    t1 = sq;
  } else {
    t0 = q;
    t1 = c / q;
  }
  if (t0 > t1) {
    const swap = t0;
    t0 = t1;
    t1 = swap;
  }

  const t = t0 > tMin ? t0 : t1 > tMin ? t1 : NaN;
  if (!Number.isFinite(t)) return null;

  const point = addScaled(origin, dir, t);
  return { t, point, normal: scale(point, 1 / radiusM) };
}

/**
 * The projector's rotation matrix, conventions.ts §R:
 * `R = Rz(yaw) * Ry(-pitch) * Rx(roll)`.
 *
 * The negated pitch is not a typo and not a preference. §R states that positive
 * pitch raises the optical axis toward `+Z`; a right-handed rotation about `+Y`
 * lowers `+X` toward `-Z`, so the sign has to flip for the documented meaning to
 * hold. Writing `Ry(pitch)` here typechecks, renders something plausible, and
 * mirrors every projector about the equator.
 */
export function projectorRotationMatrix(pose: ProjectorPose): Mat3 {
  return matMul(
    rotZ(pose.yawDeg * DEG2RAD),
    matMul(rotY(-pose.pitchDeg * DEG2RAD), rotX(pose.rollDeg * DEG2RAD)),
  );
}

/**
 * The projector's axes in the world frame.
 *
 * conventions.ts §R fixes the canonical (pre-rotation) frame as optical axis
 * `+X`, right `-Y`, up `+Z`. The right vector being `-Y` rather than `+Y` is
 * what makes a right-handed world frame produce an image that is not mirrored:
 * with the lens looking along `+X` and up along `+Z`, the viewer's right hand
 * points at `-Y`.
 */
export interface ProjectorBasis {
  /** Unit optical axis, pointing out of the lens. */
  axis: Vec3;
  /** Unit image-right vector. */
  right: Vec3;
  /** Unit image-up vector. */
  up: Vec3;
  /** The composed rotation, world <- canonical. */
  rotation: Mat3;
}

export function projectorBasis(pose: ProjectorPose): ProjectorBasis {
  const rotation = projectorRotationMatrix(pose);
  return {
    rotation,
    axis: matVec(rotation, { x: 1, y: 0, z: 0 }),
    right: matVec(rotation, { x: 0, y: -1, z: 0 }),
    up: matVec(rotation, { x: 0, y: 0, z: 1 }),
  };
}

/**
 * Yaw and pitch that point a lens at the sphere centre (the world origin).
 *
 * Used to build the nominal rigs of PARAMETERS.md §2, where the aim direction
 * is given as "at sphere center" rather than as angles. Roll is not determined
 * by an aim point and is left to the caller (§2 nominal is 0, and notes that a
 * degree of roll is invisible on a test grid until it interacts with the blend
 * region).
 *
 * Inverting §R for a pure aim: `R * (1,0,0) = (cos(yaw)cos(pitch),
 * sin(yaw)cos(pitch), sin(pitch))`, so pitch is `asin(dir.z)` and yaw is
 * `atan2(dir.y, dir.x)`. For a lens at azimuth `phi` and the same height as the
 * sphere centre this gives `yaw = phi + 180`, `pitch = 0`, which is the identity
 * §R states and geometry.test.ts asserts.
 */
export function aimAtSphereCenter(position: Vec3): { yawDeg: number; pitchDeg: number } {
  const dir = normalize(scale(position, -1));
  return {
    yawDeg: wrapDeg180(Math.atan2(dir.y, dir.x) * RAD2DEG),
    pitchDeg: Math.asin(Math.max(-1, Math.min(1, dir.z))) * RAD2DEG,
  };
}

/**
 * Angular distance in degrees between two directions on the sphere, computed
 * from the chord rather than from the dot product.
 *
 * `acos(dot)` loses precision for small angles — the derivative of acos is
 * infinite at 1 — and small angles are exactly what the sub-projector point
 * neighbourhood in PARAMETERS.md §4.1 is made of.
 */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const ua = normalize(a);
  const ub = normalize(b);
  const chord = Math.hypot(ua.x - ub.x, ua.y - ub.y, ua.z - ub.z);
  return 2 * Math.asin(Math.min(1, chord / 2)) * RAD2DEG;
}

/**
 * Angular distance in degrees from a surface point to a projector's
 * sub-projector point — the `theta` of PARAMETERS.md §4.1.
 *
 * The sub-projector point is where the line from the lens to the sphere centre
 * pierces the surface, so `theta` is just the angle between the surface normal
 * and the lens direction.
 */
export function subProjectorAngleDeg(normal: Vec3, lensPosition: Vec3): number {
  return angleBetweenDeg(normal, lensPosition);
}

/** Convenience: the world-frame ray from `from` to `to`, normalized. */
export function directionTo(from: Vec3, to: Vec3): Vec3 {
  return normalize(sub(to, from));
}

/** Angle in degrees whose cosine is `x`, clamped. */
export function acosDeg(x: number): number {
  return safeAcos(x) * RAD2DEG;
}
