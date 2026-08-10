/**
 * Naming the single largest contributor to a gate failure — by measurement.
 *
 * docs/ARCHITECTURE.md's loop protocol: "When a metric fails its gate, the
 * critic names the single largest contributor and that piece goes back." That
 * instruction is only as good as the naming, and the naming is where a bench
 * quietly turns into an opinion. The obvious approach — rank the recovered
 * parameter errors against their own tolerances and blame the biggest ratio —
 * is a guess wearing a number: grid displacement is not linear in either pose
 * error or field-of-view error, the two interact through the projector's
 * frustum, and a 40x position error and a 3x rotation error are not comparable
 * quantities in the first place.
 *
 * So the bench substitutes instead of ranking. Take the recovered calibration,
 * replace ONE parameter group with ground truth, recompute the failing metric,
 * and see how much of the failure disappears. The group whose substitution
 * removes the most is the largest contributor by construction. It costs one
 * metric evaluation per group and it answers the question that was actually
 * asked.
 *
 * Two bookends make the answer readable. `none` reproduces the reported value,
 * which is a self-check: if it does not, something about the rebuild is wrong
 * and the attribution should be distrusted rather than believed. `all` replaces
 * the entire calibration with ground truth, so whatever failure survives it is
 * NOT in the recovered calibration at all — it is the measurement floor of the
 * apparatus, or the physical rig, and sending a solver piece back to fix it
 * would waste a round.
 *
 * Run on the worst failing scenario for each failing gate, not on all of them.
 * The loop asks for one name per failing gate, and the worst scenario is where
 * that name is least ambiguous.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import { GATES } from '../../calibration/src/parameters.ts';
import { gateById } from '../../sim/src/metrics/index.ts';
import { computeGridDisplacement } from '../../sim/src/metrics/grid.ts';
import type { GateAttribution } from './results.ts';
import type { ScenarioResult } from './run.ts';
import { buildWorld } from './run.ts';
import type { BenchPreset } from './scenarios.ts';
import { HYBRID_GROUPS, hybridCalibration } from './score.ts';

/**
 * Which metrics can be attributed at all.
 *
 * Only `grid_displacement` is both scored and a function of the recovered
 * calibration. Off-sphere flux and the unlit-within-the-mask fraction are
 * computed from the PHYSICAL rig alone — they describe where the lenses point,
 * not what the compositor believes — so no substitution into the recovered
 * calibration can move them, and pretending otherwise would send the loop
 * chasing a solver bug that is really a mounting error.
 */
export function canAttribute(gateId: string): boolean {
  return (
    gateId === 'grid_displacement' ||
    gateId === 'pose_position' ||
    gateId === 'pose_rotation' ||
    gateId === 'h_center_recovery'
  );
}

/**
 * Attribute a pose-recovery failure by DECOMPOSING the error, not by
 * substituting into it.
 *
 * A pose gate cannot be attributed the way `grid_displacement` is: the metric
 * IS the recovered pose, so substituting ground truth for it drives the value to
 * zero by definition and says nothing. What can be measured instead is the
 * error's direction, and the directions are not interchangeable:
 *
 *  - **radial** — along the horizontal line from the sphere centre to the lens.
 *    `packages/solver`'s README measures this one specifically: a long-throw
 *    lens sees the sphere subtend about 19 degrees, so field of view and
 *    distance are nearly degenerate and decode noise maps almost entirely into
 *    this axis. A radial-dominated failure points at the `fov-held` question,
 *    not at the bundle.
 *  - **tangential** — azimuthal, perpendicular to radial in the horizontal
 *    plane. This is the direction the gauge lives in, so a tangential-dominated
 *    failure after gauge alignment means the network really is twisted rather
 *    than merely rotated.
 *  - **vertical** — along `+Z`, coupled to `h_center` through the floor
 *    references (§8 item 1).
 *
 * Aggregated over every projector of every failing scenario rather than over
 * the single worst, because one projector's worst draw is a sample and the loop
 * needs the systematic term.
 */
