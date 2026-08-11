/**
 * Levenberg-Marquardt bundle adjustment over projector poses, projector
 * interior orientation, camera poses, and the global floor-to-sphere-centre
 * distance.
 *
 * The residual, once, in words: take a decoded correspondence; turn its camera
 * pixel into a world ray; intersect that ray with the sphere of known radius
 * centred at the world origin; project the surface point into the projector
 * with the solver's own §R/§I/§D implementation; subtract the projector pixel
 * the structured light actually decoded there. The error is in PROJECTOR
 * pixels, which is the unit the operator's mental model works in and the unit
 * the progress page plots.
 *
 * ---------------------------------------------------------------------------
 * GAUGE FREEDOM — what is free, what was chosen, and why.
 *
 * conventions.ts §W fixes the world origin at the sphere centre and
 * PARAMETERS.md §1 fixes the radius (class DOC). Between them, translation and
 * scale are pinned: a rig translated relative to the sphere produces different
 * ray-sphere intersections, and a rescaled one contradicts the known radius. So
 * three of the usual seven similarity degrees of freedom are already gone.
 *
 * What remains is rotation. Rotate every projector and every camera about the
 * sphere centre by the same rotation and every single correspondence residual
 * is unchanged, because the sphere is rotationally symmetric and no
 * correspondence references the sphere's texture. Three degrees of freedom,
 * exactly unobservable, and they make the normal equations singular.
 *
 * This is not a numerical inconvenience to be damped away — it is a real
 * statement about what structured light can and cannot measure. §W's `+X toward
 * the canonical prime meridian` is defined by where the sphere's imagery is
 * painted, and no amount of projected Gray code can see that.
 *
 * The treatment here has two halves, and they do different jobs.
 *
 * **During the solve — a minimal-constraint (inner-constraint) gauge.** Each LM
 * step is penalised along the global-rotation null space, computed from the
 * current state. This keeps the normal equations non-singular without touching
 * anything the data determines: along an exactly null direction the data
 * contributes zero curvature, so the penalty decides a question the data never
 * asked. `gauge.mode = 'anchorProjector'` is available as the cruder
 * alternative — it holds one projector's three rotation DOF outright, which
 * works but dumps that projector's own error onto every other pose.
 *
 * **How many directions are actually null depends on the floor references, and
 * the code measures rather than assumes.** With none or one, all three
 * rotations are free: tilting the rig about X or Y changes the measured
 * entity's height and `h_center` shifts to absorb it exactly, so the null
 * direction carries a matching `h_center` component (computed below as a
 * least-squares compensation). With three or more non-collinear references no
 * single `h_center` can absorb a tilt; tilt becomes genuinely observable, the
 * candidate direction acquires real stiffness, and `gauge.nullTolerance`
 * detects that and leaves it alone. This is exactly why PARAMETERS.md §8 item 1
 * asks for "floor to each projector lens" rather than one height — four floor
 * measurements are what turn `h_center` from gauge-contaminated into measured.
 *
 * **After the solve — re-expression in the nominal frame.** A global rotation
 * changes no residual by a single ULP, so which member of the equivalent family
 * gets reported is a reporting decision, not a fitting one.
 * `alignGaugeToReference` makes it deliberately: rotate the solution, along the
 * free directions only, so its projector layout best matches PARAMETERS.md §2's
 * description of the rig. Without this the reported frame is wherever the
 * bootstrap landed, which is typically a couple of degrees out.
 *
 * **What no gauge can fix.** The anchor is only as good as the nominal layout,
 * and a rig with ±3 cm of real position scatter pins the frame to roughly a
 * tenth of a degree. The §7 pose-recovery gate of 0.05 degrees therefore cannot
 * be scored in absolute world-frame terms by anyone — the bench must align
 * frames against its own ground truth before measuring rotation, which is the
 * standard treatment for a free-network adjustment. A bench that skips that
 * step is measuring the gauge, not the calibration.
 * ---------------------------------------------------------------------------
 */

import type { ResidualSample } from '../../calibration/src/index.ts';
import type { Correspondence } from './decode.ts';
import {
  type Mat3,
  type Vec3,
  mat3Multiply,
  mat3MulVec,
  kabschRotation,
  median,
  solveSymmetric,
} from './linalg.ts';
import {
  PROJ_PARAM_COUNT,
  PROJ_PITCH,
  PROJ_PZ,
  PROJ_ROLL,
  PROJ_YAW,
  PROJ_FOV,
  PROJ_K1,
  PROJ_K2,
  PROJ_P1,
  PROJ_P2,
  PROJ_PX,
  PROJ_PY,
  PROJ_SHIFT_H,
  PROJ_SHIFT_V,
  eulerFromMatrix,
  frameAxes,
  projectPointJacobian,
  projectPointWithAxes,
  rotationMatrix,
  rotationWithDerivatives,
  type FrameAxes,
  type ProjectorModel,
  type RotationWithDerivatives,
} from './project.ts';
import {
  CAM_FOCAL,
  CAM_PARAM_COUNT,
  CAM_PITCH,
  CAM_PX,
  CAM_PY,
  CAM_PZ,
  CAM_ROLL,
  CAM_YAW,
  type CameraModel,
  cameraPixelToNormalized,
  intersectSphere,
  intersectSphereJacobian,
  rayFromNormalized,
} from './sphere.ts';
import {
  DEFAULT_ROBUST_OPTIONS,
  lossAndWeight,
  rejectOutliers,
  robustScaleFromNorms,
  type RobustOptions,
} from './robust.ts';

/** Everything the bundle optimises, plus the constants it needs. */
export interface BundleState {
  /** Sphere radius, metres. PARAMETERS.md §1, class DOC — held, never solved. */
  radiusM: number;
  /** Floor to sphere centre, metres. Free when a floor reference is supplied. */
  centerHeightM: number;
  projectors: ProjectorModel[];
  cameras: CameraModel[];
}

/**
 * A tape-measure height, and the only thing that makes `h_center` observable.
 *
 * PARAMETERS.md §1 explains the stakes: NOAA's documented remedy for diverging
 * polar grid lines is to add or subtract an inch of ground-to-sphere-centre in
 * the config and re-run alignment. Nothing in a structured-light capture sees
 * the floor, so recovering `h_center` needs one measurement that does — the
 * height of a tripod head or of a projector lens above the floor.
 *
 * The improvement over the existing procedure is not that we avoid a tape
 * measure. It is that this one is easy to take accurately (floor to a lens you
 * can touch) whereas theirs is not (floor to the centre of a suspended sphere
 * you cannot), and that the bundle propagates it through geometry that is
 * pinned to sub-millimetre rather than through a trial-and-error loop.
 */
export interface FloorReference {
  kind: 'camera' | 'projector';
  index: number;
  /** Measured height of that entity above the floor, metres. */
  heightM: number;
  /** One-sigma uncertainty of the measurement, metres. */
  sigmaM: number;
}

/**
 * A Gaussian prior on one free parameter, in that parameter's own units.
 *
 * This is the honest middle ground between `free` and held, and PARAMETERS.md
 * asks for it by name: §2 says to treat `d_proj` as `SOLVE` "with a wide prior
 * (5.0-6.5 m)", and §3.1 classes `fov_h` as `SOLVE` while classing the throw
 * ratio it is derived from as `CFG` — read from a spec sheet. Holding such a
 * parameter contradicts its class and destroys any site that disagrees with the
 * nominal; freeing it entirely throws away a real measurement and lets decode
 * noise slide along a degenerate valley. A prior states what is known and how
 * well, and lets the data overrule it when the data actually can.
 *
 * The residual is `(value - mean) / sigma`, added to the objective exactly like
 * a floor reference, so a prior competes with the correspondences on the same
 * standardised footing. Priors are reported in `BundleReport.priorResiduals` so
 * a prior that is doing all the work is visible rather than implied.
 */
export interface ParameterPrior {
  /** Parameter slot, from `slotProjector` / `slotCamera` / `layout.slotCenterHeight`. */
  slot: number;
  /** Prior mean, in the parameter's own units. */
  mean: number;
  /** One-sigma width. Must be positive; a zero-width prior is a hold, not a prior. */
  sigma: number;
  /** Human-readable, for the diagnostics. */
  name: string;
}

export interface BundleFreeFlags {
  projectorPose: boolean;
  projectorFov: boolean;
  projectorShift: boolean;
  /** k1, k2 — what SOS's manual "Vertex Tweaking" stage compensates by hand (§3.1). */
  projectorRadial: boolean;
  /**
   * p1, p2. OFF by default and that is a spec requirement, not a preference:
   * PARAMETERS.md §3.1 classes them ASSUME and says to hold them at zero unless
   * residuals demand otherwise, because the extra degrees of freedom overfit.
   */
  projectorTangential: boolean;
  cameraPose: boolean;
  /** Off by default: the operator calibrated their camera, so believe them. */
  cameraFocal: boolean;
  centerHeight: boolean;
}

export const DEFAULT_FREE_FLAGS: BundleFreeFlags = {
  projectorPose: true,
  projectorFov: true,
  projectorShift: true,
  projectorRadial: true,
  projectorTangential: false,
  cameraPose: true,
  cameraFocal: false,
  centerHeight: true,
};

export interface GaugeOptions {
  mode: 'inner' | 'anchorProjector' | 'none';
  anchorProjectorIndex: number;
  /**
   * Gauge stiffness relative to the mean diagonal of the data normal matrix.
   *
   * Along a genuinely null direction the data contributes nothing, so any
   * positive value pins it; the size only matters for directions that are
   * nearly-but-not-quite null. 1.0 makes the gauge about as stiff as a typical
   * well-observed parameter, which is stiff enough to regularise and soft
   * enough that a direction carrying real information still moves.
   */
  strength: number;
  /**
   * A candidate direction counts as null when its coupling to the floor
   * observations — the cosine defined in `floorCoupling` — falls below this.
   *
   * This is not defensive coding, it is the physics. How many of the three
   * global rotations are actually free depends on how many floor heights were
   * measured. With none or one, all three are free: rotating the rig about X or
   * Y changes the measured entity's height, and `h_center` shifts to absorb it
   * exactly. With three or more non-collinear references no single `h_center`
   * can absorb a tilt, so tilt becomes genuinely observable — which is the whole
   * reason PARAMETERS.md §8 item 1 asks for "floor to each projector lens"
   * rather than one height. Constraining a direction the data has just
   * determined would throw that measurement away, so the gauge measures each
   * candidate before pinning it.
   */
  nullTolerance: number;
}

