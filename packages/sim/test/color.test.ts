/**
 * Colorimetry, checked against published reference data rather than against
 * itself.
 *
 * The ΔE2000 formula is the only piece of this project with an external ground
 * truth: Sharma, Wu and Dalal published 34 test pairs specifically because
 * implementations kept getting the hue-wraparound, neutral-colour and rotation
 * terms wrong in ways that pass every self-consistency check. Two of PARAMETERS.md
 * §7's four photometric gates are quoted in ΔE2000, so an implementation that is
 * quietly ΔE76 in disguise would move both of them by a factor of two.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  D65_WHITE_XYZ,
  REC709_D65_RGB_TO_XYZ,
  ambientIrradiance,
  cctFromChromaticity,
  deltaE2000,
  deltaE76,
  linearRgbToLab,
  linearRgbToXyz,
  planckianChromaticity,
  relativeLuminance,
  xyToXyz,
  xyzToLab,
  xyzToLinearRgb,
} from '../src/color.ts';
import type { Lab } from '../src/color.ts';

/**
 * The CIEDE2000 supplementary test data of Sharma, Wu and Dalal (2005), Table 1.
 * `[L1, a1, b1, L2, a2, b2, dE00]`, values as published to four decimals.
 *
 * Pairs 1-6 straddle the hue discontinuity near 0/360 degrees. Pairs 7-16 sit on or
 * beside the neutral axis where the hue angle is undefined. Pairs 17-24 are large
 * differences. Pairs 25-34 come from real colour-difference experiments. An
 * implementation that gets the arithmetic right but the mean-hue rules wrong passes
 * the last two groups and fails the first two, which is exactly why the table is
 * ordered this way.
 */
