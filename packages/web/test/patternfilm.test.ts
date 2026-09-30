// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The pattern preview, checked against the pattern DEFINITION rather than
 * against itself.
 *
 * A preview of structured light is easy to get plausibly wrong: stripes that
 * look like Gray code, a sinusoid that looks like a phase step. Every assertion
 * here is a property `solver/src/decode.ts` states normatively or that
 * `planFrames` guarantees, so a preview that merely looked convincing would
 * fail them.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PATTERN_PLAN, compileFrame, planFrames } from '../../bench/src/patterns.ts';
import type { PatternPlan } from '../../bench/src/patterns.ts';
import {
  ATLAS_MAX_ROWS,
  ATLAS_WIDTH,
  createSequencePlayer,
  describeSequence,
  encodeToRgba,
  patternAtlas,
  patternMask,
  pixelCentreTarget,
  rasterTarget,
  sampleFrame,
  SEQUENCE_BRISK_MS,
  SEQUENCE_DWELL_MS,
  SEQUENCE_MIN_DWELL_MS,
  sequenceDwellMs,
  sequenceFocus,
  sequenceKeyAction,
  sequenceStep,
  stepCaption,
  strideInfo,
} from '../src/patternfilm.ts';
import type { SequenceKey } from '../src/patternfilm.ts';
import { emitOrder } from '../src/emit.ts';
import { FRAGMENT_SHADER } from '../src/glsl.ts';
import { RESOLUTIONS } from '../src/settings.ts';

const PLAN = DEFAULT_PATTERN_PLAN;
const RES_X = 1920;
const RES_Y = 1200;

/**
 * How close is close, for an identity that holds exactly in arithmetic.
 *
 * `sampleFrame` computes in double and stores into a `Float32Array`, because a
 * preview is what it is for. Float32 carries about seven significant digits, so
 * the complement and opposite-phase identities come back off by ~1e-8 wherever
 * the value is not exactly representable — 0 and 1 are, which is why the Gray
 * planes hit it on the nose and the sinusoids do not. Asserting tighter than
 * the storage would be asserting something about the array type rather than
 * about the patterns.
 */
const F32_EPS = 1e-6;

test('the sequence described is the sequence captured, frame for frame', () => {
  const notes = describeSequence(PLAN);
  const specs = planFrames(PLAN);
  assert.equal(notes.length, specs.length);
  // 1 white + 1 black + (6 planes + 6 inverses) × 2 axes + 4 phase × 2 axes.
  assert.equal(notes.length, 34);
  for (let i = 0; i < notes.length; i++) {
    assert.equal(notes[i].index, i, 'the note index is the capture order');
    assert.equal(notes[i].axis, specs[i].axis, 'the note names the spec’s own axis');
    assert.notEqual(notes[i].label, '', 'every frame is captioned');
    assert.ok(notes[i].why.length > 40, 'every frame says what it is for');
  }
});

test('a Gray plane and its complement sum to one at every coordinate', () => {
  // The identity the whole method rests on: the decoder reads a bit as the sign
  // of (plane - inverse), and albedo, ambient and cos-falloff cancel only
  // because the two frames are exact complements. Asserted on LINEAR radiance,
  // which is what that claim is about — the encoded bytes do not have this
  // property and asserting it there would be asserting something false.
  const specs = planFrames(PLAN);
  let pairs = 0;
  for (let i = 0; i < specs.length; i++) {
    if (specs[i].kind !== 'gray') continue;
    const inv = specs[i + 1];
    assert.equal(inv.kind, 'grayInverse', 'each plane is immediately followed by its own inverse');
    assert.equal(inv.axis, specs[i].axis);
    assert.equal(inv.index, specs[i].index);
    const a = sampleFrame(specs[i], PLAN, RES_X, RES_Y, 128, 96);
    const b = sampleFrame(inv, PLAN, RES_X, RES_Y, 128, 96);
    for (let p = 0; p < a.length; p++) {
      assert.ok(
        Math.abs(a[p] + b[p] - 1) < F32_EPS,
        `plane ${specs[i].index} and its inverse sum to ${a[p] + b[p]} at pixel ${p}`,
      );
    }
    pairs++;
  }
  assert.equal(pairs, PLAN.grayBits * 2, 'both axes carry a full set of planes');
});

