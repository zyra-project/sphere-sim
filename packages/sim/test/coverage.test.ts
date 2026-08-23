/**
 * The correctness checks this whole package exists to satisfy.
 *
 * PARAMETERS.md §4.2 and §4.3 state facts that are counterintuitive, that a
 * plausible-looking implementation will violate, and that the project prompt is
 * explicit about: "If your implementation contradicts any of these, you have a
 * bug." So these are not coverage theatre. Each one is a claim from the spec,
 * reproduced from the general vector code rather than from the closed form the
 * spec quotes, so that agreement means something.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bestIncidenceCosine,
  blendWeights,
  contributors,
  coverageBoundaryLatitude,
  incidenceCosine,
  incidenceCosineClosed,
  isIlluminated,
  overlapMultiplicity,
  polarMask,
  rampValue,
  unlitPolarAreaFraction,
  usableLatitude,
} from '../src/coverage.ts';
import { nominalRig } from '../src/scene.ts';
import { prepareRig } from '../src/optics.ts';
import { latLonToWorld } from '../src/geometry.ts';
import { DEG2RAD, dot } from '../src/vec.ts';

const R = 0.8636; // PARAMETERS.md §1
const D_MANUAL = 5.18; // §2, the alignment manual's figure — the one §4.3 quotes

// ---------------------------------------------------------------------------
// §4.2 — overlap multiplicity never exceeds 2
// ---------------------------------------------------------------------------

/**
 * A Fibonacci lattice: equal-area by construction, so a "never exceeds 2" claim
 * is tested with uniform density over the sphere rather than with a lat/lon grid
 * that piles 90% of its samples into the polar caps. Deterministic, no PRNG.
 */
function fibonacciSphere(n: number): { latDeg: number; lonDeg: number }[] {
  const out: { latDeg: number; lonDeg: number }[] = new Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const lat = Math.asin(z) * (180 / Math.PI);
    const lon = (((i * golden) % (2 * Math.PI)) * 180) / Math.PI - 180;
    out[i] = { latDeg: lat, lonDeg: lon };
  }
  return out;
}

test('§4.2: overlap multiplicity never exceeds 2, over 500k uniform points', () => {
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  assert.equal(rig.projectors.length, 4);

  const points = fibonacciSphere(500_000);
  const histogram = [0, 0, 0, 0, 0];
  for (const p of points) {
    const n = overlapMultiplicity(p.latDeg, p.lonDeg, rig);
    histogram[n]++;
  }

  assert.equal(histogram[3], 0, `${histogram[3]} points saw 3-way overlap`);
  assert.equal(histogram[4], 0, `${histogram[4]} points saw 4-way overlap`);
  // And the interesting half of the claim: both 1 and 2 really do occur, so the
  // test would fail on an implementation that lights nothing.
  assert.ok(histogram[1] > 0 && histogram[2] > 0, 'expected both 1- and 2-way regions to exist');
  assert.ok(histogram[0] > 0, 'expected a permanently unlit polar region to exist');
});

test('§4.2: overlap multiplicity never exceeds 2, densely near BOTH poles', () => {
  // The poles are where rev 1 of the spec got this wrong — it asserted overlap
  // goes 2-way, 3-way, 4-way toward the poles. §4.2 corrects it: the poles sit
  // exactly 90 degrees from every lens, outside the 80.4 degree limit, so they
  // are lit by NOBODY. A uniform sample puts almost nothing up there, so sample
  // the caps directly.
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));

  let worst = 0;
  let checked = 0;
  for (const sign of [1, -1]) {
    for (let i = 0; i <= 300; i++) {
      // Latitude 60 to 90, concentrated at the pole.
      const latDeg = sign * (90 - 30 * Math.pow(i / 300, 2));
      for (let j = 0; j < 720; j++) {
        const lonDeg = -180 + (360 * j) / 720;
        worst = Math.max(worst, overlapMultiplicity(latDeg, lonDeg, rig));
        checked++;
      }
    }
  }
  assert.ok(checked > 400_000, `only checked ${checked} polar points`);
  assert.ok(worst <= 2, `polar overlap multiplicity reached ${worst}`);

  // Both poles themselves receive nothing at all.
  assert.equal(overlapMultiplicity(90, 0, rig), 0);
  assert.equal(overlapMultiplicity(-90, 0, rig), 0);
});

