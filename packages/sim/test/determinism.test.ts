// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Determinism, which the headless bench depends on absolutely.
 *
 * From packages/sim/README.md: "Every render is a pure function of
 * (calibration, scene, seed). No wall-clock, no unseeded randomness, no
 * floating-point reduction whose order depends on scheduling. The headless bench
 * relies on this: two runs with the same seed must produce byte-identical PNGs."
 *
 * The CI workflow runs the bench twice with the same seed and diffs the results.
 * If that ever starts failing intermittently, every before/after comparison on
 * the progress page has been measuring noise, and nobody would know for weeks.
 * So: check byte identity here, at the level of the individual renderers, where
 * a failure names the culprit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeRng, hash01, radicalInverse } from '../src/random.ts';
import { injectMisalignment, nominalRig } from '../src/scene.ts';
import { prepareRig } from '../src/optics.ts';
import { gridAlignmentPattern } from '../src/equirect.ts';
import {
  defaultScene,
  renderFramebuffer,
  renderProjectorView,
  renderRoomView,
  viewerAt,
} from '../src/render.ts';
import { encodePng16, encodePng8 } from '../src/png.ts';

const rigCal = nominalRig({ resX: 96, resY: 54 });
const rig = prepareRig(rigCal);
const scene = defaultScene(gridAlignmentPattern({ width: 512, height: 256, spacingDeg: 15 }));
const camera = viewerAt(20, 2.5, 1.6, rigCal.sphere.centerHeightM, 120, 90);

test('the PRNG: the same seed gives the same stream, different seeds do not', () => {
  const draw = (seed: number, n: number): number[] => {
    const rng = makeRng(seed);
    return Array.from({ length: n }, () => rng.nextUint32());
  };

  assert.deepEqual(draw(1, 64), draw(1, 64), 'same seed must replay exactly');
  assert.notDeepEqual(draw(1, 64), draw(2, 64), 'adjacent seeds must diverge');

  // Adjacent seeds must diverge IMMEDIATELY, not after a few hundred draws.
  // This is the whole reason splitmix64 seeds the generator instead of the raw
  // seed being poured into the state: the bench sweeps consecutive seeds, and
  // correlated first draws would correlate the scenarios it claims are
  // independent.
  const a = draw(1000, 8);
  const b = draw(1001, 8);
  for (let i = 0; i < 8; i++) {
    assert.notEqual(a[i], b[i], `draw ${i} matched between adjacent seeds`);
  }

  // Every draw is a uint32.
  for (const v of draw(7, 1000)) {
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, `bad uint32: ${v}`);
  }
});

