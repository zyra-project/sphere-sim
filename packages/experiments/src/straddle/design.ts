// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 10 — what a photograph taken across a pattern change costs a
 * calibration, with today's page.
 *
 * EXPERIMENT-9 counted how often the shutter is open while the emitter changes
 * pattern — 728 of 2,000 simulated captures at the page's defaults — and said in
 * as many words that it could not say what one costs: "nothing in this
 * experiment renders a frame or decodes one." This experiment renders them,
 * through the bench's own renderer, and hands them to the page's own reader.
 * It asks three things of each straddle, and asks each on purpose rather than
 * assuming the answer: does the photograph decode correctly anyway; is the run
 * refused loudly, and at what smear; or does it pass and decode wrong, silently,
 * and by how much.
 *
 * ## Every constant says where it came from
 *
 * The rule this file follows is the one EXPERIMENT-9's design learned the hard
 * way: a constant that looked like a total was carrying an assumption, and the
 * assumption was false. So nothing below is a bare literal where the code can
 * supply it. The plan, the step list, the fingerprint grid, the manifest, the
 * gates and the thresholds are all read from the modules that define them, and
 * the counts this experiment inherits from EXPERIMENT-9 are checked against
 * EXPERIMENT-9's own literals when this module loads (see the end of the file).
 * A drift between the two experiments therefore stops the run at import rather
 * than re-scoring captures that do not add up to the figures it cites.
 *
 * The literals that remain are of two kinds, and each says which: choices of
 * this design (smear grids, sample sizes, budgets), and ASSUME-class physical
 * guesses (a 60 Hz display, an electronic-shutter readout, a gain repeatability,
 * a tone curve). The second kind is swept or reported as a sensitivity, never
 * quoted as a result.
 *
 * ## What this file does NOT establish
 *
 * Nothing here is measured. These are the inputs of a design, and several were
 * probed at design time (the crossings of 7-16%, the Gray onset at 3/7, the
 * headless emitter lateness of 7.5 ms per step). The experiment re-measures the
 * crossings and the Gray onsets and reports what it finds, including where it
 * disagrees. It does NOT re-measure the emitter's lateness. 7.5 ms per step is
 * a design-time figure from a headless, software-rendered browser
 * ({@link HEADLESS_LATENESS_MS} says where it came from). The lateness stage
 * sweeps around it and renders at it; it never measures it. The spec's P0
 * (`tools/emitter-timing.ts`), which would have measured it, was never built.
 * An earlier version of this paragraph said the experiment re-measured every
 * input, 7.5 ms included, and the first full run's verification caught it.
 */

import { deriveSeed } from '../../../bench/src/random.ts';
import { DEFAULT_CLOCK } from '../../../bench/src/camera.ts';
import { DEFAULT_ROOM_SPILL, DEFAULT_SENSOR } from '../../../bench/src/capture.ts';
import {
  DEFAULT_PATTERN_PLAN,
  complementPlan,
  planFrames,
  strideFor,
} from '../../../bench/src/patterns.ts';
import { ARCHETYPE_NAMES, PRESETS, makeScenario } from '../../../bench/src/scenarios.ts';
import { GATES } from '../../../calibration/src/parameters.ts';
import { gateById } from '../../../sim/src/metrics/types.ts';
import { DEFAULT_DECODE_OPTIONS } from '../../../solver/src/decode.ts';
import type { Transfer } from '../../../solver/src/ingest.ts';
import { COMPLEMENT_LIMIT, type FrameKind } from '../../../solver/src/indexing.ts';
import { emitOrder } from '../../../web/src/emit.ts';
import { captureManifest, manifestExpectedSequence } from '../../../web/src/manifest.ts';
import {
  ARMS as EXP9_ARMS,
  DEFAULT_DWELL_S as EXP9_DEFAULT_DWELL_S,
  EXPERIMENT_ROOT_SEED as EXP9_ROOT_SEED,
  EXPOSURE_S as EXP9_EXPOSURE_S,
  EXPOSURES_S as EXP9_EXPOSURES_S,
  FRAMES_PER_POSITION as EXP9_FRAMES_PER_POSITION,
  FRAMES_PER_RUN as EXP9_FRAMES_PER_RUN,
  POSITIONS as EXP9_POSITIONS,
  REACTION_S as EXP9_REACTION_S,
  START_PHASES as EXP9_START_PHASES,
  TRIALS as EXP9_TRIALS,
  type Arm,
  type StartPhase,
} from '../tether/design.ts';

