// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The live metrics panel.
 *
 * Two things are being defended here, and the first is not about arithmetic.
 *
 *  1. **The phase gate.** docs/ARCHITECTURE.md: photometric metrics rest on
 *     constants nobody has measured, so they are built, marked PROVISIONAL, and
 *     never optimized against. A panel that let one through unmarked would put a
 *     guess next to a measurement in the same typeface.
 *  2. **The panel reproduces the facts PARAMETERS.md says it must.** §4.2's
 *     multiplicity of 2, §4.3's 80.4/76.3 boundary and 69/59 usable limits,
 *     A-05's integrated polar area, A-10's unlit fraction below four projectors.
 *     If the harness disagreed with the bench about those, the window would be
 *     showing a different simulator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeMetricPanel, geometricMetrics, photometricMetrics } from '../src/metrics.ts';
import { buildWorld } from '../src/state.ts';
import { defaultState } from '../src/params.ts';
import type { HarnessState } from '../src/params.ts';

const DENSITY = 0.15;

function world(overrides: HarnessState = {}, pattern: 'graticule' | 'mid-gray' = 'mid-gray') {
  return buildWorld({ ...defaultState(), ...overrides }, pattern, {
    textureWidth: 256,
    textureHeight: 128,
    viewWidth: 32,
    viewHeight: 24,
  });
}

test('every photometric metric is PROVISIONAL, whatever the data says', () => {
  const variants: HarnessState[] = [{}, { gamma_B: 2.4 }, { L_black_R: 0.003333 }, { E_amb: 0.15 }];
  for (const overrides of variants) {
    const w = world(overrides);
    const metrics = photometricMetrics(w.rig, w.scene, DENSITY, w.shading);
    assert.ok(metrics.length >= 4, 'the photometric panel is empty');
    for (const m of metrics) {
      assert.equal(
        m.provisional,
        true,
        `${m.id} came back not provisional. docs/ARCHITECTURE.md's phase gate makes this a property of the ` +
          `PHASE, not of the run — every constant behind it is class ASSUME or MEAS.`,
      );
    }
  }
});

test('no geometric metric is marked provisional', () => {
  // The other half of the same claim: these depend on R (DOC), d_proj (SOLVE),
  // the raster (CFG) and the pose (SOLVE), and on the blend only as a DOMAIN.
  const w = world();
  for (const m of geometricMetrics(w.rig, w.scene, DENSITY)) {
    assert.equal(m.provisional, false, `${m.id} is marked provisional but rests on no ASSUME constant`);
  }
});

test('every metric carries its section and a note that explains the gate', () => {
  const w = world();
  const panel = computeMetricPanel(w.rig, w.scene, { densityScale: DENSITY, shading: w.shading });
  for (const m of [...panel.geometry, ...panel.photometry]) {
    assert.ok(m.section.length > 0, `${m.id} has no section`);
    assert.ok(m.note.length > 40, `${m.id} has no note`);
    assert.ok(Number.isFinite(m.value) || m.value !== m.value, `${m.id} produced ${m.value}`);
    if (m.gateMax === null) assert.equal(m.pass, null, `${m.id} has no gate but reports a verdict`);
  }
});

test('the panel reproduces PARAMETERS.md §4.2 and §4.3 on the nominal rig', () => {
  const w = world();
  const g = geometricMetrics(w.rig, w.scene, DENSITY);
  const value = (id: string): number => {
    const m = g.find((x) => x.id === id);
    assert.ok(m, `no metric ${id}`);
    return m.value;
  };

  // §4.2: N is 1 or 2 everywhere, never 3 or 4. Rev 1 of the spec said otherwise
  // and §4.2 exists to correct it.
  assert.equal(value('max_multiplicity'), 2);

  // §4.3: usable to ≈69° along a projector meridian, ≈59° in a seam direction.
  assert.ok(Math.abs(value('usable_meridian') - 69) < 1.5, `meridian ${value('usable_meridian')}`);
  assert.ok(Math.abs(value('usable_seam') - 59) < 1.5, `seam ${value('usable_seam')}`);

  // docs/AMENDMENTS.md A-05: the integrated unlit polar area is 0.89% at
  // d = 5.18 m, NOT the 1.4-2.8% §4.3 states — 1.4% is the seam-direction cap,
  // i.e. the strict upper bound, and 2.8% is that doubled.
  const polar = value('unlit_polar_north');
  assert.ok(polar > 0.007 && polar < 0.0141, `unlit polar area ${polar} is outside its own bounding caps`);
  assert.ok(Math.abs(polar - 0.00893) < 0.0005, `A-05 puts this at 0.893%; got ${(polar * 100).toFixed(3)}%`);

  // §7's hard gate: zero unlit inside the mask, on a four-projector rig.
  assert.equal(value('unlit_in_mask'), 0);
});

