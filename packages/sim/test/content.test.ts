// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Do all the renderers agree about what is ON the sphere?
 *
 * This file exists because they did not, and nothing here noticed. The
 * graticule used to be rasterised into `Scene.image`; when it became analytic —
 * drawn by `contentAt` at full precision instead of at whatever resolution the
 * texture happened to have — `traceTwoRig` and the page's shader were moved onto
 * `contentAt` and `sampleSurface` was not. So the room view drew a grid on the
 * ball and `renderProjectorView`, which is the picture captioned "the image this
 * projector is sending down the cable", drew none. A sphere lit by four
 * projectors sending no grid, with a grid on it.
 *
 * Every test below is about that class of bug rather than that instance:
 *
 *   - The content is read through ONE function, and the source is checked for it.
 *     A renderer added tomorrow that samples the texture itself fails here.
 *   - `sampleSurface`, which is what most of the renderers read, returns what
 *     that function returns.
 *   - And the end-to-end version, which needs no knowledge of the internals: the
 *     pattern that is on the ball is in every picture of the ball.
 *
 * A metric was never at risk — `metrics/grid.ts` has always evaluated the
 * graticule analytically and reads no rendered image — which is exactly why a
 * green bench told nobody. The disagreement was only ever visible in pictures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { flatField } from '../src/equirect.ts';
import type { RgbImage } from '../src/equirect.ts';
import { worldLonToTextureLon, worldToLatLon, latLonToWorld } from '../src/geometry.ts';
import { renderTwoRigRoomView } from '../src/misregistration.ts';
import { prepareRig } from '../src/optics.ts';
import type { Graticule } from '../src/render.ts';
import {
  contentAt,
  defaultScene,
  renderProjectorView,
  renderRoomView,
  sampleSurface,
  viewerAt,
} from '../src/render.ts';
import { nominalRig } from '../src/scene.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/** A pattern nothing can miss: white lines every 15° on a black ball. */
const GRATICULE: Graticule = {
  spacingDeg: 15,
  lineWidthDeg: 1.2,
  emphasizeAxes: true,
  color: { r: 1, g: 1, b: 1 },
};

/** The base field is FLAT and dark, so anything bright in a render is the grid. */
function graticuleScene() {
  return defaultScene(flatField(64, 32, { r: 0.02, g: 0.02, b: 0.02 }), {
    graticule: GRATICULE,
  });
}

/** How much of an image is a lot brighter than its flat base. */
function brightFraction(img: RgbImage, threshold: number): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 3) {
    if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > threshold) n++;
  }
  return n / (img.width * img.height);
}

