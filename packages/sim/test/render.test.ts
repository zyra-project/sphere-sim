// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Sampling, patterns, and the blend/transfer chain.
 *
 * The two worked examples in PARAMETERS.md — §4.5's "each must emit 0.5 linear,
 * encoded as 0.5^(1/gamma) = 0.730" and §3.2's 6% blue deficit — are the closest
 * thing the spec has to unit tests it wrote for itself. Reproducing both is a
 * strong check that the blend, the encode and the per-channel transfer are
 * composed in the right order, which is the single thing most likely to be
 * silently wrong in a photometric pipeline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cellSolidAngleWeight,
  createImage,
  fieldMap,
  flatField,
  gridAlignmentPattern,
  sampleEquirect,
  setPixel,
} from '../src/equirect.ts';
import { blendedSignal, defaultScene, renderProjectorView, renderRoomView, viewerAt } from '../src/render.ts';
import { emittedRadiance, emittedRadianceRgb, lambertianShading } from '../src/shading.ts';
import { coverageAndWeights, overlapMultiplicity } from '../src/coverage.ts';
import { latLonToWorld } from '../src/geometry.ts';
import { nominalRig } from '../src/scene.ts';
import { prepareRig } from '../src/optics.ts';
import { colorizeField, diverging, viridis } from '../src/png.ts';

test('equirect: longitude WRAPS and latitude CLAMPS', () => {
  // The asymmetry is not a shortcut. The texture is periodic in longitude, so
  // clamping there puts a seam down the prime meridian; it is not periodic in
  // latitude, so wrapping there folds the north pole onto the south.
  const img = createImage(4, 2);
  // Distinct value per texel so a wrap error is identifiable, not just visible.
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 4; x++) setPixel(img, x, y, { r: x + 1, g: y + 1, b: 0 });
  }

  // Texel centres: with width 4 the centres are at longitudes -135, -45, 45, 135.
  for (let x = 0; x < 4; x++) {
    const lon = -180 + (x + 0.5) * 90;
    const s = sampleEquirect(img, 45, lon);
    assert.ok(Math.abs(s.r - (x + 1)) < 1e-6, `texel ${x} at lon ${lon} sampled ${s.r}`);
  }

  // +180 and -180 are the same meridian, and the sample there blends the first
  // and last columns — which only happens if longitude wraps.
  const west = sampleEquirect(img, 45, -180);
  const east = sampleEquirect(img, 45, 180);
  assert.ok(Math.abs(west.r - east.r) < 1e-6, 'the antimeridian must be single-valued');
  assert.ok(Math.abs(west.r - 2.5) < 1e-6, `expected the mean of columns 3 and 0, got ${west.r}`);

  // Beyond the poles, clamp: latitude 100 must read as 90, not fold to 80.
  assert.deepEqual(sampleEquirect(img, 100, 0), sampleEquirect(img, 90, 0));
  assert.deepEqual(sampleEquirect(img, -100, 0), sampleEquirect(img, -90, 0));
  // Row 0 is the NORTH row.
  assert.ok(Math.abs(sampleEquirect(img, 90, -135).g - 1) < 1e-6, 'row 0 must be latitude +90');
  assert.ok(Math.abs(sampleEquirect(img, -90, -135).g - 2) < 1e-6);

  // Longitude 360 degrees away is the same sample.
  const a = sampleEquirect(img, 10, 37);
  const b = sampleEquirect(img, 10, 37 + 720);
  assert.ok(Math.abs(a.r - b.r) < 1e-12);
});

test('equirect: bilinear interpolation is exact at texel centres and linear between', () => {
  const img = createImage(8, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) setPixel(img, x, y, { r: x, g: 0, b: 0 });
  }
  // Halfway between the centres of columns 2 and 3.
  const lonMid = -180 + 3 * 45;
  assert.ok(Math.abs(sampleEquirect(img, 0, lonMid).r - 2.5) < 1e-6);
  const lonQuarter = -180 + 2.75 * 45;
  assert.ok(Math.abs(sampleEquirect(img, 0, lonQuarter).r - 2.25) < 1e-6);
});

