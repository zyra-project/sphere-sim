// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The metrics worker's request handling.
 *
 * Mostly this is about ONE bug, because it is the bug the page's own parity
 * check caught and it is the kind that would have been invisible without it: the
 * worker cannot see the file a user dropped, so a supplied image has to be sent
 * across the boundary — and while it was not, the GPU drew the image, the CPU
 * drew the fallback, and the two renderers reported a 15% disagreement that
 * belonged to neither model.
 *
 * Sending it on every request would cost a megabyte of float per slider drag, so
 * it is sent once and cached by id. That makes a second failure possible — a
 * cached image used for a request naming a different one — which is what most of
 * these check.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createImage } from '../../sim/src/equirect.ts';
import type { EquirectImage } from '../../sim/src/equirect.ts';
import { BOULDER_PRESET, CONTENT_CUSTOM, PERFECT_PRESET, noNudge, withNudge } from '../src/settings.ts';
import { buildWorld } from '../src/rigs.ts';
import { computeModel, computeSurface } from '../src/model.ts';
import type { ModelRequest, SurfaceRequest } from '../src/protocol.ts';
import type { SurfaceResponse } from '../src/protocol.ts';
import type { ProjectorPlacement } from '../../sim/src/placement.ts';
import type { SurfaceMesh } from '../../calibration/src/index.ts';

/** A field of one value, so a render's mean says which image was used. */
function flat(value: number): EquirectImage {
  const img = createImage(64, 32);
  img.data.fill(value);
  return img;
}

function request(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    kind: 'model',
    id: 1,
    settings: { ...BOULDER_PRESET, content: CONTENT_CUSTOM, gridOn: 0 },
    compositorRig: null,
    densityScale: 0.25,
    parity: {
      width: 32,
      height: 24,
      fovHDeg: 50,
      position: { x: 6.2, y: 0, z: 1 },
      target: { x: 0, y: 0, z: 0 },
      samplesPerPixel: 1,
      imageShift: 0,
    },
    projectorPreviewWidth: 0,
    customImage: null,
    customImageId: '',
    ...over,
  };
}

/** Mean radiance of the parity render — a proxy for "which image was used". */
function meanOf(reply: ReturnType<typeof computeModel>): number {
  const img = reply.parityImage;
  assert.ok(img, 'the request asked for a parity render and got none');
  let sum = 0;
  for (let i = 0; i < img.data.length; i++) sum += img.data[i];
  return sum / img.data.length;
}

test('a supplied image is used, and a brighter one renders brighter', () => {
  const dim = meanOf(computeModel(request({ customImage: flat(0.1), customImageId: 'dim' })));
  const bright = meanOf(computeModel(request({ customImage: flat(0.9), customImageId: 'bright' })));
  assert.ok(bright > dim * 2, `expected the brighter image to render brighter: ${dim} vs ${bright}`);
});

test('the image is cached, so a request that omits it still gets it', () => {
  const first = meanOf(computeModel(request({ customImage: flat(0.9), customImageId: 'marble' })));
  // The page sends the id alone on every subsequent request.
  const second = meanOf(computeModel(request({ customImage: null, customImageId: 'marble' })));
  assert.ok(Math.abs(second - first) < 1e-6, 'the cached image was not used');
});

test('a request naming an image the worker never received falls back, silently but not wrongly', () => {
  computeModel(request({ customImage: flat(0.9), customImageId: 'marble' }));
  const stale = meanOf(computeModel(request({ customImage: null, customImageId: 'a-different-file' })));
  const marble = meanOf(computeModel(request({ customImage: null, customImageId: 'marble' })));
  assert.ok(
    Math.abs(stale - marble) > 1e-6,
    'a request for an unknown image reused the cached one — the page would show the wrong picture',
  );
});

test('clearing the image clears the cache', () => {
  computeModel(request({ customImage: flat(0.9), customImageId: 'marble' }));
  const cleared = meanOf(
    computeModel(request({ settings: { ...BOULDER_PRESET, content: 0, gridOn: 0 }, customImageId: '' })),
  );
  // Content 0 is the black field, so a cleared cache renders near-dark; if the
  // bright image were still in play this would be nowhere near zero.
  assert.ok(cleared < 0.05, `expected the black field after clearing, got ${cleared}`);
});

