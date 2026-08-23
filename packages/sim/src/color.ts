/**
 * Colorimetry: linear RGB -> CIE XYZ -> CIE Lab, ΔE2000, and the Planckian locus.
 *
 * PARAMETERS.md's Conventions section: "Work in linear RGB for summation, convert
 * to CIE XYZ → Lab for the chromaticity metric." §7 adds two chromaticity gates in
 * ΔE2000 — seam chromaticity at 1.0 and black-uplift chromaticity at 2.0 — and §5
 * gives the ambient a colour temperature (`E_amb_chroma`, 4000 K) that "tints the
 * whole sphere and shifts every ΔE measurement". Everything needed for those three
 * sentences lives here, and nothing else does.
 *
 * ## The primaries are an assumption, and it is not a small one
 *
 * PARAMETERS.md never states the projector's primaries. It gives per-channel
 * gammas, black floors and gains (§3.2) and a white point in kelvin, but the
 * chromaticity of "full red" is nowhere in the document — and every ΔE this module
 * computes depends on it. §9 already lists "spectral rendering — RGB only, so
 * metamerism between projector primaries and ambient light is approximated, not
 * simulated" as a known omission; this is the other half of that omission.
 *
 * So the RGB->XYZ matrix is a PARAMETER with a default, not a constant. The
 * default is Rec.709/sRGB primaries at D65, because it is the only set any of the
 * cited documents implies (SOS content is authored as ordinary RGB imagery) and
 * because a documented wrong answer beats an undocumented one. A real DLP's
 * primaries — especially one with a white segment in the colour wheel — are
 * materially different, and swapping the matrix is a one-argument change.
 *
 * Class ASSUME. Every metric that reaches this module is PROVISIONAL.
 *
 * ## ΔE2000 is the real formula
 *
 * Including the `R_T` rotation term, the `G` chroma compensation, and the mean-hue
 * rules that go wrong when two hues straddle 0/360. A ΔE76 relabelled as ΔE2000 is
 * a common and entirely silent bug: it agrees to within a few percent on large
 * differences and is wrong by a factor of two on exactly the near-neutral,
 * near-blue pairs §7's gates are set at. {@link deltaE76} is exported so a test can
 * prove the two are different rather than assert it, and `test/color.test.ts`
 * checks this implementation against the published Sharma/Wu/Dalal reference pairs.
 */

import type { ChannelTriplet } from '../../calibration/src/index.ts';

/** CIE 1931 tristimulus values. `Y` is luminance in the same relative units as the input RGB. */
export interface Xyz {
  X: number;
  Y: number;
  Z: number;
}

/** CIE 1976 L*a*b*. */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** CIE 1931 chromaticity coordinates. */
export interface Xy {
  x: number;
  y: number;
}

/** Row-major 3x3, `m[row * 3 + col]`, mapping linear RGB to XYZ. */
export type ColorMatrix = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Rec.709 / sRGB primaries at D65, linear RGB -> XYZ.
 *
 * The default, and an ASSUME — see the module note. Row 1 is the luminance row,
 * which is why {@link relativeLuminance} reads it directly instead of computing a
 * whole XYZ.
 */
export const REC709_D65_RGB_TO_XYZ: ColorMatrix = [
  0.4123907992659595, 0.35758433938387796, 0.18048078840183429, 0.21263900587151036,
  0.7151686787677559, 0.07219231536073371, 0.01933081871559185, 0.11919477979462599,
  0.9505321522496607,
];

/** The exact inverse of {@link REC709_D65_RGB_TO_XYZ}. */
export const REC709_D65_XYZ_TO_RGB: ColorMatrix = [
  3.240969941904523, -1.5373831775700939, -0.498610760293003, -0.9692436362808796,
  1.8759675015077204, 0.0415550574071756, 0.05563007969699366, -0.2039769588889765,
  1.0569715142428784,
];

/** D65 white as XYZ, normalized to `Y = 1`. The column sums of the matrix above. */
export const D65_WHITE_XYZ: Xyz = {
  X: 0.9504559270516716,
  Y: 1,
  Z: 1.0890577507598784,
};

