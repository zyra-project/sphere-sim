/**
 * The hardware envelope as a box constraint, and the shared-lens tie.
 *
 * Both changes are licensed by a document rather than by a measurement:
 * docs/AMENDMENTS.md A-35 records that the install runs four BenQ LK935s, one
 * model bought together, and transcribes the manual's zoom range and lens-shift
 * travel. So what these tests pin is that the code says what the document says,
 * and that it is INERT when the fit is already inside the envelope — which is
 * the property that decides whether the constraint can be trusted at all.
 *
 * A box that changed an interior solve would be a prior wearing a constraint's
 * clothes, and the first test below is the one that would catch it: not
 * approximately equal, bit-for-bit equal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROJECTOR_LK935 } from '../../calibration/src/parameters.ts';
import {
  DEFAULT_BUNDLE_OPTIONS,
  DEFAULT_FREE_FLAGS,
  buildProblem,
  boundsAtLimit,
  levenbergMarquardt,
  runBundle,
  slotProjector,
  PROJ_SLOT_FOV,
  type BundleOptions,
  type FloorReference,
  type ParameterBox,
} from '../src/bundle.ts';
import {
  DEFAULT_HARDWARE_OPTIONS,
  bundleStateFromCalibration,
  nominalRig,
  solveFromCorrespondences,
} from '../src/index.ts';
import { generateCorrespondences, makeScene } from './synthetic.ts';
import type { BundleState } from '../src/bundle.ts';

const SMALL = { cameraRes: { x: 240, y: 180 }, cameraCount: 3 };

function floorAtEveryLens(truth: BundleState): FloorReference[] {
  return truth.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM: p.position.z + truth.centerHeightM,
    sigmaM: 0.002,
  }));
}

// ---------------------------------------------------------------------------
// What the document says
// ---------------------------------------------------------------------------

test('the profile carries the LK935 envelope A-35 transcribed', () => {
  const p = PROJECTOR_LK935;
  assert.equal(p.klass, 'CFG', 'PARAMETERS.md §3.1 classes the throw ratio CFG');
  assert.equal(p.throwRatioMin, 1.36);
  assert.equal(p.throwRatioMax, 2.18);
  assert.equal(p.shiftVMax, 0.6);
  assert.equal(p.shiftHMax, 0.23);
  assert.equal(p.projectionOffset, 0);

  // The two field-of-view limits are the throw ratios through
  // `fov = 2*atan(1/(2*T))`. The calibration package holds no arithmetic, so the
  // derivation is checked HERE rather than performed there — which is the point
  // of writing derived values out longhand.
  const fovOf = (t: number): number => (2 * Math.atan(1 / (2 * t)) * 180) / Math.PI;
  assert.ok(Math.abs(fovOf(p.throwRatioMin) - p.fovHDegMax) < 0.01);
  assert.ok(Math.abs(fovOf(p.throwRatioMax) - p.fovHDegMin) < 0.01);
  // A wider lens is a SHORTER throw. Getting this backwards would put the box
  // on the wrong side of every solve and still look plausible in a table.
  assert.ok(p.fovHDegMax > p.fovHDegMin);
});

test('the envelope contains the rig PARAMETERS.md describes, at both ends of §2s d_proj conflict', () => {
  // A-01: the sphere's silhouette is inscribed in the raster's MINOR dimension.
  // A-35: the LK935 covers the sphere across the whole of §2's disputed range,
  // so the conflict changes the zoom setting and not the lens. If this ever
  // fails, the box excludes the truth and every result computed with it is
  // suspect — which is why it is asserted rather than assumed.
  for (const distanceM of [5.18, 5.5, 6.14]) {
    const rig = nominalRig({ distanceM });
    const fov = rig.projectors[0].intrinsics.fovHDeg;
    assert.ok(
      fov > PROJECTOR_LK935.fovHDegMin && fov < PROJECTOR_LK935.fovHDegMax,
      `nominal fov ${fov.toFixed(2)} deg at d_proj = ${distanceM} m is outside the LK935 envelope`,
    );
  }
});

// ---------------------------------------------------------------------------
// Inert when the fit is inside
// ---------------------------------------------------------------------------

test('the box is EXACTLY inert on a solve that stays inside it', () => {
  const scene = makeScene(7301, SMALL);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 6, noisePx: 0.05 });
  const floor = floorAtEveryLens(scene.truth);

  const withBox = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    hardware: { profile: PROJECTOR_LK935 },
  });
  const without = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    hardware: { profile: null },
  });

  assert.equal(withBox.extra.boxProjections, 0, 'a well-posed solve should never reach a limit');
  assert.deepEqual(withBox.extra.boundsAtLimit, []);
  // Bit-for-bit. A constraint that is not active must not perturb one operation.
  assert.equal(withBox.diagnostics.rmsResidualPx, without.diagnostics.rmsResidualPx);
  assert.equal(withBox.diagnostics.iterations, without.diagnostics.iterations);
  assert.equal(withBox.diagnostics.correspondencesUsed, without.diagnostics.correspondencesUsed);
  for (let i = 0; i < withBox.calibration.projectors.length; i++) {
    const a = withBox.calibration.projectors[i].intrinsics;
    const b = without.calibration.projectors[i].intrinsics;
    assert.equal(a.fovHDeg, b.fovHDeg);
    assert.equal(a.shiftH, b.shiftH);
    assert.equal(a.shiftV, b.shiftV);
  }
  assert.equal(
    withBox.calibration.sphere.centerHeightM,
    without.calibration.sphere.centerHeightM,
  );

  // And the recovered fields are inside the envelope by a wide margin rather
  // than by a whisker, which is the fact worth reporting from a corpus run.
  for (const p of withBox.calibration.projectors) {
    assert.ok(p.intrinsics.fovHDeg > PROJECTOR_LK935.fovHDegMin + 2);
    assert.ok(p.intrinsics.fovHDeg < PROJECTOR_LK935.fovHDegMax - 2);
  }
});

// ---------------------------------------------------------------------------
// And a real constraint when it is not
// ---------------------------------------------------------------------------

test('a box the state starts outside of is a constraint, not a suggestion', () => {
  const scene = makeScene(7302, SMALL);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 6, noisePx: 0.05 });
  const floor = floorAtEveryLens(scene.truth);
  const nominal = bundleStateFromCalibration(scene.nominal, scene.cameraInputs);

  // A deliberately absurd box: the field of view is pinned to a degree either
  // side of 30, which the truth (about 34) is nowhere near. This does not model
  // any real projector — it is the smallest way to prove the mechanism BINDS,
  // since a physically honest envelope is one the solve never approaches.
  const bounds: ParameterBox[] = nominal.projectors.map((p, i) => ({
    slot: slotProjector(i, PROJ_SLOT_FOV),
    lo: 29,
    hi: 31,
    name: `${p.id}.fovH (test box)`,
  }));
  const opts: Partial<BundleOptions> = { bounds, tieProjectorFov: false };
  const report = runBundle(nominal, corrs, floor, opts, nominal);

  assert.ok(report.boxProjections > 0, 'the solve should have been pushed back onto the box');
  for (const p of report.state.projectors) {
    assert.ok(p.fovHDeg >= 29 - 1e-12 && p.fovHDeg <= 31 + 1e-12, `fov ${p.fovHDeg} escaped`);
  }
  const atLimit = report.boundsAtLimit;
  assert.ok(atLimit.length > 0);
  for (const b of atLimit) assert.ok(b.limit === 'lo' || b.limit === 'hi');
});

test('a box on a HELD parameter is dropped rather than silently enforced', () => {
  // `projectorFov: false` holds the field of view, so a box on it can never
  // fire. `buildProblem` filters it out, and the filtering is what keeps the
  // step loop from paying for constraints on parameters that cannot move.
  const scene = makeScene(7303, SMALL);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 8, noisePx: 0.05 });
  const nominal = bundleStateFromCalibration(scene.nominal, scene.cameraInputs);
  const opts: BundleOptions = {
    ...DEFAULT_BUNDLE_OPTIONS,
    free: { ...DEFAULT_FREE_FLAGS, projectorFov: false },
    bounds: nominal.projectors.map((p, i) => ({
      slot: slotProjector(i, PROJ_SLOT_FOV),
      lo: 29,
      hi: 31,
      name: `${p.id}.fovH`,
    })),
  };
  const problem = buildProblem(nominal, corrs, [], opts);
  assert.equal(problem.boxes.length, 0);
  assert.deepEqual(boundsAtLimit(nominal, problem), []);
  // And the held field really is untouched by the constraint.
  const report = levenbergMarquardt(nominal, problem);
  assert.equal(report.state.projectors[0].fovHDeg, nominal.projectors[0].fovHDeg);
  assert.equal(report.boxProjections, 0);
});

// ---------------------------------------------------------------------------
// The tie
// ---------------------------------------------------------------------------

test('the shared-lens tie is on by default and really does share one field', () => {
  assert.equal(
    DEFAULT_BUNDLE_OPTIONS.tieProjectorFov,
    true,
    'docs/AMENDMENTS.md A-35: four projectors of one model share one lens',
  );
  assert.equal(
    DEFAULT_HARDWARE_OPTIONS.profile?.id,
    'LK935',
    'the default hardware profile is the projector A-35 documents',
  );

  const scene = makeScene(7304, SMALL);
  const corrs = generateCorrespondences(scene.truth, { cameraStride: 6, noisePx: 0.05 });
  const floor = floorAtEveryLens(scene.truth);

  const tied = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {});
  const fovs = tied.calibration.projectors.map((p) => p.intrinsics.fovHDeg);
  for (const f of fovs) {
    assert.equal(f, fovs[0], 'a tied field of view must come back bit-identical on every projector');
  }

  // Untied, they differ — otherwise the test above would pass for the wrong
  // reason, and a tie that was quietly a no-op would look like a success.
  const free = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    bundle: { tieProjectorFov: false },
  });
  const freeFovs = free.calibration.projectors.map((p) => p.intrinsics.fovHDeg);
  assert.ok(
    freeFovs.some((f) => f !== freeFovs[0]),
    'four independent fields that all came back identical would mean the tie is untested',
  );
});
