/**
 * The shading interface, and its two implementations.
 *
 * PARAMETERS.md's central conclusion is that every geometric parameter is DOC,
 * CFG or SOLVE while every photometric one is ASSUME or MEAS, and that
 * photometric metrics are "not trustworthy until the ground-truth visit
 * happens". The project prompt sequences the work accordingly: build and
 * optimize the geometry now, build but do not optimize the photometry.
 *
 * So the tracer talks to a `ShadingModel` and never to a photometric constant
 * directly, and Phase 2's fuller physics arrives as a second implementation of
 * that interface rather than as an edit to `render.ts`:
 *
 *   - {@link lambertianShading} — `lambertian-v1`. Per-channel diffuse plus
 *     additive ambient. Phase 1's model, and still the one every geometric metric
 *     and every bench capture runs against, because none of them depend on a
 *     photometric constant and changing what they render would silently move
 *     numbers this project has already reported.
 *   - {@link fullShading} — `full-v1`. The same diffuse term plus the GGX specular
 *     lobe PARAMETERS.md §1 describes and `lambertian-v1` omits. What the
 *     photometric metrics of §7 are computed against.
 *
 * The per-channel transfer curve of conventions.ts §P is not here: it lives in
 * `photometry.ts` with the rest of the twelve-gammas-twelve-floors-twelve-gains
 * model, and is re-exported below.
 *
 * Everything here is LINEAR light (conventions.ts §P). Encoding happens once, at
 * the final viewer-camera step, in png.ts.
 */

import type { ChannelTriplet, ProjectorTransfer } from '../../calibration/src/index.ts';
import { emittedRadianceRgb } from './photometry.ts';
import type { Vec3 } from './vec.ts';
import { clamp, dot, normalize } from './vec.ts';

// conventions.ts §P's transfer curve lives in `photometry.ts` with the rest of the
// per-channel model. Re-exported here because every shading model needs it and
// because the two functions were part of this module's surface before the split.
export { emittedRadiance, emittedRadianceRgb } from './photometry.ts';

/** What one projector delivers to one surface point. */
export interface ProjectorContribution {
  /** Index into the rig's projector array. */
  projector: number;
  /**
   * The ENCODED signal this projector emits toward the point, per channel, in
   * [0, 1] — i.e. the framebuffer value, after blending and masking, before the
   * projector's transfer curve. conventions.ts §P turns this into radiance.
   */
  signal: ChannelTriplet;
  /** Normalized blend weight times polar mask. Diagnostics; already in `signal`. */
  weight: number;
  /** cos of the angle between the surface normal and the direction to the lens. */
  incidenceCos: number;
  /** Surface point to lens, metres. */
  distanceM: number;
  /** Unit vector from the surface point toward the lens. */
  toLens: Vec3;
  /** This projector's per-channel transfer terms. PARAMETERS.md §3.2. */
  transfer: ProjectorTransfer;
  /**
   * The distance at which this projector's output is defined to be 1.0 — the
   * centre of its own footprint, which is the near point of the sphere at
   * `d - R`. PARAMETERS.md Conventions, "Radiometry".
   */
  referenceDistanceM: number;
}

/** Everything a shading model is allowed to see about one surface point. */
export interface ShadeInput {
  point: Vec3;
  /** Outward unit normal. */
  normal: Vec3;
  /** Unit vector from the surface point toward the viewer. */
  viewDir: Vec3;
  contributions: ProjectorContribution[];
  /** Diffuse reflectance of the surface, per channel. PARAMETERS.md §1 `rho`. */
  reflectance: ChannelTriplet;
  /** Ambient irradiance, relative linear. PARAMETERS.md §5 `E_amb`. */
  ambient: ChannelTriplet;
}

export interface ShadingModel {
  readonly name: string;
  /** Reflected radiance, relative linear, per channel. */
  shade(input: ShadeInput): ChannelTriplet;
}

/**
 * Lambertian diffuse plus additive ambient. No specular lobe, no
 * inter-reflection, no depth of field — PARAMETERS.md §9 lists the last two as
 * known omissions and §1's `rho_spec` is an explicit "pure guess" the spec
 * invites setting to zero to test sensitivity.
 *
 * ## The two geometric factors, and why the normalization is what it is
 *
 * PARAMETERS.md's Radiometry convention defines 1.0 as "a single projector's
 * full-output value in that channel at the center of its own footprint, measured
 * at the sphere surface". So the emitted radiance from the transfer curve is
 * already normalized to the footprint centre, and what remains is how the
 * irradiance at some other point differs from the irradiance there:
 *
 *   - `cos(incidence)`, which is 1 at the footprint centre and falls to 0 at the
 *     limb — the exact quantity PARAMETERS.md §4.1 gives in closed form and §4.3
 *     uses to place the practically-usable boundary at 69 degrees along a
 *     meridian and 59 in a seam.
 *   - inverse-square falloff relative to `d - R`, the distance to the footprint
 *     centre. Across one footprint this spans `d - R` to `sqrt(d^2 - R^2)`,
 *     which §3.3 computes as a 0.79 m swing — an 18% irradiance difference at
 *     d = 5.18 m, well above the 2% seam-luminance gate in §7, so it cannot be
 *     dropped as a small term.
 *
 * Ambient is added as irradiance, not as radiance, so it is multiplied by
 * reflectance like every other source. §5 models it as a uniform hemisphere,
 * which is why it carries no cosine factor.
 */
