/**
 * Tests for Experiment 1.
 *
 * These do not run a solve — a single point is nine seconds at the cheapest
 * setting and twelve minutes at the dearest, and a test suite that ran the
 * experiment would stop being run. What they test is everything that could make
 * the experiment measure the wrong thing without anybody noticing:
 *
 *  - the design varies ONE axis at a time and holds everything else,
 *  - two levels of an axis at the same seed are the SAME rig, so the comparison
 *    is paired rather than two scenarios differenced,
 *  - the degradation switches land on the scenario the way the labels claim,
 *  - the dispersion summary does not quietly drop or invent a value,
 *  - the figures draw every seed, mark clamped points, and reference nothing
 *    outside themselves,
 *  - the quadrature prediction is calibrated where its docstring says and
 *    genuinely predicts the point it says it predicts.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  CUTS,
  DEGRADATION_CONDITIONS,
  EXPERIMENT_ROOT_SEED,
  FLOOR_SIGMAS,
  RESOLUTIONS,
  buildDesign,
  estimateSeconds,
  experimentPreset,
} from '../src/experiment1/design.ts';
import { BASE_ARCHETYPE_INDEX, scenarioFor, seedFor } from '../src/experiment1/point.ts';
import type { Cell } from '../src/experiment1/results.ts';
import { TRACKED_FIELDS, aggregate } from '../src/experiment1/results.ts';
import { disperse, excessOver, quadrature, quantile } from '../src/experiment1/stats.ts';
import { cameraCountFigure, quadraturePrediction } from '../src/experiment1/plots.ts';
import { renderFigure } from '../src/experiment1/svg.ts';
import type { PointRun } from '../src/experiment1/point.ts';

// ---------------------------------------------------------------------------
// The design
// ---------------------------------------------------------------------------

test('every design point has a unique key and at least one seed', () => {
  const design = buildDesign();
  const keys = new Set<string>();
  for (const p of design) {
    const k = `${p.figure}|${p.series}|${p.level}`;
    assert.equal(keys.has(k), false, `duplicate design cell ${k}`);
    keys.add(k);
    assert.ok(p.seedCount >= 1, `${k} has no seeds`);
    assert.ok(p.estimateSec > 0);
  }
  assert.ok(design.length > 30, 'the design should not have quietly shrunk');
});

test('the camera-count axis varies the count and holds everything else', () => {
  const design = buildDesign();
  for (const series of ['tripod', 'handheld']) {
    const pts = design.filter((p) => p.figure === 'camera-count' && p.series === series);
    assert.deepEqual(
      pts.map((p) => p.cameraCount),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'the brief asks for 1 to 8 and the degenerate cases are not to be dropped',
    );
    const held = new Set(
      pts.map((p) =>
        JSON.stringify([p.resX, p.resY, p.floorSigmaM, p.floorReferenceCount, p.degradation]),
      ),
    );
    assert.equal(held.size, 1, 'something other than the camera count varies along this axis');
  }
});

test('tripod and handheld differ in the motion and the shutter and in nothing else', () => {
  const design = buildDesign();
  const t = design.find((p) => p.figure === 'camera-count' && p.series === 'tripod')!;
  const h = design.find((p) => p.figure === 'camera-count' && p.series === 'handheld')!;
  assert.equal(t.degradation.ambient, h.degradation.ambient);
  assert.equal(t.degradation.sensorNoise, h.degradation.sensorNoise);
  assert.equal(t.degradation.motion, false);
  assert.equal(h.degradation.motion, true);
  assert.equal(t.degradation.rollingShutter, false);
  assert.equal(h.degradation.rollingShutter, true);
});

test('the resolution axis covers a phone and holds the camera count', () => {
  const design = buildDesign();
  const pts = design.filter((p) => p.figure === 'resolution' && p.series === 'tripod');
  assert.deepEqual(
    pts.map((p) => p.level),
    RESOLUTIONS.map((r) => r.label),
  );
  assert.equal(new Set(pts.map((p) => p.cameraCount)).size, 1);
  assert.ok(
    pts.some((p) => p.resX === 4032 && p.resY === 3024),
    'the "does a phone suffice" axis has to reach a real phone resolution',
  );
});

test('the floor-sigma axis carries the three instruments and a no-reference control', () => {
  const design = buildDesign();
  for (const series of ['320x240', '640x480']) {
    const pts = design.filter((p) => p.figure === 'floor-sigma' && p.series === series);
    assert.deepEqual(
      pts.map((p) => p.floorSigmaM),
      FLOOR_SIGMAS.map((f) => f.sigmaM),
    );
    assert.ok(pts.every((p) => p.floorReferenceCount === 4));
    const none = design.find(
      (p) => p.figure === 'floor-sigma' && p.series === `${series} (no reference)`,
    );
    assert.ok(none !== undefined, 'PARAMETERS.md §8 item 1 not carried out is its own control');
    assert.equal(none.floorReferenceCount, 0);
  }
});

test('every degradation condition is switched on against the noiseless reference', () => {
  const none = DEGRADATION_CONDITIONS.find((d) => d.label === 'none')!;
  assert.deepEqual(none.spec, {
    ambient: 0,
    sensorNoise: false,
    motion: false,
    rollingShutter: false,
  });
  // Exactly one condition isolates the rolling shutter with a static camera.
  // packages/bench/README.md proves that case is a no-op; the brief names
  // rolling shutter as one of three conditions, so the row has to exist for the
  // measured zero to be reportable.
  const rs = DEGRADATION_CONDITIONS.find((d) => d.label === 'rolling shutter')!;
  assert.equal(rs.spec.rollingShutter, true);
  assert.equal(rs.spec.motion, false);
  const single = DEGRADATION_CONDITIONS.filter(
    (d) => d.label !== 'none' && d.label !== 'all' && d.label !== 'motion + rolling',
  );
  for (const d of single) {
    const on = [
      d.spec.ambient > 0,
      d.spec.sensorNoise,
      d.spec.motion,
      d.spec.rollingShutter,
    ].filter(Boolean).length;
    assert.ok(on <= 1, `${d.label} switches on more than one thing`);
  }
});

test('every cut states what it costs the conclusion', () => {
  assert.ok(CUTS.length > 0);
  for (const c of CUTS) {
    assert.ok(c.what.length > 10, 'a cut with no description is a silent truncation');
    assert.ok(c.why.length > 10);
    assert.ok(
      c.costsTheConclusion.length > 10,
      'a cut that does not say what it costs reads as "we covered everything"',
    );
  }
});

test('the cost model separates the terms it was calibrated on', () => {
  const off = { ambient: 0, sensorNoise: false, motion: false, rollingShutter: false };
  const sensor = { ...off, sensorNoise: true };
  const motion = { ...off, motion: true };
  const base = estimateSeconds(3, 640, 480, 1500, off);
  assert.ok(estimateSeconds(3, 640, 480, 1500, sensor) > base);
  // Handheld motion rebuilds the geometry pass every frame; it is the largest
  // of the three terms and a budget that misses it is wrong by hours.
  assert.ok(estimateSeconds(3, 640, 480, 1500, motion) > estimateSeconds(3, 640, 480, 1500, sensor));
  // Quadratic in the linear resolution.
  const ratio = estimateSeconds(3, 1280, 960, 1500, sensor) / estimateSeconds(3, 640, 480, 1500, sensor);
  assert.ok(ratio > 3 && ratio < 4.2, `expected roughly 4x per doubling, got ${ratio}`);
});

// ---------------------------------------------------------------------------
// Pairing: the same seed is the same rig
// ---------------------------------------------------------------------------

test('two levels of an axis at one seed are the SAME rig', () => {
  const design = buildDesign();
  const pts = design.filter((p) => p.figure === 'camera-count' && p.series === 'tripod');
  const rigs = pts.map((p) => {
    const s = scenarioFor(p, 0);
    return JSON.stringify({
      seed: s.seed,
      distanceM: s.distanceM,
      projectorHeightM: s.projectorHeightM,
      centerHeightM: s.centerHeightM,
      projectorCount: s.projectorCount,
      slots: s.slots,
      misalignment: s.misalignment,
      misalignmentScale: s.misalignmentScale,
      camDistance: s.cameras.distanceM,
      camHeight: s.cameras.heightM,
    });
  });
  assert.equal(
    new Set(rigs).size,
    1,
    'the count sweep must photograph one rig, or the curve is a difference between scenarios',
  );
});

test('the resolution and degradation axes photograph the same rig as the count axis', () => {
  const design = buildDesign();
  const key = (figure: string): string => {
    const p = design.find((q) => q.figure === figure)!;
    const s = scenarioFor(p, 0);
    return JSON.stringify([s.seed, s.distanceM, s.projectorHeightM, s.cameras.distanceM]);
  };
  assert.equal(key('camera-count'), key('resolution'));
  assert.equal(key('camera-count'), key('floor-sigma'));
  assert.equal(key('camera-count'), key('degradation'));
});

test('seeds are a pure function of the documented root', () => {
  assert.equal(seedFor(0), seedFor(0));
  assert.notEqual(seedFor(0), seedFor(1));
  // Two different seed indices must give two different rigs, or the replicates
  // are one measurement repeated.
  const p = buildDesign().find((q) => q.figure === 'camera-count')!;
  assert.notEqual(scenarioFor(p, 0).distanceM, scenarioFor(p, 1).distanceM);
  assert.ok(EXPERIMENT_ROOT_SEED > 0);
});

test('the base scenario is the bench NOMINAL archetype, unmodified where not overridden', () => {
  const preset = experimentPreset(1500);
  assert.equal(BASE_ARCHETYPE_INDEX, 1);
  const p = buildDesign().find((q) => q.figure === 'camera-count' && q.series === 'tripod')!;
  const s = scenarioFor(p, 0);
  assert.equal(s.projectorCount, 4);
  assert.equal(s.projectorResX, 1920);
  assert.equal(s.freeFov, true, 'PARAMETERS.md §3.1 classes fov_h SOLVE; the experiment leaves it free');
  assert.equal(s.maskInterpretation, 'latitude');
  assert.equal(preset.metricConvergence, false);
});

test('the degradation switches land on the scenario the way the labels claim', () => {
  const design = buildDesign();
  const get = (label: string) =>
    scenarioFor(design.find((p) => p.figure === 'degradation' && p.level === label)!, 0);

  const none = get('none');
  assert.equal(none.degradation.sensor, null);
  assert.equal(none.degradation.handheld, null);
  assert.equal(none.degradation.clock.rollingShutter, false);
  assert.equal(none.degradation.ambient, 0);

  const rs = get('rolling shutter');
  assert.equal(rs.degradation.handheld, null, 'a rolling shutter with a MOVING camera is a different row');
  assert.equal(rs.degradation.clock.rollingShutter, true);

  const mg = get('motion, global shutter');
  assert.notEqual(mg.degradation.handheld, null);
  assert.equal(mg.degradation.clock.rollingShutter, false);

  const all = get('all');
  assert.notEqual(all.degradation.sensor, null);
  assert.notEqual(all.degradation.handheld, null);
  assert.equal(all.degradation.clock.rollingShutter, true);
  assert.equal(all.degradation.ambient, 0.15);
});

// ---------------------------------------------------------------------------
// Dispersion
// ---------------------------------------------------------------------------

test('quantile interpolates and handles the degenerate lengths', () => {
  assert.ok(Number.isNaN(quantile([], 0.5)));
  assert.equal(quantile([7], 0.5), 7);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3], 0.25), 1.5);
});

test('disperse keeps every value, counts the non-finite, and refuses to invent a spread', () => {
  const d = disperse([3, 1, 2, Number.NaN]);
  assert.equal(d.n, 3);
  assert.equal(d.nonFinite, 1);
  assert.equal(d.median, 2);
  assert.equal(d.min, 1);
  assert.equal(d.max, 3);
  assert.deepEqual(d.values.length, 4, 'the raw draws are kept, including the failure');
  // One draw says nothing about spread; a printed 0 would claim it did.
  assert.ok(Number.isNaN(disperse([5]).sd));
  assert.ok(Number.isFinite(disperse([5, 7]).sd));
});

test('quadrature and excess behave at the edges', () => {
  assert.equal(quadrature([3, 4]), 5);
  assert.ok(Number.isNaN(quadrature([3, Number.NaN])));
  assert.equal(excessOver(5, 3), 2);
  assert.equal(excessOver(2, 3), 0, 'a condition that improved things contributes zero, not a negative');
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function fakeRun(over: Partial<PointRun>): PointRun {
  return {
    key: 'k',
    figure: 'f',
    axis: 'a',
    series: 's',
    level: 'l',
    x: 1,
    seedIndex: 0,
    seed: 1,
    cameraCount: 3,
    resX: 320,
    resY: 240,
    floorSigmaM: 0.003,
    floorReferenceCount: 4,
    ambient: 0.04,
    sensorNoise: true,
    motion: false,
    rollingShutter: false,
    maxCorrespondencesPerPair: 1500,
    error: null,
    posePositionMm: 1,
    poseRotationDeg: 0.01,
    gridDisplacementMm: 0.1,
    hCenterErrorMm: 1,
    poseRmsPositionMm: 1,
    poseRawPositionMm: 1,
    fovErrorDeg: 0.01,
    rmsResidualPx: 0.1,
    correspondencesUsed: 100,
    correspondencesDecoded: 100,
    decodeAccepted: 100,
    decodeConsidered: 200,
    converged: true,
    stopReason: 'cost',
    centerHeightObserved: true,
    gaugeAngleDeg: 0.001,
    gaugeUnconstrainedAngleDeg: 0.03,
    motionTranslationMm: 0,
    motionRotationDeg: 0,
    wallClockMs: 1000,
    truthFovHDeg: 34.091776,
    truthDistanceM: 5.18,
    fovSubtensePredictedMm: 1.47,
    ...over,
  };
}

test('aggregate groups by cell, keeps every seed, and records the failures', () => {
  const cells = aggregate([
    fakeRun({ seedIndex: 0, posePositionMm: 1 }),
    fakeRun({ seedIndex: 1, posePositionMm: 3 }),
    fakeRun({ seedIndex: 2, posePositionMm: Number.NaN, error: 'boom' }),
  ]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].n, 3);
  assert.equal(cells[0].metrics.posePositionMm.median, 2);
  assert.equal(cells[0].metrics.posePositionMm.n, 2);
  assert.deepEqual(cells[0].failedSeeds, [2]);
});

test('every tracked field with a gate names where the gate comes from', () => {
  for (const f of TRACKED_FIELDS) {
    if (f.gate === null) continue;
    assert.ok(
      f.gateSource !== null && f.gateSource.length > 0,
      `${String(f.key)} has a gate with no provenance`,
    );
  }
});

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

function syntheticCells(): Cell[] {
  const runs: PointRun[] = [];
  for (const series of ['tripod', 'handheld']) {
    for (let n = 1; n <= 8; n++) {
      for (let s = 0; s < 3; s++) {
        runs.push(
          fakeRun({
            figure: 'camera-count',
            axis: 'camera-count',
            series,
            level: String(n),
            x: n,
            seedIndex: s,
            cameraCount: n,
            posePositionMm: (series === 'tripod' ? 10 : 300) / n + s,
          }),
        );
      }
    }
  }
  return aggregate(runs);
}

/**
 * Every marker the figure spec carries, counted independently of the renderer.
 *
 * Derived from the spec rather than hardcoded, because the count figure draws
 * some panels twice at two scales and a magic number would have to be edited
 * every time a panel is added — which is exactly how a "nothing is dropped"
 * test quietly stops testing that.
 */
