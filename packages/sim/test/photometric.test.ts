// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The four photometric gates of PARAMETERS.md §7, and the estimator underneath them.
 *
 * The first two tests are the ones that matter. A seam metric is only as good as its
 * ability to tell a real step from the incidence falloff it sits on, so the
 * estimator is checked against a synthetic field with a KNOWN smooth trend and a
 * KNOWN injected step — and against the same field with no step, where it must
 * report nothing. Everything after that is the metric set behaving on real rigs.
 *
 * Every number this file asserts is PROVISIONAL in the sense docs/ARCHITECTURE.md's
 * phase gate means: the tests pin that the model computes what it says it computes,
 * not that any of the constants underneath it are right. Nothing here has been
 * adjusted to make a gate pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STEP,
  computePhotometricMetrics,
  estimateStep,
  evalTrend,
  fitTrend,
} from '../src/metrics/photometric.ts';
import type { TrendSample } from '../src/metrics/photometric.ts';
import { injectMisalignment, nominalRig } from '../src/scene.ts';
import { defaultScene } from '../src/render.ts';
import { flatField } from '../src/equirect.ts';
import { tintedAmbient } from '../src/color.ts';
import { nominalTransfer } from '../src/photometry.ts';
import { lambertianShading } from '../src/shading.ts';
import { GATES } from '../../calibration/src/parameters.ts';

/**
 * The incidence falloff of PARAMETERS.md §4.1 in closed form, as a function of arc
 * distance from a seam at 45 degrees from each of two projectors.
 *
 * A deliberately NON-polynomial smooth trend, because a polynomial trend would let
 * a polynomial estimator be exactly right for the wrong reason. This is the shape
 * the real field has and it is what the estimator has to see through.
 */
function falloffField(s: number): number {
  const d = 5.18;
  const r = 0.8636;
  const theta = ((45 + s) * Math.PI) / 180;
  const cosTheta = Math.cos(theta);
  const dist = Math.sqrt(d * d - 2 * d * r * cosTheta + r * r);
  const incidence = (d * cosTheta - r) / dist;
  const ref = d - r;
  return incidence * ((ref * ref) / (dist * dist));
}

function syntheticTrack(step: number, spacingDeg = 0.25, halfWidth = 8): TrendSample[] {
  const out: TrendSample[] = [];
  for (let s = -halfWidth; s <= halfWidth + 1e-9; s += spacingDeg) {
    out.push({ s, value: falloffField(s) + (s >= 0 ? step : 0) });
  }
  return out;
}

test('the step estimator recovers a KNOWN injected step through a non-polynomial trend', () => {
  // The trend alone spans about 49% of the local level across this 16-degree
  // window — twenty-four times §7's gate — so a max-minus-min estimator would
  // report the incidence falloff and call it a seam.
  const clean = syntheticTrack(0);
  const spread = Math.max(...clean.map((x) => x.value)) - Math.min(...clean.map((x) => x.value));
  const level = falloffField(0);
  assert.ok(spread / level > 0.4, `the trend alone spans ${((spread / level) * 100).toFixed(1)}%`);

  // With no step, the estimator must find nothing. What it finds instead is its own
  // bias — the residual of a cubic against a non-polynomial function — and that
  // number is the floor under every seam measurement in the project.
  const nullResult = estimateStep(clean);
  assert.ok(nullResult !== null);
  assert.ok(
    nullResult.fraction < 2e-4,
    `estimator bias on a clean field is ${nullResult.fraction.toExponential(2)}, which must be far ` +
      `inside §7's 0.02 gate`,
  );
  assert.ok(Math.abs(nullResult.localMean - level) / level < 1e-4, 'and the local mean must be right');

  // Now inject steps spanning four orders of magnitude and require each one back.
  // The error budget is a relative part-per-thousand plus the estimator's own
  // absolute bias, because the bias does not shrink when the step does — and being
  // explicit about that is the difference between a tolerance and a fudge.
  const biasFloor = nullResult.step;
  for (const injected of [0.5, 0.05, 0.005, 0.0005]) {
    const result = estimateStep(syntheticTrack(injected));
    assert.ok(result !== null);
    const absoluteError = Math.abs(result.step - injected);
    assert.ok(
      absoluteError <= 1e-3 * injected + 2 * biasFloor,
      `injected ${injected}, recovered ${result.step} (off by ${absoluteError.toExponential(2)}, ` +
        `budget ${(1e-3 * injected + 2 * biasFloor).toExponential(2)})`,
    );
    // And the fraction is the step over the local mean, which is what §7 gates.
    assert.ok(Math.abs(result.stepFraction - result.step / result.localMean) < 1e-12);
  }

  // A subtlety worth pinning rather than discovering later: §7's gate is "2% of
  // LOCAL MEAN", and the local mean is the mean of the two sides, so a step of
  // 0.02*level over a field at `level` reads as 0.02/(1 + 0.01) = 0.019802, not
  // 0.02. The definition is the spec's; what matters is that the code implements
  // that one and not the other, because at the gate they differ by 1%.
  const atGate = estimateStep(syntheticTrack(0.02 * level));
  assert.ok(atGate !== null);
  assert.ok(
    Math.abs(atGate.stepFraction - 0.02 / 1.01) < 1e-5,
    `at-gate step read ${atGate.stepFraction}, expected 0.02/1.01`,
  );
  assert.ok(Math.abs(atGate.localMean - level * 1.01) / level < 1e-4);
});