test('the most significant plane splits the raster exactly in half', () => {
  // MSB first, so plane 0 is one black half and one white half. This is the
  // frame that would look identical whether the code were Gray or plain binary,
  // and the next test is what tells them apart.
  const spec = planFrames(PLAN).find((s) => s.kind === 'gray' && s.axis === 'u' && s.index === 0);
  assert.ok(spec);
  const img = sampleFrame(spec, PLAN, RES_X, RES_Y, 128, 1);
  const lit = [...img].filter((v) => v > 0.5).length;
  assert.equal(lit, 64, 'half the width is lit');
  // And it is one contiguous half, not a fine comb that happens to average out.
  const flips = [...img].reduce(
    (n, v, i) => (i > 0 && v > 0.5 !== img[i - 1] > 0.5 ? n + 1 : n),
    0,
  );
  assert.equal(flips, 1, 'exactly one black/white boundary');
});

test('adjacent strips differ in exactly one plane, which is what Gray code buys', () => {
  // The property that makes a boundary misread cost one strip instead of half
  // the raster. Read the six planes at the centre of each strip and check the
  // Hamming distance between neighbours is 1. Plain binary would fail at every
  // power-of-two boundary — 0111 to 1000 flips four bits.
  const specs = planFrames(PLAN).filter((s) => s.kind === 'gray' && s.axis === 'u');
  assert.equal(specs.length, PLAN.grayBits);
  const strips = Math.pow(2, PLAN.grayBits);
  // One preview pixel per strip, sampled at the strip's centre.
  const planes = specs.map((s) => sampleFrame(s, PLAN, RES_X, RES_Y, strips, 1, 1));
  for (let k = 1; k < strips; k++) {
    let differing = 0;
    for (const plane of planes) if (plane[k] > 0.5 !== plane[k - 1] > 0.5) differing++;
    assert.equal(differing, 1, `strips ${k - 1} and ${k} differ in ${differing} planes, not 1`);
  }
});

test('the phase frames are a sinusoid, and the steps are evenly spread over a period', () => {
  const specs = planFrames(PLAN).filter((s) => s.kind === 'phase' && s.axis === 'u');
  assert.equal(specs.length, PLAN.phaseSteps);
  // Sampled without supersampling: the average of a cosine over a sub-interval
  // is not the cosine, and this test is about the waveform itself.
  const rows = specs.map((s) => sampleFrame(s, PLAN, RES_X, RES_Y, 256, 1, 1));
  for (const row of rows) {
    for (const v of row) assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `radiance ${v} is outside [0,1]`);
    // A full period of `0.5 + 0.5 cos` averages to 0.5, and the stride times the
    // period count divides the raster evenly, so the row covers whole periods.
    const mean = row.reduce((a, b) => a + b, 0) / row.length;
    assert.ok(Math.abs(mean - 0.5) < 0.02, `mean radiance ${mean} is not mid-scale`);
  }
  // The four steps at one coordinate are four samples of one cosine a quarter
  // period apart, so opposite steps sum to 1: cos(x) + cos(x + pi) = 0.
  for (let i = 0; i < PLAN.phaseSteps / 2; i++) {
    const opposite = i + PLAN.phaseSteps / 2;
    for (let x = 0; x < 256; x += 17) {
      assert.ok(
        Math.abs(rows[i][x] + rows[opposite][x] - 1) < F32_EPS,
        `steps ${i} and ${opposite} sum to ${rows[i][x] + rows[opposite][x]} at ${x}`,
      );
    }
  }
});

