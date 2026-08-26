// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 1 — the design.
 *
 * docs/ARCHITECTURE.md: "The three experiments are not the loop. They are
 * measurements. Each runs ONCE, produces a plot and a written finding, and is
 * not iterated to improve its result." So this file states the whole design up
 * front, including the parts that were cut, and nothing downstream chooses what
 * to run.
 *
 * ## The question, and why it is four axes rather than one
 *
 * The brief asks: sweep 1..8 camera positions, plot solver recovery error
 * against count, add sensor noise / ambient / rolling shutter as separate
 * conditions, and answer "how many photos does a real calibration need" and
 * "does a phone suffice".
 *
 * docs/AMENDMENTS.md A-16 measured that the naive one-axis version answers the
 * wrong question: at the corpus's operating point the error floor is set by the
 * floor-reference tape measure, not by the cameras, so a count sweep alone would
 * produce a flat line and an unearned conclusion. A-18 then corrected A-16 —
 * the tape is the floor, not the ceiling, and the ceiling is knowledge of the
 * lens. Both of those say the same thing about experiment design: **camera
 * count is not the dominant axis and cannot be measured as though it were.**
 *
 * So four axes, each varied with everything else held:
 *
 *   1. `camera-count`  — 1..8, the axis the brief names.
 *   2. `resolution`    — 320x240 up to a real phone, which is what "does a
 *                        phone suffice" actually asks.
 *   3. `floor-sigma`   — 3 mm tape (what §8 item 1 prescribes), 1 mm laser
 *                        measure, 0.1 mm survey instrument, and none at all.
 *   4. `degradation`   — sensor noise, ambient, rolling shutter, and handheld
 *                        motion, each independently switchable, so each
 *                        condition's contribution is measured on its own and
 *                        the quadrature question can be asked.
 *
 * ## The base condition
 *
 * Every point is the bench's `nominal` archetype — PARAMETERS.md §2 mount
 * tolerances, four projectors, §5 nominal ambient, a real sensor, a tripod —
 * with exactly the axis under test overridden. The archetype is reused rather
 * than reinvented so the experiment measures the same pipeline the bench scores,
 * and no archetype is added to the corpus: packages/bench/README.md is explicit
 * that the corpus order is an interface CI compares across commits.
 *
 * Two conditions carry the count and resolution sweeps:
 *
 *   `tripod`   — §5 nominal ambient, sensor noise on, camera static, global
 *                shutter. What a careful operator with a tripod gets.
 *   `handheld` — the same with handheld motion and a rolling shutter on. What
 *                somebody with a phone gets.
 *
 * They differ in the motion and the shutter and in NOTHING else. That is
 * deliberate: packages/bench/README.md records that the corpus's own
 * `six-cameras` and `two-cameras` differ in three things at once, so the gap
 * between them is not the price of four extra photographs. This design does not
 * repeat that mistake.
 *
 * ## Seeds and dispersion
 *
 * Every point runs at several seeds and the spread is reported, never averaged
 * away. A single-seed curve is an anecdote — docs/ARCHITECTURE.md's loop
 * protocol regenerates scenarios per round for exactly this reason. Seeds are
 * derived from one documented root so the whole experiment replays by number.
 *
 * ## What the budget cut, stated here rather than discovered later
 *
 * Wall clock is real: capture cost is `cameras x projectors x frames x pixels`
 * and it dominates. Measured on this box, one 3-camera point costs about 9 s at
 * 320x240, 22 s at 640x480, 76 s at 1280x960, ~5 min at 2560x1920 and ~12 min
 * at 4032x3024. {@link CUTS} lists every place the design is thinner than it
 * would ideally be and what that costs the conclusion.
 */

import type { BenchPreset } from '../../../bench/src/scenarios.ts';

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/**
 * The one root the whole experiment hangs off.
 *
 * A date rather than a lucky number, so that "which run was this" has an answer
 * that is not "the one on my laptop". Every scenario seed below is
 * `deriveSeed(EXPERIMENT_ROOT_SEED, 'exp1-seed:<i>')`, which makes the run a
 * pure function of this constant and the design.
 */
export const EXPERIMENT_ROOT_SEED = 20260810;

/** Default replicate count. Overridable from the CLI for a smoke run only. */
export const DEFAULT_SEED_COUNT = 5;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * The degradation switches, each independent.
 *
 * packages/bench/README.md's degradation section is the contract these
 * implement: ambient is a DC offset the decode cancels analytically (its cost
 * arrives through the shot-noise floor, not through the decode), sensor noise is
 * Poisson so its variance tracks the signal, and a rolling shutter on a static
 * camera is a PROVEN no-op — which is why `motion` and `rollingShutter` are two
 * switches rather than one. A bench that bundled them would report the shutter's
 * cost as the motion's.
 */
