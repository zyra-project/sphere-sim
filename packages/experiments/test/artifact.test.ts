/**
 * The Experiment 2 estimator, and the estimator it replaced.
 *
 * The first test is the one that matters: a rig whose content calibration IS its
 * physical calibration must report exactly zero artifact, at every ramp shape and
 * every width. If that drifted, every cell in Experiment 2 would carry a floor that
 * looks like a small misregistration and the whole contour would move.
 *
 * The last test pins a NEGATIVE result — that the windowed estimator's reading
 * depends on the window — because that is why the experiment does not use it, and a
 * rejection nobody can reproduce is a rejection that gets re-litigated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RAMP_SHAPES } from '../../sim/src/index.ts';
import {
  estimatorScan,
  measureBlendProfile,
  measureMisregistration,
} from '../src/photometric/artifact.ts';
import { epsilonForMm, misregisteredRig } from '../src/photometric/misregistration.ts';
import { buildModel } from '../src/photometric/model.ts';

const LATS = [-25, 0, 25];
const SPACING = 0.5;

test('a registered rig reports exactly zero artifact, at every shape and width', () => {
  for (const rampShape of RAMP_SHAPES) {
    for (const w_width of [5, 20, 71]) {
      const built = buildModel({ w_width }, { rampShape });
      const artifact = measureMisregistration(built.rig, built.rig, built.scene, {
        latitudesDeg: LATS,
        sampleSpacingDeg: SPACING,
        shading: built.shading,
      });
      assert.equal(artifact.luminanceFraction, 0, `${rampShape} at ${w_width} deg`);
      assert.equal(artifact.chromaDeltaE, 0, `${rampShape} at ${w_width} deg`);
      assert.ok(artifact.blendResidual < 1e-9, `blend residual ${artifact.blendResidual}`);
      assert.ok(artifact.overlapSamples > 100, `only ${artifact.overlapSamples} overlap samples`);
    }
  }
});

test('the blend residual is linear in the misregistration and inverse in the width', () => {
  const radiusM = 0.8636;
  const residualAt = (w_width: number, mm: number): number => {
    const built = buildModel({ w_width });
    const physical = misregisteredRig(built.rig, epsilonForMm(mm, radiusM));
    return measureMisregistration(physical, built.rig, built.scene, {
      latitudesDeg: [0],
      sampleSpacingDeg: SPACING,
      shading: built.shading,
    }).blendResidual;
  };

  // Linear in the error: doubling the displacement doubles the weight the blend gets
  // wrong, because a small displacement of a smooth ramp is its derivative times the
  // displacement and nothing else.
  const one = residualAt(20, 1);
  const four = residualAt(20, 4);
  assert.ok(
    Math.abs(four / one - 4) < 0.05,
    `expected 4x from 1 mm to 4 mm, got ${(four / one).toFixed(3)}x`,
  );

  // Inverse in the width: the same displacement crosses half as much of a ramp that
  // is twice as wide. This is the mechanism behind the whole experiment, so it is
  // asserted rather than described.
  const narrow = residualAt(10, 4);
  const wide = residualAt(20, 4);
  assert.ok(
    Math.abs(narrow / wide - 2) < 0.1,
    `expected 2x from a 20 deg ramp to a 10 deg one, got ${(narrow / wide).toFixed(3)}x`,
  );
});

test('a wider ramp hands less light to a grazing projector, not more', () => {
  // The obvious worry about widening the blend is that it pushes the crossfade into
  // PARAMETERS.md §4.3's degenerate region. It does the opposite here, and the reason
  // is that `coverage.ts` anchors each ramp at the projector's own footprint EDGE:
  // a narrow ramp gives a fading-in projector its full share within a couple of
  // degrees of its own limb, where its cosine is near zero.
  const narrow = buildModel({ w_width: 5 });
  const wide = buildModel({ w_width: 40 });
  const a = measureBlendProfile(narrow.rig, narrow.scene, {
    latitudesDeg: LATS,
    sampleSpacingDeg: SPACING,
    shading: narrow.shading,
    latticeCount: 1500,
  });
  const b = measureBlendProfile(wide.rig, wide.scene, {
    latitudesDeg: LATS,
    sampleSpacingDeg: SPACING,
    shading: wide.shading,
    latticeCount: 1500,
  });
  assert.ok(a.meanIncidenceLoss > b.meanIncidenceLoss, 'widening the ramp must not cost sharpness');
  assert.ok(a.maxLogGradientPerDeg > b.maxLogGradientPerDeg, 'a narrow ramp hands over more abruptly');
  // Neither can beat the floor: some of the sphere is grazing whatever the blend does.
  assert.ok(b.smearedAreaFraction >= b.smearedAreaFractionBest - 1e-9);
});

test('the windowed estimator is scale-dependent, which is why it is not used', () => {
  const built = buildModel({ w_width: 10 });
  const readings = [
    { guardDeg: 1, windowDeg: 3, degree: 3 },
    { guardDeg: 2, windowDeg: 6, degree: 3 },
    { guardDeg: 4, windowDeg: 12, degree: 5 },
  ].map(
    (step) =>
      estimatorScan(built.rig, built.rig, built.scene, {
        latitudesDeg: [0],
        sampleSpacingDeg: 0.25,
        shading: built.shading,
        step,
      }).luminanceFraction,
  );

  // On a PERFECTLY REGISTERED rig, so every one of these is measuring the estimator
  // against the blend's own curvature rather than any artifact. If this spread ever
  // collapses, the rejection in artifact.ts should be revisited — but until it does,
  // no window choice here is the artifact's size, and quoting one against §7's 2%
  // gate would be choosing a verdict rather than measuring one.
  const spread = Math.max(...readings) / Math.min(...readings);
  assert.ok(spread > 3, `expected a large window dependence, got ${spread.toFixed(2)}x`);
  assert.ok(
    readings[2] > readings[0],
    'a wider window must read higher on a curved field, or the mechanism is not what artifact.ts says',
  );
});
