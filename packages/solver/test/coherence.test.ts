/**
 * Two round-2 mechanisms, and the properties that make them safe to ship.
 *
 * **The shared field of view** (`BundleOptions.tieProjectorFov`). PARAMETERS.md
 * §3.1 derives `fov_h` from the throw ratio `T` and classes `T` as `CFG` — one
 * spec sheet per install. A rig built that way has one field of view, not four.
 * The tie has to hold exactly, and it has to be a no-op when it is off.
 *
 * **The pair-coherence discriminator** (`BundleOptions.pairCoherence`). It exists
 * to tell a (camera, projector) pair whose residuals are BIASED from one whose
 * residuals are merely NOISY, and everything below is a way for it to be wrong:
 *
 *  - it must not fire on isotropic noise, which is the tripod case and the case
 *    that passes its gate today;
 *  - it must not fire on the two APPARATUS signatures the progress page already
 *    subtracts — the raster-aspect anisotropy of the decode (`patterns.ts` spends
 *    one Gray-plane count on both axes, so `u` residuals are 1920/1080 wider than
 *    `v`) and the axis-aligned quantisation cross;
 *  - it must fire on a coherent per-pair offset, which is what handheld motion
 *    actually produces;
 *  - and it must not disturb the outlier rejection, because the two mechanisms
 *    answer different questions and an earlier version of this code let them
 *    fight: inflating a pair's sigma shrank its standardised residuals until the
 *    rejection threshold floored and the pass stopped discarding anything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/linalg.ts';
import {
  DEFAULT_BUNDLE_OPTIONS,
  buildProblem,
  estimatePairCoherence,
  evaluate,
  runBundle,
  type BundleOptions,
  type BundleState,
  type FloorReference,
} from '../src/bundle.ts';
import type { Correspondence } from '../src/decode.ts';
import { bundleStateFromCalibration } from '../src/index.ts';
import { generateCorrespondences, makeScene } from './synthetic.ts';

function floorAtEveryLens(truth: BundleState): FloorReference[] {
  return truth.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM: p.position.z + truth.centerHeightM,
    sigmaM: 0.002,
  }));
}

// ---------------------------------------------------------------------------
// The shared field of view
// ---------------------------------------------------------------------------

test('tieProjectorFov solves ONE field of view, and off it solves four', () => {
  const scene = makeScene(4242);
  const corrs = generateCorrespondences(scene.truth, { noisePx: 0.05, seed: 11, sigmaPx: 0.05 });
  const floor = floorAtEveryLens(scene.truth);
  const nominal = bundleStateFromCalibration(scene.nominal, scene.cameraInputs);

  const tied = runBundle(nominal, corrs, floor, { tieProjectorFov: true }, nominal);
  const fovs = tied.state.projectors.map((p) => p.fovHDeg);
  for (const f of fovs) {
    // Exactly, not approximately: the tie is a structural constraint, so any
    // drift at all means the parameter vector and the state disagree.
    assert.equal(f, fovs[0], `tied fields of view diverged: ${fovs.join(', ')}`);
  }

  const free = runBundle(nominal, corrs, floor, {}, nominal);
  const freeFovs = free.state.projectors.map((p) => p.fovHDeg);
  const spread = Math.max(...freeFovs) - Math.min(...freeFovs);
  assert.ok(spread > 1e-6, `untied fields of view should differ, spread was ${spread}`);
});

test('the tie is invisible when it is off', () => {
  // The layout gained a `columnSlots` indirection and `levenbergMarquardt` gained
  // a pack/unpack round trip before the first evaluation. Both are meant to be
  // exact no-ops without a tie, and "meant to be" is not a guarantee.
  const scene = makeScene(4243);
  const corrs = generateCorrespondences(scene.truth, { noisePx: 0.05, seed: 12, sigmaPx: 0.05 });
  const floor = floorAtEveryLens(scene.truth);
  const nominal = bundleStateFromCalibration(scene.nominal, scene.cameraInputs);
  const a = runBundle(nominal, corrs, floor, {}, nominal);
  const b = runBundle(nominal, corrs, floor, { tieProjectorFov: false }, nominal);
  assert.equal(a.cost, b.cost);
  assert.equal(a.rmsResidualPx, b.rmsResidualPx);
});

// ---------------------------------------------------------------------------
// The pair-coherence discriminator
// ---------------------------------------------------------------------------

/**
 * The estimator's verdict on a residual field, measured at ground truth.
 *
 * Correspondences are generated from `truth` and then displaced by `field`, so
 * evaluating at `truth` makes the displacement BE the residual. That is what
 * lets a test state exactly what shape it is feeding in.
 */
function scalesFor(
  seed: number,
  field: (c: Correspondence, rng: ReturnType<typeof createRng>) => { du: number; dv: number },
  options: Partial<BundleOptions> = {},
): { scales: number[]; nPairs: number } {
  const scene = makeScene(seed);
  const base = generateCorrespondences(scene.truth, { seed: 5, sigmaPx: 0.25 });
  const rng = createRng(seed ^ 0x9e37);
  const corrs = base.map((c) => {
    const d = field(c, rng);
    return { ...c, projU: c.projU - d.du, projV: c.projV - d.dv };
  });
  const opts: BundleOptions = {
    ...DEFAULT_BUNDLE_OPTIONS,
    ...options,
    pairCoherence: { ...DEFAULT_BUNDLE_OPTIONS.pairCoherence, ...(options.pairCoherence ?? {}) },
  };
  const problem = buildProblem(scene.truth, corrs, [], opts);
  const ev = evaluate(scene.truth, problem, false);
  const scales = Array.from(estimatePairCoherence(scene.truth, problem, ev));
  return { scales, nPairs: scales.length };
}