test('the estimator is not fooled by the trend, and says so when it cannot fit', () => {
  // A pure trend with no step at every offset along it: the answer is always ~zero,
  // which is the property that makes the metric a seam metric rather than a
  // brightness-variation metric.
  for (const centre of [-20, -10, 0, 10, 20]) {
    const samples: TrendSample[] = [];
    for (let s = -8; s <= 8 + 1e-9; s += 0.25) samples.push({ s, value: falloffField(s + centre) });
    const result = estimateStep(samples);
    assert.ok(result !== null);
    assert.ok(result.fraction < 1e-3, `offset ${centre} reported ${result.fraction}`);
  }

  // Too few samples on one side is null, not zero. A metric that silently reports a
  // clean seam when it could not measure one is the worst available failure mode.
  assert.equal(estimateStep([{ s: -3, value: 1 }, { s: 3, value: 1 }]), null);
  assert.equal(estimateStep([]), null);
  // Samples entirely inside the guard band cannot support a fit either.
  assert.equal(estimateStep(syntheticTrack(0).filter((x) => Math.abs(x.s) < 1)), null);

  // NaN values are dropped rather than poisoning the fit.
  const withNaN = syntheticTrack(0.05);
  withNaN[3] = { s: withNaN[3].s, value: NaN };
  const survived = estimateStep(withNaN);
  assert.ok(survived !== null && Number.isFinite(survived.step));
});

test('the band statistic sees a localized bump the step statistic cannot', () => {
  // A narrow bump centred on the seam — what a blend defect or a mask edge looks
  // like — is continuous, so there is no step. The two-sided trend fit is what
  // catches it.
  const samples: TrendSample[] = [];
  const level = falloffField(0);
  for (let s = -8; s <= 8 + 1e-9; s += 0.25) {
    const bump = Math.abs(s) < 2 ? 0.05 * level * Math.cos((Math.PI * s) / 4) : 0;
    samples.push({ s, value: falloffField(s) + bump });
  }
  const result = estimateStep(samples);
  assert.ok(result !== null);
  assert.ok(result.stepFraction < 1e-3, `a symmetric bump is not a step; got ${result.stepFraction}`);
  assert.ok(
    Math.abs(result.bandFraction - 0.05) < 0.005,
    `the band must be the 5% bump; got ${result.bandFraction}`,
  );
  assert.equal(result.fraction, Math.max(result.stepFraction, result.bandFraction));
});

