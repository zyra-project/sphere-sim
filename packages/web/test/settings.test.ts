import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  BOULDER_PRESET,
  CONTROLS,
  GROUPS,
  IN_TO_M,
  PERFECT_PRESET,
  PRESETS,
  SPEC_PRESET,
  coerce,
  formatSetting,
  withSetting,
} from '../src/settings.ts';
import type { Settings } from '../src/settings.ts';

test('every control names a group that exists', () => {
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const c of CONTROLS) {
    assert.ok(ids.has(c.group), `control ${c.key} is in group '${c.group}', which no group declares`);
  }
});

test('every control drives a real setting, and every setting has a control', () => {
  const keys = new Set(Object.keys(BOULDER_PRESET));
  const driven = new Set<string>();
  for (const c of CONTROLS) {
    assert.ok(keys.has(c.key), `control ${c.key} drives a setting that does not exist`);
    driven.add(c.key);
  }
  // A setting with no control is a number nobody can reach and nobody can see,
  // which is worse than not having it: it silently participates in every metric.
  for (const k of keys) {
    assert.ok(driven.has(k), `setting '${k}' has no control — it would be invisible and immovable`);
  }
});

test('every control opens inside its own range', () => {
  for (const c of CONTROLS) {
    const v = BOULDER_PRESET[c.key];
    assert.ok(
      v >= c.min && v <= c.max,
      `${c.key} defaults to ${v}, outside its declared range ${c.min}..${c.max}`,
    );
  }
});

test('A-36: the Boulder preset differs from the spec preset on exactly the three constants', () => {
  const differing = (Object.keys(BOULDER_PRESET) as (keyof Settings)[]).filter(
    (k) => BOULDER_PRESET[k] !== SPEC_PRESET[k],
  );
  assert.deepEqual(differing.sort(), ['distanceM', 'equatorIn', 'lensRiseM']);

  // The values themselves, so a later edit to either preset that made them agree
  // would fail here rather than quietly erasing the conflict the page exists to
  // show.
  assert.equal(BOULDER_PRESET.equatorIn, 84, "Boulder's config says 84 in");
  assert.equal(SPEC_PRESET.equatorIn, 86, 'PARAMETERS.md §1 says 86 in');
  assert.equal(BOULDER_PRESET.lensRiseM, 8 * IN_TO_M, 'Boulder mounts the lenses 8 in above the equator');
  assert.equal(SPEC_PRESET.lensRiseM, 0, '§2 puts the lenses level with the equator');
  assert.ok(
    Math.abs(BOULDER_PRESET.distanceM - 211 * IN_TO_M) < 1e-12,
    "Boulder's config says 211 in",
  );
  assert.equal(SPEC_PRESET.distanceM, 5.18, "the alignment manual's figure");
});

test('the perfect preset differs from Boulder only in the mount error', () => {
  const differing = (Object.keys(BOULDER_PRESET) as (keyof Settings)[]).filter(
    (k) => BOULDER_PRESET[k] !== PERFECT_PRESET[k],
  );
  assert.deepEqual(differing, ['mountError']);
  assert.equal(PERFECT_PRESET.mountError, 0);
});

test('every preset is reachable from the preset list', () => {
  const bodies = PRESETS.map((p) => p.settings);
  assert.ok(bodies.includes(BOULDER_PRESET));
  assert.ok(bodies.includes(SPEC_PRESET));
  assert.ok(bodies.includes(PERFECT_PRESET));
});

test('coerce clamps to the declared range', () => {
  assert.equal(coerce('sphereDiaIn', 1e6), 130);
  assert.equal(coerce('sphereDiaIn', -5), 40);
  assert.equal(coerce('projectorCount', 3.4), 3);
});

test('the mask pair can never be inverted by dragging either end', () => {
  let s: Settings = { ...BOULDER_PRESET };
  s = withSetting(s, 'maskLoDeg', 85);
  assert.ok(s.maskHiDeg > s.maskLoDeg, `lo ${s.maskLoDeg} must stay below hi ${s.maskHiDeg}`);
  s = withSetting(s, 'maskHiDeg', 40);
  assert.ok(
    s.maskHiDeg > s.maskLoDeg,
    `dragging hi below lo must push lo down, got lo ${s.maskLoDeg} hi ${s.maskHiDeg}`,
  );
});

test('a discrete control formats as its option label, not as a number', () => {
  const res = CONTROLS.find((c) => c.key === 'resolution');
  assert.ok(res && res.options);
  assert.equal(formatSetting(res, 3), '3840 × 2160 (LK935)');
});

test('every ASSUME control says so in its help, since the colour alone is not a claim', () => {
  for (const c of CONTROLS.filter((x) => x.klass === 'ASSUME')) {
    assert.ok(c.help.length > 40, `${c.key} is class ASSUME and needs an explanation of what is assumed`);
  }
});