test('the content is read through exactly one function, in the whole package', () => {
  // The structural half, and the one that makes the class of bug hard to
  // reintroduce rather than merely fixed once. `contentAt` is the image PLUS the
  // analytic graticule; a renderer that reaches past it to `scene.image` is
  // drawing content the sphere does not have.
  const hits: string[] = [];
  for (const name of fs.readdirSync(SRC, { recursive: true }) as string[]) {
    if (!name.endsWith('.ts')) continue;
    const file = path.join(SRC, name);
    if (!fs.statSync(file).isFile()) continue;
    const source = fs.readFileSync(file, 'utf8');
    const re = /sampleEquirect\(\s*scene\.image/g;
    for (const _ of source.matchAll(re)) hits.push(String(name));
  }
  assert.deepEqual(
    hits,
    ['render.ts'],
    `scene.image must be sampled only by contentAt in render.ts; also sampled in ${hits.join(', ')}`,
  );
  // And in render.ts, inside `contentAt` rather than merely in the same file.
  const source = fs.readFileSync(path.join(SRC, 'render.ts'), 'utf8');
  const start = source.indexOf('export function contentAt(');
  const end = source.indexOf('\n}', start);
  assert.ok(start > 0 && end > start, 'contentAt is not where this test thinks it is');
  assert.ok(
    /sampleEquirect\(\s*scene\.image/.test(source.slice(start, end)),
    'the one read of scene.image is not the one inside contentAt',
  );
});

test('sampleSurface returns the content, graticule included', () => {
  // What most of the renderers actually call. The coupling, stated directly, so
  // a failure names the cause instead of a picture looking wrong.
  const rig = prepareRig(nominalRig());
  const scene = graticuleScene();

  let onLine = 0;
  for (const latDeg of [0, 7.5, 15, 22.5, 30, -15, -37.5]) {
    for (const lonDeg of [0, 5, 15, 45, 97.5, -60]) {
      const point = latLonToWorld(latDeg, lonDeg, rig.radiusM);
      const ll = worldToLatLon(point);
      const texLon = worldLonToTextureLon(ll.lonDeg, rig.rotationOffsetDeg);
      const want = contentAt(scene, ll.latDeg, texLon);
      const got = sampleSurface(point, rig, scene).target;
      assert.deepEqual(got, want, `sampleSurface disagrees with contentAt at ${latDeg}, ${lonDeg}`);
      if (want.r > 0.5) onLine++;
    }
  }
  // If the sample points all missed the pattern the assertions above would pass
  // against two identical readings of a flat field, and prove nothing.
  assert.ok(onLine > 0, 'none of the sample points landed on a graticule line');
});

test('the grid on the ball is in every picture of the ball', () => {
  // The end-to-end version, which knows nothing about `contentAt` and would
  // therefore survive a rewrite of all of it. Three renderers, one scene, one
  // question: is the pattern there.
  //
  // The base field is 0.02 and the lines are 1.0, so a threshold at 0.2 cannot
  // be reached by the flat field under any shading these three apply.
  const rigCal = nominalRig({ resX: 192, resY: 108 });
  const rig = prepareRig(rigCal);
  const scene = graticuleScene();
  const camera = viewerAt(0, 3.0, 1.6, rigCal.sphere.centerHeightM, 96, 72, 60);

  const frame = renderProjectorView(rig, 0, scene, { samplesPerPixel: 1, seed: 0 });
  const room = renderRoomView(rig, scene, camera, { samplesPerPixel: 1, seed: 0 });
  const twoRig = renderTwoRigRoomView(rig, rig, scene, camera, { samplesPerPixel: 1 });

  for (const [what, img] of [
    ['the frame a projector sends', frame],
    ['the room view', room],
    ['the two-calibration room view', twoRig],
  ] as const) {
    const lit = brightFraction(img, 0.2);
    assert.ok(
      lit > 0.01,
      `${what} has ${(lit * 100).toFixed(2)}% of pixels on a graticule line — the pattern the ` +
        'other renderers draw is missing from this one',
    );
  }
});

test('no graticule means no graticule, in every picture of the ball', () => {
  // The other direction, so the test above cannot be satisfied by a renderer
  // that draws a grid unconditionally — which is a real possibility for a
  // pattern that is now generated rather than supplied.
  const rigCal = nominalRig({ resX: 192, resY: 108 });
  const rig = prepareRig(rigCal);
  const scene = defaultScene(flatField(64, 32, { r: 0.02, g: 0.02, b: 0.02 }));
  const camera = viewerAt(0, 3.0, 1.6, rigCal.sphere.centerHeightM, 96, 72, 60);

  for (const [what, img] of [
    ['the frame a projector sends', renderProjectorView(rig, 0, scene, { samplesPerPixel: 1 })],
    ['the room view', renderRoomView(rig, scene, camera, { samplesPerPixel: 1, drawFloor: false })],
    [
      'the two-calibration room view',
      renderTwoRigRoomView(rig, rig, scene, camera, { samplesPerPixel: 1 }),
    ],
  ] as const) {
    assert.equal(
      brightFraction(img, 0.2),
      0,
      `${what} drew something bright on a scene with a flat field and no graticule`,
    );
  }
});
