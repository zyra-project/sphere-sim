/**
 * @sphere/solver — the inverse model (B).
 *
 * Input: camera images of structured-light patterns, the operator's camera
 * calibration, and the PARAMETERS.md nominals as an initialisation.
 * Output: a `RigCalibration` and `SolveDiagnostics`.
 *
 * This package shares no geometry, no projection math and no distortion model
 * with `packages/sim`. That is enforced by `tools/boundary-lint.ts` and argued
 * at length in both READMEs; the short version is that a solver which imported
 * the simulator's projection code would be inverting the simulator's own
 * arithmetic, and every recovery score the bench produced would be a tautology.
 *
 * What the solver is allowed to know (packages/solver/README.md):
 *   - the PARAMETERS.md nominals, as initialisation only (§2);
 *   - the sphere radius, class DOC;
 *   - the operator's camera intrinsics;
 *   - optionally, one or more tape-measure heights above the floor, without
 *     which `h_center` is not observable at all — see bundle.ts.
 *
 * What it is not allowed to know: the ground-truth calibration that generated
 * its input images, and anything whatsoever from `packages/sim`.
 */

import type {
  RigCalibration,
  SolveDiagnostics,
  SolveResult,
  Vec3,
} from '../../calibration/src/index.ts';
import { PARAMETER_TABLE } from '../../calibration/src/parameters.ts';
import {
  type Correspondence,
  type DecodeOptions,
  type DecodeStats,
  type PatternCapture,
  decodeAll,
  emptyStats,
} from './decode.ts';
import {
  DEFAULT_BUNDLE_OPTIONS,
  DEFAULT_FREE_FLAGS,
  DEFAULT_GAUGE_OPTIONS,
  PROJ_SLOT_FOV,
  PROJ_SLOT_SHIFT_H,
  PROJ_SLOT_SHIFT_V,
  type BundleOptions,
  type BundleState,
  type FloorReference,
  type ParameterPrior,
  runBundle,
  slotProjector,
} from './bundle.ts';
import { DEFAULT_INIT_OPTIONS, bootstrap, type InitOptions } from './initialize.ts';
import { DEFAULT_ROBUST_OPTIONS } from './robust.ts';
import type { CameraIntrinsics, CameraModel } from './sphere.ts';
import { aimEuler, type ProjectorModel } from './project.ts';

export type {
  Correspondence,
  DecodeOptions,
  DecodeStats,
  GraySequence,
  LinearImage,
  PatternCapture,
  PhaseSequence,
} from './decode.ts';
export type { CameraIntrinsics, CameraModel } from './sphere.ts';
export type { ProjectorModel } from './project.ts';
export type {
  BundleOptions,
  BundleState,
  BundleReport,
  FloorReference,
  ParameterPrior,
} from './bundle.ts';
export type { InitOptions, BootstrapReport } from './initialize.ts';
export type { RobustOptions, LossKind } from './robust.ts';

/**
 * The operator's camera: a calibration they already have, and a rough idea of
 * where the tripod stood.
 *
 * The pose is initialisation only, in exactly the sense PARAMETERS.md §2 uses
 * the word. It needs to be right about which side of the sphere the camera was
 * on; it does not need to be right about the distance, which the bootstrap
 * corrects from the images.
 */
