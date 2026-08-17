import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  BOULDER_PRESET,
  CONTENTS,
  CONTENT_CUSTOM,
  CONTROLS,
  GROUPS,
  IN_TO_M,
  NUDGE_CONTROLS,
  PERFECT_PRESET,
  PRESETS,
  PROJECTOR_TINTS,
  RESOLUTIONS,
  SPEC_PRESET,
  clearNudges,
  coerce,
  formatSetting,
  noNudge,
  withNudge,
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
  // The per-projector adjustments are an array, not a scalar, and have their own
  // spec list. Everything else must be reachable: a setting with no control is a
  // number nobody can see and nobody can move, which is worse than not having it
  // — it silently participates in every metric.
  driven.add('nudge');
  for (const k of keys) {
    assert.ok(driven.has(k), `setting '${k}' has no control — it would be invisible and immovable`);
  }
  for (const spec of NUDGE_CONTROLS) {
    assert.ok(spec.key in noNudge(), `nudge control ${spec.key} drives nothing`);
    assert.ok(spec.help.length > 30, `nudge control ${spec.key} has no explanation`);
  }
});

test('every projector has a tint, and they are distinct', () => {
  assert.ok(PROJECTOR_TINTS.length >= 4);
  assert.equal(new Set(PROJECTOR_TINTS).size, PROJECTOR_TINTS.length);
});

test('every base field says what it is for', () => {
  for (const c of CONTENTS) {
    assert.ok(c.help.length > 40, `base field '${c.label}' has no explanation`);
    assert.ok(c.background >= 0 && c.background <= 1);
  }
  // The one the page opens at must light the sphere: a graticule on black is the
  // honest alignment pattern and a mostly-dark ball, and a first impression of a
  // dark ball is a first impression of nothing.
  assert.ok((CONTENTS[BOULDER_PRESET.content]?.background ?? 0) > 0.05);
  assert.equal(BOULDER_PRESET.gridOn, 1, 'the alignment grid should be on at first sight');
  // The drop-in is last, so the three flat fields read as a run.
  assert.equal(CONTENT_CUSTOM, CONTENTS.length - 1);
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
  const differing = (Object.keys(BOULDER_PRESET) as (keyof Settings)[])
    .filter((k) => k !== 'nudge')
    .filter((k) => BOULDER_PRESET[k] !== SPEC_PRESET[k]);
  assert.deepEqual(differing.sort(), ['distanceM', 'equatorIn', 'lensRiseM']);
  // The nudge arrays are separate objects but must hold the same values: a
  // preset that arrived with a projector already knocked would make every
  // comparison between presets meaningless.
  assert.deepEqual(BOULDER_PRESET.nudge, SPEC_PRESET.nudge);

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
  const differing = (Object.keys(BOULDER_PRESET) as (keyof Settings)[])
    .filter((k) => k !== 'nudge')
    .filter((k) => BOULDER_PRESET[k] !== PERFECT_PRESET[k]);
  assert.deepEqual(differing, ['mountError']);
  assert.equal(PERFECT_PRESET.mountError, 0);
  assert.deepEqual(PERFECT_PRESET.nudge, BOULDER_PRESET.nudge);
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

test('presets do not share a nudge array, so editing one cannot edit the others', () => {
  const a = withNudge({ ...BOULDER_PRESET }, 0, { yawDeg: 1 });
  assert.equal(a.nudge[0].yawDeg, 1);
  assert.equal(BOULDER_PRESET.nudge[0].yawDeg, 0, 'the preset was mutated');
  assert.equal(SPEC_PRESET.nudge[0].yawDeg, 0, 'a sibling preset was mutated');
});

test('a discrete control formats as its option label, not as a number', () => {
  const res = CONTROLS.find((c) => c.key === 'resolution');
  assert.ok(res && res.options);
  assert.equal(formatSetting(res, 3), '3840 × 2160 · 16:9 · LK935');
  // Every raster names its aspect, because the shape is what §7's off-sphere gate
  // is about (A-03) and the pixel count is not.
  for (const label of RESOLUTIONS.map((r) => r.label)) {
    assert.ok(/·\s\d+:\d+/.test(label), `'${label}' does not say what shape it is`);
  }
});

test('the eye cannot be put inside the ball, whatever size the ball is', () => {
  // `viewRangeM` is measured from the sphere CENTRE, so a constant floor is
  // wrong at both ends of `sphereDiaIn`: at 130 inches a 1.4 m range is a
  // quarter of a metre inside the surface, and at 40 inches it holds the camera
  // most of a metre off a surface somebody was trying to inspect.
  const big = withSetting(PERFECT_PRESET, 'sphereDiaIn', 130);
  const closest = withSetting(big, 'viewRangeM', 0.5);
  const radius = (130 * IN_TO_M) / 2;
  assert.ok(
    closest.viewRangeM > radius,
    `the eye is inside a ${radius.toFixed(2)} m sphere at ${closest.viewRangeM} m`,
  );
  assert.ok(closest.viewRangeM - radius < 0.2, 'and it is not held further out than it needs to be');

  // The floor follows the ball rather than being applied once: growing the
  // sphere under a camera that was already close pushes the camera out.
  const near = withSetting(PERFECT_PRESET, 'viewRangeM', 1.0);
  assert.ok(near.viewRangeM < 1.1, 'a 68-inch ball allows a close look');
  const grown = withSetting(near, 'sphereDiaIn', 120);
  assert.ok(
    grown.viewRangeM > (120 * IN_TO_M) / 2,
    'growing the sphere left the camera buried inside it',
  );
});

test('every ASSUME control says so in its help, since the colour alone is not a claim', () => {
  for (const c of CONTROLS.filter((x) => x.klass === 'ASSUME')) {
    assert.ok(c.help.length > 40, `${c.key} is class ASSUME and needs an explanation of what is assumed`);
  }
});

test('clearing the hand adjustments does not switch a projector back on', () => {
  // Whether a lamp is on is the state of the installation, not an adjustment.
  // "Another install" clears the nudges and draws a different mount error; a
  // projector somebody switched off to look at the hole it leaves must not come
  // back silently, which is the same class of surprise as switching one off from
  // a second click on the tab you select with.
  const dark = withNudge(withNudge(PERFECT_PRESET, 2, { on: false }), 2, { yawDeg: 1.5 });
  const cleared = clearNudges(dark);
  assert.equal(cleared.nudge[2].yawDeg, 0, 'the hand adjustment should be gone');
  assert.equal(cleared.nudge[2].on, false, 'and the projector should still be switched off');
  for (const i of [0, 1, 3]) assert.equal(cleared.nudge[i].on, true);
});
