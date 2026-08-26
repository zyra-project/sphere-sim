// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createImage, sampleEquirect } from '../../sim/src/equirect.ts';
import { aimAtSphereCenter } from '../../sim/src/geometry.ts';
import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import { DEFAULT_MISALIGNMENT } from '../../sim/src/scene.ts';
import { contentAt } from '../../sim/src/render.ts';
import { renderTwoRigRoomView } from '../../sim/src/misregistration.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import {
  BOULDER_PRESET,
  CONTENTS,
  CONTENT_CUSTOM,
  IN_TO_M,
  NUDGE_CONTROLS,
  PERFECT_PRESET,
  SHIFT_PCT_PER_UNIT,
  SPEC_PRESET,
  noNudge,
  withNudge,
} from '../src/settings.ts';
import type { Settings } from '../src/settings.ts';
import {
  buildAsBuilt,
  buildContent,
  buildGraticule,
  buildViewer,
  buildWorld,
  framingRangeM,
  scaledMagnitudes,
  worstAimOffender,
  worstPlacementOffender,
} from '../src/rigs.ts';

test('a rig with no mount error is its own drawing', () => {
  const world = buildWorld(PERFECT_PRESET);
  for (let i = 0; i < world.truthRig.projectors.length; i++) {
    const truth = world.truthRig.projectors[i].pose.position;
    const drawn = world.asBuiltRig.projectors[i].pose.position;
    assert.ok(
      Math.hypot(truth.x - drawn.x, truth.y - drawn.y, truth.z - drawn.z) < 1e-12,
      `projector ${i} moved with mountError 0`,
    );
  }
  assert.equal(world.truthRig.sphere.centerHeightM, world.asBuiltRig.sphere.centerHeightM);
});

test('a perfectly mounted rig scores essentially zero alignment error', () => {
  // The page's own claim, in the mount-error control's help text: "Set it to 0
  // and every alignment metric should read essentially zero, which is a check on
  // the metrics as much as on the rig."
  //
  // "Essentially" is doing real work and this test measures how much. The two
  // rigs are not bit-identical even at mountError 0: `injectMisalignment` rebuilds
  // each position from `atan2`/`hypot` and adds zero, and that round trip moves
  // the last few bits. `registration_error` — a direct texel-to-texel distance —
  // sees that difference and reports it at 1e-10 mm, so the rigs really do agree.
  //
  // `grid_displacement` reads 0.01 mm at the same settings, which is therefore
  // NOT the rig disagreement: it is the grid metric's own floor, from fitting a
  // line to a sampled graticule. Worth knowing, since it is 1% of the 1 mm gate
  // — a solve that reported 0.01 mm would be at the measurement's resolution
  // rather than perfect.
  const world = buildWorld(PERFECT_PRESET);
  const set = computeGeometricMetrics(world.truthRig, world.scene, {
    contentRig: world.compositorRig,
    densityScale: 0.35,
    convergence: false,
  });
  const registration = set.metrics.find((m) => m.id === 'registration_error');
  const grid = set.metrics.find((m) => m.id === 'grid_displacement');
  assert.ok(registration && grid, 'both metrics must exist');
  assert.ok(
    registration.value < 1e-6,
    `a rig that agrees with its own compositor cannot misregister; got ${registration.value} mm`,
  );
  assert.ok(
    grid.value < 0.05,
    `the grid metric's floor should be a percent or so of the 1 mm gate; got ${grid.value} mm`,
  );
});

test('the same seed builds byte-identical rigs, and a different seed does not', () => {
  const a = buildWorld(BOULDER_PRESET);
  const b = buildWorld(BOULDER_PRESET);
  assert.deepEqual(a.truthRig, b.truthRig);

  const other: Settings = { ...BOULDER_PRESET, errorSeed: BOULDER_PRESET.errorSeed + 1 };
  const c = buildWorld(other);
  assert.notDeepEqual(a.truthRig, c.truthRig);
});

