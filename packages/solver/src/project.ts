/**
 * World point -> projector pixel. The solver's own derivation of
 * conventions.ts §R, §I and §D.
 *
 * Nothing here was read from, copied from, or checked against `packages/sim`.
 * Every formula below is derived from the prose in
 * `packages/calibration/src/conventions.ts` and nothing else, because the whole
 * value of the bench rests on the two implementations being able to disagree.
 * Where the prose is ambiguous the reading taken is stated inline, and repeated
 * in the package README so an A/B disagreement can be traced to a clause rather
 * than to a typo.
 *
 * Direction of travel: the solver's residual is "project a known surface point
 * into a projector and compare against the decoded pixel", which is the same
 * direction §D defines the Brown-Conrady map in. So the residual path needs no
 * distortion inversion at all. An inversion is provided anyway
 * (`undistortNormalized`) but it is used only by the bootstrap in
 * initialize.ts, where projector pixels have to be turned back into rays before
 * any pose is known.
 *
 * ---------------------------------------------------------------------------
 * Derivation of §R, written out because a sign error here is invisible in unit
 * tests that only check round-trips.
 *
 * §R: `R = Rz(yaw) * Ry(-pitch) * Rx(roll)`, applied to a canonical frame whose
 * optical axis is +X, right is -Y, up is +Z. With the textbook right-handed
 * generators
 *
 *   Rz(t) = [[c,-s,0],[s,c,0],[0,0,1]]
 *   Ry(t) = [[c,0,s],[0,1,0],[-s,0,c]]
 *   Rx(t) = [[1,0,0],[0,c,-s],[0,s,c]]
 *
 * the product has columns
 *
 *   col0 = ( cy*cp,               sy*cp,               sp    )
 *   col1 = (-sy*cr - cy*sp*sr,    cy*cr - sy*sp*sr,    cp*sr )
 *   col2 = ( sy*sr - cy*sp*cr,   -cy*sr - sy*sp*cr,    cp*cr )
 *
 * writing cy=cos(yaw), sp=sin(pitch), cr=cos(roll) and so on. Two checks
 * against the prose:
 *
 *  - The optical axis is `R * (1,0,0)` = col0, whose z component is sin(pitch).
 *    Positive pitch therefore raises the axis toward +Z, as §R states.
 *  - With pitch=roll=0 the axis is (cos yaw, sin yaw, 0). A projector at
 *    azimuth phi sits at (d cos phi, d sin phi, z) and aiming at the origin
 *    needs the axis (-cos phi, -sin phi, ...), i.e. yaw = phi + 180. §R states
 *    exactly that.
 *
 * Roll sign check: the right and up vectors are `R * (0,-1,0)` = -col1 and
 * `R * (0,0,1)` = col2. Feeding a raster point (x, y) gives the outgoing
 * direction `axis + x*right + y*up`; expanding at yaw=pitch=0 sends the top of
 * the image (x=0, y=1) toward `sin(roll)*right + cos(roll)*up`, i.e. the top of
 * the projected image swings toward the right as seen from the lens looking
 * out. That is "clockwise", matching §R.
 * ---------------------------------------------------------------------------
 */

import type { Viewport } from '../../calibration/src/index.ts';
import {
  type Mat3,
  type Vec3,
  mat3Column,
  mat3Multiply,
  vDot,
  vNormalize,
  vSub,
} from './linalg.ts';

const DEG = Math.PI / 180;

/**
 * Everything the solver optimises about one projector.
 *
 * Deliberately a flat mutable record rather than the nested boundary type: the
 * LM step writes into it a few hundred thousand times per solve, and a flat
 * shape keeps the pack/unpack in bundle.ts obvious enough to audit by eye.
 */
export interface ProjectorModel {
  id: string;
  position: Vec3;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Native pixels for THIS projector, not the shared X screen. PARAMETERS.md §3.4. */
  resX: number;
  resY: number;
  pixelAspect: number;
  fovHDeg: number;
  shiftH: number;
  shiftV: number;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
}