export interface DegradationSpec {
  /** PARAMETERS.md §5 `E_amb`, relative. 0 = none, 0.04 nominal, 0.15 top of range. */
  ambient: number;
  /** Photon shot noise, read noise, saturation, ADC quantization. */
  sensorNoise: boolean;
  /** Handheld tremor, sway and drift. Costs the decode with a GLOBAL shutter too. */
  motion: boolean;
  /** Row-by-row readout. Provably invisible unless `motion` is also on. */
  rollingShutter: boolean;
}

export const NOMINAL_AMBIENT = 0.04;
export const HIGH_AMBIENT = 0.15;

/** A careful operator on a tripod, in a normally lit room. */
export const TRIPOD: DegradationSpec = {
  ambient: NOMINAL_AMBIENT,
  sensorNoise: true,
  motion: false,
  rollingShutter: false,
};

/** The same room, the same sensor, a hand instead of a tripod. */
export const HANDHELD: DegradationSpec = {
  ambient: NOMINAL_AMBIENT,
  sensorNoise: true,
  motion: true,
  rollingShutter: true,
};

// ---------------------------------------------------------------------------
// A point in the design
// ---------------------------------------------------------------------------

export interface PointSpec {
  /** Which figure this point feeds. */
  figure: string;
  /** The axis under test. Everything else is held at the base condition. */
  axis: string;
  /** Series within the figure — the thing held that distinguishes two curves. */
  series: string;
  /** X-axis label for this level. */
  level: string;
  /** Numeric x for plotting. */
  x: number;
  cameraCount: number;
  resX: number;
  resY: number;
  /** PARAMETERS.md §8 item 1's instrument, as a one-sigma. */
  floorSigmaM: number;
  /** How many floor references were taken. 0 = §8 item 1 not carried out. */
  floorReferenceCount: number;
  degradation: DegradationSpec;
  /** Cap on correspondences kept per (camera, projector) pair. */
  maxCorrespondencesPerPair: number;
  /** Replicates. Thinned only where wall clock forced it; see {@link CUTS}. */
  seedCount: number;
  /** Rough per-seed cost, seconds, from the timing probe. For budgeting only. */
  estimateSec: number;
}

/** A stable key for one (point, seed) pair, used to resume a partial run. */
export function pointKey(spec: PointSpec, seedIndex: number): string {
  return `${spec.figure}|${spec.series}|${spec.level}|${seedIndex}`;
}

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/**
 * Seconds per seed, calibrated against the timing probe on this box.
 *
 * Capture is `cameras x projectors x frames x pixels` and dominates. The three
 * terms are separated because they were measured separately and they differ by
 * an order of magnitude: a noiseless static capture costs about 0.4 s per camera
 * at 320x240, adding the sensor model costs another 0.9, and handheld motion
 * costs another 2.1 because the geometry pass is rebuilt for every frame instead
 * of once for the sequence. Getting that last term wrong is how a budget says
 * ninety minutes and a run takes three hours.
 *
 * Used only to print a budget before a run — nothing downstream depends on it.
 */
export function estimateSeconds(
  cameraCount: number,
  resX: number,
  resY: number,
  maxCorr: number,
  degradation: DegradationSpec,
): number {
  const perCamera =
    0.4 + (degradation.sensorNoise ? 0.9 : 0) + (degradation.motion ? 2.1 : 0);
  const pixelRatio = (resX * resY) / (320 * 240);
  const capture = cameraCount * perCamera * pixelRatio;
  // The solve grows with the number of correspondences actually kept, which the
  // cap bounds; ~4.5 s at 12 pairs x 1500.
  const solve = 1.5 + (3.0 * Math.min(cameraCount * 4, 24) * maxCorr) / (12 * 1500);
  const metrics = 1.2;
  return capture + solve + metrics;
}

// ---------------------------------------------------------------------------
// The design
// ---------------------------------------------------------------------------

/** Camera resolutions, long side first. The last is a real phone's main camera. */
export const RESOLUTIONS: { label: string; resX: number; resY: number }[] = [
  { label: '320x240', resX: 320, resY: 240 },
  { label: '640x480', resX: 640, resY: 480 },
  { label: '1280x960', resX: 1280, resY: 960 },
  { label: '2560x1920', resX: 2560, resY: 1920 },
  { label: '4032x3024', resX: 4032, resY: 3024 },
];

