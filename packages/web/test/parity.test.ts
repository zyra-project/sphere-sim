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
  ALLOWANCE_LABEL,
  BOUNDARY_LIT_ALLOWANCE,
  DISPLAY_TOLERANCE,
  LIT_THRESHOLD,
  MIN_LIT_PIXELS,
  PARITY_HEIGHT,
  PARITY_WIDTH,
  VERDICT_PERCENTILE,
  VERDICT_PERCENTILE_LABEL,
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

test('the of-lit denominator is framing-independent and the whole-frame one is not', () => {
  // Nudge the camera by a hundredth of a degree and see how the fraction that
  // moves behaves as the framing changes.
  //
  // This test used to compare that fraction against BOUNDARY_LIT_ALLOWANCE, on the
  // reasoning that "only pixels straddling a discontinuity can change by more than
  // the tolerance, so the fraction that does IS the boundary fraction". Measured
  // against a real driver, both halves of that are false: most movers here are
  // smooth-gradient pixels, and the real boundary population is EMPTY -- 0 of
  // 10 298 lit pixels. A 0.02-degree nudge displaces the surface by about 0.28 mm
  // where float32 displaces it by about 5e-8 m, so it overstates the population it
  // stood in for by three orders of magnitude. The allowance is sized against the
  // driver now; see `src/parity.ts`.
  //
  // What the nudge is still good for is this test's actual subject, which its own
  // body always was:
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
    // Derived, not spelled. This read /p88|allowance/ while the label was p94, so
    // it could only ever match on the word 'allowance' -- it had stopped testing the
    // percentile arm entirely and went on passing.
    assert.ok(
      verdict.reason.includes(VERDICT_PERCENTILE_LABEL) || verdict.reason.includes('allowance'),
      `unhelpful reason: '${verdict.reason}'`,
    );
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
  const label = VERDICT_PERCENTILE_LABEL;
  assert.ok(
    verdict.reason.startsWith(label),
    `expected the percentile to bind first: '${verdict.reason}'`,
  );
});

/**
 * A framing whose patch is big enough to express the allowance at all.
 *
 * `BOULDER_PRESET`'s own view is the widest one, and it carries 170 lit pixels --
 * so `0.002 x 170 = 0.34` spoils ZERO pixels and a fraction near the allowance
 * cannot be built there. That is not a fixture problem, it is the constant's
 * documented consequence at small patches, pinned by its own test below. The
 * spoil-based tests use the seam close-up's 12 116 lit pixels instead.
 */
const SPOILABLE = { viewRangeM: 2.6, viewFovDeg: 34, viewElDeg: 0 } as const;

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
  const img = cpuRender({ ...BOULDER_PRESET, ...SPOILABLE });
  const { image, spoil } = spoilLit(img, BOUNDARY_LIT_ALLOWANCE * 0.5);
  const verdict = judgeParity(img, image, { ambientFloor: SCENE_FLOOR, floatReadback: true });
  assert.ok(spoil > 0, 'the fixture must actually spoil some pixels');
  assert.equal(verdict.pass, true, verdict.reason);
  assert.ok(verdict.delta.maxAbs > 0.1, 'and they really were full amplitude');
});

