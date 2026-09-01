// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A synthetic scene generator, built from the SOLVER'S OWN forward math.
 *
 * This is not a second simulator and it is not a substitute for one. The bench
 * scores this package against `packages/sim`, which implements the same
 * conventions independently; that comparison is the real test and this file
 * cannot stand in for it. What this file proves is narrower and still worth
 * proving: that the solver is *self-consistent* — that its bundle adjustment
 * recovers a perturbation that its own projection model generated, that its
 * decoder reads patterns its own pattern definition emitted, and that its
 * analytic Jacobians match its own residuals.
 *
 * Those are the failures that would otherwise hide behind a large A/B recovery
 * error and get misattributed to a convention disagreement. Ruling them out
 * here means that when the bench does report a large error, the error is
 * telling us something about the conventions rather than about a sign slip in
 * a derivative.
 *
 * Everything is seeded. Nothing calls `Math.random`.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import {
  type Mat3,
  type Vec3,
  createRng,
  mat3Multiply,
  mat3MulVec,
  mat3Transpose,
  kabschRotation,
  vNorm,
  vNormalize,
  vScale,
  vSub,
} from '../src/linalg.ts';
import {
  aimEuler,
  eulerFromMatrix,
  frameAxes,
  projectPointWithAxes,
  rotationMatrix,
  type ProjectorModel,
} from '../src/project.ts';
import {
  type CameraIntrinsics,
  type CameraModel,
  cameraAtTime,
  cameraPixelToNormalized,
  intersectSphere,
  rayFromNormalized,
} from '../src/sphere.ts';
import type { BundleState } from '../src/bundle.ts';
import type {
  Correspondence,
  GraySequence,
  LinearImage,
  PatternCapture,
  PhaseSequence,
} from '../src/decode.ts';
import { binaryToGray } from '../src/decode.ts';
import { intersectMesh, type MeshIndex } from '../src/mesh.ts';
import {
  bundleStateFromCalibration,
  nominalRig,
  type SolverCameraInput,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// Camera rig
// ---------------------------------------------------------------------------

/**
 * A plausible phone-class camera.
 *
 * PARAMETERS.md's experiment plan asks whether a phone suffices, so the default
 * test camera is phone-shaped rather than metrology-shaped: a modest sensor, a
 * moderately wide field, and real barrel distortion. `k1` of -0.09 is typical
 * of a phone main camera after the maker's own correction has been turned off,
 * which is what a RAW capture gives you.
 */
export function phoneIntrinsics(resX = 960, resY = 720): CameraIntrinsics {
  const fovHDeg = 62;
  const fx = resX / 2 / Math.tan(((fovHDeg / 2) * Math.PI) / 180);
  return {
    resX,
    resY,
    fx,
    fy: fx,
    cx: resX / 2,
    cy: resY / 2,
    k1: -0.09,
    k2: 0.02,
    p1: 0,
    p2: 0,
  };
}

export interface SceneOptions {
  projectorCount: number;
  cameraCount: number;
  cameraDistanceM: number;
  /** Camera height above the floor, metres. A tripod at eye level. */
  cameraHeightM: number;
  cameraRes: { x: number; y: number };
  projectorRes: { x: number; y: number };
  /** Peak magnitude of the injected misalignment. */
  positionJitterM: number;
  angleJitterDeg: number;
  fovJitterDeg: number;
  shiftJitter: number;
  k1Jitter: number;
  k2Jitter: number;
  centerHeightJitterM: number;
  /** Where the camera nominals sit relative to truth, i.e. how wrong the operator is. */
  cameraNominalPositionErrorM: number;
  cameraNominalAngleErrorDeg: number;
}

export const DEFAULT_SCENE: SceneOptions = {
  projectorCount: 4,
  cameraCount: 3,
  cameraDistanceM: 2.6,
  cameraHeightM: 1.6,
  cameraRes: { x: 960, y: 720 },
  projectorRes: { x: 1920, y: 1080 },
  // PARAMETERS.md §2 says real mounts hold plus or minus 1-2 degrees of azimuth,
  // so a degree of angular jitter and a few centimetres of position is a
  // realistic "the rig has drifted since it was installed" perturbation.
  positionJitterM: 0.03,
  angleJitterDeg: 1.0,
  fovJitterDeg: 0.25,
  shiftJitter: 0.01,
  k1Jitter: 0.02,
  k2Jitter: 0.004,
  // The documented add-or-subtract-an-inch correction, PARAMETERS.md §1.
  centerHeightJitterM: 0.0254,
  cameraNominalPositionErrorM: 0.25,
  cameraNominalAngleErrorDeg: 3.0,
};

export interface Scene {
  /** Ground truth. The solver never sees this. */
  truth: BundleState;
  /** What the solver is given: PARAMETERS.md nominals as a RigCalibration. */
  nominal: RigCalibration;
  /** What the solver is given about the cameras: intrinsics and a rough pose. */
  cameraInputs: SolverCameraInput[];
  options: SceneOptions;
}

function placeCameras(
  opts: SceneOptions,
  centerHeightM: number,
): { position: Vec3; yawDeg: number; pitchDeg: number; rollDeg: number }[] {
  const out: { position: Vec3; yawDeg: number; pitchDeg: number; rollDeg: number }[] = [];
  for (let i = 0; i < opts.cameraCount; i++) {
    // Spread the cameras around the sphere but deliberately off the projector
    // azimuths, so no camera sits on a seam and every projector is seen
    // obliquely by at least one of them.
    const phi = ((2 * Math.PI * i) / opts.cameraCount) + Math.PI / 7;
    const z = opts.cameraHeightM - centerHeightM;
    const horizontal = Math.sqrt(
      Math.max(0.01, opts.cameraDistanceM * opts.cameraDistanceM - z * z),
    );
    const position = {
      x: horizontal * Math.cos(phi),
      y: horizontal * Math.sin(phi),
      z,
    };
    const e = aimEuler(position, { x: 0, y: 0, z: 0 }, 0);
    out.push({ position, yawDeg: e.yawDeg, pitchDeg: e.pitchDeg, rollDeg: 0 });
  }
  return out;
}

/** Build a scene: nominal rig, perturbed ground truth, and the camera inputs. */
export function makeScene(seed: number, overrides: Partial<SceneOptions> = {}): Scene {
  const opts: SceneOptions = { ...DEFAULT_SCENE, ...overrides };
  const rng = createRng(seed);

  const nominal = nominalRig({
    projectorCount: opts.projectorCount,
    resX: opts.projectorRes.x,
    resY: opts.projectorRes.y,
  });

  const camPoses = placeCameras(opts, nominal.sphere.centerHeightM);
  const intrinsics = phoneIntrinsics(opts.cameraRes.x, opts.cameraRes.y);

  // The operator's guess: right side of the sphere, wrong distance and aim.
  const cameraInputs: SolverCameraInput[] = camPoses.map((p) => {
    const scale = 1 + opts.cameraNominalPositionErrorM / opts.cameraDistanceM;
    return {
      intrinsics: { ...intrinsics },
      position: vScale(p.position, scale),
      yawDeg: p.yawDeg + opts.cameraNominalAngleErrorDeg,
      pitchDeg: p.pitchDeg - opts.cameraNominalAngleErrorDeg * 0.5,
      rollDeg: p.rollDeg,
    };
  });

  const truth = bundleStateFromCalibration(
    nominal,
    camPoses.map((p) => ({ intrinsics: { ...intrinsics }, ...p })),
  );

  const jitter = (mag: number): number => (rng.nextFloat() * 2 - 1) * mag;
  for (const p of truth.projectors) {
    p.position = {
      x: p.position.x + jitter(opts.positionJitterM),
      y: p.position.y + jitter(opts.positionJitterM),
      z: p.position.z + jitter(opts.positionJitterM),
    };
    p.yawDeg += jitter(opts.angleJitterDeg);
    p.pitchDeg += jitter(opts.angleJitterDeg);
    p.rollDeg += jitter(opts.angleJitterDeg);
    p.fovHDeg += jitter(opts.fovJitterDeg);
    p.shiftH += jitter(opts.shiftJitter);
    p.shiftV += jitter(opts.shiftJitter);
    p.k1 += jitter(opts.k1Jitter);
    p.k2 += jitter(opts.k2Jitter);
  }
  truth.centerHeightM += jitter(opts.centerHeightJitterM);

  return { truth, nominal, cameraInputs, options: opts };
}

// ---------------------------------------------------------------------------
// Correspondence generation
// ---------------------------------------------------------------------------

export interface CorrespondenceOptions {
  /** Sample every Nth camera pixel in each axis. */
  cameraStride: number;
  /** Reported per-correspondence sigma, projector pixels. */
  sigmaPx: number;
  /** Gaussian noise added to the decoded projector coordinate, projector pixels. */
  noisePx: number;
  seed: number;
  /**
   * Minimum cosine of incidence from the projector for a point to count as lit.
   * PARAMETERS.md §4.3 takes 0.2 as the point where resolution smear exceeds 5x
   * and the image becomes streaks, so anything below that is not a
   * correspondence a real capture would produce.
   */
  minCosIncidence: number;
  /**
   * The epochs, in pattern frames, at which the `u` and `v` coordinates were
   * photographed. Both zero reproduces a capture with no time in it.
   *
   * When the truth cameras carry a `velocity`, the two coordinates are traced
   * from the camera as it was at ITS OWN epoch — which is what a real capture
   * does and what a single-pose bundle cannot express.
   */
  epochU: number;
  epochV: number;
  /**
   * Trace against this mesh instead of the sphere. `null` is the sphere.
   *
   * The same optional-surface shape `BundleOptions` uses, for the same reason:
   * a corpus and the solve that scores it must be generated by ONE forward
   * model, or a recovery number measures the difference between two fixtures.
   */
  surface?: MeshIndex | null;
}

export const DEFAULT_CORRESPONDENCE_OPTIONS: CorrespondenceOptions = {
  cameraStride: 12,
  sigmaPx: 0.25,
  noisePx: 0,
  seed: 7,
  minCosIncidence: 0.2,
  epochU: 0,
  epochV: 0,
  surface: null,
};

/**
 * Generate correspondences by tracing the solver's own forward model.
 *
 * For every sampled camera pixel: ray, sphere hit, then for every projector
 * that both faces the point and contains it in its raster, one correspondence.
 * Emitting one per (camera pixel, projector) pair matches the capture protocol
 * of decode.ts, where each projector is patterned on its own.
 */
export function generateCorrespondences(
  truth: BundleState,
  options: Partial<CorrespondenceOptions> = {},
): Correspondence[] {
  const opts: CorrespondenceOptions = { ...DEFAULT_CORRESPONDENCE_OPTIONS, ...options };
  const rng = createRng(opts.seed);
  const out: Correspondence[] = [];

  const projAxes = truth.projectors.map((p) =>
    frameAxes(rotationMatrix(p.yawDeg, p.pitchDeg, p.rollDeg)),
  );

  for (let c = 0; c < truth.cameras.length; c++) {
    const cam = truth.cameras[c];
    const camU_ = cameraAtTime(cam, opts.epochU, 0);
    const camV_ = cameraAtTime(cam, opts.epochV, 0);
    const same = camU_ === camV_;
    for (let py = 0; py < cam.intrinsics.resY; py += opts.cameraStride) {
      for (let px = 0; px < cam.intrinsics.resX; px += opts.cameraStride) {
        const camU = px + 0.5;
        const camV = py + 0.5;
        const n = cameraPixelToNormalized(cam, camU, camV);
        const rayU = rayFromNormalized(camU_, n.x, n.y);
        const trace = (o: Vec3, d: Vec3): { hit: boolean; point: Vec3; normal: Vec3 } =>
          opts.surface ? intersectMesh(opts.surface, o, d) : intersectSphere(o, d, truth.radiusM);
        const hitU = trace(rayU.origin, rayU.dir);
        if (!hitU.hit) continue;
        let hitV = hitU;
        if (!same) {
          const rayV = rayFromNormalized(camV_, n.x, n.y);
          hitV = trace(rayV.origin, rayV.dir);
          if (!hitV.hit) continue;
        }

        for (let p = 0; p < truth.projectors.length; p++) {
          const proj = truth.projectors[p];
          const toLens = vNormalize(vSub(proj.position, hitU.point));
          const cosInc =
            toLens.x * hitU.normal.x + toLens.y * hitU.normal.y + toLens.z * hitU.normal.z;
          if (cosInc < opts.minCosIncidence) continue;

          const shot = projectPointWithAxes(proj, projAxes[p], hitU.point);
          if (!shot.inFront) continue;
          if (shot.u < 0 || shot.u > proj.resX || shot.v < 0 || shot.v > proj.resY) continue;
          let shotV = shot;
          if (!same) {
            shotV = projectPointWithAxes(proj, projAxes[p], hitV.point);
            if (!shotV.inFront) continue;
            if (shotV.v < 0 || shotV.v > proj.resY) continue;
          }

          out.push({
            camera: c,
            projector: p,
            camU,
            camV,
            projU: shot.u + (opts.noisePx > 0 ? rng.nextGaussian() * opts.noisePx : 0),
            projV: shotV.v + (opts.noisePx > 0 ? rng.nextGaussian() * opts.noisePx : 0),
            sigmaU: opts.sigmaPx,
            sigmaV: opts.sigmaPx,
            modulation: cosInc,
            timeU: opts.epochU,
            timeV: opts.epochV,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern image rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  grayBits: number;
  phaseSteps: number;
  phasePeriodPx: number;
  /** Relative ambient added to every frame. PARAMETERS.md §5 nominal is 0.04. */
  ambient: number;
  /** Gaussian sensor noise, in the same relative-radiance units. */
  noiseSigma: number;
  seed: number;
  minCosIncidence: number;
  /** Include explicit all-on and all-off frames. */
  includeWhiteBlack: boolean;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  grayBits: 7,
  phaseSteps: 4,
  phasePeriodPx: 0,
  ambient: 0.04,
  noiseSigma: 0,
  seed: 11,
  minCosIncidence: 0.2,
  includeWhiteBlack: true,
};

interface PixelSample {
  lit: boolean;
  /** Projector coordinates seen at this camera pixel. */
  u: number;
  v: number;
  /** Product of albedo and shading — everything the pattern gets multiplied by. */
  shade: number;
}

/**
 * A spatially varying albedo.
 *
 * The sphere is matte white (PARAMETERS.md §1, rho ~ 0.9) so a real one is
 * nearly uniform, but a decoder that only ever sees a uniform surface is not
 * being tested for the property that matters: Gray decoding is
 * pattern-versus-complement precisely so that per-pixel albedo cancels. Varying
 * it by a factor of two makes that cancellation load-bearing in the test.
 */
function albedoAt(u: number, v: number): number {
  return 0.55 + 0.35 * Math.sin(u * 0.021) * Math.cos(v * 0.017);
}

function samplePixels(
  truth: BundleState,
  cameraIndex: number,
  projectorIndex: number,
  opts: RenderOptions,
): { samples: PixelSample[]; width: number; height: number } {
  const cam = truth.cameras[cameraIndex];
  const proj = truth.projectors[projectorIndex];
  const axes = frameAxes(rotationMatrix(proj.yawDeg, proj.pitchDeg, proj.rollDeg));
  const width = cam.intrinsics.resX;
  const height = cam.intrinsics.resY;
  const samples: PixelSample[] = new Array(width * height);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      const n = cameraPixelToNormalized(cam, px + 0.5, py + 0.5);
      const ray = rayFromNormalized(cam, n.x, n.y);
      const hit = intersectSphere(ray.origin, ray.dir, truth.radiusM);
      if (!hit.hit) {
        samples[idx] = { lit: false, u: 0, v: 0, shade: 0 };
        continue;
      }
      const toLens = vNormalize(vSub(proj.position, hit.point));
      const cosInc =
        toLens.x * hit.normal.x + toLens.y * hit.normal.y + toLens.z * hit.normal.z;
      const shot = projectPointWithAxes(proj, axes, hit.point);
      const inside =
        shot.inFront &&
        shot.u >= 0 &&
        shot.u <= proj.resX &&
        shot.v >= 0 &&
        shot.v <= proj.resY;
      if (!inside || cosInc < opts.minCosIncidence) {
        samples[idx] = { lit: false, u: 0, v: 0, shade: 0 };
        continue;
      }
      samples[idx] = {
        lit: true,
        u: shot.u,
        v: shot.v,
        // Lambertian falloff times albedo. PARAMETERS.md §4.1 defines exactly
        // this cosine as the coverage field.
        shade: albedoAt(px, py) * cosInc,
      };
    }
  }
  return { samples, width, height };
}

function makeImage(width: number, height: number): LinearImage {
  return { width, height, channels: 1, data: new Float64Array(width * height) };
}

/**
 * Render one camera's view of one projector's full pattern sequence.
 *
 * The pattern definitions are the ones stated normatively at the top of
 * decode.ts — that is the point of the exercise, since a generator that
 * disagrees with the decoder proves nothing.
 */
export function renderCapture(
  truth: BundleState,
  cameraIndex: number,
  projectorIndex: number,
  options: Partial<RenderOptions> = {},
): PatternCapture {
  const opts: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, ...options };
  const proj = truth.projectors[projectorIndex];
  const { samples, width, height } = samplePixels(truth, cameraIndex, projectorIndex, opts);
  const rng = createRng(opts.seed + cameraIndex * 1009 + projectorIndex * 5003);

  const noise = (): number => (opts.noiseSigma > 0 ? rng.nextGaussian() * opts.noiseSigma : 0);
  const emit = (value: (s: PixelSample) => number): LinearImage => {
    const img = makeImage(width, height);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const signal = s.lit ? s.shade * value(s) : 0;
      img.data[i] = signal + opts.ambient + noise();
    }
    return img;
  };

  const strideU = proj.resX / Math.pow(2, opts.grayBits);
  const strideV = proj.resY / Math.pow(2, opts.grayBits);
  const codeCount = Math.pow(2, opts.grayBits);

  const graySeq = (axis: 'u' | 'v', stride: number): GraySequence => {
    const patterns: LinearImage[] = [];
    const inverses: LinearImage[] = [];
    for (let j = 0; j < opts.grayBits; j++) {
      const bitOf = (s: PixelSample): number => {
        const coord = axis === 'u' ? s.u : s.v;
        const code = Math.min(codeCount - 1, Math.max(0, Math.floor(coord / stride)));
        return (binaryToGray(code) >>> (opts.grayBits - 1 - j)) & 1;
      };
      patterns.push(emit(bitOf));
      inverses.push(emit((s) => 1 - bitOf(s)));
    }
    return { axis, bits: opts.grayBits, stridePx: stride, patterns, inverses };
  };

  const phaseSeq = (axis: 'u' | 'v', stride: number): PhaseSequence => {
    // Two Gray bins to a fringe. See the pattern definition in decode.ts: equal
    // scales make the Gray-versus-phase cross-check structurally unable to fire.
    const period = opts.phasePeriodPx > 0 ? opts.phasePeriodPx : stride * 2;
    const frames: LinearImage[] = [];
    for (let n = 0; n < opts.phaseSteps; n++) {
      frames.push(
        emit((s) => {
          const coord = axis === 'u' ? s.u : s.v;
          return (
            0.5 +
            0.5 *
              Math.cos((2 * Math.PI * coord) / period - (2 * Math.PI * n) / opts.phaseSteps)
          );
        }),
      );
    }
    return { axis, steps: opts.phaseSteps, periodPx: period, frames };
  };

  return {
    camera: cameraIndex,
    projector: projectorIndex,
    projectorRes: { x: proj.resX, y: proj.resY },
    white: opts.includeWhiteBlack ? emit(() => 1) : null,
    black: opts.includeWhiteBlack ? emit(() => 0) : null,
    gray: [graySeq('u', strideU), graySeq('v', strideV)],
    phase: [phaseSeq('u', strideU), phaseSeq('v', strideV)],
  };
}

export function renderAllCaptures(
  truth: BundleState,
  options: Partial<RenderOptions> = {},
): PatternCapture[] {
  const out: PatternCapture[] = [];
  for (let c = 0; c < truth.cameras.length; c++) {
    for (let p = 0; p < truth.projectors.length; p++) {
      out.push(renderCapture(truth, c, p, options));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface PoseError {
  positionM: number;
  rotationDeg: number;
}

/** Angle of the relative rotation, degrees. */
export function rotationAngleDeg(a: Mat3, b: Mat3): number {
  const rel = mat3Multiply(a, mat3Transpose(b));
  const trace = rel[0] + rel[4] + rel[8];
  const c = Math.min(1, Math.max(-1, (trace - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

export function projectorPoseError(a: ProjectorModel, b: ProjectorModel): PoseError {
  return {
    positionM: vNorm(vSub(a.position, b.position)),
    rotationDeg: rotationAngleDeg(
      rotationMatrix(a.yawDeg, a.pitchDeg, a.rollDeg),
      rotationMatrix(b.yawDeg, b.pitchDeg, b.rollDeg),
    ),
  };
}

export function cameraPoseError(a: CameraModel, b: CameraModel): PoseError {
  return {
    positionM: vNorm(vSub(a.position, b.position)),
    rotationDeg: rotationAngleDeg(
      rotationMatrix(a.yawDeg, a.pitchDeg, a.rollDeg),
      rotationMatrix(b.yawDeg, b.pitchDeg, b.rollDeg),
    ),
  };
}

/**
 * Remove the unobservable global rotation before comparing to ground truth.
 *
 * bundle.ts explains why this is necessary rather than generous: rotating every
 * projector and every camera about the sphere centre leaves every residual
 * unchanged, so no solver can determine it and any score that charges the
 * solver for it is measuring the gauge rather than the calibration. This is the
 * standard free-network treatment — align first, then measure what is left.
 *
 * The alignment is Kabsch over all entity positions, using the rank-aware
 * implementation in linalg.ts — the projectors alone are coplanar, which the
 * polar-decomposition shortcut cannot handle.
 *
 * The bench should do exactly this, or explicitly accept the inner-constraint
 * gauge documented in bundle.ts.
 */
export function alignToTruth(recovered: BundleState, truth: BundleState): BundleState {
  const from: Vec3[] = [];
  const to: Vec3[] = [];
  for (let i = 0; i < recovered.projectors.length; i++) {
    from.push(recovered.projectors[i].position);
    to.push(truth.projectors[i].position);
  }
  for (let i = 0; i < recovered.cameras.length; i++) {
    from.push(recovered.cameras[i].position);
    to.push(truth.cameras[i].position);
  }
  const rg = kabschRotation(from, to);

  const applyRot = (
    yaw: number,
    pitch: number,
    roll: number,
  ): { yawDeg: number; pitchDeg: number; rollDeg: number } =>
    eulerFromMatrix(mat3Multiply(rg, rotationMatrix(yaw, pitch, roll)));

  return {
    radiusM: recovered.radiusM,
    centerHeightM: recovered.centerHeightM,
    projectors: recovered.projectors.map((p) => {
      const r = applyRot(p.yawDeg, p.pitchDeg, p.rollDeg);
      return { ...p, position: mat3MulVec(rg, p.position), ...r };
    }),
    cameras: recovered.cameras.map((c) => {
      const r = applyRot(c.yawDeg, c.pitchDeg, c.rollDeg);
      return {
        ...c,
        intrinsics: { ...c.intrinsics },
        position: mat3MulVec(rg, c.position),
        ...r,
      };
    }),
  };
}

export interface RecoveryScore {
  maxProjectorPositionM: number;
  maxProjectorRotationDeg: number;
  maxCameraPositionM: number;
  maxCameraRotationDeg: number;
  maxFovErrorDeg: number;
  centerHeightErrorM: number;
}

export function scoreRecovery(recovered: BundleState, truth: BundleState): RecoveryScore {
  let maxPp = 0;
  let maxPr = 0;
  let maxFov = 0;
  for (let i = 0; i < truth.projectors.length; i++) {
    const e = projectorPoseError(recovered.projectors[i], truth.projectors[i]);
    maxPp = Math.max(maxPp, e.positionM);
    maxPr = Math.max(maxPr, e.rotationDeg);
    maxFov = Math.max(
      maxFov,
      Math.abs(recovered.projectors[i].fovHDeg - truth.projectors[i].fovHDeg),
    );
  }
  let maxCp = 0;
  let maxCr = 0;
  for (let i = 0; i < truth.cameras.length; i++) {
    const e = cameraPoseError(recovered.cameras[i], truth.cameras[i]);
    maxCp = Math.max(maxCp, e.positionM);
    maxCr = Math.max(maxCr, e.rotationDeg);
  }
  return {
    maxProjectorPositionM: maxPp,
    maxProjectorRotationDeg: maxPr,
    maxCameraPositionM: maxCp,
    maxCameraRotationDeg: maxCr,
    maxFovErrorDeg: maxFov,
    centerHeightErrorM: Math.abs(recovered.centerHeightM - truth.centerHeightM),
  };
}