test('fieldMap samples cell CENTRES, so the pole is never a whole row', () => {
  // A corner-sampled grid puts an entire row at exactly latitude +90, where
  // longitude is undefined and every projector gives the same answer — which
  // erases the four-lobed structure of PARAMETERS.md §4.3 from the top of every
  // map for purely parametric reasons.
  const rig = prepareRig(nominalRig());
  const lats: number[] = [];
  fieldMap(rig, 4, 6, (lat) => {
    lats.push(lat);
    return 0;
  });
  assert.ok(Math.max(...lats) < 90, 'no sample may land exactly on the pole');
  assert.ok(Math.min(...lats) > -90);
  assert.ok(Math.abs(Math.max(...lats) - 75) < 1e-12, 'first row centre of a 6-row grid');

  // The field really is evaluated everywhere.
  const f = fieldMap(rig, 16, 8, (lat, lon, r) => overlapMultiplicity(lat, lon, r));
  assert.equal(f.length, 128);
  assert.ok(f.some((v) => v === 2) && f.some((v) => v === 1));

  // Solid-angle weights: the poles must not be counted like the equator.
  assert.ok(Math.abs(cellSolidAngleWeight(0) - 1) < 1e-12);
  assert.ok(Math.abs(cellSolidAngleWeight(60) - 0.5) < 1e-12);
  assert.ok(cellSolidAngleWeight(89) < 0.02);
});

test('§4.5: two projectors in an overlap sum to unity, as the spec works it out', () => {
  // "For two projectors to sum to unity in the overlap, each must emit 0.5
  // linear, encoded as 0.5^(1/gamma)." At gamma 2.2 that encoded value is 0.730.
  const gamma = { r: 2.2, g: 2.2, b: 2.2 };
  const white = { r: 1, g: 1, b: 1 };
  const half = blendedSignal(white, 0.5, gamma);
  assert.ok(Math.abs(half.r - 0.7297) < 0.0005, `expected 0.730 encoded, got ${half.r}`);

  // Through the transfer of conventions.ts §P with the nominal black floor, each
  // projector emits just over 0.5 and the pair sums to just over 1.0 — the
  // excess being exactly the doubled black floor that §7's black-uplift gate
  // exists to bound.
  const perProjector = emittedRadiance(half.r, 2.2, 1 / 800, 1);
  const sum = 2 * perProjector;
  assert.ok(Math.abs(sum - 1) < 0.005, `overlap summed to ${sum}`);
  assert.ok(sum > 1, 'the black floor must make the overlap slightly BRIGHTER than unity');

  // Weight applied to the encoded signal instead of to the linear target would
  // give 0.5 * 0.730 = 0.365 encoded, 0.106 linear, 21% of the intended
  // brightness — a black band instead of an invisible seam.
  const wrong = 2 * emittedRadiance(0.5 * 0.7297, 2.2, 1 / 800, 1);
  assert.ok(wrong < 0.25, `the wrong order gives ${wrong}, which is the bug this pins`);
});

