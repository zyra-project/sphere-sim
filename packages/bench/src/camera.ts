// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The observing camera, and the handheld motion that makes a rolling shutter
 * mean anything at all.
 *
 * ## Whose implementation of the camera is this?
 *
 * conventions.ts §C fixes the camera model — §R pose, §I/§D imaging, intrinsics
 * given directly as `fx, fy, cx, cy` — and says explicitly that whichever side
 * generates simulated camera images must adopt it. The camera is part of the
 * *forward* scene: it is apparatus standing in the room, not a property of the
 * installation. So its geometry is built out of `packages/sim`'s implementation
 * of §R and §D, not out of a third one written here.
 *
 * That choice is load bearing. If the bench re-derived Brown-Conrady for the
 * camera, a bug in the bench would look exactly like a solver failure, and the
 * A/B comparison the whole project rests on would be measuring the scorer. With
 * sim owning the forward camera there are exactly TWO independent
 * implementations of §D in the repo — sim's and the solver's — which is the
 * number the recovery score is supposed to compare.
 *
 * ## Rolling shutter is a no-op unless something moves
 *
 * A rolling shutter reads the sensor one row at a time. On a static scene
 * photographed by a static camera that is *provably* invisible: every row sees
 * the same world, so the image is identical to a global-shutter one. A bench
 * that offered "rolling shutter" as a switch and modelled only the readout would
 * therefore report a clean null result, and Experiment 1 would conclude that
 * rolling shutter costs nothing — a false negative produced entirely by the
 * apparatus.
 *
 * What actually happens in the field is a HANDHELD phone. The pose drifts, and
 * the drift interacts with the capture in two distinct ways that this module
 * keeps as separate switches so the experiment can attribute the effect:
 *
 *  1. **Between frames.** A structured-light sequence is dozens of frames. Every
 *     decode in `packages/solver/src/decode.ts` compares frames against each
 *     other — Gray bit against its complement, four phase steps against each
 *     other — and every one of those comparisons assumes the camera pixel is
 *     looking at the same surface point in both. Inter-frame drift breaks that
 *     assumption, and it does so with a GLOBAL shutter too.
 *  2. **Within a frame.** With a rolling shutter, row `r` is exposed at
 *     `r/height * readout` after row 0, so the pose varies down the frame and
 *     the image is sheared by whatever the camera did during the readout. This
 *     is the part that is genuinely rolling-shutter-specific.
 *
 * `HandheldMotion` supplies the motion; `FrameClock.rollingShutter` decides
 * whether (2) applies on top of (1). Set the motion to `null` and both are
 * exactly zero — `test/capture.test.ts` asserts that a rolling-shutter capture
 * of a static camera is byte-identical to a global-shutter one, so the no-op
 * case is a proven no-op rather than an assumed one, and asserts that switching
 * the motion on changes the decode. Neither assertion is decoration: they are
 * the difference between a measured null result and an unmeasured one.
 */

import type { ProjectorIntrinsics, Vec3 } from '../../calibration/src/index.ts';
import { projectorRotationMatrix } from '../../sim/src/geometry.ts';
import { invertDistortion } from '../../sim/src/optics.ts';
import type { Mat3 } from '../../sim/src/vec.ts';
import { DEG2RAD, RAD2DEG, matVec, normalize } from '../../sim/src/vec.ts';
import type { BenchRng } from './random.ts';

