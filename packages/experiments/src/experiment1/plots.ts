/**
 * The four figures, built from the aggregated cells.
 *
 * Nothing here computes a measurement. Every number a figure draws is read out
 * of `Cell.metrics`, which is read out of `runs`, which is what the solver
 * returned — so the plot and the JSON beside it cannot disagree, and a reader
 * checking one against the other is checking the renderer rather than the
 * result.
 *
 * The one place a figure draws something that is not a measurement is the
 * quadrature PREDICTION on figures 3 and 4. It is drawn dashed, in grey, is
 * labelled as a prediction in the legend, and its construction is stated in the
 * caption — including which point it was calibrated at, because a curve fitted
 * at every point is not a prediction of anything.
 */

import type { Cell } from './results.ts';
import { TRACKED_FIELDS, seriesOf, findCell } from './results.ts';
import type { FigureSpec, Panel, PlotPoint, PlotSeries } from './svg.ts';
import { PALETTE, fmt } from './svg.ts';
import { quadrature } from './stats.ts';
import { DEGRADATION_CONDITIONS, RESOLUTIONS } from './design.ts';

function gateFor(field: string): { value: number; label: string }[] {
  const f = TRACKED_FIELDS.find((t) => t.key === field);
  if (f === undefined || f.gate === null) return [];
  return [{ value: f.gate, label: `${f.gateSource ?? 'gate'}: ${f.gate} ${f.unit}` }];
}

function toPoints(cells: readonly Cell[], field: string): PlotPoint[] {
  return cells.map((c) => {
    const d = c.metrics[field];
    return { x: c.x, y: d.median, lo: d.min, hi: d.max, values: d.values, n: d.n };
  });
}

function mkSeries(
  cells: readonly Cell[],
  field: string,
  label: string,
  color: string,
): PlotSeries {
  return { label, color, points: toPoints(cells, field) };
}

// ---------------------------------------------------------------------------
// Figure 1 — camera count
// ---------------------------------------------------------------------------