export const DEFAULT_GAUGE_OPTIONS: GaugeOptions = {
  mode: 'inner',
  anchorProjectorIndex: 0,
  strength: 1.0,
  nullTolerance: 1e-9,
};

export interface BundleOptions {
  free: BundleFreeFlags;
  gauge: GaugeOptions;
  loss: RobustOptions;
  maxIterations: number;
  initialLambda: number;
  lambdaUp: number;
  lambdaDown: number;
  maxLambda: number;
  /**
   * Convergence tolerances. All three are checked; meeting any one on an
   * accepted step stops the loop, and only then is `converged` true.
   *
   *  - `costTol`   relative decrease in the robust cost.
   *  - `stepTol`   the step's predicted motion, in projector pixels: the step
   *                component times the square root of that parameter's own
   *                normal-matrix diagonal. Expressing the step test in pixels
   *                rather than in parameter units is what stops a metre and a
   *                degree competing on equal footing.
   *  - `gradTol`   the same scaling applied to the gradient, so it too reads as
   *                pixels of available improvement.
   */
  costTol: number;
  stepTol: number;
  gradTol: number;
  /**
   * Hard ceiling on trial evaluations, accepted or not. Separate from
   * `maxIterations` so a long line search cannot eat the step budget, and so a
   * pathological problem still terminates.
   */
  maxEvaluations: number;
  /** Rejection passes after the first fit. 0 = fit once and report. */
  rejectionPasses: number;
  /**
   * Re-estimate a per-camera variance component between passes. See
   * `estimateVarianceComponents`.
   */
  varianceComponents: boolean;
  /**
   * Solve ONE horizontal field of view shared by every projector, instead of one
   * per projector.
   *
   * This is a statement about the hardware, not a regularisation trick.
   * PARAMETERS.md §3.1 derives `fov_h` from the throw ratio `T` and classes `T`
   * as `CFG` — "read from a hardware spec sheet, known per install". A site runs
   * four projectors of one model at one zoom setting, so there is one throw
   * ratio and therefore one field of view; four independent `fov_h` values model
   * a site that bought four different lenses. Tying them costs three degrees of
   * freedom and buys nothing when the decode is clean — the four estimates agree
   * anyway — and matters exactly when the decode carries a bias, because a bias
   * that differs between projectors otherwise drives the four fields apart, and
   * a *differential* field-of-view error is what a seam metric sees.
   *
   * Off by default: the tie is a claim about the install, and §3.1 does not say
   * a rig cannot mix lenses. `packages/bench` turns it on per scenario so the
   * consequence is measured rather than assumed.
   */
  tieProjectorFov: boolean;
  /** Detect residual coherence within a (camera, projector) pair. See `PairCoherenceOptions`. */
  pairCoherence: PairCoherenceOptions;
}

/**
 * Telling a pair whose residuals are BIASED from one whose residuals are NOISY.
 *
 * `decode.ts` pools its intensity-noise estimate over tens of thousands of
 * pixels, which fixed a real defect — the per-pixel estimate was a
 * one-degree-of-freedom draw and therefore worthless as a weight — and created a
 * new liability. A pooled sigma is a statement about the SENSOR. It says nothing
 * about error the decoder is structurally blind to, and under handheld motion
 * that error dominates: measured against ground truth on this bench, the decode
 * error of a moving camera is 4-8 projector pixels against 0.2-0.4 static, and
 * 58-87% of its energy per (camera, projector) pair is a single affine field —
 * a 3 to 11 pixel translation plus a scale term of order 1%. A confident pooled
 * sigma hands all of that the weight of independent noise.
 *
 * The discriminator is that **bias is coherent within a pair and noise is not**,
 * and it needs no new capture. Partition a pair's residuals into a grid over the
 * projector raster and compare each cell's MEAN against what independent noise
 * of the decode's own stated sigma allows. Under the null a cell of `n` samples
 * has mean variance `1/n` per axis, so `sum_k n_k * |m_k|^2` has expectation
 * `2K` for `K` cells and standard deviation `2*sqrt(K)`; anything above that is
 * variance the decode did not report.
 *
 * **Two apparatus signatures must not fire it, and neither can.** The residual
 * cloud is stretched along `u` by the raster aspect ratio, because `patterns.ts`
 * counts Gray planes once and spends them on both axes — that is a VARIANCE
 * property, and standardising each axis by its own decode sigma removes it. The
 * decode also quantises `u` and `v` independently, so its residual lies on an
 * axis-aligned lattice — that is zero-mean inside a cell and does not move a
 * cell mean. A statistic built on cell means is blind to both by construction.
 *
 * **The response is a weight, not a subtraction.** A per-pair offset could be
 * estimated and removed, and that would be a mistake: a genuine projector pose
 * error also shifts a pair's residual mean, so removing the offset would delete
 * the evidence for the error the solve exists to find. Inflating the pair's
 * sigma instead leaves the offset in the objective and only says how much to
 * believe it.
 *
 * **How much to inflate.** Not by the size of the bias — that would be a second
 * variance component and the per-camera one already carries it. By the LOSS OF
 * INDEPENDENCE, which is what coherence actually costs: for a field with
 * intraclass correlation `rho` in clusters of `nbar` samples, the classic design
 * effect is `1 + (nbar - 1) * rho`, and a pair carrying it is worth `n / deff`
 * independent observations rather than `n`. Scaling sigma by `sqrt(deff)` is
 * exactly that correction. It is a no-op when the residuals are incoherent,
 * which is the tripod case, so a scenario that passes today cannot regress
 * through this path.
 */
export interface PairCoherenceOptions {
  /**
   * `off` disables the estimate entirely.
   *
   * `raw` uses a pair's own coherence. `specific` first subtracts, cell by cell,
   * what the OTHER cameras looking at the same projector see there — the part a
   * projector pose or intrinsics error CANNOT produce, since such an error is a
   * property of the projector and is common to every camera that photographs it.
   * `specific` is the conservative reading and `raw` the aggressive one; which
   * is better is a measurement, so both exist.
   */
  mode: 'off' | 'raw' | 'specific';
  /** Grid cells per axis over the projector raster. */
  cells: number;
  /** Fewest samples in a cell for its mean to be worth comparing. */
  minCell: number;
  /**
   * Excess required before any inflation, in standard deviations of the null.
   *
   * Soft-thresholded rather than switched: the statistic is reduced by this many
   * null sigmas and floored at zero, so a marginal detection produces a marginal
   * inflation instead of a cliff. Without it the estimator's own scatter would
   * inflate clean pairs by a few per cent for nothing.
   */
  significance: number;
  /**
   * Ceiling on one pair's sigma multiplier.
   *
   * `estimateVarianceComponents` explains the hazard this bounds: a projector
   * seen by one camera whose pair is driven to zero weight has its parameters
   * determined by nothing at all, and the damping then decides its pose.
   */
  maxScale: number;
}

export const DEFAULT_PAIR_COHERENCE: PairCoherenceOptions = {
  mode: 'off',
  cells: 4,
  minCell: 24,
  significance: 3,
  maxScale: 8,
};

export const DEFAULT_BUNDLE_OPTIONS: BundleOptions = {
  free: DEFAULT_FREE_FLAGS,
  gauge: DEFAULT_GAUGE_OPTIONS,
  loss: DEFAULT_ROBUST_OPTIONS,
  maxIterations: 200,
  initialLambda: 1e-3,
  lambdaUp: 10,
  lambdaDown: 10,
  maxLambda: 1e12,
  costTol: 1e-12,
  stepTol: 1e-9,
  gradTol: 1e-9,
  maxEvaluations: 2000,
  rejectionPasses: 1,
  varianceComponents: true,
  tieProjectorFov: false,
  pairCoherence: DEFAULT_PAIR_COHERENCE,
};

// ---------------------------------------------------------------------------
// Parameter layout
// ---------------------------------------------------------------------------

export interface ParamLayout {
  nProjectors: number;
  nCameras: number;
  /** Total slots including held ones. */
  nSlots: number;
  slotCenterHeight: number;
  /** Slot -> reduced column index, or -1 when held. */
  freeMap: Int32Array;
  /** Reduced column index -> the slot it is READ from. */
  freeSlots: number[];
  /**
   * Reduced column index -> every slot it is WRITTEN to.
   *
   * Normally `[freeSlots[i]]`. A tied parameter (see
   * `BundleOptions.tieProjectorFov`) has several slots on one column: the
   * Jacobian accumulation already sums every tied slot's derivative into that
   * column because `freeMap` sends them all there, and this is the other half —
   * the step has to reach every slot the column stands for, or the state and the
   * parameter vector drift apart.
   */
  columnSlots: number[][];
  n: number;
  /** Human-readable name per reduced column. Used by the rank diagnostics. */
  names: string[];
}

/** Re-exported so callers can build a prior without importing project.ts. */
export {
  PROJ_FOV as PROJ_SLOT_FOV,
  PROJ_SHIFT_H as PROJ_SLOT_SHIFT_H,
  PROJ_SHIFT_V as PROJ_SLOT_SHIFT_V,
} from './project.ts';

export function slotProjector(p: number, i: number): number {
  return p * PROJ_PARAM_COUNT + i;
}

export function slotCamera(layout: { nProjectors: number }, c: number, i: number): number {
  return layout.nProjectors * PROJ_PARAM_COUNT + c * CAM_PARAM_COUNT + i;
}

