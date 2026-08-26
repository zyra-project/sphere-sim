// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * `makeFieldSampler` — the read-only primitive the experiments measure the §7 field
 * with.
 *
 * Two things need pinning and neither is obvious from the type. First, that the
 * sampler agrees with a hand-worked closed form of conventions.ts §P and §4.1 at a
 * point where every geometric factor is exactly 1 — otherwise an experiment built on
 * it would be measuring the sampler. Second, that `weightSum` is exactly 1 wherever
 * the content calibration equals the physical one, because Experiment 2 reads
 * `weightSum - 1` as the misregistration artifact and a baseline that drifted would
 * become an artifact that is not there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFieldSampler } from '../src/metrics/photometric.ts';
import { nominalRig } from '../src/scene.ts';
import { defaultScene } from '../src/render.ts';
import { flatField } from '../src/equirect.ts';
import { tintedAmbient } from '../src/color.ts';
import { lambertianShading } from '../src/shading.ts';
import { latLonToWorld } from '../src/geometry.ts';
import { equalAreaLattice } from '../src/metrics/sampling.ts';

const GRAY = flatField(8, 4, { r: 0.5, g: 0.5, b: 0.5 });

function scene(): ReturnType<typeof defaultScene> {
  return defaultScene(GRAY, { ambient: tintedAmbient(0.04, 4000) });
}

test('at a sub-projector point the sampler reproduces §P and §4.1 in closed form', () => {
  const rig = nominalRig();
  const s = scene();
  const sample = makeFieldSampler(rig, s, { shading: lambertianShading(), level: 0.5 });

  // Projector P1 sits at azimuth 0, so (0 N, 0 E) is its sub-projector point: the
  // centre of its own footprint, where PARAMETERS.md's Radiometry convention defines
  // 1.0. cos(incidence) = 1 and the distance is exactly d - R, so the inverse-square
  // factor is 1 too, and nothing is left but the transfer curve and reflectance.
  const f = sample(latLonToWorld(0, 0, rig.sphere.radiusM));
  assert.equal(f.contributors, 1, 'only P1 reaches its own sub-projector point');
  assert.equal(f.mask, 1);
  assert.ok(Math.abs(f.weightSum - 1) < 1e-12, `weightSum ${f.weightSum}`);
  assert.ok(Math.abs(f.bestIncidenceCos - 1) < 1e-9);
  assert.ok(Math.abs(f.incidenceCosWeighted - 1) < 1e-9);

  const transfer = rig.projectors[0].transfer;
  const encoded = Math.pow(0.5, 1 / 2.2);
  const emitted = (1 - transfer.blackFloor.r) * Math.pow(encoded, transfer.gamma.r) + transfer.blackFloor.r;
  const expectedR = (emitted + s.ambient.r) * s.reflectance.r;
  assert.ok(
    Math.abs(f.rgb.r - expectedR) < 1e-12,
    `red ${f.rgb.r} against the closed form ${expectedR}`,
  );
});

test('weightSum equals the mask everywhere the rig is its own content calibration', () => {
  for (const widthDeg of [5, 20, 71]) {
    const rig = nominalRig({ blend: { widthDeg } });
    const sample = makeFieldSampler(rig, scene(), {});
    let checked = 0;
    let worst = 0;
    for (const p of equalAreaLattice(600)) {
      const f = sample(latLonToWorld(p.latDeg, p.lonDeg, rig.sphere.radiusM));
      if (f.mask <= 0 || f.contributors < 1) continue;
      // A point can be reached by a projector carrying zero blend weight — that is
      // what the outer edge of a ramp means, and it still emits its black floor —
      // so the invariant is on points the blend actually serves.
      if (f.weightSum <= 0) continue;
      checked++;
      // conventions.ts §B normalizes the weights to sum to one and the polar mask
      // then scales all of them, so the sum is the mask rather than 1 inside the
      // feather. Experiment 2 reads the departure from this as its artifact.
      worst = Math.max(worst, Math.abs(f.weightSum - f.mask));
    }
    assert.ok(checked > 200, `only ${checked} usable samples at width ${widthDeg}`);
    assert.ok(worst < 1e-9, `weightSum departs from the mask by ${worst} at width ${widthDeg}`);
  }
});

test('delivered-light-weighted incidence never exceeds the best available', () => {
  const rig = nominalRig();
  const sample = makeFieldSampler(rig, scene(), {});
  let seenBelow = 0;
  for (const p of equalAreaLattice(400)) {
    const f = sample(latLonToWorld(p.latDeg, p.lonDeg, rig.sphere.radiusM));
    if (f.mask <= 0 || f.contributors < 1 || !Number.isFinite(f.incidenceCosWeighted)) continue;
    assert.ok(
      f.incidenceCosWeighted <= f.bestIncidenceCos + 1e-12,
      `weighted ${f.incidenceCosWeighted} above best ${f.bestIncidenceCos}`,
    );
    if (f.incidenceCosWeighted < f.bestIncidenceCos - 1e-6) seenBelow++;
  }
  // In a blend region the two differ, which is the whole reason the second exists.
  assert.ok(seenBelow > 0, 'the two incidence measures never differed anywhere');
});

test('the content calibration decides the weights, the physical one decides the optics', () => {
  const content = nominalRig();
  const physical = nominalRig({ distanceM: 5.4 });
  const s = scene();
  // Sampled in the RAMP BAND, not at the hand-over. At the hand-over both projectors
  // sit on the clamped plateau of a 20-degree ramp, both normalized weights are 0.5
  // under either calibration, and the two renders agree exactly — which is the whole
  // reason Experiment 2 cannot use §7's estimator, and would make this assertion pass
  // for the wrong reason if it were written at longitude 45.
  const point = latLonToWorld(0, 20, content.sphere.radiusM);
  const withContent = makeFieldSampler(physical, s, { contentRig: content })(point);
  const selfConsistent = makeFieldSampler(physical, s, {})(point);
  assert.ok(Math.abs(selfConsistent.weightSum - 1) < 1e-12);
  // Moving the lenses without telling the compositor must change SOMETHING, or the
  // two-calibration structure the experiments rely on is not wired up.
  assert.notEqual(withContent.luminance, selfConsistent.luminance);
  assert.ok(
    Math.abs(withContent.weightSum - 1) > 1e-6,
    'a disagreeing content calibration must break the sum-to-one invariant',
  );
});
