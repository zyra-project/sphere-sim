// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The two `ShadingModel` implementations, and the interface contract that lets
 * `render.ts` take either without an edit.
 *
 * The load-bearing assertion is the first one: `fullShading` at `ρ_spec = 0` must
 * reproduce `lambertianShading` EXACTLY, bit for bit. PARAMETERS.md §1 says of
 * `ρ_spec`, "Set to 0 to test sensitivity", and a sensitivity test is only a
 * sensitivity test if the zero case is the old model rather than the old model plus
 * whatever drifted while the new one was being written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectorContribution, ShadeInput } from '../src/shading.ts';
import { fullShading, lambertianShading } from '../src/shading.ts';
import { nominalTransfer } from '../src/photometry.ts';
import { defaultScene, renderRoomView, viewerAt } from '../src/render.ts';
import { flatField } from '../src/equirect.ts';
import { nominalRig } from '../src/scene.ts';
import { prepareRig } from '../src/optics.ts';
import { normalize } from '../src/vec.ts';

const TRANSFER = nominalTransfer();
const RHO = { r: 0.9, g: 0.9, b: 0.88 };

function contribution(overrides: Partial<ProjectorContribution> = {}): ProjectorContribution {
  return {
    projector: 0,
    signal: { r: 1, g: 1, b: 1 },
    weight: 1,
    incidenceCos: 1,
    distanceM: 4.3164,
    toLens: { x: 1, y: 0, z: 0 },
    transfer: TRANSFER,
    referenceDistanceM: 4.3164,
    ...overrides,
  };
}

function input(overrides: Partial<ShadeInput> = {}): ShadeInput {
  return {
    point: { x: 0.8636, y: 0, z: 0 },
    normal: { x: 1, y: 0, z: 0 },
    viewDir: { x: 1, y: 0, z: 0 },
    contributions: [contribution()],
    reflectance: RHO,
    ambient: { r: 0.04, g: 0.04, b: 0.04 },
    ...overrides,
  };
}

test('full-v1 at rho_spec = 0 is lambertian-v1, bit for bit', () => {
  const lambert = lambertianShading();
  const full = fullShading({ weight: 0 });

  const cases: ShadeInput[] = [
    input(),
    input({ contributions: [] }),
    input({ contributions: [contribution({ incidenceCos: 0.31 })] }),
    input({ contributions: [contribution({ incidenceCos: -0.2 })] }),
    input({ contributions: [contribution({ distanceM: 5.9 })] }),
    input({ contributions: [contribution({ signal: { r: 0, g: 0, b: 0 } })] }),
    input({
      contributions: [
        contribution({ incidenceCos: 0.6, toLens: normalize({ x: 1, y: 0.4, z: 0.2 }) }),
        contribution({ projector: 1, incidenceCos: 0.55, toLens: normalize({ x: 1, y: -0.4, z: 0.1 }) }),
      ],
    }),
    input({ viewDir: normalize({ x: 1, y: 0.7, z: -0.3 }) }),
    input({ ambient: { r: 0.0566, g: 0.0369, b: 0.0213 } }),
  ];

  for (const c of cases) {
    const a = lambert.shade(c);
    const b = full.shade(c);
    assert.equal(b.r, a.r, `red differs: ${b.r} vs ${a.r}`);
    assert.equal(b.g, a.g);
    assert.equal(b.b, a.b);
  }
  assert.equal(fullShading({ weight: 0 }).name, 'full-v1(rho_spec=0,alpha_spec=0.4)');
});

test('the GGX lobe peaks at rho_spec / (4 alpha^2) where lens, normal and eye line up', () => {
  // At n = l = v the half vector is the normal, so D = 1/(pi*alpha^2), both Smith
  // terms are 1, and Schlick gives F = F0 = rho_spec. The Cook-Torrance denominator
  // is 4, and the model's pi (see the module note on units) cancels D's. So the
  // specular term is exactly rho_spec / (4*alpha^2) — 4.6875% at the nominals, which
  // is an independent closed form rather than a restatement of the code.
  const weight = 0.03;
  const alpha = 0.4;
  const expectedSpec = weight / (4 * alpha * alpha);
  assert.ok(Math.abs(expectedSpec - 0.046875) < 1e-15);

  const headOn = input({ reflectance: { r: 1, g: 1, b: 1 }, ambient: { r: 0, g: 0, b: 0 } });
  const got = fullShading({ weight, alpha }).shade(headOn).r;
  // Diffuse is (1 - rho_spec) * rho = 0.97, plus the lobe.
  assert.ok(Math.abs(got - (0.97 + expectedSpec)) < 1e-12, `got ${got}`);

  // A tighter lobe is a taller lobe, exactly as 1/alpha^2.
  const tight = fullShading({ weight, alpha: 0.2 }).shade(headOn).r;
  assert.ok(Math.abs(tight - (0.97 + weight / (4 * 0.04))) < 1e-12);
  assert.ok(tight > got, 'lower roughness must concentrate the same energy into a taller peak');
});

