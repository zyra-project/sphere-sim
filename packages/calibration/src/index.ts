// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * @sphere/calibration — THE BOUNDARY OBJECT.
 *
 * This package is the ONLY thing permitted to cross between `sim/` (the forward
 * model) and `solver/` (the inverse model). It contains types, literal
 * constants, and prose. It contains NO MATHEMATICS — no arithmetic operators,
 * no `Math.*` calls, no functions that transform values. `tools/boundary-lint.ts`
 * enforces this mechanically in CI.
 *
 * The reason is not stylistic. If the simulator and the solver shared so much as
 * a distortion helper, the solver would be inverting the simulator's own
 * arithmetic and every recovery score would be circular. They must each
 * implement the conventions documented below from scratch, and disagree loudly
 * if either gets them wrong.
 *
 * See ./conventions.ts for the normative description of every convention that
 * both sides must independently satisfy.
 */

/** Cartesian vector in the world frame. Metres. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A per-channel triple in linear-light RGB. */
export interface ChannelTriplet {
  r: number;
  g: number;
  b: number;
}

/**
 * Rigid pose of a projector lens in the world frame.
 * Rotation order and axis conventions: see conventions.ts §R.
 */
export interface ProjectorPose {
  /** Lens entrance-pupil position, world frame, metres. */
  position: Vec3;
  /** Rotation about world +Z, degrees. */
  yawDeg: number;
  /** Elevation, degrees. Positive tilts the optical axis toward world +Z. */
  pitchDeg: number;
  /** Rotation about the optical axis, degrees. */
  rollDeg: number;
}

/**
 * Projector interior orientation.
 * Distortion convention (Brown-Conrady, ideal -> distorted): conventions.ts §D.
 */
export interface ProjectorIntrinsics {
  /** Native pixels for THIS projector, not the shared X screen. PARAMETERS.md §3.4. */
  resX: number;
  resY: number;
  /** Full horizontal field of view in degrees, of the undistorted ideal frustum. */
  fovHDeg: number;
  /** Pixel aspect ratio. 1.0 = square pixels (PAR, PARAMETERS.md §3.1). */
  pixelAspect: number;
  /** Horizontal lens shift as a fraction of half the image width. 0 = centred. */
  shiftH: number;
  /** Vertical lens shift as a fraction of half the image height. 0 = centred. */
  shiftV: number;
  /** Radial distortion coefficients. */
  k1: number;
  k2: number;
  /** Tangential distortion coefficients. */
  p1: number;
  p2: number;
}

/** Per-channel photometric transfer terms. PARAMETERS.md §3.2. All class ASSUME/MEAS. */
export interface ProjectorTransfer {
  /** Encoding exponent per channel, gamma_R,G,B. */
  gamma: ChannelTriplet;
  /** Black floor per channel as a fraction of full output, L_black_R,G,B. */
  blackFloor: ChannelTriplet;
  /** Channel gain, g_R,G,B. Absorbs lamp age and colour-wheel differences. */
  gain: ChannelTriplet;
  /** Nominal white point in kelvin, reported not applied. */
  whitePointK: number;
}

/**
 * Normalized viewport rectangle inside the single shared framebuffer.
 * PARAMETERS.md §3.4: SOS drives all projectors from one X screen split 2x2.
 * Origin is bottom-left, matching the SOS `projectorInfo(viewport)` values.
 */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Everything the forward model needs about one projector, and nothing more. */
export interface ProjectorCalibration {
  id: string;
  pose: ProjectorPose;
  intrinsics: ProjectorIntrinsics;
  transfer: ProjectorTransfer;
  viewport: Viewport;
}

/** Sphere placement and orientation. */
export interface SphereCalibration {
  /** Sphere radius, metres. PARAMETERS.md §1, class DOC. */
  radiusM: number;
  /** Floor to sphere centre, metres. h_center, class DOC/SOLVE. */
  centerHeightM: number;
  /** Mechanical rotation of the sphere vs the canonical prime meridian, degrees. */
  rotationOffsetDeg: number;
}

