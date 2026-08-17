import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import { BOULDER_PRESET, SPEC_PRESET } from '../src/settings.ts';
import { buildWorld } from '../src/rigs.ts';
import {
  LK935_THROW_MAX,
  LK935_THROW_MIN,
  dProjAmbiguityMm,
  framebufferSentence,
  pixelFootprintMm,
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
