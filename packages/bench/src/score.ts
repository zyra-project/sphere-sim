/**
 * Ground-truth scoring: what the simulator knows, measured against what the
 * solver found.
 *
 * ## The gauge, and why the raw number is not the answer
 *
 * docs/AMENDMENTS.md A-09, and the gauge section of `packages/solver/README.md`,
 * both say the same thing: rotate every projector and every camera about the
 * sphere centre by one common rotation and every structured-light residual is
 * unchanged. The sphere is rotationally symmetric and no projected Gray code
 * references its texture, so those degrees of freedom are unobservable to ANY
 * solver. Comparing recovered orientations to ground truth in raw world
 * coordinates measures that gauge, not the calibration.
 *
 * So scoring aligns first. Two details matter and both are easy to get wrong in
 * the flattering direction:
 *
 *  1. **Only the unobservable axes are aligned away.** The solver reports which
 *     ones those are in `gaugeFreeAxes`, and it MEASURES rather than assumes
 *     them: with three or more floor references a rig tilt changes the predicted
 *     heights and becomes genuinely observable, so only azimuth is free. A
 *     bench that always ran an unconstrained three-degree-of-freedom fit would
 *     quietly absorb real tilt error into "the gauge" precisely in the
 *     configuration PARAMETERS.md §8 item 1 asks operators to capture. The
 *     unconstrained fit is computed too and reported beside it, so the size of
 *     what would have been absorbed is visible rather than implied.
 *  2. **Position is scored after the same rotation.** A global rotation moves
 *     positions as well as orientations; scoring position before and rotation
 *     after would be scoring two different rigs.
 *
 * Pre-alignment numbers are reported in full. A reader who thinks the alignment
 * is too generous can read the raw column and draw their own conclusion, which
 * is the only reason to publish a number you are arguing against.
 *
 * ## Which frame the geometric metrics see
 *
 * Grid-line displacement — the one scored geometric gate — is *gauge
 * invariant*: it localises each projector's own copy of a line and reports the
 * gap between them, and a common rotation moves both copies together. So the
 * choice of frame cannot change the verdict. It does change the registration
 * error, which is an absolute placement measurement, so the metrics are computed
 * against the gauge-aligned rig and the reason is stated in the result: the
 * unobservable rotation is exactly what PARAMETERS.md §1's `theta_rot`
 * (class CFG, "sites rotate the sphere mechanically") absorbs in deployment.
 * Charging the solver for it would be charging it for a frame convention.
 */

import type { RigCalibration, Vec3 } from '../../calibration/src/index.ts';
import { projectorRotationMatrix } from '../../sim/src/geometry.ts';
import type { Mat3 } from '../../sim/src/vec.ts';
import { RAD2DEG, matMul, matVec, wrapDeg180 } from '../../sim/src/vec.ts';

// ---------------------------------------------------------------------------
// Small rotation utilities — the bench's own
// ---------------------------------------------------------------------------

/**
 * Euler angles from a rotation matrix, inverting conventions.ts §R.
 *
 * §R is `R = Rz(yaw) * Ry(-pitch) * Rx(roll)`. Expanding it gives
 *
 *     R[2][0] = sin(pitch)
 *     R[0][0] = cos(yaw)cos(pitch),  R[1][0] = sin(yaw)cos(pitch)
 *     R[2][1] = cos(pitch)sin(roll), R[2][2] = cos(pitch)cos(roll)
 *
 * which is the inversion below. Derived here rather than imported from either
 * model: this is the bench's own reading of §R, and it is checked against
 * `packages/sim`'s forward `projectorRotationMatrix` by a round-trip test. If
 * the bench misread the convention the round trip fails, rather than the error
 * silently becoming part of a recovery score.
 *
 * At |pitch| = 90 degrees yaw and roll degenerate into one angle. No rig in
 * PARAMETERS.md §2 comes within 80 degrees of that, but a sweep could, so the
 * degenerate branch puts the whole rotation into yaw rather than returning NaN.
 */
