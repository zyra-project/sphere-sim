/**
 * The display shader: a two-calibration room view, on the GPU.
 *
 * ## This shader is allowed to be approximate. It is NOT allowed to be a source.
 *
 * Everything the page prints as a number comes from `packages/sim`, computed on
 * the CPU in a worker. This shader exists to make the sphere move at sixty
 * frames a second while a slider is being dragged, and it produces exactly one
 * thing: pixels. No readout, no metric and no verdict is ever taken from it.
 *
 * That division is the reason the page can afford a fast renderer at all. It is
 * also why `parity.ts` exists: a display that drifts from the model is a display
 * that teaches a person the wrong intuition, so the page renders a patch of
 * pixels both ways — this shader on the GPU, `sim`'s `traceTwoRig` on the CPU —
 * and puts the disagreement on screen where it cannot be missed. The number is
 * measured, not asserted.
 *
 * ## Why it is a third implementation and not the harness's
 *
 * `packages/harness/src/glsl.ts` is a single-calibration renderer with a
 * verified parity chain: a line-for-line TypeScript transliteration, a
 * structural test that neither side may grow a function the other lacks, and a
 * headless comparison against `packages/sim` in CI. That is a load-bearing
 * artifact and extending it to two rigs would mean editing all three.
 *
 * A single-calibration renderer also cannot show what this page is about. A
 * forward model run against itself paints the physically correct texel at the
 * physically correct point, always — the aim decides both where the pixel goes
 * and what goes in it, so the errors cancel and the picture is perfect no matter
 * how badly the rig is mounted. Misregistration only exists as a disagreement
 * between two calibrations.
 *
 * So this is its own file, mirroring `packages/sim/src/misregistration.ts`
 * rather than the harness. The four steps below are that module's four steps.
 *
 * ## The trace
 *
 *   1. Eye ray -> the PHYSICAL sphere -> surface point `X`.
 *   2. For each PHYSICAL projector that lights `X`: which of its pixels is that?
 *      (`worldToPixel` in the physical rig.)
 *   3. What did the compositor write there? Send that pixel back out through the
 *      CONTENT rig — `pixelToRay`, intersect the CONTENT sphere — reaching `X'`,
 *      and read the content, the blend weight and the mask at `X'`.
 *   4. Emit that signal from the physical lens toward `X`, and shade.
 *
 * When the two calibrations agree, `X' = X` and the picture is correct. When
 * they disagree, each projector paints the texel from where it believes it is
 * pointing, which is what doubles and kinks the grid lines.
 *
 * ## Known approximations, each deliberate
 *
 *  - **float32.** The CPU model is float64. This dominates the parity delta.
 *  - **Eight Newton steps** in the distortion inversion, where `sim` iterates to
 *    1e-14. float32 cannot reach 1e-14 and a tolerance test it can never satisfy
 *    just burns the loop. Eight steps of a quadratically convergent iteration is
 *    far past float32 at any coefficient this rig carries.
 *  - **One sample per pixel.** A live window supersamples by being looked at for
 *    more than one frame.
 *  - **`p1`, `p2` dropped.** PARAMETERS.md §3.1 holds tangential distortion at
 *    zero and this page offers no control that moves it, so the terms are absent
 *    rather than carried as dead uniforms.
 *
 * The parity readout measures all four at once. That is the point of measuring
 * it rather than reasoning about it.
 */

/** Iterations of Newton's method in `invertDistortion`. See the module note. */
export const NEWTON_ITERATIONS = 8;

/** PARAMETERS.md §2 caps an SOS install at four projectors. */
export const MAX_PROJECTORS = 4;

/**
 * Full-screen triangle from `gl_VertexID`. No vertex buffer, so nothing is
 * allocated when the rig changes shape and there is nothing to leak.
 */
export const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  vUv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

const int MAX_PROJ = ${MAX_PROJECTORS};
const int NEWTON_ITERATIONS = ${NEWTON_ITERATIONS};
const float PI = 3.141592653589793;
const float RAD2DEG = 57.29577951308232;

uniform int   uProjCount;

