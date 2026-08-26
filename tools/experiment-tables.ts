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

const BLOCKS: Record<string, Block> = {
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

function main(): void {
  const write = process.argv.includes('--write');
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
