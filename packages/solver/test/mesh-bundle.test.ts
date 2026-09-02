// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The bundle, solving against a mesh.
 *
 * `BundleOptions.surface` swaps the surface every camera ray is traced against.
 * The model's pose and scale are HELD — a visitor supplies geometry already
 * placed in world coordinates (docs/ARBITRARY-SHAPES.md, Phase 5) — so this is a
 * swap of the surface the existing camera block is differentiated against, not a
 * new parameter block.
 *
 * ## What this file proves, and what proves the other half
 *
 * Here: that a solve against a mesh RECOVERS, and that it is the MESH that made
 * it recover — asserted with a negative control, because the first version of
 * this file asserted only the first half and could not have failed.
 *
 * Tessellation error, measured separately on a tessellated sphere at three
 * refinements (16 128 / 65 024 / 261 120 triangles): 49.42, 16.63 and 2.39 mm.
 * It falls with refinement, as it must — but that curve is NOT evidence the
 * wiring works, because a solve secretly tracing the analytic sphere produces
 * the same curve. That is the trap this file fell into first.
 *
 * Elsewhere: that the sphere path did not move. That cannot be asserted from a
 * unit test, because the thing at risk is the last bit of a float across a
 * twelve-scenario corpus. It is asserted by regenerating `bench-results.json`
 * and comparing it against `bench-baseline.json` — 188 digests, 5 563 347
 * characters — which was run on this change and came back unchanged. `hitAtEpoch`
 * branches on a null check rather than routing the sphere through a shared
 * surface abstraction precisely so that guarantee is cheap to keep.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SurfaceMesh } from '../../calibration/src/index.ts';
import type { FloorReference } from '../src/bundle.ts';
import { bundleStateFromCalibration, solveFromCorrespondences } from '../src/index.ts';
import { buildMeshIndex } from '../src/mesh.ts';
import {
  alignToTruth,
  generateCorrespondences,
  makeScene,
  scoreRecovery,
  type Scene,
} from './synthetic.ts';

/**
 * A UV ellipsoid: a sphere flattened along z by `squash`.
 *
 * `squash = 1` is the sphere, and that case is USELESS as a fixture — which is
 * the whole reason this function takes the parameter. The first version of this
 * file solved against a tessellated sphere and asserted recovery, and the
 * assertion passed just as happily with the mesh disconnected: tracing the
 * analytic sphere instead of a fine tessellation OF that sphere gives nearly the
 * same answer, so the test could not tell a wired solve from an unwired one.
 * Measured at `squash = 1`, the disconnected solve was actually BETTER —
 * 4.83 mm against 7.41 mm.
 *
 * A 10% flattening breaks that. It is still a shape the sphere-shaped nominal
 * can bootstrap from, so the solve converges; and it is different enough that a
 * solve tracing a sphere is answering about the wrong surface, which the test
 * below asserts as its own negative control rather than trusting.
 */
function ellipsoid(radiusM: number, squash: number, nLat: number, nLon: number): SurfaceMesh {
  const positions: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const theta = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const phi = (2 * Math.PI * j) / nLon;
      positions.push(
        radiusM * Math.sin(theta) * Math.cos(phi),
        radiusM * Math.sin(theta) * Math.sin(phi),
        radiusM * squash * Math.cos(theta),
      );
    }
  }
  const at = (i: number, j: number): number => i * nLon + (j % nLon);
  const indices: number[] = [];
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i !== 0) indices.push(a, b, d);
      if (i !== nLat - 1) indices.push(b, c, d);
    }
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: `ellipsoid-${squash}`,
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

function floorAtEveryLens(scene: Scene): FloorReference[] {
  return scene.truth.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM: p.position.z + scene.truth.centerHeightM,
    sigmaM: 0.002,
  }));
}