// The PHYSICAL rig: where the lenses actually are.
uniform float uRadius;
uniform float uCenterHeight;
uniform vec3  uLens[MAX_PROJ];
uniform mat3  uRot[MAX_PROJ];         // world <- canonical camera frame (conventions.ts section R)
uniform vec4  uIntr[MAX_PROJ];        // fx, fy, cx, cy (conventions.ts section I)
uniform vec4  uRaster[MAX_PROJ];      // resX, resY, k1, k2
uniform vec2  uLimb[MAX_PROJ];        // lens distance to sphere centre, R/d

// The CONTENT rig: what the compositor believes. Identical fields, and when the
// two are equal every X' below lands exactly on its X.
uniform float uCRadius;
uniform float uCRotOffset;
uniform vec3  uCLens[MAX_PROJ];
uniform mat3  uCRot[MAX_PROJ];
uniform vec4  uCIntr[MAX_PROJ];
uniform vec4  uCRaster[MAX_PROJ];
uniform vec2  uCLimb[MAX_PROJ];

// Blend and mask are the COMPOSITOR's, evaluated at X' — the weights are a
// property of the calibration the content was generated against, not of where
// the light physically landed.
uniform int   uRampShape;             // 0 linear, 1 cosine, 2 smoothstep, 3 gaussian
uniform float uWidthDeg;
uniform float uRampGamma;
uniform float uMaskLo;
uniform float uMaskHi;
uniform int   uMaskBottomOnly;
uniform int   uMaskInterp;            // 0 latitude (section 4.4's reading), 1 colatitude (A-02)

uniform vec3  uEncodeGamma;
uniform vec3  uReflectance;
uniform vec3  uAmbient;
uniform float uRoomAlbedo;
uniform vec3  uGamma[MAX_PROJ];
uniform vec3  uBlack[MAX_PROJ];
uniform vec3  uGain[MAX_PROJ];

uniform vec3  uCamPos;
uniform vec3  uCamForward;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec2  uCamHalf;               // tan(fov/2) horizontal, and vertical

uniform int   uDrawFloor;
uniform float uFloorRadius;
uniform float uExposure;
uniform float uDisplayGamma;          // 0 disables the final encode (linear readback)

// Diagnostic overlays. Each is a way of LOOKING at the same trace, never a
// different trace: they recolour what step 3 already computed.
uniform int   uOverlay;               // 0 none, 1 overlap count, 2 seam bands, 3 unlit
uniform float uOverlayMix;
uniform int   uHighlight;             // -1 none, else a projector index to isolate

uniform sampler2D uEquirect;

in vec2 vUv;
out vec4 fragColor;
`;

/**
 * `packages/sim/src/vec.ts` `wrapDeg180`.
 *
 * GLSL's `mod` is floored and JavaScript's `%` is truncated. Using `mod` here
 * would put every negative longitude a full turn from where the CPU model puts
 * it — which on a four-way symmetric rig looks entirely plausible.
 */
const CHUNK_WRAP = `
float wrapDeg180(float deg) {
  float d = deg - 360.0 * trunc(deg / 360.0);
  if (d <= -180.0) d += 360.0;
  if (d > 180.0) d -= 360.0;
  return d;
}
`;

/**
 * `packages/sim/src/geometry.ts` `raySphereIntersect`, in the geometric form.
 *
 * The textbook `b*b - 4ac` is a difference of two numbers around 27 m² at this
 * geometry and loses half the mantissa exactly at the limb. In float32 that is
 * not academic — it is a visibly ragged silhouette.
 */
const CHUNK_SPHERE = `
float raySphereIntersect(vec3 origin, vec3 dir, float radius, float tMin) {
  float h = dot(origin, dir);
  vec3 m = origin - h * dir;
  float disc = radius * radius - dot(m, m);
  if (disc < 0.0) return -1.0;
  float sq = sqrt(disc);
  float c = dot(origin, origin) - radius * radius;
  float q = -(h + (h >= 0.0 ? sq : -sq));
  float t0;
  float t1;
  if (q == 0.0) { t0 = -sq; t1 = sq; } else { t0 = q; t1 = c / q; }
  if (t0 > t1) { float s = t0; t0 = t1; t1 = s; }
  if (t0 > tMin) return t0;
  if (t1 > tMin) return t1;
  return -1.0;
}

