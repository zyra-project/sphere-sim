// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * EXPERIMENT-10's library: what a straddled photograph integrated, what the
 * page's own reader makes of it, and how outcomes are tallied.
 *
 * None of these solves (following `experiment1.test.ts`): a solve is seconds
 * and a suite that ran the experiment would stop being run. What they pin is
 * everything that could make the experiment measure the wrong thing without
 * anybody noticing — a photograph filed under the wrong light, a fingerprint
 * that is not the page's, a refusal attributed to the straddle that the clean
 * capture makes anyway, a category that two positions can both be in.
 *
 * The reduced design throughout: s01 at `PRESETS.quick` (224x168), four
 * projectors, noiseless unless a test says otherwise. Its numbers are for the
 * plumbing and are not quoted. Each test names the defect it pins, and each
 * was watched failing under the mutation EXPERIMENT-10's spec names for it
 * before it was trusted to pass.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DEFAULT_SENSOR, captureAndDecode } from '../../bench/src/capture.ts';
import { frameBlockGrid, planFrames } from '../../bench/src/patterns.ts';
import { captureOptionsFor, type RunOptions } from '../../bench/src/run.ts';
import { DEFAULT_DECODE_OPTIONS } from '../../solver/src/decode.ts';
import type { Correspondence, LinearImage, PatternCapture } from '../../solver/src/decode.ts';
import { decodeTransfer, type EncodedImage } from '../../solver/src/ingest.ts';
import {
  complementResidual,
  fingerprint,
  indexByFingerprint,
  type FrameFingerprint,
} from '../../solver/src/indexing.ts';
import { indexPhotographs, summarisePhoto } from '../../web/src/readback.ts';
import {
  DWELL_S,
  ENCODE_FULL_SCALE,
  EXPECTED,
  EXPOSURE_S,
  EXP9_SEED_ROOT,
  FINGERPRINT_BLOCKS,
  FRAMES_PER_RUN,
  GRID_GATE_MM,
  MANIFEST,
  MARGINAL_RESIDUAL,
  PERIOD_PX,
  PLAN,
  POSITIONS,
  PROJECTORS,
  PROJECTOR_RES,
  STEPS,
  TRANSFER,
  ARMS,
  exp9TrialSeed,
} from '../src/straddle/design.ts';
import {
  blendFingerprint,
  classifyCapture,
  classifyPosition,
  contentChanged,
  designedPhotos,
  encodeSrgb8,
  failingPair,
  isolatedCheck,
  oracleObservations,
  pairResiduals,
  positionPhotos,
  quarterMasses,
  reconcileShots,
  runCrossing,
  runPlaced,
  runVerdicts,
  straddleForCamera,
  u0Crossing,
  type Harm,
  type LitState,
  type Photo,
  type PositionCategory,
  type RunOutcome10,
  type TwinStatus,
} from '../src/straddle/run.ts';
import {
  buildRig,
  decodeGrayOnly,
  decodeRun,
  litMask,
  noisyRun,
  photoFingerprint,
  photoFrame,
  planOrder,
  positionFingerprints,
  runFingerprints,
  runFrames,
  type RigBank,
} from '../src/straddle/bank.ts';
import { runTrial, shotTimings, straddles, summarise, exposureBlend, type ShotTiming } from '../src/tether/run.ts';

// ---------------------------------------------------------------------------
// The reduced design, built once for the file
// ---------------------------------------------------------------------------

let built: RigBank | null = null;
/** s01 at `PRESETS.quick`, noiseless. About a second, so every test shares it. */
function rig(): RigBank {
  built ??= buildRig(0, 'reduced');
  return built;
}

/** The position with nothing straddled: every photograph exactly its filed step. */
const CLEAN = designedPhotos('forward', () => 0, 1);

/** Every projector's run, and where a run keeps its references: the page's own kinds. */
const RUNS: readonly number[] = Array.from({ length: PROJECTORS }, (_, p) => p);
const WHITE = EXPECTED.kinds.indexOf('white');
const BLACK = EXPECTED.kinds.indexOf('black');

/** The headline cell EXPERIMENT-9 counted 728 touched captures in, and its arm. */
const HEADLINE = ARMS.find((a) => a.key === 'intervalometer-100ppm');
const HANDHELD = ARMS.find((a) => a.key === 'handheld-remote');
assert.ok(HEADLINE !== undefined && HANDHELD !== undefined);

function share(b: RigBank, c: number, p: number): number {
  return b.lit[c][p] / (b.width * b.height);
}

/** Runs lighting at least 1% of the photograph: the ones every claim below is made of. */
function visibleRuns(b: RigBank): { c: number; p: number }[] {
  const out: { c: number; p: number }[] = [];
  for (const c of b.cameras) for (let p = 0; p < PROJECTORS; p++) if (share(b, c, p) >= 0.01) out.push({ c, p });
  return out;
}

/** The camera and run with the most lit pixels, for the tests that decode one run. */
function brightestRun(b: RigBank): { c: number; p: number } {
  let best = { c: 0, p: 0 };
  for (const c of b.cameras) for (let p = 0; p < PROJECTORS; p++) if (b.lit[c][p] > b.lit[best.c][best.p]) best = { c, p };
  return best;
}

/** One photograph straddled, every other one clean. */
function lone(dir: 'forward' | 'backward', k: number, s: number): Photo[] {
  const blended = designedPhotos(dir, () => s, 1);
  return CLEAN.map((photo, j) => (j === k ? blended[j] : photo));
}

/** A run's frames as the renderer stores them, with sensor off: the double, rounded to Float32. */
function runImages(b: RigBank, c: number, p: number, photos: readonly Photo[]): LinearImage[] {
  return noisyRun(b, c, p, runFrames(b, c, p, photos), null, b.seed);
}

const pixelKey = (x: Correspondence): number => x.camV * 100000 + x.camU;

/** Mean decoded-coordinate change over the pixels both decodes accepted. */
function meanShift(before: readonly Correspondence[], after: readonly Correspondence[]): { du: number; dv: number; n: number } {
  const was = new Map(before.map((x) => [pixelKey(x), x]));
  let du = 0;
  let dv = 0;
  let n = 0;
  for (const y of after) {
    const x = was.get(pixelKey(y));
    if (x === undefined) continue;
    du += y.projU - x.projU;
    dv += y.projV - x.projV;
    n++;
  }
  return { du: du / n, dv: dv / n, n };
}

/** The six fields a solve reads off a correspondence. */
const coordinates = (x: Correspondence) => [x.camU, x.camV, x.projU, x.projV, x.sigmaU, x.sigmaV];

// ---------------------------------------------------------------------------
// T12-T13: what a photograph integrated
// ---------------------------------------------------------------------------

test("T12 page semantics: a photograph's parts are what the page lit, not the step numbers", () => {
  // The re-scoring files every photograph under what the PAGE showed while the
  // shutter was open. Three places where that differs from the emitter step
  // count, each of which moves photographs between "clean" and "changed":
  // before Play the page is already showing step 0 (`start()` paints it
  // silently), after the last step it is black, and the step after a run's last
  // frame is the NEXT projector's white. A 0.5/0.5 tie is the one exposure the
  // content footing cannot decide by majority.
  const D = DWELL_S;
  const E = EXPOSURE_S;
  const shots: ShotTiming[] = STEPS.map((_, j) => ({ position: 0, filedStep: j, open: j * D + D / 2 }));
  // Opened 0.1 s before Play: 0.4 of the exposure on emitter step -1.
  shots[0] = { ...shots[0], open: -0.1 };
  assert.deepEqual(
    exposureBlend(-0.1, E, D).map((p) => p.step),
    [-1, 0],
    'the timing model sees two steps; mapping them is the page semantics under test',
  );
  // Still open when the sequence ends: half the exposure after step 135.
  shots[135] = { ...shots[135], open: 136 * D - E / 2 };
  const timed = positionPhotos(shots, 0, E, D, 0, null, 0, 1);
  assert.deepEqual(timed[0].rows, [[{ step: 0, state: { projector: 0, frame: 0 }, weight: 1 }]]);
  assert.equal(contentChanged(timed[0]), false, 'a before-Play straddle is a clean photograph on the page');
  assert.deepEqual(
    timed[135].rows[0].map((p) => [p.step, p.state, p.weight]),
    [
      [135, { projector: 3, frame: 33 }, 0.5],
      [136, 'dark', 0.5],
    ],
  );
  assert.equal(timed.filter(contentChanged).length, 1, 'only the photograph that caught the dark changed');

  const forward = designedPhotos('forward', () => 0.25, 1);
  const backward = designedPhotos('backward', () => 0.25, 1);
  const states = (p: Photo) => p.rows[0].map((part) => part.state);
  assert.deepEqual(states(forward[135])[1], 'dark', "the successor of the position's last step is the dark");
  assert.deepEqual(states(forward[33]), [{ projector: 0, frame: 33 }, { projector: 1, frame: 0 }]);
  assert.deepEqual(states(backward[34]), [{ projector: 0, frame: 33 }, { projector: 1, frame: 0 }]);
  assert.deepEqual(backward[0].rows, [[{ step: 0, state: { projector: 0, frame: 0 }, weight: 1 }]]);
  assert.equal(forward.filter(contentChanged).length, 136);
  assert.equal(backward.filter(contentChanged).length, 135, 'the predecessor of step 0 is step 0');

  // The tie takes the filed kind, on the content footing, and a hair past it
  // takes the successor's: photograph 0 is white half the time and black half.
  const lit = (photos: Photo[], footing: 'content' | 'filed') =>
    oracleObservations(photos, footing)
      .slice(0, 3)
      .map((o) => o.litFraction);
  assert.deepEqual(lit(designedPhotos('forward', () => 0.5, 1), 'content'), [1, 0, 0.5]);
  assert.deepEqual(lit(designedPhotos('forward', () => 0.5 + 1e-9, 1), 'content'), [0, 0.5, 0.5]);
  assert.deepEqual(lit(designedPhotos('forward', () => 0.5 + 1e-9, 1), 'filed'), [1, 0, 0.5]);
  // The page's dark counts as a black frame.
  assert.equal(oracleObservations(designedPhotos('forward', () => 1, 1), 'content')[135].litFraction, 0);

  // The renderer's hook is handed the same states: another camera and a row
  // left whole are null (today's render, bit for bit), and a frame no
  // photograph was assigned to falls back to the one filed there.
  const hook = straddleForCamera(1, forward, null);
  assert.equal(hook.parts(0, 0, 33, 0), null);
  assert.deepEqual(hook.parts(1, 0, 33, 7), [
    { weight: 0.75, shown: { projector: 0, frame: 33 } },
    { weight: 0.25, shown: { projector: 1, frame: 0 } },
  ]);
  assert.equal(hook.parts(1, 0, 33, 7), hook.parts(1, 0, 33, 8), 'one array per distinct row, as the renderer caches');
  assert.equal(straddleForCamera(1, CLEAN, null).parts(1, 2, 5, 0), null);
  const shifted = CLEAN.map((_, j) => (j >= 1 && j < 35 ? j - 1 : null));
  const slipped = straddleForCamera(0, CLEAN, shifted);
  assert.deepEqual(slipped.parts(0, 0, 0, 0), [{ weight: 1, shown: { projector: 0, frame: 1 } }]);
  assert.equal(slipped.parts(0, 1, 5, 0), null, 'an unassigned frame is the filed photograph');

  // A rolling readout reads row r out readout·r/(H - 1) after row 0 (camera.ts,
  // `rowTimeSec`), so that row's exposure opens that much later: a shot whose
  // first row closes before a boundary can carry later rows across it, and its
  // rows then differ. Each row's share of the next step is written here from
  // the spec's timing (§3.2), not read from the code under test, so a row
  // offset over H rather than H - 1 shows. The content footing weighs a part
  // by its share of the photograph's light-time, the mean over rows: every row
  // of this photograph is mostly its filed white, so it observes as white,
  // although three of its five rows caught some black and the last mostly black.
  const H = 5;
  const readout = 0.2;
  const open0 = D - E - 0.06;
  const rolledShots: ShotTiming[] = STEPS.map((_, j) => ({
    position: 0,
    filedStep: j,
    open: j === 0 ? open0 : j * D + D / 2,
  }));
  const rolled = positionPhotos(rolledShots, 0, E, D, 0, null, readout, H);
  assert.equal(rolled[0].rows.length, H, 'a photograph whose rows differ keeps one entry per row');
  assert.equal(rolled[1].rows.length, 1, 'and one whose rows agree keeps one');
  const blackShare: number[] = [];
  for (let r = 0; r < H; r++) {
    const late = Math.max(0, (open0 + (readout * r) / (H - 1) + E - D) / E);
    blackShare.push(late);
    const got = new Map(rolled[0].rows[r].map((p) => [p.step, p.weight]));
    assert.ok(
      Math.abs((got.get(1) ?? 0) - late) < 1e-12 && Math.abs((got.get(0) ?? 0) - (1 - late)) < 1e-12,
      `row ${r} integrated ${JSON.stringify([...got])}; its exposure puts ${late} of it on the black`,
    );
  }
  assert.ok(blackShare[H - 1] > 0.5 && blackShare.reduce((a, x) => a + x, 0) / H < 0.5, `${blackShare}`);
  assert.equal(contentChanged(rolled[0]), true);
  assert.equal(oracleObservations(rolled, 'content')[0].litFraction, 1, 'the mean over rows decides, not a sum');
});

test('T13 the re-scoring accounts for every photograph EXPERIMENT-9 took', () => {
  // A photograph is content-changed when it straddled a change the page made,
  // or when it wholly caught another step. So, trial by trial,
  // changed = straddled - phantoms + wholly-wrong, where a phantom is a
  // straddle EXPERIMENT-9 counted across Play itself — the page changes nothing
  // there — and a wholly-wrong photograph straddled nothing and caught the
  // wrong step. Both are written here from the timing alone, not from the code
  // under test, so a page-semantics slip shows as a count that does not add up.
  //
  // The headline cell has no phantom in its first 50 trials (its jitter is
  // 2 ms, and a phantom needs the first shutter to open before Play), so the
  // clamp this pins could be removed without the headline noticing. The
  // hand-held arm, 250 ms of jitter, is included for that reason.
  const D = DWELL_S;
  const E = EXPOSURE_S;
  const totals = { phantoms: 0, whollyWrong: 0, straddled: 0, dark: 0 };
  for (const arm of [HEADLINE, HANDHELD]) {
    for (let t = 0; t < 50; t++) {
      const seed = exp9TrialSeed(arm, 'uniform', D, E, t);
      const shots = shotTimings(arm, 'uniform', D, seed);
      let straddled = 0;
      let phantoms = 0;
      let whollyWrong = 0;
      let changed = 0;
      for (let pos = 0; pos < POSITIONS; pos++) {
        const mine = shots.filter((s) => s.position === pos);
        positionPhotos(shots, pos, E, D, 0, null, 0, 1).forEach((photo, j) => {
          const { open, filedStep } = mine[j];
          const across = straddles(open, E, D);
          if (across) straddled++;
          if (across && open < 0 && filedStep === 0) phantoms++;
          const m = Math.floor(open / D);
          const shown = m < 0 ? 0 : Math.min(m, STEPS.length);
          if (!across && shown !== filedStep) whollyWrong++;
          if (contentChanged(photo)) changed++;
        });
      }
      const label = `${arm.key} trial ${t}`;
      assert.equal(straddled, runTrial(arm, 'uniform', D, E, seed).straddled, `${label}: not EXPERIMENT-9's shots`);
      assert.equal(changed, straddled - phantoms + whollyWrong, label);
      const r = reconcileShots(shots, E, D);
      assert.deepEqual(
        [r.photographs, r.straddled, r.phantoms, r.whollyWrong, r.contentChanged],
        [POSITIONS * STEPS.length, straddled, phantoms, whollyWrong, changed],
        label,
      );
      totals.phantoms += phantoms;
      totals.whollyWrong += whollyWrong;
      totals.straddled += straddled;
      totals.dark += r.endingInDark;
    }
  }
  // Each term has to be exercised, or the identity is about nothing.
  assert.ok(totals.phantoms > 0, 'no phantom in the sample, so the before-Play clamp is untested');
  assert.ok(totals.whollyWrong > 0 && totals.straddled > 0 && totals.dark > 0, JSON.stringify(totals));

  // And these are EXPERIMENT-9's trials, trial by trial. Its seed expression
  // lives inside tether's `summarise` and this experiment carries the one copy
  // of it (`exp9TrialSeed`), so each trial's straddle count is read back from
  // the difference of `summarise`'s own running totals and compared. A total
  // over 50 trials alone would not do: a copy one trial out of step agrees with
  // it whenever the trial it gained and the one it lost were both untouched.
  let before = 0;
  let touchedTrials = 0;
  for (let t = 0; t < 50; t++) {
    const theirs: number = summarise(HEADLINE, 'uniform', D, E, t + 1, EXP9_SEED_ROOT).straddledTotal;
    const shots = shotTimings(HEADLINE, 'uniform', D, exp9TrialSeed(HEADLINE, 'uniform', D, E, t));
    const mine = shots.filter((s) => straddles(s.open, E, D)).length;
    assert.equal(mine, theirs - before, `trial ${t} is not EXPERIMENT-9's trial ${t}`);
    before = theirs;
    if (mine > 0) touchedTrials++;
  }
  assert.ok(touchedTrials > 0 && touchedTrials < 50, `${touchedTrials} of 50 trials touched, so the comparison cannot tell trials apart`);
});

// ---------------------------------------------------------------------------
// T14-T18: the complement check
// ---------------------------------------------------------------------------

test('T14 fingerprints are linear in the blend, so a blend is fingerprinted without its pixels', () => {
  // The gate stage fingerprints tens of thousands of blends by summing the
  // fingerprints of what they blend. That is exact only if the sum is the
  // fingerprint the page would compute from the blended photograph itself —
  // every part, its own weight, and another projector's light composed as the
  // renderer composes it. Checked against the page's own `fingerprint` on the
  // blended pixels, for a whole forward position (every run's last frame
  // blends into the next projector's white, the last into the dark) and for a
  // rolling readout, whose rows blend differently and go through row sums.
  const b = rig();
  const c = brightestRun(b).c;
  const cases: [string, Photo[]][] = [
    ['forward 0.3', designedPhotos('forward', () => 0.3, 1)],
    ['backward 0.2', designedPhotos('backward', () => 0.2, 1)],
    [
      'rolling, readout 0.3 of the exposure',
      designedPhotos('forward', (row) => Math.min(1, Math.max(0, 0.1 + (row / (b.height - 1) - 0.5) * 0.3)), b.height),
    ],
  ];
  let checked = 0;
  for (const [name, photos] of cases) {
    const predicted = positionFingerprints(b, c, photos);
    photos.forEach((photo, j) => {
      const p = STEPS[j].projector;
      const pixels = photoFrame(b, c, p, photo);
      const direct = fingerprint({ width: b.width, height: b.height, channels: 1, data: pixels }, j, FINGERPRINT_BLOCKS);
      for (let i = 0; i < direct.values.length; i++) {
        const want = direct.values[i];
        const got = predicted[j].values[i];
        if (!(Math.abs(got - want) <= 1e-6 * Math.abs(want))) {
          assert.fail(`${name}, photograph ${j} block ${i}: predicted ${got}, the page's fingerprint ${want}`);
        }
      }
      if (photo.rows.some((row) => row.length > 1)) checked++;
    });
  }
  assert.ok(checked > 300, `only ${checked} blended photographs were checked`);
});

test('T15 a lone straddled pattern frame reads at most its smear, and a coarse plane nearly all of it', () => {
  // Replaces an earlier FALSE claim that such a frame reads exactly its smear.
  // A Gray frame smeared into its own complement misses the identity by
  // s·a·|1 - 2g| per block, so the residual is at most s, with equality only
  // where every counted block is uniform in the plane. Fine planes have blocks
  // across stripe edges, whose deviations cancel, and read less; the MSB
  // hardly has any. This is PR #46's single-frame bound, pinned on rendered
  // frames of the page's plan rather than on a four-block toy.
  const b = rig();
  const s = 0.1;
  let u0Runs = 0;
  let pairsChecked = 0;
  for (const { c, p } of visibleRuns(b)) {
    const clean = b.fingerprints[c][p];
    EXPECTED.complements.pairs.forEach(([a, bb], m) => {
      const k = p * FRAMES_PER_RUN + a;
      const straddled = photoFingerprint(b, c, p, lone('forward', k, s)[k], k);
      const r = complementResidual(straddled, clean[bb], clean[WHITE], clean[BLACK]);
      assert.ok(r !== null, `camera ${c} run ${p + 1} pair ${m} unanswered`);
      assert.ok(r <= s + 1e-6, `camera ${c} run ${p + 1} pair ${m} reads ${r}, above its smear ${s}`);
      pairsChecked++;
      if (m === 0) {
        assert.ok(r / s >= 0.95, `camera ${c} run ${p + 1}: the MSB reads only ${(r / s).toFixed(3)} of its smear`);
        u0Runs++;
      }
    });
  }
  assert.ok(u0Runs >= 6 && pairsChecked === 12 * u0Runs, `${u0Runs} runs checked`);
});

test('T16 the whole-run closed form holds in projector space', () => {
  // In projector space, on the aligned 64-block grid, a whole-run forward blend
  // moves pair u0 by 2s/(2 - 3s) of the modulation and every other pair by
  // 1.5s/(2 - 3s). Derived at design time and never pinned; pinned here with
  // the real `frameBlockGrid` and `complementResidual`. The references are
  // blended too, which is what the denominator is: a blend that left white and
  // black whole would read s/2 on u0 instead.
  const specs = planFrames(PLAN);
  const grids = specs.map((spec) => frameBlockGrid(spec, PLAN, FINGERPRINT_BLOCKS, PROJECTOR_RES.x, PROJECTOR_RES.y, 0));
  const measured = new Uint8Array(FINGERPRINT_BLOCKS * FINGERPRINT_BLOCKS).fill(1);
  // Projector space has no other projector and no room: a state is its frame's grid.
  const grid = (state: LitState): FrameFingerprint => ({
    ordinal: -1,
    blocks: FINGERPRINT_BLOCKS,
    values: grids[state === 'dark' ? BLACK : state.frame],
    measured,
  });
  const position = (s: number): FrameFingerprint[] =>
    designedPhotos('forward', () => s, 1).map((photo, j) => blendFingerprint(photo.rows[0], j, grid));
  for (const s of [0.05, 0.1, 0.15]) {
    const r = pairResiduals(position(s).slice(0, FRAMES_PER_RUN));
    assert.ok(Math.abs((r[0] as number) - (2 * s) / (2 - 3 * s)) <= 1e-4, `s = ${s}: pair u0 reads ${r[0]}`);
    for (let m = 1; m < r.length; m++) {
      assert.ok(Math.abs((r[m] as number) - (1.5 * s) / (2 - 3 * s)) <= 1e-4, `s = ${s}: pair ${m} reads ${r[m]}`);
    }
  }
  // 2(0.13)/(2 - 0.39) = 0.1615 > 0.15 > 0.1211: pair u0 alone refuses every run.
  const photos = designedPhotos('forward', () => 0.13, 1);
  const result = indexByFingerprint(oracleObservations(photos, 'content'), position(0.13), EXPECTED);
  assert.deepEqual(result.usableProjectors, []);
  assert.equal(result.problems.length, PROJECTORS);
  for (const [i, problem] of result.problems.entries()) {
    assert.match(problem, new RegExp(`^Projector ${i + 1}'s frames 3 and 4 were played as a pattern`));
  }
});

/** Pair u0's residual in one run at a whole-run forward smear, from the four frames it reads. */
function u0ResidualAt(b: RigBank, c: number, p: number, s: number): number | null {
  const photos = designedPhotos('forward', () => s, 1);
  const [a, bb] = EXPECTED.complements.pairs[0];
  const at = (f: number) => {
    const k = p * FRAMES_PER_RUN + f;
    return photoFingerprint(b, c, p, photos[k], k);
  };
  return complementResidual(at(a), at(bb), at(WHITE), at(BLACK));
}

const crossings = new Map<string, ReturnType<typeof runCrossing>>();
/** A run's whole-run crossing on every pair, cached: two tests read it. */
function runCrossingOf(b: RigBank, c: number, p: number): ReturnType<typeof runCrossing> {
  const key = `${c}:${p}`;
  let got = crossings.get(key);
  if (got === undefined) {
    got = runCrossing((s) => pairResiduals(runFingerprints(b, c, p, designedPhotos('forward', () => s, 1))));
    crossings.set(key, got);
  }
  return got;
}

test("T17 the quarter masses predict pair u0's crossing, and only pair u0's", () => {
  // A site can compute pair u0's crossing from how its modulation spreads over
  // the four quarters of the projector's u axis, with no render at all. That is
  // what `u0Crossing` claims, and it is held here to the crossing bisected on
  // rendered, blended fingerprints — references blended too, as the formula's
  // denominator assumes. And it is a claim about pair u0 only: a run's crossing
  // is its least pair's, and on this rig at least one run crosses far below
  // what u0 alone would say.
  const b = rig();
  let checked = 0;
  let someOtherPairBinds = false;
  for (const { c, p } of visibleRuns(b)) {
    const predicted = u0Crossing(quarterMasses(b.fingerprints[c][p]));
    const bisected = runCrossing((s) => [u0ResidualAt(b, c, p, s)]);
    assert.ok(bisected.s !== null, `camera ${c} run ${p + 1}: pair u0 never crossed`);
    assert.ok(
      Math.abs(predicted - bisected.s) <= 0.005,
      `camera ${c} run ${p + 1}: the quarter masses predict ${predicted.toFixed(4)}, the render crosses at ${bisected.s.toFixed(4)}`,
    );
    checked++;
  }
  assert.ok(checked >= 6, `${checked} runs`);
  for (const { c, p } of visibleRuns(b)) {
    const run = runCrossingOf(b, c, p);
    if (run.s !== null && Math.abs(run.s - u0Crossing(quarterMasses(b.fingerprints[c][p]))) > 0.005) {
      someOtherPairBinds = true;
      break;
    }
  }
  assert.ok(someOtherPairBinds, 'every run crossed where pair u0 does, so "only pair u0" was not tested');
});

test("T18 a run's crossing is its least pair crossing, and the direct verdict is the page's", () => {
  // The gate stage decides runs directly — any pair over the limit, or any pair
  // unanswered — because it scans thousands of smears and the page's indexer
  // answers for a whole position at a time. That is only the page's verdict if
  // it reads every pair: at five smears on every camera of the rig, the direct
  // verdict must agree with `indexByFingerprint` run for run.
  const b = rig();
  let placed = 0;
  let refused = 0;
  for (const s of [0.04, 0.08, 0.12, 0.16, 0.2]) {
    const photos = designedPhotos('forward', () => s, 1);
    for (const c of b.cameras) {
      const fps = positionFingerprints(b, c, photos);
      const result = isolatedCheck(fps, photos, 'content');
      for (let p = 0; p < PROJECTORS; p++) {
        const direct = runPlaced(pairResiduals(fps.slice(p * FRAMES_PER_RUN, (p + 1) * FRAMES_PER_RUN)));
        assert.equal(direct, result.usableProjectors.includes(p), `s = ${s}, camera ${c}, run ${p + 1}`);
        if (direct) placed++;
        else refused++;
      }
    }
  }
  assert.ok(placed > 5 && refused > 5, `${placed} placed and ${refused} refused, so the comparison is one-sided`);
  // Non-vacuity: some run's binding pair is not u0, so a verdict that read u0
  // alone would have disagreed with the page somewhere above. Scanned in order
  // until one is found; a scan is a third of a second.
  const bindsElsewhere = visibleRuns(b).find(({ c, p }) => {
    const x = runCrossingOf(b, c, p);
    return x.pair !== null && x.pair !== 0;
  });
  assert.ok(bindsElsewhere !== undefined, 'every run is bound by pair u0');
  assert.equal(failingPair([0.1, null, 0.2]), 2, 'a broken pair is named ahead of an unanswered one, as the page names it');
  assert.equal(failingPair([0.1, null, 0.12]), 1);
});

// ---------------------------------------------------------------------------
// T19-T20: the decode
// ---------------------------------------------------------------------------