test('the polynomial fit is conditioned and exact on polynomial data', () => {
  const samples: TrendSample[] = [];
  for (let s = 2; s <= 12; s += 0.25) samples.push({ s, value: 3 - 0.02 * s + 0.004 * s * s });
  const fit = fitTrend(samples, 2, 12);
  assert.ok(fit !== null);
  assert.ok(fit.residualRms < 1e-12, `residual ${fit.residualRms}`);
  assert.ok(Math.abs(evalTrend(fit, 0) - 3) < 1e-9, 'extrapolation to zero must be exact');
  assert.ok(Math.abs(evalTrend(fit, 30) - (3 - 0.6 + 3.6)) < 1e-6, 'and far outside too');
  // Degenerate input returns null rather than a vector of NaN.
  assert.equal(fitTrend([{ s: 1, value: 1 }], 2, 1), null);
  assert.equal(fitTrend(Array.from({ length: 6 }, () => ({ s: 3, value: 1 })), 2, 3), null);
  assert.deepEqual(DEFAULT_STEP, { guardDeg: 2, windowDeg: 6, degree: 3 });
});

// ---------------------------------------------------------------------------

const GRAY = flatField(8, 4, { r: 0.5, g: 0.5, b: 0.5 });
const scene = (overrides = {}) =>
  defaultScene(GRAY, { ambient: tintedAmbient(0.04, 4000), ...overrides });

test('every photometric metric is PROVISIONAL and carries its assumptions', () => {
  // docs/ARCHITECTURE.md's phase gate, mechanically. If this ever fails, a
  // photometric number has escaped into a report without its warning label.
  const m = computePhotometricMetrics(nominalRig(), scene(), { convergence: false });
  assert.equal(m.provisional, true);
  assert.equal(m.phase, 'photometry');
  for (const metric of m.metrics) {
    assert.equal(metric.provisional, true, `${metric.id} is not marked provisional`);
    assert.ok(metric.note.includes('PROVISIONAL'), `${metric.id}'s note must say so in words`);
  }

  // The four §7 gates are all present and all scored; the reference readings are
  // present and all unscored.
  const scored = m.metrics.filter((x) => x.scored).map((x) => x.id).sort();
  assert.deepEqual(scored, ['black_uplift', 'black_uplift_chroma', 'seam_chroma', 'seam_luminance']);
  for (const id of scored) {
    assert.ok(GATES.some((g) => g.id === id && g.phase === 'photometry'), `${id} must be a §7 gate`);
  }
  assert.ok(m.metrics.filter((x) => !x.scored).length >= 3);

  // Provenance carries the unmeasured constants rather than leaving a reader to
  // guess which ones the number depends on.
  assert.ok(m.provenance.assumed.length >= 12, `${m.provenance.assumed.length} assumed constants`);
  for (const a of m.provenance.assumed) {
    assert.ok(a.klass === 'ASSUME' || a.klass === 'MEAS' || a.klass === 'DOC', `${a.symbol} is ${a.klass}`);
    assert.ok(a.section.startsWith('§'));
  }
  assert.equal(m.provenance.transfers.valuesPerTerm, 12, "§3.2's twelve values per term");
  assert.equal(m.provenance.perfectlyAligned, true);
  assert.ok(m.provenance.shadingModel.startsWith('full-v1'));
});

