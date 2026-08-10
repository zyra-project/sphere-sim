/**
 * Structured-light decode.
 *
 * The synthetic captures here carry a spatially varying albedo and an ambient
 * floor, because those are the two things the pattern-versus-complement design
 * exists to cancel. A decoder tested only on a uniform, ambient-free surface is
 * not being tested for the property that makes it work on a real sphere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DECODE_OPTIONS,
  binaryToGray,
  decodeCapture,
  grayPatternBit,
  grayToBinary,
  type LinearImage,
  type PatternCapture,
} from '../src/decode.ts';
import { generateCorrespondences, makeScene, renderCapture } from './synthetic.ts';

const SMALL = { cameraRes: { x: 160, y: 120 } };

test('Gray code arithmetic round-trips over the whole word', () => {
  for (let bits = 1; bits <= 12; bits++) {
    for (let v = 0; v < 1 << bits; v++) {
      assert.equal(grayToBinary(binaryToGray(v), bits), v);
    }
  }
  // Consecutive codes differ in exactly one bit — the property the whole scheme
  // is chosen for, since it bounds a misread bit to a one-step address error.
  for (let v = 1; v < 256; v++) {
    const diff = binaryToGray(v) ^ binaryToGray(v - 1);
    assert.equal(diff & (diff - 1), 0, 'single bit change');
  }
  assert.equal(grayPatternBit(0, 4, 0), 0);
  assert.equal(grayPatternBit(8, 4, 0), 1, 'MSB first');
});

/** Ground-truth projector coordinate at every camera pixel, keyed by pixel centre. */
function truthMap(
  truth: Parameters<typeof renderCapture>[0],
  camera: number,
  projector: number,
): Map<string, { u: number; v: number }> {
  const map = new Map<string, { u: number; v: number }>();
  for (const c of generateCorrespondences(truth, { cameraStride: 1, minCosIncidence: 0.2 })) {
    if (c.camera !== camera || c.projector !== projector) continue;
    map.set(`${c.camU},${c.camV}`, { u: c.projU, v: c.projV });
  }
  return map;
}

test('noiseless decode recovers projector pixels to well under a pixel', () => {
  const scene = makeScene(11, SMALL);
  const capture = renderCapture(scene.truth, 0, 0, { noiseSigma: 0 });
  const decoded = decodeCapture(capture);
  assert.ok(decoded.correspondences.length > 200, `got ${decoded.correspondences.length}`);

  // Ground truth comes from the same forward model that rendered the frames. The
  // question here is only whether the DECODER read back what was written.
  const truth = truthMap(scene.truth, 0, 0);
  let compared = 0;
  let worstU = 0;
  let worstV = 0;
  for (const c of decoded.correspondences) {
    const t = truth.get(`${c.camU},${c.camV}`);
    if (!t) continue;
    compared++;
    worstU = Math.max(worstU, Math.abs(c.projU - t.u));
    worstV = Math.max(worstV, Math.abs(c.projV - t.v));
  }
  assert.ok(compared > 200, `expected overlap with ground truth, got ${compared}`);
  assert.ok(worstU < 0.05, `worst u error ${worstU} px`);
  assert.ok(worstV < 0.05, `worst v error ${worstV} px`);
});

test('the phase refinement is far more precise than the Gray bin alone', () => {
  const scene = makeScene(12, SMALL);
  const capture = renderCapture(scene.truth, 0, 0, { noiseSigma: 0 });
  const full = decodeCapture(capture);
  const grayOnly = decodeCapture({ ...capture, phase: [] });

  const meanSigma = (xs: { sigmaU: number }[]): number =>
    xs.reduce((a, b) => a + b.sigmaU, 0) / Math.max(1, xs.length);
  const withPhase = meanSigma(full.correspondences);
  const without = meanSigma(grayOnly.correspondences);
  assert.ok(
    withPhase * 20 < without,
    `phase sigma ${withPhase} should be far below Gray-bin sigma ${without}`,
  );
});

test('off-sphere and shadowed pixels are rejected for want of modulation', () => {
  const scene = makeScene(13, SMALL);
  const capture = renderCapture(scene.truth, 0, 0, { noiseSigma: 0 });
  const decoded = decodeCapture(capture);
  const total = 160 * 120;
  assert.ok(decoded.stats.rejectedLowModulation > total * 0.3, 'most of the frame is off-sphere');
  assert.equal(
    decoded.stats.accepted + decoded.stats.rejectedLowModulation +
      decoded.stats.rejectedGrayAmbiguous + decoded.stats.rejectedPhaseWeak +
      decoded.stats.rejectedDisagreement + decoded.stats.rejectedOutOfRange +
      decoded.stats.rejectedMissingAxis,
    decoded.stats.considered,
    'every considered pixel is accounted for',
  );
});