/**
 * Floor-reference instruments, as one-sigma height errors.
 *
 * 3 mm is what a tape measure justifies and is what PARAMETERS.md §8 item 1
 * currently prescribes; 1 mm is a hand-held laser distance meter; 0.1 mm is a
 * survey instrument. A-16 proposed the middle one as the cheapest available
 * improvement and A-18 corrected its importance without disputing its cost.
 */
export const FLOOR_SIGMAS: { label: string; sigmaM: number; instrument: string }[] = [
  { label: '0.1 mm', sigmaM: 0.0001, instrument: 'survey instrument / total station' },
  { label: '1 mm', sigmaM: 0.001, instrument: 'hand-held laser distance meter' },
  { label: '3 mm', sigmaM: 0.003, instrument: 'tape measure — PARAMETERS.md §8 item 1' },
];

/**
 * The degradation conditions, in the order they are plotted.
 *
 * `none` is the reference every other row is measured against. `rolling-shutter`
 * is included precisely because it is expected to be a no-op: reporting a
 * measured zero is a result, and omitting the row would leave the brief's third
 * named condition unanswered.
 */
export const DEGRADATION_CONDITIONS: { label: string; spec: DegradationSpec; note: string }[] = [
  {
    label: 'none',
    spec: { ambient: 0, sensorNoise: false, motion: false, rollingShutter: false },
    note: 'Reference. Noiseless sensor, dark room, static camera, global shutter.',
  },
  {
    label: 'ambient 0.04',
    spec: { ambient: NOMINAL_AMBIENT, sensorNoise: false, motion: false, rollingShutter: false },
    note: 'PARAMETERS.md §5 nominal E_amb, everything else off.',
  },
  {
    label: 'ambient 0.15',
    spec: { ambient: HIGH_AMBIENT, sensorNoise: false, motion: false, rollingShutter: false },
    note: 'Top of §5\'s stated range, everything else off.',
  },
  {
    label: 'sensor noise',
    spec: { ambient: 0, sensorNoise: true, motion: false, rollingShutter: false },
    note: 'Shot + read noise, saturation, 12-bit ADC. Dark room, static camera.',
  },
  {
    label: 'rolling shutter',
    spec: { ambient: 0, sensorNoise: false, motion: false, rollingShutter: true },
    note: 'Row-by-row readout with a STATIC camera. Provably a no-op; measured anyway.',
  },
  {
    label: 'motion, global shutter',
    spec: { ambient: 0, sensorNoise: false, motion: true, rollingShutter: false },
    note: 'Handheld tremor/sway/drift with a global shutter: the inter-frame half alone.',
  },
  {
    label: 'motion + rolling',
    spec: { ambient: 0, sensorNoise: false, motion: true, rollingShutter: true },
    note: 'Both halves. The difference from the row above is the shutter\'s own cost.',
  },
  {
    label: 'all',
    spec: { ambient: HIGH_AMBIENT, sensorNoise: true, motion: true, rollingShutter: true },
    note: 'Everything at once. Compared against the quadrature sum of the rows above.',
  },
];

const DEFAULT_CAP = 1500;

/**
 * Build the full list of points.
 *
 * `seedScale` thins every replicate count by the same factor for a smoke run.
 * It is not a knob for the real measurement — the published run uses 1.
 */
