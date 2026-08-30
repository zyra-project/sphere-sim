// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Everything the display shader needs, as plain arrays.
 *
 * Two rules govern this file:
 *
 *  1. **Nothing about the MODEL is derived here.** Every focal length, principal
 *     point, rotation matrix, limb constant, falloff reference and shadow bias is
 *     read off `packages/sim` — `PreparedProjector` for the first four,
 *     `Surface` for the last two. Recomputing `fx = resX / 2 / tan(fov/2)`
 *     locally would be four lines and would create a second definition of the
 *     camera model that no test compares against the first.
 *
 *     `distanceM - radiusM` for the falloff reference used to be the one
 *     exception, and it is gone: it was the right number only for a body the
 *     world origin sits inside, so `prepareProjector` computes
 *     `referenceDistanceM` once and this reads it.
 *
 *     What this module DOES do is pack — `packBvh` over the surface's own
 *     hierarchy, and `blendWidthM`, which turns the blend's angle into the arc
 *     it subtends on this model. Both are transformations of shapes into the
 *     layout the shader reads, not second opinions about a number.
 *
 *  2. **Both rigs go through the same packer.** {@link packRig} is called twice,
 *     once for the physical calibration and once for the compositor's. A packer
 *     with a special case for either would be able to make the two rigs differ by
 *     something other than their calibrations, which is the one thing this page
 *     must never do.
 */

import { DEFAULT_FEATHER_FRAC } from '../../sim/src/equirect.ts';
import { raySphereIntersect } from '../../sim/src/geometry.ts';
import type { PreparedRig } from '../../sim/src/optics.ts';
import type { Scene, ViewerCamera } from '../../sim/src/render.ts';
import { cross, dot, normalize, sub, DEG2RAD } from '../../sim/src/vec.ts';
import type { MeshSurface } from '../../sim/src/mesh/surface.ts';
import { packBvh } from '../../sim/src/mesh/pack.ts';
import { blendWidthM } from '../../sim/src/footprint.ts';
import type { Vec3 } from '../../calibration/src/index.ts';
import type { Surface } from '../../sim/src/surface.ts';
import { MAX_PROJECTORS } from './glsl.ts';
import { PROJECTOR_TINTS_LINEAR } from './settings.ts';

export type OverlayMode = 'none' | 'overlap' | 'seams' | 'unlit' | 'byprojector';

const OVERLAY_CODE: Record<OverlayMode, number> = {
  none: 0,
  overlap: 1,
  seams: 2,
  unlit: 3,
  byprojector: 4,
};

export interface DisplayOptions {
  /** A packed model to trace instead of the analytic sphere. */
  mesh?: DisplayMesh | null;
  overlay?: OverlayMode;
  /** How strongly the overlay is mixed over the render. */
  overlayMix?: number;
  /** Show only one projector's contribution. `-1` shows all of them. */
  highlight?: number;
  drawFloor?: boolean;
  floorRadiusM?: number;
  /**
   * Samples per pixel, rounded to the nearest perfect square and laid out on a
   * regular grid. `1` — the default — is one sample at the pixel centre, which
   * is where a GPU rasterizes and where `sim`'s offsets are.
   *
   * Whatever the display uses, the parity check's CPU render must use the same
   * number in `sampleLattice: 'grid'` mode, or the number on screen measures the
   * sampling pattern instead of the two renderers.
   */
  samplesPerPixel?: number;
  exposure?: number;
  /** Display tone curve. 1 is off, and must be 1 for a linear readback. */
  lift?: number;
  /** `0` disables the final encode, for a linear readback the parity check can use. */
  displayGamma?: number;
  /**
   * Lens marker radius in metres. `0` — the default — draws none.
   *
   * Opt-in rather than opt-out, and that is load-bearing: the CPU two-rig
   * renderer knows nothing about markers, so a path that got them by default
   * would fail the parity check for a difference belonging to neither model.
   * `drawFloor` already taught this lesson once.
   */
  markerRadiusM?: number;
  /** Which projector reads as selected. `-1` none. */
  markerSelected?: number;
  /** Floor to ceiling, metres. The hangers and the sphere's rod reach it. */
  ceilingM?: number;
  /** Draw the wall, ceiling and full floor. Opt-in, like the markers and the floor. */
  roomOn?: boolean;
  /** Sphere axis to the wall, metres. Only read when `roomOn`. */
  wallRadiusM?: number;
  /** Draw the guard rail, its floor ring and the sphere's rod. Off by default. */
  rail?: boolean;
  /** Draw a faint cone of light from each lens to the ball. */
  aimGuides?: boolean;
  /**
   * `slots[rigIndex]` is the panel slot that projector came from. Identity unless
   * one is switched off, in which case the rig is shorter than the panel.
   *
   * `highlight` and `markerSelected` arrive as panel SLOTS because that is what
   * the reader clicked; the shader indexes the rig. Without the map, switching P2
   * off made selecting P3 isolate P4 and paint it P3's colour.
   */
  slots?: readonly number[];
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
  /**
   * `MAX_PROJECTORS`: the distance each projector's output is defined to be 1.0
   * at — `PreparedProjector.referenceDistanceM`, read off rather than re-derived.
   */
  refDistance: Float32Array;
  /** `3 * MAX_PROJECTORS` each, per-channel transfer. PARAMETERS.md §3.2. */
  gamma: Float32Array;
  black: Float32Array;
  gain: Float32Array;
}

