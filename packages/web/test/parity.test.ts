// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { ChannelTriplet, SurfaceMesh } from '../../calibration/src/index.ts';
import { meshSurface } from '../../sim/src/mesh/surface.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import type { Surface } from '../../sim/src/surface.ts';
import { renderTwoRigRoomView } from '../../sim/src/misregistration.ts';
import { BOULDER_PRESET, IN_TO_M, PERFECT_PRESET } from '../src/settings.ts';
import { buildViewer, buildWorld } from '../src/rigs.ts';
import {
  BOUNDARY_LIT_ALLOWANCE,
  DISPLAY_TOLERANCE,
  LIT_THRESHOLD,
  MIN_LIT_PIXELS,
  PARITY_HEIGHT,
  PARITY_WIDTH,
  VERDICT_PERCENTILE,
  NO_AMBIENT,
  ambientFloorOf,
  compareImages,
  judgeParity,
} from '../src/parity.ts';

/** The three framings the allowance was measured at. See `src/parity.ts`. */
const FRAMINGS = [
  { name: 'a seam close-up', viewRangeM: 2.6, viewFovDeg: 34, viewElDeg: 0 },
  { name: 'standing at it', viewRangeM: 6.2, viewFovDeg: 50, viewElDeg: 12 },
  { name: 'the whole room', viewRangeM: 10.2, viewFovDeg: 71, viewElDeg: 14.4 },
] as const;

function cpuRender(settings = BOULDER_PRESET, w = PARITY_WIDTH, h = PARITY_HEIGHT, surface?: Surface) {
  const world = buildWorld(settings);
  return renderTwoRigRoomView(
    // The SAME surface object to both, which is what the display path requires
    // and what one physical surface means.
    prepareRig(world.truthRig, surface),
    prepareRig(world.compositorRig, surface),
    world.scene,
    buildViewer(settings, w, h),
    { samplesPerPixel: 1 },
  );
}

/**
 * The ambient floor of the scene every render below is of.
 *
 * One constant rather than one per test because `BOULDER_PRESET` and
 * `PERFECT_PRESET` carry the same ambient, reflectance and room albedo -- checked,
 * not assumed -- so a comparison between renders of the two has one floor.
 */
const SCENE_FLOOR = (() => {
  const w = buildWorld(BOULDER_PRESET);
  const p = buildWorld(PERFECT_PRESET);
  assert.deepEqual(w.scene.ambient, p.scene.ambient, 'the presets must share an ambient');
  assert.deepEqual(w.scene.reflectance, p.scene.reflectance);
  assert.equal(w.scene.roomAlbedo, p.scene.roomAlbedo);
  return ambientFloorOf(w.scene.ambient, w.scene.reflectance, w.scene.roomAlbedo);
})();

test('an image compared against itself is exactly zero', () => {
  const img = cpuRender();
  const d = compareImages(img, img, DISPLAY_TOLERANCE, SCENE_FLOOR);
  assert.equal(d.maxAbs, 0);
  assert.equal(d.verdictPercentileValue, 0);
  assert.equal(d.pixelsOverTolerance, 0);
});

test('comparing different rasters is refused rather than resampled', () => {
  const a = cpuRender(BOULDER_PRESET, 48, 36);
  const b = cpuRender(BOULDER_PRESET, 32, 24);
  assert.throws(() => compareImages(a, b, DISPLAY_TOLERANCE, SCENE_FLOOR), /identical rasters/);
});

