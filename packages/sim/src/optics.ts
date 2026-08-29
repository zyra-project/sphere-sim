// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The projector frustum: pixel <-> world ray, lens shift, and the Brown-Conrady
 * distortion model INVERTED.
 *
 * The forward model's independent implementation of conventions.ts §I and §D.
 * `packages/solver` implements the same prose and only ever needs the forward
 * direction (world -> pixel); this package mostly needs the inverse, because it
 * ray-traces from projector pixels outward. That asymmetry is the reason §D
 * specifies only one direction: whichever side needs the other one has to earn
 * it.
 */

import type {
  BlendCalibration,
  ProjectorCalibration,
  ProjectorIntrinsics,
  RigCalibration,
  Vec3,
} from '../../calibration/src/index.ts';
import { NOMINAL_SILHOUETTE_MARGIN_FRAC } from '../../calibration/src/conventions.ts';
import type { Mat3 } from './vec.ts';
import { DEG2RAD, RAD2DEG, matTVec, matVec, normalize, sub } from './vec.ts';
import { projectorRotationMatrix } from './geometry.ts';
import type { Surface } from './surface.ts';
import { blendModelApplies, sphereSurface } from './surface.ts';
import { buildFootprintField } from './footprint.ts';
import type { FootprintField } from './footprint.ts';
import type { MeshSurface } from './mesh/surface.ts';

/**
 * A projector with its per-render invariants precomputed.
 *
 * Rebuilding the rotation matrix and focal lengths inside the pixel loop is
 * both slow and a determinism hazard: identical inputs must produce identical
 * floating-point results, and the surest way to guarantee that is to compute
 * each derived quantity exactly once, in one place, and read it everywhere.
 */
export interface PreparedProjector {
  cal: ProjectorCalibration;
  index: number;
  /** World <- canonical camera frame. conventions.ts §R. */
  rotation: Mat3;
  /** Lens entrance pupil, world frame. */
  lens: Vec3;
  /** Unit optical axis in the world frame. */
  axis: Vec3;
  /** Unit image-right vector in the world frame. */
  right: Vec3;
  /** Unit image-up vector in the world frame. */
  up: Vec3;
  /** Focal lengths in pixels. conventions.ts §I. */
  fx: number;
  fy: number;
  /** Principal point in pixels, lens shift included. conventions.ts §I. */
  cx: number;
  cy: number;
  /**
   * The surface this projector was prepared against.
   *
   * The route to the shape for everything downstream — `coverage.ts`,
   * `render.ts` and the metrics all ask this rather than naming the sphere.
   * See `surface.ts` for why {@link PreparedProjector.radiusM} survives beside
   * it rather than being replaced by it.
   */
  surface: Surface;
  /** Sphere radius this projector was prepared against, metres. */
  radiusM: number;
  /** Distance from the lens to the sphere centre, metres. `d_proj`. */
  distanceM: number;
  /**
   * `R / d`. PARAMETERS.md §4.1's limb constant: a surface point is lit when
   * `cos(lat) * cos(lon - phi) > R/d`, which generalizes to
   * `dot(normal, lens - point) > 0`.
   */
  limbCos: number;
  /** Angular radius of the sphere's silhouette seen from this lens, degrees. */
  limbAngleDeg: number;
}

/** A rig with every projector prepared, plus the sphere it was prepared against. */
export interface PreparedRig {
  /** The calibration this was built from, kept so nothing has to be re-derived. */
  rig: RigCalibration;
  /** The shape the light lands on. See `surface.ts`. */
  surface: Surface;
  /**
   * One footprint distance field per projector, or `null` on a surface whose
   * blend has a closed form.
   *
   * `null` for a sphere, always — `blendModelApplies` is true there, the limb
   * ramp is exact, and building a field would trace sixteen thousand rays per
   * projector to reproduce arithmetic that already exists. It is also what keeps
   * this change byte-identical: the sphere path never touches any of it.
   *
   * Built at PREPARE time rather than lazily. A field built on first use would
   * be built inside whichever render happened to run first, so its cost would
   * land on an arbitrary frame and `prepareRig` would look cheaper than it is.
   */
  footprints: (FootprintField | null)[] | null;
  radiusM: number;
  centerHeightM: number;
  rotationOffsetDeg: number;
  blend: BlendCalibration;
  projectors: PreparedProjector[];
}