export function eulerFromMatrix(m: Mat3): { yawDeg: number; pitchDeg: number; rollDeg: number } {
  const sinPitch = Math.max(-1, Math.min(1, m[6]));
  const cosPitch = Math.sqrt(Math.max(0, 1 - sinPitch * sinPitch));
  if (cosPitch < 1e-9) {
    return {
      yawDeg: Math.atan2(-m[1], m[4]) * RAD2DEG,
      pitchDeg: Math.asin(sinPitch) * RAD2DEG,
      rollDeg: 0,
    };
  }
  return {
    yawDeg: Math.atan2(m[3], m[0]) * RAD2DEG,
    pitchDeg: Math.asin(sinPitch) * RAD2DEG,
    rollDeg: Math.atan2(m[7], m[8]) * RAD2DEG,
  };
}

/** Rodrigues: the rotation matrix of an axis-angle vector. */
export function rodrigues(wx: number, wy: number, wz: number): Mat3 {
  const theta = Math.hypot(wx, wy, wz);
  if (theta < 1e-15) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const kx = wx / theta;
  const ky = wy / theta;
  const kz = wz / theta;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  return [
    t * kx * kx + c,
    t * kx * ky - s * kz,
    t * kx * kz + s * ky,
    t * kx * ky + s * kz,
    t * ky * ky + c,
    t * ky * kz - s * kx,
    t * kx * kz - s * ky,
    t * ky * kz + s * kx,
    t * kz * kz + c,
  ];
}

/** Angle of the relative rotation between two orientations, degrees. */
export function rotationAngleDeg(a: Mat3, b: Mat3): number {
  // trace(a * b^T) is the sum of the elementwise products, so the 3x3 product
  // is never formed. The angle of the relative rotation follows from
  // trace(R) = 1 + 2*cos(theta).
  const trace =
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2] +
    a[3] * b[3] + a[4] * b[4] + a[5] * b[5] +
    a[6] * b[6] + a[7] * b[7] + a[8] * b[8];
  return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * RAD2DEG;
}

/** Axis and angle of a rotation matrix, for reporting what the gauge absorbed. */
export function axisAngleOf(m: Mat3): { axis: Vec3; angleDeg: number } {
  const trace = m[0] + m[4] + m[8];
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  const s = Math.sin(angle);
  if (Math.abs(s) < 1e-12) return { axis: { x: 0, y: 0, z: 1 }, angleDeg: angle * RAD2DEG };
  // Explicitly normalised. The `(m[7]-m[5]) / (2 sin theta)` form is a unit
  // vector in exact arithmetic and is not one in floating point for the
  // sub-milliradian angles a gauge produces, where both numerator and
  // denominator are tiny; a reported axis of length 1.00009 is a small thing
  // that makes a reader distrust the rest of the block.
  const x = (m[7] - m[5]) / (2 * s);
  const y = (m[2] - m[6]) / (2 * s);
  const z = (m[3] - m[1]) / (2 * s);
  const n = Math.hypot(x, y, z) || 1;
  return { axis: { x: x / n, y: y / n, z: z / n }, angleDeg: angle * RAD2DEG };
}

// ---------------------------------------------------------------------------
// Gauge alignment
// ---------------------------------------------------------------------------

/**
 * The rotation about the sphere centre that best carries `from` onto `to`,
 * restricted to the axes marked free.
 *
 * NOT a Kabsch fit, and not because Kabsch is wrong. Kabsch answers the
 * unconstrained question, and the question here is usually constrained: with
 * enough floor references only the azimuth is a gauge, and an unconstrained fit
 * would tilt the recovered rig to hide a tilt error the data actually
 * determined. Restricting a closed-form fit to a subspace is awkward; iterating
 * on a small-angle correction is not, and the same routine then serves the free
 * case exactly (it converges to the Kabsch answer) and the one- and two-axis
 * cases without a second code path.
 *
 * Each step linearises `R <- exp([w] x) R` about the current estimate. With
 * `a_i = R p_i` the residual becomes `(a_i - q_i) - [a_i]x w`, a linear least
 * squares in `w` whose normal matrix is 3x3 and whose free rows and columns are
 * simply deleted. Five steps is far more than the two or three it takes to
 * converge from identity for the sub-degree rotations a gauge produces.
 *
 * NO centroid subtraction. The gauge is a rotation about the sphere CENTRE,
 * which conventions.ts §W fixes at the world origin; recentring on the
 * projectors' centroid would fit a rotation about the wrong point and leave a
 * translation the sphere had already pinned.
 */