test('T19 only the phase frames move a coordinate, toward the neighbour the page lit', () => {
  // The fast path first: a straddled capture rendered through the renderer's
  // own hook, from this experiment's photographs, is the bank's blend of the
  // same photographs — so every decode below is of the frames the renderer
  // would have produced. A whole forward position, so every run's last frame
  // is photographed with the next projector's white and the last with the dark.
  // And a rolling readout, readout/exposure 0.3 about a mid-row smear of 0.2, so
  // the hook is asked row by row: one that answered every row with row 0's
  // parts would render a global shutter, and the pose arm's rolling solves
  // would photograph something other than what the gate stage fingerprints.
  const b = rig();
  const { c, p } = brightestRun(b);
  const whole = designedPhotos('forward', () => 0.2, 1);
  const rolling = designedPhotos('forward', (row) => 0.2 + (row / (b.height - 1) - 0.5) * 0.3, b.height);
  const runOptions: RunOptions = {
    preset: b.preset,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
    plan: PLAN,
  };
  const base = captureOptionsFor(b.world, b.scenario, runOptions, PLAN);
  for (const [name, photos] of [
    ['whole forward', whole],
    ['rolling', rolling],
  ] as const) {
    const hooked: PatternCapture[] = [];
    captureAndDecode(b.world.truthRig, [b.world.cameras[c]], {
      ...base,
      conditions: { ...base.conditions, sensor: null, straddle: straddleForCamera(0, photos, null) },
      onCapture: (_c, _p, capture) => {
        hooked.push(capture);
      },
    });
    assert.equal(hooked.length, PROJECTORS);
    let worst = 0;
    for (let q = 0; q < PROJECTORS; q++) {
      const rendered = planOrder(hooked[q]);
      for (let f = 0; f < FRAMES_PER_RUN; f++) {
        const bank = photoFrame(b, c, q, photos[q * FRAMES_PER_RUN + f]);
        const data = rendered[f].data;
        for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(data[i] - bank[i]));
      }
    }
    // The bank's frames are Float32, the hook's ideals doubles: a few 1e-8.
    assert.ok(worst <= 1e-6, `${name}: the hook's render and the bank's blend differ by ${worst}`);
  }

  // Then one run, one photograph at a time, at s = 0.2. A Gray plane blended
  // with its neighbour keeps every bit's sign below 3/7, so frames 2-25 leave
  // every correspondence as it was; white and black move only which pixels
  // clear the thresholds; and a u phase step blended with the next u step
  // looks like a sample taken slightly later in the fringe, so it moves the
  // phase one way forward and the other way backward.
  const clean = decodeRun(c, p, runImages(b, c, p, CLEAN)).correspondences;
  assert.ok(clean.length > 5000, `only ${clean.length} correspondences`);
  const decodeLone = (dir: 'forward' | 'backward', f: number): Correspondence[] =>
    decodeRun(c, p, runImages(b, c, p, lone(dir, p * FRAMES_PER_RUN + f, 0.2))).correspondences;
  for (let f = 2; f <= 25; f++) {
    const got = decodeLone('forward', f);
    assert.equal(got.length, clean.length, `frame ${f}: the accepted set changed`);
    for (let i = 0; i < got.length; i++) {
      if (coordinates(got[i]).some((v, k) => v !== coordinates(clean[i])[k])) {
        assert.fail(`frame ${f}: correspondence ${i} moved`);
      }
    }
  }
  for (const f of [0, 1]) {
    const shift = meanShift(clean, decodeLone('forward', f));
    assert.ok(shift.n > 0.9 * clean.length);
    assert.ok(shift.du === 0 && shift.dv === 0, `frame ${f} moved a coordinate on the common set: ${shift.du}, ${shift.dv}`);
  }
  const u = (dir: 'forward' | 'backward', f: number): number => meanShift(clean, decodeLone(dir, f)).du;
  const forwardBias = [26, 27, 28].map((f) => u('forward', f));
  const backwardBias = [27, 28, 29].map((f) => u('backward', f));
  for (const x of forwardBias) assert.ok(x < 0, `forward phase frames: ${forwardBias}`);
  for (const x of backwardBias) assert.ok(x > 0, `backward phase frames: ${backwardBias}`);
  // Where the neighbour is not a u phase step — the fourth u step forward (its
  // successor is v's first) and the first backward (its predecessor is v's last
  // Gray complement) — the fringe does not move.
  const unmoved = [u('forward', 29), u('backward', 26)];
  for (const x of unmoved) assert.ok(Math.abs(x) < 0.1 * Math.abs(forwardBias[0]), `neighbours off the u axis: ${unmoved}`);
});

test('T20 the phase bias is about three quarters of the cyclic shift, and negative', () => {
  // A cyclic smear of every phase step by s rotates the fringe by atan2(s, 1-s),
  // exactly. The page's sequence is not cyclic: each axis's last step blends
  // into the NEXT axis's first, not back into its own, and the estimator then
  // recovers about three quarters of the rotation. Measured on the rendered
  // blend, every visible run, both axes: -0.75, in the direction of a later
  // sample. The spec quotes the band as [0.70, 0.80] without the sign; the code
  // says the recovered coordinate moves DOWN.
  //
  // The clean decode the bias is measured from is itself held to the bank's
  // geometric truth, which the decode stage measures every error against: a
  // truth table built at pixel corners rather than centres would be half a
  // camera pixel — several projector pixels here — off everywhere.
  const b = rig();
  const s = 0.1;
  const whole = designedPhotos('forward', () => s, 1);
  const cyclic = Math.atan2(s, 1 - s) / (2 * Math.PI);
  let checked = 0;
  for (const { c, p } of visibleRuns(b)) {
    const clean = decodeRun(c, p, runImages(b, c, p, CLEAN)).correspondences;
    const errors = clean
      .map((x) => {
        const i = (x.camV - 0.5) * b.width + (x.camU - 0.5);
        return Math.hypot(x.projU - b.truth[c][p].projU[i], x.projV - b.truth[c][p].projV[i]);
      })
      .filter((e) => !Number.isNaN(e))
      .sort((x, y) => x - y);
    assert.ok(errors.length > 0.9 * clean.length, `camera ${c} run ${p + 1}: the truth misses decoded pixels`);
    const median = errors[Math.floor(errors.length / 2)];
    assert.ok(median < 1, `camera ${c} run ${p + 1}: the clean decode sits ${median.toFixed(2)} px from the truth`);
    const shift = meanShift(clean, decodeRun(c, p, runImages(b, c, p, whole)).correspondences);
    const ratio = { u: shift.du / (PERIOD_PX.u * cyclic), v: shift.dv / (PERIOD_PX.v * cyclic) };
    for (const axis of ['u', 'v'] as const) {
      assert.ok(
        ratio[axis] >= -0.8 && ratio[axis] <= -0.7,
        `camera ${c} run ${p + 1}, ${axis}: the bias is ${ratio[axis].toFixed(3)} of the cyclic shift`,
      );
    }
    checked++;
  }
  assert.ok(checked >= 6, `${checked} runs`);
});

// ---------------------------------------------------------------------------
// T21-T22: attribution and classes
// ---------------------------------------------------------------------------

test('T21 attribution runs against the clean control, on the same noise', () => {
  // A refusal is the straddle's only if the same capture without it is placed.
  // The twin is exactly that: the clean position through the same sensor and
  // the same noise stream. So the fast path's walk of that stream is checked
  // first, against the renderer's own noisy render of the same camera; then
  // that a straddled run and its twin share every draw; and only then are
  // refusals attributed.
  const b = rig();
  const runOptions: RunOptions = {
    preset: b.preset,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
    plan: PLAN,
  };
  const base = captureOptionsFor(b.world, b.scenario, runOptions, PLAN);
  assert.deepEqual(base.conditions.sensor, DEFAULT_SENSOR);
  const rendered: PatternCapture[] = [];
  captureAndDecode(b.world.truthRig, [b.world.cameras[0]], {
    ...base,
    onCapture: (_c, _p, capture) => {
      rendered.push(capture);
    },
  });
  const bits = DEFAULT_SENSOR.quantizationBits;
  assert.ok(bits !== null);
  const step = DEFAULT_SENSOR.saturationRadiance / (2 ** bits - 1);
  let total = 0;
  let same = 0;
  let worstSteps = 0;
  for (let p = 0; p < PROJECTORS; p++) {
    const walked = noisyRun(b, 0, p, (f) => b.frames[0][p][f], DEFAULT_SENSOR, b.seed);
    const theirs = planOrder(rendered[p]);
    for (let f = 0; f < FRAMES_PER_RUN; f++) {
      for (let i = 0; i < walked[f].data.length; i++) {
        total++;
        if (walked[f].data[i] === theirs[f].data[i]) same++;
        else worstSteps = Math.max(worstSteps, Math.abs(Math.round(walked[f].data[i] / step) - Math.round(theirs[f].data[i] / step)));
      }
    }
  }
  assert.ok(same >= 0.999 * total, `${total - same} of ${total} pixels differ from the renderer's`);
  assert.ok(worstSteps <= 1, `a pixel differs by ${worstSteps} quantisation steps`);

  // Common random numbers: one photograph straddled, and every other frame of
  // the run is its twin's bit for bit — the straddle moved nothing else.
  const { c: bc, p: bp } = brightestRun(b);
  const k = bp * FRAMES_PER_RUN + 20;
  const twinRun = noisyRun(b, bc, bp, runFrames(b, bc, bp, CLEAN), DEFAULT_SENSOR, b.seed);
  const oneRun = noisyRun(b, bc, bp, runFrames(b, bc, bp, lone('forward', k, 0.3)), DEFAULT_SENSOR, b.seed);
  for (let f = 0; f < FRAMES_PER_RUN; f++) {
    const identical = twinRun[f].data.every((v, i) => v === oneRun[f].data[i]);
    assert.equal(identical, f !== 20, `frame ${f} ${f === 20 ? 'did not change' : 'changed'} with the straddle on frame 20`);
  }

  const noisyFingerprints = (c: number, photos: readonly Photo[]): FrameFingerprint[] => {
    const out: FrameFingerprint[] = [];
    for (let p = 0; p < PROJECTORS; p++) {
      noisyRun(b, c, p, runFrames(b, c, p, photos), DEFAULT_SENSOR, b.seed).forEach((image, f) => {
        out.push(fingerprint(image, p * FRAMES_PER_RUN + f, FINGERPRINT_BLOCKS));
      });
    }
    return out;
  };
  const straddled = designedPhotos('forward', () => 0.12, 1);
  for (const c of b.cameras) {
    // s = 0: the twin itself. Noise alone refuses no run a camera plainly sees,
    // and the run it cannot see is refused anyway, so it is nobody's to attribute.
    const twin = isolatedCheck(noisyFingerprints(c, CLEAN), CLEAN, 'content');
    const invisible = RUNS.filter((p) => b.lit[c][p] === 0);
    assert.ok(invisible.length > 0, `camera ${c} sees every projector, so "refused anyway" is untested`);
    const still = runVerdicts(twin, CLEAN, twin.usableProjectors);
    for (const o of still) {
      assert.equal(o.touched, false);
      if (share(b, c, o.projector) >= 0.01) assert.equal(o.attributable, true, `camera ${c} run ${o.projector + 1} refused clean`);
      if (o.attributable) assert.equal(o.outcome, 'placed');
    }
    for (const p of invisible) {
      assert.equal(still[p].attributable, false, `camera ${c}'s invisible run ${p + 1} was placed by the twin`);
      assert.notEqual(still[p].outcome, 'placed', 'and it is refused anyway');
    }

    // s = 0.12, inside the crossing band: some runs go and some stay, and only
    // the ones the twin placed are the straddle's.
    const treated = isolatedCheck(noisyFingerprints(c, straddled), straddled, 'content');
    const verdicts = runVerdicts(treated, straddled, twin.usableProjectors);
    const mine = verdicts.filter((o) => o.touched && o.attributable);
    assert.ok(mine.some((o) => o.outcome !== 'placed'), `camera ${c}: no attributable run refused at 0.12`);
    assert.ok(mine.some((o) => o.outcome === 'placed'), `camera ${c}: every attributable run refused at 0.12`);
    for (const p of invisible) {
      assert.equal(verdicts[p].attributable, false);
      assert.notEqual(verdicts[p].outcome, 'placed', `camera ${c}'s invisible run ${p + 1}`);
    }
  }

  // What the rescoring reads off a run besides placed or refused, each on a
  // position built to show it, noiseless. A lone Gray plane smeared into its
  // own complement breaks its pair and moves no coordinate (T19), so its
  // refusal is a FALSE ALARM, reported with the pair the page named and that
  // pair's exact residual; add a smeared phase step to the same run and the
  // refusal is no longer false, because the run is PHASE-TOUCHED. An invisible
  // run's white read as black costs the position a run boundary, so the page
  // refuses every run, and the attributable ones no straddle touched are
  // COLLATERAL; the position is still INVISIBLE-ONLY, because §3.6 counts
  // touched runs, and the loud refusal is carried by the collateral flag. A
  // slip, every photograph from run 1's last on wholly one step late, shortens
  // the first run and lengthens the last, which the page refuses by length.
  const { c: vc, p: pv } = brightestRun(b);
  const pi = RUNS.find((q) => b.lit[vc][q] === 0);
  assert.ok(pi !== undefined);
  const firstPhase = planFrames(PLAN).findIndex((spec) => spec.kind === 'phase');
  const cleanTwin = isolatedCheck(positionFingerprints(b, vc, CLEAN), CLEAN, 'content');
  const smeared = (at: readonly number[], s: number): Photo[] => {
    const blended = designedPhotos('forward', () => s, 1);
    return CLEAN.map((photo, j) => (at.includes(j) ? blended[j] : photo));
  };
  const outcomesOf = (photos: readonly Photo[]) => {
    const fingerprints = positionFingerprints(b, vc, photos);
    const observations = oracleObservations(photos, 'content');
    const result = isolatedCheck(fingerprints, photos, 'content');
    return { fingerprints, runs: runVerdicts(result, photos, cleanTwin.usableProjectors, { observations, fingerprints }) };
  };
  const gray = outcomesOf(smeared([pv * FRAMES_PER_RUN + 2], 0.3));
  const alarm = gray.runs[pv];
  assert.equal(alarm.outcome, 'refused-complement');
  assert.deepEqual(alarm.brokenPair, EXPECTED.complements.pairs[0], 'the pair the page named, as positions in the run');
  const residual = pairResiduals(gray.fingerprints.slice(pv * FRAMES_PER_RUN, (pv + 1) * FRAMES_PER_RUN))[0];
  assert.equal(alarm.brokenResidual, residual);
  assert.equal(alarm.brokenPercent, Math.round(100 * (residual as number)));
  assert.ok(alarm.touched && alarm.attributable && !alarm.phaseTouched && alarm.falseAlarm && !alarm.collateral, JSON.stringify(alarm));
  const both = outcomesOf(smeared([pv * FRAMES_PER_RUN + 2, pv * FRAMES_PER_RUN + firstPhase + 1], 0.3)).runs[pv];
  assert.equal(both.outcome, 'refused-complement');
  assert.ok(both.phaseTouched && !both.falseAlarm, JSON.stringify(both));
  const phaseOnly = outcomesOf(smeared([pv * FRAMES_PER_RUN + firstPhase + 1], 0.3)).runs[pv];
  assert.ok(phaseOnly.outcome === 'placed' && phaseOnly.touched && phaseOnly.phaseTouched && !phaseOnly.falseAlarm, JSON.stringify(phaseOnly));

  const lost = outcomesOf(smeared([pi * FRAMES_PER_RUN + WHITE], 0.7)).runs;
  for (const o of lost) {
    assert.equal(o.outcome, 'refused-bookends-count', `run ${o.projector + 1}`);
    assert.equal(o.collateral, o.projector !== pi && o.attributable, `run ${o.projector + 1}`);
  }
  assert.ok(lost.some((o) => o.collateral), 'no collateral run, so the flag is untested');
  const twinStatus: TwinStatus[] = RUNS.map((q) => ({
    projector: q,
    placed: cleanTwin.usableProjectors.includes(q),
    worstResidual: null,
    correspondences: null,
  }));
  assert.equal(classifyPosition(lost, twinStatus), 'INVISIBLE-ONLY');

  const late = designedPhotos('forward', () => 1, 1);
  const slip = outcomesOf(CLEAN.map((photo, j) => (j >= FRAMES_PER_RUN - 1 ? late[j] : photo))).runs;
  assert.equal(slip[0].outcome, 'refused-bookends-length');
  assert.equal(slip[PROJECTORS - 1].outcome, 'refused-bookends-length');
});

test('T22 capture and position classes are exhaustive and disjoint', () => {
  // The operator headline sorts EXPERIMENT-9's touched captures into classes, and
  // a capture that fell into two, or none, would be counted twice or lost. Each
  // class is re-derived here from the run outcomes themselves rather than from
  // the position categories, and must agree with `classifyCapture` under both
  // policies. The first 50 touched captures of the headline cell, replayed on
  // the reduced rig with position p on camera p; the first 50 TRIALS hold no
  // MIXED position on this rig, so that sample could not test the one category
  // that is neither all nor none.
  const b = rig();
  const D = DWELL_S;
  const E = EXPOSURE_S;
  const twins = b.cameras.map((c) => isolatedCheck(positionFingerprints(b, c, CLEAN), CLEAN, 'content'));
  const twinStatus = (c: number): TwinStatus[] =>
    RUNS.map((p) => ({ projector: p, placed: twins[c].usableProjectors.includes(p), worstResidual: null, correspondences: null }));
  const harms: (Harm | null)[] = [
    null,
    { dGridMm: 0.1, tauNullMm: 0.2, gTwinMm: 0.5, gTwinCensored: false, gTreatedMm: 0.6, gTreatedCensored: false, rotationTwinDeg: 0.01, rotationTreatedDeg: 0.01 },
    { dGridMm: 0.3, tauNullMm: 0.2, gTwinMm: 0.5, gTwinCensored: false, gTreatedMm: 0.8, gTreatedCensored: false, rotationTwinDeg: 0.01, rotationTreatedDeg: 0.06 },
    { dGridMm: 0.3, tauNullMm: 0.2, gTwinMm: 0.9, gTwinCensored: false, gTreatedMm: 1.2, gTreatedCensored: false, rotationTwinDeg: 0.01, rotationTreatedDeg: 0.01 },
  ];
  let captures = 0;
  let mixed = 0;
  let mixedByRuns = 0;
  const seen = new Set<string>();
  for (let t = 0; captures < 50; t++) {
    assert.ok(t < 2000, 'fewer than 50 touched captures in the whole cell');
    const shots = shotTimings(HEADLINE, 'uniform', D, exp9TrialSeed(HEADLINE, 'uniform', D, E, t));
    if (!shots.some((s) => straddles(s.open, E, D))) {
      // Not touched by EXPERIMENT-9's count, and at a perfect timer nothing else moves a photograph.
      for (let pos = 0; pos < POSITIONS; pos++) {
        assert.equal(positionPhotos(shots, pos, E, D, 0, null, 0, 1).some(contentChanged), false);
      }
      continue;
    }
    captures++;
    const categories: PositionCategory[] = [];
    const runs: RunOutcome10[][] = [];
    for (let pos = 0; pos < POSITIONS; pos++) {
      const photos = positionPhotos(shots, pos, E, D, 0, null, 0, 1);
      const flagged = shots.some((s) => s.position === pos && straddles(s.open, E, D));
      const verdicts = runVerdicts(isolatedCheck(positionFingerprints(b, pos, photos), photos, 'content'), photos, twins[pos].usableProjectors);
      const category = classifyPosition(verdicts, twinStatus(pos), { exp9Flagged: flagged });
      categories.push(category);
      runs.push(verdicts);
      // MIXED, counted from the runs: a touched run the twin placed was
      // refused, and another was placed.
      const counted = verdicts.filter((o) => o.touched && o.attributable);
      const both = counted.some((o) => o.outcome === 'placed') && counted.some((o) => o.outcome !== 'placed');
      assert.equal(category === 'MIXED', both, `trial ${t} position ${pos} is ${category}`);
      if (category === 'MIXED') mixed++;
      if (both) mixedByRuns++;
    }
    // The classes, from the runs: loud when anything the twin placed was
    // refused; silent when nothing was and something was placed; else nothing
    // attributable was touched.
    const all = runs.flat();
    const counted = all.filter((o) => o.touched && o.attributable);
    const loud = counted.some((o) => o.outcome !== 'placed');
    const silent = !loud && counted.some((o) => o.outcome === 'placed');
    const invisibleOnly = !loud && !silent && all.some((o) => o.touched);
    const unchanged = !loud && !silent && !invisibleOnly;
    assert.equal([loud, silent, invisibleOnly, unchanged].filter(Boolean).length, 1);
    const placedPosition = runs.some((r) => {
      const c = r.filter((o) => o.touched && o.attributable);
      return c.length > 0 && c.every((o) => o.outcome === 'placed');
    });
    for (const policy of ['P', 'A'] as const) {
      for (const harm of harms) {
        const got = classifyCapture(categories, harm, policy);
        seen.add(`${got.class}${got.loudAndSilent ? '+silent' : ''}`);
        const want = loud
          ? 'LOUD'
          : silent
            ? harm === null
              ? 'SILENT-UNSOLVED'
              : harm.gTwinMm <= GRID_GATE_MM && harm.gTreatedMm > GRID_GATE_MM
                ? 'SILENT-GATE-BREAKING'
                : harm.dGridMm > harm.tauNullMm
                  ? 'SILENT-BIASED'
                  : 'SILENT-HARMLESS'
            : invisibleOnly
              ? 'INVISIBLE-ONLY'
              : 'UNCHANGED';
        assert.equal(got.class, want, `trial ${t}, policy ${policy}: ${categories.join(', ')}`);
        const keptSilent = policy === 'P' ? placedPosition : counted.some((o) => o.outcome === 'placed');
        assert.equal(got.loudAndSilent, loud && keptSilent, `trial ${t}, policy ${policy}`);
      }
    }
  }
  assert.equal(mixed, mixedByRuns, 'MIXED is not the positions with both a refused and a placed touched run');
  assert.ok(mixed > 0, 'no MIXED position in the sample, so the count above is about nothing');
  for (const want of ['LOUD', 'LOUD+silent', 'SILENT-UNSOLVED', 'SILENT-HARMLESS', 'SILENT-BIASED', 'SILENT-GATE-BREAKING']) {
    assert.ok(seen.has(want), `no capture was ${want}: ${[...seen].join(', ')}`);
  }

  // Every category is reported again with minor and marginal runs excluded
  // (§3.5-3.6): a run whose twin placed it with its worst pair ABOVE 0.10, so
  // within 0.05 of the limit and flippable by noise alone, or decoded to FEWER
  // than 200 correspondences, is not counted as attributable there. The bounds
  // are the spec's, so exactly 0.10 and exactly 200 stay in, and a band or a
  // comparison that moved would move runs between MIXED and PLACED unseen.
  assert.equal(MARGINAL_RESIDUAL, 0.1);
  const run = (projector: number, touched: boolean, refused: boolean): RunOutcome10 => ({
    projector,
    touched,
    attributable: true,
    phaseTouched: touched,
    outcome: refused ? 'refused-complement' : 'placed',
    brokenPair: null,
    brokenPercent: null,
    brokenResidual: null,
    collateral: false,
    falseAlarm: false,
  });
  const refusedAndPlaced = [run(0, true, true), run(1, true, false), run(2, false, false), run(3, false, false)];
  const twinOf = (worst: number, corr: number, corr1 = 5000): TwinStatus[] =>
    RUNS.map((q) => ({
      projector: q,
      placed: true,
      worstResidual: q === 0 ? worst : 0.02,
      correspondences: q === 0 ? corr : q === 1 ? corr1 : 5000,
    }));
  const excluded = { excludeMinorMarginal: true };
  assert.equal(classifyPosition(refusedAndPlaced, twinOf(0.1 + 1e-9, 199)), 'MIXED', 'nothing is excluded unless asked');
  assert.equal(classifyPosition(refusedAndPlaced, twinOf(0.1, 200), excluded), 'MIXED', 'exactly 0.10 and exactly 200 stay in');
  assert.equal(classifyPosition(refusedAndPlaced, twinOf(0.1 + 1e-9, 200), excluded), 'PLACED', 'a marginal run is left out');
  assert.equal(classifyPosition(refusedAndPlaced, twinOf(0.1, 199), excluded), 'PLACED', 'a minor run is left out');
  assert.equal(classifyPosition(refusedAndPlaced, twinOf(0.1, 199, 150), excluded), 'INVISIBLE-ONLY', 'nothing robust was touched');
});

// ---------------------------------------------------------------------------
// T23: the page's own read path
// ---------------------------------------------------------------------------

/** A one-channel grey photograph as the page's canvas hands it over: RGBA, R = G = B, opaque. */
function asCanvasRgba(grey: EncodedImage): EncodedImage {
  assert.equal(grey.channels, 1);
  const data = new Uint8Array(4 * grey.data.length);
  for (let i = 0; i < grey.data.length; i++) {
    data[4 * i] = grey.data[i];
    data[4 * i + 1] = grey.data[i];
    data[4 * i + 2] = grey.data[i];
    data[4 * i + 3] = 255;
  }
  return { width: grey.width, height: grey.height, channels: 4, data, maxValue: 255 };
}