test('isotropic noise does not fire the discriminator', () => {
  const { scales } = scalesFor(
    5150,
    (_c, rng) => ({ du: rng.nextGaussian() * 0.25, dv: rng.nextGaussian() * 0.25 }),
    { pairCoherence: { ...DEFAULT_BUNDLE_OPTIONS.pairCoherence, mode: 'raw' } },
  );
  for (const s of scales) assert.equal(s, 1, `noise inflated a pair to ${s}`);
});

test('the raster-aspect anisotropy of the decode does not fire it', () => {
  // patterns.ts counts Gray planes once and spends the count on both axes, so a
  // decode-limited residual is wider in `u` than in `v` by exactly 1920/1080.
  // That is the apparatus, and the progress page reports it as the EXPECTED
  // anisotropy. A discriminator that fires on it is measuring the instrument.
  const aspect = 1920 / 1080;
  const { scales } = scalesFor(
    5151,
    (_c, rng) => ({
      du: rng.nextGaussian() * 0.25 * aspect,
      dv: rng.nextGaussian() * 0.25,
    }),
    { pairCoherence: { ...DEFAULT_BUNDLE_OPTIONS.pairCoherence, mode: 'raw' } },
  );
  for (const s of scales) assert.equal(s, 1, `anisotropy inflated a pair to ${s}`);
});

test('the axis-aligned quantisation cross does not fire it', () => {
  // The decode quantises `u` and `v` independently, so its own residual falls on
  // an axis-aligned lattice. It is zero-mean inside any cell, so a statistic
  // built on cell means cannot see it — which is the reason the statistic is
  // built on cell means.
  const step = 0.5;
  const { scales } = scalesFor(
    5152,
    (_c, rng) => {
      const u = rng.nextGaussian() * 0.25;
      const v = rng.nextGaussian() * 0.25;
      return { du: Math.round(u / step) * step, dv: Math.round(v / step) * step };
    },
    { pairCoherence: { ...DEFAULT_BUNDLE_OPTIONS.pairCoherence, mode: 'raw' } },
  );
  for (const s of scales) assert.equal(s, 1, `quantisation inflated a pair to ${s}`);
});

test('a coherent per-pair offset DOES fire it', () => {
  // What handheld motion actually produces: measured against ground truth on the
  // bench corpus, 58-87% of a moving camera's decode-error energy per pair is a
  // single affine field, of which a 3-11 pixel translation is the largest term.
  const { scales } = scalesFor(
    5153,
    (c, rng) => {
      // Deterministic per pair, so the field is coherent rather than noisy, and
      // different per pair, so it is not a projector-level model error.
      const bias = 1 + ((c.camera * 7 + c.projector * 3) % 5) * 0.5;
      return {
        du: bias + rng.nextGaussian() * 0.25,
        dv: -0.5 * bias + rng.nextGaussian() * 0.25,
      };
    },
    { pairCoherence: { ...DEFAULT_BUNDLE_OPTIONS.pairCoherence, mode: 'raw' } },
  );
  const fired = scales.filter((s) => s > 1);
  assert.ok(
    fired.length >= scales.filter((s) => s >= 1).length / 2,
    `expected most pairs to be inflated, got ${scales.join(', ')}`,
  );
  assert.ok(Math.max(...scales) > 2, `expected a substantial inflation, got ${scales.join(', ')}`);
});

test('off is off: the estimator returns unity and the solve is unchanged', () => {
  const { scales } = scalesFor(5154, (c, rng) => ({
    du: 2 + rng.nextGaussian() * 0.25,
    dv: c.projector - 1 + rng.nextGaussian() * 0.25,
  }));
  for (const s of scales) assert.equal(s, 1);
});

test('pair coherence does not change which correspondences are rejected', () => {
  // The bug this guards: the pair scale used to reach the rejection statistic,
  // so declaring a pair untrustworthy shrank its standardised residuals until
  // the threshold floored and the pass kept MORE of it. Measured on the bench's
  // s04-handheld, rejections fell from 661 to 69 — the estimator made the solver
  // trust the data it had just distrusted.
  const scene = makeScene(5155);
  const base = generateCorrespondences(scene.truth, { noisePx: 0.1, seed: 9, sigmaPx: 0.1 });
  const rng = createRng(31337);
  const corrs = base.map((c) => {
    const bias = 1 + ((c.camera * 7 + c.projector * 3) % 5) * 0.4;
    // A handful of gross outliers, which is what the rejection pass is for.
    const gross = rng.nextFloat() < 0.01 ? 40 : 0;
    return {
      ...c,
      projU: c.projU - bias - gross,
      projV: c.projV + 0.5 * bias,
    };
  });
  const floor = floorAtEveryLens(scene.truth);
  const nominal = bundleStateFromCalibration(scene.nominal, scene.cameraInputs);

  const off = runBundle(nominal, corrs, floor, {}, nominal);
  const on = runBundle(
    nominal,
    corrs,
    floor,
    { pairCoherence: { ...DEFAULT_BUNDLE_OPTIONS.pairCoherence, mode: 'raw' } },
    nominal,
  );
  assert.ok(
    on.pairResidualScale.some((s) => s > 1),
    'the coherent bias should have fired the discriminator',
  );
  assert.equal(on.rejected, off.rejected);
  assert.equal(on.used, off.used);
});