test('the two-rig renderer really does show misregistration', () => {
  // If it did not, the parity check would be comparing two renderers that both
  // ignore the thing this page exists to display, and it would pass forever.
  const misaligned = cpuRender(BOULDER_PRESET);
  const perfect = cpuRender(PERFECT_PRESET);
  const d = compareImages(misaligned, perfect, DISPLAY_TOLERANCE, SCENE_FLOOR);
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
      const d = compareImages(base, nudged, DISPLAY_TOLERANCE, SCENE_FLOOR);
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
    const verdict = judgeParity(a, b, { ambientFloor: SCENE_FLOOR, floatReadback: true });
    assert.equal(verdict.pass, false, `${framing.name}: ${verdict.summary}`);
    assert.equal(verdict.blind, false, `${framing.name}: the patch should have enough lit pixels`);
    assert.ok(/p88|allowance/.test(verdict.reason), `unhelpful reason: '${verdict.reason}'`);
    assert.ok(verdict.summary.includes('DISAGREE'));

    const d = compareImages(a, b, DISPLAY_TOLERANCE, SCENE_FLOOR);
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
    ambientFloor: SCENE_FLOOR,
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
  const verdict = judgeParity(a, brighter, { ambientFloor: SCENE_FLOOR, floatReadback: true });
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
  // The verdict's OWN definition of lit, floor included. A literal 2e-3 here
  // would select the pixels the surface covers while the verdict counted the
  // pixels a projector reaches, and then "spoil half the allowance" would spoil
  // some other fraction of some other set.
  const bar = [
    SCENE_FLOOR.r + LIT_THRESHOLD,
    SCENE_FLOOR.g + LIT_THRESHOLD,
    SCENE_FLOOR.b + LIT_THRESHOLD,
  ];
  const litIndices: number[] = [];
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[3 * i] > bar[0] || img.data[3 * i + 1] > bar[1] || img.data[3 * i + 2] > bar[2]) {
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
  const verdict = judgeParity(img, image, { ambientFloor: SCENE_FLOOR, floatReadback: true });
  assert.ok(spoil > 0, 'the fixture must actually spoil some pixels');
  assert.equal(verdict.pass, true, verdict.reason);
  assert.ok(verdict.delta.maxAbs > 0.1, 'and they really were full amplitude');
});

test('spoiling more than the allowance does fail', () => {
  const img = cpuRender();
  const { image } = spoilLit(img, BOUNDARY_LIT_ALLOWANCE * 2);
  const verdict = judgeParity(img, image, { ambientFloor: SCENE_FLOOR, floatReadback: true });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reason.includes('allowance'));
});

/**
 * Two panels a hair apart, wound so both face +x.
 *
 * `packages/harness`'s `twoPlates` idiom at a fortieth of its separation, built
 * here rather than imported so `packages/web`'s tests do not reach into the
 * harness for geometry. The gap is the point: the projectors ring a sphere, so
 * almost none of this reaches a lens, and almost every pixel of it is ambient.
 */