/**
 * Free-parameter ordering for one projector. Written as `const` bindings rather
 * than an enum because Node 22 runs this file by type-stripping and
 * `erasableSyntaxOnly` forbids enums outright.
 *
 * The order is pose first, interior second, distortion last, which is also the
 * order the parameters become observable as the bootstrap tightens — handy when
 * reading a rank-deficiency report.
 */
export const PROJ_PX = 0;
export const PROJ_PY = 1;
export const PROJ_PZ = 2;
export const PROJ_YAW = 3;
export const PROJ_PITCH = 4;
export const PROJ_ROLL = 5;
export const PROJ_FOV = 6;
export const PROJ_SHIFT_H = 7;
export const PROJ_SHIFT_V = 8;
export const PROJ_K1 = 9;
export const PROJ_K2 = 10;
export const PROJ_P1 = 11;
export const PROJ_P2 = 12;
export const PROJ_PARAM_COUNT = 13;

export const PROJ_PARAM_NAMES: readonly string[] = [
  'px',
  'py',
  'pz',
  'yawDeg',
  'pitchDeg',
  'rollDeg',
  'fovHDeg',
  'shiftH',
  'shiftV',
  'k1',
  'k2',
  'p1',
  'p2',
];

// ---------------------------------------------------------------------------
// §R — rotation
// ---------------------------------------------------------------------------

/** `R = Rz(yaw) * Ry(-pitch) * Rx(roll)`, conventions.ts §R. Angles in degrees. */
export function rotationMatrix(yawDeg: number, pitchDeg: number, rollDeg: number): Mat3 {
  const cy = Math.cos(yawDeg * DEG);
  const sy = Math.sin(yawDeg * DEG);
  const cp = Math.cos(pitchDeg * DEG);
  const sp = Math.sin(pitchDeg * DEG);
  const cr = Math.cos(rollDeg * DEG);
  const sr = Math.sin(rollDeg * DEG);

  const m = new Float64Array(9);
  m[0] = cy * cp;
  m[1] = -sy * cr - cy * sp * sr;
  m[2] = sy * sr - cy * sp * cr;
  m[3] = sy * cp;
  m[4] = cy * cr - sy * sp * sr;
  m[5] = -cy * sr - sy * sp * cr;
  m[6] = sp;
  m[7] = cp * sr;
  m[8] = cp * cr;
  return m;
}

function rzMatrix(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return Float64Array.of(c, -s, 0, s, c, 0, 0, 0, 1);
}

function ryMatrix(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return Float64Array.of(c, 0, s, 0, 1, 0, -s, 0, c);
}

function rxMatrix(deg: number): Mat3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return Float64Array.of(1, 0, 0, 0, c, -s, 0, s, c);
}

export interface RotationWithDerivatives {
  r: Mat3;
  /** d(R)/d(yawDeg), and likewise for the other two. Per DEGREE, not per radian. */
  dYaw: Mat3;
  dPitch: Mat3;
  dRoll: Mat3;
}

/**
 * The rotation and its three partial derivatives, all with respect to DEGREES.
 *
 * Degrees rather than radians because the boundary type carries degrees, and
 * converting at the parameter-vector boundary rather than inside the Jacobian
 * is the version that stays right when someone later adds a parameter. The
 * `DEG` factor lives in the three `d*` matrices below.
 *
 * The products are built from the same generators as `rotationMatrix`, one of
 * them differentiated, which is the definition of the chain rule for a product
 * of matrices each depending on a single distinct variable.
 */
