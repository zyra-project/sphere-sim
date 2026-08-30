// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The GPU renderer's shader source — and the reason this file is TypeScript
 * rather than a `.glsl` asset.
 *
 * ## This is a SECOND implementation of the simulator's own model
 *
 * docs/ARCHITECTURE.md is explicit that this is a different thing from the A/B
 * duplication between `packages/sim` and `packages/solver`, and that it carries a
 * different risk. The A/B duplication is deliberate and must never be removed;
 * this one is a consequence of wanting an interactive window, and the danger is
 * not circularity but **silent drift**. The CPU tracer and the GLSL below can
 * disagree by a term nobody notices, and then the harness a human is using to
 * build intuition is showing them a model the bench does not score.
 *
 * Three things hold them together, and none of them is "read it carefully":
 *
 *  1. `reference.ts` transliterates every function below into TypeScript, name
 *     for name and line for line. It is the same math, runnable in Node.
 *  2. `parity.ts` renders the same scene through `reference.ts` and through
 *     `packages/sim`, and reports the delta. That runs headless, in CI, on every
 *     commit — no GPU required.
 *  3. `test/glsl.test.ts` parses THIS file for its function signatures and
 *     asserts that `reference.ts` exports a counterpart for every one, and vice
 *     versa. A term added to the shader and forgotten in the reference fails the
 *     build rather than quietly widening the gap the parity number is measuring.
 *
 * What the chain does NOT prove is that a real GL driver compiles this text into
 * the arithmetic `reference.ts` describes. That link needs a GPU. The harness
 * therefore measures GPU-against-CPU parity **at runtime, in the browser, and
 * displays the number** — see `web/main.ts`. `packages/harness/README.md` states
 * exactly which links are verified by execution and which are not.
 *
 * ## Deliberate differences from `packages/sim`, and why each is safe
 *
 *  - **float32 everywhere.** The CPU tracer is float64. This is the dominant
 *    term in the parity delta and it is why the GPU tolerance is 2e-3 rather
 *    than 1e-12.
 *  - **`p1`, `p2` are not uniforms.** PARAMETERS.md §3.1 holds tangential
 *    distortion at zero — "Extra DOF overfits" — and `state.ts` holds them
 *    there, so the shader drops the terms rather than carrying dead uniforms.
 *    `reference.ts` drops them identically.
 *  - **A fixed eight Newton steps** in `invertDistortion`, where `sim` runs an
 *    adaptive loop to a 1e-14 tolerance. A GPU cannot reach 1e-14 in float32 and
 *    a `break` on a tolerance it can never meet just burns the loop anyway. Eight
 *    steps of a quadratically convergent iteration is far past float32 precision
 *    at any coefficient this rig can carry. `reference.ts` runs the same eight,
 *    so the parity number measures this choice rather than hiding it.
 *  - **One sample per pixel, always.** `sim`'s Halton supersampling exists so
 *    bench PNGs are comparable byte-for-byte; a live window supersamples by
 *    being looked at for more than one frame. Parity is therefore computed at
 *    `samplesPerPixel: 1`, where `sim`'s offsets are exactly (0.5, 0.5).
 */

/** Iterations of Newton's method in `invertDistortion`. See the module note. */
export const NEWTON_ITERATIONS = 8;

/** Maximum projectors the shader compiles for. PARAMETERS.md §2 caps this at 4. */
export const MAX_PROJECTORS = 4;

/**
 * Full-screen triangle. No vertex buffer: `gl_VertexID` generates the corners,
 * so the harness never allocates geometry and there is nothing to leak when the
 * rig changes shape.
 */
export const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // 0 -> (-1,-1), 1 -> (3,-1), 2 -> (-1,3): one triangle covering the viewport.
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
uniform float uRadius;
uniform float uCenterHeight;
uniform float uRotationOffset;

uniform vec3  uLens[MAX_PROJ];
uniform mat3  uRot[MAX_PROJ];        // world <- canonical camera frame, conventions.ts section R
uniform vec4  uIntrinsics[MAX_PROJ]; // fx, fy, cx, cy  (conventions.ts section I)
uniform vec4  uRaster[MAX_PROJ];     // resX, resY, k1, k2
uniform vec2  uLimb[MAX_PROJ];       // distance to sphere centre, R/d
// The distance this projector's output is defined to be 1.0 at -- the near point
// of the BODY along the lens-to-centre axis, PreparedProjector.referenceDistanceM.
// A uniform rather than uLimb[i].x - uRadius, which is that number only for a
// body the world origin sits inside: on a model standing away from the origin the
// two differ by the whole translation, and the picture is simply dim.
uniform float uRefDistance[MAX_PROJ];
uniform vec3  uGamma[MAX_PROJ];
uniform vec3  uBlack[MAX_PROJ];
uniform vec3  uGain[MAX_PROJ];

