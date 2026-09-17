// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The emission plan — placement, order, and whether the window can carry it.
 *
 * Everything here is asserted against the CONVENTION rather than against the
 * implementation: the slot table in conventions.ts §N.2, the bottom-left
 * viewport origin in §V, and `planFrames`' own pairing rule. A test that
 * recomputed `emit.ts`'s arithmetic a second way would pass whenever the two
 * copies agreed, including when both were wrong.
 *
 * The four failures worth naming, because each is silent on the sphere:
 *
 *  1. **The wrong quadrant.** A two-projector rig whose second projector is
 *     placed in slot 1 rather than slot 2 lights a projector the config calls
 *     P2 and files it under P3. The pattern still looks right in the room.
 *  2. **The flip.** SOS viewports have their origin at bottom-left and a canvas
 *     has it at top-left. Passing `y` through unchanged puts P1's raster in the
 *     wrong half of the framebuffer, and nothing about the picture says so.
 *  3. **Interleaved projectors.** A Gray plane separated from its own complement
 *     by a whole rig breaks the cancellation the decode rests on, and produces
 *     a capture that decodes into a confidently wrong calibration.
 *  4. **A window that is not the framebuffer.** Then the browser resamples every
 *     frame and the solve measures the resampling too.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_PLACEABLE_PROJECTORS,
  MIN_STRIDE_PX,
  emitOrder,
  quadrantName,
  quadrantViewports,
  projectorSlots,
  rasterFit,
  rigFit,
  viewportPixels,
} from '../src/emit.ts';
import { NOMINAL_SLOTS_BY_COUNT } from '../../calibration/src/conventions.ts';
import { SOS_QUADRANT_VIEWPORTS } from '../../sim/src/scene.ts';
import { DEFAULT_PATTERN_PLAN, planFrames } from '../../bench/src/patterns.ts';

test('a projector takes its SLOT’s quadrant, which is not its index', () => {
  for (let count = 1; count <= MAX_PLACEABLE_PROJECTORS; count++) {
    const slots = projectorSlots(count);
    assert.deepEqual([...slots], [...NOMINAL_SLOTS_BY_COUNT[count]], `N=${count}`);
    assert.deepEqual(
      [...quadrantViewports(count)],
      slots.map((s) => SOS_QUADRANT_VIEWPORTS[s]),
      `N=${count} viewports`,
    );
  }
  // The one case where slot and index differ, spelled out. §2 darkens quadrants
  // rather than respacing, A-06 settles the opposed pair, and `nominalRig` names
  // these two projectors P1 and P3 — so an operator writing "P3" on a photograph
  // is naming the same projector their config does.
  const two = quadrantViewports(2);
  assert.equal(two.length, 2);
  assert.deepEqual(two[0], SOS_QUADRANT_VIEWPORTS[0]);
  assert.deepEqual(two[1], SOS_QUADRANT_VIEWPORTS[2]);
  assert.notDeepEqual(two[1], SOS_QUADRANT_VIEWPORTS[1], 'slot 2, not projector index 1');
});

test('the quadrant is named as the operator sees it on the wall', () => {
  const named = SOS_QUADRANT_VIEWPORTS.map(quadrantName);
  // The config's own order, PARAMETERS.md §3.4, with the bottom-left origin:
  // bottom-left, bottom-right, top-left, top-right. Slot 2 is the TOP-left, so a
  // label derived from the index would call it "third" and mean nothing.
  assert.deepEqual(named, ['bottom-left', 'bottom-right', 'top-left', 'top-right']);
});

test('more projectors than the framebuffer lays out are refused, not guessed', () => {
  for (const count of [5, 6, 8]) {
    assert.throws(
      () => quadrantViewports(count),
      (err: Error) => {
        assert.match(err.message, /cannot be placed/);
        // The message has to name the MISSING thing. An operator who reads only
        // "unsupported" learns that the tool is limited; what is actually true
        // is that their display's layout is not written down anywhere here.
        assert.match(err.message, /display pipeline/);
        assert.match(err.message, /Supply the framebuffer layout/);
        return true;
      },
      `N=${count}`,
    );
  }
  // Eight is the app shader's cap and is deliberately not this page's cap: the
  // shader never has to address a real output. If that ever stops being the
  // reason, this test is where the difference is stated.
  assert.throws(() => quadrantViewports(8), /carries eight because it never has to address/);
  for (const bad of [0, -1, 2.5, Number.NaN]) {
    assert.throws(() => quadrantViewports(bad), /whole number of projectors/, `N=${bad}`);
  }
});

