/**
 * Experiment 5's figure.
 *
 * Built on `experiment1/svg.ts`, like experiment 4's, and inherits its rules:
 * every seed is drawn as a dot rather than only the median, ranges are whiskers,
 * and nothing is referenced outside the file.
 *
 * The axis is CATEGORICAL here rather than swept, because the experiment
 * compares four conditions rather than moving a knob. The y axis is log on both
 * pose panels: the unsegmented room reaches six figures of millimetres and the
 * image-space arm does not leave two, and a linear axis would draw the whole
 * finding as one flat line along the bottom.
 */

import type { FigureSpec, Panel, PlotPoint, PlotSeries } from '../experiment1/svg.ts';
import { PALETTE, renderFigure } from '../experiment1/svg.ts';
import type { Cell } from '../spill/run.ts';
import { medianOf } from '../spill/run.ts';
import type { SegmentationResult } from './run.ts';

const ARM_COLOR = {
  clean: PALETTE.tripod,
  room: PALETTE.gate,
  geometric: PALETTE.handheld,
  image: PALETTE.third,
};

function point(cell: Cell | undefined, x: number, of: (c: Cell) => number[]): PlotPoint | null {
  if (cell === undefined) return null;
  const values = of(cell).filter((v) => Number.isFinite(v));
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    x,
    // The SAME median the results file records. This used to take the upper of
    // the two middle observations, which at thirty seeds is a different number.
    y: medianOf(values),
    lo: sorted[0],
    hi: sorted[sorted.length - 1],
    values,
    n: values.length,
  };
}

/** One series per condition, positioned along a categorical axis. */
function armSeries(
  cells: Record<string, Cell>,
  keys: { key: string; x: number }[],
  label: (k: string) => string,
  color: (k: string) => string,
  of: (c: Cell) => number[],
): PlotSeries[] {
  return keys
    .map(({ key, x }) => {
      const p = point(cells[key], x, of);
      return p === null ? null : { label: label(key), color: color(key), points: [p] };
    })
    .filter((s): s is PlotSeries => s !== null);
}

const CONDITIONS = ['clean', 'room', 'geometric', 'image'] as const;
const CONDITION_LABEL: Record<string, string> = {
  clean: 'no room',
  room: 'room, no segmentation',
  geometric: 'room, geometric segmentation',
  image: 'room, image-space segmentation',
};
const CATEGORIES = ['no room', 'room', 'geometric', 'image-space'];

export function renderSegmentationSvg(result: SegmentationResult): string {
  const { cells, verdict } = result;
  const poseOf = (c: Cell): number[] => c.runs.map((r) => r.posePositionMm);
  const offOf = (c: Cell): number[] => c.runs.map((r) => r.offSphereFrac);
  const keys = CONDITIONS.map((k, i) => ({ key: k as string, x: i }));
  const ltKeys = CONDITIONS.map((k, i) => ({ key: `lt-${k}`, x: i }));
  const colorFor = (k: string): string =>
    ARM_COLOR[k.replace(/^lt-/, '') as keyof typeof ARM_COLOR] ?? PALETTE.muted;
  const labelFor = (k: string): string => CONDITION_LABEL[k.replace(/^lt-/, '')] ?? k;
  const cleanMedian = point(cells.clean, 0, poseOf)?.y;

  const pose: Panel = {
    title: 'What each segmentation recovers',
    subtitle: 'worst projector position error after gauge alignment, 30 paired rig draws',
    xLabel: 'condition (archetype 1, wall at 6 m)',
    yLabel: 'pose error, mm (log)',
    xKind: 'category',
    categories: CATEGORIES,
    series: armSeries(cells, keys, labelFor, colorFor, poseOf),
    refLines:
      cleanMedian === undefined
        ? []
        : [
            {
              value: cleanMedian,
              label: `no room: ${cleanMedian.toFixed(1)} mm`,
              color: PALETTE.tripod,
            },
          ],
    footnote:
      'Every dot is one rig draw, and the same thirty draws appear in every column — so a column ' +
      'is comparable to its neighbour draw by draw, not only in aggregate. The whiskers are the ' +
      'observed range, which is the point: the image-space column has no tail.',
  };

  const contamination: Panel = {
    title: 'Why: correspondences that never touched the sphere',
    subtitle: 'share of the accepted set whose camera ray missed the ball',
    xLabel: 'condition (archetype 1, wall at 6 m)',
    yLabel: 'off-sphere share of accepted correspondences',
    xKind: 'category',
    categories: CATEGORIES,
    series: armSeries(cells, keys, labelFor, colorFor, offOf),
    footnote:
      'Measured against ground truth and reported only — neither segmentation can see it. The ' +
      'geometric test thins this population; the image-space test removes it.',
  };

  const longThrow: Panel = {
    title: 'When the nominal rig is 0.96 m wrong',
    subtitle: 'the long-throw archetype: truth 6.14 m, operator hands over 5.18 m',
    xLabel: 'condition (long-throw, wall at 6 m)',
    yLabel: 'pose error, mm (log)',
    xKind: 'category',
    categories: CATEGORIES,
    series: armSeries(cells, ltKeys, labelFor, colorFor, poseOf),
    footnote:
      'The causal test. The geometric segmentation consults the nominal rig, so a nominal this ' +
      'wrong should cost it; the image-space one never reads a rig, so it should not notice. ' +
      'Falsifiers G6 and G7 are exactly these two predictions and are judged on the share of ' +
      'seeds meeting THIS archetype’s own clean bar.',
  };

  const spec: FigureSpec = {
    title: 'Experiment 5 — segmenting the sphere in the photograph',
    subtitle:
      `${result.generatedFrom.seedCount} paired rig draws per condition, archetype ` +
      `${result.generatedFrom.archetypeIndex} and long-throw, wall at ` +
      `${result.generatedFrom.wallRadiusM} m, shipped decoder threshold`,
    panels: [pose, contamination, longThrow],
    legend: CONDITIONS.map((k) => ({ label: CONDITION_LABEL[k], color: ARM_COLOR[k] })),
    caption: [
      verdict.statement,
      'Log axes on both pose panels because the unsegmented room reaches six figures of ' +
        'millimetres while the image-space arm does not leave two; on a linear axis the entire ' +
        'finding would be one flat line along the bottom.',
      'Every comparison is paired: seed i is the same rig draw in every condition, so the ' +
        'difference between two columns is the segmentation and not the draw. Experiment 4 ' +
        'shipped ratios of unpaired five-sample medians and had to be corrected; this does not ' +
        'repeat that.',
    ],
    columns: 2,
  };
  return renderFigure(spec);
}