vec2 worldToLatLon(vec3 p) {
  float r = length(p);
  if (r == 0.0) return vec2(0.0, 0.0);
  return vec2(asin(clamp(p.z / r, -1.0, 1.0)) * RAD2DEG, atan(p.y, p.x) * RAD2DEG);
}
`;

/** `packages/sim/src/equirect.ts` `sampleEquirect`, delegated to the sampler. */
const CHUNK_EQUIRECT = `
vec3 sampleEquirect(float latDeg, float lonDeg) {
  float lon = wrapDeg180(lonDeg);
  float u = (lon + 180.0) / 360.0;
  float v = (90.0 - clamp(latDeg, -90.0, 90.0)) / 180.0;
  return texture(uEquirect, vec2(u, v)).rgb;
}
`;

/** `packages/sim/src/coverage.ts` `polarMask`, conventions.ts §M. */
const CHUNK_MASK = `
float polarMask(float latDeg) {
  float onset = uMaskInterp == 0 ? uMaskLo : 90.0 - uMaskHi;
  float full  = uMaskInterp == 0 ? uMaskHi : 90.0 - uMaskLo;
  if (uMaskBottomOnly == 1 && latDeg >= 0.0) return 1.0;
  float a = abs(latDeg);
  if (a <= onset) return 1.0;
  if (a >= full) return 0.0;
  if (full == onset) return 0.0;
  float t = (a - onset) / (full - onset);
  return 0.5 + 0.5 * cos(PI * t);
}
`;

/**
 * `packages/sim/src/optics.ts` — conventions.ts §I and §D, with `p1 = p2 = 0`.
 *
 * Every function takes its rig's arrays explicitly rather than reading a global,
 * because this shader runs each of them against BOTH rigs and a function that
 * silently picked one would be the exact bug the page exists to show.
 */
const CHUNK_OPTICS = `
vec2 applyDistortion(vec2 p, float k1, float k2) {
  float r2 = dot(p, p);
  return p * (1.0 + k1 * r2 + k2 * r2 * r2);
}

vec2 invertDistortion(vec2 d, float k1, float k2) {
  if (k1 == 0.0 && k2 == 0.0) return d;
  float r2d = dot(d, d);
  float seedRadial = 1.0 + k1 * r2d + k2 * r2d * r2d;
  vec2 p = seedRadial != 0.0 ? d / seedRadial : d;
  for (int iter = 0; iter < NEWTON_ITERATIONS; iter++) {
    float r2 = dot(p, p);
    float radial = 1.0 + k1 * r2 + k2 * r2 * r2;
    vec2 f = p * radial - d;
    float dr = k1 + 2.0 * k2 * r2;
    float j00 = radial + 2.0 * p.x * p.x * dr;
    float j01 = 2.0 * p.x * p.y * dr;
    float j11 = radial + 2.0 * p.y * p.y * dr;
    float det = j00 * j11 - j01 * j01;
    if (det == 0.0) break;
    p -= vec2(j11 * f.x - j01 * f.y, j00 * f.y - j01 * f.x) / det;
  }
  return p;
}

// Canonical frame: optical axis +X, right -Y, up +Z (conventions.ts section R).
vec3 rayFrom(mat3 rot, vec4 intr, vec2 kk, float u, float v) {
  float xd = (u - intr.z) / intr.x;
  float yd = -(v - intr.w) / intr.y;
  vec2 ideal = invertDistortion(vec2(xd, yd), kk.x, kk.y);
  return normalize(rot * vec3(1.0, -ideal.x, ideal.y));
}

bool pixelOf(vec3 lens, mat3 rot, vec4 intr, vec4 raster, vec3 worldPoint, out vec2 px) {
  vec3 local = transpose(rot) * (worldPoint - lens);
  float a = local.x;
  if (!(a > 0.0)) return false;
  vec2 d = applyDistortion(vec2(-local.y / a, local.z / a), raster.z, raster.w);
  px = vec2(intr.z + intr.x * d.x, intr.w - intr.y * d.y);
  return px.x >= 0.0 && px.x <= raster.x && px.y >= 0.0 && px.y <= raster.y;
}

