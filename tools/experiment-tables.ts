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
    fingerprint: Experiment8Mechanism;
  }[];
}

/**
 * The mechanisms in the order they were built, which is also worst to best.
 *
 * Accessors rather than key names, so the compiler checks them. A `keyof` over
 * the arm type also admits `key`, `drops`, `dupes` and `story`, and the cast
 * that made those compile would have rendered `NaN%` and `undefined` into the
 * table — caught, if at all, by `check:docs` comparing against committed
 * markdown rather than by the build. Review caught it instead.
 */
const EXPERIMENT_8_MECHANISMS: [
  string,
  (a: Experiment8['arms'][number]) => Experiment8Mechanism,
][] = [
  ['ordering', (a) => a.order],
  ['bookends', (a) => a.bookends],
  ['fingerprint', (a) => a.fingerprint],
];

function experiment8Arms(result: Experiment8): string {
  const trials = result.generatedFrom.trials;
  const share = (n: number, d: number): string =>
    d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
  const out = [
    '| what went wrong | mechanism | captures silently wrong | runs offered | of those, wrong | runs kept |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const a of result.arms) {
    for (const [name, pick] of EXPERIMENT_8_MECHANISMS) {
      const m = pick(a);
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
    ['bookends + complement fingerprint', (a) => a.fingerprint],
  ];
  // Both rates, each against its own denominator. The conditional one is what a
  // caller experiences; the exposure one is what a session costs. Reporting only
  // the second under the first's label was the error review caught.
  // `carrying` sits next to `silent` on purpose. The gap between them IS the
  // finding — a capture refused as a whole can still hand back a run it got
  // wrong — and it used to be prose carrying a hand-computed multiplier, which
  // said "a factor of three" while the file said two. Nothing checked it,
  // because this was the one number in the results that no table rendered.
  const out = [
    `| mechanism | captures silently wrong | captures carrying a wrong run | runs offered | ` +
      `of those, mis-indexed | mis-indexed per run captured |`,
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const [label, pick] of rows) {
    const silent = sum((a) => pick(a).silent);
    const carrying = sum((a) => pick(a).trialsWithBadUsableRun);
    const bad = sum((a) => pick(a).badUsableRunsTotal);
    const offered = sum((a) => pick(a).runsOfferedTotal);
    out.push(
      `| ${label} | ${silent} / ${trials} (${share(silent, trials)}) | ` +
        `${carrying} / ${trials} (${share(carrying, trials)}) | ${offered} | ` +
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

// ---------------------------------------------------------------------------
// Experiment 10
// ---------------------------------------------------------------------------

/**
 * A distribution as experiment 10 writes one: every figure null when the
 * distribution is empty, which is the one place a dash is allowed.
 */
interface Spread10 {
  n: number;
  min: number | null;
  p10: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
}

/** A share of one cell's captures, with its 95% interval resampling rigs. */
interface Share10 {
  num: number;
  den: number;
  share: number | null;
  lo: number | null;
  hi: number | null;
}

/** A cell's SILENT captures judged at one yardstick. */
interface HarmAt10 {
  tauMm: number;
  judged: number;
  HARMLESS: number;
  BIASED: number;
  'GATE-BREAKING': number;
  exceedTau: number;
}

/** One operator policy's reading of a cell: P re-shoots a refused position whole, A keeps placed runs. */
interface Policy10 {
  counts: Record<string, number>;
  shares: Record<string, Share10>;
  solved: {
    captures: number;
    rotationFlips: number;
    over025: number;
    over05: number;
    withinReshootNoise: number;
    gateBreakingWithinNoise: number;
  };
  silentAgainst: {
    tau: HarmAt10 | null;
    tauLo: HarmAt10 | null;
    tauHi: HarmAt10 | null;
    positionTau: HarmAt10 | null;
  };
  pastGate: { silent: number; loudSilent: number; total: number };
}

/** One re-scored cell: EXPERIMENT-9's photographs at one arm, start, exposure and emitter lateness. */
interface Cell10 {
  id: string;
  spec: {
    arm: string;
    phase: string;
    exposureS: number;
    lateMs: number;
    vsync: boolean;
    readoutS: number;
    which: string;
    /**
     * `policies`: solved under P and A. `first-a`: a subsample solved under A,
     * which P borrows where its plan is A's.
     */
    solve: string;
  };
  trials: number;
  capturesFlagged: number;
  capturesRecorded: number;
  newlyTouched: number;
  touchedPositions: number;
  positions: {
    content: { all: Record<string, number>; excludingMinorMarginal: Record<string, number> };
    filed: { all: Record<string, number> };
  };
  classes: { P: Policy10; A: Policy10 };
  loud: {
    captures: number;
    wholePositionOnly: number;
    runByRun: number;
    reshootNamed: number;
    dropAndDuplicate: number;
  };
  solved: boolean;
  /**
   * The page's own reader on the same captures (the page column). Null in a
   * file written before the column was summarised, as the first full run's was.
   */
  page: Page10 | null;
}

/** A cross of the page's run verdicts (rows) with the counterfactual's deciding outcomes (columns). */
type Cross10 = Record<string, Record<string, number>>;

/** A cell the page column read, or found nothing to read in. */
interface PageRead10 {
  status: 'read' | 'nothing to read';
  rigs: { column: number; of: number };
  read: { captures: number; positions: number; crashes: number; placedAny: number };
  positions: { all: Record<string, number>; excludingMinorMarginal: Record<string, number> };
  classes: {
    P: Policy10 & {
      harm: { silentPart: number; samePlan: number; notSolved: number; why: Record<string, number> };
      /**
       * Capture classes crossed: the counterfactual's (rows) against the page's (columns), collapsed.
       * The page's columns include QUIET, a class the counterfactual cannot have.
       */
      vsCounterfactual: Cross10;
    };
  };
  /**
   * Quiet drops, in whatever position; the SILENT captures with a QUIET position as well; and the
   * captures with no PLACED position where a QUIET position places another touched run.
   */
  quiet: { runs: number; positions: number; captures: number; silentWithQuiet: number; quietPlacingTouched: number };
  loud: {
    captures: number;
    runByRun: number;
    wholePositionOnly: number;
    crashOnly: number;
    reshootNamed: number;
    dropAndDuplicate: number;
  };
  words: { runs: number; byClass: Record<string, number> };
  runs: {
    touched: number;
    attributable: number;
    placed: number;
    refused: number;
    noted: number;
    crashed: number;
    unaccounted: number;
    collateral: number;
    placedNotAttributable: number;
    both: Cross10;
    counterfactualOnly: Cross10;
    pageOnly: Cross10;
    neither: number;
  };
  misfiles: {
    photographs: number;
    positions: number;
    runs: number;
    ambiguous: number;
    share: { min: number | null; max: number | null };
    below055: number;
    histogram: { from: number; to: number; n: number }[];
    list: { t: number; pos: number; photo: number; filedStep: number; contentStep: number; share: number }[] | null;
  };
}

/** The page column in one cell: read, nothing to read, or not run at all (no page-column rig). */
type Page10 = { status: 'not run'; rigs: { column: number; of: number } } | PageRead10;

/** A null distribution of D_grid: re-shoots of a designed rig against its plain twin. */
interface Yardstick10 {
  value: number | null;
  lo: number | null;
  hi: number | null;
  median: number | null;
  samples: number;
  largest: { n: number; byRig: Record<string, number> };
  rotationFlips: { flips: number; of: number };
  gridFlips: { flips: number; of: number };
}

/** One reader's figures on Q0's clean positions: the page's reader now. */
interface Q0Reader10 {
  placedPositions: number;
  runs: number;
  runsPlaced: number;
  unseen: number;
  barelySeen: number;
  problems: number;
  positionsWithProblems: number;
}

/** Q0 per variant in a file that keeps both readers: the page's, and the one it replaced. */
interface Q0TwoReaders10 {
  positions: number;
  page: Q0Reader10;
  replaced: {
    placedPositions: number;
    reasons: Record<string, number>;
    margin: Spread10;
    perRunAlone: { runs: number; rescued: number };
  };
}

/** The page's own reader on each camera's clean twin: what the page column attributes against. */
interface PageTwins10 {
  cameras: number;
  read: number;
  runs: number;
  placed: number;
  unseen: number;
  barelySeen: number;
  refused: number;
  problems: number;
  crashes: number;
  againstCounterfactual: { both: number; counterfactualOnly: number; pageOnly: number; neither: number };
}

/**
 * The precondition, with both readers on the clean positions: Q0 read by the
 * page's reader and by the one it replaced, the counterfactual reader and the
 * page's own on each clean twin, and the folder shapes (Q0b).
 */
interface Precondition10 {
  q0: {
    main: Q0TwoReaders10;
    spill: Q0TwoReaders10;
    fine: Q0TwoReaders10;
    total: number;
    page: Q0Reader10;
    replaced: {
      placedPositions: number;
      minClassifyMargin: number;
      refusedAt: {
        classify: { positions: number; maxMargin: number | null };
        count: { positions: number; margin: Spread10; runsFound: { min: number; max: number } | null };
        other: number;
      };
    };
    worth: { refusal: string | null } | null;
  };
  q0b: {
    shape: string;
    positions: number;
    runsPlaced: number;
    runsPlacedClean: number;
    wholeRefused: number;
    reasons: Record<string, number>;
  }[];
  twins: { main: Twins10; spill: Twins10; fine: Twins10 };
  pageTwins: { main: PageTwins10; spill: PageTwins10; fine: PageTwins10 };
}

/** The counterfactual reader on the clean capture: each camera's twin. */
interface Twins10 {
  cameras: number;
  raster: { width: number; height: number } | null;
  runs: number;
  attributable: number;
  refusedClean: number;
  invisibleRefused: number;
  minor: number;
  marginal: number;
  noiseFloor: Spread10;
  reshootNamed: number;
}

interface DecodeLevel10 {
  direction: string;
  s: number;
  runs: number;
  meanU: Spread10;
  meanV: Spread10;
  ratioU: Spread10;
  ratioV: Spread10;
  mmShift: Spread10;
  movedHalfPeriod: number;
  grayFlips: { matched: number; u: number; v: number } | null;
}

interface SignTally10 {
  pixels: number;
  uPos: number;
  vPos: number;
  uPosShare: number | null;
  vPosShare: number | null;
  maxAbsU: number;
  maxAbsV: number;
}

interface TimingCell10 {
  arm: string;
  phase: string;
  lateMs: number;
  vsync: boolean;
  trials: number;
  capturesTouched: number;
  positionsTouched: number;
  wholePositions: number;
}

interface AimedCrossing10 {
  firstTouchedMs: number | null;
  onePercentMs: number | null;
  bracketMs: [number | null, number] | null;
}

interface H7Clause10 {
  checks: number;
  testable: number;
  untestable: number;
  failures: number;
}

/** Only the fields a table below reads. The file carries far more. */
interface Experiment10 {
  mode: string;
  generatedFrom: {
    verdictSmear: number;
    design: {
      constants: {
        PROJECTORS: number;
        MARGINAL_RESIDUAL: number;
        MARGINAL_BAND: number;
        GRID_GATE_MM: number;
        ROTATION_GATE_DEG: number;
        VSYNC_S: number;
        HEADLESS_LATENESS_MS: { hudTickOff: number; armedTickOn: number };
        EXPECTED: { complements: { pairs: number[][] } };
      };
      plan: {
        pose: boolean;
        decodeNoiseless: number[];
        lateMsTiming: number[];
        lateMsRendered: number[];
        poseLevels: {
          forward: number[];
          backward: number[];
          rolling: { readoutOverExposure: number; midRow: number[] };
        };
      };
    };
  };
  precondition: Precondition10;
  gate: {
    crossings: {
      attributableRuns: number;
      scannedTo: number;
      neverRefused: { forward: number; backward: number };
      forward: Spread10;
      backward: Spread10;
      belowLimitShare: number | null;
      bindingPairForward: Record<string, number>;
      bindingU0Share: number | null;
      withinPositionSpread: { positions: number; spread: Spread10; atLeast002: number };
      u0: {
        runs: number;
        byRenderedCrossing: { upTo?: number; above?: number; runs: number; maxError: number | null }[];
        u0Bound: { runs: number; maxError: number | null };
      };
      lowBackward: { below: number; runs: number; maxLit: number | null; lowest: number | null };
      pairsForward: { pair: string; crossing: Spread10 }[];
    };
    noisy: { agreement: { runs: number; agree: number; share: number | null } };
    spill: { attributable: number; forward: Spread10 };
  };
  decode: {
    curve: DecodeLevel10[];
    forwardMeans: { runLevels: number; nonNegativeU: number; nonNegativeV: number };
    grayFlipsBelowFiveNinths: { matched: number; either: number } | null;
    highestDecoded: number;
    verdictLevel: {
      runs: number;
      absMeanU: Spread10;
      absMeanV: Spread10;
      p95AbsV: Spread10;
      mmShift: Spread10;
      signs: { seam: SignTally10; rest: SignTally10; all: SignTally10 } | null;
    };
  };
  pose: {
    solved: boolean;
    tauNull: Yardstick10;
    tauPosition: Yardstick10;
    levels: {
      label: string;
      cases: number;
      allRefused: number;
      dGridMm: Spread10;
      overTau: number | null;
      overTauPosition: number | null;
      gridFlips: number;
      rotationFlips: number;
    }[];
  };
  rescore: { cells: Cell10[] };
  lateness: {
    timing: TimingCell10[];
    aimed: {
      vsyncOff: AimedCrossing10;
      vsyncOn: AimedCrossing10;
      threshold: {
        aimBandS: number[];
        steps: number;
        driftPpm: number;
        matchedClocksMs: number | null;
        fastCameraMs: number | null;
      };
    };
    cells: Cell10[];
  };
  harness: { id: string; pass: boolean | null; measured: unknown }[];
}

/**
 * A cell a table reads. Absent is a fault and never a blank, for the reason
 * `cell9` gives: a missing cell rendered as a dash is a plausible-looking entry
 * with a bug behind it. The file holds a null on purpose in a few places (an
 * empty distribution, a yardstick nothing was solved for), and only a reader
 * that asks for a nullable value may render one, as a dash.
 */
function has10<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `experiment-10: the results file has no ${what}; a cell a table reads is missing, which is a ` +
        'fault and not a blank',
    );
  }
  return value;
}

/** A finite number, and nothing else. */
function n10(value: number | null | undefined, what: string): number {
  const v = has10(value, what);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`experiment-10: ${what} is ${JSON.stringify(v)}, and the table needs a number there`);
  }
  return v;
}