test('the specular lobe is a hot spot: bright toward the lens, dark away from it', () => {
  const shading = fullShading();
  const noAmbient = { r: 0, g: 0, b: 0 };

  // Head-on, lens on the normal: the peak.
  const peak = shading.shade(
    input({ ambient: noAmbient, reflectance: { r: 1, g: 1, b: 1 } }),
  ).r;
  // Same incidence and distance, but the lens swung 60 degrees off the view
  // direction: the lobe has moved away and only the reduced diffuse term is left.
  const off = shading.shade(
    input({
      ambient: noAmbient,
      reflectance: { r: 1, g: 1, b: 1 },
      viewDir: normalize({ x: 0.5, y: 0.866, z: 0 }),
    }),
  ).r;
  assert.ok(peak > off, 'the hot spot must be toward the lens');
  assert.ok(peak / off > 1.02, `hot spot is only ${((peak / off - 1) * 100).toFixed(2)}% brighter`);

  // §1 calls the lobe "broad, dim". Against the diffuse term it is a few percent,
  // not a highlight — the same order as §7's 2% seam gate, which is why it belongs
  // in the model at all.
  const lambert = lambertianShading().shade(
    input({ ambient: noAmbient, reflectance: { r: 1, g: 1, b: 1 } }),
  ).r;
  assert.ok(Math.abs(peak / lambert - 1) < 0.05, `peak is ${(peak / lambert - 1) * 100}% over diffuse`);

  // A viewer behind the surface sees no lobe at all rather than a negative one.
  const behind = shading.shade(
    input({ ambient: noAmbient, viewDir: { x: -1, y: 0, z: 0 } }),
  );
  assert.ok(Number.isFinite(behind.r) && behind.r >= 0);
});

test('the lobe is achromatic, so the hot spot DESATURATES rather than tinting', () => {
  // PARAMETERS.md §1 gives one rho_spec, not three. Reading it as one per channel
  // would invent a chromatic term the spec does not have — and §7 gates chromaticity
  // at dE2000 1.0, so an invented chromatic term would go straight into a verdict.
  const noAmbient = { r: 0, g: 0, b: 0 };
  const lambert = lambertianShading().shade(input({ ambient: noAmbient }));
  const full = fullShading().shade(input({ ambient: noAmbient }));

  const lambertRatio = lambert.b / lambert.r;
  const fullRatio = full.b / full.r;
  assert.ok(Math.abs(lambertRatio - 0.88 / 0.9) < 1e-12, 'diffuse carries the paint colour');
  assert.ok(fullRatio > lambertRatio, 'an achromatic lobe must pull b/r toward 1');
  assert.ok(fullRatio < 1, 'and not past it');
});

test('ambient reflects at the surface total albedo: (1 - rho_spec) * rho + rho_spec', () => {
  // §5 models ambient as a uniform hemisphere. A uniform environment reflects off
  // any BRDF at that BRDF's albedo, so the two lobes contribute their weights
  // directly and the roughness drops out entirely.
  const weight = 0.03;
  const ambientOnly = input({ contributions: [], ambient: { r: 0.04, g: 0.04, b: 0.04 } });
  for (const alpha of [0.2, 0.4, 0.7]) {
    const got = fullShading({ weight, alpha }).shade(ambientOnly);
    assert.ok(Math.abs(got.r - 0.04 * ((1 - weight) * 0.9 + weight)) < 1e-15, `alpha ${alpha}`);
    assert.ok(Math.abs(got.b - 0.04 * ((1 - weight) * 0.88 + weight)) < 1e-15);
  }
  // At rho_spec = 0 this is the lambertian answer, 0.04 * 0.9.
  const plain = fullShading({ weight: 0 }).shade(ambientOnly);
  assert.ok(Math.abs(plain.r - 0.036) < 1e-15);
});

test('render.ts takes the full model with no edit, and the two renders differ', () => {
  // The whole reason `ShadingModel` exists. If this needed a change in render.ts,
  // the interface would not be doing its job.
  const rigCal = nominalRig({ resX: 96, resY: 54 });
  const rig = prepareRig(rigCal);
  const scene = defaultScene(flatField(16, 8, { r: 0.5, g: 0.5, b: 0.5 }));
  const camera = viewerAt(0, 3.0, 1.6, rigCal.sphere.centerHeightM, 48, 36, 70);

  const lambert = renderRoomView(rig, scene, camera, {
    samplesPerPixel: 1,
    seed: 0,
    shading: lambertianShading(),
  });
  const full = renderRoomView(rig, scene, camera, {
    samplesPerPixel: 1,
    seed: 0,
    shading: fullShading(),
  });
  const zeroSpec = renderRoomView(rig, scene, camera, {
    samplesPerPixel: 1,
    seed: 0,
    shading: fullShading({ weight: 0 }),
  });

  assert.equal(lambert.width, full.width);
  let differing = 0;
  let identical = 0;
  for (let i = 0; i < lambert.data.length; i++) {
    if (lambert.data[i] !== full.data[i]) differing++;
    if (lambert.data[i] === zeroSpec.data[i]) identical++;
  }
  assert.ok(differing > 100, `the specular lobe must change the image; ${differing} samples differ`);
  assert.equal(identical, lambert.data.length, 'and rho_spec = 0 must change nothing at all');

  // Determinism survives the swap: same seed, same bytes.
  const again = renderRoomView(rig, scene, camera, {
    samplesPerPixel: 1,
    seed: 0,
    shading: fullShading(),
  });
  for (let i = 0; i < full.data.length; i++) assert.equal(again.data[i], full.data[i]);
});
