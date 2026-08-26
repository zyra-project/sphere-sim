// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Rig construction: framebuffer topology, degraded projector counts, and the
 * misalignment injection the bench scores solvers against.
 *
 * PARAMETERS.md §3.4 is the section with the most consequences per sentence in
 * the whole document. "This is a single framebuffer split 2x2, not four
 * independent outputs" determines the simulator's output primitive, the X screen
 * resolution, and — §3.4's second consequence — that a whole multi-window IPC
 * architecture is the wrong shape for this display. So it gets pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MISALIGNMENT,
  NOMINAL_AZIMUTHS_DEG,
  SOS_QUADRANT_VIEWPORTS,
  assertFramebufferTopology,
  defaultSlotsFor,
  injectMisalignment,
  nominalRig,
  viewportPixelRect,
} from '../src/scene.ts';
import { prepareRig } from '../src/optics.ts';
import { overlapMultiplicity } from '../src/coverage.ts';
import { defaultScene, renderFramebuffer } from '../src/render.ts';
import { flatField } from '../src/equirect.ts';
import { RAD2DEG } from '../src/vec.ts';

test('§3.4: the viewports are the SOS config values, verbatim', () => {
  // set projectorInfo(viewport) { 0,0,0.5,0.5  0.5,0,0.5,0.5  0,0.5,0.5,0.5  0.5,0.5,0.5,0.5 }
  assert.deepEqual(SOS_QUADRANT_VIEWPORTS, [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ]);

  const rig = nominalRig();
  assert.equal(rig.projectors.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(rig.projectors[i].viewport, SOS_QUADRANT_VIEWPORTS[i]);
    // Four quadrants of the same size, tiling the framebuffer exactly.
    assert.equal(rig.projectors[i].viewport.w, 0.5);
    assert.equal(rig.projectors[i].viewport.h, 0.5);
  }

  // The four quadrants cover the framebuffer with no gaps and no overlaps.
  const corners = new Set(rig.projectors.map((p) => `${p.viewport.x},${p.viewport.y}`));
  assert.equal(corners.size, 4, 'each projector must occupy a distinct quadrant');
});

test('§3.4: the X screen is 2x the per-projector resolution in each dimension', () => {
  // "Per-projector resolution is half the X screen in each dimension. Four
  // native-4K projectors require a 7680x4320 X screen. Any resolution figure
  // must state which it means."
  const hd = nominalRig({ resX: 1920, resY: 1080 });
  assert.equal(hd.framebuffer.width, 3840);
  assert.equal(hd.framebuffer.height, 2160);
  for (const p of hd.projectors) {
    assert.equal(p.intrinsics.resX, 1920);
    assert.equal(p.intrinsics.resY, 1080);
  }

  const uhd = nominalRig({ resX: 3840, resY: 2160 });
  assert.equal(uhd.framebuffer.width, 7680, "§3.4's four native-4K projectors");
  assert.equal(uhd.framebuffer.height, 4320);

  // ...and the invariant is asserted at construction, not merely documented.
  assertFramebufferTopology(hd);
  assertFramebufferTopology(uhd);
});

test('§3.4: a framebuffer that is not the spanned X screen is rejected', () => {
  // The failure mode this guards against: four independent 1920x1080 outputs
  // modelled as a 1920x1080 framebuffer. Every viewport composite would be
  // quietly wrong and every rendered framebuffer would look like a quarter-scale
  // version of the right answer.
  const rig = nominalRig();
  const broken = { ...rig, framebuffer: { width: 1920, height: 1080 } };
  assert.throws(() => assertFramebufferTopology(broken), /ONE framebuffer split 2x2/);

  const offEdge = {
    ...rig,
    projectors: rig.projectors.map((p, i) =>
      i === 0 ? { ...p, viewport: { x: 0.75, y: 0, w: 0.5, h: 0.5 } } : p,
    ),
  };
  assert.throws(() => assertFramebufferTopology(offEdge), /leaves the framebuffer/);
});