function expectedCircles(spec: ReturnType<typeof cameraCountFigure>): number {
  let n = spec.legend.length;
  for (const panel of spec.panels) {
    for (const s of panel.series) {
      if (!s.noDots) {
        for (const p of s.points) n += p.values.filter((v) => Number.isFinite(v)).length;
      }
      n += s.points.filter((p) => Number.isFinite(p.y)).length;
    }
  }
  return n;
}

test('a figure draws every seed, not just the median', () => {
  const cells = syntheticCells();
  const spec = cameraCountFigure(cells);
  const svg = renderFigure(spec);
  assert.equal(
    (svg.match(/<circle/g) ?? []).length,
    expectedCircles(spec),
    'the plot must show the draws a reader is asked to trust',
  );
  // And the spec must carry every seed the cells hold, or the renderer is
  // faithfully drawing an already-thinned dataset.
  const seedsInCells = cells
    .filter((c) => c.figure === 'camera-count')
    .reduce((a, c) => a + c.metrics.posePositionMm.values.length, 0);
  const seedsInTopRow = spec.panels[0].series.reduce(
    (a, s) => a + s.points.reduce((b, p) => b + p.values.length, 0),
    0,
  );
  assert.equal(seedsInTopRow, seedsInCells);
});

test('a figure references nothing outside itself', () => {
  const svg = renderFigure(cameraCountFigure(syntheticCells()));
  assert.equal(/<script/i.test(svg), false);
  assert.equal(/https?:/i.test(svg.replace('http://www.w3.org/2000/svg', '')), false);
  assert.equal(/xlink:href|<image/i.test(svg), false);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
});

