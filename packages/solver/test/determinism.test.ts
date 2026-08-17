/**
 * Determinism.
 *
 * The headless bench compares runs byte for byte, so "same inputs, same seed,
 * same output" is not a nicety here — a solver that drifts in the last digit
 * makes every regression check unusable, and the drift is always in something
 * boring: an unseeded RANSAC sample, a Map iteration order reaching a
 * floating-point sum, a tie broken by object identity.
 *
 * These tests compare serialised output rather than a scalar, because a scalar
 * summary is exactly where a one-ULP difference hides.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solve, solveFromCorrespondences } from '../src/index.ts';
import { createRng } from '../src/linalg.ts';
import { decodeAll } from '../src/decode.ts';
import type { FloorReference } from '../src/bundle.ts';
import { generateCorrespondences, makeScene, renderAllCaptures } from './synthetic.ts';

/**
 * Determinism does not need a big problem — it needs the same problem twice.
 * These scenes are deliberately small so the suite stays fast; the accuracy
 * claims live in bundle.test.ts, which uses the full-size ones.
 */
const SMALL = { cameraCount: 2, cameraRes: { x: 320, y: 240 } };
const STRIDE = { cameraStride: 8 };

function floorRefs(scene: ReturnType<typeof makeScene>): FloorReference[] {
  return scene.truth.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM: p.position.z + scene.truth.centerHeightM,
    sigmaM: 0.002,
  }));
}

test('two solves from identical inputs produce identical output', () => {
  const scene = makeScene(51, SMALL);
  const corrs = generateCorrespondences(scene.truth, { ...STRIDE, noisePx: 0.1, seed: 3 });
  const floor = floorRefs(scene);

  const a = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor);
  const b = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor);

  assert.equal(JSON.stringify(a.calibration), JSON.stringify(b.calibration));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
  assert.equal(JSON.stringify(a.extra), JSON.stringify(b.extra));
});

test('the whole pipeline, images included, is reproducible', () => {
  const scene = makeScene(52, { cameraRes: { x: 112, y: 84 }, cameraCount: 2 });
  const captures = renderAllCaptures(scene.truth, { noiseSigma: 0.005, seed: 17 });
  const floor = floorRefs(scene);

  const a = solve({ nominal: scene.nominal, cameras: scene.cameraInputs, captures, floorReferences: floor });
  const b = solve({ nominal: scene.nominal, cameras: scene.cameraInputs, captures, floorReferences: floor });
  assert.equal(JSON.stringify(a.calibration), JSON.stringify(b.calibration));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
});

test('watching a solve cannot change it', () => {
  // `SolveInput.onStep` exists so a person waiting several seconds can see the
  // optimiser converging rather than a spinner. It is documented as read-only by
  // construction; this is what makes that a claim rather than an intention. An
  // observer that could move the answer would make every solve depend on who was
  // looking at it.
  const scene = makeScene(54, SMALL);
  const corrs = generateCorrespondences(scene.truth, { ...STRIDE, noisePx: 0.1, seed: 5 });
  const floor = floorRefs(scene);
  const input = { nominal: scene.nominal, cameras: scene.cameraInputs, correspondences: corrs, floorReferences: floor };

  const silent = solve(input);
  const steps: { pass: number; iteration: number; cost: number }[] = [];
  const watched = solve({ ...input, onStep: (s) => steps.push({ pass: s.pass, iteration: s.iteration, cost: s.cost }) });

  assert.equal(JSON.stringify(watched.calibration), JSON.stringify(silent.calibration));
  assert.equal(JSON.stringify(watched.diagnostics), JSON.stringify(silent.diagnostics));

  // And it actually reported something, or the check above is vacuous.
  assert.ok(steps.length > 0, 'no steps were reported');
  assert.ok(
    steps.every((s, i) => i === 0 || s.cost <= steps[i - 1].cost || s.pass > steps[i - 1].pass),
    'the cost rose on an accepted step within a pass, which cannot happen',
  );
});

test('the synthetic generator is itself reproducible', () => {
  // If the generator drifted, a determinism failure in the solver would be
  // misattributed. Pin the input before pinning the output.
  const one = makeScene(53, SMALL);
  const two = makeScene(53, SMALL);
  assert.equal(JSON.stringify(one.truth), JSON.stringify(two.truth));
  assert.equal(
    JSON.stringify(generateCorrespondences(one.truth, { ...STRIDE, noisePx: 0.2, seed: 9 })),
    JSON.stringify(generateCorrespondences(two.truth, { ...STRIDE, noisePx: 0.2, seed: 9 })),
  );
  const small = makeScene(53, { cameraCount: 1, cameraRes: { x: 96, y: 72 } });
  const capA = renderAllCaptures(small.truth, { noiseSigma: 0.01, seed: 4 });
  const capB = renderAllCaptures(small.truth, { noiseSigma: 0.01, seed: 4 });
  assert.deepEqual(
    Array.from(capA[0].gray[0].patterns[0].data),
    Array.from(capB[0].gray[0].patterns[0].data),
  );
  assert.equal(
    JSON.stringify(decodeAll(capA).correspondences),
    JSON.stringify(decodeAll(capB).correspondences),
  );
});

test('the RANSAC seed is honoured: same seed identical, different seed still deterministic', () => {
  const scene = makeScene(54, SMALL);
  const corrs = generateCorrespondences(scene.truth, { ...STRIDE, noisePx: 0.2, seed: 11 });
  const floor = floorRefs(scene);

  const s1 = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    seed: 1,
  });
  const s1again = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    seed: 1,
  });
  const s2 = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    seed: 2,
  });
  const s2again = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    seed: 2,
  });

  assert.equal(JSON.stringify(s1.calibration), JSON.stringify(s1again.calibration));
  assert.equal(JSON.stringify(s2.calibration), JSON.stringify(s2again.calibration));
  // Two seeds may or may not land on the same answer — with clean data the
  // bootstrap converges to the same place either way. What must hold is that
  // each is reproducible and that both are good.
  assert.ok(s1.diagnostics.rmsResidualPx < 1, `seed 1 rms ${s1.diagnostics.rmsResidualPx}`);
  assert.ok(s2.diagnostics.rmsResidualPx < 1, `seed 2 rms ${s2.diagnostics.rmsResidualPx}`);
});

test('the PRNG is the only source of randomness, and it is seeded', () => {
  // A guard against someone reaching for Math.random later: replacing it with a
  // thrower must not change any result.
  const original = Math.random;
  Math.random = (): number => {
    throw new Error('Math.random is banned in the solver: use createRng(seed)');
  };
  try {
    const scene = makeScene(55, SMALL);
    const corrs = generateCorrespondences(scene.truth, STRIDE);
    const res = solveFromCorrespondences(
      scene.nominal,
      scene.cameraInputs,
      corrs,
      floorRefs(scene),
    );
    assert.ok(res.diagnostics.rmsResidualPx < 1);
  } finally {
    Math.random = original;
  }
});

test('the PRNG stream does not depend on how it is consumed', () => {
  // nextInt and nextFloat must draw from the same stream in the same order, or a
  // refactor that swaps one for the other silently changes every RANSAC sample.
  const a = createRng(4242);
  const b = createRng(4242);
  const viaFloat: number[] = [];
  for (let i = 0; i < 20; i++) viaFloat.push(Math.min(9, Math.floor(a.nextFloat() * 10)));
  const viaInt: number[] = [];
  for (let i = 0; i < 20; i++) viaInt.push(b.nextInt(10));
  assert.deepEqual(viaFloat, viaInt);
});
