// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Free projector placement.
 *
 * The load-bearing test is the first one: the general builder, handed the
 * nominal geometry, must reproduce `nominalRig()` field for field. A
 * generalization that cannot express the case it generalizes is not a
 * generalization, and this is the only check that can tell the difference.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { gridViewports, isRing, placedRig } from '../src/placement.ts';
import type { ProjectorPlacement } from '../src/placement.ts';
import { NOMINAL_AZIMUTHS_DEG, SOS_QUADRANT_VIEWPORTS, nominalRig } from '../src/scene.ts';
import { aimAtPoint, aimAtSphereCenter } from '../src/geometry.ts';
import { pixelToRay, prepareRig } from '../src/optics.ts';
import { coverageAndWeights } from '../src/coverage.ts';
import { latLonToWorld } from '../src/geometry.ts';

const DEG = Math.PI / 180;

/** The four nominal lens positions, from PARAMETERS.md §2's numbers. */
function nominalPlacements(distanceM = 5.18): ProjectorPlacement[] {
  return NOMINAL_AZIMUTHS_DEG.map((azDeg) => ({
    position: {
      x: distanceM * Math.cos(azDeg * DEG),
      y: distanceM * Math.sin(azDeg * DEG),
      // h_proj - h_center, both nominally 2.1844.
      z: 0,
    },
  }));
}

/** Replace every `-0` with `0`, recursively. See the test below for why. */
function unsignZeros<T>(value: T): T {
  if (Object.is(value, -0)) return 0 as unknown as T;
  if (Array.isArray(value)) return value.map(unsignZeros) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = unsignZeros(v);
    return out as T;
  }
  return value;
}