test('§V: the viewport origin is BOTTOM-LEFT', () => {
  // conventions.ts §V. Image buffers have row 0 at the top, so the flip has to
  // happen somewhere; if it happens nowhere, the top and bottom quadrant pairs
  // swap. On a symmetric four-way rig that produces an image that looks entirely
  // correct until somebody stands next to the actual sphere.
  const fbW = 3840;
  const fbH = 2160;

  // Viewport {0, 0} is the BOTTOM-left quadrant, so in raster coordinates its
  // first row is halfway down the framebuffer.
  const bottomLeft = viewportPixelRect({ x: 0, y: 0, w: 0.5, h: 0.5 }, fbW, fbH);
  assert.deepEqual(bottomLeft, { x0: 0, y0: 1080, width: 1920, height: 1080 });

  // Viewport {0, 0.5} is the TOP-left quadrant: raster row 0.
  const topLeft = viewportPixelRect({ x: 0, y: 0.5, w: 0.5, h: 0.5 }, fbW, fbH);
  assert.deepEqual(topLeft, { x0: 0, y0: 0, width: 1920, height: 1080 });

  const bottomRight = viewportPixelRect({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, fbW, fbH);
  assert.deepEqual(bottomRight, { x0: 1920, y0: 1080, width: 1920, height: 1080 });
});

test('§2: N = 2 and N = 3 leave quadrants dark rather than crashing', () => {
  // "2- and 3-projector installs are supported; quadrants go dark. Simulator
  // must handle N=2,3,4."
  const scene = defaultScene(flatField(64, 32, { r: 1, g: 1, b: 1 }));

  for (const n of [2, 3, 4]) {
    const rigCal = nominalRig({ projectorCount: n, resX: 120, resY: 68 });
    assert.equal(rigCal.projectors.length, n);

    // The framebuffer does NOT shrink. The hardware is still one spanned X
    // screen; a simulator that resized it would stop modelling the deployment
    // target.
    assert.equal(rigCal.framebuffer.width, 240);
    assert.equal(rigCal.framebuffer.height, 136);

    const rig = prepareRig(rigCal);
    const fb = renderFramebuffer(rig, scene, { samplesPerPixel: 1, seed: 1 });
    assert.equal(fb.width, 240);
    assert.equal(fb.height, 136);

    // Count quadrants that got any light at all.
    const litQuadrants = [0, 1, 2, 3].filter((q) => {
      const vp = SOS_QUADRANT_VIEWPORTS[q];
      const rect = viewportPixelRect(vp, fb.width, fb.height);
      let sum = 0;
      for (let y = rect.y0; y < rect.y0 + rect.height; y++) {
        for (let x = rect.x0; x < rect.x0 + rect.width; x++) {
          sum += fb.data[3 * (y * fb.width + x)];
        }
      }
      return sum > 0;
    });
    assert.equal(litQuadrants.length, n, `N=${n} lit ${litQuadrants.length} quadrants`);
    // The lit ones are exactly the slots the rig occupies. A-06: N=2 takes the
    // ANTIPODAL pair, not the first two.
    assert.deepEqual(litQuadrants, defaultSlotsFor(n).slice().sort((a, b) => a - b));
  }
});

test('A-06: a 2-projector rig uses the antipodal pair, not two adjacent slots', () => {
  // PARAMETERS.md §2 does not say which two quadrants a 2-projector install
  // uses, and the choice is not cosmetic: adjacent lenses leave far more of the
  // sphere permanently unlit than opposed ones.
  const antipodal = prepareRig(nominalRig({ projectorCount: 2 }));
  const adjacent = prepareRig(nominalRig({ projectorCount: 2, slots: [0, 1] }));

  const unlitFraction = (rig: ReturnType<typeof prepareRig>): number => {
    let unlit = 0;
    let total = 0;
    // Equal-area sampling: uniform in sin(lat).
    for (let i = 0; i < 200; i++) {
      const lat = Math.asin(-1 + (2 * (i + 0.5)) / 200) * (180 / Math.PI);
      for (let j = 0; j < 360; j++) {
        const lon = -180 + j + 0.5;
        if (overlapMultiplicity(lat, lon, rig) === 0) unlit++;
        total++;
      }
    }
    return unlit / total;
  };

  const a = unlitFraction(antipodal);
  const b = unlitFraction(adjacent);
  assert.ok(a < b, `antipodal leaves ${(a * 100).toFixed(1)}%, adjacent ${(b * 100).toFixed(1)}%`);
  // Adjacent lenses leave twice as much of the sphere dark: 33.8% against
  // 16.7%. The antipodal figure has a closed form worth checking against — two
  // caps of angular radius acos(R/d) = 80.4 deg centred on opposite points miss
  // exactly the band within 9.6 deg of the great circle equidistant from both,
  // whose area fraction is sin(9.6 deg) = 0.1668.
  assert.ok(Math.abs(a - Math.sin((90 - 80.4029) * (Math.PI / 180))) < 0.005, `${a}`);
  assert.ok(b > 0.3, `two adjacent lenses leave ${(b * 100).toFixed(1)}% of the sphere dark`);

  // With the antipodal pair, no point is ever double-lit: §4.2's argument says a
  // point cannot be within 80.4 degrees of two antipodal directions.
  let maxN = 0;
  for (let lat = -85; lat <= 85; lat += 5) {
    for (let lon = -175; lon <= 175; lon += 5) {
      maxN = Math.max(maxN, overlapMultiplicity(lat, lon, antipodal));
    }
  }
  assert.equal(maxN, 1, 'antipodal lenses can never co-illuminate a point — §4.2');
});

test('§2: fewer projectors means unlit surface, not a crash', () => {
  const two = prepareRig(nominalRig({ projectorCount: 2 }));
  const three = prepareRig(nominalRig({ projectorCount: 3 }));
  const four = prepareRig(nominalRig({ projectorCount: 4 }));

  const unlitCount = (rig: ReturnType<typeof prepareRig>): number => {
    let unlit = 0;
    for (let lat = -85; lat <= 85; lat += 5) {
      for (let lon = -175; lon <= 175; lon += 5) {
        if (overlapMultiplicity(lat, lon, rig) === 0) unlit++;
      }
    }
    return unlit;
  };

  // Monotone: every projector you remove leaves more of the sphere dark.
  assert.ok(unlitCount(two) > unlitCount(three), 'two must be darker than three');
  assert.ok(unlitCount(three) > unlitCount(four), 'three must be darker than four');
  // ...and the full rig still leaves the scalloped polar region of §4.3.
  assert.ok(unlitCount(four) > 0, 'even four projectors leave the polar region unlit');
});

test('§2: an out-of-range projector count is rejected with a useful message', () => {
  assert.throws(() => nominalRig({ projectorCount: 5 }), /PARAMETERS.md §2/);
  assert.throws(() => nominalRig({ projectorCount: 0 }), /PARAMETERS.md §2/);
  assert.throws(() => nominalRig({ projectorCount: 2.5 }), /integer/);
});

test('§2: the nominal rig places lenses at the documented azimuths and distance', () => {
  const rig = nominalRig({ distanceM: 5.18 });
  for (let i = 0; i < 4; i++) {
    const p = rig.projectors[i].pose.position;
    assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - 5.18) < 1e-12, 'd_proj');
    const azimuth = Math.atan2(p.y, p.x) * RAD2DEG;
    const expected = NOMINAL_AZIMUTHS_DEG[i];
    // Signed difference wrapped into (-180, 180].
    const delta = ((azimuth - expected + 540) % 360) - 180;
    assert.ok(Math.abs(delta) < 1e-9, `P${i + 1} azimuth ${azimuth}, expected ${expected}`);
    // h_proj == h_center nominally (§2), so every lens sits at world z = 0.
    assert.ok(Math.abs(p.z) < 1e-12, 'a lens at equator height sits at world z = 0');
    assert.equal(rig.projectors[i].id, `P${i + 1}`);
  }
  assert.equal(rig.schema, 'sphere-sim/rig-calibration@2');
  assert.equal(rig.sphere.radiusM, 0.8636);
  assert.equal(rig.sphere.centerHeightM, 2.1844);
  // §4.5 nominals.
  assert.equal(rig.blend.rampGamma, 0.8);
  assert.equal(rig.blend.maskLoDeg, 60);
  assert.equal(rig.blend.maskHiDeg, 70);
  assert.equal(rig.blend.bottomOnly, true);
});

