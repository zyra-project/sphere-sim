// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 1 — the runner.
 *
 *   node packages/experiments/src/experiment1/cli.ts              # the published run, ~2 h
 *   node packages/experiments/src/experiment1/cli.ts --list       # print the plan and the budget, run nothing
 *   node packages/experiments/src/experiment1/cli.ts --plots-only # re-render the figures from the raw runs
 *   node packages/experiments/src/experiment1/cli.ts --seed-scale 0.2 --only degradation   # smoke test
 *
 * Experiment 1 lives in its own directory because experiments 2 and 3 share
 * this package and were written by a different hand at the same time. Distinct
 * namespaces are cheaper than a merge.
 *
 * ## Resume, and why it is not a shortcut
 *
 * The full design is about two hours of wall clock and a single point can be
 * twelve minutes of it. Each completed (point, seed) is appended to
 * `progress/experiment-1-runs.jsonl` as it finishes, and a re-run skips
 * anything already there. That is safe precisely because every point is a pure
 * function of `(spec, seedIndex)` — the same key can only ever produce the same
 * numbers, so resuming cannot silently splice two different measurements
 * together. Delete the file to force a clean run.
 *
 * ## What "deterministic" means here
 *
 * Same command, same numbers, byte for byte, apart from the two blocks the
 * results file declares volatile: `env` and the wall-clock timings. That is the
 * same contract `packages/bench` states and `tools/assert-deterministic.ts`
 * enforces there.
 *
 * ## What this file does NOT do
 *
 * It does not read a previous run and change the design, it has no best-of-N,
 * and it has no tuning knob. docs/ARCHITECTURE.md: "Iterating an experiment
 * until it says something better is how a measurement becomes an
 * advertisement." `--plots-only` re-renders figures from runs already on disk;
 * it is a renderer, not a re-measurement.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PointSpec } from './design.ts';
import { CUTS, DEGRADATION_CONDITIONS, EXPERIMENT_ROOT_SEED, buildDesign } from './design.ts';
import type { PointRun } from './point.ts';
import { runPoint, seedFor } from './point.ts';
import type { Cell } from './results.ts';
import { EXPERIMENT_SCHEMA, TRACKED_FIELDS, aggregate, findCell, seriesOf } from './results.ts';
import {
  cameraCountFigure,
  degradationFigure,
  floorSigmaFigure,
  quadratureCheck,
  quadraturePrediction,
  resolutionFigure,
} from './plots.ts';
import { renderFigure } from './svg.ts';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const PROGRESS = path.join(REPO_ROOT, 'progress');
const RUNS_PATH = path.join(PROGRESS, 'experiment-1-runs.jsonl');
const JSON_PATH = path.join(PROGRESS, 'experiment-1.json');

interface Args {
  list: boolean;
  plotsOnly: boolean;
  seedScale: number;
  only: string | null;
  runsPath: string;
  jsonPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    list: false,
    plotsOnly: false,
    seedScale: 1,
    only: null,
    runsPath: RUNS_PATH,
    jsonPath: JSON_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--list') a.list = true;
    else if (v === '--plots-only') a.plotsOnly = true;
    else if (v === '--seed-scale') a.seedScale = Number(argv[++i]);
    else if (v === '--only') a.only = argv[++i];
    else if (v === '--runs') a.runsPath = path.resolve(argv[++i]);
    else if (v === '--out') a.jsonPath = path.resolve(argv[++i]);
    else throw new Error(`unknown argument '${v}'`);
  }
  return a;
}

function loadRuns(file: string): Map<string, PointRun> {
  const out = new Map<string, PointRun>();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line) as PointRun;
    out.set(r.key, r);
  }
  return out;
}

