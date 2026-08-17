/**
 * Everything the display shader needs, as plain arrays.
 *
 * Two rules govern this file:
 *
 *  1. **Nothing is derived here.** Every focal length, principal point, rotation
 *     matrix and limb constant is read off `packages/sim`'s `PreparedProjector`.
 *     Recomputing `fx = resX / 2 / tan(fov/2)` locally would be four lines and
 *     would create a second definition of the camera model that no test compares
 *     against the first. The one arithmetic operation this module performs is
 *     `distanceM - radiusM` for the falloff reference, and it performs it because
 *     the shader needs the difference rather than the pair.
 *
 *  2. **Both rigs go through the same packer.** {@link packRig} is called twice,
 *     once for the physical calibration and once for the compositor's. A packer
 *     with a special case for either would be able to make the two rigs differ by
 *     something other than their calibrations, which is the one thing this page
 *     must never do.
 */

import type { PreparedRig } from '../../sim/src/optics.ts';
import type { Scene, ViewerCamera } from '../../sim/src/render.ts';
import { cross, dot, normalize, sub, DEG2RAD } from '../../sim/src/vec.ts';
import { MAX_PROJECTORS } from './glsl.ts';

export type OverlayMode = 'none' | 'overlap' | 'seams' | 'unlit';

const OVERLAY_CODE: Record<OverlayMode, number> = { none: 0, overlap: 1, seams: 2, unlit: 3 };

export interface DisplayOptions {
  overlay?: OverlayMode;
  /** How strongly the overlay is mixed over the render. */
  overlayMix?: number;
  /** Show only one projector's contribution. `-1` shows all of them. */
  highlight?: number;
  drawFloor?: boolean;
  floorRadiusM?: number;
  exposure?: number;
  /** `0` disables the final encode, for a linear readback the parity check can use. */
  displayGamma?: number;
}

/** One rig's arrays, in the layout the shader declares. */
export interface PackedRig {
  radiusM: number;
  centerHeightM: number;
  rotationOffsetDeg: number;
  /** `3 * MAX_PROJECTORS` floats. */
  lens: Float32Array;
  /** `9 * MAX_PROJECTORS` floats, column-major as GL expects. */
  rot: Float32Array;
  /** `4 * MAX_PROJECTORS`: fx, fy, cx, cy. */
  intrinsics: Float32Array;
  /** `4 * MAX_PROJECTORS`: resX, resY, k1, k2. */
  raster: Float32Array;
  /** `2 * MAX_PROJECTORS`: lens distance to the sphere centre, and R/d. */
  limb: Float32Array;
  /** `3 * MAX_PROJECTORS` each, per-channel transfer. PARAMETERS.md §3.2. */
  gamma: Float32Array;
  black: Float32Array;
  gain: Float32Array;
}

export function packRig(rig: PreparedRig): PackedRig {
  const n = MAX_PROJECTORS;
  const packed: PackedRig = {
    radiusM: rig.radiusM,
    centerHeightM: rig.centerHeightM,
    rotationOffsetDeg: rig.rotationOffsetDeg,
    lens: new Float32Array(3 * n),
    rot: new Float32Array(9 * n),
    intrinsics: new Float32Array(4 * n),
    raster: new Float32Array(4 * n),
    limb: new Float32Array(2 * n),
    gamma: new Float32Array(3 * n),
    black: new Float32Array(3 * n),
    gain: new Float32Array(3 * n),
  };

  for (let i = 0; i < n; i++) {
    const p = rig.projectors[i];
    if (!p) {
      // An unused slot still has to hold something the shader can divide by. A
      // zero limb distance would produce NaN inside `contentWeight` even though
      // the loop guards on `uProjCount`, because a GPU is free to evaluate both
      // sides of a branch.
      packed.limb[2 * i] = 1;
      packed.limb[2 * i + 1] = 1;
      packed.intrinsics[4 * i] = 1;
      packed.intrinsics[4 * i + 1] = 1;
      packed.raster[4 * i] = 1;
      packed.raster[4 * i + 1] = 1;
      packed.rot[9 * i] = 1;
      packed.rot[9 * i + 4] = 1;
      packed.rot[9 * i + 8] = 1;
      continue;
    }
    const it = p.cal.intrinsics;
    const t = p.cal.transfer;

    packed.lens[3 * i] = p.lens.x;
    packed.lens[3 * i + 1] = p.lens.y;
    packed.lens[3 * i + 2] = p.lens.z;

    // `Mat3` is row-major (`m[row * 3 + col]`); GL's `uniformMatrix3fv` reads
    // column-major and WebGL2 rejects `transpose = true`. So the transpose
    // happens here, once, in the packer both rigs share.
    const m = p.rotation;
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) packed.rot[9 * i + 3 * c + r] = m[r * 3 + c];
    }

    packed.intrinsics[4 * i] = p.fx;
    packed.intrinsics[4 * i + 1] = p.fy;
    packed.intrinsics[4 * i + 2] = p.cx;
    packed.intrinsics[4 * i + 3] = p.cy;

    packed.raster[4 * i] = it.resX;
    packed.raster[4 * i + 1] = it.resY;
    packed.raster[4 * i + 2] = it.k1;
    packed.raster[4 * i + 3] = it.k2;

    packed.limb[2 * i] = p.distanceM;
    packed.limb[2 * i + 1] = p.limbCos;

    packed.gamma[3 * i] = t.gamma.r;
    packed.gamma[3 * i + 1] = t.gamma.g;
    packed.gamma[3 * i + 2] = t.gamma.b;
    packed.black[3 * i] = t.blackFloor.r;
    packed.black[3 * i + 1] = t.blackFloor.g;
    packed.black[3 * i + 2] = t.blackFloor.b;
    packed.gain[3 * i] = t.gain.r;
    packed.gain[3 * i + 1] = t.gain.g;
    packed.gain[3 * i + 2] = t.gain.b;
  }
  return packed;
}