test('a figure draws the §7 gate where §7 puts it', () => {
  const svg = renderFigure(cameraCountFigure(syntheticCells()));
  assert.ok(svg.includes('PARAMETERS.md §7: 2 mm'));
  assert.ok(svg.includes('PARAMETERS.md §7: 0.05 deg'));
  assert.ok(svg.includes('PARAMETERS.md §7: 1 mm on sphere surface'));
});

test('an outlier expands the axis instead of being dropped', () => {
  const runs: PointRun[] = [];
  for (let s = 0; s < 3; s++) {
    runs.push(
      fakeRun({
        figure: 'camera-count',
        series: 'tripod',
        level: '1',
        x: 1,
        seedIndex: s,
        // One draw six decades above the others: the exact case a plot must
        // not quietly delete.
        posePositionMm: s === 2 ? 1e6 : 1,
      }),
    );
  }
  const spec = cameraCountFigure(aggregate(runs));
  const svg = renderFigure(spec);
  assert.equal((svg.match(/<circle/g) ?? []).length, expectedCircles(spec), 'every draw is still drawn');
  // The y axis grew to contain it rather than clipping it away.
  assert.ok(svg.includes('>1000000<') || svg.includes('>1e+6<'), 'the axis must reach the outlier');
});

test('a value a log axis cannot represent is drawn on the floor and marked, not skipped', () => {
  const runs = [0, 1, 2].map((s) =>
    fakeRun({
      figure: 'camera-count',
      series: 'tripod',
      level: '1',
      x: 1,
      seedIndex: s,
      // A recovery error of exactly zero happens on a noiseless capture and is
      // a result, not a missing measurement.
      posePositionMm: s === 0 ? 0 : 1,
    }),
  );
  const spec = cameraCountFigure(aggregate(runs));
  const svg = renderFigure(spec);
  assert.equal((svg.match(/<circle/g) ?? []).length, expectedCircles(spec), 'the zero draw is still drawn');
  assert.ok(svg.includes('stroke="#b3261e"'), 'an off-scale draw must be marked as such');
});