export function prepareProjector(
  cal: ProjectorCalibration,
  surface: Surface,
  index: number,
): PreparedProjector {
  const radiusM = surface.boundsRadiusM;
  const rotation = projectorRotationMatrix(cal.pose);
  const it = cal.intrinsics;
  const fx = it.resX / 2 / Math.tan((it.fovHDeg * DEG2RAD) / 2);
  const fy = fx * it.pixelAspect;
  const lens = cal.pose.position;
  const distanceM = Math.hypot(lens.x, lens.y, lens.z);
  // A lens inside the sphere has no silhouette; clamp rather than produce NaN so
  // a wildly misplaced projector in a sweep degrades instead of exploding.
  const limbCos = distanceM > 0 ? Math.min(1, radiusM / distanceM) : 1;
  return {
    cal,
    index,
    rotation,
    lens,
    axis: matVec(rotation, { x: 1, y: 0, z: 0 }),
    right: matVec(rotation, { x: 0, y: -1, z: 0 }),
    up: matVec(rotation, { x: 0, y: 0, z: 1 }),
    fx,
    fy,
    // conventions.ts §I: lens shift is a fraction of the HALF-image dimension.
    // Writing `shiftH * resX` instead of `shiftH * resX / 2` doubles every shift
    // and still looks entirely reasonable on screen, which is why optics.test.ts
    // pins it with a non-zero shift.
    cx: it.resX / 2 + it.shiftH * (it.resX / 2),
    cy: it.resY / 2 - it.shiftV * (it.resY / 2),
    surface,
    radiusM,
    distanceM,
    limbCos,
    limbAngleDeg: Math.asin(limbCos) * RAD2DEG,
  };
}

/** Normalized image coordinates, conventions.ts §I. `x` right, `y` up. */
export interface NormalizedImagePoint {
  x: number;
  y: number;
}

/**
 * Brown-Conrady in the direction conventions.ts §D defines it: IDEAL ->
 * DISTORTED. This is the only direction the boundary specifies, so it is the
 * only direction implemented directly; everything else in this file is built on
 * top of it or inverts it numerically.
 */
export function applyDistortion(p: NormalizedImagePoint, it: ProjectorIntrinsics): NormalizedImagePoint {
  const { x, y } = p;
  const r2 = x * x + y * y;
  const radial = 1 + it.k1 * r2 + it.k2 * r2 * r2;
  return {
    x: x * radial + 2 * it.p1 * x * y + it.p2 * (r2 + 2 * x * x),
    y: y * radial + it.p1 * (r2 + 2 * y * y) + 2 * it.p2 * x * y,
  };
}

/**
 * Invert {@link applyDistortion}.
 *
 * Newton's method on `F(x) = distort(x) - x_d` with the analytic 2x2 Jacobian.
 * The usual fixed-point iteration (`x <- x_d / radial(x)`) is a line of code and
 * converges for small `k1`, but it degrades exactly where distortion is large —
 * near the raster corners, which for this rig is off-sphere but is precisely
 * where a solver's residuals would be judged. Newton converges quadratically
 * and reaches the 1e-10 tolerance conventions.ts callers need in three or four
 * iterations at nominal coefficients.
 *
 * The undistorted point is seeded with the fixed-point step rather than with
 * `x_d` itself, which buys roughly one Newton iteration for one multiply.
 *
 * If the Jacobian goes singular (achievable with pathological `k1`, `k2` in a
 * sensitivity sweep) the iteration stops and returns its best estimate rather
 * than dividing by zero. Callers that care can check with
 * {@link distortionRoundTripError}.
 */
