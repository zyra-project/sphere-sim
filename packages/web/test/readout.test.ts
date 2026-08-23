import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import { BOULDER_PRESET, PERFECT_PRESET, SPEC_PRESET } from '../src/settings.ts';
import { buildWorld } from '../src/rigs.ts';
import {
  LK935_THROW_MAX,
  LK935_THROW_MIN,
  dProjAmbiguityMm,
  framebufferSentence,
  pixelFootprintMm,
  projectorFacts,
  readingsFrom,
  rigFacts,
} from '../src/readout.ts';

function metricsAt(settings = BOULDER_PRESET) {
  const world = buildWorld(settings);
  return {
    world,
    set: computeGeometricMetrics(world.truthRig, world.scene, {
      contentRig: world.compositorRig,
      densityScale: 0.3,
      convergence: false,
    }),
  };
}

test('every metric the model produces has plain-language copy', () => {
  // The claim `readout.ts` makes about itself: keying by the metric's own id
  // means a metric appearing or disappearing in `sim` shows up as a missing
  // entry rather than as a silently unlabelled row. This is that check.
  const { set } = metricsAt();
  const readings = readingsFrom(set);
  assert.equal(readings.length, set.metrics.length);
  for (const r of readings) {
    assert.ok(r.means.length > 40, `'${r.id}' has no explanation of what it means`);
    assert.notEqual(r.label, '', `'${r.id}' has no label`);
  }
});

test('a metric with no §7 gate is REFERENCE, never PASS', () => {
  const { set } = metricsAt();
  const readings = readingsFrom(set);
  for (const m of set.metrics) {
    const r = readings.find((x) => x.id === m.id);
    assert.ok(r);
    if (!m.scored) {
      assert.equal(
        r.status,
        m.provisional ? 'PROVISIONAL' : 'REFERENCE',
        `'${m.id}' is unscored and must not read as a verdict`,
      );
    }
  }
});

test('the registration error is reported and never scored', () => {
  // PARAMETERS.md §7 sets no numeric gate on it. Reporting it as a pass would be
  // inventing a bar; hiding it would drop the one number that separates "the
  // seams are misregistered" from "the whole sphere is offset".
  const { set } = metricsAt();
  const r = readingsFrom(set).find((x) => x.id === 'registration_error');
  assert.ok(r);
  assert.equal(r.status, 'REFERENCE');
});

test('the unlit gate is a hard zero, and a good rig meets it', () => {
  const { set } = metricsAt();
  const r = readingsFrom(set).find((x) => x.id === 'unlit_in_mask');
  assert.ok(r);
  // §7 calls this a hard requirement: anything above the bottom mask must be lit
  // by at least one projector, so the bound is an exact zero and only an exact
  // zero passes. It is achievable because the quantity is a count over a count,
  // not a floating-point residual.
  assert.ok(r.gate.startsWith('0.0'), `expected a zero gate, got '${r.gate}'`);
  assert.equal(r.status, 'PASS');
});

test('the absolute off-sphere reading is excluded from the verdict — A-03', () => {
  // §7 gates it at 52%, which a 16:9 raster cannot reach at any alignment: the
  // analytic floor is about 56%. Scoring it would make the gate a measurement of
  // the projector's aspect ratio.
  const { set } = metricsAt();
  const absolute = set.metrics.find((m) => m.id === 'off_sphere_flux');
  assert.ok(absolute);
  assert.equal(absolute.scored, false);
  assert.ok(absolute.value > 0.52, 'the 16:9 floor really is above the gate');
});

test('the throw ratio verdict tracks the LK935 band and nothing else', () => {
  const { world, set } = metricsAt();
  const facts = rigFacts(world.asBuiltRig, set);
  const ratio = facts.find((f) => f.label === 'Throw ratio');
  assert.ok(ratio);
  const value = Number(ratio.value.replace(':1', ''));
  assert.equal(ratio.ok, value >= LK935_THROW_MIN && value <= LK935_THROW_MAX);
});

test('Boulder at 4K puts a projector pixel under the 1 mm gate', () => {
  const mm = pixelFootprintMm(buildWorld(BOULDER_PRESET).truthRig);
  assert.ok(mm < 1, `expected under the 1 mm gate at 3840x2160; got ${mm.toFixed(3)} mm`);
  assert.ok(mm > 0.5, `and not absurdly small; got ${mm.toFixed(3)} mm`);
});

test('the same rig at 1024x768 does not', () => {
  const mm = pixelFootprintMm(buildWorld({ ...BOULDER_PRESET, resolution: 0 }).truthRig);
  assert.ok(mm > 1, `expected over the gate at 1024x768; got ${mm.toFixed(3)} mm`);
});