export function lambertianShading(): ShadingModel {
  return {
    name: 'lambertian-v1',
    shade(input: ShadeInput): ChannelTriplet {
      let r = input.ambient.r;
      let g = input.ambient.g;
      let b = input.ambient.b;

      for (const c of input.contributions) {
        const cos = c.incidenceCos > 0 ? c.incidenceCos : 0;
        if (cos === 0) continue;
        const falloff = (c.referenceDistanceM * c.referenceDistanceM) / (c.distanceM * c.distanceM);
        const k = cos * falloff;
        const e = emittedRadianceRgb(c.signal, c.transfer);
        r += e.r * k;
        g += e.g * k;
        b += e.b * k;
      }

      return {
        r: r * input.reflectance.r,
        g: g * input.reflectance.g,
        b: b * input.reflectance.b,
      };
    },
  };
}

/**
 * PARAMETERS.md §1's specular terms, as a parameter block.
 *
 * All three are class ASSUME and §1 says so in as many words: `ρ_spec` is "matte
 * paint still has a low-gloss lobe" with an invitation to "set to 0 to test
 * sensitivity", and `α_spec` is labelled "Broad, dim lobe. Pure guess."
 */
export interface SpecularParams {
  /**
   * §1 `ρ_spec`, nominal 0.03. The fraction of incident light the coating reflects
   * specularly rather than passing to the diffuse substrate. At 0 this model
   * reproduces {@link lambertianShading} to the last bit, which is what §1's
   * "set to 0 to test sensitivity" asks for and what `test/shading.test.ts` pins.
   */
  weight?: number;
  /**
   * §1 `α_spec`, nominal 0.4, taken as the GGX `α` DIRECTLY rather than as a
   * perceptual roughness whose square is `α`. The spec writes "0.4 (GGX)" and GGX's
   * own parameter is `α`, so that is the literal reading; a site that meant
   * perceptual roughness would want 0.16 here. Since nobody has measured the gloss
   * of the paint at all, the difference between those two readings is smaller than
   * the uncertainty on the number itself — but it is a real ambiguity and it is
   * recorded rather than resolved.
   */
  alpha?: number;
  /**
   * Fresnel reflectance at normal incidence. 0.04 is the standard dielectric value
   * and is ACHROMATIC, which is the physically important part: a dielectric coating
   * reflects all three channels equally, so the hot spot desaturates whatever is
   * under it rather than tinting it. PARAMETERS.md gives no value; 0.04 is the
   * textbook figure for a clear coat and is class ASSUME like everything else here.
   */
  f0?: number;
}

/**
 * The full shading model: per-channel Lambertian diffuse, a GGX specular lobe, and
 * tinted ambient — PARAMETERS.md §1 and §5 as written, rather than the subset
 * {@link lambertianShading} implements.
 *
 * Behind the same `ShadingModel` interface, so `render.ts` needs no change: pass it
 * as `RenderOptions.shading` and every projector view, framebuffer and room view
 * picks it up.
 *
 * ## What it adds over `lambertian-v1`
 *
 * The specular lobe of §1, which the simple model omits: "Matte paint still has a
 * low-gloss lobe, producing a hot spot toward each projector." At the nominal
 * `ρ_spec` = 0.03 and `α_spec` = 0.4 the lobe adds about 0.2% at the centre of each
 * projector's footprint and less everywhere else — dim, exactly as §1 says, but not
 * zero against a 2% seam gate, and it is brightest at the sub-projector point and
 * dimmest in the seams, so it works in the same direction as the incidence falloff.
 *
 * ## Energy bookkeeping, and why there is a `pi`
 *
 * The Radiometry convention defines 1.0 as a single projector's full output at the
 * centre of its own footprint measured AT THE SURFACE, so the diffuse term is
 * written `rho * E` rather than `(rho/pi) * E` — the normalization has already
 * absorbed the `pi`. The specular term is a real BRDF in units of inverse
 * steradians, so it has to be multiplied by that same `pi` to live in the same
 * units. Getting this wrong scales the lobe by 3.14 in one direction or the other,
 * which is invisible on screen at `ρ_spec` = 0.03 and would quietly become a 0.6%
 * error in the seam metric.
 *
 * The two lobes share incident energy rather than stacking: diffuse is weighted by
 * `1 - ρ_spec`. So a rig with a glossier coat is not a brighter rig, it is one that
 * has moved light from the diffuse hemisphere into a narrow lobe.
 *
 * ## Ambient
 *
 * §5 models ambient as a uniform hemisphere, so it carries no cosine and no
 * direction. A uniform environment reflects off any BRDF as `albedo * L`, which for
 * this pair of lobes is `(1 - ρ_spec) * rho + ρ_spec` per channel — the specular
 * lobe returns its own weight exactly, whatever its roughness. The ambient TINT of
 * §5's `E_amb_chroma` is not applied here: it belongs to the light, not the
 * surface, and arrives already coloured in `ShadeInput.ambient`. `color.ts`'s
 * `tintedAmbient` is what builds it.
 */
