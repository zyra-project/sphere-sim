import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import { DEFAULT_MISALIGNMENT } from '../../sim/src/scene.ts';
import { BOULDER_PRESET, IN_TO_M, PERFECT_PRESET, SPEC_PRESET } from '../src/settings.ts';
import type { Settings } from '../src/settings.ts';
import {
  buildAsBuilt,
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