/**
 * The model a prepared rig is lighting, packed for the shader — or `null` when
 * that rig is lighting the analytic sphere.
 *
 * Reads the surface rather than re-deriving: the shadow bias is the surface's
 * own, and the blend width is `footprint.ts`'s own function applied to it. A
 * second definition of either is a second thing to keep in agreement. That is the opposite of the
 * choice `packages/harness/src/uniforms.ts` makes, and deliberately: the harness
 * re-derives because it is the independent half of a parity chain, and this is
 * the app.
 */
export function packMesh(rig: PreparedRig): DisplayMesh | null {
  if (rig.surface.kind !== 'mesh') return null;
  // `as MeshSurface`, which is `optics.ts`'s own idiom, rather than a structural
  // cast through `unknown` to whatever declares a `mesh`. `Surface` is not a
  // discriminated union, so the check above narrows nothing and SOME cast is
  // needed -- but this one names the type that actually carries the mesh, so a
  // future surface answering `kind: 'mesh'` without one fails to compile here
  // rather than reaching `packBvh` with `undefined`.
  const surface = rig.surface as MeshSurface;
  const { mesh } = surface;
  // The surface's OWN hierarchy, not a second one built over the same mesh.
  // `packBvh` indexes triangles by `bvh.order`, and `pickMarker` traverses the
  // surface's; two builds agree only for as long as the build stays
  // deterministic, and the cost is the dominant one in preparing a model.
  const packed = packBvh(surface.bvh, mesh, rig.footprints);
  if (packed.maxDepth >= BVH_STACK_DEPTH) {
    // Refused rather than rendered. The shader's traversal stack is a
    // compile-time array, so a deeper hierarchy would silently drop the nodes it
    // could not push and report a miss where there is geometry — a hole in the
    // model that reads as a modelling error rather than as a limit being hit.
    throw new Error(
      `the model's hierarchy is ${packed.maxDepth} deep and the shader's stack is ` +
        `${BVH_STACK_DEPTH}; it would render with holes in it rather than fail`,
    );
  }
  return {
    nodes: packed.nodes,
    nodeWidth: packed.nodeWidth,
    triangles: packed.triangles,
    triangleWidth: packed.triangleWidth,
    field: packed.field,
    fieldWidth: packed.fieldWidth,
    nodeCount: packed.nodeCount,
    triangleCount: packed.triangleCount,
    surface,
    // The surface's own number, not a third copy of the fraction.
    shadowBias: surface.shadowBiasM,
    blendWidthM: blendWidthM(rig.blend.widthDeg, surface.extentRadiusM),
  };
}

