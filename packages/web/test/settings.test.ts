// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `web/main.ts` as text.
 *
 * A control is DECLARED in settings.ts and LAID OUT in main.ts, and the test
 * below is about the second half. Reading the source is the same trick
 * glsl.test.ts uses on gl.ts, for the same reason: there is no DOM here, and the
 * question is which call sites exist rather than what they render.
 */
const MAIN_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'main.ts'),
  'utf8',
);

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

test('every declared control is laid out by some panel', () => {
  // The test above catches a SETTING with no control. This one catches the other
  // half, which is what actually happened: `wallRadiusM` was declared with a
  // range, a unit and 250 words of help, in group 'capture' — and `controlsFor`
  // is called once, for the install, lens and error groups, while
  // `controlsByKey` never named it. So `r_wall` was pinned at its default of
  // 6.0 m, and PARAMETERS.md §8 item 19's sweep of it could not be reproduced by
  // hand on the page that exists to make it reproducible. Nothing looked broken;
  // that is the whole difficulty.
  const laidOut = new Set<string>();

  // `controlsFor(groups, skip)` — every control in those groups except the skips.
  for (const m of MAIN_SOURCE.matchAll(/controlsFor\(\s*(\[[^\]]*\])\s*(?:,\s*(\[[^\]]*\]))?/g)) {
    const groups = [...m[1].matchAll(/'([^']+)'/g)].map((g) => g[1]);
    const skip = new Set([...(m[2] ?? '').matchAll(/'([^']+)'/g)].map((g) => g[1]));
    for (const c of CONTROLS) {
      if (groups.includes(c.group) && !skip.has(c.key)) laidOut.add(c.key);
    }
  }
  // `controlsByKey([...])` — named one at a time.
  for (const m of MAIN_SOURCE.matchAll(/controlsByKey\(\s*\[([^\]]*)\]/g)) {
    for (const k of m[1].matchAll(/'([^']+)'/g)) laidOut.add(k[1]);
  }
  // A chip row is a control too: it does not render a slider, it calls
  // `setSetting` with the key.
  for (const m of MAIN_SOURCE.matchAll(/setSetting\(\s*'([^']+)'/g)) laidOut.add(m[1]);

  assert.ok(laidOut.size > 10, 'the source scan found almost nothing, so it has stopped working');
  for (const c of CONTROLS) {
    assert.ok(
      laidOut.has(c.key),
      `control '${c.key}' ('${c.label}') is declared and no panel lays it out`,
    );
  }
});

test('every option a discrete control offers can actually be chosen', () => {
  // `resolution` declared `max: 3` while RESOLUTIONS grew to five entries, so
  // `coerce` clamped the last chip away: it was rendered, clickable, and
  // unreachable — clicking it selected 3840x2160 instead. The square chip is the
  // one added to demonstrate A-03, that §7's off-sphere-flux gate is unreachable
  // on 16:9 and reachable on a square chip, and the readout's advice for that
  // failing row is "A squarer chip".
  for (const c of CONTROLS) {
    if (!c.options) continue;
    assert.equal(
      c.max,
      c.options.length - 1,
      `'${c.key}' offers ${c.options.length} options and its range stops at ${c.max}`,
    );
    for (let i = 0; i < c.options.length; i++) {
      assert.equal(coerce(c.key, i), i, `'${c.key}' cannot be set to option ${i}`);
    }
  }
});

test('picking an install preset keeps every view-group setting, not most of them', () => {
  // The chip's own caption says picking a preset "leaves both alone" — the
  // viewpoint and what is playing. The call site carried seven of the ten keys
  // `CONTROLS` puts in group 'view', so the graticule spacing, the edge
  // smoothing and the black lift were silently reset, and `matchesInstall`
  // skips exactly those keys, so the chip lit up as matching while having
  // changed three of them.
  //
  // The scan is over the source because there is no DOM here: the requirement
  // is that the call site is driven by the group rather than by a list, which is
  // what stops the eleventh view key being forgotten.
  const pick = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('A preset is an INSTALL'),
    MAIN_SOURCE.indexOf('clearCalibration();', MAIN_SOURCE.indexOf('A preset is an INSTALL')),
  );
  assert.ok(pick.length > 0, 'the preset chip has moved; this test can no longer find it');
  assert.ok(
    /c\.group !== 'view'/.test(pick),
    'the preset chip carries view settings by a hand-written list rather than by group',
  );
  // And through `withSetting`, because `viewRangeM`'s floor tracks `sphereDiaIn`
  // and the preset changes `sphereDiaIn`. Carried verbatim, a range that was
  // legal beside a 40-inch ball survives beside a 68-inch one and the eye ends
  // up inside the shell.
  assert.ok(
    /withSetting\(next, c\.key/.test(pick),
    'the preset chip writes view settings without re-applying their live bounds',
  );
});

test('a one-position capture is refused before it is attempted', () => {
  // Refused, not warned about. A warning beside a number that looks BETTER than
  // the good one is not a warning anybody acts on: the single-camera solve
  // converges in 48 steps to a 0.518 px residual — better than the three-camera
  // solve — and lands 19.6 m from the lenses, and no diagnostic the solver
  // produces says otherwise.
  //
  // Before the capture, because the answer is knowable from the camera count
  // and photographing a sphere for ten seconds to throw the result away is not
  // a courtesy.
  assert.ok(
    /export const MIN_CAMERA_POSITIONS = 2;/.test(MAIN_SOURCE),
    'the minimum is not stated as a named constant',
  );
  const start = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('function startSolve(): void {'),
    MAIN_SOURCE.indexOf('function startSolve(): void {') + 700,
  );
  assert.ok(
    /solveRefusalReason\(state\.cameraCount\)/.test(start),
    'startSolve does not check whether the capture can be calibrated at all',
  );
  assert.ok(
    start.indexOf('return;') < start.indexOf('solveRunning = true'),
    'the refusal happens after the solve has already been started',
  );

  // And the button says why, rather than being live and doing nothing.
  const button = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf("  const solve = el('button'"),
    MAIN_SOURCE.indexOf('actionsEl.append(solve);'),
  );
  assert.ok(/disabled: solveRunning \|\| refusal !== null/.test(button));
  assert.ok(/title:\s*\n?\s*refusal \?\?/.test(button), 'the disabled button gives no reason');
});

