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
import { bootstrap } from '../src/initialize.ts';
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

/**
 * A UV ellipsoid with three DIFFERENT semi-axes.
 *
 * `ellipsoid` above squashes one axis, which leaves the body rotationally
 * symmetric about z — a real shape, and useless for asking whether the solve can
 * recover a rotation the sphere hides, because it hides that rotation too.
 * Scaling y as well removes the symmetry and makes every global rotation
 * observable.
 */
function triaxialEllipsoid(
  radiusM: number,
  scaleY: number,
  scaleZ: number,
  nLat: number,
  nLon: number,
): SurfaceMesh {
  const positions: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const theta = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const phi = (2 * Math.PI * j) / nLon;
      positions.push(
        radiusM * Math.sin(theta) * Math.cos(phi),
        radiusM * scaleY * Math.sin(theta) * Math.sin(phi),
        radiusM * scaleZ * Math.cos(theta),
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
    name: `triaxial-${scaleY}-${scaleZ}`,
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
  // This used to carry an ENVELOPE: "it does NOT pass on a strongly tri-axial
  // body: measured at 1 : 0.6 : 0.35, the recovered pose is 120-435 mm across
  // six seeds." That failure was real and it was not the bootstrap's — the
  // gauge in `bundle.ts` was pinning three rotations the mesh determines, and
  // freezing them froze what this ladder handed over. The tri-axial fixture now
  // recovers to 7.6e-11 mm from this same unchanged bootstrap, and it is
  // asserted directly in the gauge test below.
  //
  // The two squash factors stay because they are the cases where the gauge
  // correctly does NOT stand down: an oblate spheroid is symmetric about z, so
  // its azimuth really is unobservable and the numbers below are the gauge's
  // residue rather than a solver error.
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

test('the gauge measures the model it was handed, and pins only what that model leaves free', () => {
  // The inner gauge exists because a SPHERE is rotationally symmetric: rotate
  // every projector and camera about the centre and no correspondence residual
  // moves, so three directions carry no information and the normal matrix is
  // singular along them. `gaugeUnobserved` used to establish that by asking the
  // floor references alone, which was exactly right for as long as the first
  // half of that sentence was — the correspondences could not tell one global
  // rotation from another, so the floor was the only thing that could.
  //
  // A held mesh breaks it. The model stays in world coordinates while the rig
  // turns, so the traced points move across the geometry and the
  // correspondences DO see the rotation. Asking only the floor then pins a
  // direction the data determines, and because the gauge is pure damping — it
  // adds to `jtj`, never to `jtr` — pinning it freezes whatever the bootstrap
  // handed over, which is PARAMETERS.md §2's nominal azimuth.
  //
  // Both arms below are the assertion. The first alone would pass a solver that
  // simply stopped gauging meshes, and that solver would be wrong: an oblate
  // spheroid IS rotationally symmetric about z, tessellated or not, and freeing
  // its azimuth would leave the normal matrix singular in exactly the way the
  // gauge exists to fix. What has to hold is that the same test gives opposite
  // answers on the two shapes.
  const scene = makeScene(1);
  const run = (mesh: SurfaceMesh): { score: ReturnType<typeof scoreRecovery>; gauge: number } => {
    const index = buildMeshIndex(mesh);
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
    return {
      score: scoreRecovery(alignToTruth(state, scene.truth), scene.truth),
      gauge: res.extra.gaugeConstraints,
    };
  };

  // A tri-axial body determines all three rotations, so nothing should be
  // pinned. Measured stiffness on the azimuth direction: 1.9e-5, against the
  // 1e-6 tolerance. With the direction pinned this fixture recovered 133.4,
  // 119.9 and 287.2 mm on seeds 1-3; with it left to the data, 7.6e-11.
  const triaxial = run(triaxialEllipsoid(scene.truth.radiusM, 0.6, 0.35, 192, 384));
  assert.equal(
    triaxial.gauge,
    0,
    `a tri-axial body determines every global rotation, but the gauge pinned ` +
      `${triaxial.gauge} of them`,
  );
  assert.ok(
    triaxial.score.maxProjectorPositionM < 0.002,
    `tri-axial recovered ${(1000 * triaxial.score.maxProjectorPositionM).toFixed(3)} mm`,
  );

  // An oblate spheroid does not. Its azimuth is unobservable in fact, and the
  // only thing a tessellation of one adds is the accident of where the facets
  // fell — 7.9e-9 of stiffness, four orders below where this gauge lets a
  // direction go. It must still be pinned.
  const oblate = run(ellipsoid(scene.truth.radiusM, 0.9, 192, 384));
  assert.equal(
    oblate.gauge,
    1,
    `an oblate spheroid is symmetric about z and its azimuth must stay pinned, ` +
      `but the gauge pinned ${oblate.gauge} directions`,
  );
});

test('rung 1 sweeps one shared radius along nominal bearings, and neither assumption binds', () => {
  // `initialize.ts` used to name rung 1 as the reason a strongly aspherical body
  // failed: "rung 1 collapses the search to one dimension by placing every
  // projector at ONE distance along its NOMINAL bearing. That collapse needs the
  // object to be roughly centrally symmetric about the origin, and a tri-axial
  // body is not." The real defect was the gauge, and that hypothesis was written
  // without a fixture that could test it. This is the fixture.
  //
  // It violates BOTH halves of the assumption at once, well past anything a real
  // site would produce. The distances span 4.41 to 6.45 m — wider than
  // PARAMETERS.md §2's whole 5.0-6.5 m prior, which is the range the sweep
  // searches — and the bearings are swung 15 to 35 degrees off §2's
  // 0/90/180/270, against the 1-2 degree mount tolerance §2 states. The surface
  // is the tri-axial body the old hypothesis was about.
  //
  // What the test asserts is the interesting half: the sweep's single answer is
  // WRONG for every projector, and the rig is recovered anyway. The shared radius
  // is where rung 1 starts its camera-only fit, not a constraint it imposes on
  // the answer.
  //
  // What recovers it is NOT what the module docblock's next sentence would lead
  // you to expect. That sentence says rung 2's DLT is "what makes the bootstrap
  // robust to a rig that is not laid out the way §2 says". Mutating rung 2 to
  // offer NO alternative candidate at all — no footprint, no DLT, so a projector
  // can only ever be the one it started as — leaves this test passing. On this
  // fixture the short LM settle inside rung 2, and the full solve after it, do
  // the work. So this asserts end-to-end robustness to an off-nominal rig and
  // does not attribute it; the DLT's own claim still has no fixture.
  //
  // It is not a test that cannot fail: reverting the gauge's data-observability
  // test takes this same fixture to 1669.6 mm.
  const scene = makeScene(1);
  const spread = [0.85, 1.0, 1.12, 1.25];
  const swingDeg = [30, -20, 15, -35];
  scene.truth.projectors.forEach((p, i) => {
    const a = (swingDeg[i] * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = p.position.x * spread[i];
    const y = p.position.y * spread[i];
    p.position = { x: c * x - s * y, y: s * x + c * y, z: p.position.z * spread[i] };
    p.yawDeg += swingDeg[i];
  });

  const index = buildMeshIndex(triaxialEllipsoid(scene.truth.radiusM, 0.6, 0.35, 192, 384));
  const corrs = generateCorrespondences(scene.truth, {
    surface: index,
    noisePx: 0,
    sigmaPx: 0.02,
  });
  const floor = floorAtEveryLens(scene);

  const boot = bootstrap(
    bundleStateFromCalibration(scene.nominal, scene.cameraInputs),
    corrs,
    floor,
    {},
    { tieProjectorFov: false, surface: index },
    [],
  );

  // The sweep picks ONE distance, and it is wrong for every projector — measured
  // 5.00 m against truths of 4.41, 5.16, 5.83 and 6.45. If a future rung 1 ever
  // searched per-projector distances this assertion would start failing, which is
  // the right way for it to fail: the claim below would then need re-measuring
  // rather than silently resting on a rung that no longer works this way.
  for (const p of scene.truth.projectors) {
    const truthD = Math.hypot(p.position.x, p.position.y, p.position.z);
    assert.ok(
      Math.abs(truthD - boot.selectedDistanceM) > 0.1,
      `the sweep chose ${boot.selectedDistanceM.toFixed(2)} m and a projector sits at ` +
        `${truthD.toFixed(2)} m — this fixture no longer violates the shared-radius assumption`,
    );
  }

  const res = solveFromCorrespondences(scene.nominal, scene.cameraInputs, corrs, floor, {
    bundle: { tieProjectorFov: false, surface: index },
  });
  const state = {
    ...bundleStateFromCalibration(res.calibration, []),
    cameras: res.extra.cameras,
  };
  const score = scoreRecovery(alignToTruth(state, scene.truth), scene.truth);
  // Measured 1.4e-10 mm on this seed.
  assert.ok(
    score.maxProjectorPositionM < 0.002,
    `off-nominal rig recovered ${(1000 * score.maxProjectorPositionM).toFixed(4)} mm`,
  );
});

test('with few floor references the gauge still pins exactly the direction the shape hides', () => {
  // The branch below the one the test above reaches. With four floor references
  // exactly one rotation survives the floor test — the azimuth — so the verdict
  // is a single yes or no. Supply FEWER and two or three survive together, and
  // `gaugeUnobserved` has to decide among them as a subspace.
  //
  // An oblate spheroid is the fixture because its answer is not symmetric: it is
  // rotationally symmetric about z, so its azimuth is unobservable in fact,
  // while a TILT of it is plainly visible. Exactly one of the two survivors must
  // be pinned, and a solver that pinned both or neither is wrong in a way this
  // catches — both mutations fail it.
  //
  // ## What this test does NOT establish, having been checked
  //
  // Two properties of that branch are argued rather than demonstrated here, and
  // the difference matters because the comment on this test asserted both before
  // the mutations were run.
  //
  // The MIXING — reading the verdict off eigenvectors of the stiffness form
  // rather than off each survivor alone — is not discriminated. Replacing the
  // eigendecomposition with a per-survivor test still passes, because on this
  // fixture the individual stiffnesses (1.18e-6 and 5.20e-9) already straddle
  // the 1e-6 tolerance and give the same count. The mixing is still right:
  // measured with no floor references, the survivors carry 1.18e-6, 9.95e-7 and
  // 5.20e-9 while the eigenvalues are 5.02e-9, 7.85e-7 and 1.39e-6 — the
  // smallest is BELOW every individual survivor, so the direction the data
  // cannot see is genuinely a combination. It just does not change a COUNT on
  // any fixture in this repository.
  //
  // The WHITENING is not discriminated either. `gaugeUnobserved` solves the
  // generalised problem `S w = lambda D w` against the survivors' own overlap
  // because they are not mutually orthogonal — measured off-diagonals of 0.0034
  // and -0.0031 on this rig, from packing metres of position and degrees of yaw
  // into one vector. Without it the eigenvalue is stiffness times squared
  // length while the direction returned is normalised. Measured, the two part
  // company by about 0.4% (naive 2.72e-5 and 1.20e-4 against generalised 2.71e-5
  // and 1.21e-4, at two floor references where the overlap is 4.65e-3), and no
  // verdict on any fixture here turns on 0.4%. A fixture that separated them
  // would be one tuned until a stiffness sat within 0.4% of the tolerance, which
  // would test the tolerance rather than the code.
  //
  // So: this asserts the branch reaches the right answer, and the argument plus
  // those measurements carry the rest. Saying so is better than a test name that
  // claims the coverage it does not have.
  const scene = makeScene(1);
  const index = buildMeshIndex(ellipsoid(scene.truth.radiusM, 0.9, 192, 384));
  const corrs = generateCorrespondences(scene.truth, {
    surface: index,
    noisePx: 0,
    sigmaPx: 0.02,
  });

  const gaugeWith = (floorCount: number): number => {
    const res = solveFromCorrespondences(
      scene.nominal,
      scene.cameraInputs,
      corrs,
      floorAtEveryLens(scene).slice(0, floorCount),
      { bundle: { tieProjectorFov: false, surface: index } },
    );
    return res.extra.gaugeConstraints;
  };

  // One floor reference: two directions survive it, and the mixed branch runs.
  // Measured eigenvalues 5.02e-9 and 1.18e-6 against the 1e-6 tolerance — the
  // spheroid's azimuth pinned, its tilt left to the data.
  assert.equal(
    gaugeWith(1),
    1,
    'an oblate spheroid hides its azimuth and shows its tilt, so exactly one of ' +
      'the two directions surviving a single floor reference should be pinned',
  );

  // And four references, where the floor test alone leaves one direction and the
  // mixed branch is never entered. Same answer by a different route, which is
  // what makes the first assertion a statement about the mixing rather than
  // about the shape.
  assert.equal(gaugeWith(4), 1, 'the azimuth is still the one pinned direction at four references');
});