test('injectMisalignment is deterministic and reports exactly what it did', () => {
  const base = nominalRig();
  const a = injectMisalignment(base, 12345);
  const b = injectMisalignment(base, 12345);
  assert.deepEqual(a.rig, b.rig, 'the same seed must produce the same rig');
  assert.deepEqual(a.perturbation, b.perturbation);

  const c = injectMisalignment(base, 12346);
  assert.notDeepEqual(a.rig, c.rig, 'adjacent seeds must produce different rigs');

  // The nominal rig is untouched — the perturbation returns a new object.
  assert.deepEqual(nominalRig(), base);

  // The report must actually describe the rig that came back.
  for (let i = 0; i < 4; i++) {
    const nominal = base.projectors[i];
    const moved = a.rig.projectors[i];
    const p = a.perturbation.projectors[i];
    assert.equal(p.id, nominal.id);
    assert.ok(
      Math.abs(moved.intrinsics.k1 - (nominal.intrinsics.k1 + p.k1)) < 1e-15,
      'reported k1 delta must match the rig',
    );
    assert.ok(
      Math.abs(moved.intrinsics.fovHDeg - (nominal.intrinsics.fovHDeg + p.fovHDeg)) < 1e-12,
    );
    assert.ok(
      Math.abs(moved.intrinsics.shiftV - (nominal.intrinsics.shiftV + p.shiftV)) < 1e-15,
    );
    const actual = Math.hypot(
      moved.pose.position.x - nominal.pose.position.x,
      moved.pose.position.y - nominal.pose.position.y,
      moved.pose.position.z - nominal.pose.position.z,
    );
    assert.ok(Math.abs(actual - p.positionErrorM) < 1e-12);
  }
  assert.ok(
    Math.abs(a.rig.sphere.centerHeightM - (base.sphere.centerHeightM + a.perturbation.centerHeightM)) < 1e-15,
  );
});

