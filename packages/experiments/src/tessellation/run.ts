// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 7's sweep. Pure: it returns one object per point and writes nothing.
 *
 * Every arm is built from the SAME archetype — `nominal` — and overrides only
 * `surface`. Not from `mesh`, even though `mesh` is the archetype whose name
 * matches: `mesh` pairs with `nominal` and so draws the same seed, but going
 * through `nominal` for every arm makes the shared rig structural rather than a
 * claim about the pairing table. The RNG stream is identical across arms, so the
 * distances, the camera placements, the injected misalignment and the photons
 * are the same objects; the representation of the body is the only thing that
 * moves. Nothing downstream branches on the archetype's NAME — `run.ts` gates
 * everything on `surface === null` — so `nominal` with a surface is a
 * well-defined scenario rather than a smuggled one.
 */

import { deriveSeed } from '../../../bench/src/random.ts';
import { ARCHETYPE_NAMES, PRESETS, makeScenario } from '../../../bench/src/scenarios.ts';
import { buildWorld, runScenario } from '../../../bench/src/run.ts';
import { ellipsoidMesh } from '../../../bench/src/surfaces.ts';
import type { Arm } from './design.ts';
import { EXPERIMENT_ROOT_SEED, TIGHT_SIGMA } from './design.ts';

/** Scenario seed for sweep index `i`. The documented seeds are passed directly. */
export function seedFor(i: number): number {
  return deriveSeed(EXPERIMENT_ROOT_SEED, `tessellation/${i}`);
}

export interface PointRun {
  arm: string;
  seed: number;
  /** True when this seed is the one every recorded figure names. */
  documented: boolean;
  /**
   * Worst projector position error, gauge-aligned.
   *
   * Reported first because every figure in the record this starts from is in
   * millimetres of position, so it is the column a reader will come looking for.
   * It is NOT on its own the subject; see the next field.
   */
  posePositionMm: number;
  /**
   * Worst projector rotation error, roll included, gauge-aligned.
   *
   * EQUALLY THE SUBJECT, and the document says why in its own words: "Every
   * refutation above was judged on POSITION, and re-reading them on rotation"
   * reversed one of them. §7 gates both at once, `recovery.aligned` carries both,
   * and the sixty-seed sweep that settled `meshNormal` found no separable effect
   * on position and the largest effect in the document on rotation. An
   * experiment here that reported position alone would repeat the mistake that
   * sweep's own pre-registration made and had to correct.
   */
  poseRotationDeg: number;
  /**
   * Residual RMS in pixels.
   *
   * A-18's pairing, and not an afterthought: pose error leaving for no residual
   * is a degeneracy, pose error leaving for a lot of residual is a different
   * fit, and only the pair distinguishes them. It also separates the two ways a
   * facet normal could cost something — a mis-steered step that still lands
   * (residual flat, pose worse) from a fit the facets will not let close
   * (residual up too).
   */
  residualRmsPx: number;
  converged: boolean;
  /**
   * WHY the loop stopped, not merely whether it liked where it landed.
   *
   * `converged` alone is a fact with no cause attached, and this document's own
   * history is a run of causes asserted over one: the 400-iteration cap read as
   * a tessellation cost, and a `lambda` stop read as an inexact Jacobian
   * upsetting Levenberg-Marquardt, refuted later by a perfectly consistent pair
   * stopping the same way. `maxIterations` is the record's defect, `plateau` is
   * the rule that retired it, and `lambda` is the smooth mode's early exit —
   * which the record measures reaching a LOWER cost than the facet solve that
   * converged, on one seed. Three different things, and one boolean for all of
   * them invites exactly the guess this experiment exists to stop making.
   */
  stopReason: string;
  /**
   * How many directions the stiffness test found unobservable and froze.
   *
   * A sphere is a body the record says PINS — every spheroid does, every
   * tri-axial frees — and a pinned direction is held by a soft prior rather than
   * by the data. If the two normals land apart at equal residual, this is the
   * column saying there was a direction available for them to land apart along.
   */
  gaugeConstraints: number;
  /** True when this arm pinned lens shift at truth. Carried so a row says so. */
  shiftKnown: boolean;
  /**
   * Steps taken.
   *
   * The record's defect was a solve running to the 400-iteration cap, so this
   * column is what says whether the thing being measured is the same thing.
   */
  iterations: number;
  /** Triangles in the body, 0 for the analytic sphere. The mechanism's x-axis. */
  facets: number;
  /**
   * The gauge-aligned pose error broken out per projector and per axis.
   *
   * WHICH DIRECTION CARRIES THE ERROR, which `docs/ARBITRARY-SHAPES.md` left
   * open in the same breath as the reading this experiment tests — "which
   * directions carry the error has not been measured; this is the reading, not
   * the proof" — and which experiment 7's first pass could not answer because it
   * recorded only the worst projector's total.
   *
   * Nothing new is computed for it. `poseErrors` in the bench has always
   * returned these components and `scoreRecovery` gauge-aligns before it does,
   * so this is the result object being written down rather than a measurement
   * being invented.
   *
   * A caution the summary depends on: `rotationDeg` is the angle between two
   * rotation MATRICES and the three Euler differences beside it do not sum to
   * it. They say which axis carries the larger error; they are not an orthogonal
   * decomposition of it, and nothing here may add them up.
   */
  perProjector: {
    id: string;
    positionMm: number;
    rotationDeg: number;
    dxMm: number;
    dyMm: number;
    dzMm: number;
    yawDeg: number;
    pitchDeg: number;
    rollDeg: number;
  }[];
  seconds: number;
}