/**
 * The shader's `BVH_STACK`. Both shaders declare 32; `packMesh` refuses past it.
 *
 * The threshold is `maxDepth >= BVH_STACK_DEPTH` and not something more
 * conservative, because the traversal's peak stack occupancy is exactly
 * `maxDepth + 1`: popping a node at depth `d` leaves at most one deferred
 * sibling per ancestor level below it, so the stack holds at most `d` entries
 * before the pop and `d + 2` is unreachable — the deepest node that pushes
 * anything is internal, and therefore sits at `maxDepth - 1`. A model whose
 * hierarchy is 31 deep needs 32 slots and has 32.
 *
 * `packages/sim`'s CPU traversal allocates `maxDepth + 2` (`mesh/bvh.ts`), one
 * slot more than that bound. The spare is slack, not a requirement, and reading
 * it as one would cost a legitimate model its last level of depth.
 * `test/glsl.test.ts` pins the bound over real hierarchies and over every tree
 * shape up to ten leaves, so this stops being an argument.
 */
export const BVH_STACK_DEPTH = 32;

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
    refDistance: new Float32Array(n),
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
      packed.refDistance[i] = 1;
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
    packed.refDistance[i] = p.referenceDistanceM;

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

/**
 * The model as texels, plus the two lengths derived from its own size.
 *
 * `sim/src/mesh/pack.ts` writes the layout. Both rigs trace the SAME model: a
 * misregistration is a disagreement about where the lenses are, not about what
 * shape is standing in the room.
 */
export interface DisplayMesh {
  nodes: Float32Array;
  nodeWidth: number;
  triangles: Float32Array;
  triangleWidth: number;
  field: Float32Array | null;
  fieldWidth: number;
  nodeCount: number;
  triangleCount: number;
  /**
   * The surface these texels were packed from.
   *
   * Carried so `pickMarker` can ask what a ray hits without a third traversal
   * being written to answer it. Not uploaded — the shader reads the texels.
   */
  surface: Surface;
  /** `SHADOW_BIAS_FRACTION * extentRadiusM`, from the surface itself. */
  shadowBias: number;
  /** `blendWidthM(widthDeg, extentRadiusM)`: the ramp as an arc, not an angle. */
  blendWidthM: number;
}

export interface DisplayUniforms {
  projCount: number;
  physical: PackedRig;
  content: PackedRig;
  /**
   * The model to trace, or `null` for the analytic sphere.
   *
   * `null` is the ordinary case and costs the shader nothing: `uMeshMode` is 0
   * and `bvhIntersect` returns a miss before it fetches anything.
   */
  mesh: DisplayMesh | null;

  rampShape: number;
  widthDeg: number;
  rampGamma: number;
  maskLo: number;
  maskHi: number;
  maskBottomOnly: number;
  maskInterp: number;
  /** AMENDMENTS.md A-37. Must track `blend.region` or parity reports it. */
  blendSector: number;

  encodeGamma: [number, number, number];
  reflectance: [number, number, number];
  ambient: [number, number, number];
  roomAlbedo: number;

  camPos: [number, number, number];
  camForward: [number, number, number];
  camRight: [number, number, number];
  camUp: [number, number, number];
  camHalf: [number, number];
  /** {@link ViewerCamera.imageShift}, in halves of the frame height. */
  camShift: number;

  overlay: number;
  overlayMix: number;
  highlight: number;
  drawFloor: number;
  floorRadius: number;
  /** Side of the regular sample grid: `sampleGrid * sampleGrid` samples. */
  sampleGrid: number;
  /** One pixel in uv, so the shader can place a sub-pixel offset. */
  pixelUv: [number, number];
  /**
   * Viewing gain on the picture, and on nothing else.
   *
   * The sphere is a PAINTED BALL lit by four projectors, so what it shows is
   * `texture × reflectance × cos(incidence)`: 0.9 for §1's paint, and a cosine
   * that runs to zero at the limb. A demo that draws the map as an emissive
   * material has neither term and is most of a stop brighter for it. Ours is the
   * physically right picture and it is genuinely dim, so the viewer gets an
   * exposure the way a camera has one.
   *
   * The parity check builds its own uniforms and does not pass this, so the
   * render it reads back is the model's own radiance. No metric can see it.
   */
  exposure: number;
  lift: number;
  /** {@link Scene.graticule}, flattened. `gridDeg` 0 means no graticule. */
  gridDeg: number;
  gridWidthDeg: number;
  gridFeather: number;
  gridAxes: number;
  gridColor: Float32Array;
  displayGamma: number;