test('§4.2: overlap multiplicity never exceeds 2 across the whole d_proj prior', () => {
  // §2 leaves d_proj conflicted between 5.18 and 5.50-6.14 and says to treat it
  // as SOLVE with a wide 5.0-6.5 prior. §4.2 says the SHAPE of the coverage field
  // does not change across it — so the multiplicity bound must hold everywhere
  // in the prior, not just at the nominal.
  const points = fibonacciSphere(120_000);
  for (const d of [5.0, 5.18, 5.5, 6.14, 6.5]) {
    const rig = prepareRig(nominalRig({ distanceM: d }));
    let worst = 0;
    for (const p of points) worst = Math.max(worst, overlapMultiplicity(p.latDeg, p.lonDeg, rig));
    assert.ok(worst <= 2, `d_proj = ${d} produced ${worst}-way overlap`);
  }
});

test('§4.2: no point is ever lit by two projectors whose azimuths are antipodal', () => {
  // The mechanism behind the bound, tested directly. Any three of the four
  // nominal directions contain an antipodal pair, so if no antipodal pair ever
  // co-illuminates, 3-way overlap is impossible by construction.
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  for (const p of fibonacciSphere(60_000)) {
    const lit = contributors(p.latDeg, p.lonDeg, rig);
    assert.ok(!(lit.includes(0) && lit.includes(2)), `P1+P3 at ${p.latDeg},${p.lonDeg}`);
    assert.ok(!(lit.includes(1) && lit.includes(3)), `P2+P4 at ${p.latDeg},${p.lonDeg}`);
  }
});

// ---------------------------------------------------------------------------
// §4.1 — the closed form and the general form must agree
// ---------------------------------------------------------------------------

test('§4.1: the general vector limb test agrees with cos(lat)*cos(lon-phi) > R/d', () => {
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  const k = R / D_MANUAL;

  let disagreements = 0;
  for (const p of fibonacciSphere(200_000)) {
    for (let i = 0; i < 4; i++) {
      const phi = i * 90;
      const closed =
        Math.cos(p.latDeg * DEG2RAD) * Math.cos((p.lonDeg - phi) * DEG2RAD) > k;
      const general = isIlluminated(p.latDeg, p.lonDeg, rig.projectors[i]);
      // Points within a hair of the boundary can land either way; count only
      // real disagreements away from it.
      const margin = Math.abs(
        Math.cos(p.latDeg * DEG2RAD) * Math.cos((p.lonDeg - phi) * DEG2RAD) - k,
      );
      if (closed !== general && margin > 1e-9) disagreements++;
    }
  }
  assert.equal(disagreements, 0, `${disagreements} points disagreed with §4.1's closed form`);
});

test('§4.1: the general incidence cosine agrees with the closed form to 1e-12', () => {
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  const proj = rig.projectors[0]; // azimuth 0, so theta is measured from (0, 0)

  let worst = 0;
  for (let lat = -89; lat <= 89; lat += 1) {
    for (let lon = -179; lon <= 179; lon += 1) {
      // theta is the angular distance from the sub-projector point at (0, 0).
      const cosTheta = Math.cos(lat * DEG2RAD) * Math.cos(lon * DEG2RAD);
      const closed = incidenceCosineClosed(cosTheta, proj.distanceM, R);
      const general = incidenceCosine(lat, lon, proj);
      worst = Math.max(worst, Math.abs(closed - general));
    }
  }
  assert.ok(worst < 1e-12, `worst closed-vs-general incidence disagreement ${worst}`);
});

test('§4.1: incidence is 1 at the sub-projector point and 0 at the limb', () => {
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  const proj = rig.projectors[0];
  assert.ok(Math.abs(incidenceCosine(0, 0, proj) - 1) < 1e-12);

  const limbLatDeg = Math.acos(R / D_MANUAL) * (180 / Math.PI);
  assert.ok(Math.abs(incidenceCosine(limbLatDeg, 0, proj)) < 1e-9);
  // theta_max = acos(R/d) = 80.4 degrees at d = 5.18, exactly as §4.1 states.
  assert.ok(Math.abs(limbLatDeg - 80.4) < 0.05, `theta_max came out ${limbLatDeg}`);
});