test('the projector pixel is the on-axis one, not the average across the raster', () => {
  // A rectilinear lens is linear in TANGENT, so its pixels are not equal in
  // angle across the raster and `fov / resX` is their average. The pixel this
  // fact is about is the widest of them — the on-axis one, which lands at the
  // sub-projector point the fact names.
  //
  // Checked against the identity rather than against a remembered number: the
  // footprint is the half-width the frustum subtends at the near surface,
  // divided by half the columns.
  for (const s of [
    BOULDER_PRESET,
    { ...BOULDER_PRESET, sphereDiaIn: 130, distanceM: 4.32 },
    { ...BOULDER_PRESET, sphereDiaIn: 40, distanceM: 7.2 },
    { ...BOULDER_PRESET, resolution: 0 },
  ]) {
    const rig = buildWorld(s).truthRig;
    const mm = pixelFootprintMm(rig);
    const worst = rig.projectors.reduce((acc, p) => {
      const throwM =
        Math.hypot(p.pose.position.x, p.pose.position.y, p.pose.position.z) - rig.sphere.radiusM;
      const halfWidthM = Math.tan(((p.intrinsics.fovHDeg / 2) * Math.PI) / 180) * throwM;
      return Math.max(acc, (halfWidthM / (p.intrinsics.resX / 2)) * 1000);
    }, 0);
    assert.ok(
      Math.abs(mm - worst) < 1e-9,
      `${mm.toFixed(4)} mm against the frustum's own ${worst.toFixed(4)} mm`,
    );
  }

  // And the case where the two readings disagree about the verdict, which is
  // what makes this worth a test rather than a comment: a 130-inch ball at
  // 4.32 m read "under the 1 mm gate" for a pixel that lands over it.
  const big = buildWorld({ ...BOULDER_PRESET, sphereDiaIn: 130, distanceM: 4.32 });
  const px = pixelFootprintMm(big.truthRig);
  assert.ok(px > 1, `expected over the 1 mm gate; got ${px.toFixed(4)} mm`);
  const average = big.truthRig.projectors.reduce((acc, p) => {
    const throwM =
      Math.hypot(p.pose.position.x, p.pose.position.y, p.pose.position.z) - big.truthRig.sphere.radiusM;
    return Math.max(acc, (((p.intrinsics.fovHDeg * Math.PI) / 180 / p.intrinsics.resX) * throwM) * 1000);
  }, 0);
  assert.ok(average < 1, 'the average reading no longer disagrees, so this fixture proves nothing');
});

test('the d_proj ambiguity fact appears at Boulder and is absent at the spec', () => {
  const boulder = metricsAt(BOULDER_PRESET);
  const spec = metricsAt(SPEC_PRESET);

  // Read off the AS-BUILT rig, which is the point: the ambiguity is a question
  // about a documented constant, not about this seed's mount error. A shaken
  // level rig still shows about 0.18 mm of it purely from jitter, and reporting
  // that would turn a spec conflict into a random number.
  assert.ok(dProjAmbiguityMm(boulder.world.asBuiltRig) > 2);
  assert.ok(dProjAmbiguityMm(spec.world.asBuiltRig) < 1e-9);

  const shown = rigFacts(boulder.world.asBuiltRig, boulder.set).some((f) =>
    f.label.includes('d_proj'),
  );
  const hidden = rigFacts(spec.world.asBuiltRig, spec.set).some((f) => f.label.includes('d_proj'));
  assert.ok(shown, 'A-36 is live at Boulder and the page must say so');
  assert.ok(!hidden, 'at a level rig there is nothing to report');
});

test('overlap multiplicity never exceeds 2, and the page checks rather than asserts it', () => {
  for (const count of [2, 3, 4]) {
    const { world, set } = metricsAt({ ...BOULDER_PRESET, projectorCount: count });
    assert.ok(set.coverage.maxMultiplicity <= 2, `${count} projectors produced a 3-way overlap`);
    const fact = rigFacts(world.asBuiltRig, set).find((f) => f.label.startsWith('Most projectors'));
    assert.ok(fact && fact.ok === true);
  }
});

test('the framebuffer sentence says one image, and names the dark quadrants', () => {
  const four = framebufferSentence(buildWorld(BOULDER_PRESET).truthRig);
  assert.ok(four.includes('7680 × 4320'), '4K per projector implies a 7680x4320 X screen');
  assert.ok(four.includes('one image'));

  const three = framebufferSentence(
    buildWorld({ ...BOULDER_PRESET, projectorCount: 3 }).truthRig,
  );
  assert.ok(three.includes('1 of them black'));
  assert.ok(three.includes('7680 × 4320'), 'fewer projectors must not shrink the framebuffer');
});