test('a raised modulation floor rejects the dim, grazing edge of the footprint', () => {
  const scene = makeScene(14, SMALL);
  const capture = renderCapture(scene.truth, 0, 0, { noiseSigma: 0 });
  const loose = decodeCapture(capture, { minModulation: 0.02 });
  const strict = decodeCapture(capture, { minModulation: 0.35 });
  assert.ok(strict.correspondences.length < loose.correspondences.length);
  assert.ok(strict.correspondences.length > 0);
  // What survives the strict threshold is the well-lit core, so its mean
  // incidence-driven modulation must be higher.
  const mean = (xs: { modulation: number }[]): number =>
    xs.reduce((a, b) => a + b.modulation, 0) / Math.max(1, xs.length);
  assert.ok(mean(strict.correspondences) >= mean(loose.correspondences) - 1e-9);
});

test('decode degrades gracefully under additive gaussian noise', () => {
  const scene = makeScene(15, SMALL);
  const clean = decodeCapture(renderCapture(scene.truth, 0, 0, { noiseSigma: 0 }));
  const cleanMap = new Map<string, { u: number; v: number }>();
  for (const c of clean.correspondences) cleanMap.set(`${c.camU},${c.camV}`, { u: c.projU, v: c.projV });

  const noisy = decodeCapture(
    renderCapture(scene.truth, 0, 0, { noiseSigma: 0.01, seed: 99 }),
    { noiseSigma: 0.01 },
  );

  let n = 0;
  let sumSq = 0;
  let worst = 0;
  let sigmaSum = 0;
  for (const c of noisy.correspondences) {
    const ref = cleanMap.get(`${c.camU},${c.camV}`);
    if (!ref) continue;
    const du = c.projU - ref.u;
    n++;
    sumSq += du * du;
    worst = Math.max(worst, Math.abs(du));
    sigmaSum += c.sigmaU;
  }
  assert.ok(n > 100, `expected surviving correspondences, got ${n}`);
  const rms = Math.sqrt(sumSq / n);
  // 1% of full modulation is heavy noise for a projector-lit surface. The decode
  // should still land inside a pixel, and — the part that matters for the bundle
  // — its own uncertainty estimate should be the right order of magnitude rather
  // than optimistic, because that estimate becomes a weight.
  assert.ok(rms < 1.0, `rms decode error ${rms} px`);
  const meanSigma = sigmaSum / n;
  assert.ok(meanSigma > rms * 0.2, `reported sigma ${meanSigma} vs actual rms ${rms}`);
  assert.ok(meanSigma < rms * 5, `reported sigma ${meanSigma} vs actual rms ${rms}`);
  assert.ok(
    noisy.correspondences.length > clean.correspondences.length * 0.5,
    'noise should not gut the yield',
  );
});

test('a corrupted Gray plane is caught by the phase cross-check', () => {
  const scene = makeScene(16, SMALL);
  const capture = renderCapture(scene.truth, 0, 0, { noiseSigma: 0 });
  const before = decodeCapture(capture);

  // Flip one Gray bit plane against its complement across the whole frame. That
  // is exactly a fringe-order error: the Gray address moves by a power of two
  // while the phase does not, and nothing but the cross-check notices.
  const swapped: PatternCapture = {
    ...capture,
    gray: capture.gray.map((g, i) => {
      if (i !== 0) return g;
      const patterns = g.patterns.slice();
      const inverses = g.inverses.slice();
      // A high-order plane: an MSB-adjacent misread moves the decoded address by
      // a large fraction of the raster, which is the failure worth catching.
      const j = 1;
      const tmp: LinearImage = patterns[j];
      patterns[j] = inverses[j];
      inverses[j] = tmp;
      return { ...g, patterns, inverses };
    }),
  };
  const after = decodeCapture(swapped);
  assert.ok(after.stats.rejectedDisagreement > 0, 'the cross-check must fire');
  assert.ok(
    after.correspondences.length < before.correspondences.length * 0.75,
    `corrupted plane should cost most correspondences: ${after.correspondences.length} vs ${before.correspondences.length}`,
  );
  // The survivors are the pixels whose address error happened to land on a whole
  // number of fringes, where the unwrap silently agrees. Those are genuine
  // outliers by a whole period and are left to the robust loss in bundle.ts —
  // no cross-check between two commensurable scales can catch all of them.
});