test('the nominal rig: all four §7 gates pass, and the seam reading is below the estimator floor', () => {
  const m = computePhotometricMetrics(nominalRig(), scene());
  const by = (id: string) => {
    const found = m.metrics.find((x) => x.id === id);
    assert.ok(found, `no metric ${id}`);
    return found;
  };

  assert.equal(m.pass, true, 'every scored gate must pass on the nominal rig');
  assert.ok(by('seam_luminance').value < 0.02);
  assert.ok(by('seam_chroma').value < 1.0);
  assert.ok(by('black_uplift').value < 1.2);
  assert.ok(by('black_uplift_chroma').value < 2.0);

  // But the luminance reading is BELOW the estimator's own noise floor, so the
  // honest statement is "no seam is resolvable here", not "the seam is 0.14%".
  const floor = m.seams.estimatorFloorFraction;
  assert.ok(Number.isFinite(floor), 'the control must be measurable on this rig');
  assert.ok(
    by('seam_luminance').value < floor,
    `seam ${by('seam_luminance').value} vs estimator floor ${floor} — the reading must not exceed ` +
      'the floor on a rig with no seam in it',
  );
  assert.ok(floor < 0.02 / 5, `the floor ${floor} must be well inside the gate to be useful`);

  // The geometry the metric found: four hand-over seams at the azimuth bisectors,
  // crossed at five latitudes, with both projectors at exactly half weight.
  assert.equal(m.seams.measurements.length, 20);
  assert.equal(m.seams.dropped.length, 0);
  // PARAMETERS.md §4.2: the two ANTIPODAL pairs never overlap, so they are not
  // seams. Two pairs times five latitudes.
  assert.equal(m.seams.nonSeamPairs, 10);
  for (const s of m.seams.measurements) {
    assert.ok(Math.abs(s.seamWeight - 0.5) < 1e-9, `seam weight ${s.seamWeight}`);
    const nearestBisector = 45 * Math.round(s.seamLonDeg / 45);
    assert.ok(Math.abs(s.seamLonDeg - nearestBisector) < 1e-6, `seam at ${s.seamLonDeg}`);
    assert.ok(Math.abs(nearestBisector % 90) === 45, 'seams sit between projectors, not on them');
  }

  // Both convergence checks agree between densities.
  for (const id of ['seam_luminance', 'black_uplift']) {
    const c = by(id).sampling.convergence;
    assert.ok(c !== null && c.converged, `${id} did not converge: ${JSON.stringify(c)}`);
  }
});

test('black uplift: the observed ratio passes only because the room is lit', () => {
  const m = computePhotometricMetrics(nominalRig(), scene(), { convergence: false });
  const observed = m.metrics.find((x) => x.id === 'black_uplift');
  const projectorOnly = m.metrics.find((x) => x.id === 'black_uplift_projector_only');
  assert.ok(observed && projectorOnly);

  // With ambient removed the ratio is the projector count, exactly — 2.00 against a
  // gate of 1.20, for any black floor and any gain. So §7's gate is satisfiable only
  // under the reading that includes ambient, and whether it passes is then mostly a
  // statement about E_amb, which is class ASSUME over a fifteen-fold range.
  assert.ok(Math.abs(projectorOnly.value - 2) < 0.01, `ambient-free ratio ${projectorOnly.value}`);
  assert.equal(projectorOnly.scored, false, 'and it must not be allowed to decide a build');
  assert.ok(observed.value < 1.2);

  // The sensitivity, measured rather than argued: the darkest room PARAMETERS.md §5
  // considers plausible makes the uplift four times more visible.
  const dark = computePhotometricMetrics(nominalRig(), scene({ ambient: tintedAmbient(0.01, 4000) }), {
    convergence: false,
  });
  const darkRatio = dark.metrics.find((x) => x.id === 'black_uplift');
  assert.ok(darkRatio);
  assert.ok(darkRatio.value > observed.value, 'a darker room must make the uplift MORE visible');
  assert.ok(
    (darkRatio.value - 1) / (observed.value - 1) > 3,
    `E_amb 0.04 -> 0.01 moved the uplift from ${observed.value} to ${darkRatio.value}`,
  );

  // The uplift is neutral on the nominal rig, because all twelve black floors are
  // equal. §3.2 predicts a TINTED uplift when they are not, and that is the
  // second-highest-risk unmeasured group in §10.
  assert.ok(m.black.deltaE < 0.5, `neutral uplift should be a small dE; got ${m.black.deltaE}`);
});