/** A number the file may hold as null on purpose. Absent still throws. */
function nOrNull10(value: number | null | undefined, what: string): number | null {
  const v = has10(value, what);
  return v === null ? null : n10(v, what);
}

const DASH10 = '—';
const fixed10 =
  (digits: number) =>
  (x: number): string =>
    x.toFixed(digits);
const pct10 = (x: number, digits = 1): string => `${(100 * x).toFixed(digits)}%`;
/** A share that is small and not nothing keeps its figures, as the verdict prints one. */
function pctSmall10(x: number): string {
  if (x === 0) return '0%';
  if (x < 0.001) return `${(100 * x).toFixed(3)}%`;
  if (x < 0.01) return `${(100 * x).toFixed(2)}%`;
  return pct10(x);
}
const orDash10 = (x: number | null, f: (v: number) => string): string => (x === null ? DASH10 : f(x));
/** An interval, or one dash when the file has none. */
const ci10 = (lo: number | null, hi: number | null, f: (v: number) => string): string =>
  lo === null && hi === null ? DASH10 : `${orDash10(lo, f)}–${orDash10(hi, f)}`;
/** A smear, as a share of the exposure: how the crossings are quoted. */
const smear10 = (s: number): string => pct10(s);
/** A smear as the designed arms name it, s itself. */
const s10 = (s: number): string => String(s);

/** One re-scored cell by id: a cell the design runs and the file lacks is a fault, like `cell9`'s. */
function cell10(cells: readonly Cell10[] | undefined, id: string, where: string): Cell10 {
  const found = has10(cells, where).find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`experiment-10: ${where} has no cell ${id}, which the design runs`);
  }
  return found;
}

/** EXPERIMENT-9's cells as the spec's §6 R table lists them, R1 first. */
const RESCORE_IDS10: readonly string[] = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'];

/** The lateness cells the design renders: each rendered lateness, aimed and uniform. */
function latenessIds10(result: Experiment10): string[] {
  const plan = has10(result.generatedFrom?.design?.plan, 'generatedFrom.design.plan');
  return has10(plan.lateMsRendered, 'generatedFrom.design.plan.lateMsRendered').flatMap((ms) =>
    ['aimed', 'uniform'].map((phase) => `L-${phase}-${n10(ms, 'a rendered lateness')}`),
  );
}

/** The refresh rate the vsync arm assumes, from the file. */
function hz10(result: Experiment10): number {
  return Math.round(1 / n10(result.generatedFrom?.design?.constants?.VSYNC_S, 'constants.VSYNC_S'));
}

/** A cell's setting in words, every field it is keyed on. */
function setting10(result: Experiment10, cell: Cell10): string {
  const s = has10(cell.spec, `${cell.id}.spec`);
  const exposure = n10(s.exposureS, `${cell.id}.spec.exposureS`);
  const late = n10(s.lateMs, `${cell.id}.spec.lateMs`);
  const readout = n10(s.readoutS, `${cell.id}.spec.readoutS`);
  const parts = [
    has10(s.arm, `${cell.id}.spec.arm`),
    `${has10(s.phase, `${cell.id}.spec.phase`)} start`,
    `1/${Math.round(1 / exposure)} s`,
    late === 0 ? 'perfect timer' : `emitter ${late} ms late per step`,
  ];
  if (has10(s.vsync, `${cell.id}.spec.vsync`)) parts.push(`${hz10(result)} Hz refresh wait`);
  if (readout > 0) parts.push(`${Math.round(1000 * readout)} ms rolling readout`);
  if (has10(s.which, `${cell.id}.spec.which`) === 'spill') parts.push('room spill on');
  return parts.join(', ');
}

/** What a cell changes from the headline cell, in words; the headline cell itself in full. */
function differs10(result: Experiment10, cell: Cell10, base: Cell10): string {
  if (cell.id === base.id) return setting10(result, cell);
  const mine = setting10(result, cell).split(', ');
  const theirs = new Set(setting10(result, base).split(', '));
  const changed = mine.filter((part) => !theirs.has(part));
  return changed.length === 0 ? DASH10 : changed.join(', ');
}

/** Captures a cell recorded, of its trials, naming any that EXPERIMENT-9's own timer did not flag. */
function touched10(cell: Cell10): string {
  const recorded = n10(cell.capturesRecorded, `${cell.id}.capturesRecorded`);
  const trials = n10(cell.trials, `${cell.id}.trials`);
  const newly = n10(cell.newlyTouched, `${cell.id}.newlyTouched`);
  return `${recorded} of ${trials}${newly > 0 ? ` (${newly} newly touched)` : ''}`;
}

/** A class count with its share of the cell's captures and the share's 95% interval. */
function classShare10(policy: Policy10, name: string, where: string): string {
  const s = has10(has10(policy.shares, `${where}.shares`)[name], `${where}.shares.${name}`);
  const num = n10(s.num, `${where}.shares.${name}.num`);
  const share = nOrNull10(s.share, `${where}.shares.${name}.share`);
  if (share === null) return String(num);
  const lo = n10(s.lo, `${where}.shares.${name}.lo`);
  const hi = n10(s.hi, `${where}.shares.${name}.hi`);
  return `${num} (${pct10(share)}, ${(100 * lo).toFixed(1)}–${pct10(hi)})`;
}

/** The SILENT classes, as the assembly tallies them. */
const SILENT_CLASSES10: readonly string[] = [
  'SILENT-HARMLESS',
  'SILENT-BIASED',
  'SILENT-GATE-BREAKING',
  'SILENT-UNJUDGEABLE',
  'SILENT-UNSOLVED',
];

function count10(policy: Policy10, name: string, where: string): number {
  return n10(has10(policy.counts, `${where}.counts`)[name], `${where}.counts.${name}`);
}

function silent10(policy: Policy10, where: string): number {
  return SILENT_CLASSES10.reduce((a, name) => a + count10(policy, name, where), 0);
}

/**
 * A cell's SILENT captures in one line: "n placed (not solved)" where nothing
 * was solved, as the spec's §7 asks, and the harm classes where it was.
 */
function silentSummary10(cell: Cell10, policy: Policy10, where: string): string {
  const silent = silent10(policy, where);
  const unsolved = count10(policy, 'SILENT-UNSOLVED', where);
  if (!has10(cell.solved, `${cell.id}.solved`) || unsolved === silent) {
    return `${silent} placed (not solved)`;
  }
  const parts = [
    `${count10(policy, 'SILENT-HARMLESS', where)} harmless`,
    `${count10(policy, 'SILENT-BIASED', where)} biased`,
    `${count10(policy, 'SILENT-GATE-BREAKING', where)} gate-breaking`,
  ];
  const unjudgeable = count10(policy, 'SILENT-UNJUDGEABLE', where);
  if (unjudgeable > 0) parts.push(`${unjudgeable} unjudgeable`);
  if (unsolved > 0) parts.push(`${unsolved} not solved`);
  return `${silent}: ${parts.join(', ')}`;
}

/**
 * How many of a cell's captures end past the seam gate, SILENT and LOUD+SILENT
 * together. A cell solved under both policies reads P's count. A cell whose
 * solves are a policy-A subsample reads A's beside P's, because P can borrow an
 * A solve only where the capture has no MIXED position, and P's count alone
 * would hide the rest.
 */
function pastGate10(cell: Cell10): string {
  if (!has10(cell.solved, `${cell.id}.solved`)) return DASH10;
  const P = has10(cell.classes?.P, `${cell.id}.classes.P`);
  const p = n10(P.pastGate?.total, `${cell.id}.classes.P.pastGate.total`);
  const solve = has10(cell.spec?.solve, `${cell.id}.spec.solve`);
  if (solve !== 'first-a') return String(p);
  const A = has10(cell.classes?.A, `${cell.id}.classes.A`);
  return (
    `${p} under P; ${n10(A.pastGate?.total, `${cell.id}.classes.A.pastGate.total`)} of the ` +
    `${n10(A.solved?.captures, `${cell.id}.classes.A.solved.captures`)} solved under A`
  );
}

/**
 * What a reader's refusal says, in each class of its words (`reasonOf`'s, and
 * the finer classes the assembly's `pageWordsOf` splits three of them into):
 * the first eight are where the reader the page replaced stopped a clean
 * position, the rest the page's reader now.
 */
const REASON_WORDS10: Record<string, string> = {
  margin: 'classify',
  count: 'run count',
  length: 'run length',
  kind: 'frame kind',
  broken: 'broken pair',
  unanswered: 'unanswered pair',
  leading: 'photographs before the first white',
  clipping: 'clipping',
  unfound: 'run not found',
  'unfound-room': 'run not found, a room’s light',
  'length-extra': 'a photograph too many after the run',
  'length-slot': 'a run’s count between found neighbours',
  short: 'folder too short',
  dark: 'folder dark or one picture',
  norun: 'no run in the folder',
  numbering: 'runs not numbered',
  'numbering-gap': 'a stretch that is not whole runs',
  reshoot: 're-shoot not matched',
  plan: 'the plan',
  other: 'words not recognised',
};

function reasons10(reasons: Record<string, number> | undefined, where: string): string {
  const entries = Object.entries(has10(reasons, where));
  if (entries.length === 0) return DASH10;
  return entries
    .map(([key, n]) => `${REASON_WORDS10[key] ?? key} ${n10(n, `${where}.${key}`)}`)
    .join(' · ');
}

const Q0_VARIANTS10: readonly (readonly ['main' | 'spill' | 'fine', string])[] = [
  ['main', 'the sweep'],
  ['spill', 'room spill on'],
  ['fine', 'the finer preset'],
];

/**
 * The precondition, both readers on the clean positions: Q0 read by the page's
 * reader and, beside it and labelled as such, by the reader it replaced; the
 * counterfactual reader and the page's own reader on each clean twin; and the
 * folder shapes, which the counterfactual reads.
 *
 * It replaced the one-reader table the first run's file was rendered by, when
 * the re-run with the page's reader wrote `experiments/experiment-10.json`: a
 * file with one reader lacks the other reader's fields (`precondition.pageTwins`,
 * `precondition.q0.replaced`), and is refused here rather than rendered with
 * blanks.
 */
