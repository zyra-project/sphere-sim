// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Supersampling: the display shader and the model must integrate the SAME
 * points, and the point set has to be dense enough to catch a graticule line.
 *
 * A pixel is an area, not a point. The page draws a rig whose graticule lines
 * are about 0.35° of arc wide — five millimetres on a 68-inch ball, and roughly
 * one screen pixel at a normal standing distance — so a single sample per pixel
 * does not draw a thin line badly, it draws it INTERMITTENTLY. Where a parallel
 * runs closest to horizontal its sub-pixel position drifts slowly across the
 * pixel, the sample falls on it in some columns and beside it in others, and a
 * continuous line renders as a dashed one. That is a sampling artifact, not
 * something on the sphere, and no exposure setting recovers it because the
 * information was never in the frame.
 *
 * These tests pin the two halves of the fix:
 *
 *   - The GRID is dense enough. An n × n set has samples 1/n of a pixel apart in
 *     each axis, so a feature wider than 1/n is hit in every pixel it crosses.
 *   - The two renderers place the SAME grid. The whole worth of the browser's
 *     parity readout rests on it: if the shader supersampled and the CPU model
 *     did not, the number on screen would be reporting a sampling difference as
 *     a disagreement about optics.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { gridSampleCount, gridSampleOffset, sampleOffset } from '../../sim/src/render.ts';
import { renderTwoRigRoomView } from '../../sim/src/misregistration.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { BOULDER_PRESET, VIEW_SAMPLE_GRIDS, viewSampleSide } from '../src/settings.ts';
import { buildViewer, buildWorld } from '../src/rigs.ts';
import { MIN_LIT_PIXELS, PARITY_HEIGHT, PARITY_WIDTH } from '../src/parity.ts';
import { buildDisplayUniforms } from '../src/uniforms.ts';

test('the grid is a regular n x n set that tiles the pixel', () => {
  for (const n of [1, 2, 3, 4]) {
    const seen = new Set<string>();
    for (let s = 0; s < n * n; s++) {
      const [ox, oy] = gridSampleOffset(s, n * n);
      seen.add(`${ox},${oy}`);
      assert.ok(ox > 0 && ox < 1 && oy > 0 && oy < 1, `sample ${s} of ${n}x${n} left the pixel`);
      // The cell centres, which is what makes this a box-filter quadrature
      // rather than a set of points that happen to be inside the pixel.
      const i = Math.round(ox * n - 0.5);
      const j = Math.round(oy * n - 0.5);
      assert.ok(Math.abs(ox - (i + 0.5) / n) < 1e-12);
      assert.ok(Math.abs(oy - (j + 0.5) / n) < 1e-12);
    }
    assert.equal(seen.size, n * n, `${n}x${n} repeated a sample position`);
  }
});

test('one sample is the pixel centre, on either lattice', () => {
  // conventions.ts §I's half-integer convention, and where a GPU rasterizes.
  // The two lattices have to agree here or turning supersampling off would move
  // the picture.
  assert.deepEqual(gridSampleOffset(0, 1), [0.5, 0.5]);
  assert.deepEqual(sampleOffset(7, 11, 0, 1, 1234), [0.5, 0.5]);
});

test('a count that is not a perfect square rounds, and rounds the same way twice', () => {
  // A grid with a hole in it is not a grid. What matters is less which way it
  // rounds than that `gridSampleCount` is the only place it happens, so the CPU
  // renderer and `buildDisplayUniforms` cannot round apart.
  assert.equal(gridSampleCount(1), 1);
  assert.equal(gridSampleCount(4), 4);
  assert.equal(gridSampleCount(5), 4);
  assert.equal(gridSampleCount(9), 9);
  assert.equal(gridSampleCount(0), 1);
  for (const asked of [1, 2, 3, 4, 5, 6, 7, 8, 9, 16]) {
    const world = buildWorld(BOULDER_PRESET);
    const u = buildDisplayUniforms(
      prepareRig(world.truthRig),
      prepareRig(world.compositorRig),
      world.scene,
      buildViewer(BOULDER_PRESET, 64, 48),
      { samplesPerPixel: asked },
    );
    assert.equal(
      u.sampleGrid * u.sampleGrid,
      gridSampleCount(asked),
      `the shader would draw ${u.sampleGrid ** 2} samples where the model draws ${gridSampleCount(asked)}`,
    );
  }
});

test('a feature wider than 1/n of a pixel cannot fall between the samples', () => {
  // The property the whole thing rests on, swept rather than argued: slide a
  // band of a given width across the pixel and count the placements where no
  // sample lands on it.
  const missesFor = (n: number, width: number): number => {
    const xs: number[] = [];
    for (let s = 0; s < n * n; s++) xs.push(gridSampleOffset(s, n * n)[0]);
    let missed = 0;
    const steps = 1000;
    for (let k = 0; k < steps; k++) {
      // The band's CENTRE slides across the pixel — which is what a line does as
      // it drifts through a row — so it may hang over an edge. Whether the
      // neighbour also sees it is the neighbour's business; the question here is
      // whether THIS pixel shows the part of the line inside it.
      const c = k / steps;
      if (!xs.some((x) => Math.abs(x - c) <= width / 2)) missed++;
    }
    return missed / steps;
  };

  // One sample per pixel misses a third-of-a-pixel feature two times in three,
  // which is the dashed line, quantified.
  assert.ok(missesFor(1, 1 / 3) > 0.6, `1x1 missed only ${missesFor(1, 1 / 3)} of placements`);
  // And the guarantee: wider than the sample spacing is never missed.
  for (const n of [2, 3, 4]) {
    assert.equal(missesFor(n, 1 / n + 1e-6), 0, `${n}x${n} lost a feature wider than 1/${n}`);
    assert.ok(missesFor(n, 1 / n - 0.05) > 0, `${n}x${n} is claimed to catch more than it can`);
  }
});