test('one predicate decides whether a solve became the calibration', () => {
  // The handler decided whether to install and the drift cells decided
  // separately whether to show the solver's residual, so they could disagree —
  // and a residual shown for a rig that was never installed is the same class of
  // lie as installing it. Both now ask `solveInstalled`.
  assert.ok(/function solveInstalled\(r: SolveResponse\): boolean \{/.test(MAIN_SOURCE));
  const fn = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('function solveInstalled(r: SolveResponse): boolean {'),
    MAIN_SOURCE.indexOf('export const MIN_CAMERA_POSITIONS'),
  );
  assert.ok(/r\.converged/.test(fn), 'the predicate ignores convergence');
  assert.ok(/MIN_CAMERA_POSITIONS/.test(fn), 'the predicate ignores how many views were usable');
  assert.ok(
    /!solveInstalled\(solveResult\)/.test(MAIN_SOURCE),
    'the drift cells do not consult the predicate',
  );
});

test('a solve that never settled is not installed as the calibration', () => {
  // The reply handler wrote `state.compositorRig = msg.recoveredRig` with no
  // reference to `msg.converged`, so a bundle adjustment that stopped at its
  // iteration cap was painted onto the sphere and became the rig every readout
  // describes. Measured on this page: one handheld camera stops at the 400-step
  // cap with a 2.31 px residual and a rig 3.06 m from the lenses.
  //
  // Refusing also has to put the PRE-SOLVE rig back, because `partialRig` draws
  // the sphere from intermediates while the solve runs — leaving the last
  // intermediate up would be worse than either outcome.
  const handler = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('  solveResult = msg;'),
    MAIN_SOURCE.indexOf('let solveSeq = 0;'),
  );
  assert.ok(handler.length > 0, 'the solve reply handler has moved');
  assert.ok(
    /!msg\.converged/.test(handler),
    'the recovered rig is installed without checking that the solve converged',
  );
  // The install must sit behind the check, not beside it.
  assert.ok(
    handler.indexOf('!msg.converged') <
      handler.indexOf('state.compositorRig = msg.recoveredRig'),
    'the rig is installed before the convergence check can refuse it',
  );
  assert.ok(
    /state\.compositorRig = beforeRig \?\? null/.test(handler),
    'a refused solve leaves the last partial rig on screen',
  );
});