export function buildLayout(state: BundleState, opts: BundleOptions): ParamLayout {
  const nProjectors = state.projectors.length;
  const nCameras = state.cameras.length;
  const nSlots = nProjectors * PROJ_PARAM_COUNT + nCameras * CAM_PARAM_COUNT + 1;
  const slotCenterHeight = nSlots - 1;
  const freeMap = new Int32Array(nSlots).fill(-1);
  const freeSlots: number[] = [];
  const columnSlots: number[][] = [];
  const names: string[] = [];

  const take = (slot: number, name: string): void => {
    freeMap[slot] = freeSlots.length;
    freeSlots.push(slot);
    columnSlots.push([slot]);
    names.push(name);
  };

  /** Point `slot` at a column that already exists, so the two move together. */
  const tieTo = (slot: number, column: number): void => {
    freeMap[slot] = column;
    columnSlots[column].push(slot);
  };

  const f = opts.free;
  // One shared field of view, when the caller says the rig has one lens model.
  let sharedFovColumn = -1;
  for (let p = 0; p < nProjectors; p++) {
    const id = state.projectors[p].id;
    const anchored =
      opts.gauge.mode === 'anchorProjector' && p === opts.gauge.anchorProjectorIndex;
    if (f.projectorPose) {
      take(slotProjector(p, PROJ_PX), `${id}.px`);
      take(slotProjector(p, PROJ_PY), `${id}.py`);
      take(slotProjector(p, PROJ_PZ), `${id}.pz`);
      // Anchoring holds the three rotation DOF of one projector, which removes
      // exactly the three-dimensional global-rotation freedom. Position stays
      // free: translation is already pinned by the sphere.
      if (!anchored) {
        take(slotProjector(p, PROJ_YAW), `${id}.yaw`);
        take(slotProjector(p, PROJ_PITCH), `${id}.pitch`);
        take(slotProjector(p, PROJ_ROLL), `${id}.roll`);
      }
    }
    if (f.projectorFov) {
      const slot = slotProjector(p, PROJ_FOV);
      if (!opts.tieProjectorFov) {
        take(slot, `${id}.fovH`);
      } else if (sharedFovColumn < 0) {
        take(slot, 'fovH (shared)');
        sharedFovColumn = freeSlots.length - 1;
      } else {
        tieTo(slot, sharedFovColumn);
      }
    }
    if (f.projectorShift) {
      take(slotProjector(p, PROJ_SHIFT_H), `${id}.shiftH`);
      take(slotProjector(p, PROJ_SHIFT_V), `${id}.shiftV`);
    }
    if (f.projectorRadial) {
      take(slotProjector(p, PROJ_K1), `${id}.k1`);
      take(slotProjector(p, PROJ_K2), `${id}.k2`);
    }
    if (f.projectorTangential) {
      take(slotProjector(p, PROJ_P1), `${id}.p1`);
      take(slotProjector(p, PROJ_P2), `${id}.p2`);
    }
  }
  const layoutHead = { nProjectors };
  for (let c = 0; c < nCameras; c++) {
    if (f.cameraPose) {
      take(slotCamera(layoutHead, c, CAM_PX), `cam${c}.px`);
      take(slotCamera(layoutHead, c, CAM_PY), `cam${c}.py`);
      take(slotCamera(layoutHead, c, CAM_PZ), `cam${c}.pz`);
      take(slotCamera(layoutHead, c, CAM_YAW), `cam${c}.yaw`);
      take(slotCamera(layoutHead, c, CAM_PITCH), `cam${c}.pitch`);
      take(slotCamera(layoutHead, c, CAM_ROLL), `cam${c}.roll`);
    }
    if (f.cameraFocal) take(slotCamera(layoutHead, c, CAM_FOCAL), `cam${c}.focal`);
  }
  if (f.centerHeight) take(slotCenterHeight, 'h_center');

  return {
    nProjectors,
    nCameras,
    nSlots,
    slotCenterHeight,
    freeMap,
    freeSlots,
    columnSlots,
    n: freeSlots.length,
    names,
  };
}

// ---------------------------------------------------------------------------
// State plumbing
// ---------------------------------------------------------------------------

export function cloneState(s: BundleState): BundleState {
  return {
    radiusM: s.radiusM,
    centerHeightM: s.centerHeightM,
    projectors: s.projectors.map((p) => ({ ...p, position: { ...p.position } })),
    cameras: s.cameras.map((c) => ({
      ...c,
      position: { ...c.position },
      intrinsics: { ...c.intrinsics },
    })),
  };
}

function readSlot(s: BundleState, layout: ParamLayout, slot: number): number {
  if (slot === layout.slotCenterHeight) return s.centerHeightM;
  const projEnd = layout.nProjectors * PROJ_PARAM_COUNT;
  if (slot < projEnd) {
    const p = s.projectors[Math.floor(slot / PROJ_PARAM_COUNT)];
    switch (slot % PROJ_PARAM_COUNT) {
      case PROJ_PX:
        return p.position.x;
      case PROJ_PY:
        return p.position.y;
      case PROJ_PZ:
        return p.position.z;
      case PROJ_YAW:
        return p.yawDeg;
      case PROJ_PITCH:
        return p.pitchDeg;
      case PROJ_ROLL:
        return p.rollDeg;
      case PROJ_FOV:
        return p.fovHDeg;
      case PROJ_SHIFT_H:
        return p.shiftH;
      case PROJ_SHIFT_V:
        return p.shiftV;
      case PROJ_K1:
        return p.k1;
      case PROJ_K2:
        return p.k2;
      case PROJ_P1:
        return p.p1;
      default:
        return p.p2;
    }
  }
  const rel = slot - projEnd;
  const c = s.cameras[Math.floor(rel / CAM_PARAM_COUNT)];
  switch (rel % CAM_PARAM_COUNT) {
    case CAM_PX:
      return c.position.x;
    case CAM_PY:
      return c.position.y;
    case CAM_PZ:
      return c.position.z;
    case CAM_YAW:
      return c.yawDeg;
    case CAM_PITCH:
      return c.pitchDeg;
    case CAM_ROLL:
      return c.rollDeg;
    default:
      return c.focalScale;
  }
}

function writeSlot(s: BundleState, layout: ParamLayout, slot: number, value: number): void {
  if (slot === layout.slotCenterHeight) {
    s.centerHeightM = value;
    return;
  }
  const projEnd = layout.nProjectors * PROJ_PARAM_COUNT;
  if (slot < projEnd) {
    const p = s.projectors[Math.floor(slot / PROJ_PARAM_COUNT)];
    switch (slot % PROJ_PARAM_COUNT) {
      case PROJ_PX:
        p.position.x = value;
        return;
      case PROJ_PY:
        p.position.y = value;
        return;
      case PROJ_PZ:
        p.position.z = value;
        return;
      case PROJ_YAW:
        p.yawDeg = value;
        return;
      case PROJ_PITCH:
        p.pitchDeg = value;
        return;
      case PROJ_ROLL:
        p.rollDeg = value;
        return;
      case PROJ_FOV:
        p.fovHDeg = value;
        return;
      case PROJ_SHIFT_H:
        p.shiftH = value;
        return;
      case PROJ_SHIFT_V:
        p.shiftV = value;
        return;
      case PROJ_K1:
        p.k1 = value;
        return;
      case PROJ_K2:
        p.k2 = value;
        return;
      case PROJ_P1:
        p.p1 = value;
        return;
      default:
        p.p2 = value;
        return;
    }
  }
  const rel = slot - projEnd;
  const c = s.cameras[Math.floor(rel / CAM_PARAM_COUNT)];
  switch (rel % CAM_PARAM_COUNT) {
    case CAM_PX:
      c.position.x = value;
      return;
    case CAM_PY:
      c.position.y = value;
      return;
    case CAM_PZ:
      c.position.z = value;
      return;
    case CAM_YAW:
      c.yawDeg = value;
      return;
    case CAM_PITCH:
      c.pitchDeg = value;
      return;
    case CAM_ROLL:
      c.rollDeg = value;
      return;
    default:
      c.focalScale = value;
      return;
  }
}

/** Read the free parameters into a vector. */
export function packState(s: BundleState, layout: ParamLayout): Float64Array {
  const v = new Float64Array(layout.n);
  for (let i = 0; i < layout.n; i++) v[i] = readSlot(s, layout, layout.freeSlots[i]);
  return v;
}

/**
 * Write a free-parameter vector back into a state.
 *
 * Every slot a column stands for is written, not just the one it is read from,
 * so a tied parameter reaches all of its slots. With no ties `columnSlots[i]` is
 * `[freeSlots[i]]` and this is the obvious loop.
 */