test('the quadrants tile an odd framebuffer exactly — no seam, no overlap', () => {
  // Odd in both dimensions, which is where a `x + w` right edge leaves an unlit
  // column down the middle. A row of a projector's raster that nothing emits is
  // a band of the sphere nothing addresses.
  const W = 2561;
  const H = 1601;
  const cover = new Uint8Array(W * H);
  for (const v of quadrantViewports(4)) {
    const r = viewportPixels(v, W, H);
    assert.ok(r.w > 0 && r.h > 0, `${JSON.stringify(v)} came out empty`);
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) cover[y * W + x]++;
    }
  }
  let uncovered = 0;
  let doubled = 0;
  for (let i = 0; i < cover.length; i++) {
    if (cover[i] === 0) uncovered++;
    else if (cover[i] > 1) doubled++;
  }
  assert.equal(uncovered, 0, `${uncovered} framebuffer pixels belong to no projector`);
  assert.equal(doubled, 0, `${doubled} framebuffer pixels belong to two projectors`);
});

test('slot 0 is the LOWER half of the canvas, because the viewport origin is not', () => {
  // conventions.ts §V: `Viewport` is normalized with its origin at BOTTOM-left,
  // matching the SOS config. A canvas has it at top-left. Slot 0 is P1, the
  // projector nearest the SOS computer; if this lands in the upper half then
  // every photograph of P1 is filed under P3 and the pattern looks fine.
  const H = 1000;
  const bottomLeft = viewportPixels(SOS_QUADRANT_VIEWPORTS[0], 1000, H);
  const topLeft = viewportPixels(SOS_QUADRANT_VIEWPORTS[2], 1000, H);
  assert.equal(bottomLeft.y, H / 2, 'slot 0 starts halfway down the canvas');
  assert.equal(topLeft.y, 0, 'slot 2 starts at the top of the canvas');
  assert.ok(bottomLeft.y > topLeft.y, 'a pass-through of v.y would reverse these');
  // And left/right is NOT flipped, so a blanket transpose would fail here.
  const bottomRight = viewportPixels(SOS_QUADRANT_VIEWPORTS[1], 1000, H);
  assert.equal(bottomLeft.x, 0);
  assert.equal(bottomRight.x, 500);
});

test('the capture is every frame on every projector, counted from one', () => {
  const plan = DEFAULT_PATTERN_PLAN;
  const frames = planFrames(plan).length;
  for (let count = 1; count <= MAX_PLACEABLE_PROJECTORS; count++) {
    const steps = emitOrder(count, plan);
    assert.equal(steps.length, count * frames, `N=${count}`);
    for (let i = 0; i < steps.length; i++) {
      assert.equal(steps[i].ordinal, i + 1, `step ${i} ordinal`);
      assert.equal(steps[i].projector, Math.floor(i / frames), `step ${i} projector`);
      assert.equal(steps[i].frame, i % frames, `step ${i} frame`);
    }
  }
  // The number the plan is costed against: four projectors at the page's own
  // settings is 34 frames each, 136 per camera position.
  assert.equal(frames, 34);
  assert.equal(emitOrder(4, plan).length, 136);
});

test('no Gray plane is ever separated from its own complement', () => {
  // The property the grouping exists to protect, checked on the emitted order
  // rather than on `planFrames` — interleaving projectors would leave
  // `planFrames` untouched and break exactly this.
  const plan = DEFAULT_PATTERN_PLAN;
  const specs = planFrames(plan);
  const steps = emitOrder(4, plan);
  let pairs = 0;
  for (let i = 0; i < steps.length; i++) {
    const spec = specs[steps[i].frame];
    if (spec.kind !== 'gray') continue;
    const next = steps[i + 1];
    assert.ok(next !== undefined, `Gray plane at step ${i + 1} is the last thing shot`);
    const nextSpec = specs[next.frame];
    assert.equal(nextSpec.kind, 'grayInverse', `step ${i + 2} should be the complement`);
    assert.equal(nextSpec.axis, spec.axis);
    assert.equal(nextSpec.index, spec.index);
    assert.equal(next.projector, steps[i].projector, 'and on the same projector');
    pairs++;
  }
  assert.equal(pairs, 4 * 2 * plan.grayBits, 'every plane on every projector was checked');
});

test('a window that is the framebuffer resamples nothing', () => {
  const fit = rasterFit({ w: 1920, h: 1200 }, 1920, 1200, DEFAULT_PATTERN_PLAN);
  assert.equal(fit.exact, true);
  assert.equal(fit.scaleX, 1);
  assert.equal(fit.scaleY, 1);
  assert.equal(fit.problem, null);
  assert.equal(fit.fatal, false);
  // 1920 / 2^6 = 30 across, 1200 / 2^6 = 18.75 down. The binding axis is the
  // one with fewer pixels, and it is the one the fringe has to live on.
  assert.equal(fit.finestStridePx, 1200 / 64);
});

test('a window that is not the framebuffer says so, with the scale', () => {
  const fit = rasterFit({ w: 960, h: 600 }, 1920, 1200, DEFAULT_PATTERN_PLAN);
  assert.equal(fit.exact, false);
  assert.equal(fit.fatal, false, 'still emits a decodable pattern, just not a faithful one');
  assert.equal(fit.scaleX, 0.5);
  assert.match(fit.problem ?? '', /960×600/);
  assert.match(fit.problem ?? '', /1920×1200/);
  assert.match(fit.problem ?? '', /0\.500/);
});