// ---------------------------------------------------------------------------
// §4.3 — the unlit polar region is four-lobed and scalloped
// ---------------------------------------------------------------------------

test('§4.3: coverage reaches 80.4 deg on a meridian and 76.3 deg in a seam', () => {
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));

  for (const lon of [0, 90, 180, -90]) {
    const lat = coverageBoundaryLatitude(lon, rig, 1);
    assert.ok(
      Math.abs(lat - 80.4) < 0.1,
      `along the projector meridian at lon=${lon}, coverage reached ${lat.toFixed(4)} deg`,
    );
  }
  for (const lon of [45, 135, -135, -45]) {
    const lat = coverageBoundaryLatitude(lon, rig, 1);
    assert.ok(
      Math.abs(lat - 76.3) < 0.1,
      `in the seam direction at lon=${lon}, coverage reached ${lat.toFixed(4)} deg`,
    );
  }

  // §4.3 gives the seam figure as `cos(lat) * cos(45 deg) = R/d`. Check the
  // bisected answer against that arithmetic directly.
  const predicted = Math.acos(R / D_MANUAL / Math.cos(45 * DEG2RAD)) * (180 / Math.PI);
  assert.ok(Math.abs(coverageBoundaryLatitude(45, rig, 1) - predicted) < 1e-6);

  // The south pole is symmetric — the mask is asymmetric, the geometry is not.
  assert.ok(Math.abs(coverageBoundaryLatitude(0, rig, -1) - 80.4) < 0.1);
});

test('§4.3: the boundary has exactly four maxima and four minima — it is scalloped', () => {
  // This is the claim that distinguishes a four-lobed scalloped region from a
  // circular cap. A circular cap has a CONSTANT boundary latitude and therefore
  // no strict extrema at all.
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));

  const n = 720; // 0.5 degree steps; the extrema land on sample points
  const lat: number[] = new Array(n);
  for (let i = 0; i < n; i++) lat[i] = coverageBoundaryLatitude(-180 + (360 * i) / n, rig, 1);

  let maxima = 0;
  let minima = 0;
  for (let i = 0; i < n; i++) {
    const prev = lat[(i - 1 + n) % n];
    const next = lat[(i + 1) % n];
    if (lat[i] > prev && lat[i] > next) maxima++;
    if (lat[i] < prev && lat[i] < next) minima++;
  }
  assert.equal(maxima, 4, `expected 4 maxima (one per projector meridian), got ${maxima}`);
  assert.equal(minima, 4, `expected 4 minima (one per seam), got ${minima}`);

  // The scallop depth is about 4 degrees of latitude, and it is not noise.
  const hi = Math.max(...lat);
  const lo = Math.min(...lat);
  assert.ok(hi - lo > 3.5 && hi - lo < 4.5, `scallop depth ${hi - lo} deg`);
});

