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
  WALL_RADII,
  buildDesign,
  cellKey,
  spillFor,
} from '../src/spill/design.ts';
import type { Cell, Dispersion } from '../src/spill/run.ts';
import { judge } from '../src/spill/run.ts';
import { renderSpillSvg } from '../src/spill/plot.ts';

test('the design is a full grid and every cell is distinct', () => {
  const design = buildDesign();
  assert.equal(design.length, WALL_RADII.length * MIN_MODULATION.length);
  assert.equal(new Set(design.map(cellKey)).size, design.length);
  // The baseline the verdict is defined against has to be in it, or `judge`
  // silently answers "the grid did not contain the cells".
  assert.ok(design.some((c) => c.wallRadiusM === null && c.minModulation === 0.02));
  assert.ok(
    design.some(
      (c) => c.wallRadiusM === DEFAULT_ROOM_SPILL.wallRadiusM && c.minModulation === 0.02,
    ),
  );
});

test('the room the design builds is the room the design describes', () => {
  assert.equal(spillFor({ wallRadiusM: null, minModulation: 0.02 }), null);
  const six = spillFor({ wallRadiusM: 6, minModulation: 0.02 });
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
): Cell {
  return {
    wallRadiusM,
    minModulation,
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