test('the flat fields are flat, and they are the extremes', () => {
  const specs = planFrames(PLAN);
  const white = sampleFrame(specs[0], PLAN, RES_X, RES_Y, 32, 24);
  const black = sampleFrame(specs[1], PLAN, RES_X, RES_Y, 32, 24);
  assert.equal(specs[0].kind, 'white');
  assert.equal(specs[1].kind, 'black');
  assert.ok([...white].every((v) => v === 1), 'the white frame asks for full radiance everywhere');
  assert.ok([...black].every((v) => v === 0), 'the black frame asks for none anywhere');
});

test('a frame that varies down the raster varies down it, not across', () => {
  // The axis is the one thing a preview can get subtly and invisibly wrong: a
  // transposed frame is still a plausible-looking stripe pattern.
  const spec = planFrames(PLAN).find((s) => s.kind === 'gray' && s.axis === 'v' && s.index === 0);
  assert.ok(spec);
  const w = 16;
  const h = 64;
  const img = sampleFrame(spec, PLAN, RES_X, RES_Y, w, h);
  for (let y = 0; y < h; y++) {
    const row = img.subarray(y * w, y * w + w);
    assert.ok([...row].every((v) => v === row[0]), `row ${y} is not constant across`);
  }
  const column = Array.from({ length: h }, (_, y) => img[y * w]);
  assert.ok(new Set(column).size > 1, 'the column does not vary, so the frame is transposed');
});

test('encoding is monotone, opaque, grey, and brightens the mid-tones', () => {
  const linear = Float32Array.from([0, 0.25, 0.5, 0.75, 1]);
  const rgba = encodeToRgba(linear);
  assert.equal(rgba.length, linear.length * 4);
  for (let i = 0; i < linear.length; i++) {
    assert.equal(rgba[4 * i], rgba[4 * i + 1], 'r equals g');
    assert.equal(rgba[4 * i + 1], rgba[4 * i + 2], 'g equals b');
    assert.equal(rgba[4 * i + 3], 255, 'every pixel is opaque');
    if (i > 0) assert.ok(rgba[4 * i] > rgba[4 * (i - 1)], 'encoding is monotone');
  }
  assert.equal(rgba[0], 0, 'no light encodes to black');
  assert.equal(rgba[4 * 4], 255, 'full radiance encodes to white');
  // 0.5^(1/2.2) = 0.7297, so mid radiance is well above mid grey. Stated as a
  // number because "brighter" would pass for any encoding at all, including one
  // that skipped the transfer and clamped.
  assert.equal(rgba[4 * 2], Math.round(Math.pow(0.5, 1 / 2.2) * 255));
});

test('the strip count and its width are consistent with the plan', () => {
  const info = strideInfo(PLAN, RES_X, RES_Y);
  assert.equal(info.strips, 64, 'six bits address 64 strips');
  assert.equal(info.strideXPx, RES_X / 64);
  assert.equal(info.strideYPx, RES_Y / 64);
  // The coupling that makes the whole sequence decodable: a strip has to be
  // several camera pixels wide. At 1920 across it is 30 projector pixels.
  assert.ok(info.strideXPx >= 8, 'the finest feature is not a hairline');
});

// ---------------------------------------------------------------------------
// The sequence texture the display shader reads
// ---------------------------------------------------------------------------

