// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The deterministic CPU ray tracer.
 *
 * Three outputs, in increasing distance from the hardware:
 *
 *   - `renderProjectorView`  — what one projector emits, in its own raster.
 *   - `renderFramebuffer`    — all four quadrant viewports composited into the
 *                              ONE framebuffer that SOS actually drives
 *                              (PARAMETERS.md §3.4). This is the deployment
 *                              target and therefore the primary primitive.
 *   - `renderRoomView`       — a viewer camera looking at the sphere in a room.
 *
 * Determinism, from packages/sim/README.md: every render is a pure function of
 * `(calibration, scene, seed)`. No wall clock, no unseeded randomness, and no
 * reduction whose floating-point order depends on scheduling. Supersampling uses
 * a Halton set offset by a hash of the pixel coordinate and the seed, so a pixel
 * gets the same samples no matter what order pixels are visited in — which keeps
 * the door open for tiling or worker threads later without changing a single
 * output byte.
 */

import type { ChannelTriplet, Vec3 } from '../../calibration/src/index.ts';
import type { EquirectImage, RgbImage } from './equirect.ts';
import { createImage, graticuleCoverage, sampleEquirect } from './equirect.ts';
import { worldLonToTextureLon } from './geometry.ts';
import type { PreparedRig } from './optics.ts';
import { pixelToRay, worldToPixel } from './optics.ts';
import { coverageAndWeights, isIlluminatedAt, polarMask } from './coverage.ts';
import { blendModelApplies } from './surface.ts';
import type { MaskInterpretation } from './coverage.ts';
import type { ProjectorContribution, ShadeInput, ShadingModel } from './shading.ts';
import { lambertianShading } from './shading.ts';
import { hash01, radicalInverse } from './random.ts';
import { viewportPixelRect } from './scene.ts';
import { add, cross, dot, normalize, scale, sub } from './vec.ts';
import { DEG2RAD, clamp } from './vec.ts';

/** The content being shown, plus the surface it is being shown on. */
export interface Scene {
  /** Equirectangular source, LINEAR light. conventions.ts §S, §P. */
  image: EquirectImage;
  /**
   * The encoding exponent the COMPOSITOR assumes when it writes a framebuffer
   * value, per channel.
   *
   * Not the same thing as the projector's `transfer.gamma`, even though the
   * nominal numbers match. This is what the software thinks the display does;
   * `transfer.gamma` is what the display actually does. PARAMETERS.md §3.2's
   * worked example is exactly the case where they differ, and the visible result
   * is a coloured seam that no scalar correction can remove. Keeping them as
   * separate fields is what lets the simulator reproduce that.
   */
  encodeGamma: ChannelTriplet;
  /** Diffuse reflectance of the sphere paint. PARAMETERS.md §1 `rho_R,G,B`. */
  reflectance: ChannelTriplet;
  /** Ambient irradiance on the sphere, relative linear. §5 `E_amb`. */
  ambient: ChannelTriplet;
  /** Wall and floor albedo. §5 `rho_room`. */
  roomAlbedo: number;
  /** How `set bottommask 60,70` is read. docs/AMENDMENTS.md A-02. */
  maskInterpretation: MaskInterpretation;
  /**
   * The alignment graticule, drawn ANALYTICALLY over {@link Scene.image} rather
   * than baked into it. `null` for no graticule.
   *
   * It used to be rasterised into the image, which made the line an artefact of
   * whatever raster that image happened to have: at 1024 texels round a 5.43 m
   * equator one texel is 5.30 mm of sphere, against 0.687 mm for one pixel of a
   * 3840-wide projector — so the pattern the page measures was DISPLAYED about
   * eight times coarser than the thing drawing it, and zooming in showed the
   * texture's own bilinear reconstruction as a diamond lattice.
   *
   * `metrics/grid.ts` has always evaluated it analytically, and says why: the
   * gate is 1.0 mm on a sphere whose projector pixels are ~1.3 mm across, so the
   * metric "cannot afford to inherit the resolution of whatever texture the
   * raster happened to be baked into". The renderers now agree with it. The
   * projector raster is the only quantization left in the chain, which is the
   * same thing a real installation gets.
   */
  graticule: Graticule | null;
}