test('injectMisalignment draws within the PARAMETERS.md §2 tolerances', () => {
  // Sigmas, not bounds, so the check is statistical: over many seeds the sample
  // standard deviation must land near the configured magnitude, and nothing may
  // wander absurdly far.
  const base = nominalRig();
  const az: number[] = [];
  const height: number[] = [];
  const centre: number[] = [];
  for (let seed = 0; seed < 400; seed++) {
    const m = injectMisalignment(base, seed);
    centre.push(m.perturbation.centerHeightM);
    for (const p of m.perturbation.projectors) {
      az.push(p.azimuthDeg);
      height.push(p.heightM);
    }
  }

  const sd = (xs: number[]): number => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  };

  assert.ok(
    Math.abs(sd(az) - DEFAULT_MISALIGNMENT.azimuthDeg) < 0.1,
    `azimuth sd ${sd(az)} vs configured ${DEFAULT_MISALIGNMENT.azimuthDeg}`,
  );
  assert.ok(Math.abs(sd(height) - DEFAULT_MISALIGNMENT.heightM) < 0.005);
  // §1: the documented remedy for a mis-measured h_center is "add or subtract an
  // inch", which is 0.0254 m and is the sigma DEFAULT_MISALIGNMENT uses.
  assert.equal(DEFAULT_MISALIGNMENT.centerHeightM, 0.0254);
  assert.ok(Math.abs(sd(centre) - 0.0254) < 0.005);

  // §2 says real mounts hold plus or minus 1-2 degrees. Essentially everything
  // should land inside 2 degrees; a Gaussian tail beyond 3 sigma is expected but
  // must be rare.
  const beyond = az.filter((a) => Math.abs(a) > 2).length;
  assert.ok(beyond / az.length < 0.02, `${beyond}/${az.length} azimuth draws exceeded 2 degrees`);
});

test('a misaligned rig is still a usable rig', () => {
  // A misalignment that broke the framebuffer topology or pushed a lens inside
  // the sphere would make every downstream metric meaningless. The bench sweeps
  // hundreds of seeds; none of them may produce nonsense.
  const base = nominalRig();
  for (let seed = 0; seed < 50; seed++) {
    const { rig } = injectMisalignment(base, seed);
    assertFramebufferTopology(rig);
    for (const p of rig.projectors) {
      const d = Math.hypot(p.pose.position.x, p.pose.position.y, p.pose.position.z);
      assert.ok(d > rig.sphere.radiusM * 2, `seed ${seed}: lens at ${d} m is too close`);
      assert.ok(Number.isFinite(p.intrinsics.fovHDeg) && p.intrinsics.fovHDeg > 0);
    }
    // The whole sphere below the mask boundary must still be lit.
    const prepared = prepareRig(rig);
    let unlit = 0;
    for (let lat = -55; lat <= 55; lat += 5) {
      for (let lon = -175; lon <= 175; lon += 5) {
        if (overlapMultiplicity(lat, lon, prepared) === 0) unlit++;
      }
    }
    assert.equal(unlit, 0, `seed ${seed} left ${unlit} points unlit inside the mask boundary`);
  }
});
