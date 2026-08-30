// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `RigCalibration` + `Scene` + `ViewerCamera` -> the uniform block `glsl.ts`
 * declares.
 *
 * These are the values a GPU renderer computes ONCE on the CPU and uploads:
 * rotation matrices, focal lengths in pixels, the principal point with lens
 * shift folded in, the limb cosine. The shader never recomputes them, so a bug
 * here is a bug in both the GPU path and the reference path at the same time and
 * the parity number cannot see it.
 *
 * That is why this module does its own arithmetic instead of calling
 * `packages/sim`'s `prepareRig`, and why `test/uniforms.test.ts` asserts the
 * result agrees with `prepareRig` to 1e-12. Comparing the OUTPUTS of two
 * independent derivations is a real check; calling one from the other would
 * turn the check into a tautology, which is the same argument
 * `packages/sim/README.md` makes about the A/B boundary — applied here to a
 * boundary that is not A/B and matters less, but matters.
 */

import type { ChannelTriplet, RigCalibration, Vec3 } from '../../calibration/src/index.ts';
import type { Scene, ViewerCamera } from '../../sim/src/render.ts';

const DEG2RAD = Math.PI / 180;

/** Row-major 3x3, `m[row * 3 + col]`. */
export type Mat3x3 = number[];

export interface ProjectorUniforms {
  /** Lens entrance pupil, world frame. */
  lens: Vec3;
  /** World <- canonical camera frame, conventions.ts §R. Row-major. */
  rot: Mat3x3;
  /** fx, fy, cx, cy — conventions.ts §I, lens shift already in the principal point. */
  intrinsics: [number, number, number, number];
  /** resX, resY, k1, k2. */
  raster: [number, number, number, number];
  /** Distance to the sphere centre, and `R / d`. */
  limb: [number, number];
  /**
   * The distance this projector's output is defined to be 1.0 at —
   * `PreparedProjector.referenceDistanceM`, PARAMETERS.md Conventions,
   * "Radiometry".
   */
  refDistance: number;
  gamma: ChannelTriplet;
  black: ChannelTriplet;
  gain: ChannelTriplet;
}

/** A float RGB texture sampled the way GL samples it. See `reference.ts`. */
export interface TextureData {
  width: number;
  height: number;
  /** `3 * (row * width + col)`, row 0 at the TOP. Linear light. */
  data: Float32Array;
}

export interface Uniforms {
  projCount: number;
  radius: number;
  centerHeight: number;
  rotationOffset: number;
  projectors: ProjectorUniforms[];

  rampShape: number;
  widthDeg: number;
  rampGamma: number;
  maskLo: number;
  maskHi: number;
  maskBottomOnly: number;
  maskInterp: number;

  encodeGamma: ChannelTriplet;
  reflectance: ChannelTriplet;
  ambient: ChannelTriplet;
  roomAlbedo: number;
  specWeight: number;
  specAlpha: number;

  camPos: Vec3;
  camForward: Vec3;
  camRight: Vec3;
  camUp: Vec3;
  camHalf: [number, number];

  mode: number;
  projIndex: number;
  drawFloor: number;
  floorRadius: number;
  exposure: number;
  /** 0 disables the final encode, which is what a linear readback needs. */
  displayGamma: number;

  equirect: TextureData;

  /**
   * The mesh as texels, or `null` for the analytic sphere.
   *
   * `sim/src/mesh/pack.ts` writes the layout; this carries it. `null` is the
   * ordinary case and costs the shader nothing — `uMeshMode` is 0 and
   * `bvhIntersect` returns a miss before it fetches anything.
   */
  mesh: MeshUniforms | null;
  /** Shadow-ray bias and blend width in metres, both scaled to the model. */
  meshShadowBias: number;
  meshBlendWidthM: number;
}

/** The packed textures, the counts, and the two facts about the model itself. */
export interface MeshUniforms {
  /** `RGBA32F`, `4 * width * height` floats. See `sim/src/mesh/pack.ts`. */
  nodes: Float32Array;
  nodeWidth: number;
  triangles: Float32Array;
  triangleWidth: number;
  nodeCount: number;
  triangleCount: number;
  /**
   * Per-corner footprint distances, or `null` when none were packed.
   *
   * `null` is not "no blend": it is "no field to blend from", and the shader
   * takes the same hard-seam fallback `coverageAndWeights` takes when
   * `rig.footprints` is missing.
   */
  field?: Float32Array | null;
  fieldWidth?: number;
  /**
   * Where the model's own centre is, and how big it is about that centre —
   * `Surface.centre` and `Surface.extentRadiusM`.
   *
   * Facts, not formulas. Everything derived from them (the radiometric
   * reference distance, the shadow-ray bias, the blend width in metres) is
   * computed by {@link buildUniforms} from these, because this module's whole
   * discipline is that it re-derives rather than importing the simulator's
   * answers — see the module note.
   */
  centre: Vec3;
  extentRadiusM: number;
}

