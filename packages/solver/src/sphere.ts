// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Camera pixel -> ray -> sphere surface. The solver's own derivation.
 *
 * Two things live here, and they are separate on purpose:
 *
 *  1. A pinhole camera with radial and tangential distortion. conventions.ts
 *     says nothing about the *camera* — it is not part of the boundary object —
 *     so the model is the solver's to define. It deliberately reuses the §I/§D
 *     algebra of the projector (normalized y up, pixel v down, Brown-Conrady in
 *     the ideal -> distorted direction) so that this package contains exactly
 *     one set of imaging conventions rather than two subtly different ones.
 *     The camera differs from the projector in one respect only: its interior
 *     orientation is given directly as (fx, fy, cx, cy) rather than through a
 *     field of view and a lens shift, because that is the form an operator's
 *     checkerboard calibration produces.
 *
 *     The distortion matters. PARAMETERS.md's experiment plan asks explicitly
 *     whether a phone suffices for a real calibration, and a phone's wide lens
 *     carries several percent of radial distortion at the frame edge. Modelling
 *     it as zero would put a systematic curve into the residual field, which is
 *     precisely the "structure means the model is wrong" signal the progress
 *     page is built to surface — and it would be our own fault, not the rig's.
 *
 *  2. Ray-sphere intersection against the sphere of known radius R
 *     (PARAMETERS.md §1, class DOC, 0.8636 m) centred at the world origin
 *     (conventions.ts §W).
 *
 * The camera goes pixel -> ray, which is the direction §D does NOT define, so
 * this file inverts the distortion map. That inversion is the solver's own and
 * is used only on the camera side; the projector residual path never inverts
 * anything. See project.ts.
 */

import {
  type Vec3,
  vAdd,
  vDot,
  vNorm,
  vNormalize,
  vScale,
  vSub,
} from './linalg.ts';
import {
  frameAxes,
  projectorPixelToRay,
  rotationMatrix,
  rotationWithDerivatives,
  undistortNormalized,
  type FrameAxes,
  type ProjectorModel,
  type RotationWithDerivatives,
} from './project.ts';
import { mat3MulVec } from './linalg.ts';

/**
 * Interior orientation of the observing camera, in pixels.
 *
 * `focalScale` is not here: it is a free parameter of the bundle and lives on
 * `CameraModel`, so that a solve with the focal held fixed and a solve with it
 * free share the same intrinsics record.
 */
export interface CameraIntrinsics {
  resX: number;
  resY: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
}

/**
 * The camera's pose DIFFERENCE between two observation epochs, expressed per
 * unit of epoch separation.
 *
 * The unit is ONE PATTERN FRAME, because that is the only ordering the decoder
 * can read off its own input: `decode.ts` knows the frame ORDER of a capture
 * from the pattern contract it defines, and does not know the frame interval in
 * seconds. A quantity expressed per frame needs no such constant, and the
 * seconds cancel out of every residual anyway — only the ratio between the
 * epochs of two observations matters.
 *
 * **Read "rate" here as a parameterisation, not as a trajectory.** With this
 * pipeline's decode every capture reports the same two epochs, so the
 * separation is one constant and this is exactly the `u`-to-`v` pose difference
 * divided by four frames. It is written as a rate so that a decode reporting
 * different separations would need no second code path — not because anything
 * here integrates a motion over time. Round 3 shipped the opposite claim and
 * round 3's critic falsified it; see the header of `bundle.ts`.
 *
 * Zero everywhere is a camera on a tripod, and is the default state of every
 * solve. See `BundleFreeFlags.cameraEpochPose`.
 */