export function experiment10PreconditionTwoReaders(result: Experiment10): string {
  const pre = has10(result.precondition, 'precondition');
  const q0 = has10(pre.q0, 'precondition.q0');
  const twins = has10(pre.twins, 'precondition.twins');
  const pageTwins = has10(pre.pageTwins, 'precondition.pageTwins');
  const replaced = has10(q0.replaced, 'precondition.q0.replaced');
  const minMargin = n10(replaced.minClassifyMargin, 'precondition.q0.replaced.minClassifyMargin');
  const projectors = n10(result.generatedFrom?.design?.constants?.PROJECTORS, 'constants.PROJECTORS');
  const raster = (t: Twins10, where: string): string => {
    const r = has10(t.raster, `${where}.raster`);
    return r === null ? DASH10 : `${n10(r.width, `${where}.raster.width`)}×${n10(r.height, `${where}.raster.height`)}`;
  };
  const readerCells = (r: Q0Reader10, where: string): string =>
    `${n10(r.placedPositions, `${where}.placedPositions`)} | ` +
    `${n10(r.runsPlaced, `${where}.runsPlaced`)} of ${n10(r.runs, `${where}.runs`)} | ` +
    `${n10(r.unseen, `${where}.unseen`)} · ${n10(r.barelySeen, `${where}.barelySeen`)} | ` +
    `${n10(r.problems, `${where}.problems`)}`;
  const out = [
    '| clean positions | raster | positions | the page’s reader: positions placed | runs placed | ' +
      'noted out of view · barely seen | problems | the reader it replaced: positions placed | ' +
      `refused at | its classify margin (needs ${minMargin}): median · max | runs a per-run classify would rescue |`,
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |',
  ];
  for (const [which, label] of Q0_VARIANTS10) {
    const v = has10(q0[which], `precondition.q0.${which}`);
    const t = has10(twins[which], `precondition.twins.${which}`);
    const where = `precondition.q0.${which}`;
    const old = has10(v.replaced, `${where}.replaced`);
    const margin = has10(old.margin, `${where}.replaced.margin`);
    const perRun = has10(old.perRunAlone, `${where}.replaced.perRunAlone`);
    out.push(
      `| ${label} | ${raster(t, `precondition.twins.${which}`)} | ${n10(v.positions, `${where}.positions`)} | ` +
        `${readerCells(has10(v.page, `${where}.page`), `${where}.page`)} | ` +
        `${n10(old.placedPositions, `${where}.replaced.placedPositions`)} | ` +
        `${reasons10(old.reasons, `${where}.replaced.reasons`)} | ` +
        `${orDash10(nOrNull10(margin.median, `${where}.replaced.margin.median`), fixed10(3))} · ` +
        `${orDash10(nOrNull10(margin.max, `${where}.replaced.margin.max`), fixed10(3))} | ` +
        `${n10(perRun.rescued, `${where}.replaced.perRunAlone.rescued`)} of ` +
        `${n10(perRun.runs, `${where}.replaced.perRunAlone.runs`)} |`,
    );
  }
  const at = has10(replaced.refusedAt, 'precondition.q0.replaced.refusedAt');
  const classify = has10(at.classify, 'replaced.refusedAt.classify');
  const count = has10(at.count, 'replaced.refusedAt.count');
  const found = has10(count.runsFound, 'replaced.refusedAt.count.runsFound');
  const countMargin = has10(count.margin, 'replaced.refusedAt.count.margin');
  const nCount = n10(count.positions, 'replaced.refusedAt.count.positions');
  const countWords =
    nCount === 0
      ? '0 at the run count'
      : `${nCount} at the run count, having cleared classify ` +
        `(margin ${orDash10(nOrNull10(countMargin.min, 'replaced.refusedAt.count.margin.min'), fixed10(3))}–` +
        `${orDash10(nOrNull10(countMargin.max, 'replaced.refusedAt.count.margin.max'), fixed10(3))}) and found ` +
        (found === null
          ? DASH10
          : n10(found.min, 'replaced.refusedAt.count.runsFound.min') ===
              n10(found.max, 'replaced.refusedAt.count.runsFound.max')
            ? `${found.min}`
            : `${found.min}–${found.max}`) +
        ` of ${projectors} runs`;
  out.push(
    `| **all** | | **${n10(q0.total, 'precondition.q0.total')}** | ` +
      `**${readerCells(has10(q0.page, 'precondition.q0.page'), 'precondition.q0.page').split(' | ').join('** | **')}** | ` +
      `**${n10(replaced.placedPositions, 'precondition.q0.replaced.placedPositions')}** | ` +
      `**${n10(classify.positions, 'replaced.refusedAt.classify.positions')} at classify** ` +
      `(margin at most ${orDash10(nOrNull10(classify.maxMargin, 'replaced.refusedAt.classify.maxMargin'), fixed10(3))}), ` +
      `${countWords}, ${n10(at.other, 'replaced.refusedAt.other')} elsewhere | | |`,
  );
  out.push('');
  out.push(
    '_Both readers read the same photographs: each clean position rendered with noise, encoded to 8-bit sRGB ' +
      'and summarised as the page reads them. The reader the page replaced classified the whole position into ' +
      'white, black and patterned before it counted runs; the page’s reader finds each run by its own white and ' +
      'black, and notes a projector this camera cannot see instead of refusing it._',
  );
  const worth = has10(q0.worth, 'precondition.q0.worth');
  const refusal = worth === null ? null : has10(worth.refusal, 'precondition.q0.worth.refusal');
  out.push('');
  out.push(
    refusal === null
      ? '_The page’s worth report printed nothing for one clean folder read alone._'
      : `_What the page’s worth report printed for one clean folder read alone, as it did while it read a ` +
          `camera position at a time: “${refusal.split('. ')[0]}.”_`,
  );

  out.push('');
  out.push(
    '| the counterfactual reader, clean | runs | placed | refused anyway | of those, invisible | ' +
      'minor | marginal | positions told “Re-shoot projector N” | clean noise floor: median · max |',
  );
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const [which, label] of Q0_VARIANTS10) {
    const t = has10(twins[which], `precondition.twins.${which}`);
    const where = `precondition.twins.${which}`;
    const floor = has10(t.noiseFloor, `${where}.noiseFloor`);
    out.push(
      `| ${label} | ${n10(t.runs, `${where}.runs`)} | ${n10(t.attributable, `${where}.attributable`)} | ` +
        `${n10(t.refusedClean, `${where}.refusedClean`)} | ${n10(t.invisibleRefused, `${where}.invisibleRefused`)} | ` +
        `${n10(t.minor, `${where}.minor`)} | ${n10(t.marginal, `${where}.marginal`)} | ` +
        `${n10(t.reshootNamed, `${where}.reshootNamed`)} of ${n10(t.cameras, `${where}.cameras`)} | ` +
        `${orDash10(nOrNull10(floor.median, `${where}.noiseFloor.median`), fixed10(4))} · ` +
        `${orDash10(nOrNull10(floor.max, `${where}.noiseFloor.max`), fixed10(4))} |`,
    );
  }

  out.push('');
  out.push(
    '| the page’s reader, clean (the page twin) | runs | placed | noted out of view | barely seen | refused | ' +
      'problems | crashed | placed by both readers · the counterfactual alone · the page alone |',
  );
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const [which, label] of Q0_VARIANTS10) {
    const t = has10(pageTwins[which], `precondition.pageTwins.${which}`);
    const where = `precondition.pageTwins.${which}`;
    const vs = has10(t.againstCounterfactual, `${where}.againstCounterfactual`);
    out.push(
      `| ${label} | ${n10(t.runs, `${where}.runs`)} | ${n10(t.placed, `${where}.placed`)} | ` +
        `${n10(t.unseen, `${where}.unseen`)} | ${n10(t.barelySeen, `${where}.barelySeen`)} | ` +
        `${n10(t.refused, `${where}.refused`)} | ${n10(t.problems, `${where}.problems`)} | ` +
        `${n10(t.crashes, `${where}.crashes`)} of ${n10(t.read, `${where}.read`)} | ` +
        `${n10(vs.both, `${where}.againstCounterfactual.both`)} · ` +
        `${n10(vs.counterfactualOnly, `${where}.againstCounterfactual.counterfactualOnly`)} · ` +
        `${n10(vs.pageOnly, `${where}.againstCounterfactual.pageOnly`)} |`,
    );
  }

  // Q0b: every shape the stage builds, in its order, as the first run's table has them.
  const shapes = has10(pre.q0b, 'precondition.q0b');
  const wanted = [
    ...[0, 1, 3].flatMap((lead) => [0, 1, 2].map((trail) => `leading ${lead}, trailing ${trail}`)),
    ...Array.from({ length: projectors }, (_, p) => [
      `projector ${p + 1} re-shot and appended`,
      `projector ${p + 1} re-shot alone`,
    ]).flat(),
  ];
  out.push('');
  out.push(
    '| folder shapes an operator can produce, read by the counterfactual reader | positions | ' +
      'runs placed (the plain folder’s) | refused whole | its reasons |',
  );
  out.push('| --- | ---: | --- | ---: | --- |');
  for (const name of wanted) {
    const x = shapes.find((s) => s.shape === name);
    if (x === undefined) throw new Error(`experiment-10: precondition.q0b has no folder '${name}'`);
    const where = `precondition.q0b['${name}']`;
    out.push(
      `| ${name} | ${n10(x.positions, `${where}.positions`)} | ${n10(x.runsPlaced, `${where}.runsPlaced`)} ` +
        `(${n10(x.runsPlacedClean, `${where}.runsPlacedClean`)}) | ${n10(x.wholeRefused, `${where}.wholeRefused`)} | ` +
        `${reasons10(x.reasons, `${where}.reasons`)} |`,
    );
  }
  out.push('');
  out.push(
    '_Q0b is the counterfactual reader’s: the complement check handed each shape’s exact frame kinds. The page’s ' +
      'reader was held to the same shapes by the acceptance sweep (`experiments/reader-acceptance.json`), not here._',
  );
  return out.join('\n');
}

/**
 * Where the complement check first refuses a straddled run, and why a position
 * is refused run by run: each run crosses at its own smear, set by its own
 * binding pair.
 */
export function experiment10Crossings(result: Experiment10): string {
  const c = has10(result.gate?.crossings, 'gate.crossings');
  const constants = has10(result.generatedFrom?.design?.constants, 'generatedFrom.design.constants');
  const limit =
    n10(constants.MARGINAL_RESIDUAL, 'constants.MARGINAL_RESIDUAL') +
    n10(constants.MARGINAL_BAND, 'constants.MARGINAL_BAND');
  const scannedTo = n10(c.scannedTo, 'gate.crossings.scannedTo');
  const never = has10(c.neverRefused, 'gate.crossings.neverRefused');
  const spill = has10(result.gate?.spill, 'gate.spill');
  const row = (
    label: string,
    runs: string,
    neverRefused: string,
    s: Spread10,
    where: string,
    f: (x: number) => string,
  ): string =>
    `| ${label} | ${runs} | ${neverRefused} | ` +
    (['min', 'p10', 'median', 'p90', 'max'] as const)
      .map((k) => orDash10(nOrNull10(has10(s, where)[k], `${where}.${k}`), f))
      .join(' | ') +
    ' |';
  const attributable = n10(c.attributableRuns, 'gate.crossings.attributableRuns');
  const spillForward = has10(spill.forward, 'gate.spill.forward');
  const spillAttributable = n10(spill.attributable, 'gate.spill.attributable');
  const wps = has10(c.withinPositionSpread, 'gate.crossings.withinPositionSpread');
  const points = (x: number): string => `${(100 * x).toFixed(1)} pts`;
  const out = [
    `| where the check first refuses a run | runs | never refused up to ${smear10(scannedTo)} | ` +
      'min | p10 | median | p90 | max |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    row(
      'forward, whole position',
      String(attributable),
      String(n10(never.forward, 'neverRefused.forward')),
      c.forward,
      'gate.crossings.forward',
      smear10,
    ),
    row(
      'backward, whole position',
      String(attributable),
      String(n10(never.backward, 'neverRefused.backward')),
      c.backward,
      'gate.crossings.backward',
      smear10,
    ),
    row(
      'forward, room spill on',
      String(spillAttributable),
      String(spillAttributable - n10(spillForward.n, 'gate.spill.forward.n')),
      spillForward,
      'gate.spill.forward',
      smear10,
    ),
    row(
      'spread of one position’s forward crossings',
      `${n10(wps.positions, 'withinPositionSpread.positions')} positions`,
      DASH10,
      has10(wps.spread, 'withinPositionSpread.spread'),
      'gate.crossings.withinPositionSpread.spread',
      points,
    ),
  ];
  const below = nOrNull10(c.belowLimitShare, 'gate.crossings.belowLimitShare');
  const low = has10(c.lowBackward, 'gate.crossings.lowBackward');
  const lowRuns = n10(low.runs, 'lowBackward.runs');
  const agreement = has10(result.gate?.noisy?.agreement, 'gate.noisy.agreement');
  const agreeShare = nOrNull10(agreement.share, 'gate.noisy.agreement.share');
  out.push('');
  out.push(
    `_Forward, ${orDash10(below, pct10)} of the ${attributable} attributable runs are refused below the ` +
      `${limit.toFixed(2)} limit itself; ${n10(wps.atLeast002, 'withinPositionSpread.atLeast002')} of ` +
      `${n10(wps.positions, 'withinPositionSpread.positions')} positions have runs crossing at least 2 points ` +
      'apart. Backward, ' +
      (lowRuns === 0
        ? `no run is refused below ${smear10(n10(low.below, 'lowBackward.below'))}`
        : `${lowRuns} runs are refused below ${smear10(n10(low.below, 'lowBackward.below'))}, each lighting at most ` +
          `${orDash10(nOrNull10(low.maxLit, 'lowBackward.maxLit'), pct10)} of the photograph, the lowest at ` +
          `${orDash10(nOrNull10(low.lowest, 'lowBackward.lowest'), (x) => pct10(x, 2))}`) +
      `. With noise on, the verdict agrees with the noiseless predictor on ` +
      `${n10(agreement.agree, 'agreement.agree')} of ${n10(agreement.runs, 'agreement.runs')} run-levels ` +
      `(${orDash10(agreeShare, pct10)})._`,
  );

  // Every pair of the plan, in the plan's order: a pair missing from the file
  // is a fault, and a pair that binds no run is a zero the count leaves out.
  const pairs = has10(c.pairsForward, 'gate.crossings.pairsForward');
  const planned = has10(constants.EXPECTED?.complements?.pairs, 'constants.EXPECTED.complements.pairs');
  if (pairs.length !== planned.length) {
    throw new Error(
      `experiment-10: gate.crossings.pairsForward has ${pairs.length} pairs and the plan pairs ${planned.length}`,
    );
  }
  const binding = has10(c.bindingPairForward, 'gate.crossings.bindingPairForward');
  const bound = Object.values(binding).reduce((a, x) => a + n10(x, 'a binding count'), 0);
  out.push('');
  out.push('| pair | binds a run’s forward crossing | the pair’s own forward crossing: p10 · median · p90 |');
  out.push('| --- | ---: | --- |');
  for (const p of pairs) {
    const name = has10(p.pair, 'a pair name');
    const s = has10(p.crossing, `pairsForward.${name}.crossing`);
    const binds = binding[name] === undefined ? 0 : n10(binding[name], `bindingPairForward.${name}`);
    out.push(
      `| ${name} | ${binds}${bound > 0 ? ` (${pct10(binds / bound)})` : ''} | ` +
        `${orDash10(nOrNull10(s.p10, `${name}.p10`), smear10)} · ` +
        `${orDash10(nOrNull10(s.median, `${name}.median`), smear10)} · ` +
        `${orDash10(nOrNull10(s.p90, `${name}.p90`), smear10)} |`,
    );
  }
  const u0 = has10(c.u0, 'gate.crossings.u0');
  const byCrossing = has10(u0.byRenderedCrossing, 'gate.crossings.u0.byRenderedCrossing');
  const upTo = byCrossing.find((x) => x.upTo !== undefined);
  const above = byCrossing.find((x) => x.above !== undefined);
  if (upTo === undefined || above === undefined) {
    throw new Error('experiment-10: gate.crossings.u0.byRenderedCrossing lacks a side of its band');
  }
  const bindsU0 = has10(u0.u0Bound, 'gate.crossings.u0.u0Bound');
  const gap = (x: number | null): string => orDash10(x, fixed10(4));
  out.push('');
  out.push(
    `_Pair u0’s quarter-mass closed form against its rendered crossing: largest gap ` +
      `${gap(nOrNull10(bindsU0.maxError, 'u0Bound.maxError'))} on the ${n10(bindsU0.runs, 'u0Bound.runs')} runs ` +
      `u0 binds, ${gap(nOrNull10(upTo.maxError, 'byRenderedCrossing.upTo.maxError'))} on the ` +
      `${n10(upTo.runs, 'byRenderedCrossing.upTo.runs')} runs whose u0 crossing is at most ` +
      `${smear10(n10(upTo.upTo, 'byRenderedCrossing.upTo'))}, and ` +
      `${gap(nOrNull10(above.maxError, 'byRenderedCrossing.above.maxError'))} ` +
      `on the ${n10(above.runs, 'byRenderedCrossing.above.runs')} above it._`,
  );
  return out.join('\n');
}

