/**
 * Which loader a dropped file goes to, and whether it can go on a sphere.
 *
 * Small rules, but both of them decide what happens to a file a reader handed
 * over, and both used to be written out inline where a second loader could
 * quietly disagree with the first.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ASPECT_TOLERANCE, equirectAspectError, mediaKind } from '../src/media.ts';

test('a dropped file goes to the loader its type names', () => {
  assert.equal(mediaKind('video/mp4', 'earth.mp4'), 'video');
  assert.equal(mediaKind('video/webm', 'earth.webm'), 'video');
  assert.equal(mediaKind('image/jpeg', 'earth.jpg'), 'image');
  assert.equal(mediaKind('image/png', 'earth.png'), 'image');
});

test('a file with no type falls back to its extension', () => {
  // Some archive tools and some drag sources hand over an empty `type`, and a
  // video sent to the image loader fails with a message about aspect ratios.
  assert.equal(mediaKind('', 'sst.mp4'), 'video');
  assert.equal(mediaKind('', 'sst.MP4'), 'video');
  assert.equal(mediaKind('', 'sst.mov'), 'video');
  assert.equal(mediaKind('', 'sst.webm'), 'video');
  // And anything else is tried as an image, which is where the useful error is.
  assert.equal(mediaKind('', 'sst.tif'), 'image');
  assert.equal(mediaKind('', 'sst'), 'image');
  assert.equal(mediaKind('application/octet-stream', 'sst.png'), 'image');
});

test('2:1 is accepted, 16:9 is refused, and the message says why', () => {
  assert.equal(equirectAspectError(2048, 1024, 'image'), null);
  assert.equal(equirectAspectError(4096, 2048, 'video'), null);
  // Encoders round: 1998x1000 is 1.998 and is a sphere map.
  assert.equal(equirectAspectError(1998, 1000, 'video'), null);

  const wide = equirectAspectError(1920, 1080, 'video');
  assert.ok(wide, '16:9 must be refused — the poles would land in the wrong place');
  assert.match(wide, /1920×1080/);
  assert.match(wide, /1\.78:1/);
  assert.match(wide, /video/);

  // The tolerance is what it claims to be, from both sides.
  assert.equal(equirectAspectError(1000 * (2 + ASPECT_TOLERANCE * 0.99), 1000, 'image'), null);
  assert.ok(equirectAspectError(1000 * (2 + ASPECT_TOLERANCE * 1.5), 1000, 'image'));
});

test('an empty raster is refused rather than divided by', () => {
  // `videoWidth` is 0 until metadata arrives, and a file that never decodes
  // keeps it there. Without this the ratio is NaN and the comparison is false,
  // so a broken file passed the check and drew a black sphere.
  assert.ok(equirectAspectError(0, 0, 'video'));
  assert.ok(equirectAspectError(2048, 0, 'video'));
});