test('T23 the page path runs on encoded frames, and grey reads as the canvas RGBA would', () => {
  // The experiment hands the page ONE grey channel where a browser hands it
  // RGBA. That is a substitution, and it is only honest if the page reads the
  // two the same: `summarisePhoto` reads channel 0 and drops alpha, and a
  // layout slip — alpha where red should be — would read every photograph as
  // full white. Then a clean reduced position goes through the page's own
  // `indexPhotographs` and comes back whole in its accounting, and placed:
  // every run this camera sees under its own projector, each photograph under
  // its own step, and the projector it cannot see said to be out of view rather
  // than refused. Until the page read positions with `indexPosition` this
  // asserted the accounting alone, because the page's capture-wide
  // classification refused every clean bench position (the experiment's
  // precondition stage measured that) and pinning it as passing would have
  // pinned a defect.
  const b = rig();
  const { c, p } = brightestRun(b);
  const summaries = [];
  for (let j = 0; j < STEPS.length; j++) {
    const { projector, frame } = STEPS[j];
    const encoded = encodeSrgb8(
      { width: b.width, height: b.height, channels: 1, data: b.frames[c][projector][frame] },
      ENCODE_FULL_SCALE,
    );
    summaries.push(summarisePhoto(encoded, j, `IMG_${j}.png`, TRANSFER, FINGERPRINT_BLOCKS));
    if (projector === p && [0, 1, 2, 13, 26, 33].includes(frame)) {
      const rgba = summarisePhoto(asCanvasRgba(encoded), j, `IMG_${j}.png`, TRANSFER, FINGERPRINT_BLOCKS);
      assert.deepEqual(rgba.stats, summaries[j].stats, `frame ${frame}: statistics differ between grey and RGBA`);
      assert.deepEqual(rgba.fingerprint, summaries[j].fingerprint, `frame ${frame}: fingerprints differ`);
      assert.equal(rgba.clippedHigh, summaries[j].clippedHigh);
    }
  }
  const indexed = indexPhotographs(summaries, MANIFEST);
  assert.equal(indexed.total, STEPS.length);
  const inRuns = indexed.runs.flatMap((r) => r.ordinals);
  assert.equal(new Set(inRuns).size, inRuns.length, 'a photograph placed twice');
  const unplaced = STEPS.map((_, j) => j).filter((j) => !inRuns.includes(j)).length;
  assert.equal(indexed.placed, inRuns.length);
  assert.equal(indexed.placed + unplaced, STEPS.length);
  const everyProjector = Array.from({ length: PROJECTORS }, (_, q) => q);
  const seen = everyProjector.filter((q) => b.lit[c][q] > 0);
  assert.ok(seen.length > 0 && seen.length < PROJECTORS, 'this needs a camera that sees some projectors and not others');
  assert.deepEqual(indexed.problems, []);
  assert.equal(indexed.ok, true);
  assert.deepEqual(indexed.runs.map((r) => r.projector), seen);
  assert.deepEqual(indexed.unseen, everyProjector.filter((q) => !seen.includes(q)));
  for (const r of indexed.runs) {
    const own = STEPS.flatMap((step, j) => (step.projector === r.projector ? [j] : []));
    assert.deepEqual(r.ordinals, own, `projector ${r.projector + 1}'s run holds photographs of other steps`);
  }

  // The encode inverts through the page's own `decodeTransfer` to within half
  // an 8-bit step, over every 12-bit level the sensor can produce and over the
  // noiseless values of a whole run.
  const levels = Float32Array.from({ length: 4096 }, (_, k) => Math.fround((k * ENCODE_FULL_SCALE) / 4095));
  const values = [levels, ...b.frames[c][p]];
  let checked = 0;
  for (const data of values) {
    const encoded = encodeSrgb8({ width: data.length, height: 1, channels: 1, data }, ENCODE_FULL_SCALE);
    for (let i = 0; i < data.length; i++) {
      const byte = encoded.data[i];
      const x = Math.min(1, data[i] / ENCODE_FULL_SCALE);
      const lo = byte === 0 ? 0 : decodeTransfer((byte - 0.5) / 255, TRANSFER);
      const hi = byte === 255 ? 1 : decodeTransfer((byte + 0.5) / 255, TRANSFER);
      if (!(x >= lo - 1e-12 && x <= hi + 1e-12)) {
        assert.fail(`${data[i]} encodes to ${byte}, which decodes to [${lo}, ${hi}] of full scale, not ${x}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 100000);
});

// ---------------------------------------------------------------------------
// T24: the experiment's own document
// ---------------------------------------------------------------------------

/** The reduced design's document, as T24 wrote it; T37 reads it again rather than run it twice. */
let testPlanText: string | null = null;
/** And its checkpoints, which T43 reads Q0 from. */
let testPlanStore: import('../src/straddle/stages.ts').Store | null = null;

test('T24 deterministic: the reduced design run twice is one document, and it records no time', async () => {
  // `experiments/experiment-10.json` is regenerated by running the CLI, and a
  // regenerated file can only be trusted if every difference from the
  // committed one is a real change in the design or the code. So the document
  // has to be a function of those two alone: the same value on every run, and
  // nothing in it that says when, or where, it was made. A run-to-run
  // difference enters wherever a draw is not named off a seed, an iteration
  // order is not the plan's, or a clock or a path is written down, and it
  // enters silently — the file still looks like a result.
  //
  // So the reduced design (`TEST_PLAN`: s01 at the reduced preset, every stage
  // but the solves, each thinned to seconds) runs twice at once: once in this
  // process, whose module caches T12-T23 have warmed, and once in a fresh one,
  // so a difference between a warm process and a cold one shows as well as a
  // difference between two runs. Both on in-memory checkpoints, so neither
  // reads the other's.
  const { spawn } = await import('node:child_process');
  const { runExperiment10 } = await import('../src/straddle/cli.ts');
  const { TEST_PLAN, memoryStore, runContext } = await import('../src/straddle/stages.ts');
  const { clusteredShare, verdictStatement } = await import('../src/straddle/assemble.ts');
  const cli = new URL('../src/straddle/cli.ts', import.meta.url).href;
  const stages = new URL('../src/straddle/stages.ts', import.meta.url).href;
  const script =
    `const c = await import(${JSON.stringify(cli)});` +
    `const s = await import(${JSON.stringify(stages)});` +
    'const doc = c.runExperiment10(s.runContext(s.TEST_PLAN, s.memoryStore(), () => {}));' +
    'process.stdout.write(JSON.stringify(doc));';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));

  const store = memoryStore();
  const here = runExperiment10(runContext(TEST_PLAN, store, () => {}));
  assert.ok(here !== null, 'the reduced design did not assemble');
  const code = await exited;
  assert.equal(code, 0, `the second run failed: ${Buffer.concat(err).toString()}`);
  const text = JSON.stringify(here, null, 2);
  testPlanText = text;
  testPlanStore = store;
  assert.deepEqual(JSON.parse(Buffer.concat(out).toString()), JSON.parse(text), 'two runs of one design wrote different documents');

  // Non-vacuity: a determinism check of a document with nothing in it is about
  // nothing. Every section is filled, and the cells the verdict reads exist.
  const doc = JSON.parse(text);
  for (const section of ['precondition', 'gate', 'decode', 'pose', 'rescore', 'lateness', 'harness', 'predictions', 'verdict']) {
    assert.ok(doc[section] !== undefined && doc[section] !== null, `no ${section}`);
  }
  assert.ok(doc.gate.crossings.runs.length > 0 && doc.decode.runs > 0, 'no crossing or decode was measured');
  const r1 = doc.rescore.cells.find((c: { id: string }) => c.id === 'R1');
  const late = doc.lateness.cells.find((c: { id: string }) => c.id === 'L-aimed-7.5');
  assert.ok(r1.capturesRecorded > 0 && late.capturesRecorded > 0, 'no touched capture was scored');
  assert.ok(doc.rescore.cells.some((c: { decode: { runs: number } }) => c.decode.runs > 0), 'no subsample was decoded');
  assert.match(doc.verdict.statement, /^The page's reader placed a run in /);
  // The page column ran, so its determinism above is about something: Q0
  // placed runs on the reduced rig and triggered it, the bank stage recorded
  // a page twin for every camera, and every changed position of R1 and
  // L-aimed-7.5 carries the page's reading of it. None of those readings is a
  // crash: `pageRecord` records what the reader throws rather than raising
  // it, and a crash is otherwise a reading that placed nothing.
  assert.equal(doc.precondition.q0.contingency.triggered, true, 'the page column was not triggered');
  const checkpoint = (stage: string) => JSON.parse(store.read(`${stage}.json`) as string);
  const bankTwins = Object.values(checkpoint('bank').units as Record<string, { twins: { camera: number; page?: { crash: string | null } }[] }>).flatMap((u) => u.twins);
  assert.ok(bankTwins.length > 0 && bankTwins.every((t) => t.page !== undefined && t.page !== null), 'a camera has no page twin');
  assert.deepEqual(bankTwins.flatMap((t) => (t.page !== undefined && t.page.crash !== null ? [t.page.crash] : [])), [], 'the page threw on a clean twin');
  for (const [stage, id] of [['rescore', 'R1'], ['lateness', 'L-aimed-7.5']]) {
    type Scored = { changed: boolean; page: { placed: number[]; crash: string | null } | null };
    const changed = Object.entries(checkpoint(stage).units as Record<string, { score?: { cells: Record<string, { positions: Scored[] }[]> } }>)
      .filter(([unit]) => unit.startsWith('A:'))
      .flatMap(([, u]) => (u.score?.cells[id] ?? []).flatMap((cap) => cap.positions.filter((p) => p.changed)));
    assert.ok(changed.length > 0, `${id} changed no position`);
    assert.ok(changed.every((p) => p.page !== null && Array.isArray(p.page.placed)), `${id} has a changed position the page did not read`);
    assert.deepEqual(
      changed.flatMap((p) => (p.page !== null && p.page.crash !== null ? [p.page.crash] : [])),
      [],
      `${id}: the page's reader threw on a changed position`,
    );
    // And the document's summary of the column is about those readings: every
    // one of them read, every capture of the cell classed through the page,
    // every touched run given a verdict and set against the counterfactual's.
    type PageDoc = {
      status: string;
      read: { captures: number; positions: number; crashes: number };
      classes: { P: { counts: Record<string, number> } };
      runs: { touched: number; attributable: number; placed: number; refused: number; noted: number; crashed: number; unaccounted: number; neither: number } & Record<'both' | 'counterfactualOnly' | 'pageOnly', Record<string, Record<string, number>>>;
      positions: { all: Record<string, number> };
      quiet: { runs: number };
    };
    const cell = (stage === 'rescore' ? doc.rescore : doc.lateness).cells.find((c: { id: string }) => c.id === id);
    const page = cell.page as PageDoc;
    assert.equal(page.status, 'read', `${id}: the page column's summary says ${page.status}`);
    assert.deepEqual([page.read.positions, page.read.crashes, page.read.captures], [changed.length, 0, cell.capturesRecorded], `${id}: the summary read other positions than the stage wrote`);
    const classed = ['LOUD', 'SILENT-HARMLESS', 'SILENT-BIASED', 'SILENT-GATE-BREAKING', 'SILENT-UNJUDGEABLE', 'SILENT-UNSOLVED', 'INVISIBLE-ONLY', 'UNCHANGED', 'UNTOUCHED'];
    assert.equal(classed.reduce((a, k) => a + page.classes.P.counts[k], 0), page.read.captures, `${id}: a capture read by the page has no class`);
    const crossed = (['both', 'counterfactualOnly', 'pageOnly'] as const).reduce((a, k) => a + Object.values(page.runs[k]).reduce((b, row) => b + Object.values(row).reduce((c, n) => c + n, 0), 0), 0);
    assert.ok(page.runs.attributable > 0 && page.runs.touched === crossed + page.runs.neither, `${id}: ${JSON.stringify(page.runs)}`);
    assert.equal(page.runs.placed + page.runs.refused + page.runs.noted + page.runs.crashed + page.runs.unaccounted, page.runs.attributable);
    assert.equal(page.runs.unaccounted, 0, `${id}: a run the page gave no verdict`);
    // A quiet drop is an attributable touched run only noted: the same runs the run tally counts noted.
    assert.equal(page.quiet.runs, page.runs.noted, `${id}: quiet drops and noted runs disagree`);
    assert.ok(page.positions.all.PLACED + page.positions.all.MIXED + page.positions.all['REFUSED-ALL'] > 0, `${id}: no position the page counted`);
  }
  // The page twins, and the identities and bets they carry. The reduced rig
  // is at a preset the acceptance sweep never photographed, so I-page-twin is
  // not established here, and says why; Q0 and the page twin read alike.
  const pageTwins = doc.precondition.pageTwins.main;
  assert.equal(pageTwins.read, pageTwins.cameras);
  assert.ok(pageTwins.placed > 0 && pageTwins.crashes === 0, JSON.stringify(pageTwins));
  const identity = (id: string) => doc.harness.find((h: { id: string }) => h.id === id);
  assert.equal(identity('I-page-twin').pass, null);
  assert.deepEqual(identity('I-page-twin').measured.notSwept, { reduced: pageTwins.cameras });
  assert.equal(identity('H8-page').pass, null, 'H8-page passed on a design that renders no hook position');
  const bet = (id: string) => doc.predictions.find((p: { id: string }) => p.id === id);
  assert.equal(bet('P13').measured.compared, doc.precondition.q0.total);
  for (const id of ['P10', 'P11', 'P12', 'P13']) assert.equal(typeof bet(id).falsified, 'boolean', `${id} was not evaluated`);

  // No time, and no machine: no date-time, no epoch milliseconds, no key
  // naming a moment or a duration with anything in it, no absolute path. The
  // manifest's own `written` is such a key, and `design.ts` leaves it empty on
  // purpose; this holds it there.
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, 'the document carries a date-time');
  assert.doesNotMatch(text, /(?<![\d.])1[5-9]\d{11}(?![\d.])/, 'the document carries an epoch-milliseconds number');
  assert.doesNotMatch(
    text,
    /"((generated|created|written|started|finished|updated|run)(At|On|Time)?|timestamp|date|time|when|elapsed\w*|duration\w*|wallClock\w*)"\s*:(?!\s*(""|null\b))/i,
    'the document names a time and fills it',
  );
  assert.doesNotMatch(text, /"\/(home|tmp|root|Users)\//, 'the document carries an absolute path');

  // The one draw the reduced design cannot show: its single rig is a single
  // cluster, so every bootstrap replicate resamples the same rig and the
  // interval comes out the same whatever the stream. Held directly instead, on
  // twelve clusters that differ, so the interval's ends are not a handful of
  // discrete values every stream lands on: the same shares and label give the
  // same interval, and another label — another stream — gives another one.
  const clusters = Array.from({ length: 12 }, (_, i) => ({ num: (7 * i + 3) % 11, den: 11 + (i % 5) }));
  const once = clusteredShare(clusters, 'T24');
  assert.deepEqual(clusteredShare(clusters, 'T24'), once);
  const other = clusteredShare(clusters, 'T24/another stream');
  assert.ok(once.lo !== null && once.hi !== null && once.lo < once.hi, JSON.stringify(once));
  assert.notDeepEqual([other.lo, other.hi], [once.lo, once.hi], 'the interval does not depend on its stream, so a stream that drifted would not show');

  // The verdict is read from the document's cells through `at`, so a document
  // without a cell the sentence quotes stops the sentence. The headline and
  // lateness cells were once looked up with `=== undefined` guards instead, and
  // a document without them printed a verdict with those sentences missing and
  // nothing to say so. Rebuilt from the written document, the sentence is the
  // one the run printed, so these cuts are the only difference.
  assert.equal(verdictStatement(JSON.parse(text)), doc.verdict.statement);
  type Holed = {
    rescore: { cells: { id: string }[] };
    lateness: { cells: { id: string }[] };
    decode: { curve: { direction: string; s: number }[] };
    gate: { crossings: { neverRefused: { forward?: number } } };
  };
  const cuts: [string, (d: Holed) => void][] = [
    ['the headline cell R1', (d) => { d.rescore.cells = d.rescore.cells.filter((c) => c.id !== 'R1'); }],
    ['the lateness cell L-aimed-7.5', (d) => { d.lateness.cells = d.lateness.cells.filter((c) => c.id !== 'L-aimed-7.5'); }],
    ['the forward s = 0.1 decode level', (d) => { d.decode.curve = d.decode.curve.filter((c) => !(c.direction === 'forward' && c.s === 0.1)); }],
    ['the count of runs the scan never refused', (d) => { delete d.gate.crossings.neverRefused.forward; }],
    // And the clause on the page's own reader, which reads R1's page block.
    ['the page\'s run-by-run count in R1', (d) => { delete (d.rescore.cells.find((c) => c.id === 'R1') as unknown as { page: { loud: { runByRun?: number } } }).page.loud.runByRun; }],
    ['the page\'s quiet drops in L-aimed-7.5', (d) => { delete (d.lateness.cells.find((c) => c.id === 'L-aimed-7.5') as unknown as { page: { quiet: { runs?: number } } }).page.quiet.runs; }],
  ];
  for (const [what, cut] of cuts) {
    const holed = JSON.parse(text);
    cut(holed);
    assert.throws(() => verdictStatement(holed), /the verdict needs cell/, `a document without ${what} still got a verdict`);
  }

  // The crossing figures are percentiles over the runs the scan refused, so a
  // run it never refused up to s = 0.5 has no place in them. The sentence
  // left such runs out without a word, and read as if its figures covered
  // every run. It names them now, and says so when there were none to quote.
  const scanned = doc.gate.crossings.scannedTo as number;
  assert.equal(scanned, 0.5);
  const clause = (n: number, of: number) =>
    `; ${n} of the ${of} attributable runs were never refused up to s = ${scanned}, and are not in those figures.`;
  const own = doc.gate.crossings.neverRefused.forward as number;
  const runs = doc.gate.crossings.attributableRuns as number;
  assert.equal(doc.verdict.statement.includes(clause(own, runs)), own > 0, 'the written verdict does not match its own never-refused count');
  const some = JSON.parse(text);
  some.gate.crossings.attributableRuns = 5;
  some.gate.crossings.neverRefused.forward = 2;
  assert.ok(verdictStatement(some).includes(clause(2, 5)), `two runs never refused went unmentioned: ${verdictStatement(some)}`);
  const none = JSON.parse(text);
  none.gate.crossings.attributableRuns = 5;
  none.gate.crossings.neverRefused.forward = 5;
  none.gate.crossings.forward = { ...none.gate.crossings.forward, p10: null, median: null, p90: null };
  assert.match(verdictStatement(none), /refused none of the 5 attributable runs of a whole-position straddle at any smear up to s = 0\.5\./);
});

test('T24b an accepted stale checkpoint stays stale', async () => {
  // EXP10_ACCEPT_STALE resumes from checkpoints another build wrote, and the
  // document says so. That promise held only for the run that used the
  // override: resuming a stage re-stamped its file with this build's
  // fingerprint, so the next run without the override took another build's
  // measurements as its own and its document said no stale checkpoint was
  // used. The stage here has its one unit on disk, so resuming it computes
  // nothing and only rewrites the file, which is the step that re-stamped.
  const { runExperiment10 } = await import('../src/straddle/cli.ts');
  const { CHECKPOINT_SCHEMA, StaleCheckpoint, TEST_PLAN, memoryStore, runContext } = await import(
    '../src/straddle/stages.ts'
  );
  const store = memoryStore();
  const foreign = 'another build';
  store.write(
    'q0.json',
    JSON.stringify({
      schema: CHECKPOINT_SCHEMA,
      fingerprint: foreign,
      stage: 'q0',
      units: { 'main:0': { positions: [], shapes: [], worth: null } },
      complete: false,
    }),
  );
  assert.throws(() => runExperiment10(runContext(TEST_PLAN, store, () => {}), 'q0'), StaleCheckpoint);
  const accepting = runContext(TEST_PLAN, store, () => {}, true);
  runExperiment10(accepting, 'q0');
  assert.deepEqual(accepting.staleAccepted, ['q0.json']);
  const after = JSON.parse(store.read('q0.json') as string);
  assert.equal(after.complete, true, 'the resumed stage was not written back');
  assert.equal(after.fingerprint, foreign, 'resuming under the override re-stamped the checkpoint as this build\'s');
  assert.throws(() => runExperiment10(runContext(TEST_PLAN, store, () => {}), 'q0'), StaleCheckpoint);
});

// ---------------------------------------------------------------------------
// T25-T28: what the full run is held to before it starts
// ---------------------------------------------------------------------------

test('T25 the checkpoint fingerprint covers every stage and none of the document', async () => {
  // A checkpoint answers to the fingerprint of the code that measured it, and
  // the full run is four hours of checkpoints. While the document's assembly
  // was fingerprinted with the stages, an edit to a field or to the verdict's
  // wording after the run had started made every checkpoint stale. So the
  // assembly now lives outside the fingerprint (stages.ts's header). This holds
  // both halves of that line: (a) an edit to the document's modules leaves the
  // fingerprint as it was, (b) an edit to a stage changes it, and (c) the stage
  // module reaches neither document module through any import, and everything
  // it does reach is fingerprinted. (c) is the half that keeps unfingerprinted
  // code out of a measurement. The fingerprint hashes bytes, not imports, so a
  // stage calling into the assembly would be invisible to (a) and (b).
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ts = (await import('typescript')).default;
  const { DOCUMENT_SOURCES, TEST_PLAN, codeFingerprint, measurementFiles } = await import('../src/straddle/stages.ts');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const editing = (suffix: string) => (file: string) =>
    file.split(path.sep).join('/').endsWith(suffix) ? Buffer.concat([fs.readFileSync(file), Buffer.from('\n// an edit\n')]) : fs.readFileSync(file);

  const base = codeFingerprint(TEST_PLAN);
  assert.equal(codeFingerprint(TEST_PLAN, editing('straddle/assemble.ts')), base, 'an edit to the assembly made every checkpoint stale');
  assert.equal(codeFingerprint(TEST_PLAN, editing('straddle/cli.ts')), base, 'an edit to the entry made every checkpoint stale');
  assert.notEqual(codeFingerprint(TEST_PLAN, editing('straddle/stages.ts')), base, 'an edit to a stage left its checkpoints current');
  assert.notEqual(codeFingerprint(TEST_PLAN, editing('straddle/run.ts')), base, 'an edit to the library left its checkpoints current');

  // Everything the stages import, followed file by file from stages.ts:
  // static, type-only and dynamic imports alike.
  const closure = new Set<string>();
  const visit = (abs: string): void => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (closure.has(rel)) return;
    closure.add(rel);
    for (const { fileName } of ts.preProcessFile(fs.readFileSync(abs, 'utf8'), true, true).importedFiles) {
      if (fileName.startsWith('.')) visit(path.resolve(path.dirname(abs), fileName));
    }
  };
  visit(path.join(root, 'packages/experiments/src/straddle/stages.ts'));
  const fingerprinted = new Set(measurementFiles());
  for (const doc of DOCUMENT_SOURCES) {
    assert.ok(fs.existsSync(path.join(root, doc)), `${doc} is not there`);
    assert.ok(!closure.has(doc), `the stages import ${doc}, so their measurements run unfingerprinted code`);
    assert.ok(!fingerprinted.has(doc), `${doc} is fingerprinted`);
  }
  const outside = [...closure].filter((f) => !fingerprinted.has(f));
  assert.deepEqual(outside, [], 'the stages run code the fingerprint does not cover');
  // Not vacuous: the walk reached the library, EXPERIMENT-9's replay and the renderer.
  for (const f of [
    'packages/experiments/src/straddle/run.ts',
    'packages/experiments/src/straddle/bank.ts',
    'packages/experiments/src/straddle/design.ts',
    'packages/experiments/src/tether/run.ts',
    'packages/bench/src/capture.ts',
    'packages/web/src/readback.ts',
  ]) {
    assert.ok(closure.has(f), `the import walk never reached ${f}`);
  }
});

// ---------------------------------------------------------------------------
// A scored capture, written out by hand: the shapes the rescore stage stores
// ---------------------------------------------------------------------------

type Twin = import('../src/straddle/stages.ts').TwinCamera;
type Score = import('../src/straddle/stages.ts').RunScore;
type PosScore = import('../src/straddle/stages.ts').PositionScore;

/** Runs 0-2 placed by the twin, run 3 refused anyway (an invisible projector), at every camera. */
function handTwin(camera: number): Twin {
  return {
    camera,
    placedContent: [0, 1, 2],
    placedFiled: [0, 1, 2],
    placedNoiseless: [0, 1, 2],
    problems: [],
    runs: RUNS.map((p) => ({
      projector: p,
      litShare: p === 3 ? 0 : 0.3,
      placed: p !== 3,
      placedNoiseless: p !== 3,
      worstNoisy: p === 3 ? null : 0.05,
      worstNoiseless: p === 3 ? null : 0.04,
      noiseFloor: p === 3 ? null : 0.01,
      accepted: p === 3 ? 0 : 5000,
      sigmaU: null,
      sigmaV: null,
      marginal: false,
      minor: p === 3,
    })),
    worthUsable: false,
    worthRefusal: null,
  };
}

/**
 * One run's scores. `on` is the noisy verdict where the stage computed one;
 * `w0` the noiseless worst pair it chose by. At a noise floor of 0.01 the
 * widest band (0.05) is [0.09, 0.20] and a 0.01 margin [0.13, 0.16], so 0.19
 * is inside the first and outside the second, 0.05 outside both.
 */
function handRun(o0: Score['o0'], on: Score['on'], w0: Score['w0'], collateral = false): Score {
  const noisy = on !== null;
  return { o0, on, pt0: false, ptn: noisy ? false : null, fa0: false, fan: noisy ? false : null, co0: collateral, con: noisy ? collateral : null, bp: null, w0 };
}

/** A touched position: `runs` gives every run's scores, content and filed footing alike. */
function handPosition(pos: number, touched: number[], runs: Score[]): PosScore {
  return { pos, flagged: true, changed: true, touched, content: runs, filed: runs.map((r) => ({ ...r })), assignment: null, page: null, decodes: [] };
}

const untouchedPosition = (pos: number): PosScore => ({
  pos, flagged: false, changed: false, touched: [], content: [], filed: [], assignment: null, page: null, decodes: [],
});

const placedRun = (): Score => handRun('placed', null, 0.05);
const invisibleRun = (o0: Score['o0'] = 'refused-unanswered'): Score => handRun(o0, null, null);

test('T26 one refine band decides every run, and the cross-cell run tables hold attributable runs only', async () => {
  // Two defects, one capture. First, the refined cells were classified at the
  // margin R1 validated (0.01 in quick) while the stages had chosen their
  // decodes and solves at the widest band (0.05). A run the widest band
  // re-evaluated to placed was then reported refused, beside a solve that had
  // straddled it as placed. Second, `runs.outcomes` tallied the runs the twin
  // refuses anyway beside the attributable ones. R1 evaluates those runs with
  // noise and the refined cells do not, so the tables did not compare across
  // cells. Camera 0's run 1 is the first defect: noiseless refused, noisy
  // placed, at 0.19, inside the widest band and outside 0.01. Camera 2's
  // touched run is the second: refused, and not attributable.
  const { REFINE_CEILING, capturePlan, categoryOf } = await import('../src/straddle/stages.ts');
  const { summariseCell } = await import('../src/straddle/assemble.ts');
  const { TEST_PLAN, latenessCells } = await import('../src/straddle/stages.ts');
  const cell = latenessCells(TEST_PLAN).find((c) => c.id === 'L-aimed-7.5');
  assert.ok(cell !== undefined && cell.mode === 'refine' && REFINE_CEILING === 0.05);
  const cap = {
    t: 0,
    rig: 0,
    positions: [
      handPosition(0, [0], [handRun('refused-complement', 'placed', 0.19), placedRun(), placedRun(), invisibleRun()]),
      untouchedPosition(1),
      // Its refusal names a broken pair, as a complement refusal does, so the
      // broken-pair table has something of its to leave out.
      handPosition(2, [3], [placedRun(), placedRun(), placedRun(), { ...invisibleRun('refused-complement'), bp: 0 }]),
    ],
  };
  const twins = [0, 1, 2].map(handTwin);
  const ev = {
    plan: { ...TEST_PLAN, rigs: [0] },
    bank: { units: { 'main:0': { width: 0, height: 0, seed: 0, twins } } },
    solves: new Map(),
  } as unknown as Parameters<typeof summariseCell>[0];
  const file = { units: { 'A:main:0': { score: { cells: { [cell.id]: [cap] } } } } } as unknown as Parameters<typeof summariseCell>[2];
  const got = summariseCell(ev, cell, file, null);

  // The document reports the position by the band the stage chose by...
  assert.deepEqual(
    { PLACED: got.positions.content.all.PLACED, 'REFUSED-ALL': got.positions.content.all['REFUSED-ALL'], 'INVISIBLE-ONLY': got.positions.content.all['INVISIBLE-ONLY'] },
    { PLACED: 1, 'REFUSED-ALL': 0, 'INVISIBLE-ONLY': 1 },
    'the document classified camera 0 at another band than the stages chose by',
  );
  assert.equal(got.classes.P.counts['SILENT-UNSOLVED'], 1);
  assert.equal(got.classes.P.counts.LOUD, 0);
  assert.deepEqual(got.refineBand, { margin: 0.05, evaluation: 'refine band', runsReEvaluated: 1 });
  // ...which is the band a solve of this capture straddles by.
  assert.equal(categoryOf(cap.positions[0], 'content', twins[0], false), 'PLACED');
  assert.deepEqual(capturePlan(cap, (c) => twins[c], 'A', [])?.positions, [0]);

  // The cross-cell table holds the one attributable touched run; the refused
  // invisible run is counted apart, with how it was evaluated.
  assert.deepEqual(got.runs.outcomes, { placed: 1 }, 'a run the twin refuses anyway is in the cross-cell outcome table');
  assert.deepEqual(got.runs.brokenPairs, {}, 'a run the twin refuses anyway is in the cross-cell broken-pair table');
  assert.deepEqual(got.runs.notAttributable, { touched: 1, evaluatedNoisy: 0, outcomes: { 'refused-complement': 1 } });
  assert.equal(got.runs.touched, 2);
  assert.equal(got.runs.attributableTouched, 1);

  // A checkpoint scored at another band is refused, not re-described: run 1
  // of camera 0 at 0.30 sits outside the widest band yet carries a noisy verdict.
  const stale = structuredClone(cap);
  stale.positions[0].content[0] = handRun('refused-complement', 'placed', 0.3);
  const staleFile = { units: { 'A:main:0': { score: { cells: { [cell.id]: [stale] } } } } } as unknown as Parameters<typeof summariseCell>[2];
  assert.throws(() => summariseCell(ev, cell, staleFile, null), /refine band at 0\.05 does not ask for/);
});

test('T27 a solve withholds every run the page would not decode, and P borrows A when the plans agree', async () => {
  // Two defects in what a capture solve is handed. First, the spec withheld
  // only a MIXED position's refused runs. A collateral refusal inside a PLACED
  // position (an untouched run the page refuses because a neighbour's slip
  // moved its bookends) was still handed to the treated solve, rendered clean,
  // though the page decodes nothing of a run it refuses. Second, the lateness
  // cell solves under policy A alone. Its SILENT captures, which hold no MIXED
  // position, were reported unsolved under P, though P's plan for them is A's
  // plan: the same positions and the same exclusions, so the same solve id.
  const { capturePlan, solvePlan, solveId } = await import('../src/straddle/stages.ts');
  const twins = [0, 1, 2].map(handTwin);
  const twinOf = (c: number) => twins[c];
  const refusedClean = ['0.3', '1.3', '2.3'];

  // Camera 0 PLACED, its untouched run 2 refused by the bookends (collateral);
  // camera 1 REFUSED-ALL; camera 2 untouched. No MIXED position.
  const loudSilent = {
    t: 7,
    rig: 0,
    positions: [
      handPosition(0, [0], [placedRun(), placedRun(), handRun('refused-bookends-kind', null, 'x', true), invisibleRun()]),
      handPosition(1, [1], [placedRun(), handRun('refused-complement', null, 0.4), placedRun(), invisibleRun()]),
      untouchedPosition(2),
    ],
  };
  const a = capturePlan(loudSilent, twinOf, 'A', refusedClean);
  assert.deepEqual(a, { positions: [0], exclude: ['0.2', '0.3', '1.3', '2.3'] }, 'the collateral refusal inside the PLACED position was handed to the solve');
  assert.deepEqual(capturePlan(loudSilent, twinOf, 'P', refusedClean), a);
  const lateness = solvePlan(loudSilent, twinOf, refusedClean, ['A']);
  assert.equal(lateness.pIsA, true, 'P was left unsolved where its plan is A\'s');
  assert.equal(lateness.p, null, 'P was planned as a second solve of the same thing');
  const spec = (plan: { positions: number[]; exclude: string[] }) => solveId({
    kind: 'capture', rig: 0, variant: 'reduced', straddle: `L-aimed-7.5/t7/[${plan.positions.join(',')}]`, exclude: plan.exclude, captureSeed: null,
  });
  assert.equal(spec(capturePlan(loudSilent, twinOf, 'P', refusedClean) as NonNullable<typeof a>), spec(a as NonNullable<typeof a>));

  // Camera 0 MIXED, camera 1 PLACED: A straddles both and withholds the
  // MIXED position's refused run, P straddles camera 1 alone. The plans
  // differ, so P borrows nothing: unsolved where only A was asked for,
  // solved on its own where both were.
  const mixed = {
    t: 8,
    rig: 0,
    positions: [
      handPosition(0, [0, 1], [placedRun(), handRun('refused-complement', null, 0.4), placedRun(), invisibleRun()]),
      handPosition(1, [2], [placedRun(), placedRun(), placedRun(), invisibleRun()]),
      untouchedPosition(2),
    ],
  };
  assert.deepEqual(capturePlan(mixed, twinOf, 'A', refusedClean), { positions: [0, 1], exclude: ['0.1', '0.3', '1.3', '2.3'] });
  assert.deepEqual(capturePlan(mixed, twinOf, 'P', refusedClean), { positions: [1], exclude: refusedClean });
  assert.deepEqual(solvePlan(mixed, twinOf, refusedClean, ['A']), { a: capturePlan(mixed, twinOf, 'A', refusedClean), p: null, pIsA: false });
  assert.deepEqual(solvePlan(mixed, twinOf, refusedClean, ['A', 'P']).p, capturePlan(mixed, twinOf, 'P', refusedClean));

  // The borrow decided is the borrow applied. With `pIsA` right and the
  // answers still solved plan by plan, P went back to unsolved and every
  // assertion above still passed, because solveCapture's last lines sat below
  // every test. A stub solve stands in for runScenario and counts its calls.
  const { policyAnswers } = await import('../src/straddle/stages.ts');
  const answering = (plans: Parameters<typeof policyAnswers>[0]) => {
    const solved: string[] = [];
    const got = policyAnswers(plans, (plan) => {
      solved.push(plan.positions.join(','));
      return { treated: `t${solved.length}`, twin: 'x' };
    });
    return { ...got, solved };
  };
  const borrowed = answering(lateness);
  assert.deepEqual(borrowed.solved, ['0'], "A's plan was not solved exactly once");
  assert.ok(borrowed.p !== null && borrowed.p === borrowed.a, "P was not answered by A's own solve where its plan is A's");
  const own = answering(solvePlan(mixed, twinOf, refusedClean, ['A', 'P']));
  assert.deepEqual(own.solved, ['0,1', '1']);
  assert.deepEqual([own.a?.treated, own.p?.treated], ['t1', 't2'], 'P borrowed a plan that is not its own');
  const unasked = answering(solvePlan(mixed, twinOf, refusedClean, ['A']));
  assert.deepEqual([unasked.solved, unasked.p], [['0,1'], null], 'P was solved where it was not asked for and its plan is not A\'s');

  // And solveCapture applies it, as the lateness cell calls it (policy A
  // alone). Every solve it may ask for is already on record, so solveOnce
  // answers from ctx.solves and nothing is rendered; a solve it was not
  // expected to ask for would reach runScenario with a rig of nothing and fail.
  const { TEST_PLAN, latenessCells, memoryStore, runContext, solveCapture } = await import('../src/straddle/stages.ts');
  const cell = latenessCells(TEST_PLAN).find((c) => c.id === 'L-aimed-7.5');
  assert.ok(cell !== undefined);
  const ctx = runContext(TEST_PLAN, memoryStore(), () => {});
  const planA = a as NonNullable<typeof a>;
  const known = {
    twin: solveId({ kind: 'twin', rig: 0, variant: 'reduced', straddle: 'none', exclude: refusedClean, captureSeed: null }),
    withheld: solveId({ kind: 'twin', rig: 0, variant: 'reduced', straddle: 'none', exclude: planA.exclude, captureSeed: null }),
    treated: solveId({ kind: 'capture', rig: 0, variant: 'reduced', straddle: `${cell.id}/t7/[0]`, exclude: planA.exclude, captureSeed: null }),
  };
  for (const id of Object.values(known)) ctx.solves.set(id, { id } as never);
  const rc = { unit: 'main:0', bank: { cameras: [0, 1, 2], height: 1 }, twins: new Map(twins.map((t) => [t.camera, t])) };
  const answered = solveCapture(ctx, rc as never, cell, loudSilent, ['A']);
  const pair = { treated: known.treated, twin: known.withheld };
  assert.deepEqual(answered, { cell: cell.id, t: 7, rig: 0, a: pair, p: pair, pIsA: true }, 'the lateness cell left P unsolved beside the solve that answers it');
});

test("T28 the R audit is EXPERIMENT-9's own count, and at its trial count its committed file", async () => {
  // The audit is what holds this experiment's replay to the shots EXPERIMENT-9
  // counted. It once restated runTrial's and summarise's accounting instead of
  // calling them, and a restated reducer can drift from the one it copies.
  // It calls runTrial now, on the seed the re-scoring draws its shots under,
  // and keeps only the reduction over trials. Here that reduction is held to
  // EXPERIMENT-9's own summarise on every audited cell at a short count, and
  // the headline cell to the committed file at 2000 trials, exactly.
  const fs = await import('node:fs');
  const { TEST_PLAN, recountCell, stageAudit } = await import('../src/straddle/stages.ts');
  const { TRIALS } = await import('../src/straddle/design.ts');
  assert.ok(HEADLINE !== undefined);
  const committed = JSON.parse(fs.readFileSync(new URL('../../../experiments/experiment-9.json', import.meta.url), 'utf8')) as {
    cells: Record<string, unknown>[];
  };
  // Every audited cell at 60 trials: stageAudit throws unless each recount is
  // summarise's own figures, and 60 is not EXPERIMENT-9's count, so no cell is
  // compared with the file here.
  const audit = stageAudit({ ...TEST_PLAN, auditTrials: 60 });
  assert.equal(audit.length, 18);
  for (const a of audit) assert.ok(a.summarised && a.committed === null && !a.equal, JSON.stringify(a));
  assert.ok(audit.some((a) => a.recount.capturesTouched > 0), 'no audited cell touched a capture in 60 trials');

  const cell = committed.cells.find(
    (c) => c.key === HEADLINE.key && c.startPhase === 'uniform' && c.dwellS === DWELL_S && c.exposureS === EXPOSURE_S,
  );
  assert.ok(cell !== undefined && cell.trials === TRIALS);
  const { recount } = recountCell(HEADLINE, 'uniform', EXPOSURE_S, TRIALS);
  assert.deepEqual(recount, Object.fromEntries(Object.keys(recount).map((f) => [f, cell[f]])), 'the headline replay is not the committed cell');
  assert.equal(recount.capturesTouched, 728);
});

test('T29 a stage that starts while another is appending reads only whole solve lines', async () => {
  // Pose, rescore and lateness can run as three processes sharing
  // solves.jsonl, one write per line. Lines never interleave, but a stage that
  // starts while another is mid-append can read a line cut off at the end of
  // the file. A stress test of three appending processes against a reading
  // one saw it 2 times in 385,621 reads, and JSON.parse stopped the stage that
  // was starting. The cut-off tail is left for the next read, and nothing
  // else is: a whole line that does not parse is still an error.
  const { CHECKPOINT_SCHEMA, TEST_PLAN, loadSolves, memoryStore, runContext } = await import('../src/straddle/stages.ts');
  const store = memoryStore();
  const ctx = runContext(TEST_PLAN, store, () => {});
  const line = (id: string) => JSON.stringify({ schema: CHECKPOINT_SCHEMA, fingerprint: ctx.fingerprint, id, spec: null });
  store.append('solves.jsonl', line('twin/one'));
  store.append('solves.jsonl', line('twin/two'));
  const third = line('capture/three');
  store.write('solves.jsonl', `${store.read('solves.jsonl')}${third.slice(0, 40)}`);
  loadSolves(ctx);
  assert.deepEqual([...ctx.solves.keys()], ['twin/one', 'twin/two'], 'a line still being written was read');
  store.write('solves.jsonl', `${store.read('solves.jsonl')}${third.slice(40)}\n`);
  loadSolves(ctx);
  assert.deepEqual([...ctx.solves.keys()], ['twin/one', 'twin/two', 'capture/three'], 'the finished line was not read');
  store.append('solves.jsonl', third.slice(0, 40));
  assert.throws(() => loadSolves(ctx), SyntaxError, 'a whole line that does not parse was passed over');
});

test('T30 asking for the document and not getting one is a failure', async () => {
  // `--stage assemble` with a stage still missing said "not writing a results
  // file" and exited 0, as a single measuring stage does. The full run's
  // plan ends by assembling after three stages run side by side, so a script
  // following it would carry on as if the document were new. The checkpoint
  // root here is an empty directory, so nothing can be assembled from it and
  // nothing may be written into it.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { main } = await import('../src/straddle/cli.ts');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'exp10-t30-'));
  try {
    assert.equal(main(['--quick', '--stage', 'assemble'], work), 1, 'an assembly that wrote nothing reported success');
    assert.deepEqual(fs.readdirSync(work, { recursive: true }), [], 'an assembly with nothing to assemble wrote something');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T31-T37: what the first full run's verification found, and the re-run adds
// ---------------------------------------------------------------------------

/** A correspondence at camera pixel (x, y) decoding to (u, v), for hand-built decodes. */
function handCorrespondence(x: number, y: number, u: number, v: number): Correspondence {
  return { camera: 0, projector: 0, camU: x + 0.5, camV: y + 0.5, projU: u, projV: v, sigmaU: 0.1, sigmaV: 0.1, modulation: 1, timeU: 0, timeV: 0 };
}

test("T31 H7's flip clause counts Gray words: a flip that moves nothing counts, a phase shift of any size does not", async () => {
  // The first full run counted "confident flips" as decodes that moved half a
  // period or more. That is a displacement: a correct Gray word with a phase
  // error can move a decode by up to 0.65 of a period, and a flipped word can
  // leave it exactly where it was, when the unwrap finds the same fringe from
  // the neighbouring bin. The Gray word is now read as the decoder reads it,
  // with the phase withheld (`decodeGrayOnly`), and compared pixel by pixel.
  const { pixelTallies, neighbourOf, shiftBetween, halves, halfMasks } = await import('../src/straddle/stages.ts');
  const b = rig();
  const { c, p } = brightestRun(b);
  const none = new Uint8Array(b.width * b.height);
  const cleanFrames = runImages(b, c, p, CLEAN);
  const clean = decodeRun(c, p, cleanFrames).correspondences;
  const cleanGray = decodeGrayOnly(c, p, cleanFrames).correspondences;

  // The Gray-only decode is the full decode's own Gray address: every pixel the
  // full decode accepts has one, and the unwrap keeps the full coordinate within
  // 0.4 of a period of that bin's centre (`unwrapToleranceFrac`).
  const grayAt = new Map(cleanGray.map((x) => [pixelKey(x), x]));
  for (const x of clean) {
    const g = grayAt.get(pixelKey(x));
    assert.ok(g !== undefined, `pixel (${x.camU}, ${x.camV}) decodes whole with no Gray address`);
    assert.ok(Math.abs(g.projU - x.projU) <= 0.4 * PERIOD_PX.u + 1e-9 && Math.abs(g.projV - x.projV) <= 0.4 * PERIOD_PX.v + 1e-9);
  }
  const tally = (photos: readonly Photo[]) => {
    const frames = runImages(b, c, p, photos);
    const got = decodeRun(c, p, frames).correspondences;
    return { t: pixelTallies(clean, got, cleanGray, decodeGrayOnly(c, p, frames).correspondences, none, b.width), shift: shiftBetween(clean, got) };
  };

  // The u axis's least significant plane and its complement, each filed in the
  // other's place: the bit reads inverted, and trusted. (A lone straddle cannot
  // do it: the complement it is compared with is still whole.) Where the unwrap
  // still finds the true fringe from the neighbouring bin, the pixel keeps its
  // coordinate and its word changed, so flips outnumber the decodes that moved
  // half a period; and none of them is on v.
  const lsb = planFrames(PLAN).findIndex((spec) => spec.kind === 'gray' && spec.axis === 'u' && spec.index === PLAN.grayBits - 1);
  const k = p * FRAMES_PER_RUN + lsb;
  const swapped = CLEAN.map((photo, j) => (j === k ? { filedStep: j, rows: CLEAN[k + 1].rows } : j === k + 1 ? { filedStep: j, rows: CLEAN[k].rows } : photo));
  const flipped = tally(swapped);
  assert.ok(flipped.t.grayFlips.u > 0 && flipped.t.grayFlips.v === 0 && flipped.t.grayFlips.either === flipped.t.grayFlips.u, JSON.stringify(flipped.t.grayFlips));
  assert.ok(flipped.t.grayFlips.u > flipped.shift.movedHalfPeriod, `${flipped.t.grayFlips.u} flips, ${flipped.shift.movedHalfPeriod} moved half a period: no flip that moved nothing`);
  // A u phase step smeared into the next moves coordinates and flips no word.
  const firstPhase = planFrames(PLAN).findIndex((spec) => spec.kind === 'phase');
  const phase = tally(lone('forward', p * FRAMES_PER_RUN + firstPhase + 1, 0.4));
  assert.ok(phase.shift.moved > 100 && phase.t.grayFlips.either === 0, `${phase.shift.moved} moved, ${phase.t.grayFlips.either} flips`);
  // And the identity itself, on the rendered whole-run blend up to and between
  // the onsets: Gray-ambiguous pixels are refused, and no accepted word changes.
  // At 0.5 the MSB-lit half has no modulation left and little else survives.
  for (const s of [0.3, 0.45, 0.5]) {
    const whole = tally(designedPhotos('forward', () => s, 1));
    assert.ok((s === 0.5 || whole.t.grayFlips.matched > 1000) && whole.t.grayFlips.either === 0, `s = ${s}: ${JSON.stringify(whole.t.grayFlips)}`);
  }

  // The per-pixel signs, the seam apart, on decodes built by hand: pixel (1, 0)
  // and (2, 1) are the seam, (0, 1) is accepted after and not before.
  const W = 4;
  const seam = new Uint8Array(8);
  seam[1] = 1;
  seam[1 * W + 2] = 1;
  const before = [handCorrespondence(0, 0, 10, 10), handCorrespondence(1, 0, 20, 20), handCorrespondence(2, 1, 30, 30), handCorrespondence(3, 1, 40, 40)];
  const after = [handCorrespondence(0, 0, 10, 9.5), handCorrespondence(1, 0, 20.5, 20.25), handCorrespondence(2, 1, 29, 30), handCorrespondence(0, 1, 5, 5)];
  const words = (x: Correspondence) => handCorrespondence(x.camU - 0.5, x.camV - 0.5, 15, 25);
  const grayBefore = [...before, handCorrespondence(0, 1, 15, 25)].map(words);
  const grayAfter = [...after].map(words);
  grayAfter[1] = handCorrespondence(1, 0, 45, 25);
  const hand = pixelTallies(before, after, grayBefore, grayAfter, seam, W);
  assert.deepEqual(hand.grayFlips, { matched: 3, u: 1, v: 0, either: 1 });
  assert.deepEqual(hand.signs.seam, { pixels: 2, uPos: 1, uNeg: 1, vPos: 1, vNeg: 0, maxAbsU: 1, maxAbsV: 0.25 });
  assert.deepEqual(hand.signs.rest, { pixels: 1, uPos: 0, uNeg: 0, vPos: 0, vNeg: 1, maxAbsU: 0, maxAbsV: 0.5 });
  assert.throws(() => pixelTallies(before, after, grayBefore.slice(1), grayAfter, seam, W), /has no Gray address/);

  // The seam's neighbour is the page's: the next projector forward, the one
  // before backward, and none past either end.
  for (let q = 0; q < PROJECTORS; q++) {
    assert.equal(neighbourOf(q, 'forward'), q + 1 < PROJECTORS ? q + 1 : null, `run ${q + 1} forward`);
    assert.equal(neighbourOf(q, 'backward'), q > 0 ? q - 1 : null, `run ${q + 1} backward`);
  }
  // And what it lights is the bank's own count of lit pixels.
  for (const cc of b.cameras) {
    for (let q = 0; q < PROJECTORS; q++) assert.equal(litMask(b, cc, q).reduce((a, x) => a + x, 0), b.lit[cc][q], `camera ${cc} projector ${q + 1}`);
  }
  // At the decoder's own floor, not a margin above it. The noiseless bank has no
  // pixel near the floor, so four are set either side of it: a white 1.5, 1.01,
  // 0.99 and 0.5 floors above its black.
  {
    const floor = DEFAULT_DECODE_OPTIONS.minModulation;
    const cc = b.cameras[0];
    const white = new Float32Array(b.frames[cc][0][WHITE]);
    const black = new Float32Array(b.frames[cc][0][BLACK]);
    const above = [1.5, 1.01, 0.99, 0.5];
    above.forEach((k, i) => {
      black[i] = 0.25;
      white[i] = 0.25 + k * floor;
    });
    const frames = b.frames.map((perCamera, ci) =>
      ci !== cc ? perCamera : perCamera.map((run, q) => (q !== 0 ? run : run.map((f, fi) => (fi === WHITE ? white : fi === BLACK ? black : f)))),
    );
    assert.deepEqual([...litMask({ ...b, frames }, cc, 0).subarray(0, above.length)], [1, 1, 0, 0]);
  }
  // A half's `inView` is every pixel the geometric truth puts on it, lit or not,
  // which is what an untestable onset check reports.
  const h = halves(c, p, cleanFrames, halfMasks(b, c, p));
  const u = b.truth[c][p].projU;
  let dark = 0;
  let lit = 0;
  for (let i = 0; i < u.length; i++) {
    if (Number.isNaN(u[i])) continue;
    if (u[i] < PROJECTOR_RES.x / 2) dark++;
    else lit++;
  }
  assert.deepEqual([h.dark.inView, h.lit.inView], [dark, lit]);
  assert.ok(h.dark.inView > h.dark.accepted && h.lit.inView > h.lit.accepted, JSON.stringify(h));
});

/** A decode run for H7 by hand: its clean halves, and a level per (direction, s). */
function h7Run(
  rig: number,
  projector: number,
  clean: { darkAccepted: number; darkInView?: number; litAccepted: number },
  levels: { direction: 'forward' | 'backward'; s: number; darkAmbiguous?: number; litAccepted?: number; flips?: number; moved?: number }[],
) {
  const half = (inView: number, accepted: number, grayAmbiguous = 0) => ({ inView, accepted, grayAmbiguous, lowModulation: 0 });
  return {
    rig,
    camera: 0,
    projector,
    cleanHalves: { dark: half(clean.darkInView ?? 500, clean.darkAccepted, 3), lit: half(500, clean.litAccepted) },
    levels: levels.map((l) => ({
      direction: l.direction,
      s: l.s,
      accepted: 0,
      statsDelta: {},
      shift: { movedHalfPeriod: l.moved ?? 0, gross: 0 },
      ratioU: null,
      ratioV: null,
      truth: { meanU: null, meanV: null, medianAbs: null, p95Abs: null },
      mm: { errorMedian: null, errorP95: null, shiftMean: null, shiftMedian: null, shiftP95: null },
      halves: l.s >= 0.3 ? { dark: half(500, 10, 3 + (l.darkAmbiguous ?? 0)), lit: half(500, l.litAccepted ?? 0) } : null,
      grayFlips: { matched: 100, u: l.flips ?? 0, v: 0, either: l.flips ?? 0 },
      signs: { seam: { pixels: 0, uPos: 0, uNeg: 0, vPos: 0, vNeg: 0, maxAbsU: 0, maxAbsV: 0 }, rest: { pixels: 0, uPos: 0, uNeg: 0, vPos: 0, vNeg: 0, maxAbsU: 0, maxAbsV: 0 } },
    })),
  };
}

test('T32 H7 is judged clause by clause: untestable checks apart, every failing run listed, flips from Gray words', async () => {
  // The first full run's H7 said "failed" over 49 of 2023 checks. 48 were onset
  // checks on runs whose clean decode accepts no MSB-dark pixel, which cannot
  // test the identity; the 49th was a phase error at a seam, counted as a flip
  // because the flip clause counted decodes moved half a period; and the list
  // was cut at 40, which hid one rig's nine.
  const { evaluateH7, h7Pass } = await import('../src/straddle/assemble.ts');
  const grid = [0.1, 0.3, 0.43, 0.5];
  const onsetsHold = (d: 'forward' | 'backward') => [
    { direction: d, s: 0.1 },
    { direction: d, s: 0.3 },
    { direction: d, s: 0.43, darkAmbiguous: 50 },
    { direction: d, s: 0.5, darkAmbiguous: 80 },
  ];
  // Run 1 of rig 0 decodes no MSB-dark pixel at all; run 2 of rig 3 holds every
  // clause; run 2 of rig 6 has one seam pixel moved half a period, no word changed.
  const good = [
    h7Run(0, 0, { darkAccepted: 0, darkInView: 0, litAccepted: 40 }, [...onsetsHold('forward').map((l) => ({ ...l, darkAmbiguous: 0 })), ...onsetsHold('backward').map((l) => ({ ...l, darkAmbiguous: 0 }))]),
    h7Run(3, 1, { darkAccepted: 40, litAccepted: 40 }, onsetsHold('forward')),
    h7Run(6, 1, { darkAccepted: 40, litAccepted: 40 }, onsetsHold('forward').map((l) => (l.s === 0.43 ? { ...l, moved: 1 } : l))),
  ];
  const h = evaluateH7(good, grid);
  assert.equal(h.clauses.darkOnset.untestable, 6, 'the run with no MSB-dark pixel was not counted apart');
  assert.deepEqual(h.clauses.darkOnset.untestableRuns, ['rig 0 camera 0 run 1: 6 checks; no MSB-dark pixel is in view']);
  assert.equal(h.failures, 0, JSON.stringify(h.clauses));
  assert.deepEqual([h.checks, h.testable, h.untestable], [h.clauses.darkOnset.checks + h.clauses.flips.checks + h.clauses.litLoss.checks, h.checks - 6, 6]);
  assert.equal(h.clauses.flips.checks, 16, 'every level below 5/9 is a flip check');
  assert.deepEqual(h.displacements.cases, ['rig 6 camera 0 run 2 forward 0.43: 1 moved half a period or more, 0 Gray words changed']);
  assert.equal(h.everyClauseTested, true);
  assert.deepEqual(h.flipOnset, { claimedFrom: 0.5556, highestDecoded: 0.5, bracketed: false });
  assert.equal(evaluateH7(good, [...grid, 0.6]).flipOnset.bracketed, true);

  // A word changed is a failure; so is an onset that does not happen, on a run
  // that can show it. Forty-five failing runs are forty-five lines.
  const failing = Array.from({ length: 45 }, (_, i) =>
    h7Run(9 + i, 2, { darkAccepted: 40, litAccepted: 40 }, onsetsHold('forward').map((l) => (l.s === 0.5 ? { ...l, darkAmbiguous: 0, flips: 2 } : l))),
  );
  const bad = evaluateH7([...good, ...failing], grid);
  assert.equal(bad.clauses.flips.failures, 45);
  assert.equal(bad.clauses.darkOnset.failures, 45);
  assert.equal(bad.clauses.darkOnset.failingRuns.length, 45, 'the failing runs were cut short');
  assert.equal(bad.clauses.flips.failingRuns[44], 'rig 53 camera 0 run 3: forward 0.5: 2 Gray words changed (u 2, v 0)');
  // An MSB-lit half still decoding at 0.5 fails; a run with none to lose cannot.
  const lit = evaluateH7([h7Run(1, 0, { darkAccepted: 40, litAccepted: 40 }, onsetsHold('forward').map((l) => (l.s === 0.5 ? { ...l, litAccepted: 7 } : l))), h7Run(2, 0, { darkAccepted: 40, litAccepted: 0 }, onsetsHold('forward'))], grid);
  assert.deepEqual([lit.clauses.litLoss.failures, lit.clauses.litLoss.untestable], [1, 1]);
  // Judged: failed by any testable failure, passed only when every clause was tested.
  assert.equal(h7Pass(bad), false);
  assert.equal(h7Pass(h), true);
  const noOnsets = good.map((r) => ({ ...r, levels: r.levels.filter((l) => l.s < 0.3) }));
  assert.equal(evaluateH7(noOnsets, [0.1]).everyClauseTested, false, 'runs with no onset level still tested the onsets');
  assert.equal(h7Pass(evaluateH7(noOnsets, [0.1])), null, 'H7 passed with a clause never tested');
});

test("T33 a position re-shot alone: the merged capture is the plain one but for the re-shot camera, whose pairs are the whole re-shoot's", async () => {
  // The first full run judged a straddle against re-shooting the WHOLE capture,
  // every camera's photons renewed. What an operator re-shoots is one position,
  // so the re-run adds that null: the straddled camera photographed again under
  // the whole re-shoots' own seeds, merged into the scenario's own capture as
  // it is rendered, and solved by the bench's own runScenario.
  const { TEST_PLAN, memoryStore, nullSpecs, reshotPairs, runContext, solveId, solveNulls, solveRunOptions, swapInReshoot } = await import('../src/straddle/stages.ts');
  const b = rig();
  const runOptions: RunOptions = { preset: b.preset, outDir: '', repoRoot: '', writeArtifacts: false, baseline: false, plan: PLAN };
  const base = captureOptionsFor(b.world, b.scenario, runOptions, PLAN);
  const seed = 0x5eed;
  const byPair = (xs: readonly Correspondence[]): Map<string, Correspondence[]> => {
    const out = new Map<string, Correspondence[]>();
    for (const x of xs) out.set(`${x.camera}.${x.projector}`, [...(out.get(`${x.camera}.${x.projector}`) ?? []), x]);
    return out;
  };
  const capture = (options: typeof base) => byPair(captureAndDecode(b.world.truthRig, b.world.cameras, options).correspondences);
  const plain = capture(base);
  const whole = capture({ ...base, seed });
  const camera = 1;
  const merged = capture({ ...base, onCapture: swapInReshoot(camera, reshotPairs(b, camera, seed)) });
  let differs = 0;
  for (const [key, xs] of plain) {
    const c = Number(key.split('.')[0]);
    assert.deepEqual(merged.get(key), c === camera ? whole.get(key) : xs, `pair ${key}`);
    if (c === camera && JSON.stringify(whole.get(key)) !== JSON.stringify(xs)) differs++;
  }
  assert.equal(merged.size, plain.size);
  assert.ok(differs > 0, 'the re-shoot drew the same photons, so the merge is untested');
  // Re-shot under the scenario's own seed, the merge is the plain capture itself.
  assert.deepEqual(capture({ ...base, onCapture: swapInReshoot(camera, reshotPairs(b, camera, b.seed)) }), plain);

  // Its solves: the same seeds as the whole re-shoots, the rig's straddled
  // camera named (rig 3 straddles camera 1), and no capture seed for
  // runScenario, which would re-shoot every camera.
  const specs = nullSpecs(3, 'reduced', ['0.3', '1.0'], 2);
  assert.deepEqual(specs.position.map((x) => x.captureSeed), specs.whole.map((x) => x.captureSeed));
  assert.ok(specs.position.every((x) => x.kind === 'position-null' && x.reshotCamera === 1) && specs.whole.every((x) => x.kind === 'null' && x.reshotCamera === undefined));
  // Solved into the right lists, each against the plain twin: every solve on
  // record, so nothing renders.
  const ctx = runContext(TEST_PLAN, memoryStore(), () => {});
  for (const spec of [...specs.whole, ...specs.position]) ctx.solves.set(solveId(spec), { id: solveId(spec) } as never);
  assert.deepEqual(solveNulls(ctx, b, specs, { id: 'plain' } as never), { nulls: specs.whole.map(solveId), positionNulls: specs.position.map(solveId) });
  assert.equal(solveRunOptions(b, specs.whole[0]).captureSeed, specs.whole[0].captureSeed);
  assert.equal(solveRunOptions(b, specs.position[0]).captureSeed, undefined, 'a position re-shoot re-shot every camera');
  assert.deepEqual(solveRunOptions(b, specs.position[0]).excludePairs, [{ camera: 0, projector: 3 }, { camera: 1, projector: 0 }]);
  assert.throws(() => solveRunOptions(b, { ...specs.whole[0], reshotCamera: 1 }), /re-shot camera/);
  assert.throws(() => solveRunOptions(b, { ...specs.position[0], reshotCamera: undefined }), /re-shot camera/);
  assert.notEqual(solveId(specs.position[0]), solveId({ ...specs.position[0], reshotCamera: 0 }), 'two cameras re-shot under one seed share an id');
});

/** A solve on record, for the assembly to judge: grid and rotation against truth, D_grid against its twin. */
function handSolve(id: string, gridMm: number, extra: { dGridMm?: number; censored?: boolean; rotationDeg?: number; gridCensored?: boolean } = {}) {
  return {
    schema: '',
    fingerprint: '',
    id,
    spec: null,
    error: null,
    alignedRig: null,
    gridMm,
    gridCensored: extra.gridCensored ?? false,
    rotationDeg: extra.rotationDeg ?? 0.01,
    correspondences: 0,
    audit: null,
    against: extra.dGridMm === undefined ? null : { twinId: 'twin', dGridMm: extra.dGridMm, p95Mm: null, rmsMm: null, censored: extra.censored ?? false, positionShiftMm: 0 },
  };
}

test('T34 a solve whose harm cannot be read is unjudgeable; the loud are split by what they read; the silent are judged at every yardstick', async () => {
  // Five corrections to how a cell's captures are reported. A censored D_grid,
  // or a twin that misses the seam gate on its own, was tallied HARMLESS or
  // BIASED. The loud captures were one number, though a position refused whole
  // and a run refused with "Re-shoot projector N" ask the operator for
  // different things. The total past the gate left out the loud captures whose
  // silent part still broke it. HARMLESS was drawn at τ alone. And the overlap
  // of GATE-BREAKING and "within re-shoot noise" was never tallied.
  const { summariseCell } = await import('../src/straddle/assemble.ts');
  const { TEST_PLAN, latenessCells } = await import('../src/straddle/stages.ts');
  const cell = latenessCells(TEST_PLAN).find((c) => c.id === 'L-aimed-7.5');
  assert.ok(cell !== undefined);
  const twins = [0, 1, 2].map(handTwin);
  const placedAt = (pos: number) => handPosition(pos, [0], [placedRun(), placedRun(), placedRun(), invisibleRun()]);
  const refusedAt = (pos: number, kind: Score['o0'], w0: Score['w0'] = 'x') => handPosition(pos, [0], [handRun(kind, null, w0), placedRun(), placedRun(), invisibleRun()]);
  const silent = (t: number) => ({ t, rig: 0, positions: [placedAt(0), untouchedPosition(1), untouchedPosition(2)] });
  const caps = [
    silent(1),
    silent(2),
    silent(3),
    silent(4),
    { t: 5, rig: 0, positions: [refusedAt(0, 'refused-bookends-count'), untouchedPosition(1), untouchedPosition(2)] },
    { t: 6, rig: 0, positions: [refusedAt(0, 'refused-complement', 0.4), placedAt(1), untouchedPosition(2)] },
    { t: 7, rig: 0, positions: [refusedAt(0, 'refused-unanswered', 0.4), untouchedPosition(1), untouchedPosition(2)] },
    // The two bookends refusals: the kind refusal blames a drop and a duplicate
    // and names a re-shoot; the length refusal names a re-shoot and blames nothing.
    { t: 8, rig: 0, positions: [refusedAt(0, 'refused-bookends-kind'), untouchedPosition(1), untouchedPosition(2)] },
    { t: 9, rig: 0, positions: [refusedAt(0, 'refused-bookends-length'), untouchedPosition(1), untouchedPosition(2)] },
  ];
  const solves = new Map<string, unknown>();
  const put = (x: ReturnType<typeof handSolve>) => solves.set(x.id, x);
  put(handSolve('twin', 0.4));
  put(handSolve('twin-broken', 1.5));
  put(handSolve('t1', 0.5, { dGridMm: 0.3, censored: true })); // a lower bound: unjudgeable
  put(handSolve('t2', 1.6, { dGridMm: 0.3 })); // its twin misses the gate on its own: unjudgeable
  put(handSolve('t3', 0.45, { dGridMm: 0.3 })); // HARMLESS at τ = 0.5
  put(handSolve('t4', 1.2, { dGridMm: 0.4 })); // GATE-BREAKING, and within re-shoot noise
  put(handSolve('t6', 1.3, { dGridMm: 0.9 })); // LOUD+SILENT, its silent part past the gate
  const pair = (treated: string, twin = 'twin') => ({ treated, twin });
  const solveList = [
    { cell: cell.id, t: 1, rig: 0, a: pair('t1'), p: pair('t1'), pIsA: true },
    { cell: cell.id, t: 2, rig: 0, a: pair('t2', 'twin-broken'), p: pair('t2', 'twin-broken'), pIsA: true },
    { cell: cell.id, t: 3, rig: 0, a: pair('t3'), p: pair('t3'), pIsA: true },
    { cell: cell.id, t: 4, rig: 0, a: pair('t4'), p: pair('t4'), pIsA: true },
    { cell: cell.id, t: 6, rig: 0, a: pair('t6'), p: pair('t6'), pIsA: true },
  ];
  const ev = { plan: { ...TEST_PLAN, rigs: [0] }, bank: { units: { 'main:0': { width: 0, height: 0, seed: 0, twins } } }, solves } as unknown as Parameters<typeof summariseCell>[0];
  const file = { units: { 'A:main:0': { score: { cells: { [cell.id]: caps } } }, 'S:main:0': { solves: solveList } } } as unknown as Parameters<typeof summariseCell>[2];
  const got = summariseCell(ev, cell, file, 0.5, { tauLo: 0.2, tauHi: 0.8, positionTau: 0.25 });
  const P = got.classes.P;
  assert.deepEqual(
    { unj: P.counts['SILENT-UNJUDGEABLE'], harmless: P.counts['SILENT-HARMLESS'], biased: P.counts['SILENT-BIASED'], gate: P.counts['SILENT-GATE-BREAKING'], loud: P.counts.LOUD, loudSilent: P.counts['LOUD+SILENT'] },
    { unj: 2, harmless: 1, biased: 0, gate: 1, loud: 5, loudSilent: 1 },
  );
  assert.equal(P.unjudgeable.length, 2);
  assert.match(P.unjudgeable[0], /^trial 1: D_grid is censored/);
  assert.match(P.unjudgeable[1], /^trial 2: the twin misses the 1 mm seam gate on its own/);
  assert.equal(P.solved.unjudgeable, 2);
  assert.deepEqual(got.loud, { captures: 5, wholePositionOnly: 1, runByRun: 4, reshootNamed: 3, dropAndDuplicate: 2 });
  assert.deepEqual(P.pastGate, { silent: 1, loudSilent: 1, total: 2 });
  assert.deepEqual([P.solved.withinReshootNoise, P.solved.gateBreakingWithinNoise], [2, 1]);
  const at = (x: { HARMLESS: number; BIASED: number; 'GATE-BREAKING': number; exceedTau: number; judged: number } | null) =>
    x === null ? null : [x.judged, x.HARMLESS, x.BIASED, x['GATE-BREAKING'], x.exceedTau];
  assert.deepEqual(at(P.silentAgainst.tau), [2, 1, 0, 1, 0]);
  assert.deepEqual(at(P.silentAgainst.tauLo), [2, 0, 1, 1, 2]);
  assert.deepEqual(at(P.silentAgainst.tauHi), [2, 1, 0, 1, 0]);
  assert.deepEqual(at(P.silentAgainst.positionTau), [2, 0, 1, 1, 2]);
});

test('T35 the yardsticks: a median beside a 95th percentile, what sets the percentile, and how often a clean re-shoot flips each gate', async () => {
  // The first full run set a straddle's median D_grid against the nulls' 95th
  // percentile, and quoted no null rate for the rotation-gate flips it counted,
  // though a clean re-shoot alone flipped that gate in one case of five; nor
  // any for the seam gate's.
  const { yardstick, poseLevel, p3Bookkeeping, p5aPairs, meanRowSmear, encodeBookkeeping } = await import('../src/straddle/assemble.ts');
  const { rollingSmear } = await import('../src/straddle/stages.ts');
  const solves = new Map<string, ReturnType<typeof handSolve>>();
  // Each re-shoot's grid error against truth, and whether it is censored.
  const nulls = (rig: number, kind: string, ds: number[], rot: number[], grid: [number, boolean][] = ds.map(() => [0.3, false])) =>
    ds.map((d, i) => {
      const id = `${kind}/${rig}/${i}`;
      solves.set(id, handSolve(id, grid[i][0], { dGridMm: d, rotationDeg: rot[i], gridCensored: grid[i][1] }));
      return id;
    });
  solves.set('plain/0', handSolve('plain/0', 0.3, { rotationDeg: 0.04 }));
  solves.set('plain/3', handSolve('plain/3', 1.1, { rotationDeg: 0.06 }));
  const pose = {
    units: {
      'main:0': { rig: 0, camera: 0, plain: 'plain/0', levels: [], nulls: nulls(0, 'n', [0.1, 0.2, 0.3], [0.03, 0.06, 0.07], [[0.3, false], [1.2, false], [1.4, true]]), positionNulls: nulls(0, 'q', [0.05, 0.06, 0.07], [0.03, 0.03, 0.06]) },
      'main:3': { rig: 3, camera: 1, plain: 'plain/3', levels: [], nulls: nulls(3, 'n', [0.4, 0.5, 0.9], [0.07, 0.08, 0.09], [[1.5, false], [0.9, false], [1.2, false]]), positionNulls: nulls(3, 'q', [0.1, 0.2, 0.3], [0.01, 0.01, 0.01]) },
    },
  };
  const ev = { pose, solves } as unknown as Parameters<typeof yardstick>[0];
  const whole = yardstick(ev, 'nulls', 'T35/whole');
  assert.equal(whole.median, 0.35, 'the median of the six');
  assert.equal(whole.value, Math.round(1e5 * (0.5 + 0.75 * (0.9 - 0.5))) / 1e5, 'the 95th percentile, type 7');
  assert.deepEqual(whole.perRigRange, { 0: [0.1, 0.3], 3: [0.4, 0.9] });
  assert.deepEqual(whole.largest, { n: 1, byRig: { 3: 1 } });
  // Rig 0's twin passes the gate at 0.04, and two of its re-shoots fail it; rig
  // 3's twin already fails it, so its re-shoots cannot flip it.
  assert.deepEqual(whole.rotationFlips, { flips: 2, of: 6, twinDeg: [0.04, 0.06] });
  // The seam gate likewise: rig 0's twin keeps it at 0.3 mm and one re-shoot
  // takes it to 1.2 mm, another reaches 1.4 mm censored and is not read; rig 3's
  // twin misses the gate on its own at 1.1 mm, so its re-shoots cannot flip it.
  assert.deepEqual(whole.gridFlips, { flips: 1, of: 5 });
  const position = yardstick(ev, 'positionNulls', 'T35/position');
  assert.equal(position.median, 0.085);
  assert.deepEqual(position.rotationFlips.flips, 1);
  assert.deepEqual(position.gridFlips, { flips: 0, of: 6 });
  assert.ok(position.lo !== null && position.hi !== null && position.lo <= position.value! && position.value! <= position.hi);

  // A level against both lines.
  const cases = [0.2, 0.3, 0.6].map((d) => ({ allRefused: false, dGridMm: d, gridFlip: d > 0.5, rotationFlip: false }));
  const level = poseLevel('forward/0.06', [...cases, { allRefused: true, dGridMm: null, gridFlip: null, rotationFlip: null }], 0.5, 0.25);
  assert.deepEqual([level.cases, level.allRefused, level.overTau, level.overTauPosition, level.gridFlips], [4, 1, 1, 2, 1]);

  // P3 by its yardstick: it holds for any τ below its third-smallest case, and
  // a case beyond every one of its own rig's re-shoots is beyond noise anyway.
  const at003 = [{ rig: 0, dGridMm: 0.25 }, { rig: 0, dGridMm: 0.4 }, { rig: 3, dGridMm: 0.45 }, { rig: 3, dGridMm: 1.0 }];
  const p3 = p3Bookkeeping(at003, whole, position.value);
  assert.equal(p3.holdsForTauBelowMm, 0.45);
  assert.equal(p3.exceedOwnRigNulls, 2, 'rig 0 above 0.3 once, rig 3 above 0.9 once');
  assert.deepEqual(p3.withinTauAt.positionTau, at003.filter((x) => x.dGridMm <= (position.value as number)).length);

  // P5a like for like: a rolling case whose solve withheld other runs is paired
  // but not compared.
  const p5a = p5aPairs(
    [{ rig: 0, dGridMm: 2, refused: [2, 3] }, { rig: 3, dGridMm: 1.5, refused: [0] }, { rig: 6, dGridMm: 0.9, refused: [1] }],
    [{ rig: 0, dGridMm: 1, refused: [3] }, { rig: 3, dGridMm: 1, refused: [0] }, { rig: 6, dGridMm: 1, refused: [1] }],
  );
  assert.deepEqual(p5a.pairs.map((x) => x.sameExclusions), [false, true, true]);
  assert.deepEqual(p5a.likeForLike, { cases: 2, outside30: 1 });
  // The rolling smear's mean over rows, from the spec's s(r) = clamp(s̄ + (r/(H−1) − 0.5)·ρ/E, 0, 1).
  let sum = 0;
  for (let r = 0; r < 240; r++) sum += Math.min(1, Math.max(0, 0.06 + (r / 239 - 0.5) * 0.3));
  assert.equal(meanRowSmear(0.06, 0.3, 240), Math.round(1e5 * (sum / 240)) / 1e5);
  assert.ok(meanRowSmear(0.06, 0.3, 240) > 0.07 && rollingSmear(0.06, 0.3, 240)(0) === 0);

  // P9 by the run each record came from.
  const rec = (maxDelta: number, minor: boolean, litShare: number) => ({ which: 'main', rig: 12, camera: 1, projector: 2, s: 0.12, maxDelta, twin: { minor, litShare } });
  const p9 = encodeBookkeeping([rec(0.007, true, 0.004), rec(0.0038, false, 0.008), rec(0.0031, false, 0.2)]);
  assert.deepEqual([p9.encodeMaxDeltaNonMinor, p9.encodeMaxDeltaLitOnePercent], [0.0038, 0.0031]);
  assert.deepEqual(p9.recordsOverBound, ['main rig 12 camera 1 run 3 s = 0.12: 0.007 (lit 0.4%, minor)']);
});

test('T36 where the page stopped, the aimed rule measured on a fine grid and derived from the design, and what is still not measured', async () => {
  const { aimedCrossing, aimedThreshold, followUps, lowBackward, namesReshoot, refusedAtOf, reshootNamedOf, u0Gaps } = await import('../src/straddle/assemble.ts');
  const { FULL_PLAN, QUICK_PLAN, latenessCells } = await import('../src/straddle/stages.ts');
  const { HEADLESS_LATENESS_MS, LATE_MS_RENDERED, LATE_MS_TIMING } = await import('../src/straddle/design.ts');

  // The first full run quoted "classify margin at most 0.201, against 0.15": a
  // margin over 0.15 belonged to a position that CLEARED classify and was
  // refused at the run count.
  const found2 = 'Found 2 projector runs and the capture should hold 4. A run whose white and black frames are both missing merges into the one before it.';
  const at = refusedAtOf([
    { runsPlaced: [], reasons: ['margin'], margin: 0.148, problems: ['The white and black frames cannot be reliably told from the patterned ones'] },
    { runsPlaced: [], reasons: ['margin'], margin: 0.02, problems: [] },
    { runsPlaced: [], reasons: ['count'], margin: 0.2014, problems: [found2] },
    { runsPlaced: [], reasons: ['count'], margin: 0.1715, problems: [found2.replace('Found 2', 'Found 3')] },
    { runsPlaced: [0, 1], reasons: [], margin: 0.3, problems: [] },
  ]);
  assert.deepEqual(at.classify, { positions: 2, maxMargin: 0.148 });
  assert.deepEqual([at.count.positions, at.count.margin.min, at.count.margin.max, at.count.runsFound], [2, 0.1715, 0.2014, { min: 2, max: 3 }]);
  assert.equal(at.other, 0);
  // "Re-shoot projector N", in the page's own words, on a real position: a
  // lone Gray plane smeared into its complement is a complement refusal and
  // names it; a run the camera cannot see, noiseless, "could not be checked"
  // and names nothing.
  const b = rig();
  const { c, p } = brightestRun(b);
  const smeared = lone('forward', p * FRAMES_PER_RUN + 2, 0.3);
  const problems = isolatedCheck(positionFingerprints(b, c, smeared), smeared, 'content').problems;
  const invisible = RUNS.find((q) => b.lit[c][q] === 0) as number;
  assert.ok(problems.some((x) => x.startsWith(`Projector ${p + 1}'s frames`) && namesReshoot(x)), problems.join(' | '));
  assert.ok(problems.some((x) => x.startsWith(`Projector ${invisible + 1}'s run could not be checked`) && !namesReshoot(x)), problems.join(' | '));
  assert.equal(namesReshoot(found2), false);
  assert.equal(reshootNamedOf([{ problems }, { problems: [found2] }, { problems: [] }]), 1);

  // The runs a backward straddle refuses early, and the quarter-mass gap by band.
  const gateRun = (forward: number | null, backward: number | null, litShare: number, u0: [number, number] | null, pair: number | null) => ({
    attributable: true,
    litShare,
    forward: { s: forward, pair, nonMonotone: false },
    backward: { s: backward, pair: null, nonMonotone: false },
    u0: u0 === null ? null : { analytic: u0[0], rendered: u0[1], masses: [] },
  });
  const runs = [gateRun(0.03, 0.12, 0.3, [0.12, 0.1201], 0), gateRun(0.12, 0.004, 0.012, [0.3, 0.315], 5), gateRun(0.1, 0.045, 0.015, [0.2, 0.2002], 3), gateRun(null, null, 0.2, null, null)];
  assert.deepEqual(lowBackward(runs), { below: 0.05, runs: 2, maxLit: 0.015, lowest: 0.004 });
  // A run the clean capture refuses is no straddle's, however early it crosses.
  assert.deepEqual(lowBackward([...runs, { ...gateRun(0.2, 0.001, 0.5, null, null), attributable: false }]), lowBackward(runs));
  assert.deepEqual(u0Gaps(runs), {
    byRenderedCrossing: [{ upTo: 0.2, runs: 1, maxError: 0.0001 }, { above: 0.2, runs: 2, maxError: 0.015 }],
    u0Bound: { runs: 1, maxError: 0.0001 },
  });

  // The lateness grid resolves the aimed crossing to 0.05 ms, where the first
  // run's whole milliseconds bracketed it in (3, 4].
  const fine = Array.from({ length: 13 }, (_, i) => Math.round(340 + 5 * i) / 100);
  for (const x of fine) assert.ok(LATE_MS_TIMING.includes(x), `${x} ms is not swept`);
  assert.ok(LATE_MS_TIMING.every((x, i) => i === 0 || x > LATE_MS_TIMING[i - 1]));
  assert.ok(LATE_MS_RENDERED.every((x) => LATE_MS_TIMING.includes(x)) && QUICK_PLAN.lateMsTiming === LATE_MS_TIMING);
  // The one lateness cell that solves is the design-time headless figure's.
  assert.deepEqual(latenessCells(FULL_PLAN).filter((x) => x.solve !== 'none').map((x) => [x.id, x.lateMs]), [[`L-aimed-${HEADLESS_LATENESS_MS.hudTickOff}`, 7.5]]);
  const cellAt = (lateMs: number, touched: number, vsync = false) => ({ arm: 'intervalometer-100ppm', phase: 'aimed' as const, vsync, lateMs, capturesTouched: touched, trials: 2000 });
  const timing = [cellAt(3.6, 30), cellAt(3, 0), cellAt(3.45, 0), cellAt(3.5, 3), cellAt(3.55, 15), cellAt(4, 235), cellAt(3.5, 25, true), { ...cellAt(3.4, 900), phase: 'uniform' as const }];
  assert.deepEqual(
    { ...aimedCrossing(timing, false), grid: undefined },
    { firstTouchedMs: 3.5, onePercentMs: 3.6, bracketMs: [3.55, 3.6], grid: undefined },
  );
  assert.deepEqual(aimedCrossing(timing, true).bracketMs, [null, 3.5]);
  // Derived, not written: the aimed rule's band is read off EXPERIMENT-9's own
  // startPhase, and the camera clock's drift is the headline arm's. The first
  // run wrote "about 3.7 ms", the matched-clock figure, for an arm whose camera
  // runs 100 ppm fast in half its captures.
  const t = aimedThreshold();
  assert.deepEqual(t.aimBandS, [DWELL_S / 4, (3 * DWELL_S) / 4]);
  assert.equal(t.steps, STEPS.length - 1);
  assert.equal(t.matchedClocksMs, Math.round(1e4 * ((1000 * DWELL_S) / 4 / 135)) / 1e4);
  assert.equal(t.fastCameraMs, Math.round(1e4 * 1000 * (DWELL_S / 4 / 135 - DWELL_S * (1 - 1 / 1.0001))) / 1e4);
  assert.deepEqual([t.matchedClocksMs, t.fastCameraMs], [3.7037, 3.5037]);

  // What is not measured: always P0 and P9 on noise; the 5/9 onset only while
  // no smear reaches it; the page column's own gaps once it ran, and that it
  // did not run while the page's reader placed nothing. The item asking for
  // the column to be run, worded for the reader the page replaced, is gone.
  const has = (xs: string[], start: string) => xs.some((x) => x.startsWith(start));
  const now = followUps(FULL_PLAN, 0);
  assert.ok(has(now, 'P0,') && has(now, 'P9 on noisy frames') && has(now, 'The Gray flip onset at 5/9') && has(now, "The page's reader on a straddled position"));
  assert.ok(!has(now, "The page's own harm") && !has(now, "The page's decode"));
  const later = followUps({ ...FULL_PLAN, decodeNoiseless: [...FULL_PLAN.decodeNoiseless, 0.6] }, 3);
  assert.ok(has(later, 'P0,') && !has(later, 'The Gray flip onset at 5/9') && !has(later, "The page's reader on a straddled position"));
  assert.ok(has(later, "The page's own harm") && has(later, "The page's decode"));
  for (const xs of [now, later]) assert.ok(!xs.some((x) => x.includes("Today's page")), xs.join(' | '));
  // P9's follow-up says the page column reads noisy frames without a linear reference beside them.
  assert.ok(later.some((x) => x.startsWith('P9 on noisy frames') && x.includes('sets no linear fingerprint beside them')));
  // Which lateness captures are solved, read off the plan: one cell's first
  // captures under policy A, or none at all.
  const lateSolves = now.find((x) => x.startsWith('Lateness solves:')) ?? '';
  assert.ok(lateSolves.startsWith(`Lateness solves: only L-aimed-${HEADLESS_LATENESS_MS.hudTickOff} solves captures, the first ${FULL_PLAN.solveSubsample} in trial order with a PLACED or MIXED position, under policy A.`), lateSolves);
  // What P borrows, in the words T27 holds the code to: a LOUD+SILENT capture
  // whose loud positions are REFUSED-ALL has A's plan and is solved under P;
  // only a MIXED position keeps P unsolved. This follow-up first said that no
  // LOUD+SILENT capture of the cell was solved under P.
  assert.ok(lateSolves.includes('so a LOUD+SILENT capture whose loud positions are all REFUSED-ALL is solved under P; a capture with a MIXED position is not'), lateSolves);
  assert.doesNotMatch(lateSolves, /a LOUD\+SILENT capture is not solved/);
  for (const plan of [QUICK_PLAN, { ...FULL_PLAN, solveSubsample: 0 }]) {
    assert.ok(has(followUps(plan, 0), 'Lateness solves: this plan solves no lateness capture'), `${plan.pose} ${plan.solveSubsample}`);
  }
});

test("T37 the verdict and the caveats say what the first full run's verification found, every number through at()", async () => {
  // The first full run's verdict was checked sentence by sentence against its
  // own data and eleven clauses were corrected. The reduced design's document
  // carries none of those numbers, so the first run's are set into it here, and
  // the sentence must read them back in the corrected words; the words it was
  // corrected from must be gone. Then the document's own new fields are held to
  // each other.
  const { caveats, verdictStatement } = await import('../src/straddle/assemble.ts');
  let text = testPlanText;
  if (text === null) {
    const { runExperiment10 } = await import('../src/straddle/cli.ts');
    const { TEST_PLAN, memoryStore, runContext } = await import('../src/straddle/stages.ts');
    text = JSON.stringify(runExperiment10(runContext(TEST_PLAN, memoryStore(), () => {})), null, 2);
  }
  const doc = JSON.parse(text);

  // Solved or not, the headline counts the loud captures that also carry a
  // silent position: a count of positions, not of solves. 379bb2f's verdict
  // said it on every plan; the corrected wording first dropped it from a
  // document that solved nothing.
  {
    assert.equal(doc.pose.solved, false);
    const unsolved = verdictStatement(doc);
    const counts = doc.rescore.cells.find((x: { id: string }) => x.id === 'R1').classes.P.counts;
    assert.ok(unsolved.includes(` ${counts['LOUD+SILENT']} of the loud captures also carry a silent position. `), unsolved);
    assert.ok(unsolved.includes(`${counts['SILENT-UNSOLVED']} pass silently (not solved in this run).`), unsolved);
  }

  // The document's new fields, held to each other on the reduced design.
  const vl = doc.decode.verdictLevel;
  assert.equal(vl.signs.all.pixels, vl.signs.seam.pixels + vl.signs.rest.pixels);
  assert.equal(vl.signs.all.vPos, vl.signs.seam.vPos + vl.signs.rest.vPos);
  assert.ok(vl.signs.seam.pixels > 0 && vl.signs.rest.pixels > 0, 'no seam, so the split is untested');
  const below = doc.decode.curve.filter((x: { s: number }) => x.s < 5 / 9);
  assert.equal(doc.decode.grayFlipsBelowFiveNinths.matched, below.reduce((a: number, x: { grayFlips: { matched: number } }) => a + x.grayFlips.matched, 0));
  assert.equal(doc.decode.grayFlipsBelowFiveNinths.either, 0, 'a Gray word changed below 5/9 on the reduced rig');
  const attributable = doc.gate.crossings.runs.filter((r: { attributable: boolean }) => r.attributable);
  assert.equal(doc.gate.crossings.lowBackward.runs, attributable.filter((r: { backward: number | null }) => r.backward !== null && r.backward < 0.05).length);
  assert.equal(doc.gate.crossings.u0.byRenderedCrossing[0].runs + doc.gate.crossings.u0.byRenderedCrossing[1].runs, doc.gate.crossings.u0.runs);
  assert.ok(doc.decode.ablation.dimmingControl !== undefined && doc.decode.ablation.darkSuccessor === undefined);
  // Every clean position of the reduced rig has a run its camera cannot see, and
  // the counterfactual reader, reading that run's noise as a broken pair, tells
  // the operator to re-shoot it on each.
  const twinsMain = doc.precondition.twins.main;
  assert.deepEqual([twinsMain.reshootNamed, twinsMain.invisible], [twinsMain.cameras, twinsMain.cameras]);
  // Both gates' null rates, beside each other, for both re-shoots: none solved here.
  for (const y of [doc.pose.tauNull, doc.pose.tauPosition]) assert.deepEqual([y.gridFlips, y.rotationFlips.flips, y.rotationFlips.of], [{ flips: 0, of: 0 }, 0, 0]);
  assert.ok(doc.decode.curve.every((x: Record<string, unknown>) => 'movedHalfPeriod' in x && !('wrongFringe' in x)));
  assert.ok(Array.isArray(doc.followUps) && doc.followUps.length >= 6);
  assert.ok(doc.decode.forwardMeans.runLevels > 0 && doc.decode.forwardMeans.nonNegativeU === 0 && doc.decode.forwardMeans.nonNegativeV === 0, JSON.stringify(doc.decode.forwardMeans));
  assert.ok(vl.p95AbsV.max < vl.p95AbsU.max, 'the v spread is the u spread');
  assert.ok(vl.absMeanV.median < vl.absMeanU.median, 'the mean v shift is the mean u shift');
  // The crossing figures keep the runs' own five places, so a percentile the
  // verdict quotes to 0.1% of the exposure is not a rounding of a rounding:
  // their ends are the extreme runs, as the per-run list rounds them.
  for (const dir of ['forward', 'backward'] as const) {
    const xs = attributable.map((r: Record<string, number | null>) => r[dir]).filter((x: number | null): x is number => x !== null);
    assert.ok(xs.length > 0, dir);
    assert.deepEqual([doc.gate.crossings[dir].min, doc.gate.crossings[dir].max], [Math.min(...xs), Math.max(...xs)], dir);
  }
  const h7 = doc.harness.find((x: { id: string }) => x.id === 'H7');
  assert.equal(h7.pass, null, 'H7 passed on a design that decodes no onset level');
  assert.equal(h7.measured.everyClauseTested, false);
  // Where the reader the page replaced stopped each clean position, under its
  // own name, and P6 reading it beside the page's reader, which decides it.
  const stopped = doc.precondition.q0.replaced.refusedAt;
  assert.equal(stopped.classify.positions + stopped.count.positions + stopped.other, doc.precondition.q0.total - doc.precondition.q0.replaced.placedPositions);
  const prediction = (id: string) => doc.predictions.find((x: { id: string }) => x.id === id).measured;
  assert.deepEqual(prediction('P6').replaced.refusedAt, stopped);
  const { RERUN_PREDICTIONS } = await import('../src/straddle/design.ts');
  const p6 = doc.predictions.find((x: { id: string }) => x.id === 'P6');
  assert.equal(p6.note, RERUN_PREDICTIONS.find((x) => x.id === 'P6')?.note);
  assert.equal(p6.falsifiedIf, RERUN_PREDICTIONS.find((x) => x.id === 'P6')?.falsifiedIf, "P6's words moved from the ones registered");
  assert.equal(p6.falsified, doc.precondition.q0.page.placedPositions > 0);
  assert.equal(prediction('P6').placedPositions, doc.precondition.q0.page.placedPositions);
  const { meanRowSmear } = await import('../src/straddle/assemble.ts');
  assert.equal(prediction('P5a').meanRowSmear, meanRowSmear(0.06, 0.3, rig().height));
  for (const key of ['encodeMaxDeltaNonMinor', 'encodeMaxDeltaLitOnePercent', 'recordsOverBound']) assert.ok(key in prediction('P9'), key);

  // The first full run's figures, set into the reduced design's document.
  const spread = (min: number, p10: number, median: number, p90: number, max: number, n: number) => ({ n, min, p10, median, p90, max, mean: median });
  // Q0: the first run's figures are the reader the page replaced; the page's
  // reader's are set as the acceptance sweep read the same 108 positions.
  doc.precondition.q0.total = 108;
  Object.assign(doc.precondition.q0.page, { placedPositions: 108, runs: 432, unseen: 87, barelySeen: 18, positionsWithProblems: 0 });
  Object.assign(doc.precondition.q0.replaced, {
    placedPositions: 0,
    refusedAt: { classify: { positions: 105, maxMargin: 0.148 }, count: { positions: 3, margin: spread(0.1715, 0.1715, 0.2014, 0.2014, 0.2014, 3), runsFound: { min: 2, max: 2 } }, other: 0 },
  });
  Object.assign(doc.precondition.pageTwins.main, { runs: 288, unseen: 68 });
  Object.assign(doc.precondition.twins.main, { cameras: 72, reshootNamed: 66 });
  Object.assign(doc.gate.crossings, {
    attributableRuns: 222,
    neverRefused: { forward: 0, backward: 0 },
    forward: spread(0.06981, 0.07238, 0.11578, 0.16203, 0.16453, 222),
    backward: spread(0.00453, 0.05068, 0.10984, 0.15849, 0.16734, 222),
    lowBackward: { below: 0.05, runs: 22, maxLit: 0.01522, lowest: 0.00453 },
  });
  doc.decode.curve.find((x: { direction: string; s: number }) => x.direction === 'forward' && x.s === 0.1).ratioU.median = -0.7517;
  Object.assign(doc.decode, { forwardMeans: { runLevels: 804, nonNegativeU: 0, nonNegativeV: 0 }, highestDecoded: 0.5 });
  Object.assign(doc.decode.verdictLevel, {
    runs: 67,
    absMeanU: spread(0.4433, 0.4554, 0.457, 0.4599, 0.4723, 67),
    absMeanV: spread(0.24, 0.25, 0.257, 0.26, 0.27, 67),
    p95AbsV: spread(0.3, 0.35, 0.4, 1.2, 1.44, 67),
    mmShift: spread(0.9491, 0.9631, 1.1736, 2.1288, 2.7236, 67),
    signs: {
      seam: { pixels: 20000, uPos: 0, uNeg: 20000, vPos: 620, vNeg: 19380, maxAbsU: 0.7, maxAbsV: 2.03, uPosShare: 0, vPosShare: 0.031 },
      rest: { pixels: 1000000, uPos: 0, uNeg: 1000000, vPos: 120, vNeg: 999880, maxAbsU: 0.7, maxAbsV: 0.6, uPosShare: 0, vPosShare: 0.00012 },
      all: { pixels: 1020000, uPos: 0, uNeg: 1020000, vPos: 740, vNeg: 1019260, maxAbsU: 0.7, maxAbsV: 2.03, uPosShare: 0, vPosShare: 0.00073 },
    },
  });
  doc.pose = {
    ...doc.pose,
    solved: true,
    tauNull: { value: 0.69093, lo: 0.43689, hi: 0.75459, median: 0.338, samples: 80, rotationFlips: { flips: 16, of: 80 }, gridFlips: { flips: 3, of: 78 } },
    tauPosition: { value: 0.33, lo: 0.26, hi: 0.4, median: 0.2, samples: 80 },
    levels: [{ label: 'forward/0.06', cases: 8, dGridMm: spread(0.8042, 0.8821, 1.3602, 1.9012, 1.9366, 8), gridFlips: 6, rotationFlips: 7 }],
  };
  const cells = (xs: { id: string }[], id: string) => xs.find((x) => x.id === id) as Record<string, any>;
  const r1 = cells(doc.rescore.cells, 'R1');
  Object.assign(r1, { capturesFlagged: 728, capturesRecorded: 728, loud: { captures: 627, wholePositionOnly: 332, runByRun: 295, reshootNamed: 295, dropAndDuplicate: 295 } });
  Object.assign(r1.classes.P.counts, { LOUD: 627, 'LOUD+SILENT': 31, 'SILENT-HARMLESS': 38, 'SILENT-BIASED': 17, 'SILENT-GATE-BREAKING': 43, 'SILENT-UNJUDGEABLE': 0, 'SILENT-UNSOLVED': 0, 'INVISIBLE-ONLY': 3, UNCHANGED: 0 });
  r1.classes.P.solved.loudSilentHarm = { HARMLESS: 10, BIASED: 3, 'GATE-BREAKING': 18 };
  const judged = (tauMm: number, HARMLESS: number, BIASED: number, exceedTau: number) => ({ tauMm, judged: 98, HARMLESS, BIASED, 'GATE-BREAKING': 43, exceedTau });
  r1.classes.P.silentAgainst = { tau: judged(0.69093, 38, 17, 60), tauLo: judged(0.43689, 32, 23, 66), tauHi: judged(0.75459, 44, 11, 54), positionTau: judged(0.33, 24, 31, 74) };
  r1.classes.P.pastGate = { silent: 43, loudSilent: 18, total: 61 };
  Object.assign(cells(doc.rescore.cells, 'R8'), { capturesRecorded: 0, trials: 2000 });
  const aimed = cells(doc.lateness.cells, 'L-aimed-7.5');
  Object.assign(aimed, { capturesRecorded: 1786, trials: 2000 });
  Object.assign(aimed.classes.P.counts, { LOUD: 1358, 'LOUD+SILENT': 349, 'SILENT-HARMLESS': 4, 'SILENT-BIASED': 2, 'SILENT-GATE-BREAKING': 17, 'SILENT-UNJUDGEABLE': 0, 'SILENT-UNSOLVED': 301, 'INVISIBLE-ONLY': 104, UNCHANGED: 0 });
  // The same captures through the page's own reader: figures of the right
  // shape, set in so the clause has to read each one back from its cell.
  Object.assign(r1.page.read, { captures: 728 });
  Object.assign(r1.page.classes.P.counts, { LOUD: 600, 'LOUD+SILENT': 20, 'SILENT-HARMLESS': 30, 'SILENT-BIASED': 10, 'SILENT-GATE-BREAKING': 20, 'SILENT-UNJUDGEABLE': 0, 'SILENT-UNSOLVED': 60, 'INVISIBLE-ONLY': 8, UNCHANGED: 0 });
  r1.page.loud = { captures: 600, runByRun: 400, wholePositionOnly: 200, crashOnly: 0, reshootNamed: 400, dropAndDuplicate: 50 };
  r1.page.quiet = { runs: 5, positions: 5, captures: 5, silentOnlyThroughQuiet: 2 };
  r1.page.classes.P.vsCounterfactual = { LOUD: { LOUD: 590, SILENT: 30, 'INVISIBLE-ONLY': 7, UNCHANGED: 0, UNTOUCHED: 0 }, SILENT: { LOUD: 10, SILENT: 87, 'INVISIBLE-ONLY': 1, UNCHANGED: 0, UNTOUCHED: 0 }, 'INVISIBLE-ONLY': { LOUD: 0, SILENT: 3, 'INVISIBLE-ONLY': 0, UNCHANGED: 0, UNTOUCHED: 0 }, UNCHANGED: { LOUD: 0, SILENT: 0, 'INVISIBLE-ONLY': 0, UNCHANGED: 0, UNTOUCHED: 0 }, UNTOUCHED: { LOUD: 0, SILENT: 0, 'INVISIBLE-ONLY': 0, UNCHANGED: 0, UNTOUCHED: 0 } };
  Object.assign(r1.page.misfiles, { photographs: 40, positions: 30, share: { min: 0.5002, max: 0.6 } });
  Object.assign(aimed.page.read, { captures: 1786 });
  Object.assign(aimed.page.classes.P.counts, { LOUD: 1300, 'SILENT-HARMLESS': 0, 'SILENT-BIASED': 0, 'SILENT-GATE-BREAKING': 0, 'SILENT-UNJUDGEABLE': 0, 'SILENT-UNSOLVED': 380 });
  aimed.page.quiet.runs = 7;
  // Across every cell the page read: the totals the clause must sum.
  const pageRead = [...doc.rescore.cells, ...doc.lateness.cells].filter((x: { page: { status: string } }) => x.page.status !== 'not run').map((x: { page: unknown }) => x.page as { quiet: { runs: number }; misfiles: { photographs: number; positions: number; share: { min: number | null; max: number | null } } });
  const allQuiet = pageRead.reduce((a, x) => a + x.quiet.runs, 0);
  const allMisfiled = pageRead.reduce((a, x) => a + x.misfiles.photographs, 0);
  const allMisfiledPositions = pageRead.reduce((a, x) => a + x.misfiles.positions, 0);
  const allShares = pageRead.flatMap((x) => [x.misfiles.share.min, x.misfiles.share.max].filter((v): v is number => v !== null));
  assert.ok(allQuiet >= 12 && allMisfiled >= 40, 'the injected page figures did not reach the totals');
  doc.lateness.aimed.vsyncOff = { firstTouchedMs: 3.5, onePercentMs: 3.6, bracketMs: [3.55, 3.6], grid: [] };
  doc.lateness.aimed.vsyncOn = { firstTouchedMs: 3.45, onePercentMs: 3.5, bracketMs: [3.45, 3.5], grid: [] };

  const v = verdictStatement(doc);
  for (const want of [
    "The page's reader placed a run in 108 of the 108 clean camera positions rendered from the card's three marks, noting 87 runs out of view and 18 barely seen and refusing nothing. The reader it replaced placed none of them: 105 were refused at classify (margin at most 0.148, against 0.15). The other 3 cleared classify (margins 0.172-0.201) but were refused at the run count, having found 2 of 4 projector runs. The rescoring put every straddled position of those rigs through the page's reader as well.",
    'Handed every frame\'s kind (the counterfactual reader), the complement check first refuses a forward whole-position straddle',
    'the complement check first refuses a forward whole-position straddle at between 7.2% and 16.2% of the exposure, depending on the run. These are the 10th and 90th percentiles over all 222 attributable runs, from the noiseless linear predictor: median 11.6%, full range 7.0-16.5%.',
    'A backward straddle is first refused at between 5.1% and 15.8% (median 11.0%); 22 runs, each lighting at most 1.5% of the photograph, are refused below 5.0% backward, the lowest at 0.45%.',
    'no pixel both decodes accept changed its Gray address',
    'It carries a phase bias whose mean is one-signed: about 0.75 of atan2(s, 1−s)·P/2π, toward lower projector coordinates for a forward straddle, and every run\'s mean Δu and mean Δv is negative at every forward smear decoded.',
    'At s = 0.06 that is 0.46 px along u and 0.26 px along v at the 1920×1080 raster',
    'no pixel moves positive along u; along v, 3.1% of the 20000 pixels where the next projector also lights move positive, against 0.012% of the 1000000 others, and |Δv| reaches 2.03 px against the 0.26 px mean (the largest run\'s 95th percentile is 1.44 px).',
    'On the sphere, a median 1.17 mm counting both axes: the median of 67 per-run medians, which span 0.95-2.72 mm.',
    'moves the worst seam point by a median 1.36 mm over 8 designed rigs (range 0.80-1.94 mm). The 1 mm seam gate flips in 6 of 8 and the 0.05° rotation gate in 7; clean whole-capture re-shoots flip them in 3 of 78 and 16 of 80.',
    'That is 4.0 times the median 0.34 mm by which re-shooting the whole capture moves it (95th percentile 0.69 mm, 95% CI 0.44-0.75), and 6.8 times the median 0.20 mm by which re-shooting only the straddled position moves it (95th percentile 0.33 mm, 95% CI 0.26-0.40).',
    "Of EXPERIMENT-9's 728 touched captures at the page's defaults (2 s dwell, 1/4 s exposure), with an un-aimed (uniform) start, under its perfect-timer model and policy P (a refused position is re-shot whole, and the re-shoot is assumed clean), the counterfactual reader refuses 627 loudly: 295 run by run, with 'Re-shoot projector N' (295 blaming a dropped and a duplicated frame), a remedy that produces a folder the counterfactual reader refuses whole",
    "and 332 only as a whole position ('Found N projector runs …'), whose remedy, re-shooting the position, it can read.",
    '31 of the loud captures also carry a silent position, and in 18 of those the seams still end past the 1 mm gate after the refused positions are re-shot clean.',
    "98 pass silently: 38 keep the gate and move the worst seam point no further than 95% of whole-capture re-shoots do (32-44 across τ's 95% CI, and 24 against the one-position re-shoot), 17 move it further without breaking the gate, and 43 break it. In all, 61 of the 728 end past the gate under policy P, and 60 of the 98 silent captures judged move the seams further than τ.",
    '3 touched only runs that the counterfactual reader also refuses on the clean capture; 0 changed no photograph. With the card\'s aimed start and a perfect timer, 0 of 2000 captures are touched (R8).',
    "If the emitter runs 7.5 ms late per step, 1786 of 2000 captures started by the card's aimed rule are touched: 1358 loud, 349 of them also carrying a silent position; 324 silent, 23 of them solved and 17 of those past the seam gate; and 104 touching only runs that are refused anyway. Through the page's own reader the same 1786 captures are 1300 loud and 380 silent.",
    "Through the page's own reader, each run attributed against its reading of the same clean frames, the 728 captures come out 600 loud (400 run by run, told 'Re-shoot projector N', and 200 only as a whole position; 20 of them also carrying a silent position) and 120 silent, 2 of them only through a quiet drop (30 harmless, 10 biased and 20 past the gate by a counterfactual solve of the same plan, and 60 not solved); 8 touch only runs its clean reading does not place, and 0 changed no photograph. Of the counterfactual reader's 627 loud captures the page passes 30 silently, and of its 98 silent ones the page refuses 10 loudly.",
    `Across the ${pageRead.length} rescore and lateness cells it read, the page quietly drops ${allQuiet} runs its clean reading places, noting them out of view or barely seen with no problem naming them, and its placed runs file ${allMisfiled} photographs under a step other than the one holding more than half their exposure (in ${allMisfiledPositions} positions, that step's share ${Math.min(...allShares).toFixed(3)}-${Math.max(...allShares).toFixed(3)}).`,
    'armed with the tick on, the same setup ran about 9.3 ms late. This experiment did not re-measure it',
    'about 3.70 ms per step with matched clocks, and 3.50 ms for the half of captures whose camera clock runs 100 ppm fast.',
    'On the swept grid the first aimed capture is touched at 3.5 ms, and 1% are touched from 3.6 ms, a crossing the sweep finds in (3.55, 3.6] ms; with a 60 Hz refresh wait, 3.45 and 3.5 ms.',
  ]) {
    assert.ok(v.includes(want), `the verdict does not say: ${want}\n\n${v}`);
  }
  // The lateness sentence's parts add up to its whole now.
  assert.equal(1358 + 324 + 104, 1786);
  for (const gone of [/straddled or not/, /carrying a one-signed phase bias/, /mm for a re-shoot/, /as it did headless/, /classify margin at most/, /stays below about 3\.7 ms/, /straddle from \d/, /is refused from/, /against 16 of 80/, /Today's page/, /such a reader/, /Given a reader whose bookends/, /folder the reader refuses/]) {
    assert.doesNotMatch(v, gone);
  }
  // Every number is read through at(): a document without one stops the sentence.
  const cuts: [string, (d: any) => void][] = [
    ['the null median', (d) => { delete d.pose.tauNull.median; }],
    ['the one-position 95th percentile', (d) => { delete d.pose.tauPosition.value; }],
    ['the count refusals\' margins', (d) => { d.precondition.q0.replaced.refusedAt.count.margin.max = null; }],
    ['the runs the page\'s reader notes out of view', (d) => { delete d.precondition.q0.page.unseen; }],
    ['the reader the page replaced', (d) => { delete d.precondition.q0.replaced.placedPositions; }],
    ['the captures silent only through a quiet drop', (d) => { delete cells(d.rescore.cells, 'R1').page.quiet.silentOnlyThroughQuiet; }],
    ['where the two readers part', (d) => { delete cells(d.rescore.cells, 'R1').page.classes.P.vsCounterfactual.SILENT.LOUD; }],
    ['the page\'s misfiles in a cell', (d) => { delete cells(d.lateness.cells, 'L-aimed-7.5').page.misfiles.photographs; }],
    ['the rotation null rate', (d) => { delete d.pose.tauNull.rotationFlips.flips; }],
    ['the seam null rate', (d) => { delete d.pose.tauNull.gridFlips.flips; }],
    ['the refresh period', (d) => { delete d.generatedFrom.design.constants.VSYNC_S; }],
    ['the loud split', (d) => { delete cells(d.rescore.cells, 'R1').loud.wholePositionOnly; }],
    ['the aimed threshold', (d) => { d.lateness.aimed.threshold.fastCameraMs = null; }],
    ['the sign split', (d) => { d.decode.verdictLevel.signs.seam.vPosShare = null; }],
    ['the headless figure', (d) => { delete d.generatedFrom.design.constants.HEADLESS_LATENESS_MS.armedTickOn; }],
  ];
  for (const [what, cut] of cuts) {
    const holed = structuredClone(doc);
    cut(holed);
    assert.throws(() => verdictStatement(holed), /the verdict needs cell/, `a document without ${what} still got a verdict`);
  }

  // The refresh rate is the design's, not a word in the sentence.
  const at50 = structuredClone(doc);
  at50.generatedFrom.design.constants.VSYNC_S = 1 / 50;
  assert.match(verdictStatement(at50), /; with a 50 Hz refresh wait, 3\.45 and 3\.5 ms\./);

  // The caveats are read from the same cells.
  const said = caveats(doc);
  assert.match(said.stopped, /^The reader the page replaced refused every clean bench position before its complement check ran: 105 of 108 at classify and 3 at the run count \(precondition\.q0\.replaced\.refusedAt\)\./);
  assert.match(said.reader, /^Two readers are reported\. Each cell's classes, loud, positions and runs are a COUNTERFACTUAL reader's/);
  assert.match(said.reader, /'Re-shoot projector N' on 66 of 72 clean positions/);
  assert.match(said.reader, /which notes a projector the camera cannot see out of view instead: 68 of the 288 runs of the sweep/);
  assert.match(said.fastPath, /the page's reading of the whole straddled position by H8-page; this run rendered no hook position, so neither is established\.$/);
  assert.doesNotMatch(JSON.stringify(said), /Today's page|No fix to the page is implied/);
  assert.match(said.timer, /7\.5 ms is the mean of a design-time probe in headless Chromium on SwiftShader's software GL, in HUD mode with the tick off; armed with the tick on, the same setup ran about 9\.3 ms late/);
  assert.match(said.timer, /this experiment re-measured neither: the spec's P0 \(tools\/emitter-timing\.ts\) was never built/);
  for (const key of ['inherited', 'placement', 'projection', 'resolution', 'yardsticks', 'unjudgeable', 'decodeControls', 'stopped', 'pageColumn', 'folder']) assert.ok(typeof said[key] === 'string', key);
  // The swept range and the raster are the document's own, not words.
  assert.match(said.timer, /sweeps δ from 0 to 15 ms per step/);
  const cell = Math.round((rig().width * rig().height) / doc.generatedFrom.design.constants.FINGERPRINT_BLOCKS ** 2);
  assert.equal(said.resolution, `The main sweep renders at ${rig().width}x${rig().height}, where a fingerprint cell holds about ${cell} pixels. No finer preset was rendered.`);
  const holed = structuredClone(doc);
  delete holed.precondition.twins.main.reshootNamed;
  assert.throws(() => caveats(holed), /the verdict needs cell/);
  const holedTwins = structuredClone(doc);
  delete holedTwins.precondition.pageTwins.main.unseen;
  assert.throws(() => caveats(holedTwins), /the verdict needs cell/);
  const holedStop = structuredClone(doc);
  delete holedStop.precondition.q0.replaced.refusedAt.count.positions;
  assert.throws(() => caveats(holedStop), /the verdict needs cell/);
  // A page reading beside a page reader that placed nothing is a document at odds with itself.
  const odd = structuredClone(doc);
  odd.precondition.q0.page.placedPositions = 0;
  assert.throws(() => verdictStatement(odd), /placed no clean position, and a cell has a page column/);
});

test("T38 the decode stage counts every flip above 5/9, and each direction's seam is its own neighbour's light", async () => {
  // The decode stage's own levels, on the reduced rig. Above 5/9 a whole-run
  // blend flips Gray words confidently, and the count sees them; below it,
  // none. The seam each level's signs are split by is the light of the
  // projector that direction's blend brings in: forward the next projector,
  // backward the one before. Held here to independent decodes, pixel by pixel.
  const { computeTwin, decodeRunArms, TEST_PLAN } = await import('../src/straddle/stages.ts');
  const b = rig();
  const c = 0;
  const inner = RUNS.filter((q) => q > 0 && q < PROJECTORS - 1);
  const p = inner.reduce((best, q) => (b.lit[c][q] > b.lit[c][best] ? q : best), inner[0]);
  assert.ok(b.lit[c][p] > 1000 && b.lit[c][p - 1] > 0 && b.lit[c][p + 1] > 0, `camera ${c} run ${p + 1} and its neighbours: ${b.lit[c]}`);
  const twin = computeTwin(b, c).twin;
  const rc = { unit: 'main:0', bank: b, twins: new Map([[c, twin]]), prints: new Map(), decodes: new Map(), prepared: null };
  const plan = { ...TEST_PLAN, decodeNoiseless: [0.1, 0.6], decodeNoisy: [], rollingDecode: { ratios: [], midRow: [] }, shortRowFractions: [] };
  const run = decodeRunArms(rc as never, plan, c, p);
  const level = (direction: 'forward' | 'backward', s: number) => {
    const got = run.levels.find((l) => l.direction === direction && l.s === s);
    assert.ok(got !== undefined, `${direction} ${s}`);
    return got;
  };
  for (const direction of ['forward', 'backward'] as const) {
    assert.equal(level(direction, 0.1).grayFlips.either, 0, `${direction} 0.1 flipped a word`);
    assert.ok(level(direction, 0.6).grayFlips.either > 0, `${direction} 0.6 flipped nothing it could count`);
    // The seam, pixel by pixel from decodes made here.
    const clean = decodeRun(c, p, runImages(b, c, p, CLEAN)).correspondences;
    const treated = decodeRun(c, p, runImages(b, c, p, designedPhotos(direction, () => 0.1, 1))).correspondences;
    const neighbour = litMask(b, c, direction === 'forward' ? p + 1 : p - 1);
    const was = new Set(clean.map(pixelKey));
    const matched = treated.filter((y) => was.has(pixelKey(y)));
    const inSeam = matched.filter((y) => neighbour[(y.camV - 0.5) * b.width + (y.camU - 0.5)] === 1).length;
    assert.deepEqual([level(direction, 0.1).signs.seam.pixels, level(direction, 0.1).signs.rest.pixels], [inSeam, matched.length - inSeam], direction);
  }
  assert.notEqual(level('forward', 0.1).signs.seam.pixels, level('backward', 0.1).signs.seam.pixels, 'both directions split by one neighbour');
});

test('T39 the pose stage keeps both re-shoots of each designed rig: the same seeds, the clean refusals withheld, each in its own list', async () => {
  // T33 holds nullSpecs and solveNulls; this holds the pose stage's own use of
  // them. Every solve is answered from the record, so nothing renders. Under a
  // stage that handed the position re-shoots no exclusions, or stored the whole
  // re-shoots in their place, every test passed and only a changed smoke
  // number would have said so.
  const { TEST_PLAN, memoryStore, nullSpecs, runContext, solveId, stageBank, stagePose } = await import('../src/straddle/stages.ts');
  const plan = { ...TEST_PLAN, pose: true, kNull: 2, poseLevels: { forward: [0.06], backward: [], rolling: { readoutOverExposure: 0.3, midRow: [] } } };
  const ctx = runContext(plan, memoryStore(), () => {});
  const bank = stageBank(ctx);
  const asked: string[] = [];
  const answered = new Map<string, unknown>();
  answered.get = (id: string) => {
    asked.push(id);
    return { id };
  };
  ctx.solves = answered as never;
  const pose = stagePose(ctx);
  assert.ok(pose !== null);
  const k = plan.designedRigs[0];
  const unit = pose.units[`main:${k}`];
  // What the clean capture refuses, from the bank's own twins: the pairs the
  // plain twin withholds, and so every re-shoot measured against it.
  const refusedClean = bank.units[`main:${k}`].twins
    .flatMap((t) => RUNS.filter((p) => !t.placedContent.includes(p)).map((p) => `${t.camera}.${p}`))
    .sort();
  assert.ok(refusedClean.length > 0, 'nothing refused on the clean capture, so the exclusions are untested');
  const specs = nullSpecs(k, plan.variant, refusedClean, plan.kNull);
  assert.equal(unit.plain, solveId({ kind: 'twin', rig: k, variant: plan.variant, straddle: 'none', exclude: refusedClean, captureSeed: null }));
  assert.deepEqual(unit.nulls, specs.whole.map(solveId));
  assert.deepEqual(unit.positionNulls, specs.position.map(solveId));
  assert.ok([...unit.nulls, ...unit.positionNulls].every((id) => asked.includes(id)), 'a re-shoot was recorded without being asked for');
});

test('T40 Q0 photographs a camera alone with the noise its twin is built from', async () => {
  // A fine unit photographs one camera of its rig. Rendered alone that camera
  // sits at position 0, and keyed by position it drew camera 0's noise, while
  // its twin is noised as the camera it is (`noisyRun`): the page's verdict and
  // the twin's were on two different photographs. T21 checks the renderer
  // against `noisyRun` on camera 0, the one camera whose position and index
  // agree, which is how this went unseen.
  const { q0CaptureOptions } = await import('../src/straddle/stages.ts');
  const b = rig();
  const c = 1;
  assert.ok(b.cameras.includes(c), 'the reduced rig has no second camera to photograph alone');
  const photographAlone = (key: 'rig' | 'position'): PatternCapture[] => {
    const out: PatternCapture[] = [];
    const options = q0CaptureOptions(b, [c], (_i, _p, capture) => {
      out.push(capture);
    });
    captureAndDecode(
      b.world.truthRig,
      [b.world.cameras[c]],
      key === 'rig' ? options : { ...options, noiseCameraIndices: null },
    );
    return out;
  };
  const bits = DEFAULT_SENSOR.quantizationBits;
  assert.ok(bits !== null);
  const step = DEFAULT_SENSOR.saturationRadiance / (2 ** bits - 1);
  const agreement = (rendered: PatternCapture[]): { share: number; worstSteps: number } => {
    let total = 0;
    let same = 0;
    let worstSteps = 0;
    for (let p = 0; p < PROJECTORS; p++) {
      const twin = noisyRun(b, c, p, (f) => b.frames[c][p][f], DEFAULT_SENSOR, b.seed);
      const theirs = planOrder(rendered[p]);
      for (let f = 0; f < FRAMES_PER_RUN; f++) {
        for (let i = 0; i < twin[f].data.length; i++) {
          total++;
          if (twin[f].data[i] === theirs[f].data[i]) same++;
          else worstSteps = Math.max(worstSteps, Math.abs(Math.round(twin[f].data[i] / step) - Math.round(theirs[f].data[i] / step)));
        }
      }
    }
    return { share: same / total, worstSteps };
  };
  // The same tolerance as T21's, for the same reason: the twin noises a Float32
  // frame where the renderer noised the double.
  const keyed = agreement(photographAlone('rig'));
  assert.ok(keyed.share >= 0.999, `camera ${c} alone matches its twin on only ${(100 * keyed.share).toFixed(2)}% of pixels`);
  assert.ok(keyed.worstSteps <= 1, `camera ${c} alone differs from its twin by ${keyed.worstSteps} quantisation steps`);
  const unkeyed = agreement(photographAlone('position'));
  assert.ok(unkeyed.share < 0.5, `keyed by position, camera ${c} still matched its twin on ${(100 * unkeyed.share).toFixed(2)}%: this test cannot see the key`);
});

// ---------------------------------------------------------------------------
// T41-: the page column's record of a straddled position
// ---------------------------------------------------------------------------

test('T41 a run the page places is judged by what its photographs show, and a reader that throws is recorded, not raised', async () => {
  // The page finds a run by what its frames show. Under a late emitter
  // photograph j can show step j - 1, so the page can place a run one
  // photograph late (offset +1) and be right about every photograph in it;
  // past half a forward straddle, one photograph early (offset -1). Counted
  // against the folder's order either is 34 misfiles; counted against what
  // each photograph shows, none. The page column counts the
  // second, by `contentStep`, the same rule the counterfactual's content
  // footing reads kinds by, so the two cannot disagree about what a photograph
  // is. A photograph that shows no step by a majority is neither right nor
  // wrong, and the dark after the last step is no run's frame.
  const { contentStep, pageParts, runFiling } = await import('../src/straddle/run.ts');
  const { pageRecord } = await import('../src/straddle/stages.ts');
  const photo = (filedStep: number, ...rows: { step: number; weight: number }[][]): Photo => ({
    filedStep,
    rows: rows.map((r) => pageParts(r, STEPS)),
  });
  assert.equal(contentStep(photo(5, [{ step: 5, weight: 0.6 }, { step: 6, weight: 0.4 }])), 5);
  assert.equal(contentStep(photo(5, [{ step: 5, weight: 0.4 }, { step: 6, weight: 0.6 }])), 6);
  assert.equal(contentStep(photo(5, [{ step: 5, weight: 0.5 }, { step: 6, weight: 0.5 }])), null, 'a tie is a majority');
  assert.equal(contentStep(photo(5, [{ step: 4, weight: 0.3 }, { step: 5, weight: 0.4 }, { step: 6, weight: 0.3 }])), null, 'a three-way split is a majority');
  assert.equal(contentStep(photo(135, [{ step: 135, weight: 0.2 }, { step: 136, weight: 0.8 }])), STEPS.length, 'the dark is not a step');
  // Rolling rows: a part's share is its weight averaged over the rows.
  assert.equal(contentStep(photo(5, [{ step: 5, weight: 1 }], [{ step: 6, weight: 1 }], [{ step: 6, weight: 1 }])), 6);
  assert.equal(contentStep(photo(5, [{ step: 5, weight: 1 }], [{ step: 6, weight: 1 }])), null);
  // The content footing reads its kinds by the same rule, the filed step where there is none.
  for (const photos of [designedPhotos('forward', () => 0.7, 1), designedPhotos('backward', () => 0.5, 1), designedPhotos('forward', (row) => [0.3, 0.45, 0.6, 0.75][row], 4)]) {
    const kinds = oracleObservations(photos, 'content').map((o) => o.litFraction);
    assert.deepEqual(kinds, photos.map((ph) => oracleObservations([{ ...ph, filedStep: contentStep(ph) ?? ph.filedStep }], 'filed')[0].litFraction));
  }

  // A run placed where the folder files it, on the clean position: nothing misfiled.
  const p = 1;
  assert.deepEqual(runFiling(CLEAN, p, p * FRAMES_PER_RUN), { misfiled: [], ambiguous: 0 });
  // Each photograph of a run misfiled from `start`, as it would be listed.
  const listed = (start: number, projector: number, shows: (j: number) => number, share: number) =>
    Array.from({ length: FRAMES_PER_RUN }, (_, f) => ({
      photo: start + f,
      filedStep: projector * FRAMES_PER_RUN + f,
      contentStep: shows(start + f),
      share,
    }));
  // Forward at 0.95 every photograph shows the step after its own, so the run
  // the page can find starts one photograph early, and there it misfiles none.
  const ahead = designedPhotos('forward', () => 0.95, 1);
  assert.deepEqual(runFiling(ahead, p, p * FRAMES_PER_RUN - 1), { misfiled: [], ambiguous: 0 });
  assert.deepEqual(runFiling(ahead, p, p * FRAMES_PER_RUN), { misfiled: listed(p * FRAMES_PER_RUN, p, (j) => j + 1, 0.95), ambiguous: 0 });
  // Placed one photograph late instead, each is filed two steps before the
  // one it shows: an entry's filed step is the placed run's, not the folder's.
  assert.deepEqual(runFiling(ahead, p, p * FRAMES_PER_RUN + 1).misfiled, listed(p * FRAMES_PER_RUN + 1, p, (j) => j + 1, 0.95));
  // Behind a late emitter every photograph can show the step before its own,
  // so the run starts one photograph late, and there it misfiles none.
  const behind = CLEAN.map((_, j) => photo(j, [{ step: j - 1, weight: 1 }]));
  assert.deepEqual(runFiling(behind, p, p * FRAMES_PER_RUN + 1), { misfiled: [], ambiguous: 0 });
  assert.deepEqual(runFiling(behind, p, p * FRAMES_PER_RUN), { misfiled: listed(p * FRAMES_PER_RUN, p, (j) => j - 1, 1), ambiguous: 0 });
  // At 0.5 no photograph shows a step: all ambiguous, none misfiled.
  assert.deepEqual(runFiling(designedPhotos('forward', () => 0.5, 1), p, p * FRAMES_PER_RUN), { misfiled: [], ambiguous: FRAMES_PER_RUN });
  // A photograph of the dark filed in a run is a misfile.
  const darkLast = CLEAN.map((ph, j) => (j === STEPS.length - 1 ? photo(j, [{ step: STEPS.length, weight: 1 }]) : ph));
  const last = (PROJECTORS - 1) * FRAMES_PER_RUN;
  assert.deepEqual(runFiling(darkLast, PROJECTORS - 1, last), {
    misfiled: [{ photo: STEPS.length - 1, filedStep: STEPS.length - 1, contentStep: STEPS.length, share: 1 }],
    ambiguous: 0,
  });
  // A photograph a hair past a tie is a majority all the same, so it is a
  // misfile when filed under its minority step, and its entry says by how
  // much. Every misfile of the quick run was of this kind: filed where the
  // folder files it, its majority barely over half.
  const nearTie = CLEAN.map((ph, j) =>
    j === STEPS.length - 1 ? photo(j, [{ step: j - 1, weight: 0.50026 }, { step: j, weight: 0.49974 }]) : ph,
  );
  const tie = { photo: STEPS.length - 1, filedStep: STEPS.length - 1, contentStep: STEPS.length - 2, share: 0.50026 };
  assert.deepEqual(runFiling(nearTie, PROJECTORS - 1, last), { misfiled: [tie], ambiguous: 0 });
  // Its share is the photograph's, averaged over the rows of a rolling readout.
  const rolled = CLEAN.map((ph, j) =>
    j === STEPS.length - 1 ? photo(j, [{ step: j - 1, weight: 1 }], [{ step: j - 1, weight: 0.25 }, { step: j, weight: 0.75 }]) : ph,
  );
  assert.deepEqual(runFiling(rolled, PROJECTORS - 1, last).misfiled, [{ ...tie, share: 0.625 }]);

  // The record, from an IndexedCapture written by hand.
  const run = (projector: number, start: number) => ({ projector, ordinals: Array.from({ length: FRAMES_PER_RUN }, (_, f) => start + f) });
  const indexed = (runs: { projector: number; ordinals: number[] }[]) => ({
    ok: true,
    runs,
    problems: ['a problem'],
    notes: ['a note'],
    unseen: [3],
    barelySeen: [0],
    reshoots: [],
    mechanism: 'position' as const,
    total: STEPS.length,
    placed: FRAMES_PER_RUN * runs.length,
  });
  const got = pageRecord(() => indexed([run(1, 33), run(2, 68)]), ahead);
  assert.deepEqual(got, {
    ok: true,
    placed: [1, 2],
    starts: [33, 68],
    offsets: [-1, 0],
    contentMisfiles: [0, FRAMES_PER_RUN],
    misfiled: listed(68, 2, (j) => j + 1, 0.95),
    ambiguous: [0, 0],
    unseen: [3],
    barelySeen: [0],
    reshoots: 0,
    problems: ['a problem'],
    notes: ['a note'],
    crash: null,
  });
  // The position's list runs through every placed run, and each run's count
  // is how many of it lie in that run: the near-tie is the last run's one.
  const tied = pageRecord(() => indexed([run(2, 68), run(3, last)]), nearTie);
  assert.deepEqual([tied.contentMisfiles, tied.misfiled], [[0, 1], [tie]]);
  // A run that is not 34 photographs in a row is a crash, not a record.
  const gapped = run(1, 34);
  gapped.ordinals[20] = 100;
  const broken = pageRecord(() => indexed([gapped]), CLEAN);
  assert.match(broken.crash ?? '', /projector 2's run at photographs .* not 34 in a row/);
  assert.deepEqual([broken.placed, broken.problems, broken.ok], [[], [], false]);
  // A reader that throws on a folder stops nothing: the position records it.
  const thrown = pageRecord(() => {
    throw new Error('a folder this reader was never built against');
  }, CLEAN);
  assert.equal(thrown.crash, 'a folder this reader was never built against');
  assert.deepEqual(Object.keys(thrown).sort(), Object.keys(got).sort());
});

test('T42 the page column reads the clean position as its page twin, and three forward straddles as pinned here', async () => {
  // The page column hands every straddled position whole to the page's own
  // reader, and counts a run against the straddle only if the page twin, its
  // reading of the same clean frames, places it. So the twin is the clean
  // position through the column itself: read from the cache of the twin's
  // summaries, and read again with every run walked, both are the bank
  // stage's record, and it places every run where the folder files it.
  const { computeTwin, pagePath, reasonOf, rigContextOf } = await import('../src/straddle/stages.ts');
  const b = rig();
  const twins = b.cameras.map((c) => computeTwin(b, c).twin);
  const rc = rigContextOf('main:0', b, twins);
  const fields = ['ok', 'placed', 'starts', 'offsets', 'contentMisfiles', 'misfiled', 'ambiguous', 'unseen', 'barelySeen', 'reshoots', 'problems', 'notes', 'crash'];
  for (const c of b.cameras) {
    const twin = twins[c].page;
    assert.ok(twin !== undefined, `camera ${c} has no page twin`);
    assert.deepEqual(Object.keys(twin).sort(), [...fields].sort());
    assert.deepEqual(pagePath(rc, c, CLEAN, []), twin, `camera ${c}: the cached clean runs do not read as the twin`);
    assert.deepEqual(pagePath(rc, c, CLEAN, RUNS), twin, `camera ${c}: the clean runs walked again do not read as the twin`);
    assert.ok(twin.placed.length > 0 && twin.crash === null && twin.ok, JSON.stringify(twin));
    assert.deepEqual(twin.starts, twin.placed.map((p) => p * FRAMES_PER_RUN));
    for (const none of [twin.offsets, twin.contentMisfiles, twin.ambiguous]) assert.deepEqual(none, twin.placed.map(() => 0));
    assert.deepEqual(twin.misfiled, []);
    assert.deepEqual(twin.problems, []);
  }

  // Forward straddles of the whole position at 0.03, 0.3 and 0.95. What
  // follows is what the page was OBSERVED to make of them on this rig when
  // this test was written, pinned so that a change to the reader or to the
  // column shows here: observations, not predictions. At 0.95 it finds runs
  // one photograph early, which is a departure from the folder's order and
  // not a misfile, since each photograph shows the step it is placed as.
  const read = (s: number) => {
    const photos = designedPhotos('forward', () => s, 1);
    const touched = RUNS.filter((p) => photos.slice(p * FRAMES_PER_RUN, (p + 1) * FRAMES_PER_RUN).some(contentChanged));
    return b.cameras.map((c) => {
      const r = pagePath(rc, c, photos, touched);
      const { problems, notes, ...rest } = r;
      return { ...rest, reasons: problems.map(reasonOf), notes: notes.length };
    });
  };
  const at = (placed: number[], starts: number[], unseen: number[], reasons: string[], notes: number) => ({
    ok: reasons.length === 0,
    placed,
    starts,
    offsets: placed.map((p, i) => starts[i] - p * FRAMES_PER_RUN),
    contentMisfiles: placed.map(() => 0),
    misfiled: [],
    ambiguous: placed.map(() => 0),
    unseen,
    barelySeen: [],
    reshoots: 0,
    crash: null,
    reasons,
    notes,
  });
  const cleanAt = [at([0, 1, 2], [0, 34, 68], [3], [], 1), at([1, 2, 3], [34, 68, 102], [0], [], 1), at([0, 2, 3], [0, 68, 102], [1], [], 1)];
  assert.deepEqual(read(0.03), cleanAt, 'forward 0.03');
  assert.deepEqual(read(0.3), b.cameras.map(() => at([], [], [], ['norun'], 0)), 'forward 0.3');
  assert.deepEqual(
    read(0.95),
    [at([1], [33], [3], ['unfound', 'unfound'], 2), at([1, 2, 3], [33, 67, 101], [0], [], 2), at([2, 3], [67, 101], [1], ['unfound'], 2)],
    'forward 0.95',
  );

  // The twin's summaries are the rig's own stream read again, held to the
  // bank stage's page twin: a twin that no longer reads as recorded stops the
  // column, as `twinPrints` stops the counterfactual.
  const drifted = twins.map((t) => (t.camera === 0 ? { ...t, page: { ...(t.page as NonNullable<typeof t.page>), notes: [] } } : t));
  assert.throws(() => pagePath(rigContextOf('main:0', b, drifted), 0, CLEAN, [0]), /page twin no longer reads as the bank stage recorded it/);
  const unrecorded = twins.map((t) => (t.camera === 0 ? { ...t, page: undefined } : t));
  assert.throws(() => pagePath(rigContextOf('main:0', b, unrecorded), 0, CLEAN, [0]), /has no page reading on record/);
});

test("T43 Q0 keeps the reader the page replaced, and on this rig it reads as 754147f's code read it", async () => {
  // A re-run of Q0 with the page's current reader would leave the record of
  // the reader it replaced, which the experiment's precondition was written
  // from, in no results file. So Q0 hands the replaced reader the same
  // summaries, and each position carries both verdicts. Here the replaced one
  // is held to what the code at 754147f, where that reader was the page's,
  // recorded when its own Q0 was run on this rig for this test: every clean
  // position refused at classify, in these words and at these margins.
  const { MANIFEST: manifest } = await import('../src/straddle/design.ts');
  const { TEST_PLAN, memoryStore, replacedIndexPhotographs, runContext, stageQ0 } = await import('../src/straddle/stages.ts');
  let q0 = testPlanStore?.read('q0.json') ?? null;
  if (q0 === null) {
    const ctx = runContext(TEST_PLAN, memoryStore(), () => {});
    stageQ0(ctx);
    q0 = ctx.store.read('q0.json') as string;
  }
  type Q0 = import('../src/straddle/stages.ts').Q0Position;
  const positions = Object.values(JSON.parse(q0).units as Record<string, { positions: Q0[] }>).flatMap((u) => u.positions);
  const classify = (gap: string) =>
    `The white and black frames cannot be reliably told from the patterned ones: the closest two groups are ${gap} apart, ` +
    'under the 0.15 this needs. That usually means the sphere fills too little of the frame, the room is bright enough ' +
    'to lift the black frames, or the exposure is clipping the white ones. Nothing below this line would be a ' +
    'measurement; it would be a segmentation of noise.';
  assert.deepEqual(
    positions.map((p) => p.replaced),
    ['0.002', '0.054', '0.018'].map((gap) => ({ ok: false, placed: 0, runsPlaced: [], problems: [classify(gap)], reasons: ['margin'] })),
  );
  // Beside it the page's own reader places every run it sees and notes the
  // projector it cannot see, which is what Q0 now records of it.
  for (const p of positions) {
    assert.ok(p.runsPlaced.length > 0 && p.ok, `camera ${p.camera}: ${JSON.stringify(p.problems)}`);
    assert.equal(p.unseen.length, 1, `camera ${p.camera}`);
    assert.ok(p.notes.some((n) => n.startsWith(`Projector ${p.unseen[0] + 1} was not in this camera's view`)), JSON.stringify(p.notes));
    assert.deepEqual(p.barelySeen, []);
  }

  // Where it places nothing it names a clipped photograph as a possible cause,
  // above the page's own threshold and not at it.
  const b = rig();
  const summaries = STEPS.map(({ projector, frame }, j) =>
    summarisePhoto(
      encodeSrgb8({ width: b.width, height: b.height, channels: 1, data: b.frames[0][projector][frame] }, ENCODE_FULL_SCALE),
      j,
      `IMG_${String(j + 1).padStart(4, '0')}.png`,
      TRANSFER,
      FINGERPRINT_BLOCKS,
    ),
  );
  const clipped = replacedIndexPhotographs(summaries.map((x, j) => (j === 2 ? { ...x, clippedHigh: 0.25 } : x)), manifest);
  assert.deepEqual(clipped.runs, []);
  assert.equal(
    clipped.problems[clipped.problems.length - 1],
    "While nothing here decoded: 25.0% of IMG_0003.png is at the sensor's ceiling. A clipped white frame is one the " +
      'references cannot be told apart by, so an overexposed capture and an unreadable one look the same from here.',
  );
  const atThreshold = replacedIndexPhotographs(summaries.map((x, j) => (j === 2 ? { ...x, clippedHigh: 0.01 } : x)), manifest);
  assert.deepEqual(atThreshold.problems, clipped.problems.slice(0, -1));
});

test("T44 H8 holds the page's own reading of the fast path to its reading of the hook's frames", async () => {
  // The page column reads a straddled position from the fast path's frames,
  // where the page would have the camera's; H8 held only the counterfactual's
  // verdicts and the page's decode to the renderer's hook. The page's reader
  // finds runs by absolute block levels, so its agreement is its own claim.
  // Two readings agree when every field the page column counts by agrees.
  const { TEST_PLAN, gateHook, pageVerdictOf, rigContextOf, samePageVerdict } = await import('../src/straddle/stages.ts');
  type Verdict = import('../src/straddle/stages.ts').PageVerdict;
  const verdict: Verdict = { placed: [0, 2], unseen: [3], barelySeen: [1], problems: 1, crash: null };
  assert.equal(samePageVerdict(verdict, structuredClone(verdict)), true);
  const changes: [string, Partial<Verdict>][] = [
    ['placed', { placed: [0] }],
    ['placed', { placed: [0, 1] }],
    ['unseen', { unseen: [] }],
    ['barely seen', { barelySeen: [2] }],
    ['problems', { problems: 2 }],
    ['crash', { crash: 'a throw' }],
  ];
  for (const [field, other] of changes) {
    assert.equal(samePageVerdict(verdict, { ...verdict, ...other }), false, `readings that differ in ${field} agree`);
    assert.equal(samePageVerdict({ ...verdict, ...other }, verdict), false, `readings that differ in ${field} agree`);
  }

  // The gate stage's own record, at the quick plan's level on the reduced
  // rig: both readings, kept whole, and their agreement. The reading itself is
  // as observed when this test was written, not predicted.
  const b = rig();
  const [got] = gateHook(rigContextOf('main:0', b, []), { ...TEST_PLAN, hookLevels: [0.12] }, 0);
  assert.deepEqual(pageVerdictOf(got.pageFast), { placed: [0], unseen: [3], barelySeen: [], problems: 2, crash: null });
  // Whole, so where each reading placed its run, and in what words it refused
  // the others, is on record and not only how many of each.
  assert.deepEqual([got.pageFast.starts, got.pageFast.contentMisfiles, got.pageFast.misfiled], [[0], [0], []]);
  assert.match(got.pageFast.problems[0], /^Projector 2's frames 3 and 4 were played as a pattern and its complement/);
  assert.deepEqual(got.pageHook, got.pageFast);
  assert.equal(got.pageAgree, true);
  // Keeping them whole widens nothing H8-page registered: two readings that
  // place the same runs at different photographs still agree by it.
  const moved = { ...got.pageFast, starts: [1], offsets: [1] };
  assert.equal(samePageVerdict(pageVerdictOf(moved), pageVerdictOf(got.pageFast)), true);
  assert.ok(got.identical < got.pixels, 'the hook and the fast path are the same frames, so this compares nothing');
});

test('T45 every page record the reduced run wrote is what the page reads of that position afresh', async () => {
  // The rescoring hands the page column the twin's cached summaries for every
  // run a straddle did not touch, and for a touched run the frames its noisy
  // fingerprints were walked from. Both are the page's own reading by
  // construction, and T24's determinism cannot see it if they are not: a
  // wrong cache is wrong in both processes. So each changed position of R1
  // (whose frames the noisy walk hands over), R7 (a refresh wait per step) and
  // L-aimed-7.5 (a late emitter) is rebuilt from its cell's own shots and read
  // again, every touched run walked afresh, and must be the record the stage
  // wrote; a position nothing changed carries none.
  const S = await import('../src/straddle/stages.ts');
  let store = testPlanStore;
  if (store === null) {
    store = S.memoryStore();
    const ctx = S.runContext(S.TEST_PLAN, store, () => {});
    for (const stage of ['q0', 'bank', 'rescore', 'lateness'] as const) S.runStages(ctx, stage);
  }
  const checkpoint = (stage: string) => JSON.parse((store as NonNullable<typeof store>).read(`${stage}.json`) as string);
  const b = rig();
  const rc = S.rigContextOf('main:0', b, checkpoint('bank').units['main:0'].twins);
  const cells = [...S.rescoreCells(S.TEST_PLAN), ...S.latenessCells(S.TEST_PLAN)];
  type Scored = { pos: number; changed: boolean; touched: number[]; page: unknown };
  let reread = 0;
  for (const [stage, id] of [['rescore', 'R1'], ['rescore', 'R7'], ['lateness', 'L-aimed-7.5']]) {
    const cell = cells.find((x) => x.id === id);
    assert.ok(cell !== undefined, id);
    for (const cap of checkpoint(stage).units['A:main:0'].score.cells[id] as { t: number; positions: Scored[] }[]) {
      for (const pos of cap.positions) {
        if (!pos.changed) {
          assert.equal(pos.page, null, `${id} trial ${cap.t} position ${pos.pos} changed nothing and carries a page reading`);
          continue;
        }
        const photos = S.cellPhotos(cell, S.cellShots(cell, cap.t), cap.t, pos.pos, b.height);
        assert.deepEqual(S.pagePath(rc, pos.pos, photos, pos.touched), pos.page, `${id} trial ${cap.t} position ${pos.pos}`);
        reread++;
      }
    }
  }
  assert.ok(reread >= 10, `only ${reread} positions re-read`);
});

// ---------------------------------------------------------------------------
// T46-T49: what the document makes of the page column
// ---------------------------------------------------------------------------

type PageRead = import('../src/straddle/stages.ts').PagePosition;

/** A page reading written out by hand: each placed run where the folder files it, nothing misfiled. */
function handPage(over: Partial<PageRead> = {}): PageRead {
  const placed = over.placed ?? [];
  return {
    ok: (over.problems ?? []).length === 0,
    placed,
    starts: placed.map((p) => p * FRAMES_PER_RUN),
    offsets: placed.map(() => 0),
    contentMisfiles: placed.map(() => 0),
    misfiled: [],
    ambiguous: placed.map(() => 0),
    unseen: [],
    barelySeen: [],
    reshoots: 0,
    problems: [],
    notes: [],
    crash: null,
    ...over,
  };
}

/** The words `indexPosition` writes for one run it could not find, and for a folder it could not read. */
const unfound = (p: number): string =>
  `Projector ${p + 1}'s photographs are lit, but no run of 34 could be found among them: its white and black, or its ` +
  'phase frames, are not where a run of this plan puts them, which is what a dropped, doubled or out-of-order ' +
  `photograph looks like — this run is dropped and the rest of the position is unaffected. Re-shoot projector ${p + 1}.`;
const NO_RUN =
  "No projector run could be found in the 136 photographs: nowhere do a white, a black and the plan's phase frames " +
  'sit where a run of 34 puts them.';
const GAP =
  'Photographs 69–80 lie between two runs, and 12 photographs is not within 2 of a whole number of runs of 34, so ' +
  'the projector numbers after photograph 69 cannot be worked out: the 2 runs found after it are not used, and ' +
  'projectors 3 and 4 are not decoded. Shoot the whole camera position again.';

/** A twin whose page reading places `placed` and notes the rest, beside handTwin's counterfactual verdicts. */
function handPageTwin(camera: number, placed: number[], barelySeen: number[] = []): Twin {
  const rest = RUNS.filter((p) => !placed.includes(p) && !barelySeen.includes(p));
  return { ...handTwin(camera), page: handPage({ placed, barelySeen, unseen: rest }) };
}

test('T46 the page column: each run\'s verdict, attributed against the page twin, a quiet drop neither refused nor placed', async () => {
  // The page's reader does three things with a run it does not place: names
  // it in a problem, refuses the whole folder, or only notes it as out of
  // view or barely seen. A note asks the operator for nothing, so a run the
  // page twin places and a straddle turns into a note is a quiet drop (P12):
  // counted as a refusal, it made a capture LOUD though nobody was told; and
  // attributed against the counterfactual's twin, a grazing run the page only
  // ever notes counted against the straddle.
  const { pageRunVerdicts, problemsRefusing, pageRunsOf, classifyPagePosition, pageCategoryOf, pageCaptureClass } = await import(
    '../src/straddle/assemble.ts'
  );
  // Placed, named, barely seen and out of view, one of each.
  assert.deepEqual(pageRunVerdicts(handPage({ placed: [0], problems: [unfound(1)], barelySeen: [2], unseen: [3] })), ['placed', 'refused', 'noted', 'noted']);
  // The whole folder refused: nothing placed, a problem about the folder.
  assert.deepEqual(pageRunVerdicts(handPage({ problems: [NO_RUN] })), ['refused', 'refused', 'refused', 'refused']);
  // Nothing placed and two runs named: the one only noted is a note, as P12 reads it.
  assert.deepEqual(pageRunVerdicts(handPage({ problems: [unfound(0), unfound(1)], barelySeen: [2], unseen: [3] })), ['refused', 'refused', 'noted', 'noted']);
  // A stretch between two runs that is not whole runs: the runs before it are
  // placed, the projectors after it are refused by the folder's problem.
  assert.deepEqual(pageRunVerdicts(handPage({ placed: [0, 1], problems: [GAP] })), ['placed', 'placed', 'refused', 'refused']);
  // A reader that threw read nothing.
  assert.deepEqual(pageRunVerdicts(handPage({ crash: 'the page placed projector 1 at photographs 1, 3' })), ['crashed', 'crashed', 'crashed', 'crashed']);
  // Nothing said of a run the reader always says something of: counted apart.
  assert.deepEqual(pageRunVerdicts(handPage({ placed: [0, 1, 2] })), ['placed', 'placed', 'placed', 'unaccounted']);
  // The words that refuse a run: those naming it, or else the folder's.
  assert.deepEqual(problemsRefusing({ problems: [unfound(1), NO_RUN] }, 1, 'refused'), [unfound(1)]);
  assert.deepEqual(problemsRefusing({ problems: [unfound(1), NO_RUN] }, 2, 'refused'), [NO_RUN]);
  assert.deepEqual(problemsRefusing({ problems: [unfound(1)] }, 1, 'noted'), []);

  // Attribution: the counterfactual's twin places runs 0-2 (handTwin); the page
  // twin places 0 and 1 and only notes run 2, which grazes this camera.
  const twin = handPageTwin(0, [0, 1], [2]);
  const at = (touched: number[], page: PageRead) => ({ ...handPosition(0, touched, [placedRun(), placedRun(), placedRun(), invisibleRun()]), page });
  const grazing = at([1, 2], handPage({ placed: [0], problems: [unfound(1)], barelySeen: [2], unseen: [3] }));
  const runs = pageRunsOf(grazing, twin);
  assert.deepEqual(runs.map((r) => [r.touched, r.attributable, r.counterfactualAttributable, r.verdict]), [
    [false, true, true, 'placed'],
    [true, true, true, 'refused'],
    [true, false, true, 'noted'],
    [false, false, false, 'noted'],
  ]);
  // Run 2 does not count against the straddle: the page twin never placed it.
  assert.equal(pageCategoryOf(grazing, twin, false), 'REFUSED-ALL');
  // Against the counterfactual's twin it would have: refused and noted, none placed.
  assert.equal(classifyPagePosition(runs.map((r) => ({ ...r, attributable: r.counterfactualAttributable }))), 'REFUSED-ALL');
  assert.throws(() => pageRunsOf(grazing, handTwin(0)), /has no page reading/, 'a reading was attributed against a twin with no page reading');

  // A quiet drop: run 1, which the page twin places, only barely seen.
  const quiet = at([1], handPage({ placed: [0], barelySeen: [1], unseen: [2, 3] }));
  assert.equal(pageCategoryOf(quiet, twin, false), 'QUIET');
  // Beside a placed touched run it is still QUIET: neither PLACED nor refused.
  const half = at([0, 1], handPage({ placed: [0], barelySeen: [1], unseen: [2, 3] }));
  assert.equal(pageCategoryOf(half, twin, false), 'QUIET');
  // Beside a refusal the position is as loud as the refusal makes it.
  const loud = at([0, 1], handPage({ problems: [unfound(0)], barelySeen: [1], unseen: [2, 3] }));
  assert.equal(pageCategoryOf(loud, twin, false), 'REFUSED-ALL');
  const placedToo = at([0, 1], handPage({ placed: [0], problems: [unfound(1)], unseen: [2, 3] }));
  assert.equal(pageCategoryOf(placedToo, twin, false), 'MIXED');
  // A crash counts as a refusal.
  assert.equal(pageCategoryOf(at([0], handPage({ crash: 'boom' })), twin, false), 'REFUSED-ALL');
  // Touching only runs the page twin does not place is INVISIBLE-ONLY.
  assert.equal(pageCategoryOf(at([2], handPage({ placed: [0, 1], barelySeen: [2], unseen: [3] })), twin, false), 'INVISIBLE-ONLY');
  assert.equal(pageCategoryOf(untouchedPosition(0), twin, false), 'UNTOUCHED');
  // A QUIET position asks for nothing, so its capture is silent unless another is refused.
  assert.equal(pageCaptureClass(['QUIET', 'UNTOUCHED', 'UNTOUCHED'], null, 'P').class, 'SILENT-UNSOLVED');
  assert.equal(pageCaptureClass(['QUIET', 'REFUSED-ALL', 'UNTOUCHED'], null, 'P').class, 'LOUD');
  assert.equal(pageCaptureClass(['QUIET', 'REFUSED-ALL', 'UNTOUCHED'], null, 'P').loudAndSilent, true);
  assert.equal(pageCaptureClass(['INVISIBLE-ONLY', 'UNCHANGED', 'UNTOUCHED'], null, 'P').class, 'INVISIBLE-ONLY');
});

test("T47 the page's words: reasonOf's classes refined, never a throw, and the parser acceptance.ts reads problems by", async () => {
  // `reasonOf` throws on a sentence it does not know, which is right in a
  // stage and wrong in a document that can be re-assembled: an unknown
  // sentence found after the run must be counted, not crash the assembly.
  // And the projector a problem names is read by one rule in two places:
  // `reader/acceptance.ts` keeps its own `problemProjector` unexported, so the
  // assembly states it again, and this holds the two to each other on every
  // problem the reduced run's page column wrote, by running acceptance.ts's
  // own function from its source.
  const { pageWordsOf, problemProjectorOf } = await import('../src/straddle/assemble.ts');
  const { reasonOf } = await import('../src/straddle/stages.ts');
  const other = 'The page has learned a new way of saying no.';
  assert.throws(() => reasonOf(other));
  assert.equal(pageWordsOf(other), 'other');
  assert.equal(pageWordsOf(''), 'other');
  assert.equal(pageWordsOf(unfound(2)), 'unfound');
  assert.equal(pageWordsOf(NO_RUN), 'norun');
  assert.equal(pageWordsOf(GAP), 'numbering-gap');
  assert.equal(pageWordsOf("Projector 3's run holds 35 photographs and should hold 34: photograph 103, after its last frame, lights only what this projector lights, so it is one more of this run"), 'length-extra');
  assert.equal(pageWordsOf("Projector 2's run holds 35 photographs and should hold 34. Its neighbours were found, so the fault is inside it"), 'length-slot');
  assert.equal(pageWordsOf("Projector 2's run holds 33 photographs and should hold 34."), 'length');
  assert.equal(pageWordsOf("Projector 1's photographs are lit, but no run of 34 could be found among them, and the light in them changes the way a room changes rather than the way a projector's patterns do"), 'unfound-room');
  assert.equal(pageWordsOf("Projector 2's re-shot frames 3 and 4 were played as a pattern and its complement, and they no longer add up to one"), 'broken');

  // acceptance.ts's own problemProjector, compiled from its source text.
  const fs = await import('node:fs');
  const ts = (await import('typescript')).default;
  const source = fs.readFileSync(new URL('../src/reader/acceptance.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('acceptance.ts', source, ts.ScriptTarget.Latest, true);
  let text: string | null = null;
  file.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'problemProjector') text = node.getText(file);
  });
  assert.ok(text !== null, 'reader/acceptance.ts no longer has a problemProjector to hold this to');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const theirs = new Function(`${js}\nreturn problemProjector;`)() as (problem: string) => number | null;
  // Every problem the reduced run's page column wrote, and the hand-written ones above.
  let store = testPlanStore;
  if (store === null) {
    const S = await import('../src/straddle/stages.ts');
    store = S.memoryStore();
    const ctx = S.runContext(S.TEST_PLAN, store, () => {});
    for (const stage of ['q0', 'bank', 'rescore', 'lateness'] as const) S.runStages(ctx, stage);
  }
  const problems = new Set<string>([other, '', unfound(0), unfound(3), NO_RUN, GAP]);
  type Units = Record<string, { score?: { cells: Record<string, { positions: { page: PageRead | null }[] }[]> } }>;
  const collect = (units: Units): void => {
    for (const u of Object.values(units)) {
      for (const caps of Object.values(u.score?.cells ?? {})) {
        for (const cap of caps) for (const pos of cap.positions) for (const x of pos.page?.problems ?? []) problems.add(x);
      }
    }
  };
  for (const stage of ['rescore', 'lateness']) collect(JSON.parse(store.read(`${stage}.json`) as string).units as Units);
  const reduced = problems.size;
  assert.ok(reduced > 10, `only ${reduced} problems to hold the parser to`);
  // And a quick run's, where one has been made in this checkout: its page
  // column reads four rigs and every lateness, and says more than the
  // reduced design's does. Its checkpoints are not committed.
  const quick = new URL('../../../experiments/.experiment-10-partial/quick/', import.meta.url);
  for (const stage of ['rescore', 'lateness']) {
    const file = new URL(`${stage}.json`, quick);
    if (fs.existsSync(file)) collect(JSON.parse(fs.readFileSync(file, 'utf8')).units as Units);
  }
  let named = 0;
  for (const x of problems) {
    assert.equal(problemProjectorOf(x), theirs(x), x);
    if (theirs(x) !== null) named++;
  }
  assert.ok(named > 0 && named < problems.size, 'the problems held to it are all of one kind');
});

test('T48 a capture the page lets through takes a solve\'s harm only where the page\'s plan, placement included, is that solve\'s', async () => {
  // No capture is solved for the page. A counterfactual solve renders a
  // straddled position with the counterfactual's own assignment, and its id
  // records the positions and exclusions, not where each run was placed. So
  // its harm is the page's only where the page's plan is the same positions,
  // the same exclusions, and every kept run at the same photographs; anything
  // else is not solved.
  const { pagePlanOf, pageSolveOf, pageRunVerdicts, summariseCell } = await import('../src/straddle/assemble.ts');
  const { TEST_PLAN, latenessCells, solveId } = await import('../src/straddle/stages.ts');
  const twins = [0, 1, 2].map((c) => handPageTwin(c, [0, 1, 2]));
  const reading = (starts: number[]) => handPage({ placed: [0, 1, 2], starts, unseen: [3] });
  const capWith = (page: PageRead, assignment: (number | null)[] | null = null) => ({
    t: 7,
    rig: 0,
    positions: [{ ...handPosition(0, [0], [placedRun(), placedRun(), placedRun(), invisibleRun()]), page, assignment }, untouchedPosition(1), untouchedPosition(2)],
  });
  const cap = capWith(reading([0, 34, 68]));
  const cats = ['PLACED', 'UNTOUCHED', 'UNTOUCHED'] as const;
  const verdictsAt = (c: number) => (c === 0 ? pageRunVerdicts(cap.positions[0].page as PageRead) : []);
  const plan = pagePlanOf(cap, cats, verdictsAt, (c) => twins[c].page?.placed ?? [], [0, 1, 2], 'P');
  assert.deepEqual(plan, { positions: [0], exclude: ['0.3', '1.3', '2.3'] });
  // A QUIET position is straddled as a PLACED one is, and what it dropped is withheld.
  const quiet = pagePlanOf(cap, ['QUIET', 'UNTOUCHED', 'UNTOUCHED'], () => ['placed', 'noted', 'placed', 'noted'], (c) => twins[c].page?.placed ?? [], [0, 1, 2], 'P');
  assert.deepEqual(quiet, { positions: [0], exclude: ['0.1', '0.3', '1.3', '2.3'] });
  assert.equal(pagePlanOf(cap, ['REFUSED-ALL', 'UNTOUCHED', 'UNTOUCHED'], verdictsAt, (c) => twins[c].page?.placed ?? [], [0, 1, 2], 'P'), null);

  const spec = (straddle: string, exclude: string[]) => ({ straddle, exclude });
  const specs: Record<string, { straddle: string; exclude: string[] }> = {
    same: spec('L-aimed-7.5/t7/[0]', ['0.3', '1.3', '2.3']),
    moreExcluded: spec('L-aimed-7.5/t7/[0]', ['0.2', '0.3', '1.3', '2.3']),
    otherPositions: spec('L-aimed-7.5/t7/[0,1]', ['0.3', '1.3', '2.3']),
  };
  const specOf = (id: string) => specs[id] ?? null;
  const pair = (treated: string) => ({ treated, twin: 'twin' });
  const p = plan as NonNullable<typeof plan>;
  assert.deepEqual(pageSolveOf(p, cap, [pair('same')], specOf), { pair: pair('same'), why: 'same plan' });
  assert.deepEqual(pageSolveOf(p, cap, [pair('moreExcluded')], specOf), { pair: null, why: 'exclusions' });
  assert.deepEqual(pageSolveOf(p, cap, [pair('otherPositions')], specOf), { pair: null, why: 'positions' });
  assert.deepEqual(pageSolveOf(p, cap, [], specOf), { pair: null, why: 'no solve' });
  // The solve decoded run 0 one photograph late (its own assignment); the page placed it where it is filed.
  const late: (number | null)[] = STEPS.map(() => null);
  for (let f = 0; f < FRAMES_PER_RUN; f++) late[f + 1] = f;
  assert.deepEqual(pageSolveOf(p, capWith(reading([0, 34, 68]), late), [pair('same')], specOf), { pair: null, why: 'placement' });
  // ...and where the page placed it one photograph late too, the plans are one.
  assert.deepEqual(pageSolveOf(p, capWith(reading([1, 34, 68]), late), [pair('same')], specOf), { pair: pair('same'), why: 'same plan' });
  // A run the plan withholds is placed nowhere that matters.
  assert.deepEqual(pageSolveOf({ ...p, exclude: [...p.exclude, '0.0'].sort() }, capWith(reading([0, 34, 68]), late), [pair('x')], () => spec('L-aimed-7.5/t7/[0]', ['0.0', '0.3', '1.3', '2.3'])), { pair: pair('x'), why: 'same plan' });
  // The nearest miss is reported.
  assert.deepEqual(pageSolveOf(p, capWith(reading([0, 34, 68]), late), [pair('otherPositions'), pair('same')], specOf).why, 'placement');

  // Through the cell's summary: the solve of the same plan judges the page's
  // capture as it judges the counterfactual's; a page placing run 0 elsewhere
  // leaves it not solved, beside the same counterfactual verdict.
  const cell = latenessCells(TEST_PLAN).find((c) => c.id === 'L-aimed-7.5');
  assert.ok(cell !== undefined);
  const treatedId = solveId({ kind: 'capture', rig: 0, variant: 'reduced', straddle: 'L-aimed-7.5/t7/[0]', exclude: ['0.3', '1.3', '2.3'], captureSeed: null });
  const solves = new Map<string, unknown>();
  solves.set(treatedId, { ...handSolve(treatedId, 0.45, { dGridMm: 0.3 }), spec: { kind: 'capture', rig: 0, variant: 'reduced', straddle: 'L-aimed-7.5/t7/[0]', exclude: ['0.3', '1.3', '2.3'], captureSeed: null } });
  solves.set('twin', handSolve('twin', 0.4));
  const summary = (page: PageRead) => {
    const ev = {
      plan: { ...TEST_PLAN, rigs: [0] },
      q0: { units: { 'main:0': { positions: [{ runsPlaced: [0] }] } } },
      bank: { units: { 'main:0': { width: 0, height: 0, seed: 0, twins } } },
      solves,
    } as unknown as Parameters<typeof summariseCell>[0];
    const file = {
      units: {
        'A:main:0': { score: { cells: { [cell.id]: [capWith(page)] } } },
        'S:main:0': { solves: [{ cell: cell.id, t: 7, rig: 0, a: pair(treatedId), p: pair(treatedId), pIsA: true }] },
      },
    } as unknown as Parameters<typeof summariseCell>[2];
    return summariseCell(ev, cell, file, 0.5);
  };
  const same = summary(reading([0, 34, 68]));
  assert.equal(same.classes.P.counts['SILENT-HARMLESS'], 1, 'the counterfactual did not judge its own capture');
  assert.ok(same.page.status === 'read');
  assert.equal(same.page.classes.P.counts['SILENT-HARMLESS'], 1, 'a solve of the page\'s own plan did not judge the page\'s capture');
  assert.deepEqual(same.page.classes.P.harm, { silentPart: 1, samePlan: 1, notSolved: 0, why: { 'no solve': 0, positions: 0, exclusions: 0, placement: 0 } });
  const moved = summary(reading([1, 34, 68]));
  assert.ok(moved.page.status === 'read');
  assert.equal(moved.classes.P.counts['SILENT-HARMLESS'], 1);
  assert.deepEqual([moved.page.classes.P.counts['SILENT-HARMLESS'], moved.page.classes.P.counts['SILENT-UNSOLVED']], [0, 1], 'a solve of another placement judged the page\'s capture');
  assert.deepEqual(moved.page.classes.P.harm.why, { 'no solve': 0, positions: 0, exclusions: 0, placement: 1 });
});

test('T49 the re-run\'s bets P10-P13 are read off the page blocks and Q0, each held and each falsified', async () => {
  const { evaluateRerunBets, q0AgainstPageTwin, pageTwinIdentity } = await import('../src/straddle/assemble.ts');
  const { RERUN_PREDICTIONS } = await import('../src/straddle/design.ts');
  const block = (over: { misfiled?: number; quiet?: number; silent?: number } = {}) => ({
    status: 'read' as const,
    read: { captures: 728 },
    classes: { P: { counts: { LOUD: 600, 'SILENT-HARMLESS': 0, 'SILENT-BIASED': 0, 'SILENT-GATE-BREAKING': 0, 'SILENT-UNJUDGEABLE': 0, 'SILENT-UNSOLVED': over.silent ?? 90 } } },
    quiet: { runs: over.quiet ?? 0, positions: over.quiet ?? 0, captures: over.quiet ?? 0, silentOnlyThroughQuiet: 0 },
    misfiles: { photographs: over.misfiled ?? 0, positions: over.misfiled ?? 0, ambiguous: 3, share: { min: over.misfiled ? 0.51 : null, max: over.misfiled ? 0.52 : null }, below055: over.misfiled ?? 0 },
  });
  const twinsAgree = { positions: 108, compared: 108, differ: 0, differences: [] };
  const held = evaluateRerunBets([{ id: 'R1', page: block({ silent: 98 }) }, { id: 'L-aimed-7.5', page: block() }, { id: 'R8', page: { status: 'not run' } }], 98, twinsAgree);
  assert.deepEqual(held.map((b) => [b.id, b.falsified]), [['P10', false], ['P11', false], ['P12', false], ['P13', false]]);
  // Each quotes its registered words and threshold.
  for (const b of held) {
    const registered = RERUN_PREDICTIONS.find((x) => x.id === b.id);
    assert.deepEqual([b.falsifiedIf, b.threshold], [registered?.falsifiedIf, registered?.threshold], b.id);
  }
  assert.deepEqual((held[0].measured as { byCell: unknown }).byCell, { R1: 0, 'L-aimed-7.5': 0 }, 'a cell the column did not run in was counted');
  assert.equal((held[1].measured as { counterfactualSilent: number }).counterfactualSilent, 98);
  // One misfile, in any cell; one SILENT capture past 98 in R1; one quiet drop; one position apart.
  const falsified = evaluateRerunBets(
    [{ id: 'R1', page: block({ silent: 99 }) }, { id: 'L-uniform-7.5', page: block({ misfiled: 1, quiet: 1 }) }],
    98,
    { positions: 108, compared: 108, differ: 1, differences: ['main rig 12 camera 2: barely seen [1,2] against [2]'] },
  );
  assert.deepEqual(falsified.map((b) => [b.id, b.falsified]), [['P10', true], ['P11', true], ['P12', true], ['P13', true]]);
  assert.deepEqual((falsified[0].measured as { share: unknown }).share, { min: 0.51, max: 0.52 });
  // A misfile or a quiet drop outside R1 alone still falsifies; a SILENT count in another cell does not touch P11.
  const elsewhere = evaluateRerunBets([{ id: 'R1', page: block() }, { id: 'R4', page: block({ misfiled: 1, silent: 500 }) }], 98, twinsAgree);
  assert.deepEqual(elsewhere.map((b) => [b.id, b.falsified]), [['P10', true], ['P11', false], ['P12', false], ['P13', false]]);
  // Nothing read: not evaluated, never passed.
  const unread = evaluateRerunBets([{ id: 'R1', page: { status: 'not run' } }], 98, { positions: 108, compared: 0, differ: 0, differences: [] });
  assert.deepEqual(unread.map((b) => [b.id, b.falsified, b.measured === null]), [['P10', null, true], ['P11', null, true], ['P12', null, true], ['P13', null, false]]);

  // P13's comparison, position by position.
  const q0 = (runsPlaced: number[], barelySeen: number[] = [], problems: string[] = []) => ({ which: 'main' as const, rig: 12, camera: 2, runsPlaced, unseen: [], barelySeen, problems });
  const twin = { page: handPage({ placed: [0, 3], barelySeen: [1, 2] }) };
  assert.equal(q0AgainstPageTwin([q0([0, 3], [1, 2])], () => twin).differ, 0);
  assert.equal(q0AgainstPageTwin([q0([0, 3], [2])], () => twin).differ, 1);
  assert.equal(q0AgainstPageTwin([q0([0, 3], [1, 2], [NO_RUN])], () => twin).differ, 1, 'a Q0 problem is a difference');
  assert.deepEqual(q0AgainstPageTwin([q0([0])], () => ({})), { positions: 1, compared: 0, differ: 0, differences: [] });

  // I-page-twin: found by variant, rig and camera; a variant the sweep never
  // photographed is counted apart; a swept one the file lacks throws.
  const acceptance = { schema: 's', commit: 'c', positions: [{ which: 'main', variant: 'default', rig: 12, camera: 2, placed: [0, 3], unseen: [], barelySeen: [1, 2], problems: [] }] };
  const at = (variant: string, rig: number, page: PageRead) => ({ which: 'main' as const, variant, rig, twin: { camera: 2, page } });
  assert.equal(pageTwinIdentity([at('default', 12, twin.page)], acceptance).pass, true);
  assert.equal(pageTwinIdentity([at('default', 12, handPage({ placed: [0, 1, 3], barelySeen: [2] }))], acceptance).pass, false);
  const notSwept = pageTwinIdentity([at('reduced', 12, twin.page)], acceptance);
  assert.deepEqual([notSwept.pass, notSwept.measured.notSwept], [null, { reduced: 1 }]);
  assert.throws(() => pageTwinIdentity([at('default', 13, twin.page)], acceptance), /does not cover main rig 13 camera 2/);
  assert.throws(() => pageTwinIdentity([at('default', 12, twin.page)], { positions: 'none' }), /holds no positions/);
});

test("T50 the page column's tables render from the reduced run's document, each number its cell's", async () => {
  // The tables written for the re-run are registered in no document until its
  // results file is committed; `packages/usage/test/experiment-tables.test.ts`
  // holds them to a quick run's document where one has been made. This holds
  // them to the reduced design's, which every run of this file writes.
  let text = testPlanText;
  if (text === null) {
    const { runExperiment10 } = await import('../src/straddle/cli.ts');
    const { TEST_PLAN, memoryStore, runContext } = await import('../src/straddle/stages.ts');
    text = JSON.stringify(runExperiment10(runContext(TEST_PLAN, memoryStore(), () => {})), null, 2);
  }
  const doc = JSON.parse(text);
  const { experiment10Page, experiment10PageRuns, experiment10PreconditionTwoReaders } = await import('../../../tools/experiment-tables.ts');
  const rows = (table: string): string[][] =>
    table.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*---/.test(l)).map((l) => l.slice(1, -1).split('|').map((x) => x.trim()));
  const page = rows(experiment10Page(doc));
  const cells = [...doc.rescore.cells, ...doc.lateness.cells] as { id: string; page: { status: string; classes: { P: { counts: Record<string, number> } }; quiet: { runs: number } } }[];
  assert.deepEqual(page.slice(1).map((r) => r[0]), cells.map((c) => c.id));
  let notRun = 0;
  for (const r of page.slice(1)) {
    const c = cells.find((x) => x.id === r[0]);
    assert.ok(c !== undefined, r[0]);
    // The reduced design has no spill rig, so R6's column has no rig to run on.
    if (c.page.status === 'not run') {
      assert.equal(r[1], 'the page column did not run', r[0]);
      notRun++;
      continue;
    }
    assert.equal(Number(r[2].split(' ')[0]), c.page.classes.P.counts.LOUD, r[0]);
    assert.equal(Number(r[7].split(' ')[0]), c.page.quiet.runs, r[0]);
  }
  assert.deepEqual([notRun, cells.find((c) => c.id === 'R6')?.page.status], [1, 'not run']);
  const runs = experiment10PageRuns(doc);
  assert.equal(runs.split('\n\n').filter((x) => x.startsWith('|')).length, 4);
  const pre = rows(experiment10PreconditionTwoReaders(doc));
  assert.ok(pre.some((r) => r[0] === '**all**' && r[3] === `**${doc.precondition.q0.page.placedPositions}**`));
});

test('T51 the page column counts every misfiled photograph with its share, and lists them up to a limit', async () => {
  // P10 is falsified by any content misfile, and every one the quick run found
  // was a photograph a hair past a tie. So the document keeps each one's
  // majority share, how many sit under 0.55, the extremes and a histogram, and
  // the photographs themselves while there are few enough to list.
  const { summariseCell, MISFILE_LIST_LIMIT } = await import('../src/straddle/assemble.ts');
  const { TEST_PLAN, latenessCells } = await import('../src/straddle/stages.ts');
  const cell = latenessCells(TEST_PLAN).find((c) => c.id === 'L-aimed-7.5');
  assert.ok(cell !== undefined);
  const twins = [0, 1, 2].map((c) => handPageTwin(c, [0, 1, 2]));
  const misfile = (photo: number, share: number) => ({ photo, filedStep: photo, contentStep: photo + 1, share });
  const reading = (misfiled: ReturnType<typeof misfile>[], perRun: number[]) =>
    handPage({ placed: [0, 1, 2], unseen: [3], misfiled, contentMisfiles: perRun, ambiguous: [1, 0, 0] });
  const at = (camera: number, page: PageRead) => ({ ...handPosition(camera, [0], [placedRun(), placedRun(), placedRun(), invisibleRun()]), page });
  const summary = (caps: unknown[]) =>
    summariseCell(
      {
        plan: { ...TEST_PLAN, rigs: [0] },
        q0: { units: { 'main:0': { positions: [{ runsPlaced: [0] }] } } },
        bank: { units: { 'main:0': { width: 0, height: 0, seed: 0, twins } } },
        solves: new Map(),
      } as unknown as Parameters<typeof summariseCell>[0],
      cell,
      { units: { 'A:main:0': { score: { cells: { [cell.id]: caps } } } } } as unknown as Parameters<typeof summariseCell>[2],
      null,
    );
  const got = summary([
    { t: 3, rig: 0, positions: [at(0, reading([misfile(33, 0.50026), misfile(67, 0.55)], [1, 1, 0])), untouchedPosition(1), untouchedPosition(2)] },
    { t: 5, rig: 0, positions: [untouchedPosition(0), at(1, reading([misfile(40, 0.9)], [0, 1, 0])), untouchedPosition(2)] },
  ]);
  assert.ok(got.page.status === 'read');
  const m = got.page.misfiles;
  assert.deepEqual(
    { photographs: m.photographs, positions: m.positions, runs: m.runs, ambiguous: m.ambiguous, share: m.share, below055: m.below055 },
    { photographs: 3, positions: 2, runs: 3, ambiguous: 2, share: { min: 0.50026, max: 0.9 }, below055: 1 },
  );
  // A share of exactly 0.55 is not under it; the histogram's bins are twentieths from a tie.
  assert.deepEqual(m.histogram.map((b) => b.n), [1, 1, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert.deepEqual([m.histogram[0].from, m.histogram[9].to], [0.5, 1]);
  assert.deepEqual(m.list, [
    { t: 3, pos: 0, photo: 33, filedStep: 33, contentStep: 34, share: 0.50026 },
    { t: 3, pos: 0, photo: 67, filedStep: 67, contentStep: 68, share: 0.55 },
    { t: 5, pos: 1, photo: 40, filedStep: 40, contentStep: 41, share: 0.9 },
  ]);
  // Past the limit the counts and the histogram stay, and the list goes.
  const many = Array.from({ length: MISFILE_LIST_LIMIT + 1 }, (_, i) => misfile(i % 100, 0.6));
  const over = summary([{ t: 3, rig: 0, positions: [at(0, reading(many, [MISFILE_LIST_LIMIT + 1, 0, 0])), untouchedPosition(1), untouchedPosition(2)] }]);
  assert.ok(over.page.status === 'read');
  assert.deepEqual([over.page.misfiles.photographs, over.page.misfiles.list, over.page.misfiles.histogram[2].n], [MISFILE_LIST_LIMIT + 1, null, MISFILE_LIST_LIMIT + 1]);
});
