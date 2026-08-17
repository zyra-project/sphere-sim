import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createImage } from '../../sim/src/equirect.ts';
import { aimAtSphereCenter } from '../../sim/src/geometry.ts';
import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import { DEFAULT_MISALIGNMENT } from '../../sim/src/scene.ts';
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
  buildViewer,
  buildWorld,
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

test('the grid toggle turns the graticule on and off without changing the field', () => {
  const on = buildContent({ ...BOULDER_PRESET, gridOn: 1, content: 1 }, null);
  const off = buildContent({ ...BOULDER_PRESET, gridOn: 0, content: 1 }, null);

  // With the grid off the field is flat: every texel is the same value, and that
  // value is the base field's.
  const first = off.data[0];
  let flat = true;
  for (let i = 0; i < off.data.length; i++) {
    if (Math.abs(off.data[i] - first) > 1e-6) flat = false;
  }
  assert.ok(flat, 'the grid is off and the field is not flat');
  // 1e-6, not 1e-9: `RgbImage` is a Float32Array, so 0.18 stores as
  // 0.18000000715255737 and a tighter bound would be a statement about the
  // storage format rather than about the field.
  assert.ok(Math.abs(first - 0.18) < 1e-6, `expected the mid-grey field, got ${first}`);

  // With it on, the lines are brighter than the field somewhere.
  let brightest = 0;
  for (let i = 0; i < on.data.length; i++) brightest = Math.max(brightest, on.data[i]);
  assert.ok(brightest > 0.5, `the graticule is not visible over the field; brightest ${brightest}`);
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
  const plain = buildContent({ ...BOULDER_PRESET, content: CONTENT_CUSTOM, gridOn: 0 }, supplied);
  assert.equal(plain, supplied, 'the image should be passed through untouched with the grid off');

  const withGrid = buildContent({ ...BOULDER_PRESET, content: CONTENT_CUSTOM, gridOn: 1 }, supplied);
  assert.equal(withGrid.width, supplied.width);
  assert.equal(withGrid.height, supplied.height);
  // The composite is a blend toward white, so it can never darken the source and
  // can never leave the display range.
  for (let i = 0; i < supplied.data.length; i++) {
    assert.ok(withGrid.data[i] >= supplied.data[i] - 1e-9, `the grid darkened the image at ${i}`);
    assert.ok(withGrid.data[i] <= 1 + 1e-9, `the composite clipped past white at ${i}`);
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