/** Blend and mask configuration. PARAMETERS.md §4.4, §4.5. */
export interface BlendCalibration {
  /** Ramp shape identifier. See conventions.ts §B for the normative definitions. */
  rampShape: RampShape;
  /**
   * Blend region angular width in degrees, `w_width`. PARAMETERS.md §4.5, ~20.
   *
   * FULL width, not a half-width — this comment said half-width and the
   * simulator has never treated it as one. `rampWeight` is evaluated at
   * `t = (edge − θ) / widthDeg`, so the ramp spans `widthDeg` end to end.
   */
  widthDeg: number;
  /** Blend ramp exponent, gamma_blend. One global scalar in SOS. Class DOC. */
  rampGamma: number;
  /** Polar mask onset latitude, degrees. */
  maskLoDeg: number;
  /** Polar mask full-mask latitude, degrees. */
  maskHiDeg: number;
  /** Apply the mask at the south pole only, matching `set bottommask`. */
  bottomOnly: boolean;
  /**
   * Where the blend region IS. See docs/AMENDMENTS.md A-37; absent means `'limb'`.
   *
   * `'limb'` ramps inward from each projector's own footprint edge, so the region
   * is an annulus at the limb and the middle of an overlap is a 50/50 plateau
   * about 31° of longitude wide. `'sector'` gives each projector a longitude
   * wedge of `360/count` and crossfades across ±`widthDeg/2` at the boundary with
   * its neighbour, which is what an SOS compositor does and what §4.5's "derived
   * from seam geometry" describes.
   *
   * A string in a bag of numbers, and deliberately not a function: which region a
   * rig uses is a fact about the installation, and the arithmetic for both lives
   * on the simulator's side of this boundary where it belongs.
   */
  region?: BlendRegion;
}

/** See {@link BlendCalibration.region} and docs/AMENDMENTS.md A-37. */
export type BlendRegion = 'limb' | 'sector';

export type RampShape = 'linear' | 'cosine' | 'smoothstep' | 'gaussian';

/** The complete boundary object. Serialized to JSON, passed between A and B. */
export interface RigCalibration {
  /** Schema identifier. Bump when the shape changes incompatibly. */
  schema: 'sphere-sim/rig-calibration@2';
  sphere: SphereCalibration;
  blend: BlendCalibration;
  /** The single shared framebuffer, in pixels. PARAMETERS.md §3.4. */
  framebuffer: {
    width: number;
    height: number;
  };
  projectors: ProjectorCalibration[];
}

/**
 * What the solver reports alongside the calibration it recovered.
 * Diagnostics only: nothing here feeds the forward model.
 */
export interface SolveDiagnostics {
  /** RMS reprojection residual in projector pixels. */
  rmsResidualPx: number;
  /** Per-projector RMS reprojection residual in projector pixels. */
  perProjectorRmsPx: number[];
  /** Count of correspondences actually used after outlier rejection. */
  correspondencesUsed: number;
  /** Count of correspondences rejected. */
  correspondencesRejected: number;
  /** Levenberg-Marquardt iterations consumed. */
  iterations: number;
  /** True when the optimiser met its convergence tolerance rather than its cap. */
  converged: boolean;
  /** Recovered floor-to-sphere-centre distance, metres. PARAMETERS.md §1 note. */
  recoveredCenterHeightM: number;
  /** Every residual, for the scatter plot. Projector index, and pixel residual. */
  residuals: ResidualSample[];
}

export interface ResidualSample {
  projector: number;
  camera: number;
  /** Decoded projector pixel coordinate the correspondence landed on. */
  u: number;
  v: number;
  /** Residual in projector pixels. */
  du: number;
  dv: number;
}

/** The solver's complete output. */
export interface SolveResult {
  calibration: RigCalibration;
  diagnostics: SolveDiagnostics;
}
