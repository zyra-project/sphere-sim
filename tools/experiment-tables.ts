// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The tables in the experiment write-ups, generated from the results files.
 *
 * ## Why this exists
 *
 * Three separate times, a number in an experiment page disagreed with the
 * results file it was supposedly reporting. Once a reviewer caught it; once the
 * page was corrected and the correction was ALSO wrong; and once the page and
 * the file had simply never agreed, at any commit, because the page was written
 * from one run and the file regenerated from another. Every one of those was a
 * human copying a number out of a JSON file by eye.
 *
 * So the tables are no longer copied. Each one sits between a pair of marker
 * comments in the markdown and is produced by a function here:
 *
 *     <!-- generated: experiment-5-arms -->
 *     | arm | median | ... |
 *     <!-- /generated -->
 *
 * `npm run check:docs` regenerates every block and fails if what it produced is
 * not what the file already says. `--write` updates them instead. The check runs
 * in CI, so a results file that moves without its page moving is a red build
 * rather than a page nobody re-read.
 *
 * What this does NOT cover is prose. A sentence that quotes a figure is still a
 * human writing a number down, and the only defence there is to quote few of
 * them and to take the ones you do quote from the machine-written
 * `verdict.statement` in the results file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One measured run, as the experiment runners write it. */
interface PointRun {
  posePositionMm: number;
  offSphereFrac: number;
  /** Absent or non-finite when the recovered rig is too wrong to evaluate it on. */
  gridMm?: number | null;
  wallRadiusM: number | null;
  minModulation: number;
  segmentMarginFrac: number | null;
}

interface Cell {
  runs: PointRun[];
}

/**
 * Millimetres, formatted once.
 *
 * One rule, applied everywhere, rather than the by-eye mixture the hand-written
 * tables carried (a maximum rounded to `52` in one column beside a minimum of
 * `7.8` in the next). Thin spaces above a thousand because these run to seven
 * digits and `1199120` is not a number anybody reads.
 */
export function mm(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1000) return Math.round(value).toLocaleString('en-US').replace(/,/g, ' ');
  return value.toFixed(1);
}