export interface SolverCameraInput {
  intrinsics: CameraIntrinsics;
  position: Vec3;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

/**
 * How tightly the documented nominals constrain the parameters PARAMETERS.md
 * classes SOLVE but derives from something it classes CFG.
 *
 * The mechanism exists because PARAMETERS.md asks for it by name — §2 says to
 * treat `d_proj` as `SOLVE` "with a wide prior (5.0-6.5 m)", and §3.1 classes
 * `fov_h` as SOLVE while classing the throw ratio it is derived from as CFG,
 * "read from a hardware spec sheet, known per install". A site that has read its
 * own spec sheet should pass `fovHDeg` to `nominalRig` and a small sigma here.
 *
 * **Every default is 0, i.e. off, and that is a measured decision rather than
 * caution.** The field-of-view/distance valley is real: with `fovHDeg` held, the
 * scenarios whose decode carries a motion bias improve by a factor of three to
 * eight. But a prior does not reproduce that, at any width. Swept over
 * 0.5, 1, 2, 3 and 4 degrees on the twelve-scenario corpus, the worst-case pose
 * position error moved from 639.6 mm to 622.1 mm — under 3% — and the median
 * barely at all.
 *
 * The reason is that the failure along the valley is BIAS, not variance. With
 * ten thousand correspondences the formal one-sigma on `fovHDeg` is about
 * 0.15 degrees, while the recovered field is 2.5 to 4.9 degrees away from truth:
 * a twenty-sigma error. A prior at any width a spec sheet could justify is two
 * orders of magnitude weaker than the (wrong) data and is simply outvoted.
 * Holding the field works only because it is an infinitely tight prior at a
 * value that happens to be closer to truth than the fit is — and holding it
 * would encode one side of §2's unresolved `d_proj` conflict, which costs
 * `long-throw` a factor of 1.6 (501 mm -> 794 mm) when the site really is at the
 * floor plan's end of that conflict.
 *
 * So the honest statement is: this degeneracy is not closed by regularisation.
 * It is closed by knowing the lens, which is what PARAMETERS.md §8 item 2 asks
 * the ground-truth visit to write down. See docs/AMENDMENTS.md A-13.
 */
export interface SolvePriorOptions {
  /** One-sigma prior on each projector's `fovHDeg`, degrees. 0 = no prior. */
  fovHDegSigma: number;
  /**
   * One-sigma prior on each projector's lens shift, in §I's units (a fraction
   * of the half-image). 0 = no prior, which is the default and is deliberate.
   *
   * Lens shift is the OTHER near-degeneracy in this geometry and it is the one
   * that decides the pose-rotation gate. At a 33-degree field a shift of 0.01 —
   * ten pixels of principal point on a 1920 raster — is worth 0.17 degrees of
   * yaw, and the two are separated only by the second-order difference between
   * translating a principal point and rotating a lens. Measured on this corpus:
   * holding `shiftH`/`shiftV` at §3.1's nominal of zero drops the worst rotation
   * error from 6.29 degrees to 0.30 and the pitch component with it.
   *
   * It is off by default because PARAMETERS.md gives lens shift a nominal (0)
   * and a class (SOLVE) but no uncertainty, and any sigma chosen here would be
   * invented — and would then be the number that decides whether §7's rotation
   * gate passes. That is a decision for the spec, not for the solver. Filed as
   * docs/AMENDMENTS.md A-12 with the measurement.
   */
  shiftSigma: number;
}

export const DEFAULT_PRIOR_OPTIONS: SolvePriorOptions = {
  fovHDegSigma: 0,
  shiftSigma: 0,
};

export interface SolveOptions {
  decode: Partial<DecodeOptions>;
  init: Partial<InitOptions>;
  bundle: Partial<BundleOptions>;
  priors: Partial<SolvePriorOptions>;
  /** Propagated to the bootstrap RANSAC. Every run with the same seed is identical. */
  seed: number;
}

export interface SolveInput {
  /**
   * PARAMETERS.md nominals, as a `RigCalibration`. Every geometric field is an
   * initialisation; the photometric fields (`transfer`, `blend`) and the
   * sphere's `rotationOffsetDeg` are passed through untouched, because nothing
   * in a structured-light capture observes them.
   */
  nominal: RigCalibration;
  cameras: SolverCameraInput[];
  /** Raw captures. Supply these or `correspondences`, not both. */
  captures?: readonly PatternCapture[];
  /** Pre-decoded correspondences, for callers that decoded elsewhere. */
  correspondences?: readonly Correspondence[];
  /** Without at least one of these, `h_center` is held at its nominal. */
  floorReferences?: readonly FloorReference[];
  options?: Partial<SolveOptions>;
}

export interface SolverExtraDiagnostics {
  decode: DecodeStats;
  /** The `d_proj` the bootstrap sweep selected, metres. PARAMETERS.md §2. */
  bootstrapDistanceM: number;
  bootstrapProjectorSource: ('nominal' | 'footprint' | 'dlt')[];
  /** Why the optimiser stopped. `maxIterations` or `lambda` means it did not converge. */
  stopReason: string;
  /** Gauge constraints applied. 3 unless the floor references made tilt observable. */
  gaugeConstraints: number;
  /**
   * Per world axis (X, Y, Z): true where the global rotation was unobservable
   * and had to be fixed by convention rather than measured. Anyone scoring pose
   * recovery against PARAMETERS.md §7 must align frames along these axes first.
   */
  gaugeFreeAxes: boolean[];
  /** True when `h_center` was actually solved rather than held at its nominal. */
  centerHeightObserved: boolean;
  /**
   * Each parameter prior and how far the solution sits from it, in units of that
   * prior's own sigma. Reported so a prior doing the work of the data is
   * visible: a residual near zero means the prior decided the parameter, and a
   * residual past two sigma means the data overruled it.
   */
  priorResiduals: { name: string; sigmas: number }[];
  /**
   * Per camera, how many times worse its residuals were than its decode claimed.
   * 1.0 means the decode's uncertainty model was right for that camera; 3 means
   * two thirds of its error is something the decoder cannot see from inside one
   * frame set, which in a handheld capture is the camera having moved.
   */
  cameraResidualScale: number[];
  /**
   * Recovered camera poses.
   *
   * Not part of `RigCalibration` — the boundary object describes the rig, not
   * the metrology that measured it — but genuinely useful output: it says where
   * each photograph was taken from, which is what an operator needs in order to
   * repeat a capture, and what a bench needs in order to score the camera half
   * of the adjustment.
   */
  cameras: CameraModel[];
}

export interface SolverResult extends SolveResult {
  extra: SolverExtraDiagnostics;
}

// ---------------------------------------------------------------------------
// Boundary object <-> internal state
// ---------------------------------------------------------------------------

/**
 * Boundary object plus camera inputs -> the flat internal state.
 *
 * Exported because the bench and the tests both need to build a state from a
 * `RigCalibration` without going through a full solve, and because a second
 * hand-written copy of this mapping is a second place for a field to be
 * forgotten.
 */
export function bundleStateFromCalibration(
  nominal: RigCalibration,
  cameras: readonly SolverCameraInput[],
): BundleState {
  const projectors: ProjectorModel[] = nominal.projectors.map((p) => ({
    id: p.id,
    position: { ...p.pose.position },
    yawDeg: p.pose.yawDeg,
    pitchDeg: p.pose.pitchDeg,
    rollDeg: p.pose.rollDeg,
    resX: p.intrinsics.resX,
    resY: p.intrinsics.resY,
    pixelAspect: p.intrinsics.pixelAspect,
    fovHDeg: p.intrinsics.fovHDeg,
    shiftH: p.intrinsics.shiftH,
    shiftV: p.intrinsics.shiftV,
    k1: p.intrinsics.k1,
    k2: p.intrinsics.k2,
    p1: p.intrinsics.p1,
    p2: p.intrinsics.p2,
  }));
  const cams: CameraModel[] = cameras.map((c) => ({
    position: { ...c.position },
    yawDeg: c.yawDeg,
    pitchDeg: c.pitchDeg,
    rollDeg: c.rollDeg,
    intrinsics: { ...c.intrinsics },
    focalScale: 1,
  }));
  return {
    radiusM: nominal.sphere.radiusM,
    centerHeightM: nominal.sphere.centerHeightM,
    projectors,
    cameras: cams,
  };
}

/**
 * Rebuild the boundary object from a solved state.
 *
 * Everything the solver did not observe is copied from the nominal rather than
 * defaulted. That includes the whole photometric transfer (PARAMETERS.md §3.2,
 * class ASSUME/MEAS), the blend configuration (§4.5), the viewports (§3.4) and
 * the sphere's mechanical `rotationOffsetDeg` — which structured light cannot
 * see, because no pattern references the sphere's texture. Silently emitting a
 * default for any of those would let a solver's output look complete while
 * having quietly discarded the caller's configuration.
 */
function calibrationFromState(state: BundleState, nominal: RigCalibration): RigCalibration {
  return {
    schema: 'sphere-sim/rig-calibration@2',
    sphere: {
      radiusM: state.radiusM,
      centerHeightM: state.centerHeightM,
      rotationOffsetDeg: nominal.sphere.rotationOffsetDeg,
    },
    blend: { ...nominal.blend },
    framebuffer: { ...nominal.framebuffer },
    projectors: state.projectors.map((p, i) => {
      const src = nominal.projectors[i];
      return {
        id: p.id,
        pose: {
          position: { ...p.position },
          yawDeg: p.yawDeg,
          pitchDeg: p.pitchDeg,
          rollDeg: p.rollDeg,
        },
        intrinsics: {
          resX: p.resX,
          resY: p.resY,
          fovHDeg: p.fovHDeg,
          pixelAspect: p.pixelAspect,
          shiftH: p.shiftH,
          shiftV: p.shiftV,
          k1: p.k1,
          k2: p.k2,
          p1: p.p1,
          p2: p.p2,
        },
        transfer: {
          gamma: { ...src.transfer.gamma },
          blackFloor: { ...src.transfer.blackFloor },
          gain: { ...src.transfer.gain },
          whitePointK: src.transfer.whitePointK,
        },
        viewport: { ...src.viewport },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------

export function solve(input: SolveInput): SolverResult {
  const opts: SolveOptions = {
    decode: input.options?.decode ?? {},
    init: input.options?.init ?? {},
    bundle: input.options?.bundle ?? {},
    priors: input.options?.priors ?? {},
    seed: input.options?.seed ?? DEFAULT_INIT_OPTIONS.seed,
  };
  const priorOpts: SolvePriorOptions = { ...DEFAULT_PRIOR_OPTIONS, ...opts.priors };

  let correspondences: readonly Correspondence[];
  let decodeStats: DecodeStats;
  if (input.correspondences) {
    correspondences = input.correspondences;
    decodeStats = emptyStats();
    decodeStats.accepted = correspondences.length;
    decodeStats.considered = correspondences.length;
  } else if (input.captures) {
    const decoded = decodeAll(input.captures, opts.decode);
    correspondences = decoded.correspondences;
    decodeStats = decoded.stats;
  } else {
    throw new Error('solve: supply either `captures` or `correspondences`');
  }

  const floor = input.floorReferences ?? [];
  const nominalState = bundleStateFromCalibration(input.nominal, input.cameras);

  // h_center is observable only through a floor reference. With none supplied
  // it is held at the documented 2.1844 m rather than being handed to the
  // optimiser as a free parameter it cannot possibly determine — a free
  // parameter with no observation does not stay put, it wanders wherever the
  // damping lets it and then gets reported as if it had been measured.
  const centerHeightObserved = floor.length > 0;

  const bundleOptions: Partial<BundleOptions> = {
    ...DEFAULT_BUNDLE_OPTIONS,
    ...opts.bundle,
    free: {
      ...DEFAULT_FREE_FLAGS,
      ...(opts.bundle.free ?? {}),
      centerHeight: centerHeightObserved && (opts.bundle.free?.centerHeight ?? true),
    },
    gauge: { ...DEFAULT_GAUGE_OPTIONS, ...(opts.bundle.gauge ?? {}) },
    loss: { ...DEFAULT_ROBUST_OPTIONS, ...(opts.bundle.loss ?? {}) },
  };

  // Centred on the NOMINAL field of view, never on the bootstrap's own estimate.
  // A prior centred on an estimate derived from the same data is not a prior, it
  // is the fit talking to itself, and it would suppress the valley without
  // adding a single bit of outside information.
  const priors: ParameterPrior[] = [];
  for (let i = 0; i < nominalState.projectors.length; i++) {
    const p = nominalState.projectors[i];
    if (priorOpts.fovHDegSigma > 0) {
      priors.push({
        slot: slotProjector(i, PROJ_SLOT_FOV),
        mean: p.fovHDeg,
        sigma: priorOpts.fovHDegSigma,
        name: `${p.id}.fovH`,
      });
    }
    if (priorOpts.shiftSigma > 0) {
      priors.push({
        slot: slotProjector(i, PROJ_SLOT_SHIFT_H),
        mean: p.shiftH,
        sigma: priorOpts.shiftSigma,
        name: `${p.id}.shiftH`,
      });
      priors.push({
        slot: slotProjector(i, PROJ_SLOT_SHIFT_V),
        mean: p.shiftV,
        sigma: priorOpts.shiftSigma,
        name: `${p.id}.shiftV`,
      });
    }
  }

  const boot = bootstrap(
    nominalState,
    correspondences,
    floor,
    { ...opts.init, seed: opts.seed },
    bundleOptions,
    priors,
  );

  // The nominal is the gauge anchor: PARAMETERS.md §2 describes the rig's
  // azimuths and heights, and that description is the only external statement
  // available about the three rotational degrees of freedom structured light
  // cannot see. See the gauge section of bundle.ts.
  const report = runBundle(
    boot.state,
    correspondences,
    floor,
    bundleOptions,
    nominalState,
    priors,
  );

  const diagnostics: SolveDiagnostics = {
    rmsResidualPx: report.rmsResidualPx,
    perProjectorRmsPx: report.perProjectorRmsPx,
    correspondencesUsed: report.used,
    correspondencesRejected: report.rejected,
    iterations: report.iterations,
    converged: report.converged,
    recoveredCenterHeightM: report.state.centerHeightM,
    residuals: report.residuals,
  };

  return {
    calibration: calibrationFromState(report.state, input.nominal),
    diagnostics,
    extra: {
      decode: decodeStats,
      bootstrapDistanceM: boot.selectedDistanceM,
      bootstrapProjectorSource: boot.projectorSource,
      stopReason: report.stopReason,
      gaugeConstraints: report.gaugeConstraints,
      gaugeFreeAxes: report.gaugeFreeAxes,
      centerHeightObserved,
      priorResiduals: report.priorResiduals,
      cameraResidualScale: report.cameraResidualScale,
      cameras: report.state.cameras,
    },
  };
}

/** Convenience wrapper for callers that already have correspondences. */
export function solveFromCorrespondences(
  nominal: RigCalibration,
  cameras: SolverCameraInput[],
  correspondences: readonly Correspondence[],
  floorReferences: readonly FloorReference[] = [],
  options: Partial<SolveOptions> = {},
): SolverResult {
  return solve({ nominal, cameras, correspondences, floorReferences, options });
}

// ---------------------------------------------------------------------------
// Nominal rig construction
// ---------------------------------------------------------------------------

export interface NominalRigOptions {
  projectorCount: number;
  resX: number;
  resY: number;
  /** Overrides the A-01 derivation below when the projector's spec sheet is known. */
  fovHDeg?: number;
  distanceM?: number;
  /** Projector lens height above the floor, metres. PARAMETERS.md §2. */
  projectorHeightM?: number;
  centerHeightM?: number;
  radiusM?: number;
  rotationOffsetDeg?: number;
}

/**
 * Build a nominal `RigCalibration` from the PARAMETERS.md table.
 *
 * Initialisation only — PARAMETERS.md §2 is explicit that all six pose DOF are
 * SOLVE and that "nominals exist to initialize the solver". Nothing here is a
 * claim about a real installation.
 *
 * The one judgement call is `fovHDeg`. §3.1 gives `T ~ 3.0:1` and `fov_h ~ 18.9
 * deg`, derived from "image width ~ sphere diameter at d_proj". AMENDMENTS.md
 * A-01 shows that reading cannot be right: the sphere's angular diameter from
 * 5.18 m is 19.2 deg, so an 18.9 deg horizontal field barely fails to contain
 * the silhouette, and the vertical field of a 16:9 raster would be 10.7 deg —
 * a projector so configured could not light anything above latitude 33 deg,
 * while §4.3 requires coverage to 80.4 deg. A-01 concludes the silhouette is
 * inscribed in the raster's MINOR dimension, and reports that the ~51%
 * off-sphere floor of §7 matches that construction on a 16:10 raster almost
 * exactly.
 *
 * So the default here follows A-01: the vertical field subtends the sphere,
 * `fovV = 2*asin(R/d)`, and the horizontal field follows from the aspect ratio.
 * Since `T` is class CFG — "read from a hardware spec sheet", known per install
 * — a caller who has the spec sheet should pass `fovHDeg` and skip the
 * derivation entirely. A wrong nominal costs iterations, not correctness (§10),
 * but only if it is close enough to keep the bootstrap in its basin, and a
 * factor-of-two error in field of view is not.
 */
export function nominalRig(options: Partial<NominalRigOptions> = {}): RigCalibration {
  const projectorCount = options.projectorCount ?? 4;
  const resX = options.resX ?? 1920;
  const resY = options.resY ?? 1080;
  const radiusM = options.radiusM ?? PARAMETER_TABLE.R.nominal;
  const centerHeightM = options.centerHeightM ?? PARAMETER_TABLE.h_center.nominal;
  const distanceM = options.distanceM ?? PARAMETER_TABLE.d_proj.nominal;
  const projectorHeightM = options.projectorHeightM ?? PARAMETER_TABLE.h_proj.nominal;

  const fovVRad = 2 * Math.asin(Math.min(0.999, radiusM / distanceM));
  const derivedFovH =
    (2 * Math.atan(Math.tan(fovVRad / 2) * (resX / resY)) * 180) / Math.PI;
  const fovHDeg = options.fovHDeg ?? derivedFovH;

  // §W puts the world origin at the sphere centre and the floor at z = -h_center,
  // so a lens h_proj above the floor sits at z = h_proj - h_center.
  const lensZ = projectorHeightM - centerHeightM;
  const horizontal = Math.sqrt(Math.max(0, distanceM * distanceM - lensZ * lensZ));

  // §V: quadrant viewports of the single shared framebuffer, origin bottom-left,
  // matching `set projectorInfo(viewport) { 0,0,0.5,0.5 ... }` in PARAMETERS.md §3.4.
  const quadrants = [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ];

  const projectors = [];
  for (let i = 0; i < projectorCount; i++) {
    const phi = (2 * Math.PI * i) / projectorCount;
    const position = {
      x: horizontal * Math.cos(phi),
      y: horizontal * Math.sin(phi),
      z: lensZ,
    };
    const e = aimEuler(position, { x: 0, y: 0, z: 0 }, 0);
    projectors.push({
      id: `P${i + 1}`,
      pose: { position, yawDeg: e.yawDeg, pitchDeg: e.pitchDeg, rollDeg: 0 },
      intrinsics: {
        resX,
        resY,
        fovHDeg,
        pixelAspect: 1.0,
        shiftH: 0,
        shiftV: 0,
        k1: 0,
        k2: 0,
        p1: 0,
        p2: 0,
      },
      transfer: {
        gamma: {
          r: PARAMETER_TABLE.gamma_R.nominal,
          g: PARAMETER_TABLE.gamma_G.nominal,
          b: PARAMETER_TABLE.gamma_B.nominal,
        },
        blackFloor: {
          r: PARAMETER_TABLE.L_black_R.nominal,
          g: PARAMETER_TABLE.L_black_G.nominal,
          b: PARAMETER_TABLE.L_black_B.nominal,
        },
        gain: {
          r: PARAMETER_TABLE.g_R.nominal,
          g: PARAMETER_TABLE.g_G.nominal,
          b: PARAMETER_TABLE.g_B.nominal,
        },
        whitePointK: PARAMETER_TABLE.wp.nominal,
      },
      viewport: quadrants[i % 4],
    });
  }

  return {
    schema: 'sphere-sim/rig-calibration@2',
    sphere: {
      radiusM,
      centerHeightM,
      rotationOffsetDeg: options.rotationOffsetDeg ?? PARAMETER_TABLE.theta_rot.nominal,
    },
    blend: {
      rampShape: 'cosine',
      widthDeg: PARAMETER_TABLE.w_width.nominal,
      rampGamma: PARAMETER_TABLE.gamma_blend.nominal,
      maskLoDeg: PARAMETER_TABLE.mask_lo.nominal,
      maskHiDeg: PARAMETER_TABLE.mask_hi.nominal,
      bottomOnly: true,
    },
    framebuffer: { width: resX * 2, height: resY * 2 },
    projectors,
  };
}

export { decodeAll, decodeCapture } from './decode.ts';
export { bootstrap } from './initialize.ts';
export {
  runBundle,
  levenbergMarquardt,
  buildProblem,
  evaluate,
  gaugeNullSpace,
  alignGaugeToReference,
  buildLayout,
} from './bundle.ts';
export { createRng } from './linalg.ts';