export function applyColorMatrix(m: ColorMatrix, r: number, g: number, b: number): Xyz {
  return {
    X: m[0] * r + m[1] * g + m[2] * b,
    Y: m[3] * r + m[4] * g + m[5] * b,
    Z: m[6] * r + m[7] * g + m[8] * b,
  };
}

export function linearRgbToXyz(rgb: ChannelTriplet, m: ColorMatrix = REC709_D65_RGB_TO_XYZ): Xyz {
  return applyColorMatrix(m, rgb.r, rgb.g, rgb.b);
}

export function xyzToLinearRgb(
  xyz: Xyz,
  m: ColorMatrix = REC709_D65_XYZ_TO_RGB,
): ChannelTriplet {
  const c = applyColorMatrix(m, xyz.X, xyz.Y, xyz.Z);
  return { r: c.X, g: c.Y, b: c.Z };
}

/**
 * Luminance of a linear-light RGB triple, in the same relative units.
 *
 * The middle row of the matrix, nothing more. Kept as its own function because
 * "luminance" appears in §7's seam gate ("2% of local mean") and a reader should be
 * able to see that the metric uses photopic Y rather than an unweighted channel
 * mean — the two differ by a factor of three on a saturated blue artifact, which is
 * precisely the artifact §3.2 predicts.
 */
export function relativeLuminance(
  rgb: ChannelTriplet,
  m: ColorMatrix = REC709_D65_RGB_TO_XYZ,
): number {
  return m[3] * rgb.r + m[4] * rgb.g + m[5] * rgb.b;
}

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

/**
 * The CIE Lab companding function, with the linear segment near zero.
 *
 * The linear segment is not optional here. §7's black-uplift chromaticity gate is
 * evaluated in dark content where `Y/Yn` is of order 1e-3 — well below the
 * `epsilon = 216/24389` breakpoint — and a pure cube root there has an unbounded
 * derivative, so a naive implementation reports a ΔE that grows without limit as
 * the content gets darker. That would turn the gate into a measurement of how dark
 * the room is.
 */
function labF(t: number): number {
  if (t > LAB_EPSILON) return Math.cbrt(t);
  return (LAB_KAPPA * (t > 0 ? t : 0) + 16) / 116;
}