test('the PRNG: floats and gaussians are in range and reproducible', () => {
  const rng = makeRng(99);
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < 100_000; i++) {
    const f = rng.nextFloat();
    assert.ok(f >= 0 && f < 1, `float out of range: ${f}`);
    lo = Math.min(lo, f);
    hi = Math.max(hi, f);
  }
  assert.ok(lo < 0.001 && hi > 0.999, `poor coverage of [0,1): ${lo}..${hi}`);

  // Box-Muller: mean 0, sd 1, and no NaN from a log(0).
  const g = makeRng(5);
  let sum = 0;
  let sumSq = 0;
  const n = 200_000;
  for (let i = 0; i < n; i++) {
    const x = g.gaussian();
    assert.ok(Number.isFinite(x), 'gaussian produced a non-finite value');
    sum += x;
    sumSq += x * x;
  }
  const mean = sum / n;
  const sd = Math.sqrt(sumSq / n - mean * mean);
  assert.ok(Math.abs(mean) < 0.01, `gaussian mean ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.01, `gaussian sd ${sd}`);

  // Reproducible across separate generator instances.
  const p = makeRng(31);
  const q = makeRng(31);
  for (let i = 0; i < 100; i++) assert.equal(p.gaussian(), q.gaussian());
});

test('the sample-offset hash is a pure function of its arguments', () => {
  // The tracer must not depend on pixel iteration order, so the offsets come
  // from a hash rather than a stream. Verify the property directly: asking out
  // of order gives the same answers.
  const forward: number[] = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) forward.push(hash01(x, y, 42, 0));
  const backward: number[] = [];
  for (let y = 19; y >= 0; y--) for (let x = 19; x >= 0; x--) backward.push(hash01(x, y, 42, 0));
  backward.reverse();
  assert.deepEqual(forward, backward);

  // Different pixels get different offsets; a hash that collapsed would restore
  // the structured moire the rotation exists to remove.
  assert.ok(new Set(forward).size > 390, 'hash collisions across a 20x20 tile');
  // ...and the seed changes them all.
  assert.notEqual(hash01(3, 4, 42, 0), hash01(3, 4, 43, 0));

  // Halton is deterministic and in range.
  assert.equal(radicalInverse(2, 1), 0.5);
  assert.equal(radicalInverse(2, 2), 0.25);
  assert.equal(radicalInverse(2, 3), 0.75);
  assert.ok(Math.abs(radicalInverse(3, 1) - 1 / 3) < 1e-15);
  for (let i = 1; i < 500; i++) {
    const v = radicalInverse(2, i);
    assert.ok(v >= 0 && v < 1);
  }

  // Base 1 used to spin forever: `i % 1` is 0 and `Math.floor(i / 1)` is `i`, so
  // the loop never advances and the render never returns. Throwing is the only
  // outcome a caller can see.
  assert.throws(() => radicalInverse(1, 4), RangeError);
  assert.throws(() => radicalInverse(0, 4), RangeError);
  assert.throws(() => radicalInverse(2.5, 4), RangeError);
  // A non-integer index returns a number, which is why it needs a guard: it
  // would quietly stop being the low-discrepancy sequence.
  assert.throws(() => radicalInverse(2, 1.5), RangeError);
  assert.throws(() => radicalInverse(2, -1), RangeError);
  // Index zero is the legitimate first element of the sequence, not an error.
  assert.equal(radicalInverse(2, 0), 0);
});

test('room view: the same seed gives byte-identical PNGs', () => {
  const a = encodePng8(renderRoomView(rig, scene, camera, { samplesPerPixel: 4, seed: 2024 }));
  const b = encodePng8(renderRoomView(rig, scene, camera, { samplesPerPixel: 4, seed: 2024 }));
  assert.ok(a.equals(b), 'same seed produced different bytes');

  // And the 16-bit path, where a single differing least-significant bit that
  // 8-bit quantization would hide becomes visible.
  const a16 = encodePng16(renderRoomView(rig, scene, camera, { samplesPerPixel: 4, seed: 2024 }));
  const b16 = encodePng16(renderRoomView(rig, scene, camera, { samplesPerPixel: 4, seed: 2024 }));
  assert.ok(a16.equals(b16), '16-bit output differed');
});

test('room view: different seeds give different renders', () => {
  // If this ever passes trivially — because the seed is ignored — the
  // byte-identity test above would pass no matter how much nondeterminism crept
  // into the tracer. The pair only means something together.
  const a = encodePng8(renderRoomView(rig, scene, camera, { samplesPerPixel: 4, seed: 1 }));
  const b = encodePng8(renderRoomView(rig, scene, camera, { samplesPerPixel: 4, seed: 2 }));
  assert.ok(!a.equals(b), 'the seed had no effect on the render');

  // The difference must be sub-pixel jitter, not a different picture: the mean
  // intensity should barely move.
  const meanOf = (seed: number): number => {
    const img = renderRoomView(rig, scene, camera, { samplesPerPixel: 4, seed });
    let sum = 0;
    for (let i = 0; i < img.data.length; i++) sum += img.data[i];
    return sum / img.data.length;
  };
  assert.ok(Math.abs(meanOf(1) - meanOf(2)) < 1e-3, 'the seed changed more than the sampling');
});

test('a single-sample render ignores the seed entirely', () => {
  // With one sample per pixel the offset is exactly the pixel centre, per
  // conventions.ts §I. That makes single-sample renders comparable against an
  // analytic expectation, which is what the metrics use.
  const a = encodePng8(renderRoomView(rig, scene, camera, { samplesPerPixel: 1, seed: 11 }));
  const b = encodePng8(renderRoomView(rig, scene, camera, { samplesPerPixel: 1, seed: 22 }));
  assert.ok(a.equals(b), 'at one sample per pixel the seed must not matter');
});

test('projector views and the framebuffer are byte-identical across runs', () => {
  for (let i = 0; i < rig.projectors.length; i++) {
    const a = encodePng8(renderProjectorView(rig, i, scene, { samplesPerPixel: 3, seed: 88 }));
    const b = encodePng8(renderProjectorView(rig, i, scene, { samplesPerPixel: 3, seed: 88 }));
    assert.ok(a.equals(b), `projector ${i} differed between runs`);
  }

  const fa = encodePng8(renderFramebuffer(rig, scene, { samplesPerPixel: 2, seed: 5 }));
  const fb = encodePng8(renderFramebuffer(rig, scene, { samplesPerPixel: 2, seed: 5 }));
  assert.ok(fa.equals(fb), 'the framebuffer differed between runs');
});

test('a render is a pure function of the calibration too', () => {
  // Not just of the seed. Two independently constructed but identical rigs must
  // render identically — no hidden state carried in the prepared form.
  const one = prepareRig(nominalRig({ resX: 96, resY: 54 }));
  const two = prepareRig(nominalRig({ resX: 96, resY: 54 }));
  const a = encodePng8(renderRoomView(one, scene, camera, { samplesPerPixel: 2, seed: 3 }));
  const b = encodePng8(renderRoomView(two, scene, camera, { samplesPerPixel: 2, seed: 3 }));
  assert.ok(a.equals(b));

  // A perturbed rig renders differently, and the same perturbation renders the
  // same way — which is what makes the bench's before/after pairs meaningful.
  const m1 = prepareRig(injectMisalignment(nominalRig({ resX: 96, resY: 54 }), 77).rig);
  const m2 = prepareRig(injectMisalignment(nominalRig({ resX: 96, resY: 54 }), 77).rig);
  const c = encodePng8(renderRoomView(m1, scene, camera, { samplesPerPixel: 2, seed: 3 }));
  const d = encodePng8(renderRoomView(m2, scene, camera, { samplesPerPixel: 2, seed: 3 }));
  assert.ok(c.equals(d), 'the same misalignment seed rendered differently');
  assert.ok(!a.equals(c), 'a misaligned rig must render differently from the nominal one');
});

test('the PNG encoder itself is byte-reproducible', () => {
  // Fixed compression level, filter type 0 on every scanline, no timestamp
  // chunk. An encoder that picked filters adaptively would still be
  // deterministic, but one that embedded a creation time would not — and the
  // failure would look exactly like a nondeterministic renderer.
  const img = renderRoomView(rig, scene, camera, { samplesPerPixel: 1, seed: 0 });
  const first = encodePng8(img);
  for (let i = 0; i < 5; i++) assert.ok(encodePng8(img).equals(first));

  // Valid PNG structure: signature, IHDR, IDAT, IEND.
  assert.deepEqual([...first.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(first.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(first.readUInt32BE(16), img.width);
  assert.equal(first.readUInt32BE(20), img.height);
  assert.equal(first[24], 8, 'bit depth');
  assert.equal(first[25], 2, 'colour type 2 = truecolour RGB');
  assert.equal(first.subarray(first.length - 8, first.length - 4).toString('latin1'), 'IEND');

  const sixteen = encodePng16(img);
  assert.equal(sixteen[24], 16, '16-bit depth');
  assert.equal(sixteen[25], 2);
  assert.ok(sixteen.length > first.length, '16-bit output must carry more data');
});

test('encoding options change the output but not its determinism', () => {
  const img = renderRoomView(rig, scene, camera, { samplesPerPixel: 1, seed: 0 });
  const plain = encodePng8(img);
  const bright = encodePng8(img, { exposure: 2 });
  const linear = encodePng8(img, { displayGamma: 1 });
  assert.ok(!plain.equals(bright));
  assert.ok(!plain.equals(linear));
  assert.ok(encodePng8(img, { exposure: 2 }).equals(bright));
  assert.ok(encodePng8(img, { displayGamma: 1 }).equals(linear));
});