/** Every numeric leaf, by dotted path. */
function leaves(value: unknown, path = '', out = new Map<string, number>()): Map<string, number> {
  if (typeof value === 'number') out.set(path, value);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

test('the general builder reproduces the nominal rig, to the sign of a zero', () => {
  const nominal = nominalRig();
  const placed = placedRig({ projectors: nominalPlacements() });

  // Everything but the sign of zero is identical, field for field.
  assert.deepEqual(unsignZeros(placed), unsignZeros(nominal));

  // And the ONLY places they differ at all are pitches that are zero either way.
  // This is not a formality. `aimAtSphereCenter` negates the position and
  // `aimAtPoint` subtracts it from the target; for a lens at the sphere's own
  // height the z component is `0 * -1 = -0` one way and `0 - 0 = +0` the other,
  // and that sign survives `asin`. It is exactly the hazard that kept
  // `aimAtSphereCenter` from being rewritten in terms of the general form —
  // `bench-results.json` is byte-compared, and the nominal rig is what produces
  // it.
  const a = leaves(nominal);
  const b = leaves(placed);
  assert.deepEqual([...b.keys()], [...a.keys()], 'the two rigs must have the same shape');
  const differing = [...a.keys()].filter((k) => !Object.is(a.get(k), b.get(k)));
  // All four, because every nominal lens sits at the sphere's own height, so
  // every one of them has an exactly-zero z to disagree about.
  assert.deepEqual(
    differing,
    [
      'projectors.0.pose.pitchDeg',
      'projectors.1.pose.pitchDeg',
      'projectors.2.pose.pitchDeg',
      'projectors.3.pose.pitchDeg',
    ],
    `unexpected differences: ${differing.join(', ')}`,
  );
  // `===` again, not `assert.equal`: the point of these two lines is that both
  // values ARE zero, and `assert.equal` is `Object.is`, which is the one
  // comparison that would refuse to say so.
  for (const k of differing) {
    assert.ok(a.get(k) === 0, `${k} on the nominal rig is ${String(a.get(k))}`);
    assert.ok(b.get(k) === 0, `${k} on the placed rig is ${String(b.get(k))}`);
  }
});

test('the sign of that zero reaches nothing — the two rigs render identically', () => {
  // The claim above is only worth making if it is inert, and "a signed zero
  // cannot matter" is exactly the kind of thing that turns out to matter. So it
  // is measured through the pose, where the pitch actually acts: the rotation
  // matrix takes `-pitchDeg`, so `-0` and `+0` swap places in `rotY` and the
  // question is whether that survives into a ray.
  const nominal = prepareRig(nominalRig());
  const placed = prepareRig(placedRig({ projectors: nominalPlacements() }));

  for (let i = 0; i < nominal.projectors.length; i++) {
    const pn = nominal.projectors[i];
    const pp = placed.projectors[i];
    for (let v = 0; v <= 1080; v += 108) {
      for (let u = 0; u <= 1920; u += 192) {
        const rn = pixelToRay(pn, u, v);
        const rp = pixelToRay(pp, u, v);
        assert.ok(
          Object.is(rn.x, rp.x) && Object.is(rn.y, rp.y) && Object.is(rn.z, rp.z),
          `projector ${i} pixel ${u},${v}: ${JSON.stringify(rn)} vs ${JSON.stringify(rp)}`,
        );
      }
    }
  }

  // And the coverage the two produce, which is what the bench scores.
  for (let latDeg = -80; latDeg <= 80; latDeg += 10) {
    for (let lonDeg = -180; lonDeg < 180; lonDeg += 15) {
      const p = latLonToWorld(latDeg, lonDeg, 0.8636);
      const wn = coverageAndWeights(p, nominal.surface.normalAt(p), nominal).weights;
      const wp = coverageAndWeights(p, placed.surface.normalAt(p), placed).weights;
      for (let i = 0; i < wn.length; i++) {
        assert.ok(
          Object.is(wn[i], wp[i]),
          `weight ${i} at ${latDeg},${lonDeg}: ${wn[i]} vs ${wp[i]}`,
        );
      }
    }
  }
});

test('four projectors tile the framebuffer into the SOS quadrants', () => {
  // Pinned against the constant rather than against the prose in
  // `gridViewports`, so the claim is checked rather than restated.
  assert.deepEqual(gridViewports(4), [...SOS_QUADRANT_VIEWPORTS]);
});

test('the grid keeps every viewport inside the framebuffer and disjoint', () => {
  for (const n of [1, 2, 3, 5, 6, 7, 9, 12]) {
    const vps = gridViewports(n);
    assert.equal(vps.length, n);
    for (const v of vps) {
      assert.ok(v.x >= 0 && v.y >= 0, `viewport starts outside: ${JSON.stringify(v)}`);
      assert.ok(v.x + v.w <= 1 + 1e-12, `viewport runs off the right: ${JSON.stringify(v)}`);
      assert.ok(v.y + v.h <= 1 + 1e-12, `viewport runs off the top: ${JSON.stringify(v)}`);
    }
    // No two overlap: compare every pair as rectangles.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = vps[i];
        const b = vps[j];
        const overlaps =
          a.x < b.x + b.w - 1e-12 &&
          b.x < a.x + a.w - 1e-12 &&
          a.y < b.y + b.h - 1e-12 &&
          b.y < a.y + a.h - 1e-12;
        assert.ok(!overlaps, `viewports ${i} and ${j} overlap at n=${n}`);
      }
    }
  }
});

test('a rig can have more than four projectors, and eight is not special', () => {
  const eight: ProjectorPlacement[] = Array.from({ length: 8 }, (_, i) => {
    const az = (i / 8) * 360 * DEG;
    return { position: { x: 5.18 * Math.cos(az), y: 5.18 * Math.sin(az), z: 0 } };
  });
  const rig = placedRig({ projectors: eight });
  assert.equal(rig.projectors.length, 8);
  // ceil(sqrt(8)) = 3 columns, 3 rows.
  assert.equal(rig.framebuffer.width, 1920 * 3);
  assert.equal(rig.framebuffer.height, 1080 * 3);
  // And it renders: every projector reaches the sphere it is aimed at.
  const prepared = prepareRig(rig);
  const p = latLonToWorld(0, 0, 0.8636);
  const { lit } = coverageAndWeights(p, prepared.surface.normalAt(p), prepared);
  assert.ok(lit.some(Boolean), 'a point on the equator must be lit by something');
});