export function rotationWithDerivatives(
  yawDeg: number,
  pitchDeg: number,
  rollDeg: number,
): RotationWithDerivatives {
  const rz = rzMatrix(yawDeg);
  const ry = ryMatrix(-pitchDeg);
  const rx = rxMatrix(rollDeg);

  const cy = Math.cos(yawDeg * DEG);
  const sy = Math.sin(yawDeg * DEG);
  const cp = Math.cos(-pitchDeg * DEG);
  const sp = Math.sin(-pitchDeg * DEG);
  const cr = Math.cos(rollDeg * DEG);
  const sr = Math.sin(rollDeg * DEG);

  // d(Rz)/d(yawDeg)
  const dRz = Float64Array.of(-sy * DEG, -cy * DEG, 0, cy * DEG, -sy * DEG, 0, 0, 0, 0);
  // d(Ry(-pitch))/d(pitchDeg): inner angle is -pitch, so the chain rule adds -1.
  const dRy = Float64Array.of(
    sp * DEG,
    0,
    -cp * DEG,
    0,
    0,
    0,
    cp * DEG,
    0,
    sp * DEG,
  );
  // d(Rx)/d(rollDeg)
  const dRx = Float64Array.of(0, 0, 0, 0, -sr * DEG, -cr * DEG, 0, cr * DEG, -sr * DEG);

  return {
    r: mat3Multiply(mat3Multiply(rz, ry), rx),
    dYaw: mat3Multiply(mat3Multiply(dRz, ry), rx),
    dPitch: mat3Multiply(mat3Multiply(rz, dRy), rx),
    dRoll: mat3Multiply(mat3Multiply(rz, ry), dRx),
  };
}

export interface FrameAxes {
  /** Optical axis, world frame. `R * (1,0,0)`. */
  axis: Vec3;
  /** Right vector, world frame. `R * (0,-1,0)`. */
  right: Vec3;
  /** Up vector, world frame. `R * (0,0,1)`. */
  up: Vec3;
}

/**
 * The canonical frame of §R carried into the world by `R`.
 *
 * §R says the canonical optical axis is +X, right is -Y and up is +Z, so the
 * three world axes are columns 0, -1 and 2 of the rotation. The minus sign on
 * the right vector is the single easiest thing to get wrong in this whole
 * package; it is isolated here so there is exactly one place to check.
 */
export function frameAxes(r: Mat3): FrameAxes {
  const c0 = mat3Column(r, 0);
  const c1 = mat3Column(r, 1);
  const c2 = mat3Column(r, 2);
  return {
    axis: c0,
    right: { x: -c1.x, y: -c1.y, z: -c1.z },
    up: c2,
  };
}