test('mount error scales the tolerances rather than replacing them', () => {
  const one = scaledMagnitudes(1);
  assert.deepEqual(one, { ...DEFAULT_MISALIGNMENT });
  const half = scaledMagnitudes(0.5);
  assert.equal(half.azimuthDeg, DEFAULT_MISALIGNMENT.azimuthDeg / 2);
  assert.equal(half.k2, DEFAULT_MISALIGNMENT.k2 / 2);
  // A negative knob is a nonsense input, not a mirrored one.
  assert.equal(scaledMagnitudes(-3).rollDeg, 0);
});

test('doubling the mount error roughly doubles how far the lenses moved', () => {
  const one = buildWorld({ ...BOULDER_PRESET, mountError: 1 });
  const two = buildWorld({ ...BOULDER_PRESET, mountError: 2 });
  const worst = (w: ReturnType<typeof buildWorld>): number =>
    Math.max(...w.perturbation.projectors.map((p) => p.positionErrorM));
  const ratio = worst(two) / worst(one);
  // Close to 2 but not exactly, and the gap is geometry rather than statistics.
  // The distance and height terms are linear in the scale, so those double
  // exactly; the AZIMUTH term moves the lens along an arc, and the chord of a
  // doubled angle is slightly less than twice the chord of the original. At the
  // scale of a degree the difference is a fraction of a percent, which is what
  // this measures. The same deviates are drawn either way — only their
  // magnitudes change — so nothing here is a sampling effect.
  assert.ok(Math.abs(ratio - 2) < 0.02, `expected about 2x, got ${ratio}`);
  assert.notEqual(ratio, 2);
});

test('the panel measures lens rise from the equator, as a site survey does', () => {
  const s: Settings = { ...SPEC_PRESET, lensRiseM: 0.2032, equatorIn: 84 };
  const rig = buildAsBuilt(s);
  for (const p of rig.projectors) {
    // World +Z is up with the origin at the sphere centre, so a lens `rise`
    // above the equator sits at exactly `rise`.
    assert.ok(Math.abs(p.pose.position.z - 0.2032) < 1e-12);
  }
  assert.ok(Math.abs(rig.sphere.centerHeightM - 84 * IN_TO_M) < 1e-12);
});

test('A-36: at Boulder the horizontal and 3-D readings of d_proj differ by ~3.85 mm', () => {
  const rig = buildAsBuilt(BOULDER_PRESET);
  const p = rig.projectors[0];
  const horizontal = Math.hypot(p.pose.position.x, p.pose.position.y);
  const three = Math.hypot(horizontal, p.pose.position.z);
  const deltaMm = (three - horizontal) * 1000;
  assert.ok(
    Math.abs(deltaMm - 3.85) < 0.05,
    `amendment A-36 computes 3.85 mm at this geometry; got ${deltaMm.toFixed(3)}`,
  );
  // And it is nearly twice §7's 2 mm pose gate, which is the whole point of the
  // amendment.
  assert.ok(deltaMm > 2);
});

test('at the spec preset the same ambiguity vanishes, which is why it went unnoticed', () => {
  const rig = buildAsBuilt(SPEC_PRESET);
  const p = rig.projectors[0];
  const horizontal = Math.hypot(p.pose.position.x, p.pose.position.y);
  const three = Math.hypot(horizontal, p.pose.position.z);
  assert.ok((three - horizontal) * 1000 < 1e-9);
});

test('the fewer-projector cases keep the full 2x2 framebuffer', () => {
  for (const count of [2, 3, 4]) {
    const rig = buildAsBuilt({ ...BOULDER_PRESET, projectorCount: count });
    assert.equal(rig.projectors.length, count);
    assert.equal(rig.framebuffer.width, rig.projectors[0].intrinsics.resX * 2);
    assert.equal(rig.framebuffer.height, rig.projectors[0].intrinsics.resY * 2);
  }
});

test('two projectors take opposite slots, not adjacent ones', () => {
  const rig = buildAsBuilt({ ...BOULDER_PRESET, projectorCount: 2 });
  const [a, b] = rig.projectors.map((p) => Math.atan2(p.pose.position.y, p.pose.position.x));
  const separation = Math.abs(((a - b) * 180) / Math.PI);
  assert.ok(Math.abs(separation - 180) < 1e-9, `expected antipodal, got ${separation}°`);
});

