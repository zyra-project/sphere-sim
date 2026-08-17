import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { prepareRig } from '../../sim/src/optics.ts';
import { renderTwoRigRoomView } from '../../sim/src/misregistration.ts';
import { BOULDER_PRESET, PERFECT_PRESET } from '../src/settings.ts';
import { buildViewer, buildWorld } from '../src/rigs.ts';
import {
  BOUNDARY_LIT_ALLOWANCE,
  DISPLAY_TOLERANCE,
  MIN_LIT_PIXELS,
  PARITY_HEIGHT,
  PARITY_WIDTH,
  VERDICT_PERCENTILE,
  compareImages,
  judgeParity,
} from '../src/parity.ts';

/** The three framings the allowance was measured at. See `src/parity.ts`. */
const FRAMINGS = [
  { name: 'a seam close-up', viewRangeM: 2.6, viewFovDeg: 34, viewElDeg: 0 },
  { name: 'standing at it', viewRangeM: 6.2, viewFovDeg: 50, viewElDeg: 12 },
  { name: 'the whole room', viewRangeM: 10.2, viewFovDeg: 71, viewElDeg: 14.4 },
] as const;

function cpuRender(settings = BOULDER_PRESET, w = PARITY_WIDTH, h = PARITY_HEIGHT) {
  const world = buildWorld(settings);
  return renderTwoRigRoomView(
    prepareRig(world.truthRig),
    prepareRig(world.compositorRig),
    world.scene,
    buildViewer(settings, w, h),
    { samplesPerPixel: 1 },
  );
}

test('an image compared against itself is exactly zero', () => {
  const img = cpuRender();
  const d = compareImages(img, img, DISPLAY_TOLERANCE);
  assert.equal(d.maxAbs, 0);
  assert.equal(d.verdictPercentileValue, 0);
  assert.equal(d.pixelsOverTolerance, 0);
});

test('comparing different rasters is refused rather than resampled', () => {
  const a = cpuRender(BOULDER_PRESET, 48, 36);
  const b = cpuRender(BOULDER_PRESET, 32, 24);
  assert.throws(() => compareImages(a, b, DISPLAY_TOLERANCE), /identical rasters/);
});

test('the two-rig renderer really does show misregistration', () => {
  // If it did not, the parity check would be comparing two renderers that both
  // ignore the thing this page exists to display, and it would pass forever.
  const misaligned = cpuRender(BOULDER_PRESET);
  const perfect = cpuRender(PERFECT_PRESET);
  const d = compareImages(misaligned, perfect, DISPLAY_TOLERANCE);
  assert.ok(
    d.maxAbs > 0.05,
    `a 1x mount error must be visible in the picture; worst pixel differed by ${d.maxAbs}`,
  );
});

test('the boundary allowance is what the measurement says, and it is measured against LIT pixels', () => {
  // Nudge the camera by a hundredth of a degree: only pixels straddling a
  // discontinuity — the limb, a coverage edge, the mask edge — can change by more
  // than the tolerance, so the fraction that does IS the boundary fraction.
  //
  // The point of this test is the DENOMINATOR. Against the whole frame the same
  // renderers disagreeing by the same amount give answers two orders of magnitude
  // apart depending on how much of the window the sphere fills. Against the lit
  // pixels the answer is flat, which is what makes one allowance mean one thing.
  const wholeFrame: number[] = [];
  const ofLit: number[] = [];
  for (const framing of FRAMINGS) {
    for (const [w, h] of [
      [PARITY_WIDTH, PARITY_HEIGHT],
      [PARITY_WIDTH * 2, PARITY_HEIGHT * 2],
    ] as const) {
      const settings = { ...BOULDER_PRESET, ...framing };
      const base = cpuRender(settings, w, h);
      const nudged = cpuRender({ ...settings, viewAzDeg: settings.viewAzDeg + 0.02 }, w, h);
      const d = compareImages(base, nudged, DISPLAY_TOLERANCE);
      wholeFrame.push(d.fractionOverTolerance);
      ofLit.push(d.fractionOfLitOverTolerance);
      assert.ok(
        d.fractionOfLitOverTolerance < BOUNDARY_LIT_ALLOWANCE,
        `at ${framing.name} ${w}x${h} the boundary is ` +
          `${(d.fractionOfLitOverTolerance * 100).toFixed(1)}% of lit pixels, at or above the ` +
          `${(BOUNDARY_LIT_ALLOWANCE * 100).toFixed(0)}% allowance — the check would fail on edge noise`,
      );
      assert.ok(
        d.fractionOfLitOverTolerance > BOUNDARY_LIT_ALLOWANCE / 5,
        `at ${framing.name} ${w}x${h} the boundary is only ` +
          `${(d.fractionOfLitOverTolerance * 100).toFixed(2)}% of lit pixels, so the allowance is ` +
          `more than five times what is needed and is not measuring anything`,
      );
    }
  }

  // The spread that justifies the choice, pinned so a later edit cannot quietly
  // undo it. Whole-frame varies by more than 50x; of-lit by less than 1.5x.
  const spread = (v: number[]): number => Math.max(...v) / Math.min(...v);
  assert.ok(
    spread(wholeFrame) > 20,
    `the whole-frame boundary fraction should swing wildly with framing; it spread only ` +
      `${spread(wholeFrame).toFixed(1)}x, so this test is no longer measuring what it claims`,
  );
  assert.ok(
    spread(ofLit) < 2,
    `the of-lit boundary fraction must be framing-independent; it spread ${spread(ofLit).toFixed(2)}x`,
  );
});