/** The shader's code for a ramp shape, or an error naming the ones that exist. */
export function rampShapeIndex(shape: string): number {
  const index = RAMP_SHAPE_INDEX[shape];
  if (index === undefined) {
    throw new Error(
      `unknown rampShape ${JSON.stringify(shape)}; expected one of ${Object.keys(RAMP_SHAPE_INDEX).join(', ')}`,
    );
  }
  return index;
}

export const RAMP_SHAPE_INDEX: Readonly<Record<string, number>> = {
  linear: 0,
  cosine: 1,
  smoothstep: 2,
  gaussian: 3,
};

function matMul(a: Mat3x3, b: Mat3x3): Mat3x3 {
  const out: number[] = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/**
 * conventions.ts §R: `R = Rz(yaw) * Ry(-pitch) * Rx(roll)`.
 *
 * The negated pitch is the clause, not a preference: §R states that positive
 * pitch raises the optical axis toward `+Z`, and a right-handed rotation about
 * `+Y` lowers `+X` toward `-Z`. Writing `Ry(pitch)` compiles, renders something
 * plausible, and mirrors every projector about the equator.
 */
export function rotationMatrix(yawDeg: number, pitchDeg: number, rollDeg: number): Mat3x3 {
  const y = yawDeg * DEG2RAD;
  const p = -pitchDeg * DEG2RAD;
  const r = rollDeg * DEG2RAD;
  const cz = Math.cos(y);
  const sz = Math.sin(y);
  const cy = Math.cos(p);
  const sy = Math.sin(p);
  const cx = Math.cos(r);
  const sx = Math.sin(r);
  const rz: Mat3x3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const ry: Mat3x3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rx: Mat3x3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  return matMul(rz, matMul(ry, rx));
}

export interface UniformOptions {
  mode: 'room' | 'projector';
  projIndex?: number;
  drawFloor?: boolean;
  /** A packed model to trace instead of the analytic sphere. */
  mesh?: MeshUniforms | null;
  floorRadiusM?: number;
  exposure?: number;
  /** 0 to read back linear radiance; 2.2 to encode for a display. */
  displayGamma?: number;
  specWeight?: number;
  specAlpha?: number;
}

/** Build the uniform block. Pure: no GL, no DOM, runnable in Node. */
export function buildUniforms(
  rig: RigCalibration,
  scene: Scene,
  camera: ViewerCamera,
  options: UniformOptions,
): Uniforms {
  const radius = rig.sphere.radiusM;
  // The body being lit: the model when there is one, and otherwise the sphere,
  // which conventions.ts section W puts on the origin with its radius as its
  // extent. Written as ONE pair so the three quantities below are one expression
  // rather than two branches that have to be kept saying the same thing.
  //
  // The sphere's centre is EXACTLY zero, and that is load-bearing: subtracting an
  // exact zero returns its operand unchanged, so `hypot(lens - centre)` receives
  // the bits `hypot(lens)` receives and the sphere's arithmetic does not move.
  const mesh = options.mesh ?? null;
  const centre = mesh === null ? { x: 0, y: 0, z: 0 } : mesh.centre;
  const extentRadiusM = mesh === null ? radius : mesh.extentRadiusM;
  const projectors: ProjectorUniforms[] = rig.projectors.map((p) => {
    const it = p.intrinsics;
    const fx = it.resX / 2 / Math.tan((it.fovHDeg * DEG2RAD) / 2);
    const lens = p.pose.position;
    const distanceM = Math.hypot(lens.x, lens.y, lens.z);
    return {
      lens: { x: lens.x, y: lens.y, z: lens.z },
      rot: rotationMatrix(p.pose.yawDeg, p.pose.pitchDeg, p.pose.rollDeg),
      intrinsics: [
        fx,
        fx * it.pixelAspect,
        // conventions.ts §I: lens shift is a fraction of the HALF-image dimension.
        it.resX / 2 + it.shiftH * (it.resX / 2),
        it.resY / 2 - it.shiftV * (it.resY / 2),
      ],
      raster: [it.resX, it.resY, it.k1, it.k2],
      limb: [distanceM, distanceM > 0 ? Math.min(1, radius / distanceM) : 1],
      // `optics.ts` `prepareProjector`, re-derived: the near point of the body
      // along the axis from this lens to its centre.
      refDistance:
        Math.hypot(lens.x - centre.x, lens.y - centre.y, lens.z - centre.z) - extentRadiusM,
      gamma: { ...p.transfer.gamma },
      black: { ...p.transfer.blackFloor },
      gain: { ...p.transfer.gain },
    };
  });

  const basis = cameraBasis(camera);
  const halfW = Math.tan((camera.fovHDeg * DEG2RAD) / 2);

  return {
    projCount: projectors.length,
    radius,
    centerHeight: rig.sphere.centerHeightM,
    rotationOffset: rig.sphere.rotationOffsetDeg,
    projectors,

    // Refused, not defaulted. `?? 1` drew the rig as cosine while the CPU
    // path threw on the same string, so a typo'd shape produced two different
    // answers to one question and the parity check compared them.
    rampShape: rampShapeIndex(rig.blend.rampShape),
    widthDeg: rig.blend.widthDeg,
    rampGamma: rig.blend.rampGamma,
    maskLo: rig.blend.maskLoDeg,
    maskHi: rig.blend.maskHiDeg,
    maskBottomOnly: rig.blend.bottomOnly ? 1 : 0,
    maskInterp: scene.maskInterpretation === 'colatitude' ? 1 : 0,

    encodeGamma: { ...scene.encodeGamma },
    reflectance: { ...scene.reflectance },
    ambient: { ...scene.ambient },
    roomAlbedo: scene.roomAlbedo,
    specWeight: options.specWeight ?? 0,
    specAlpha: options.specAlpha ?? 0.4,

    camPos: basis.position,
    camForward: basis.forward,
    camRight: basis.right,
    camUp: basis.up,
    camHalf: [halfW, (halfW * camera.height) / camera.width],

    mode: options.mode === 'projector' ? 1 : 0,
    projIndex: options.projIndex ?? 0,
    drawFloor: (options.drawFloor ?? true) ? 1 : 0,
    floorRadius: options.floorRadiusM ?? 8,
    exposure: options.exposure ?? 1,
    displayGamma: options.displayGamma ?? 0,

    equirect: {
      width: scene.image.width,
      height: scene.image.height,
      data: scene.image.data,
    },

    // The sphere unless a caller attaches a model. Absent rather than empty, so
    // a shader built for the sphere takes the analytic path with no branch on a
    // zero count.
    mesh,
    // `mesh/surface.ts` SHADOW_BIAS_FRACTION and `footprint.ts` `blendWidthM`,
    // re-derived. A ray leaving the surface it stands on hits that surface at t
    // near zero unless told not to, and a fixed epsilon cannot serve a 30 cm prop
    // and a 30 m facade at once — so the bias is a fraction of the model's own
    // size, which is the only length scale the surface knows. The blend width is
    // an ANGLE in the configuration and an arc on the surface here, for the same
    // reason: a ramp measured in degrees at the lens is not the ramp the blend
    // means.
    // Re-derived, not read off the surface, and deliberately: this module is
    // the independent half of a parity chain, so it states the formula rather
    // than importing the answer. Both lengths, matching `Surface.shadowBiasM` --
    // the model's size AND how far out it stands, because the shader runs this
    // ray in float32 and the self-intersection residual is an ulp at the world
    // coordinate rather than at the model's own scale.
    meshShadowBias:
      1e-6 *
      Math.max(extentRadiusM, Math.hypot(centre.x, centre.y, centre.z), Number.MIN_VALUE),
    meshBlendWidthM:
      Math.max(rig.blend.widthDeg, 1e-9) * (Math.PI / 180) * Math.max(extentRadiusM, 1e-9),
  };
}

/**
 * The viewer camera's orthonormal basis, built exactly as `render.ts` builds it:
 * forward from position to target, right = forward × up-hint, up = right ×
 * forward. The degenerate case (looking straight up) falls back to `+X`, so a
 * slider that walks the viewer onto the pole produces a picture rather than NaN.
 */
export function cameraBasis(camera: ViewerCamera): {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
} {
  const forward = normalize(sub(camera.target, camera.position));
  const upHint = camera.upHint ?? { x: 0, y: 0, z: 1 };
  let right = cross(forward, upHint);
  if (dot(right, right) < 1e-18) right = cross(forward, { x: 1, y: 0, z: 0 });
  right = normalize(right);
  return { position: camera.position, forward, right, up: cross(right, forward) };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(a: Vec3): Vec3 {
  const n = Math.hypot(a.x, a.y, a.z);
  if (n === 0) return { x: 0, y: 0, z: 0 };
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}