/**
 * Interior orientation of the observing camera, conventions.ts §C.
 *
 * Structurally identical to `packages/solver`'s `CameraIntrinsics` because §C
 * is what both are implementing. It is redeclared rather than imported so that
 * `capture.ts` does not have to reach into the solver for a *type* that
 * describes the forward model's apparatus — and so the field-by-field mapping
 * from bench camera to solver input is written out once, visibly, where a
 * missing field would be obvious.
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

/** Camera pose, conventions.ts §R — identical convention to a projector's. */
export interface CameraPose {
  position: Vec3;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface SimulatedCamera {
  id: string;
  intrinsics: CameraIntrinsics;
  /** Where the camera actually is. The solver never sees this. */
  pose: CameraPose;
  /** Height above the floor, metres — what a tape measure would read. */
  heightM: number;
}

/**
 * A plausible phone camera.
 *
 * PARAMETERS.md's experiment plan asks whether a phone suffices for a real
 * calibration, so the default apparatus is phone-shaped rather than
 * metrology-shaped: a moderately wide field and real barrel distortion. `k1` of
 * -0.09 is what a phone main camera looks like once the maker's own correction
 * is off, which is what a RAW capture gives you (§8: "RAW only").
 *
 * Modelling the distortion as zero would be the comfortable choice and the
 * dishonest one: it would delete the single largest systematic the solver has
 * to survive on the camera side, and conventions.ts §C warns that getting §D's
 * direction backwards produces a radially symmetric residual easily mistaken
 * for a focal-length error. A bench that never exercises it cannot catch that.
 */
export function phoneIntrinsics(
  resX: number,
  resY: number,
  fovHDeg = 62,
  k1 = -0.09,
  k2 = 0.02,
): CameraIntrinsics {
  const fx = resX / 2 / Math.tan((fovHDeg * DEG2RAD) / 2);
  return { resX, resY, fx, fy: fx, cx: resX / 2, cy: resY / 2, k1, k2, p1: 0, p2: 0 };
}

/**
 * Carrier for `sim`'s `invertDistortion`, which reads `k1, k2, p1, p2` and
 * nothing else.
 *
 * A camera's interior orientation is given directly as `fx, fy, cx, cy` (§C)
 * rather than through a field of view and a lens shift (§I), so the remaining
 * fields of `ProjectorIntrinsics` are inert here and are filled with values that
 * would be obviously wrong if anything ever started reading them. Passing a
 * carrier rather than reimplementing Newton's method keeps the count of §D
 * implementations in this repository at exactly two.
 */
function distortionCarrier(k: CameraIntrinsics): ProjectorIntrinsics {
  return {
    resX: k.resX,
    resY: k.resY,
    fovHDeg: Number.NaN,
    pixelAspect: Number.NaN,
    shiftH: Number.NaN,
    shiftV: Number.NaN,
    k1: k.k1,
    k2: k.k2,
    p1: k.p1,
    p2: k.p2,
  };
}

/**
 * The undistorted ray direction for every camera pixel, in the camera's
 * CANONICAL frame (before the pose rotation), as a flat `[x, y, z, ...]` array.
 *
 * Precomputed because it is the only expensive part of a camera ray — Newton's
 * method on the distortion — and it depends on the intrinsics alone. Under
 * handheld motion the pose changes for every frame and every row, but the
 * canonical directions never do, so this table is built once per camera and
 * reused across the whole capture. That is the difference between a handheld
 * scenario costing seconds and costing minutes.
 *
 * §I inverted: normalized `(x, y)` maps to the canonical direction
 * `axis + x*right + y*up` = `(1, -x, y)`, since §R's canonical frame is optical
 * axis `+X`, right `-Y`, up `+Z`. Left unnormalized on purpose — the caller
 * rotates first and normalizes once.
 */
export function canonicalRayTable(k: CameraIntrinsics): Float64Array {
  const carrier = distortionCarrier(k);
  const out = new Float64Array(k.resX * k.resY * 3);
  for (let py = 0; py < k.resY; py++) {
    for (let px = 0; px < k.resX; px++) {
      // conventions.ts §I: pixel centres sit at half-integer coordinates.
      const u = px + 0.5;
      const v = py + 0.5;
      const xd = (u - k.cx) / k.fx;
      const yd = (k.cy - v) / k.fy;
      const ideal = invertDistortion({ x: xd, y: yd }, carrier);
      const i = 3 * (py * k.resX + px);
      out[i] = 1;
      out[i + 1] = -ideal.x;
      out[i + 2] = ideal.y;
    }
  }
  return out;
}

/** Single-pixel form of {@link canonicalRayTable}, for tests and previews. */
export function cameraPixelToRay(cam: SimulatedCamera, u: number, v: number): Vec3 {
  const k = cam.intrinsics;
  const ideal = invertDistortion(
    { x: (u - k.cx) / k.fx, y: (k.cy - v) / k.fy },
    distortionCarrier(k),
  );
  return normalize(
    matVec(rotationOf(cam.pose), { x: 1, y: -ideal.x, z: ideal.y }),
  );
}

/** conventions.ts §R, via the forward model's own implementation. */
export function rotationOf(pose: CameraPose): Mat3 {
  return projectorRotationMatrix({
    position: pose.position,
    yawDeg: pose.yawDeg,
    pitchDeg: pose.pitchDeg,
    rollDeg: pose.rollDeg,
  });
}

/** Yaw and pitch that aim a camera at the sphere centre. Roll left to the caller. */
export function aimAt(position: Vec3, target: Vec3): { yawDeg: number; pitchDeg: number } {
  const dir = normalize({
    x: target.x - position.x,
    y: target.y - position.y,
    z: target.z - position.z,
  });
  return {
    yawDeg: Math.atan2(dir.y, dir.x) * RAD2DEG,
    // §R: the optical axis is column 0 of R, whose z component is sin(pitch).
    pitchDeg: Math.asin(Math.max(-1, Math.min(1, dir.z))) * RAD2DEG,
  };
}

// ---------------------------------------------------------------------------
// Camera placement
// ---------------------------------------------------------------------------

export interface CameraPlacementOptions {
  /** How many cameras. Experiment 1 sweeps 1 to 8. */
  count: number;
  /** Distance from the sphere centre, metres. PARAMETERS.md §6 `d_view`. */
  distanceM: number;
  /** Nominal height above the floor, metres. A tripod or a person holding a phone. */
  heightM: number;
  resX: number;
  resY: number;
  fovHDeg: number;
  k1: number;
  k2: number;
  /** Seeded scatter on the placement, metres and degrees. */
  positionJitterM: number;
  aimJitterDeg: number;
  rollJitterDeg: number;
  /** Peak-to-peak variation in height across the set, metres. */
  heightSpreadM: number;
}

/**
 * Place `count` cameras around the sphere.
 *
 * Three deliberate choices, each with a failure mode behind it:
 *
 *  - **Azimuths are offset from the projector azimuths.** A camera standing on
 *    a projector's own meridian sees that projector's footprint almost
 *    face-on and shares its viewing direction, which is the degenerate geometry
 *    for triangulating that projector's distance. The offset is a quarter of the
 *    inter-camera spacing plus a fixed 25.7 degrees, so no camera lands on a
 *    projector meridian or on a seam for any count from 1 to 8.
 *  - **Heights vary across the set.** Cameras all at one height are coplanar
 *    with each other and (at PARAMETERS.md §2's nominal `h_proj`) with the
 *    projectors too. A coplanar network is exactly where a naive Kabsch
 *    alignment and a rank-deficient normal matrix both misbehave, and a bench
 *    that never produced a non-coplanar network would never exercise either.
 *  - **Everything is jittered from a seed.** An operator does not put a tripod
 *    on a surveyed mark. The jitter is what makes the recovered camera poses a
 *    real unknown rather than a decoration.
 *
 * Distances stay inside §6's 2.0-3.5 m band, which is bounded below by the
 * guard rail.
 */
export function placeCameras(
  opts: CameraPlacementOptions,
  centerHeightM: number,
  rng: BenchRng,
): SimulatedCamera[] {
  const out: SimulatedCamera[] = [];
  for (let i = 0; i < opts.count; i++) {
    const baseAz = (360 * i) / opts.count + 25.714 + 90 / Math.max(1, opts.count);
    const az = (baseAz + rng.normal(0, opts.aimJitterDeg)) * DEG2RAD;
    // Alternate above and below the nominal height so the set is never planar.
    const heightOffset =
      opts.count === 1 ? 0 : opts.heightSpreadM * ((i % 2 === 0 ? 1 : -1) * (0.5 - i / (4 * opts.count)));
    const heightM = opts.heightM + heightOffset + rng.normal(0, opts.positionJitterM);
    const z = heightM - centerHeightM;
    const distance = opts.distanceM + rng.normal(0, opts.positionJitterM * 4);
    const horizontal = Math.sqrt(Math.max(0.04, distance * distance - z * z));
    const position: Vec3 = {
      x: horizontal * Math.cos(az),
      y: horizontal * Math.sin(az),
      z,
    };
    const aim = aimAt(position, { x: 0, y: 0, z: 0 });
    out.push({
      id: `C${i + 1}`,
      intrinsics: phoneIntrinsics(opts.resX, opts.resY, opts.fovHDeg, opts.k1, opts.k2),
      pose: {
        position,
        yawDeg: aim.yawDeg + rng.normal(0, opts.aimJitterDeg),
        pitchDeg: aim.pitchDeg + rng.normal(0, opts.aimJitterDeg),
        rollDeg: rng.normal(0, opts.rollJitterDeg),
      },
      heightM,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handheld motion
// ---------------------------------------------------------------------------

/**
 * How a handheld camera moves during a capture.
 *
 * Three components, because hand motion has three distinguishable ones and they
 * hit the capture differently:
 *
 *  - **Tremor.** Physiological hand tremor sits around 8-12 Hz with a
 *    sub-millimetre amplitude. It is fast compared to a frame interval, so it
 *    decorrelates frame to frame and reads as noise on the decode — and it is
 *    fast compared to a rolling-shutter readout, so it also shears each frame.
 *  - **Sway.** Postural sway, roughly 0.5-1 Hz, larger amplitude. Slow enough
 *    that neighbouring frames see nearly the same displacement, so it biases a
 *    phase estimate rather than averaging out of it.
 *  - **Drift.** A slow monotonic wander over the whole sequence: the operator
 *    is not a tripod. This is what makes the LAST frame of a 34-frame sequence
 *    look at a measurably different scene from the first.
 *
 * Amplitudes are `ASSUME` in exactly PARAMETERS.md's sense — nothing in the
 * spec describes a handheld capture, and no ground-truth measurement of one
 * exists. They are chosen from the published human-factors ranges and are
 * reported in `bench-results.json` so a reader can see what was assumed. The
 * defaults describe someone deliberately bracing a phone, not someone waving
 * it: 0.4 mm of tremor, 1.5 mm of sway, 2 mm/s of drift.
 */
export interface HandheldMotion {
  /** RMS translational tremor amplitude, metres. */
  tremorM: number;
  /** RMS rotational tremor amplitude, degrees. */
  tremorDeg: number;
  /** Tremor centre frequency, Hz. */
  tremorHz: number;
  /** RMS translational sway amplitude, metres. */
  swayM: number;
  /** RMS rotational sway amplitude, degrees. */
  swayDeg: number;
  /** Sway centre frequency, Hz. */
  swayHz: number;
  /** Monotonic drift rate, metres per second. */
  driftMPerS: number;
  /** Monotonic angular drift rate, degrees per second. */
  driftDegPerS: number;
}

export const DEFAULT_HANDHELD: HandheldMotion = {
  tremorM: 0.0004,
  tremorDeg: 0.03,
  tremorHz: 9,
  swayM: 0.0015,
  swayDeg: 0.06,
  swayHz: 0.7,
  driftMPerS: 0.002,
  driftDegPerS: 0.05,
};

/**
 * Frozen phases and drift directions for one camera's motion.
 *
 * Drawn once per camera from the scenario seed. Everything downstream is a pure
 * function of `(state, t)` with no stream position involved, which is what lets
 * a rolling shutter ask for the pose at an arbitrary row time without the answer
 * depending on which rows were evaluated first.
 */
export interface MotionState {
  /** Six phases: three translation axes, three rotation axes, per component. */
  tremorPhase: number[];
  swayPhase: number[];
  /** Unit drift direction in translation, and a signed rate per rotation axis. */
  driftDir: number[];
}

export function makeMotionState(rng: BenchRng): MotionState {
  const phases = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push(rng.uniform(0, 2 * Math.PI));
    return out;
  };
  const dir: number[] = [];
  for (let i = 0; i < 6; i++) dir.push(rng.gaussian());
  // Normalize the translation triple so `driftMPerS` is a speed rather than a
  // per-axis amplitude; leave the rotation triple as three independent rates.
  const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  dir[0] /= n;
  dir[1] /= n;
  dir[2] /= n;
  return { tremorPhase: phases(), swayPhase: phases(), driftDir: dir };
}

/** Displacement and angular offset at time `tSec` into the capture. */
export interface MotionSample {
  dx: number;
  dy: number;
  dz: number;
  dYawDeg: number;
  dPitchDeg: number;
  dRollDeg: number;
}

const ZERO_MOTION: MotionSample = { dx: 0, dy: 0, dz: 0, dYawDeg: 0, dPitchDeg: 0, dRollDeg: 0 };

/**
 * Sample the motion at an absolute time.
 *
 * `sqrt(2)` on each sinusoid converts the stated RMS amplitude into the peak
 * amplitude of a sinusoid with that RMS, so `tremorM` means what it says.
 */
export function motionAt(
  motion: HandheldMotion | null,
  state: MotionState,
  tSec: number,
): MotionSample {
  if (motion === null) return ZERO_MOTION;
  const root2 = Math.SQRT2;
  const tw = 2 * Math.PI * motion.tremorHz * tSec;
  const sw = 2 * Math.PI * motion.swayHz * tSec;
  const comp = (i: number, ampT: number, ampS: number): number =>
    root2 * ampT * Math.sin(tw + state.tremorPhase[i]) +
    root2 * ampS * Math.sin(sw + state.swayPhase[i]);
  return {
    dx: comp(0, motion.tremorM, motion.swayM) + motion.driftMPerS * tSec * state.driftDir[0],
    dy: comp(1, motion.tremorM, motion.swayM) + motion.driftMPerS * tSec * state.driftDir[1],
    dz: comp(2, motion.tremorM, motion.swayM) + motion.driftMPerS * tSec * state.driftDir[2],
    dYawDeg:
      comp(3, motion.tremorDeg, motion.swayDeg) + motion.driftDegPerS * tSec * state.driftDir[3],
    dPitchDeg:
      comp(4, motion.tremorDeg, motion.swayDeg) + motion.driftDegPerS * tSec * state.driftDir[4],
    dRollDeg:
      comp(5, motion.tremorDeg, motion.swayDeg) + motion.driftDegPerS * tSec * state.driftDir[5],
  };
}

export function poseAt(
  base: CameraPose,
  motion: HandheldMotion | null,
  state: MotionState,
  tSec: number,
): CameraPose {
  const m = motionAt(motion, state, tSec);
  return {
    position: { x: base.position.x + m.dx, y: base.position.y + m.dy, z: base.position.z + m.dz },
    yawDeg: base.yawDeg + m.dYawDeg,
    pitchDeg: base.pitchDeg + m.dPitchDeg,
    rollDeg: base.rollDeg + m.dRollDeg,
  };
}

// ---------------------------------------------------------------------------
// Shutter timing
// ---------------------------------------------------------------------------

export interface FrameClock {
  /** Time between successive pattern frames, milliseconds. */
  frameIntervalMs: number;
  /** Sensor readout time from the first row to the last, milliseconds. */
  readoutMs: number;
  /**
   * When false, every row of a frame is sampled at the frame's own instant —
   * a global shutter. When true, row `r` is sampled `r/height * readoutMs`
   * later, which is what a CMOS rolling shutter does.
   */
  rollingShutter: boolean;
}

/**
 * 20 frames per second with a 30 ms readout.
 *
 * The frame interval is a capture-rate choice, not a physical constant: it has
 * to be slow enough that the projector has settled and the sensor has an
 * exposure. 20 fps puts a 34-frame sequence at 1.7 seconds, which is about as
 * long as anybody holds a phone still on purpose. The readout is typical of a
 * phone sensor's full-frame rolling readout.
 */
export const DEFAULT_CLOCK: FrameClock = {
  frameIntervalMs: 50,
  readoutMs: 30,
  rollingShutter: true,
};

/** Absolute time, in seconds from the start of the capture, at which a row is read. */
export function rowTimeSec(clock: FrameClock, frameIndex: number, row: number, height: number): number {
  const frame = (frameIndex * clock.frameIntervalMs) / 1000;
  if (!clock.rollingShutter || height <= 1) return frame;
  return frame + (row / (height - 1)) * (clock.readoutMs / 1000);
}