// ---------------------------------------------------------------------------
// Scenes and rigs, first, because the plan's raster is read from one
// ---------------------------------------------------------------------------

/**
 * The corpus root the bench's own CI run uses (`package.json`, `ci`:
 * `--seed 1234`). Index 1 under it is `s01-nominal`, the published nominal rig,
 * so rig 0 of this experiment is a rig the bench has already reported on.
 */
export const SCENE_ROOT_SEED = 1234;

/**
 * Rigs in the sweep.
 *
 * Enough clusters for a bootstrap that resamples RIGS rather than runs, which
 * is the resampling unit the confidence intervals need: every run of a rig
 * shares its cameras, its projectors and its placement, so runs are not
 * independent draws and resampling them would understate the interval. A
 * noiseless bank costs about two seconds a rig at the default preset.
 */
export const RIGS = 24;

/**
 * The scenario index of rig `k`: the `nominal` archetype of cycle `k`.
 *
 * `makeScenario` takes the archetype from `index % 13` and enters the cycle
 * into the seed, so `1 + 13k` is a fresh nominal rig for every `k` — a tripod,
 * no handheld motion, the §5 nominal ambient and a real sensor — rather than
 * the same rig 24 times. Checked below against `ARCHETYPE_NAMES`, so an
 * archetype inserted into the corpus fails here instead of quietly turning
 * this sweep into a sweep of some other archetype.
 */
export function sceneIndex(k: number): number {
  return 1 + ARCHETYPE_NAMES.length * k;
}

/**
 * The scenario rig 0 is built from, read once so the raster, the projector
 * count and the camera count below come from the scenario rather than from a
 * number written beside it.
 */
const REFERENCE_SCENARIO = makeScenario(SCENE_ROOT_SEED, sceneIndex(0), PRESETS.default);

/** Projectors in the rig, which is also the number of runs in one camera position. */
export const PROJECTORS = REFERENCE_SCENARIO.projectorCount;

/** Camera positions per capture: the rig's own camera count. */
export const CAMERAS = REFERENCE_SCENARIO.cameras.count;

/**
 * How far the camera set turns before the arrangement repeats, degrees.
 *
 * Three cameras 120 degrees apart against four projectors 90 degrees apart
 * repeat every gcd(120, 90) = 30 degrees. Derived rather than written, because
 * it is what makes `[0, 30)` cover every arrangement, and a rig with another
 * count would need another period.
 */
export const CAMERA_SET_PERIOD_DEG = (() => {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return gcd(360 / CAMERAS, 360 / PROJECTORS);
})();

/**
 * How far rig `k`'s camera set is turned about the sphere's axis, degrees.
 *
 * `CAMERA_SET_PERIOD_DEG / RIGS` apart, so across the sweep a camera's azimuth
 * modulo 90 degrees is covered uniformly at 1.25 degrees. Rig 0 is the bench's
 * own placement, which is s01 exactly. The offset only turns the set
 * (`camera.ts`, `azimuthOffsetDeg`): heights, distances and every jitter draw
 * are the scenario's own.
 *
 * Why it is a variable at all: `placeCameras` puts the three cameras at 55.7,
 * 175.7 and 295.7 degrees plus N(0, 2) — camera 1 is 4.3 degrees off P3's
 * axis, which contradicts `docs/CALIBRATE.md`'s "deliberately offset from
 * both". What a straddle costs depends on which projectors a camera sees and
 * how obliquely, so one placement would be one answer.
 */
export function azimuthOffsetDeg(k: number): number {
  return (CAMERA_SET_PERIOD_DEG / RIGS) * k;
}

/** Every third rig: eight camera sets turned 0 to 26.25 degrees, for the dose-response arms. */
export const DESIGNED_RIGS: readonly number[] = Array.from({ length: RIGS / 3 }, (_, i) => 3 * i);

/**
 * Which camera of designed rig `k` is straddled in the pose arms: (k/3) mod 3,
 * so the eight designed rigs straddle each camera position in turn.
 */
