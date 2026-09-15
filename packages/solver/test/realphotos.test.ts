// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Real photographs into a decoded capture — Phase 3's plumbing, end to end.
 *
 * The chain is `linearise` -> `assembleCapture` -> `decodeCapture`, and the test
 * that matters is the one that runs all three on 8-bit sRGB integers and checks
 * the projector coordinates that come out are the ones that went in. Every other
 * test in this file is a single link.
 *
 * ## Why the frames are synthesised from the docblock rather than from the bench
 *
 * `packages/solver` may not import `packages/sim`, and `packages/bench` reaches
 * it — so the bench's renderer is not available here, and that turns out to be
 * the better fixture anyway. `decode.ts`'s own header states the pattern
 * normatively:
 *
 *     code(s)    = clamp(floor(s / stridePx), 0, 2^bits - 1)
 *     gray(s)    = code XOR (code >> 1)
 *     pattern[j] = bit (bits-1-j) of gray(s)
 *     frame[n](s) = 0.5 + 0.5 cos(2 pi s / periodPx - 2 pi n / steps)
 *
 * and {@link emit} below is a second implementation of exactly that, written
 * from the prose rather than from `grayPatternBit`. So a failure here is a
 * failure of the plumbing or of the convention, not of one helper agreeing with
 * itself.
 *
 * ## What it does not prove
 *
 * That real photographs decode. These are synthetic integers with a flat albedo,
 * a constant ambient term and no sensor noise, mapped camera pixel to projector
 * pixel one to one. What they establish is that the ingest undoes the transfer
 * it was told about, that the assembler puts every frame in the slot the decoder
 * expects, and that the three agree about the normative order — which is the
 * part that was missing, and the part a real capture cannot be debugged without.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeCapture, type LinearImage } from '../src/decode.ts';
import { assembleCapture, type FrameRole } from '../src/assemble.ts';
import { decodeTransfer, linearise, referenceRange, type EncodedImage } from '../src/ingest.ts';
import { captureWorth, type PairContribution } from '../src/worth.ts';

const RES = 256;
const BITS = 5;
const STRIDE = RES / Math.pow(2, BITS); // 8 projector pixels
const STEPS = 4;
const PERIOD = STRIDE * 2; // 16, the even multiple decode.ts asks for

/** The surface: a flat albedo and a room that never goes fully dark. */
const ALBEDO = 0.7;
const AMBIENT = 0.05;

/** The pattern, written from `decode.ts`'s header rather than from its helpers. */
function emit(role: FrameRole, u: number, v: number): number {
  if (role.kind === 'white') return 1;
  if (role.kind === 'black') return 0;
  const s = role.axis === 'u' ? u : v;
  if (role.kind === 'phase') {
    return 0.5 + 0.5 * Math.cos((2 * Math.PI * s) / PERIOD - (2 * Math.PI * role.index) / STEPS);
  }
  const code = Math.min(Math.pow(2, BITS) - 1, Math.max(0, Math.floor(s / STRIDE)));
  const gray = code ^ (code >>> 1);
  const bit = (gray >>> (BITS - 1 - role.index)) & 1;
  return role.kind === 'grayInverse' ? 1 - bit : bit;
}

/** sRGB encode, IEC 61966-2-1 — the inverse of what `linearise` undoes. */
function srgbEncode(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** One frame as a camera would file it: 8-bit sRGB, one camera pixel per projector pixel. */
function shoot(role: FrameRole): EncodedImage {
  const data = new Uint8Array(RES * RES);
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      // Pixel centres, conventions.ts §I and what decode.ts evaluates at.
      const lit = AMBIENT + ALBEDO * emit(role, x + 0.5, y + 0.5);
      data[y * RES + x] = Math.round(srgbEncode(lit) * 255);
    }
  }
  return { width: RES, height: RES, channels: 1, data, maxValue: 255 };
}

/** `planFrames`' order, restated here because solver cannot import it. */
function roles(): FrameRole[] {
  const out: FrameRole[] = [
    { kind: 'white', axis: null, index: 0 },
    { kind: 'black', axis: null, index: 0 },
  ];
  for (const axis of ['u', 'v'] as const) {
    for (let j = 0; j < BITS; j++) {
      out.push({ kind: 'gray', axis, index: j });
      out.push({ kind: 'grayInverse', axis, index: j });
    }
  }
  for (const axis of ['u', 'v'] as const) {
    for (let n = 0; n < STEPS; n++) out.push({ kind: 'phase', axis, index: n });
  }
  return out;
}