test('the sequence texture is compileFrame at every pixel centre, for every raster the page offers', () => {
  // The shader computes no pattern: it looks the value up in this table. So the
  // table has to BE the definition — not a resampling of it, not a copy that
  // agreed once — at the one place a projector samples it, the pixel centre.
  // Every plan the emitter can play (1 to 8 Gray planes, 4 to 12 phase steps)
  // on every raster the Resolution control offers, every pixel of every frame.
  let checked = 0;
  const plans: PatternPlan[] = [];
  for (let grayBits = 1; grayBits <= 8; grayBits++) plans.push({ ...PLAN, grayBits });
  plans.push({ ...PLAN, phaseSteps: 7 }, { ...PLAN, phaseSteps: 12, phasePeriodStrides: 4 });
  for (const r of RESOLUTIONS) {
    for (const plan of plans) {
      const atlas = patternAtlas(plan, r.resX, r.resY);
      const specs = planFrames(plan);
      assert.equal(atlas.rows.length, specs.length, 'one row of the table per frame, in capture order');
      assert.equal(atlas.data.length, atlas.width * atlas.height);
      let next = 0;
      for (let f = 0; f < specs.length; f++) {
        const frame = compileFrame(specs[f], plan, r.resX, r.resY);
        const row = atlas.rows[f];
        assert.equal(row.offset, next, 'rows are packed end to end');
        const axis = frame.axis === null ? 0 : frame.axis === 'u' ? 1 : 2;
        assert.equal(row.axis, axis, `frame ${f} is tabulated along the wrong axis`);
        const res = axis === 2 ? r.resY : r.resX;
        assert.equal(row.length, axis === 0 ? 1 : res);
        for (let i = 0; i < row.length; i++) {
          const want = Math.fround(axis === 0 ? frame.at(0) : frame.at(i + 0.5));
          if (atlas.data[row.offset + i] !== want) {
            assert.fail(
              `${r.label}, ${plan.grayBits} planes, frame ${f} pixel ${i}: the table holds ` +
                `${atlas.data[row.offset + i]} and compileFrame says ${want}`,
            );
          }
          checked++;
        }
        next += row.length;
      }
    }
  }
  assert.ok(checked > 1_000_000, `only ${checked} pixel centres were compared`);
});

test('the table is as wide as the shader reads it, and fits the smallest texture WebGL2 allows', () => {
  // `packedTexel` divides a texel index by PACK_WIDTH. Read out of the shader
  // rather than restated, so the two cannot quietly differ.
  const m = /#define PACK_WIDTH (\d+)/.exec(FRAGMENT_SHADER);
  assert.ok(m, 'the shader no longer defines PACK_WIDTH');
  assert.equal(ATLAS_WIDTH, Number(m[1]));
  // The biggest table the emitter's own limits allow, on the biggest raster.
  const biggest = patternAtlas({ ...PLAN, grayBits: 8, phaseSteps: 12 }, 3840, 2160);
  assert.equal(biggest.width, ATLAS_WIDTH);
  assert.ok(biggest.height <= ATLAS_MAX_ROWS, `${biggest.height} rows`);
  assert.equal(ATLAS_MAX_ROWS, 2048, 'WebGL2\u2019s guaranteed MAX_TEXTURE_SIZE');
  // And the default one, whose size the docblock quotes.
  const usual = patternAtlas(PLAN, 3840, 2160);
  const used = usual.rows.reduce((n, row) => n + row.length, 0);
  assert.equal(used, 96_002);
  assert.equal(usual.height, 94);
  assert.throws(() => patternAtlas(PLAN, 0, 1080), /not a projector raster/);
});

test('a corner off the raster reads the edge pixel, and a flat field reads its one value', () => {
  const gray = planFrames(PLAN).find((s) => s.kind === 'gray' && s.axis === 'u' && s.index === 5);
  assert.ok(gray);
  const frame = compileFrame(gray, PLAN, RES_X, RES_Y);
  assert.equal(pixelCentreTarget(frame, RES_X, -1), frame.at(0.5));
  assert.equal(pixelCentreTarget(frame, RES_X, RES_X), frame.at(RES_X - 0.5));
  assert.equal(pixelCentreTarget(frame, RES_X, 17), frame.at(17.5));
  const white = compileFrame({ kind: 'white', axis: null, index: 0 }, PLAN, RES_X, RES_Y);
  assert.equal(pixelCentreTarget(white, RES_X, 999_999), 1);
});