// ---------------------------------------------------------------------------
// The quadrature prediction
// ---------------------------------------------------------------------------

test('the quadrature prediction is calibrated at the ends and predicts the middle', () => {
  // Construct a world that obeys the model exactly: sensor term 4, tape term
  // 6 mm at sigma = 3 mm, so total(3) = sqrt(16 + 36) and total(1) = sqrt(16+4).
  const mk = (level: string, sigmaMm: number, value: number): PointRun[] =>
    [0, 1].map((s) =>
      fakeRun({
        figure: 'floor-sigma',
        axis: 'floor-sigma',
        series: '640x480',
        level,
        x: sigmaMm,
        seedIndex: s,
        posePositionMm: value,
      }),
    );
  const cells = aggregate([
    ...mk('0.1 mm', 0.1, 4),
    ...mk('1 mm', 1, Math.sqrt(16 + 4)),
    ...mk('3 mm', 3, Math.sqrt(16 + 36)),
  ]);
  const p = quadraturePrediction(cells, '640x480', 'posePositionMm');
  assert.ok(p !== null);
  assert.ok(Math.abs(p.sensorTerm - 4) < 1e-9);
  assert.ok(Math.abs(p.tapeAt3mm - 6) < 1e-9);
  // The 1 mm point was NOT used to build the model, so this is a real test.
  assert.ok(Math.abs(p.predict(1) - Math.sqrt(16 + 4)) < 1e-9);
});

test('the quadrature prediction refuses to answer when a calibration point is missing', () => {
  const cells = aggregate([
    fakeRun({ figure: 'floor-sigma', series: '640x480', level: '1 mm', x: 1 }),
  ]);
  assert.equal(quadraturePrediction(cells, '640x480', 'posePositionMm'), null);
});