/** {@link Scene.graticule}. Angles in degrees; see `graticuleCoverage`. */
export interface Graticule {
  spacingDeg: number;
  lineWidthDeg: number;
  emphasizeAxes: boolean;
  /** Linear light, composited over the image by coverage. */
  color: ChannelTriplet;
}

/**
 * The content a projector is sending for one point of the sphere: the image,
 * with the graticule drawn over it at full precision.
 *
 * One function, both renderers — `traceTwoRig` here and `shadeTwoRig` in the
 * page's shader, which ports it line for line. The GPU/CPU parity check is what
 * keeps the port honest.
 */
export function contentAt(scene: Scene, latDeg: number, textureLonDeg: number): ChannelTriplet {
  const base = sampleEquirect(scene.image, latDeg, textureLonDeg);
  const g = scene.graticule;
  if (g === null) return base;
  const c = graticuleCoverage(latDeg, textureLonDeg, g.spacingDeg, g.lineWidthDeg, g.emphasizeAxes);
  if (c <= 0) return base;
  return {
    r: base.r + (g.color.r - base.r) * c,
    g: base.g + (g.color.g - base.g) * c,
    b: base.b + (g.color.b - base.b) * c,
  };
}

/** PARAMETERS.md §1 and §5 nominals, as a ready-made scene. */
export function defaultScene(image: EquirectImage, overrides: Partial<Scene> = {}): Scene {
  return {
    image,
    encodeGamma: overrides.encodeGamma ?? { r: 2.2, g: 2.2, b: 2.2 },
    reflectance: overrides.reflectance ?? { r: 0.9, g: 0.9, b: 0.88 },
    ambient: overrides.ambient ?? { r: 0.04, g: 0.04, b: 0.04 },
    roomAlbedo: overrides.roomAlbedo ?? 0.3,
    maskInterpretation: overrides.maskInterpretation ?? 'latitude',
    graticule: overrides.graticule ?? null,
  };
}

export interface RenderOptions {
  /** Samples per pixel. 1 disables supersampling. */
  samplesPerPixel?: number;
  /** Seed. Two runs with the same seed must be byte-identical. */
  seed?: number;
  shading?: ShadingModel;
  /** Include the floor plane at `z = -h_center`. */
  drawFloor?: boolean;
  /** Radius of the modelled floor disc, metres. Beyond it, background. */
  floorRadiusM?: number;
  /** Linear radiance of everything that is neither sphere nor floor. */
  background?: ChannelTriplet;
  /**
   * Evaluate a projector view on a coarser grid than its own raster.
   *
   * `renderProjectorView` at Boulder's 3840x2160 is eight megapixels through a
   * CPU tracer, which is minutes for a thumbnail nobody will look at closely.
   * Setting these renders the SAME function of the same pixel coordinates at
   * fewer of them — the pixel coordinate handed to `pixelToRay` still spans the
   * full raster, so the field of view, the lens shift and the distortion are all
   * exactly what the projector has. It is a sampling change, not a crop and not
   * a resize.
   *
   * Omit both, and the raster is its own grid: the default is byte-identical to
   * what this function returned before the option existed.
   */
  sampleWidth?: number;
  sampleHeight?: number;
}

const BLACK: ChannelTriplet = { r: 0, g: 0, b: 0 };

/**
 * The signal one projector sends to one surface point, already blended and
 * masked, in ENCODED units ready for the projector's transfer curve.
 *
 * The blend weight multiplies the target radiance in LINEAR light and the result
 * is then encoded — not the other way round. PARAMETERS.md §4.5 works the
 * arithmetic: for two projectors to sum to unity in an overlap each must emit
 * 0.5 linear, which is `0.5^(1/gamma)` = 0.730 encoded at gamma 2.2. Multiplying
 * the encoded signal by 0.5 instead would give 0.365 encoded, 0.106 linear, and
 * the two together would reach 21% of the intended brightness. The seam would be
 * a black band rather than an invisible one.
 */
