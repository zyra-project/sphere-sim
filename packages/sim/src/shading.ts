/**
 * The shading interface, and a deliberately simple Lambertian implementation.
 *
 * PARAMETERS.md's central conclusion is that every geometric parameter is DOC,
 * CFG or SOLVE while every photometric one is ASSUME or MEAS, and that
 * photometric metrics are "not trustworthy until the ground-truth visit
 * happens". The project prompt sequences the work accordingly: build and
 * optimize the geometry now, build but do not optimize the photometry.
 *
 * So the tracer talks to a `ShadingModel` and never to a photometric constant
 * directly. Swapping in the full per-channel model of §3.2 — divergent gammas,
 * tinted black floors, per-lamp gains, the specular lobe of §1 — is then a
 * matter of writing another implementation of this interface, with no edit to
 * render.ts at all.
 *
 * Everything here is LINEAR light (conventions.ts §P). Encoding happens once, at
 * the final viewer-camera step, in png.ts.
 */

import type { ChannelTriplet, ProjectorTransfer } from '../../calibration/src/index.ts';
import type { Vec3 } from './vec.ts';

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
 * conventions.ts §P, per channel:
 *
 *     L = gain * ((1 - blackFloor) * V^gamma + blackFloor)
 *
 * The black floor is additive and survives V = 0, which is the entire mechanism
 * behind the overlap uplift artifact of PARAMETERS.md §3.2 and §7: two
 * projectors overlapping in black content emit two black floors and the region
 * reads as a visible rectangle. §10 ranks `L_black` the second highest
 * photometric risk precisely because so much SOS content is dark.
 */
export function emittedRadiance(signal: number, gamma: number, blackFloor: number, gain: number): number {
  const v = signal < 0 ? 0 : signal > 1 ? 1 : signal;
  return gain * ((1 - blackFloor) * Math.pow(v, gamma) + blackFloor);
}

export function emittedRadianceRgb(signal: ChannelTriplet, t: ProjectorTransfer): ChannelTriplet {
  return {
    r: emittedRadiance(signal.r, t.gamma.r, t.blackFloor.r, t.gain.r),
    g: emittedRadiance(signal.g, t.gamma.g, t.blackFloor.g, t.gain.g),
    b: emittedRadiance(signal.b, t.gamma.b, t.blackFloor.b, t.gain.b),
  };
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