/**
 * What a blend the check lets through does to a decode: the phase bias per
 * axis, the Gray words it leaves alone, the per-pixel signs with the seam
 * apart, and H7 clause by clause.
 */
export function experiment10Decode(result: Experiment10): string {
  const d = has10(result.decode, 'decode');
  const plan = has10(result.generatedFrom?.design?.plan, 'generatedFrom.design.plan');
  const verdictS = n10(result.generatedFrom?.verdictSmear, 'generatedFrom.verdictSmear');
  const noiseless = has10(plan.decodeNoiseless, 'plan.decodeNoiseless').map((s) => n10(s, 'a decoded smear'));
  const levels: [string, number][] = [
    ...[...new Set([...noiseless, verdictS])].sort((a, b) => a - b).map((s): [string, number] => ['forward', s]),
    ...[...noiseless].sort((a, b) => a - b).map((s): [string, number] => ['backward', s]),
  ];
  const curve = has10(d.curve, 'decode.curve');
  const med = (s: Spread10 | undefined, where: string, f: (x: number) => string): string =>
    orDash10(nOrNull10(has10(s, where).median, `${where}.median`), f);
  const out = [
    '| straddle | s | runs | mean Δu, px | mean Δv, px | Δ ÷ cyclic shift: u · v | ' +
      'Gray words changed: u · v, of pixels compared | moved ½ period or more | on the sphere, mm |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |',
  ];
  for (const [direction, s] of levels) {
    const l = curve.find((x) => x.direction === direction && x.s === s);
    if (l === undefined) throw new Error(`experiment-10: decode.curve has no ${direction} level at s = ${s}`);
    const where = `decode.curve[${direction} ${s}]`;
    const flips = has10(l.grayFlips, `${where}.grayFlips`);
    const emphasise = direction === 'forward' && s === verdictS;
    const bold = (x: string): string => (emphasise ? `**${x}**` : x);
    out.push(
      `| ${direction} | ${bold(s10(s))} | ${n10(l.runs, `${where}.runs`)} | ` +
        `${bold(med(l.meanU, `${where}.meanU`, fixed10(2)))} | ${bold(med(l.meanV, `${where}.meanV`, fixed10(2)))} | ` +
        `${med(l.ratioU, `${where}.ratioU`, fixed10(3))} · ${med(l.ratioV, `${where}.ratioV`, fixed10(3))} | ` +
        (flips === null
          ? `${DASH10} |`
          : `${n10(flips.u, `${where}.grayFlips.u`)} · ${n10(flips.v, `${where}.grayFlips.v`)}, of ` +
            `${n10(flips.matched, `${where}.grayFlips.matched`)} |`) +
        ` ${n10(l.movedHalfPeriod, `${where}.movedHalfPeriod`)} | ${bold(med(l.mmShift, `${where}.mmShift`, fixed10(2)))} |`,
    );
  }
  const vl = has10(d.verdictLevel, 'decode.verdictLevel');
  const signs = has10(vl.signs, 'decode.verdictLevel.signs');
  out.push('');
  const fm = has10(d.forwardMeans, 'decode.forwardMeans');
  const below = has10(d.grayFlipsBelowFiveNinths, 'decode.grayFlipsBelowFiveNinths');
  out.push(
    `_Mean Δ is the median over runs of each run’s mean; the ratio divides it by \`atan2(s, 1−s)·P/2π\`; ` +
      `millimetres are the median of per-run medians, both axes together. Forward run-levels whose mean is not ` +
      `negative: ${n10(fm.nonNegativeU, 'forwardMeans.nonNegativeU')} along u and ` +
      `${n10(fm.nonNegativeV, 'forwardMeans.nonNegativeV')} along v, of ${n10(fm.runLevels, 'forwardMeans.runLevels')}. ` +
      (below === null
        ? 'Gray words were not counted in this run._'
        : `Gray words changed below 5/9, every run and level: ${n10(below.either, 'grayFlipsBelowFiveNinths.either')} ` +
          `of ${n10(below.matched, 'grayFlipsBelowFiveNinths.matched')} pixels compared._`),
  );
  if (signs !== null) {
    out.push('');
    out.push(
      `| per pixel, forward s = ${s10(verdictS)} | pixels | Δu > 0 | Δv > 0 | largest Δu, px | largest Δv, px |`,
    );
    out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    const parts: [string, 'seam' | 'rest' | 'all'][] = [
      ['where the next projector also lights (the seam)', 'seam'],
      ['everywhere else', 'rest'],
      ['all', 'all'],
    ];
    for (const [label, key] of parts) {
      const t = has10(signs[key], `decode.verdictLevel.signs.${key}`);
      const where = `decode.verdictLevel.signs.${key}`;
      out.push(
        `| ${label} | ${n10(t.pixels, `${where}.pixels`)} | ${n10(t.uPos, `${where}.uPos`)} ` +
          `(${orDash10(nOrNull10(t.uPosShare, `${where}.uPosShare`), pctSmall10)}) | ${n10(t.vPos, `${where}.vPos`)} ` +
          `(${orDash10(nOrNull10(t.vPosShare, `${where}.vPosShare`), pctSmall10)}) | ` +
          `${n10(t.maxAbsU, `${where}.maxAbsU`).toFixed(2)} | ${n10(t.maxAbsV, `${where}.maxAbsV`).toFixed(2)} |`,
      );
    }
  }
  const p95 = has10(vl.p95AbsV, 'decode.verdictLevel.p95AbsV');
  const mm = has10(vl.mmShift, 'decode.verdictLevel.mmShift');
  out.push('');
  out.push(
    `_At s = ${s10(verdictS)}, over ${n10(vl.runs, 'verdictLevel.runs')} runs: |mean Δu| ` +
      `${med(vl.absMeanU, 'verdictLevel.absMeanU', fixed10(2))} px and |mean Δv| ` +
      `${med(vl.absMeanV, 'verdictLevel.absMeanV', fixed10(2))} px (medians); the largest run’s 95th percentile ` +
      `of |Δv| ${orDash10(nOrNull10(p95.max, 'verdictLevel.p95AbsV.max'), fixed10(2))} px; on the sphere ` +
      `${med(mm, 'verdictLevel.mmShift', fixed10(2))} mm, per-run medians spanning ` +
      `${orDash10(nOrNull10(mm.min, 'verdictLevel.mmShift.min'), fixed10(2))}–` +
      `${orDash10(nOrNull10(mm.max, 'verdictLevel.mmShift.max'), fixed10(2))} mm._`,
  );

  // H7, clause by clause: an untestable check is neither a pass nor a failure.
  const h7 = has10(has10(result.harness, 'harness').find((h) => h.id === 'H7'), 'harness H7');
  const measured = has10(h7.measured, 'harness H7.measured') as {
    clauses?: Record<string, H7Clause10>;
    flipOnset?: { claimedFrom: number; highestDecoded: number; bracketed: boolean };
    displacements?: { belowFiveNinths: number };
  };
  const clauses = has10(measured.clauses, 'harness H7.measured.clauses');
  const onset = has10(measured.flipOnset, 'harness H7.measured.flipOnset');
  const displaced = has10(measured.displacements, 'harness H7.measured.displacements');
  const clauseRows: [string, string][] = [
    ['darkOnset', 'Gray-ambiguous from 3/7 on the MSB-dark half'],
    ['flips', 'no Gray word changed below 5/9'],
    ['litLoss', 'the MSB-lit half lost to low modulation at s = 0.5'],
  ];
  out.push('');
  out.push('| H7, noiseless | checks | testable | untestable | failures |');
  out.push('| --- | ---: | ---: | ---: | ---: |');
  for (const [key, label] of clauseRows) {
    const x = has10(clauses[key], `harness H7.measured.clauses.${key}`);
    const where = `H7.${key}`;
    out.push(
      `| ${label} | ${n10(x.checks, `${where}.checks`)} | ${n10(x.testable, `${where}.testable`)} | ` +
        `${n10(x.untestable, `${where}.untestable`)} | ${n10(x.failures, `${where}.failures`)} |`,
    );
  }
  const pass = has10(h7.pass, 'harness H7.pass');
  out.push('');
  out.push(
    `_H7 ${pass === true ? 'holds' : pass === false ? 'fails' : 'is not established'}. The 5/9 flip onset is ` +
      `${has10(onset.bracketed, 'H7.flipOnset.bracketed') ? '' : 'not '}bracketed: the highest smear decoded is ` +
      `s = ${s10(n10(onset.highestDecoded, 'H7.flipOnset.highestDecoded'))}. Decodes moved half a period or more ` +
      'below 5/9, a displacement bound and not a flip count: ' +
      `${n10(displaced.belowFiveNinths, 'H7.displacements.belowFiveNinths')}._`,
  );
  return out.join('\n');
}

/**
 * Designed straddles solved through the bench, against both yardsticks: the
 * whole capture re-shot and only the straddled position re-shot. A straddle's
 * median is set against each null's median, the 95th percentile beside it and
 * never in its place, and each gate's flips beside the rate a clean re-shoot
 * alone flips it at.
 */
export function experiment10Pose(result: Experiment10): string {
  const pose = has10(result.pose, 'pose');
  const solved = has10(pose.solved, 'pose.solved');
  const constants = has10(result.generatedFrom?.design?.constants, 'generatedFrom.design.constants');
  const gridGate = n10(constants.GRID_GATE_MM, 'constants.GRID_GATE_MM');
  const rotationGate = n10(constants.ROTATION_GATE_DEG, 'constants.ROTATION_GATE_DEG');
  const mm2 = fixed10(2);
  const yard = (y: Yardstick10 | undefined, label: string, where: string): string => {
    const v = has10(y, where);
    const grid = has10(v.gridFlips, `${where}.gridFlips`);
    const rot = has10(v.rotationFlips, `${where}.rotationFlips`);
    return (
      `| ${label} | ${n10(v.samples, `${where}.samples`)} | ` +
      `${orDash10(nOrNull10(v.median, `${where}.median`), mm2)} | ` +
      `${orDash10(nOrNull10(v.value, `${where}.value`), mm2)} | ` +
      `${ci10(nOrNull10(v.lo, `${where}.lo`), nOrNull10(v.hi, `${where}.hi`), mm2)} | ` +
      `${n10(grid.flips, `${where}.gridFlips.flips`)} of ${n10(grid.of, `${where}.gridFlips.of`)} | ` +
      `${n10(rot.flips, `${where}.rotationFlips.flips`)} of ${n10(rot.of, `${where}.rotationFlips.of`)} |`
    );
  };
  const out = [
    '| re-shot against the plain twin | re-shoots | median D_grid, mm | 95th percentile (τ), mm | ' +
      `τ's 95% CI | seam gate (${gridGate} mm) flipped | rotation gate (${rotationGate}°) flipped |`,
    '| --- | ---: | ---: | ---: | --- | ---: | ---: |',
    yard(pose.tauNull, 'the whole capture (τ_null)', 'pose.tauNull'),
    yard(pose.tauPosition, 'only the straddled position', 'pose.tauPosition'),
  ];
  const whole = has10(pose.tauNull, 'pose.tauNull');
  const position = has10(pose.tauPosition, 'pose.tauPosition');
  const largest = has10(whole.largest, 'pose.tauNull.largest');
  const byRig = Object.entries(has10(largest.byRig, 'pose.tauNull.largest.byRig')).sort(
    (a, b) => n10(b[1], 'a rig count') - n10(a[1], 'a rig count') || Number(a[0]) - Number(b[0]),
  );
  out.push('');
  out.push(
    byRig.length === 0
      ? '_No re-shoot was solved, so there is no null to set a straddle against._'
      : `_τ_null is set by the rigs supplying its largest ${n10(largest.n, 'pose.tauNull.largest.n')} values: ` +
          `${byRig.map(([rig, n]) => `rig ${rig} (${n})`).join(', ')}._`,
  );
  const plan = has10(result.generatedFrom?.design?.plan, 'generatedFrom.design.plan');
  const levels = has10(pose.levels, 'pose.levels');
  if (!solved) {
    if (levels.length > 0) throw new Error('experiment-10: pose.levels has solves but pose.solved is false');
    out.push('');
    out.push('_This run solved nothing (`pose.solved` is false): no designed straddle has a D_grid._');
    return out.join('\n');
  }
  const pl = has10(plan.poseLevels, 'plan.poseLevels');
  const rolling = has10(pl.rolling, 'plan.poseLevels.rolling');
  const labels = [
    ...has10(pl.forward, 'plan.poseLevels.forward').map((s) => `forward/${s}`),
    ...has10(pl.backward, 'plan.poseLevels.backward').map((s) => `backward/${s}`),
    ...has10(rolling.midRow, 'plan.poseLevels.rolling.midRow').map(
      (s) => `rolling/${n10(rolling.readoutOverExposure, 'rolling.readoutOverExposure')}/${s}`,
    ),
  ];
  const wholeMedian = nOrNull10(whole.median, 'pose.tauNull.median');
  const positionMedian = nOrNull10(position.median, 'pose.tauPosition.median');
  const times = (x: number | null, by: number | null): string =>
    x === null || by === null || by === 0 ? DASH10 : `${(x / by).toFixed(1)}×`;
  out.push('');
  out.push(
    '| designed straddle | solved, of cases | D_grid, mm: median [range] | ' +
      '× the re-shoot medians: whole · position | beyond τ: whole · position | seam gate flipped | ' +
      'rotation gate flipped |',
  );
  out.push('| --- | --- | --- | --- | --- | ---: | ---: |');
  for (const label of labels) {
    const l = levels.find((x) => x.label === label);
    if (l === undefined) throw new Error(`experiment-10: pose.levels has no ${label}, which the design solves`);
    const where = `pose.levels[${label}]`;
    const g = has10(l.dGridMm, `${where}.dGridMm`);
    const medianMm = nOrNull10(g.median, `${where}.dGridMm.median`);
    const cases = n10(l.cases, `${where}.cases`);
    const refused = n10(l.allRefused, `${where}.allRefused`);
    const [direction, ...rest] = label.split('/');
    const name =
      direction === 'rolling'
        ? `rolling, ρ/E = ${rest[0]}, s̄ = ${rest[1]}`
        : `${direction}, s = ${rest[0]}`;
    out.push(
      `| ${name} | ${n10(g.n, `${where}.dGridMm.n`)} of ${cases}${refused > 0 ? ` (${refused} all refused)` : ''} | ` +
        `${orDash10(medianMm, mm2)} [${orDash10(nOrNull10(g.min, `${where}.dGridMm.min`), mm2)}–` +
        `${orDash10(nOrNull10(g.max, `${where}.dGridMm.max`), mm2)}] | ` +
        `${times(medianMm, wholeMedian)} · ${times(medianMm, positionMedian)} | ` +
        `${orDash10(nOrNull10(l.overTau, `${where}.overTau`), String)} · ` +
        `${orDash10(nOrNull10(l.overTauPosition, `${where}.overTauPosition`), String)} | ` +
        `${n10(l.gridFlips, `${where}.gridFlips`)} of ${cases} | ` +
        `${n10(l.rotationFlips, `${where}.rotationFlips`)} of ${cases} |`,
    );
  }
  return out.join('\n');
}