test('§3.2: a divergent blue gamma produces the 6% blue deficit the spec predicts', () => {
  // The rev 2 headline. "If that projector's blue channel runs gamma=2.4, blue
  // emits 0.730^2.4 = 0.469 per projector, summing to 0.938 against 1.000 in
  // red — a 6% blue deficit... The seam reads as a yellow band. No scalar gamma
  // can correct this."
  //
  // The compositor still encodes assuming 2.2 (that is the whole point: it does
  // not know), so the encode gamma and the transfer gamma differ.
  const encodeGamma = { r: 2.2, g: 2.2, b: 2.2 };
  const signal = blendedSignal({ r: 1, g: 1, b: 1 }, 0.5, encodeGamma);
  assert.ok(Math.abs(signal.b - 0.7297) < 0.0005);

  const transfer = {
    gamma: { r: 2.2, g: 2.2, b: 2.4 },
    // Zero the black floor so the 6% figure is not contaminated by the uplift;
    // the spec's arithmetic ignores it too.
    blackFloor: { r: 0, g: 0, b: 0 },
    gain: { r: 1, g: 1, b: 1 },
    whitePointK: 6500,
  };
  const emitted = emittedRadianceRgb(signal, transfer);
  assert.ok(Math.abs(emitted.b - 0.4695) < 0.001, `blue emitted ${emitted.b}, spec says 0.469`);
  assert.ok(Math.abs(emitted.r - 0.5) < 1e-9);

  const sumR = 2 * emitted.r;
  const sumB = 2 * emitted.b;
  assert.ok(Math.abs(sumR - 1) < 1e-9);
  assert.ok(Math.abs(sumB - 0.939) < 0.002, `blue summed to ${sumB}, spec says 0.938`);
  const deficit = 1 - sumB / sumR;
  assert.ok(
    Math.abs(deficit - 0.061) < 0.003,
    `blue deficit came out ${(deficit * 100).toFixed(1)}%, spec says about 6%`,
  );

  // And the point §3.2 is making: OUTSIDE the overlap, where one projector emits
  // full signal, there is no deficit at all. The error appears only at the seam,
  // which is why it reads as a band rather than an overall colour cast.
  const full = emittedRadianceRgb(blendedSignal({ r: 1, g: 1, b: 1 }, 1, encodeGamma), transfer);
  assert.ok(Math.abs(full.b - full.r) < 1e-9, 'no chromatic error away from the seam');
});

test('§P: the transfer curve is gain * ((1 - blackFloor) * V^gamma + blackFloor)', () => {
  // Black in, black floor out — the mechanism behind every overlap artifact in
  // dark content, which §10 ranks the second highest photometric risk.
  assert.ok(Math.abs(emittedRadiance(0, 2.2, 1 / 800, 1) - 1 / 800) < 1e-15);
  // White in, full output out, regardless of the floor.
  assert.ok(Math.abs(emittedRadiance(1, 2.2, 1 / 800, 1) - 1) < 1e-15);
  // Gain scales everything, including the floor.
  assert.ok(Math.abs(emittedRadiance(0, 2.2, 1 / 800, 0.5) - 0.5 / 800) < 1e-15);
  // Out-of-range signals clamp rather than producing NaN from a negative base.
  assert.ok(Number.isFinite(emittedRadiance(-0.5, 2.2, 0, 1)));
  assert.equal(emittedRadiance(2, 2.2, 0, 1), 1);
});