uniform int   uRampShape;            // 0 linear, 1 cosine, 2 smoothstep, 3 gaussian
uniform float uWidthDeg;
uniform float uRampGamma;
uniform float uMaskLo;
uniform float uMaskHi;
uniform int   uMaskBottomOnly;
uniform int   uMaskInterp;           // 0 latitude (section 4.4's reading), 1 colatitude (A-02)

uniform vec3  uEncodeGamma;
uniform vec3  uReflectance;
uniform vec3  uAmbient;
uniform float uRoomAlbedo;
uniform float uSpecWeight;
uniform float uSpecAlpha;

uniform vec3  uCamPos;
uniform vec3  uCamForward;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec2  uCamHalf;              // tan(fov/2) horizontal, and vertical

uniform int   uMode;                 // 0 room view, 1 one projector's own raster
uniform int   uProjIndex;
uniform int   uDrawFloor;
uniform float uFloorRadius;
uniform float uExposure;
uniform float uDisplayGamma;         // 0 disables the final encode (linear readback)

uniform sampler2D uEquirect;

// The mesh, as texels. sim/src/mesh/pack.ts writes this layout and documents
// it; nothing here decides it. uMeshMode is 0 for the analytic sphere, so a
// shader compiled without a model still takes the closed form and costs nothing.
uniform sampler2D uBvhNodes;
uniform sampler2D uBvhTris;
uniform sampler2D uBvhField;         // per-corner footprint distance, one channel per projector
uniform int   uMeshMode;
uniform int   uBvhNodeCount;
uniform int   uMeshHasField;         // 0 when no field was packed; the blend falls back
// Both computed on the CPU by the same expressions sim uses, and passed rather
// than re-derived, because a shader that recomputed them from the model's extent
// would be a second definition of two numbers the two renderers have to agree on
// exactly. sim/src/mesh/surface.ts SHADOW_BIAS_FRACTION and footprint.ts
// blendWidthM.
uniform float uMeshShadowBias;
uniform float uMeshBlendWidthM;

in vec2 vUv;
out vec4 fragColor;

struct Surface {
  vec3 point;
  vec3 normal;
  float latDeg;
  float lonDeg;
  vec3 target;
  float weights[MAX_PROJ];
  bool lit[MAX_PROJ];
  float mask;
};
`;

/**
 * `packages/sim/src/vec.ts` `wrapDeg180`.
 *
 * GLSL's `mod` is floored (`x - y*floor(x/y)`) and JavaScript's `%` is truncated
 * (it keeps the sign of the dividend). Using `mod` here would put every negative
 * longitude a full turn away from where the CPU tracer puts it, which on a
 * symmetric four-projector rig looks completely plausible.
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
 * `packages/sim/src/geometry.ts` `raySphereIntersect`, including the
 * geometric discriminant. Returns the parametric distance, or -1 for a miss.
 *
 * The textbook `b*b - 4ac` form is a difference of two numbers around 27 m² at
 * this geometry and loses half the mantissa exactly at the limb — which in
 * float32 is not an academic concern, it is a visibly ragged silhouette.
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

/**
 * `packages/sim/src/equirect.ts` `sampleEquirect`, delegated to the sampler.
 *
 * GL's LINEAR filtering with `REPEAT` on S and `CLAMP_TO_EDGE` on T is the same
 * arithmetic as `sampleEquirect`'s hand-written bilinear: same half-texel centre
 * convention, wrap in longitude, clamp in latitude. The asymmetry is not a
 * shortcut — the texture is periodic in longitude and is not periodic in
 * latitude, and wrapping T would fold the north pole onto the south.
 *
 * Filtering precision is the one place GL is entitled to differ: the spec allows
 * reduced precision in the interpolation weights. That difference is inside the
 * stated GPU parity tolerance and is one of the reasons the tolerance is not
 * tighter.
 */
const CHUNK_EQUIRECT = `
vec3 sampleEquirect(float latDeg, float lonDeg) {
  float lon = wrapDeg180(lonDeg);
  float u = (lon + 180.0) / 360.0;
  float v = (90.0 - clamp(latDeg, -90.0, 90.0)) / 180.0;
  return texture(uEquirect, vec2(u, v)).rgb;
}

