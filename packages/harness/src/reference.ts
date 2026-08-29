// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A line-for-line TypeScript transliteration of `glsl.ts`.
 *
 * ## What this file is for
 *
 * The harness renders on the GPU. The bench renders on the CPU. docs/ARCHITECTURE.md
 * says those are two implementations of the simulator's OWN model, which is a
 * different thing from the A/B duplication and carries a different risk: they can
 * drift apart silently, and then a human is building intuition from a model
 * nothing scores.
 *
 * A parity test needs both renderers in the same process. This container has no
 * GPU and no display, and CI generally does not either, so the GLSL cannot be
 * executed here at all. What CAN be executed is the same arithmetic, written out
 * in TypeScript from the same source text, and compared against `packages/sim`.
 * That is this file, and `parity.ts` is the comparison.
 *
 * ## The rule this file lives by
 *
 * **Every function here mirrors a function in `glsl.ts` with the same name, the
 * same argument order, and the same statement order.** Not "the same behaviour" —
 * the same shape, so that a diff between the two reads. `test/glsl.test.ts`
 * asserts the name sets match in both directions, so a term added to one and not
 * the other fails the build.
 *
 * It deliberately does NOT import `packages/sim`'s vector, geometry or optics
 * modules. If it did, the parity number would be comparing `sim` against itself
 * through a thin wrapper and would read zero no matter how wrong the shader was.
 *
 * ## Precision
 *
 * float64, not float32. That is a considered choice: this file exists to compare
 * the MODEL against `packages/sim`'s model, and rounding it to float32 would put
 * a 1e-7 floor under a comparison whose whole value is being able to resolve a
 * disagreement in the ninth digit. The float32 term is real and is measured
 * separately — in the browser, where the actual GPU runs, and displayed as the
 * live parity number. See `parity.ts` for the two tolerances and why they differ
 * by nine orders of magnitude.
 */

import type { ChannelTriplet, Vec3 } from '../../calibration/src/index.ts';
import { NEWTON_ITERATIONS } from './glsl.ts';
import type { Mat3x3, TextureData, Uniforms } from './uniforms.ts';

const PI = Math.PI;
const RAD2DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Small vector helpers. These have no GLSL counterpart — they are the language's
// own operators over there — so `glsl.ts`'s function list does not name them and
// `test/glsl.test.ts` does not expect it to.
// ---------------------------------------------------------------------------