const SHARMA: readonly (readonly number[])[] = [
  [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
  [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
  [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
  [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
  [50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
  [50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
  [50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
  [50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
  [50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
  [50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

test('dE2000 reproduces every published Sharma reference pair', () => {
  let worst = 0;
  let worstIndex = -1;
  for (let i = 0; i < SHARMA.length; i++) {
    const row = SHARMA[i];
    const a: Lab = { L: row[0], a: row[1], b: row[2] };
    const b: Lab = { L: row[3], a: row[4], b: row[5] };
    const got = deltaE2000(a, b);
    const err = Math.abs(got - row[6]);
    if (err > worst) {
      worst = err;
      worstIndex = i + 1;
    }
    assert.ok(err < 5e-5, `pair ${i + 1}: got ${got.toFixed(6)}, published ${row[6]}`);
  }
  // The published values carry four decimals, so half a unit in the last place is
  // the best any implementation can do. Anything much larger than that is a formula
  // error rather than a rounding one.
  assert.ok(worst < 5e-5, `worst disagreement ${worst} at pair ${worstIndex}`);
});

test('dE2000 is symmetric, zero on identical colours, and NOT dE76', () => {
  for (const row of SHARMA) {
    const a: Lab = { L: row[0], a: row[1], b: row[2] };
    const b: Lab = { L: row[3], a: row[4], b: row[5] };
    assert.ok(Math.abs(deltaE2000(a, b) - deltaE2000(b, a)) < 1e-12, 'dE2000 must be symmetric');
    assert.equal(deltaE2000(a, a), 0);
  }

  // The two formulas disagree in BOTH directions, which is what makes the
  // substitution impossible to spot by eye on any single pair.
  //
  // Pair 16 — near-neutral, 3.54 apart in Lab — expands to 4.31, because the
  // chroma compensation `G` inflates small differences around the neutral axis.
  const p16 = SHARMA[15];
  const a16: Lab = { L: p16[0], a: p16[1], b: p16[2] };
  const b16: Lab = { L: p16[3], a: p16[4], b: p16[5] };
  assert.ok(Math.abs(deltaE76(a16, b16) - Math.hypot(2.5, 2.5)) < 1e-9);
  assert.ok(deltaE2000(a16, b16) > deltaE76(a16, b16) + 0.5, 'near-neutral pairs must expand');

  // Pair 17 — a large, saturated difference, 36.87 apart in Lab — compresses to
  // 27.15, because `S_C` and `S_H` grow with chroma.
  const p17 = SHARMA[16];
  const a17: Lab = { L: p17[0], a: p17[1], b: p17[2] };
  const b17: Lab = { L: p17[3], a: p17[4], b: p17[5] };
  assert.ok(deltaE2000(a17, b17) < deltaE76(a17, b17) - 5, 'saturated pairs must compress');

  // Pair 9 is the one no Euclidean metric can produce: 4.98 apart in Lab, 7.18 in
  // dE2000 — a 44% disagreement on a pair straddling the neutral axis.
  const p9 = SHARMA[8];
  const a9: Lab = { L: p9[0], a: p9[1], b: p9[2] };
  const b9: Lab = { L: p9[3], a: p9[4], b: p9[5] };
  assert.ok(deltaE2000(a9, b9) > deltaE76(a9, b9) + 2, 'and pair 9 must expand by more than 2');
});

test('the rotation term is the thing that makes blue different', () => {
  // R_T is only large near h = 275 degrees, which is blue, and it is NEGATIVE.
  // PARAMETERS.md §3.2's predicted artifact is a blue deficit, so an implementation
  // that dropped the rotation term would over-report exactly the artifact the
  // project is looking for. Pair 1 is in that region; construct a matched pair in
  // yellow (h ~ 95) with identical Lab deltas and check the two disagree.
  const blueA: Lab = { L: 50, a: 2.6772, b: -79.7751 };
  const blueB: Lab = { L: 50, a: 0, b: -82.7485 };
  const yellowA: Lab = { L: 50, a: 2.6772, b: 79.7751 };
  const yellowB: Lab = { L: 50, a: 0, b: 82.7485 };
  const blue = deltaE2000(blueA, blueB);
  const yellow = deltaE2000(yellowA, yellowB);
  assert.ok(
    Math.abs(blue - yellow) > 0.2,
    `the rotation term must separate blue from yellow; got ${blue} and ${yellow}`,
  );
});

test('Lab: white maps to L*=100 and the linear segment survives near black', () => {
  const white = { r: 1, g: 1, b: 1 };
  const lab = linearRgbToLab(white, white);
  assert.ok(Math.abs(lab.L - 100) < 1e-9);
  assert.ok(Math.abs(lab.a) < 1e-9 && Math.abs(lab.b) < 1e-9);

  // At Y/Yn below 216/24389 the companding is linear, not a cube root. A pure cube
  // root has unbounded derivative at zero, which would make §7's black-uplift dE
  // gate a measurement of how dark the content is rather than of the uplift.
  const dark = xyzToLab({ X: 0.0001, Y: 0.0001, Z: 0.0001 }, D65_WHITE_XYZ);
  const darker = xyzToLab({ X: 0.00005, Y: 0.00005, Z: 0.00005 }, D65_WHITE_XYZ);
  // Linear segment: halving Y halves L*.
  assert.ok(Math.abs(darker.L / dark.L - 0.5) < 1e-6, 'the near-black segment must be linear');
  assert.equal(xyzToLab({ X: 0, Y: 0, Z: 0 }, D65_WHITE_XYZ).L, 0);

  // Exactly at the breakpoint the two branches must agree.
  const eps = 216 / 24389;
  const below = xyzToLab({ X: eps * 0.999999999, Y: eps * 0.999999999, Z: eps * 0.999999999 }, { X: 1, Y: 1, Z: 1 });
  const above = xyzToLab({ X: eps * 1.000000001, Y: eps * 1.000000001, Z: eps * 1.000000001 }, { X: 1, Y: 1, Z: 1 });
  assert.ok(Math.abs(below.L - above.L) < 1e-6, 'the companding must be continuous at epsilon');
});

test('the RGB<->XYZ matrices are inverses and the luminance row is the middle one', () => {
  for (const rgb of [
    { r: 1, g: 0, b: 0 },
    { r: 0.3, g: 0.7, b: 0.11 },
    { r: 0.9, g: 0.9, b: 0.88 },
  ]) {
    const back = xyzToLinearRgb(linearRgbToXyz(rgb));
    assert.ok(Math.abs(back.r - rgb.r) < 1e-12, `round trip r ${back.r} vs ${rgb.r}`);
    assert.ok(Math.abs(back.g - rgb.g) < 1e-12);
    assert.ok(Math.abs(back.b - rgb.b) < 1e-12);
    assert.ok(Math.abs(relativeLuminance(rgb) - linearRgbToXyz(rgb).Y) < 1e-15);
  }
  // White is D65 at Y = 1.
  const w = linearRgbToXyz({ r: 1, g: 1, b: 1 });
  assert.ok(Math.abs(w.Y - 1) < 1e-12);
  assert.ok(Math.abs(w.X - D65_WHITE_XYZ.X) < 1e-12);
  assert.ok(Math.abs(w.Z - D65_WHITE_XYZ.Z) < 1e-12);
  // Green carries 71.5% of the luminance and blue 7.2% — the reason a blue-only
  // artifact of 6% is a luminance artifact of well under 1%.
  assert.ok(Math.abs(REC709_D65_RGB_TO_XYZ[4] - 0.7151686787677559) < 1e-15);
  assert.ok(Math.abs(REC709_D65_RGB_TO_XYZ[5] - 0.07219231536073371) < 1e-15);
});

test('the Planckian locus hits published reference points', () => {
  // CIE Standard Illuminant A is a Planckian radiator at 2856 K with published
  // chromaticity x = 0.44757, y = 0.40745. That is an external check on the
  // approximation, not a restatement of it.
  const a = planckianChromaticity(2856);
  assert.ok(Math.abs(a.x - 0.44757) < 0.001, `illuminant A x = ${a.x}`);
  assert.ok(Math.abs(a.y - 0.40745) < 0.001, `illuminant A y = ${a.y}`);

  // PARAMETERS.md §5's nominal ambient, 4000 K: published locus (0.3805, 0.3768).
  const amb = planckianChromaticity(4000);
  assert.ok(Math.abs(amb.x - 0.3805) < 0.001, `4000 K x = ${amb.x}`);
  assert.ok(Math.abs(amb.y - 0.3768) < 0.001, `4000 K y = ${amb.y}`);

  // Monotone: hotter is bluer, i.e. smaller x, all the way across the range.
  let prev = Infinity;
  for (let t = 1700; t <= 25000; t += 100) {
    const xy = planckianChromaticity(t);
    assert.ok(xy.x < prev, `x must fall with temperature; failed at ${t}`);
    prev = xy.x;
  }

  // Out of range clamps rather than extrapolating the cubics into nonsense.
  assert.deepEqual(planckianChromaticity(500), planckianChromaticity(1667));
  assert.deepEqual(planckianChromaticity(1e9), planckianChromaticity(25000));

  // McCamy inverts it to within a few kelvin on the locus itself.
  for (const t of [2856, 3000, 4000, 5000, 6500]) {
    const back = cctFromChromaticity(planckianChromaticity(t));
    assert.ok(Math.abs(back - t) / t < 0.005, `CCT round trip ${t} -> ${back}`);
  }
});

test('ambient tinting changes the colour and not the amount of light', () => {
  // PARAMETERS.md §5 states E_amb as a relative LUMINANCE, so a colour-temperature
  // sweep has to be a sweep of one variable: the tint must not smuggle in a
  // brightness change, or every sensitivity result for E_amb_chroma would really be
  // a result for E_amb.
  for (const cct of [2700, 3000, 4000, 5000, 6500]) {
    const { rgb, outOfGamut } = ambientIrradiance(0.04, cct);
    assert.equal(outOfGamut, false, `${cct} K should be inside the Rec.709 gamut`);
    assert.ok(
      Math.abs(relativeLuminance(rgb) - 0.04) < 1e-12,
      `${cct} K carried luminance ${relativeLuminance(rgb)}`,
    );
  }

  // Warm is redder than cool, and §5's nominal 4000 K is warm.
  const warm = ambientIrradiance(0.04, 2700).rgb;
  const cool = ambientIrradiance(0.04, 6500).rgb;
  assert.ok(warm.r / warm.b > cool.r / cool.b, 'lower CCT must be redder');
  const nominal = ambientIrradiance(0.04, 4000).rgb;
  assert.ok(nominal.r > nominal.g && nominal.g > nominal.b, '4000 K is a warm white');

  // And the tint is not free: against a neutral reference it is worth a large dE.
  // §5 says it "tints the whole sphere and shifts every dE measurement" — this is
  // how much.
  const white = { r: 0.9, g: 0.9, b: 0.88 };
  const neutral = { r: 0.04, g: 0.04, b: 0.04 };
  const shift = deltaE2000(linearRgbToLab(nominal, white), linearRgbToLab(neutral, white));
  assert.ok(shift > 5, `4000 K ambient against neutral is only dE ${shift}`);
});

test('xyToXyz preserves chromaticity and handles the degenerate case', () => {
  const xy = planckianChromaticity(4000);
  const xyz = xyToXyz(xy, 0.04);
  const sum = xyz.X + xyz.Y + xyz.Z;
  assert.ok(Math.abs(xyz.X / sum - xy.x) < 1e-12);
  assert.ok(Math.abs(xyz.Y / sum - xy.y) < 1e-12);
  assert.ok(Math.abs(xyz.Y - 0.04) < 1e-15);
  assert.deepEqual(xyToXyz({ x: 0.3, y: 0 }, 1), { X: 0, Y: 0, Z: 0 });
});