export function cameraCountFigure(cells: readonly Cell[]): FigureSpec {
  const tripod = seriesOf(cells, 'camera-count', 'tripod');
  const handheld = seriesOf(cells, 'camera-count', 'handheld');
  const xTicks = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ value: v, label: String(v) }));

  /**
   * `from` exists because one camera cannot constrain the rig and misses by
   * kilometres, which on a shared log axis compresses everything else into a
   * band a few pixels tall. The top row shows the whole range including that
   * point — it is the answer to the first half of the brief's question and is
   * not to be hidden — and the bottom row shows the same three metrics from two
   * cameras up, so the part a reader is trying to read is legible. Nothing is
   * dropped; the same data is drawn twice at two scales.
   */
  const panel = (field: string, title: string, yLabel: string, from: number): Panel => ({
    title,
    subtitle: from > 1 ? `${from} cameras and up — same data, legible scale` : undefined,
    xLabel: 'camera positions (photographs of the sphere)',
    yLabel,
    xKind: 'linear',
    xTicks: xTicks.filter((t) => t.value >= from),
    gates: gateFor(field),
    series: [
      mkSeries(
        tripod.filter((c) => c.inputs.cameraCount >= from),
        field,
        'tripod',
        PALETTE.tripod,
      ),
      mkSeries(
        handheld.filter((c) => c.inputs.cameraCount >= from),
        field,
        'handheld',
        PALETTE.handheld,
      ),
    ],
  });

  const n = tripod[0]?.n ?? 0;
  return {
    title: 'Experiment 1, figure 1 — solver recovery against camera count',
    subtitle: `1 to 8 camera positions, ${n} seeds each. Held: 320x240 camera, 4 projectors at PARAMETERS.md §2 nominal, 4 floor references at sigma = 3 mm, E_amb = 0.04, fov_h free.`,
    columns: 3,
    legend: [
      { label: 'tripod (static camera, global shutter)', color: PALETTE.tripod },
      { label: 'handheld (motion + rolling shutter)', color: PALETTE.handheld },
    ],
    panels: [
      panel('posePositionMm', 'Pose position error', 'worst projector, mm (log)', 1),
      panel('poseRotationDeg', 'Pose rotation error', 'worst projector, deg (log)', 1),
      panel('gridDisplacementMm', 'Grid-line displacement', 'mm on sphere surface (log)', 1),
      panel('posePositionMm', 'Pose position error', 'worst projector, mm (log)', 2),
      panel('poseRotationDeg', 'Pose rotation error', 'worst projector, deg (log)', 2),
      panel('gridDisplacementMm', 'Grid-line displacement', 'mm on sphere surface (log)', 2),
    ],
    caption: [
      'Open circle = median over seeds. Small dots = every individual seed. Vertical bar = observed range. Red dashed = PARAMETERS.md §7 gate.',
      'The two conditions differ in the camera motion and the shutter and in nothing else — same rig, same seeds, same ambient, same sensor.',
      'Top row: all counts including one camera, which cannot constrain the rig and misses by kilometres. Bottom row: the same data from two cameras up.',
      'Note the third column against the first: at one camera the grid gate PASSES while the pose error is six orders of magnitude out. The recovered rig',
      'is internally self-consistent, so every projector is wrong in a way that agrees with every other projector and their grid lines still coincide.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Figure 2 — camera resolution
// ---------------------------------------------------------------------------

export function resolutionFigure(cells: readonly Cell[]): FigureSpec {
  const tripod = seriesOf(cells, 'resolution', 'tripod');
  const handheld = seriesOf(cells, 'resolution', 'handheld');
  const xTicks = RESOLUTIONS.map((r) => ({ value: r.resX, label: r.label }));

  const panel = (field: string, title: string, yLabel: string): Panel => ({
    title,
    xLabel: 'camera resolution (log)',
    yLabel,
    xKind: 'log',
    xTicks,
    gates: gateFor(field),
    series: [
      mkSeries(tripod, field, 'tripod', PALETTE.tripod),
      mkSeries(handheld, field, 'handheld', PALETTE.handheld),
    ],
  });

  const counts = tripod.map((c) => `${c.level}: n=${c.n}`).join(', ');
  return {
    title: 'Experiment 1, figure 2 — solver recovery against camera resolution',
    subtitle: `3 camera positions throughout. Replicates thin at the top end (${counts}); see the cuts block in experiment-1.json.`,
    columns: 3,
    legend: [
      { label: 'tripod (static camera, global shutter)', color: PALETTE.tripod },
      { label: 'handheld (motion + rolling shutter) — i.e. a phone', color: PALETTE.handheld },
    ],
    panels: [
      panel('posePositionMm', 'Pose position error', 'worst projector, mm (log)'),
      panel('poseRotationDeg', 'Pose rotation error', 'worst projector, deg (log)'),
      panel('gridDisplacementMm', 'Grid-line displacement', 'mm on sphere surface (log)'),
    ],
    caption: [
      'The correspondence cap is held at 1500 per (camera, projector) pair across the whole axis, so this measures per-correspondence PRECISION,',
      'not correspondence COUNT. The cap-control cells in experiment-1.json measure the difference directly at 1280x960.',
      '4032x3024 is a real phone main camera at full resolution, tripod condition, one seed — it is a confirming draw, not a measured mean.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Figure 3 — floor-reference instrument
// ---------------------------------------------------------------------------

/**
 * The quadrature model, calibrated at ONE point and tested at the others.
 *
 * A-16 measured the sensor term and the tape term to be independent and to add
 * in quadrature. If that holds here then, writing `S` for the error a noiseless
 * tape would leave and `T(sigma)` for the tape's own contribution,
 *
 *     total(sigma) = sqrt(S^2 + T(sigma)^2),  T proportional to sigma
 *
 * `S` is taken from the 0.1 mm point (where the tape contributes essentially
 * nothing) and the constant of proportionality from the 3 mm point. That uses
 * two of the three measurements and leaves the 1 mm point as a genuine
 * prediction. Fitting all three would have produced a curve through the data
 * and no test at all.
 */
export function quadraturePrediction(
  cells: readonly Cell[],
  series: string,
  field: string,
): { predict(sigmaMm: number): number; sensorTerm: number; tapeAt3mm: number } | null {
  const fine = findCell(cells, 'floor-sigma', series, '0.1 mm');
  const coarse = findCell(cells, 'floor-sigma', series, '3 mm');
  if (fine === undefined || coarse === undefined) return null;
  const s = fine.metrics[field].median;
  const total3 = coarse.metrics[field].median;
  if (!Number.isFinite(s) || !Number.isFinite(total3)) return null;
  const tape3 = Math.sqrt(Math.max(0, total3 * total3 - s * s));
  return {
    sensorTerm: s,
    tapeAt3mm: tape3,
    predict: (sigmaMm: number) => Math.sqrt(s * s + Math.pow((tape3 * sigmaMm) / 3, 2)),
  };
}

export function floorSigmaFigure(cells: readonly Cell[]): FigureSpec {
  const coarseCam = seriesOf(cells, 'floor-sigma', '320x240');
  const fineCam = seriesOf(cells, 'floor-sigma', '640x480');
  const noRefCoarse = findCell(cells, 'floor-sigma', '320x240 (no reference)', 'none');
  const noRefFine = findCell(cells, 'floor-sigma', '640x480 (no reference)', 'none');
  const xTicks = [
    { value: 0.1, label: '0.1 (survey)' },
    { value: 1, label: '1 (laser)' },
    { value: 3, label: '3 (tape)' },
  ];

  const panel = (field: string, title: string, yLabel: string): Panel => {
    const series: PlotSeries[] = [
      mkSeries(coarseCam, field, '320x240', PALETTE.tripod),
      mkSeries(fineCam, field, '640x480', PALETTE.third),
    ];
    const pred = quadraturePrediction(cells, '640x480', field);
    if (pred !== null) {
      series.push({
        label: 'quadrature prediction',
        color: PALETTE.prediction,
        dashed: true,
        noDots: true,
        points: [0.1, 0.3, 1, 2, 3].map((s) => ({
          x: s,
          y: pred.predict(s),
          lo: Number.NaN,
          hi: Number.NaN,
          values: [],
          n: 0,
        })),
      });
    }
    const refLines: { value: number; label: string; color: string }[] = [];
    if (noRefCoarse !== undefined) {
      refLines.push({
        value: noRefCoarse.metrics[field].median,
        label: `no floor reference, 320x240: ${fmt(noRefCoarse.metrics[field].median)}`,
        color: PALETTE.handheld,
      });
    }
    if (noRefFine !== undefined) {
      refLines.push({
        value: noRefFine.metrics[field].median,
        label: `no floor reference, 640x480: ${fmt(noRefFine.metrics[field].median)}`,
        color: PALETTE.fourth,
      });
    }
    return {
      title,
      xLabel: 'floor-reference one-sigma, mm (log)',
      yLabel,
      xKind: 'log',
      xTicks,
      gates: gateFor(field),
      refLines,
      series,
    };
  };

  return {
    title: 'Experiment 1, figure 3 — solver recovery against floor-reference instrument',
    subtitle:
      '3 camera positions, tripod, E_amb = 0.04. 3 mm is the tape measure PARAMETERS.md §8 item 1 prescribes; 1 mm is a hand-held laser measure; 0.1 mm is a survey instrument.',
    columns: 3,
    legend: [
      { label: '320x240 camera', color: PALETTE.tripod },
      { label: '640x480 camera', color: PALETTE.third },
      { label: 'quadrature prediction (calibrated at 0.1 and 3 mm)', color: PALETTE.prediction, dashed: true },
    ],
    panels: [
      panel('posePositionMm', 'Pose position error', 'worst projector, mm (log)'),
      panel('poseRotationDeg', 'Pose rotation error', 'worst projector, deg (log)'),
      panel('hCenterErrorMm', 'h_center recovery error', 'mm (log)'),
    ],
    caption: [
      'The prediction uses the 0.1 mm point as the sensor term and the 3 mm point to scale the tape term, leaving 1 mm as an actual prediction.',
      'The dotted horizontal lines are the same rig with PARAMETERS.md §8 item 1 not carried out at all — no floor reference, so h_center is HELD at its',
      'documented value rather than solved. That is a different estimator, not a noisier one, which is why it is not a point on this axis.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Figure 4 — degradation conditions, separately switchable
// ---------------------------------------------------------------------------

export interface QuadratureCheck {
  field: string;
  baselineLabel: string;
  baseline: number;
  contributions: { label: string; excess: number }[];
  predictedAll: number;
  measuredAll: number;
  ratio: number;
}

/**
 * Does the "all conditions" case equal the quadrature sum of the individual
 * conditions' excesses over the noiseless reference?
 *
 * The three conditions summed are ambient at the level `all` uses, sensor
 * noise, and motion-with-rolling-shutter — i.e. exactly the switches `all` turns
 * on, each measured alone. `rolling shutter` alone is excluded from the sum
 * because it is inside `motion + rolling`; adding it would double-count a term
 * that is separately measured to be zero.
 */
export function quadratureCheck(cells: readonly Cell[], field: string): QuadratureCheck | null {
  const get = (label: string): Cell | undefined =>
    findCell(cells, 'degradation', 'single condition', label);
  const none = get('none');
  const all = get('all');
  if (none === undefined || all === undefined) return null;
  const base = none.metrics[field].median;
  const parts = ['ambient 0.15', 'sensor noise', 'motion + rolling'];
  const contributions: { label: string; excess: number }[] = [];
  for (const label of parts) {
    const c = get(label);
    if (c === undefined) return null;
    contributions.push({
      label,
      excess: Math.max(0, c.metrics[field].median - base),
    });
  }
  const predicted = Math.sqrt(
    base * base + Math.pow(quadrature(contributions.map((c) => c.excess)), 2),
  );
  const measured = all.metrics[field].median;
  return {
    field,
    baselineLabel: 'none',
    baseline: base,
    contributions,
    predictedAll: predicted,
    measuredAll: measured,
    ratio: measured / predicted,
  };
}

export function degradationFigure(cells: readonly Cell[]): FigureSpec {
  const rows = DEGRADATION_CONDITIONS.map((c) =>
    findCell(cells, 'degradation', 'single condition', c.label),
  ).filter((c): c is Cell => c !== undefined);
  const categories = rows.map((c) => c.level);

  const panel = (field: string, title: string, yLabel: string): Panel => {
    const series: PlotSeries[] = [
      {
        label: 'measured',
        color: PALETTE.tripod,
        points: rows.map((c, i) => {
          const d = c.metrics[field];
          return { x: i, y: d.median, lo: d.min, hi: d.max, values: d.values, n: d.n };
        }),
      },
    ];
    const q = quadratureCheck(cells, field);
    if (q !== null && Number.isFinite(q.predictedAll)) {
      series.push({
        label: 'quadrature prediction for "all"',
        color: PALETTE.prediction,
        dashed: true,
        noDots: true,
        points: [
          { x: categories.length - 1, y: q.predictedAll, lo: Number.NaN, hi: Number.NaN, values: [], n: 0 },
        ],
      });
    }
    return {
      title,
      xLabel: 'degradation condition (each switched on alone)',
      yLabel,
      xKind: 'category',
      categories,
      gates: gateFor(field),
      series,
    };
  };

  const n = rows[0]?.n ?? 0;
  return {
    title: 'Experiment 1, figure 4 — each degradation condition on its own',
    subtitle: `3 camera positions, 640x480, 4 floor references at sigma = 3 mm, ${n} seeds each. Every condition is switched on against the noiseless reference, not against the one before it.`,
    columns: 3,
    legend: [
      { label: 'measured (median, range over seeds)', color: PALETTE.tripod },
      { label: 'quadrature prediction for "all"', color: PALETTE.prediction, dashed: true },
    ],
    panels: [
      panel('posePositionMm', 'Pose position error', 'worst projector, mm (log)'),
      panel('gridDisplacementMm', 'Grid-line displacement', 'mm on sphere surface (log)'),
      panel('rmsResidualPx', 'RMS reprojection residual', 'projector px (log)'),
    ],
    caption: [
      '"rolling shutter" is a rolling readout with a STATIC camera. packages/bench/test/capture.test.ts proves it is bit-identical to a global shutter;',
      'the row is measured anyway, because reporting a zero the brief asked for is a result and omitting it would leave the question open.',
      '"motion, global shutter" isolates the inter-frame half of handheld drift; the gap to "motion + rolling" is the shutter\'s own contribution.',
    ],
  };
}