export function blendedSignal(
  target: ChannelTriplet,
  weight: number,
  encodeGamma: ChannelTriplet,
): ChannelTriplet {
  return {
    r: weight <= 0 ? 0 : Math.pow(clamp(target.r * weight, 0, 1), 1 / encodeGamma.r),
    g: weight <= 0 ? 0 : Math.pow(clamp(target.g * weight, 0, 1), 1 / encodeGamma.g),
    b: weight <= 0 ? 0 : Math.pow(clamp(target.b * weight, 0, 1), 1 / encodeGamma.b),
  };
}

/**
 * Everything about a surface point that both the projector views and the room
 * view need. Computed once so the two renderers cannot drift apart in what they
 * think a given point is showing.
 */
export interface SurfaceSample {
  point: Vec3;
  normal: Vec3;
  latDeg: number;
  lonDeg: number;
  /** The linear radiance the content asks for at this point. */
  target: ChannelTriplet;
  /** Normalized blend weight per projector, mask already applied. */
  weights: number[];
  /**
   * Whether each projector's light reaches this point at all, independent of
   * blend weight. A projector at the outer edge of its ramp carries weight 0 and
   * still emits its black floor here.
   */
  lit: boolean[];
  /** Polar mask attenuation, 1 = unmasked. */
  mask: number;
}

export function sampleSurface(point: Vec3, rig: PreparedRig, scene: Scene): SurfaceSample {
  const normal = rig.surface.normalAt(point);
  const ll = rig.surface.coordAt(point);
  const texLon = worldLonToTextureLon(ll.lonDeg, rig.rotationOffsetDeg);
  // `contentAt`, never `sampleEquirect` directly: the graticule is drawn
  // analytically over the image, so a renderer that reads the texture is
  // reading the content with the pattern missing. This is exactly what happened
  // when the graticule stopped being baked in — `traceTwoRig` and the page's
  // shader were moved onto `contentAt` and this was not, so the sphere showed a
  // grid and the frame the projector was supposedly sending had none. See
  // `test/content.test.ts`, which now refuses to let the two disagree.
  const target = contentAt(scene, ll.latDeg, texLon);
  // The polar mask keys on latitude, and off a sphere `ll.latDeg` is a UV
  // coordinate wearing a latitude's name. Refused rather than applied to a row
  // of texture. See `blendModelApplies`.
  const mask = blendModelApplies(rig.surface)
    ? polarMask(ll.latDeg, rig.blend, scene.maskInterpretation)
    : 1;
  const { weights, lit } = coverageAndWeights(point, normal, rig);
  for (let i = 0; i < weights.length; i++) weights[i] *= mask;
  return { point, normal, latDeg: ll.latDeg, lonDeg: ll.lonDeg, target, weights, lit, mask };
}

/**
 * What projector `i` emits, in its own raster.
 *
 * One ray per pixel through {@link pixelToRay}, intersected with the sphere. A
 * miss is black: the Red Ball procedure masks each projector's content to the
 * sphere's silhouette from its own position, which is what makes the off-sphere
 * flux of PARAMETERS.md §7 a geometric floor rather than a free parameter.
 *
 * The output is ENCODED framebuffer content in [0, 1], not radiance — this is
 * the image that goes down the cable. It is the one place in the pipeline where
 * a non-linear value is correct before the final encode, and it is non-linear
 * because a real framebuffer is.
 */