export function fitGlobalRotation(
  from: readonly Vec3[],
  to: readonly Vec3[],
  freeAxes: readonly boolean[],
): Mat3 {
  const cols: number[] = [];
  for (let i = 0; i < 3; i++) if (freeAxes[i]) cols.push(i);
  let r: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (cols.length === 0 || from.length === 0) return r;

  for (let iter = 0; iter < 5; iter++) {
    // Full 3x3 normal equations, then extract the free sub-block.
    const ata = new Float64Array(9);
    const atb = new Float64Array(3);
    for (let i = 0; i < from.length; i++) {
      const a = matVec(r, from[i]);
      const q = to[i];
      const rx = a.x - q.x;
      const ry = a.y - q.y;
      const rz = a.z - q.z;
      // The residual linearises to `r - M w` with `M = [a]x`, because
      // `w x a = -[a]x w`. Writing the cross-product matrix with the wrong sign
      // here is silent and vicious: the normal matrix `M^T M` is unchanged, so
      // the solve succeeds, `w` comes out negated, and five iterations then
      // drive the fit AWAY from the truth. It showed up as a six-degree gauge on
      // a rig whose raw pose error was under a degree.
      const m = [
        [0, -a.z, a.y],
        [a.z, 0, -a.x],
        [-a.y, a.x, 0],
      ];
      for (let p = 0; p < 3; p++) {
        for (let q2 = 0; q2 < 3; q2++) {
          ata[p * 3 + q2] += m[0][p] * m[0][q2] + m[1][p] * m[1][q2] + m[2][p] * m[2][q2];
        }
        atb[p] += m[0][p] * rx + m[1][p] * ry + m[2][p] * rz;
      }
    }

    const n = cols.length;
    const a = new Float64Array(n * n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      b[i] = atb[cols[i]];
      for (let j = 0; j < n; j++) a[i * n + j] = ata[cols[i] * 3 + cols[j]];
      // A whisper of ridge so a genuinely degenerate direction returns zero
      // rather than a NaN that would poison every downstream number.
      a[i * n + i] += 1e-12;
    }
    const sol = solveSmall(a, b, n);
    if (sol === null) break;
    const w = [0, 0, 0];
    for (let i = 0; i < n; i++) w[cols[i]] = sol[i];
    if (Math.hypot(w[0], w[1], w[2]) < 1e-15) break;
    r = matMul(rodrigues(w[0], w[1], w[2]), r);
  }
  return r;
}

/** Gaussian elimination with partial pivoting on an n x n system, n <= 3. */
function solveSmall(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = Float64Array.from(a);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row * n + col]) > Math.abs(m[pivot * n + col])) pivot = row;
    }
    if (Math.abs(m[pivot * n + col]) < 1e-18) return null;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const t = m[col * n + k];
        m[col * n + k] = m[pivot * n + k];
        m[pivot * n + k] = t;
      }
      const t = x[col];
      x[col] = x[pivot];
      x[pivot] = t;
    }
    for (let row = col + 1; row < n; row++) {
      const f = m[row * n + col] / m[col * n + col];
      if (f === 0) continue;
      for (let k = col; k < n; k++) m[row * n + k] -= f * m[col * n + k];
      x[row] -= f * x[col];
    }
  }
  for (let row = n - 1; row >= 0; row--) {
    let s = x[row];
    for (let k = row + 1; k < n; k++) s -= m[row * n + k] * x[k];
    x[row] = s / m[row * n + row];
  }
  return x;
}

/** Rotate a whole rig about the sphere centre. */
export function applyGlobalRotation(rig: RigCalibration, r: Mat3): RigCalibration {
  return {
    ...rig,
    sphere: { ...rig.sphere },
    blend: { ...rig.blend },
    framebuffer: { ...rig.framebuffer },
    projectors: rig.projectors.map((p) => {
      const composed = matMul(r, projectorRotationMatrix(p.pose));
      const e = eulerFromMatrix(composed);
      return {
        ...p,
        pose: {
          position: matVec(r, p.pose.position),
          yawDeg: e.yawDeg,
          pitchDeg: e.pitchDeg,
          rollDeg: e.rollDeg,
        },
        intrinsics: { ...p.intrinsics },
        transfer: {
          gamma: { ...p.transfer.gamma },
          blackFloor: { ...p.transfer.blackFloor },
          gain: { ...p.transfer.gain },
          whitePointK: p.transfer.whitePointK,
        },
        viewport: { ...p.viewport },
      };
    }),
  };
}