  /** `3 * MAX_PROJECTORS` floats, linear light. */
  tint: Float32Array;
  markerRadius: number;
  markerSelected: number;
  ceiling: number;
  /** Draw the room the capture models: wall, ceiling, and floor out to the wall. */
  roomOn: boolean;
  /** Sphere axis to the wall, metres. */
  wallRadius: number;
  rail: number;
  aimGuides: number;
}

/** The tints in RIG order, which is panel order until somebody uses the switch. */
function tintsFor(slots: readonly number[] | undefined): Float32Array {
  const a = new Float32Array(3 * MAX_PROJECTORS);
  for (let i = 0; i < MAX_PROJECTORS; i++) {
    const slot = slots ? (slots[i] ?? i) : i;
    const t = PROJECTOR_TINTS_LINEAR[slot] ?? ([0.5, 0.5, 0.5] as const);
    a[3 * i] = t[0];
    a[3 * i + 1] = t[1];
    a[3 * i + 2] = t[2];
  }
  return a;
}

/** Panel slot to rig index, or `-1` when that projector is switched off. */
function rigIndexOf(slot: number, slots: readonly number[] | undefined): number {
  if (slot < 0) return -1;
  if (!slots) return slot;
  const i = slots.indexOf(slot);
  return i;
}

const RAMP_SHAPE_CODE: Record<string, number> = {
  linear: 0,
  cosine: 1,
  smoothstep: 2,
  gaussian: 3,
};

/** The shader's code for a ramp shape, or an error naming the ones that exist. */
function rampShapeCode(shape: string): number {
  const code = RAMP_SHAPE_CODE[shape];
  if (code === undefined) {
    throw new Error(
      `unknown rampShape ${JSON.stringify(shape)}; expected one of ${Object.keys(RAMP_SHAPE_CODE).join(', ')}`,
    );
  }
  return code;
}

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
    mesh: options.mesh ?? null,

    // Refused, not defaulted -- see the note in packages/harness/src/uniforms.ts.
    rampShape: rampShapeCode(blend.rampShape),
    widthDeg: blend.widthDeg,
    rampGamma: blend.rampGamma,
    maskLo: blend.maskLoDeg,
    maskHi: blend.maskHiDeg,
    maskBottomOnly: blend.bottomOnly ? 1 : 0,
    maskInterp: scene.maskInterpretation === 'colatitude' ? 1 : 0,
    blendSector: blend.region === 'sector' ? 1 : 0,

    encodeGamma: [scene.encodeGamma.r, scene.encodeGamma.g, scene.encodeGamma.b],
    reflectance: [scene.reflectance.r, scene.reflectance.g, scene.reflectance.b],
    ambient: [scene.ambient.r, scene.ambient.g, scene.ambient.b],
    roomAlbedo: scene.roomAlbedo,

    camPos: [camera.position.x, camera.position.y, camera.position.z],
    camForward: basis.forward,
    camRight: basis.right,
    camUp: basis.up,
    camHalf: basis.half,
    // See `ViewerCamera.imageShift`. Straight off the camera, so the shader and
    // `renderTwoRigRoomView` cannot be handed different framings.
    camShift: camera.imageShift ?? 0,

    overlay: OVERLAY_CODE[options.overlay ?? 'none'],
    overlayMix: options.overlayMix ?? 0.75,
    highlight: rigIndexOf(options.highlight ?? -1, options.slots),
    drawFloor: (options.drawFloor ?? true) ? 1 : 0,
    floorRadius: options.floorRadiusM ?? 8,
    // The nearest perfect square, rounded HERE and in `gridSampleCount` by the
    // same arithmetic, so a caller that asks both renderers for five samples
    // gets four from both.
    sampleGrid: Math.max(1, Math.round(Math.sqrt(Math.max(1, options.samplesPerPixel ?? 1)))),
    pixelUv: [1 / Math.max(1, camera.width), 1 / Math.max(1, camera.height)],
    exposure: options.exposure ?? 1,
    lift: options.lift ?? 1,
    // Straight off the scene, so the shader and `traceTwoRig` are drawing the
    // same pattern from the same numbers rather than two copies of a constant.
    gridDeg: scene.graticule ? scene.graticule.spacingDeg : 0,
    gridWidthDeg: scene.graticule ? scene.graticule.lineWidthDeg : 0,
    gridFeather: DEFAULT_FEATHER_FRAC,
    gridAxes: scene.graticule && scene.graticule.emphasizeAxes ? 1 : 0,
    gridColor: scene.graticule
      ? new Float32Array([scene.graticule.color.r, scene.graticule.color.g, scene.graticule.color.b])
      : new Float32Array([1, 1, 1]),
    displayGamma: options.displayGamma ?? 2.2,

    tint: tintsFor(options.slots),
    markerRadius: options.markerRadiusM ?? 0,
    markerSelected: rigIndexOf(options.markerSelected ?? -1, options.slots),
    ceiling: options.ceilingM ?? 4.27,
    // Opt-IN for the same reason the markers and the floor are: the CPU two-rig
    // renderer draws no room, so anything the display shader draws by default
    // is a difference the parity check reports as a disagreement.
    roomOn: options.roomOn === true,
    wallRadius: options.wallRadiusM ?? 6.0,
    // Opt-IN, exactly like `markerRadiusM` and for exactly the same reason: the
    // CPU two-rig renderer draws no furniture, so anything the display shader
    // draws by default is a difference the parity check reports as a
    // disagreement between two renderers. This defaulted to true and only got
    // away with it because `roomHit` used to refuse to march at all unless the
    // markers were on — so fixing the guard rail's toggle turned the parity
    // check red, which is the check doing its job.
    rail: (options.rail ?? false) ? 1 : 0,
    aimGuides: (options.aimGuides ?? false) ? 1 : 0,
  };
}

