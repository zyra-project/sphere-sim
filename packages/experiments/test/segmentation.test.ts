// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 5's design and verdict.
 *
 * Mirrors `spill.test.ts`: every falsifier must be able to trigger AND to not
 * trigger, the cuts must be complete, and the figure must be well-formed and
 * self-contained. A falsifier that cannot fire is decoration, and this
 * experiment shipped one — G4's counter was scoped to the wrong arms and read
 * zero while a real failure sat in the arm it did not look at.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ARMS, CUTS, LONG_THROW_INDEX, SEED_COUNT } from '../src/segmentation/design.ts';
import type { Cell, PointRun } from '../src/spill/run.ts';
import { judgeSegmentation } from '../src/segmentation/run.ts';
import { renderSegmentationSvg } from '../src/segmentation/plot.ts';
import { buildResult } from '../src/segmentation/run.ts';

/** A cell whose per-seed values are exactly what the caller says. */
function cell(
  values: number[],
  opts: { offSphereFrac?: number; segmentImage?: boolean; silhouetteFailures?: number } = {},
): Cell {
  const runs: PointRun[] = values.map((v, i) => ({
    wallRadiusM: null,
    minModulation: 0.02,
    segmentMarginFrac: null,
    seedIndex: i,
    seed: 1000 + i,
    correspondences: 10000,
    offSphere: 0,
    offSphereFrac: opts.offSphereFrac ?? 0,
    offSphereWall: 0,
    offSphereFloor: 0,
    offSphereCeiling: 0,
    rejectedLowModulation: 0,
    rejectedOffSphere: 0,
    segmentImage: opts.segmentImage ?? false,
    archetypeIndex: 1,
    rejectedOffImage: 0,
    silhouetteFailures: opts.silhouetteFailures ?? 0,
    posePositionMm: v,
    poseRotationDeg: 0.1,
    gridMm: 1,
    seconds: 1,
  }));
  const sorted = [...values].sort((a, b) => a - b);
  const disp = (vals: number[]) => {
    const s2 = [...vals].sort((a, b) => a - b);
    return { median: s2[Math.floor(s2.length / 2)], min: s2[0], max: s2[s2.length - 1], values: vals };
  };
  return {
    wallRadiusM: null,
    minModulation: 0.02,
    segmentMarginFrac: null,
    n: values.length,
    runs,
    posePositionMm: { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1], values },
    poseRotationDeg: disp(values.map(() => 0.1)),
    offSphereFrac: disp(values.map(() => opts.offSphereFrac ?? 0)),
    correspondences: disp(values.map(() => 10000)),
    offSphereBySurface: { wall: 0, floor: 0, ceiling: 0 },
    gridUsable: values.length,
  };
}

/** A grid where image-space wins everything, so each falsifier is off. */
function healthy(): Record<string, Cell> {
  return {
    clean: cell([20, 25, 30]),
    room: cell([5000, 6000, 7000], { offSphereFrac: 0.15 }),
    // One draw under archetype 1's bar of 30, none under long-throw's 600, so the
    // geometric test genuinely does worse where the nominal is worse and G6 is off.
    geometric: cell([25, 500, 600], { offSphereFrac: 0.012 }),
    image: cell([21, 26, 31], { segmentImage: true }),
    'image-clean': cell([20, 24, 29], { segmentImage: true }),
    'lt-clean': cell([90, 95, 600]),
    'lt-room': cell([4000, 4200, 5000], { offSphereFrac: 0.11 }),
    'lt-geometric': cell([900, 1000, 1100], { offSphereFrac: 0.002 }),
    'lt-image': cell([95, 100, 110], { segmentImage: true }),
  };
}

test('the design pairs every arm on the same seeds and covers both archetypes', () => {
  assert.equal(new Set(ARMS.map((a) => a.key)).size, ARMS.length, 'duplicate arm key');
  const lt = ARMS.filter((a) => a.spec.archetypeIndex === LONG_THROW_INDEX);
  assert.equal(lt.length, 4, 'long-throw needs its own clean arm to set a bar');
  assert.ok(lt.some((a) => a.spec.wallRadiusM === null), 'no long-throw clean arm');
  assert.ok(SEED_COUNT >= 30, 'the whole point of this experiment is not being at n=5');
});

test('every cut names what it costs the conclusion', () => {
  assert.ok(CUTS.length >= 4);
  for (const c of CUTS) {
    assert.ok(c.what.length > 0 && c.why.length > 0);
    assert.ok(c.costsTheConclusion.length > 40, `a cut with no stated cost: ${c.what}`);
  }
  assert.ok(
    CUTS.some((c) => /seed 0|before the falsifiers/i.test(c.what + c.costsTheConclusion)),
    'the pre-registration caveat must survive in the cuts',
  );
});