test('the viewer orbits without ever losing its basis at the pole', () => {
  for (const el of [-90, -35, 0, 35, 89, 90]) {
    const cam = buildViewer({ ...BOULDER_PRESET, viewElDeg: el }, 320, 240);
    const r = Math.hypot(cam.position.x, cam.position.y, cam.position.z);
    assert.ok(Math.abs(r - BOULDER_PRESET.viewRangeM) < 1e-9, `elevation ${el}° moved the eye`);
    assert.ok(Number.isFinite(cam.position.z));
  }
});

test('no metric depends on the viewer — PARAMETERS.md §6', () => {
  const world = buildWorld(BOULDER_PRESET);
  const at = (fov: number): number => {
    const set = computeGeometricMetrics(world.truthRig, world.scene, {
      contentRig: world.compositorRig,
      densityScale: 0.3,
      convergence: false,
      viewer: buildViewer({ ...BOULDER_PRESET, viewFovDeg: fov }, 320, 240),
    });
    return set.grid.metric.value;
  };
  assert.equal(at(35), at(70));
});

test('the offender report names a projector and a real degree of freedom', () => {
  const world = buildWorld(BOULDER_PRESET);
  const place = worstPlacementOffender(world.perturbation, BOULDER_PRESET.distanceM);
  const aim = worstAimOffender(world.perturbation);
  assert.ok(place && /^P[1-4]$/.test(place.projectorId));
  assert.ok(place.displacementMm > 0);
  assert.ok(aim && aim.displacementMm > 0);
});

test('a perfect rig has no offender worth naming', () => {
  const world = buildWorld(PERFECT_PRESET);
  const place = worstPlacementOffender(world.perturbation, PERFECT_PRESET.distanceM);
  assert.ok(place && place.displacementMm === 0);
});

test('a zero nudge changes nothing at all', () => {
  // The path every rig takes when nobody has touched a projector. If passing
  // through `applyNudges` moved a pose by a rounding error, every metric would
  // carry it and the "perfect mount scores zero" check above would be measuring
  // this function instead of the rig.
  const plain = buildWorld(BOULDER_PRESET);
  // Built from `noNudge()` rather than spelled out, so a new degree of freedom
  // appearing on the panel is covered here the day it lands instead of silently
  // dropping out of this comparison.
  const explicit = buildWorld({
    ...BOULDER_PRESET,
    nudge: BOULDER_PRESET.nudge.map(() => noNudge()),
  });
  assert.deepEqual(explicit.truthRig, plain.truthRig);
  assert.deepEqual(explicit.asBuiltRig, plain.asBuiltRig);
});

test('every per-projector control moves something, and the neutral value moves nothing', () => {
  // Two failures this catches. A control wired to nothing looks like it works —
  // the slider moves and the picture does not, which reads as "the model says it
  // does not matter". And a control whose neutral value is not its identity makes
  // an untouched rig differ from the drawing, which would put a number on the
  // page for a projector nobody has touched.
  const at = (over: Partial<ReturnType<typeof noNudge>>) =>
    buildWorld({ ...BOULDER_PRESET, nudge: BOULDER_PRESET.nudge.map(() => ({ ...noNudge(), ...over })) })
      .truthRig;
  const base = at({});
  assert.deepEqual(base, buildWorld(BOULDER_PRESET).truthRig, 'noNudge must be the identity');

  for (const spec of NUDGE_CONTROLS) {
    const away = spec.key === 'lumens' ? 3000 : spec.key === 'blackPct' ? 0.6 : spec.max / 2;
    const moved = at({ [spec.key]: away });
    assert.notDeepEqual(moved, base, `'${spec.label}' is wired to nothing`);
  }

  // …and the two photometric ones move the TRANSFER, not the geometry, which is
  // what keeps them inside the phase gate: they cannot touch a §7 geometry number.
  for (const key of ['lumens', 'blackPct'] as const) {
    const away = at({ [key]: key === 'lumens' ? 3000 : 0.6 });
    assert.deepEqual(
      away.projectors.map((p) => p.pose),
      base.projectors.map((p) => p.pose),
      `'${key}' moved a pose`,
    );
    assert.deepEqual(
      away.projectors.map((p) => p.intrinsics),
      base.projectors.map((p) => p.intrinsics),
      `'${key}' moved an intrinsic`,
    );
  }
});