test('§3.2 on a rig: divergence is visible to the divergence reading and invisible to the seam gate', () => {
  // The spec's own worked example, as a rig: every projector's blue channel at
  // gamma 2.4 while the compositor still encodes assuming 2.2.
  const rig = nominalRig({ transfer: nominalTransfer({ gamma: { r: 2.2, g: 2.2, b: 2.4 } }) });
  const m = computePhotometricMetrics(rig, scene(), { convergence: false });
  const get = (id: string) => {
    const found = m.metrics.find((x) => x.id === id);
    assert.ok(found);
    return found.value;
  };

  // The divergence differential sees it: a yellow band worth dE2000 ~3.9, well over
  // §7's seam-chromaticity gate of 1.0 if that gate applied to it.
  assert.ok(get('seam_divergence_chroma') > 3, `divergence dE ${get('seam_divergence_chroma')}`);
  assert.ok(get('seam_divergence_luminance') < 0.02, 'and under 1% in luminance, as blue is only 7%');

  // The seam DISCONTINUITY metrics do not, and that is not a bug — the artifact is
  // smooth across the entire 71-degree overlap, so it is not a discontinuity. §7's
  // gate as literally worded cannot detect the artifact §3.2 exists to describe.
  // Recorded as docs/AMENDMENTS.md A-15.
  assert.ok(get('seam_chroma') < 0.1, `seam chroma metric read ${get('seam_chroma')}`);
  assert.ok(get('seam_luminance') < 0.02);
  assert.equal(m.pass, true, 'so this rig passes every scored gate while carrying a visible band');

  // On the channel-matched nominal both divergence readings are exactly zero. Not
  // approximately — the two renders are the same render.
  const matched = computePhotometricMetrics(nominalRig(), scene(), { convergence: false });
  assert.equal(matched.divergence.deltaE, 0);
  assert.equal(matched.divergence.luminanceFraction, 0);
  assert.equal(matched.divergence.channelMatched, true);
  assert.equal(m.divergence.channelMatched, false);
});

test('a misregistered rig fails the seam gates, which is what makes them worth having', () => {
  // Two calibrations, per metrics/registration.ts: the compositor draws with the
  // nominal rig and the lenses are somewhere else. That is what real misalignment
  // is, and it produces a genuine discontinuity at every seam.
  const content = nominalRig();
  const physical = injectMisalignment(content, 424242).rig;
  const m = computePhotometricMetrics(physical, scene(), {
    contentRig: content,
    convergence: false,
  });

  const seamLuminance = m.metrics.find((x) => x.id === 'seam_luminance');
  const seamChroma = m.metrics.find((x) => x.id === 'seam_chroma');
  assert.ok(seamLuminance && seamChroma);
  assert.equal(seamLuminance.pass, false, `misregistration must show up: ${seamLuminance.value}`);
  assert.equal(seamChroma.pass, false);
  // The control floor rises on a misaligned rig too — the estimator is looking at a
  // field that has been bent everywhere, not just at the seam — so the test is that
  // the seam still stands clear of it by a wide margin.
  assert.ok(
    seamLuminance.value > 3 * m.seams.estimatorFloorFraction,
    `seam ${seamLuminance.value} against floor ${m.seams.estimatorFloorFraction}`,
  );
  assert.equal(m.pass, false);
  assert.equal(m.provenance.perfectlyAligned, false);

  // Black uplift is unmoved: it is a property of the black floors and the geometry,
  // not of whether the content lines up. A metric set where every metric moves
  // together is a metric set that cannot localize a fault.
  const black = m.metrics.find((x) => x.id === 'black_uplift');
  assert.ok(black && black.pass === true, 'the black uplift gate must not care about registration');
});

test('the metrics are deterministic and independent of the shading model choice being recorded', () => {
  const rig = nominalRig();
  const a = computePhotometricMetrics(rig, scene(), { convergence: false });
  const b = computePhotometricMetrics(rig, scene(), { convergence: false });
  for (let i = 0; i < a.metrics.length; i++) {
    assert.equal(a.metrics[i].value, b.metrics[i].value, `${a.metrics[i].id} is not deterministic`);
  }

  // Switching to the Phase 1 shading model changes the numbers a little — the
  // specular lobe of §1 is real — but not the verdict, and the model that produced
  // the numbers is named in the provenance either way.
  const lambert = computePhotometricMetrics(rig, scene(), {
    convergence: false,
    shading: lambertianShading(),
  });
  assert.equal(lambert.provenance.shadingModel, 'lambertian-v1');
  assert.equal(lambert.pass, a.pass);
  const blackFull = a.metrics.find((x) => x.id === 'black_uplift');
  const blackLambert = lambert.metrics.find((x) => x.id === 'black_uplift');
  assert.ok(blackFull && blackLambert);
  assert.ok(blackFull.value !== blackLambert.value, 'rho_spec = 0.03 is not a no-op');
  assert.ok(Math.abs(blackFull.value - blackLambert.value) < 0.01, 'but it is a small one');
});