test('§4.3: the unlit polar area, and the range the spec states for it', () => {
  // Reported as a headline number, so it is computed here rather than asserted
  // loosely: integrate 1 - sin(lat_boundary) over longitude.
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  const fraction = unlitPolarAreaFraction(rig, 1440, 1);

  // The scalloped region must lie strictly BETWEEN the two circular caps that
  // §4.3's own boundary latitudes cut. That bracketing is the mathematical
  // content of "not a circular cap", and it holds for any correct
  // implementation.
  const capAt = (latDeg: number): number => (1 - Math.sin(latDeg * DEG2RAD)) / 2;
  const capMeridian = capAt(coverageBoundaryLatitude(0, rig, 1)); // 0.700%
  const capSeam = capAt(coverageBoundaryLatitude(45, rig, 1)); // 1.410%
  assert.ok(
    fraction > capMeridian && fraction < capSeam,
    `unlit fraction ${(fraction * 100).toFixed(4)}% must lie between the meridian cap ` +
      `${(capMeridian * 100).toFixed(4)}% and the seam cap ${(capSeam * 100).toFixed(4)}%`,
  );

  // The value itself, pinned so a regression is visible.
  assert.ok(
    Math.abs(fraction - 0.008931) < 0.00005,
    `unlit polar area fraction ${(fraction * 100).toFixed(4)}% (expected 0.8931%)`,
  );

  // Across the whole d_proj prior of §2 the figure spans 0.57% to 0.96%.
  const lo = unlitPolarAreaFraction(prepareRig(nominalRig({ distanceM: 6.5 })), 720, 1);
  const hi = unlitPolarAreaFraction(prepareRig(nominalRig({ distanceM: 5.0 })), 720, 1);
  assert.ok(Math.abs(lo - 0.005652) < 0.00005, `at d=6.5: ${(lo * 100).toFixed(4)}%`);
  assert.ok(Math.abs(hi - 0.009593) < 0.00005, `at d=5.0: ${(hi * 100).toFixed(4)}%`);

  // ---------------------------------------------------------------------
  // docs/AMENDMENTS.md A-05.
  //
  // §4.3 states the unlit region is "roughly 1.4-2.8% of the sphere by area,
  // per pole". That range is NOT reachable from the boundary latitudes stated
  // three sentences earlier in the same paragraph: the seam-direction cap is a
  // strict upper bound on the area, and it is 1.41%. So 1.4% is the ceiling,
  // not the floor, and 2.8% is exactly twice it.
  //
  // The assertion below pins where the stated numbers come from, which is the
  // evidence A-05 rests on: 1.4 is the seam-direction circular cap, and the
  // spec's range appears to be [that cap, twice that cap] rather than a range
  // over d_proj. This is a spec bug, not an implementation bug — the
  // implementation reproduces §4.3's 80.4 and 76.3 exactly, and those two
  // numbers force the area.
  // ---------------------------------------------------------------------
  assert.ok(
    Math.abs(capSeam - 0.014) < 0.0002,
    `the seam-direction cap is ${(capSeam * 100).toFixed(4)}%, which is where §4.3's "1.4%" comes from`,
  );
});

test('§4.3: coverage inside the boundary is complete — no holes', () => {
  // §7's only tolerance-free gate is "unlit fraction within the mask boundary:
  // 0%". Check the stronger property that makes it pass: below the scalloped
  // boundary, every point is lit by at least one projector.
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  let unlitInside = 0;
  for (const p of fibonacciSphere(200_000)) {
    if (Math.abs(p.latDeg) > 60) continue; // inside mask_lo, PARAMETERS.md §4.5
    if (overlapMultiplicity(p.latDeg, p.lonDeg, rig) === 0) unlitInside++;
  }
  assert.equal(unlitInside, 0, `${unlitInside} unlit points inside the mask boundary`);
});

// ---------------------------------------------------------------------------
// §4.3 / §4.4 — the practically usable limits, and the mask rationale
// ---------------------------------------------------------------------------

test('§4.3: incidence drops below 0.2 at latitude ~69 on a meridian, ~59 in a seam', () => {
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));

  const meridian = usableLatitude(0, rig, 0.2, 1);
  const seam = usableLatitude(45, rig, 0.2, 1);
  assert.ok(
    Math.abs(meridian - 69) < 0.5,
    `along a projector meridian the usable limit came out ${meridian.toFixed(3)} deg (§4.3 says ~69)`,
  );
  assert.ok(
    Math.abs(seam - 59) < 1.0,
    `in a seam direction the usable limit came out ${seam.toFixed(3)} deg (§4.3 says ~59)`,
  );

  // The usable limit is strictly inside the coverage limit — §4.3's point that
  // "the practically unusable region is much larger".
  assert.ok(meridian < coverageBoundaryLatitude(0, rig, 1) - 10);
  assert.ok(seam < coverageBoundaryLatitude(45, rig, 1) - 15);

  // And incidence really is above 0.2 below the limit and below it above.
  assert.ok(bestIncidenceCosine(meridian - 1, 0, rig) > 0.2);
  assert.ok(bestIncidenceCosine(meridian + 1, 0, rig) < 0.2);
});

