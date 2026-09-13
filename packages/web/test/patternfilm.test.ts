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
import test from 'node:test';

import { DEFAULT_PATTERN_PLAN, planFrames } from '../../bench/src/patterns.ts';
import {
  describeSequence,
  encodeToRgba,
  sampleFrame,
  strideInfo,
} from '../src/patternfilm.ts';

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