test('the metrics are unaffected by which image is playing', () => {
  // The geometric gates generate their own graticule — `metrics/grid.ts` says so
  // and explains why — so the content a visitor chose must never move a number
  // the page reports against §7. If this ever fails, a gate has started
  // depending on the picture.
  const a = computeModel(request({ customImage: flat(0.1), customImageId: 'dim' }));
  const b = computeModel(request({ customImage: flat(0.9), customImageId: 'bright' }));
  assert.equal(a.gridWorstMm, b.gridWorstMm);
  assert.deepEqual(a.multiplicityAreaFraction, b.multiplicityAreaFraction);
  assert.equal(a.unlitPolarSouth, b.unlitPolarSouth);
});

test('a slider position the panel offers does not take the panel down', () => {
  // 'Lens rise above the equator' runs to 1.4 m. §4.2's proof that overlap
  // multiplicity never exceeds 2 assumes lenses at or near the equator, and it
  // stops holding once a lens is more than a sphere radius above the centre —
  // the north pole comes into view of all four at once. `computeCoverageStats`
  // throws on that, which is right for a batch run and wrong for a page where a
  // human drags the slider: every number froze under a red box carrying sim's
  // engineer text, roughly sixty per cent along a slider whose own help text
  // invites the reader up it. `packages/harness` reached the same conclusion.
  for (const lensRiseM of [0.2032, 0.9, 1.0, 1.4]) {
    const reply = computeModel(request({ settings: { ...BOULDER_PRESET, lensRiseM } }));
    assert.ok(reply.readings.length > 0, `the model died at lensRiseM = ${lensRiseM}`);
  }

  // And the reading is not lost: the fact that carries it reports the number
  // with a gate of 2, which is the whole point of not throwing. Its failure arm
  // was unreachable while the assertion was inherited.
  const high = computeModel(request({ settings: { ...BOULDER_PRESET, lensRiseM: 1.4 } }));
  const fact = high.facts.find((f) => f.label === 'Most projectors on one spot');
  assert.ok(fact, 'the multiplicity fact is gone');
  assert.equal(fact.ok, false, 'a four-way overlap was reported as fine');
  assert.ok(Number(fact.value) > 2);
  // It must not claim a code bug — this is geometry §4.2 does not cover, not a
  // defect, and the note said "the code has a bug" while it could never render.
  assert.doesNotMatch(fact.note, /the code has a bug/);

  const level = computeModel(request({ settings: { ...BOULDER_PRESET, lensRiseM: 0.2032 } }));
  const ok = level.facts.find((f) => f.label === 'Most projectors on one spot');
  assert.equal(ok?.ok, true);
  assert.equal(ok?.value, '2');
});

test('a projector bumped in roll alone is drift, not a rig that is up to date', () => {
  // The 'Lens aim' cell shows this number until a solve lands and the solver's
  // roll-inclusive residual afterwards, under a tooltip saying "same basis". The
  // drift was the angle between forward axes, which roll leaves fixed, so a
  // pure-roll bump read 0.000° — and then recalibrating made the cell go UP.
  // Roll is not exotic: it is a slider on the projector tab and the largest of
  // §2's three angular mount tolerances at 0.5°.
  const rolled = (deg: number) => ({
    ...PERFECT_PRESET,
    nudge: PERFECT_PRESET.nudge.map((n, i) => (i === 1 ? { ...noNudge(), rollDeg: deg } : noNudge())),
  });
  const still = computeModel(request({ settings: rolled(0) }));
  assert.ok(still.driftAimDeg < 1e-9, 'an untouched rig has drifted');

  for (const deg of [0.5, 3]) {
    const reply = computeModel(request({ settings: rolled(deg) }));
    assert.ok(
      Math.abs(reply.driftAimDeg - deg) < 1e-6,
      `a ${deg}° roll reported ${reply.driftAimDeg.toFixed(4)}° of aim drift`,
    );
    // The position term is genuinely unmoved — roll is a rotation about the
    // lens, so this is the pair being right rather than both being wrong.
    assert.ok(reply.driftPositionMm < 1e-9);
  }
});

