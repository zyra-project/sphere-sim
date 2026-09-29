// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The page's reader, handed the bench's own photographs.
 *
 * `packages/solver/test/position.test.ts` holds `indexPosition` to a small
 * block-space sphere, because the solver may not import the bench, and that
 * model has no limb darkening, no specular term, no room and no page encode.
 * These tests hand the page's reader what the bench itself renders, noisy,
 * through the page's own path, and hold it to a counterfactual reader that is
 * handed every frame's kind — `src/reader/acceptance.ts` says how, and states
 * the criteria once for these tests and for `tools/reader-acceptance.ts`, which
 * runs them over every clean position EXPERIMENT-10's Q0 photographed and is
 * too slow for a test.
 *
 * Rigs 0 and 3 at the reduced preset (224x168). In both, every camera has a
 * projector it cannot see, and camera 0 sees projector 3 grazing: 68 lit pixels
 * and a 19-block crescent in rig 0, the smallest run either reader is handed
 * here, and both place it. Rig 3's camera 1 was one of EXPERIMENT-10 Q0's
 * run-count refusals. The folder shapes the card's procedure makes are built
 * from the same renders, with the photographs besides the position from a
 * second noise stream, `nullSeed(k, 0)`: the seed EXPERIMENT-10 photographs its
 * first re-shoot of rig k with. So are a few of the faults an operator makes on
 * the way (review B's finding 11); `tools/reader-acceptance.ts` builds them all.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { MIN_CRESCENT_BLOCKS } from '../../solver/src/indexing.ts';
import { summarisePhoto, type IndexedCapture } from '../../web/src/readback.ts';
import {
  asPositionOrRefused,
  extrasPart,
  folder,
  judgePosition,
  judgeShapes,
  photographCamera,
  secondSeed,
  type PositionRecord,
  type ShapeRecord,
} from '../src/reader/acceptance.ts';
import { FINGERPRINT_BLOCKS, FRAMES_PER_RUN, PROJECTORS, TRANSFER } from '../src/straddle/design.ts';
import { buildRig } from '../src/straddle/bank.ts';

const RIGS: readonly number[] = [0, 3];
const EVERY: readonly number[] = Array.from({ length: PROJECTORS }, (_, p) => p);

interface CameraReading {
  label: string;
  lit: number[];
  position: PositionRecord;
  /** The projector re-shot in the shapes: the first this camera sees. */
  reshot: number;
  shapes: ShapeRecord[];
}

/**
 * Rig `k` photographed and read, camera by camera. Only the records are kept:
 * a reduced rig's frames are about 60 MB, and every test file shares one
 * process.
 */
const readings = new Map<number, CameraReading[]>();
function readRig(k: number): CameraReading[] {
  let got = readings.get(k);
  if (got !== undefined) return got;
  const bank = buildRig(k, 'reduced');
  got = bank.cameras.map((c) => {
    const shots = photographCamera(bank, c, secondSeed(k));
    // What the page should make of this camera's photographs, from what the
    // renderer lit: every run with light in it placed, every run without
    // noted out of view, nothing barely seen.
    const seen = EVERY.filter((p) => shots.lit[p] > 0);
    const dark = EVERY.filter((p) => shots.lit[p] === 0);
    const expect = { placed: seen, unseen: dark, barelySeen: [], refused: [] };
    // The first projector the camera sees is the one re-shot, so that a
    // played-on re-shoot from it holds every later projector, the ones this
    // camera cannot see among them.
    const reshot = seen[0];
    return {
      label: `rig ${k} camera ${c}`,
      lit: shots.lit,
      position: judgePosition(shots, false).record,
      reshot,
      shapes: judgeShapes(shots, expect, [reshot], 'few'),
    };
  });
  readings.set(k, got);
  return got;
}

test('every clean rendered position: the page places what the counterfactual places, and notes what the camera cannot see', (t) => {
  let unseenNoted = 0;
  let smallest = { lit: Number.POSITIVE_INFINITY, blocks: 0, where: '' };
  for (const k of RIGS) {
    for (const { label, lit, position } of readRig(k)) {
      assert.deepEqual(position.failures, [], label);
      // The criteria the module words, restated against the renderer's truth.
      assert.equal(position.misfiled, 0, `${label}: photographs filed under the wrong frame`);
      assert.deepEqual(position.placed, position.counterfactualPlaced, `${label}: the page and the counterfactual`);
      assert.deepEqual(position.placed, EVERY.filter((p) => lit[p] > 0), `${label}: placed`);
      const dark = EVERY.filter((p) => lit[p] === 0);
      assert.deepEqual(position.unseen, dark, `${label}: out of view`);
      unseenNoted += dark.length;
      for (const p of dark) {
        assert.ok(position.notes.some((n) => n.startsWith(`Projector ${p + 1} was not in this camera's view`)), `${label}: no note`);
        // The counterfactual refuses it — F1b(ii), the advice this page must not give.
        assert.match(position.counterfactualProblems.join(' '), new RegExp(`Re-shoot projector ${p + 1}\\b`), label);
      }
      assert.doesNotMatch([...position.problems, ...position.notes].join(' | '), /Re-shoot/, label);
      assert.deepEqual(position.problems, [], label);
      assert.equal(position.ok, true, label);
      assert.deepEqual(position.grazing, [], `${label}: a run the camera sees, refused by both readers`);
      for (const r of position.projectors) {
        if (r.litPixels > 0 && r.litPixels < smallest.lit) {
          smallest = { lit: r.litPixels, blocks: r.crescentBlocks, where: `${label} projector ${r.projector + 1}` };
        }
      }
    }
  }
  assert.equal(unseenNoted, 6, 'every camera of both rigs has one projector out of view');
  // A grazing run is among them, placed: measured, rig 0 camera 0's
  // projector 3, at 68 lit pixels and a 19-block crescent.
  t.diagnostic(`smallest run placed: ${smallest.where}, ${smallest.lit} lit pixels, ${smallest.blocks} crescent blocks`);
  assert.ok(smallest.blocks < 3 * MIN_CRESCENT_BLOCKS, `the smallest run placed has ${smallest.blocks} crescent blocks`);
});

test("the card's folder shapes, from the same renders: photographs before Play and after the black, and a re-shoot appended, played on, or alone", () => {
  let tailsWithUnseen = 0;
  for (const k of RIGS) {
    for (const { label, lit, reshot, shapes } of readRig(k)) {
      const q = reshot;
      assert.deepEqual(
        shapes.slice(0, 12).map((s) => s.shape),
        [
          ...[0, 1, 3].flatMap((l) => [0, 1, 2].map((tr) => `leading ${l}, trailing ${tr}`)),
          `projector ${q + 1} re-shot and appended`,
          `projector ${q + 1} re-shot and played on`,
          `projector ${q + 1} re-shot alone`,
        ],
        label,
      );
      for (const s of shapes.slice(0, 12)) {
        assert.deepEqual(s.failures, [], `${label}, ${s.shape}`);
        assert.equal(s.misfiled, 0, `${label}, ${s.shape}`);
      }
      const seen = EVERY.filter((p) => lit[p] > 0);
      for (const s of shapes.slice(0, 9)) {
        assert.deepEqual(s.placed, seen, `${label}, ${s.shape}`);
        assert.deepEqual(s.problems, [], `${label}, ${s.shape}`);
      }
      const [appended, playedOn, alone] = shapes.slice(9, 12);
      assert.deepEqual(appended.placed, seen, label);
      assert.deepEqual(appended.reshoots.map((r) => r.projector), [q], label);
      assert.deepEqual(playedOn.placed, seen, label);
      assert.deepEqual(playedOn.reshoots.map((r) => r.projector), seen.filter((p) => p >= q), label);
      assert.deepEqual(playedOn.unseen, EVERY.filter((p) => lit[p] === 0), label);
      if (EVERY.some((p) => p > q && lit[p] === 0)) tailsWithUnseen++;
      assert.equal(alone.ok, false, label);
      assert.deepEqual(alone.placed, [], label);
      assert.match(alone.problems[0] ?? '', /a re-shoot of one projector handed in on its own/, label);
    }
  }
  // A played-on re-shoot holds a projector the camera cannot see: rig 0's and
  // rig 3's camera 0 (projector 4) and camera 2 (projector 2).
  assert.equal(tailsWithUnseen, 4);
});

test('the faults on the way — the camera started late or stopped early, a test shot before Play, a spoiled run re-shot — read as the position or are refused in words, and are never misfiled', () => {
  for (const k of RIGS) {
    for (const { label, lit, reshot, shapes } of readRig(k)) {
      const q = reshot;
      const seen = EVERY.filter((p) => lit[p] > 0);
      const last = seen[seen.length - 1];
      const faults = shapes.slice(12);
      assert.deepEqual(
        faults.map((s) => s.shape),
        [
          'started 2 late, trailing 3',
          'started 4 late, trailing 3',
          'stopped 2 early, leading 3',
          'stopped 4 early, leading 3',
          `a test shot of projector ${last + 1}'s white before Play`,
          `a test shot of projector ${last + 1}'s white before Play, projector ${last + 1} re-shot and appended`,
          `projector ${q + 1} spoiled, photograph 11 of its run doubled, re-shot and appended`,
          `projector ${q + 1} spoiled, photograph 11 of its run dropped, re-shot and played on`,
        ],
        label,
      );
      for (const s of faults) {
        const where = `${label}, ${s.shape}`;
        assert.deepEqual(s.failures, [], where);
        assert.equal(s.misfiled, 0, where);
        if (!s.read) assert.ok(s.problems.length > 0, `${where}: neither read nor refused`);
      }
      const [late2, late4, early2, early4, testShot, testShotReshot, doubled, dropped] = faults;
      // The folders are what their names say: a position of 136, less or plus
      // what the fault took or added.
      const position = PROJECTORS * FRAMES_PER_RUN;
      assert.deepEqual(
        faults.map((s) => s.photographs),
        [
          position - 2 + 3,
          position - 4 + 3,
          3 + position - 2,
          3 + position - 4,
          3 + position + 2,
          3 + position + 2 + FRAMES_PER_RUN,
          position + 1 + 2 + FRAMES_PER_RUN,
          position - 1 + 5 + (PROJECTORS - q) * FRAMES_PER_RUN + 2,
        ],
        label,
      );
      // Two photographs lost where the projector at that end is out of view
      // lose nothing a count needs; lost from a run the camera sees, they are
      // its white and black or its last two phase steps, and it is refused by
      // name.
      assert.equal(late2.read, lit[0] === 0, `${label}: started 2 late`);
      if (!late2.read) assert.match(late2.problems[0] ?? '', /^Projector 1's photographs are lit, but no run/, label);
      assert.equal(early2.read, lit[PROJECTORS - 1] === 0, `${label}: stopped 2 early`);
      if (!early2.read) assert.match(early2.problems[0] ?? '', /^Projector 4's photographs are lit, but no run/, label);
      // Four is past what a count lets go by at either end: refused whole.
      for (const s of [late4, early4]) {
        assert.equal(s.read, false, `${label}, ${s.shape}`);
        assert.deepEqual(s.placed, [], `${label}, ${s.shape}`);
      }
      // A test shot of another projector's white is set aside, and does not
      // stop that projector's re-shoot being matched (review B's finding 4).
      assert.equal(testShot.read, true, label);
      assert.equal(testShotReshot.read, true, label);
      assert.deepEqual(testShotReshot.reshoots.map((r) => r.projector), [last], label);
      // A run spoiled by a photograph shot twice or not at all is replaced by
      // its re-shoot, appended or played on.
      assert.equal(doubled.read, true, label);
      assert.deepEqual(doubled.reshoots.map((r) => r.projector), [q], label);
      assert.equal(dropped.read, true, label);
      assert.deepEqual(dropped.reshoots.map((r) => r.projector), seen.filter((p) => p >= q), label);
    }
  }
});

test("a fault's folder passes only read as its position, or refused in words with nothing placed that the position did not place", () => {
  // The judge the faults above are held to, on readings made up to fail it:
  // the sweep has no second check behind it.
  const expect = { placed: [0, 1, 2], unseen: [3], barelySeen: [], refused: [] };
  const reading = (over: Partial<IndexedCapture>): IndexedCapture => ({
    ok: true,
    runs: [0, 1, 2].map((projector) => ({ projector, ordinals: [] })),
    problems: [],
    notes: [],
    unseen: [3],
    barelySeen: [],
    reshoots: [],
    mechanism: 'position',
    total: 136,
    placed: 102,
    ...over,
  });
  const judged = (r: IndexedCapture): { read: boolean; failures: string[] } => {
    const failures: string[] = [];
    return { read: asPositionOrRefused(expect)(r, failures), failures };
  };
  assert.deepEqual(judged(reading({})), { read: true, failures: [] });
  // A run lost with nothing said: projector 3 noted out of view.
  const silent = judged(reading({ runs: [0, 1].map((projector) => ({ projector, ordinals: [] })), unseen: [2, 3] }));
  assert.equal(silent.read, false);
  assert.match(silent.failures.join(' | '), /^neither read as its position nor refused: /);
  // Refused in words, and still noting a run the position placed as out of view.
  const misnoted = judged(reading({ ok: false, runs: [0, 1].map((projector) => ({ projector, ordinals: [] })), unseen: [2, 3], problems: ["Projector 2's run ..."] }));
  assert.deepEqual(misnoted.failures, ['projector 3 noted out of view, and the position alone does not note it', 'projector 3 neither placed nor refused']);
  // Refused whole, in words: passes, read or not.
  assert.deepEqual(judged(reading({ ok: false, runs: [], unseen: [], problems: ['The 3 runs found do not fit ...'] })), { read: false, failures: [] });
});

test('a photograph summarised once and placed in a folder is the summary the page makes of it there', () => {
  // The folders above are made of photographs summarised once each and
  // stamped with their place, as the page stamps a photograph's ordinal when
  // it reads the file. Held here to `summarisePhoto` itself, on any bytes.
  const width = 48;
  const height = 36;
  const data = new Uint8Array(width * height).map((_, i) => (i * 37) % 251);
  const image = { width, height, channels: 1, data, maxValue: 255 };
  const once = summarisePhoto(image, 0, 'somewhere else', TRANSFER, FINGERPRINT_BLOCKS);
  const placed = folder([extrasPart([once, once, once])]).summaries[2];
  assert.deepEqual(placed, summarisePhoto(image, 2, 'IMG_0003.png', TRANSFER, FINGERPRINT_BLOCKS));
});