function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}
function vadd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function vsub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function vscale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
/** GLSL `cross`. */
function vcross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function vdot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function vlength(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
function vnormalize(a: Vec3): Vec3 {
  const n = vlength(a);
  return n === 0 ? v3(0, 0, 0) : v3(a.x / n, a.y / n, a.z / n);
}
function matVec(m: Mat3x3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}
/** `transpose(m) * v`. For a rotation matrix the transpose is the inverse. */
function matTVec(m: Mat3x3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
    y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
    z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
  };
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function rgb(r: number, g: number, b: number): ChannelTriplet {
  return { r, g, b };
}

/**
 * GL's `texture()` on a 2D sampler with LINEAR filtering, `REPEAT` on S and
 * `CLAMP_TO_EDGE` on T — the state `web/main.ts` sets and the state
 * `sampleEquirect` implies.
 *
 * The half-texel offset is the whole of the correctness here: GL puts texel
 * centres at `(i + 0.5) / size`, which is the same convention conventions.ts §I
 * fixes for projector pixels. One convention for the whole project rather than
 * two that differ by half a texel.
 */
export function textureLinear(tex: TextureData, u: number, v: number): ChannelTriplet {
  const fx = u * tex.width - 0.5;
  const fy = v * tex.height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const wrap = (i: number, n: number): number => {
    const m = i % n;
    return m < 0 ? m + n : m;
  };
  const clampi = (i: number, n: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);

  const xa = wrap(x0, tex.width);
  const xb = wrap(x0 + 1, tex.width);
  const ya = clampi(y0, tex.height);
  const yb = clampi(y0 + 1, tex.height);

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  const ia = 3 * (ya * tex.width + xa);
  const ib = 3 * (ya * tex.width + xb);
  const ic = 3 * (yb * tex.width + xa);
  const id = 3 * (yb * tex.width + xb);
  const d = tex.data;

  return {
    r: d[ia] * w00 + d[ib] * w10 + d[ic] * w01 + d[id] * w11,
    g: d[ia + 1] * w00 + d[ib + 1] * w10 + d[ic + 1] * w01 + d[id + 1] * w11,
    b: d[ia + 2] * w00 + d[ib + 2] * w10 + d[ic + 2] * w01 + d[id + 2] * w11,
  };
}

// ---------------------------------------------------------------------------
// The transliteration. One exported function per GLSL function, same names.
// ---------------------------------------------------------------------------

/**
 * `sim/src/vec.ts` `wrapDeg180`, and the reason `glsl.ts` cannot use GLSL's
 * `mod`: `mod` is floored and JavaScript's `%` is truncated, so they disagree in
 * sign for every negative longitude.
 */
export function wrapDeg180(deg: number): number {
  let d = deg - 360 * Math.trunc(deg / 360);
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** `sim/src/geometry.ts` `raySphereIntersect`. Returns `t`, or -1 for a miss. */
export function raySphereIntersect(origin: Vec3, dir: Vec3, radius: number, tMin: number): number {
  const h = vdot(origin, dir);
  const m = vsub(origin, vscale(dir, h));
  const disc = radius * radius - vdot(m, m);
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const c = vdot(origin, origin) - radius * radius;
  const q = -(h + (h >= 0 ? sq : -sq));
  let t0: number;
  let t1: number;
  if (q === 0) {
    t0 = -sq;
    t1 = sq;
  } else {
    t0 = q;
    t1 = c / q;
  }
  if (t0 > t1) {
    const s = t0;
    t0 = t1;
    t1 = s;
  }
  if (t0 > tMin) return t0;
  if (t1 > tMin) return t1;
  return -1;
}

/** `sim/src/geometry.ts` `worldToLatLon`. Returns `[latDeg, lonDeg]`. */
export function worldToLatLon(p: Vec3): [number, number] {
  const r = vlength(p);
  if (r === 0) return [0, 0];
  return [Math.asin(clamp(p.z / r, -1, 1)) * RAD2DEG, Math.atan2(p.y, p.x) * RAD2DEG];
}

/** `sim/src/equirect.ts` `sampleEquirect`, through the GL sampler. */
export function sampleEquirect(u: Uniforms, latDeg: number, lonDeg: number): ChannelTriplet {
  const lon = wrapDeg180(lonDeg);
  return textureLinear(
    u.equirect,
    (lon + 180) / 360,
    (90 - clamp(latDeg, -90, 90)) / 180,
  );
}

/** `sim/src/geometry.ts` `worldLonToTextureLon`. conventions.ts §S. */
export function worldLonToTextureLon(u: Uniforms, worldLonDeg: number): number {
  return wrapDeg180(worldLonDeg - u.rotationOffset);
}

/** `sim/src/coverage.ts` `polarMask`. conventions.ts §M. */
export function polarMask(u: Uniforms, latDeg: number): number {
  const onset = u.maskInterp === 0 ? u.maskLo : 90 - u.maskHi;
  const full = u.maskInterp === 0 ? u.maskHi : 90 - u.maskLo;
  if (u.maskBottomOnly === 1 && latDeg >= 0) return 1;
  const a = Math.abs(latDeg);
  if (a <= onset) return 1;
  if (a >= full) return 0;
  if (full === onset) return 0;
  const t = (a - onset) / (full - onset);
  return 0.5 + 0.5 * Math.cos(PI * t);
}

/** `sim/src/optics.ts` `applyDistortion` with `p1 = p2 = 0` (PARAMETERS.md §3.1). */
export function applyDistortion(x: number, y: number, k1: number, k2: number): [number, number] {
  const r2 = x * x + y * y;
  const radial = 1 + k1 * r2 + k2 * r2 * r2;
  return [x * radial, y * radial];
}

/**
 * `sim/src/optics.ts` `invertDistortion`, at a FIXED iteration count.
 *
 * `sim` runs Newton until the residual is under 1e-14 or twenty steps have gone
 * by. A GPU in float32 cannot reach 1e-14, so the shader runs a fixed eight
 * steps and this mirrors it. Eight steps of a quadratically convergent iteration
 * is far past float32 at any coefficient this rig carries, and the difference
 * against `sim`'s adaptive loop is one of the things the parity number measures
 * rather than something it hides.
 */
export function invertDistortion(
  xd: number,
  yd: number,
  k1: number,
  k2: number,
): [number, number] {
  if (k1 === 0 && k2 === 0) return [xd, yd];
  const r2d = xd * xd + yd * yd;
  const seedRadial = 1 + k1 * r2d + k2 * r2d * r2d;
  let x = seedRadial !== 0 ? xd / seedRadial : xd;
  let y = seedRadial !== 0 ? yd / seedRadial : yd;
  for (let iter = 0; iter < NEWTON_ITERATIONS; iter++) {
    const r2 = x * x + y * y;
    const radial = 1 + k1 * r2 + k2 * r2 * r2;
    const fx = x * radial - xd;
    const fy = y * radial - yd;
    const dr = k1 + 2 * k2 * r2;
    const j00 = radial + 2 * x * x * dr;
    const j01 = 2 * x * y * dr;
    const j11 = radial + 2 * y * y * dr;
    const det = j00 * j11 - j01 * j01;
    if (det === 0) break;
    x -= (j11 * fx - j01 * fy) / det;
    y -= (j00 * fy - j01 * fx) / det;
  }
  return [x, y];
}

/** `sim/src/optics.ts` `pixelToRay`. Raster origin top-left, `v` down. */
export function pixelToRay(u: Uniforms, i: number, px: number, py: number): Vec3 {
  const p = u.projectors[i];
  const [fx, fy, cx, cy] = p.intrinsics;
  const xd = (px - cx) / fx;
  const yd = -(py - cy) / fy;
  const [ix, iy] = invertDistortion(xd, yd, p.raster[2], p.raster[3]);
  return vnormalize(matVec(p.rot, v3(1, -ix, iy)));
}

/** `sim/src/optics.ts` `worldToPixel`. `null` when behind the lens or off-raster. */
export function worldToPixel(u: Uniforms, i: number, worldPoint: Vec3): [number, number] | null {
  const p = u.projectors[i];
  const local = matTVec(p.rot, vsub(worldPoint, p.lens));
  const a = local.x;
  if (!(a > 0)) return null;
  const [fx, fy, cx, cy] = p.intrinsics;
  const [dx, dy] = applyDistortion(-local.y / a, local.z / a, p.raster[2], p.raster[3]);
  const ux = cx + fx * dx;
  const vy = cy - fy * dy;
  if (ux < 0 || ux > p.raster[0] || vy < 0 || vy > p.raster[1]) return null;
  return [ux, vy];
}

/** `sim/src/coverage.ts` `isIlluminatedAt`. PARAMETERS.md §4.1's limb test. */
export function isIlluminatedAt(u: Uniforms, i: number, point: Vec3): boolean {
  const toLens = vsub(u.projectors[i].lens, point);
  if (vdot(point, toLens) <= 0) return false;
  return worldToPixel(u, i, point) !== null;
}

/** `sim/src/blend.ts` `rampValue`. conventions.ts §B, all four shapes. */
export function rampValue(shape: number, t: number): number {
  const x = clamp(t, 0, 1);
  if (shape === 0) return x;
  if (shape === 1) return 0.5 - 0.5 * Math.cos(PI * x);
  if (shape === 2) return x * x * (3 - 2 * x);
  const g0 = Math.exp(-4.5);
  const g = Math.exp(-4.5 * (1 - x) * (1 - x));
  return (g - g0) / (1 - g0);
}

/** `sim/src/blend.ts` `rampWeight`. The exponent goes on the WEIGHT (§B clause 2). */
export function rampWeight(shape: number, t: number, rampGamma: number): number {
  const w = rampValue(shape, t);
  return w === 0 ? 0 : Math.pow(w, rampGamma);
}

/** `sim/src/render.ts` `SurfaceSample`, in the shader's field order. */
export interface Surface {
  point: Vec3;
  normal: Vec3;
  latDeg: number;
  lonDeg: number;
  target: ChannelTriplet;
  weights: number[];
  lit: boolean[];
  mask: number;
}

/** `sim/src/render.ts` `sampleSurface` plus `coverage.ts` `coverageAndWeights`. */
export function sampleSurface(u: Uniforms, point: Vec3): Surface {
  const normal = vscale(point, 1 / u.radius);
  const [latDeg, lonDeg] = worldToLatLon(point);
  const target = sampleEquirect(u, latDeg, worldLonToTextureLon(u, lonDeg));
  const mask = polarMask(u, latDeg);

  const width = u.widthDeg > 0 ? u.widthDeg : 1e-9;
  const weights: number[] = [0, 0, 0, 0];
  const lit: boolean[] = [false, false, false, false];
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    if (i >= u.projCount) continue;
    if (!isIlluminatedAt(u, i, point)) continue;
    lit[i] = true;
    const p = u.projectors[i];
    const cosTheta = clamp(vdot(point, p.lens) / (u.radius * p.limb[0]), -1, 1);
    const thetaDeg = Math.acos(cosTheta) * RAD2DEG;
    const thetaMaxDeg = Math.acos(p.limb[1]) * RAD2DEG;
    weights[i] = rampWeight(u.rampShape, (thetaMaxDeg - thetaDeg) / width, u.rampGamma);
    sum += weights[i];
  }
  if (sum > 0) for (let i = 0; i < 4; i++) weights[i] /= sum;
  for (let i = 0; i < 4; i++) weights[i] *= mask;

  return { point, normal, latDeg, lonDeg, target, weights, lit, mask };
}

/** `sim/src/render.ts` `blendedSignal`. Weight in LINEAR light, encode after. */
export function blendedSignal(u: Uniforms, target: ChannelTriplet, weight: number): ChannelTriplet {
  if (weight <= 0) return rgb(0, 0, 0);
  return rgb(
    Math.pow(clamp(target.r * weight, 0, 1), 1 / u.encodeGamma.r),
    Math.pow(clamp(target.g * weight, 0, 1), 1 / u.encodeGamma.g),
    Math.pow(clamp(target.b * weight, 0, 1), 1 / u.encodeGamma.b),
  );
}

/** `sim/src/photometry.ts` `emittedRadianceRgb`. conventions.ts §P. */
export function emittedRadianceRgb(u: Uniforms, signal: ChannelTriplet, i: number): ChannelTriplet {
  const p = u.projectors[i];
  const one = (v: number, gamma: number, black: number, gain: number): number =>
    gain * ((1 - black) * Math.pow(clamp(v, 0, 1), gamma) + black);
  return rgb(
    one(signal.r, p.gamma.r, p.black.r, p.gain.r),
    one(signal.g, p.gamma.g, p.black.g, p.gain.g),
    one(signal.b, p.gamma.b, p.black.b, p.gain.b),
  );
}

/** `sim/src/shading.ts` `ggxBrdf`. Cook-Torrance with GGX, Smith and Schlick. */
export function ggxBrdf(
  normal: Vec3,
  toLens: Vec3,
  viewDir: Vec3,
  nDotL: number,
  nDotV: number,
  a2: number,
  f0: number,
): number {
  const half = vnormalize(vadd(toLens, viewDir));
  const nDotH = vdot(normal, half);
  if (!(nDotH > 0)) return 0;
  const vDotH = vdot(viewDir, half);
  const denom = nDotH * nDotH * (a2 - 1) + 1;
  const d = a2 / (PI * denom * denom);
  const g1l = (2 * nDotL) / (nDotL + Math.sqrt(a2 + (1 - a2) * nDotL * nDotL));
  const g1v = (2 * nDotV) / (nDotV + Math.sqrt(a2 + (1 - a2) * nDotV * nDotV));
  const oneMinus = 1 - (vDotH > 0 ? vDotH : 0);
  const f = f0 + (1 - f0) * Math.pow(oneMinus, 5);
  return (d * g1l * g1v * f) / (4 * nDotL * nDotV);
}

/** `sim/src/shading.ts` `fullShading`. At `specWeight = 0` this IS `lambertian-v1`. */
export function shadeSurface(u: Uniforms, s: Surface, viewDir: Vec3): ChannelTriplet {
  let dr = u.ambient.r;
  let dg = u.ambient.g;
  let db = u.ambient.b;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  const nDotV = vdot(s.normal, viewDir);
  const kd = 1 - u.specWeight;
  const a2 = u.specAlpha * u.specAlpha;

  for (let i = 0; i < 4; i++) {
    if (i >= u.projCount) continue;
    if (!s.lit[i]) continue;
    const p = u.projectors[i];
    const toLensVec = vsub(p.lens, s.point);
    const distanceM = vlength(toLensVec);
    const incidenceCos = vdot(s.normal, toLensVec) / distanceM;
    const nDotL = incidenceCos > 0 ? incidenceCos : 0;
    if (nDotL === 0) continue;
    const ref = p.limb[0] - u.radius;
    const falloff = (ref * ref) / (distanceM * distanceM);
    const k = nDotL * falloff;
    const e = emittedRadianceRgb(u, blendedSignal(u, s.target, s.weights[i]), i);
    dr += e.r * k;
    dg += e.g * k;
    db += e.b * k;
    if (u.specWeight > 0 && nDotV > 0) {
      const b = PI * ggxBrdf(s.normal, vscale(toLensVec, 1 / distanceM), viewDir, nDotL, nDotV, a2, u.specWeight);
      sr += e.r * k * b;
      sg += e.g * k * b;
      sb += e.b * k * b;
    }
  }

  return rgb(
    dr * (kd * u.reflectance.r) + sr + u.ambient.r * u.specWeight,
    dg * (kd * u.reflectance.g) + sg + u.ambient.g * u.specWeight,
    db * (kd * u.reflectance.b) + sb + u.ambient.b * u.specWeight,
  );
}

/** `sim/src/render.ts` `shadeFloor`: ambient plus each projector's black-floor leak. */
export function shadeFloor(u: Uniforms, point: Vec3): ChannelTriplet {
  const normal = v3(0, 0, 1);
  let r = u.ambient.r;
  let g = u.ambient.g;
  let b = u.ambient.b;

  for (let i = 0; i < 4; i++) {
    if (i >= u.projCount) continue;
    const p = u.projectors[i];
    const toLensVec = vsub(p.lens, point);
    const distanceM = vlength(toLensVec);
    if (distanceM === 0) continue;
    const cosv = vdot(normal, toLensVec) / distanceM;
    if (cosv <= 0) continue;
    const dir = vscale(toLensVec, 1 / distanceM);
    const occl = raySphereIntersect(point, dir, u.radius, 1e-6);
    if (occl > 0 && occl < distanceM) continue;
    if (worldToPixel(u, i, point) === null) continue;
    const ref = p.limb[0] - u.radius;
    const falloff = (ref * ref) / (distanceM * distanceM);
    const k = cosv * falloff;
    r += p.gain.r * p.black.r * k;
    g += p.gain.g * p.black.g * k;
    b += p.gain.b * p.black.b * k;
  }

  return rgb(r * u.roomAlbedo, g * u.roomAlbedo, b * u.roomAlbedo);
}

/** `sim/src/render.ts` `traceRoomRay`. Sphere, then floor, then background. */
export function traceRoomRay(u: Uniforms, origin: Vec3, dir: Vec3): ChannelTriplet {
  const t = raySphereIntersect(origin, dir, u.radius, 1e-9);
  if (t > 0) {
    const s = sampleSurface(u, vadd(origin, vscale(dir, t)));
    return shadeSurface(u, s, vscale(dir, -1));
  }
  if (u.drawFloor === 0 || dir.z >= 0) return rgb(0, 0, 0);
  const floorZ = -u.centerHeight;
  const tf = (floorZ - origin.z) / dir.z;
  if (!(tf > 0)) return rgb(0, 0, 0);
  const p = v3(origin.x + dir.x * tf, origin.y + dir.y * tf, floorZ);
  if (Math.hypot(p.x, p.y) > u.floorRadius) return rgb(0, 0, 0);
  return shadeFloor(u, p);
}

/** `sim/src/render.ts` `renderProjectorView`, one pixel. ENCODED, not radiance. */
export function projectorPixel(u: Uniforms, i: number, px: number, py: number): ChannelTriplet {
  const dir = pixelToRay(u, i, px, py);
  const t = raySphereIntersect(u.projectors[i].lens, dir, u.radius, 1e-9);
  if (t < 0) return rgb(0, 0, 0);
  const s = sampleSurface(u, vadd(u.projectors[i].lens, vscale(dir, t)));
  return blendedSignal(u, s.target, s.weights[i]);
}

// ---------------------------------------------------------------------------
// The two whole-image entry points. `main()` over there, driven by a raster loop
// here, since a fragment shader is invoked once per pixel by the hardware.
// ---------------------------------------------------------------------------

export interface ReferenceImage {
  width: number;
  height: number;
  /** `3 * (y * width + x)`, row 0 at the TOP, matching `sim`'s `RgbImage`. */
  data: Float32Array;
}

/**
 * The room view, rasterized at one sample per pixel.
 *
 * `vUv` in the shader has its origin at the BOTTOM-left, because that is where
 * GL puts it. `sim`'s image buffers have row 0 at the TOP. The flip lives here,
 * once, in the loop that stands in for the hardware's pixel dispatch — exactly
 * where `web/main.ts` relies on GL to do it. Getting it wrong flips the room
 * view upside down, which on a sphere with a floor is obvious, and flips the
 * projector rasters, which is not.
 */
export function renderRoomReference(u: Uniforms, width: number, height: number): ReferenceImage {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const vu = (x + 0.5) / width;
      const vv = 1 - (y + 0.5) / height;
      const sx = vu * 2 - 1;
      const sy = vv * 2 - 1;
      const dir = vnormalize(
        vadd(u.camForward, vadd(vscale(u.camRight, sx * u.camHalf[0]), vscale(u.camUp, sy * u.camHalf[1]))),
      );
      const c = traceRoomRay(u, u.camPos, dir);
      const i = 3 * (y * width + x);
      data[i] = c.r * u.exposure;
      data[i + 1] = c.g * u.exposure;
      data[i + 2] = c.b * u.exposure;
    }
  }
  return { width, height, data };
}