test('white and black reference frames are optional', () => {
  const scene = makeScene(17, SMALL);
  const withRefs = decodeCapture(renderCapture(scene.truth, 0, 0, { includeWhiteBlack: true }));
  const withoutRefs = decodeCapture(
    renderCapture(scene.truth, 0, 0, { includeWhiteBlack: false }),
  );
  // Every Gray pattern is paired with its exact complement, so the per-pixel max
  // and min over the Gray frames reproduce the white and black references.
  assert.equal(withRefs.correspondences.length, withoutRefs.correspondences.length);
  for (let i = 0; i < withRefs.correspondences.length; i++) {
    assert.ok(Math.abs(withRefs.correspondences[i].projU - withoutRefs.correspondences[i].projU) < 1e-9);
  }
});

test('decode is invariant to per-pixel albedo and to an ambient floor', () => {
  const scene = makeScene(18, SMALL);
  const dark = decodeCapture(renderCapture(scene.truth, 0, 0, { ambient: 0.0 }));
  const bright = decodeCapture(renderCapture(scene.truth, 0, 0, { ambient: 0.12 }));
  const map = new Map<string, number>();
  for (const c of dark.correspondences) map.set(`${c.camU},${c.camV}`, c.projU);
  let compared = 0;
  for (const c of bright.correspondences) {
    const u = map.get(`${c.camU},${c.camV}`);
    if (u === undefined) continue;
    compared++;
    assert.ok(Math.abs(c.projU - u) < 1e-9, 'ambient must cancel exactly');
  }
  assert.ok(compared > 100);
});

test('decoding a single colour channel agrees with luminance on a neutral capture', () => {
  const scene = makeScene(19, SMALL);
  const capture = renderCapture(scene.truth, 0, 0);
  const lum = decodeCapture(capture, { channel: 'luminance' });
  // The synthetic capture is single-channel, so a channel request falls back to
  // the same plane. The point of the test is that the option is wired up and
  // does not silently read past the end of a one-channel buffer.
  const red = decodeCapture(capture, { channel: 'r' });
  assert.equal(lum.correspondences.length, red.correspondences.length);
});

test('decimation is deterministic and spatially uniform', () => {
  const scene = makeScene(20, SMALL);
  const capture = renderCapture(scene.truth, 0, 0);
  const a = decodeCapture(capture, { maxCorrespondences: 50 });
  const b = decodeCapture(capture, { maxCorrespondences: 50 });
  assert.equal(a.correspondences.length, 50);
  assert.deepEqual(a.correspondences, b.correspondences);
  // A uniform stride keeps the spread of camera rows; a random subset would clump.
  const rows = a.correspondences.map((c) => c.camV);
  assert.ok(Math.max(...rows) - Math.min(...rows) > 20);
});

test('the phase estimator is unbiased on a clean synthetic sinusoid', () => {
  // A direct check of the estimator itself, with no geometry in the way: one
  // pixel, a single fringe spanning the whole raster so the fringe order is
  // necessarily zero, and a known sub-pixel position to read back.
  const steps = 4;
  const res = 64;
  for (const s of [0.0, 3.7, 11.9, 23.4, 63.5]) {
    const frames: LinearImage[] = [];
    for (let n = 0; n < steps; n++) {
      const value =
        0.5 + 0.5 * Math.cos((2 * Math.PI * s) / res - (2 * Math.PI * n) / steps);
      frames.push({ width: 1, height: 1, channels: 1, data: Float64Array.of(value) });
    }
    const capture: PatternCapture = {
      camera: 0,
      projector: 0,
      projectorRes: { x: res, y: res },
      white: { width: 1, height: 1, channels: 1, data: Float64Array.of(1) },
      black: { width: 1, height: 1, channels: 1, data: Float64Array.of(0) },
      gray: [],
      phase: [
        { axis: 'u', steps, periodPx: res, frames },
        { axis: 'v', steps, periodPx: res, frames },
      ],
    };
    const decoded = decodeCapture(capture, {
      ...DEFAULT_DECODE_OPTIONS,
      minModulation: 0.1,
    });
    assert.equal(decoded.correspondences.length, 1, `phase ${s}`);
    assert.ok(
      Math.abs(decoded.correspondences[0].projU - s) < 1e-9,
      `phase ${s} decoded as ${decoded.correspondences[0].projU}`,
    );
  }
});