export function straddledCamera(k: number): number {
  if (!DESIGNED_RIGS.includes(k)) {
    throw new Error(`straddle: rig ${k} is not a designed rig (${DESIGNED_RIGS.join(', ')})`);
  }
  return (k / 3) % CAMERAS;
}

/**
 * The designed rigs again, with the room turned on: `DEFAULT_ROOM_SPILL`.
 *
 * This is how the experiment asks whether an invisible run's refusal is a
 * `roomSpill: null` artefact. With the room off, a pixel no projector reaches
 * is one constant and its modulation is exactly zero; with the room on, the
 * wall behind the sphere carries the pattern.
 */
export const SPILL_RIGS: readonly number[] = DESIGNED_RIGS;
export const SPILL_ROOM = DEFAULT_ROOM_SPILL;

/** Rigs rendered again at `PRESETS.thorough` (640x480), to bound what 320x240 costs the gate. */
export const THOROUGH_RIGS: readonly number[] = [0, 6, 12, 18];

/**
 * This experiment's own root, new. Every draw it makes that EXPERIMENT-9 did
 * not make is named off it by a label (see the seed functions below), so
 * adding an arm cannot shift the draws of another.
 */
export const EXP10_ROOT_SEED = 0x10ad5eed;

/** The capture seed of re-shoot `i` of rig `k`, for the null distribution of D_grid. */
export function nullSeed(k: number, i: number): number {
  return deriveSeed(EXP10_ROOT_SEED, `exp10/null/${k}/${i}`);
}
/** The gain-jitter draws of run (rig `k`, camera `c`, draw `d`). */
export function gainSeed(k: number, c: number, d: number): number {
  return deriveSeed(EXP10_ROOT_SEED, `exp10/gain/${k}/${c}/${d}`);
}
/** The display-refresh waits of trial `t` in cell `cell`. */
export function vsyncSeed(cell: string, t: number): number {
  return deriveSeed(EXP10_ROOT_SEED, `exp10/vsync/${cell}/${t}`);
}
/** Which runs a cell's decode or solve subsample takes. */
export function subsampleSeed(cell: string): number {
  return deriveSeed(EXP10_ROOT_SEED, `exp10/subsample/${cell}`);
}

// ---------------------------------------------------------------------------
// Plan and page
// ---------------------------------------------------------------------------

/**
 * The plan the page plays: `DEFAULT_PATTERN_PLAN`, 6 Gray bits, 4 phase steps,
 * 2 strides per period, white and black.
 *
 * Forced through `RunOptions.plan` wherever this experiment solves, because
 * `planPatternFor` derives 7 bits for s01 and the page does not offer that
 * choice: its `readPlan` exposes only bits and steps (`web/web/emit.ts`), and
 * what a straddle costs depends on the sequence the page actually shows.
 */
export const PLAN = DEFAULT_PATTERN_PLAN;

/** Frames in one projector's run: `planFrames(PLAN).length`, 34. */
export const FRAMES_PER_RUN = planFrames(PLAN).length;

/**
 * Every step the page shows, projector-major: step `k` lights projector
 * `STEPS[k].projector` with frame `STEPS[k].frame` and nothing else.
 *
 * The page's own `emitOrder`, not a loop written here, because this is the
 * order the emitter plays and a second statement of it is the thing that
 * drifts.
 */
export const STEPS = emitOrder(PROJECTORS, PLAN);

/** Blocks per axis of a fingerprint: `complementPlan(PLAN).minBlocks`, 64 — the page's own choice. */
export const FINGERPRINT_BLOCKS = complementPlan(PLAN).minBlocks;

/**
 * The projector raster the patterns address, from the scenario that builds the
 * rig (1920x1080 for every scenario this sweep builds).
 */
export const PROJECTOR_RES = {
  x: REFERENCE_SCENARIO.projectorResX,
  y: REFERENCE_SCENARIO.projectorResY,
} as const;

/**
 * One fringe period per axis, projector pixels: the Gray stride times
 * `phasePeriodStrides`, as `capture.ts` builds the phase sequences. 60 px
 * across and 33.75 px down at 1920x1080.
 */
export const PERIOD_PX = {
  u: strideFor(PROJECTOR_RES.x, PLAN.grayBits) * PLAN.phasePeriodStrides,
  v: strideFor(PROJECTOR_RES.y, PLAN.grayBits) * PLAN.phasePeriodStrides,
} as const;

