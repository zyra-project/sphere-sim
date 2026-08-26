// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Bootstrap: from PARAMETERS.md nominals to a basin the Levenberg-Marquardt can
 * finish from.
 *
 * The hard requirement this module exists to satisfy is PARAMETERS.md §2's
 * unresolved `d_proj`. The alignment manual puts the projectors about 17 ft
 * (5.18 m) from the sphere centre; the floor plan implies 5.50-6.14 m. The two
 * do not overlap, the document declines to pick, and it tells the solver to
 * treat the value as SOLVE with a wide 5.0-6.5 m prior. So the bootstrap must
 * not care which end of that prior it starts from — a solver that quietly needs
 * the right answer to find the right answer would be useless at a real site
 * where nobody has run the tape measure yet.
 *
 * The strategy is a small ladder, each rung using only what the rung below has
 * established:
 *
 *   0. Pull each camera in along its own line of sight if the images say the
 *      sphere is bigger than the operator's rough tripod distance implies.
 *   1. Sweep the `d_proj` prior. For each candidate distance, place the
 *      projectors at their nominal azimuths and solve ONLY the camera poses.
 *      Score, keep the best. This turns a two-sided chicken-and-egg into a
 *      one-dimensional search, and the search is over the one parameter the
 *      documentation actually disagrees about.
 *   2. With cameras now roughly right, re-derive each projector's pose three
 *      ways — from the nominal, from the centroid of its own decoded footprint
 *      (its sub-projector point), and from a RANSAC DLT that uses no nominal at
 *      all — and keep whichever reprojects best.
 *   3. A short LM on projector pose and field of view, to hand the full solve a
 *      state that is already in the right basin.
 *
 * Rung 2 is what makes the bootstrap robust to a rig that is not laid out the
 * way §2 says. If a site's projectors are not at 0/90/180/270, or the capture
 * indexes them in a different order, the DLT does not notice and does not care.
 */

import type { Correspondence } from './decode.ts';
import {
  type Vec3,
  createRng,
  jacobiEigenSymmetric,
  mat3MulVec,
  mat3Transpose,
  nearestRotation,
  vNorm,
  vNormalize,
  vScale,
} from './linalg.ts';
import {
  aimEuler,
  eulerFromMatrix,
  frameAxes,
  pixelIntrinsics,
  projectPointWithAxes,
  rotationMatrix,
  undistortNormalized,
  type ProjectorModel,
} from './project.ts';
import {
  type CameraModel,
  cameraPixelToNormalized,
  distanceFromAngularRadius,
  fitRayCone,
  intersectSphere,
  rayFromNormalized,
} from './sphere.ts';
import {
  DEFAULT_BUNDLE_OPTIONS,
  DEFAULT_FREE_FLAGS,
  type BundleOptions,
  type BundleState,
  type FloorReference,
  type ParameterPrior,
  cloneState,
  runBundle,
} from './bundle.ts';

export interface InitOptions {
  /**
   * The `d_proj` prior to sweep, PARAMETERS.md §2. Defaults to the documented
   * 5.0-6.5 m with seven samples, which puts a candidate within 12 cm of any
   * true value in the prior — comfortably inside the LM's basin for a
   * long-throw lens.
   */
  distanceMinM: number;
  distanceMaxM: number;
  distanceSteps: number;
  /** Cap on correspondences used per projector during bootstrap. */
  bootstrapSamples: number;
  /**
   * Cap on correspondences used for the whole `d_proj` sweep.
   *
   * Much smaller than `bootstrapSamples` on purpose. The sweep runs a short LM
   * once per candidate distance and only needs to rank them; a few hundred
   * well-spread correspondences rank them exactly as well as fifty thousand and
   * do it two orders of magnitude faster. The precision comes later, from the
   * full solve on the full set.
   */
  sweepSamples: number;
  ransacIterations: number;
  /** Inlier threshold for the bootstrap RANSAC, projector pixels. */
  ransacInlierPx: number;
  /** Seed for the RANSAC sampling. Determinism requires it be explicit. */
  seed: number;
  /** LM iteration cap for each bootstrap stage. Deliberately small. */
  stageIterations: number;
  /**
   * How many times to alternate between re-deriving the projectors from the
   * cameras and re-fitting the cameras from the projectors.
   *
   * One round is not enough. The camera poses that come out of rung 1 were fitted
   * against projectors sitting at their NOMINAL azimuths, so they carry the
   * nominal's error; the DLT then places the projectors in that skewed frame and
   * inherits it. A second round runs the DLT against cameras that have seen
   * real projector poses, and that is usually the difference between handing the
   * optimiser a state it finishes from and handing it one it converges into a
   * local minimum from.
   */
  alternations: number;
}