// coverage.ts isIlluminatedAt: the point must face the lens AND land on the raster.
bool illuminated(int i, vec3 point, out vec2 px) {
  vec3 toLens = uLens[i] - point;
  if (dot(point, toLens) <= 0.0) return false;
  return pixelOf(uLens[i], uRot[i], uIntr[i], uRaster[i], point, px);
}
`;

/**
 * `packages/sim/src/blend.ts` — conventions.ts §B.
 *
 * `rampGamma` is applied to the WEIGHT, never to the signal. Applying it to the
 * signal would be a per-projector gamma adjustment and would break the
 * normalization, which is the clause that stops a ramp exponent from being able
 * to create a luminance step at all.
 */
const CHUNK_BLEND = `
float rampValue(int shape, float t) {
  float x = clamp(t, 0.0, 1.0);
  if (shape == 0) return x;
  if (shape == 1) return 0.5 - 0.5 * cos(PI * x);
  if (shape == 2) return x * x * (3.0 - 2.0 * x);
  float g0 = exp(-4.5);
  float g = exp(-4.5 * (1.0 - x) * (1.0 - x));
  return (g - g0) / (1.0 - g0);
}

float rampWeight(int shape, float t, float rampGamma) {
  float w = rampValue(shape, t);
  return w == 0.0 ? 0.0 : pow(w, rampGamma);
}

// coverageAndWeights, evaluated in the CONTENT rig at the back-projected point.
// Returns the normalized weight of projector 'want' and, through 'count', how
// many content projectors light that point — which is the overlap multiplicity
// the overlay draws.
float contentWeight(vec3 x, int want, out int count) {
  float width = uWidthDeg > 0.0 ? uWidthDeg : 1e-9;
  float sum = 0.0;
  float mine = 0.0;
  count = 0;
  for (int i = 0; i < MAX_PROJ; i++) {
    if (i >= uProjCount) continue;
    vec3 toLens = uCLens[i] - x;
    if (dot(x, toLens) <= 0.0) continue;
    vec2 px;
    if (!pixelOf(uCLens[i], uCRot[i], uCIntr[i], uCRaster[i], x, px)) continue;
    count++;
    float cosTheta = clamp(dot(x, uCLens[i]) / (uCRadius * uCLimb[i].x), -1.0, 1.0);
    float thetaDeg = acos(cosTheta) * RAD2DEG;
    float thetaMaxDeg = acos(uCLimb[i].y) * RAD2DEG;
    float w = rampWeight(uRampShape, (thetaMaxDeg - thetaDeg) / width, uRampGamma);
    sum += w;
    if (i == want) mine = w;
  }
  return sum > 0.0 ? mine / sum : 0.0;
}
`;

/**
 * `packages/sim/src/render.ts` `blendedSignal` and `photometry.ts`
 * `emittedRadianceRgb` — conventions.ts §P.
 *
 * The weight multiplies the target radiance in LINEAR light and the result is
 * encoded afterwards, not the other way round. PARAMETERS.md §4.5 works the
 * counterexample: multiplying the ENCODED signal by 0.5 gives 0.106 linear per
 * projector and turns every seam into a black band.
 */
const CHUNK_TRANSFER = `
vec3 blendedSignal(vec3 target, float weight) {
  if (weight <= 0.0) return vec3(0.0);
  vec3 t = clamp(target * weight, 0.0, 1.0);
  return pow(t, 1.0 / uEncodeGamma);
}