export interface Euler {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

/**
 * Inverse of `rotationMatrix`: recover (yaw, pitch, roll) from a rotation.
 *
 * From the column expansion at the top of this file: `m[6] = sin(pitch)`,
 * `(m[0], m[3]) = cos(pitch) * (cos yaw, sin yaw)` and
 * `(m[8], m[7]) = cos(pitch) * (cos roll, sin roll)`.
 *
 * The sequence is singular at pitch = +/-90 degrees, where yaw and roll become
 * the same rotation. That never happens for a projector aimed near-horizontally
 * at a sphere whose centre is at lens height (PARAMETERS.md §2), but the
 * degenerate branch is handled anyway so the DLT bootstrap cannot produce a NaN
 * pose from a bad RANSAC sample and poison the whole solve.
 */
export function eulerFromMatrix(m: Mat3): Euler {
  const sp = Math.min(1, Math.max(-1, m[6]));
  const pitch = Math.asin(sp);
  const cp = Math.sqrt(Math.max(0, 1 - sp * sp));
  if (cp < 1e-9) {
    // Gimbal lock: fold the whole in-plane rotation into yaw and set roll to 0.
    return {
      yawDeg: Math.atan2(-m[1], m[4]) / DEG,
      pitchDeg: pitch / DEG,
      rollDeg: 0,
    };
  }
  return {
    yawDeg: Math.atan2(m[3], m[0]) / DEG,
    pitchDeg: pitch / DEG,
    rollDeg: Math.atan2(m[7], m[8]) / DEG,
  };
}

/**
 * The (yaw, pitch) that aims the optical axis from `from` at `to`, with roll
 * supplied by the caller.
 *
 * Inverted straight from col0 = (cos p cos y, cos p sin y, sin p): pitch is the
 * arcsine of the z component, yaw the atan2 of the horizontal part.
 *
 * A note on a clause the solver deliberately does NOT use. §R adds "a projector
 * at azimuth phi aimed at the sphere centre therefore has yaw = phi + 180 and
 * pitch = -elevation_of_center_from_lens". The yaw half checks out. The pitch
 * half does not: a lens above the sphere centre looks DOWN, so its axis has a
 * negative z component, so `pitch = asin(axis.z)` is negative — while the
 * elevation of the centre as seen from that lens is also negative, making
 * `-elevation` positive. The two halves of §R disagree by a sign whenever the
 * lens and the sphere centre are at different heights. Since the nominal rig
 * puts both at 2.1844 m (PARAMETERS.md §1 and §2) the clause is exercised only
 * under injected misalignment, which is exactly when a latent sign error is
 * most expensive. This function follows the *definitional* clauses instead —
 * "positive pitch raises the optical axis toward +Z", stated in §R and again on
 * `ProjectorPose.pitchDeg` in the boundary types — and the discrepancy is filed
 * as an ambiguity in the README.
 */
export function aimEuler(from: Vec3, to: Vec3, rollDeg: number): Euler {
  const d = vNormalize(vSub(to, from));
  return {
    yawDeg: Math.atan2(d.y, d.x) / DEG,
    pitchDeg: Math.asin(Math.min(1, Math.max(-1, d.z))) / DEG,
    rollDeg,
  };
}

// ---------------------------------------------------------------------------
// §I — interior orientation
// ---------------------------------------------------------------------------

export interface PixelIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** d(fx)/d(fovHDeg). Carried alongside because the LM needs it every row. */
  dfxdFov: number;
}

/**
 * §I verbatim:
 *   fx = (resX / 2) / tan(fovHDeg / 2),  fy = fx * pixelAspect
 *   cx = resX / 2 + shiftH * resX / 2,   cy = resY / 2 - shiftV * resY / 2
 *
 * The lens shift is a fraction of the HALF-image dimension, and the vertical
 * sign is negative — a positive `shiftV` moves the principal point UP, which in
 * a v-increases-down raster means a smaller `cy`.
 *
 * Note what §I does not say: whether `fovHDeg` describes the horizontal field
 * of the raster or of the sphere's silhouette. AMENDMENTS.md A-01 shows the two
 * readings differ materially. The solver takes `fovHDeg` at face value as the
 * full horizontal field of the raster, because that is what the formula above
 * computes and because it is a free parameter anyway (PARAMETERS.md §3.1 class
 * SOLVE) — a wrong nominal costs iterations, not correctness.
 */
export function pixelIntrinsics(m: ProjectorModel): PixelIntrinsics {
  const half = m.fovHDeg * 0.5 * DEG;
  const t = Math.tan(half);
  const fx = m.resX / 2 / t;
  // d/d(fovHDeg) of (resX/2)/tan(fov*DEG/2) = -(resX/2) * (DEG/2) * sec^2 / tan^2
  const sec2 = 1 / (Math.cos(half) * Math.cos(half));
  const dfxdFov = (-(m.resX / 2) * (DEG / 2) * sec2) / (t * t);
  return {
    fx,
    fy: fx * m.pixelAspect,
    cx: m.resX / 2 + m.shiftH * (m.resX / 2),
    cy: m.resY / 2 - m.shiftV * (m.resY / 2),
    dfxdFov,
  };
}

// ---------------------------------------------------------------------------
// §D — distortion
// ---------------------------------------------------------------------------