test('projector frames are rendered only when asked for', () => {
  const none = computeModel(request({ projectorPreviewWidth: 0 }));
  // Slot-indexed, so the array is always as long as the panel has projectors and
  // the entries are null when no frames were asked for.
  assert.equal(none.projectorFrames.filter(Boolean).length, 0);

  const some = computeModel(request({ projectorPreviewWidth: 64, parity: null }));
  assert.equal(some.projectorFrames.length, BOULDER_PRESET.nudge.length);
  assert.equal(some.projectorFrames.filter(Boolean).length, BOULDER_PRESET.projectorCount);
  for (const f of some.projectorFrames) {
    if (!f) continue;
    assert.equal(f.width, 64);
    assert.ok(f.height > 0 && f.height < 64, 'a 16:9 raster should come back wider than it is tall');
    assert.ok(/^P[1-4] — \d+ × \d+$/.test(f.caption), `unhelpful caption: '${f.caption}'`);
    assert.equal(f.space, 'display', 'a projector frame is a video signal, not radiance');
  }
});

test('switching a projector off leaves a hole rather than renaming its neighbours', () => {
  // The bug this indexing exists to prevent. A projector switched off is dropped
  // from the RIG — §2's "quadrants go dark" — so without a slot map every
  // projector after it inherits its neighbour's frame, colour and name, and every
  // one of them looks entirely plausible.
  const nudge = BOULDER_PRESET.nudge.map((n, i) => ({ ...n, on: i !== 1 }));
  const res = computeModel(
    request({ settings: { ...BOULDER_PRESET, nudge }, projectorPreviewWidth: 48, parity: null, id: 9 }),
  );
  assert.deepEqual(res.live, [true, false, true, true]);
  assert.equal(res.projectorFrames[1], null, 'P2 is off and must have no frame');
  assert.equal(res.meshes[1], null);
  assert.equal(res.projectorConfig[1], null);
  // …and P3 is still P3.
  assert.ok(res.projectorFrames[2]?.caption.startsWith('P3'), res.projectorFrames[2]?.caption);
  assert.equal(res.meshes[2]?.projectorId, 'P3');
  assert.equal(res.meshes[3]?.projectorId, 'P4');
});

test('the seam patch has both projectors drawing the same lines, and closes when the rig is true', () => {
  // The doubled line is the product's whole subject and it is the one thing the
  // page never drew. What makes the picture worth anything is that it is the
  // composition of BOTH rigs — where the compositor thinks a point is, thrown by
  // the lens that actually exists.
  const perfect = computeModel(request({ settings: { ...PERFECT_PRESET, gridOn: 1 } }));
  assert.equal(perfect.seams.length, 4, 'four projectors make four seams');
  for (const s of perfect.seams) {
    assert.ok(s.worstMm < 0.5, `a true rig should agree at the seam, not by ${s.worstMm} mm`);
    assert.ok(
      s.lines.some((l) => l.which === 0) && s.lines.some((l) => l.which === 1),
      `the seam between P${s.a + 1} and P${s.b + 1} only has one projector drawing it`,
    );
    for (const l of s.lines) {
      assert.equal(l.lonDeg.length, l.dLonDeg.length);
      assert.equal(l.lonDeg.length, l.latDeg.length);
    }
  }

  // Anchored on the lowest slot and going round the ring, so the picker does not
  // renumber itself when the recovered azimuths move by a hair.
  assert.deepEqual(
    perfect.seams.map((s) => [s.a, s.b]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ],
  );

  // Knock P1 and its two seams open; the seam on the far side stays shut.
  const bumped = computeModel(
    request({ settings: withNudge({ ...PERFECT_PRESET, gridOn: 1 }, 0, { yawDeg: 0.25 }) }),
  );
  const at = (a: number, b: number) => bumped.seams.find((s) => s.a === a && s.b === b);
  assert.ok(at(0, 1)!.worstMm > 5, 'the bumped projector should disagree with its neighbour');
  assert.ok(at(3, 0)!.worstMm > 5, 'and with its other neighbour');
  assert.ok(at(1, 2)!.worstMm < 0.5, 'the seam on the far side of the ring is untouched');
});