test('a hand adjustment moves the lenses and never the drawing', () => {
  // The exact mirror of the test above, on the other rig, and the half that was
  // missing. `ProjectorNudge`'s own words: "These move the LENSES and nothing
  // else. The software is not told — that is the whole point." A nudge that
  // reaches the compositor is a change the software already knows about, so it
  // cancels out of every alignment metric and the page prints the untouched
  // number for a projector somebody has just moved.
  //
  // `buildWorld` used to build the compositor-side nudge by stripping the five
  // pose terms out of the operator's nudge by hand. ProjectorNudge has ten, so
  // 'Image size', both lens shifts and both lamp terms went straight through.
  //
  // Driven off NUDGE_CONTROLS rather than naming the fields, so the day an
  // eleventh degree of freedom lands it is covered without anybody remembering.
  const drawing = buildWorld(BOULDER_PRESET).compositorRig;
  for (const spec of NUDGE_CONTROLS) {
    const away = spec.key === 'lumens' ? 3000 : spec.key === 'blackPct' ? 0.6 : spec.max / 2;
    const world = buildWorld({
      ...BOULDER_PRESET,
      nudge: BOULDER_PRESET.nudge.map(() => ({ ...noNudge(), [spec.key]: away })),
    });
    assert.deepEqual(
      world.compositorRig,
      drawing,
      `'${spec.label}' leaked into the rig the software believes`,
    );
    // And it really did move the lenses, or the assertion above is vacuous.
    assert.notDeepEqual(world.truthRig, drawing, `'${spec.label}' moved neither rig`);
  }

  // Switching one off is the exception, and the one the comment names: which
  // projectors EXIST is not a movement, so it has to reach both rigs.
  const dark = buildWorld({
    ...BOULDER_PRESET,
    nudge: BOULDER_PRESET.nudge.map((n, i) => ({ ...noNudge(), on: i !== 1 })),
  });
  assert.equal(dark.compositorRig.projectors.length, drawing.projectors.length - 1);
});

test('the content cache is not rebuilt by a control the content does not read', () => {
  // The graticule is evaluated per sample from `Scene.graticule`, never
  // rasterised into the field, so neither grid term can change what
  // `buildContent` returns. Keying the cache on them bought a full rebuild of a
  // byte-identical 2048x1024 field on every step of the Grid spacing slider.
  // Identity, not deep equality: the point is that the same object comes back
  // rather than an equal one built again.
  const first = buildContent(BOULDER_PRESET, null);
  assert.equal(buildContent({ ...BOULDER_PRESET, gridDeg: 29 }, null), first);
  assert.equal(buildContent({ ...BOULDER_PRESET, gridOn: 0 }, null), first);
  // A term it DOES read still misses, or the cache would be stale instead.
  assert.notEqual(buildContent({ ...BOULDER_PRESET, content: 0 }, null), first);
});

test('a nudge moves the lens and re-aims it, without losing the mount error', () => {
  const before = buildWorld(BOULDER_PRESET).truthRig.projectors[0];
  const after = buildWorld({
    ...BOULDER_PRESET,
    nudge: BOULDER_PRESET.nudge.map((n, i) => (i === 0 ? { ...n, distanceM: 0.25 } : { ...n })),
  }).truthRig.projectors[0];

  const horiz = (p: typeof before): number => Math.hypot(p.pose.position.x, p.pose.position.y);
  assert.ok(
    Math.abs(horiz(after) - horiz(before) - 0.25) < 1e-9,
    'the lens did not move by the amount asked for',
  );
  // The aim error the mount already had is still there: the projector was
  // re-aimed from its new position and the same offset re-applied, so a pure
  // placement nudge must not quietly straighten a crooked projector.
  const aimBefore = aimAtSphereCenter(before.pose.position);
  const aimAfter = aimAtSphereCenter(after.pose.position);
  assert.ok(
    Math.abs(
      (after.pose.yawDeg - aimAfter.yawDeg) - (before.pose.yawDeg - aimBefore.yawDeg),
    ) < 1e-9,
    'the mount error was lost when the projector moved',
  );
});

