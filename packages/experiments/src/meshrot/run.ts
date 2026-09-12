// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 6's sweep. Pure: it returns one object per point and writes nothing.
 *
 * Like experiment 4's, it assembles nothing itself. It builds a bench `Scenario`
 * through `makeScenario`, overrides only what the arm is about, and hands it to
 * `packages/bench/src/run.ts` — so a disagreement between this and the bench is
 * impossible rather than merely unlikely.
 */

import { deriveSeed } from '../../../bench/src/random.ts';
import { ARCHETYPE_NAMES, PRESETS, makeScenario } from '../../../bench/src/scenarios.ts';
import { buildWorld, runScenario } from '../../../bench/src/run.ts';
import type { Arm, Body } from './design.ts';
import { EXPERIMENT_ROOT_SEED } from './design.ts';

/** Scenario seed for sweep index `i`. The documented seeds are passed directly. */
export function seedFor(i: number): number {
  return deriveSeed(EXPERIMENT_ROOT_SEED, `meshrot/${i}`);
}

export interface PointRun {
  arm: string;
  body: Body;
  seed: number;
  /** True when this seed is one of the three the document reports. */
  documented: boolean;
  /** Worst projector rotation error, roll included, gauge-aligned. The subject. */
  poseRotationDeg: number;
  /** Worst projector position error. Carried to show what the arm costs elsewhere. */
  posePositionMm: number;
  /**
   * Residual RMS in pixels.
   *
   * The other half of A-18's test and not a diagnostic afterthought: error
   * leaving for no residual is a degeneracy, error leaving for a lot of residual
   * is just a different fit, and only the pair distinguishes them.
   */
  residualRmsPx: number;
  converged: boolean;
  iterations: number;
  /**
   * The truth shift this seed actually drew, largest magnitude over projectors.
   *
   * Ground truth, reported and never fed to the solver except in the
   * `shiftFromTruth` arms. Without it the finding is a correlation: a seed whose
   * shift happened to land near zero should show the arms agreeing, and if it
   * does not then shift is not the mechanism.
   */
  truthShiftMax: number;
  seconds: number;
}

export function runPoint(arm: Arm, body: Body, seed: number, documented: boolean): PointRun {
  const t0 = Date.now();
  const preset = PRESETS.default;
  const idx = ARCHETYPE_NAMES.indexOf(body);
  if (idx < 0) throw new Error(`meshrot: no archetype named '${body}'`);
  const scenario = makeScenario(seed, idx, preset);
  const result = runScenario(scenario, {
    preset,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
    ...(arm.shiftSigma > 0 ? { priors: { shiftSigma: arm.shiftSigma } } : {}),
    ...(arm.shiftFromTruth ? { shiftFromTruth: true } : {}),
  });

  // Rebuilt rather than plumbed out: the same pure construction from the same
  // scenario, which is how experiment 4 reads its own mechanism.
  const world = buildWorld(scenario);
  let truthShiftMax = 0;
  for (const p of world.truthRig.projectors) {
    truthShiftMax = Math.max(
      truthShiftMax,
      Math.abs(p.intrinsics.shiftH),
      Math.abs(p.intrinsics.shiftV),
    );
  }

  return {
    arm: arm.key,
    body,
    seed,
    documented,
    poseRotationDeg: result.recovery?.aligned.maxRotationDeg ?? NaN,
    posePositionMm: result.recovery?.aligned.maxPositionMm ?? NaN,
    residualRmsPx: result.solver?.diagnostics.rmsResidualPx ?? NaN,
    converged: result.solver?.diagnostics.converged ?? false,
    iterations: result.solver?.diagnostics.iterations ?? -1,
    truthShiftMax,
    seconds: (Date.now() - t0) / 1000,
  };
}

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