/** The dwell the page defaults to and EXPERIMENT-9 headlines, seconds. */
export const DWELL_S = EXP9_DEFAULT_DWELL_S;
/** The exposure EXPERIMENT-9's headline is quoted at, seconds. */
export const EXPOSURE_S = EXP9_EXPOSURE_S;

/**
 * The capture plan file the page would have written for this rig, with no
 * timestamp: `written` is for telling two captures apart, and a timestamp here
 * would make the experiment's output differ run to run.
 */
export const MANIFEST = captureManifest(PLAN, PROJECTOR_RES, PROJECTORS, DWELL_S, '');

/**
 * What the page's indexer expects a camera position to hold: the manifest's
 * own `manifestExpectedSequence`, which is the join the page makes between the
 * emitter's plan and the solver's indexer.
 */
export const EXPECTED = manifestExpectedSequence(MANIFEST);

/**
 * The transfer the page reads photographs with. Not importable — the page's
 * `canvasTransfer()` lives in the DOM half, `web/web/emit.ts` — so it is
 * written here with that as its provenance: `drawImage` hands `getImageData`
 * sRGB-encoded bytes whatever the file held.
 */
export const TRANSFER: Transfer = { kind: 'srgb' };

/**
 * Full scale of the 8-bit encode: the sensor's own saturation, 1.4. Nothing
 * clips: the brightest noiseless white is 0.93 on the sphere, and 1.14 on the
 * wall of a spill rig, where the room carries the pattern (measured over every
 * rig of both variants). The 12-bit levels the sensor quantises to map onto
 * the encode exactly.
 */
export const ENCODE_FULL_SCALE = DEFAULT_SENSOR.saturationRadiance;

/**
 * The lit fractions EXPERIMENT-8 supplies as exact observations
 * (`indexing/run.ts`, `cleanCapture`): a white frame lights all of a crescent,
 * a black frame none, a patterned frame half. The page's dark after its last
 * step is a black frame.
 */
export const ORACLE_LIT: Readonly<Record<FrameKind, number>> = { white: 1, black: 0, patterned: 0.5 };

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * EXPERIMENT-9's arms, start phases, reaction time, seeds and trial count,
 * REPLAYED rather than re-chosen. EXPERIMENT-10 re-scores the photographs
 * EXPERIMENT-9 counted, so every one of these is theirs.
 */
export const ARMS: readonly Arm[] = EXP9_ARMS;
export const START_PHASES: readonly StartPhase[] = EXP9_START_PHASES;
export const REACTION_S = EXP9_REACTION_S;
export const EXP9_SEED_ROOT = EXP9_ROOT_SEED;
export const TRIALS = EXP9_TRIALS;
export const POSITIONS = EXP9_POSITIONS;

/**
 * The seed of EXPERIMENT-9's trial `t` in one cell.
 *
 * This is the expression inside tether's `summarise` (`tether/run.ts`), which
 * is not exported, so it is necessarily written a second time here — the one
 * copy in this experiment. It is held to the original twice: the R audit
 * re-derives every committed EXPERIMENT-9 cell from `shotTimings` under these
 * seeds and requires field-for-field equality, and `straddle.test.ts` requires
 * the same of the first 50 headline trials. A copy that drifted would fail
 * both rather than re-score captures EXPERIMENT-9 never drew.
 */
export function exp9TrialSeed(arm: Arm, phase: StartPhase, dwellS: number, exposureS: number, t: number): number {
  return deriveSeed(EXP9_SEED_ROOT, `${arm.key}:${phase}:${dwellS}:${exposureS}:${t}`);
}

/**
 * The emitter's lateness per step, as far as anybody has measured it, ms. NOT
 * measured by this experiment, and not on a display machine.
 *
 *   - `hudTickOff`: the mean of a design-time probe (`wf/design/lateness.mjs`)
 *     in headless Chromium on SwiftShader's software GL, a 3840x2160 canvas,
 *     the page in HUD mode with its tick off. Median 6.5-6.6, p90 8.3.
 *   - `armedTickOn`: about what the same setup ran, armed with the tick on,
 *     when the first full run's verification re-ran it. A verification figure,
 *     not a design one, quoted beside the design figure because armed with the
 *     tick on is the page as an operator runs it, and it runs later still.
 *   - `pureJsLowerBound`: the script's own share at 1920x1080 quadrants, with
 *     no paint (physics review `delta.ts`: 1.3-2.5 ms).
 *
 * The spec's P0 (`tools/emitter-timing.ts`, writing
 * `experiments/emitter-timing.json`) would measure the first two on the
 * machine it runs on, and was never built. So these are inputs the lateness
 * stage sweeps around and renders at, and every sentence that quotes 7.5 ms
 * says where it came from.
 */