test('the Lambertian model applies incidence and inverse-square falloff', () => {
  const shading = lambertianShading();
  const transfer = {
    gamma: { r: 2.2, g: 2.2, b: 2.2 },
    blackFloor: { r: 0, g: 0, b: 0 },
    gain: { r: 1, g: 1, b: 1 },
    whitePointK: 6500,
  };
  const base = {
    point: { x: 0.8636, y: 0, z: 0 },
    normal: { x: 1, y: 0, z: 0 },
    viewDir: { x: 1, y: 0, z: 0 },
    reflectance: { r: 1, g: 1, b: 1 },
    ambient: { r: 0, g: 0, b: 0 },
  };
  const contribution = {
    projector: 0,
    signal: { r: 1, g: 1, b: 1 },
    weight: 1,
    incidenceCos: 1,
    distanceM: 4.3164,
    toLens: { x: 1, y: 0, z: 0 },
    transfer,
    referenceDistanceM: 4.3164,
  };

  // At the footprint centre — incidence 1, distance equal to the reference —
  // full output is exactly 1.0 by the definition in PARAMETERS.md's Radiometry
  // convention.
  const centre = shading.shade({ ...base, contributions: [contribution] });
  assert.ok(Math.abs(centre.r - 1) < 1e-12, `footprint centre must be 1.0, got ${centre.r}`);

  // Halve the incidence cosine, halve the result.
  const oblique = shading.shade({
    ...base,
    contributions: [{ ...contribution, incidenceCos: 0.5 }],
  });
  assert.ok(Math.abs(oblique.r - 0.5) < 1e-12);

  // Double the distance, quarter the result.
  const far = shading.shade({
    ...base,
    contributions: [{ ...contribution, distanceM: 2 * 4.3164 }],
  });
  assert.ok(Math.abs(far.r - 0.25) < 1e-12);

  // A point facing away receives nothing.
  const behind = shading.shade({
    ...base,
    contributions: [{ ...contribution, incidenceCos: -0.3 }],
  });
  assert.equal(behind.r, 0);

  // Ambient is irradiance, so reflectance multiplies it too.
  const ambient = shading.shade({
    ...base,
    reflectance: { r: 0.9, g: 0.9, b: 0.88 },
    ambient: { r: 0.04, g: 0.04, b: 0.04 },
    contributions: [],
  });
  assert.ok(Math.abs(ambient.r - 0.036) < 1e-12);
  assert.ok(Math.abs(ambient.b - 0.04 * 0.88) < 1e-12, 'the blue reflectance of §1 is 0.88');
});

test('the seam is continuous: no luminance step where the blend hands over', () => {
  // §7's seam-luminance gate is 2% of the local mean. With matched gammas the
  // blend must be continuous to far better than that — a discontinuity here
  // would mean the weights or the encode are composed wrongly, not that the
  // display is imperfect.
  const rig = prepareRig(nominalRig());
  const encodeGamma = { r: 2.2, g: 2.2, b: 2.2 };
  const transfer = rig.projectors[0].cal.transfer;

  // Total emitted radiance along the equator, ignoring geometry so the test
  // isolates the blend chain. Every projector whose light REACHES the point
  // counts, including one carrying blend weight zero — it is still emitting its
  // black floor.
  const totalAt = (lonDeg: number): number => {
    const point = latLonToWorld(0, lonDeg, rig.radiusM);
    const { weights, lit } = coverageAndWeights(point, rig);
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      if (!lit[i]) continue;
      sum += emittedRadianceRgb(
        blendedSignal({ r: 1, g: 1, b: 1 }, weights[i], encodeGamma),
        transfer,
      ).r;
    }
    return sum;
  };

  // Inside a two-projector overlap the sum must be smooth to far better than
  // the gate: the crossfade is the thing under test.
  let worstInterior = 0;
  let prevInterior = totalAt(20);
  for (let lon = 20; lon <= 70; lon += 0.25) {
    const v = totalAt(lon);
    assert.equal(overlapMultiplicity(0, lon, rig), 2, `lon ${lon} should be a two-way overlap`);
    worstInterior = Math.max(worstInterior, Math.abs(v - prevInterior));
    prevInterior = v;
    // The overlap uplift has a closed form worth pinning. Summing §P's transfer
    // over n projectors whose weights total 1:
    //
    //     sum = (1 - b) * SUM(w_i) + n*b = 1 + (n - 1) * b
    //
    // So the uplift is (n-1) black floors, not n — the (1 - b) factor scales the
    // signal down by exactly the one floor that a single projector already
    // carries. At n = 2 and b = 1/800 that is 1.00125, and PARAMETERS.md §7's
    // black-uplift gate of 1.20 is a ratio against the single-projector case in
    // DARK content, where the same arithmetic gives 2b/b = 2.0.
    assert.ok(
      Math.abs(v - (1 + 1 / 800)) < 1e-9,
      `total radiance ${v} at lon ${lon}, expected 1 + (n-1)*blackFloor`,
    );
  }
  assert.ok(worstInterior < 1e-4, `worst step inside the overlap ${worstInterior}`);

  // Across the whole equator the only discontinuity is where a projector's cone
  // begins or ends, and it is exactly one black floor — the light genuinely
  // starts there. 1/800 is 0.125% of the local mean, comfortably inside §7's 2%
  // seam-luminance gate, and it is a real feature of the hardware rather than a
  // modelling artifact.
  let worstStep = 0;
  let prev = totalAt(-89);
  for (let lon = -89; lon <= 89; lon += 0.25) {
    const v = totalAt(lon);
    worstStep = Math.max(worstStep, Math.abs(v - prev));
    prev = v;
    assert.ok(Math.abs(v - 1) < 0.01, `total radiance ${v} at lon ${lon}`);
  }
  assert.ok(
    Math.abs(worstStep - 1 / 800) < 1e-6,
    `the only step should be one black floor, got ${worstStep}`,
  );
  assert.ok(worstStep < 0.02, 'and it must clear §7s 2% seam-luminance gate');
});