test('the value handed to the CPU renderer is read along the frame\u2019s own axis', () => {
  const across = planFrames(PLAN).find((s) => s.kind === 'phase' && s.axis === 'u' && s.index === 1);
  const down = planFrames(PLAN).find((s) => s.kind === 'phase' && s.axis === 'v' && s.index === 1);
  assert.ok(across && down);
  const u = compileFrame(across, PLAN, RES_X, RES_Y);
  const v = compileFrame(down, PLAN, RES_X, RES_Y);
  // Same column, different rows: an across frame must not change, a down frame must.
  assert.equal(rasterTarget(u, RES_X, RES_Y, 40, 3), rasterTarget(u, RES_X, RES_Y, 40, 900));
  assert.notEqual(rasterTarget(v, RES_X, RES_Y, 40, 3), rasterTarget(v, RES_X, RES_Y, 40, 900));
  assert.equal(rasterTarget(v, RES_X, RES_Y, 40, 900), v.at(900.5));
  assert.equal(rasterTarget(u, RES_X, RES_Y, 40, 900), u.at(40.5));
});

// ---------------------------------------------------------------------------
// Playing it on the ball
// ---------------------------------------------------------------------------

test('the ball plays the emitter\u2019s order for any rig, and wraps both ways', () => {
  for (const plan of [PLAN, { ...PLAN, grayBits: 3, phaseSteps: 3 }]) {
    for (let count = 1; count <= 4; count++) {
      const order = emitOrder(count, plan);
      for (let n = 0; n < order.length; n++) {
        const at = sequenceStep(n, count, plan);
        assert.equal(at.slot, order[n].projector, `step ${n} of ${count}`);
        assert.equal(at.frame, order[n].frame, `step ${n} of ${count}`);
        assert.equal(at.step + 1, order[n].ordinal);
        assert.equal(at.total, order.length);
        assert.equal(at.framesPerRun, planFrames(plan).length);
      }
      // Looping forward, and stepping back from the first frame.
      assert.equal(sequenceStep(order.length, count, plan).step, 0);
      assert.equal(sequenceStep(-1, count, plan).step, order.length - 1);
    }
  }
  // `emitOrder` refuses a fifth quadrant, as it must; the simulator can place
  // eight, and the sequence still plays each one's run in turn.
  const last = sequenceStep(8 * 34 - 1, 8, PLAN);
  assert.equal(last.slot, 7);
  assert.equal(last.frame, 33);
});

test('a run lights the rig projector its slot became, and no lamp at all when that slot is off', () => {
  assert.equal(patternMask([0, 1, 2, 3], 2), 0b0100);
  // P2 switched off: the rig is three projectors and P3 is its SECOND.
  assert.equal(patternMask([0, 2, 3], 2), 0b0010);
  assert.equal(patternMask([0, 2, 3], 1), 0, 'P2’s own run goes to a dark lamp, everyone else black');
});

/** A clock the test turns by hand, and a record of what the player asked of the page. */
function harness(projectors = 4, shown: () => boolean = () => true) {
  const timers = new Map<number, () => void>();
  const log = { show: 0, settle: 0, scheduled: [] as number[] };
  let handles = 0;
  const player = createSequencePlayer({
    place: (n) => sequenceStep(n, projectors, PLAN),
    shown,
    show: () => {
      log.show++;
    },
    settle: () => {
      log.settle++;
    },
    schedule: (fn, ms) => {
      timers.set(++handles, fn);
      log.scheduled.push(ms);
      return handles;
    },
    cancel: (handle) => {
      timers.delete(handle);
    },
  });
  /** The one pending frame timer running out. */
  const tick = (): void => {
    assert.equal(timers.size, 1, 'exactly one frame timer is pending');
    const [handle, fn] = [...timers][0];
    timers.delete(handle);
    fn();
  };
  return { player, log, timers, tick };
}