export const HEADLESS_LATENESS_MS = { hudTickOff: 7.5, armedTickOn: 9.3, pureJsLowerBound: 2 } as const;

/**
 * Emitter lateness swept on timing alone, ms per step.
 *
 * `advance()` re-arms its timer only after painting the next frame, so each
 * step runs late and the lateness accumulates. These bracket the derived
 * threshold at which the card's aimed start stops protecting (0.5 s over 135
 * steps, about 3.7 ms with matched clocks and 3.5 ms with the camera's clock
 * 100 ppm fast) and the design-time headless figure.
 *
 * Every 0.05 ms from 3.40 to 4.00 as well. The first full run swept whole
 * milliseconds and could only say that 1% of aimed captures were touched
 * somewhere in (3, 4] ms: 0 of 2000 at 3, 235 at 4. A crossing the grid
 * brackets by a whole millisecond is not measured, and the aimed rule's margin
 * is the number the card would quote.
 */
export const LATE_MS_TIMING: readonly number[] = [
  0,
  1,
  2,
  3,
  ...Array.from({ length: 12 }, (_, i) => Number((3.4 + 0.05 * i).toFixed(2))),
  4,
  5,
  6,
  HEADLESS_LATENESS_MS.hudTickOff,
  10,
  15,
];

/**
 * Lateness rendered: the pure-JS lower bound at 1920x1080 quadrants, below the
 * aimed threshold, and the design-time headless figure. Neither is the display
 * machine's number; nobody has measured that ({@link HEADLESS_LATENESS_MS}).
 */
export const LATE_MS_RENDERED: readonly number[] = [
  HEADLESS_LATENESS_MS.pureJsLowerBound,
  HEADLESS_LATENESS_MS.hudTickOff,
];

/**
 * ASSUME: a 60 Hz display. A step's frame reaches the screen up to one refresh
 * after its timer fires, drawn per step as U(0, VSYNC_S) and NOT carried to the
 * next step, because the timer is re-armed before presentation.
 */
export const VSYNC_S = 1 / 60;

/**
 * Sensor readout from the first row to the last, seconds, as a fraction of the
 * exposure 0, 0.12 and 0.30. 0 is a global shutter, EXPERIMENT-9's model; 30 ms
 * is the bench's own `DEFAULT_CLOCK.readoutMs`; 75 ms is ASSUME, the upper end
 * of electronic-shutter readouts.
 */
export const READOUT_S: readonly number[] = [0, DEFAULT_CLOCK.readoutMs / 1000, 0.075];

/** The short exposure EXPERIMENT-9 sweeps, 1/60 s, where the readout outlasts the exposure. */
export const SHORT_EXPOSURE_S = EXP9_EXPOSURES_S[0];

// ---------------------------------------------------------------------------
// Smear grids
// ---------------------------------------------------------------------------

/**
 * How a run's crossing is located: scan the smear at `step` from `step` to
 * `max`, then bisect the first refusing bracket until it is `resolution` wide.
 * The design-time crossings were 7-16% and the Gray planes start to misread at
 * 3/7, so the scan covers both with room.
 */
export const GATE_SCAN = { step: 0.005, max: 0.5, resolution: 0.0005 } as const;

/** Smears confirmed with noise on, dense around the design-time crossings. */
export const NOISY_LEVELS: readonly number[] = [0, 0.03, 0.06, 0.09, 0.12, 0.15, 0.2, 0.3];

/** Single-frame smears: PR #46's 15%, and "about a third". */
export const SINGLE_LEVELS: readonly number[] = [0.05, 0.1, 0.15, 0.3];

/**
 * Smears decoded. Noiseless across both Gray onsets — 3/7 = 0.4286, where the
 * MSB-dark half starts to read ambiguous, and 0.5 — and noisy below them.
 */
export const DECODE_LEVELS = {
  noiseless: [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.43, 0.45, 0.5],
  noisy: [0.02, 0.05, 0.1, 0.15],
} as const;