/**
 * One projector's own raster, at `width`x`height` samples spread across it.
 *
 * Rendering the full 1920x1080 would take minutes on a CPU and prove nothing the
 * subsample does not: the parity question is whether the two models agree at a
 * point, not whether they agree about how many points there are. The sample grid
 * maps to pixel centres of a `width`x`height` raster scaled onto the projector's,
 * so a caller passing the projector's real resolution gets the real thing.
 */
export function renderProjectorReference(
  u: Uniforms,
  i: number,
  width: number,
  height: number,
): ReferenceImage {
  const data = new Float32Array(width * height * 3);
  const resX = u.projectors[i].raster[0];
  const resY = u.projectors[i].raster[1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = projectorPixel(u, i, ((x + 0.5) / width) * resX, ((y + 0.5) / height) * resY);
      const o = 3 * (y * width + x);
      data[o] = c.r;
      data[o + 1] = c.g;
      data[o + 2] = c.b;
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// The hierarchy traversal — CHUNK_MESH, line for line
// ---------------------------------------------------------------------------

/**
 * `packedTexel`, which in GLSL is a `texelFetch` and here is an offset.
 *
 * The layout is `sim/src/mesh/pack.ts`'s and neither side decides it. Returned
 * as a four-tuple rather than an object because the shader reads `.xyz` and `.w`
 * off a `vec4` and the transliteration should look like what it mirrors.
 */
export function packedTexel(
  data: Float32Array,
  width: number,
  i: number,
): [number, number, number, number] {
  // `ivec2(i % width, i / width)` then row-major — which for a flat array is
  // just `4 * i`, and writing it the long way would obscure that the two agree.
  const a = 4 * i;
  return [data[a], data[a + 1], data[a + 2], data[a + 3]];
}

const PACK_WIDTH_REF = 1024;
const NODE_TEXELS_REF = 2;
const TRI_TEXELS_REF = 6;
const BVH_STACK_REF = 32;

/** `rayBoxNear`. -1 for a miss, as the shader returns, not `Infinity`. */
export function rayBoxNear(
  bmin: Vec3,
  bmax: Vec3,
  origin: Vec3,
  invDir: Vec3,
  tMin: number,
  tMax: number,
): number {
  const t0x = (bmin.x - origin.x) * invDir.x;
  const t1x = (bmax.x - origin.x) * invDir.x;
  const t0y = (bmin.y - origin.y) * invDir.y;
  const t1y = (bmax.y - origin.y) * invDir.y;
  const t0z = (bmin.z - origin.z) * invDir.z;
  const t1z = (bmax.z - origin.z) * invDir.z;
  const lo = Math.max(
    Math.max(Math.min(t0x, t1x), Math.min(t0y, t1y)),
    Math.min(t0z, t1z),
  );
  const hi = Math.min(
    Math.min(Math.max(t0x, t1x), Math.max(t0y, t1y)),
    Math.max(t0z, t1z),
  );
  if (hi < Math.max(lo, tMin) || lo > tMax) return -1;
  return Math.max(lo, tMin);
}

/** `rayTriangleAt`. `[t, u, v]`, with `t < 0` for a miss. */
export function rayTriangleAt(
  u: Uniforms,
  tri: number,
  origin: Vec3,
  dir: Vec3,
): [number, number, number] {
  const mesh = u.mesh;
  if (mesh === null) return [-1, 0, 0];
  const base = tri * TRI_TEXELS_REF;
  const ta = packedTexel(mesh.triangles, mesh.triangleWidth, base);
  const tb = packedTexel(mesh.triangles, mesh.triangleWidth, base + 1);
  const tc = packedTexel(mesh.triangles, mesh.triangleWidth, base + 2);
  const a: Vec3 = { x: ta[0], y: ta[1], z: ta[2] };
  const b: Vec3 = { x: tb[0], y: tb[1], z: tb[2] };
  const c: Vec3 = { x: tc[0], y: tc[1], z: tc[2] };

  const e1 = vsub(b, a);
  const e2 = vsub(c, a);
  const pv = vcross(dir, e2);
  const det = vdot(e1, pv);
  if (det > -1e-12 && det < 1e-12) return [-1, 0, 0];

  const inv = 1 / det;
  const tv = vsub(origin, a);
  const bu = vdot(tv, pv) * inv;
  if (bu < -1e-9 || bu > 1 + 1e-9) return [-1, 0, 0];

  const qv = vcross(tv, e1);
  const bv = vdot(dir, qv) * inv;
  if (bv < -1e-9 || bu + bv > 1 + 1e-9) return [-1, 0, 0];

  return [vdot(e2, qv) * inv, bu, bv];
}

/** `bvhIntersect`. `[t, triangle, u, v]`, with `t < 0` for a miss. */
export function bvhIntersect(
  u: Uniforms,
  origin: Vec3,
  dir: Vec3,
  tMin: number,
  tMax: number,
): [number, number, number, number] {
  const mesh = u.mesh;
  if (mesh === null || mesh.nodeCount === 0) return [-1, 0, 0, 0];
  const invDir: Vec3 = { x: 1 / dir.x, y: 1 / dir.y, z: 1 / dir.z };

  let bestT = tMax;
  let best: [number, number, number, number] = [-1, 0, 0, 0];

  const stack = new Int32Array(BVH_STACK_REF);
  let sp = 0;
  stack[sp++] = 0;

  const box = (node: number): { lo: number[]; hi: number[] } => {
    const na = node * NODE_TEXELS_REF;
    return {
      lo: packedTexel(mesh.nodes, mesh.nodeWidth, na),
      hi: packedTexel(mesh.nodes, mesh.nodeWidth, na + 1),
    };
  };

  while (sp > 0) {
    const node = stack[--sp];
    const { lo, hi } = box(node);
    const near = rayBoxNear(
      { x: lo[0], y: lo[1], z: lo[2] },
      { x: hi[0], y: hi[1], z: hi[2] },
      origin,
      invDir,
      tMin,
      bestT,
    );
    if (near < 0) continue;

    const link = lo[3];
    if (link < 0) {
      const from = Math.trunc(hi[3]);
      const to = from + Math.trunc(-link);
      for (let i = from; i < to; i++) {
        const h = rayTriangleAt(u, i, origin, dir);
        if (h[0] < 0) continue;
        if (h[0] <= tMin || h[0] >= bestT) continue;
        bestT = h[0];
        best = [h[0], i, h[1], h[2]];
      }
      continue;
    }

    const left = node + 1;
    const right = Math.trunc(link);
    const bl = box(left);
    const br = box(right);
    const dLeft = rayBoxNear(
      { x: bl.lo[0], y: bl.lo[1], z: bl.lo[2] },
      { x: bl.hi[0], y: bl.hi[1], z: bl.hi[2] },
      origin, invDir, tMin, bestT,
    );
    const dRight = rayBoxNear(
      { x: br.lo[0], y: br.lo[1], z: br.lo[2] },
      { x: br.hi[0], y: br.hi[1], z: br.hi[2] },
      origin, invDir, tMin, bestT,
    );
    // `!(d < 0)`, not `d >= 0`, and the difference is NaN.
    //
    // An axis-parallel ray has an infinite reciprocal on that axis, and a slab
    // plane the origin sits exactly on then gives `0 * Infinity = NaN`. The
    // simulator's test is `!== Infinity`, which ADMITS a NaN and descends; the
    // obvious transliteration `>= 0` rejects it and prunes a subtree that
    // contains geometry. That is a hole in the model, on exactly the rays a
    // viewer looking straight down an axis produces.
    if (dLeft <= dRight) {
      if (!(dRight < 0) && sp < BVH_STACK_REF) stack[sp++] = right;
      if (!(dLeft < 0) && sp < BVH_STACK_REF) stack[sp++] = left;
    } else {
      if (!(dLeft < 0) && sp < BVH_STACK_REF) stack[sp++] = left;
      if (!(dRight < 0) && sp < BVH_STACK_REF) stack[sp++] = right;
    }
  }
  return best;
}

/** `bvhNormalAt`. Zero vertex normals mean the file carried none. */
export function bvhNormalAt(u: Uniforms, tri: number, bu: number, bv: number): Vec3 {
  const mesh = u.mesh;
  if (mesh === null) return { x: 0, y: 0, z: 1 };
  const base = tri * TRI_TEXELS_REF;
  const n0 = packedTexel(mesh.triangles, mesh.triangleWidth, base + 3);
  const n1 = packedTexel(mesh.triangles, mesh.triangleWidth, base + 4);
  const n2 = packedTexel(mesh.triangles, mesh.triangleWidth, base + 5);
  const w0 = 1 - bu - bv;
  let n: Vec3 = {
    x: w0 * n0[0] + bu * n1[0] + bv * n2[0],
    y: w0 * n0[1] + bu * n1[1] + bv * n2[1],
    z: w0 * n0[2] + bu * n1[2] + bv * n2[2],
  };
  if (vdot(n, n) <= 0) {
    const a = packedTexel(mesh.triangles, mesh.triangleWidth, base);
    const b = packedTexel(mesh.triangles, mesh.triangleWidth, base + 1);
    const c = packedTexel(mesh.triangles, mesh.triangleWidth, base + 2);
    n = vcross(
      { x: b[0] - a[0], y: b[1] - a[1], z: b[2] - a[2] },
      { x: c[0] - a[0], y: c[1] - a[1], z: c[2] - a[2] },
    );
  }
  const len = Math.hypot(n.x, n.y, n.z);
  return len === 0 ? { x: 0, y: 0, z: 1 } : { x: n.x / len, y: n.y / len, z: n.z / len };
}

/** `bvhCoordAt`. `[latDeg, lonDeg]`, through the equirectangular convention. */
export function bvhCoordAt(u: Uniforms, tri: number, bu: number, bv: number): [number, number] {
  const mesh = u.mesh;
  if (mesh === null) return [0, 0];
  const base = tri * TRI_TEXELS_REF;
  const p0 = packedTexel(mesh.triangles, mesh.triangleWidth, base);
  const p1 = packedTexel(mesh.triangles, mesh.triangleWidth, base + 1);
  const p2 = packedTexel(mesh.triangles, mesh.triangleWidth, base + 2);
  const q0 = packedTexel(mesh.triangles, mesh.triangleWidth, base + 3);
  const q1 = packedTexel(mesh.triangles, mesh.triangleWidth, base + 4);
  const q2 = packedTexel(mesh.triangles, mesh.triangleWidth, base + 5);
  const w0 = 1 - bu - bv;
  const uu = w0 * p0[3] + bu * p1[3] + bv * p2[3];
  const vv = w0 * q0[3] + bu * q1[3] + bv * q2[3];
  return [90 - vv * 180, uu * 360 - 180];
}