test('the parity verdict is retired by the same events that retire its reply', () => {
  // `viewKey` retires a reply IN FLIGHT, which is only consulted when one
  // arrives. The partial-rig path deliberately requests no pass — "draw with it;
  // compute nothing from it" — so with a solve running and nothing in flight,
  // widening `viewKey` alone leaves the previous rig's verdict on screen for the
  // whole solve, beside a picture drawn from a rig it has never seen. Retiring
  // the reply and retiring the verdict are two different jobs and the first
  // version of this fix only did the first.
  const partial = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('      state.compositorRig = msg.partialRig;'),
    MAIN_SOURCE.indexOf('      state.compositorRig = msg.partialRig;') + 700,
  );
  assert.ok(partial.length > 0, 'the partial-rig handler has moved');
  assert.ok(
    /^\s*parity = null;$/m.test(partial),
    'installing a partial rig leaves the previous rig’s verdict on screen',
  );
  assert.ok(
    partial.indexOf('parity = null') < partial.indexOf('markDirty()'),
    'the frame is redrawn before the verdict it invalidates is cleared',
  );

  // And the key itself has to be total. Naming fields by hand is correct only
  // until the next setting is added, so it names `state.settings` wholesale —
  // plus the two inputs that do not live there.
  const key = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('function viewKey(): string {'),
    MAIN_SOURCE.indexOf('function paritySamples(): number {'),
  );
  assert.ok(key.length > 0, 'viewKey has moved');
  for (const field of ['state.settings', 'state.compositorRig', 'viewShiftFrac()', 'suppliedName()']) {
    assert.ok(key.includes(field), `viewKey does not carry ${field}`);
  }
  assert.ok(
    !/state\.settings\./.test(key.slice(key.indexOf('return JSON.stringify'))),
    'viewKey is back to naming settings one at a time',
  );
});

test('two different pictures cannot share one supplied-image id', () => {
  // `${file.name}:${file.size}` names a FILE, not pixels: re-export a photo at
  // the same byte length, or crop and re-save to the same length, and the id is
  // unchanged — so `viewKey` calls a reply rendered from the OLD image current
  // against the new one on the GPU. That is the false disagreement
  // `ModelRequest.customImage` already records having been caught by once, at
  // 15%, which was two pictures rather than two models. Video frames already
  // carried a monotonic tail; stills did not.
  assert.ok(
    /customName = `\$\{file\.name\}:\$\{file\.size\}#\$\{\+\+customImageSeq\}`/.test(MAIN_SOURCE),
    'a supplied still is identified by name and byte length alone',
  );
  assert.ok(
    /let customImageSeq = 0;/.test(MAIN_SOURCE),
    'the still counter is not declared',
  );
});