/**
 * EXPERIMENT-9's touched captures re-scored, cell by cell (spec §7), and for a
 * cell that was solved, its SILENT captures judged against every yardstick the
 * verdict names.
 */
export function experiment10Rescore(result: Experiment10): string {
  const cells = has10(result.rescore?.cells, 'rescore.cells');
  const base = cell10(cells, 'R1', 'rescore.cells');
  const out = [
    '| cell | setting (R1 in full; the rest, what differs) | captures touched | LOUD (share, 95% CI) | ' +
      'LOUD+SILENT | SILENT | INVISIBLE-ONLY | UNCHANGED |',
    '| --- | --- | --- | --- | ---: | --- | ---: | ---: |',
  ];
  const solvedCells: Cell10[] = [];
  for (const id of RESCORE_IDS10) {
    const cell = cell10(cells, id, 'rescore.cells');
    const P = has10(cell.classes?.P, `${id}.classes.P`);
    const where = `${id}.classes.P`;
    if (has10(cell.solved, `${id}.solved`)) solvedCells.push(cell);
    out.push(
      `| ${id} | ${differs10(result, cell, base)} | ${touched10(cell)} | ${classShare10(P, 'LOUD', where)} | ` +
        `${count10(P, 'LOUD+SILENT', where)} | ${silentSummary10(cell, P, where)} | ` +
        `${count10(P, 'INVISIBLE-ONLY', where)} | ${count10(P, 'UNCHANGED', where)} |`,
    );
  }
  out.push('');
  out.push(
    '_Policy P: a refused position is re-shot whole and the re-shoot assumed clean. A LOUD+SILENT capture is ' +
      'LOUD and is not counted again under SILENT._',
  );
  if (solvedCells.length === 0) {
    out.push('');
    out.push('_No re-scored cell was solved in this run, so no SILENT capture is split by harm._');
    return out.join('\n');
  }
  // Transposed: a row per measure, a column per solved cell and policy.
  const columns = solvedCells.flatMap((cell) =>
    (['P', 'A'] as const).map((p) => ({
      label: `${cell.id}, policy ${p}`,
      cell,
      policy: has10(cell.classes?.[p], `${cell.id}.classes.${p}`),
      where: `${cell.id}.classes.${p}`,
    })),
  );
  const gridGate = n10(result.generatedFrom?.design?.constants?.GRID_GATE_MM, 'constants.GRID_GATE_MM');
  const at = (
    x: HarmAt10 | null,
    key: 'HARMLESS' | 'BIASED' | 'GATE-BREAKING' | 'exceedTau' | 'judged',
    where: string,
  ): string =>
    x === null ? DASH10 : String(n10(x[key], `${where}.${key}`));
  const rows: [string, (c: (typeof columns)[number]) => string][] = [
    ['SILENT', (c) => String(silent10(c.policy, c.where))],
    // The share is of the cell's touched captures, as LOUD's is, not of its SILENT ones.
    [
      'HARMLESS: within τ_null, gate kept (share of touched captures, 95% CI)',
      (c) => classShare10(c.policy, 'SILENT-HARMLESS', c.where),
    ],
    [
      'BIASED: beyond τ_null, gate kept (share of touched captures, 95% CI)',
      (c) => classShare10(c.policy, 'SILENT-BIASED', c.where),
    ],
    [
      `GATE-BREAKING: seams pushed past ${gridGate} mm (share of touched captures, 95% CI)`,
      (c) => classShare10(c.policy, 'SILENT-GATE-BREAKING', c.where),
    ],
    [
      'unjudgeable (D_grid censored, or the twin misses the gate)',
      (c) => String(count10(c.policy, 'SILENT-UNJUDGEABLE', c.where)),
    ],
    ['not solved', (c) => String(count10(c.policy, 'SILENT-UNSOLVED', c.where))],
    [
      'judged, and of those beyond τ_null',
      (c) => {
        const a = has10(c.policy.silentAgainst, `${c.where}.silentAgainst`);
        const tau = has10(a.tau, `${c.where}.silentAgainst.tau`);
        const where = `${c.where}.silentAgainst.tau`;
        return `${at(tau, 'judged', where)}, ${at(tau, 'exceedTau', where)}`;
      },
    ],
    [
      'HARMLESS if τ_null were its CI’s lower · upper end',
      (c) => {
        const a = has10(c.policy.silentAgainst, `${c.where}.silentAgainst`);
        return (
          `${at(has10(a.tauLo, `${c.where}.silentAgainst.tauLo`), 'HARMLESS', `${c.where}.silentAgainst.tauLo`)} · ` +
          `${at(has10(a.tauHi, `${c.where}.silentAgainst.tauHi`), 'HARMLESS', `${c.where}.silentAgainst.tauHi`)}`
        );
      },
    ],
    [
      'HARMLESS against the one-position τ',
      (c) => {
        const a = has10(c.policy.silentAgainst, `${c.where}.silentAgainst`);
        const where = `${c.where}.silentAgainst.positionTau`;
        return at(has10(a.positionTau, where), 'HARMLESS', where);
      },
    ],
    [
      'past the seam gate: SILENT · LOUD+SILENT · all',
      (c) => {
        const g = has10(c.policy.pastGate, `${c.where}.pastGate`);
        return (
          `${n10(g.silent, `${c.where}.pastGate.silent`)} · ${n10(g.loudSilent, `${c.where}.pastGate.loudSilent`)} · ` +
          `**${n10(g.total, `${c.where}.pastGate.total`)}**`
        );
      },
    ],
    [
      'solved captures: rotation gate flipped · D_grid > 0.25 mm · > 0.5 mm',
      (c) => {
        const s = has10(c.policy.solved, `${c.where}.solved`);
        return (
          `${n10(s.captures, `${c.where}.solved.captures`)}: ${n10(s.rotationFlips, `${c.where}.solved.rotationFlips`)} · ` +
          `${n10(s.over025, `${c.where}.solved.over025`)} · ${n10(s.over05, `${c.where}.solved.over05`)}`
        );
      },
    ],
    [
      'within re-shoot noise, and of those gate-breaking anyway',
      (c) => {
        const s = has10(c.policy.solved, `${c.where}.solved`);
        return (
          `${n10(s.withinReshootNoise, `${c.where}.solved.withinReshootNoise`)}, ` +
          `${n10(s.gateBreakingWithinNoise, `${c.where}.solved.gateBreakingWithinNoise`)}`
        );
      },
    ],
  ];
  out.push('');
  out.push(`| the solved cell’s captures | ${columns.map((c) => c.label).join(' | ')} |`);
  out.push(`| --- | ${columns.map(() => '---').join(' | ')} |`);
  for (const [label, value] of rows) out.push(`| ${label} | ${columns.map(value).join(' | ')} |`);
  return out.join('\n');
}

/** Every re-scored and lateness cell, in the order the two tables above list them. */
function allCellIds10(result: Experiment10): { id: string; from: 'rescore' | 'lateness' }[] {
  return [
    ...RESCORE_IDS10.map((id) => ({ id, from: 'rescore' as const })),
    ...latenessIds10(result).map((id) => ({ id, from: 'lateness' as const })),
  ];
}

const POSITION_CATEGORIES10: readonly string[] = ['REFUSED-ALL', 'MIXED', 'PLACED', 'INVISIBLE-ONLY', 'UNCHANGED'];

/**
 * Position categories side by side, never ranked (spec §3.6): both footings,
 * and the primary one again with minor and marginal runs left out. Then what
 * the LOUD captures are told, which is what the operator reads.
 */
export function experiment10Positions(result: Experiment10): string {
  const out = [
    `| cell | footing, runs counted | touched positions | ${POSITION_CATEGORIES10.join(' | ')} |`,
    `| --- | --- | ---: | ${POSITION_CATEGORIES10.map(() => '---:').join(' | ')} |`,
  ];
  const loudRows: string[] = [];
  for (const { id, from } of allCellIds10(result)) {
    const cell = cell10(from === 'rescore' ? result.rescore?.cells : result.lateness?.cells, id, `${from}.cells`);
    const pos = has10(cell.positions, `${id}.positions`);
    const touched = n10(cell.touchedPositions, `${id}.touchedPositions`);
    const variants: [string, Record<string, number> | undefined, string][] = [
      ['content, all', pos.content?.all, `${id}.positions.content.all`],
      [
        'content, minor & marginal left out',
        pos.content?.excludingMinorMarginal,
        `${id}.positions.content.excludingMinorMarginal`,
      ],
      ['filed, all', pos.filed?.all, `${id}.positions.filed.all`],
    ];
    variants.forEach(([label, table, where], i) => {
      const t = has10(table, where);
      out.push(
        `| ${i === 0 ? `${id}` : ''} | ${label} | ${touched} | ` +
          `${POSITION_CATEGORIES10.map((k) => n10(t[k], `${where}.${k}`)).join(' | ')} |`,
      );
    });
    const loud = has10(cell.loud, `${id}.loud`);
    loudRows.push(
      `| ${id} | ${n10(loud.captures, `${id}.loud.captures`)} | ` +
        `${n10(loud.wholePositionOnly, `${id}.loud.wholePositionOnly`)} | ` +
        `${n10(loud.runByRun, `${id}.loud.runByRun`)} | ${n10(loud.reshootNamed, `${id}.loud.reshootNamed`)} | ` +
        `${n10(loud.dropAndDuplicate, `${id}.loud.dropAndDuplicate`)} |`,
    );
  }
  out.push('');
  out.push(
    '_Content footing (primary): a photograph observes as the kind of the part holding more than half its ' +
      'exposure. Filed footing: as the kind of the step it is filed as. Rows are the cells of the two tables ' +
      'above: R1–R8 as re-scored, then each rendered lateness._',
  );
  out.push('');
  out.push(
    '| cell | LOUD | refused only as whole positions: “Found N projector runs” | refused run by run | ' +
      'of those, told “Re-shoot projector N” | told it looks like a dropped and a duplicated frame |',
  );
  out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  out.push(...loudRows);
  return out.join('\n');
}

/**
 * How late the emitter may run before the card's aimed start stops protecting:
 * every lateness swept on timing alone, the fine grid around the derived
 * threshold included, then the rendered cells.
 */