export function renderProjectorView(
  rig: PreparedRig,
  index: number,
  scene: Scene,
  options: RenderOptions = {},
): RgbImage {
  const proj = rig.projectors[index];
  if (!proj) throw new Error(`no projector at index ${index}`);
  const samples = Math.max(1, Math.floor(options.samplesPerPixel ?? 1));
  const seed = options.seed ?? 0;
  const it = proj.cal.intrinsics;
  const width = Math.max(1, Math.floor(options.sampleWidth ?? it.resX));
  const height = Math.max(1, Math.floor(options.sampleHeight ?? it.resY));
  // How many raster pixels one grid cell spans. Exactly 1 at the default, which
  // is what keeps that path byte-identical.
  const stepX = it.resX / width;
  const stepY = it.resY / height;
  const img = createImage(width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let s = 0; s < samples; s++) {
        const [ox, oy] = sampleOffset(x, y, s, samples, seed);
        // conventions.ts §I: pixel centres at half-integers. With one sample the
        // offsets are exactly (0.5, 0.5), i.e. the pixel centre — and at the
        // default step of 1 the coordinate is exactly `x + 0.5` as before.
        const ray = pixelToRay(proj, (x + ox) * stepX, (y + oy) * stepY);
        const hit = rig.surface.intersect(proj.lens, ray);
        if (!hit) continue;
        const surf = sampleSurface(hit.point, rig, scene);
        const sig = blendedSignal(surf.target, surf.weights[index], scene.encodeGamma);
        r += sig.r;
        g += sig.g;
        b += sig.b;
      }
      const i = 3 * (y * width + x);
      img.data[i] = r / samples;
      img.data[i + 1] = g / samples;
      img.data[i + 2] = b / samples;
    }
  }
  return img;
}

/**
 * The single shared framebuffer, all quadrant viewports composited.
 *
 * PARAMETERS.md §3.4: "The simulator's output primitive should be one
 * framebuffer with four viewports, matching the deployment target." Quadrants
 * with no projector stay black, which is §2's "quadrants go dark" for a 2- or
 * 3-projector install — the X screen does not shrink.
 */
export function renderFramebuffer(rig: PreparedRig, scene: Scene, options: RenderOptions = {}): RgbImage {
  const fb = rig.rig.framebuffer;
  const out = createImage(fb.width, fb.height);
  for (let i = 0; i < rig.projectors.length; i++) {
    const view = renderProjectorView(rig, i, scene, options);
    const rect = viewportPixelRect(rig.projectors[i].cal.viewport, fb.width, fb.height);
    for (let y = 0; y < Math.min(view.height, rect.height); y++) {
      const dstRow = rect.y0 + y;
      if (dstRow < 0 || dstRow >= fb.height) continue;
      for (let x = 0; x < Math.min(view.width, rect.width); x++) {
        const dstCol = rect.x0 + x;
        if (dstCol < 0 || dstCol >= fb.width) continue;
        const s = 3 * (y * view.width + x);
        const d = 3 * (dstRow * fb.width + dstCol);
        out.data[d] = view.data[s];
        out.data[d + 1] = view.data[s + 1];
        out.data[d + 2] = view.data[s + 2];
      }
    }
  }
  return out;
}

/** A viewer standing in the room. PARAMETERS.md §6. */
export interface ViewerCamera {
  position: Vec3;
  /** Point the camera looks at. */
  target: Vec3;
  /** Up hint; the true up is orthogonalized against the view direction. */
  upHint?: Vec3;
  /** Horizontal field of view, degrees. §6 `fov_eye`, nominal 50. */
  fovHDeg: number;
  width: number;
  height: number;
  /**
   * Lens shift, in halves of the frame height. Positive moves the subject DOWN
   * the picture. Zero — the default — is a centred principal point.
   *
   * The same thing PARAMETERS.md §3.1 gives every projector, on the viewer's
   * camera: the optical axis stays where it is pointing and the frame moves
   * across it. It is here rather than in a caller because the alternative is
   * worse. A caller that wants its subject low in the frame can also get there by
   * AIMING above it, and that is not the same picture: the subject then sits off
   * the optical axis, where a rectilinear projection stretches it. At the shift a
   * phone layout wants — about two thirds of a half-frame, in a portrait
   * frustum — that is a 27 degree tilt and it renders the sphere as a visible
   * egg. A shifted principal point keeps the ball on the axis and moves only the
   * window, which is why real projection optics have the control.
   *
   * No metric reads it: like the rest of this struct it exists to decide what a
   * picture contains. The browser's shader carries the same term and its parity
   * check runs both at the same value.
   */
  imageShift?: number;
}

/**
 * A viewer at `d_view` from the sphere centre, at eye height `h_eye`.
 *
 * PARAMETERS.md §6 is emphatic that both the adult (1.60 m) and child (1.15 m)
 * cases must be run: the equator sits at 2.18 m so everybody looks up, children
 * steeply, and children are a large share of the SOS audience. That makes the
 * bottom polar region — the masked one — far more visible than an adult-only
 * view would suggest.
 */