test('switching a projector off removes it and leaves the framebuffer alone', () => {
  const world = buildWorld({
    ...BOULDER_PRESET,
    nudge: BOULDER_PRESET.nudge.map((n, i) => (i === 1 ? { ...n, on: false } : { ...n })),
  });
  assert.equal(world.truthRig.projectors.length, 3);
  assert.equal(world.compositorRig.projectors.length, 3, 'the software knows which outputs it drives');
  // §2's "quadrants go dark": the X screen does not shrink.
  const full = buildWorld(BOULDER_PRESET).truthRig.framebuffer;
  assert.deepEqual(world.truthRig.framebuffer, full);
});

test('the field is only ever the field; the graticule is drawn over it', () => {
  // The content texture carries NO lines now, at either toggle setting. The
  // graticule is evaluated per sample by both renderers instead, so the pattern
  // the §7 gate measures is not displayed at whatever raster the image has. See
  // `Scene.graticule`.
  for (const gridOn of [0, 1]) {
    const field = buildContent({ ...BOULDER_PRESET, gridOn, content: 1 }, null);
    const first = field.data[0];
    let flat = true;
    for (let i = 0; i < field.data.length; i++) {
      if (Math.abs(field.data[i] - first) > 1e-6) flat = false;
    }
    assert.ok(flat, `grid ${gridOn}: the field is not flat, so a line has been baked into it`);
    // 1e-6, not 1e-9: `RgbImage` is a Float32Array, so 0.18 stores as
    // 0.18000000715255737 and a tighter bound would be a statement about the
    // storage format rather than about the field.
    assert.ok(Math.abs(first - 0.18) < 1e-6, `expected the mid-grey field, got ${first}`);
  }

  // And the toggle is what decides whether there is a graticule at all.
  assert.equal(buildGraticule({ ...BOULDER_PRESET, gridOn: 0 }), null);
  const g = buildGraticule({ ...BOULDER_PRESET, gridOn: 1 });
  assert.ok(g, 'the grid is on and there is no graticule to draw');
  assert.equal(g.spacingDeg, Math.round(BOULDER_PRESET.gridDeg));
});

test('the graticule composites over the field, at full precision and only on the lines', () => {
  const world = buildWorld({ ...BOULDER_PRESET, gridOn: 1, content: 1 });
  const field = world.scene.image.data[0];

  // On a line — the equator is one — the sample is white. A quarter of a degree
  // off it, at a longitude nowhere near a meridian, it is the bare field. That
  // second half is the point: the line has an edge, and it is where the formula
  // says rather than where a texel boundary happens to fall.
  const on = contentAt(world.scene, 0, 7.5);
  const off = contentAt(world.scene, 0.6, 7.5);
  assert.ok(on.r > 0.9, `the equator should be a white line, got ${on.r}`);
  assert.ok(Math.abs(off.r - field) < 1e-6, `just off the line should be bare field, got ${off.r}`);

  // Resolution-independent: halfway between two texels of the 2048-wide raster
  // is still exactly on the line, which a baked pattern could not promise.
  const sub = contentAt(world.scene, 0, 7.5 + 360 / 2048 / 2);
  assert.ok(sub.r > 0.9, `a sub-texel step along the equator left the line, got ${sub.r}`);

  // And with the graticule off there is nothing to composite.
  const plain = buildWorld({ ...BOULDER_PRESET, gridOn: 0, content: 1 });
  assert.equal(plain.scene.graticule, null);
  assert.ok(Math.abs(contentAt(plain.scene, 0, 7.5).r - field) < 1e-6);
});

test('every base field renders, and each is a different brightness', () => {
  const means = CONTENTS.map((_, i) => {
    const img = buildContent({ ...BOULDER_PRESET, content: i, gridOn: 0 }, null);
    let sum = 0;
    for (let k = 0; k < img.data.length; k++) sum += img.data[k];
    return sum / img.data.length;
  });
  // Black, mid grey and white must be ordered and distinct. The fourth entry is
  // the drop-in, which falls back to the grey field when no image has been
  // supplied — an empty sphere reads as a broken page.
  assert.ok(means[0] < means[1] && means[1] < means[2], `not ordered: ${means.join(', ')}`);
  assert.ok(Math.abs(means[3] - means[1]) < 1e-6, 'the drop-in should fall back to the grey field');
});