export function experiment10Lateness(result: Experiment10): string {
  const late = has10(result.lateness, 'lateness');
  const timing = has10(late.timing, 'lateness.timing');
  const plan = has10(result.generatedFrom?.design?.plan, 'generatedFrom.design.plan');
  const grid = has10(plan.lateMsTiming, 'plan.lateMsTiming').map((x) => n10(x, 'a swept lateness'));
  const hz = hz10(result);
  const series: [string, string, string, boolean][] = [
    ['aimed', 'intervalometer-100ppm', 'aimed', false],
    [`aimed, ${hz} Hz wait`, 'intervalometer-100ppm', 'aimed', true],
    ['uniform', 'intervalometer-100ppm', 'uniform', false],
    [`uniform, ${hz} Hz wait`, 'intervalometer-100ppm', 'uniform', true],
    ['handheld-remote, uniform', 'handheld-remote', 'uniform', false],
  ];
  const find = (arm: string, phase: string, vsync: boolean, ms: number): TimingCell10 => {
    const t = timing.find((x) => x.arm === arm && x.phase === phase && x.vsync === vsync && x.lateMs === ms);
    if (t === undefined) {
      throw new Error(`experiment-10: lateness.timing has no ${arm} / ${phase} at ${ms} ms, vsync ${vsync}`);
    }
    return t;
  };
  // A column's trials once, in its header; a column whose trials vary is a fault.
  const trialsOf = (arm: string, phase: string, vsync: boolean): number => {
    const ns = new Set(grid.map((ms) => n10(find(arm, phase, vsync, ms).trials, `timing ${arm} ${phase} trials`)));
    if (ns.size !== 1) throw new Error(`experiment-10: lateness.timing ${arm} / ${phase} changes its trial count`);
    return [...ns][0];
  };
  const off = has10(late.aimed?.vsyncOff, 'lateness.aimed.vsyncOff');
  const onePercent = nOrNull10(off.onePercentMs, 'lateness.aimed.vsyncOff.onePercentMs');
  const out = [
    `| δ, ms per step | ` +
      `${series.map(([label, arm, phase, v]) => `${label} (of ${trialsOf(arm, phase, v)})`).join(' | ')} | ` +
      'uniform: positions touched · whole |',
    `| ---: | ${series.map(() => '---:').join(' | ')} | ---: |`,
  ];
  for (const ms of grid) {
    const cells = series.map(([, arm, phase, v]) => {
      const t = find(arm, phase, v, ms);
      const n = n10(t.capturesTouched, `timing ${arm} ${phase} ${ms} capturesTouched`);
      return `${n} (${pct10(n / n10(t.trials, `timing ${arm} ${phase} ${ms} trials`))})`;
    });
    const u = find('intervalometer-100ppm', 'uniform', false, ms);
    out.push(
      `| ${ms === onePercent ? `**${ms}**` : ms} | ${cells.join(' | ')} | ` +
        `${n10(u.positionsTouched, `timing uniform ${ms} positionsTouched`)} · ` +
        `${n10(u.wholePositions, `timing uniform ${ms} wholePositions`)} |`,
    );
  }
  const threshold = has10(late.aimed?.threshold, 'lateness.aimed.threshold');
  const band = has10(threshold.aimBandS, 'lateness.aimed.threshold.aimBandS');
  const bracket = (x: AimedCrossing10, where: string): string => {
    const first = nOrNull10(x.firstTouchedMs, `${where}.firstTouchedMs`);
    const one = nOrNull10(x.onePercentMs, `${where}.onePercentMs`);
    const b = has10(x.bracketMs, `${where}.bracketMs`);
    if (one === null || b === null) return 'no lateness swept touches 1% of aimed captures';
    const lo = b[0] === null ? null : n10(b[0], `${where}.bracketMs[0]`);
    return (
      `the first aimed capture is touched at ${orDash10(first, String)} ms and 1% from ${one} ms, ` +
      (lo === null ? 'the smallest lateness swept' : `a crossing in (${lo}, ${n10(b[1], `${where}.bracketMs[1]`)}] ms`)
    );
  };
  out.push('');
  out.push(
    `_Derived from the design: the aim band’s lower edge, ${n10(band[0], 'aimBandS[0]')} s, spread over ` +
      `${n10(threshold.steps, 'threshold.steps')} steps is ` +
      `${orDash10(nOrNull10(threshold.matchedClocksMs, 'threshold.matchedClocksMs'), fixed10(2))} ms per step with ` +
      `matched clocks, and ${orDash10(nOrNull10(threshold.fastCameraMs, 'threshold.fastCameraMs'), fixed10(2))} ms ` +
      `with the camera’s clock ${n10(threshold.driftPpm, 'threshold.driftPpm')} ppm fast. Swept on this grid, on timing alone: ` +
      `${bracket(off, 'lateness.aimed.vsyncOff')}; with a ${hz} Hz refresh wait, ` +
      `${bracket(has10(late.aimed?.vsyncOn, 'lateness.aimed.vsyncOn'), 'lateness.aimed.vsyncOn')}._`,
  );

  const cells = has10(late.cells, 'lateness.cells');
  out.push('');
  out.push(
    '| rendered | setting | captures flagged or changed | LOUD (share, 95% CI) | of which run by run | LOUD+SILENT | ' +
      'SILENT | INVISIBLE-ONLY | UNCHANGED | past the seam gate |',
  );
  out.push('| --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | --- |');
  for (const id of latenessIds10(result)) {
    const cell = cell10(cells, id, 'lateness.cells');
    const P = has10(cell.classes?.P, `${id}.classes.P`);
    const where = `${id}.classes.P`;
    out.push(
      `| ${id} | ${setting10(result, cell)} | ${touched10(cell)} | ${classShare10(P, 'LOUD', where)} | ` +
        `${n10(cell.loud?.runByRun, `${id}.loud.runByRun`)} | ${count10(P, 'LOUD+SILENT', where)} | ` +
        `${silentSummary10(cell, P, where)} | ${count10(P, 'INVISIBLE-ONLY', where)} | ${count10(P, 'UNCHANGED', where)} | ` +
        `${pastGate10(cell)} |`,
    );
  }
  return out.join('\n');
}

/**
 * The operator's view, for the plan and the field card: by start rule and
 * emitter lateness, how many captures a straddle touches, how many the page
 * would refuse loudly, and how many pass silently.
 *
 * Registered twice: `experiment-10-rescore-operator-path` in
 * `docs/OPERATOR-PATH.md`, and `experiment-10-rescore-calibrate` in
 * `docs/CALIBRATE.md`.
 */