test('no frame is held for less than half a second, whatever the player is asked', () => {
  assert.equal(sequenceDwellMs(SEQUENCE_DWELL_MS), 2000, 'the emitter’s own default');
  assert.equal(sequenceDwellMs(SEQUENCE_BRISK_MS), 700);
  // The emitter's floor is 0.2 s — right for an operator, a flash for an audience.
  assert.equal(sequenceDwellMs(200), SEQUENCE_MIN_DWELL_MS);
  assert.equal(SEQUENCE_MIN_DWELL_MS, 500);
  assert.equal(sequenceDwellMs(0), 500);
  assert.equal(sequenceDwellMs(-40), 500);
  assert.equal(sequenceDwellMs(Number.NaN), 2000);

  const { player, log, tick } = harness();
  player.play();
  assert.deepEqual(log.scheduled, [2000]);
  player.setDwell(100);
  assert.equal(player.dwellMs, 500);
  tick();
  tick();
  // What the CLOCK was given, which is the only number that decides a flash.
  assert.deepEqual(log.scheduled, [2000, 500, 500, 500]);
});

test('a frame on the clock asks the parity check for nothing; a frame stopped on by hand asks once', () => {
  const { player, log, tick } = harness();
  player.play();
  for (let i = 0; i < 40; i++) tick();
  assert.equal(player.step, 40);
  assert.equal(log.settle, 0, 'no model pass per frame while it plays');
  assert.equal(log.show, 41, 'every frame painted');

  player.pause();
  assert.equal(log.settle, 1, 'a pause by hand stops on a frame');
  player.play();
  player.stepTo(7);
  assert.equal(player.playing, false, 'a step by hand stops the player under the hand');
  assert.equal(player.step, 7);
  assert.equal(log.settle, 2);
  player.play();
  player.toggle();
  assert.equal(log.settle, 3, 'the play button pauses by hand too');
  player.play();
  player.pause(false);
  assert.equal(log.settle, 3, 'stopped by the page rather than a person: nothing new to judge');
});

test('the player loops every projector\u2019s run, and stops itself when nothing shows it', () => {
  let shown = true;
  const { player, log, timers, tick } = harness(4, () => shown);
  const order = emitOrder(4, PLAN);
  player.play();
  const seen = [player.step];
  for (let i = 0; i < order.length; i++) {
    tick();
    seen.push(player.step);
  }
  assert.deepEqual(
    seen.slice(0, order.length),
    order.map((s) => s.ordinal - 1),
  );
  assert.equal(seen[order.length], 0, 'after the last frame of the last run, the first again');

  shown = false;
  const painted = log.show;
  tick();
  assert.equal(player.playing, false);
  assert.equal(timers.size, 0, 'no timer left running for views that are gone');
  assert.equal(log.show, painted, 'and nothing painted into them');
});

test('stepping a run lands on its first frame, both ways round', () => {
  const { player } = harness(4);
  player.stepTo(40); // P2, frame 7
  player.stepRun(1);
  assert.equal(player.step, 68);
  player.stepRun(-1);
  assert.equal(player.step, 34);
  player.stepTo(0);
  player.stepRun(-1);
  assert.equal(player.step, 102, 'back from the first run is the last');
  player.stepTo(135);
  player.stepRun(1);
  assert.equal(player.step, 0);
  player.stepTo(-1);
  assert.equal(player.step, 135, 'a step back from the first frame is the last');
});

test('reduced motion starts the sequence paused on its first frame, and says so until touched', () => {
  const { player, timers } = harness();
  player.stepTo(50);
  player.start(true);
  assert.equal(player.step, 0);
  assert.equal(player.playing, false);
  assert.equal(player.heldStill, true);
  assert.equal(timers.size, 0, 'nothing scheduled: nothing moves until somebody asks');
  player.pause(false);
  assert.equal(player.heldStill, true, 'the page stopping it again is not somebody asking');
  player.stepTo(1);
  assert.equal(player.heldStill, false);

  player.start(false);
  assert.equal(player.step, 0, 'from the top');
  assert.equal(player.playing, true);
  assert.equal(player.heldStill, false);
  assert.equal(timers.size, 1);
});