function tightPlates(halfSizeM: number, sepFrac: number): SurfaceMesh {
  const s = halfSizeM;
  const h = s * sepFrac;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const x of [h, -h]) {
    const base = positions.length / 3;
    positions.push(x, -s, -s, x, s, -s, x, s, s, x, -s, s);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'tight plates',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: Float32Array.from(uvs),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

test('a rig in pieces cannot pass by filling the denominator with ambient-only pixels', () => {
  // The failure this floor exists for, and it is not hypothetical: with the floor
  // at zero a COMPLETE 1x mount error passes here, because 96% of what the old
  // denominator called "lit" is pixels no projector reaches. Ambient is additive
  // and rig-independent, so those pixels cancel exactly in every difference --
  // they can never enter the numerator and only ever dilute the denominator.
  //
  // Measured at the seam framing, azimuth +135: 2400 lit pixels at 3.58% over
  // tolerance and a PASS, against 86 lit pixels at 100.00% and a fail. Of the
  // pixels a lens actually reaches, every single one disagrees.
  const radiusM = (BOULDER_PRESET.sphereDiaIn * IN_TO_M) / 2;
  const surface = meshSurface(tightPlates(radiusM * 0.35, 0.05));
  const framing = { viewRangeM: 2.6, viewFovDeg: 34, viewElDeg: 0 };
  const misaligned = cpuRender(
    { ...BOULDER_PRESET, ...framing, viewAzDeg: BOULDER_PRESET.viewAzDeg + 135 },
    PARITY_WIDTH,
    PARITY_HEIGHT,
    surface,
  );
  const aligned = cpuRender(
    { ...PERFECT_PRESET, ...framing, viewAzDeg: PERFECT_PRESET.viewAzDeg + 135 },
    PARITY_WIDTH,
    PARITY_HEIGHT,
    surface,
  );

  const withoutFloor = judgeParity(misaligned, aligned, {
    ambientFloor: NO_AMBIENT,
    floatReadback: true,
  });
  const withFloor = judgeParity(misaligned, aligned, {
    ambientFloor: SCENE_FLOOR,
    floatReadback: true,
  });

  // The bug, asserted so this test cannot quietly stop demonstrating anything.
  assert.equal(withoutFloor.pass, true, 'the fixture must still reproduce the old failure');
  assert.equal(withoutFloor.blind, false);

  // And the fix.
  assert.equal(withFloor.pass, false, `a full mount error must not pass: ${withFloor.summary}`);
  assert.ok(
    withFloor.delta.litPixelCount < withoutFloor.delta.litPixelCount / 10,
    `the floor must remove the ambient-only bulk: ${withoutFloor.delta.litPixelCount} -> ` +
      `${withFloor.delta.litPixelCount}`,
  );
  assert.ok(
    withFloor.delta.fractionOfLitOverTolerance > 0.9,
    `of the pixels a lens reaches, nearly all must disagree; ` +
      `${(withFloor.delta.fractionOfLitOverTolerance * 100).toFixed(1)}%`,
  );
});

/** The pixel indices a comparison would count as lit, at a given floor. */
function litSet(img: ReturnType<typeof cpuRender>, floor: ChannelTriplet): Set<number> {
  const bar = [floor.r + LIT_THRESHOLD, floor.g + LIT_THRESHOLD, floor.b + LIT_THRESHOLD];
  const out = new Set<number>();
  for (let i = 0; i < img.width * img.height; i++) {
    for (let c = 0; c < 3; c++) {
      if (img.data[3 * i + c] > bar[c]) {
        out.add(i);
        break;
      }
    }
  }
  return out;
}

test('the floored denominator is exactly the set of pixels a projector reaches', () => {
  // The property the floor claims, checked against ground truth rather than
  // against a tolerance. Render the same scene with `ambient: 0` and a lit pixel
  // is a projector-lit pixel BY CONSTRUCTION -- there is no other source of light
  // in it. The floored denominator must be that set.
  //
  // Measured: exact equality at all three framings, 0 pixels in either symmetric
  // difference -- 12116, 1123 and 170 pixels. Not a bound, an identity, which is
  // what makes `ambient x reflectance` the right floor rather than merely a
  // conservative one.
  //
  // It is also the check that would notice `lambertianShading` gaining a term
  // that ambient no longer factors out of, which would make the arithmetic in
  // {@link ambientFloorOf} wrong without changing anything it can see locally.
  for (const framing of FRAMINGS) {
    const settings = { ...BOULDER_PRESET, ...framing };
    const world = buildWorld(settings);
    const floor = ambientFloorOf(world.scene.ambient, world.scene.reflectance, world.scene.roomAlbedo);

    const floored = litSet(cpuRender(settings), floor);
    const truth = litSet(cpuRender({ ...settings, ambient: 0 }), NO_AMBIENT);

    const extra = [...floored].filter((i) => !truth.has(i));
    const missing = [...truth].filter((i) => !floored.has(i));
    assert.equal(
      extra.length,
      0,
      `${framing.name}: ${extra.length} pixels counted lit that no projector reaches`,
    );
    assert.equal(
      missing.length,
      0,
      `${framing.name}: ${missing.length} projector-lit pixels dropped from the denominator`,
    );
    assert.ok(truth.size > MIN_LIT_PIXELS, `${framing.name}: the fixture must have something lit`);

    // And the floor is doing work: without it the sphere's own limb is counted.
    const unfloored = litSet(cpuRender(settings), NO_AMBIENT);
    assert.ok(unfloored.size >= floored.size, 'a floor cannot add pixels to the denominator');

    // Through the REAL function and not only the rule above. `litSet` is a second
    // copy of what counts as lit, and a second copy is a place to drift from the
    // one the verdict actually uses; this pins them together.
    const img = cpuRender(settings);
    assert.equal(
      compareImages(img, img, DISPLAY_TOLERANCE, floor).litPixelCount,
      truth.size,
      `${framing.name}: compareImages does not count the projector-lit set`,
    );
  }
});

test('an 8-bit read-back widens the tolerance and says so', () => {
  const img = cpuRender();
  const verdict = judgeParity(img, img, { ambientFloor: SCENE_FLOOR, floatReadback: false });
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