export function fullShading(params: SpecularParams = {}): ShadingModel {
  const weight = clamp(params.weight ?? 0.03, 0, 1);
  const alpha = Math.max(1e-4, params.alpha ?? 0.4);
  const f0 = params.f0 ?? 0.04;
  const kd = 1 - weight;
  const a2 = alpha * alpha;

  return {
    name: `full-v1(rho_spec=${weight},alpha_spec=${alpha})`,
    shade(input: ShadeInput): ChannelTriplet {
      // A uniform hemisphere reflects at the surface's total albedo, diffuse lobe
      // plus specular lobe. With weight = 0 this is exactly `ambient * reflectance`.
      let r = input.ambient.r * (kd * input.reflectance.r + weight);
      let g = input.ambient.g * (kd * input.reflectance.g + weight);
      let b = input.ambient.b * (kd * input.reflectance.b + weight);

      const nDotV = dot(input.normal, input.viewDir);

      for (const c of input.contributions) {
        const nDotL = c.incidenceCos > 0 ? c.incidenceCos : 0;
        if (nDotL === 0) continue;
        const falloff = (c.referenceDistanceM * c.referenceDistanceM) / (c.distanceM * c.distanceM);
        // Irradiance in the project's relative units: emitted radiance, the
        // incidence cosine, and inverse-square falloff against the footprint centre.
        const k = nDotL * falloff;
        const e = emittedRadianceRgb(c.signal, c.transfer);

        let spec = 0;
        if (weight > 0 && nDotV > 0) {
          spec = weight * Math.PI * ggxBrdf(input.normal, c.toLens, input.viewDir, nDotL, nDotV, a2, f0);
        }

        r += e.r * k * (kd * input.reflectance.r + spec);
        g += e.g * k * (kd * input.reflectance.g + spec);
        b += e.b * k * (kd * input.reflectance.b + spec);
      }

      return { r, g, b };
    },
  };
}

/**
 * Cook-Torrance microfacet BRDF with the GGX/Trowbridge-Reitz distribution, Smith's
 * separable geometry term matched to it, and Schlick's Fresnel approximation.
 *
 * `D * G * F / (4 * NdotL * NdotV)`. The `4 * NdotL * NdotV` denominator cancels
 * against the `NdotL` the caller has already folded into its irradiance, so the two
 * must be kept consistent — the caller multiplies by `k = NdotL * falloff` and this
 * function divides by `NdotL`, which is correct and looks like a bug until you
 * check both halves.
 *
 * Achromatic: a dielectric clear coat has the same `F0` in all three channels, so
 * the lobe carries no colour of its own.
 */
function ggxBrdf(
  normal: Vec3,
  toLens: Vec3,
  viewDir: Vec3,
  nDotL: number,
  nDotV: number,
  a2: number,
  f0: number,
): number {
  const half = normalize({
    x: toLens.x + viewDir.x,
    y: toLens.y + viewDir.y,
    z: toLens.z + viewDir.z,
  });
  const nDotH = dot(normal, half);
  if (!(nDotH > 0)) return 0;
  const vDotH = dot(viewDir, half);

  const denom = nDotH * nDotH * (a2 - 1) + 1;
  const d = a2 / (Math.PI * denom * denom);

  // Smith's G1 for GGX, one factor per direction.
  const g1l = (2 * nDotL) / (nDotL + Math.sqrt(a2 + (1 - a2) * nDotL * nDotL));
  const g1v = (2 * nDotV) / (nDotV + Math.sqrt(a2 + (1 - a2) * nDotV * nDotV));

  const oneMinus = 1 - (vDotH > 0 ? vDotH : 0);
  const f = f0 + (1 - f0) * Math.pow(oneMinus, 5);

  return (d * g1l * g1v * f) / (4 * nDotL * nDotV);
}