export interface DisplayUniforms {
  projCount: number;
  physical: PackedRig;
  content: PackedRig;

  rampShape: number;
  widthDeg: number;
  rampGamma: number;
  maskLo: number;
  maskHi: number;
  maskBottomOnly: number;
  maskInterp: number;

  encodeGamma: [number, number, number];
  reflectance: [number, number, number];
  ambient: [number, number, number];
  roomAlbedo: number;

  camPos: [number, number, number];
  camForward: [number, number, number];
  camRight: [number, number, number];
  camUp: [number, number, number];
  camHalf: [number, number];

  overlay: number;
  overlayMix: number;
  highlight: number;
  drawFloor: number;
  floorRadius: number;
  exposure: number;
  displayGamma: number;
}

const RAMP_SHAPE_CODE: Record<string, number> = {
  linear: 0,
  cosine: 1,
  smoothstep: 2,
  gaussian: 3,
};

/**
 * The camera basis, built exactly as `renderRoomView` and `renderTwoRigRoomView`
 * build it — forward from position to target, right from forward × upHint, up
 * from right × forward, and `halfH` scaled by the raster's aspect rather than by
 * a second field-of-view number.
 *
 * The degenerate case (looking straight up the up-hint) is handled the same way
 * the CPU handles it, because a viewer who drags the elevation slider to 90°
 * should get the same picture on both paths rather than a black frame on one.
 */
function cameraBasis(camera: ViewerCamera): {
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  half: [number, number];
} {
  const forward = normalize(sub(camera.target, camera.position));
  const upHint = camera.upHint ?? { x: 0, y: 0, z: 1 };
  let right = cross(forward, upHint);
  if (dot(right, right) < 1e-18) right = cross(forward, { x: 1, y: 0, z: 0 });
  right = normalize(right);
  const up = cross(right, forward);
  const halfW = Math.tan((camera.fovHDeg * DEG2RAD) / 2);
  return {
    forward: [forward.x, forward.y, forward.z],
    right: [right.x, right.y, right.z],
    up: [up.x, up.y, up.z],
    half: [halfW, (halfW * camera.height) / camera.width],
  };
}

export function buildDisplayUniforms(
  physical: PreparedRig,
  content: PreparedRig,
  scene: Scene,
  camera: ViewerCamera,
  options: DisplayOptions = {},
): DisplayUniforms {
  const basis = cameraBasis(camera);
  // The blend and mask are the COMPOSITOR's: the weights belong to the
  // calibration the content was generated against, not to where the light
  // physically landed. Reading them off `physical` would be a subtle and very
  // convincing bug — the picture would still look like a sphere.
  const blend = content.blend;
  return {
    projCount: Math.min(MAX_PROJECTORS, physical.projectors.length),
    physical: packRig(physical),
    content: packRig(content),

    rampShape: RAMP_SHAPE_CODE[blend.rampShape] ?? 1,
    widthDeg: blend.widthDeg,
    rampGamma: blend.rampGamma,
    maskLo: blend.maskLoDeg,
    maskHi: blend.maskHiDeg,
    maskBottomOnly: blend.bottomOnly ? 1 : 0,
    maskInterp: scene.maskInterpretation === 'colatitude' ? 1 : 0,

    encodeGamma: [scene.encodeGamma.r, scene.encodeGamma.g, scene.encodeGamma.b],
    reflectance: [scene.reflectance.r, scene.reflectance.g, scene.reflectance.b],
    ambient: [scene.ambient.r, scene.ambient.g, scene.ambient.b],
    roomAlbedo: scene.roomAlbedo,

    camPos: [camera.position.x, camera.position.y, camera.position.z],
    camForward: basis.forward,
    camRight: basis.right,
    camUp: basis.up,
    camHalf: basis.half,

    overlay: OVERLAY_CODE[options.overlay ?? 'none'],
    overlayMix: options.overlayMix ?? 0.75,
    highlight: options.highlight ?? -1,
    drawFloor: (options.drawFloor ?? true) ? 1 : 0,
    floorRadius: options.floorRadiusM ?? 8,
    exposure: options.exposure ?? 1,
    displayGamma: options.displayGamma ?? 2.2,
  };
}

/** Unused, but kept adjacent to the packer so the two never drift apart. */
export function eyeRay(
  u: DisplayUniforms,
  ndcX: number,
  ndcY: number,
): { x: number; y: number; z: number } {
  const f = { x: u.camForward[0], y: u.camForward[1], z: u.camForward[2] };
  const r = { x: u.camRight[0], y: u.camRight[1], z: u.camRight[2] };
  const up = { x: u.camUp[0], y: u.camUp[1], z: u.camUp[2] };
  return normalize({
    x: f.x + r.x * ndcX * u.camHalf[0] + up.x * ndcY * u.camHalf[1],
    y: f.y + r.y * ndcX * u.camHalf[0] + up.y * ndcY * u.camHalf[1],
    z: f.z + r.z * ndcX * u.camHalf[0] + up.z * ndcY * u.camHalf[1],
  });
}