export function buildDesign(seedScale = 1): PointSpec[] {
  const out: PointSpec[] = [];
  const seeds = (n: number): number => Math.max(1, Math.round(n * seedScale));
  const push = (p: Omit<PointSpec, 'estimateSec'>): void => {
    out.push({
      ...p,
      estimateSec: estimateSeconds(
        p.cameraCount,
        p.resX,
        p.resY,
        p.maxCorrespondencesPerPair,
        p.degradation,
      ),
    });
  };

  // --- Axis 1: camera count, 1..8, at the corpus's own operating point -------
  // 320x240 because that is where every scenario in `bench-results.json` runs
  // (A-18's third criticism of A-16 was measuring at an operating point the
  // corpus does not use), and because the count sweep is the axis the brief
  // names, so it gets the most seeds.
  for (const [seriesLabel, spec] of [
    ['tripod', TRIPOD],
    ['handheld', HANDHELD],
  ] as [string, DegradationSpec][]) {
    for (let n = 1; n <= 8; n++) {
      push({
        figure: 'camera-count',
        axis: 'camera-count',
        series: seriesLabel,
        level: String(n),
        x: n,
        cameraCount: n,
        resX: 320,
        resY: 240,
        floorSigmaM: 0.003,
        floorReferenceCount: 4,
        degradation: spec,
        maxCorrespondencesPerPair: DEFAULT_CAP,
        seedCount: seeds(DEFAULT_SEED_COUNT),
      });
    }
  }

  // --- Axis 2: camera resolution -------------------------------------------
  // Three cameras throughout, because axis 1 answers what the count buys and
  // holding it fixed is what makes this axis about the sensor. Both conditions,
  // because "does a phone suffice" is a question about a phone — which is a
  // high-resolution sensor attached to a hand, not to a tripod. Replicates thin
  // at the top end; see CUTS.
  for (const [seriesLabel, spec] of [
    ['tripod', TRIPOD],
    ['handheld', HANDHELD],
  ] as [string, DegradationSpec][]) {
    for (const r of RESOLUTIONS) {
      const px = r.resX * r.resY;
      let n = DEFAULT_SEED_COUNT;
      if (px >= 2560 * 1920) n = 2;
      else if (px >= 1280 * 960) n = 3;
      // The 4032x3024 phone point is a single seed in the tripod condition only.
      if (px >= 4032 * 3024) {
        if (seriesLabel !== 'tripod') continue;
        n = 1;
      }
      push({
        figure: 'resolution',
        axis: 'resolution',
        series: seriesLabel,
        level: r.label,
        x: r.resX,
        cameraCount: 3,
        resX: r.resX,
        resY: r.resY,
        floorSigmaM: 0.003,
        floorReferenceCount: 4,
        degradation: spec,
        maxCorrespondencesPerPair: DEFAULT_CAP,
        seedCount: seeds(n),
      });
    }
  }

  // --- Axis 2b: the correspondence-cap control ------------------------------
  // The resolution axis holds `maxCorrespondencesPerPair` fixed, so it measures
  // per-correspondence PRECISION rather than correspondence COUNT. A-12 step 2
  // measured that this is the right thing to hold — twelve times fewer points on
  // a finer sensor scored the same — but that was one scenario on one seed, and
  // an experiment that inherits a claim without re-checking it is quoting, not
  // measuring. Two points, same rig and same seeds, cap raised 6x.
  for (const cap of [DEFAULT_CAP, 9000]) {
    push({
      figure: 'cap-control',
      axis: 'correspondence-cap',
      series: 'tripod',
      level: cap === DEFAULT_CAP ? '1500/pair' : '9000/pair',
      x: cap,
      cameraCount: 3,
      resX: 1280,
      resY: 960,
      floorSigmaM: 0.003,
      floorReferenceCount: 4,
      degradation: TRIPOD,
      maxCorrespondencesPerPair: cap,
      seedCount: seeds(3),
    });
  }

  // --- Axis 3: floor-reference instrument -----------------------------------
  // Run at TWO camera resolutions on purpose. A-16 measured the tape term and
  // the sensor term separately and found they add in quadrature; that prediction
  // only has teeth if the tape axis is measured where the sensor term is large
  // (320x240) and where it is small (640x480), so the two curves have to
  // converge at the fine end and separate at the coarse one.
  for (const [seriesLabel, resX, resY] of [
    ['320x240', 320, 240],
    ['640x480', 640, 480],
  ] as [string, number, number][]) {
    for (const f of FLOOR_SIGMAS) {
      push({
        figure: 'floor-sigma',
        axis: 'floor-sigma',
        series: seriesLabel,
        level: f.label,
        x: f.sigmaM * 1000,
        cameraCount: 3,
        resX,
        resY,
        floorSigmaM: f.sigmaM,
        floorReferenceCount: 4,
        degradation: TRIPOD,
        maxCorrespondencesPerPair: DEFAULT_CAP,
        seedCount: seeds(DEFAULT_SEED_COUNT),
      });
    }
    // §8 item 1 not carried out at all. Plotted separately rather than as a
    // point on the sigma axis, because "no measurement" is not "a measurement
    // with a large sigma": the solver holds `h_center` at its documented value
    // instead of solving it, which is a different estimator, not a noisier one.
    push({
      figure: 'floor-sigma',
      axis: 'floor-sigma',
      series: `${seriesLabel} (no reference)`,
      level: 'none',
      x: 0,
      cameraCount: 3,
      resX,
      resY,
      floorSigmaM: 0.003,
      floorReferenceCount: 0,
      degradation: TRIPOD,
      maxCorrespondencesPerPair: DEFAULT_CAP,
      seedCount: seeds(DEFAULT_SEED_COUNT),
    });
  }

  // --- Axis 4: degradation conditions, each separately switchable -----------
  // At 640x480 and three cameras. 640x480 rather than 320x240 because the point
  // of this axis is to separate the conditions from each other, and at 320x240
  // the decode quantisation is itself a large term that would sit under all of
  // them.
  for (const c of DEGRADATION_CONDITIONS) {
    push({
      figure: 'degradation',
      axis: 'degradation',
      series: 'single condition',
      level: c.label,
      x: DEGRADATION_CONDITIONS.findIndex((d) => d.label === c.label),
      cameraCount: 3,
      resX: 640,
      resY: 480,
      floorSigmaM: 0.003,
      floorReferenceCount: 4,
      degradation: c.spec,
      maxCorrespondencesPerPair: DEFAULT_CAP,
      seedCount: seeds(DEFAULT_SEED_COUNT),
    });
  }

  return out;
}

