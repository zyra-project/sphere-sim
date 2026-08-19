/**
 * Experiment 4's figure.
 *
 * Built on `experiment1/svg.ts` rather than on a third plotting kit. There are
 * already two in this package and the survey that preceded this experiment named
 * a third as the thing not to do; `renderFigure` takes a `FigureSpec` and this
 * file computes nothing that is not already in a `Cell`.
 *
 * The design rules it inherits are `svg.ts`'s own: log axes where the data spans
 * decades — and this one spans two — every seed drawn as a dot rather than only
 * the median, out-of-range points clamped to the frame and MARKED rather than
 * dropped, and nothing referenced outside the file.
 */

import type { FigureSpec, Panel, PlotSeries } from '../experiment1/svg.ts';
import { PALETTE, renderFigure } from '../experiment1/svg.ts';
import type { Cell, SpillExperimentResult } from './run.ts';

const ROOM_COLORS = [PALETTE.tripod, PALETTE.handheld, PALETTE.third, PALETTE.fourth];

function roomLabel(wallRadiusM: number | null): string {
  return wallRadiusM === null ? 'no room (as published)' : `wall at ${wallRadiusM} m`;
}

function seriesForRooms(
  cells: Cell[],
  value: (c: Cell) => { median: number; min: number; max: number; values: number[] },
): PlotSeries[] {
  const rooms = [...new Set(cells.map((c) => c.wallRadiusM))];
  return rooms.map((room, i) => {
    const mine = cells
      .filter((c) => c.wallRadiusM === room)
      .sort((a, b) => a.minModulation - b.minModulation);
    return {
      label: roomLabel(room),
      color: ROOM_COLORS[i % ROOM_COLORS.length],
      points: mine.map((c) => {
        const d = value(c);
        return { x: c.minModulation, y: d.median, lo: d.min, hi: d.max, values: d.values, n: c.n };
      }),
    };
  });
}

export function renderSpillSvg(result: SpillExperimentResult): string {
  const { cells } = result;
  const base = cells.find((c) => c.wallRadiusM === null && c.minModulation === 0.02);

  const pose: Panel = {
    title: 'What the room costs the recovered pose',
    subtitle: 'worst projector position error after gauge alignment',
    xLabel: 'decoder modulation floor (minModulation)',
    yLabel: 'pose error, mm (log)',
    xKind: 'log',
    series: seriesForRooms(cells, (c) => c.posePositionMm),
    refLines:
      base === undefined
        ? []
        : [
            {
              value: base.posePositionMm.median,
              label: `no room, shipped floor: ${base.posePositionMm.median.toFixed(0)} mm`,
              color: PALETTE.tripod,
            },
          ],
    footnote:
      'The leftmost point of every series is the shipped decoder floor. Every seed is a dot; the ' +
      'line is the median of five.',
  };

  const contamination: Panel = {
    title: 'Why: correspondences that never touched the sphere',
    subtitle: 'share of the accepted set whose camera ray missed the ball',
    xLabel: 'decoder modulation floor (minModulation)',
    yLabel: 'off-sphere share of accepted correspondences',
    xKind: 'log',
    series: seriesForRooms(cells, (c) => c.offSphereFrac),
    footnote:
      'Measured against ground truth and reported only — the solver never sees it. This is the ' +
      'mechanism the panel on the left is explained by; without it the finding is a correlation.',
  };

  const spec: FigureSpec = {
    title: 'Experiment 4 — what the room behind the sphere costs a calibration',
    subtitle:
      `${result.generatedFrom.seedCount} seeds per cell · archetype ` +
      `${result.generatedFrom.archetypeIndex} · ${result.generatedFrom.preset} preset · ` +
      `ceiling ${result.generatedFrom.ceilingM} m · root seed ${result.generatedFrom.rootSeed}`,
    panels: [pose, contamination],
    legend: [...new Set(cells.map((c) => c.wallRadiusM))].map((room, i) => ({
      label: roomLabel(room),
      color: ROOM_COLORS[i % ROOM_COLORS.length],
    })),
    caption: [
      result.verdict.statement,
      'The room is a cylinder about the sphere’s axis with a flat floor and ceiling and no',
      'furniture; both of its constants are class ASSUME and nobody has measured a gallery. It is a',
      'floor on the effect, not a bound — see the cuts in the results file.',
    ],
    columns: 2,
  };
  return renderFigure(spec);
}