/**
 * Smears solved. Below, inside and up to the top of the crossing band, which
 * answers the falsification critique that an earlier draft stopped at 0.10;
 * and a rolling shutter at readout/exposure 0.30 at two mid-row smears.
 */
export const POSE_LEVELS = {
  forward: [0.03, 0.06, 0.09, 0.12, 0.15],
  backward: [0.03, 0.06, 0.09, 0.12],
  rolling: { readoutOverExposure: 0.3, midRow: [0.06, 0.12] },
} as const;

// ---------------------------------------------------------------------------
// Thresholds and subsamples
// ---------------------------------------------------------------------------

/** Re-shoots per designed rig for the null distribution of D_grid. The falsification critique asked for at least 10. */
export const K_NULL = 10;

/**
 * A twin run placed with its worst pair residual above this is MARGINAL: within
 * `MARGINAL_BAND` of `COMPLEMENT_LIMIT`, so noise alone could flip it. Derived
 * from the limit rather than written, so the band moves if the limit does;
 * rounded to 12 places so the file reports 0.1 rather than the
 * 0.09999999999999999 that `0.15 - 0.05` is in binary.
 */
export const MARGINAL_BAND = 0.05;
export const MARGINAL_RESIDUAL = Number((COMPLEMENT_LIMIT - MARGINAL_BAND).toFixed(12));

/**
 * A run with fewer clean page-path correspondences than this is MINOR. Probed:
 * invisible runs decode 0-126, visible ones 1,331-41,190, and the bound sits in
 * the gap.
 */
export const MINOR_RUN_CORR = 200;

/** Half-width added around the limit when deciding which noiseless runs to re-evaluate with noise. */
export const REFINE_MARGIN = 0.01;

/** ASSUME: per-frame gain repeatability, the standard deviation of a photograph's overall scale. */
export const GAIN_JITTER: readonly number[] = [0.005, 0.01, 0.02];

/**
 * ASSUME: a mild picture-style S-curve applied to the ENCODED value before it
 * is quantised, `e' = (1 - kappa)·e + kappa·(3e² - 2e³)`. It is deliberately
 * NOT the transfer the page undoes, which is the point of the case.
 */
export const TONE_CURVE = { kappa: 0.3 } as const;

/**
 * A decoded coordinate this far from its truth is a GROSS error, per axis: a
 * correct decode sits within half a stride, a quarter of a period, of its bin
 * (`decode.ts`'s unwrap tolerance argument).
 */
export const GROSS_PX = { u: PERIOD_PX.u / 4, v: PERIOD_PX.v / 4 } as const;

/** PARAMETERS.md §7's seam and rotation gates, read from the table rather than restated. */
export const GRID_GATE_MM = gateById(GATES, 'grid_displacement').max;
export const ROTATION_GATE_DEG = gateById(GATES, 'pose_rotation').max;

/** The decode a solve is handed: every pixel, capped as the default preset caps it. */
export const SOLVE_DECODE = {
  pixelStride: 1,
  maxCorrespondences: PRESETS.default.maxCorrespondencesPerPair,
} as const;

/** The decode the page's `readRun` performs: `decodeCapture` with its defaults. */
export const PAGE_DECODE = DEFAULT_DECODE_OPTIONS;

/** Budgets. */
export const HANDHELD_TRIALS = 500;
export const DECODE_SUBSAMPLE = 200;
export const SOLVE_SUBSAMPLE = 60;

/**
 * How far the 8-bit sRGB page path may move a residual or a phase bias from the
 * linear one before encoding is reported as mattering: about a tenth of the
 * smallest gap between crossings, and of the bias at s = 0.02.
 */
export const ENCODE_BOUNDS = { residual: 0.005, biasPx: 0.02 } as const;

// ---------------------------------------------------------------------------
// Registered before the re-run with the page's reader
// ---------------------------------------------------------------------------

/** A bet the assembly will hold the re-run to. */
export interface RerunPrediction {
  id: string;
  falsifiedIf: string;
  /** Falsified when what `falsifiedIf` counts exceeds this. */
  threshold: number;
  note?: string;
}

/** A check on the re-run's own harness, which must hold before any bet is read. */
export interface RerunIdentity {
  id: string;
  holds: string;
  /** What makes it exact rather than likely. */
  restsOn?: string;
}