test('a supplied image is used as-is, and the grid composites over it', () => {
  // A recognisable fake: a horizontal ramp. If the page ever resized, cropped or
  // re-encoded it the ramp would stop being a ramp.
  const supplied = createImage(64, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      const i = 3 * (y * 64 + x);
      supplied.data[i] = supplied.data[i + 1] = supplied.data[i + 2] = x / 63;
    }
  }
  // Passed through untouched at BOTH settings now: the grid is no longer copied
  // into a second buffer to have lines painted on it.
  for (const gridOn of [0, 1]) {
    const out = buildContent({ ...BOULDER_PRESET, content: CONTENT_CUSTOM, gridOn }, supplied);
    assert.equal(out, supplied, `grid ${gridOn}: the image should be passed through untouched`);
  }

  // The composite is a blend toward white, so it can never darken the source and
  // can never leave the display range.
  const scene = buildWorld({ ...BOULDER_PRESET, content: CONTENT_CUSTOM, gridOn: 1 }, undefined, supplied).scene;
  for (const [lat, lon] of [[0, 0], [12, 33], [-47, 128], [80, -170]] as const) {
    const base = sampleEquirect(supplied, lat, lon);
    const out = contentAt(scene, lat, lon);
    assert.ok(out.r >= base.r - 1e-9, `the grid darkened the image at ${lat},${lon}`);
    assert.ok(out.r <= 1 + 1e-9, `the composite clipped past white at ${lat},${lon}`);
  }
});

test('room light reaches the scene, and it is the §5 nominal by default', () => {
  assert.equal(BOULDER_PRESET.ambient, 0.04, 'PARAMETERS.md §5 nominal');
  const dark = buildWorld({ ...BOULDER_PRESET, ambient: 0 });
  const lit = buildWorld({ ...BOULDER_PRESET, ambient: 0.15 });
  assert.equal(dark.scene.ambient.r, 0);
  assert.equal(lit.scene.ambient.r, 0.15);
});

test('the projector count is capped at four, and the error says why', () => {
  // §3.4: one framebuffer split into four quadrant viewports. A fifth projector
  // has no quadrant to be, which is why the page offers 2, 3 and 4 and explains
  // the absence rather than silently listing three options.
  assert.throws(() => buildAsBuilt({ ...BOULDER_PRESET, projectorCount: 5 }), /1\.\.4|§2/);
});

test('the panel states lens shift the way a spec sheet does, and the calibration keeps its own units', () => {
  // The panel's control is a percentage of the FULL image, because that is what
  // a projector's data sheet quotes and what an installer reads off one — the
  // LK935 is ±23% across and ±60% up. conventions §3.1 measures shift against
  // the HALF-extent instead, so the two differ by exactly a factor of two and
  // the conversion belongs in one place.
  const h = NUDGE_CONTROLS.find((c) => c.key === 'shiftH');
  const v = NUDGE_CONTROLS.find((c) => c.key === 'shiftV');
  assert.ok(h && v);
  assert.equal(h.unit, '%');
  assert.equal(v.max, 60, 'the vertical range is the projector\u2019s, not a quarter of it');

  const base = buildWorld(PERFECT_PRESET).truthRig.projectors[0].intrinsics;
  const shifted = buildWorld(withNudge(PERFECT_PRESET, 0, { shiftV: 60 })).truthRig.projectors[0]
    .intrinsics;
  assert.ok(
    Math.abs(shifted.shiftV - (base.shiftV + 60 / SHIFT_PCT_PER_UNIT)) < 1e-9,
    `60% of image height became ${shifted.shiftV - base.shiftV} of the half-extent`,
  );
  // 60% of the image is 1.2 half-extents: past the edge of the frame, which is
  // exactly what a ceiling mount does and what the old ±0.3 could not express.
  assert.ok(shifted.shiftV - base.shiftV > 1, 'the ceiling-mount case is still unreachable');
});