export function attributePoseFailure(
  results: readonly ScenarioResult[],
  failedScenarioIds: readonly string[],
  kind: 'position' | 'rotation',
  gateMax: number,
): GateAttribution | null {
  const failing = results.filter((r) => failedScenarioIds.includes(r.scenario.id));
  if (failing.length === 0) return null;

  const sums = new Map<string, number>();
  const bump = (key: string, v: number): void => {
    sums.set(key, (sums.get(key) ?? 0) + v * v);
  };
  let n = 0;
  let worstValue = 0;
  let worstScenario = failing[0].scenario.id;

  for (const r of failing) {
    if (r.recovery === null) continue;
    const truthProjectors = r.recovery.aligned.perProjector;
    for (let i = 0; i < truthProjectors.length; i++) {
      const e = truthProjectors[i];
      n++;
      if (kind === 'rotation') {
        bump('yaw', e.yawDeg);
        bump('pitch', e.pitchDeg);
        bump('roll', e.rollDeg);
        if (e.rotationDeg > worstValue) {
          worstValue = e.rotationDeg;
          worstScenario = r.scenario.id;
        }
        continue;
      }
      // Decompose the position error in the frame of the TRUE lens: radial and
      // tangential in the horizontal plane, plus vertical.
      const lens = r.alignedRig?.projectors[i]?.pose.position;
      const horiz = lens === undefined ? 0 : Math.hypot(lens.x, lens.y);
      const ux = horiz > 1e-9 && lens !== undefined ? lens.x / horiz : 1;
      const uy = horiz > 1e-9 && lens !== undefined ? lens.y / horiz : 0;
      bump('radial (distance/fov degeneracy)', e.dxMm * ux + e.dyMm * uy);
      bump('tangential (azimuth)', -e.dxMm * uy + e.dyMm * ux);
      bump('vertical (height/h_center)', e.dzMm);
      if (e.positionMm > worstValue) {
        worstValue = e.positionMm;
        worstScenario = r.scenario.id;
      }
    }
  }
  if (n === 0) return null;

  const byGroup = [...sums.entries()]
    .map(([group, sq]) => ({ group, value: Math.sqrt(sq / n) }))
    .sort((a, b) => b.value - a.value);
  const total = Math.sqrt(byGroup.reduce((s, g) => s + g.value * g.value, 0));
  const best = byGroup[0];

  return {
    scenario: worstScenario,
    method:
      'error decomposition: RMS of each component over every projector of every failing scenario, after gauge alignment',
    contributor: best.group,
    explains: `${(100 * (total > 0 ? (best.value * best.value) / (total * total) : NaN)).toFixed(0)}% of the error energy`,
    // What fraction of the error's ENERGY sits in the dominant direction. A
    // value near 1/sqrt(3) would mean the error is isotropic and the
    // decomposition has found nothing worth reporting.
    explainedFraction: total > 0 ? (best.value * best.value) / (total * total) : NaN,
    allGroupsExplain: 1,
    byGroup,
    note:
      `Worst ${kind} error ${worstValue.toFixed(3)} against a gate of ${gateMax}. ` +
      `RMS decomposition over ${n} projector instances: ` +
      byGroup.map((g) => `${g.group} ${g.value.toFixed(3)}`).join(', ') +
      '. An isotropic error would put about a third of the energy in each direction; ' +
      'a dominant direction is a mechanism.',
  };
}

/**
 * `h_center` failures have exactly one interesting question attached, and it is
 * not a decomposition: was the height OBSERVABLE at all?
 *
 * `packages/solver`'s bundle holds `h_center` at its documented nominal when no
 * floor reference is supplied, because nothing in a structured-light capture
 * sees the floor. A failure in that configuration is not a solver defect; it is
 * PARAMETERS.md §8 item 1 not having been carried out.
 */