test('no falsifier fires on a healthy grid', () => {
  const v = judgeSegmentation(healthy());
  assert.equal(v.noContaminationGain, false);
  assert.equal(v.noPoseGain, false);
  assert.equal(v.costsACleanCapture, false);
  assert.equal(v.assumptionFailed, false);
  assert.equal(v.notConsistentlySigned, false);
  assert.equal(v.geometricSurvivesABadNominal, false);
  assert.equal(v.imageDegradesOnABadNominal, false);
});

test('G1 fires when the image test leaves as much contamination as the geometric one', () => {
  const g = healthy();
  g.image = cell([21, 26, 31], { segmentImage: true, offSphereFrac: 0.012 });
  assert.equal(judgeSegmentation(g).noContaminationGain, true);
});

test('G2 fires when the image test does not beat the geometric one on pose', () => {
  const g = healthy();
  g.image = cell([500, 600, 700], { segmentImage: true });
  assert.equal(judgeSegmentation(g).noPoseGain, true);
});

test('G3 fires when the image test costs a clean capture', () => {
  const g = healthy();
  g['image-clean'] = cell([200, 250, 300], { segmentImage: true });
  assert.equal(judgeSegmentation(g).costsACleanCapture, true);
});

test('G4 counts a failure in ANY arm that ran the detector, long-throw included', () => {
  // The bug this pins: scoped to the archetype-1 arms, the counter read zero
  // while a real refusal sat in lt-image.
  const g = healthy();
  g['lt-image'] = cell([95, 100, 110], { segmentImage: true, silhouetteFailures: 1 });
  const v = judgeSegmentation(g);
  assert.equal(v.assumptionFailed, true, 'a long-throw failure was invisible to G4');
  assert.equal(v.silhouetteFailures, 3, 'one failure per run over three runs');
  assert.ok(v.silhouetteCaptures > 0, 'the failure count needs a denominator');
});

test('G5 fires when the win is carried by a minority of seeds', () => {
  const g = healthy();
  // Image loses on two of three draws while a single huge win holds the mean up.
  g.geometric = cell([10, 10, 100000], { offSphereFrac: 0.012 });
  g.image = cell([20, 20, 1], { segmentImage: true });
  assert.equal(judgeSegmentation(g).notConsistentlySigned, true);
});

test('G6 fires trivially when the geometric test is useless on both archetypes', () => {
  // Documented rather than special-cased. With both shares at zero it is true
  // that the bad nominal cost nothing, and the falsifier says so — but the
  // signal is vacuous, and a reader of the results file should know that this is
  // how it reads when the geometric arm never clears either bar.
  const g = healthy();
  g.geometric = cell([400, 500, 600], { offSphereFrac: 0.012 });
  const v = judgeSegmentation(g);
  assert.equal(v.usableShare.geometric, 0);
  assert.equal(v.usableShare['lt-geometric'], 0);
  assert.equal(v.geometricSurvivesABadNominal, true);
});

test('G6 fires when a bad nominal does not cost the geometric test', () => {
  const g = healthy();
  // Long-throw geometric does as well against its own bar as on archetype 1.
  g['lt-geometric'] = cell([95, 100, 110], { offSphereFrac: 0.002 });
  assert.equal(judgeSegmentation(g).geometricSurvivesABadNominal, true);
});

test('G7 fires when the image test loses ground on a bad nominal', () => {
  const g = healthy();
  g['lt-image'] = cell([1000, 2000, 3000], { segmentImage: true });
  assert.equal(judgeSegmentation(g).imageDegradesOnABadNominal, true);
});

test('the verdict reports the bar-free recovery beside the bar-bound one', () => {
  // The confound this exists for: long-throw's clean bar is far looser, so the
  // usable-share numbers flatter both methods there and cannot be compared
  // across archetypes on their own.
  const v = judgeSegmentation(healthy());
  assert.ok(v.recoveryByArchetype.nominal !== undefined);
  assert.ok(v.recoveryByArchetype['long-throw'] !== undefined);
  for (const k of ['nominal', 'long-throw']) {
    for (const m of ['geometric', 'image', 'headToHead'] as const) {
      assert.ok(Number.isFinite(v.recoveryByArchetype[k][m]), `${k}.${m} is not finite`);
    }
  }
  assert.match(v.statement, /bar is 12x looser|dimensionless/);
});

test('the figure is well-formed, self-contained, and carries no non-finite coordinate', () => {
  const svg = renderSegmentationSvg(buildResult(healthy(), 3));
  assert.ok(svg.startsWith('<svg'), 'not an svg');
  assert.ok(svg.trimEnd().endsWith('</svg>'), 'unclosed svg');
  assert.ok(!/<(script|image|use\b)/.test(svg), 'the figure references something outside itself');
  assert.ok(
    !/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(svg),
    'the figure carries an external URL',
  );
  assert.ok(!/NaN|undefined|Infinity/.test(svg), 'a non-finite coordinate reached the figure');
});