test('projectors need not ring anything — three on one wall', () => {
  // The arrangement the nominal rig cannot express and a real installation
  // routinely is: a row of projectors on one side, all aimed at the object.
  const wall: ProjectorPlacement[] = [-2, 0, 2].map((y) => ({
    position: { x: 5, y, z: 1.2 },
  }));
  const rig = placedRig({ projectors: wall });
  assert.equal(rig.projectors.length, 3);
  // Each is aimed at the origin from where it actually stands, so the three
  // yaws differ — a ring rig would have them differ by exactly 90.
  const yaws = rig.projectors.map((p) => p.pose.yawDeg);
  assert.equal(new Set(yaws).size, 3, `expected three distinct yaws, got ${yaws}`);
  // And they pitch DOWN, because they stand above the sphere centre.
  for (const p of rig.projectors) assert.ok(p.pose.pitchDeg < 0, `pitch ${p.pose.pitchDeg}`);
  assert.equal(isRing(wall), false);
  assert.equal(isRing(nominalPlacements()), true);
});

test('each projector is framed from its OWN throw', () => {
  // Two projectors at different distances. Giving them a shared field would
  // overshoot with the near one, which is the bug this guards.
  const rig = placedRig({
    projectors: [{ position: { x: 3, y: 0, z: 0 } }, { position: { x: -9, y: 0, z: 0 } }],
  });
  const [near, far] = rig.projectors;
  assert.ok(
    near.intrinsics.fovHDeg > far.intrinsics.fovHDeg,
    `the nearer lens needs the wider field: ${near.intrinsics.fovHDeg} vs ${far.intrinsics.fovHDeg}`,
  );
});

test('an explicit aim is honoured, including one that misses', () => {
  const aimed = placedRig({
    projectors: [{ position: { x: 5, y: 0, z: 0 }, yawDeg: 0, pitchDeg: 0, rollDeg: 3 }],
  });
  // Yaw 0 from +5 on the x axis points AWAY from the sphere. That is a rig
  // somebody builds on purpose to measure spill, and the builder must not
  // quietly turn it round.
  assert.equal(aimed.projectors[0].pose.yawDeg, 0);
  assert.equal(aimed.projectors[0].pose.rollDeg, 3);
});

test('half an orientation is refused rather than half honoured', () => {
  assert.throws(
    () => placedRig({ projectors: [{ position: { x: 5, y: 0, z: 0 }, yawDeg: 10 }] }),
    /both yawDeg and pitchDeg/,
  );
});

test('aiming at a point agrees with aiming at the centre, to the sign of a zero', () => {
  // `aimAtSphereCenter` negates the position; `aimAtPoint` subtracts it from the
  // target. Those differ in the sign of zero and both `atan2` and `asin` read
  // that sign, so this is measured on the positions the nominal rig actually
  // uses rather than argued from the algebra — and the measurement found a
  // difference, which is why the two functions stay separate.
  const origin = { x: 0, y: 0, z: 0 };
  let signedZeroDiffs = 0;
  for (const place of nominalPlacements()) {
    const a = aimAtSphereCenter(place.position);
    const b = aimAtPoint(place.position, origin);
    // Yaw agrees exactly. `wrapDeg180` maps both -180 and 180 to 180, which is
    // where the sign of zero would otherwise have shown up in the azimuth.
    assert.ok(Object.is(b.yawDeg, a.yawDeg), `yaw at ${JSON.stringify(place.position)}`);
    // Pitch agrees in VALUE always -- `===` is the right operator here, because
    // it is the one that says +0 and -0 are the same number, which is the claim.
    assert.ok(b.pitchDeg === a.pitchDeg, `pitch at ${JSON.stringify(place.position)}`);
    if (!Object.is(b.pitchDeg, a.pitchDeg)) {
      assert.ok(a.pitchDeg === 0, 'the only disagreement allowed is +0 against -0');
      signedZeroDiffs++;
    }
  }
  assert.ok(signedZeroDiffs > 0, 'this test is pinning a real difference, not a hypothetical one');

  // And off the ring, where only the general form has an answer at all.
  const off = aimAtPoint({ x: 3, y: 4, z: 2 }, { x: 1, y: 1, z: 0 });
  assert.ok(Number.isFinite(off.yawDeg) && Number.isFinite(off.pitchDeg));
  assert.ok(off.pitchDeg < 0, 'a lens above its target points down');
});

test('a rig needs at least one projector', () => {
  assert.throws(() => placedRig({ projectors: [] }), /at least one projector/);
});
