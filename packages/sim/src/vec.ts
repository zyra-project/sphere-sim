/**
 * Minimal 3-vector and 3x3 matrix arithmetic — the forward model's OWN copy.
 *
 * `packages/solver` has its own, and the two must never be merged. See
 * packages/sim/README.md: if both sides shared this file, the solver would
 * eventually be inverting the simulator's own arithmetic and every recovery
 * score the bench produces would be circular. A dot product is a silly thing to
 * duplicate right up until the moment somebody notices the duplication and
 * "helpfully" extracts it, which is exactly how the boundary erodes.
 *
 * Everything here is a pure function returning fresh objects. Nothing mutates
 * its arguments, because determinism (packages/sim/README.md) is much easier to
 * keep when no value can be changed out from under a caller.
 */

import type { Vec3 } from '../../calibration/src/index.ts';

export type { Vec3 };

/**
 * Row-major 3x3 matrix: `m[row * 3 + col]`.
 *
 * A flat tuple rather than nested arrays because rotation composition happens
 * once per projector per render and readability at the call site matters more
 * than the allocation.
 */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
export const UNIT_X: Vec3 = { x: 1, y: 0, z: 0 };
export const UNIT_Y: Vec3 = { x: 0, y: 1, z: 0 };
export const UNIT_Z: Vec3 = { x: 0, y: 0, z: 1 };

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function negate(a: Vec3): Vec3 {
  return { x: -a.x, y: -a.y, z: -a.z };
}

/** `a + b * s`, fused because it is the single most common shape in the tracer. */
export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/**
 * Normalize. Uses `Math.hypot` rather than `Math.sqrt(dot(a, a))`: the
 * projector sits ~6 sphere radii out and camera rays get scaled by metres, so
 * the intermediate square can be large enough that the accuracy of hypot's
 * scaling is worth the modest cost. A zero-length input returns zero rather
 * than NaN so a degenerate camera basis produces a black pixel instead of
 * poisoning an entire render with NaN.
 */
export function normalize(a: Vec3): Vec3 {
  const n = Math.hypot(a.x, a.y, a.z);
  if (n === 0) return { x: 0, y: 0, z: 0 };
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function identity(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** Rotation about +X by `rad`, right-handed. */
export function rotX(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/** Rotation about +Y by `rad`, right-handed. */
export function rotY(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Rotation about +Z by `rad`, right-handed. */
export function rotZ(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** `a * b`, i.e. apply `b` first then `a`. */
export function matMul(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out as unknown as Mat3;
}

/** `m * v`. */
export function matVec(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/**
 * `transpose(m) * v`. For a rotation matrix the transpose is the inverse, so
 * this is the world -> local direction of a pose without ever forming an
 * inverse or paying for a general solve.
 */
export function matTVec(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
    y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
    z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
  };
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * `Math.acos` that will not return NaN when a dot product of two unit vectors
 * lands at 1 + 2e-16. Grazing incidence at the sphere's limb is exactly where
 * this happens and exactly where PARAMETERS.md §4.3's interesting physics lives,
 * so it must not produce NaN.
 */
export function safeAcos(x: number): number {
  return Math.acos(clamp(x, -1, 1));
}

/** Wrap an angle in degrees into (-180, +180], the range conventions.ts §S uses. */
export function wrapDeg180(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}