/**
 * Which lens marker is under a point on the canvas, or `-1` for none.
 *
 * This mirrors the shader's `markerHit` deliberately: the same ray, the same
 * spheres, the same occlusion by the ball. A click that selects something other
 * than what is visibly under the cursor — a projector hidden behind the sphere,
 * say — is worse than a click that does nothing. It reads the packed uniforms
 * rather than the rig so there is only ever one statement of where a lens is.
 *
 * `ndc` is −1..1 with y up, as the shader's `s` is.
 */
/**
 * Which projector is under a point on the canvas, or `-1` for none.
 *
 * This is a sphere trace against the same signed distance field `glsl.ts` draws —
 * `sdProjector` and `projectorBodyCentre`, transliterated. Two bounding spheres
 * were tried first and were wrong in a way worth recording: a sphere generous
 * enough to cover the body is also generous enough to be hit by a ray that merely
 * passes NEAR a projector, so clicking the far P3 returned the near P1, which the
 * viewer could see was not under the cursor.
 *
 * The rail and the rod are not in this field. They are not pickable, and a click
 * that landed on a handrail and selected nothing would be right.
 *
 * `ndc` is −1..1 with y up, as the shader's `s` is.
 */
export function pickMarker(u: DisplayUniforms, ndcX: number, ndcY: number): number {
  if (u.markerRadius <= 0) return -1;
  const dir = eyeRay(u, ndcX, ndcY);
  const origin = { x: u.camPos[0], y: u.camPos[1], z: u.camPos[2] };

  // Deliberately NOT routed through `Surface`, unlike the rest of the model.
  // This picks against the payload the SHADER is handed, so it has to answer the
  // question the shader would answer: a marker behind whatever is standing in
  // the room is not pickable, and "whatever is standing in the room" stopped
  // being a sphere in Phase 2. A seam here would let the picker and the picture
  // disagree about what was hit — click through a building and select a
  // projector the viewer cannot see.
  //
  // The mesh path asks the SURFACE, which is the simulator's own float64
  // traversal over the hierarchy these texels were packed from -- the same
  // shape, to a different last bit. That difference is nanometres and a click is
  // pixels, so it cannot change an answer; what would change one is asking about
  // a different shape. Writing a third traversal here to match float32 exactly
  // would be a third traversal to keep in agreement.
  const maxT = occluderDistance(u, origin, dir);

  let t = 0.02;
  for (let step = 0; step < PICK_STEPS; step++) {
    if (t >= maxT) return -1;
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    let nearest = 1e9;
    let which = -1;
    for (let i = 0; i < u.projCount; i++) {
      const d = projectorDistance(u, i, px, py, pz);
      if (d < nearest) {
        nearest = d;
        which = i;
      }
    }
    if (nearest < 0.0015) return which;
    t += Math.max(nearest, 0.004);
  }
  return -1;
}