export function runPoint(arm: Arm, seed: number, documented: boolean): PointRun {
  const t0 = Date.now();
  const preset = PRESETS.default;
  const idx = ARCHETYPE_NAMES.indexOf('nominal');
  if (idx < 0) throw new Error('tessellation: no archetype named nominal');
  const scenario = makeScenario(seed, idx, preset);
  if (arm.grid !== null) {
    // A SPHERE mesh: scaleY and scaleZ at 1, so this is the analytic arm's own
    // body at the analytic arm's own radius, tessellated. The `mesh` archetype's
    // 1 : 0.8 : 0.6 ellipsoid would change the shape and the representation at
    // once, which is the comparison this experiment exists to avoid.
    //
    // NOT "and nothing else differs" — that is the record's phrase and it is
    // wrong. `ellipsoidMesh` interpolates the sphere rather than approximating
    // it, so every facet lies inside: `radiusDeficitMm` below measures how far,
    // and the design says what the arms can and cannot conclude because of it.
    scenario.surface = { kind: 'ellipsoid', scaleY: 1, scaleZ: 1, ...arm.grid };
  }
  const result = runScenario(scenario, {
    preset,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
    // Passed on every arm including the analytic one, where it is inert: the
    // flag reaches the bundle's mesh Jacobian and there is no mesh.
    meshNormal: arm.meshNormal,
    // Both knobs together or neither — see `Arm.shiftKnown`. Splitting them is
    // the A-16 error A-18 named, and the object literal is the only place the
    // pairing could be broken, so it is made here and not at the call sites.
    ...(arm.shiftKnown === true
      ? { shiftFromTruth: true, priors: { shiftSigma: TIGHT_SIGMA } }
      : {}),
  });

  return {
    arm: arm.key,
    seed,
    documented,
    posePositionMm: result.recovery?.aligned.maxPositionMm ?? NaN,
    poseRotationDeg: result.recovery?.aligned.maxRotationDeg ?? NaN,
    residualRmsPx: result.solver?.diagnostics.rmsResidualPx ?? NaN,
    converged: result.solver?.diagnostics.converged ?? false,
    stopReason: result.solver?.extra.stopReason ?? 'no-solve',
    gaugeConstraints: result.solver?.extra.gaugeConstraints ?? -1,
    shiftKnown: arm.shiftKnown === true,
    iterations: result.solver?.diagnostics.iterations ?? -1,
    facets: arm.grid === null ? 0 : arm.grid.nLat * arm.grid.nLon * 2,
    perProjector: (result.recovery?.aligned.perProjector ?? []).map((p) => ({
      id: p.id,
      positionMm: p.positionMm,
      rotationDeg: p.rotationDeg,
      dxMm: p.dxMm,
      dyMm: p.dyMm,
      dzMm: p.dzMm,
      yawDeg: p.yawDeg,
      pitchDeg: p.pitchDeg,
      rollDeg: p.rollDeg,
    })),
    seconds: (Date.now() - t0) / 1000,
  };
}

/**
 * How far inside the sphere a grid's facets actually sit, in millimetres.
 *
 * This BOUNDS THE CONTROL CONFOUND, which is the one thing the `vs control`
 * column cannot do for itself. `ellipsoidMesh` puts every vertex exactly on the
 * sphere of the rig's radius, so every facet lies inside it: the analytic arm
 * and a mesh arm do not photograph the same body, and the difference between
 * them is the representation AND the body. Stating how much body is a number
 * anybody can check, where "changes the representation and nothing else" is an
 * argument that happens to be false.
 *
 * Measured at triangle centroids rather than derived: the mesh the solve used
 * is the mesh this walks, so a change to `ellipsoidMesh` moves this figure
 * instead of leaving a stale one behind. The centroid is inside the facet, so
 * `max` is a lower bound on the deepest point of the facet, not an upper one —
 * which is the safe direction for a number used to say the confound is SMALL.
 */
export function radiusDeficitMm(
  grid: { nLat: number; nLon: number },
  radiusM: number,
): { mean: number; max: number } {
  const mesh = ellipsoidMesh({ kind: 'ellipsoid', scaleY: 1, scaleZ: 1, ...grid }, radiusM);
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t + k] * 3;
      x += mesh.positions[v];
      y += mesh.positions[v + 1];
      z += mesh.positions[v + 2];
    }
    const r = Math.hypot(x / 3, y / 3, z / 3);
    // A degenerate triangle — the pole fan collapses one — has a centroid on the
    // axis and a meaningless deficit, so it is skipped rather than averaged in.
    if (!Number.isFinite(r) || r <= 0) continue;
    const d = (radiusM - r) * 1000;
    sum += d;
    if (d > max) max = d;
    n++;
  }
  return n === 0 ? { mean: NaN, max: NaN } : { mean: sum / n, max };
}

/**
 * The rig's sphere radius, which every arm shares.
 *
 * Read off a world built with NO surface, so nothing here builds a mesh or a
 * hierarchy to answer a question about a scalar. `injectMisalignment` perturbs
 * the sphere's centre height and not its radius, so this is one number for the
 * whole experiment rather than one per seed.
 */
export function rigRadiusM(): number {
  const preset = PRESETS.default;
  const idx = ARCHETYPE_NAMES.indexOf('nominal');
  return buildWorld(makeScenario(DEFAULT_RADIUS_SEED, idx, preset)).truthRig.sphere.radiusM;
}

/** Any seed: the radius does not depend on one. Named so that is on the record. */
const DEFAULT_RADIUS_SEED = 1;

/** Median, because one diverged seed should not decide an arm's headline. */
export function median(xs: readonly number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function worst(xs: readonly number[]): number {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length === 0 ? NaN : Math.max(...v);
}