export function invertDistortion(
  distorted: NormalizedImagePoint,
  it: ProjectorIntrinsics,
  // The residual is in normalized units and gets multiplied by fx (~3100 px) on
  // the way to a pixel coordinate, so a 1e-10 normalized tolerance would only
  // buy 3e-7 px. Converging to 1e-14 — a few tens of ulps at the ~0.3 magnitudes
  // involved — puts the pixel round-trip comfortably under 1e-9 px, and costs
  // one extra Newton step because the convergence is quadratic.
  tolerance = 1e-14,
  maxIterations = 20,
): NormalizedImagePoint {
  if (it.k1 === 0 && it.k2 === 0 && it.p1 === 0 && it.p2 === 0) return distorted;

  // Fixed-point warm start.
  const r2d = distorted.x * distorted.x + distorted.y * distorted.y;
  const seedRadial = 1 + it.k1 * r2d + it.k2 * r2d * r2d;
  let x = seedRadial !== 0 ? distorted.x / seedRadial : distorted.x;
  let y = seedRadial !== 0 ? distorted.y / seedRadial : distorted.y;

  for (let iter = 0; iter < maxIterations; iter++) {
    const r2 = x * x + y * y;
    const radial = 1 + it.k1 * r2 + it.k2 * r2 * r2;
    const fx = x * radial + 2 * it.p1 * x * y + it.p2 * (r2 + 2 * x * x) - distorted.x;
    const fy = y * radial + it.p1 * (r2 + 2 * y * y) + 2 * it.p2 * x * y - distorted.y;
    if (Math.abs(fx) < tolerance && Math.abs(fy) < tolerance) break;

    // d(radial)/dx = 2x * (k1 + 2*k2*r2), and likewise for y.
    const dr = it.k1 + 2 * it.k2 * r2;
    const j00 = radial + 2 * x * x * dr + 2 * it.p1 * y + 6 * it.p2 * x;
    const j01 = 2 * x * y * dr + 2 * it.p1 * x + 2 * it.p2 * y;
    const j10 = 2 * x * y * dr + 2 * it.p1 * x + 2 * it.p2 * y;
    const j11 = radial + 2 * y * y * dr + 6 * it.p1 * y + 2 * it.p2 * x;

    const det = j00 * j11 - j01 * j10;
    if (det === 0 || !Number.isFinite(det)) break;
    x -= (j11 * fx - j01 * fy) / det;
    y -= (-j10 * fx + j00 * fy) / det;
  }
  return { x, y };
}

/** How far `invertDistortion(applyDistortion(p))` lands from `p`. Diagnostics. */
export function distortionRoundTripError(p: NormalizedImagePoint, it: ProjectorIntrinsics): number {
  const back = invertDistortion(applyDistortion(p, it), it);
  return Math.hypot(back.x - p.x, back.y - p.y);
}

/**
 * Projector pixel -> unit world ray.
 *
 * `u` and `v` are in the projector's OWN raster (not the shared framebuffer of
 * conventions.ts §V), origin top-left, `v` down. Pixel centres sit at
 * half-integers: pass `(0.5, 0.5)` for the first pixel, not `(0, 0)`. Getting
 * that wrong shifts every projector by half a pixel, which is ~0.3 mm on the
 * sphere surface — a third of the entire 1.0 mm grid-displacement gate in
 * PARAMETERS.md §7, spent on an off-by-one.
 *
 * Reverses conventions.ts §D's `u = cx + fx*x_d`, `v = cy - fy*y_d` to recover
 * the distorted normalized point, inverts the distortion to the ideal point,
 * then reads §I's `x = r/a`, `y = u/a` backwards: the ray in the canonical frame
 * is `(1, x, y)` in (axis, right, up) components.
 */
export function pixelToRay(proj: PreparedProjector, u: number, v: number): Vec3 {
  const xd = (u - proj.cx) / proj.fx;
  const yd = -(v - proj.cy) / proj.fy;
  const ideal = invertDistortion({ x: xd, y: yd }, proj.cal.intrinsics);
  return normalize({
    x: proj.axis.x + proj.right.x * ideal.x + proj.up.x * ideal.y,
    y: proj.axis.y + proj.right.y * ideal.x + proj.up.y * ideal.y,
    z: proj.axis.z + proj.right.z * ideal.x + proj.up.z * ideal.y,
  });
}

/** A pixel coordinate in a projector's own raster. */
export interface PixelPoint {
  u: number;
  v: number;
}

/**
 * World point -> projector pixel, the forward direction of conventions.ts §I
 * and §D. Returns `null` when the point is behind the lens or lands outside the
 * raster.
 *
 * The simulator needs this for its own registration metrics (where does this
 * surface point land in each projector's raster, and how far apart are the two
 * answers in a blend region). It is emphatically NOT the solver's copy of the
 * same function; see packages/sim/README.md.
 *
 * "Outside the raster" is `[0, resX] x [0, resY]` inclusive, in the same
 * half-integer-centre convention: the outer edge of the first pixel is 0.0 and
 * the outer edge of the last is `resX`.
 */