vec3 emittedRadianceRgb(vec3 signal, int i) {
  vec3 v = clamp(signal, 0.0, 1.0);
  return uGain[i] * ((1.0 - uBlack[i]) * pow(v, uGamma[i]) + uBlack[i]);
}
`;

/**
 * The two-rig trace. `packages/sim/src/misregistration.ts` `traceTwoRig`.
 *
 * There is no view direction, because there is nothing that needs one. The CPU
 * counterpart shades with `lambertianShading`, which is view-independent; the
 * specular lobe PARAMETERS.md §1 describes lives in `fullShading` and is what
 * the PHOTOMETRIC metrics are computed against, not the geometric ones. Carrying
 * a parameter the model does not use would suggest this renderer is doing
 * something the one it is checked against is not.
 *
 * `overlapCount` and `litCount` are carried out for the overlays. They are
 * by-products of the trace rather than a second pass, so an overlay can never
 * disagree with the picture it is drawn over.
 */
const CHUNK_TRACE = `
vec3 shadeTwoRig(vec3 point, out int overlapCount, out int litCount) {
  vec3 normal = point / uRadius;
  vec3 diffuse = uAmbient;
  overlapCount = 0;
  litCount = 0;

  for (int i = 0; i < MAX_PROJ; i++) {
    if (i >= uProjCount) continue;
    vec2 px;
    if (!illuminated(i, point, px)) continue;
    litCount++;
    if (uHighlight >= 0 && uHighlight != i) continue;

    // Step 3: what the compositor wrote into that pixel, found by sending the
    // pixel back out through the calibration the compositor believed it had.
    vec3 signal = vec3(0.0);
    vec3 dir = rayFrom(uCRot[i], uCIntr[i], uCRaster[i].zw, px.x, px.y);
    float t = raySphereIntersect(uCLens[i], dir, uCRadius, 1e-9);
    if (t > 0.0) {
      vec3 xp = uCLens[i] + dir * t;
      vec2 ll = worldToLatLon(xp);
      int count;
      float weight = contentWeight(xp, i, count) * polarMask(ll.x);
      overlapCount = max(overlapCount, count);
      signal = blendedSignal(sampleEquirect(ll.x, wrapDeg180(ll.y - uCRotOffset)), weight);
    }

    vec3 toLensVec = uLens[i] - point;
    float distanceM = length(toLensVec);
    float nDotL = max(dot(normal, toLensVec) / distanceM, 0.0);
    if (nDotL == 0.0) continue;
    float ref = uLimb[i].x - uRadius;
    float falloff = (ref * ref) / (distanceM * distanceM);
    diffuse += emittedRadianceRgb(signal, i) * (nDotL * falloff);
  }
  return diffuse * uReflectance;
}