float worldLonToTextureLon(float worldLonDeg) {
  return wrapDeg180(worldLonDeg - uRotationOffset);
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
 * §D defines Brown-Conrady in the IDEAL -> DISTORTED direction only. A projector
 * goes pixel -> world ray, so it has to invert it; that asymmetry is why §D
 * specifies one direction and makes whichever side needs the other one earn it.
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

vec3 pixelToRay(int i, float u, float v) {
  vec4 it = uIntrinsics[i];
  vec4 ra = uRaster[i];
  float xd = (u - it.z) / it.x;
  float yd = -(v - it.w) / it.y;
  vec2 ideal = invertDistortion(vec2(xd, yd), ra.z, ra.w);
  // Canonical frame: optical axis +X, right -Y, up +Z (conventions.ts section R).
  return normalize(uRot[i] * vec3(1.0, -ideal.x, ideal.y));
}

bool worldToPixel(int i, vec3 worldPoint, out vec2 px) {
  vec3 local = transpose(uRot[i]) * (worldPoint - uLens[i]);
  float a = local.x;
  if (!(a > 0.0)) return false;
  vec4 it = uIntrinsics[i];
  vec4 ra = uRaster[i];
  vec2 d = applyDistortion(vec2(-local.y / a, local.z / a), ra.z, ra.w);
  px = vec2(it.z + it.x * d.x, it.w - it.y * d.y);
  return px.x >= 0.0 && px.x <= ra.x && px.y >= 0.0 && px.y <= ra.y;
}

bool isIlluminatedAt(int i, vec3 point) {
  vec3 toLens = uLens[i] - point;
  if (dot(point, toLens) <= 0.0) return false;
  vec2 px;
  return worldToPixel(i, point, px);
}

// \`sim/src/coverage.ts\` \`isIlluminatedAt\` on a mesh: the same three tests in
// the same order -- faces the lens, lands on the raster, and is not in the
// model's own shadow.
//
// The sphere's version above substitutes the POSITION for the normal, which it
// may because a sphere centred on the origin has them parallel. A mesh does not,
// so the normal is passed; and a sphere cannot occlude itself, so the third test
// exists only here. That third test is what a sphere never had to ask and is the
// whole reason Phase 1 built a hierarchy.
//
// \`bvhIntersect\` where the simulator calls \`occludedBvh\`: a nearest-hit query
// standing in for an any-hit one. More work, same answer -- both accept a hit
// on \`t > tMin && t < tMax\`, and "some accepted hit exists" is "the nearest
// accepted hit exists". Writing a second traversal to save the difference would
// be a second traversal to keep in parity.
bool meshIlluminatedAt(int i, vec3 point, vec3 normal) {
  vec3 toLens = uLens[i] - point;
  if (dot(normal, toLens) <= 0.0) return false;
  vec2 px;
  if (!worldToPixel(i, point, px)) return false;
  float distanceM = length(toLens);
  if (distanceM == 0.0) return true;
  return bvhIntersect(point, toLens / distanceM, uMeshShadowBias, distanceM).x < 0.0;
}
`;

/**
 * `packages/sim/src/blend.ts` and `coverage.ts` — conventions.ts §B.
 *
 * `rampGamma` is applied to the WEIGHT, never to the signal. Applying it to the
 * signal would be a per-projector gamma adjustment and would break the
 * normalization, which is the clause that keeps a ramp exponent from being able
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

// \`hit\` is what \`surfaceIntersect\` returned: (t, triangle, u, v), triangle < 0
// on the sphere. The face travels with the point for the reason
// \`SurfaceLocation\` exists on the CPU -- a mesh's normal and content coordinate
// belong to the FACE that was struck, and re-finding it from the point alone is
// a search that a flat wall defeats completely.
Surface sampleSurface(vec3 point, vec4 hit) {
  Surface s;
  s.point = point;
  int tri = int(hit.y);
  bool mesh = hit.y >= 0.0;

  vec2 ll;
  if (mesh) {
    s.normal = bvhNormalAt(tri, hit.z, hit.w);
    ll = bvhCoordAt(tri, hit.z, hit.w);
    // No rotation offset and no polar mask. The sphere's texture is anchored to
    // the world by a mechanical rotation and its mask attenuates a cap the mount
    // occludes; a model's UV is anchored by its own unwrap and it has neither a
    // pole nor a mount. \`render.ts\` and \`warp.ts\` make the same two exceptions.
    s.target = sampleEquirect(ll.x, ll.y);
    s.mask = 1.0;
  } else {
    s.normal = point / uRadius;
    ll = worldToLatLon(point);
    s.target = sampleEquirect(ll.x, worldLonToTextureLon(ll.y));
    s.mask = polarMask(ll.x);
  }
  s.latDeg = ll.x;
  s.lonDeg = ll.y;

  vec4 field = mesh ? bvhFieldAt(tri, hit.z, hit.w) : vec4(0.0);
  float width = uWidthDeg > 0.0 ? uWidthDeg : 1e-9;
  float widthM = uMeshBlendWidthM > 0.0 ? uMeshBlendWidthM : 1e-9;
  float sum = 0.0;
  for (int i = 0; i < MAX_PROJ; i++) {
    s.weights[i] = 0.0;
    s.lit[i] = false;
    if (i >= uProjCount) continue;
    if (mesh) {
      if (!meshIlluminatedAt(i, point, s.normal)) continue;
      s.lit[i] = true;
      // \`coverage.ts\`: how deep inside this projector's own footprint the point
      // sits, geodesically. A distance that is not positive means the field
      // could not place it inside -- no field packed, or a footprint smaller
      // than one face -- and the answer is a hard seam rather than a silent
      // zero, because a black patch is indistinguishable from being unlit,
      // which is the one thing this point is not.
      float d = field[i];
      s.weights[i] = d > 0.0 ? rampWeight(uRampShape, d / widthM, uRampGamma) : 1.0;
    } else {
      if (!isIlluminatedAt(i, point)) continue;
      s.lit[i] = true;
      float cosTheta = clamp(dot(point, uLens[i]) / (uRadius * uLimb[i].x), -1.0, 1.0);
      float thetaDeg = acos(cosTheta) * RAD2DEG;
      float thetaMaxDeg = acos(uLimb[i].y) * RAD2DEG;
      s.weights[i] = rampWeight(uRampShape, (thetaMaxDeg - thetaDeg) / width, uRampGamma);
    }
    sum += s.weights[i];
  }
  if (sum > 0.0) {
    for (int i = 0; i < MAX_PROJ; i++) s.weights[i] /= sum;
  }
  for (int i = 0; i < MAX_PROJ; i++) s.weights[i] *= s.mask;
  return s;
}
`;

/**
 * `packages/sim/src/render.ts` `blendedSignal` and `photometry.ts`
 * `emittedRadianceRgb` — conventions.ts §P.
 *
 * The blend weight multiplies the target radiance in LINEAR light and the result
 * is encoded afterwards, not the other way round. PARAMETERS.md §4.5 works it:
 * multiplying the ENCODED signal by 0.5 gives 0.106 linear per projector and the
 * seam becomes a black band.
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
 * `packages/sim/src/shading.ts` `fullShading`, which reproduces
 * `lambertianShading` exactly at `uSpecWeight = 0` — the case PARAMETERS.md §1
 * asks for when it says "Set to 0 to test sensitivity".
 *
 * The `4 * NdotL * NdotV` in the BRDF denominator cancels against the `NdotL`
 * the caller already folded into its irradiance. Both halves have to stay
 * consistent; it looks like a bug until you check the pair.
 */
const CHUNK_SHADING = `
float ggxBrdf(vec3 normal, vec3 toLens, vec3 viewDir, float nDotL, float nDotV, float a2, float f0) {
  vec3 half3 = normalize(toLens + viewDir);
  float nDotH = dot(normal, half3);
  if (!(nDotH > 0.0)) return 0.0;
  float vDotH = dot(viewDir, half3);
  float denom = nDotH * nDotH * (a2 - 1.0) + 1.0;
  float d = a2 / (PI * denom * denom);
  float g1l = (2.0 * nDotL) / (nDotL + sqrt(a2 + (1.0 - a2) * nDotL * nDotL));
  float g1v = (2.0 * nDotV) / (nDotV + sqrt(a2 + (1.0 - a2) * nDotV * nDotV));
  float oneMinus = 1.0 - max(vDotH, 0.0);
  float f = f0 + (1.0 - f0) * pow(oneMinus, 5.0);
  return (d * g1l * g1v * f) / (4.0 * nDotL * nDotV);
}

vec3 shadeSurface(Surface s, vec3 viewDir) {
  vec3 diffuse = uAmbient;
  vec3 spec = vec3(0.0);
  float nDotV = dot(s.normal, viewDir);
  float kd = 1.0 - uSpecWeight;
  float a2 = uSpecAlpha * uSpecAlpha;

  for (int i = 0; i < MAX_PROJ; i++) {
    if (i >= uProjCount) continue;
    if (!s.lit[i]) continue;
    vec3 toLensVec = uLens[i] - s.point;
    float distanceM = length(toLensVec);
    float incidenceCos = dot(s.normal, toLensVec) / distanceM;
    float nDotL = incidenceCos > 0.0 ? incidenceCos : 0.0;
    if (nDotL == 0.0) continue;
    float ref = uRefDistance[i];
    float falloff = (ref * ref) / (distanceM * distanceM);
    float k = nDotL * falloff;
    vec3 e = emittedRadianceRgb(blendedSignal(s.target, s.weights[i]), i);
    diffuse += e * k;
    if (uSpecWeight > 0.0 && nDotV > 0.0) {
      float b = PI * ggxBrdf(s.normal, toLensVec / distanceM, viewDir, nDotL, nDotV, a2, uSpecWeight);
      spec += e * k * b;
    }
  }
  return diffuse * (kd * uReflectance) + spec + uAmbient * uSpecWeight;
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
    vec3 dir = toLensVec / distanceM;
    // Whatever is standing in the room, not the sphere specifically. A model
    // that shadows the floor is exactly the thing a sphere could never do.
    // Bounded at the lens: the caller knows how far the ray may travel, and an
    // unbounded nearest-hit walks the whole hierarchy before discarding
    // everything past it.
    float occl = surfaceIntersect(point, dir, 1e-6, distanceM).x;
    if (occl > 0.0 && occl < distanceM) continue;
    vec2 px;
    if (!worldToPixel(i, point, px)) continue;
    float ref = uRefDistance[i];
    float falloff = (ref * ref) / (distanceM * distanceM);
    float k = cosv * falloff;
    // The ray that reaches this floor point missed the sphere, so the content is
    // black there and conventions.ts section P collapses to gain * blackFloor. That is
    // the rectangle of glow around the sphere in every real SOS photograph.
    acc += uGain[i] * uBlack[i] * k;
  }
  return acc * uRoomAlbedo;
}
`;

/** `packages/sim/src/render.ts` `traceRoomRay` and `renderProjectorView`. */
const CHUNK_TRACE = `
vec3 traceRoomRay(vec3 origin, vec3 dir) {
  vec4 hit = surfaceIntersect(origin, dir, 1e-9, BVH_FAR);
  if (hit.x > 0.0) {
    Surface s = sampleSurface(origin + dir * hit.x, hit);
    return shadeSurface(s, -dir);
  }
  if (uDrawFloor == 0 || dir.z >= 0.0) return vec3(0.0);
  float floorZ = -uCenterHeight;
  float tf = (floorZ - origin.z) / dir.z;
  if (!(tf > 0.0)) return vec3(0.0);
  vec3 p = vec3(origin.x + dir.x * tf, origin.y + dir.y * tf, floorZ);
  if (length(p.xy) > uFloorRadius) return vec3(0.0);
  return shadeFloor(p);
}

vec3 projectorPixel(int i, float u, float v) {
  vec3 dir = pixelToRay(i, u, v);
  vec4 hit = surfaceIntersect(uLens[i], dir, 1e-9, BVH_FAR);
  if (hit.x < 0.0) return vec3(0.0);
  Surface s = sampleSurface(uLens[i] + dir * hit.x, hit);
  return blendedSignal(s.target, s.weights[i]);
}
`;

/**
 * The entry point.
 *
 * `uMode = 1` returns ENCODED framebuffer content — the image that goes down the
 * cable — so it must not be encoded a second time. `uMode = 0` returns linear
 * relative radiance, and the display encode of `png.ts` is applied here and
 * nowhere else, exactly as conventions.ts §P requires.
 */
const CHUNK_MAIN = `
void main() {
  vec3 c;
  if (uMode == 1) {
    vec4 ra = uRaster[uProjIndex];
    // GL's viewport origin is bottom-left and conventions.ts section I puts the
    // projector's raster origin at TOP-left, so v is flipped once, here.
    c = projectorPixel(uProjIndex, vUv.x * ra.x, (1.0 - vUv.y) * ra.y);
    fragColor = vec4(c, 1.0);
    return;
  }
  vec2 s = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uCamForward + uCamRight * (s.x * uCamHalf.x) + uCamUp * (s.y * uCamHalf.y));
  c = traceRoomRay(uCamPos, dir) * uExposure;
  if (uDisplayGamma > 0.0) {
    c = pow(max(c, vec3(0.0)), vec3(1.0 / uDisplayGamma));
  }
  fragColor = vec4(c, 1.0);
}
`;


/**
 * The hierarchy traversal, on the GPU — `docs/ARBITRARY-SHAPES.md` Phase 2.
 *
 * A transliteration of `sim/src/mesh/bvh.ts`, not a re-derivation: the box slab
 * test, the Moller-Trumbore triangle, the near-child-first descent and the
 * epsilons are the same arithmetic in the same order. That is the point of the
 * parity chain — two implementations of ONE model, so a disagreement is a bug
 * rather than a design difference.
 *
 * ## The stack is fixed and that is a refusal, not a limit
 *
 * GLSL has no dynamic allocation, so the traversal stack is a compile-time
 * array. A hierarchy deeper than it would silently drop the nodes it could not
 * push and report a miss where there is geometry — a hole in the model that
 * looks like a modelling error. `packBvh` therefore reports `maxDepth` and the
 * caller refuses to upload a hierarchy deeper than `BVH_STACK` rather than
 * rendering one it cannot finish. 32 admits about four billion triangles at the
 * builder's leaf size, so the refusal is a guard rather than a ceiling anybody
 * meets.
 *
 * ## Why the triangle fetch is six texels and not a vertex indirection
 *
 * See `pack.ts`. The short version is that a dependent texture fetch inside this
 * loop cannot be prefetched, and this loop is where a mesh renderer spends its
 * time.
 */
const CHUNK_MESH = `
#define BVH_STACK 32
#define PACK_WIDTH 1024
#define NODE_TEXELS 2
#define TRI_TEXELS 6
#define FIELD_TEXELS 3
// Stands in for the Infinity the simulator passes as tMax. GLSL has no such
// literal, and any bound past the scene serves: tMax only ever shrinks as the
// traversal finds closer hits, so a larger one changes nothing but the first
// comparison. 1e30 is far outside a room measured in metres and far inside
// float32's range, so it neither clips geometry nor overflows.
#define BVH_FAR 1e30

vec4 packedTexel(sampler2D tex, int i) {
  return texelFetch(tex, ivec2(i % PACK_WIDTH, i / PACK_WIDTH), 0);
}

// \`sim/src/mesh/bvh.ts\` \`rayBox\`. Returns the near distance, or -1.0 for a
// miss -- GLSL has no Infinity to return, so the sentinel changes and every
// comparison against it changes with it.
float rayBoxNear(vec3 bmin, vec3 bmax, vec3 origin, vec3 invDir, float tMin, float tMax) {
  vec3 t0 = (bmin - origin) * invDir;
  vec3 t1 = (bmax - origin) * invDir;
  vec3 lo3 = min(t0, t1);
  vec3 hi3 = max(t0, t1);
  float lo = max(max(lo3.x, lo3.y), lo3.z);
  float hi = min(min(hi3.x, hi3.y), hi3.z);
  if (hi < max(lo, tMin) || lo > tMax) return -1.0;
  return max(lo, tMin);
}

// \`sim/src/mesh/bvh.ts\` \`rayTriangle\`. Returns (t, u, v), or t = -1.0 for a
// miss. BARY_EPS closes the crack a ray landing exactly on a shared edge would
// otherwise fall through -- both adjacent triangles rejecting it and the surface
// reporting its own back face.
vec3 rayTriangleAt(int tri, vec3 origin, vec3 dir) {
  int base = tri * TRI_TEXELS;
  vec3 a = packedTexel(uBvhTris, base).xyz;
  vec3 b = packedTexel(uBvhTris, base + 1).xyz;
  vec3 c = packedTexel(uBvhTris, base + 2).xyz;

  vec3 e1 = b - a;
  vec3 e2 = c - a;
  vec3 pv = cross(dir, e2);
  float det = dot(e1, pv);
  if (det > -1e-12 && det < 1e-12) return vec3(-1.0, 0.0, 0.0);

  float inv = 1.0 / det;
  vec3 tv = origin - a;
  float u = dot(tv, pv) * inv;
  if (u < -1e-9 || u > 1.0 + 1e-9) return vec3(-1.0, 0.0, 0.0);

  vec3 qv = cross(tv, e1);
  float v = dot(dir, qv) * inv;
  if (v < -1e-9 || u + v > 1.0 + 1e-9) return vec3(-1.0, 0.0, 0.0);

  return vec3(dot(e2, qv) * inv, u, v);
}

// \`sim/src/mesh/bvh.ts\` \`intersectBvh\`. Returns (t, triangle, u, v), with
// t < 0.0 for a miss.
vec4 bvhIntersect(vec3 origin, vec3 dir, float tMin, float tMax) {
  if (uMeshMode == 0 || uBvhNodeCount == 0) return vec4(-1.0, 0.0, 0.0, 0.0);
  vec3 invDir = 1.0 / dir;

  float bestT = tMax;
  vec4 best = vec4(-1.0, 0.0, 0.0, 0.0);

  int stack[BVH_STACK];
  int sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    int node = stack[--sp];
    int na = node * NODE_TEXELS;
    vec4 lo = packedTexel(uBvhNodes, na);
    vec4 hi = packedTexel(uBvhNodes, na + 1);
    if (rayBoxNear(lo.xyz, hi.xyz, origin, invDir, tMin, bestT) < 0.0) continue;

    float link = lo.w;
    if (link < 0.0) {
      int from = int(hi.w);
      int to = from + int(-link);
      for (int i = from; i < to; i++) {
        vec3 h = rayTriangleAt(i, origin, dir);
        if (h.x < 0.0) continue;
        if (h.x <= tMin || h.x >= bestT) continue;
        bestT = h.x;
        best = vec4(h.x, float(i), h.y, h.z);
      }
      continue;
    }

    // Near child first: pushing the far one first means it is popped last, so
    // the near subtree gets to lower bestT before the far one is tested.
    int left = node + 1;
    int right = int(link);
    int la = left * NODE_TEXELS;
    int ra = right * NODE_TEXELS;
    float dLeft = rayBoxNear(
      packedTexel(uBvhNodes, la).xyz, packedTexel(uBvhNodes, la + 1).xyz,
      origin, invDir, tMin, bestT);
    float dRight = rayBoxNear(
      packedTexel(uBvhNodes, ra).xyz, packedTexel(uBvhNodes, ra + 1).xyz,
      origin, invDir, tMin, bestT);
    // !(d < 0.0), not d >= 0.0, and the difference is NaN. An axis-parallel
    // ray has an infinite reciprocal on that axis, and a slab plane the origin
    // sits exactly on gives 0 * Infinity = NaN. The simulator descends on a NaN
    // and the obvious form prunes on it, which is a hole in the model on
    // exactly the rays a viewer looking down an axis produces.
    //
    // GLSL ES 3.0 does NOT guarantee NaN behaviour in min/max, so this
    // agreement is proven for link (1) and is a KNOWN RISK for link (3). See
    // packages/harness/README.md.
    if (dLeft <= dRight) {
      if (!(dRight < 0.0) && sp < BVH_STACK) stack[sp++] = right;
      if (!(dLeft < 0.0) && sp < BVH_STACK) stack[sp++] = left;
    } else {
      if (!(dLeft < 0.0) && sp < BVH_STACK) stack[sp++] = left;
      if (!(dRight < 0.0) && sp < BVH_STACK) stack[sp++] = right;
    }
  }
  return best;
}

// The shading normal at a packed hit. Zero vertex normals mean the file carried
// none, and the face normal stands in -- the same rule \`MeshSurface.normalOfHit\`
// follows, so the two renderers shade such a model identically.
vec3 bvhNormalAt(int tri, float u, float v) {
  int base = tri * TRI_TEXELS;
  vec3 n0 = packedTexel(uBvhTris, base + 3).xyz;
  vec3 n1 = packedTexel(uBvhTris, base + 4).xyz;
  vec3 n2 = packedTexel(uBvhTris, base + 5).xyz;
  vec3 n = (1.0 - u - v) * n0 + u * n1 + v * n2;
  if (dot(n, n) <= 0.0) {
    vec3 a = packedTexel(uBvhTris, base).xyz;
    vec3 b = packedTexel(uBvhTris, base + 1).xyz;
    vec3 c = packedTexel(uBvhTris, base + 2).xyz;
    n = cross(b - a, c - a);
  }
  return normalize(n);
}

// \`sim/src/footprint.ts\` \`footprintDistanceAt\`, for all four projectors at
// once. The field is per-VERTEX and interpolated across the face a hit landed
// on; \`pack.ts\` writes the three corners beside the triangle, so this is that
// interpolation with no vertex indirection. One channel per projector.
vec4 bvhFieldAt(int tri, float u, float v) {
  if (uMeshHasField == 0) return vec4(0.0);
  int base = tri * FIELD_TEXELS;
  vec4 f0 = packedTexel(uBvhField, base);
  vec4 f1 = packedTexel(uBvhField, base + 1);
  vec4 f2 = packedTexel(uBvhField, base + 2);
  return (1.0 - u - v) * f0 + u * f1 + v * f2;
}

// The surface's own intersection, whichever surface this is -- the shader's
// \`Surface.intersect\`. Returns (t, triangle, u, v) with triangle < 0 on the
// sphere, which has no faces, and t < 0 for a miss.
//
// One place branches on \`uMeshMode\` so the tracer does not have to. The sphere
// keeps \`raySphereIntersect\` with the same arguments in the same order, which is
// what makes this a routing change and not an arithmetic one.
vec4 surfaceIntersect(vec3 origin, vec3 dir, float tMin, float tMax) {
  if (uMeshMode == 0) {
    return vec4(raySphereIntersect(origin, dir, uRadius, tMin), -1.0, 0.0, 0.0);
  }
  return bvhIntersect(origin, dir, tMin, tMax);
}

// The content coordinate at a packed hit, through the equirectangular
// convention \`uvToCoord\` defines: (lat, lon) in degrees.
vec2 bvhCoordAt(int tri, float u, float v) {
  int base = tri * TRI_TEXELS;
  vec2 uv0 = vec2(packedTexel(uBvhTris, base).w, packedTexel(uBvhTris, base + 3).w);
  vec2 uv1 = vec2(packedTexel(uBvhTris, base + 1).w, packedTexel(uBvhTris, base + 4).w);
  vec2 uv2 = vec2(packedTexel(uBvhTris, base + 2).w, packedTexel(uBvhTris, base + 5).w);
  vec2 uv = (1.0 - u - v) * uv0 + u * uv1 + v * uv2;
  return vec2(90.0 - uv.y * 180.0, uv.x * 360.0 - 180.0);
}
`;

/**
 * The chunks, in link order, each named after the `packages/sim` module it
 * mirrors. `test/glsl.test.ts` reads this list.
 */
export const FRAGMENT_CHUNKS: readonly { name: string; mirrors: string; source: string }[] = [
  { name: 'header', mirrors: '(uniforms and the Surface struct)', source: HEADER },
  { name: 'wrap', mirrors: 'sim/src/vec.ts', source: CHUNK_WRAP },
  { name: 'sphere', mirrors: 'sim/src/geometry.ts', source: CHUNK_SPHERE },
  { name: 'equirect', mirrors: 'sim/src/equirect.ts', source: CHUNK_EQUIRECT },
  { name: 'mesh', mirrors: 'sim/src/mesh/bvh.ts + mesh/pack.ts', source: CHUNK_MESH },
  { name: 'mask', mirrors: 'sim/src/coverage.ts', source: CHUNK_MASK },
  { name: 'optics', mirrors: 'sim/src/optics.ts', source: CHUNK_OPTICS },
  { name: 'blend', mirrors: 'sim/src/blend.ts + coverage.ts', source: CHUNK_BLEND },
  { name: 'transfer', mirrors: 'sim/src/photometry.ts + render.ts', source: CHUNK_TRANSFER },
  { name: 'shading', mirrors: 'sim/src/shading.ts', source: CHUNK_SHADING },
  { name: 'trace', mirrors: 'sim/src/render.ts', source: CHUNK_TRACE },
  { name: 'main', mirrors: 'sim/src/render.ts', source: CHUNK_MAIN },
];

export const FRAGMENT_SHADER = FRAGMENT_CHUNKS.map((c) => c.source).join('\n');

/**
 * Every function the fragment shader declares, parsed from its own source.
 *
 * Used by `test/glsl.test.ts` to prove the TypeScript reference covers the
 * shader rather than trailing it. Parsing beats a hand-maintained list for
 * exactly one reason: a hand-maintained list is a place to forget something, and
 * forgetting something here is the failure mode this whole file is guarding.
 */
export function glslFunctionNames(source: string = FRAGMENT_SHADER): string[] {
  const names: string[] = [];
  const re = /^\s*(?:float|vec2|vec3|vec4|bool|int|void|Surface)\s+([A-Za-z_]\w*)\s*\(/gm;
  for (const m of source.matchAll(re)) {
    if (m[1] !== 'main') names.push(m[1]);
  }
  return [...new Set(names)].sort();
}

/** Uniform names the shader declares. The GL binder checks it found them all. */
export function glslUniformNames(source: string = FRAGMENT_SHADER): string[] {
  const names: string[] = [];
  const re = /^\s*uniform\s+\w+\s+(\w+)\s*(\[\s*\w+\s*\])?\s*;/gm;
  for (const m of source.matchAll(re)) names.push(m[1]);
  return [...new Set(names)].sort();
}
