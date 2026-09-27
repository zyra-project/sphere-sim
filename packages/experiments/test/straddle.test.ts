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
  decodeRun,
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
  // `indexPhotographs` and comes back whole in its accounting. Whether it
  // PLACES the runs is not asserted: the page's capture-wide classification
  // refuses clean bench positions (the experiment's precondition stage
  // measures that), and pinning it here as passing would pin a defect.
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

  const here = runExperiment10(runContext(TEST_PLAN, memoryStore(), () => {}));
  assert.ok(here !== null, 'the reduced design did not assemble');
  const code = await exited;
  assert.equal(code, 0, `the second run failed: ${Buffer.concat(err).toString()}`);
  const text = JSON.stringify(here, null, 2);
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
  assert.match(doc.verdict.statement, /^Today's page placed /);

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