vec3 shadeFloor(vec3 point) {
  vec3 normal = vec3(0.0, 0.0, 1.0);
  vec3 acc = uAmbient;
  for (int i = 0; i < MAX_PROJ; i++) {
    if (i >= uProjCount) continue;
    vec3 toLensVec = uLens[i] - point;
    float distanceM = length(toLensVec);
    if (distanceM == 0.0) continue;
    float cosv = dot(normal, toLensVec) / distanceM;
    if (cosv <= 0.0) continue;
    float occl = raySphereIntersect(point, toLensVec / distanceM, uRadius, 1e-6);
    if (occl > 0.0 && occl < distanceM) continue;
    vec2 px;
    if (!pixelOf(uLens[i], uRot[i], uIntr[i], uRaster[i], point, px)) continue;
    float ref = uLimb[i].x - uRadius;
    float falloff = (ref * ref) / (distanceM * distanceM);
    // The ray reaching this floor point missed the sphere, so the content there
    // is black and conventions.ts section P collapses to gain * blackFloor. That
    // is the rectangle of glow around the sphere in every real SOS photograph.
    acc += uGain[i] * uBlack[i] * (cosv * falloff);
  }
  return acc * uRoomAlbedo;
}
`;

/**
 * The overlays.
 *
 * Colours chosen so the three counterintuitive facts of PARAMETERS.md §4.2 and
 * §4.3 are legible at a glance: a three-projector overlap would come out red and
 * must never appear; the unlit region should read as four scalloped lobes and
 * not as a round cap.
 */
const CHUNK_OVERLAY = `
vec3 overlayTint(int overlapCount, int litCount) {
  if (uOverlay == 1) {
    if (litCount == 0) return vec3(0.10, 0.10, 0.13);
    if (litCount == 1) return vec3(0.16, 0.38, 0.62);
    if (litCount == 2) return vec3(0.20, 0.68, 0.42);
    return vec3(0.90, 0.14, 0.10);     // impossible: see PARAMETERS.md section 4.2
  }
  if (uOverlay == 2) {
    return litCount >= 2 ? vec3(0.95, 0.72, 0.20) : vec3(0.10, 0.10, 0.13);
  }
  return litCount == 0 ? vec3(0.85, 0.20, 0.35) : vec3(0.10, 0.10, 0.13);
}
`;

const CHUNK_MAIN = `
void main() {
  vec2 s = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uCamForward + uCamRight * (s.x * uCamHalf.x) + uCamUp * (s.y * uCamHalf.y));

  vec3 c = vec3(0.0);
  float t = raySphereIntersect(uCamPos, dir, uRadius, 1e-9);
  if (t > 0.0) {
    int overlapCount;
    int litCount;
    c = shadeTwoRig(uCamPos + dir * t, overlapCount, litCount);
    if (uOverlay > 0) c = mix(c, overlayTint(overlapCount, litCount), uOverlayMix);
  } else if (uDrawFloor == 1 && dir.z < 0.0) {
    float floorZ = -uCenterHeight;
    float tf = (floorZ - uCamPos.z) / dir.z;
    if (tf > 0.0) {
      vec3 p = vec3(uCamPos.x + dir.x * tf, uCamPos.y + dir.y * tf, floorZ);
      if (length(p.xy) <= uFloorRadius) c = shadeFloor(p);
    }
  }

  c *= uExposure;
  if (uDisplayGamma > 0.0) c = pow(max(c, vec3(0.0)), vec3(1.0 / uDisplayGamma));
  fragColor = vec4(c, 1.0);
}
`;

export const FRAGMENT_CHUNKS: readonly { name: string; mirrors: string; source: string }[] = [
  { name: 'header', mirrors: '(uniforms)', source: HEADER },
  { name: 'wrap', mirrors: 'sim/src/vec.ts', source: CHUNK_WRAP },
  { name: 'sphere', mirrors: 'sim/src/geometry.ts', source: CHUNK_SPHERE },
  { name: 'equirect', mirrors: 'sim/src/equirect.ts', source: CHUNK_EQUIRECT },
  { name: 'mask', mirrors: 'sim/src/coverage.ts', source: CHUNK_MASK },
  { name: 'optics', mirrors: 'sim/src/optics.ts', source: CHUNK_OPTICS },
  { name: 'blend', mirrors: 'sim/src/blend.ts + coverage.ts', source: CHUNK_BLEND },
  { name: 'transfer', mirrors: 'sim/src/photometry.ts + render.ts', source: CHUNK_TRANSFER },
  { name: 'trace', mirrors: 'sim/src/misregistration.ts', source: CHUNK_TRACE },
  { name: 'overlay', mirrors: '(presentation only)', source: CHUNK_OVERLAY },
  { name: 'main', mirrors: 'sim/src/misregistration.ts', source: CHUNK_MAIN },
];

export const FRAGMENT_SHADER = FRAGMENT_CHUNKS.map((c) => c.source).join('\n');

/** Uniform names the shader declares. The GL binder checks it found them all. */
export function glslUniformNames(source: string = FRAGMENT_SHADER): string[] {
  const names: string[] = [];
  const re = /^\s*uniform\s+\w+\s+(\w+)\s*(\[\s*\w+\s*\])?\s*;/gm;
  for (const m of source.matchAll(re)) names.push(m[1]);
  return [...new Set(names)].sort();
}

/** Function names the shader declares, for the structural test. */
export function glslFunctionNames(source: string = FRAGMENT_SHADER): string[] {
  const names: string[] = [];
  const re = /^\s*(?:float|vec2|vec3|vec4|bool|int|void|mat3)\s+([A-Za-z_]\w*)\s*\(/gm;
  for (const m of source.matchAll(re)) {
    if (m[1] !== 'main') names.push(m[1]);
  }
  return [...new Set(names)].sort();
}