/**
 * A recovered calibration outlives a bump, on purpose — the whole demonstration
 * is that the software goes on sending what it sent before. It must NOT outlive
 * a change to which projectors are in the room.
 *
 * The two rigs are flat lists, and `metrics/registration.ts` indexes one by the
 * other's length. Hand it a four-projector belief about a three-projector room
 * and it reads past the end of the array and dies inside `pixelToRay`, which the
 * worker turns into `ok: false` — and the page, which keeps the last good model
 * on screen under the error, goes on showing every number from a rig that is no
 * longer there. A readout that looks live is worse than one that is blank.
 *
 * The page clears the calibration on both controls that can cause this. This
 * checks the layer underneath, because "should be unreachable" is not a check.
 */
test('a compositor rig for a different set of projectors is refused, not indexed past', () => {
  const four = buildWorld({ ...PERFECT_PRESET }).compositorRig;
  assert.equal(four.projectors.length, 4, 'the fixture is a four-projector rig');

  for (const [what, settings] of [
    ['the count dropped to three', { ...PERFECT_PRESET, projectorCount: 3 }],
    ['one was switched off at the wall', withNudge(PERFECT_PRESET, 1, { on: false })],
  ] as const) {
    const reply = computeModel(request({ settings, compositorRig: four, parity: null }));
    assert.ok(
      Number.isFinite(reply.gridWorstMm),
      `${what}: the model should still produce a number, got ${reply.gridWorstMm}`,
    );
    // Refused means "fall back to the config as written", which is exactly the
    // state a page with no calibration is in — so there is nothing to compare
    // the calibration against.
    assert.equal(reply.gridBaselineMm, null, `${what}: the stale rig was used anyway`);
  }
});

test('computeSurface lights a dropped model and reports what it is', () => {
  // A hollow box: convex from outside, so nothing shadows — the control.
  const box = boxMesh(0.5);
  const req: SurfaceRequest = {
    kind: 'surface',
    id: 1,
    settings: BOULDER_PRESET,
    mesh: box,
    width: 48,
    height: 36,
    camera: { azimuthDeg: 35, elevationDeg: 10, rangeM: 6, fovHDeg: 50 },
  };
  const reply = computeSurface(req);
  assert.equal(reply.ok, true);
  assert.ok(reply.frame !== null, 'a model must produce a picture');
  assert.equal(reply.frame.width, 48);
  assert.ok(reply.frame.data.some((v) => v > 0), 'the picture must not be empty');
  // A room view is radiance. Labelling it 'display' would encode it twice on the
  // way to the canvas.
  assert.equal(reply.frame.space, 'linear');

  const f = reply.facts;
  assert.ok(f !== null);
  assert.equal(f.triangles, box.triangleCount);
  assert.equal(f.hasUvs, false);
  assert.ok(f.litFraction > 0 && f.litFraction <= 1, `litFraction ${f.litFraction}`);
  assert.ok(f.areaM2 > 0);
  // Convex: a box cannot get in its own way from outside.
  assert.equal(f.shadowedFraction, 0, 'a convex shell must shadow nothing');
});

test('computeSurface reports the shadowing a concave model does to itself', () => {
  // The same box with a panel hung across the middle, which is exactly the thing
  // a sphere can never do and the reason the number exists.
  const shaded = boxWithBaffle(0.5);
  const reply = computeSurface({
    kind: 'surface',
    id: 2,
    settings: BOULDER_PRESET,
    mesh: shaded,
    width: 32,
    height: 24,
    camera: { azimuthDeg: 0, elevationDeg: 0, rangeM: 6, fovHDeg: 50 },
  });
  assert.ok(reply.ok && reply.facts !== null);
  assert.ok(
    reply.facts.shadowedFraction > 0,
    'a baffle across the box must leave area facing a lens and dark anyway',
  );
});

test('computeSurface with no mesh puts the sphere back', () => {
  const reply = computeSurface({
    kind: 'surface',
    id: 3,
    settings: BOULDER_PRESET,
    mesh: null,
    width: 32,
    height: 24,
    camera: { azimuthDeg: 0, elevationDeg: 0, rangeM: 6, fovHDeg: 50 },
  });
  assert.ok(reply.ok);
  assert.equal(reply.frame, null);
  assert.equal(reply.facts, null);
});