test('the transfer is undone, and it is the one the caller named', () => {
  // sRGB is not a power law, and the toe is where the black reference lives.
  // A pure 2.2 at the dark end is off by a factor of three, which is exactly the
  // region the modulation reference is measured from.
  assert.ok(Math.abs(decodeTransfer(0.5, { kind: 'srgb' }) - 0.2140) < 1e-3);
  assert.equal(decodeTransfer(0.5, { kind: 'linear' }), 0.5);
  assert.ok(Math.abs(decodeTransfer(0.5, { kind: 'gamma', exponent: 2.2 }) - 0.2176) < 1e-3);
  const toe = 0.02;
  assert.ok(
    decodeTransfer(toe, { kind: 'srgb' }) > 2 * decodeTransfer(toe, { kind: 'gamma', exponent: 2.2 }),
    'the sRGB toe is far above a pure power law, which is why the curve is named not fitted',
  );
  // Round trip: encode then decode returns what went in, to 8-bit resolution.
  for (const v of [0, 0.01, 0.05, 0.25, 0.5, 0.75, 1]) {
    const byte = Math.round(srgbEncode(v) * 255);
    const back = decodeTransfer(byte / 255, { kind: 'srgb' });
    assert.ok(Math.abs(back - v) < 0.01, `round trip at ${v} gave ${back}`);
  }
});

test('clipping is counted rather than judged, and a dead reference pair is refused', () => {
  const flat = (value: number): EncodedImage => ({
    width: 2,
    height: 2,
    channels: 1,
    data: new Uint8Array([value, value, value, value]),
    maxValue: 255,
  });
  const blown = linearise(flat(255), { kind: 'srgb' });
  assert.equal(blown.report.clippedHigh, 1);
  assert.equal(blown.report.clippedLow, 0);
  const dark = linearise(flat(0), { kind: 'srgb' });
  assert.equal(dark.report.clippedLow, 1);

  // A white frame brighter than the black one is usable however ugly it is.
  assert.equal(referenceRange(blown.report, dark.report).usable, true);
  // Both clipped flat is not a degraded capture, it is no capture: every later
  // frame is read as a fraction of `white - black`.
  const dead = referenceRange(blown.report, blown.report);
  assert.equal(dead.usable, false);
  assert.match(dead.problem ?? '', /nothing to read them against/);
  assert.match(dead.problem ?? '', /100.0% of the white frame is at the sensor ceiling/);
  // And the inverted case, which is a mislabelled pair rather than an exposure.
  assert.equal(referenceRange(dark.report, blown.report).usable, false);
});

test('a folder of 8-bit sRGB frames decodes to the projector pixels that made it', () => {
  // The chain the phase exists to build. Nothing here is rendered by the bench:
  // integers in, correspondences out.
  const order = roles();
  const shots = order.map(shoot);
  const images: LinearImage[] = shots.map((s) => linearise(s, { kind: 'srgb' }).image);

  const assembled = assembleCapture(images, order, {
    camera: 0,
    projector: 0,
    projectorRes: { x: RES, y: RES },
    grayBits: BITS,
    phaseSteps: STEPS,
    phasePeriodStrides: 2,
  });
  assert.equal(assembled.ok, true, assembled.problems.join(' '));
  const capture = assembled.capture;
  assert.ok(capture !== null);
  assert.equal(capture.gray.length, 2, 'both axes addressed');
  assert.equal(capture.phase.length, 2);
  assert.equal(capture.gray[0].stridePx, STRIDE);
  assert.equal(capture.phase[0].periodPx, PERIOD);

  const decoded = decodeCapture(capture);
  assert.ok(decoded.correspondences.length > 0, 'nothing decoded at all');

  // Every surviving correspondence should name the projector pixel it came from,
  // because the camera and the projector are the same raster in this fixture.
  let worst = 0;
  for (const c of decoded.correspondences) {
    worst = Math.max(worst, Math.abs(c.projU - c.camU), Math.abs(c.projV - c.camV));
  }
  assert.ok(worst < 1.0, `worst coordinate error ${worst.toFixed(3)} projector pixels`);
  // And most of the raster should survive: this fixture has no limb, no shadow
  // and no noise, so a low yield would mean the plumbing is dropping frames.
  const yieldFrac = decoded.correspondences.length / (RES * RES);
  assert.ok(yieldFrac > 0.9, `only ${(100 * yieldFrac).toFixed(1)}% of pixels decoded`);
});