export function worldToPixel(proj: PreparedProjector, worldPoint: Vec3): PixelPoint | null {
  const rel = sub(worldPoint, proj.lens);
  const local = matTVec(proj.rotation, rel);
  // Canonical frame: optical axis +X, right -Y, up +Z (conventions.ts §R).
  const a = local.x;
  if (!(a > 0)) return null;
  const r = -local.y;
  const upComp = local.z;

  const d = applyDistortion({ x: r / a, y: upComp / a }, proj.cal.intrinsics);
  const u = proj.cx + proj.fx * d.x;
  const v = proj.cy - proj.fy * d.y;
  const it = proj.cal.intrinsics;
  if (u < 0 || u > it.resX || v < 0 || v > it.resY) return null;
  return { u, v };
}

/** Same as {@link worldToPixel} but without the raster bounds test. */
export function worldToPixelUnbounded(proj: PreparedProjector, worldPoint: Vec3): PixelPoint | null {
  const local = matTVec(proj.rotation, sub(worldPoint, proj.lens));
  const a = local.x;
  if (!(a > 0)) return null;
  const d = applyDistortion({ x: -local.y / a, y: local.z / a }, proj.cal.intrinsics);
  return { u: proj.cx + proj.fx * d.x, v: proj.cy - proj.fy * d.y };
}

/**
 * Build a projector's interior orientation so the sphere's silhouette is
 * inscribed in the raster's MINOR dimension.
 *
 * ## Read docs/AMENDMENTS.md A-01 before changing this
 *
 * PARAMETERS.md §3.1 derives `T ~ 3.0:1` from "image width ~ sphere diameter at
 * d_proj", giving `fov_h ~ 18.9`. Taken literally on a 16:9 raster the VERTICAL
 * field of view is only 10.7 degrees against a silhouette that subtends 19.2, so
 * such a projector could not illuminate anything above about latitude 33 — and
 * §4.3 requires coverage to reach 80.4 along a projector's own meridian. The two
 * clauses cannot both hold.
 *
 * A-01 resolves it in favour of §4.3, which is the clause with a correctness
 * check attached (coverage.test.ts), and notes the corroborating evidence: §7's
 * "~51%" off-sphere flux floor matches a 16:10 raster with the silhouette
 * inscribed in the minor axis almost exactly, and matches nothing about the
 * §3.1 reading.
 *
 * So: the half-angle of the minor raster dimension is set to the silhouette's
 * angular radius `asin(R/d)` times `1 + marginFrac`, and `fovHDeg` follows from
 * the raster's aspect ratio. With `marginFrac = 0`, a 1920x1080 raster at
 * d = 5.18 m comes out at `fovH = 33.46 deg`, i.e. `T = 1.66:1` in the
 * conventional distance-over-width sense — close to the 1.69:1 A-01 quotes, the
 * small difference being that A-01 uses the flat-plane approximation
 * (`T = d / (D * aspect)`) while this uses the exact tangent cone.
 *
 * `marginFrac` exists because a silhouette inscribed with zero margin puts the
 * limb exactly on the raster edge, where the coverage test and the raster test
 * disagree at the last ulp and coverage develops a ragged fringe. A couple of
 * percent of headroom makes the limb test of PARAMETERS.md §4.1 the sole
 * binding constraint, which is what §4.1 intends.
 *
 * ## The default is no longer a local decision
 *
 * It used to be a `0.02` written here and nowhere else, and `packages/solver`
 * built its nominal with no margin at all. Nothing in PARAMETERS.md pins the
 * number, so both were defensible and the two nominal rigs quietly differed by
 * 0.63 degrees of field — which is what made "hold the field of view" look like
 * a fix when it is a 5x regression (docs/AMENDMENTS.md A-16 step 1, A-17). The
 * value now lives in conventions.ts §N.1 as
 * `NOMINAL_SILHOUETTE_MARGIN_FRAC`, which is a literal in the boundary object;
 * this module still does its own arithmetic with it, and so does the solver.
 * `packages/bench/test/nominal-agreement.test.ts` compares the two outputs.
 */
export interface FrustumSpec {
  resX: number;
  resY: number;
  /** Lens to sphere centre, metres. PARAMETERS.md §2 `d_proj`. */
  distanceM: number;
  /** Sphere radius, metres. PARAMETERS.md §1 `R`. */
  radiusM: number;
  /**
   * Headroom beyond the silhouette in the minor dimension, as a fraction.
   * Defaults to conventions.ts §N.1's `NOMINAL_SILHOUETTE_MARGIN_FRAC`.
   */
  marginFrac?: number;
  pixelAspect?: number;
  shiftH?: number;
  shiftV?: number;
  k1?: number;
  k2?: number;
  p1?: number;
  p2?: number;
}