/**
 * The viewer's lens shift.
 *
 * The phone layout puts a sheet at the top of the screen and one at the bottom,
 * so the room a reader can see is the band between them — and that band is not
 * centred on the window. `viewShiftFrac` in `web/main.ts` measures it and the
 * camera moves the picture to match.
 *
 * There are two ways to put a subject low in the frame and only one of them is
 * right, which is what these two tests are for.
 */
const SHIFT_VIEW: Settings = {
  ...BOULDER_PRESET,
  // Nothing but the sphere in the frame: this renderer draws no floor, so with a
  // black field the silhouette is exactly the pixels that are not zero.
  content: 0,
  mountError: 0,
  viewRangeM: 6.2,
  viewFovDeg: 40,
};
const SHIFT_W = 180;
const SHIFT_H = 320;

/** The bounding box of everything the renderer lit. */
function silhouetteOf(camera: ReturnType<typeof buildViewer>): {
  w: number;
  h: number;
  cy: number;
  lit: number;
} {
  const world = buildWorld(SHIFT_VIEW);
  const img = renderTwoRigRoomView(
    prepareRig(world.truthRig),
    prepareRig(world.compositorRig),
    world.scene,
    camera,
    { samplesPerPixel: 1 },
  );
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let lit = 0;
  for (let y = 0; y < SHIFT_H; y++) {
    for (let x = 0; x < SHIFT_W; x++) {
      const i = 3 * (y * SHIFT_W + x);
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] <= 0) continue;
      lit++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, cy: (y0 + y1) / 2, lit };
}

test('a lens shift moves the ball down the frame by exactly what it says', () => {
  // The unit is halves of the frame height, so a shift of s moves the subject
  // s * H / 2 pixels down. Anything else and the page cannot aim at a band it
  // measured in pixels.
  for (const shift of [0, 0.3, 0.65]) {
    const s = silhouetteOf(buildViewer(SHIFT_VIEW, SHIFT_W, SHIFT_H, shift));
    const expected = SHIFT_H / 2 + (shift * SHIFT_H) / 2;
    assert.ok(
      Math.abs(s.cy - expected) < 1.5,
      `shift ${shift} put the ball at row ${s.cy}, expected ${expected}`,
    );
  }
});

test('a lens shift does not stretch the ball, and aiming above it would', () => {
  // The whole reason this is a principal-point offset rather than a re-aim. An
  // aimed camera puts the sphere off its own optical axis, and a rectilinear
  // projection stretches whatever sits off-axis — in a portrait frustum at the
  // shift a phone layout wants, into a visible egg.
  const flat = silhouetteOf(buildViewer(SHIFT_VIEW, SHIFT_W, SHIFT_H, 0));
  assert.equal(flat.w, flat.h, 'the unshifted ball is not round; the rest of this proves nothing');

  for (const shift of [0.3, 0.65]) {
    const s = silhouetteOf(buildViewer(SHIFT_VIEW, SHIFT_W, SHIFT_H, shift));
    assert.equal(s.w, flat.w, `shift ${shift} changed the ball's width`);
    assert.equal(s.h, flat.h, `shift ${shift} changed the ball's height`);
    assert.equal(s.lit, flat.lit, `shift ${shift} changed how many pixels the ball covers`);
  }

  // And the same composition reached by aiming, which is what this is instead
  // of. `buildViewer` cannot produce it, so it is constructed here: tilt the
  // forward axis up by `shift * halfH` and look there.
  const base = buildViewer(SHIFT_VIEW, SHIFT_W, SHIFT_H, 0);
  const p = base.position;
  const r = Math.hypot(p.x, p.y, p.z);
  const f = { x: -p.x / r, y: -p.y / r, z: -p.z / r };
  const rl = Math.hypot(f.y, -f.x);
  const right = { x: f.y / rl, y: -f.x / rl, z: 0 };
  const up = {
    x: right.y * f.z - right.z * f.y,
    y: right.z * f.x - right.x * f.z,
    z: right.x * f.y - right.y * f.x,
  };
  const halfH = (Math.tan(((SHIFT_VIEW.viewFovDeg * Math.PI) / 180) / 2) * SHIFT_H) / SHIFT_W;
  const k = 0.65 * halfH;
  const a = { x: f.x + up.x * k, y: f.y + up.y * k, z: f.z + up.z * k };
  const al = Math.hypot(a.x, a.y, a.z);
  const aimed = silhouetteOf({
    ...base,
    target: { x: p.x + (a.x / al) * r, y: p.y + (a.y / al) * r, z: p.z + (a.z / al) * r },
  });

  // It lands in the same place — that is what makes it the alternative — and it
  // is a different shape when it gets there.
  const shifted = silhouetteOf(buildViewer(SHIFT_VIEW, SHIFT_W, SHIFT_H, 0.65));
  assert.ok(
    Math.abs(aimed.cy - shifted.cy) < 4,
    `the aimed camera was meant to compose the same picture: ${aimed.cy} vs ${shifted.cy}`,
  );
  assert.ok(
    aimed.h > flat.h + 8,
    `aiming was expected to stretch the ball; it drew ${aimed.w}x${aimed.h} against ${flat.w}x${flat.h}`,
  );
  assert.ok(
    aimed.lit > flat.lit * 1.2,
    `aiming was expected to inflate the ball; ${aimed.lit} px against ${flat.lit}`,
  );
});

