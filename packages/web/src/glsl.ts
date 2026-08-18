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
uniform int   uBlendSector;           // 0 limb-inward, 1 longitude sector (A-37)

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
uniform float uLift;                  // display tone curve; 1.0 is off
uniform float uDisplayGamma;          // 0 disables the final encode (linear readback)

// Diagnostic overlays. Each is a way of LOOKING at the same trace, never a
// different trace: they recolour what step 3 already computed.
uniform int   uOverlay;               // 0 none, 1 overlap count, 2 seams, 3 unlit, 4 by projector
uniform float uOverlayMix;
uniform int   uHighlight;             // -1 none, else a projector index to isolate

// Which projector is which, everywhere on the page: the panel tab, the inspect
// card, the overlay and the projector in the room all read the same colour.
uniform vec3  uTint[MAX_PROJ];
// The room's furniture: projector bodies on their ceiling hangers, the guard
// rail, the sphere's suspension rod. A drawing aid — none of it emits light, none
// of it occludes the light, and the trace below is not told it exists.
uniform float uMarkerRadius;          // metres; 0 draws no furniture at all
uniform int   uMarkerSelected;        // -1 none
uniform float uCeilingM;              // floor to ceiling, metres
uniform int   uRailOn;
uniform int   uAimGuides;

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
    // Where the blend region is. AMENDMENTS.md A-37 and coverage.ts must agree
    // here or the parity readout on this very page reports the disagreement.
    float t = (thetaMaxDeg - thetaDeg) / width;
    if (uBlendSector == 1) {
      float span = 360.0 / float(uProjCount);
      float lonDeg = atan(x.y, x.x) * RAD2DEG;
      float meridianDeg = atan(uCLens[i].y, uCLens[i].x) * RAD2DEG;
      float dLon = abs(wrapDeg180(lonDeg - meridianDeg));
      t = min((span * 0.5 + width * 0.5 - dLon) / width, t);
    }
    float w = rampWeight(uRampShape, t, uRampGamma);
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
vec3 shadeTwoRig(
  vec3 point,
  out int overlapCount,
  out int litCount,
  out int strongest,
  out float strongestWeight,
  out vec3 blendTint
) {
  vec3 normal = point / uRadius;
  vec3 diffuse = uAmbient;
  overlapCount = 0;
  litCount = 0;
  strongest = -1;
  strongestWeight = 0.0;
  // Every projector's colour, in proportion to what it is contributing here.
  // The argmax alone cannot show a blend band: the strongest projector flips at
  // the 50/50 line, so a 20-degree band of genuine overlap drew as a razor edge
  // between two flat colours and the one thing the view exists to show — how
  // wide the hand-over is — was invisible.
  vec3 tintAcc = vec3(0.0);
  float tintW = 0.0;

  for (int i = 0; i < MAX_PROJ; i++) {
    if (i >= uProjCount) continue;
    vec2 px;
    if (!illuminated(i, point, px)) continue;
    litCount++;
    if (uHighlight >= 0 && uHighlight != i) continue;

    // Step 3: what the compositor wrote into that pixel, found by sending the
    // pixel back out through the calibration the compositor believed it had.
    //
    // Reconstructed over the projector's PIXEL GRID rather than resampled
    // continuously. The compositor writes one value per pixel, at its centre,
    // and a projector cannot draw anything finer than that; a continuous
    // resample gave every projector infinite resolution, so the panel's
    // Resolution control changed the readout — the grid metric has modelled the
    // pixel grid all along — and left the sphere looking identical at 1024x768
    // and at 4K.
    //
    // Bilinear over the four surrounding centres, which is the same
    // reconstruction packages/sim/src/metrics/grid.ts uses and its reason is
    // the same: it is what a real projector does with its grid. The softness
    // that comes out at low resolution is the point. What is still NOT modelled
    // is the lens spot, which overlaps its neighbours and would soften it
    // further.
    vec3 signal = vec3(0.0);
    vec2 f = px - 0.5;
    vec2 i0 = floor(f);
    vec2 tf = f - i0;
    for (int c = 0; c < 4; c++) {
      vec2 corner = i0 + vec2(float(c == 1 || c == 3), float(c >= 2)) + 0.5;
      float w = (c == 1 || c == 3 ? tf.x : 1.0 - tf.x) * (c >= 2 ? tf.y : 1.0 - tf.y);
      if (w <= 0.0) continue;
      vec3 dir = rayFrom(uCRot[i], uCIntr[i], uCRaster[i].zw, corner.x, corner.y);
      float t = raySphereIntersect(uCLens[i], dir, uCRadius, 1e-9);
      if (t <= 0.0) continue;
      vec3 xp = uCLens[i] + dir * t;
      vec2 ll = worldToLatLon(xp);
      int count;
      float weight = contentWeight(xp, i, count) * polarMask(ll.x);
      overlapCount = max(overlapCount, count);
      if (weight > strongestWeight) {
        strongestWeight = weight;
        strongest = i;
      }
      tintAcc += uTint[i] * (weight * w);
      tintW += weight * w;
      signal += w * blendedSignal(sampleEquirect(ll.x, wrapDeg180(ll.y - uCRotOffset)), weight);
    }

    // A display tone curve on what the PROJECTOR is drawing, and nothing else.
    // Applied to the finished frame instead, it lifted the floor and the guard
    // rail out of the dark along with the map and the room came up grey — the
    // sample app grades its map sample for exactly this reason and leaves its
    // room alone. Held at 1.0 for the linear readback, so the parity check
    // still compares the model's own radiance; glsl.test asserts it.
    if (uLift != 1.0) signal = pow(max(signal, vec3(0.0)), vec3(uLift));

    vec3 toLensVec = uLens[i] - point;
    float distanceM = length(toLensVec);
    float nDotL = max(dot(normal, toLensVec) / distanceM, 0.0);
    if (nDotL == 0.0) continue;
    float ref = uLimb[i].x - uRadius;
    float falloff = (ref * ref) / (distanceM * distanceM);
    diffuse += emittedRadianceRgb(signal, i) * (nDotL * falloff);
  }
  blendTint = tintW > 0.0 ? tintAcc / tintW : vec3(0.0);
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
vec3 overlayTint(int overlapCount, int litCount, int strongest, float strongestWeight, vec3 blendTint) {
  if (uOverlay == 1) {
    if (litCount == 0) return vec3(0.10, 0.10, 0.13);
    if (litCount == 1) return vec3(0.16, 0.38, 0.62);
    if (litCount == 2) return vec3(0.20, 0.68, 0.42);
    return vec3(0.90, 0.14, 0.10);     // impossible: see PARAMETERS.md section 4.2
  }
  if (uOverlay == 2) {
    return litCount >= 2 ? vec3(0.95, 0.72, 0.20) : vec3(0.10, 0.10, 0.13);
  }
  if (uOverlay == 4) {
    // Every projector's colour in proportion to what it is contributing, so a
    // blend band reads as a GRADIENT between two tints and its width is the
    // width of the hand-over. Tinting by the strongest projector instead drew
    // the band as a razor edge, because the argmax flips at the 50/50 line
    // however wide the overlap is.
    if (litCount == 0 || strongest < 0) return vec3(0.10, 0.10, 0.13);
    return blendTint * (0.45 + 0.55 * strongestWeight);
  }
  return litCount == 0 ? vec3(0.85, 0.20, 0.35) : vec3(0.10, 0.10, 0.13);
}
`;

/**
 * The room's furniture — the objects a photograph of a real SOS gallery contains
 * and a bare ball on a plane does not: four projectors hanging from the ceiling,
 * the guard rail visitors stand behind, and the rod the sphere hangs from.
 *
 * ## None of this is part of the model
 *
 * The trace above is not told any of it exists. Nothing here emits light, casts a
 * shadow, or occludes a projector — a projector body that blocked its own beam
 * would be a physical claim, and this file is not allowed to make one. It is set
 * dressing that makes the geometry legible, and `uMarkerRadius = 0` removes it
 * entirely, which is what the parity pass does.
 *
 * ## Why sphere tracing rather than analytic intersections
 *
 * Everything else in this shader is an analytic intersection because everything
 * else is a sphere or a plane. A box, a capped cylinder and a torus are not, and
 * a ray-torus intersection is a quartic that float32 cannot be trusted with. A
 * signed distance field costs one loop and is exact enough for scenery.
 *
 * Dimensions follow a BenQ LK935 in a NOAA gallery: a 0.34 x 0.15 x 0.40 m body,
 * a 0.13 m lens barrel, a rail at 1.9 m radius with its top at 1.04 m — waist
 * height on the far side of a 68-inch ball.
 */
const ROOM_STEPS = 72;

const CHUNK_ROOM = `
const int ROOM_STEPS = ${ROOM_STEPS};
/**
 * The guard rail's radius, as a multiple of the sphere's.
 *
 * 2.2 is 1.9 m at PARAMETERS.md §1's 68-inch ball, which is what this was as a
 * constant. Scaling it rather than fixing it is the point: a 130-inch sphere in
 * a room whose handrail stayed at 1.9 m would have visitors standing inside the
 * silhouette, and the rail is what §6's viewing band is bounded below BY.
 *
 * The rail's HEIGHTS do not scale — a handrail is 1.04 m because of the people
 * leaning on it, not because of the ball — and they are measured off the floor,
 * so raising the sphere leaves them where they are.
 */
const float RAIL_RADIUS_FRAC = 2.2;
#define RAIL_RADIUS_M (uRadius * RAIL_RADIUS_FRAC)
const float RAIL_TOP_M = 1.04;
const float RAIL_MID_M = 0.62;

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

/** Capped cylinder along +z, half-height h, radius r. */
float sdCylinderZ(vec3 p, float h, float r) {
  vec2 d = vec2(length(p.xy) - r, abs(p.z) - h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

/** Torus in the xy plane (the floor plane here is xy; z is up). */
float sdTorusZ(vec3 p, float major, float minor) {
  vec2 q = vec2(length(p.xy) - major, p.z);
  return length(q) - minor;
}

/**
 * One projector, in the frame where the lens point is the origin and +z points
 * at the sphere. The barrel's front face lands exactly on the calibration's lens
 * point, so dragging a projector in the panel moves the object a viewer sees
 * rather than a proxy for it.
 */
float sdProjector(vec3 q) {
  float barrel = sdCylinderZ(q - vec3(0.0, 0.0, -0.065), 0.065, 0.068);
  float body = sdBox(q - vec3(0.0, 0.0, -0.33), vec3(0.17, 0.075, 0.20));
  return min(body, barrel);
}

/** Where {@link sdProjector}'s body sits, for the hanger and the click target. */
vec3 projectorBodyCentre(int i) {
  vec3 lens = uLens[i];
  return lens - normalize(-lens) * 0.33;
}

/** Floor-plane z, in the same frame the sphere centre is the origin of. */
float roomFloorZ() { return -uCenterHeight; }

/**
 * The whole scene's distance, with the nearest projector index written out.
 *
 * The out parameter is -1 for the rail and the rod, which are not pickable and
 * carry no tint.
 */
float roomDistance(vec3 p, out int which) {
  which = -1;
  float floorZ = roomFloorZ();
  float ceilZ = floorZ + uCeilingM;
  float d = 1e9;

  // The room's own structure: the guard rail, and the rod the sphere hangs from.
  // PARAMETERS.md section 4.4 on the rod — the ceiling mount is why the north cap
  // needs no software mask and the south does. The ball has to hang from
  // something whether or not the projectors are being drawn.
  if (uRailOn == 1) {
    d = min(d, sdTorusZ(p - vec3(0.0, 0.0, floorZ + RAIL_TOP_M), RAIL_RADIUS_M, 0.021));
    d = min(d, sdTorusZ(p - vec3(0.0, 0.0, floorZ + RAIL_MID_M), RAIL_RADIUS_M, 0.013));
    // Ten posts, by folding the angle into one of them rather than looping.
    float step = 6.2831853 / 10.0;
    float a = atan(p.y, p.x) - 0.31;
    float folded = a - step * floor(a / step + 0.5);
    float rad = length(p.xy);
    vec3 q = vec3(rad * cos(folded) - RAIL_RADIUS_M, rad * sin(folded), p.z - floorZ - 0.52);
    d = min(d, sdCylinderZ(q, 0.52, 0.021));

    float rodTop = ceilZ;
    float rodBot = uRadius * 0.96;
    d = min(d, sdCylinderZ(vec3(p.xy, p.z - 0.5 * (rodTop + rodBot)), max(0.5 * (rodTop - rodBot), 0.0), 0.018));
  }

  // Everything below hangs off the PROJECTOR toggle. The rail and the rod above
  // do not: one flag used to gate the march itself, so turning the projectors
  // off took the handrail, the rod and the floor plan with them.
  if (uMarkerRadius <= 0.0) return d;

  for (int i = 0; i < MAX_PROJ; i++) {
    if (i >= uProjCount) continue;
    vec3 lens = uLens[i];
    // The projector points at the sphere centre, which is the origin.
    vec3 fwd = normalize(-lens);
    vec3 up0 = abs(fwd.z) > 0.98 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
    vec3 right = normalize(cross(fwd, up0));
    vec3 up = cross(right, fwd);
    vec3 rel = p - lens;
    vec3 q = vec3(dot(rel, right), dot(rel, up), dot(rel, fwd));
    float dp = sdProjector(q);
    if (dp < d) { d = dp; which = i; }

    // The hanger, from the ceiling straight down to the top of the body.
    vec3 top = projectorBodyCentre(i);
    float hangTop = ceilZ;
    float hangBot = top.z + 0.075;
    float dh = sdCylinderZ(
      vec3(p.x - top.x, p.y - top.y, p.z - 0.5 * (hangTop + hangBot)),
      max(0.5 * (hangTop - hangBot), 0.0), 0.013);
    if (dh < d) { d = dh; which = -1; }
  }
  return d;
}

vec3 roomNormal(vec3 p) {
  vec2 e = vec2(1.0, -1.0) * 0.0015;
  int ignore;
  return normalize(
    e.xyy * roomDistance(p + e.xyy, ignore) + e.yyx * roomDistance(p + e.yyx, ignore) +
    e.yxy * roomDistance(p + e.yxy, ignore) + e.xxx * roomDistance(p + e.xxx, ignore));
}

/**
 * March the furniture. Returns -2 for a miss, -1 for untinted scenery, otherwise
 * a projector index; writes the hit distance.
 */
int roomHit(vec3 origin, vec3 dir, float maxT, out float hitT) {
  hitT = maxT;
  // Nothing to march only when BOTH kinds of furniture are off.
  if (uMarkerRadius <= 0.0 && uRailOn == 0) return -2;
  float t = 0.02;
  int which = -1;
  for (int s = 0; s < ROOM_STEPS; s++) {
    if (t >= maxT) return -2;
    int w;
    float d = roomDistance(origin + dir * t, w);
    if (d < 0.0015) { hitT = t; return w; }
    t += max(d, 0.004);
  }
  return -2;
}

vec3 shadeRoom(int which, vec3 point, vec3 dir) {
  vec3 n = roomNormal(point);
  // A key light from above and behind the viewer plus the room's own ambient.
  // Deliberately NOT the projectors: scenery lit by the model would read as a
  // photometric result, and it is not one. Kept dark on purpose — a sphere
  // gallery is a dark room, and furniture brighter than the sphere would be a
  // lie about where the light in the picture comes from.
  float key = 0.25 + 0.75 * max(dot(n, normalize(vec3(-dir.x, -dir.y, 1.2))), 0.0);
  vec3 base = vec3(0.016, 0.019, 0.025) * key;
  if (which >= 0) {
    base = vec3(0.026, 0.029, 0.035) * key;
    // The lens glows in the projector's own colour, so the object in the room and
    // the tab in the panel are recognisably the same projector.
    vec3 lens = uLens[which];
    float atLens = 1.0 - smoothstep(0.050, 0.105, length(point - lens));
    base += uTint[which] * atLens * 0.55;
    if (uMarkerSelected == which) base += uTint[which] * 0.055 + vec3(0.008);
  }
  return base + uAmbient * 0.18;
}

/**
 * The aim guide: a faint cone of light from each lens to the ball.
 *
 * Additive along the view ray, so it reads as haze rather than as a surface. It
 * is drawn from the PHYSICAL lens, which is what makes a bumped projector's cone
 * visibly miss where the others converge.
 */
vec3 aimGuides(vec3 origin, vec3 dir, float maxT) {
  vec3 acc = vec3(0.0);
  if (uAimGuides != 1) return acc;
  for (int i = 0; i < MAX_PROJ; i++) {
    if (i >= uProjCount) continue;
    vec3 lens = uLens[i];
    vec3 axis = normalize(-lens);
    float len = length(lens);
    // Closest approach of the view ray to the beam's axis segment.
    vec3 w0 = origin - lens;
    float a = dot(dir, dir), b = dot(dir, axis), c = dot(axis, axis);
    float d0 = dot(dir, w0), e0 = dot(axis, w0);
    float den = a * c - b * b;
    if (abs(den) < 1e-6) continue;
    float s = (b * e0 - c * d0) / den;
    float u = (a * e0 - b * d0) / den;
    if (s < 0.0 || s > maxT) continue;
    u = clamp(u, 0.0, len);
    vec3 pv = origin + dir * s;
    vec3 pa = lens + axis * u;
    // The beam narrows toward the ball, so the tube it sweeps is a cone.
    float radius = mix(0.10, uRadius, u / max(len, 1e-6));
    float k = 1.0 - smoothstep(radius * 0.55, radius, length(pv - pa));
    acc += uTint[i] * k * 0.09;
  }
  return acc;
}
`;

const CHUNK_MAIN = `
void main() {
  vec2 s = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uCamForward + uCamRight * (s.x * uCamHalf.x) + uCamUp * (s.y * uCamHalf.y));

  vec3 c = vec3(0.0);
  float t = raySphereIntersect(uCamPos, dir, uRadius, 1e-9);
  float sceneT = t > 0.0 ? t : 1e9;
  if (t > 0.0) {
    int overlapCount;
    int litCount;
    int strongest;
    float strongestWeight;
    vec3 blendTint;
    c = shadeTwoRig(uCamPos + dir * t, overlapCount, litCount, strongest, strongestWeight, blendTint);
    if (uOverlay > 0) {
      c = mix(c, overlayTint(overlapCount, litCount, strongest, strongestWeight, blendTint), uOverlayMix);
    }
  } else if (uDrawFloor == 1 && dir.z < 0.0) {
    float floorZ = -uCenterHeight;
    float tf = (floorZ - uCamPos.z) / dir.z;
    if (tf > 0.0) {
      vec3 p = vec3(uCamPos.x + dir.x * tf, uCamPos.y + dir.y * tf, floorZ);
      if (length(p.xy) <= uFloorRadius) {
        c = shadeFloor(p);
        sceneT = tf;
        // The rail's footprint, so the room has a floor plan rather than a
        // circle of grey. Presentation, like the rail itself.
        if (uRailOn == 1) {
          float ring = abs(length(p.xy) - RAIL_RADIUS_M);
          c = mix(c, c * 1.9 + vec3(0.010, 0.012, 0.016), 1.0 - smoothstep(0.02, 0.05, ring));
        }
      }
    }
  }

  // The furniture last, and only where it is in front of whatever was drawn.
  float roomT;
  int room = roomHit(uCamPos, dir, sceneT, roomT);
  if (room > -2) {
    c = shadeRoom(room, uCamPos + dir * roomT, dir);
    sceneT = roomT;
  }
  c += aimGuides(uCamPos, dir, sceneT);

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
  { name: 'room', mirrors: '(presentation only — no model reads it)', source: CHUNK_ROOM },
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