test('a projector\'s configuration is the same six facts from whichever rig is asked', () => {
  const world = buildWorld(BOULDER_PRESET);
  const believed = projectorFacts(world.compositorRig, 2);
  const actual = projectorFacts(world.truthRig, 2);

  // Same function, two rigs. Two functions would be free to disagree about what
  // a row MEANS, and the page prints them side by side as if they could not.
  assert.equal(believed.length, actual.length);
  assert.deepEqual(
    believed.map((f) => f.label),
    actual.map((f) => f.label),
  );
  assert.ok(believed.length >= 5);
  for (const f of believed) assert.ok(f.note.length > 40, `${f.label} has no explanation`);

  // A knocked rig must differ somewhere, or the column pair is decoration.
  const differing = believed.filter((f, i) => f.value !== actual[i].value);
  assert.ok(differing.length > 0, 'the mount error moved nothing this page can see');
  // …and the raster is not one of the things a mount tolerance moves.
  assert.ok(
    !differing.some((f) => f.label === 'Raster'),
    'a mount tolerance cannot change how many pixels a projector has',
  );
});

test('azimuth is wrapped so the two columns can be subtracted by eye', () => {
  // atan2 answers in (-180, 180], which puts a one-degree error either side of
  // the wrap at 180.00 against -178.95 — a 359-degree difference on the page.
  const world = buildWorld(BOULDER_PRESET);
  for (const rig of [world.compositorRig, world.truthRig]) {
    for (let i = 0; i < rig.projectors.length; i++) {
      const az = projectorFacts(rig, i).find((f) => f.label === 'Around the ball');
      assert.ok(az);
      const deg = Number.parseFloat(az.value);
      assert.ok(deg >= 0 && deg < 360, `azimuth reads ${az.value}`);
    }
  }
});

test('a perfectly-mounted rig agrees with itself on every row', () => {
  const world = buildWorld(PERFECT_PRESET);
  for (let i = 0; i < world.truthRig.projectors.length; i++) {
    const believed = projectorFacts(world.compositorRig, i);
    const actual = projectorFacts(world.truthRig, i);
    assert.deepEqual(
      believed.map((f) => f.value),
      actual.map((f) => f.value),
      `P${i + 1} disagrees with itself at zero mount error`,
    );
  }
});

test('a censored metric is printed as a lower bound, not as a worst case', () => {
  // A metric that could not evaluate part of its own domain reports the worst of
  // what it COULD read. Printed bare, that is a small number beside a FAIL badge
  // and a 1.000 mm gate, which reads as a contradiction; printed with a `>=` it
  // reads as what it is. The page also puts the metric's own INCOMPLETE sentence
  // ahead of the standing copy, because that sentence is what explains the badge.
  const { set } = metricsAt();
  const m = set.metrics.find((x) => x.id === 'grid_displacement');
  assert.ok(m);
  const reading = readingsFrom(set).find((r) => r.id === 'grid_displacement');
  assert.ok(reading);
  assert.equal(reading.censored, m.censored);
  if (m.censored) {
    assert.ok(reading.value.startsWith('\u2265 '), `censored value reads '${reading.value}'`);
    assert.match(reading.means, /^INCOMPLETE: /);
    assert.equal(reading.status, 'FAIL', 'a censored metric cannot report PASS');
  } else {
    assert.ok(!reading.value.startsWith('\u2265 '));
    assert.doesNotMatch(reading.means, /^INCOMPLETE: /);
  }
});

test('a gate printed beside the headline drops the sampling basis and keeps the unit', () => {
  // `sim` says what a number was measured over — "mm on sphere surface" — which
  // belongs in a table and not in the line under a 44px figure, where it wrapped
  // onto three lines beside the number it was captioning.
  const { set } = metricsAt();
  const grid = readingsFrom(set).find((r) => r.id === 'grid_displacement');
  assert.ok(grid);
  assert.match(grid.gate, /mm on sphere surface$/, 'the long form is what the table wants');
  assert.match(grid.gateShort, /^[\d.]+ mm$/, `short gate reads '${grid.gateShort}'`);
  // The optional `>=` is the lower-bound marker a CENSORED metric carries: the
  // Boulder preset's own mount error is large enough that some seams can no
  // longer be localised, so its worst grid displacement really is a floor. What
  // this test is about is the UNIT, and the marker must not disturb it.
  assert.match(grid.valueShort, /^(\u2265 )?[\d.]+ mm$/, `short value reads '${grid.valueShort}'`);
  assert.equal(
    grid.valueShort.startsWith('\u2265 '),
    grid.censored,
    'the lower-bound marker and the censored flag disagree',
  );

  // A fraction has no short form to take: "0.13%" is already the whole of it,
  // and chopping its unit would leave a bare number with no percent sign.
  const unlit = readingsFrom(set).find((r) => r.id === 'unlit_in_mask');
  assert.ok(unlit);
  assert.equal(unlit.valueShort, unlit.value);
});