export function experiment10Operator(result: Experiment10): string {
  const rescore = has10(result.rescore?.cells, 'rescore.cells');
  const lateness = has10(result.lateness?.cells, 'lateness.cells');
  // The card's aimed start first, then no procedure; each at a perfect timer
  // (EXPERIMENT-9's model) and then at every lateness rendered.
  const plan = has10(result.generatedFrom?.design?.plan, 'generatedFrom.design.plan');
  const rendered = has10(plan.lateMsRendered, 'plan.lateMsRendered').map((x) => n10(x, 'a rendered lateness'));
  const rows: Cell10[] = [
    cell10(rescore, 'R8', 'rescore.cells'),
    ...rendered.map((ms) => cell10(lateness, `L-aimed-${ms}`, 'lateness.cells')),
    cell10(rescore, 'R1', 'rescore.cells'),
    ...rendered.map((ms) => cell10(lateness, `L-uniform-${ms}`, 'lateness.cells')),
  ];
  const gridGate = n10(result.generatedFrom?.design?.constants?.GRID_GATE_MM, 'constants.GRID_GATE_MM');
  const out = [
    '| start, emitter | captures flagged or changed | refused loudly (share, 95% CI) | of those, run by run | ' +
      `pass silently | past the ${gridGate} mm seam gate |`,
    '| --- | --- | --- | ---: | --- | --- |',
  ];
  for (const cell of rows) {
    const P = has10(cell.classes?.P, `${cell.id}.classes.P`);
    const where = `${cell.id}.classes.P`;
    const spec = has10(cell.spec, `${cell.id}.spec`);
    const late = n10(spec.lateMs, `${cell.id}.spec.lateMs`);
    const label =
      `${has10(spec.phase, `${cell.id}.spec.phase`) === 'aimed' ? 'aimed' : 'un-aimed (uniform)'} start, ` +
      (late === 0 ? 'perfect timer' : `${late} ms late per step`) + ` (${cell.id})`;
    out.push(
      `| ${label} | ${touched10(cell)} | ${classShare10(P, 'LOUD', where)} | ` +
        `${n10(cell.loud?.runByRun, `${cell.id}.loud.runByRun`)} | ` +
        `${silentSummary10(cell, P, where)} | ${pastGate10(cell)} |`,
    );
  }
  const threshold = has10(result.lateness?.aimed?.threshold, 'lateness.aimed.threshold');
  const off = has10(result.lateness?.aimed?.vsyncOff, 'lateness.aimed.vsyncOff');
  const onePercent = nOrNull10(off.onePercentMs, 'lateness.aimed.vsyncOff.onePercentMs');
  out.push('');
  out.push(
    `_Policy P, the counterfactual reader. The aimed start protects while the emitter runs less than about ` +
      `${orDash10(nOrNull10(threshold.fastCameraMs, 'threshold.fastCameraMs'), fixed10(2))}–` +
      `${orDash10(nOrNull10(threshold.matchedClocksMs, 'threshold.matchedClocksMs'), fixed10(2))} ms late per step ` +
      '(derived); ' +
      (onePercent === null
        ? 'no lateness swept touched 1% of aimed captures'
        : `1% of aimed captures are touched from ${onePercent} ms (swept)`) +
      '. ' +
      `The emitter’s lateness has been measured only headless: a design-time ` +
      `${n10(
        result.generatedFrom?.design?.constants?.HEADLESS_LATENESS_MS?.hudTickOff,
        'constants.HEADLESS_LATENESS_MS.hudTickOff',
      )} ms per step, and about ` +
      `${n10(
        result.generatedFrom?.design?.constants?.HEADLESS_LATENESS_MS?.armedTickOn,
        'constants.HEADLESS_LATENESS_MS.armedTickOn',
      )} ms armed with the tick on._`,
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The page column: EXPERIMENT-10's captures through the page's own reader
// ---------------------------------------------------------------------------

/**
 * A cell's page column. Absent, or null as the first full run's file holds it,
 * is a file written before the column was summarised, and a fault here.
 */
function page10(cell: Cell10): Page10 {
  const page = has10(cell.page, `${cell.id}.page`);
  if (page === null) {
    throw new Error(
      `experiment-10: ${cell.id} has no page column summary; this file predates the page's reader`,
    );
  }
  return page;
}

/** What a cell whose page column did not run shows in a column that would count it. */
const NOT_RUN10 = 'the page column did not run';

/** The page's SILENT captures in one line, as `silentSummary10` puts the counterfactual's. */
function pageSilent10(cell: Cell10, page: PageRead10, where: string): string {
  const P = page.classes.P as Policy10;
  const silent = silent10(P, where);
  const unsolved = count10(P, 'SILENT-UNSOLVED', where);
  const quiet = n10(page.quiet?.silentWithQuiet, `${cell.id}.page.quiet.silentWithQuiet`);
  const quietWords = quiet > 0 ? `; ${quiet} with a QUIET position too` : '';
  if (!has10(cell.solved, `${cell.id}.solved`) || unsolved === silent) {
    return `${silent} (not solved)${quietWords}`;
  }
  const parts = [
    `${count10(P, 'SILENT-HARMLESS', where)} harmless`,
    `${count10(P, 'SILENT-BIASED', where)} biased`,
    `${count10(P, 'SILENT-GATE-BREAKING', where)} gate-breaking`,
  ];
  const unjudgeable = count10(P, 'SILENT-UNJUDGEABLE', where);
  if (unjudgeable > 0) parts.push(`${unjudgeable} unjudgeable`);
  if (unsolved > 0) parts.push(`${unsolved} not solved`);
  return `${silent}: ${parts.join(', ')}${quietWords}`;
}

/**
 * EXPERIMENT-9's captures through the page's own reader, cell by cell: the
 * counterfactual's rescore and lateness tables, read by the page. Each run is
 * attributed against the page's reading of the same clean frames, and a run
 * that reading places and the straddled one only notes is a quiet drop, apart.
 * A capture with nothing refused and no position PLACED but one QUIET is QUIET,
 * a class the counterfactual cannot have; a LOUD one with a QUIET position is
 * LOUD+QUIET.
 */
export function experiment10Page(result: Experiment10): string {
  const header = [
    'cell',
    'captures touched',
    'LOUD (share, 95% CI)',
    'LOUD+SILENT',
    'LOUD+QUIET',
    'SILENT',
    'QUIET',
    'INVISIBLE-ONLY',
    'UNCHANGED',
    'quiet drops: runs (captures)',
    'misfiled photographs (the largest majority share)',
    'crashes',
  ];
  const out = [
    `| ${header.join(' | ')} |`,
    '| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- | ---: |',
  ];
  for (const { id, from } of allCellIds10(result)) {
    const cell = cell10(from === 'rescore' ? result.rescore?.cells : result.lateness?.cells, id, `${from}.cells`);
    const page = page10(cell);
    const trials = n10(cell.trials, `${id}.trials`);
    const rigs = has10(page.rigs, `${id}.page.rigs`);
    if (page.status === 'not run') {
      out.push(`| ${id} | ${NOT_RUN10} | ${header.slice(2).map(() => DASH10).join(' | ')} |`);
      continue;
    }
    const P = has10(page.classes?.P, `${id}.page.classes.P`) as Policy10;
    const where = `${id}.page.classes.P`;
    const read = has10(page.read, `${id}.page.read`);
    const column = n10(rigs.column, `${id}.page.rigs.column`);
    const of = n10(rigs.of, `${id}.page.rigs.of`);
    const touched =
      `${n10(read.captures, `${id}.page.read.captures`)} of ${trials}` +
      (column < of ? ` (${column} of ${of} rigs read)` : '') +
      (page.status === 'nothing to read' ? ' (nothing to read)' : '');
    const quiet = has10(page.quiet, `${id}.page.quiet`);
    const misfiles = has10(page.misfiles, `${id}.page.misfiles`);
    const misfiled = n10(misfiles.photographs, `${id}.page.misfiles.photographs`);
    const largest = nOrNull10(has10(misfiles.share, `${id}.page.misfiles.share`).max, `${id}.page.misfiles.share.max`);
    out.push(
      `| ${id} | ${touched} | ${classShare10(P, 'LOUD', where)} | ${count10(P, 'LOUD+SILENT', where)} | ` +
        `${count10(P, 'LOUD+QUIET', where)} | ${pageSilent10(cell, page, where)} | ${count10(P, 'QUIET', where)} | ` +
        `${count10(P, 'INVISIBLE-ONLY', where)} | ${count10(P, 'UNCHANGED', where)} | ` +
        `${n10(quiet.runs, `${id}.page.quiet.runs`)} (${n10(quiet.captures, `${id}.page.quiet.captures`)}) | ` +
        (misfiled === 0 ? '0' : `${misfiled} (${orDash10(largest, fixed10(3))})`) +
        ` | ${n10(read.crashes, `${id}.page.read.crashes`)} |`,
    );
  }
  out.push('');
  out.push(
    '_Policy P, through the page’s own reader, on the fast path’s noisy frames encoded as the page reads them. ' +
      'Each run counts against the straddle only where the page’s reading of the same clean frames places it. A ' +
      'quiet drop is a touched run that reading places and the straddled one only notes out of view or barely seen, ' +
      'with no problem naming it; a position holding one with nothing refused is QUIET, not PLACED. With nothing ' +
      'refused, a capture is SILENT when some position is PLACED, and QUIET when none is and some position is QUIET: ' +
      'its dropped run is noted, not decoded, and no harm is read for it. The counterfactual reader has no QUIET ' +
      'class, since it refuses every run it does not place. LOUD+QUIET is a LOUD capture with a QUIET position (LOUD ' +
      'with a quiet drop), counted apart from LOUD+SILENT, which needs a PLACED position; a quiet drop inside a refused ' +
      'position makes no position QUIET and is counted only among the quiet drops. A SILENT capture is judged ' +
      'only by a counterfactual solve of the page’s own plan, placement included; the rest are not solved. A misfiled ' +
      'photograph is one a placed run files under another step than the one holding more than half its exposure, ' +
      'and its share is that step’s. A crash is a folder the reader threw on, counted as refused._',
  );
  return out.join('\n');
}

/** The counterfactual's deciding outcomes, as the run tables name them. */
const OUTCOMES10: readonly (readonly [string, string])[] = [
  ['placed', 'placed'],
  ['refused-complement', 'refused: complement'],
  ['refused-bookends-count', 'bookends count'],
  ['refused-bookends-length', 'bookends length'],
  ['refused-bookends-kind', 'bookends kind'],
  ['refused-unanswered', 'unanswered'],
  ['refused-classify', 'classify'],
];

/** The page's verdicts on a run, as the run tables name them. */
const VERDICTS10: readonly (readonly [string, string])[] = [
  ['placed', 'the page placed'],
  ['refused', 'the page refused'],
  ['noted', 'the page only noted (a quiet drop)'],
  ['crashed', 'the page crashed'],
  ['unaccounted', 'the page said nothing of it'],
];

/** The page's word classes, in the order the run tables list them. */
const PAGE_WORDS10: readonly string[] = [
  'broken',
  'unanswered',
  'unfound',
  'unfound-room',
  'length-extra',
  'length-slot',
  'length',
  'norun',
  'dark',
  'short',
  'numbering',
  'numbering-gap',
  'reshoot',
  'plan',
  'margin',
  'count',
  'kind',
  'leading',
  'clipping',
  'other',
];

/**
 * Run by run, the page against the counterfactual reader: R1 in full, each
 * touched run the two clean twins both place crossed by the page's verdict and
 * the counterfactual's deciding outcome; every cell summarised; what each
 * reader's LOUD captures are told; and the page's words on the runs it refuses.
 */
export function experiment10PageRuns(result: Experiment10): string {
  const out: string[] = [];
  const r1 = cell10(result.rescore?.cells, 'R1', 'rescore.cells');
  const r1Page = page10(r1);
  const cross = (x: Cross10 | undefined, verdict: string, outcome: string, where: string): number => {
    const row = has10(has10(x, where)[verdict], `${where}.${verdict}`);
    const v = row[outcome];
    return v === undefined ? 0 : n10(v, `${where}.${verdict}.${outcome}`);
  };
  const refusedOf = (x: Cross10 | undefined, verdict: string, where: string): number =>
    OUTCOMES10.filter(([k]) => k !== 'placed').reduce((a, [k]) => a + cross(x, verdict, k, where), 0);
  if (r1Page.status === 'not run') {
    out.push(`_R1: ${NOT_RUN10}._`);
  } else {
    const runs = has10(r1Page.runs, 'R1.page.runs');
    const where = 'R1.page.runs.both';
    out.push(
      `| R1, touched runs both clean twins place | counterfactual: ${OUTCOMES10.map(([, label]) => label).join(' | ')} | all |`,
    );
    out.push(`| --- | ${OUTCOMES10.map(() => '---:').join(' | ')} | ---: |`);
    for (const [verdict, label] of VERDICTS10) {
      const values = OUTCOMES10.map(([k]) => cross(runs.both, verdict, k, where));
      const total = values.reduce((a, v) => a + v, 0);
      // The two verdicts the page's reader should never give are shown only where it gave them.
      if (total === 0 && (verdict === 'crashed' || verdict === 'unaccounted')) continue;
      out.push(`| ${label} | ${values.join(' | ')} | ${total} |`);
    }
    const colTotals = OUTCOMES10.map(([k]) => VERDICTS10.reduce((a, [v]) => a + cross(runs.both, v, k, where), 0));
    out.push(`| **all** | ${colTotals.map((v) => `**${v}**`).join(' | ')} | **${colTotals.reduce((a, v) => a + v, 0)}** |`);
    const oneTwin = (x: Cross10 | undefined, name: string, w: string): string => {
      const counts = VERDICTS10.map(([v]) => ({
        v,
        placed: cross(x, v, 'placed', w),
        refused: refusedOf(x, v, w),
      })).filter((c) => c.placed + c.refused > 0);
      const total = counts.reduce((a, c) => a + c.placed + c.refused, 0);
      if (total === 0) return `${name} alone places 0`;
      return (
        `${name} alone places ${total}: ` +
        counts.map((c) => `the page ${c.v} ${c.placed + c.refused} (the counterfactual placed ${c.placed})`).join(', ')
      );
    };
    out.push('');
    out.push(
      `_R1's other touched runs: ${oneTwin(runs.counterfactualOnly, 'the counterfactual’s twin', 'R1.page.runs.counterfactualOnly')}; ` +
        `${oneTwin(runs.pageOnly, 'the page twin', 'R1.page.runs.pageOnly')}; neither twin places ` +
        `${n10(runs.neither, 'R1.page.runs.neither')}. The counterfactual’s column is its deciding evaluation, fully ` +
        'noisy in R1; the page reads the same noisy frames encoded as it reads them._',
    );
    out.push('');
  }

  out.push(
    '| cell | touched runs both twins place | both place | both refuse | the page places, the counterfactual refuses | ' +
      'the page refuses, the counterfactual places | the page only notes | the counterfactual’s twin alone | the page twin alone | ' +
      'captures: the counterfactual’s LOUD the page passes SILENT · its SILENT the page refuses LOUD |',
  );
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  const loudRows: string[] = [];
  const wordRows: { id: string; runs: number; byClass: Record<string, number> }[] = [];
  for (const { id, from } of allCellIds10(result)) {
    const cell = cell10(from === 'rescore' ? result.rescore?.cells : result.lateness?.cells, id, `${from}.cells`);
    const page = page10(cell);
    const loud = has10(cell.loud, `${id}.loud`);
    if (page.status === 'not run') {
      out.push(`| ${id} | ${NOT_RUN10} | ${DASH10} | ${DASH10} | ${DASH10} | ${DASH10} | ${DASH10} | ${DASH10} | ${DASH10} | ${DASH10} |`);
      loudRows.push(
        `| ${id} | ${n10(loud.captures, `${id}.loud.captures`)} · ${DASH10} | ` +
          `${n10(loud.wholePositionOnly, `${id}.loud.wholePositionOnly`)} · ${DASH10} | ` +
          `${n10(loud.runByRun, `${id}.loud.runByRun`)} · ${DASH10} | ${n10(loud.reshootNamed, `${id}.loud.reshootNamed`)} · ${DASH10} | ` +
          `${n10(loud.dropAndDuplicate, `${id}.loud.dropAndDuplicate`)} · ${DASH10} |`,
      );
      continue;
    }
    const runs = has10(page.runs, `${id}.page.runs`);
    const w = `${id}.page.runs.both`;
    const sum = (verdict: string, outcomes: 'placed' | 'refused'): number =>
      outcomes === 'placed' ? cross(runs.both, verdict, 'placed', w) : refusedOf(runs.both, verdict, w);
    const both = VERDICTS10.reduce((a, [v]) => a + sum(v, 'placed') + sum(v, 'refused'), 0);
    const total = (x: Cross10 | undefined, where: string): number =>
      VERDICTS10.reduce((a, [v]) => a + cross(x, v, 'placed', where) + refusedOf(x, v, where), 0);
    const vs = has10(page.classes?.P?.vsCounterfactual, `${id}.page.classes.P.vsCounterfactual`);
    const loudToSilent = n10(has10(vs.LOUD, `${id} vsCounterfactual.LOUD`).SILENT, `${id} vsCounterfactual.LOUD.SILENT`);
    const silentToLoud = n10(has10(vs.SILENT, `${id} vsCounterfactual.SILENT`).LOUD, `${id} vsCounterfactual.SILENT.LOUD`);
    out.push(
      `| ${id} | ${both} | ${sum('placed', 'placed')} | ${sum('refused', 'refused') + sum('crashed', 'refused')} | ` +
        `${sum('placed', 'refused')} | ${sum('refused', 'placed') + sum('crashed', 'placed')} | ` +
        `${sum('noted', 'placed') + sum('noted', 'refused')} | ` +
        `${total(runs.counterfactualOnly, `${id}.page.runs.counterfactualOnly`)} | ` +
        `${total(runs.pageOnly, `${id}.page.runs.pageOnly`)} | ${loudToSilent} · ${silentToLoud} |`,
    );
    const pl = has10(page.loud, `${id}.page.loud`);
    loudRows.push(
      `| ${id} | ${n10(loud.captures, `${id}.loud.captures`)} · ${n10(pl.captures, `${id}.page.loud.captures`)} | ` +
        `${n10(loud.wholePositionOnly, `${id}.loud.wholePositionOnly`)} · ${n10(pl.wholePositionOnly, `${id}.page.loud.wholePositionOnly`)} | ` +
        `${n10(loud.runByRun, `${id}.loud.runByRun`)} · ${n10(pl.runByRun, `${id}.page.loud.runByRun`)} | ` +
        `${n10(loud.reshootNamed, `${id}.loud.reshootNamed`)} · ${n10(pl.reshootNamed, `${id}.page.loud.reshootNamed`)} | ` +
        `${n10(loud.dropAndDuplicate, `${id}.loud.dropAndDuplicate`)} · ${n10(pl.dropAndDuplicate, `${id}.page.loud.dropAndDuplicate`)} |`,
    );
    const words = has10(page.words, `${id}.page.words`);
    wordRows.push({ id, runs: n10(words.runs, `${id}.page.words.runs`), byClass: has10(words.byClass, `${id}.page.words.byClass`) });
  }
  out.push('');
  out.push(
    '_Touched runs of the changed positions the page read, on the counterfactual’s deciding evaluation. A crash counts ' +
      'with the page’s refusals. “Alone”: the one clean twin places the run and the other does not, so only the one reader ' +
      'can hold the straddle to account for it._',
  );
  out.push('');
  out.push(
    '| cell | LOUD: the counterfactual · the page | refused only as whole positions | refused run by run | ' +
      'of those, told “Re-shoot projector N” | told it looks like a dropped and a duplicated frame |',
  );
  out.push('| --- | --- | --- | --- | --- | --- |');
  out.push(...loudRows);
  const classes = PAGE_WORDS10.filter((k) => wordRows.some((r) => (r.byClass[k] ?? 0) > 0));
  for (const r of wordRows) {
    for (const k of Object.keys(r.byClass)) {
      if (!PAGE_WORDS10.includes(k)) throw new Error(`experiment-10: ${r.id}.page.words has a class '${k}' no table names`);
    }
  }
  out.push('');
  out.push(
    `| the page’s refused runs | refused | ${classes.map((k) => REASON_WORDS10[k] ?? k).join(' | ')} |`,
  );
  out.push(`| --- | ---: | ${classes.map(() => '---:').join(' | ')} |`);
  for (const r of wordRows) {
    out.push(
      `| ${r.id} | ${r.runs} | ${classes.map((k) => n10(r.byClass[k] ?? 0, `${r.id}.page.words.byClass.${k}`)).join(' | ')} |`,
    );
  }
  out.push('');
  out.push(
    '_The page’s words on each touched run it refuses and its clean reading places: the problems naming the run, or ' +
      'where none does, those about the whole folder, each class counted once per run. A run can be told more than ' +
      'one thing, so a row can sum past its refusals._',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The page's reader (tools/reader-acceptance.ts)
// ---------------------------------------------------------------------------

/** How one reader's runs came out, by its verdict: `placed`, `unseen`, `barely seen`, `broken`, … */
type VerdictsRA = Record<string, number>;

/** One kind of rig's clean positions, as the tool totals them. */
interface PositionsRA {
  positions: number;
  /** Positions where the page placed the projectors the counterfactual placed. */
  agreeing: number;
  /** Positions where the page raised no problem. */
  ok: number;
  misfiled: number;
  runs: number;
  page: VerdictsRA;
  counterfactual: VerdictsRA;
  /** Runs that light no pixel of the camera's picture, and what the page made of them. */
  darkRuns: number;
  darkRunsReadAs: VerdictsRA;
}

/** The folder shapes of one build, as the tool totals them. */
interface ShapesRA {
  cameras: number;
  shapes: number;
  passing: number;
  misfiled: number;
  /** `read`: of those passing, how many the page read as the position; the rest of a fault it refused in words. */
  byKind: Record<string, { shapes: number; passing: number; read?: number }>;
}

/** Only the fields the table below reads. The file carries far more. */
interface ReaderAcceptance {
  generatedFrom: {
    reader: { MIN_CRESCENT_BLOCKS: number };
    /** `lost`: photographs a camera started late or stopped early by; `spoiledPhotograph`: counted from 1. */
    shapes: { rigs: number[]; lost: number[]; spoiledPhotograph: number };
  };
  totals: {
    positions: Record<'all' | 'main' | 'spill' | 'fine', PositionsRA>;
    shapes: Record<'all' | 'main' | 'spill', ShapesRA>;
    disagreements: { where: string; litPixels: number; crescentBlocks: number; page: string; counterfactual: string }[];
  };
  positions: {
    which: string;
    width: number;
    height: number;
    runs: { litPixels: number; page: string; counterfactual: string }[];
  }[];
}

/** A cell the table reads. Absent is a fault and never a blank, for the reason `has10` gives. */
function hasRA<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `reader-acceptance: the results file has no ${what}; a cell a table reads is missing, which is ` +
        'a fault and not a blank',
    );
  }
  return value;
}

/** A finite number, and nothing else. */
function nRA(value: number | undefined, what: string): number {
  const v = hasRA(value, what);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`reader-acceptance: ${what} is ${JSON.stringify(v)}, and the table needs a number there`);
  }
  return v;
}