export function intrinsicsFromThrow(spec: FrustumSpec): ProjectorIntrinsics {
  const pixelAspect = spec.pixelAspect ?? 1;
  const margin = spec.marginFrac ?? NOMINAL_SILHOUETTE_MARGIN_FRAC;
  const sigma = Math.asin(Math.min(1, spec.radiusM / spec.distanceM));
  // Half-extent the minor dimension must cover, in normalized image units.
  const halfMinor = Math.tan(sigma) * (1 + margin);

  // Which dimension is minor in ANGLE, not in pixels: a non-square pixel aspect
  // can make the taller raster the narrower field.
  const horizontalIsMinor = spec.resX * pixelAspect < spec.resY;
  const fx = horizontalIsMinor
    ? spec.resX / 2 / halfMinor
    : spec.resY / 2 / (pixelAspect * halfMinor);

  return {
    resX: spec.resX,
    resY: spec.resY,
    fovHDeg: 2 * Math.atan(spec.resX / 2 / fx) * RAD2DEG,
    pixelAspect,
    shiftH: spec.shiftH ?? 0,
    shiftV: spec.shiftV ?? 0,
    k1: spec.k1 ?? 0,
    k2: spec.k2 ?? 0,
    p1: spec.p1 ?? 0,
    p2: spec.p2 ?? 0,
  };
}

/**
 * The analytic floor for the off-sphere flux metric, PARAMETERS.md §7 and
 * docs/AMENDMENTS.md A-01 and A-03.
 *
 * When content is masked to the sphere's silhouette — which is what the Red Ball
 * procedure produces — and that silhouette circle is inscribed in the raster's
 * minor dimension, the lit fraction of the raster is the circle's area over the
 * rectangle's: `(pi/4) * (minor/major)`. Everything else is thrown past the
 * sphere and onto the room:
 *
 *     off-sphere floor = 1 - (pi/4) * (minor / major)
 *
 *   16:10  ->  50.9%   (matches §7's "~51%" almost exactly)
 *   16:9   ->  55.8%
 *   4:3    ->  41.1%
 *
 * §7's gate of 52% is therefore unpassable on a 16:9 raster no matter how well
 * aligned the rig is, which is A-03. The bench scores excess-above-this-floor so
 * the gate measures misaim rather than the projector's aspect ratio, and reports
 * the absolute fraction alongside it.
 *
 * `aspect` is width over height; the function sorts out which is minor itself,
 * so it is safe to hand it a portrait raster.
 */
export function analyticOffSphereFloor(aspect: number): number {
  const a = Math.abs(aspect);
  if (!(a > 0) || !Number.isFinite(a)) return 1;
  const ratio = a >= 1 ? 1 / a : a;
  return 1 - (Math.PI / 4) * ratio;
}

/**
 * Throw ratio in the conventional distance-over-image-width sense, for
 * reporting against PARAMETERS.md §3.1's `T ~ 3.0:1`. See A-01: this rig's value
 * is ~1.66:1 because the silhouette is inscribed in the minor dimension.
 */
export function throwRatioOf(it: ProjectorIntrinsics): number {
  return 1 / (2 * Math.tan((it.fovHDeg * DEG2RAD) / 2));
}

/** Vertical field of view implied by the horizontal one and the raster shape. */
export function fovVDeg(it: ProjectorIntrinsics): number {
  const fx = it.resX / 2 / Math.tan((it.fovHDeg * DEG2RAD) / 2);
  return 2 * Math.atan(it.resY / 2 / (fx * it.pixelAspect)) * RAD2DEG;
}

/**
 * Memoise a whole rig. Every coverage, blend and render entry point takes the
 * prepared form rather than the raw `RigCalibration`, so the derived quantities
 * are computed exactly once per run — cheaper, and one fewer way for two runs
 * with the same seed to disagree in the last bit.
 */