test('spoiling more than the allowance does fail', () => {
  const img = cpuRender({ ...BOULDER_PRESET, ...SPOILABLE });
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

  // The bug, asserted so this test cannot quietly stop demonstrating anything --
  // and asserted on the FRACTION rather than on pass/fail, because pass/fail also
  // moves with BOUNDARY_LIT_ALLOWANCE and this test is about the denominator. At
  // the 6% allowance in force when this was found, 3.58% passed outright.
  assert.equal(withoutFloor.blind, false);
  assert.ok(
    withoutFloor.delta.fractionOfLitOverTolerance < 0.06,
    `undiluted, a complete mount error must look benign here: ` +
      `${(withoutFloor.delta.fractionOfLitOverTolerance * 100).toFixed(2)}% is not under the 6% ` +
      `allowance this fixture was built to slip past`,
  );

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

test('the allowance can see the one real GPU bug this check has found', () => {
  // The self-shadow acne of `packages/sim/src/mesh/bvh.ts`, which this check
  // found. Measured against the real driver on the room track -- the view
  // geometry the app's own parity patch is -- it moves 1.187% of lit pixels on a
  // tessellated sphere and 2.198% on two plates, with the worst pixel 193x the
  // tolerance.
  //
  // At the allowance this replaced, 0.06, BOTH passed, and the verdict printed
  // "The picture and the model agree". A defect touching 1.187% of pixels hides
  // entirely inside the 6% a p94 percentile discards, however wrong those pixels
  // are. That is the failure this number was changed to fix, and this is the
  // assertion that would notice it coming back.
  const img = cpuRender({ ...BOULDER_PRESET, ...SPOILABLE });
  for (const [what, fraction] of [
    ['a tessellated sphere', 0.01187],
    ['two plates', 0.02198],
  ] as const) {
    const { image, spoil, lit } = spoilLit(img, fraction);
    assert.ok(spoil > 0, `${what}: the fixture must actually spoil pixels of ${lit} lit`);
    const verdict = judgeParity(img, image, {
      ambientFloor: SCENE_FLOOR,
      floatReadback: true,
    });
    assert.equal(
      verdict.pass,
      false,
      `${what}: a defect over ${(fraction * 100).toFixed(3)}% of lit pixels must not pass ` +
        `-- ${verdict.summary}`,
    );
  }

  // And the bracket on the other side, so this pins the constant rather than
  // merely bounding it: a defect an order of magnitude under the allowance passes.
  const { image } = spoilLit(img, BOUNDARY_LIT_ALLOWANCE / 10);
  assert.equal(
    judgeParity(img, image, { ambientFloor: SCENE_FLOOR, floatReadback: true }).pass,
    true,
  );
});

test('at the widest view the shed rounds to zero, which is deliberate', () => {
  // The consequence recorded in BOUNDARY_LIT_ALLOWANCE's docblock, pinned here so
  // it is a decision rather than a surprise. The shed is a FRACTION, so it scales
  // with the patch: 24 pixels at the seam close-up's 12 116 lit, and 0.34 -- which
  // floors to zero -- at the 170 the app's opening view carries. One stray
  // full-amplitude pixel therefore fails the check there.
  //
  // Measured against the real driver that never happens: 0 strays in 10 298 lit
  // pixels. If a hardware GPU turns out to produce them, the answer named in the
  // docblock is an absolute floor on the shed, not a larger fraction -- and this
  // test is where that change would announce itself.
  const wide = cpuRender();
  const lit = compareImages(wide, wide, DISPLAY_TOLERANCE, SCENE_FLOOR).litPixelCount;
  assert.ok(lit < 1 / BOUNDARY_LIT_ALLOWANCE, `the opening view carries ${lit} lit pixels`);

  const one = { ...wide, data: Float32Array.from(wide.data) };
  for (let i = 0; i < wide.width * wide.height; i++) {
    if (wide.data[3 * i] > SCENE_FLOOR.r + LIT_THRESHOLD) {
      one.data[3 * i] = 1;
      break;
    }
  }
  const verdict = judgeParity(wide, one, { ambientFloor: SCENE_FLOOR, floatReadback: true });
  assert.equal(verdict.pass, false, 'one stray pixel must fail at a patch this small');
  assert.equal(verdict.blind, false, `${lit} lit pixels is above MIN_LIT_PIXELS`);
});

test('the printed labels say the number they claim to say', () => {
  // Deriving the expected label from the same constant makes an assertion that
  // cannot fail: the message and the expectation move together and agree with each
  // other however wrong both are. `(0.998 * 100).toFixed(0)` is '100', so a
  // verdict would have offered "p100 of the lit pixels" and every test comparing
  // it against its own copy of that expression would have passed.
  //
  // So parse the label back and check it against the constant it describes.
  assert.match(VERDICT_PERCENTILE_LABEL, /^p[\d.]+$/);
  assert.ok(
    Math.abs(Number(VERDICT_PERCENTILE_LABEL.slice(1)) / 100 - VERDICT_PERCENTILE) < 1e-9,
    `${VERDICT_PERCENTILE_LABEL} does not name ${VERDICT_PERCENTILE}`,
  );
  assert.match(ALLOWANCE_LABEL, /^[\d.]+%$/);
  assert.ok(
    Math.abs(Number(ALLOWANCE_LABEL.slice(0, -1)) / 100 - BOUNDARY_LIT_ALLOWANCE) < 1e-9,
    `${ALLOWANCE_LABEL} does not name ${BOUNDARY_LIT_ALLOWANCE}`,
  );
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