export const DEFAULT_INIT_OPTIONS: InitOptions = {
  distanceMinM: 5.0,
  distanceMaxM: 6.5,
  distanceSteps: 7,
  bootstrapSamples: 2000,
  sweepSamples: 600,
  ransacIterations: 200,
  // A long-throw projector at 5 m puts one pixel at well under a millimetre on
  // the sphere, so 4 px is generous for a bootstrap and still rejects the gross
  // fringe-order errors a decode can produce.
  ransacInlierPx: 4.0,
  seed: 20240001,
  stageIterations: 40,
  alternations: 3,
};

/** Deterministic uniform subsample of indices, used everywhere in this module. */
function strideSample(items: readonly Correspondence[], max: number): Correspondence[] {
  if (max <= 0 || items.length <= max) return items.slice();
  const out: Correspondence[] = [];
  const step = items.length / max;
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function groupByProjector(
  corrs: readonly Correspondence[],
  nProjectors: number,
): Correspondence[][] {
  const groups: Correspondence[][] = [];
  for (let i = 0; i < nProjectors; i++) groups.push([]);
  for (const c of corrs) {
    if (c.projector >= 0 && c.projector < nProjectors) groups[c.projector].push(c);
  }
  return groups;
}

function groupByCamera(
  corrs: readonly Correspondence[],
  nCameras: number,
): Correspondence[][] {
  const groups: Correspondence[][] = [];
  for (let i = 0; i < nCameras; i++) groups.push([]);
  for (const c of corrs) {
    if (c.camera >= 0 && c.camera < nCameras) groups[c.camera].push(c);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Rung 0: camera distance sanity
// ---------------------------------------------------------------------------

/**
 * Pull a camera in along its own position vector when the images say the sphere
 * subtends more than the nominal distance allows.
 *
 * `fitRayCone` returns a LOWER bound on the silhouette half-angle, because a
 * single projector lights well under half the sphere and the camera sees only
 * part of that. A lower bound on the angle is an UPPER bound on the distance, so
 * this can only ever say "you are closer than you thought", never the reverse —
 * and that is the only direction it is allowed to move the camera. Scaling
 * radially rather than repositioning along the observed cone axis is the same
 * conservatism: the axis of a partial footprint is not the direction of the
 * sphere centre, and treating it as one would be reading a measurement out of a
 * bound.
 */
function correctCameraDistance(
  cam: CameraModel,
  corrs: readonly Correspondence[],
  radiusM: number,
  sampleCap: number,
): void {
  const nominal = vNorm(cam.position);
  if (!(nominal > radiusM)) return;
  const sample = strideSample(corrs, sampleCap);
  if (sample.length < 16) return;

  const dirs: Vec3[] = [];
  for (const c of sample) {
    const n = cameraPixelToNormalized(cam, c.camU, c.camV);
    dirs.push(rayFromNormalized(cam, n.x, n.y).dir);
  }
  const cone = fitRayCone(dirs);
  const observed = distanceFromAngularRadius(radiusM, cone.halfAngleRad);
  if (!Number.isFinite(observed) || observed >= nominal) return;
  const dist = Math.max(observed, radiusM * 1.2);
  cam.position = vScale(vNormalize(cam.position), dist);
}

// ---------------------------------------------------------------------------
// Rung 2a: projector pose from the nominal geometry at a given distance
// ---------------------------------------------------------------------------

/**
 * Place a projector at distance `d` from the sphere centre along its nominal
 * bearing, aimed at the centre.
 *
 * PARAMETERS.md §2 gives azimuth, height and "aim at sphere centre" as the
 * nominal; `d_proj` is the conflicted one. Scaling the whole position vector
 * rather than only its horizontal part treats `d_proj` as the centre-to-lens
 * distance the document describes, which is also what §8's tape-measure item
 * would produce.
 */
function placeAtDistance(model: ProjectorModel, d: number): void {
  const dir = vNormalize(model.position);
  const unit = vNorm(dir) > 0 ? dir : { x: 1, y: 0, z: 0 };
  model.position = vScale(unit, d);
  const e = aimEuler(model.position, { x: 0, y: 0, z: 0 }, model.rollDeg);
  model.yawDeg = e.yawDeg;
  model.pitchDeg = e.pitchDeg;
}

// ---------------------------------------------------------------------------
// Rung 2b: sub-projector point from the decoded footprint
// ---------------------------------------------------------------------------

/**
 * Estimate a projector's bearing from the centroid of the surface it lit.
 *
 * PARAMETERS.md §4.1 gives the coverage field as a function of angular distance
 * from the sub-projector point, and it is symmetric about that point, so the
 * centroid of an unclipped footprint IS the sub-projector direction. Real
 * footprints are clipped — by the camera's field of view, by the limb, by the
 * polar mask — so the centroid is biased, which is why this is one of three
 * candidates rather than the answer.
 */
function poseFromFootprint(
  model: ProjectorModel,
  state: BundleState,
  corrs: readonly Correspondence[],
  distance: number,
): ProjectorModel | null {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let count = 0;
  for (const c of corrs) {
    const cam = state.cameras[c.camera];
    const n = cameraPixelToNormalized(cam, c.camU, c.camV);
    const ray = rayFromNormalized(cam, n.x, n.y);
    const hit = intersectSphere(ray.origin, ray.dir, state.radiusM);
    if (!hit.hit) continue;
    sx += hit.point.x;
    sy += hit.point.y;
    sz += hit.point.z;
    count++;
  }
  if (count < 16) return null;
  const dir = vNormalize({ x: sx, y: sy, z: sz });
  if (vNorm(dir) === 0) return null;

  const next: ProjectorModel = { ...model, position: vScale(dir, distance) };
  const e = aimEuler(next.position, { x: 0, y: 0, z: 0 }, model.rollDeg);
  next.yawDeg = e.yawDeg;
  next.pitchDeg = e.pitchDeg;
  return next;
}

// ---------------------------------------------------------------------------
// Rung 2c: DLT pose, no nominal at all
// ---------------------------------------------------------------------------

/**
 * Direct linear transform pose from 3D-2D correspondences with known interior
 * orientation.
 *
 * Each correspondence gives a ray in the projector's own frame. Writing that
 * frame's basis as the rows of `R^T` — note the rows are (axis, -right, up), so
 * that the triad is right-handed and the matrix is a proper rotation; the
 * (axis, right, up) triad of §R is left-handed and would land the Procrustes
 * step on a reflection — the ray direction for a normalized point (x, y) is the
 * constant vector `(1, -x, y)`.
 *
 * The parallelism constraint `m x (P X) = 0` is linear in the twelve entries of
 * `P = [R^T | t]`. Two of the three cross-product rows are independent; the two
 * chosen here are the ones whose coefficient on the first component of `m` is 1,
 * which is exactly the component that can never vanish.
 *
 * World points are divided by the sphere radius before the solve. That is
 * Hartley normalisation in its simplest possible form: every point lies on the
 * unit sphere afterwards, which is as well conditioned as a DLT design matrix
 * gets, and the recovered translation scales straight back.
 */
export function dltPose(
  model: ProjectorModel,
  points: readonly Vec3[],
  pixels: readonly { u: number; v: number }[],
  radiusM: number,
): ProjectorModel | null {
  const n = points.length;
  if (n < 6) return null;
  const k = pixelIntrinsics(model);

  // Normal equations of the 2n x 12 design matrix, formed directly: n can be
  // thousands and the 12x12 Gram matrix is all the eigensolver needs.
  const g = new Float64Array(144);
  const row = new Float64Array(12);

  const addRow = (): void => {
    for (let a = 0; a < 12; a++) {
      if (row[a] === 0) continue;
      for (let b = 0; b < 12; b++) g[a * 12 + b] += row[a] * row[b];
    }
  };

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const xd = (pixels[i].u - k.cx) / k.fx;
    const yd = (k.cy - pixels[i].v) / k.fy;
    const ideal = undistortNormalized(xd, yd, model.k1, model.k2, model.p1, model.p2);
    const wx = p.x / radiusM;
    const wy = p.y / radiusM;
    const wz = p.z / radiusM;

    // Row A: y*(A.X) - (C.X) = 0
    row.fill(0);
    row[0] = ideal.y * wx;
    row[1] = ideal.y * wy;
    row[2] = ideal.y * wz;
    row[3] = ideal.y;
    row[8] = -wx;
    row[9] = -wy;
    row[10] = -wz;
    row[11] = -1;
    addRow();

    // Row B: (B.X) + x*(A.X) = 0
    row.fill(0);
    row[0] = ideal.x * wx;
    row[1] = ideal.x * wy;
    row[2] = ideal.x * wz;
    row[3] = ideal.x;
    row[4] = wx;
    row[5] = wy;
    row[6] = wz;
    row[7] = 1;
    addRow();
  }

  const eig = jacobiEigenSymmetric(g, 12);
  const vec = new Float64Array(12);
  for (let i = 0; i < 12; i++) vec[i] = eig.vectors[i * 12];

  // The overall sign of a null vector is arbitrary; fix it by requiring the
  // majority of points to be in front of the lens.
  let front = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const a =
      (vec[0] * p.x + vec[1] * p.y + vec[2] * p.z) / radiusM + vec[3];
    if (a > 0) front++;
  }
  if (front * 2 < n) for (let i = 0; i < 12; i++) vec[i] = -vec[i];

  const b = Float64Array.of(
    vec[0], vec[1], vec[2],
    vec[4], vec[5], vec[6],
    vec[8], vec[9], vec[10],
  );
  const rt = nearestRotation(b);
  let s = 0;
  for (let i = 0; i < 9; i++) s += b[i] * rt[i];
  s /= 3;
  if (!(Math.abs(s) > 1e-12)) return null;

  const t = { x: vec[3] / s, y: vec[7] / s, z: vec[11] / s };
  const r = mat3Transpose(rt);
  // t = -R^T * position  =>  position = -R * t, then undo the radius scaling.
  const posUnit = mat3MulVec(r, t);
  const position = vScale({ x: -posUnit.x, y: -posUnit.y, z: -posUnit.z }, radiusM);
  if (!Number.isFinite(position.x + position.y + position.z)) return null;

  const e = eulerFromMatrix(r);
  return {
    ...model,
    position,
    yawDeg: e.yawDeg,
    pitchDeg: e.pitchDeg,
    rollDeg: e.rollDeg,
  };
}

/**
 * Is this pose physically plausible for a projector aimed at the sphere?
 *
 * PARAMETERS.md §2 gives `d_proj` a 5.0-6.5 m prior and says every projector is
 * aimed at the sphere centre. Used as a VALUE that prior would be exactly the
 * assumption the bootstrap is supposed to be robust to; used as a BOUND it is
 * free information, and it is what stops a RANSAC hypothesis fitted to noisy
 * correspondences from winning the candidate comparison with a projector
 * reflected through the sphere or parked a hundred metres away. The bounds are
 * deliberately far outside the documented prior — a factor of four either side —
 * so that a site whose real layout disagrees with §2 still solves.
 */
function plausibleProjector(model: ProjectorModel, radiusM: number): boolean {
  const d = vNorm(model.position);
  if (!Number.isFinite(d) || d < radiusM * 1.5 || d > 40) return false;
  const axes = frameAxes(rotationMatrix(model.yawDeg, model.pitchDeg, model.rollDeg));
  const toCentre = vNormalize({
    x: -model.position.x,
    y: -model.position.y,
    z: -model.position.z,
  });
  const cos =
    axes.axis.x * toCentre.x + axes.axis.y * toCentre.y + axes.axis.z * toCentre.z;
  // 60 degrees of misaim is far more than any real mount allows and still leaves
  // room for a badly-wrong nominal.
  return cos > 0.5;
}

/** Mean reprojection error in projector pixels, for a single projector. */
function projectorRms(
  model: ProjectorModel,
  points: readonly Vec3[],
  pixels: readonly { u: number; v: number }[],
): number {
  const axes = frameAxes(rotationMatrix(model.yawDeg, model.pitchDeg, model.rollDeg));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    const shot = projectPointWithAxes(model, axes, points[i]);
    if (!shot.inFront) continue;
    const du = shot.u - pixels[i].u;
    const dv = shot.v - pixels[i].v;
    sum += du * du + dv * dv;
    count++;
  }
  if (count === 0) return Number.POSITIVE_INFINITY;
  // Penalise a pose that only manages to see part of the data: a projector that
  // reprojects six points perfectly and drops the rest is not a better fit.
  const coverage = count / points.length;
  return Math.sqrt(sum / count) / Math.max(coverage, 1e-6);
}