export interface Distorted {
  xd: number;
  yd: number;
  /** d(xd,yd)/d(x,y), row-major 2x2. Needed by both the Jacobian and the inverse. */
  dxdx: number;
  dxdy: number;
  dydx: number;
  dydy: number;
  r2: number;
}

/**
 * Brown-Conrady in the IDEAL -> DISTORTED direction, §D:
 *
 *   xd = x*(1 + k1 r2 + k2 r2^2) + 2 p1 x y + p2 (r2 + 2 x^2)
 *   yd = y*(1 + k1 r2 + k2 r2^2) + p1 (r2 + 2 y^2) + 2 p2 x y
 *
 * Returned with the 2x2 partial derivatives, because the LM row needs them and
 * `undistortNormalized` needs them for its Newton step, and computing them
 * twice from two slightly different expansions is how the two copies drift.
 */
export function distortNormalized(
  x: number,
  y: number,
  k1: number,
  k2: number,
  p1: number,
  p2: number,
): Distorted {
  const r2 = x * x + y * y;
  const radial = 1 + k1 * r2 + k2 * r2 * r2;
  // d(radial)/d(r2)
  const dRadial = k1 + 2 * k2 * r2;

  return {
    xd: x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x),
    yd: y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y,
    dxdx: radial + 2 * x * x * dRadial + 2 * p1 * y + 6 * p2 * x,
    dxdy: 2 * x * y * dRadial + 2 * p1 * x + 2 * p2 * y,
    dydx: 2 * x * y * dRadial + 2 * p1 * x + 2 * p2 * y,
    dydy: radial + 2 * y * y * dRadial + 6 * p1 * y + 2 * p2 * x,
    r2,
  };
}

/**
 * Inverse of `distortNormalized`, by Newton iteration on the 2x2 system.
 *
 * §D explicitly says the boundary specifies only the forward direction and that
 * "any numerically sound inversion is acceptable". This one is used ONLY by the
 * bootstrap (projector pixel -> ray) and by the camera model in sphere.ts;
 * the bundle residual never touches it, so no inversion error can leak into a
 * recovered calibration.
 *
 * Newton rather than the more common fixed-point iteration because the fixed
 * point diverges for |k1| large enough to matter and because a fixed iteration
 * count with quadratic convergence is both faster and — more importantly here —
 * deterministic without a tolerance-dependent loop trip count.
 */