test('the keys pause, step and jump, and leave fields, browser shortcuts and held keys alone', () => {
  const key = (k: string, mods: Partial<SequenceKey> = {}): SequenceKey => ({
    key: k,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    ...mods,
  });
  assert.equal(sequenceKeyAction(key(' '), 'page'), 'toggle');
  assert.equal(sequenceKeyAction(key('ArrowRight'), 'page'), 'next');
  assert.equal(sequenceKeyAction(key('ArrowLeft'), 'page'), 'previous');
  // What a presentation clicker sends.
  assert.equal(sequenceKeyAction(key('PageDown'), 'page'), 'next');
  assert.equal(sequenceKeyAction(key('PageUp'), 'page'), 'previous');
  assert.equal(sequenceKeyAction(key('ArrowRight', { shiftKey: true }), 'page'), 'next-run');
  assert.equal(sequenceKeyAction(key('ArrowLeft', { shiftKey: true }), 'page'), 'previous-run');

  for (const k of [' ', 'ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp']) {
    assert.equal(sequenceKeyAction(key(k), 'field'), null, `${k} belongs to the field`);
  }
  // A focused button keeps Space, which is how a keyboard presses it; the
  // clicker's keys still step.
  assert.equal(sequenceKeyAction(key(' '), 'button'), null);
  assert.equal(sequenceKeyAction(key('PageDown'), 'button'), 'next');
  assert.equal(sequenceKeyAction(key('ArrowRight', { shiftKey: true }), 'button'), 'next-run');

  for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'repeat'] as const) {
    assert.equal(sequenceKeyAction(key('ArrowLeft', { [mod]: true }), 'page'), null, mod);
    assert.equal(sequenceKeyAction(key(' ', { [mod]: true }), 'page'), null, mod);
  }
  // Escape keeps its own binding; Enter presses whatever has focus.
  assert.equal(sequenceKeyAction(key('Escape'), 'page'), null);
  assert.equal(sequenceKeyAction(key('Enter'), 'page'), null);
});

test('a key in a field, or on anything inside one, is the field’s; on a control it is a button’s', () => {
  /** A stand-in for a DOM node: its own selector and its ancestors', innermost first. */
  const node = (chain: string[], editable = false) => ({
    isContentEditable: editable,
    closest: (selectors: string) =>
      chain.find((own) => selectors.split(',').some((s) => s.trim() === own)) ?? null,
  });
  for (const field of ['input', 'select', 'textarea']) {
    assert.equal(sequenceFocus(node([field])), 'field', field);
  }
  // `closest`, not the node's own tag: text inside a field's wrapper still counts.
  assert.equal(sequenceFocus(node(['span', 'textarea'])), 'field');
  assert.equal(sequenceFocus(node(['div'], true)), 'field', 'an editable block');
  for (const control of ['button', 'a[href]', 'summary', '[role="button"]']) {
    assert.equal(sequenceFocus(node([control])), 'button', control);
  }
  assert.equal(sequenceFocus(node(['span', 'button'])), 'button', 'the label inside a button');
  assert.equal(sequenceFocus(node(['canvas'])), 'page');
  assert.equal(sequenceFocus(null), 'page', 'the window itself');

  // And the two together, which is what the page asks.
  const space = { key: ' ', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, repeat: false };
  assert.equal(sequenceKeyAction(space, sequenceFocus(node(['input']))), null);
  assert.equal(sequenceKeyAction({ ...space, key: 'ArrowRight' }, sequenceFocus(node(['input']))), null);
  assert.equal(sequenceKeyAction(space, sequenceFocus(node(['canvas']))), 'toggle');
});