/**
 * Fill `out` with distinct indices below `n`, or report that it could not.
 *
 * Rejection sampling rather than a partial Fisher-Yates shuffle: the draw is
 * six from thousands, so a collision is rare and a retry is cheaper than
 * touching an n-element array once per RANSAC iteration.
 */
function drawDistinct(out: number[], n: number, rng: { nextInt(bound: number): number }): boolean {
  if (n < out.length) return false;
  for (let s = 0; s < out.length; s++) {
    let tries = 0;
    let candidate = rng.nextInt(n);
    while (out.lastIndexOf(candidate, s - 1) >= 0) {
      if (++tries > 64) return false;
      candidate = rng.nextInt(n);
    }
    out[s] = candidate;
  }
  return true;
}

/**
 * RANSAC over the DLT, so one badly-unwrapped fringe cannot define the pose.
 *
 * The iteration count is fixed rather than adaptive. An adaptive count depends
 * on the running inlier ratio, which depends on the samples drawn, which makes
 * the amount of work — and therefore the floating-point reduction order of the
 * final refit — depend on the data in a way that is tedious to reproduce. A
 * fixed count with a seeded generator is reproducible by construction, which is
 * what the bench needs.
 */
function ransacDlt(
  model: ProjectorModel,
  points: readonly Vec3[],
  pixels: readonly { u: number; v: number }[],
  radiusM: number,
  opts: InitOptions,
  seedOffset: number,
): ProjectorModel | null {
  if (points.length < 6) return null;
  const rng = createRng(opts.seed + seedOffset);
  let best: ProjectorModel | null = null;
  let bestInliers = 0;

  const sampleIdx = new Array<number>(6);
  for (let iter = 0; iter < opts.ransacIterations; iter++) {
    // Six DISTINCT points. Drawing with replacement repeats an index about 0.75%
    // of the time at the default sample size, and a minimal set with a repeat
    // gives dltPose fewer than six constraints for a twelve-column system: the
    // block is rank deficient, `nearestRotation`'s determinant branch cannot
    // repair it, and the iteration burns on a candidate that was never a
    // candidate. Redrawing the collision costs a few extra RNG calls and keeps
    // every iteration a real hypothesis.
    if (!drawDistinct(sampleIdx, points.length, rng)) continue;
    const sp = sampleIdx.map((i) => points[i]);
    const sx = sampleIdx.map((i) => pixels[i]);
    const candidate = dltPose(model, sp, sx, radiusM);
    if (!candidate) continue;

    const axes = frameAxes(
      rotationMatrix(candidate.yawDeg, candidate.pitchDeg, candidate.rollDeg),
    );
    let inliers = 0;
    for (let i = 0; i < points.length; i++) {
      const shot = projectPointWithAxes(candidate, axes, points[i]);
      if (!shot.inFront) continue;
      const du = shot.u - pixels[i].u;
      const dv = shot.v - pixels[i].v;
      if (du * du + dv * dv <= opts.ransacInlierPx * opts.ransacInlierPx) inliers++;
    }
    if (inliers > bestInliers) {
      bestInliers = inliers;
      best = candidate;
    }
  }
  if (!best) return null;

  // Refit on the consensus set. The minimal-sample pose is only ever a
  // hypothesis; the pose worth keeping is the one that used all the good data.
  const axes = frameAxes(rotationMatrix(best.yawDeg, best.pitchDeg, best.rollDeg));
  const ip: Vec3[] = [];
  const ix: { u: number; v: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const shot = projectPointWithAxes(best, axes, points[i]);
    if (!shot.inFront) continue;
    const du = shot.u - pixels[i].u;
    const dv = shot.v - pixels[i].v;
    if (du * du + dv * dv <= opts.ransacInlierPx * opts.ransacInlierPx) {
      ip.push(points[i]);
      ix.push(pixels[i]);
    }
  }
  if (ip.length < 6) return best;
  return dltPose(model, ip, ix, radiusM) ?? best;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export interface BootstrapReport {
  state: BundleState;
  /** The `d_proj` candidate the sweep selected, metres. */
  selectedDistanceM: number;
  /** Score of each candidate distance, in the sweep's own units. Diagnostic. */
  distanceScores: { distanceM: number; score: number }[];
  /** Which candidate won for each projector. */
  projectorSource: ('nominal' | 'footprint' | 'dlt')[];
}

export function bootstrap(
  nominal: BundleState,
  correspondences: readonly Correspondence[],
  floor: readonly FloorReference[],
  options: Partial<InitOptions> = {},
  bundleOptions: Partial<BundleOptions> = {},
  /**
   * Carried through every rung so the ladder optimises the same objective the
   * full solve will. A bootstrap that ignored the priors would hand the
   * optimiser a state fitted to a different problem.
   */
  priors: readonly ParameterPrior[] = [],
): BootstrapReport {
  const opts: InitOptions = { ...DEFAULT_INIT_OPTIONS, ...options };
  const base: BundleOptions = {
    ...DEFAULT_BUNDLE_OPTIONS,
    ...bundleOptions,
    free: { ...DEFAULT_FREE_FLAGS, ...(bundleOptions.free ?? {}) },
  };

  const nProjectors = nominal.projectors.length;
  const nCameras = nominal.cameras.length;
  const byCamera = groupByCamera(correspondences, nCameras);

  // --- rung 0 ---
  const start = cloneState(nominal);
  for (let c = 0; c < nCameras; c++) {
    correctCameraDistance(start.cameras[c], byCamera[c], start.radiusM, opts.bootstrapSamples);
  }

  // --- rung 1: sweep the d_proj prior, cameras only ---
  const sweepSample = strideSample(correspondences, opts.sweepSamples);
  const sample = strideSample(correspondences, opts.bootstrapSamples * Math.max(1, nProjectors));
  const distanceScores: { distanceM: number; score: number }[] = [];
  let bestState = start;
  let bestScore = Number.POSITIVE_INFINITY;
  let selectedDistanceM = vNorm(start.projectors[0]?.position ?? { x: 0, y: 0, z: 0 });

  const steps = Math.max(1, opts.distanceSteps);
  for (let i = 0; i < steps; i++) {
    const d =
      steps === 1
        ? 0.5 * (opts.distanceMinM + opts.distanceMaxM)
        : opts.distanceMinM + ((opts.distanceMaxM - opts.distanceMinM) * i) / (steps - 1);
    const trial = cloneState(start);
    for (const p of trial.projectors) placeAtDistance(p, d);

    // Both sides move. An earlier version held the projectors and fitted only
    // the cameras, on the theory that holding one side breaks the chicken-and-egg
    // — but it breaks it the wrong way: the camera poses then absorb the
    // nominal's own error, and with only two or three cameras each one absorbs a
    // DIFFERENT projector's error and they end up in mutually inconsistent
    // frames. Everything downstream inherits that, and the DLT that was supposed
    // to fix the projectors is fed 3D points computed from the broken cameras.
    // Letting the poses move together makes each candidate distance an honest
    // multi-start; the field of view stays held because freeing it here opens
    // the focal/distance valley before anything is pinned.
    const report = runBundle(trial, sweepSample, floor, {
      ...base,
      free: {
        ...base.free,
        projectorPose: true,
        projectorFov: false,
        projectorShift: false,
        projectorRadial: false,
        projectorTangential: false,
        cameraPose: true,
        centerHeight: false,
      },
      maxIterations: opts.stageIterations,
      rejectionPasses: 0,
    }, undefined, priors);

    const coverage = report.used / Math.max(1, sweepSample.length);
    const score = coverage > 0 ? report.rmsResidualPx / coverage : Number.POSITIVE_INFINITY;
    distanceScores.push({ distanceM: d, score });
    if (score < bestScore) {
      bestScore = score;
      bestState = report.state;
      selectedDistanceM = d;
    }
  }

  // --- rung 2: alternate projector re-derivation and camera re-fitting ---
  let state = cloneState(bestState);
  const byProjector = groupByProjector(correspondences, nProjectors);
  const projectorSource: ('nominal' | 'footprint' | 'dlt')[] = new Array(nProjectors).fill(
    'nominal',
  );
  // The rung-1 result is the fallback: projectors at their nominal azimuths and
  // the swept distance, cameras fitted to them. It is never brilliant, but it is
  // always plausible, and returning it beats returning a round that went
  // somewhere physically impossible.
  let bestRound: BundleState = cloneState(state);
  let bestRoundScore = Number.POSITIVE_INFINITY;
  let bestRoundSource: ('nominal' | 'footprint' | 'dlt')[] = projectorSource.slice();

  for (let round = 0; round < Math.max(1, opts.alternations); round++) {
    for (let p = 0; p < nProjectors; p++) {
      const sampleP = strideSample(byProjector[p], opts.bootstrapSamples);
      const points: Vec3[] = [];
      const pixels: { u: number; v: number }[] = [];
      for (const c of sampleP) {
        const cam = state.cameras[c.camera];
        const nrm = cameraPixelToNormalized(cam, c.camU, c.camV);
        const ray = rayFromNormalized(cam, nrm.x, nrm.y);
        const hit = intersectSphere(ray.origin, ray.dir, state.radiusM);
        if (!hit.hit) continue;
        points.push(hit.point);
        pixels.push({ u: c.projU, v: c.projV });
      }
      if (points.length < 6) continue;

      const candidates: { source: 'nominal' | 'footprint' | 'dlt'; model: ProjectorModel }[] = [
        { source: projectorSource[p], model: state.projectors[p] },
      ];
      const footprint = poseFromFootprint(state.projectors[p], state, sampleP, selectedDistanceM);
      if (footprint && plausibleProjector(footprint, state.radiusM)) {
        candidates.push({ source: 'footprint', model: footprint });
      }
      const dlt = ransacDlt(
        state.projectors[p],
        points,
        pixels,
        state.radiusM,
        opts,
        p * 7919 + round * 104729,
      );
      if (dlt && plausibleProjector(dlt, state.radiusM)) {
        candidates.push({ source: 'dlt', model: dlt });
      }

      let bestIdx = 0;
      let bestErr = Number.POSITIVE_INFINITY;
      for (let i = 0; i < candidates.length; i++) {
        const err = projectorRms(candidates[i].model, points, pixels);
        if (err < bestErr) {
          bestErr = err;
          bestIdx = i;
        }
      }
      state.projectors[p] = candidates[bestIdx].model;
      projectorSource[p] = candidates[bestIdx].source;
    }

    // Settle the round with a short joint fit, then keep it only if it actually
    // improved on the best round so far. Alternation is not monotone on its own:
    // one badly-placed projector can drag the camera refit, and the next round
    // then re-derives every projector in a frame that is worse than the one it
    // started from. Scoring each round and keeping the best makes the ladder
    // monotone by construction, which is cheap insurance for a stage whose whole
    // job is to hand the optimiser a state it can finish from.
    // The field of view stays HELD here. It is class CFG in PARAMETERS.md §3.1 —
    // derived from a throw ratio read off a spec sheet — and freeing it before
    // the geometry is pinned opens the focal/distance degeneracy that a
    // long-throw lens has in abundance: the sphere subtends only about 19
    // degrees, so there is very little depth baseline separating "the projector
    // is further away" from "the projector has a narrower field", and a noisy
    // bootstrap will happily slide tens of metres along that valley.
    const settled = runBundle(state, sample, floor, {
      ...base,
      free: {
        ...base.free,
        projectorPose: true,
        projectorFov: false,
        projectorShift: false,
        projectorRadial: false,
        projectorTangential: false,
        cameraPose: true,
        centerHeight: false,
      },
      maxIterations: opts.stageIterations,
      rejectionPasses: 0,
    }, undefined, priors);
    const plausible = settled.state.projectors.every((m) =>
      plausibleProjector(m, settled.state.radiusM),
    );
    const score =
      settled.used > 0 && plausible
        ? settled.rmsResidualPx / (settled.used / Math.max(1, sample.length))
        : Number.POSITIVE_INFINITY;
    if (score < bestRoundScore) {
      bestRoundScore = score;
      bestRound = cloneState(settled.state);
      bestRoundSource = projectorSource.slice();
    }
    state = settled.state;
  }

  state = bestRound;
  for (let p = 0; p < nProjectors; p++) projectorSource[p] = bestRoundSource[p];

  return {
    state,
    selectedDistanceM,
    distanceScores,
    projectorSource,
  };
}