export function undistortNormalized(
  xd: number,
  yd: number,
  k1: number,
  k2: number,
  p1: number,
  p2: number,
  iterations = 12,
): { x: number; y: number } {
  if (k1 === 0 && k2 === 0 && p1 === 0 && p2 === 0) return { x: xd, y: yd };
  let x = xd;
  let y = yd;
  for (let i = 0; i < iterations; i++) {
    const d = distortNormalized(x, y, k1, k2, p1, p2);
    const ex = d.xd - xd;
    const ey = d.yd - yd;
    const det = d.dxdx * d.dydy - d.dxdy * d.dydx;
    if (Math.abs(det) < 1e-15) break;
    x -= (d.dydy * ex - d.dxdy * ey) / det;
    y -= (-d.dydx * ex + d.dxdx * ey) / det;
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// The projection itself
// ---------------------------------------------------------------------------

export interface Projection {
  /** True when the point is in front of the lens (`a > 0`). */
  inFront: boolean;
  u: number;
  v: number;
  /** Ideal normalized coordinates, kept for the Jacobian and for diagnostics. */
  x: number;
  y: number;
  /** Depth along the optical axis, metres. */
  a: number;
}

/**
 * World point -> projector pixel.
 *
 * §I: with the point expressed in the projector's own frame as forward `a`,
 * right `r`, up `u`, the ideal normalized coordinates are `x = r/a`, `y = u/a`.
 * §D then distorts and maps to pixels with `u = cx + fx*xd`, `v = cy - fy*yd`.
 *
 * Pixel coordinates are continuous with the raster origin at the TOP-LEFT and
 * pixel centres at half-integers (§I), so `u = 3.5` is the centre of the fourth
 * column. Nothing in this function needs the half-pixel offset — it falls out
 * of `resX/2` being the geometric centre of a raster whose first pixel spans
 * [0, 1). The offset matters when *generating* or *indexing* a pattern image,
 * which is decode.ts's problem, and it is handled there.
 */
export function projectPoint(m: ProjectorModel, world: Vec3): Projection {
  const r = rotationMatrix(m.yawDeg, m.pitchDeg, m.rollDeg);
  return projectPointWithAxes(m, frameAxes(r), world);
}

export function projectPointWithAxes(
  m: ProjectorModel,
  axes: FrameAxes,
  world: Vec3,
): Projection {
  const rel = vSub(world, m.position);
  const a = vDot(axes.axis, rel);
  if (!(a > 0)) {
    return { inFront: false, u: NaN, v: NaN, x: NaN, y: NaN, a };
  }
  const x = vDot(axes.right, rel) / a;
  const y = vDot(axes.up, rel) / a;
  const d = distortNormalized(x, y, m.k1, m.k2, m.p1, m.p2);
  const k = pixelIntrinsics(m);
  return {
    inFront: true,
    u: k.cx + k.fx * d.xd,
    v: k.cy - k.fy * d.yd,
    x,
    y,
    a,
  };
}

/**
 * Projector pixel -> world ray direction. Bootstrap only.
 *
 * Inverts §I and §D: pixel to distorted normalized, Newton-undistort to ideal
 * normalized, then `axis + x*right + y*up` and normalise. The bundle never
 * calls this; see the file header for why that matters.
 */
export function projectorPixelToRay(m: ProjectorModel, u: number, v: number): Vec3 {
  const k = pixelIntrinsics(m);
  const xd = (u - k.cx) / k.fx;
  const yd = (k.cy - v) / k.fy;
  const ideal = undistortNormalized(xd, yd, m.k1, m.k2, m.p1, m.p2);
  const axes = frameAxes(rotationMatrix(m.yawDeg, m.pitchDeg, m.rollDeg));
  return vNormalize({
    x: axes.axis.x + ideal.x * axes.right.x + ideal.y * axes.up.x,
    y: axes.axis.y + ideal.x * axes.right.y + ideal.y * axes.up.y,
    z: axes.axis.z + ideal.x * axes.right.z + ideal.y * axes.up.z,
  });
}

// ---------------------------------------------------------------------------
// Analytic Jacobian
// ---------------------------------------------------------------------------

export interface ProjectionJacobian extends Projection {
  /**
   * d(u,v)/d(projector params), 2 x PROJ_PARAM_COUNT, row-major:
   * `dParam[0*13 + i]` is du/dp_i and `dParam[1*13 + i]` is dv/dp_i.
   */
  dParam: Float64Array;
  /** d(u,v)/d(world point), 2 x 3 row-major. Chains into the camera pose block. */
  dWorld: Float64Array;
}

/**
 * The full analytic derivative of `projectPoint`.
 *
 * Every partial is closed form; nothing here is finite-differenced. The chain is
 *
 *   (params) -> (a, r_c, u_c) -> (x, y) -> (xd, yd) -> (u, v)
 *
 * and each link is small enough to check by hand:
 *
 *   d(u,v)/d(xd,yd) = diag(fx, -fy)                       [§D pixel mapping]
 *   d(xd,yd)/d(x,y) = the 2x2 from `distortNormalized`    [§D]
 *   d(x,y)/d(rel)   = (right*a - r_c*axis)/a^2, likewise for up  [quotient rule]
 *   d(rel)/d(position) = -I
 *   d(a,r_c,u_c)/d(angle) = (dR/dangle applied to the canonical axes) . rel
 *
 * `test/project.test.ts` compares all thirteen columns against central
 * differences; a mismatch there means this comment and the code have drifted.
 */
export function projectPointJacobian(
  m: ProjectorModel,
  world: Vec3,
  out?: Float64Array,
  /**
   * Precomputed rotation and its derivatives. They depend only on the
   * projector's three angles, which do not change across the correspondences of
   * a single evaluation, so the bundle hoists this out of its inner loop —
   * rebuilding it per correspondence costs eight 3x3 products and dominated the
   * whole solve before it was hoisted.
   */
  precomputedRotation?: RotationWithDerivatives,
  worldOut?: Float64Array,
): ProjectionJacobian {
  const rot =
    precomputedRotation ?? rotationWithDerivatives(m.yawDeg, m.pitchDeg, m.rollDeg);
  const axes = frameAxes(rot.r);
  const rel = vSub(world, m.position);

  const a = vDot(axes.axis, rel);
  const rc = vDot(axes.right, rel);
  const uc = vDot(axes.up, rel);

  const dParam = out ?? new Float64Array(2 * PROJ_PARAM_COUNT);
  dParam.fill(0);
  const dWorld = worldOut ?? new Float64Array(6);

  if (!(a > 0)) {
    return { inFront: false, u: NaN, v: NaN, x: NaN, y: NaN, a, dParam, dWorld };
  }

  const x = rc / a;
  const y = uc / a;
  const d = distortNormalized(x, y, m.k1, m.k2, m.p1, m.p2);
  const k = pixelIntrinsics(m);

  const u = k.cx + k.fx * d.xd;
  const v = k.cy - k.fy * d.yd;

  // d(u,v)/d(x,y): pixel mapping composed with the distortion 2x2.
  const dudx = k.fx * d.dxdx;
  const dudy = k.fx * d.dxdy;
  const dvdx = -k.fy * d.dydx;
  const dvdy = -k.fy * d.dydy;

  // d(x,y)/d(rel), by the quotient rule on x = (right . rel)/(axis . rel).
  const inv = 1 / a;
  const inv2 = inv * inv;
  const dxdRel = {
    x: (axes.right.x * a - rc * axes.axis.x) * inv2,
    y: (axes.right.y * a - rc * axes.axis.y) * inv2,
    z: (axes.right.z * a - rc * axes.axis.z) * inv2,
  };
  const dydRel = {
    x: (axes.up.x * a - uc * axes.axis.x) * inv2,
    y: (axes.up.y * a - uc * axes.axis.y) * inv2,
    z: (axes.up.z * a - uc * axes.axis.z) * inv2,
  };

  // --- world point (chains into the camera block in bundle.ts) ---
  dWorld[0] = dudx * dxdRel.x + dudy * dydRel.x;
  dWorld[1] = dudx * dxdRel.y + dudy * dydRel.y;
  dWorld[2] = dudx * dxdRel.z + dudy * dydRel.z;
  dWorld[3] = dvdx * dxdRel.x + dvdy * dydRel.x;
  dWorld[4] = dvdx * dxdRel.y + dvdy * dydRel.y;
  dWorld[5] = dvdx * dxdRel.z + dvdy * dydRel.z;

  // --- position: rel = world - position, so d/d(position) = -d/d(rel) ---
  dParam[PROJ_PX] = -dWorld[0];
  dParam[PROJ_PY] = -dWorld[1];
  dParam[PROJ_PZ] = -dWorld[2];
  dParam[PROJ_PARAM_COUNT + PROJ_PX] = -dWorld[3];
  dParam[PROJ_PARAM_COUNT + PROJ_PY] = -dWorld[4];
  dParam[PROJ_PARAM_COUNT + PROJ_PZ] = -dWorld[5];

  // --- orientation ---
  const angleSlot = (dR: Mat3, slot: number): void => {
    // The canonical axes are +X, -Y, +Z (§R), so their images under dR/dtheta
    // are columns 0, -1 and 2 of dR — same extraction as `frameAxes`.
    const dAxis = mat3Column(dR, 0);
    const c1 = mat3Column(dR, 1);
    const dRight = { x: -c1.x, y: -c1.y, z: -c1.z };
    const dUp = mat3Column(dR, 2);

    const da = vDot(dAxis, rel);
    const drc = vDot(dRight, rel);
    const duc = vDot(dUp, rel);

    const dx = (drc * a - rc * da) * inv2;
    const dy = (duc * a - uc * da) * inv2;

    dParam[slot] = dudx * dx + dudy * dy;
    dParam[PROJ_PARAM_COUNT + slot] = dvdx * dx + dvdy * dy;
  };
  angleSlot(rot.dYaw, PROJ_YAW);
  angleSlot(rot.dPitch, PROJ_PITCH);
  angleSlot(rot.dRoll, PROJ_ROLL);

  // --- interior orientation ---
  // fy = fx * pixelAspect, so both focal derivatives come from dfx/dfov.
  dParam[PROJ_FOV] = k.dfxdFov * d.xd;
  dParam[PROJ_PARAM_COUNT + PROJ_FOV] = -k.dfxdFov * m.pixelAspect * d.yd;

  // cx = resX/2 + shiftH*resX/2 and cy = resY/2 - shiftV*resY/2 (§I).
  dParam[PROJ_SHIFT_H] = m.resX / 2;
  dParam[PROJ_PARAM_COUNT + PROJ_SHIFT_H] = 0;
  dParam[PROJ_SHIFT_V] = 0;
  dParam[PROJ_PARAM_COUNT + PROJ_SHIFT_V] = -(m.resY / 2);

  // --- distortion (§D is linear in every coefficient, so these are exact) ---
  const r2 = d.r2;
  dParam[PROJ_K1] = k.fx * x * r2;
  dParam[PROJ_PARAM_COUNT + PROJ_K1] = -k.fy * y * r2;
  dParam[PROJ_K2] = k.fx * x * r2 * r2;
  dParam[PROJ_PARAM_COUNT + PROJ_K2] = -k.fy * y * r2 * r2;
  dParam[PROJ_P1] = k.fx * (2 * x * y);
  dParam[PROJ_PARAM_COUNT + PROJ_P1] = -k.fy * (r2 + 2 * y * y);
  dParam[PROJ_P2] = k.fx * (r2 + 2 * x * x);
  dParam[PROJ_PARAM_COUNT + PROJ_P2] = -k.fy * (2 * x * y);

  return { inFront: true, u, v, x, y, a, dParam, dWorld };
}

// ---------------------------------------------------------------------------
// §V — viewports
// ---------------------------------------------------------------------------

/**
 * Projector raster pixel -> shared-framebuffer pixel, §V.
 *
 * The solver does not need this to compute a residual: the decoded
 * correspondence is already in the projector's own raster, which is the frame
 * the boundary type's intrinsics describe. It is here because the pattern
 * generator on the other side of the bench displays through one X screen split
 * 2x2 (PARAMETERS.md §3.4), and anyone wiring the two together needs the
 * mapping written down once, with the flip in it.
 *
 * §V puts the viewport origin at BOTTOM-LEFT while §I puts the raster origin at
 * TOP-LEFT with v increasing down. So the vertical term is flipped: the top of
 * the projector raster (v = 0) sits at the top of the viewport, which is
 * `y + h` in bottom-left-origin normalized coordinates.
 */
export function rasterToFramebuffer(
  vp: Viewport,
  fb: { width: number; height: number },
  m: { resX: number; resY: number },
  u: number,
  v: number,
): { x: number; y: number } {
  const fx = (vp.x + (u / m.resX) * vp.w) * fb.width;
  const fyBottomUp = vp.y + (1 - v / m.resY) * vp.h;
  return { x: fx, y: fyBottomUp * fb.height };
}