test('a solve against a mesh recovers the rig, and the same corpus against the sphere does not', () => {
  // The end-to-end claim, with its own negative control, because the first
  // version of this test had none and could not have failed.
  //
  // One corpus, traced against the ellipsoid, solved twice: once with the mesh
  // wired in and once with `surface` omitted. If the wiring were inert the two
  // would agree. Measured on seed 1 at a 10% flattening: 2.95 mm and 0.0131 deg
  // wired, against 791.75 mm and 2.6987 deg unwired — 268 times apart.
  //
  // The corpus and the solve share ONE forward model on purpose. Generating
  // correspondences against one surface and solving against another measures the
  // difference between two fixtures and calls it a recovery error — which is
  // exactly what the unwired arm below is doing, deliberately.
  const scene = makeScene(1);
  const index = buildMeshIndex(ellipsoid(scene.truth.radiusM, 0.9, 192, 384));
  const corrs = generateCorrespondences(scene.truth, {
    surface: index,
    noisePx: 0,
    sigmaPx: 0.02,
  });
  assert.ok(corrs.length > 1000, `only ${corrs.length} correspondences`);

  const solve = (surface: ReturnType<typeof buildMeshIndex> | null): ReturnType<typeof scoreRecovery> => {
    const res = solveFromCorrespondences(
      scene.nominal,
      scene.cameraInputs,
      corrs,
      floorAtEveryLens(scene),
      { bundle: { tieProjectorFov: false, surface } },
    );
    const state = {
      ...bundleStateFromCalibration(res.calibration, []),
      cameras: res.extra.cameras,
    };
    return scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
  };

  const wired = solve(index);
  const unwired = solve(null);

  // It recovers. Every part has to be right together for this to happen at all:
  // the traversal, the derivative, the assembly and the gauge.
  assert.ok(
    wired.maxProjectorPositionM < 0.02,
    `the mesh solve did not recover: ${(1000 * wired.maxProjectorPositionM).toFixed(2)} mm`,
  );
  assert.ok(
    wired.maxProjectorRotationDeg < 0.05,
    `mesh rotation ${wired.maxProjectorRotationDeg.toFixed(4)} deg`,
  );

  // And the surface is what did it. A ratio, not an absolute: the point is that
  // these two answers are nothing like each other.
  const ratio = unwired.maxProjectorPositionM / wired.maxProjectorPositionM;
  assert.ok(
    ratio > 20,
    `solving the same corpus against the sphere gave ` +
      `${(1000 * unwired.maxProjectorPositionM).toFixed(2)} mm against the mesh solve's ` +
      `${(1000 * wired.maxProjectorPositionM).toFixed(2)} mm — only ${ratio.toFixed(1)}x, so this ` +
      'fixture cannot tell a wired solve from an unwired one',
  );
});

test('omitting `surface` is the sphere, and is what every existing caller gets', () => {
  // The guarantee the whole change rests on: `buildProblem` resolves
  // `opts.surface ?? null`, and `hitAtEpoch` branches on that null before
  // touching any arithmetic. A solve that passes no surface runs the code it ran
  // before, and the twelve-scenario baseline confirms it to the last bit.
  const scene = makeScene(1);
  const corrs = generateCorrespondences(scene.truth, { noisePx: 0, sigmaPx: 0.02 });
  const res = solveFromCorrespondences(
    scene.nominal,
    scene.cameraInputs,
    corrs,
    floorAtEveryLens(scene),
    { bundle: { tieProjectorFov: false } },
  );
  const state = {
    ...bundleStateFromCalibration(res.calibration, []),
    cameras: res.extra.cameras,
  };
  const score = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
  assert.ok(
    score.maxProjectorPositionM < 0.002,
    `the sphere path regressed: ${(1000 * score.maxProjectorPositionM).toFixed(3)} mm`,
  );
});


test('the bootstrap reaches a good basin on a mesh, within the envelope it has', () => {
  // The bootstrap is `initialize.ts`, and this asserts the whole ladder end to
  // end: it starts from PARAMETERS.md nominals, sweeps `d_proj`, re-derives each
  // projector three ways, and hands the full solve a state. If any rung were
  // still consulting a sphere where it should consult the mesh, or if the sweep
  // landed in the wrong basin, the recovery below would not happen.
  //
  // ENVELOPE, and it is a real one. This passes on ellipsoids that deviate
  // moderately from a sphere. It does NOT pass on a strongly tri-axial body:
  // measured at 1 : 0.6 : 0.35, the recovered pose is 120-435 mm across six
  // seeds against §7's 2 mm, and tripling the correspondences makes it worse
  // rather than better. See the module docblock in `initialize.ts` for the
  // measurements and the hypothesis. That failure is deliberately NOT asserted
  // here — a test that pins a known-bad number turns a research problem into a
  // green tick.
  const scene = makeScene(1);
  for (const squash of [0.9, 0.7]) {
    const index = buildMeshIndex(ellipsoid(scene.truth.radiusM, squash, 192, 384));
    const corrs = generateCorrespondences(scene.truth, {
      surface: index,
      noisePx: 0,
      sigmaPx: 0.02,
    });
    const res = solveFromCorrespondences(
      scene.nominal,
      scene.cameraInputs,
      corrs,
      floorAtEveryLens(scene),
      { bundle: { tieProjectorFov: false, surface: index } },
    );
    const state = {
      ...bundleStateFromCalibration(res.calibration, []),
      cameras: res.extra.cameras,
    };
    const score = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
    // Measured 2.95 mm at 0.9 and 0.88 mm at 0.7 on this seed. The bound is
    // loose enough to survive a re-tuned rung without being loose enough to
    // survive the ladder landing in the wrong basin, which costs hundreds.
    assert.ok(
      score.maxProjectorPositionM < 0.01,
      `squash ${squash}: bootstrap+solve recovered ${(1000 * score.maxProjectorPositionM).toFixed(2)} mm`,
    );
    assert.ok(
      score.maxProjectorRotationDeg < 0.05,
      `squash ${squash}: rotation ${score.maxProjectorRotationDeg.toFixed(4)} deg`,
    );
  }
});