/**
 * What this design does NOT cover, and what each omission costs.
 *
 * Written into the results file and into docs/EXPERIMENT-1.md verbatim. Silent
 * truncation reads as "we covered everything" when it did not.
 */
export const CUTS: { what: string; why: string; costsTheConclusion: string }[] = [
  {
    what: 'The 4032x3024 phone point runs at ONE seed, tripod only.',
    why: 'About 12 minutes per solve on this box, and the handheld arm would have doubled it. Two points would have cost 24 minutes for one bit of dispersion.',
    costsTheConclusion:
      'No dispersion at the top resolution. The conclusion about phones therefore rests on the 2560x1920 point (2 seeds) and the trend below it, with 4032x3024 as a single confirming draw rather than a measured mean.',
  },
  {
    what: '2560x1920 runs at 2 seeds and 1280x960 at 3, against 5 everywhere cheap.',
    why: 'Capture cost is quadratic in the linear resolution: one 3-camera point is ~5 min at 2560x1920 against ~9 s at 320x240.',
    costsTheConclusion:
      'The dispersion estimate at the two finest resolutions is weak. Where the finding quotes a spread at those points it quotes the observed range and says n.',
  },
  {
    what: 'The resolution axis holds the correspondence cap at 1500 per (camera, projector) pair.',
    why: 'Uncapping it makes the solve cost grow with the sensor and turns one axis into two.',
    costsTheConclusion:
      'The resolution axis measures per-correspondence PRECISION, not correspondence COUNT. The `cap-control` figure measures the difference directly rather than inheriting A-12\'s claim about it.',
  },
  {
    what: 'Camera count is swept at 320x240 only.',
    why: 'The count axis is 36 camera-units per condition per seed; at 640x480 the sweep alone would have been about an hour per condition.',
    costsTheConclusion:
      'The count sweep is measured at the corpus operating point, which is coarser than a phone. The resolution axis covers the other direction, but the CROSS — does a fourth photograph buy more at 4032x3024 than at 320x240 — is not measured.',
  },
  {
    what: 'Only the geometric half of the pipeline is scored.',
    why: 'PARAMETERS.md §10 and the ARCHITECTURE phase gate: every photometric constant is ASSUME or MEAS, so a photometric number here would be a statement about an unmeasured constant.',
    costsTheConclusion:
      'Nothing. Experiment 1 is purely geometric by design and its outputs carry no PROVISIONAL marking.',
  },
  {
    what: 'Projector count is held at 4 and the rig at PARAMETERS.md §2 nominal.',
    why: 'The bench corpus already covers N=2 and N=3 (archetypes 7 and 8) and A-10 records what they do to the unlit gate.',
    costsTheConclusion:
      'The answer to "how many photos" is stated for a four-projector install. A three-projector install has fewer parameters and one fewer seam; the count answer there is not measured.',
  },
];

/**
 * The preset the experiment runs the bench pipeline at.
 *
 * `scenarioCount` and `cameraResX/Y` are inert — every point overrides the
 * camera on the scenario itself — but `BenchPreset` is the bench's own
 * interface and is passed through unchanged rather than reimplemented, so that
 * this experiment measures the same pipeline `bench-results.json` scores.
 *
 * `metricConvergence` is off: it is roughly a 40% cost on the metric pass and
 * it checks the metric's own sampling, which is not what this experiment varies.
 */
export function experimentPreset(maxCorrespondencesPerPair: number): BenchPreset {
  return {
    name: 'default',
    scenarioCount: 1,
    cameraResX: 320,
    cameraResY: 240,
    metricDensityScale: 1,
    metricConvergence: false,
    maxCorrespondencesPerPair,
    minCameraPixelsPerStride: 4,
    attributeFailures: false,
    renderSize: 256,
  };
}