test('the assembler refuses a run it cannot decode, and says which part is missing', () => {
  const order = roles();
  const images: LinearImage[] = order.map((r) => linearise(shoot(r), { kind: 'srgb' }).image);
  const params = {
    camera: 0,
    projector: 0,
    projectorRes: { x: RES, y: RES },
    grayBits: BITS,
    phaseSteps: STEPS,
    phasePeriodStrides: 2,
  };

  // A Gray plane whose complement never arrived.
  const dropIdx = order.findIndex((r) => r.kind === 'grayInverse' && r.index === 2);
  const shortRoles = order.filter((_, i) => i !== dropIdx);
  const shortImages = images.filter((_, i) => i !== dropIdx);
  const missing = assembleCapture(shortImages, shortRoles, params);
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join(' '), /missing plane 3's complement/);
  assert.match(missing.problems.join(' '), /it is no bit/);

  // Lists whose two halves disagree about length are an indexing fault, and the
  // message says so rather than blaming the photographs.
  const mismatched = assembleCapture(images.slice(0, 5), order, params);
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.problems.join(' '), /indexing fault upstream/);

  // One frame of a different size cannot be subtracted from the references.
  const odd = images.slice();
  odd[7] = { width: 128, height: 128, channels: 1, data: new Float32Array(128 * 128) };
  const resized = assembleCapture(odd, order, params);
  assert.equal(resized.ok, false);
  assert.match(resized.problems.join(' '), /Photograph 8 is 128x128/);
});