export function viewerAt(
  azimuthDeg: number,
  distanceM: number,
  eyeHeightM: number,
  centerHeightM: number,
  width: number,
  height: number,
  fovHDeg = 50,
): ViewerCamera {
  const a = azimuthDeg * DEG2RAD;
  return {
    position: {
      x: distanceM * Math.cos(a),
      y: distanceM * Math.sin(a),
      z: eyeHeightM - centerHeightM,
    },
    target: { x: 0, y: 0, z: 0 },
    upHint: { x: 0, y: 0, z: 1 },
    fovHDeg,
    width,
    height,
  };
}

/**
 * A viewer camera looking at the sphere in a room.
 *
 * Sphere first, then the floor plane at `z = -h_center` (PARAMETERS.md's
 * Conventions section), then background. The floor is what makes the image read
 * as a sphere in a room rather than a ball on a black field, and it also shows
 * the off-sphere spill: PARAMETERS.md §7 and AMENDMENTS A-01 put more than half
 * of every projector's flux past the sphere, and in a real room that light lands
 * somewhere.
 *
 * ## What the floor receives
 *
 * For a floor point and a lens, the segment between them either clears the
 * sphere or it does not. If it does not, the point is in the sphere's shadow. If
 * it does, then the projector's ray toward that floor point is the same ray —
 * and since it missed the sphere, that pixel's content is black. So a lit floor
 * point receives exactly the projector's black floor, `gain * blackFloor`, and
 * nothing else.
 *
 * That is not a simplification, it is the physics of a silhouette-masked
 * projector, and it is why the black-floor term of §3.2 shows up as a visible
 * rectangle of glow on the floor around the sphere — the single most recognizable
 * feature of a real SOS room photograph.
 */
export function renderRoomView(
  rig: PreparedRig,
  scene: Scene,
  camera: ViewerCamera,
  options: RenderOptions = {},
): RgbImage {
  const samples = Math.max(1, Math.floor(options.samplesPerPixel ?? 1));
  const seed = options.seed ?? 0;
  const shading = options.shading ?? lambertianShading();
  const drawFloor = options.drawFloor ?? true;
  const floorRadius = options.floorRadiusM ?? 8;
  const background = options.background ?? BLACK;

  const forward = normalize(sub(camera.target, camera.position));
  const upHint = camera.upHint ?? { x: 0, y: 0, z: 1 };
  let right = cross(forward, upHint);
  if (dot(right, right) < 1e-18) right = cross(forward, { x: 1, y: 0, z: 0 });
  right = normalize(right);
  const up = cross(right, forward);

  const halfW = Math.tan((camera.fovHDeg * DEG2RAD) / 2);
  // Square pixels: the vertical half-extent follows from the aspect ratio.
  const halfH = (halfW * camera.height) / camera.width;
  // See `ViewerCamera.imageShift`. Added to the image coordinate, not to the
  // aim: the axis stays put and the frame slides along it.
  const shift = camera.imageShift ?? 0;
  const floorZ = -rig.centerHeightM;

  const img = createImage(camera.width, camera.height);
  for (let y = 0; y < camera.height; y++) {
    for (let x = 0; x < camera.width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let s = 0; s < samples; s++) {
        const [ox, oy] = sampleOffset(x, y, s, samples, seed);
        const sx = ((x + ox) / camera.width) * 2 - 1;
        const sy = 1 - ((y + oy) / camera.height) * 2 + shift;
        const dir = normalize(
          add(forward, add(scale(right, sx * halfW), scale(up, sy * halfH))),
        );
        const c = traceRoomRay(camera.position, dir, rig, scene, shading, {
          drawFloor,
          floorRadius,
          floorZ,
          background,
        });
        r += c.r;
        g += c.g;
        b += c.b;
      }
      const i = 3 * (y * camera.width + x);
      img.data[i] = r / samples;
      img.data[i + 1] = g / samples;
      img.data[i + 2] = b / samples;
    }
  }
  return img;
}

interface RoomTraceContext {
  drawFloor: boolean;
  floorRadius: number;
  floorZ: number;
  background: ChannelTriplet;
}

