/**
 * Experiment 4's apparatus, not its result.
 *
 * No solve runs here. The published run is nine minutes of real solves and a
 * test that reproduced it would be a second copy of the measurement rather than
 * a check on it. What these pin is everything that could make the measurement
 * mean something other than it says: that the design varies one thing at a time,
 * that the verdict is computed from the cells rather than written, and that each
 * of the four falsifiers can actually trigger.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DEFAULT_ROOM_SPILL } from '../../bench/src/capture.ts';
import {
  CEILING_M,
  CUTS,
  MIN_MODULATION,
  SEGMENT_MARGINS,
  SHIPPED_MODULATION,
  WALL_RADII,
  buildDesign,
  cellKey,
  spillFor,
} from '../src/spill/design.ts';
import type { Cell, Dispersion } from '../src/spill/run.ts';
import { judge, paired, runSpillExperiment } from '../src/spill/run.ts';
import { renderSpillSvg } from '../src/spill/plot.ts';

test('the design is two one-axis arms and every cell is distinct', () => {
  const design = buildDesign();
  const margins = SEGMENT_MARGINS.filter((m) => m !== null);
  assert.equal(design.length, WALL_RADII.length * (MIN_MODULATION.length + margins.length));
  assert.equal(new Set(design.map(cellKey)).size, design.length);

  // Each arm varies ONE thing. The threshold arm is unsegmented throughout; the
  // segmentation arm holds the shipped threshold throughout. A cell that varied
  // both would make its comparison uninterpretable and nothing else would fail.
  const armA = design.filter((c) => c.segmentMarginFrac === null);
  const armB = design.filter((c) => c.segmentMarginFrac !== null);
  assert.equal(new Set(armB.map((c) => c.minModulation)).size, 1);
  assert.equal(armB[0].minModulation, SHIPPED_MODULATION);
  assert.equal(armA.length, WALL_RADII.length * MIN_MODULATION.length);

  // The baseline the verdict is defined against has to be in it, or `judge`
  // silently answers "the grid did not contain the cells".
  assert.ok(
    design.some(
      (c) =>
        c.wallRadiusM === null && c.minModulation === 0.02 && c.segmentMarginFrac === null,
    ),
  );
  assert.ok(
    design.some(
      (c) =>
        c.wallRadiusM === DEFAULT_ROOM_SPILL.wallRadiusM &&
        c.minModulation === 0.02 &&
        c.segmentMarginFrac === null,
    ),
  );
});

test('the room the design builds is the room the design describes', () => {
  assert.equal(spillFor({ wallRadiusM: null, minModulation: 0.02, segmentMarginFrac: null }), null);
  const six = spillFor({ wallRadiusM: 6, minModulation: 0.02, segmentMarginFrac: null });
  assert.deepEqual(six, { wallRadiusM: 6, ceilingM: CEILING_M });
  // And the level called "the default room" IS the shipped default, or the
  // experiment is measuring a room nothing else uses.
  assert.equal(DEFAULT_ROOM_SPILL.wallRadiusM, 6);
  assert.equal(DEFAULT_ROOM_SPILL.ceilingM, CEILING_M);
});

test('every cut says what it costs the conclusion', () => {
  assert.ok(CUTS.length > 0);
  for (const cut of CUTS) {
    assert.ok(cut.what.length > 0, 'a cut with no description');
    assert.ok(cut.why.length > 0, `"${cut.what}" does not say why`);
    assert.ok(
      cut.costsTheConclusion.length > 0,
      `"${cut.what}" does not say what it costs the conclusion`,
    );
  }
});

// ---------------------------------------------------------------------------
// The verdict, against synthetic cells
// ---------------------------------------------------------------------------

function d(median: number, values?: number[]): Dispersion {
  const v = values ?? [median];
  return { median, min: Math.min(...v), max: Math.max(...v), values: v };
}

function cell(
  wallRadiusM: number | null,
  minModulation: number,
  poseMm: number,
  offFrac: number,
  poseValues?: number[],
  segmentMarginFrac: number | null = null,
): Cell {
  return {
    wallRadiusM,
    minModulation,
    segmentMarginFrac,
    n: poseValues?.length ?? 1,
    runs: [],
    posePositionMm: d(poseMm, poseValues),
    poseRotationDeg: d(0.1),
    offSphereFrac: d(offFrac),
    correspondences: d(12000),
    offSphereBySurface: { wall: 0, floor: 0, ceiling: 0 },
    gridUsable: 1,
  };
}

test('F1 triggers when nothing lands off the sphere', () => {
  const v = judge([cell(null, 0.02, 20, 0), cell(6, 0.02, 20, 0)]);
  assert.equal(v.isInert, true);
  assert.match(v.statement, /inert/);
});

test('F2 triggers when the correspondence set moves and the pose does not', () => {
  const v = judge([cell(null, 0.02, 20, 0), cell(6, 0.02, 22, 0.1)]);
  assert.equal(v.isInert, false);
  assert.equal(v.lossAbsorbsIt, true);
  assert.match(v.statement, /robustness property/);
});

test('F3 triggers when a tighter room costs less than a wider one', () => {
  const cells = [
    cell(null, 0.02, 20, 0),
    cell(9, 0.02, 900, 0.1),
    cell(6, 0.02, 8000, 0.14),
    // Tighter and yet cheaper: the criterion must catch this.
    cell(4, 0.02, 3000, 0.16),
  ];
  assert.equal(judge(cells).monotoneInRoomSize, false);
  const ordered = [cell(null, 0.02, 20, 0), cell(9, 0.02, 900, 0.1), cell(6, 0.02, 3000, 0.14)];
  assert.equal(judge(ordered).monotoneInRoomSize, true);
});

test('F4 triggers when a floor recovers the solve, and reports what it costs a clean capture', () => {
  const cells = [
    cell(null, 0.02, 20, 0),
    cell(6, 0.02, 8000, 0.14),
    cell(6, 0.2, 30, 0.002),
    cell(null, 0.2, 26, 0),
  ];
  const v = judge(cells);
  assert.equal(v.aThresholdSeparatesThem, true);
  assert.equal(v.separatingModulation, 0.2);
  assert.ok(v.costToACleanCapture !== null && Math.abs(v.costToACleanCapture - 26 / 20) < 1e-9);
  assert.match(v.statement, /Raising the decoder/);
});

test('F4 does not trigger when every floor leaves the solve broken', () => {
  const cells = [
    cell(null, 0.02, 20, 0),
    cell(6, 0.02, 8000, 0.14),
    cell(6, 0.2, 500, 0.002),
    cell(6, 0.4, 900, 0.001),
  ];
  const v = judge(cells);
  assert.equal(v.aThresholdSeparatesThem, false);
  assert.equal(v.separatingModulation, null);
  assert.match(v.statement, /segmentation/);
});

test('F5 triggers when a segmentation margin recovers the solve, and F6 prices it', () => {
  const cells = [
    cell(null, 0.02, 20, 0),
    cell(6, 0.02, 8000, 0.14),
    // Segmentation arm: margin 0 recovers, margin 0.15 does not.
    cell(6, 0.02, 30, 0.001, undefined, 0),
    cell(6, 0.02, 9000, 0.02, undefined, 0.15),
    cell(null, 0.02, 24, 0, undefined, 0),
  ];
  const v = judge(cells);
  assert.equal(v.segmentationRecoversIt, true);
  assert.equal(v.recoveringMargin, 0);
  assert.ok(
    v.segmentationCostToACleanCapture !== null &&
      Math.abs(v.segmentationCostToACleanCapture - 24 / 20) < 1e-9,
  );
  assert.match(v.statement, /Segmentation at a margin of 0 recovers it/);
});

test('F5 does not trigger when no margin recovers the solve', () => {
  const cells = [
    cell(null, 0.02, 20, 0),
    cell(6, 0.02, 8000, 0.14),
    cell(6, 0.02, 5000, 0.01, undefined, 0),
    cell(6, 0.02, 9000, 0.02, undefined, 0.15),
  ];
  const v = judge(cells);
  assert.equal(v.segmentationRecoversIt, false);
  assert.equal(v.recoveringMargin, null);
  // Not a null result, and the statement must say so: the boolean is a
  // threshold and the factor is the size of the effect.
  assert.equal(v.bestMargin, 0);
  assert.ok(v.segmentationMedianFactor !== null && Math.abs(v.segmentationMedianFactor - 8000 / 5000) < 1e-9);
  assert.match(v.statement, /does not clear the two-times bar/);
  assert.match(v.statement, /What it does not fix is the tail/);
});

test('the verdict never reads a segmentation cell as an unsegmented one', () => {
  // Every lookup in `judge` pins the arm. Without that, a segmented cell at the
  // same room and threshold could be picked up as the baseline or as the
  // room's cost, and the headline would compare a mitigation against itself.
  const withDecoys = [
    cell(null, 0.02, 20, 0),
    cell(6, 0.02, 8000, 0.14),
    // Decoys: same room, same threshold, but segmented.
    cell(null, 0.02, 1, 0, undefined, 0),
    cell(6, 0.02, 2, 0, undefined, 0),
  ];
  const v = judge(withDecoys);
  assert.match(v.statement, /20\.0 mm to 8000 mm/);
});

test('the verdict refuses rather than invents when the grid is missing its baseline', () => {
  const v = judge([cell(6, 0.02, 8000, 0.14)]);
  assert.match(v.statement, /did not contain the cells/);
});

// ---------------------------------------------------------------------------
// The figure
// ---------------------------------------------------------------------------

test('the figure is well-formed, self-contained, and carries no non-finite coordinate', () => {
  const svg = renderSpillSvg({
    schema: 'sphere-sim/experiment-4@1',
    provisional: false,
    provisionalNote: 'test',
    generatedFrom: {
      rootSeed: 1,
      seedCount: 2,
      archetypeIndex: 1,
      preset: 'default',
      wallRadiiM: [null, 6],
      ceilingM: CEILING_M,
      minModulation: [0.02, 0.2],
      segmentMargins: [null, 0],
      defaultRoomSpill: { ...DEFAULT_ROOM_SPILL },
    },
    cells: [
      cell(null, 0.02, 20, 0, [18, 22]),
      cell(null, 0.2, 26, 0, [24, 28]),
      cell(6, 0.02, 8000, 0.14, [500, 40000]),
      cell(6, 0.2, 30, 0.002, [28, 33]),
    ],
    cuts: CUTS,
    verdict: judge([
      cell(null, 0.02, 20, 0),
      cell(6, 0.02, 8000, 0.14),
      cell(6, 0.2, 30, 0.002),
      cell(null, 0.2, 26, 0),
    ]),
  });
  assert.ok(svg.startsWith('<svg'), 'not an svg');
  assert.ok(svg.trimEnd().endsWith('</svg>'), 'unclosed svg');
  // A plot that quietly needs a CDN is a plot that will be blank in the room
  // where it matters.
  assert.ok(!/<(script|image|use\b)/.test(svg), 'the figure references something outside itself');
  // Everything except the SVG namespace declaration, which is required and is
  // not a fetch. Asserting "no http at all" fails on `xmlns`, which is a check
  // that is wrong rather than a figure that is.
  assert.ok(
    !/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(svg),
    'the figure carries an external URL',
  );
  assert.ok(!/NaN|undefined|Infinity/.test(svg), 'a non-finite coordinate reached the figure');
});

// The estimator these three pin was found by an adversarial review of the first
// published run. The design is fully paired — seedFor() depends only on the seed
// index — and every headline quantity divided two independently sorted medians,
// which at n=5 is a ratio of two single seeds.

test('the paired estimator uses the pairing, not the sorted order', () => {
  const cellOf = (values: number[]): Cell =>
    ({
      wallRadiusM: null,
      minModulation: 0.02,
      segmentMarginFrac: null,
      n: values.length,
      // Deliberately out of seed order: paired() must sort by seedIndex, and a
      // reader who trusted array order would get a different answer here.
      runs: values.map((v, i) => ({ seedIndex: values.length - 1 - i, posePositionMm: v })),
    }) as unknown as Cell;

  // before/after are written so that seed 0 gets WORSE and every other seed
  // improves: a ratio of medians cannot see that and a paired estimate must.
  const before = cellOf([100, 100, 100, 100, 10].reverse());
  const after = cellOf([10, 10, 10, 10, 100].reverse());
  const p = paired(before, after, 50);

  assert.equal(p.n, 5);
  assert.equal(p.improved, 4, 'four of five seeds improved');
  assert.ok(p.ratios.some((r) => r < 1), 'the seed that got worse must appear as a ratio below 1');
  // Geometric mean of four 10x improvements and one 10x regression is 10^(3/5).
  assert.ok(Math.abs(p.geometricMean - Math.pow(10, 3 / 5)) < 1e-9, `got ${p.geometricMean}`);
  assert.equal(p.usableBefore, 1);
  assert.equal(p.usableAfter, 4);
});

test('the paired geometric mean is not the ratio of the medians', () => {
  // The whole point: on data spanning orders of magnitude these disagree, and the
  // published run disagreed by a factor of 13.
  const mk = (values: number[]): Cell =>
    ({
      wallRadiusM: null,
      minModulation: 0.02,
      segmentMarginFrac: null,
      n: values.length,
      runs: values.map((v, i) => ({ seedIndex: i, posePositionMm: v })),
    }) as unknown as Cell;
  const before = mk([15.1, 7840.59, 40638.1, 2499.79, 40349.2]);
  const after = mk([21.55, 44.01, 18.77, 352389, 166.76]);
  const p = paired(before, after, 51.5);
  const medianOf = (v: number[]): number => [...v].sort((a, b) => a - b)[2];
  const ratioOfMedians =
    medianOf([15.1, 7840.59, 40638.1, 2499.79, 40349.2]) /
    medianOf([21.55, 44.01, 18.77, 352389, 166.76]);

  assert.ok(Math.abs(ratioOfMedians - 178.16) < 0.1, `ratio of medians ${ratioOfMedians}`);
  assert.ok(Math.abs(p.geometricMean - 13.6) < 0.2, `paired geometric mean ${p.geometricMean}`);
  assert.equal(p.improved, 3, 'segmentation improved three of five seeds and degraded two');
});

test('F6 is evaluated even when F5 triggers', () => {
  // It used to be keyed on recoveringMargin, which is null exactly when F5 fires,
  // so the published run printed an F6 row from a hand calculation while the
  // machine field beside it was null.
  const v = judge([
    cell(null, 0.02, 20, 0),                 // clean baseline
    cell(6, 0.02, 7800, 0.14),               // the room, unsegmented
    cell(6, 0.02, 44, 0.008, undefined, 0),  // segmented: 44 > 2 x 20, so F5 fires
    cell(null, 0.02, 21, 0, undefined, 0),   // clean + segmentation, what F6 asks about
  ]);
  assert.equal(v.segmentationRecoversIt, false, 'F5 must trigger for this test to mean anything');
  assert.notEqual(
    v.segmentationCostToACleanCapture,
    null,
    'F6 must still produce a number when F5 has triggered',
  );
  assert.equal(v.bestMargin, 0);
});