/** How many runs a reader gave one verdict. A verdict it never gave is not in the file, and is none. */
const verdictRA = (verdicts: VerdictsRA, name: string, what: string): number =>
  name in verdicts ? nRA(verdicts[name], `${what}.${name}`) : 0;

/** "4–176", or "7" when the two ends agree. */
const spanRA = (xs: readonly number[]): string => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
};

/** The folder shapes as the tool builds them, in its order. A kind the file lacks is a fault. */
const SHAPE_KINDS_RA: readonly string[] = [
  'before Play and after the black',
  're-shot and appended',
  're-shot and played on',
  're-shot alone',
];

/**
 * The faults on the way, as the tool builds them, in its order, each with the
 * words the table says it in. They pass read as the position or refused in
 * words, so each says how many were read.
 */
const FAULT_KINDS_RA: readonly { kind: string; say: (lost: string, photograph: number) => string }[] = [
  { kind: 'camera started late', say: (lost) => `the camera started ${lost} photographs late` },
  { kind: 'camera stopped early', say: () => 'stopped as many early' },
  { kind: 'a test shot before Play', say: () => 'a test shot of another projector’s white before Play' },
  { kind: 'a test shot before Play, re-shot and appended', say: () => 'and with that projector re-shot and appended' },
  {
    kind: 'spoiled, re-shot and appended',
    say: (_, photograph) => `a run spoiled by its photograph ${photograph} shot twice or not at all, re-shot and appended`,
  },
  { kind: 'spoiled, re-shot and played on', say: () => 'and played on' },
  { kind: 'a test shot of a Gray plane before Play', say: () => 'a test shot of a projector’s Gray plane before Play' },
  { kind: 'a test shot a stop under before Play', say: () => 'or of its white a stop under' },
  { kind: 'the room light switched on at the end tone', say: () => 'the room light switched on at the end tone' },
];

/**
 * The page's reader on every clean position EXPERIMENT-10's Q0 photographed,
 * against the counterfactual reader, and on the folder shapes the field card's
 * procedure makes and the faults an operator makes on the way.
 *
 * Rows by kind of rig, labelled as EXPERIMENT-10's Q0 table labels the same
 * positions so the two can be read side by side: that table is the reader the
 * page had then, this one the reader it has now. The folder shapes are built on
 * the designed rigs with the room off and on, so the sweep's row carries the
 * room-off shapes, the room-on row the rest, and the finer preset has none.
 *
 * Registered in `docs/OPERATOR-PATH.md`, as Phase 2's status.
 */
export function readerAcceptance(result: ReaderAcceptance): string {
  const totals = hasRA(result.totals, 'totals');
  const positions = hasRA(totals.positions, 'totals.positions');
  const shapes = hasRA(totals.shapes, 'totals.shapes');
  const records = hasRA(result.positions, 'positions');
  const raster = (which: string): string => {
    const sizes = [...new Set(records.filter((p) => p.which === which).map((p) => `${p.width}×${p.height}`))];
    if (sizes.length === 0) throw new Error(`reader-acceptance: no position record is '${which}'`);
    return sizes.join(', ');
  };
  const shapeCell = (s: ShapesRA | undefined, where: string): string =>
    s === undefined ? DASH10 : `${nRA(s.passing, `${where}.passing`)} of ${nRA(s.shapes, `${where}.shapes`)}`;
  const row = (label: string, which: 'all' | 'main' | 'spill' | 'fine', rasterCell: string): string => {
    const v = hasRA(positions[which], `totals.positions.${which}`);
    const where = `totals.positions.${which}`;
    const page = hasRA(v.page, `${where}.page`);
    const cf = hasRA(v.counterfactual, `${where}.counterfactual`);
    const dark = hasRA(v.darkRunsReadAs, `${where}.darkRunsReadAs`);
    const n = nRA(v.positions, `${where}.positions`);
    const b = (s: string): string => (which === 'all' ? `**${s}**` : s);
    // The finer preset has no folder shapes: they are built on the designed rigs.
    const shape = which === 'fine' ? undefined : hasRA(shapes[which], `totals.shapes.${which}`);
    const cells = [
      b(label),
      rasterCell,
      b(String(n)),
      b(String(n - nRA(v.ok, `${where}.ok`))),
      b(String(nRA(v.misfiled, `${where}.misfiled`))),
      b(`${verdictRA(page, 'placed', `${where}.page`)} · ${verdictRA(cf, 'placed', `${where}.counterfactual`)}`),
      b(`${nRA(v.agreeing, `${where}.agreeing`)} of ${n}`),
      b(`${verdictRA(page, 'unseen', `${where}.page`)} (${verdictRA(dark, 'unseen', `${where}.darkRunsReadAs`)})`),
      b(String(verdictRA(page, 'barely seen', `${where}.page`))),
      shape === undefined ? DASH10 : b(shapeCell(shape, `totals.shapes.${which}`)),
    ];
    return `| ${cells.join(' | ')} |`.replace(/\|  \|/g, '| |');
  };
  const out = [
    '| clean positions | raster | positions | refused | photographs misfiled | ' +
      'runs placed: the page · the counterfactual | placing what the counterfactual places | ' +
      'noted out of view (lighting no pixel) | noted barely seen | folder shapes passing |',
    '| --- | --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |',
  ];
  // The same positions as EXPERIMENT-10's Q0 table, under the same names.
  for (const [which, label] of Q0_VARIANTS10) out.push(row(label, which, raster(which)));
  out.push(row('all', 'all', ''));

  const all = hasRA(positions.all, 'totals.positions.all');
  const darkRuns = nRA(all.darkRuns, 'totals.positions.all.darkRuns');
  const darkUnseen = verdictRA(hasRA(all.darkRunsReadAs, 'totals.positions.all.darkRunsReadAs'), 'unseen', 'darkRunsReadAs');
  // What the counterfactual said of the same dark runs, from the per-position
  // records. `broken` is the tool's name for its broken-pair refusal, whose
  // words always end "Re-shoot projector N." (`indexByFingerprint`); the file
  // keeps the words themselves only where the two readers disagree.
  const darkRecords = records
    .flatMap((p) => hasRA(p.runs, `positions[${p.which}].runs`))
    .filter((r) => nRA(r.litPixels, 'positions[].runs[].litPixels') === 0);
  if (darkRecords.length !== darkRuns) {
    throw new Error(`reader-acceptance: ${darkRecords.length} run records light no pixel, and the totals say ${darkRuns}`);
  }
  const darkReshoot = darkRecords.filter((r) => r.counterfactual === 'broken').length;
  const minBlocks = nRA(result.generatedFrom?.reader?.MIN_CRESCENT_BLOCKS, 'generatedFrom.reader.MIN_CRESCENT_BLOCKS');
  out.push('');
  out.push(
    '_The counterfactual is `indexByFingerprint` handed the same fingerprints and every frame’s kind ' +
      'exactly, as EXPERIMENT-10’s counterfactual reader was. Refused: positions where the page raised a ' +
      'problem. Noted out of view: a projector whose run is dark in every photograph from that position; ' +
      `noted barely seen: one that lights fewer than ${minBlocks} fingerprint blocks, and is not decoded. ` +
      `Every run that lights no pixel is noted out of view, ${darkUnseen} of ${darkRuns}; the ` +
      `counterfactual refuses ${darkReshoot} of them as a broken pair and asks for that projector to be re-shot._`,
  );

  const dis = hasRA(totals.disagreements, 'totals.disagreements');
  const notDecoded = dis.filter((d) => d.counterfactual === 'placed' && d.page !== 'placed');
  if (notDecoded.length !== dis.length) {
    throw new Error(
      `reader-acceptance: ${dis.length - notDecoded.length} disagreements are not a run the counterfactual ` +
        'places and the page does not, which this table has no words for',
    );
  }
  out.push('');
  out.push(
    dis.length === 0
      ? '_The two readers place the same runs everywhere._'
      : `_Where the two disagree — ${dis.length} runs in ${new Set(dis.map((d) => d.where)).size} ` +
          `positions — the counterfactual places a run the page does not decode: a crescent of ` +
          `${spanRA(dis.map((d) => nRA(d.crescentBlocks, 'disagreements[].crescentBlocks')))} fingerprint blocks lighting ` +
          `${spanRA(dis.map((d) => nRA(d.litPixels, 'disagreements[].litPixels')))} pixels, noted barely seen ` +
          `(${dis.filter((d) => d.page === 'barely seen').length}) or out of view ` +
          `(${dis.filter((d) => d.page === 'unseen').length})._`,
  );

  const every = hasRA(shapes.all, 'totals.shapes.all');
  const byKind = hasRA(every.byKind, 'totals.shapes.all.byKind');
  const kinds = SHAPE_KINDS_RA.map((kind) => {
    const k = hasRA(byKind[kind], `totals.shapes.all.byKind['${kind}']`);
    return `${kind} ${nRA(k.passing, `byKind['${kind}'].passing`)} of ${nRA(k.shapes, `byKind['${kind}'].shapes`)}`;
  });
  const lostBy = hasRA(result.generatedFrom?.shapes?.lost, 'generatedFrom.shapes.lost').map((x) => nRA(x, 'generatedFrom.shapes.lost[]'));
  const lost = lostBy.length === 1 ? String(lostBy[0]) : `${lostBy.slice(0, -1).join(', ')} or ${lostBy[lostBy.length - 1]}`;
  const photograph = nRA(result.generatedFrom?.shapes?.spoiledPhotograph, 'generatedFrom.shapes.spoiledPhotograph');
  const faults = FAULT_KINDS_RA.map(({ kind, say }) => {
    const k = hasRA(byKind[kind], `totals.shapes.all.byKind['${kind}']`);
    return (
      `${say(lost, photograph)} ${nRA(k.passing, `byKind['${kind}'].passing`)} of ` +
      `${nRA(k.shapes, `byKind['${kind}'].shapes`)} (${nRA(k.read, `byKind['${kind}'].read`)} read)`
    );
  });
  const known = [...SHAPE_KINDS_RA, ...FAULT_KINDS_RA.map((f) => f.kind)];
  const extra = Object.keys(byKind).filter((k) => !known.includes(k));
  if (extra.length > 0) throw new Error(`reader-acceptance: folder shapes this table does not know: ${extra.join(', ')}`);
  out.push('');
  out.push(
    `_Folder shapes, on the ${hasRA(result.generatedFrom?.shapes?.rigs, 'generatedFrom.shapes.rigs').length} ` +
      `designed rigs with the room off and on: ${kinds.join(' · ')}. A shape passes when the page reads ` +
      'it as it read the position alone, with a re-shot run used in place of its original; a re-shot ' +
      'run handed in alone passes when it is refused with how to hand it in. The faults an operator ' +
      'makes on the way pass when the page reads them so or refuses them in words, placing nothing ' +
      `the position alone does not: ${faults.join(' · ')}. Photographs misfiled in them all: ` +
      `${nRA(every.misfiled, 'totals.shapes.all.misfiled')}._`,
  );
  return out.join('\n');
}

const BLOCKS: Record<string, Block> = {
  'experiment-10-precondition': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10PreconditionTwoReaders as (r: never) => string,
  },
  'experiment-10-crossings': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Crossings as (r: never) => string,
  },
  'experiment-10-decode': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Decode as (r: never) => string,
  },
  'experiment-10-pose': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Pose as (r: never) => string,
  },
  'experiment-10-rescore': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Rescore as (r: never) => string,
  },
  // The same captures through the page's own reader, in the section after the
  // counterfactual's: the rescore and lateness cells as the page reads them.
  'experiment-10-page': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Page as (r: never) => string,
  },
  'experiment-10-positions': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Positions as (r: never) => string,
  },
  // Run by run, the page against the counterfactual, and what each reader's
  // refusals say, directly under the counterfactual's words in the section on
  // what the page tells the operator.
  'experiment-10-page-runs': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10PageRuns as (r: never) => string,
  },
  'experiment-10-lateness': {
    doc: 'docs/EXPERIMENT-10.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Lateness as (r: never) => string,
  },
  // The operator's view of the same cells, in the plan whose Phase 5 it
  // prices. Registered here and not copied, for the reason the experiment-9
  // entry below gives.
  'experiment-10-rescore-operator-path': {
    doc: 'docs/OPERATOR-PATH.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Operator as (r: never) => string,
  },
  // And in the field card, beside EXPERIMENT-9's table, because it is the
  // measurement under two of the card's instructions — re-shoot a refused
  // position whole, and aim the start — and under the caveat on the second:
  // how late the emitter may run before aiming stops protecting. A copied
  // table would go stale exactly where a stale number costs a camera position.
  'experiment-10-rescore-calibrate': {
    doc: 'docs/CALIBRATE.md',
    data: 'experiments/experiment-10.json',
    render: experiment10Operator as (r: never) => string,
  },
  // The page's reader on the same clean positions EXPERIMENT-10's Q0 refused
  // whole, in the plan whose Phase 2 status it is. Registered and not copied,
  // for the reason the Phase 2 entry below gives: that status IS these numbers.
  // It sits in the dated note under EXPERIMENT-10's correction, hence the prefix.
  'reader-acceptance-operator-path': {
    doc: 'docs/OPERATOR-PATH.md',
    data: 'experiments/reader-acceptance.json',
    render: readerAcceptance as (r: never) => string,
    prefix: '> ',
  },
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
  // And a third time, in the field card, because this table is the argument for
  // the one instruction on it that an operator has no way to check: how to start
  // the intervalometer. A copied table would go stale exactly where a stale
  // number costs a camera position.
  'experiment-9-phase-calibrate': {
    doc: 'docs/CALIBRATE.md',
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