test('§4.4: the bottommask onset of 60 matches the seam-direction usable limit', () => {
  // This is the observation the entire mask rationale rests on: the mask exists
  // to hide the degenerate grazing-incidence region, NOT to suppress overlap
  // brightness — §4.2 shows there is no 4x pile-up to suppress.
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  const seamUsable = usableLatitude(45, rig, 0.2, 1);
  const maskOnset = rig.blend.maskLoDeg;

  assert.equal(maskOnset, 60, "PARAMETERS.md §4.5's mask_lo, from `set bottommask 60,70`");
  assert.ok(
    Math.abs(maskOnset - seamUsable) < 1.0,
    `mask onset ${maskOnset} vs seam-direction usable limit ${seamUsable.toFixed(3)} — ` +
      `§4.4 calls this match "almost exactly", and it is what makes the grazing-incidence ` +
      `reading of the mask more credible than the overlap-brightness one`,
  );
});

// ---------------------------------------------------------------------------
// §M — the polar mask
// ---------------------------------------------------------------------------

test('§M: the mask is a cosine feather on ABSOLUTE latitude, south only', () => {
  const blend = {
    rampShape: 'cosine' as const,
    widthDeg: 20,
    rampGamma: 0.8,
    maskLoDeg: 60,
    maskHiDeg: 70,
    bottomOnly: true,
  };

  assert.equal(polarMask(0, blend), 1);
  assert.equal(polarMask(-59.9, blend), 1, 'unattenuated below the onset');
  assert.equal(polarMask(-70, blend), 0, 'fully masked at maskHi');
  assert.equal(polarMask(-85, blend), 0);
  assert.ok(Math.abs(polarMask(-65, blend) - 0.5) < 1e-12, 'cosine feather is 0.5 at the midpoint');

  // Monotone, and continuous at both ends — a step at the onset would show as a
  // ring at latitude 60, which is squarely in a standing viewer's field (§6).
  let prev = 1;
  for (let lat = -60; lat >= -70; lat -= 0.1) {
    const m = polarMask(lat, blend);
    assert.ok(m <= prev + 1e-12, `mask must be monotone, ${m} > ${prev} at ${lat}`);
    prev = m;
  }

  // bottomOnly: the north cap is occluded by the ceiling mount (§1, §4.4), so
  // there is no software mask there.
  assert.equal(polarMask(65, blend), 1);
  assert.equal(polarMask(89, blend), 1);
  // ...and with bottomOnly off, the mask is symmetric in ABSOLUTE latitude.
  const both = { ...blend, bottomOnly: false };
  assert.ok(Math.abs(polarMask(65, both) - polarMask(-65, both)) < 1e-15);
});