/** March steps. The shader's `ROOM_STEPS`; more would only cost a click. */
const PICK_STEPS = 72;

/**
 * How far the ray gets before the surface stops it, or effectively forever.
 *
 * `1e9` where nothing is hit, matching the shader's own sentinel for the same
 * thing: a marker in front of empty space is pickable at any distance.
 */
function occluderDistance(u: DisplayUniforms, origin: Vec3, dir: Vec3): number {
  const mesh = u.mesh;
  if (mesh === null) {
    const ball = raySphereIntersect(origin, dir, u.physical.radiusM, 1e-9);
    return ball ? ball.t : 1e9;
  }
  const hit = mesh.surface.intersect(origin, dir);
  return hit === null ? 1e9 : hit.t;
}

/**
 * The same pick, widened to the size of a fingertip.
 *
 * `pickMarker` asks what is exactly under one ray, which is the right question
 * for a mouse and the wrong one for a thumb. A projector body is about ten CSS
 * pixels across on a phone and a touch point is nearer forty, so an exact test
 * answers "nothing" for taps that visibly landed on a projector — the whole
 * gesture then does nothing, with no way for the person tapping to tell whether
 * they missed or the page is broken.
 *
 * Sampling rings outward from the tap and taking the first hit means the answer
 * is still the projector NEAREST to where the finger went down, so a tap between
 * two of them cannot silently pick the far one. The centre is always tried
 * first, so a precise pointer keeps its exact behaviour.
 *
 * `radiusX`/`radiusY` are the tolerance in NDC — a pixel radius scaled by the
 * canvas, which is why they are two numbers and not one.
 */
export function pickMarkerNear(
  u: DisplayUniforms,
  ndcX: number,
  ndcY: number,
  radiusX: number,
  radiusY: number,
): number {
  const centre = pickMarker(u, ndcX, ndcY);
  if (centre >= 0 || radiusX <= 0 || radiusY <= 0) return centre;
  for (const scale of PICK_RINGS) {
    for (let k = 0; k < PICK_RING_SAMPLES; k++) {
      const a = (2 * Math.PI * k) / PICK_RING_SAMPLES;
      const hit = pickMarker(
        u,
        ndcX + Math.cos(a) * radiusX * scale,
        ndcY + Math.sin(a) * radiusY * scale,
      );
      if (hit >= 0) return hit;
    }
  }
  return -1;
}

/** Two rings is enough to cover a fingertip without eight more sphere traces. */
const PICK_RINGS = [0.5, 1] as const;
const PICK_RING_SAMPLES = 8;

/**
 * The panel slot a picked projector belongs to.
 *
 * Both pick functions answer in RIG indices, because that is what the packed
 * uniforms are indexed by — and the rig only contains the projectors that are
 * switched on. With P2 off the rig is [P1, P3, P4], so clicking the last marker
 * answers 2, and a caller that treats 2 as a panel slot selects P3 while the
 * viewer is looking at P4. This is the inverse of `rigIndexOf`, and the reason
 * neither direction is done by hand at the call site.
 */