test('the grid alignment pattern draws a graticule at the configured spacing', () => {
  const img = gridAlignmentPattern({
    width: 720,
    height: 360,
    spacingDeg: 30,
    lineWidthDeg: 1,
    emphasizeAxes: false,
  });
  assert.equal(img.width, 720);

  // On a parallel of the graticule the row should be almost entirely line; two
  // degrees away it should be almost entirely background except where meridians
  // cross.
  const rowAt = (latDeg: number): number => {
    const y = Math.round(((90 - latDeg) / 180) * 360 - 0.5);
    let sum = 0;
    for (let x = 0; x < 720; x++) sum += img.data[3 * (y * 720 + x)];
    return sum / 720;
  };
  assert.ok(rowAt(30) > 0.9, `latitude 30 should be a graticule line, got ${rowAt(30)}`);
  assert.ok(rowAt(0) > 0.9, 'the equator is a multiple of 30');
  assert.ok(rowAt(15) < 0.15, `latitude 15 should be mostly background, got ${rowAt(15)}`);

  // Meridians converge but do not fill in: the line width is angular along the
  // parallel, so a row near the pole is not a solid bar.
  assert.ok(rowAt(85) < 0.6, `latitude 85 filled in at ${rowAt(85)} — meridians are fanning out`);

  // The per-projector tint option colours the four quadrants differently.
  const tinted = gridAlignmentPattern({
    width: 360,
    height: 180,
    spacingDeg: 30,
    // With 360 columns the pixel centres sit at ...-0.5, +0.5, so no centre lands
    // exactly on a meridian. A 3-degree line is wide enough that the nearest
    // column is unambiguously on it.
    lineWidthDeg: 3,
    quadrantTint: [
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
      { r: 1, g: 1, b: 0 },
    ],
  });
  // Sample the equator on P1's meridian (lon 0) and P2's (lon 90).
  const at = (lonDeg: number): number[] => {
    const x = Math.round(((lonDeg + 180) / 360) * 360 - 0.5);
    const y = 90;
    const i = 3 * (y * 360 + x);
    return [tinted.data[i], tinted.data[i + 1], tinted.data[i + 2]];
  };
  assert.ok(at(0)[0] > 0.5 && at(0)[1] < 0.01, `lon 0 should be red-tinted, got ${at(0)}`);
  assert.ok(at(90)[1] > 0.5 && at(90)[0] < 0.01, `lon 90 should be green-tinted, got ${at(90)}`);
});

