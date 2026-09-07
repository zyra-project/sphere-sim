// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The file the page's warp button actually writes.
 *
 * `packages/sim/test/warp.test.ts` proves the FORMAT: that y runs up while the
 * raster runs down, that a node with no data is marked both ways the format
 * allows, that the text parses back to the mesh it came from. None of it uses
 * the page's rig, and the button's whole job is to supply that rig — so the
 * failure this covers is the one those tests cannot see: a warp file that is
 * perfectly well formed and describes nothing, because the rig handed to it had
 * no projectors pointing at the body.
 *
 * `settings.test.ts` asserts, from the source, that the exporter builds from the
 * COMPOSITOR rig rather than the truth rig — the choice that is invisible in the
 * output and wrong only in a simulator. This asserts the output is usable.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { BOULDER_PRESET } from '../src/settings.ts';
import { buildWorld } from '../src/rigs.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { buildWarpExports, formatWarpMesh } from '../../sim/src/warp.ts';

/** Exactly what `exportWarpFiles` hands the library: the believed rig, prepared. */
function pageExports() {
  const world = buildWorld(BOULDER_PRESET);
  return buildWarpExports(prepareRig(world.compositorRig));
}

test('the page’s own rig writes one usable warp mesh per projector', () => {
  const exports = pageExports();
  assert.equal(exports.length, BOULDER_PRESET.projectorCount, 'one file per projector, in rig order');

  for (const w of exports) {
    // A file whose nodes all miss is a well-formed file describing nothing, and
    // is exactly what a rig built from the wrong place would produce.
    assert.ok(
      w.onSurface > w.cols * w.rows * 0.25,
      `${w.projectorId}: only ${w.onSurface} of ${w.cols * w.rows} nodes reached the sphere`,
    );
    // And a blend that is all-or-nothing is a rig whose projectors do not
    // overlap, which for a four-projector dome means the aim is wrong.
    assert.ok(
      w.meanIntensity > 0 && w.meanIntensity <= 1,
      `${w.projectorId}: mean intensity ${w.meanIntensity} is not a blend weight`,
    );
  }

  // Distinct ids, or two projectors would write to the same filename and the
  // export would silently ship three files where the operator needs four.
  const ids = new Set(exports.map((w) => w.projectorId));
  assert.equal(ids.size, exports.length, 'two projectors share a filename');
});

test('every line the button writes is a node the format can read', () => {
  const [first] = pageExports();
  const lines = formatWarpMesh(first).trimEnd().split('\n');
  assert.equal(lines[0], '2', 'the Bourke mesh type header is missing');
  assert.equal(lines[1], `${first.cols} ${first.rows}`);
  assert.equal(lines.length, 2 + first.cols * first.rows, 'the node count does not match the header');
  for (const line of lines.slice(2)) {
    const parts = line.split(' ');
    assert.equal(parts.length, 5, `node line has ${parts.length} fields: ${line}`);
    for (const p of parts) assert.ok(Number.isFinite(Number(p)), `unreadable field ${p} in ${line}`);
  }
});