test('A-02: the colatitude reading roughly triples the masked region', () => {
  // docs/AMENDMENTS.md A-02: `set bottommask 60,70` is read as latitude, but the
  // reading is inferred, and §7 makes "unlit fraction within the mask boundary"
  // a hard 0% gate whose DOMAIN that reading defines. Both readings are
  // implemented so the difference is visible rather than assumed.
  const blend = {
    rampShape: 'cosine' as const,
    widthDeg: 20,
    rampGamma: 0.8,
    maskLoDeg: 60,
    maskHiDeg: 70,
    bottomOnly: true,
  };

  // Latitude reading: onset at |lat| 60, full at 70.
  assert.equal(polarMask(-59, blend, 'latitude'), 1);
  assert.equal(polarMask(-71, blend, 'latitude'), 0);

  // Colatitude reading: 70 degrees from the pole is latitude -20 (the onset),
  // 60 degrees from the pole is latitude -30 (full mask).
  assert.equal(polarMask(-19, blend, 'colatitude'), 1);
  assert.equal(polarMask(-31, blend, 'colatitude'), 0);
  assert.ok(Math.abs(polarMask(-25, blend, 'colatitude') - 0.5) < 1e-12);

  // A-02's "roughly triples" compares the region governed by `mask_lo` under
  // each reading: latitude puts that boundary at |lat| 60, colatitude puts it 60
  // degrees from the pole, i.e. |lat| 30. Find each boundary by bisecting the
  // mask itself rather than by restating the arithmetic, then compare the caps
  // they cut.
  //
  // The bisection predicates are `mask >= 1` for the onset and `mask > 0` for
  // full mask, not a comparison against a level like 1 - 1e-9. The cosine
  // feather of §M has zero derivative at both ends, so an epsilon-level test
  // resolves the onset only to sqrt(epsilon) — 2e-4 degrees, which would make a
  // tight assertion fail for reasons that have nothing to do with the mask.
  const boundaryOf = (
    interp: 'latitude' | 'colatitude',
    stillInside: (m: number) => boolean,
  ): number => {
    let lo = 0;
    let hi = 90;
    for (let i = 0; i < 80; i++) {
      const mid = 0.5 * (lo + hi);
      if (stillInside(polarMask(-mid, blend, interp))) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  const unattenuated = (m: number): boolean => m >= 1;
  const notYetFull = (m: number): boolean => m > 0;

  assert.ok(Math.abs(boundaryOf('latitude', unattenuated) - 60) < 1e-5);
  assert.ok(Math.abs(boundaryOf('latitude', notYetFull) - 70) < 1e-5);
  assert.ok(Math.abs(boundaryOf('colatitude', unattenuated) - 20) < 1e-5);
  assert.ok(Math.abs(boundaryOf('colatitude', notYetFull) - 30) < 1e-5);

  // Cap area as a fraction of the whole sphere, for the boundary `mask_lo`
  // defines under each reading.
  const cap = (latDeg: number): number => (1 - Math.sin(latDeg * DEG2RAD)) / 2;
  const latitudeCap = cap(60); // 6.70%
  const colatitudeCap = cap(30); // 25.00%
  assert.ok(Math.abs(latitudeCap - 0.0670) < 0.0005, `${(latitudeCap * 100).toFixed(2)}%`);
  assert.ok(Math.abs(colatitudeCap - 0.25) < 0.0005, `${(colatitudeCap * 100).toFixed(2)}%`);
  assert.ok(
    colatitudeCap / latitudeCap > 3 && colatitudeCap / latitudeCap < 4.5,
    `ratio ${colatitudeCap / latitudeCap} — A-02 says the protected region "roughly triples"`,
  );

  // The consequence A-02 warns about, made concrete: under the colatitude
  // reading, §7's hard 0%-unlit gate would apply out to latitude 30 instead of
  // 60 — over a region where incidence is far better, so the gate would be
  // easier, not harder. The risk is that it silently tests the wrong region.
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  assert.ok(bestIncidenceCosine(-30, 45, rig) > bestIncidenceCosine(-60, 45, rig));
});

// ---------------------------------------------------------------------------
// §B — blend ramps and weights
// ---------------------------------------------------------------------------

test('§B: all four ramp shapes run 0 to 1 and are monotone', () => {
  for (const shape of ['linear', 'cosine', 'smoothstep', 'gaussian'] as const) {
    assert.ok(Math.abs(rampValue(shape, 0)) < 1e-15, `${shape} must be 0 at t=0`);
    assert.ok(Math.abs(rampValue(shape, 1) - 1) < 1e-15, `${shape} must be 1 at t=1`);
    assert.equal(rampValue(shape, -0.5), rampValue(shape, 0), `${shape} must clamp below 0`);
    assert.equal(rampValue(shape, 1.5), rampValue(shape, 1), `${shape} must clamp above 1`);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = rampValue(shape, t);
      assert.ok(v >= prev - 1e-12, `${shape} is not monotone at t=${t}`);
      prev = v;
    }
  }
  // The gaussian's endpoint renormalization is the one that is easy to skip:
  // exp(-4.5) is 0.011, not 0, so an unnormalized ramp leaks about 1% of full
  // signal past the footprint edge.
  assert.ok(Math.abs(rampValue('gaussian', 0)) < 1e-15);
  assert.ok(Math.abs(rampValue('cosine', 0.5) - 0.5) < 1e-15);
  assert.ok(Math.abs(rampValue('smoothstep', 0.5) - 0.5) < 1e-15);
});

test('§B: weights normalize to one wherever anything contributes, and to zero elsewhere', () => {
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  let litSamples = 0;
  for (const p of fibonacciSphere(20_000)) {
    const w = blendWeights(p.latDeg, p.lonDeg, rig);
    const sum = w.reduce((a, b) => a + b, 0);
    const n = overlapMultiplicity(p.latDeg, p.lonDeg, rig);
    if (n === 0) {
      assert.ok(sum === 0, `unlit point had weight sum ${sum}`);
    } else {
      litSamples++;
      assert.ok(Math.abs(sum - 1) < 1e-12, `weight sum ${sum} at ${p.latDeg},${p.lonDeg}`);
    }
    for (const wi of w) assert.ok(wi >= 0 && wi <= 1, `weight out of range: ${wi}`);
  }
  assert.ok(litSamples > 10_000, 'expected most of the sphere to be lit');
});

test('§B: weights are symmetric across a seam and single-valued on a meridian', () => {
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));

  // Exactly on the seam between P1 (azimuth 0) and P2 (azimuth 90), the two
  // must split evenly by symmetry.
  const seam = blendWeights(0, 45, rig);
  assert.ok(Math.abs(seam[0] - 0.5) < 1e-9 && Math.abs(seam[1] - 0.5) < 1e-9, JSON.stringify(seam));
  assert.ok(seam[2] === 0 && seam[3] === 0, 'the far pair must contribute nothing');

  // On P1's own meridian at the equator only P1 contributes, and it gets
  // everything.
  const own = blendWeights(0, 0, rig);
  assert.ok(Math.abs(own[0] - 1) < 1e-12, JSON.stringify(own));
});