test('the caption names the projector as its panel tab does, and says when its lamp is off', () => {
  const at = sequenceStep(34 + 2, 4, PLAN); // P2's run, its third frame
  const note = describeSequence(PLAN)[2];
  const lit = stepCaption(at, PLAN, false);
  assert.equal(lit.label, `P2 · ${note.label}`);
  assert.equal(lit.position, 'frame 3 of 34 · step 37 of 136');
  assert.equal(lit.why, note.why);
  assert.equal(lit.dark, '');
  const off = stepCaption(at, PLAN, true);
  assert.match(off.dark, /^P2 is switched off at the wall/);
  assert.match(off.dark, /plays P2’s run anyway/);
});

test('the page wires one player, draws the card\u2019s frame itself, and asks the worker for none', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const main = fs.readFileSync(path.join(here, '..', 'web', 'main.ts'), 'utf8');
  const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
  /** A top-level function's body, up to its closing brace in column 0. */
  const body = (name: string): string => {
    const from = main.indexOf(`function ${name}(`);
    assert.ok(from >= 0, `main.ts has no function ${name}`);
    return main.slice(from, main.indexOf('\n}', from));
  };
  assert.equal(
    main.match(/createSequencePlayer\(/g)?.length,
    1,
    'one clock for the ball, the lower third and the film, or two of them can disagree',
  );
  // Its hooks are the page's settle timer and the one function that repaints
  // every view of the sequence.
  const wiring = main.slice(main.indexOf('createSequencePlayer({'));
  assert.match(wiring.slice(0, wiring.indexOf('});')), /settle: settleOnFrame,/);
  assert.match(wiring.slice(0, wiring.indexOf('});')), /show: showSequence,/);
  const repaint = body('repaintSequenceViews');
  for (const hook of ['sequenceInline', 'sequenceFilm', 'sequenceCardFrame', 'sequenceLightbox']) {
    assert.ok(repaint.includes(`${hook}?.()`), `a new frame is not painted into ${hook}`);
  }

  // The film has no clock of its own any more, and shows the player's frame.
  const film = main.slice(main.indexOf("if (inspectView === 'patterns') {"));
  const filmBlock = film.slice(0, film.indexOf('\n}'));
  assert.doesNotMatch(filmBlock, /set(Interval|Timeout)\(/, 'the film keeps a timer of its own');
  assert.match(filmBlock, /const at = sequenceNow\(\);\n\s+const note = notes\[at\.frame\];/);
  assert.match(filmBlock, /sampleFrame\(specs\[at\.frame\]/);
  assert.match(filmBlock, /sequenceFilm = \(\) =>/);

  // The card's frame is drawn on the page and opened at slot -1, under its own
  // tag: a worker frame for a real slot, or a late reply tagged for another
  // picture, would replace it with something nobody is sending.
  const zoom = body('openSequenceLightbox');
  assert.match(zoom, /openLightbox\(image, image\.caption, -1, SEQUENCE_LIGHTBOX\)/);
  assert.match(zoom, /sequenceLightbox = \(\) =>/);
  // No compositor frame is rendered while the card shows the calibration frame.
  assert.match(main, /projectorPreviewWidth: fine && !patternActive\(\) \? previewWidth : 0/);
  // A frame stopped on asks for the parity pass, after the same 260 ms a settled
  // slider waits, and not for the model preview, whose request rebuilds the
  // control panel.
  assert.match(body('settleOnFrame'), /setTimeout\(\(\) => requestModel\(true, false\), 260\)/);
  // The keys read where focus is before they act.
  assert.match(
    body('installSequenceKeys'),
    /sequenceKeyAction\(\s*e,\s*sequenceFocus\(e\.target instanceof HTMLElement \? e\.target : null\),\s*\)/,
  );
  // On a phone the transport is the first thing under the content chips: the
  // settings sheet there is a few hundred pixels tall, and anything put above
  // the transport pushes it out of sight.
  assert.match(body('sequenceBlock'), /return \[\n\s+inline,/);
  // The lower third exists, starts hidden, and the hint makes way for it.
  assert.match(html, /<div id="sequence"[^>]*\shidden><\/div>/);
  assert.match(html, /body\.sequence-on #hint \{ display: none; \}/);
});