function traceRoomRay(
  origin: Vec3,
  dir: Vec3,
  rig: PreparedRig,
  scene: Scene,
  shading: ShadingModel,
  ctx: RoomTraceContext,
): ChannelTriplet {
  const hit = rig.surface.intersect(origin, dir);
  if (hit) {
    const surf = sampleSurface(hit.point, rig, scene);
    const contributions: ProjectorContribution[] = [];
    for (let i = 0; i < rig.projectors.length; i++) {
      // Every projector whose light REACHES this point contributes, even at
      // blend weight zero — its content is black there, and a black frame still
      // emits `gain * blackFloor` (conventions.ts §P). Skipping those makes the
      // black floor appear and disappear with the blend ramp and erases the
      // overlap uplift of PARAMETERS.md §3.2 from the model entirely.
      if (!surf.lit[i]) continue;
      const w = surf.weights[i];
      const p = rig.projectors[i];
      const toLensVec = sub(p.lens, hit.point);
      const distanceM = Math.hypot(toLensVec.x, toLensVec.y, toLensVec.z);
      contributions.push({
        projector: i,
        signal: blendedSignal(surf.target, w, scene.encodeGamma),
        weight: w,
        incidenceCos: dot(surf.normal, toLensVec) / distanceM,
        distanceM,
        toLens: scale(toLensVec, 1 / distanceM),
        transfer: p.cal.transfer,
        referenceDistanceM: p.distanceM - rig.radiusM,
      });
    }
    const input: ShadeInput = {
      point: hit.point,
      normal: surf.normal,
      viewDir: scale(dir, -1),
      contributions,
      reflectance: scene.reflectance,
      ambient: scene.ambient,
    };
    return shading.shade(input);
  }

  if (!ctx.drawFloor || dir.z >= 0) return ctx.background;
  const t = (ctx.floorZ - origin.z) / dir.z;
  if (!(t > 0)) return ctx.background;
  const p: Vec3 = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: ctx.floorZ };
  if (Math.hypot(p.x, p.y) > ctx.floorRadius) return ctx.background;
  return shadeFloor(p, rig, scene);
}

/** Ambient plus each projector's black-floor leak. See {@link renderRoomView}. */
function shadeFloor(point: Vec3, rig: PreparedRig, scene: Scene): ChannelTriplet {
  const normal: Vec3 = { x: 0, y: 0, z: 1 };
  let r = scene.ambient.r;
  let g = scene.ambient.g;
  let b = scene.ambient.b;

  for (const p of rig.projectors) {
    const toLensVec = sub(p.lens, point);
    const distanceM = Math.hypot(toLensVec.x, toLensVec.y, toLensVec.z);
    if (distanceM === 0) continue;
    const cos = dot(normal, toLensVec) / distanceM;
    if (cos <= 0) continue;
    const dir = scale(toLensVec, 1 / distanceM);
    // Shadow test: does the sphere sit between the floor point and the lens?
    const occl = rig.surface.intersect(point, dir, 1e-6);
    if (occl && occl.t < distanceM) continue;
    // Is the floor point even inside this projector's cone?
    if (worldToPixel(p, point) === null) continue;

    const ref = p.distanceM - rig.radiusM;
    const falloff = (ref * ref) / (distanceM * distanceM);
    const k = cos * falloff;
    const t = p.cal.transfer;
    // Content is black here (the ray missed the sphere), so V = 0 and the
    // transfer of conventions.ts §P collapses to gain * blackFloor.
    r += t.gain.r * t.blackFloor.r * k;
    g += t.gain.g * t.blackFloor.g * k;
    b += t.gain.b * t.blackFloor.b * k;
  }

  return {
    r: r * scene.roomAlbedo,
    g: g * scene.roomAlbedo,
    b: b * scene.roomAlbedo,
  };
}