test('a grid too coarse for the fringe is fatal, and says which number to change', () => {
  // 2^6 = 64 strips across 100 pixels is 1.56 px a strip, so a fringe period is
  // 3.1 px — under the four a cosine needs to still be one.
  const plan = DEFAULT_PATTERN_PLAN;
  const fit = rasterFit({ w: 100, h: 100 }, 100, 100, plan);
  assert.equal(fit.fatal, true);
  assert.ok(fit.finestStridePx < MIN_STRIDE_PX);
  assert.match(fit.problem ?? '', /One fringe period is two strips/);
  assert.match(fit.problem ?? '', new RegExp(`${plan.grayBits - 1} Gray`));
  // The plan is part of the capture's identity: a page that quietly dropped a
  // bit would emit one sequence and leave the decode expecting another.
  assert.match(fit.problem ?? '', /record that you did/);
  // Exactly at the floor is not fatal: 2^6 strips across 128 px is 2.00 each.
  const edge = rasterFit({ w: 128, h: 128 }, 128, 128, plan);
  assert.equal(edge.finestStridePx, MIN_STRIDE_PX);
  assert.equal(edge.fatal, false);
});

test('a big window cannot rescue a raster too coarse to carry the fringe', () => {
  // Review's counter-example, and the first version of this check passed it: a
  // 100x100 projector in a 128x128 quadrant has a CANVAS stride of 2.00, which
  // clears the floor, and a NATIVE stride of 1.56, which does not. The display
  // resamples the window down onto that raster on the way out, so the projector
  // emits the undersampled signal — the canvas measurement was of a grid the
  // light does not finally live on.
  const plan = DEFAULT_PATTERN_PLAN;
  const fit = rasterFit({ w: 128, h: 128 }, 100, 100, plan);
  assert.equal(fit.fatal, true, 'a canvas stride of 2.00 must not clear a native stride of 1.56');
  assert.equal(fit.binding, 'raster');
  assert.equal(fit.finestStridePx, 100 / 64);
  // And it must not send the operator after the wrong number.
  assert.match(fit.problem ?? '', /100×100 raster you named/);
  assert.match(fit.problem ?? '', /A larger window cannot fix this/);
  // The mirror case still names the window, so the message tracks the grid.
  const narrow = rasterFit({ w: 100, h: 100 }, 1920, 1200, plan);
  assert.equal(narrow.binding, 'window');
  assert.match(narrow.problem ?? '', /this 100×100 window/);
  assert.match(narrow.problem ?? '', /Open a larger window/);
});

test('the fit is the whole rig’s, not the first quadrant’s', () => {
  const plan = DEFAULT_PATTERN_PLAN;
  // 1281 is odd, so `viewportPixels` gives the left quadrants 641 columns and
  // the right ones 640. Declaring 641 makes projector 0 exact and projector 1
  // resampled — and a verdict read off projector 0 alone would call the rig
  // exact while a projector beside it was being resampled.
  const fit = rigFit(4, 1281, 800, 641, 400, plan);
  assert.equal(fit.perProjector.length, 4);
  assert.equal(fit.perProjector[0].exact, true, 'projector 0 really is exact');
  assert.equal(fit.allExact, false, 'but the rig is not');
  assert.equal(fit.worst.exact, false);
  assert.ok(fit.worstProjector !== 0, `worst should not be the exact one, got ${fit.worstProjector}`);
  assert.equal(fit.anyFatal, false);

  // An even framebuffer with a matching raster is exact everywhere.
  const clean = rigFit(4, 1280, 800, 640, 400, plan);
  assert.equal(clean.allExact, true);
  assert.equal(clean.worst.problem, null);
  assert.equal(clean.anyFatal, false);

  // Fatal outranks merely inexact when choosing what to report.
  const bad = rigFit(4, 1280, 800, 100, 100, plan);
  assert.equal(bad.anyFatal, true);
  assert.equal(bad.worst.fatal, true);
});

test('every element the emitter page reaches for exists in its markup', () => {
  // The emit page has no browser smoke coverage — `tools/smoke-app.ts` drives
  // the simulator page only — so a mistyped id here is caught by nobody until
  // an operator opens the page and gets a blank screen. `web/emit.ts` casts
  // every lookup (`as HTMLButtonElement`), so a missing id is `null` wearing a
  // type, and the failure is a TypeError at the first `addEventListener`.
  //
  // This is the cheapest guard that actually holds: parse both files and check
  // the module never reaches for something the markup does not have.
  const root = path.resolve(fileURLToPath(import.meta.url), '../../../..');
  const html = fs.readFileSync(path.join(root, 'packages/web/emit.html'), 'utf8');
  const module_ = fs.readFileSync(path.join(root, 'packages/web/web/emit.ts'), 'utf8');

  const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const wanted = [...module_.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(wanted.length > 10, `expected the page to reach for many ids, found ${wanted.length}`);
  const missing = [...new Set(wanted)].filter((id) => id !== undefined && !present.has(id));
  assert.deepEqual(missing, [], `emit.ts reaches for ids emit.html does not define`);
});