export function attributeCenterHeightFailure(
  results: readonly ScenarioResult[],
  failedScenarioIds: readonly string[],
  gateMax: number,
): GateAttribution | null {
  const failing = results.filter((r) => failedScenarioIds.includes(r.scenario.id));
  if (failing.length === 0) return null;
  const unobserved = failing.filter((r) => r.recovery?.centerHeight.observed === false);
  const observed = failing.filter((r) => r.recovery?.centerHeight.observed !== false);
  const worst = failing.reduce((a, b) =>
    (a.recovery?.centerHeight.errorMm ?? 0) >= (b.recovery?.centerHeight.errorMm ?? 0) ? a : b,
  );
  const contributor =
    unobserved.length >= observed.length
      ? 'no floor reference (h_center held, not solved)'
      : 'floor-reference noise and network geometry';
  return {
    scenario: worst.scenario.id,
    method: 'observability split: failing scenarios partitioned by whether a floor reference existed',
    contributor,
    explains: `${unobserved.length} of ${failing.length} failing scenarios had no floor reference`,
    explainedFraction: unobserved.length / failing.length,
    allGroupsExplain: 1,
    byGroup: [
      { group: 'no floor reference', value: unobserved.length },
      { group: 'floor reference supplied', value: observed.length },
    ],
    note:
      `${failing.length} scenario(s) over the ${gateMax} mm mark; ${unobserved.length} of them ` +
      'supplied no floor reference at all, in which case the solver holds h_center at the ' +
      'documented 2.1844 m rather than handing the optimiser a parameter it cannot determine. ' +
      'That is PARAMETERS.md §8 item 1 not having been carried out, not a solver defect.',
  };
}

export interface AttributionOptions {
  preset: BenchPreset;
}

export function attributeGridFailure(
  result: ScenarioResult,
  options: AttributionOptions,
): GateAttribution | null {
  if (result.alignedRig === null) return null;
  const gate = gateById(GATES, 'grid_displacement');
  const world = buildWorld(result.scenario);
  const truth: RigCalibration = world.truthRig;

  const byGroup: { group: string; value: number }[] = [];
  for (const group of HYBRID_GROUPS) {
    const content = hybridCalibration(result.alignedRig, truth, group);
    const report = computeGridDisplacement(
      truth,
      content,
      world.scene.maskInterpretation,
      gate,
      { convergence: false, measurementFloor: false },
      options.preset.metricDensityScale,
    );
    byGroup.push({ group, value: report.all.max });
  }

  const valueOf = (group: string): number =>
    byGroup.find((g) => g.group === group)?.value ?? NaN;
  const base = valueOf('none');
  const all = valueOf('all');
  const excess = base - gate.max;
  if (!(excess > 0)) return null;

  let best = 'none';
  let bestDrop = 0;
  for (const g of byGroup) {
    if (g.group === 'none' || g.group === 'all') continue;
    const drop = base - g.value;
    if (drop > bestDrop) {
      bestDrop = drop;
      best = g.group;
    }
  }

  return {
    scenario: result.scenario.id,
    method:
      'counterfactual substitution: one recovered parameter group replaced by ground truth at a time, metric recomputed',
    contributor: best,
    explains: `${((100 * bestDrop) / excess).toFixed(0)}% of the ${excess.toFixed(2)} mm excess over the gate`,
    explainedFraction: bestDrop / excess,
    allGroupsExplain: (base - all) / excess,
    byGroup,
    note:
      `Reported value ${base.toFixed(3)} mm against a ${gate.max} mm gate. Replacing the recovered ` +
      `${best} with ground truth removes ${bestDrop.toFixed(3)} mm of the ${excess.toFixed(3)} mm excess. ` +
      `Replacing the WHOLE calibration leaves ${all.toFixed(3)} mm, which is the apparatus and the ` +
      'physical rig rather than anything a solver can fix — see GridReport.measurementFloorMm. ' +
      'Expect some groups to make the metric WORSE than leaving them alone: a recovered ' +
      'calibration is internally consistent, and substituting one group\'s truth into it breaks ' +
      'that consistency. That is information, not noise — it says the recovered parameters are ' +
      'correlated, which is exactly what a near-degenerate field-of-view/distance pair produces.',
  };
}