/**
 * Sub-pixel sample offsets in [0, 1)^2.
 *
 * A Halton (2, 3) set, Cranley-Patterson rotated by a hash of the pixel
 * coordinate and the seed. Three properties, all required:
 *
 *   - Deterministic. Same seed, same pixel, same offsets, forever.
 *   - Order-independent. The offsets are a pure function of `(x, y, s, seed)`,
 *     never of how many samples came before, so tiling or threading the loop
 *     later cannot change a single output byte.
 *   - Decorrelated between pixels. An unrotated Halton set uses the identical
 *     sample positions in every pixel, which turns edge aliasing into a
 *     structured moire that looks exactly like the registration error the
 *     grid-displacement metric is trying to measure.
 *
 * With `samples === 1` the offset is exactly the pixel centre, which is what
 * conventions.ts §I's half-integer convention requires and what makes
 * single-sample renders comparable against an analytic expectation.
 */
export function sampleOffset(
  x: number,
  y: number,
  s: number,
  samples: number,
  seed: number,
): [number, number] {
  if (samples === 1) return [0.5, 0.5];
  const rx = hash01(x, y, seed, 0x9e37);
  const ry = hash01(x, y, seed, 0x85eb);
  const hx = radicalInverse(2, s + 1);
  const hy = radicalInverse(3, s + 1);
  return [(hx + rx) % 1, (hy + ry) % 1];
}

/**
 * Sub-pixel sample offsets on a regular n x n grid, `samples = n * n`.
 *
 * The alternative to `sampleOffset` above, and it exists for exactly one
 * reason: a GPU has to be able to place the identical samples.
 *
 * The Halton set is the better estimator — decorrelating the offsets between
 * pixels turns residual aliasing into noise instead of into a structured moire
 * that looks like the registration error the grid metric is measuring — and it
 * stays the default for anything rendered offline. But it is built out of a
 * radical inverse and an integer hash, and transliterating both into GLSL would
 * mean the browser's shader-versus-model check was comparing two independent
 * PRNG implementations. A disagreement there would be a disagreement about
 * hashing, reported as a disagreement about optics.
 *
 * A regular grid has no such term. `(i + 0.5) / n` is the same rational number
 * in float32 and in float64, so the two renderers integrate the SAME point set
 * and the parity number keeps measuring what it claims to. What it costs is the
 * usual price of an ordered grid: it is a box-filter quadrature, so it converges
 * more slowly than a stratified stochastic set and it can still beat against a
 * periodic pattern. At the 2x2 and 3x3 this is used at, against a graticule line
 * about one screen pixel wide, that is not the binding term — point sampling
 * dropping the line entirely is.
 *
 * With `samples === 1` this is the pixel centre, identical to `sampleOffset`.
 */
export function gridSampleOffset(s: number, samples: number): [number, number] {
  const n = Math.max(1, Math.round(Math.sqrt(samples)));
  const i = s % n;
  const j = Math.floor(s / n) % n;
  return [(i + 0.5) / n, (j + 0.5) / n];
}

/**
 * The sample count a regular grid can actually deliver: the nearest perfect
 * square, never below one.
 *
 * A caller that asks for five gets four rather than a grid with a hole in it,
 * and — the part that matters — the CPU and the GPU round identically because
 * they both round here.
 */
export function gridSampleCount(requested: number): number {
  const n = Math.max(1, Math.round(Math.sqrt(Math.max(1, requested))));
  return n * n;
}

/**
 * Where a surface point lands in each projector's raster — the raw material for
 * the grid-displacement metric of PARAMETERS.md §7.
 *
 * Exported here rather than in a metrics module because it is the tracer's own
 * forward projection, and because a later metrics agent should build on the
 * simulator's projection rather than re-deriving it. (Re-deriving it would be
 * fine too. What is NOT fine is importing the solver's.)
 */
export function surfacePointVisibility(
  latDeg: number,
  lonDeg: number,
  rig: PreparedRig,
): { projector: number; u: number; v: number }[] {
  const point = rig.surface.pointAt({ latDeg, lonDeg });
  const normal = rig.surface.normalAt(point);
  const out: { projector: number; u: number; v: number }[] = [];
  for (const p of rig.projectors) {
    if (!isIlluminatedAt(point, normal, p)) continue;
    const px = worldToPixel(p, point);
    if (px) out.push({ projector: p.index, u: px.u, v: px.v });
  }
  return out;
}