export function slotOfRigIndex(rigIndex: number, slots: readonly number[] | undefined): number {
  if (rigIndex < 0) return -1;
  if (!slots) return rigIndex;
  return slots[rigIndex] ?? rigIndex;
}

/** `glsl.ts` `sdProjector`, in the frame where the lens is the origin. */
function projectorDistance(
  u: DisplayUniforms,
  i: number,
  px: number,
  py: number,
  pz: number,
): number {
  const lx = u.physical.lens[3 * i];
  const ly = u.physical.lens[3 * i + 1];
  const lz = u.physical.lens[3 * i + 2];
  const len = Math.hypot(lx, ly, lz) || 1;
  // Forward points at the sphere centre, which is the origin.
  const fx = -lx / len;
  const fy = -ly / len;
  const fz = -lz / len;
  // The shader's `up0` choice, so the roll of the body matches what is drawn.
  const upz = Math.abs(fz) > 0.98 ? 0 : 1;
  const upx = Math.abs(fz) > 0.98 ? 1 : 0;
  let rx = fy * upz - fz * 0;
  let ry = fz * upx - fx * upz;
  let rz = fx * 0 - fy * upx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const relx = px - lx;
  const rely = py - ly;
  const relz = pz - lz;
  const qx = relx * rx + rely * ry + relz * rz;
  const qy = relx * ux + rely * uy + relz * uz;
  const qz = relx * fx + rely * fy + relz * fz;

  // Barrel: capped cylinder along +z, centre −0.065, half-length 0.065, r 0.068.
  const bd = Math.hypot(qx, qy) - 0.068;
  const bz = Math.abs(qz + 0.065) - 0.065;
  const barrel =
    Math.min(Math.max(bd, bz), 0) + Math.hypot(Math.max(bd, 0), Math.max(bz, 0));

  // Body: box at −0.33 with half-extents (0.17, 0.075, 0.20).
  const ex = Math.abs(qx) - 0.17;
  const ey = Math.abs(qy) - 0.075;
  const ez = Math.abs(qz + 0.33) - 0.2;
  const body =
    Math.hypot(Math.max(ex, 0), Math.max(ey, 0), Math.max(ez, 0)) +
    Math.min(Math.max(ex, Math.max(ey, ez)), 0);

  return Math.min(barrel, body);
}

/**
 * Used by {@link pickMarker}, and by the shader's `main` under another name.
 *
 * `camShift` is applied HERE, because the shader applies it before it builds a
 * ray: `main` traces `(uv * 2.0 - 1.0) + vec2(0.0, uCamShift)` and `traceScene`
 * takes an image coordinate that already carries it. This function did not, so
 * for a screen point the shader drew the ray at `ndcY + camShift` while the
 * picker tested `ndcY` — a pick that was aimed at a different part of the room
 * than the one under the finger.
 *
 * It is zero on a wide window and non-zero on every narrow one: `viewShiftFrac`
 * in `web/main.ts` returns 0 above 820 px and otherwise measures the band of
 * room left between the two sheets, so this was a defect that existed only on
 * phones and in portrait — where `pickMarkerNear`'s fingertip radius exists
 * precisely because picking is hardest. A miss is not inert either: the tap
 * falls through to the "clicked the room" branch, which clears the highlight
 * and shuts the projector card.
 */
export function eyeRay(
  u: DisplayUniforms,
  ndcX: number,
  ndcY: number,
): { x: number; y: number; z: number } {
  const f = { x: u.camForward[0], y: u.camForward[1], z: u.camForward[2] };
  const r = { x: u.camRight[0], y: u.camRight[1], z: u.camRight[2] };
  const up = { x: u.camUp[0], y: u.camUp[1], z: u.camUp[2] };
  const sy = ndcY + u.camShift;
  return normalize({
    x: f.x + r.x * ndcX * u.camHalf[0] + up.x * sy * u.camHalf[1],
    y: f.y + r.y * ndcX * u.camHalf[0] + up.y * sy * u.camHalf[1],
    z: f.z + r.z * ndcX * u.camHalf[0] + up.z * sy * u.camHalf[1],
  });
}