/**
 * The bets on the re-run with the page's reader. These were registered before
 * the re-run's first page-column output existed, in the commit that introduced
 * them, and they are not to change after it.
 *
 * The page's reader was replaced after this experiment first ran. The reader
 * it has now places the clean positions the one it replaced refused, so a
 * re-run starts the rescoring's page column: every straddled camera position
 * handed whole to the page's own reader. These are the bets on what that
 * column shows, in the words `docs/EXPERIMENT-10.md` registers them in
 * ("Registered before the re-run with the page's reader", committed before any
 * of the code that measures them). They are held here, not in the assembly,
 * because every value this module exports is hashed into each checkpoint's
 * fingerprint and repeated in the document's `generatedFrom`: a bet edited
 * after the run would turn every checkpoint stale, and the document would
 * carry the edit. The assembly evaluates them once the run is over.
 *
 * Each is falsified when what its text counts exceeds its `threshold`. The
 * thresholds come from this document's own cells and from the new reader's
 * design, not from a look at the column. P6 is the first run's, word for word
 * as the assembly states it.
 */
export const RERUN_PREDICTIONS: readonly RerunPrediction[] = [
  {
    id: 'P10',
    falsifiedIf:
      'In every rescore and lateness cell, a run the page places files every photograph under ' +
      'the step that holds more than half that photograph\'s exposure. Falsified by any content ' +
      'misfile in a placed run, in any cell. Photographs with no majority step are counted apart ' +
      'and cannot falsify it.',
    threshold: 0,
  },
  {
    id: 'P11',
    falsifiedIf:
      'In R1 the page is SILENT on no more of the touched captures than the counterfactual reader ' +
      '(98 of 728). Falsified if the page\'s SILENT count in R1, attributed against the page twin, ' +
      'exceeds 98.',
    threshold: 98,
  },
  {
    id: 'P12',
    falsifiedIf:
      'A straddle never turns a run the page twin places into a note. Falsified by any touched ' +
      'run, in any cell, that the page twin places and the straddled position only notes as out ' +
      'of view or barely seen, with no problem naming it.',
    threshold: 0,
  },
  {
    id: 'P13',
    falsifiedIf:
      'Q0 (the renderer\'s photographs) and the page twin (the fast path\'s) read the same at ' +
      'every one of the 108 clean positions: placed, unseen and barely seen equal, and neither ' +
      'with a problem. Falsified by any position where they differ.',
    threshold: 0,
  },
  {
    id: 'P6',
    falsifiedIf:
      'Any of the default, spill or fine clean positions places at least one run (which ' +
      'triggers the page-column contingency).',
    threshold: 0,
    note:
      'Registered before the first run, against the reader the page had then, and kept word for ' +
      'word. The new reader falsifies it by construction, since it places clean positions, and ' +
      'that is what triggers the page column.',
  },
];

/**
 * The re-run's checks on its own harness, registered with
 * {@link RERUN_PREDICTIONS} and in the same commit. They are not bets: each
 * says the harness measured what it meant to, and each must hold before any
 * bet is read.
 */
export const RERUN_IDENTITIES: readonly RerunIdentity[] = [
  {
    id: 'I-page-twin',
    holds:
      'The page twin, the page\'s reading of each clean position through the fast path, equals ' +
      'experiments/reader-acceptance.json\'s positions[] at all 108 positions: placed, unseen and ' +
      'barelySeen equal, and no problems.',
    restsOn:
      'Its inputs are bit for bit the acceptance sweep\'s clean photographs: the same rig build ' +
      '(buildRig, as the bank stage calls it), the same noise (noisyRun under the rig\'s own seed, ' +
      'each pair its own stream), the same encode (encodeSrgb8 at ENCODE_FULL_SCALE), and the ' +
      'same summaries, ordinals and names (summarisePhoto), read by the same reader: indexing.ts ' +
      'unchanged since 32afdc4, the commit the sweep records, readback.ts\'s indexPhotographs and ' +
      'summarisePhoto unchanged since then, and linearise\'s code table held to the per-sample ' +
      'path it replaced, bit for bit.',
  },
  {
    id: 'I-replaced',
    holds:
      'Q0\'s replaced-reader verdict equals the Q0 of experiments/experiment-10.json as committed ' +
      'at 754147f, field by field: runsPlaced, problems text and reasons.',
    restsOn:
      'The replaced reader is readback.ts\'s indexPhotographs at 754147f, reproduced line for ' +
      'line in stages.ts, and it reads the same summaries: the render, the encode, ' +
      'summarisePhoto (linearise\'s code table included), litFractions and indexByFingerprint ' +
      'compute what they computed then, and indexByFingerprint does not read the phases the ' +
      'expected sequence has gained since.',
  },
  {
    id: 'H8-page',
    holds:
      'At every hook rig, camera and level, the page reads the hook\'s straddled frames and the ' +
      'fast path\'s the same: placed, unseen and barely seen equal, and as many problems.',
  },
];