/** An axis-aligned cube shell of half-extent `h`, wound outward. */
function boxMesh(h: number): SurfaceMesh {
  const p: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    const base = p.length / 3;
    p.push(...a, ...b, ...c, ...d);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]);
  quad([-h, h, -h], [h, h, -h], [h, -h, -h], [-h, -h, -h]);
  quad([-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]);
  quad([h, h, -h], [-h, h, -h], [-h, h, h], [h, h, h]);
  quad([h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]);
  quad([-h, h, -h], [-h, -h, -h], [-h, -h, h], [-h, h, h]);
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'box',
    positions: Float64Array.from(p),
    indices: Uint32Array.from(idx),
    normals: null,
    uvs: null,
    vertexCount: p.length / 3,
    triangleCount: idx.length / 3,
  };
}

/** The box, plus a panel across its middle that shadows the far wall. */
function boxWithBaffle(h: number): SurfaceMesh {
  const box = boxMesh(h);
  const p = Array.from(box.positions);
  const idx = Array.from(box.indices);
  const base = p.length / 3;
  p.push(-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0);
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  return {
    ...box,
    name: 'box-with-baffle',
    positions: Float64Array.from(p),
    indices: Uint32Array.from(idx),
    vertexCount: p.length / 3,
    triangleCount: idx.length / 3,
  };
}

test('the surface cache never answers with a stale build', () => {
  // `computeSurface` holds the last model built, because it runs on every
  // settled control and the mesh arrives by structured clone — a fresh copy of
  // an unchanged model, and a BVH, an adjacency graph and a Dijkstra field per
  // projector to get back where the previous request already was.
  //
  // The failure mode of any such cache is a stale answer, so this measures it
  // against the thing it is an optimization OF: an unnamed model is never
  // cached, so the same request without a `meshId` is a cold worker, and every
  // warm answer has to equal one.
  const box = boxMesh(0.5);
  const baffled = boxWithBaffle(0.5);
  const moved: ProjectorPlacement[] = [
    { position: { x: 3, y: 0, z: 1 } },
    { position: { x: -3, y: 0, z: 1 } },
  ];
  const ask = (mesh: SurfaceMesh, placements: ProjectorPlacement[] | null, meshId?: string) =>
    computeSurface({
      kind: 'surface',
      id: 9,
      settings: BOULDER_PRESET,
      mesh,
      width: 32,
      height: 24,
      camera: { azimuthDeg: 20, elevationDeg: 15, rangeM: 6, fovHDeg: 50 },
      ...(placements ? { placements } : {}),
      ...(meshId === undefined ? {} : { meshId }),
    });

  // Every cold answer first. A cold call clears the cache on its way through, so
  // taking them later would flush the warm state this is trying to test.
  const coldBox = ask(box, null);
  const coldMoved = ask(box, moved);
  const coldBaffled = ask(baffled, null);

  const same = (got: SurfaceResponse, want: SurfaceResponse, what: string): void => {
    assert.deepEqual(got.facts, want.facts, `${what}: facts`);
    assert.deepEqual(got.frame?.data, want.frame?.data, `${what}: picture`);
  };

  same(ask(box, null, 'm1'), coldBox, 'cold, filling the cache');
  same(ask(box, null, 'm1'), coldBox, 'the same model and the same rig again');
  // The two that a cache gets wrong. Without the rig key a moved projector keeps
  // the old footprint fields; without the model key a different file is answered
  // with the last one's geometry. Both are mutation-checked: dropping either
  // comparison from `cachedMesh` fails the matching line here.
  same(ask(box, moved, 'm1'), coldMoved, 'the same model, projectors moved');
  same(ask(baffled, null, 'm2'), coldBaffled, 'a different model');
  same(ask(box, null, 'm1'), coldBox, 'and back to the first model');

  // The rigs really do differ, or the third line above proves nothing.
  assert.notDeepEqual(coldMoved.facts, coldBox.facts, 'the moved rig must light the box differently');
  assert.notDeepEqual(coldBaffled.facts, coldBox.facts, 'the baffle must change the facts');
});