test('what the capture was worth is said before any pose is', () => {
  const zero = {
    considered: 1000,
    accepted: 0,
    rejectedLowModulation: 900,
    rejectedGrayAmbiguous: 100,
    rejectedPhaseWeak: 0,
    rejectedDisagreement: 0,
    rejectedOutOfRange: 0,
    rejectedMissingAxis: 0,
    rejectedOffSphere: 0,
    rejectedOffImage: 0,
  };
  const empty = captureWorth([{ camera: 0, projector: 0, stats: zero }]);
  assert.equal(empty.usable, false);
  // The generalised form of the guard in pipeline.ts, and its reason.
  assert.match(empty.refusal ?? '', /no pose to report/);
  assert.match(empty.refusal ?? '', /every appearance of having converged/);
  // The dominant bucket is named, because "it didn't converge" sends an operator
  // home and "the light never reached them" sends them to the projector.
  assert.match(empty.summary, /90% went because the projector’s light never reached them/);

  // One camera is degenerate rather than poor, and EXPERIMENT-1 is what says so.
  const some = { ...zero, accepted: 5000 };
  const lonely = captureWorth([{ camera: 0, projector: 0, stats: some }]);
  assert.equal(lonely.usable, false);
  assert.match(lonely.refusal ?? '', /cannot separate a projector's distance from its field of view/);
  assert.match(lonely.refusal ?? '', /17 489.84 mm/);

  // Two contributing cameras is usable, and a third that contributed nothing is
  // named in the summary rather than quietly absent.
  const pairs: PairContribution[] = [
    { camera: 0, projector: 0, stats: some },
    { camera: 1, projector: 0, stats: some },
    { camera: 2, projector: 0, stats: zero },
  ];
  const worth = captureWorth(pairs);
  assert.equal(worth.usable, true);
  assert.equal(worth.accepted, 10000);
  assert.deepEqual(worth.silentCameras, [2]);
  assert.deepEqual(worth.contributingCameras, [0, 1]);
  assert.match(worth.summary, /Camera 3 contributed nothing/);
  assert.equal(worth.refusal, null);
});

test('8-bit sRGB is not what limits the phase, and the test says by how much', () => {
  // The question an operator asks first — "will a JPEG do, or do I need raw?" —
  // and the one case where this fixture can answer it, because quantisation is
  // the ONLY error in it: flat albedo, constant ambient, no sensor noise, camera
  // pixel to projector pixel one to one.
  //
  // What that isolates is the transfer's resolution and nothing else. It is a
  // floor rather than a prediction: a real room adds noise, a real sphere adds
  // a cosine falloff and a limb, and neither is here.
  const order = roles();
  const run = (maxValue: number): number => {
    const images: LinearImage[] = order.map((role) => {
      const data = maxValue > 255 ? new Uint16Array(RES * RES) : new Uint8Array(RES * RES);
      for (let y = 0; y < RES; y++) {
        for (let x = 0; x < RES; x++) {
          const lit = AMBIENT + ALBEDO * emit(role, x + 0.5, y + 0.5);
          data[y * RES + x] = Math.round(srgbEncode(lit) * maxValue);
        }
      }
      return linearise(
        { width: RES, height: RES, channels: 1, data, maxValue },
        { kind: 'srgb' },
      ).image;
    });
    const a = assembleCapture(images, order, {
      camera: 0,
      projector: 0,
      projectorRes: { x: RES, y: RES },
      grayBits: BITS,
      phaseSteps: STEPS,
      phasePeriodStrides: 2,
    });
    assert.equal(a.ok, true, a.problems.join(' '));
    const d = decodeCapture(a.capture as NonNullable<typeof a.capture>);
    let worst = 0;
    for (const c of d.correspondences) {
      worst = Math.max(worst, Math.abs(c.projU - c.camU), Math.abs(c.projV - c.camV));
    }
    assert.equal(d.correspondences.length, RES * RES, `only ${d.correspondences.length} decoded`);
    return worst;
  };

  const eight = run(255);
  const sixteen = run(65535);
  // A hundredth of a projector pixel at 8 bits. Against PARAMETERS.md §7's 2 mm
  // on a 1.7 m sphere this is not the term that matters, which is the finding:
  // an operator shooting JPEG is not giving up the calibration.
  assert.ok(eight < 0.01, `8-bit worst coordinate error ${eight.toFixed(4)} projector px`);
  // Sixteen bits is better, and the gap is what says the 8-bit number is
  // quantisation rather than something else in the chain.
  assert.ok(sixteen < eight, `16-bit (${sixteen.toFixed(5)}) should beat 8-bit (${eight.toFixed(5)})`);
  assert.ok(sixteen < 0.001, `16-bit worst coordinate error ${sixteen.toFixed(5)}`);
});

/**
 * The refusals a review found missing, each with the capture that slipped past.
 *
 * Every one of these assembled cleanly before: the frame-count check at the top
 * cannot see them, because `images` and `roles` still agree about the length.
 * What they have in common is that the decoder would have accepted the result
 * and produced coordinates from it.
 */
test('a phase pass short of its last frame is refused, not read as a shorter pass', () => {
  const order = roles();
  // Drop the final across phase step. The remaining three were shot at 0, 90
  // and 180 degrees; counted rather than checked they look like a three-step
  // pass at 0, 120 and 240, and decode to a confidently wrong phase.
  const cut = order.findIndex((r) => r.kind === 'phase' && r.axis === 'u' && r.index === STEPS - 1);
  assert.ok(cut >= 0);
  const short = order.filter((_, i) => i !== cut);
  const images = short.map(shoot).map((s) => linearise(s, { kind: 'srgb' }).image);

  const a = assembleCapture(images, short, {
    camera: 0,
    projector: 0,
    projectorRes: { x: RES, y: RES },
    grayBits: BITS,
    phaseSteps: STEPS,
    phasePeriodStrides: 2,
  });
  assert.equal(a.ok, false);
  assert.match(a.problems.join(' '), /across phase pass is missing step 4 of 4/);
});

test('two photographs claiming one slot are refused rather than one overwriting the other', () => {
  const order = roles();
  const dupe = order.map((r, i) =>
    i === order.length - 1 ? { ...order[order.length - 2] } : r,
  );
  const images = dupe.map(shoot).map((s) => linearise(s, { kind: 'srgb' }).image);
  const a = assembleCapture(images, dupe, {
    camera: 0,
    projector: 0,
    projectorRes: { x: RES, y: RES },
    grayBits: BITS,
    phaseSteps: STEPS,
    phasePeriodStrides: 2,
  });
  assert.equal(a.ok, false);
  assert.match(a.problems.join(' '), /both call themselves/);
});

test('a role indexing past its own plan is refused', () => {
  const order = roles();
  const past = order.map((r) =>
    r.kind === 'gray' && r.axis === 'u' && r.index === 0 ? { ...r, index: BITS } : r,
  );
  const images = past.map(shoot).map((s) => linearise(s, { kind: 'srgb' }).image);
  const a = assembleCapture(images, past, {
    camera: 0,
    projector: 0,
    projectorRes: { x: RES, y: RES },
    grayBits: BITS,
    phaseSteps: STEPS,
    phasePeriodStrides: 2,
  });
  assert.equal(a.ok, false);
  assert.match(a.problems.join(' '), /of an axis whose plan has 5/);
});

test('an odd or zero fringe period is refused where the phase would use it', () => {
  const order = roles();
  const images = order.map(shoot).map((s) => linearise(s, { kind: 'srgb' }).image);
  const at = (phasePeriodStrides: number) =>
    assembleCapture(images, order, {
      camera: 0,
      projector: 0,
      projectorRes: { x: RES, y: RES },
      grayBits: BITS,
      phaseSteps: STEPS,
      phasePeriodStrides,
    });
  // Zero makes periodPx zero, which the unwrap divides by.
  assert.equal(at(0).ok, false);
  // One leaves the Gray address no finer than a fringe, so the cross-check that
  // catches a mis-indexed capture can never fire — decode.ts's own header.
  assert.equal(at(1).ok, false);
  assert.equal(at(3).ok, false);
  assert.equal(at(2).ok, true, at(2).problems.join(' '));
});

test('one axis addressed and the other not is refused, not offered as half a capture', () => {
  const order = roles().filter((r) => r.axis !== 'v');
  const images = order.map(shoot).map((s) => linearise(s, { kind: 'srgb' }).image);
  const a = assembleCapture(images, order, {
    camera: 0,
    projector: 0,
    projectorRes: { x: RES, y: RES },
    grayBits: BITS,
    phaseSteps: STEPS,
    phasePeriodStrides: 2,
  });
  // Before, `gray.length === 0` was the only gate: a complete across sequence
  // satisfied it and every pixel then died as `rejectedMissingAxis`.
  assert.equal(a.ok, false);
  assert.match(a.problems.join(' '), /Nothing in this run addresses the down axis/);
});

test('every projector needs two views, not the capture as a whole', () => {
  const base = {
    considered: 1000,
    rejectedLowModulation: 0,
    rejectedGrayAmbiguous: 0,
    rejectedPhaseWeak: 0,
    rejectedDisagreement: 0,
    rejectedOutOfRange: 0,
    rejectedMissingAxis: 0,
    rejectedOffSphere: 0,
    rejectedOffImage: 0,
  };
  const some = { ...base, accepted: 400 };

  // Two cameras, two projectors, and each camera saw only one of them. The
  // capture-wide count is two and every projector still has a single view, so
  // each one keeps the distance-versus-field-of-view degeneracy whole.
  const split = captureWorth([
    { camera: 0, projector: 0, stats: some },
    { camera: 1, projector: 1, stats: some },
  ]);
  assert.equal(split.contributingCameras.length, 2, 'two cameras did contribute');
  assert.equal(split.usable, false, 'but neither projector was seen twice');
  assert.match(split.refusal ?? '', /2 projectors were seen by fewer than two cameras/);
  assert.match(split.refusal ?? '', /solved from the views that saw IT/);
  assert.match(split.refusal ?? '', /17 489\.84 mm/);

  // The same two cameras, both looking at both projectors, is the shot list
  // that works — and it is one move away from the capture above.
  const both = captureWorth([
    { camera: 0, projector: 0, stats: some },
    { camera: 1, projector: 0, stats: some },
    { camera: 0, projector: 1, stats: some },
    { camera: 1, projector: 1, stats: some },
  ]);
  assert.equal(both.usable, true, both.refusal ?? '');
  assert.deepEqual(
    both.camerasPerProjector.map((e) => e.cameras.length),
    [2, 2],
  );

  // A pair that decoded nothing does not count as a view of that projector.
  const silent = captureWorth([
    { camera: 0, projector: 0, stats: some },
    { camera: 1, projector: 0, stats: { ...base, accepted: 0 } },
    { camera: 1, projector: 1, stats: some },
    { camera: 0, projector: 1, stats: some },
  ]);
  assert.equal(silent.usable, false);
  assert.match(silent.refusal ?? '', /A projector was seen by fewer than two cameras: P1 \(1\)/);
});

test('colour survives the ingest, because the decoder has its own opinion about channels', () => {
  // Three channels in, three out: decode.ts reads Rec.709 luminance by default
  // and PARAMETERS.md §3.2 warns the channels diverge in gamma, gain and black
  // floor. Returning one channel made that choice for it — and made it red.
  const rgb = new Uint8Array([0, 255, 0, 0, 255, 0]);
  const lin = linearise({ width: 2, height: 1, channels: 3, data: rgb, maxValue: 255 }, { kind: 'srgb' });
  assert.equal(lin.image.channels, 3);
  assert.equal(lin.image.data.length, 6);
  // The green is what the old code threw away: it read data[i * 3] and called
  // a fully lit green frame black.
  assert.equal(lin.image.data[0], 0);
  assert.ok(lin.image.data[1] > 0.99, `green came back ${lin.image.data[1]}`);

  // Alpha is coverage, not light, so it is dropped rather than transferred.
  const rgba = new Uint8Array([0, 255, 0, 255]);
  const withAlpha = linearise(
    { width: 1, height: 1, channels: 4, data: rgba, maxValue: 255 },
    { kind: 'srgb' },
  );
  assert.equal(withAlpha.image.channels, 3);
  assert.equal(withAlpha.image.data.length, 3);

  // A single-channel file is still single-channel: nothing was invented.
  const grey = linearise(
    { width: 2, height: 1, channels: 1, data: new Uint8Array([0, 255]), maxValue: 255 },
    { kind: 'linear' },
  );
  assert.equal(grey.image.channels, 1);
  assert.equal(grey.report.clippedHigh, 0.5);
  assert.equal(grey.report.clippedLow, 0.5);

  // Clipping is per pixel, and one railed channel is enough: the decoder makes
  // one number out of the three, and that number is then the sensor's ceiling
  // rather than the scene's.
  const oneRailed = linearise(
    { width: 1, height: 1, channels: 3, data: new Uint8Array([10, 255, 10]), maxValue: 255 },
    { kind: 'srgb' },
  );
  assert.equal(oneRailed.report.clippedHigh, 1);
});

test('a three-channel folder decodes, so the colour reaches the decoder and not just the ingest', () => {
  // The junction the previous test cannot see. `linearise` keeping three
  // channels is only worth something if `decodeCapture` then reads them, and
  // checking the ingest against itself would miss a decoder that quietly took
  // channel 0 anyway.
  //
  // So the signal is put in GREEN and red is held at a dim constant. Under
  // Rec.709 luminance this decodes; under "first channel wins" it is a flat
  // field and nothing decodes at all.
  const order = roles();
  const images: LinearImage[] = order.map((role) => {
    const data = new Uint8Array(RES * RES * 3);
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const lit = AMBIENT + ALBEDO * emit(role, x + 0.5, y + 0.5);
        const at = (y * RES + x) * 3;
        data[at] = Math.round(srgbEncode(AMBIENT) * 255);
        data[at + 1] = Math.round(srgbEncode(lit) * 255);
        data[at + 2] = Math.round(srgbEncode(AMBIENT) * 255);
      }
    }
    return linearise(
      { width: RES, height: RES, channels: 3, data, maxValue: 255 },
      { kind: 'srgb' },
    ).image;
  });
  assert.equal(images[0].channels, 3);

  const a = assembleCapture(images, order, {
    camera: 0,
    projector: 0,
    projectorRes: { x: RES, y: RES },
    grayBits: BITS,
    phaseSteps: STEPS,
    phasePeriodStrides: 2,
  });
  assert.equal(a.ok, true, a.problems.join(' '));
  const d = decodeCapture(a.capture as NonNullable<typeof a.capture>);
  assert.equal(
    d.correspondences.length,
    RES * RES,
    `only ${d.correspondences.length} of ${RES * RES} decoded from a green-carried pattern`,
  );
  let worst = 0;
  for (const c of d.correspondences) {
    worst = Math.max(worst, Math.abs(c.projU - c.camU), Math.abs(c.projV - c.camV));
  }
  // Slightly worse than the grey chain: luminance keeps 0.7152 of the green
  // and the two dim channels dilute the modulation. Still far inside a pixel.
  assert.ok(worst < 0.05, `worst coordinate error ${worst.toFixed(4)} projector px`);
});