export function xyzToLab(xyz: Xyz, white: Xyz = D65_WHITE_XYZ): Lab {
  const fx = labF(xyz.X / white.X);
  const fy = labF(xyz.Y / white.Y);
  const fz = labF(xyz.Z / white.Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * Linear RGB straight to Lab, adapting to a stated white given as linear RGB.
 *
 * The white matters and there is no neutral choice. `metrics/photometric.ts` uses
 * the sphere's radiance under one projector's full white output at the centre of
 * its own footprint — i.e. the reflectance triple of PARAMETERS.md §1 — because
 * that is the brightest thing in the room and therefore what a viewer's eye is
 * adapted to. Adapting instead to the local dark level, which some seam-analysis
 * literature does, inflates every ΔE in black content by more than an order of
 * magnitude and would make §7's 2.0 gate mean something entirely different. The
 * choice is recorded in the metric's provenance rather than buried here.
 */
export function linearRgbToLab(
  rgb: ChannelTriplet,
  whiteRgb: ChannelTriplet,
  m: ColorMatrix = REC709_D65_RGB_TO_XYZ,
): Lab {
  return xyzToLab(linearRgbToXyz(rgb, m), linearRgbToXyz(whiteRgb, m));
}

/** CIE76: plain Euclidean distance in Lab. Exported to be compared AGAINST, not used. */
export function deltaE76(a: Lab, b: Lab): number {
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

const DEG = Math.PI / 180;

/**
 * CIEDE2000, the full formula.
 *
 * Sharma, Wu and Dalal (2005), "The CIEDE2000 color-difference formula:
 * implementation notes, supplementary test data, and mathematical observations."
 * The three places an implementation usually goes wrong, all handled explicitly:
 *
 *  1. **The mean hue when the two hues straddle the 0/360 discontinuity.** The
 *     naive average of 350 and 10 is 180 — the opposite hue — which sends the `T`
 *     weighting and the `R_T` rotation to entirely wrong values. Reference pairs
 *     1 through 6 exist to catch exactly this.
 *  2. **Neutral colours, where the hue angle is undefined.** When either chroma is
 *     zero, `Δh'` is defined to be zero and the mean hue is the plain sum, not the
 *     average. Pairs 9 through 16 catch this.
 *  3. **The `R_T` rotation term itself.** It is only large in the blue region
 *     around `h' = 275`, and it is NEGATIVE, so an implementation that drops it
 *     over-reports blue differences. §3.2's predicted artifact is a blue deficit,
 *     so this project would feel that error directly.
 *
 * `kL`, `kC`, `kH` default to 1 — the reference conditions the gates in §7 are
 * quoted under.
 */
export function deltaE2000(lab1: Lab, lab2: Lab, kL = 1, kC = 1, kH = 1): number {
  const c1 = Math.hypot(lab1.a, lab1.b);
  const c2 = Math.hypot(lab2.a, lab2.b);
  const cBar = (c1 + c2) / 2;
  const cBar7 = Math.pow(cBar, 7);
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 6103515625))); // 25^7 = 6103515625

  const a1p = (1 + g) * lab1.a;
  const a2p = (1 + g) * lab2.a;
  const c1p = Math.hypot(a1p, lab1.b);
  const c2p = Math.hypot(a2p, lab2.b);

  const h1p = hueAngleDeg(a1p, lab1.b);
  const h2p = hueAngleDeg(a2p, lab2.b);

  const dLp = lab2.L - lab1.L;
  const dCp = c2p - c1p;

  const chromaProduct = c1p * c2p;
  let dhp: number;
  if (chromaProduct === 0) {
    dhp = 0;
  } else if (Math.abs(h2p - h1p) <= 180) {
    dhp = h2p - h1p;
  } else if (h2p - h1p > 180) {
    dhp = h2p - h1p - 360;
  } else {
    dhp = h2p - h1p + 360;
  }
  const dHp = 2 * Math.sqrt(chromaProduct) * Math.sin((dhp / 2) * DEG);

  const lBar = (lab1.L + lab2.L) / 2;
  const cBarP = (c1p + c2p) / 2;

  let hBarP: number;
  if (chromaProduct === 0) {
    hBarP = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBarP = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hBarP = (h1p + h2p + 360) / 2;
  } else {
    hBarP = (h1p + h2p - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * DEG) +
    0.24 * Math.cos(2 * hBarP * DEG) +
    0.32 * Math.cos((3 * hBarP + 6) * DEG) -
    0.2 * Math.cos((4 * hBarP - 63) * DEG);

  const dTheta = 30 * Math.exp(-Math.pow((hBarP - 275) / 25, 2));
  const cBarP7 = Math.pow(cBarP, 7);
  const rc = 2 * Math.sqrt(cBarP7 / (cBarP7 + 6103515625));
  const rt = -Math.sin(2 * dTheta * DEG) * rc;

  const lMinus50 = lBar - 50;
  const sl = 1 + (0.015 * lMinus50 * lMinus50) / Math.sqrt(20 + lMinus50 * lMinus50);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;

  const termL = dLp / (kL * sl);
  const termC = dCp / (kC * sc);
  const termH = dHp / (kH * sh);

  return Math.sqrt(termL * termL + termC * termC + termH * termH + rt * termC * termH);
}

/** Hue angle in [0, 360). Zero for the neutral axis, per the CIEDE2000 notes. */
function hueAngleDeg(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const deg = Math.atan2(b, a) / DEG;
  return deg >= 0 ? deg : deg + 360;
}

/**
 * Chromaticity of a Planckian (blackbody) radiator at `cctK`, CIE 1931 xy.
 *
 * PARAMETERS.md §5 gives the ambient a colour temperature and nothing else, so a
 * temperature has to become a colour somewhere. This is Kim, Garcia, Kwak and Lee's
 * cubic-spline approximation to the Planckian locus, valid over 1667–25000 K, which
 * reproduces the published locus to within about 0.0005 in x and y — an order of
 * magnitude finer than the difference between 4000 K and 4100 K, and far finer than
 * the uncertainty on `E_amb_chroma` itself (class ASSUME, no stated range,
 * docs/AMENDMENTS.md A-04).
 *
 * Two things this is NOT. It is not the daylight locus, so 6500 K here is the
 * blackbody at 6500 K rather than D65 — the two differ by about 0.005 in y, which
 * matters if a caller means "daylight". And it is not a spectral computation: §9
 * lists spectral rendering as a known omission, so the tint is applied as a
 * chromaticity in an RGB model rather than as a spectrum against the projector's
 * actual primaries.
 *
 * Inputs outside the valid range are clamped rather than extrapolated; the cubics
 * diverge quickly outside their fitted interval.
 */
export function planckianChromaticity(cctK: number): Xy {
  const t = Math.min(25000, Math.max(1667, cctK));
  const t2 = t * t;
  const t3 = t2 * t;

  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;

  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (t <= 2222) {
    y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  } else if (t <= 4000) {
    y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  }
  return { x, y };
}

/** Chromaticity plus a luminance, as XYZ. `y = 0` returns black rather than NaN. */
export function xyToXyz(xy: Xy, luminance = 1): Xyz {
  if (!(xy.y > 0)) return { X: 0, Y: 0, Z: 0 };
  const s = luminance / xy.y;
  return { X: s * xy.x, Y: luminance, Z: s * (1 - xy.x - xy.y) };
}

/**
 * McCamy's cubic approximation for correlated colour temperature from
 * chromaticity — the inverse of {@link planckianChromaticity}, near the locus.
 *
 * PARAMETERS.md §3.2 lists `wp_i` (white point in kelvin) as "derived from `g`;
 * tracked separately for reporting", which is exactly this: given a projector's
 * three channel gains, its white is a chromaticity, and this turns that back into
 * the number the spec wants reported. Accurate to a few kelvin near the locus and
 * meaningless far from it, so callers should report the chromaticity too.
 */
export function cctFromChromaticity(xy: Xy): number {
  const n = (xy.x - 0.332) / (0.1858 - xy.y);
  return 437 * n * n * n + 3601 * n * n + 6861 * n + 5517;
}

/**
 * Ambient irradiance as a linear RGB triple: PARAMETERS.md §5's `E_amb` carrying
 * §5's `E_amb_chroma`.
 *
 * `level` is the luminance — §5's `E_amb` is stated as a relative *luminance*, so
 * the returned triple has photopic `Y` exactly equal to `level` regardless of the
 * colour temperature. That is the property that makes a tint sweep a sweep of one
 * variable: changing `E_amb_chroma` alone must not change how much light there is.
 *
 * A chromaticity outside the primaries' gamut would need a negative channel; those
 * are clamped to zero, which changes the luminance slightly. `outOfGamut` says
 * whether that happened so a report can say so rather than silently shipping a
 * colour the model cannot represent. At §5's nominal 4000 K with Rec.709 primaries
 * it does not happen.
 */
export function ambientIrradiance(
  level: number,
  cctK: number,
  m: ColorMatrix = REC709_D65_XYZ_TO_RGB,
): { rgb: ChannelTriplet; outOfGamut: boolean } {
  const xyz = xyToXyz(planckianChromaticity(cctK), level);
  const raw = xyzToLinearRgb(xyz, m);
  const outOfGamut = raw.r < 0 || raw.g < 0 || raw.b < 0;
  return {
    rgb: {
      r: raw.r > 0 ? raw.r : 0,
      g: raw.g > 0 ? raw.g : 0,
      b: raw.b > 0 ? raw.b : 0,
    },
    outOfGamut,
  };
}

/** {@link ambientIrradiance} without the gamut flag, for call sites that only want the colour. */
export function tintedAmbient(level: number, cctK: number): ChannelTriplet {
  return ambientIrradiance(level, cctK).rgb;
}