test('a projector view is masked to the sphere silhouette', () => {
  // The Red Ball procedure constrains each projector's content to the sphere's
  // silhouette from its own position. That is what makes the off-sphere flux of
  // PARAMETERS.md §7 a geometric floor rather than a free parameter.
  const rig = prepareRig(nominalRig({ resX: 192, resY: 108 }));
  const scene = defaultScene(flatField(64, 32, { r: 1, g: 1, b: 1 }));
  const view = renderProjectorView(rig, 0, scene, { samplesPerPixel: 1, seed: 0 });

  let lit = 0;
  for (let i = 0; i < view.width * view.height; i++) if (view.data[3 * i] > 0) lit++;
  const offSphere = 1 - lit / (view.width * view.height);

  // With the silhouette inscribed in the minor dimension (A-01) and a 2% margin,
  // the lit fraction is the circle's area over the raster's: (pi/4)*(9/16),
  // shrunk slightly by the margin. The off-sphere fraction lands just under the
  // 55.8% analytic floor for a 16:9 raster.
  assert.ok(offSphere > 0.5 && offSphere < 0.6, `off-sphere fraction ${offSphere}`);

  // The corners are always dark, the centre never is.
  assert.equal(view.data[0], 0, 'top-left corner must be off-sphere');
  const centre = 3 * (Math.floor(view.height / 2) * view.width + Math.floor(view.width / 2));
  assert.ok(view.data[centre] > 0, 'the raster centre must be on the sphere');
});

test('the room view puts a floor under the sphere and light on it', () => {
  const rigCal = nominalRig({ resX: 96, resY: 54 });
  const rig = prepareRig(rigCal);
  const scene = defaultScene(flatField(32, 16, { r: 1, g: 1, b: 1 }));
    // Far enough back and wide enough that the bottom of the frame clears the
  // sphere's silhouette and looks at the floor. At 2.5 m with a 50-degree lens
  // the sphere fills the frame edge to edge and no floor is visible at all.
  const camera = viewerAt(0, 3.0, 1.6, rigCal.sphere.centerHeightM, 64, 48, 70);

  const withFloor = renderRoomView(rig, scene, camera, { samplesPerPixel: 1, seed: 0 });
  const without = renderRoomView(rig, scene, camera, {
    samplesPerPixel: 1,
    seed: 0,
    drawFloor: false,
  });

  const mean = (img: { data: Float32Array }): number => {
    let s = 0;
    for (let i = 0; i < img.data.length; i++) s += img.data[i];
    return s / img.data.length;
  };
  assert.ok(mean(withFloor) > mean(without), 'the floor must add light to the frame');

  // The bottom row looks down at the floor, which receives ambient plus each
  // projector's black-floor leak — never zero, never as bright as the sphere.
  const bottom = 3 * (47 * 64 + 32);
  assert.ok(withFloor.data[bottom] > 0, 'the floor must not be black');
  assert.equal(without.data[bottom], 0, 'with the floor off, the same ray is background');
});

test('colormaps are monotone in lightness and cover their range', () => {
  // A field map is read by eye, and a non-monotone colormap invents boundaries
  // the data does not have — which for a coverage map means inventing exactly
  // the structure PARAMETERS.md §4.2 exists to rule out.
  const luma = (c: { r: number; g: number; b: number }): number =>
    0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const l = luma(viridis(t));
    assert.ok(l > prev - 0.01, `viridis lightness dipped at t=${t}`);
    prev = l;
  }
  assert.ok(luma(viridis(0)) < 0.15 && luma(viridis(1)) > 0.8);

  // The diverging map is light in the middle and dark at both ends.
  assert.ok(luma(diverging(0.5)) > luma(diverging(0)));
  assert.ok(luma(diverging(0.5)) > luma(diverging(1)));
  // ...and its ends are opposite in hue.
  assert.ok(diverging(0).b > diverging(0).r, 'the low end is blue');
  assert.ok(diverging(1).r > diverging(1).b, 'the high end is red');

  // Out-of-range inputs clamp instead of extrapolating into nonsense.
  assert.deepEqual(viridis(-1), viridis(0));
  assert.deepEqual(viridis(2), viridis(1));

  const field = new Float32Array([0, 0.5, 1, 0.25]);
  const img = colorizeField(field, 2, 2, 0, 1);
  assert.equal(img.width, 2);
  for (const v of img.data) assert.ok(v >= 0 && v <= 1 && Number.isFinite(v));
});