test('§B: rampGamma is applied to the WEIGHT, not to the signal', () => {
  // Applying it to the signal would be a per-projector gamma adjustment and the
  // weights would stop summing to one. Applying it to the weight changes the
  // crossfade shape but preserves the sum — which is the property to test.
  const base = nominalRig({ distanceM: D_MANUAL });
  const soft = prepareRig({ ...base, blend: { ...base.blend, rampGamma: 0.8 } });
  const hard = prepareRig({ ...base, blend: { ...base.blend, rampGamma: 2.5 } });

  // Pick a longitude inside the crossfade rather than at its midpoint, where
  // symmetry makes every gamma give 0.5.
  const lon = 12;
  const a = blendWeights(0, lon, soft);
  const b = blendWeights(0, lon, hard);
  assert.ok(Math.abs(a.reduce((x, y) => x + y, 0) - 1) < 1e-12);
  assert.ok(Math.abs(b.reduce((x, y) => x + y, 0) - 1) < 1e-12);
  assert.ok(
    Math.abs(a[1] - b[1]) > 1e-3,
    `rampGamma must change the crossfade shape: ${a[1]} vs ${b[1]}`,
  );
  // A larger exponent pushes weight toward the projector that is further inside
  // its own footprint — here P1, whose meridian lon=12 is nearer.
  assert.ok(b[0] > a[0], 'a harder ramp concentrates weight on the nearer projector');
});

test('the limb test really is dot(normal, lens - point) > 0', () => {
  // Spot-check the generalization §4.1 is written against, at points chosen to
  // straddle the boundary.
  const rig = prepareRig(nominalRig({ distanceM: D_MANUAL }));
  const proj = rig.projectors[0];
  const limbLatDeg = Math.acos(R / D_MANUAL) * (180 / Math.PI);

  for (const delta of [-0.5, -0.01, 0.01, 0.5]) {
    const point = latLonToWorld(limbLatDeg + delta, 0, R);
    const toLens = {
      x: proj.lens.x - point.x,
      y: proj.lens.y - point.y,
      z: proj.lens.z - point.z,
    };
    const facing = dot(point, toLens) > 0;
    assert.equal(
      isIlluminated(limbLatDeg + delta, 0, proj),
      facing,
      `at ${delta} deg from the limb the two tests disagreed`,
    );
    assert.equal(facing, delta < 0, 'inside the limb faces the lens, outside does not');
  }
});