/**
 * The framing solve behind the seam picker.
 *
 * Clicking a seam walks the camera round to it and comes in until the patch the
 * diagram covers fills a stated fraction of the frame. The distance is solved,
 * not picked, so it has to be right at any sphere diameter and any field of
 * view — a phone's is chosen from the aspect and is roughly half a desktop's.
 */
test('the framing distance really does put the patch where it says', () => {
  // The inversion, checked by putting the answer back through the FORWARD
  // formula, written out here rather than reused: an algebra slip in
  // `framingRangeM` would otherwise agree with itself.
  const forwardHalfAngleDeg = (radiusM: number, halfSpanDeg: number, rangeM: number): number => {
    const phi = (halfSpanDeg * Math.PI) / 180;
    return (
      (Math.atan2(radiusM * Math.sin(phi), rangeM - radiusM * Math.cos(phi)) * 180) / Math.PI
    );
  };

  for (const radiusM of [0.5, 0.864, 1.65]) {
    for (const halfSpanDeg of [8, 15, 30]) {
      for (const fovHDeg of [30, 41, 71]) {
        for (const fill of [0.5, 0.7, 0.95]) {
          const r = framingRangeM(radiusM, halfSpanDeg, fovHDeg, fill);
          assert.ok(
            r > radiusM,
            `radius ${radiusM}, span ${halfSpanDeg}, fov ${fovHDeg}, fill ${fill} put the eye ` +
              `inside the sphere at ${r}`,
          );
          const got = forwardHalfAngleDeg(radiusM, halfSpanDeg, r);
          const want = (fovHDeg / 2) * fill;
          assert.ok(
            Math.abs(got - want) < 1e-9,
            `the patch subtends ${got}° of half-frame where ${want}° was asked for`,
          );
        }
      }
    }
  }
});

test('the framing distance scales with the ball and closes with the field', () => {
  // The two properties a reader would predict, so a plausible-looking formula
  // that got them backwards cannot pass the round-trip above by coincidence.
  const a = framingRangeM(0.864, 15, 71, 0.7);
  const twice = framingRangeM(1.728, 15, 71, 0.7);
  assert.ok(
    Math.abs(twice - 2 * a) < 1e-9,
    `a sphere twice the size wants twice the distance: ${twice} against ${2 * a}`,
  );
  // A narrower field — a phone's — has to stand further back to hold the same
  // patch across the frame.
  assert.ok(framingRangeM(0.864, 15, 41, 0.7) > a);
  // And filling more of the frame means coming closer.
  assert.ok(framingRangeM(0.864, 15, 71, 0.95) < a);
});

test('the framing distance survives a degenerate field of view', () => {
  // `viewFovDeg` is a slider and `halfSpanDeg` comes off a worker message. A
  // zero in either used to be a division by approximately zero.
  for (const [span, fov] of [[0, 71], [15, 0], [0, 0], [-4, -4]] as const) {
    const r = framingRangeM(0.864, span, fov, 0.7);
    assert.ok(Number.isFinite(r) && r > 0.864, `span ${span}, fov ${fov} gave ${r}`);
  }
});