// ---------------------------------------------------------------------------
// Checked at load
// ---------------------------------------------------------------------------

/**
 * The counts this experiment inherits, held to the literals EXPERIMENT-9 wrote.
 *
 * Thrown rather than logged. EXPERIMENT-10 re-scores EXPERIMENT-9's shots
 * photograph by photograph, filing shot `j` of a position as step `j`; if the
 * plan's run length or the page's step count stopped agreeing with the numbers
 * EXPERIMENT-9 counted in, the re-scoring would file photographs under steps
 * that do not exist, or leave steps with no photograph, and every downstream
 * count would be off by the difference with nothing saying so.
 */
function checkAtLoad(): void {
  const fail = (what: string): never => {
    throw new Error(`straddle/design: ${what}`);
  };
  if (FRAMES_PER_RUN !== EXP9_FRAMES_PER_RUN) {
    fail(`the plan has ${FRAMES_PER_RUN} frames per run and EXPERIMENT-9 counted ${EXP9_FRAMES_PER_RUN}`);
  }
  if (STEPS.length !== EXP9_FRAMES_PER_POSITION) {
    fail(`the page plays ${STEPS.length} steps per position and EXPERIMENT-9 counted ${EXP9_FRAMES_PER_POSITION}`);
  }
  if (PROJECTORS * FRAMES_PER_RUN !== STEPS.length) {
    fail(`${PROJECTORS} runs of ${FRAMES_PER_RUN} is not the page's ${STEPS.length} steps`);
  }
  if (MANIFEST.framesPerRun !== FRAMES_PER_RUN || EXPECTED.kinds.length !== FRAMES_PER_RUN) {
    fail('the manifest and the plan disagree about a run');
  }
  if (EXPECTED.complements.minBlocks !== FINGERPRINT_BLOCKS) {
    fail('the manifest and the plan disagree about the fingerprint grid');
  }
  if (ARCHETYPE_NAMES[sceneIndex(1) % ARCHETYPE_NAMES.length] !== 'nominal' || REFERENCE_SCENARIO.archetype !== 'nominal') {
    fail(`scene index ${sceneIndex(1)} is not the nominal archetype`);
  }
  if (REFERENCE_SCENARIO.degradation.handheld !== null) {
    fail('the nominal archetype is no longer a tripod, and every noise pairing here assumes one');
  }
  if (CAMERA_SET_PERIOD_DEG !== 30 || azimuthOffsetDeg(1) !== 1.25) {
    fail(`the camera set repeats every ${CAMERA_SET_PERIOD_DEG} degrees, not the 30 this design was built on`);
  }
  if (SHORT_EXPOSURE_S !== 1 / 60) fail(`EXPERIMENT-9's shortest exposure is ${SHORT_EXPOSURE_S}, not 1/60 s`);
  // The document reads the lateness grid as a bracket: the last value below a
  // crossing and the first at or above it. Out of order or repeated, the
  // bracket it names would not be the one swept.
  if (LATE_MS_TIMING.some((x, i) => i > 0 && !(x > LATE_MS_TIMING[i - 1]))) {
    fail(`the lateness grid ${LATE_MS_TIMING.join(', ')} is not strictly ascending`);
  }
  if (!LATE_MS_RENDERED.every((x) => LATE_MS_TIMING.includes(x))) {
    fail('a rendered lateness is not on the timing grid, so its timing cell is missing');
  }
  if (!EXP9_ARMS.some((a) => a.key === 'intervalometer-100ppm')) fail("EXPERIMENT-9's headline arm is gone");
}
checkAtLoad();