export interface EntityPose {
  position: Vec3;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface GaugeReport {
  /** Which world axes the solver reported as unobservable. */
  freeAxes: boolean[];
  /** Entities whose positions were used for the fit. */
  entities: number;
  /** Rotation applied, expressed as an axis and an angle. */
  angleDeg: number;
  axis: Vec3;
  /**
   * The same fit with all three axes free. Larger than `angleDeg` whenever the
   * constrained fit left something on the table — which is exactly the tilt the
   * floor references made observable, and exactly what an unconstrained score
   * would have hidden.
   */
  unconstrainedAngleDeg: number;
}

export interface GaugeAlignment {
  rotation: Mat3;
  report: GaugeReport;
}

/**
 * Fit the gauge from projector AND camera positions.
 *
 * Cameras are included because they are part of the same free network: the
 * global rotation moved them too, and with one or two projectors the projectors
 * alone can leave the fit poorly conditioned. They are ground truth the bench
 * holds and the solver never saw, so using them costs nothing in honesty.
 */
export function alignGauge(
  recovered: RigCalibration,
  recoveredCameras: readonly EntityPose[],
  truth: RigCalibration,
  truthCameras: readonly EntityPose[],
  gaugeFreeAxes: readonly boolean[],
): GaugeAlignment {
  const from: Vec3[] = [];
  const to: Vec3[] = [];
  for (let i = 0; i < recovered.projectors.length && i < truth.projectors.length; i++) {
    from.push(recovered.projectors[i].pose.position);
    to.push(truth.projectors[i].pose.position);
  }
  for (let i = 0; i < recoveredCameras.length && i < truthCameras.length; i++) {
    from.push(recoveredCameras[i].position);
    to.push(truthCameras[i].position);
  }
  const rotation = fitGlobalRotation(from, to, gaugeFreeAxes);
  const unconstrained = fitGlobalRotation(from, to, [true, true, true]);
  const aa = axisAngleOf(rotation);
  return {
    rotation,
    report: {
      freeAxes: [...gaugeFreeAxes],
      entities: from.length,
      angleDeg: aa.angleDeg,
      axis: aa.axis,
      unconstrainedAngleDeg: axisAngleOf(unconstrained).angleDeg,
    },
  };
}

// ---------------------------------------------------------------------------
// Pose and intrinsics error
// ---------------------------------------------------------------------------

export interface ProjectorPoseError {
  id: string;
  positionMm: number;
  rotationDeg: number;
  /** Component errors, for reading which degree of freedom moved. */
  dxMm: number;
  dyMm: number;
  dzMm: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface PoseErrorSet {
  perProjector: ProjectorPoseError[];
  maxPositionMm: number;
  maxRotationDeg: number;
  rmsPositionMm: number;
  rmsRotationDeg: number;
}

export function poseErrors(recovered: RigCalibration, truth: RigCalibration): PoseErrorSet {
  const perProjector: ProjectorPoseError[] = [];
  let sumP = 0;
  let sumR = 0;
  let maxP = 0;
  let maxR = 0;
  const n = Math.min(recovered.projectors.length, truth.projectors.length);
  for (let i = 0; i < n; i++) {
    const a = recovered.projectors[i].pose;
    const b = truth.projectors[i].pose;
    const dx = (a.position.x - b.position.x) * 1000;
    const dy = (a.position.y - b.position.y) * 1000;
    const dz = (a.position.z - b.position.z) * 1000;
    const positionMm = Math.hypot(dx, dy, dz);
    const rotationDeg = rotationAngleDeg(projectorRotationMatrix(a), projectorRotationMatrix(b));
    perProjector.push({
      id: truth.projectors[i].id,
      positionMm,
      rotationDeg,
      dxMm: dx,
      dyMm: dy,
      dzMm: dz,
      yawDeg: wrapDeg180(a.yawDeg - b.yawDeg),
      pitchDeg: wrapDeg180(a.pitchDeg - b.pitchDeg),
      rollDeg: wrapDeg180(a.rollDeg - b.rollDeg),
    });
    sumP += positionMm * positionMm;
    sumR += rotationDeg * rotationDeg;
    // `Math.max`, not `if (x > max)`. Every comparison against NaN is false, so
    // the guarded form SKIPS a non-finite projector and leaves the maximum at
    // the largest finite value it happened to see — a diverged bundle would
    // report a small, passing `pose_position` while its own `perProjector`
    // entry read NaN, and the RMS beside it would already be NaN because
    // `sumP` is not comparison-guarded. `Math.max` propagates it and keeps it
    // propagated, which is what `cameraErrors` and `intrinsicsErrors` below
    // already do; `buildRecoveryGates` then counts a non-finite value as both
    // failed and unmeasured rather than scoring it.
    maxP = Math.max(maxP, positionMm);
    maxR = Math.max(maxR, rotationDeg);
  }
  return {
    perProjector,
    maxPositionMm: maxP,
    maxRotationDeg: maxR,
    rmsPositionMm: n > 0 ? Math.sqrt(sumP / n) : NaN,
    rmsRotationDeg: n > 0 ? Math.sqrt(sumR / n) : NaN,
  };
}

export interface ProjectorIntrinsicsError {
  id: string;
  fovHDeg: number;
  shiftH: number;
  shiftV: number;
  k1: number;
  k2: number;
}

export interface IntrinsicsErrorSet {
  perProjector: ProjectorIntrinsicsError[];
  maxFovHDeg: number;
  maxShift: number;
  maxK1: number;
  maxK2: number;
}

/**
 * Intrinsics recovery. Signed per projector, absolute in the maxima.
 *
 * PARAMETERS.md §7 sets no gate on any of these, so nothing here is scored.
 * They are reported because §3.1 says `k1, k2` is "what SOS's manual Vertex
 * Tweaking stage compensates by hand", and recovering it is the claim that
 * collapses their three stages into one. A claim with no number attached is
 * marketing.
 */
export function intrinsicsErrors(
  recovered: RigCalibration,
  truth: RigCalibration,
): IntrinsicsErrorSet {
  const perProjector: ProjectorIntrinsicsError[] = [];
  let maxFov = 0;
  let maxShift = 0;
  let maxK1 = 0;
  let maxK2 = 0;
  const n = Math.min(recovered.projectors.length, truth.projectors.length);
  for (let i = 0; i < n; i++) {
    const a = recovered.projectors[i].intrinsics;
    const b = truth.projectors[i].intrinsics;
    const e: ProjectorIntrinsicsError = {
      id: truth.projectors[i].id,
      fovHDeg: a.fovHDeg - b.fovHDeg,
      shiftH: a.shiftH - b.shiftH,
      shiftV: a.shiftV - b.shiftV,
      k1: a.k1 - b.k1,
      k2: a.k2 - b.k2,
    };
    perProjector.push(e);
    maxFov = Math.max(maxFov, Math.abs(e.fovHDeg));
    maxShift = Math.max(maxShift, Math.abs(e.shiftH), Math.abs(e.shiftV));
    maxK1 = Math.max(maxK1, Math.abs(e.k1));
    maxK2 = Math.max(maxK2, Math.abs(e.k2));
  }
  return { perProjector, maxFovHDeg: maxFov, maxShift, maxK1, maxK2 };
}

export interface CameraPoseError {
  id: string;
  positionMm: number;
  rotationDeg: number;
}

export function cameraErrors(
  recovered: readonly EntityPose[],
  truth: readonly EntityPose[],
  ids: readonly string[],
): { perCamera: CameraPoseError[]; maxPositionMm: number; maxRotationDeg: number } {
  const perCamera: CameraPoseError[] = [];
  let maxP = 0;
  let maxR = 0;
  for (let i = 0; i < Math.min(recovered.length, truth.length); i++) {
    const a = recovered[i];
    const b = truth[i];
    const positionMm =
      Math.hypot(
        a.position.x - b.position.x,
        a.position.y - b.position.y,
        a.position.z - b.position.z,
      ) * 1000;
    const rotationDeg = rotationAngleDeg(
      projectorRotationMatrix({ position: a.position, yawDeg: a.yawDeg, pitchDeg: a.pitchDeg, rollDeg: a.rollDeg }),
      projectorRotationMatrix({ position: b.position, yawDeg: b.yawDeg, pitchDeg: b.pitchDeg, rollDeg: b.rollDeg }),
    );
    perCamera.push({ id: ids[i] ?? `C${i + 1}`, positionMm, rotationDeg });
    maxP = Math.max(maxP, positionMm);
    maxR = Math.max(maxR, rotationDeg);
  }
  return { perCamera, maxPositionMm: maxP, maxRotationDeg: maxR };
}

// ---------------------------------------------------------------------------
// The whole recovery score
// ---------------------------------------------------------------------------

export interface CenterHeightScore {
  trueM: number;
  recoveredM: number;
  errorMm: number;
  /** False when no floor reference was supplied, so it was held, not solved. */
  observed: boolean;
  /** The documented nominal, for scale: §1's remedy works in inches. */
  nominalM: number;
  documentedStepMm: number;
}

export interface RecoveryScore {
  /** Before any gauge alignment. Reported so the gauge's size is visible. */
  raw: PoseErrorSet;
  /** After removing the rotation the solver could not observe. Scored. */
  aligned: PoseErrorSet;
  gauge: GaugeReport;
  intrinsics: IntrinsicsErrorSet;
  /**
   * Camera pose error against the truth pose AT THE REFERENCE EPOCH when the
   * caller supplied one, and against the static pose otherwise. This is what
   * `camera_pose_rotation` scores.
   */
  cameras: { perCamera: CameraPoseError[]; maxPositionMm: number; maxRotationDeg: number };
  /**
   * The same error against the STATIC truth pose — the definition used until
   * round 4 — or null when no epoch pose was supplied and the two would be the
   * same numbers twice.
   *
   * Kept because the difference between the two columns is the size of the
   * definitional floor round 3's critic found, and a reader comparing this
   * round's camera numbers against an earlier round's needs the old definition
   * to compare against.
   */
  camerasStatic:
    | { perCamera: CameraPoseError[]; maxPositionMm: number; maxRotationDeg: number }
    | null;
  centerHeight: CenterHeightScore;
  /** The gauge-aligned recovered rig, for the metrics and the renders. */
  alignedRig: RigCalibration;
}

export interface ScoreInput {
  truthRig: RigCalibration;
  recoveredRig: RigCalibration;
  /** Where the cameras were placed. Static: the pose before any motion. */
  truthCameras: readonly EntityPose[];
  /**
   * Where each camera ACTUALLY WAS at the epoch the solver's reported pose
   * refers to — the mean of that camera's own correspondence epochs.
   *
   * This exists because scoring a moving camera's recovered pose against its
   * static placement is scoring against a quantity that no longer exists.
   * `packages/solver` centres each camera's pose on its own mean observation
   * epoch and says so; round 3 scored it against the static pose anyway, and
   * round 3's critic measured the consequence: on a motion archetype a PERFECT
   * solver scores 0.08 to 0.33 degrees against a 0.07 degree gate, and the
   * recovered values track that floor rather than the solver. A gate nothing can
   * reach is not a gate, and raising the threshold instead would have been
   * tuning. So the metric is corrected and the threshold is not.
   *
   * Omit for a static capture, where it is the same pose.
   */
  truthCamerasAtEpoch?: readonly EntityPose[];
  recoveredCameras: readonly EntityPose[];
  cameraIds: readonly string[];
  gaugeFreeAxes: readonly boolean[];
  centerHeightObserved: boolean;
  /** PARAMETERS.md §1 nominal, 2.1844 m. */
  nominalCenterHeightM: number;
}

export function scoreRecovery(input: ScoreInput): RecoveryScore {
  const raw = poseErrors(input.recoveredRig, input.truthRig);
  // The gauge is fitted against the same poses the cameras are scored against.
  // Using the static poses for the fit and the epoch poses for the score would
  // put a millimetre of the camera's own motion into the rig's frame, which is
  // small and is exactly the kind of small inconsistency that later turns up as
  // an unexplained bias.
  const truthCamerasScored = input.truthCamerasAtEpoch ?? input.truthCameras;
  const gauge = alignGauge(
    input.recoveredRig,
    input.recoveredCameras,
    input.truthRig,
    truthCamerasScored,
    input.gaugeFreeAxes,
  );
  const alignedRig = applyGlobalRotation(input.recoveredRig, gauge.rotation);
  const alignedCameras = input.recoveredCameras.map((c) => {
    const composed = matMul(
      gauge.rotation,
      projectorRotationMatrix({
        position: c.position,
        yawDeg: c.yawDeg,
        pitchDeg: c.pitchDeg,
        rollDeg: c.rollDeg,
      }),
    );
    const e = eulerFromMatrix(composed);
    return { position: matVec(gauge.rotation, c.position), ...e };
  });

  return {
    raw,
    aligned: poseErrors(alignedRig, input.truthRig),
    gauge: gauge.report,
    intrinsics: intrinsicsErrors(input.recoveredRig, input.truthRig),
    cameras: cameraErrors(alignedCameras, truthCamerasScored, input.cameraIds),
    camerasStatic:
      input.truthCamerasAtEpoch === undefined
        ? null
        : cameraErrors(alignedCameras, input.truthCameras, input.cameraIds),
    centerHeight: {
      trueM: input.truthRig.sphere.centerHeightM,
      recoveredM: input.recoveredRig.sphere.centerHeightM,
      errorMm: Math.abs(input.recoveredRig.sphere.centerHeightM - input.truthRig.sphere.centerHeightM) * 1000,
      observed: input.centerHeightObserved,
      nominalM: input.nominalCenterHeightM,
      // PARAMETERS.md §1: the documented remedy is "add or subtract an inch".
      documentedStepMm: 25.4,
    },
    alignedRig,
  };
}

// ---------------------------------------------------------------------------
// Hybrid calibrations, for attributing a gate failure
// ---------------------------------------------------------------------------

/**
 * Which group of recovered parameters to replace with ground truth.
 *
 * The loop protocol in docs/ARCHITECTURE.md says that when a metric fails, the
 * critic names the single largest contributor and that piece goes back. A
 * heuristic ranking — "the position error is 40x its gate and the rotation
 * error is 3x, so it must be position" — is a guess dressed as an attribution:
 * the metric is not linear in either, and the two interact.
 *
 * So the bench measures it instead. Substitute one group's ground truth into
 * the recovered calibration, recompute the failing metric, and see how much of
 * the failure goes away. The group whose substitution removes the most IS the
 * largest contributor, by construction rather than by argument. The `none` and
 * `all` bookends bound how much of the failure the six groups explain between
 * them; a large residual at `all` would mean the failure is not in the
 * calibration at all, which is a finding rather than a bug.
 */
export type HybridGroup =
  | 'none'
  | 'position'
  | 'rotation'
  | 'fov'
  | 'shift'
  | 'radial'
  | 'centerHeight'
  | 'all';

export const HYBRID_GROUPS: HybridGroup[] = [
  'none',
  'position',
  'rotation',
  'fov',
  'shift',
  'radial',
  'centerHeight',
  'all',
];

/** `recovered`, with one parameter group taken from `truth`. */
export function hybridCalibration(
  recovered: RigCalibration,
  truth: RigCalibration,
  group: HybridGroup,
): RigCalibration {
  if (group === 'none') return recovered;
  if (group === 'all') return truth;
  return {
    ...recovered,
    sphere: {
      ...recovered.sphere,
      centerHeightM:
        group === 'centerHeight' ? truth.sphere.centerHeightM : recovered.sphere.centerHeightM,
    },
    projectors: recovered.projectors.map((p, i) => {
      const t = truth.projectors[i] ?? p;
      return {
        ...p,
        pose: {
          position: group === 'position' ? { ...t.pose.position } : { ...p.pose.position },
          yawDeg: group === 'rotation' ? t.pose.yawDeg : p.pose.yawDeg,
          pitchDeg: group === 'rotation' ? t.pose.pitchDeg : p.pose.pitchDeg,
          rollDeg: group === 'rotation' ? t.pose.rollDeg : p.pose.rollDeg,
        },
        intrinsics: {
          ...p.intrinsics,
          fovHDeg: group === 'fov' ? t.intrinsics.fovHDeg : p.intrinsics.fovHDeg,
          shiftH: group === 'shift' ? t.intrinsics.shiftH : p.intrinsics.shiftH,
          shiftV: group === 'shift' ? t.intrinsics.shiftV : p.intrinsics.shiftV,
          k1: group === 'radial' ? t.intrinsics.k1 : p.intrinsics.k1,
          k2: group === 'radial' ? t.intrinsics.k2 : p.intrinsics.k2,
        },
      };
    }),
  };
}