test('supersampling turns a dashed graticule line back into a line', () => {
  // The user-visible claim, on the renderer rather than on the sampler.
  //
  // Framed so a small raster reproduces what a full-size window does: at 6.2 m
  // in a 50° field, 200 pixels wide, the equator — an emphasised axis, 0.70° of
  // arc — is 0.39 of a screen pixel across. One sample per pixel therefore
  // misses it almost everywhere; 3 × 3, whose samples are 0.33 of a pixel apart,
  // cannot miss it anywhere. On the page the same line is about one pixel wide
  // and the default 2 × 2 is what clears it; the geometry is identical and only
  // the pixel density differs.
  //
  // The content is BLACK, so the only bright thing along the equator is the line
  // itself, and the rig is perfect, so the line is one line rather than four.
  const settings = {
    ...BOULDER_PRESET,
    content: 0,
    mountError: 0,
    viewElDeg: 0,
    viewRangeM: 6.2,
    viewFovDeg: 50,
  };
  const world = buildWorld(settings);
  const width = 200;
  const height = 150;
  const litColumns = (samplesPerPixel: number): number => {
    const img = renderTwoRigRoomView(
      prepareRig(world.truthRig),
      prepareRig(world.compositorRig),
      world.scene,
      buildViewer(settings, width, height),
      { samplesPerPixel, sampleLattice: 'grid' },
    );
    // With the eye on the equatorial plane the equator projects to the middle
    // row. A few rows either side of it, so a line that merely moved is not
    // counted as a line that vanished.
    const cy = Math.floor(height / 2);
    let lit = 0;
    for (let x = 80; x <= 120; x++) {
      let best = 0;
      for (let y = cy - 5; y <= cy + 5; y++) {
        const i = 3 * (y * width + x);
        best = Math.max(best, (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3);
      }
      // The unlit floor here is the ambient term at about 0.037. Anything above
      // 0.05 is the line.
      if (best > 0.05) lit++;
    }
    return lit;
  };

  const columns = 41;
  const one = litColumns(1);
  const nine = litColumns(9);
  assert.ok(
    one < columns / 4,
    `one sample per pixel was expected to lose the line; it drew ${one}/${columns} columns`,
  );
  assert.equal(nine, columns, `3 x 3 left ${columns - nine} columns of the equator unlit`);
});

test('grid mode at one sample is the render the default lattice already produced', () => {
  // Turning the feature off has to be exactly the old picture, not nearly it —
  // otherwise every stored comparison in the repo moved for a display setting.
  const settings = { ...BOULDER_PRESET, viewRangeM: 6.2, viewFovDeg: 50 };
  const world = buildWorld(settings);
  const render = (sampleLattice: 'halton' | 'grid') =>
    renderTwoRigRoomView(
      prepareRig(world.truthRig),
      prepareRig(world.compositorRig),
      world.scene,
      buildViewer(settings, 48, 36),
      { samplesPerPixel: 1, sampleLattice },
    );
  const a = render('halton');
  const b = render('grid');
  for (let i = 0; i < a.data.length; i++) {
    assert.equal(a.data[i], b.data[i], `pixel component ${i} moved when the lattice was named`);
  }
});

test('the parity patch stays big enough to see the sphere at every sample count', () => {
  // The patch is FIXED, and the temptation is to shrink it as the sample count
  // rises so the cost does not move. It cannot be: this view is a room shot and
  // the sphere is a percent and a half of the frame, so a quarter-size patch
  // holds fewer lit pixels than the check needs and it reports itself blind. See
  // the note beside these constants.
  const settings = { ...BOULDER_PRESET };
  const world = buildWorld(settings);
  for (const side of VIEW_SAMPLE_GRIDS.map((g) => g.side)) {
    const img = renderTwoRigRoomView(
      prepareRig(world.truthRig),
      prepareRig(world.compositorRig),
      world.scene,
      buildViewer(settings, PARITY_WIDTH, PARITY_HEIGHT),
      { samplesPerPixel: side * side, sampleLattice: 'grid' },
    );
    let lit = 0;
    for (let i = 0; i < img.data.length; i += 3) {
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 0) lit++;
    }
    assert.ok(
      lit > MIN_LIT_PIXELS,
      `at ${side}x${side} the patch holds ${lit} lit pixels, at or under the ${MIN_LIT_PIXELS} ` +
        'the check needs — it would report itself blind rather than compare anything',
    );
  }
});

test('the panel offers only sample counts that are perfect squares', () => {
  // The control stores an index; a side of 2 means four samples. An entry whose
  // square the grid could not lay out would silently render as something else.
  for (const g of VIEW_SAMPLE_GRIDS) {
    assert.equal(gridSampleCount(g.side * g.side), g.side * g.side, g.label);
  }
  assert.equal(viewSampleSide({ ...BOULDER_PRESET, viewSamples: 0 }), 1);
  assert.equal(viewSampleSide({ ...BOULDER_PRESET, viewSamples: 99 }), VIEW_SAMPLE_GRIDS.at(-1)!.side);
});