test('A-10: the unlit gate cannot be met below four projectors, and the panel says so', () => {
  for (const [count, atLeast] of [[3, 0.02], [2, 0.05]] as [number, number][]) {
    const w = world({ N_proj: count });
    const g = geometricMetrics(w.rig, w.scene, DENSITY);
    const m = g.find((x) => x.id === 'unlit_in_mask');
    assert.ok(m);
    assert.ok(
      m.value > atLeast,
      `with ${count} projectors the unlit fraction is ${m.value}; §2's "quadrants go dark" should make it large`,
    );
    assert.equal(m.pass, false, 'the gate is reported as passing on an install that cannot pass it');
  }
});

test('A-02: the two readings of bottommask are both reported, and they differ', () => {
  const w = world();
  const g = geometricMetrics(w.rig, w.scene, DENSITY);
  const primary = g.find((x) => x.id === 'unlit_in_mask');
  const other = g.find((x) => x.id === 'unlit_in_mask_other');
  assert.ok(primary && other);
  assert.equal(other.scored, false, 'the alternative reading must be reported, never scored');
  // On the nominal rig both are zero; the DOMAINS differ by a factor of about
  // three, which is the size of A-02's ambiguity and is what the harness shows.
  const colat = world({ mask_interp: 1 });
  const gc = geometricMetrics(colat.rig, colat.scene, DENSITY);
  const boundary = gc.find((x) => x.id === 'boundary_margin');
  const boundaryLat = g.find((x) => x.id === 'boundary_margin');
  assert.ok(boundary && boundaryLat);
  assert.notEqual(boundary.value, boundaryLat.value, 'switching the mask reading changed nothing');
});

test('A-15: the §7 seam gates barely move on §3.2’s artifact, and the band readings do', () => {
  // This is the finding A-15 records, reproduced live by the harness. The rig
  // carrying §3.2's worked divergence passes every scored §7 gate while the
  // unscored band reading moves by several ΔE.
  const flat = world({});
  const diverged = world({ gamma_B: 2.4 });
  const of = (w: ReturnType<typeof world>, id: string): number => {
    const m = photometricMetrics(w.rig, w.scene, DENSITY, w.shading).find((x) => x.id === id);
    assert.ok(m, `no metric ${id}`);
    return m.value;
  };

  const seamFlat = of(flat, 'seam_chroma');
  const seamDiv = of(diverged, 'seam_chroma');
  const bandFlat = of(flat, 'divergence_chroma');
  const bandDiv = of(diverged, 'divergence_chroma');

  assert.equal(bandFlat, 0, 'a channel-matched rig must show exactly zero divergence');
  assert.ok(bandDiv > 1, `§3.2's artifact moved the band reading only ${bandDiv} dE2000`);
  assert.ok(
    Math.abs(seamDiv - seamFlat) < 0.05,
    `the §7 seam-chromaticity gate moved by ${Math.abs(seamDiv - seamFlat)} — A-15 measured ~0.001, and the ` +
      `point of the entry is that the gate is nearly blind to the artifact rev 2 added it for`,
  );
  assert.ok(seamDiv < 1.0, 'the rig carrying §3.2’s artifact should still PASS the §7 gate — that is A-15');
});

test('the panel is cheap enough to run on a slider release', () => {
  const w = world();
  const panel = computeMetricPanel(w.rig, w.scene, { densityScale: DENSITY, shading: w.shading });
  assert.ok(panel.computeMs >= 0);
  assert.equal(panel.densityScale, DENSITY);
  // A budget, not a benchmark: this runs on a debounce in a browser, and a panel
  // that took a second would make the harness feel like the model is expensive.
  assert.ok(panel.computeMs < 4000, `the panel took ${panel.computeMs} ms`);
});

test('the geometric verdict excludes the readings that are not scored', () => {
  const w = world();
  const panel = computeMetricPanel(w.rig, w.scene, { densityScale: DENSITY, includePhotometry: false });
  const absolute = panel.geometry.find((m) => m.id === 'off_sphere_absolute');
  assert.ok(absolute);
  // A-01/A-03: on a 16:9 raster the absolute off-sphere gate can never pass, so
  // it is reported and excluded rather than allowed to fail every build.
  assert.equal(absolute.scored, false);
  assert.equal(absolute.pass, false);
  assert.equal(panel.geometryPass, true, 'an unscored reading decided the verdict');
});