/** A point that could not be run at all. Every measurement is NaN, on purpose. */
function failedRun(spec: PointSpec, seedIndex: number, e: unknown): PointRun {
  const nan = Number.NaN;
  return {
    key: `${spec.figure}|${spec.series}|${spec.level}|${seedIndex}`,
    figure: spec.figure,
    axis: spec.axis,
    series: spec.series,
    level: spec.level,
    x: spec.x,
    seedIndex,
    seed: seedFor(seedIndex),
    cameraCount: spec.cameraCount,
    resX: spec.resX,
    resY: spec.resY,
    floorSigmaM: spec.floorSigmaM,
    floorReferenceCount: spec.floorReferenceCount,
    ambient: spec.degradation.ambient,
    sensorNoise: spec.degradation.sensorNoise,
    motion: spec.degradation.motion,
    rollingShutter: spec.degradation.rollingShutter,
    maxCorrespondencesPerPair: spec.maxCorrespondencesPerPair,
    error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    posePositionMm: nan,
    poseRotationDeg: nan,
    gridDisplacementMm: nan,
    hCenterErrorMm: nan,
    poseRmsPositionMm: nan,
    poseRawPositionMm: nan,
    fovErrorDeg: nan,
    rmsResidualPx: nan,
    correspondencesUsed: 0,
    correspondencesDecoded: 0,
    decodeAccepted: 0,
    decodeConsidered: 0,
    converged: false,
    stopReason: 'threw',
    centerHeightObserved: false,
    gaugeAngleDeg: nan,
    gaugeUnconstrainedAngleDeg: nan,
    motionTranslationMm: nan,
    motionRotationDeg: nan,
    wallClockMs: 0,
    truthFovHDeg: nan,
    truthDistanceM: nan,
    fovSubtensePredictedMm: nan,
  };
}

function hhmmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The answers, computed from the cells rather than written by hand.
 *
 * docs/EXPERIMENT-1.md quotes these. Deriving them here means the prose and the
 * plot cannot drift apart: if a number in the finding is wrong, it is wrong in
 * the results file too and a reader can see it.
 */
