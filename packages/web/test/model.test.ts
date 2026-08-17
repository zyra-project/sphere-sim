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
import { BOULDER_PRESET, CONTENT_CUSTOM } from '../src/settings.ts';
import { computeModel } from '../src/model.ts';
import type { ModelRequest } from '../src/protocol.ts';

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

test('projector frames are rendered only when asked for', () => {
  const none = computeModel(request({ projectorPreviewWidth: 0 }));
  assert.equal(none.projectorFrames.length, 0);

  const some = computeModel(request({ projectorPreviewWidth: 64, parity: null }));
  assert.equal(some.projectorFrames.length, BOULDER_PRESET.projectorCount);
  for (const f of some.projectorFrames) {
    assert.equal(f.width, 64);
    assert.ok(f.height > 0 && f.height < 64, 'a 16:9 raster should come back wider than it is tall');
    assert.ok(/^P[1-4] — \d+ × \d+$/.test(f.caption), `unhelpful caption: '${f.caption}'`);
  }
});
