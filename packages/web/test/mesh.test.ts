// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The warp mesh, which is the one output on this page derived by composing the
 * two rigs rather than by measuring one of them.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { BOULDER_PRESET, PERFECT_PRESET } from '../src/settings.ts';
import { buildWorld } from '../src/rigs.ts';
import { computeModel } from '../src/model.ts';
import type { ModelRequest } from '../src/protocol.ts';

function request(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    kind: 'model',
    id: 1,
    settings: BOULDER_PRESET,
    compositorRig: null,
    densityScale: 0.2,
    parity: null,
    customImage: null,
    customImageId: '',
    projectorPreviewWidth: 0,
    ...over,
  };
}

test('there is a mesh per projector, and it reaches the ball', () => {
  const res = computeModel(request());
  assert.equal(res.meshes.length, BOULDER_PRESET.nudge.length);
  assert.equal(res.meshes.filter(Boolean).length, Math.round(BOULDER_PRESET.projectorCount));
  for (const m of res.meshes) {
    if (!m) continue;
    assert.equal(m.u.length, m.cols * m.rows);
    // The raster overshoots the silhouette by design (§3.1 and A-01), so the
    // corners must MISS — a mesh where every vertex landed would mean the
    // projector was not overfilling and the spill metric had nothing to measure.
    assert.ok(m.onSphere > 0, `${m.projectorId} has no vertex on the sphere`);
    assert.ok(
      m.onSphere < m.cols * m.rows,
      `${m.projectorId} lands every vertex on the ball, so nothing is overfilling`,
    );
    // A vertex that missed carries NaN rather than zero: zero is a claim that no
    // correction is needed there.
    let missing = 0;
    for (let k = 0; k < m.du.length; k++) if (!Number.isFinite(m.du[k])) missing++;
    assert.equal(missing, m.cols * m.rows - m.onSphere);
  }
});

test('a perfect rig needs no correction, and a knocked one does', () => {
  const perfect = computeModel(request({ settings: PERFECT_PRESET, id: 2 }));
  for (const m of perfect.meshes) {
    if (!m) continue;
    assert.ok(
      m.worstPx < 0.02,
      `a perfectly-mounted ${m.projectorId} still wants ${m.worstPx.toFixed(3)} px of warp`,
    );
  }
  const knocked = computeModel(request({ id: 3 }));
  const worst = Math.max(...knocked.meshes.filter(Boolean).map((m) => m!.worstPx));
  assert.ok(worst > 1, `a 1x mount error should bend the mesh by pixels, got ${worst.toFixed(2)}`);
});

test('the mesh measures the compositor against the truth, not the truth against itself', () => {
  // The property that makes it worth drawing: hand the compositor the rig the
  // lenses actually have and the correction vanishes. If the composition read
  // one rig twice this would be true no matter what, so the previous test —
  // where it does NOT vanish — is the other half of the check.
  const world = buildWorld(BOULDER_PRESET);
  const res = computeModel(request({ compositorRig: world.truthRig, id: 4 }));
  for (const m of res.meshes) {
    if (!m) continue;
    assert.ok(
      m.worstPx < 0.02,
      `${m.projectorId} wants ${m.worstPx.toFixed(3)} px of warp against its own truth`,
    );
  }
});