function derive(cells: readonly Cell[]): Record<string, unknown> {
  const gate = (id: string): number =>
    TRACKED_FIELDS.find((f) => f.key === id)?.gate ?? Number.NaN;

  // How many photographs before the curve stops moving? "Stops moving" is
  // docs/ARCHITECTURE.md's own definition — the change no longer exceeds the
  // run-to-run dispersion — applied to the count axis: the knee is the smallest
  // count whose median is within the seed-to-seed spread of the best point.
  const knee = (series: string, field: string): Record<string, unknown> => {
    const s = seriesOf(cells, 'camera-count', series);
    if (s.length === 0) return { series, field, knee: null };
    const medians = s.map((c) => c.metrics[field].median);
    const finite = medians.filter((v) => Number.isFinite(v));
    if (finite.length === 0) return { series, field, knee: null };
    const best = Math.min(...finite);
    const bestCell = s[medians.indexOf(best)];
    const spread = bestCell.metrics[field];
    const tol = Number.isFinite(spread.max - spread.min) ? spread.max - spread.min : 0;
    let kneeAt: number | null = null;
    for (const c of s) {
      const m = c.metrics[field].median;
      if (Number.isFinite(m) && m - best <= tol) {
        kneeAt = c.inputs.cameraCount;
        break;
      }
    }
    return {
      series,
      field,
      bestMedian: best,
      bestAtCameras: bestCell.inputs.cameraCount,
      toleranceUsed: tol,
      toleranceIs: 'the observed seed-to-seed range at the best point',
      knee: kneeAt,
      perCount: s.map((c) => ({
        cameras: c.inputs.cameraCount,
        median: c.metrics[field].median,
        min: c.metrics[field].min,
        max: c.metrics[field].max,
        sd: c.metrics[field].sd,
        n: c.n,
      })),
    };
  };

  const resolutionTable = (series: string): Record<string, unknown>[] =>
    seriesOf(cells, 'resolution', series).map((c) => ({
      resolution: c.level,
      n: c.n,
      posePositionMm: c.metrics.posePositionMm.median,
      posePositionRange: [c.metrics.posePositionMm.min, c.metrics.posePositionMm.max],
      poseRotationDeg: c.metrics.poseRotationDeg.median,
      gridDisplacementMm: c.metrics.gridDisplacementMm.median,
      gridDisplacementRange: [c.metrics.gridDisplacementMm.min, c.metrics.gridDisplacementMm.max],
      fovErrorDeg: c.metrics.fovErrorDeg.median,
      rmsResidualPx: c.metrics.rmsResidualPx.median,
      correspondencesUsed: c.metrics.correspondencesUsed.median,
      passesPosePositionGate: c.metrics.posePositionMm.median <= gate('posePositionMm'),
      passesPoseRotationGate: c.metrics.poseRotationDeg.median <= gate('poseRotationDeg'),
      passesGridGate: c.metrics.gridDisplacementMm.median <= gate('gridDisplacementMm'),
      medianSeconds: c.medianSeconds,
    }));

  const capControl = ['1500/pair', '9000/pair'].map((level) => {
    const c = findCell(cells, 'cap-control', 'tripod', level);
    return c === undefined
      ? { level, present: false }
      : {
          level,
          present: true,
          n: c.n,
          correspondencesUsed: c.metrics.correspondencesUsed.median,
          posePositionMm: c.metrics.posePositionMm.median,
          posePositionRange: [c.metrics.posePositionMm.min, c.metrics.posePositionMm.max],
          poseRotationDeg: c.metrics.poseRotationDeg.median,
          rmsResidualPx: c.metrics.rmsResidualPx.median,
          medianSeconds: c.medianSeconds,
        };
  });

  const floorTable = (series: string): Record<string, unknown> => {
    const s = seriesOf(cells, 'floor-sigma', series);
    const out: Record<string, unknown> = {
      series,
      levels: s.map((c) => ({
        sigmaMm: c.x,
        n: c.n,
        posePositionMm: c.metrics.posePositionMm.median,
        posePositionRange: [c.metrics.posePositionMm.min, c.metrics.posePositionMm.max],
        poseRotationDeg: c.metrics.poseRotationDeg.median,
        hCenterErrorMm: c.metrics.hCenterErrorMm.median,
        passesPosePositionGate: c.metrics.posePositionMm.median <= gate('posePositionMm'),
        passesPoseRotationGate: c.metrics.poseRotationDeg.median <= gate('poseRotationDeg'),
      })),
    };
    for (const field of ['posePositionMm', 'poseRotationDeg']) {
      const p = quadraturePrediction(cells, series, field);
      const mid = findCell(cells, 'floor-sigma', series, '1 mm');
      if (p !== null && mid !== undefined) {
        out[`quadrature_${field}`] = {
          sensorTerm: p.sensorTerm,
          tapeTermAt3mm: p.tapeAt3mm,
          predictedAt1mm: p.predict(1),
          measuredAt1mm: mid.metrics[field].median,
          ratio: mid.metrics[field].median / p.predict(1),
          note:
            'Calibrated at 0.1 mm (sensor term) and 3 mm (tape term). 1 mm is a prediction, not a fit.',
        };
      }
    }
    const noRef = findCell(cells, 'floor-sigma', `${series} (no reference)`, 'none');
    if (noRef !== undefined) {
      out.noFloorReference = {
        n: noRef.n,
        posePositionMm: noRef.metrics.posePositionMm.median,
        poseRotationDeg: noRef.metrics.poseRotationDeg.median,
        hCenterErrorMm: noRef.metrics.hCenterErrorMm.median,
        note:
          'h_center is HELD at its documented value rather than solved, so this is a different estimator, not a noisier one.',
      };
    }
    return out;
  };

  const degradationTable = DEGRADATION_CONDITIONS.map((d) => {
    const c = findCell(cells, 'degradation', 'single condition', d.label);
    if (c === undefined) return { condition: d.label, present: false };
    const none = findCell(cells, 'degradation', 'single condition', 'none');
    const base = none?.metrics.posePositionMm.median ?? Number.NaN;
    return {
      condition: d.label,
      note: d.note,
      n: c.n,
      posePositionMm: c.metrics.posePositionMm.median,
      posePositionRange: [c.metrics.posePositionMm.min, c.metrics.posePositionMm.max],
      excessOverNoneMm: c.metrics.posePositionMm.median - base,
      poseRotationDeg: c.metrics.poseRotationDeg.median,
      gridDisplacementMm: c.metrics.gridDisplacementMm.median,
      rmsResidualPx: c.metrics.rmsResidualPx.median,
      fovErrorDeg: c.metrics.fovErrorDeg.median,
      cameraExcursionMm: c.metrics.motionTranslationMm.median,
    };
  });

  // docs/AMENDMENTS.md A-18's causal chain, tested on every cell of every axis
  // rather than on the three scenarios A-18 had. If the position error IS the
  // field-of-view error converted by the subtense relation, this ratio sits near
  // 1 everywhere — and then the answer to "how many photographs" is decided by
  // how well the lens is known rather than by how many pictures were taken.
  const subtenseRows: { cell: string; measured: number; predicted: number; ratio: number }[] = [];
  for (const c of cells) {
    const m = c.metrics.posePositionMm.median;
    const p = c.metrics.fovSubtensePredictedMm.median;
    if (!Number.isFinite(m) || !Number.isFinite(p) || p <= 0) continue;
    subtenseRows.push({
      cell: `${c.figure}/${c.series}/${c.level}`,
      measured: m,
      predicted: p,
      ratio: m / p,
    });
  }
  const ratios = subtenseRows.map((r) => r.ratio).sort((a, b) => a - b);
  const rq = (f: number): number =>
    ratios.length === 0
      ? Number.NaN
      : ratios[Math.min(ratios.length - 1, Math.floor(f * ratios.length))];

  return {
    fovSubtenseCheck: {
      relation: 'delta_d / d = delta_fov / (2 tan(fov/2)), docs/AMENDMENTS.md A-18 step 3',
      note:
        'Both terms are worst-projector maxima and can land on different projectors, so agreement is expected to be good rather than exact.',
      cells: subtenseRows.length,
      ratioMedian: rq(0.5),
      ratioP10: rq(0.1),
      ratioP90: rq(0.9),
      withinTwoFold: subtenseRows.filter((r) => r.ratio > 0.5 && r.ratio < 2).length,
      perCell: subtenseRows,
    },
    cameraCount: {
      question: 'How many photographs does a real calibration need?',
      tripod: knee('tripod', 'posePositionMm'),
      handheld: knee('handheld', 'posePositionMm'),
      tripodGrid: knee('tripod', 'gridDisplacementMm'),
      handheldGrid: knee('handheld', 'gridDisplacementMm'),
    },
    resolution: {
      question: 'Does a phone suffice, and against which gate?',
      tripod: resolutionTable('tripod'),
      handheld: resolutionTable('handheld'),
      capControl,
    },
    floorReference: {
      question: 'Is the floor-reference instrument the binding constraint?',
      byCamera: [floorTable('320x240'), floorTable('640x480')],
    },
    degradation: {
      question: 'What does each degradation cost on its own, and do they add in quadrature?',
      conditions: degradationTable,
      quadrature: ['posePositionMm', 'poseRotationDeg', 'gridDisplacementMm']
        .map((f) => quadratureCheck(cells, f))
        .filter((q) => q !== null),
    },
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let design = buildDesign(args.seedScale);
  if (args.only !== null) {
    const only = args.only;
    design = design.filter((d) => d.figure === only);
    if (design.length === 0) throw new Error(`no points for figure '${only}'`);
  }

  const totalPoints = design.reduce((a, d) => a + d.seedCount, 0);
  const totalSec = design.reduce((a, d) => a + d.seedCount * d.estimateSec, 0);

  if (args.list) {
    console.log(`Experiment 1 design: ${design.length} cells, ${totalPoints} solves.`);
    console.log(`Estimated wall clock: ${hhmmss(totalSec)} (probe-derived, budgeting only).\n`);
    const byFigure = new Map<string, { cells: number; solves: number; sec: number }>();
    for (const d of design) {
      const e = byFigure.get(d.figure) ?? { cells: 0, solves: 0, sec: 0 };
      e.cells += 1;
      e.solves += d.seedCount;
      e.sec += d.seedCount * d.estimateSec;
      byFigure.set(d.figure, e);
    }
    for (const [fig, e] of byFigure) {
      console.log(
        `  ${fig.padEnd(14)} ${String(e.cells).padStart(3)} cells  ${String(e.solves).padStart(4)} solves  ~${hhmmss(e.sec)}`,
      );
    }
    console.log('\nCuts:');
    for (const c of CUTS) console.log(`  - ${c.what}`);
    return;
  }

  const done = loadRuns(args.runsPath);
  const runs: PointRun[] = [];

  if (!args.plotsOnly) {
    fs.mkdirSync(path.dirname(args.runsPath), { recursive: true });
    let index = 0;
    let spent = 0;
    const started = Date.now();
    for (const spec of design) {
      for (let s = 0; s < spec.seedCount; s++) {
        index++;
        const key = `${spec.figure}|${spec.series}|${spec.level}|${s}`;
        const cached = done.get(key);
        if (cached !== undefined) {
          runs.push(cached);
          spent += spec.estimateSec;
          continue;
        }
        const label = `${spec.figure}/${spec.series}/${spec.level} seed ${s}`;
        process.stdout.write(
          `[${String(index).padStart(3)}/${totalPoints}] ${label.padEnd(46)} (~${Math.round(spec.estimateSec)}s) ... `,
        );
        // A point that throws is recorded and the run continues. The 4032x3024
        // point allocates about a gigabyte of ray tables; if it fails on a
        // smaller box that is a fact about the experiment worth writing down,
        // not a reason to lose the ninety minutes that preceded it.
        let run: PointRun;
        try {
          run = runPoint(spec, s, REPO_ROOT);
        } catch (e) {
          run = failedRun(spec, s, e);
        }
        fs.appendFileSync(args.runsPath, `${JSON.stringify(run)}\n`);
        runs.push(run);
        spent += spec.estimateSec;
        process.stdout.write(
          `${(run.wallClockMs / 1000).toFixed(1)}s  pose ${run.posePositionMm.toFixed(2)}mm  rot ${run.poseRotationDeg.toFixed(4)}deg  grid ${Number.isFinite(run.gridDisplacementMm) ? run.gridDisplacementMm.toFixed(3) : 'n/a'}mm  [eta ${hhmmss(totalSec - spent)}, elapsed ${hhmmss((Date.now() - started) / 1000)}]\n`,
        );
      }
    }
  } else {
    for (const spec of design) {
      for (let s = 0; s < spec.seedCount; s++) {
        const r = done.get(`${spec.figure}|${spec.series}|${spec.level}|${s}`);
        if (r !== undefined) runs.push(r);
      }
    }
  }

  const cells = aggregate(runs);

  const results = {
    schema: EXPERIMENT_SCHEMA,
    experiment: 1,
    title: 'Camera positions, resolution, floor reference, and each degradation on its own',
    questions: [
      'How many photographs does a real calibration need?',
      'Does a phone suffice — and against which gate?',
    ],
    phase: 'geometry',
    provisional: false,
    provisionalNote:
      'Experiment 1 is purely geometric. docs/ARCHITECTURE.md: experiments 2 and 3 inherit the PROVISIONAL marking from Phase 2 photometry; this one does not.',
    command: 'node packages/experiments/src/experiment1/cli.ts',
    rootSeed: EXPERIMENT_ROOT_SEED,
    seedsUsed: Array.from(new Set(runs.map((r) => r.seedIndex)))
      .sort((a, b) => a - b)
      .map((i) => ({ seedIndex: i, seed: seedFor(i) })),
    volatile: ['env', 'runs[].wallClockMs', 'cells[].medianSeconds'],
    gates: TRACKED_FIELDS.filter((f) => f.gate !== null).map((f) => ({
      field: f.key,
      label: f.label,
      unit: f.unit,
      max: f.gate,
      source: f.gateSource,
    })),
    cuts: CUTS,
    degradationConditions: DEGRADATION_CONDITIONS.map((d) => ({
      label: d.label,
      note: d.note,
      ...d.spec,
    })),
    derived: derive(cells),
    cells,
    runs,
    env: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      generatedAt: new Date().toISOString(),
    },
  };

  fs.mkdirSync(path.dirname(args.jsonPath), { recursive: true });
  fs.writeFileSync(args.jsonPath, `${JSON.stringify(results, null, 2)}\n`);

  const figures: { file: string; spec: ReturnType<typeof cameraCountFigure> }[] = [];
  if (seriesOf(cells, 'camera-count', 'tripod').length > 0) {
    figures.push({ file: 'experiment-1-camera-count.svg', spec: cameraCountFigure(cells) });
  }
  if (seriesOf(cells, 'resolution', 'tripod').length > 0) {
    figures.push({ file: 'experiment-1-resolution.svg', spec: resolutionFigure(cells) });
  }
  if (seriesOf(cells, 'floor-sigma', '320x240').length > 0) {
    figures.push({ file: 'experiment-1-floor-reference.svg', spec: floorSigmaFigure(cells) });
  }
  if (findCell(cells, 'degradation', 'single condition', 'none') !== undefined) {
    figures.push({ file: 'experiment-1-degradations.svg', spec: degradationFigure(cells) });
  }
  fs.mkdirSync(PROGRESS, { recursive: true });
  for (const f of figures) {
    fs.writeFileSync(path.join(PROGRESS, f.file), renderFigure(f.spec));
  }

  console.log(`\n${runs.length} solves across ${cells.length} cells.`);
  console.log(`wrote ${path.relative(REPO_ROOT, args.jsonPath)}`);
  for (const f of figures) console.log(`wrote progress/${f.file}`);
  const failed = runs.filter((r) => r.error !== null);
  if (failed.length > 0) {
    console.log(`\n${failed.length} solve(s) threw:`);
    for (const f of failed.slice(0, 10)) console.log(`  ${f.key}: ${f.error}`);
  }
}

main();