export interface CameraRate {
  /** Metres per frame. */
  px: number;
  py: number;
  pz: number;
  /** Degrees per frame, on the same three Euler angles as the pose. */
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export function zeroCameraRate(): CameraRate {
  return { px: 0, py: 0, pz: 0, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
}

export interface CameraModel {
  position: Vec3;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  intrinsics: CameraIntrinsics;
  /**
   * Multiplies fx and fy. Free parameter when `freeCameraFocal` is on, 1
   * otherwise. A single scale rather than independent fx and fy because a
   * calibrated camera's aspect ratio is far better determined than its absolute
   * focal length, and freeing both invites the focal to trade against the
   * camera's distance from the sphere.
   */
  focalScale: number;
  /**
   * The pose difference between observation epochs, per pattern frame of
   * separation. See `CameraRate` for why "rate" is a parameterisation here and
   * not a trajectory.
   *
   * The pose above is then the pose at the reference epoch the bundle chose,
   * and the camera at epoch `t` is `pose + velocity * (t - tRef)`. A tripod
   * capture leaves this at zero and every arithmetic result is identical to a
   * solver that had no such field — which is asserted rather than assumed, in
   * `test/epoch-pose.test.ts`.
   */
  velocity: CameraRate;
}

/** The camera as it was at `t`, given a reference epoch. Pure; allocates. */
export function cameraAtTime(cam: CameraModel, t: number, tRef: number): CameraModel {
  const d = t - tRef;
  if (d === 0) return cam;
  const v = cam.velocity;
  return {
    position: {
      x: cam.position.x + v.px * d,
      y: cam.position.y + v.py * d,
      z: cam.position.z + v.pz * d,
    },
    yawDeg: cam.yawDeg + v.yawDeg * d,
    pitchDeg: cam.pitchDeg + v.pitchDeg * d,
    rollDeg: cam.rollDeg + v.rollDeg * d,
    intrinsics: cam.intrinsics,
    focalScale: cam.focalScale,
    velocity: cam.velocity,
  };
}

/** Free-parameter ordering for one camera. `const` bindings, not an enum (see project.ts). */
export const CAM_PX = 0;
export const CAM_PY = 1;
export const CAM_PZ = 2;
export const CAM_YAW = 3;
export const CAM_PITCH = 4;
export const CAM_ROLL = 5;
export const CAM_FOCAL = 6;
/**
 * The six velocity slots, in the same order as the six pose slots.
 *
 * They sit after the focal rather than beside their own pose components so
 * that the first seven indices — and therefore every slot number a caller
 * built before this existed — are unchanged.
 */
export const CAM_VPX = 7;
export const CAM_VPY = 8;
export const CAM_VPZ = 9;
export const CAM_VYAW = 10;
export const CAM_VPITCH = 11;
export const CAM_VROLL = 12;
export const CAM_PARAM_COUNT = 13;

/** Pose slot each velocity slot differentiates. `-1` for the non-velocity slots. */
export const CAM_VELOCITY_OF: readonly number[] = [
  -1, -1, -1, -1, -1, -1, -1, CAM_PX, CAM_PY, CAM_PZ, CAM_YAW, CAM_PITCH, CAM_ROLL,
];

export const CAM_PARAM_NAMES: readonly string[] = [
  'px',
  'py',
  'pz',
  'yawDeg',
  'pitchDeg',
  'rollDeg',
  'focalScale',
  'vpx',
  'vpy',
  'vpz',
  'vyawDeg',
  'vpitchDeg',
  'vrollDeg',
];

/**
 * Camera pixel -> ideal normalized coordinates.
 *
 * Inverts the pixel mapping (`u = cx + fx*xd`, `v = cy - fy*yd`, §D) and then
 * the Brown-Conrady map by Newton iteration.
 *
 * These are a pure function of the pixel and the *fixed* intrinsics scaled by
 * `focalScale`, so for a solve with the focal held they can be computed once per
 * correspondence and cached — which is what decode-time caching in bundle.ts
 * relies on.
 */
export function cameraPixelToNormalized(
  cam: CameraModel,
  u: number,
  v: number,
): { x: number; y: number } {
  const k = cam.intrinsics;
  const fx = k.fx * cam.focalScale;
  const fy = k.fy * cam.focalScale;
  const xd = (u - k.cx) / fx;
  const yd = (k.cy - v) / fy;
  return undistortNormalized(xd, yd, k.k1, k.k2, k.p1, k.p2);
}

export interface CameraRay {
  origin: Vec3;
  /** Unit direction, world frame. */
  dir: Vec3;
  /** Unnormalised direction, kept because the derivative of `normalize` needs its length. */
  raw: Vec3;
  rawLength: number;
}

/**
 * Ideal normalized coordinates -> world ray.
 *
 * §I inverted: a normalized point (x, y) corresponds to the direction
 * `axis + x*right + y*up` in the camera's frame. In the canonical frame of §R
 * (axis +X, right -Y, up +Z) that is the constant vector `(1, -x, y)`, so the
 * world direction is simply `R * (1, -x, y)`. Writing it that way rather than
 * as a sum of three world axes makes the derivative below one matrix-vector
 * product instead of three.
 */
export function rayFromNormalized(cam: CameraModel, x: number, y: number): CameraRay {
  const r = rotationMatrix(cam.yawDeg, cam.pitchDeg, cam.rollDeg);
  const raw = mat3MulVec(r, { x: 1, y: -x, z: y });
  const len = vNorm(raw);
  return { origin: cam.position, dir: vScale(raw, 1 / len), raw, rawLength: len };
}

export function cameraPixelToRay(cam: CameraModel, u: number, v: number): CameraRay {
  const n = cameraPixelToNormalized(cam, u, v);
  return rayFromNormalized(cam, n.x, n.y);
}

export interface SphereHit {
  hit: boolean;
  /** Distance along the unit ray to the near intersection. */
  t: number;
  point: Vec3;
  /** Outward unit normal at the hit. */
  normal: Vec3;
  /**
   * Cosine of the angle between the incoming ray and the inward normal. Falls to
   * zero at the limb. PARAMETERS.md §4.1 uses the same quantity for the
   * projector side; here it is the *camera's* obliquity, which is what makes a
   * decoded fringe smeared and its correspondence uncertain.
   */
  cosIncidence: number;
}

const MISS: SphereHit = {
  hit: false,
  t: NaN,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
  cosIncidence: 0,
};

/**
 * Near intersection of a unit ray with the sphere of radius `radius` centred at
 * the world origin (conventions.ts §W puts the sphere centre at the origin, so
 * there is no centre term).
 *
 * Solving `|o + t d|^2 = R^2` gives `t^2 + 2 b t + c = 0` with `b = o.d` and
 * `c = |o|^2 - R^2`, whose textbook discriminant is `b^2 - c`. That form is
 * badly conditioned for exactly the situation we are in: the camera sits several
 * times the radius away, so `b^2` and `c` are both large and nearly equal, and
 * their difference — the small number that decides whether the ray grazes or
 * misses — is computed by cancelling most of the significant digits away.
 *
 * The stable rearrangement replaces the difference with a quantity that never
 * gets large. Writing `m = o - b d` for the component of the origin
 * perpendicular to the ray, the discriminant is exactly `R^2 - |m|^2`: the
 * squared radius minus the squared miss distance, both O(R^2), no cancellation
 * against the camera's distance at all. The near root is then `-b - sqrt(disc)`,
 * a large number minus a number bounded by `R`, which is also cancellation-free
 * for any camera outside the sphere.
 */
export function intersectSphere(origin: Vec3, dir: Vec3, radius: number): SphereHit {
  const b = vDot(origin, dir);
  const mx = origin.x - b * dir.x;
  const my = origin.y - b * dir.y;
  const mz = origin.z - b * dir.z;
  const disc = radius * radius - (mx * mx + my * my + mz * mz);
  if (disc < 0) return MISS;
  const sq = Math.sqrt(disc);
  const near = -b - sq;
  const far = -b + sq;
  // `near` is the entry point for a camera outside the sphere; if it is behind
  // the origin the camera is inside and the exit point is the visible one.
  const t = near > 0 ? near : far;
  if (!(t > 0)) return MISS;

  const point = vAdd(origin, vScale(dir, t));
  const normal = vScale(point, 1 / radius);
  return { hit: true, t, point, normal, cosIncidence: -vDot(dir, normal) };
}

export interface SphereHitJacobian {
  hit: SphereHit;
  /**
   * d(point)/d(camera params), 3 x CAM_PARAM_COUNT row-major.
   *
   * The focal column is filled only when `dNormalized` is supplied, and stays
   * zero otherwise — a solve with the focal held never asks for it. This used to
   * say the column was 'filled by finite differences in bundle.ts', and no such
   * code existed anywhere: freeing the focal added a parameter whose Jacobian
   * column was identically zero, so the normal equations were rank deficient by
   * one and `focalScale` came back as exactly 1.0 however wrong it was.
   */
  dPoint: Float64Array;
}

/**
 * Analytic derivative of the surface point with respect to the camera's six
 * pose degrees of freedom.
 *
 * The point is `X = o + t d`, and both `d` and `t` move when the camera moves:
 *
 *   - Rotation moves the direction only. With `w = R * (1, -x, y)` and
 *     `d = w/|w|`, the derivative of the normalisation is the projector
 *     `(I - d d^T)/|w|` applied to `dw/dtheta = (dR/dtheta) * (1, -x, y)`.
 *   - Translation moves the origin only.
 *   - `t` moves in response to both, and its derivative comes from
 *     differentiating the quadratic in place rather than from re-deriving the
 *     root: from `t^2 + 2 b t + c = 0`,
 *
 *         dt = -(t * db + o . do) / (t + b)
 *
 *     with `db = do . d + o . dd` and `dc = 2 o . do`. The denominator `t + b`
 *     is `-sqrt(disc)` at the near root, so it vanishes only exactly at the limb
 *     where the ray is tangent — the same place the decode already rejects for
 *     lack of modulation. It is guarded anyway.
 */
export function intersectSphereJacobian(
  cam: CameraModel,
  x: number,
  y: number,
  radius: number,
  /** Precomputed rotation and derivatives; see the note on `projectPointJacobian`. */
  precomputedRotation?: RotationWithDerivatives,
  out?: Float64Array,
  /**
   * Elapsed time from the reference epoch to this observation, in pattern
   * frames. When supplied, the six velocity columns are filled as `dt` times
   * their own pose column — which is exact, not an approximation, because the
   * effective pose is affine in the rate: `pose(t) = pose + velocity * dt`.
   * Omit it (or pass 0) and those columns stay zero, which is what a solve with
   * the velocity held wants.
   */
  dt?: number,
  /**
   * d(x, y)/d(focalScale) for the normalised coordinate that was passed in.
   * Supplied only by a solve with the focal free; omit it and the focal column
   * stays zero, which is what a solve with the focal held wants.
   */
  dNormalized?: { dx: number; dy: number },
): SphereHitJacobian {
  const dPoint = out ?? new Float64Array(3 * CAM_PARAM_COUNT);
  dPoint.fill(0);
  const rot =
    precomputedRotation ?? rotationWithDerivatives(cam.yawDeg, cam.pitchDeg, cam.rollDeg);
  const canonical = { x: 1, y: -x, z: y };
  const raw = mat3MulVec(rot.r, canonical);
  const len = vNorm(raw);
  const dir = vScale(raw, 1 / len);
  const origin = cam.position;

  const hit = intersectSphere(origin, dir, radius);
  if (!hit.hit) return { hit, dPoint };

  const t = hit.t;
  const b = vDot(origin, dir);
  let denom = t + b;
  if (Math.abs(denom) < 1e-12) denom = denom >= 0 ? 1e-12 : -1e-12;

  // --- translation: do = e_i, dd = 0 ---
  for (let i = 0; i < 3; i++) {
    const eo = { x: i === 0 ? 1 : 0, y: i === 1 ? 1 : 0, z: i === 2 ? 1 : 0 };
    const db = vDot(eo, dir);
    const dt = -(t * db + vDot(origin, eo)) / denom;
    dPoint[0 * CAM_PARAM_COUNT + i] = eo.x + dir.x * dt;
    dPoint[1 * CAM_PARAM_COUNT + i] = eo.y + dir.y * dt;
    dPoint[2 * CAM_PARAM_COUNT + i] = eo.z + dir.z * dt;
  }

  // --- anything that moves the unnormalised direction and nothing else ---
  // Rotation and focal both land here: the camera stays put, `w` changes, and
  // the derivative of `w -> w/|w| -> intersection` is the same three lines
  // either way. Only the source of `dw` differs.
  const dirSlot = (dw: Vec3, slot: number): void => {
    // (I - d d^T) dw / |w|
    const proj = vDot(dir, dw);
    const dd = {
      x: (dw.x - dir.x * proj) / len,
      y: (dw.y - dir.y * proj) / len,
      z: (dw.z - dir.z * proj) / len,
    };
    const db = vDot(origin, dd);
    const dt = -(t * db) / denom;
    dPoint[0 * CAM_PARAM_COUNT + slot] = t * dd.x + dir.x * dt;
    dPoint[1 * CAM_PARAM_COUNT + slot] = t * dd.y + dir.y * dt;
    dPoint[2 * CAM_PARAM_COUNT + slot] = t * dd.z + dir.z * dt;
  };
  const rotSlot = (dR: Float64Array, slot: number): void => {
    dirSlot(mat3MulVec(dR, canonical), slot);
  };
  rotSlot(rot.dYaw, CAM_YAW);
  rotSlot(rot.dPitch, CAM_PITCH);
  rotSlot(rot.dRoll, CAM_ROLL);

  // --- focal: the normalised coordinate moves, so the canonical ray does ---
  // `canonical` is (1, -x, y), so d(canonical)/d(focalScale) is (0, -dx, dy)
  // and the rest is the same normalisation. The caller supplies d(x,y) because
  // it owns the pixel and the intrinsics; this function is handed x and y
  // already undistorted and cannot recover where they came from.
  if (dNormalized !== undefined) {
    dirSlot(mat3MulVec(rot.r, { x: 0, y: -dNormalized.dx, z: dNormalized.dy }), CAM_FOCAL);
  }

  // --- velocity: the chain rule on `pose(t) = pose + velocity * dt` ---
  if (dt !== undefined && dt !== 0) {
    for (let slot = CAM_VPX; slot <= CAM_VROLL; slot++) {
      const src = CAM_VELOCITY_OF[slot];
      dPoint[0 * CAM_PARAM_COUNT + slot] = dt * dPoint[0 * CAM_PARAM_COUNT + src];
      dPoint[1 * CAM_PARAM_COUNT + slot] = dt * dPoint[1 * CAM_PARAM_COUNT + src];
      dPoint[2 * CAM_PARAM_COUNT + slot] = dt * dPoint[2 * CAM_PARAM_COUNT + src];
    }
  }

  return { hit, dPoint };
}

/** The camera's frame axes, for callers that want to reason about where it looks. */
/**
 * Which decoded pixels are the ball.
 *
 * ## The test
 *
 * A structured-light correspondence says: projector pixel `(u, v)` was seen at
 * camera pixel `(x, y)`. Run the projector pixel back out as a ray from that
 * projector's own lens and ask whether it reaches the sphere at all. If it does
 * not, whatever the camera saw was not the ball — it was the wall, the floor,
 * the ceiling, or a visitor — and the correspondence is a confident, precise
 * statement about a surface nobody is solving for. docs/EXPERIMENT-4.md
 * measures what a tenth of those costs: three orders of magnitude.
 *
 * ## Why it is allowed to know this
 *
 * Everything it uses is in the solver's hands before a pixel is decoded:
 * PARAMETERS.md §1's sphere radius (class DOC), conventions.ts §W's placement of
 * the sphere centre at the world origin, and the NOMINAL projector calibration
 * the operator starts from. Nothing comes from the perturbed rig. That
 * distinction is the discipline `packages/bench/src/run.ts` is built around and
 * it is worth being explicit about here: a segmentation that used the true rig
 * would be an oracle, and every number downstream of it would be worthless.
 *
 * ## The chicken-and-egg in it, stated
 *
 * The test is only as good as the nominal it runs against. A projector a degree
 * off its documented aim moves the silhouette by a degree, so a genuine point
 * near the limb can fail and a room point just outside can pass. `marginFrac`
 * inflates the test sphere to buy the limb back, and that is a real trade: it
 * admits a thin annulus of room just outside the true silhouette.
 *
 * So this is a dependence on the answer, inside the step that produces the input
 * to finding it. It is a mild one — the sphere subtends about 19 degrees from a
 * projector at §2's throw and the §2 mount tolerances are near a degree — but it
 * is real, and it means this cannot rescue a rig whose documented calibration is
 * wildly wrong. It is not a substitute for knowing roughly where the projectors
 * are; it is a way of not being destroyed by the room once you do.
 */
export interface SphereSegmentation {
  /** PARAMETERS.md §1's sphere radius, metres. Class DOC. */
  radiusM: number;
  /**
   * The projector calibration to test against, indexed by the correspondence's
   * projector index. The NOMINAL one — what the operator starts from — never
   * the truth.
   */
  projectors: readonly ProjectorModel[];
  /**
   * How far to inflate the test sphere, as a fraction of its radius.
   *
   * The obvious reasoning says inflate it: a projector a degree off its
   * documented aim moves the silhouette by a degree, and a margin buys the
   * genuine limb points back. docs/EXPERIMENT-4.md measured that reasoning and
   * it is wrong, decisively — see {@link DEFAULT_SEGMENTATION_MARGIN}.
   *
   * A ray that passes between `R` and `(1 + margin) R` misses the real sphere
   * and travels on to the room, so it lands metres away while its projector
   * coordinate sits right at the silhouette edge. That is the most damaging
   * outlier available: geometrically plausible, systematically placed at the
   * limb, and wrong by the width of the room. The margin that protects the limb
   * is exactly the margin that admits it.
   */
  marginFrac: number;
}

/**
 * Zero, and it is a measurement rather than a default nobody thought about.
 *
 * docs/EXPERIMENT-4.md sweeps this. Any inflation at all admits the annulus of
 * rays that graze past the ball and land on the far wall, and those cost more
 * than the limb points an inflation keeps. Trimming the limb is not even a loss
 * on a clean capture: the points a zero margin removes are the grazing-incidence
 * decodes, which are the least certain ones in the set.
 */
export const DEFAULT_SEGMENTATION_MARGIN = 0;

/**
 * Build the predicate `DecodeOptions.segmentation` expects.
 *
 * The rotation matrix and pixel intrinsics of every projector are computed once,
 * here, rather than per correspondence: this runs on every pixel that survived
 * the modulation and decode gates, which is millions of them on a real frame.
 */
export function sphereSegmenter(seg: SphereSegmentation): (
  projector: number,
  u: number,
  v: number,
) => boolean {
  const testRadius = seg.radiusM * (1 + seg.marginFrac);
  return (projector: number, u: number, v: number): boolean => {
    const model = seg.projectors[projector];
    // A correspondence naming a projector the caller did not describe cannot be
    // tested, and passing it would make the option silently partial. Rejecting
    // is the safe direction: the alternative is admitting exactly the points
    // this exists to remove.
    if (model === undefined) return false;
    const dir = projectorPixelToRay(model, u, v);
    return intersectSphere(model.position, dir, testRadius).hit;
  };
}

export function cameraAxes(cam: CameraModel): FrameAxes {
  return frameAxes(rotationMatrix(cam.yawDeg, cam.pitchDeg, cam.rollDeg));
}

/**
 * Coarse cone fit to a bundle of ray directions, used by the bootstrap as a
 * distance sanity check.
 *
 * A sphere of radius R seen from distance d subtends a half-angle
 * `asin(R/d)`, so if the rays that produced valid correspondences really did
 * cover the visible cap, the widest of them recovers d. They usually do not
 * cover it — one projector lights well under half the sphere and the camera
 * sees part of that — so the half-angle this returns is a LOWER bound and the
 * implied distance an UPPER bound.
 *
 * That asymmetry is why initialize.ts uses it only in one direction: to pull a
 * camera in when its nominal distance is impossible given what it evidently
 * saw, never to push one out. Anything stronger would be reading a measurement
 * out of a bound.
 */
export function fitRayCone(dirs: readonly Vec3[]): { axis: Vec3; halfAngleRad: number } {
  if (dirs.length === 0) return { axis: { x: 1, y: 0, z: 0 }, halfAngleRad: 0 };
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const d of dirs) {
    sx += d.x;
    sy += d.y;
    sz += d.z;
  }
  const axis = vNormalize({ x: sx, y: sy, z: sz });
  let maxAngle = 0;
  for (const d of dirs) {
    const c = Math.min(1, Math.max(-1, vDot(axis, d)));
    const ang = Math.acos(c);
    if (ang > maxAngle) maxAngle = ang;
  }
  return { axis, halfAngleRad: maxAngle };
}

/** `d = R / sin(halfAngle)`, the distance implied by an observed angular radius. */
export function distanceFromAngularRadius(radius: number, halfAngleRad: number): number {
  const s = Math.sin(halfAngleRad);
  if (!(s > 1e-9)) return Infinity;
  return radius / s;
}

/** Convenience for the bootstrap: world point on the sphere from a camera pixel. */
export function cameraPixelToSurface(
  cam: CameraModel,
  u: number,
  v: number,
  radius: number,
): SphereHit {
  const ray = cameraPixelToRay(cam, u, v);
  return intersectSphere(ray.origin, ray.dir, radius);
}

/** Latitude/longitude of a surface point, conventions.ts §S. Degrees. */
export function latLonOf(p: Vec3): { latDeg: number; lonDeg: number } {
  const r = vNorm(p);
  if (r === 0) return { latDeg: 0, lonDeg: 0 };
  return {
    latDeg: (Math.asin(Math.min(1, Math.max(-1, p.z / r))) * 180) / Math.PI,
    lonDeg: (Math.atan2(p.y, p.x) * 180) / Math.PI,
  };
}

/** Surface point from latitude/longitude, conventions.ts §S. Degrees in, metres out. */
export function surfacePoint(latDeg: number, lonDeg: number, radius: number): Vec3 {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  return {
    x: radius * Math.cos(la) * Math.cos(lo),
    y: radius * Math.cos(la) * Math.sin(lo),
    z: radius * Math.sin(la),
  };
}

/** Re-exported so callers do not need linalg for the common vector ops. */
export { vAdd, vSub, vScale, vDot, vNorm, vNormalize };
