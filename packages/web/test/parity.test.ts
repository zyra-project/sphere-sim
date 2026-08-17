import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { prepareRig } from '../../sim/src/optics.ts';
import { renderTwoRigRoomView } from '../../sim/src/misregistration.ts';
import { BOULDER_PRESET, PERFECT_PRESET } from '../src/settings.ts';
import { buildViewer, buildWorld } from '../src/rigs.ts';
import {
  BOUNDARY_PIXEL_ALLOWANCE,
  DISPLAY_TOLERANCE,
  PARITY_HEIGHT,
  PARITY_WIDTH,
  compareImages,
  judgeParity,
} from '../src/parity.ts';

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

test('the boundary allowance is what the measurement says, not what perimeter reasoning said', () => {
  // The measurement `parity.ts` cites. Nudge the camera by a hundredth of a
  // degree: only pixels straddling a discontinuity — the limb, a coverage edge,
  // the mask edge, the floor disc — can change by more than the tolerance, so
  // the fraction that does IS the boundary fraction.
  //
  // It comes out at a few tenths of a percent, and it barely moves with raster
  // size, because the count scales with perimeter while the total scales with
  // area. The allowance must sit above it with room to spare and nowhere near
  // the 1.7% a real misalignment produces.
  for (const [w, h] of [
    [PARITY_WIDTH, PARITY_HEIGHT],
    [PARITY_WIDTH * 2, PARITY_HEIGHT * 2],
  ] as const) {
    const base = cpuRender(BOULDER_PRESET, w, h);
    const nudged = cpuRender({ ...BOULDER_PRESET, viewAzDeg: BOULDER_PRESET.viewAzDeg + 0.02 }, w, h);
    const d = compareImages(base, nudged, DISPLAY_TOLERANCE);
    assert.ok(
      d.fractionOverTolerance < BOUNDARY_PIXEL_ALLOWANCE,
      `at ${w}x${h} the boundary fraction is ${(d.fractionOverTolerance * 100).toFixed(2)}%, ` +
        `at or above the ${(BOUNDARY_PIXEL_ALLOWANCE * 100).toFixed(0)}% allowance — the check ` +
        `would fail on edge noise`,
    );
    assert.ok(
      d.fractionOverTolerance > BOUNDARY_PIXEL_ALLOWANCE / 5,
      `at ${w}x${h} the boundary fraction is ${(d.fractionOverTolerance * 100).toFixed(3)}%, ` +
        `so the allowance is more than five times what is needed and is not measuring anything`,
    );
  }
});

test('a difference the size of a full misalignment does fail the verdict', () => {
  // The calibration that matters. At a 2% allowance this passed — a complete 1x
  // mount error moves only 1.7% of pixels past tolerance, because the signal is
  // thin grid lines rather than a wash — and the check could not have failed for
  // a difference the size of the whole problem. At the measured 1% it fails.
  const a = cpuRender(BOULDER_PRESET);
  const b = cpuRender(PERFECT_PRESET);
  const verdict = judgeParity(a, b, { floatReadback: true });
  assert.equal(verdict.pass, false, verdict.summary);
  assert.ok(/p99|allowance/.test(verdict.reason), `unhelpful reason: '${verdict.reason}'`);
  assert.ok(verdict.summary.includes('DISAGREE'));
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
  assert.ok(verdict.reason.startsWith('p99'), `expected the percentile to bind: '${verdict.reason}'`);
});

test('a handful of full-amplitude edge pixels does not fail the verdict', () => {
  // The construction the module note argues for: at the limb, at a coverage edge
  // and at the raster edge, one ULP flips a hit into a miss and produces a
  // full-amplitude delta. A max-only verdict would fail at random as the viewer
  // orbits, so the verdict is a percentile with a separate, bounded allowance
  // for boundary pixels.
  const img = cpuRender();
  const nudged = { ...img, data: Float32Array.from(img.data) };
  const n = img.width * img.height;
  const spoil = Math.floor(n * (BOUNDARY_PIXEL_ALLOWANCE * 0.5));
  for (let i = 0; i < spoil; i++) nudged.data[3 * i] = 1;

  const verdict = judgeParity(img, nudged, { floatReadback: true });
  assert.ok(spoil > 0, 'the fixture must actually spoil some pixels');
  assert.equal(verdict.pass, true, verdict.reason);
  assert.ok(verdict.delta.maxAbs > 0.1, 'and they really were full amplitude');
});

test('spoiling more than the allowance does fail', () => {
  const img = cpuRender();
  const nudged = { ...img, data: Float32Array.from(img.data) };
  const n = img.width * img.height;
  for (let i = 0; i < Math.ceil(n * (BOUNDARY_PIXEL_ALLOWANCE * 2)); i++) nudged.data[3 * i] = 1;
  const verdict = judgeParity(img, nudged, { floatReadback: true });
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