test('the page never states convergence it did not get', () => {
  // Both sentences asserted it unconditionally. The worker's progress line read
  // "Bundle adjustment converged in N iterations" whatever happened, and the
  // report block read "Converged in N steps — hit the cap", which asserts the
  // claim and then withdraws it in a subordinate clause.
  const PIPELINE = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pipeline.ts'),
    'utf8',
  );
  const progress = PIPELINE.slice(PIPELINE.indexOf("    'score',"), PIPELINE.indexOf("  const recovery = scoreRecovery("));
  assert.ok(progress.length > 0, 'the score progress report has moved');
  assert.ok(
    /solver\.diagnostics\.converged\s*$|solver\.diagnostics\.converged\s*\n?\s*\?/m.test(progress),
    'the worker reports convergence without testing it',
  );
  assert.ok(!/Converged in \$\{r\.iterations\} steps`/.test(MAIN_SOURCE));
  assert.ok(
    MAIN_SOURCE.includes('Did NOT converge'),
    'the report block has no branch for a solve that did not converge',
  );
});

test('a slider drag belongs to one pointer', () => {
  // The handler put `pointermove`/`pointerup` on `window` — correctly, because
  // the track node is replaced whenever the panel re-renders — but with no
  // reference to which pointer started the drag. On a touchscreen the settings
  // sheet sits over the sphere, so a second finger orbiting the ball wrote its
  // own clientX into the slider, and that finger's `pointerup` tore the
  // listeners down and set `sliderDragging` false while the reader's finger was
  // still on the track. The drag went dead mid-gesture and `renderControls`
  // rebuilt the panel underneath it, which reads as the page freezing.
  const handler = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf("track.addEventListener('pointerdown'"),
    MAIN_SOURCE.indexOf("window.addEventListener('pointercancel', up);"),
  );
  assert.ok(handler.length > 0, 'the slider drag handler has moved');
  assert.ok(
    /const owner = e\.pointerId/.test(handler),
    'the drag does not record which pointer owns it',
  );
  assert.ok(
    /ev\.pointerId !== owner/.test(handler),
    'the move and up listeners answer to any pointer in the window',
  );
  assert.ok(
    /if \(sliderDragging\) return;/.test(handler),
    'a second pointerdown can register a second set of listeners on the same track',
  );
});

test('Reset re-fits the field of view instead of installing the desktop one', () => {
  // `PERFECT_PRESET.viewFovDeg` is Boulder's desktop 71, which across a 390x844
  // screen is the 114-degree vertical frustum `portraitFovDeg` exists to
  // prevent. Every other writer of that key respects it — the viewpoint chips
  // and `fitFirstScreen` — and Reset, whose whole job is to put everything back,
  // was the one that did not. It also poisoned the refit: `fitFirstScreen`
  // overwrites only while the value is still the one it wrote, so installing a
  // foreign one gave up ownership for the life of the page and rotating the
  // phone stopped fixing anything.
  const handler = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf("const reset = el('button'"),
    MAIN_SOURCE.indexOf('actionsEl.append(reset);'),
  );
  assert.ok(handler.length > 0, 'the Reset button has moved');
  assert.ok(/PERFECT_PRESET/.test(handler), 'Reset no longer installs the preset at all');
  assert.ok(
    /fittedFov = null/.test(handler) && /fitFirstScreen\(\)/.test(handler),
    'Reset installs a field of view without re-fitting it to the viewport',
  );
});

test('the standing distance stays outside the ball when the ball changes size', () => {
  // The rule `withSetting` enforces, checked at the range the preset chip walks
  // between: 40 inches is the smallest ball and 68 the preset's, so a camera
  // legal at the first must be pushed out at the second rather than left inside.
  const close = withSetting({ ...BOULDER_PRESET, sphereDiaIn: 40 }, 'viewRangeM', 0.6);
  assert.ok(close.viewRangeM < 0.96, 'the fixture is not close enough to prove anything');
  const grown = withSetting(close, 'sphereDiaIn', 68);
  const radiusM = (68 * 0.0254) / 2;
  assert.ok(
    grown.viewRangeM > radiusM,
    `the eye is ${(radiusM - grown.viewRangeM).toFixed(3)} m inside a ${radiusM.toFixed(3)} m sphere`,
  );
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

test('the warp export ships the calibration the software believes, never ground truth', () => {
  // The one decision in this button that can be silently wrong, and it is
  // invisible on screen either way: `displayModel` returns BOTH rigs, and they
  // differ only in a simulator. `content` is `world.compositorRig` — the config
  // as written before a solve, what the solve recovered after one — and it is
  // what an operator would load. `physical` is `world.truthRig`, ground truth the
  // solver never sees. Exporting from `physical` would write a flawless warp file
  // here and a file that cannot exist in a real dome, and every test that only
  // checked the file PARSED would still pass.
  //
  // The scan is over the source because there is no DOM here.
  const fn = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('function exportWarpFiles(): void {'),
    MAIN_SOURCE.indexOf('function renderTopButtons(): void {'),
  );
  assert.ok(fn.length > 0, 'the warp exporter has moved; this test can no longer find it');
  assert.ok(
    /displayModel\(world\)\.content/.test(fn),
    'the warp export does not build from the compositor rig',
  );
  assert.ok(
    !/\.physical/.test(fn),
    'the warp export reaches for the truth rig, which is ground truth the solver never sees',
  );
  // And it is reachable: a handler nothing calls is a button that does nothing.
  assert.ok(
    /warp\.addEventListener\('click', exportWarpFiles\)/.test(MAIN_SOURCE),
    'the warp button is not wired to the exporter',
  );
});

test('the page hands a file to the browser without leaving anything in the DOM', () => {
  // `downloadText` is the page's only download path and the mirror of
  // `pickImage`, which is the page's only upload path: both create an element,
  // use it, and never insert it. An anchor left in the document would survive
  // the next `replaceChildren` and accumulate one dead node per export.
  const fn = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('function downloadText(name: string, text: string): void {'),
    MAIN_SOURCE.indexOf('function exportWarpFiles(): void {'),
  );
  assert.ok(fn.length > 0, 'the download helper has moved; this test can no longer find it');
  assert.ok(!/append|insertBefore|body\./.test(fn), 'the download anchor is inserted into the page');
  assert.ok(
    /URL\.revokeObjectURL/.test(fn),
    'the object URL is never revoked, so every export pins its blob for the life of the document',
  );
});