/**
 * A rig with every projector prepared, against `rig.sphere` or against a surface
 * the caller supplies.
 *
 * ## Why the mesh arrives here and not in `RigCalibration`
 *
 * The obvious move for `docs/ARBITRARY-SHAPES.md` Phase 1 is a `mesh?:
 * SurfaceMesh` field on `RigCalibration`, so a rig names its own shape. It is
 * the right destination and it is not yet the right change, because
 * `RigCalibration`'s own contract says "serialized to JSON, passed between A and
 * B" — and a `SurfaceMesh` is typed arrays. `JSON.stringify` turns a
 * `Float64Array` into an object keyed by stringified indices: a 100k-triangle
 * model becomes tens of megabytes of `{"0":0.123,"1":...}` that reads back as
 * something which is not a mesh.
 *
 * (It would not break the bench today — `bench-results.json` carries no
 * `RigCalibration`; `inputs.injected` is a perturbation record that happens to
 * have a `projectors` key. But the type's documented contract is the contract,
 * and the solver returns one of these.)
 *
 * Fixing that properly means deciding how a calibration carries a mesh across
 * JSON — beside it as a `.bin`, or as the source file's own bytes to re-read,
 * as `packages/calibration/src/mesh.ts` sketches. That is a decision about the
 * boundary object, and it belongs with Phase 5, where the solver actually needs
 * a mesh to cross. Until then the surface is passed in, which gets a model on
 * screen without putting a landmine in the type that both models share.
 *
 * Omit it and the rig is a sphere built from `rig.sphere.radiusM`, which is what
 * every existing caller gets and why this change moves no bytes.
 */
export function prepareRig(rig: RigCalibration, surfaceOverride?: Surface): PreparedRig {
  // One surface per rig, shared by every projector. Building it once is not an
  // optimisation: a surface built twice is two objects that a `===` check can
  // tell apart, and a mesh carries a bounding volume hierarchy that nobody wants
  // rebuilt four times per prepare.
  const surface = surfaceOverride ?? sphereSurface(rig.sphere.radiusM);
  const projectors = rig.projectors.map((p, i) => prepareProjector(p, surface, i));

  // Only where the closed form does not apply. On a sphere this is `null` and
  // nothing below runs, which is what keeps the sphere path byte-identical.
  const footprints = blendModelApplies(surface) ? null : buildFootprints(surface, projectors);

  return {
    rig,
    surface,
    // The SURFACE's radius, not `rig.sphere.radiusM`. They are the same number
    // for a sphere and must be, or this change would move bytes; for a mesh the
    // sphere calibration describes a ball that is not being lit, and a metric
    // reading `radiusM` would be measuring it.
    radiusM: surface.boundsRadiusM,
    centerHeightM: rig.sphere.centerHeightM,
    rotationOffsetDeg: rig.sphere.rotationOffsetDeg,
    blend: rig.blend,
    projectors,
    footprints,
  };
}

/**
 * One geodesic footprint field per projector, over the mesh's own vertices.
 *
 * Here rather than in `footprint.ts` because it needs `worldToPixel` and the
 * surface's own visibility pair, and `coverage.ts` imports `footprint.ts` — so
 * putting the assembly there would close a cycle. `footprint.ts` owns the graph
 * and the search; this owns what "lit" means, which is `isIlluminatedAt`'s
 * three tests in `isIlluminatedAt`'s order, cheapest rejection first.
 */
function buildFootprints(
  surface: Surface,
  projectors: PreparedProjector[],
): (FootprintField | null)[] | null {
  const mesh = meshOf(surface);
  if (mesh === null) return null;
  const adjacency = mesh.adjacency;
  const positions = mesh.mesh.positions;
  return projectors.map((p) =>
    buildFootprintField(mesh.mesh, adjacency, mesh.extentRadiusM, (i) => {
      const point = { x: positions[3 * i], y: positions[3 * i + 1], z: positions[3 * i + 2] };
      // `vertexNormal`, from the faces that meet at this vertex. The previous
      // version asked `normalAt(point)` when the file carried no normals, which
      // re-finds the face by the radial search — and that search returns nothing
      // for a flat wall, so every vertex of a wall took the `{0, 0, 1}` fallback,
      // a wall facing a projector on +x read as facing away, and the field found
      // no lit vertex to feather from. A vertex knows its own faces.
      const normal = mesh.vertexNormal(i);
      if (!surface.facesLens(point, normal, p.lens)) return false;
      if (worldToPixel(p, point) === null) return false;
      return !surface.shadowed(point, p.lens);
    }),
  );
}

/** The mesh behind a surface, or `null` when there is not one. */
function meshOf(surface: Surface): MeshSurface | null {
  return surface.kind === 'mesh' ? (surface as MeshSurface) : null;
}