export function unpackState(v: Float64Array, s: BundleState, layout: ParamLayout): void {
  for (let i = 0; i < layout.n; i++) {
    const slots = layout.columnSlots[i];
    for (let k = 0; k < slots.length; k++) writeSlot(s, layout, slots[k], v[i]);
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvalResult {
  /** Robust cost: sum of rho over correspondences plus the floor terms. */
  cost: number;
  /** Standardised residual norm per correspondence; 0 for inactive ones. */
  norms: Float64Array;
  /** Raw pixel residuals, 2 per correspondence, (du, dv). */
  raw: Float64Array;
  /** False when the camera ray missed the sphere or the point fell behind the lens. */
  usable: boolean[];
  /** Only when a Jacobian was requested. */
  jtj: Float64Array | null;
  jtr: Float64Array | null;
  /** Number of correspondences that contributed. */
  contributing: number;
}

interface BlockIndex {
  /** Local parameter index within the projector/camera block. */
  local: Int32Array;
  /** Reduced column index. */
  column: Int32Array;
}

function blockIndices(layout: ParamLayout, base: number, count: number): BlockIndex {
  const local: number[] = [];
  const column: number[] = [];
  for (let i = 0; i < count; i++) {
    const col = layout.freeMap[base + i];
    if (col >= 0) {
      local.push(i);
      column.push(col);
    }
  }
  return { local: Int32Array.from(local), column: Int32Array.from(column) };
}

export interface BundleProblem {
  correspondences: readonly Correspondence[];
  floor: readonly FloorReference[];
  priors: readonly ParameterPrior[];
  layout: ParamLayout;
  opts: BundleOptions;
  /** Rejected by an earlier pass, or unusable. Never re-enters the fit. */
  excluded: boolean[];
  projBlocks: BlockIndex[];
  camBlocks: BlockIndex[];
  /** Cached ideal normalized camera coordinates, 2 per correspondence. */
  normalized: Float64Array;
  normalizedValid: boolean;
  /**
   * Per-camera variance component: how much larger the residuals of that
   * camera's correspondences actually are than the decode said they would be.
   *
   * One entry per camera, all 1 until `runBundle` estimates them between LM
   * passes. See `estimateVarianceComponents` for what it is for and why it is
   * floored at 1.
   */
  cameraScale: Float64Array;
  /**
   * Per (camera, projector) pair: how much of that pair's residual is coherent
   * rather than independent, expressed as a sigma multiplier.
   *
   * Indexed `camera * nProjectors + projector`, all 1 until `runBundle` estimates
   * them between LM passes. Multiplies `cameraScale`, which is the layer below
   * it: the camera term says how much worse this camera is overall, this one says
   * how much of what is left is structure rather than noise. See
   * `PairCoherenceOptions`.
   */
  pairScale: Float64Array;
}

export function buildProblem(
  state: BundleState,
  correspondences: readonly Correspondence[],
  floor: readonly FloorReference[],
  opts: BundleOptions,
  priors: readonly ParameterPrior[] = [],
): BundleProblem {
  const layout = buildLayout(state, opts);
  const projBlocks: BlockIndex[] = [];
  for (let p = 0; p < layout.nProjectors; p++) {
    projBlocks.push(blockIndices(layout, slotProjector(p, 0), PROJ_PARAM_COUNT));
  }
  const camBlocks: BlockIndex[] = [];
  for (let c = 0; c < layout.nCameras; c++) {
    camBlocks.push(blockIndices(layout, slotCamera(layout, c, 0), CAM_PARAM_COUNT));
  }

  const normalized = new Float64Array(correspondences.length * 2);
  // Undistorting the camera pixel is a Newton loop, and it depends only on the
  // camera's interior orientation. When the focal is held (the default) that is
  // constant across the whole solve, so it is worth doing once. When the focal
  // is free the cache is invalid and the loop runs per evaluation.
  if (!opts.free.cameraFocal) {
    for (let i = 0; i < correspondences.length; i++) {
      const corr = correspondences[i];
      const n = cameraPixelToNormalized(state.cameras[corr.camera], corr.camU, corr.camV);
      normalized[2 * i] = n.x;
      normalized[2 * i + 1] = n.y;
    }
  }

  // One prior per COLUMN, not per slot. Without ties the two are the same thing.
  // With them, four spec-sheet priors on four slots that are one parameter would
  // stack into a prior twice as tight as any of them — four readings of the same
  // spec sheet are not four measurements.
  const priorColumns = new Set<number>();
  const livePriors = priors.filter((p) => {
    if (!(p.sigma > 0)) return false;
    const col = layout.freeMap[p.slot];
    if (col < 0 || priorColumns.has(col)) return false;
    priorColumns.add(col);
    return true;
  });

  return {
    correspondences,
    floor,
    priors: livePriors,
    layout,
    opts,
    excluded: new Array(correspondences.length).fill(false),
    projBlocks,
    camBlocks,
    normalized,
    normalizedValid: !opts.free.cameraFocal,
    cameraScale: new Float64Array(layout.nCameras).fill(1),
    pairScale: new Float64Array(layout.nCameras * layout.nProjectors).fill(1),
  };
}

/**
 * One evaluation of the objective, optionally accumulating the normal equations.
 *
 * The normal equations are accumulated directly rather than by forming a dense
 * Jacobian. A capture can easily yield a hundred thousand correspondences, and a
 * dense `J` would be gigabytes while `J^T J` is at most a hundred on a side. Each
 * correspondence touches only its own projector's and camera's blocks, so the
 * accumulation is over an index list of about eighteen columns — the sparsity is
 * in the loop bounds rather than in a data structure.
 */
export function evaluate(
  state: BundleState,
  problem: BundleProblem,
  wantJacobian: boolean,
): EvalResult {
  const { correspondences, layout, opts } = problem;
  const n = layout.n;
  const jtj = wantJacobian ? new Float64Array(n * n) : null;
  const jtr = wantJacobian ? new Float64Array(n) : null;
  const norms = new Float64Array(correspondences.length);
  const raw = new Float64Array(correspondences.length * 2);
  const usable: boolean[] = new Array(correspondences.length).fill(false);

  const dParamScratch = new Float64Array(2 * PROJ_PARAM_COUNT);
  const dWorldScratch = new Float64Array(6);
  const dPointScratch = new Float64Array(3 * CAM_PARAM_COUNT);
  const maxBlock = PROJ_PARAM_COUNT + CAM_PARAM_COUNT;
  const idx = new Int32Array(maxBlock);
  const ju = new Float64Array(maxBlock);
  const jv = new Float64Array(maxBlock);

  // The projector frame is constant across correspondences, so build it once
  // per projector. The Jacobian path needs the rotation derivatives too and
  // rebuilds them per row; the cost-only path — which runs on every trial step
  // of every LM iteration — does not, and this is where that saving lands.
  const axesByProjector: FrameAxes[] = state.projectors.map((p) =>
    frameAxes(rotationMatrix(p.yawDeg, p.pitchDeg, p.rollDeg)),
  );
  // Same argument for the rotation derivatives: eight 3x3 products per entity,
  // constant across the whole evaluation. Building them per correspondence made
  // a Jacobian pass thirty times slower than a cost-only pass, which is the
  // wrong ratio by about an order of magnitude.
  const projRot: RotationWithDerivatives[] = wantJacobian
    ? state.projectors.map((p) => rotationWithDerivatives(p.yawDeg, p.pitchDeg, p.rollDeg))
    : [];
  const camRot: RotationWithDerivatives[] = wantJacobian
    ? state.cameras.map((c) => rotationWithDerivatives(c.yawDeg, c.pitchDeg, c.rollDeg))
    : [];

  // See `RobustOptions.missPenalty`: a correspondence the current state cannot
  // use is charged a fixed price rather than silently leaving the objective.
  const missCost = lossAndWeight(opts.loss.missPenalty, opts.loss).rho;

  let cost = 0;
  let contributing = 0;

  for (let i = 0; i < correspondences.length; i++) {
    if (problem.excluded[i]) continue;
    const corr = correspondences[i];
    const cam = state.cameras[corr.camera];
    const proj = state.projectors[corr.projector];

    let nx: number;
    let ny: number;
    if (problem.normalizedValid) {
      nx = problem.normalized[2 * i];
      ny = problem.normalized[2 * i + 1];
    } else {
      const nn = cameraPixelToNormalized(cam, corr.camU, corr.camV);
      nx = nn.x;
      ny = nn.y;
    }

    let hitPoint: Vec3;
    let dPoint: Float64Array | null = null;
    if (wantJacobian) {
      const hj = intersectSphereJacobian(
        cam,
        nx,
        ny,
        state.radiusM,
        camRot[corr.camera],
        dPointScratch,
      );
      if (!hj.hit.hit) {
        cost += missCost;
        continue;
      }
      hitPoint = hj.hit.point;
      dPoint = hj.dPoint;
    } else {
      const ray = rayFromNormalized(cam, nx, ny);
      const hit = intersectSphere(ray.origin, ray.dir, state.radiusM);
      if (!hit.hit) {
        cost += missCost;
        continue;
      }
      hitPoint = hit.point;
    }

    const pj = wantJacobian
      ? projectPointJacobian(
          proj,
          hitPoint,
          dParamScratch,
          projRot[corr.projector],
          dWorldScratch,
        )
      : null;
    const shot = pj ?? projectPointWithAxes(proj, axesByProjector[corr.projector], hitPoint);
    if (!shot.inFront) {
      cost += missCost;
      continue;
    }
    const u = shot.u;
    const v = shot.v;

    const du = u - corr.projU;
    const dv = v - corr.projV;
    const cs =
      problem.cameraScale[corr.camera] *
      problem.pairScale[corr.camera * layout.nProjectors + corr.projector];
    const wu = 1 / (corr.sigmaU * cs);
    const wv = 1 / (corr.sigmaV * cs);
    const su = du * wu;
    const sv = dv * wv;
    const s = Math.hypot(su, sv);

    raw[2 * i] = du;
    raw[2 * i + 1] = dv;
    norms[i] = s;
    usable[i] = true;
    contributing++;

    const lw = lossAndWeight(s, opts.loss);
    cost += lw.rho;

    if (!wantJacobian || !jtj || !jtr || !pj || !dPoint) continue;

    // Assemble the compacted row pair: projector block, then camera block.
    const pb = problem.projBlocks[corr.projector];
    const cb = problem.camBlocks[corr.camera];
    let m = 0;
    for (let k = 0; k < pb.local.length; k++) {
      const l = pb.local[k];
      idx[m] = pb.column[k];
      ju[m] = pj.dParam[l];
      jv[m] = pj.dParam[PROJ_PARAM_COUNT + l];
      m++;
    }
    for (let k = 0; k < cb.local.length; k++) {
      const l = cb.local[k];
      // d(u,v)/d(camParam) = d(u,v)/d(worldPoint) . d(worldPoint)/d(camParam)
      const dx = dPoint[0 * CAM_PARAM_COUNT + l];
      const dy = dPoint[1 * CAM_PARAM_COUNT + l];
      const dz = dPoint[2 * CAM_PARAM_COUNT + l];
      idx[m] = cb.column[k];
      ju[m] = pj.dWorld[0] * dx + pj.dWorld[1] * dy + pj.dWorld[2] * dz;
      jv[m] = pj.dWorld[3] * dx + pj.dWorld[4] * dy + pj.dWorld[5] * dz;
      m++;
    }

    const au = lw.omega * wu * wu;
    const av = lw.omega * wv * wv;
    for (let a = 0; a < m; a++) {
      const ia = idx[a];
      jtr[ia] += au * ju[a] * du + av * jv[a] * dv;
      const rowBase = ia * n;
      for (let b = 0; b < m; b++) {
        jtj[rowBase + idx[b]] += au * ju[a] * ju[b] + av * jv[a] * jv[b];
      }
    }
  }

  // --- floor references: the only thing that sees h_center ---
  for (const ref of problem.floor) {
    const z =
      ref.kind === 'camera'
        ? state.cameras[ref.index].position.z
        : state.projectors[ref.index].position.z;
    const w = 1 / ref.sigmaM;
    const r = (z + state.centerHeightM - ref.heightM) * w;
    cost += r * r;
    if (!wantJacobian || !jtj || !jtr) continue;

    const cols: number[] = [];
    const vals: number[] = [];
    const zSlot =
      ref.kind === 'camera'
        ? slotCamera(layout, ref.index, CAM_PZ)
        : slotProjector(ref.index, PROJ_PZ);
    if (layout.freeMap[zSlot] >= 0) {
      cols.push(layout.freeMap[zSlot]);
      vals.push(w);
    }
    if (layout.freeMap[layout.slotCenterHeight] >= 0) {
      cols.push(layout.freeMap[layout.slotCenterHeight]);
      vals.push(w);
    }
    for (let a = 0; a < cols.length; a++) {
      jtr[cols[a]] += vals[a] * r;
      for (let b = 0; b < cols.length; b++) {
        jtj[cols[a] * n + cols[b]] += vals[a] * vals[b];
      }
    }
  }

  // --- parameter priors: what the documentation knows, and how well ---
  for (const pr of problem.priors) {
    const col = layout.freeMap[pr.slot];
    if (col < 0) continue;
    const w = 1 / pr.sigma;
    const r = (readSlot(state, layout, pr.slot) - pr.mean) * w;
    cost += r * r;
    if (!wantJacobian || !jtj || !jtr) continue;
    jtr[col] += w * r;
    jtj[col * n + col] += w * w;
  }

  return { cost, norms, raw, usable, jtj, jtr, contributing };
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

function rotationAboutAxis(axis: Vec3, angleRad: number): Mat3 {
  const { x, y, z } = axis;
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const t = 1 - c;
  return Float64Array.of(
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  );
}

function wrapDeg(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/**
 * The three global-rotation null directions of the correspondence residuals,
 * expressed in the reduced parameter space and normalised to unit length.
 *
 * Computed by applying a small global rotation to the entire rig and reading off
 * the parameter displacement. Doing it that way rather than deriving the Euler
 * derivative in closed form is deliberate: the null space is a property of the
 * *parameterisation*, and a numerical difference of the actual pack/unpack path
 * cannot drift out of step with it the way a hand-derived formula can. The
 * epsilon is 1e-6 rad, far above the point where the Euler extraction loses
 * precision and far below where the second-order term matters.
 *
 * The `h_center` component is the least-squares compensation described in the
 * file header: with one floor reference it makes the direction exactly null,
 * with several it makes it as close to null as a single scalar can.
 */
export interface GaugeDirection {
  /** 0 = world X, 1 = world Y, 2 = world Z. */
  axis: number;
  /** Unit vector in the reduced parameter space. */
  dir: Float64Array;
}

export function gaugeNullSpace(state: BundleState, problem: BundleProblem): GaugeDirection[] {
  const { layout } = problem;
  // Central difference. A forward difference leaves an O(eps) error in the
  // direction, which shows up as an O(eps^2) = 1e-12 relative stiffness — the
  // same order as the tolerance that decides whether a direction is null, so
  // the two become indistinguishable and the observability test stops working.
  const eps = 1e-5;
  const axes: Vec3[] = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
  ];
  const out: GaugeDirection[] = [];

  for (let axisIndex = 0; axisIndex < axes.length; axisIndex++) {
    const axis = axes[axisIndex];
    const rgPos = rotationAboutAxis(axis, eps);
    const rgNeg = rotationAboutAxis(axis, -eps);
    const full = new Float64Array(layout.nSlots);
    const denom = 2 * eps;

    const fillEntity = (
      base: number,
      position: Vec3,
      yawDeg: number,
      pitchDeg: number,
      rollDeg: number,
      pxSlot: number,
      pySlot: number,
      pzSlot: number,
      yawSlot: number,
      pitchSlot: number,
      rollSlot: number,
    ): void => {
      const pp = mat3MulVec(rgPos, position);
      const pn = mat3MulVec(rgNeg, position);
      full[base + pxSlot] = (pp.x - pn.x) / denom;
      full[base + pySlot] = (pp.y - pn.y) / denom;
      full[base + pzSlot] = (pp.z - pn.z) / denom;
      const r0 = rotationMatrix(yawDeg, pitchDeg, rollDeg);
      const ep = eulerFromMatrix(mat3Multiply(rgPos, r0));
      const en = eulerFromMatrix(mat3Multiply(rgNeg, r0));
      full[base + yawSlot] = wrapDeg(ep.yawDeg - en.yawDeg) / denom;
      full[base + pitchSlot] = wrapDeg(ep.pitchDeg - en.pitchDeg) / denom;
      full[base + rollSlot] = wrapDeg(ep.rollDeg - en.rollDeg) / denom;
    };

    for (let p = 0; p < layout.nProjectors; p++) {
      const proj = state.projectors[p];
      fillEntity(
        slotProjector(p, 0),
        proj.position,
        proj.yawDeg,
        proj.pitchDeg,
        proj.rollDeg,
        PROJ_PX,
        PROJ_PY,
        PROJ_PZ,
        PROJ_YAW,
        PROJ_PITCH,
        PROJ_ROLL,
      );
    }
    for (let c = 0; c < layout.nCameras; c++) {
      const cam = state.cameras[c];
      fillEntity(
        slotCamera(layout, c, 0),
        cam.position,
        cam.yawDeg,
        cam.pitchDeg,
        cam.rollDeg,
        CAM_PX,
        CAM_PY,
        CAM_PZ,
        CAM_YAW,
        CAM_PITCH,
        CAM_ROLL,
      );
    }

    if (problem.floor.length > 0) {
      let sum = 0;
      for (const ref of problem.floor) {
        const pos =
          ref.kind === 'camera'
            ? state.cameras[ref.index].position
            : state.projectors[ref.index].position;
        sum += (mat3MulVec(rgPos, pos).z - mat3MulVec(rgNeg, pos).z) / denom;
      }
      full[layout.slotCenterHeight] = -sum / problem.floor.length;
    }

    const reduced = new Float64Array(layout.n);
    for (let i = 0; i < layout.n; i++) reduced[i] = full[layout.freeSlots[i]];
    let norm = 0;
    for (let i = 0; i < layout.n; i++) norm += reduced[i] * reduced[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
      for (let i = 0; i < layout.n; i++) reduced[i] /= norm;
      out.push({ axis: axisIndex, dir: reduced });
    }
  }
  return out;
}

/**
 * How strongly the floor observations resist a candidate gauge direction.
 *
 * The correspondence residuals are exactly invariant under every global
 * rotation, so they can never tell one candidate from another; the only rows
 * that can are the floor heights. This measures the coupling directly, as the
 * cosine between the unit direction and each floor row — a floor row is
 * `(1/sigma) * (e_z + e_hcenter)`, so the cosine is
 * `(n[z] + n[h]) / sqrt(2)`, with the sigmas cancelling.
 *
 * Doing it this way rather than as `n^T J^T J n` against the mean diagonal is
 * what makes the test mean anything. That quadratic form mixes the
 * correspondence block, whose scale is set by the decode's sigma, with the floor
 * block, whose scale is set by a tape measure; halving the decode uncertainty
 * multiplies the ratio by four and a fixed threshold silently changes its
 * verdict. This cosine is dimensionless and depends on neither.
 */
function floorCoupling(problem: BundleProblem, dir: Float64Array): number {
  const { layout } = problem;
  const hCol = layout.freeMap[layout.slotCenterHeight];
  let worst = 0;
  for (const ref of problem.floor) {
    const zSlot =
      ref.kind === 'camera'
        ? slotCamera(layout, ref.index, CAM_PZ)
        : slotProjector(ref.index, PROJ_PZ);
    const zCol = layout.freeMap[zSlot];
    const dz = zCol >= 0 ? dir[zCol] : 0;
    const dh = hCol >= 0 ? dir[hCol] : 0;
    worst = Math.max(worst, Math.abs(dz + dh) / Math.SQRT2);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Post-solve gauge alignment
// ---------------------------------------------------------------------------

/** Rotation vector (axis * angle) of a rotation matrix, small-angle branch. */
function rotationVector(m: Mat3): Vec3 {
  const wx = 0.5 * (m[7] - m[5]);
  const wy = 0.5 * (m[2] - m[6]);
  const wz = 0.5 * (m[3] - m[1]);
  const s = Math.hypot(wx, wy, wz);
  if (s < 1e-15) return { x: 0, y: 0, z: 0 };
  const angle = Math.asin(Math.min(1, s));
  const k = angle / s;
  return { x: wx * k, y: wy * k, z: wz * k };
}

/**
 * Re-express the solution in the frame the nominal layout defines, along the
 * rotational directions that are genuinely free.
 *
 * A global rotation about the sphere centre leaves every correspondence
 * residual exactly unchanged, so applying one is not an adjustment — it does not
 * improve or degrade the fit by a single ULP. It only chooses which member of an
 * equivalent family to report. Left alone, that member is wherever the bootstrap
 * happened to land, which in practice is a couple of degrees off; anchored to
 * the nominal, it is as close to the truth as the nominal layout itself is.
 *
 * The anchor is PARAMETERS.md §2's own description of the rig: projectors at
 * 0/90/180/270 degrees of azimuth, all at the equator's height. Kabsch over the
 * projector positions finds the rotation taking the recovered layout onto that
 * description; the rotation is then filtered to the axes `freeAxes` reports as
 * unobservable, so that a tilt the floor references genuinely measured is not
 * overwritten by a nominal that only assumed it.
 *
 * `h_center` is re-fitted afterwards in closed form, because rotating the rig
 * moves the measured entities in z and the floor observation has to be honoured
 * in the new frame.
 *
 * What this cannot do is make the world-frame rotation error arbitrarily small.
 * The anchor is only as good as the nominal layout: with the ±3 cm of position
 * scatter a real rig carries, a four-point Kabsch pins the frame to something
 * like a tenth of a degree. Anything scoring pose recovery against the
 * PARAMETERS.md §7 gate of 0.05 degrees must align frames against its own ground
 * truth first. That is not a weakness of this solver; a global rotation is
 * unobservable to any solver, and a bench that charges for it is measuring the
 * gauge.
 */
export function alignGaugeToReference(
  state: BundleState,
  reference: BundleState,
  freeAxes: readonly boolean[],
  floor: readonly FloorReference[],
): BundleState {
  const count = Math.min(state.projectors.length, reference.projectors.length);
  if (count < 3) return state;

  const from: Vec3[] = [];
  const to: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    from.push(state.projectors[i].position);
    to.push(reference.projectors[i].position);
  }
  const full = kabschRotation(from, to);
  const w = rotationVector(full);
  const filtered = {
    x: freeAxes[0] ? w.x : 0,
    y: freeAxes[1] ? w.y : 0,
    z: freeAxes[2] ? w.z : 0,
  };
  const angle = Math.hypot(filtered.x, filtered.y, filtered.z);
  if (!(angle > 1e-15)) return state;
  const rg = rotationAboutAxis(
    { x: filtered.x / angle, y: filtered.y / angle, z: filtered.z / angle },
    angle,
  );

  const out = cloneState(state);
  for (const p of out.projectors) {
    p.position = mat3MulVec(rg, p.position);
    const e = eulerFromMatrix(
      mat3Multiply(rg, rotationMatrix(p.yawDeg, p.pitchDeg, p.rollDeg)),
    );
    p.yawDeg = e.yawDeg;
    p.pitchDeg = e.pitchDeg;
    p.rollDeg = e.rollDeg;
  }
  for (const c of out.cameras) {
    c.position = mat3MulVec(rg, c.position);
    const e = eulerFromMatrix(
      mat3Multiply(rg, rotationMatrix(c.yawDeg, c.pitchDeg, c.rollDeg)),
    );
    c.yawDeg = e.yawDeg;
    c.pitchDeg = e.pitchDeg;
    c.rollDeg = e.rollDeg;
  }

  if (floor.length > 0) {
    let num = 0;
    let den = 0;
    for (const ref of floor) {
      const z =
        ref.kind === 'camera'
          ? out.cameras[ref.index].position.z
          : out.projectors[ref.index].position.z;
      const wgt = 1 / (ref.sigmaM * ref.sigmaM);
      num += wgt * (ref.heightM - z);
      den += wgt;
    }
    if (den > 0) out.centerHeightM = num / den;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Levenberg-Marquardt
// ---------------------------------------------------------------------------

export interface BundleReport {
  state: BundleState;
  iterations: number;
  converged: boolean;
  /** Why the loop stopped. Reported so a stall is never mistaken for convergence. */
  stopReason: 'cost' | 'step' | 'gradient' | 'maxIterations' | 'lambda' | 'noFreeParams';
  cost: number;
  rmsResidualPx: number;
  perProjectorRmsPx: number[];
  used: number;
  rejected: number;
  residuals: ResidualSample[];
  /** Number of gauge constraints actually applied. 3 in the normal case. */
  gaugeConstraints: number;
  /**
   * Per world axis (X, Y, Z), whether the global rotation about it turned out
   * to be unobservable and therefore gauge-fixed rather than measured.
   */
  gaugeFreeAxes: boolean[];
  /** Rank deficiency reported by the last linear solve, after damping. */
  lastDeficiency: number;
  /**
   * Every prior, and how far the solution ended up from it in units of the
   * prior's own sigma. A prior sitting at 0.1 sigma did nothing; one at 3 sigma
   * is fighting the data and the reader deserves to know before quoting the
   * answer.
   */
  priorResiduals: { name: string; sigmas: number }[];
  /**
   * Per camera, how many times worse its residuals turned out to be than its
   * decode claimed. 1.0 means the decode's own uncertainty was right. Anything
   * much above 1 is unmodelled error — on this bench, almost always inter-frame
   * camera motion — and it is reported because a solver that silently reweights
   * its own input owes the reader that number.
   */
  cameraResidualScale: number[];
  /**
   * Per (camera, projector) pair, indexed `camera * nProjectors + projector`:
   * how much its sigma was inflated for residual coherence the decode could not
   * see. 1.0 means the pair's residuals were consistent with independent noise
   * of the decode's own stated sigma. See `PairCoherenceOptions`.
   */
  pairResidualScale: number[];
}

/**
 * One Levenberg-Marquardt run over a fixed set of active correspondences.
 *
 * Damping is Marquardt's: `(J^T J + lambda * diag(J^T J)) d = -J^T r`. Scaling
 * the damping by the diagonal rather than by the identity is the whole answer to
 * "a metre and a degree must not compete on equal footing" — the diagonal
 * carries each parameter's own sensitivity in pixels-squared per unit, so the
 * damped system is invariant to how the parameters happen to be scaled. A fixed
 * floor on the diagonal keeps a completely unobserved parameter (say, a
 * projector nobody photographed) from producing a division by zero.
 */
export function levenbergMarquardt(
  initial: BundleState,
  problem: BundleProblem,
  onIteration?: (iteration: number, cost: number, lambda: number) => void,
): BundleReport {
  const { layout, opts } = problem;
  let state = cloneState(initial);
  // Put the state on the tie manifold before the first evaluation. Without ties
  // this reads each free slot and writes the same value straight back — exactly
  // a no-op. With ties it makes the initial state consistent with the parameter
  // vector, instead of letting the first accepted step silently equalise four
  // fields of view and charging the difference to that step.
  unpackState(packState(state, layout), state, layout);

  if (layout.n === 0) {
    const ev = evaluate(state, problem, false);
    return finishReport(state, problem, ev, 0, false, 'noFreeParams', 0, [false, false, false], 0);
  }

  let ev = evaluate(state, problem, true);
  let cost = ev.cost;
  let lambda = opts.initialLambda;
  // `iterations` counts ACCEPTED steps; `evaluations` counts every trial,
  // accepted or not. Conflating them makes the iteration cap a budget for
  // failed line searches rather than for progress — a badly conditioned start
  // spends most of its trials raising lambda, and a solve that needed thirty
  // real steps reports "maxIterations" having taken eight.
  let iterations = 0;
  let evaluations = 0;
  let costPlateaus = 0;
  let converged = false;
  let stopReason: BundleReport['stopReason'] = 'maxIterations';
  let gaugeCount = 0;
  let gaugeFreeAxes: boolean[] = [true, true, true];
  let lastDeficiency = 0;

  const n = layout.n;
  const damped = new Float64Array(n * n);
  const rhs = new Float64Array(n);

  while (iterations < opts.maxIterations && evaluations < opts.maxEvaluations) {
    const jtj = ev.jtj;
    const jtr = ev.jtr;
    if (!jtj || !jtr) break;

    // --- gauge rows, added after the data so the strength can be relative ---
    let meanDiag = 0;
    for (let i = 0; i < n; i++) meanDiag += jtj[i * n + i];
    meanDiag = n > 0 ? meanDiag / n : 1;
    if (!(meanDiag > 0)) meanDiag = 1;

    gaugeCount = 0;
    if (opts.gauge.mode === 'inner' && opts.gauge.strength > 0) {
      const nulls = gaugeNullSpace(state, problem);
      const w2 = opts.gauge.strength * meanDiag;
      gaugeFreeAxes = [false, false, false];
      for (let ci = 0; ci < nulls.length; ci++) {
        // A direction the floor heights genuinely determine must be left to the
        // data. Pinning it would throw away the measurement PARAMETERS.md §8
        // item 1 exists to collect.
        if (floorCoupling(problem, nulls[ci].dir) > opts.gauge.nullTolerance) continue;
        const cand = nulls[ci];
        gaugeFreeAxes[cand.axis] = true;
        gaugeCount++;
        const vec = cand.dir;
        for (let a = 0; a < n; a++) {
          if (vec[a] === 0) continue;
          const rowBase = a * n;
          for (let b = 0; b < n; b++) {
            if (vec[b] === 0) continue;
            jtj[rowBase + b] += w2 * vec[a] * vec[b];
          }
        }
      }
    }

    // Diagonal used for both damping and the pixel-unit convergence tests.
    const diag = new Float64Array(n);
    let maxDiag = 0;
    for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, jtj[i * n + i]);
    const diagFloor = maxDiag > 0 ? maxDiag * 1e-12 : 1e-12;
    for (let i = 0; i < n; i++) diag[i] = Math.max(jtj[i * n + i], diagFloor);

    let maxGrad = 0;
    for (let i = 0; i < n; i++) maxGrad = Math.max(maxGrad, Math.abs(jtr[i]) / Math.sqrt(diag[i]));
    if (maxGrad < opts.gradTol) {
      converged = true;
      stopReason = 'gradient';
      break;
    }

    let accepted = false;
    while (lambda <= opts.maxLambda) {
      damped.set(jtj);
      for (let i = 0; i < n; i++) damped[i * n + i] += lambda * diag[i];
      for (let i = 0; i < n; i++) rhs[i] = -jtr[i];

      const sol = solveSymmetric(damped, n, rhs);
      lastDeficiency = sol.deficiency;

      const trial = cloneState(state);
      const current = packState(state, layout);
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) next[i] = current[i] + sol.x[i];
      unpackState(next, trial, layout);

      const trialEv = evaluate(trial, problem, false);
      evaluations++;

      if (trialEv.cost < cost) {
        iterations++;
        let maxStep = 0;
        for (let i = 0; i < n; i++) {
          maxStep = Math.max(maxStep, Math.abs(sol.x[i]) * Math.sqrt(diag[i]));
        }
        const rel = cost > 0 ? (cost - trialEv.cost) / cost : 0;

        state = trial;
        cost = trialEv.cost;
        lambda = Math.max(lambda / opts.lambdaDown, 1e-12);
        accepted = true;
        if (onIteration) onIteration(iterations, cost, lambda);

        if (maxStep < opts.stepTol) {
          converged = true;
          stopReason = 'step';
        } else if (rel < opts.costTol) {
          // Two in a row. A single tiny decrease also happens when the damping
          // has run up and the step has been throttled to nothing, which is a
          // stall wearing convergence's clothes; requiring the plateau to
          // persist across an undamped step tells the two apart.
          costPlateaus++;
          if (costPlateaus >= 2) {
            converged = true;
            stopReason = 'cost';
          }
        } else {
          costPlateaus = 0;
        }
        break;
      }
      lambda *= opts.lambdaUp;
      if (evaluations >= opts.maxEvaluations) break;
    }

    if (converged) break;
    if (!accepted) {
      // Damping ran away without finding a downhill step. That is a stall, not
      // a convergence, and it is reported as such — a solver that calls its own
      // failures "converged" is worse than one that fails loudly.
      stopReason = lambda > opts.maxLambda ? 'lambda' : 'maxIterations';
      break;
    }
    ev = evaluate(state, problem, true);
  }

  const final = evaluate(state, problem, false);
  return finishReport(
    state,
    problem,
    final,
    iterations,
    converged,
    stopReason,
    gaugeCount,
    gaugeFreeAxes,
    lastDeficiency,
  );
}

function finishReport(
  state: BundleState,
  problem: BundleProblem,
  ev: EvalResult,
  iterations: number,
  converged: boolean,
  stopReason: BundleReport['stopReason'],
  gaugeConstraints: number,
  gaugeFreeAxes: boolean[],
  lastDeficiency: number,
): BundleReport {
  const { correspondences, layout } = problem;
  const residuals: ResidualSample[] = [];
  const perSum = new Float64Array(layout.nProjectors);
  const perCount = new Int32Array(layout.nProjectors);
  let sum = 0;
  let count = 0;
  let used = 0;
  let rejected = 0;

  for (let i = 0; i < correspondences.length; i++) {
    const corr = correspondences[i];
    const excluded = problem.excluded[i] || !ev.usable[i];
    if (excluded) {
      rejected++;
      continue;
    }
    used++;
    const du = ev.raw[2 * i];
    const dv = ev.raw[2 * i + 1];
    // Every residual is reported, not a summary. PARAMETERS.md's progress page
    // reads structure in this scatter as "the model is wrong" and randomness as
    // "sensor noise", and that distinction does not survive an RMS.
    residuals.push({
      projector: corr.projector,
      camera: corr.camera,
      u: corr.projU,
      v: corr.projV,
      du,
      dv,
    });
    const sq = du * du + dv * dv;
    sum += sq;
    count++;
    perSum[corr.projector] += sq;
    perCount[corr.projector]++;
  }

  const perProjectorRmsPx: number[] = [];
  for (let p = 0; p < layout.nProjectors; p++) {
    perProjectorRmsPx.push(perCount[p] > 0 ? Math.sqrt(perSum[p] / perCount[p]) : 0);
  }

  const priorResiduals = problem.priors.map((pr) => ({
    name: pr.name,
    sigmas: (readSlot(state, layout, pr.slot) - pr.mean) / pr.sigma,
  }));

  return {
    state,
    iterations,
    converged,
    stopReason,
    cost: ev.cost,
    rmsResidualPx: count > 0 ? Math.sqrt(sum / count) : 0,
    perProjectorRmsPx,
    used,
    rejected,
    residuals,
    gaugeConstraints,
    gaugeFreeAxes,
    lastDeficiency,
    priorResiduals,
    cameraResidualScale: Array.from(problem.cameraScale),
    pairResidualScale: Array.from(problem.pairScale),
  };
}

/**
 * Per-camera variance components: how much worse each camera's correspondences
 * really are than its decode claimed.
 *
 * `decode.ts` estimates a correspondence's sigma from the photon and read noise
 * it can see inside one frame set. That is a genuine lower bound and nothing
 * more. A handheld capture adds an error the decoder is structurally blind to:
 * a 34-frame sequence at 20 fps takes 1.7 seconds, the lens moves a few
 * millimetres over that, and every frame-to-frame comparison the decode makes —
 * Gray bit against complement, phase step against phase step — is then reading a
 * slightly different scene. Measured against the simulator's ground truth, that
 * pushes the median decode error from 0.23 to 4.50 projector pixels while the
 * reported sigma barely moves.
 *
 * The residuals see it even though the decoder cannot, so the fit measures it:
 * the robust scale of each camera's own standardised residuals is how many times
 * worse that camera turned out to be. Scaling by it makes the weights reflect
 * what the data actually is, which is the entire content of a variance-component
 * estimate.
 *
 * Two deliberate constraints.
 *
 * **Floored at 1.** A camera is never allowed to claim it is BETTER than its
 * decode said. The unmodelled terms — motion, model error, fringe-order slips —
 * can only add variance, so a scale below 1 is a small-sample artefact, and
 * believing it would hand that camera weight it has not earned.
 *
 * **Per camera, not per correspondence and not per (camera, projector) pair.**
 * The cause is a camera that moved, so the camera is the group the physics
 * names. Going finer would fit the group structure to the residuals themselves —
 * with a pair-level scale, a projector seen by one camera could have that pair
 * down-weighted until its pose was determined by nothing.
 */
export function estimateVarianceComponents(
  problem: BundleProblem,
  norms: Float64Array,
  usable: readonly boolean[],
): Float64Array {
  const nCameras = problem.layout.nCameras;
  const out = new Float64Array(nCameras).fill(1);
  const buckets: number[][] = [];
  for (let c = 0; c < nCameras; c++) buckets.push([]);
  for (let i = 0; i < norms.length; i++) {
    if (problem.excluded[i] || !usable[i]) continue;
    const cam = problem.correspondences[i].camera;
    if (cam >= 0 && cam < nCameras) buckets[cam].push(norms[i]);
  }
  for (let c = 0; c < nCameras; c++) {
    // A camera with a handful of surviving correspondences has no estimable
    // scale; leaving it at 1 keeps its stated sigma rather than inventing one.
    if (buckets[c].length < 64) continue;
    // The residuals here are already multiplied by the CURRENT scale, so the
    // update is multiplicative: a camera sitting at 1.0 is where it should be.
    out[c] = Math.max(1, problem.cameraScale[c] * robustScaleFromNorms(buckets[c]));
  }
  return out;
}

/**
 * Per-pair coherence: how much of a (camera, projector) pair's residual is
 * structure rather than noise, as a sigma multiplier.
 *
 * See `PairCoherenceOptions` for the argument. The arithmetic:
 *
 *  1. Standardise each residual per axis by the pair's OWN robust scale on that
 *     axis. Not by the decode's stated sigma: a sigma that is uniformly too small
 *     is a VARIANCE error and belongs to `estimateVarianceComponents`, and if it
 *     reached this statistic the two would charge for the same excess twice. It
 *     is also what makes the estimate blind to the raster-aspect anisotropy — the
 *     decode's residual is 1920/1080 wider in `u` than in `v` because
 *     `patterns.ts` spends one Gray-plane count on both axes, and dividing each
 *     axis by its own scale removes that whether the decode declared it or not.
 *  2. Bin by position in the projector raster and take each cell's mean. A cell
 *     mean is blind to the decode's axis-aligned quantisation lattice, which is
 *     zero-mean inside any cell.
 *  3. `S = sum_k n_k |m_k|^2` has expectation `2K` and standard deviation
 *     `2 sqrt(K)` for `K` cells of independent unit-variance residuals. Soft
 *     threshold the excess at `significance` null sigmas.
 *  4. Turn the excess into an intraclass correlation and then into the design
 *     effect `1 + (nbar - 1) * rho`, and return its square root.
 *
 * In `specific` mode step 3 first subtracts, cell by cell, the mean of the OTHER
 * cameras looking at the same projector, and corrects for that estimate's own
 * variance. What survives cannot be a property of the projector.
 */
export function estimatePairCoherence(
  state: BundleState,
  problem: BundleProblem,
  ev: EvalResult,
): Float64Array {
  const { layout, opts, correspondences } = problem;
  const o = opts.pairCoherence;
  const nPairs = layout.nCameras * layout.nProjectors;
  const out = new Float64Array(nPairs).fill(1);
  if (o.mode === 'off' || nPairs === 0) return out;

  const g = Math.max(1, Math.floor(o.cells));
  const cellsPerPair = g * g;

  // Pass 1: collect each live correspondence's pair, cell and per-axis residual.
  const pairOf: number[] = [];
  const cellOf: number[] = [];
  const du: number[] = [];
  const dv: number[] = [];
  for (let i = 0; i < correspondences.length; i++) {
    if (problem.excluded[i] || !ev.usable[i]) continue;
    const corr = correspondences[i];
    const proj = state.projectors[corr.projector];
    if (!proj || !(proj.resX > 0) || !(proj.resY > 0)) continue;
    const a = ev.raw[2 * i];
    const b = ev.raw[2 * i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const cu = Math.min(g - 1, Math.max(0, Math.floor((corr.projU / proj.resX) * g)));
    const cv = Math.min(g - 1, Math.max(0, Math.floor((corr.projV / proj.resY) * g)));
    pairOf.push(corr.camera * layout.nProjectors + corr.projector);
    cellOf.push(cv * g + cu);
    du.push(a);
    dv.push(b);
  }

  // Pass 2: each pair's own robust scale per axis. Dividing by this rather than
  // by the decode's stated sigma is what keeps this statistic about STRUCTURE.
  // A pair whose sigma is uniformly too small — including too small on one axis
  // only, which is what the raster-aspect anisotropy looks like — has a variance
  // problem, and `estimateVarianceComponents` is where variance is priced.
  const absU: number[][] = [];
  const absV: number[][] = [];
  for (let p = 0; p < nPairs; p++) {
    absU.push([]);
    absV.push([]);
  }
  for (let i = 0; i < pairOf.length; i++) {
    absU[pairOf[i]].push(Math.abs(du[i]));
    absV[pairOf[i]].push(Math.abs(dv[i]));
  }
  // median(|N(0, s)|) = 0.6745 s.
  const HALF_NORMAL = 0.674489750196082;
  const scaleU = new Float64Array(nPairs);
  const scaleV = new Float64Array(nPairs);
  for (let p = 0; p < nPairs; p++) {
    if (absU[p].length < 2 * o.minCell) continue;
    scaleU[p] = median(absU[p]) / HALF_NORMAL;
    scaleV[p] = median(absV[p]) / HALF_NORMAL;
  }

  // Pass 3: cell sums of the doubly-standardised residual, per pair and per
  // projector. The projector sums are what `specific` mode's consensus reads.
  //
  // A known weakness of that consensus, stated because it is the mode that
  // measured WORSE: each pair contributes in its OWN noise units, so averaging
  // across cameras mixes scales, and the cameras of one projector overlap only
  // where their views do — a cell one camera covers well may be empty for its
  // neighbours, which is why cells with too little consensus are skipped rather
  // than compared. Both are reasons to distrust `specific`, and the paired
  // measurement in docs/PHASE-1.md says to.
  const pairN = new Int32Array(nPairs * cellsPerPair);
  const pairU = new Float64Array(nPairs * cellsPerPair);
  const pairV = new Float64Array(nPairs * cellsPerPair);
  const projN = new Int32Array(layout.nProjectors * cellsPerPair);
  const projU = new Float64Array(layout.nProjectors * cellsPerPair);
  const projV = new Float64Array(layout.nProjectors * cellsPerPair);
  for (let i = 0; i < pairOf.length; i++) {
    const pair = pairOf[i];
    if (!(scaleU[pair] > 0) || !(scaleV[pair] > 0)) continue;
    const zu = du[i] / scaleU[pair];
    const zv = dv[i] / scaleV[pair];
    const pi = pair * cellsPerPair + cellOf[i];
    pairN[pi]++;
    pairU[pi] += zu;
    pairV[pi] += zv;
    const gi = (pair % layout.nProjectors) * cellsPerPair + cellOf[i];
    projN[gi]++;
    projU[gi] += zu;
    projV[gi] += zv;
  }

  for (let pair = 0; pair < nPairs; pair++) {
    const projector = pair % layout.nProjectors;
    let s = 0;
    let k = 0;
    let n = 0;
    for (let cell = 0; cell < cellsPerPair; cell++) {
      const pi = pair * cellsPerPair + cell;
      const nk = pairN[pi];
      if (nk < o.minCell) continue;
      let mu = pairU[pi] / nk;
      let mv = pairV[pi] / nk;
      let extra = 0;
      if (o.mode === 'specific') {
        const gi = projector * cellsPerPair + cell;
        const on = projN[gi] - nk;
        if (on < o.minCell) continue;
        mu -= (projU[gi] - pairU[pi]) / on;
        mv -= (projV[gi] - pairV[pi]) / on;
        // The consensus is itself an average of `on` noisy samples, so it adds
        // `1/on` of variance per axis to the difference. Charging the pair for
        // the estimator's own noise would inflate every pair a little, which is
        // exactly the failure the significance floor exists to prevent.
        extra = (2 * nk) / on;
      }
      s += nk * (mu * mu + mv * mv) - extra;
      n += nk;
      k++;
    }
    if (k < 2 || n <= 0) continue;
    // Expectation 2K, standard deviation 2*sqrt(K), under independence.
    const excess = s - 2 * k - o.significance * 2 * Math.sqrt(k);
    if (!(excess > 0)) continue;
    const tau2 = excess / n;
    const rho = tau2 / (1 + tau2);
    const nbar = n / k;
    const deff = 1 + (nbar - 1) * rho;
    // Absolute, not multiplicative: the statistic is computed on residuals
    // divided by the pair's OWN scale, so it does not see the weight the last
    // pass assigned. `estimateVarianceComponents` is multiplicative for exactly
    // the opposite reason — its residuals arrive already scaled by it.
    out[pair] = Math.min(o.maxScale, Math.max(1, Math.sqrt(deff)));
  }
  return out;
}

/**
 * Fit, reject outliers, refit.
 *
 * The rejection happens between complete LM runs rather than inside the loop.
 * Rejecting mid-descent makes the objective discontinuous and the LM's
 * accept/reject test meaningless — the cost can drop purely because a point
 * left the problem. Separating the passes keeps each LM run minimising a fixed
 * objective, which is the only version whose convergence report can be believed.
 */
export function runBundle(
  initial: BundleState,
  correspondences: readonly Correspondence[],
  floor: readonly FloorReference[],
  options: Partial<BundleOptions> = {},
  /**
   * Layout the reported frame should be anchored to, along the rotational
   * directions that turn out to be unobservable. Normally the PARAMETERS.md
   * nominal rig. Omit to report in whatever frame the initialisation was in.
   */
  gaugeReference?: BundleState,
  priors: readonly ParameterPrior[] = [],
): BundleReport {
  const opts: BundleOptions = {
    ...DEFAULT_BUNDLE_OPTIONS,
    ...options,
    free: { ...DEFAULT_FREE_FLAGS, ...(options.free ?? {}) },
    gauge: { ...DEFAULT_GAUGE_OPTIONS, ...(options.gauge ?? {}) },
    loss: { ...DEFAULT_ROBUST_OPTIONS, ...(options.loss ?? {}) },
    pairCoherence: { ...DEFAULT_PAIR_COHERENCE, ...(options.pairCoherence ?? {}) },
  };
  const problem = buildProblem(initial, correspondences, floor, opts, priors);

  let report = levenbergMarquardt(initial, problem);
  let totalIterations = report.iterations;

  for (let pass = 0; pass < opts.rejectionPasses; pass++) {
    const ev = evaluate(report.state, problem, false);
    // A correspondence whose ray no longer meets the sphere is not an outlier
    // to be scored, it is unusable; fold it into the exclusion set directly.
    const priorExcluded = problem.excluded.map((e, i) => e || !ev.usable[i]);

    // Variance components first, rejection second, and the order matters: the
    // rejection threshold is stated in standardised units, so it means one thing
    // when a camera's sigma is right and another when it is three times too
    // small. Re-estimating between complete LM runs rather than inside one keeps
    // each run minimising a fixed objective, which is the same reason the
    // rejection lives here.
    let scaleChanged = false;
    if (opts.varianceComponents) {
      const next = estimateVarianceComponents(problem, ev.norms, ev.usable);
      for (let c = 0; c < next.length; c++) {
        if (Math.abs(next[c] - problem.cameraScale[c]) > 1e-3 * problem.cameraScale[c]) {
          scaleChanged = true;
        }
        problem.cameraScale[c] = next[c];
      }
    }
    // Pair coherence AFTER the camera term, and measured on residuals already
    // standardised by it, so the two do not both charge for the same excess.
    if (opts.pairCoherence.mode !== 'off') {
      const next = estimatePairCoherence(report.state, problem, ev);
      for (let k = 0; k < next.length; k++) {
        if (Math.abs(next[k] - problem.pairScale[k]) > 1e-3 * problem.pairScale[k]) {
          scaleChanged = true;
        }
        problem.pairScale[k] = next[k];
      }
    }

    const rejEv = scaleChanged ? evaluate(report.state, problem, false) : ev;
    // Rejection is judged WITHOUT the pair-coherence inflation, and that
    // separation is not a detail. The two mechanisms answer different questions:
    // the pair scale asks how much to trust a pair as a whole, the rejection
    // pass asks whether one correspondence is a gross error — a slipped fringe
    // order, a misread Gray word. Letting the pair scale into the rejection
    // statistic makes them fight: inflating a biased pair's sigma shrinks its
    // standardised residuals, the robust scale falls, the threshold floors at
    // `rejectFloor`, and the pass stops discarding anything at all. Measured on
    // s04-handheld, that took rejections from 661 to 69 — the estimator declared
    // a pair untrustworthy and thereby made the solver keep MORE of it.
    // Multiplying the norms back by the pair scale undoes it exactly, since both
    // axes carry the same factor.
    const rejNorms = Float64Array.from(rejEv.norms);
    if (opts.pairCoherence.mode !== 'off') {
      const nProj = problem.layout.nProjectors;
      for (let i = 0; i < rejNorms.length; i++) {
        const corr = problem.correspondences[i];
        rejNorms[i] *= problem.pairScale[corr.camera * nProj + corr.projector];
      }
    }
    const rej = rejectOutliers(rejNorms, opts.loss, priorExcluded);
    let changed = false;
    for (let i = 0; i < problem.excluded.length; i++) {
      const next = !rej.keep[i];
      if (next !== problem.excluded[i]) changed = true;
      problem.excluded[i] = next;
    }
    if (!changed && !scaleChanged) break;
    report = levenbergMarquardt(report.state, problem);
    totalIterations += report.iterations;
  }

  if (gaugeReference && opts.gauge.mode === 'inner') {
    const aligned = alignGaugeToReference(
      report.state,
      gaugeReference,
      report.gaugeFreeAxes,
      floor,
    );
    // Re-derive the report from the aligned state. The correspondence residuals
    // are invariant under the rotation, so this cannot change the fit; it is
    // done rather than assumed so that a mistake in `alignGaugeToReference`
    // would show up as a jump in the reported RMS instead of hiding.
    const ev = evaluate(aligned, problem, false);
    const re = finishReport(
      aligned,
      problem,
      ev,
      totalIterations,
      report.converged,
      report.stopReason,
      report.gaugeConstraints,
      report.gaugeFreeAxes,
      report.lastDeficiency,
    );
    return re;
  }

  report.iterations = totalIterations;
  return report;
}