/** A share, as a percentage to two places. */
export function share(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

/** The median, defined the same way the runners define it. */
export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return Number.NaN;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Row {
  label: string;
  cell: Cell;
  emphasis?: boolean;
}

/**
 * How many seeds produced a grid-displacement number at all.
 *
 * In the worst cells the metric comes back absent: the recovered rig is so wrong
 * it cannot be evaluated on. That is a finding rather than a gap -- a pipeline
 * reporting only a gate verdict would show a pass -- so the count travels beside
 * the pose error.
 */
function usableGrid(cell: Cell): string {
  const total = cell.runs.length;
  const usable = cell.runs.filter((r) => typeof r.gridMm === 'number' && Number.isFinite(r.gridMm)).length;
  return `${usable}/${total}`;
}

/** median / min / max / off-sphere share, one row per arm. */
function poseTable(rows: Row[], firstColumn = 'arm', withGrid = false): string {
  const head = withGrid
    ? `| ${firstColumn} | median | min | max | off-sphere share | usable grid metric |`
    : `| ${firstColumn} | median | min | max | off-sphere share |`;
  const rule = withGrid ? '| --- | ---: | ---: | ---: | ---: | --- |' : '| --- | ---: | ---: | ---: | ---: |';
  const out = [head, rule];
  for (const { label, cell, emphasis } of rows) {
    const pose = cell.runs.map((r) => r.posePositionMm);
    const off = cell.runs.map((r) => r.offSphereFrac);
    const b = (s: string): string => (emphasis ? `**${s}**` : s);
    const grid = withGrid ? ` ${usableGrid(cell)} |` : '';
    out.push(
      `| ${b(label)} | ${b(mm(medianOf(pose)))} | ${mm(Math.min(...pose))} | ` +
        `${b(mm(Math.max(...pose)))} | ${b(share(medianOf(off)))} |${grid}`,
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Experiment 5
// ---------------------------------------------------------------------------

interface Experiment7 {
  summary: {
    scope: string;
    arm: string;
    facets: number;
    shiftKnown: boolean;
    control: string;
    n: number;
    medianPosMm: number;
    medianRotDeg: number;
    medianResidualPx: number;
    medianIterations: number;
    posVsControl: number;
    rotVsControl: number;
    residualVsControl: number;
    bodyDeficitMaxMm: number;
    notConverged: number;
    gaugeConstraints: number[];
  }[];
  mechanism: {
    label: string;
    facetArm: string;
    smoothArm: string;
    facetMedianPosMm: number;
    smoothMedianPosMm: number;
    controlMedianPosMm: number;
    posRecoveredPercent: number | null;
    facetMedianRotDeg: number;
    smoothMedianRotDeg: number;
    controlMedianRotDeg: number;
    rotRecoveredPercent: number | null;
    pairs: number;
    axes: { axis: string; facetMedianDeg: number; smoothMedianDeg: number; smoothWins: number; signP: number }[];
    posSmoothWins: number;
    rotSmoothWins: number;
    posSignP: number;
    rotSignP: number;
    smoothResidualOverFacet: number;
  }[];
}

interface Experiment6 {
  summary: {
    scope: string;
    arm: string;
    meshMedianRotDeg: number;
    sphereMedianRotDeg: number;
    meshMedianResidualPx: number;
  }[];
}

interface Experiment5 {
  cells: Record<string, Cell>;
  generatedFrom: { arms: { key: string; label: string }[] };
  verdict: {
    recoveryByArchetype: Record<string, { geometric: number; image: number; headToHead: number }>;
    geometricOffSphereFrac: number;
    imageOffSphereFrac: number;
    usableShare: Record<string, number>;
    cleanCostFactor: number;
    silhouetteFailures: number;
    silhouetteCaptures: number;
    imageVsRoom: Paired;
    geometricVsRoom: Paired;
    imageOverGeometric: Paired;
  };
}

interface Paired {
  geometricMean: number;
  improved: number;
  n: number;
  usableBefore: number;
  usableAfter: number;
}

function labelOf(result: Experiment5, key: string): string {
  return result.generatedFrom.arms.find((a) => a.key === key)?.label ?? key;
}

/** The archetype-1 arms. */
function experiment5Arms(result: Experiment5): string {
  const keys = ['clean', 'room', 'geometric', 'image', 'image-clean'];
  return poseTable(
    keys.map((k) => ({
      label: labelOf(result, k),
      cell: result.cells[k],
      emphasis: k === 'image',
    })),
  );
}

/** The long-throw arms, whose labels carry the archetype and are trimmed here. */
function experiment5LongThrow(result: Experiment5): string {
  const keys = ['lt-clean', 'lt-room', 'lt-geometric', 'lt-image'];
  return poseTable(
    keys.map((k) => ({
      label: labelOf(result, k).replace(/^long-throw, /, ''),
      cell: result.cells[k],
      emphasis: k === 'lt-image',
    })),
  );
}

/** Solves no worse than the archetype's own worst clean solve. */
function experiment5Usable(result: Experiment5): string {
  const worst = Math.max(...result.cells.clean.runs.map((r) => r.posePositionMm));
  const n = result.cells.clean.runs.length;
  const rows: [string, string][] = [
    ['clean capture, no room', 'clean'],
    ['room, no segmentation', 'room'],
    ['room, geometric segmentation', 'geometric'],
    ['room, image-space segmentation', 'image'],
  ];
  const out = [
    `| | usable solves |`,
    `| --- | --- |`,
  ];
  for (const [label, key] of rows) {
    const count = Math.round(result.verdict.usableShare[key] * n);
    const emphasise = key === 'room' || key === 'image';
    const cell = emphasise ? `**${count} / ${n}**` : `${count} / ${n}`;
    out.push(`| ${label} | ${cell} |`);
  }
  out.push('');
  out.push(`_The bar is this archetype's own worst clean solve, ${mm(worst)} mm — set by the data rather than chosen._`);
  return out.join('\n');
}

/** What the long-throw archetype did to the explanation. */
function experiment5Archetypes(result: Experiment5): string {
  const r = result.verdict.recoveryByArchetype;
  const geoOff = result.verdict.geometricOffSphereFrac;
  const ltGeoOff = medianOf(result.cells['lt-geometric'].runs.map((x) => x.offSphereFrac));
  return [
    '| | archetype 1 | long-throw |',
    '| --- | ---: | ---: |',
    `| geometric: paired recovery vs the room | ${r.nominal.geometric.toFixed(1)}× | **${r['long-throw'].geometric.toFixed(1)}×** |`,
    `| image-space: paired recovery vs the room | ${r.nominal.image.toFixed(1)}× | **${r['long-throw'].image.toFixed(1)}×** |`,
    `| head to head (image ÷ geometric) | ${r.nominal.headToHead.toFixed(1)}× | **${r['long-throw'].headToHead.toFixed(2)}×** |`,
    `| geometric: contamination it fails to remove | ${share(geoOff)} | **${share(ltGeoOff)}** |`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Experiment 4
// ---------------------------------------------------------------------------

interface Experiment4 {
  cells: Record<string, Cell>;
}

function cellsOf(
  result: Experiment4,
  match: (r: PointRun) => boolean,
): Cell | undefined {
  return Object.values(result.cells).find((c) => c.runs.length > 0 && match(c.runs[0]));
}

/** What the room costs at the shipped decoder threshold. */
function experiment4Rooms(result: Experiment4): string {
  const walls: (number | null)[] = [null, 9, 6, 4];
  const rows: Row[] = [];
  for (const wall of walls) {
    const cell = cellsOf(
      result,
      (r) => r.wallRadiusM === wall && r.minModulation === 0.02 && r.segmentMarginFrac === null,
    );
    if (!cell) continue;
    rows.push({
      label: wall === null ? 'none (as published)' : `wall at ${wall} m`,
      cell,
      emphasis: wall === null,
    });
  }
  return poseTable(rows, 'room', true);
}

/** The decoder modulation-floor sweep, clean against a 6 m room. */
function experiment4Modulation(result: Experiment4): string {
  const out = [
    '| threshold | no room | wall at 6 m | room ÷ clean, same floor |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const floor of [0.02, 0.1, 0.2, 0.4]) {
    const clean = cellsOf(
      result,
      (r) => r.wallRadiusM === null && r.minModulation === floor && r.segmentMarginFrac === null,
    );
    const room = cellsOf(
      result,
      (r) => r.wallRadiusM === 6 && r.minModulation === floor && r.segmentMarginFrac === null,
    );
    if (!clean || !room) continue;
    const cleanPose = clean.runs.map((r) => r.posePositionMm);
    const roomPose = room.runs.map((r) => r.posePositionMm);
    const ratio = medianOf(roomPose) / medianOf(cleanPose);
    const shipped = floor === 0.02;
    const b = (s: string): string => (shipped ? `**${s}**` : s);
    const label = shipped ? '**0.02 (shipped)**' : floor.toFixed(2);
    out.push(
      `| ${label} | ${b(`${mm(medianOf(cleanPose))} [${mm(Math.min(...cleanPose))} – ${mm(Math.max(...cleanPose))}]`)} ` +
        `| ${b(`${mm(medianOf(roomPose))} [${mm(Math.min(...roomPose))} – ${mm(Math.max(...roomPose))}]`)} ` +
        `| ${ratio >= 100 ? Math.round(ratio) : ratio.toFixed(2)}× |`,
    );
  }
  return out.join('\n');
}

/** The segmentation margin sweep. */
function experiment4Segmentation(result: Experiment4): string {
  const out = [
    '| room | no segmentation | margin 0 | margin 0.05 | margin 0.15 | best |',
    '| --- | ---: | ---: | ---: | ---: | :--- |',
  ];
  for (const wall of [null, 9, 6, 4] as (number | null)[]) {
    const parts: string[] = [];
    let best = '—';
    let bestMedian = Number.POSITIVE_INFINITY;
    for (const margin of [null, 0, 0.05, 0.15] as (number | null)[]) {
      const cell = cellsOf(
        result,
        (r) =>
          r.wallRadiusM === wall && r.minModulation === 0.02 && r.segmentMarginFrac === margin,
      );
      if (!cell) {
        parts.push('—');
        continue;
      }
      const pose = cell.runs.map((r) => r.posePositionMm);
      const centre = medianOf(pose);
      parts.push(`${mm(centre)} [${mm(Math.min(...pose))} – ${mm(Math.max(...pose))}]`);
      // The argmin over the SEGMENTED margins only: 'best margin' is a choice
      // among margins, and 'no segmentation' is not one of them.
      if (margin !== null && centre < bestMedian) {
        bestMedian = centre;
        best = String(margin);
      }
    }
    const label = wall === null ? '**none**' : `wall at ${wall} m`;
    out.push(`| ${label} | ${parts.join(' | ')} | ${best} |`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The block registry
// ---------------------------------------------------------------------------

interface Block {
  doc: string;
  data: string;
  render: (result: never) => string;
  /**
   * Prepended to every generated line. `'> '` for a block that lives inside a
   * blockquote, where an unprefixed table would silently fall out of the quote
   * and render as a separate element.
   */
  prefix?: string;
}


/**
 * Experiment 6's arms, over the full seed set.
 *
 * Both bodies and the residual in one table, because the finding is a
 * COMPARISON and not a number: rotation error leaving while the residual stays
 * put is what separates a degeneracy from a solver defect, and a table that
 * reported only the rotation would let either reading stand.
 */
function experiment6Arms(result: Experiment6): string {
  const rows = result.summary.filter((s) => s.scope === 'all');
  const free = rows.find((s) => s.arm === 'free');
  const out = [
    '| arm | sphere rot | **mesh rot** | mesh/sphere | mesh rot removed | mesh residual |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const removed =
      free === undefined ? 0 : (1 - r.meshMedianRotDeg / free.meshMedianRotDeg) * 100;
    out.push(
      `| \`${r.arm}\` | ${r.sphereMedianRotDeg.toFixed(4)}° | **${r.meshMedianRotDeg.toFixed(4)}°** | ` +
        `${(r.meshMedianRotDeg / r.sphereMedianRotDeg).toFixed(2)}x | ` +
        `${removed >= 0 ? '' : ''}${removed.toFixed(1)}% | ${r.meshMedianResidualPx.toFixed(5)} px |`,
    );
  }
  return out.join('\n');
}

/**
 * Experiment 7's arms, over the full seed set.
 *
 * Position AND rotation AND the residual in one table, because no one of them
 * decides anything here. A pose difference at an unchanged residual is two
 * calibrations fitting the same photographs, which is a degenerate direction
 * rather than a better fit — and the document this corrects reached its reading
 * by looking at position alone.
 */
function experiment7Arms(result: Experiment7): string {
  const rows = result.summary.filter((s) => s.scope === 'all');
  const out = [
    // `n` is a column and not a footnote: these are medians over a seed set the
    // drop policy shrinks, and a median whose sample size is not on the same row
    // is an invitation to read it as the whole sweep.
    '| arm | facets | shift | n | median pos | vs control | median rot | vs control | residual | vs control | iters |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    out.push(
      `| \`${r.arm}\` | ${r.facets === 0 ? '—' : r.facets.toLocaleString('en-US')} | ` +
        `${r.shiftKnown ? 'at truth' : 'free'} | ${r.n} | ${r.medianPosMm.toFixed(1)} mm | ` +
        `${r.posVsControl.toFixed(2)}x | **${r.medianRotDeg.toFixed(4)}°** | ` +
        `${r.rotVsControl.toFixed(2)}x | ${r.medianResidualPx.toFixed(5)} px | ` +
        `${r.residualVsControl.toFixed(3)}x | ${r.medianIterations.toFixed(0)} |`,
    );
  }
  return out.join('\n');
}

/**
 * The pairs where the derivative is the only thing that changed.
 *
 * The one table in this experiment that isolates anything: same mesh, same
 * photographs, same starting rig, two normals. The `vs control` columns of the
 * table above cannot do that, because a control with no facets is also a
 * different body.
 */
/**
 * The recovered fraction, or an em dash.
 *
 * Null means there was no meaningful positive excess to recover a fraction OF —
 * either the facet arm sat on its control, or it was already BETTER than the
 * control, which the finest grid's rotation row actually is. It does not mean
 * nothing was recovered, so it must not render as `0%`: that is a different
 * claim and a wrong one.
 */
const pct = (v: number | null): string => (v === null ? '— (no excess)' : `${v.toFixed(0)}%`);

function experiment7Mechanism(result: Experiment7): string {
  // The per-arm medians are in the table above; repeating them here would give a
  // reader two places to read the same number out of and one of them to get
  // wrong. This table carries only what belongs to the PAIR.
  const out = [
    '| pair | pos: smooth wins | pos excess recovered | rot: smooth wins | rot excess recovered | smooth residual |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const m of result.mechanism) {
    out.push(
      `| ${m.label} | ${m.posSmoothWins}/${m.pairs}, p=${m.posSignP.toPrecision(2)} | ` +
        `${pct(m.posRecoveredPercent)} | ` +
        `**${m.rotSmoothWins}/${m.pairs}**, p=${m.rotSignP.toPrecision(2)} | ` +
        `${pct(m.rotRecoveredPercent)} | ${m.smoothResidualOverFacet.toFixed(4)}x |`,
    );
  }
  return out.join('\n');
}

/**
 * Which axis the derivative moves, paired by seed.
 *
 * The question `docs/ARBITRARY-SHAPES.md` left open beside the reading this
 * experiment tests — "which directions carry the error has not been measured".
 * Each cell is the worst projector's |error| on that axis, so the three do NOT
 * sum to the rotation total beside them: they say which axis is larger, not how
 * a matrix angle decomposes.
 */
function experiment7Axes(result: Experiment7): string {
  const out = [
    '| pair | axis | facet | smooth | smooth wins | sign test |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const m of result.mechanism) {
    for (const a of m.axes) {
      const better = a.smoothMedianDeg < a.facetMedianDeg;
      out.push(
        `| ${a.axis === m.axes[0].axis ? m.label : ''} | \`${a.axis}\` | ` +
          `${a.facetMedianDeg.toFixed(4)}° | ${better ? '**' : ''}${a.smoothMedianDeg.toFixed(4)}°` +
          `${better ? '**' : ''} | ${a.smoothWins}/${m.pairs} | ${a.signP.toPrecision(2)} |`,
      );
    }
  }
  return out.join('\n');
}


/** Experiment 8 — indexing a folder of photographs under drops and duplicates. */
interface Experiment8Mechanism {
  clean: number;
  refused: number;
  silent: number;
  misplacedWorst: number;
  usableRunsMean: number;
  trialsWithBadUsableRun: number;
  badUsableRunsTotal: number;
  runsOfferedTotal: number;
}

interface Experiment8 {
  generatedFrom: { trials: number; projectors: number; framesPerProjector: number };
  arms: {
    key: string;
    drops: number;
    dupes: number;
    story: string;
    order: Experiment8Mechanism;
    bookends: Experiment8Mechanism;
  }[];
}

function experiment8Arms(result: Experiment8): string {
  const trials = result.generatedFrom.trials;
  const share = (n: number, d: number): string =>
    d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
  const out = [
    '| what went wrong | mechanism | captures silently wrong | runs offered | of those, wrong | runs kept |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const a of result.arms) {
    for (const [name, m] of [
      ['ordering', a.order],
      ['bookends', a.bookends],
    ] as const) {
      out.push(
        `| ${name === 'ordering' ? a.story : ''} | ${name} | ` +
          `${share(m.silent, trials)} | ${m.runsOfferedTotal} | ` +
          `${m.badUsableRunsTotal} (${share(m.badUsableRunsTotal, m.runsOfferedTotal)}) | ` +
          `${m.usableRunsMean.toFixed(2)} / ${result.generatedFrom.projectors} |`,
      );
    }
  }
  return out.join('\n');
}

function experiment8Headline(result: Experiment8): string {
  const faulty = result.arms.filter((a) => a.drops + a.dupes > 0);
  const trials = faulty.length * result.generatedFrom.trials;
  const runsIn = trials * result.generatedFrom.projectors;
  const sum = (pick: (a: Experiment8['arms'][number]) => number): number =>
    faulty.reduce((t, a) => t + pick(a), 0);
  const share = (n: number, d: number): string =>
    d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
  const rows: [string, (a: Experiment8['arms'][number]) => Experiment8Mechanism][] = [
    ['ordering alone', (a) => a.order],
    ['structural bookends', (a) => a.bookends],
  ];
  // Both rates, each against its own denominator. The conditional one is what a
  // caller experiences; the exposure one is what a session costs. Reporting only
  // the second under the first's label was the error review caught.
  const out = [
    `| mechanism | captures silently wrong | runs offered | of those, mis-indexed | mis-indexed per run captured |`,
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [label, pick] of rows) {
    const silent = sum((a) => pick(a).silent);
    const bad = sum((a) => pick(a).badUsableRunsTotal);
    const offered = sum((a) => pick(a).runsOfferedTotal);
    out.push(
      `| ${label} | ${silent} / ${trials} (${share(silent, trials)}) | ${offered} | ` +
        `${bad} (${share(bad, offered)}) | ${share(bad, runsIn)} of ${runsIn} |`,
    );
  }
  return out.join('\n');
}

interface Experiment9Cell {
  key: string;
  startPhase: string;
  dwellS: number;
  exposureS: number;
  trials: number;
  capturesTouched: number;
  straddledTotal: number;
  worstStraddled: number;
  worstBurst: number;
  runsTouchedTotal: number;
  capturesAllRunsTouched: number;
  positionsTouchedTotal: number;
  capturesLosingAWholePosition: number;
}

interface Experiment9 {
  generatedFrom: {
    trials: number;
    frames: number;
    framesPerPosition: number;
    positions: number;
    framesPerRun: number;
    headlineExposureS: number;
    startPhases: string[];
  };
  arms: { key: string; driftPpm: number; jitterS: number; tethered: boolean; story: string }[];
  cells: Experiment9Cell[];
}

/**
 * Find one cell, and distinguish "unshootable" from "missing".
 *
 * `undefined` rendered as `n/a` for every reason was the same fault `at()` in
 * the CLI was added to prevent: a cell absent because of a bug became a
 * plausible-looking table entry. A dwell shorter than the exposure genuinely
 * has no row — the shutter is still open when the next frame is up — and that
 * is the ONLY reason a blank is allowed.
 */
function cell9(
  result: Experiment9,
  key: string,
  phase: string,
  dwellS: number,
  exposureS: number,
): Experiment9Cell | null {
  const found = result.cells.find(
    (c) => c.key === key && c.startPhase === phase && c.dwellS === dwellS && c.exposureS === exposureS,
  );
  if (found !== undefined) return found;
  if (exposureS >= dwellS) return null;
  throw new Error(
    `experiment-9: no cell for ${key} / ${phase} at dwell ${dwellS}s, exposure ${exposureS}s — ` +
      `that combination is shootable, so its absence is a fault rather than a blank`,
  );
}

const share9 = (n: number, d: number): string =>
  d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;

/**
 * The axis the answer turns on: where the first shutter lands.
 *
 * Rows are start phases at one crystal, because the experiment's finding is
 * that this matters more than the clock does.
 */
function experiment9Phase(result: Experiment9): string {
  const exposure = result.generatedFrom.headlineExposureS;
  const dwells = [...new Set(result.cells.map((c) => c.dwellS))].sort((a, b) => a - b);
  const out = [
    `| first shutter | ${dwells.map((d) => `${d} s dwell`).join(' | ')} |`,
    `| --- | ${dwells.map(() => '---').join(' | ')} |`,
  ];
  for (const phase of result.generatedFrom.startPhases) {
    const row = dwells.map((d) => {
      const c = cell9(result, 'intervalometer-100ppm', phase, d, exposure);
      return c === null ? '—' : `${c.capturesTouched} (${share9(c.capturesTouched, c.trials)})`;
    });
    out.push(`| ${phase} | ${row.join(' | ')} |`);
  }
  return out.join('\n');
}

/** Captures touched, by shutter arrangement and dwell, at a uniform start. */
function experiment9Dwell(result: Experiment9): string {
  const exposure = result.generatedFrom.headlineExposureS;
  const dwells = [...new Set(result.cells.map((c) => c.dwellS))].sort((a, b) => a - b);
  const out = [
    `| shutter | ${dwells.map((d) => `${d} s dwell`).join(' | ')} |`,
    `| --- | ${dwells.map(() => '---').join(' | ')} |`,
  ];
  for (const arm of result.arms) {
    const row = dwells.map((d) => {
      const c = cell9(result, arm.key, 'uniform', d, exposure);
      return c === null ? '—' : `${c.capturesTouched} (${share9(c.capturesTouched, c.trials)})`;
    });
    out.push(`| ${arm.key} | ${row.join(' | ')} |`);
  }
  return out.join('\n');
}

/**
 * The shape of a bad capture.
 *
 * "all runs touched" rather than "wholly ruined": the column counts captures
 * where every run holds at least one straddled frame, and what one straddled
 * frame costs a decode is exactly what this experiment does not measure.
 *
 * "position lost" is the separate, stronger property: a camera position in
 * which EVERY photograph straddled. It replaced a column counting captures
 * straddled from frame 1 to frame 408, which only the old single-start model
 * could produce in quantity — three independent start phases make it a
 * coincidence rather than a shape, and reporting a coincidence as the
 * characteristic failure is how the first version of this table read.
 */
function experiment9Shape(result: Experiment9): string {
  const exposure = result.generatedFrom.headlineExposureS;
  const out = [
    '| shutter | start | dwell | captures touched | worst capture | worst burst | all runs touched | position lost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const c of result.cells) {
    if (c.exposureS !== exposure) continue;
    if (c.capturesTouched === 0) continue;
    out.push(
      `| ${c.key} | ${c.startPhase} | ${c.dwellS} s | ${c.capturesTouched} / ${c.trials} | ` +
        `${c.worstStraddled} / ${result.generatedFrom.frames} | ${c.worstBurst} | ` +
        `${c.capturesAllRunsTouched} | ${c.capturesLosingAWholePosition} |`,
    );
  }
  return out.join('\n');
}

const BLOCKS: Record<string, Block> = {
  'experiment-9-phase': {
    doc: 'docs/EXPERIMENT-9.md',
    data: 'experiments/experiment-9.json',
    render: experiment9Phase as (r: never) => string,
  },
  'experiment-9-phase-operator-path': {
    doc: 'docs/OPERATOR-PATH.md',
    data: 'experiments/experiment-9.json',
    render: experiment9Phase as (r: never) => string,
  },
  'experiment-9-dwell': {
    doc: 'docs/EXPERIMENT-9.md',
    data: 'experiments/experiment-9.json',
    render: experiment9Dwell as (r: never) => string,
  },
  'experiment-9-shape': {
    doc: 'docs/EXPERIMENT-9.md',
    data: 'experiments/experiment-9.json',
    render: experiment9Shape as (r: never) => string,
  },
  // The same dwell table in the plan the measurement was run to settle.
  // Registered a second time rather than copied, for the reason the Phase 2
  // entry below gives: Phase 5's status IS this table.
  'experiment-8-headline': {
    doc: 'docs/EXPERIMENT-8.md',
    data: 'experiments/experiment-8.json',
    render: experiment8Headline as (r: never) => string,
  },
  'experiment-8-arms': {
    doc: 'docs/EXPERIMENT-8.md',
    data: 'experiments/experiment-8.json',
    render: experiment8Arms as (r: never) => string,
  },
  // The same headline in the plan the measurement was run to settle. Registered
  // a second time rather than copied: Phase 2's status IS these two numbers, and
  // a hand-typed version of them sitting in the plan would be exactly the fault
  // this file exists to prevent, in the document a reader checks the status in.
  'experiment-8-headline-operator-path': {
    doc: 'docs/OPERATOR-PATH.md',
    data: 'experiments/experiment-8.json',
    render: experiment8Headline as (r: never) => string,
  },
  'experiment-7-axes': {
    doc: 'docs/EXPERIMENT-7.md',
    data: 'experiments/experiment-7.json',
    render: experiment7Axes as (r: never) => string,
  },
  'experiment-7-arms': {
    doc: 'docs/EXPERIMENT-7.md',
    data: 'experiments/experiment-7.json',
    render: experiment7Arms as (r: never) => string,
  },
  'experiment-7-mechanism': {
    doc: 'docs/EXPERIMENT-7.md',
    data: 'experiments/experiment-7.json',
    render: experiment7Mechanism as (r: never) => string,
  },
  // The same table, in the entry that corrects the Phase-5 reading it refutes.
  // A second registration rather than a copy: that entry's whole argument is
  // these numbers, and a hand-copied table there would be the fault this file
  // exists to prevent, sitting inside a paragraph about a claim that rotted.
  'experiment-7-mechanism-arbitrary-shapes': {
    doc: 'docs/ARBITRARY-SHAPES.md',
    data: 'experiments/experiment-7.json',
    render: experiment7Mechanism as (r: never) => string,
  },
  'experiment-6-arms': {
    doc: 'docs/EXPERIMENT-6.md',
    data: 'experiments/experiment-6.json',
    render: experiment6Arms as (r: never) => string,
  },
  'experiment-5-arms': {
    doc: 'docs/EXPERIMENT-5.md',
    data: 'experiments/experiment-5.json',
    render: experiment5Arms as (r: never) => string,
  },
  'experiment-5-long-throw': {
    doc: 'docs/EXPERIMENT-5.md',
    data: 'experiments/experiment-5.json',
    render: experiment5LongThrow as (r: never) => string,
  },
  'experiment-5-usable': {
    doc: 'docs/EXPERIMENT-5.md',
    data: 'experiments/experiment-5.json',
    render: experiment5Usable as (r: never) => string,
    prefix: '> ',
  },
  'experiment-5-archetypes': {
    doc: 'docs/EXPERIMENT-5.md',
    data: 'experiments/experiment-5.json',
    render: experiment5Archetypes as (r: never) => string,
  },
  'experiment-4-rooms': {
    doc: 'docs/EXPERIMENT-4.md',
    data: 'experiments/experiment-4.json',
    render: experiment4Rooms as (r: never) => string,
  },
  'experiment-4-modulation': {
    doc: 'docs/EXPERIMENT-4.md',
    data: 'experiments/experiment-4.json',
    render: experiment4Modulation as (r: never) => string,
  },
  'experiment-4-segmentation': {
    doc: 'docs/EXPERIMENT-4.md',
    data: 'experiments/experiment-4.json',
    render: experiment4Segmentation as (r: never) => string,
  },
};

/** The text a block should contain, from the results file it names. */
export function renderBlock(id: string): string {
  const block = BLOCKS[id];
  if (!block) throw new Error(`unknown generated block ${JSON.stringify(id)}`);
  const result = JSON.parse(fs.readFileSync(path.join(ROOT, block.data), 'utf8')) as never;
  const body = block.render(result);
  if (block.prefix === undefined) return body;
  // Trailing whitespace on an otherwise empty quoted line is what a linter
  // strips and a diff then shows forever, so an empty line keeps a bare marker.
  return body
    .split('\n')
    .map((line) => (line === '' ? block.prefix!.trimEnd() : block.prefix + line))
    .join('\n');
}

const OPEN = (id: string): string => `<!-- generated: ${id} -->`;
const CLOSE = '<!-- /generated -->';

/**
 * Replace, or check, every generated block in every registered document.
 *
 * Returns the ids whose contents did not match what the results file says. A
 * block named in the registry but absent from its document is an error rather
 * than a skip: a table that quietly stopped being checked is the failure this
 * tool exists to prevent.
 */
export function syncDocs(write: boolean): { mismatched: string[]; missing: string[] } {
  const mismatched: string[] = [];
  const missing: string[] = [];
  const byDoc = new Map<string, string[]>();
  for (const [id, block] of Object.entries(BLOCKS)) {
    byDoc.set(block.doc, [...(byDoc.get(block.doc) ?? []), id]);
  }

  for (const [doc, ids] of byDoc) {
    const file = path.join(ROOT, doc);
    let text = fs.readFileSync(file, 'utf8');
    let changed = false;
    for (const id of ids) {
      const open = OPEN(id);
      const start = text.indexOf(open);
      if (start < 0) {
        missing.push(id);
        continue;
      }
      const bodyStart = start + open.length;
      const end = text.indexOf(CLOSE, bodyStart);
      if (end < 0) {
        missing.push(id);
        continue;
      }
      const current = text.slice(bodyStart, end);
      const wanted = `\n${renderBlock(id)}\n`;
      if (current === wanted) continue;
      mismatched.push(id);
      if (write) {
        text = text.slice(0, bodyStart) + wanted + text.slice(end);
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(file, text);
  }
  return { mismatched, missing };
}

/**
 * Markers in the documentation that no block claims.
 *
 * `syncDocs` catches the opposite direction — a block registered here whose
 * marker has gone from its document — and that is the check this file was
 * written with. It does not catch a marker that was never registered, and the
 * consequence is worse than an unmarked table: the marker ANNOUNCES that the
 * numbers below it are generated, so a reader trusts them and no tool checks
 * them. A hand-copied table wearing a generated table's label.
 *
 * Found by writing one. The experiment-7 entry in ARBITRARY-SHAPES.md was
 * pasted under `<!-- generated: experiment-7-mechanism -->` — an id registered
 * against a DIFFERENT document — and `check:docs` passed, because nothing looks
 * at the markers a document actually carries. The same blind spot
 * `check:ci-parity` had when it read one workflow and called that the set.
 */
export function unregisteredBlocks(): { doc: string; id: string }[] {
  const docs = new Set<string>(Object.values(BLOCKS).map((b) => b.doc));
  for (const name of fs.readdirSync(path.join(ROOT, 'docs'))) {
    if (name.endsWith('.md')) docs.add(path.join('docs', name));
  }
  const out: { doc: string; id: string }[] = [];
  const marker = /<!--\s*generated:\s*([A-Za-z0-9_-]+)\s*-->/g;
  for (const doc of [...docs].sort()) {
    const file = path.join(ROOT, doc);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const seen = new Set<string>();
    for (const m of text.matchAll(marker)) {
      const id = m[1];
      // Registered, but against some OTHER document — which is the case that
      // produced this check and the one a bare `id in BLOCKS` would miss.
      if (BLOCKS[id]?.doc !== doc) {
        out.push({ doc, id });
        continue;
      }
      // A SECOND occurrence of a properly registered id, which the first version
      // of this check waved through. `syncDocs` finds a block with `indexOf`, so
      // it regenerates the first occurrence and never looks at the rest: a
      // duplicate marker keeps the generated label over a table nothing writes
      // or compares. The same hole as an unregistered marker, one step further
      // in. Caught in review.
      if (seen.has(id)) out.push({ doc, id });
      seen.add(id);
    }
  }
  return out;
}

function main(): void {
  const write = process.argv.includes('--write');

  const stray = unregisteredBlocks();
  if (stray.length > 0) {
    process.stderr.write(
      `\nThese documents carry a generated-table marker that no block renders into them:\n` +
        stray.map(({ doc, id }) => `  ${doc}: ${OPEN(id)}\n`).join('') +
        `\nA marker tells a reader the table below it is machine-written and checked.\n` +
        `One nothing renders is a hand-copied table wearing that label, which is worse\n` +
        `than an unmarked one. Register it in BLOCKS, or take the marker off.\n\n`,
    );
    process.exit(1);
  }

  const { mismatched, missing } = syncDocs(write);

  if (missing.length > 0) {
    process.stderr.write(
      `\nThese generated blocks are registered but not present in their document:\n` +
        missing.map((id) => `  ${id}  (expected ${OPEN(id)} ... ${CLOSE})\n`).join('') +
        `\nA table that stopped being checked is the failure this tool exists to prevent.\n\n`,
    );
    process.exit(1);
  }

  if (mismatched.length === 0) {
    process.stdout.write('check:docs: every generated table matches its results file\n');
    return;
  }

  if (write) {
    process.stdout.write(`check:docs: rewrote ${mismatched.length} block(s): ${mismatched.join(', ')}\n`);
    return;
  }

  process.stderr.write(
    `\nThese tables disagree with the results files they report:\n` +
      mismatched.map((id) => `  ${id}\n`).join('') +
      `\nThe results file is the measurement; the page is a report of it. Run:\n\n` +
      `    npm run check:docs -- --write\n\n` +
      `and read the diff — if a number moved, the prose around it probably needs to move too.\n\n`,
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