test('a full misalignment fails the verdict at every framing, which is what the lit denominator buys', () => {
  // The calibration that matters, and the reason the denominator changed. Against
  // the whole frame, a COMPLETE 1x mount error moves 4.65% of pixels standing at
  // the sphere and 0.70% from across the room — so a 1%-of-frame allowance passed
  // a rig in pieces at any wide view. Against lit pixels it moves 41-49%
  // everywhere and fails everywhere.
  for (const framing of FRAMINGS) {
    const a = cpuRender({ ...BOULDER_PRESET, ...framing });
    const b = cpuRender({ ...PERFECT_PRESET, ...framing });
    const verdict = judgeParity(a, b, { floatReadback: true });
    assert.equal(verdict.pass, false, `${framing.name}: ${verdict.summary}`);
    assert.equal(verdict.blind, false, `${framing.name}: the patch should have enough lit pixels`);
    assert.ok(/p88|allowance/.test(verdict.reason), `unhelpful reason: '${verdict.reason}'`);
    assert.ok(verdict.summary.includes('DISAGREE'));

    const d = compareImages(a, b, DISPLAY_TOLERANCE);
    assert.ok(
      d.fractionOfLitOverTolerance > 0.3,
      `${framing.name}: a full mount error moved only ` +
        `${(d.fractionOfLitOverTolerance * 100).toFixed(1)}% of lit pixels`,
    );
  }
});

test('a patch with almost nothing lit is reported blind rather than passing', () => {
  // A green tick earned by a frame full of matching black is worse than no tick.
  const img = cpuRender();
  const dark = { width: img.width, height: img.height, data: new Float32Array(img.data.length) };
  const verdict = judgeParity(dark, { ...img, data: new Float32Array(img.data.length) } as typeof img, {
    floatReadback: true,
  });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.blind, true);
  assert.ok(verdict.summary.includes('Too little'));
  assert.ok(MIN_LIT_PIXELS > 0);
});

test('a difference spread over the whole image fails on the percentile, not the count', () => {
  // What the check is actually FOR: a term dropped from the shader, a sign
  // flipped, the wrong rig read. Those light up the interior rather than an
  // outline — here, a room lit differently — and they fail on the percentile
  // even before the pixel count is consulted.
  const a = cpuRender(BOULDER_PRESET);
  const brighter = { ...a, data: Float32Array.from(a.data, (v) => v * 1.05) };
  const verdict = judgeParity(a, brighter, { floatReadback: true });
  assert.equal(verdict.pass, false);
  // Derived from the constant rather than spelled, so moving the allowance moves
  // the label and this assertion together instead of pinning a stale number.
  const label = `p${(VERDICT_PERCENTILE * 100).toFixed(0)}`;
  assert.ok(
    verdict.reason.startsWith(label),
    `expected the percentile to bind first: '${verdict.reason}'`,
  );
});

/** Spoil a fraction of the pixels that are lit, leaving the dark ones alone. */
function spoilLit(img: ReturnType<typeof cpuRender>, fraction: number) {
  const out = { ...img, data: Float32Array.from(img.data) };
  const litIndices: number[] = [];
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[3 * i] > 2e-3 || img.data[3 * i + 1] > 2e-3 || img.data[3 * i + 2] > 2e-3) {
      litIndices.push(i);
    }
  }
  const spoil = Math.floor(litIndices.length * fraction);
  for (let k = 0; k < spoil; k++) out.data[3 * litIndices[k]] = 1;
  return { image: out, spoil, lit: litIndices.length };
}

test('a handful of full-amplitude edge pixels does not fail the verdict', () => {
  // The construction the module note argues for: at the limb, at a coverage edge
  // and at the raster edge, one ULP flips a hit into a miss and produces a
  // full-amplitude delta. A max-only verdict would fail at random as the viewer
  // orbits, so the verdict is a percentile with a separate, bounded allowance
  // for boundary pixels.
  const img = cpuRender();
  const { image, spoil } = spoilLit(img, BOUNDARY_LIT_ALLOWANCE * 0.5);
  const verdict = judgeParity(img, image, { floatReadback: true });
  assert.ok(spoil > 0, 'the fixture must actually spoil some pixels');
  assert.equal(verdict.pass, true, verdict.reason);
  assert.ok(verdict.delta.maxAbs > 0.1, 'and they really were full amplitude');
});

test('spoiling more than the allowance does fail', () => {
  const img = cpuRender();
  const { image } = spoilLit(img, BOUNDARY_LIT_ALLOWANCE * 2);
  const verdict = judgeParity(img, image, { floatReadback: true });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reason.includes('allowance'));
});

test('an 8-bit read-back widens the tolerance and says so', () => {
  const img = cpuRender();
  const verdict = judgeParity(img, img, { floatReadback: false });
  assert.equal(verdict.tolerance, 1 / 255);
  assert.ok(verdict.summary.includes('8-bit'));
});

test('the parity raster is small enough to render inside a frame budget', () => {
  const started = Date.now();
  const img = cpuRender(BOULDER_PRESET);
  const ms = Date.now() - started;
  assert.equal(img.width * img.height, PARITY_WIDTH * PARITY_HEIGHT);
  // Generous: this runs in a worker beside the metrics, not on the main thread.
  // The bound exists so a later change that made the patch a megapixel fails
  // here rather than as a page that stops responding.
  assert.ok(ms < 4000, `the parity render took ${ms} ms, which is too slow to run on a settle`);
});
