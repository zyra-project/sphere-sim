/**
 * The frustum, the distortion inversion, and the two conventions that are
 * easiest to get subtly wrong: half-integer pixel centres and lens shift as a
 * fraction of the HALF-image dimension.
 *
 * Both of those are off-by-a-factor bugs that render something entirely
 * plausible. A doubled lens shift looks like a projector aimed slightly high; a
 * half-pixel offset looks like nothing at all until the grid-displacement gate
 * of PARAMETERS.md §7 spends a third of its 1.0 mm budget on it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectorIntrinsics } from '../../calibration/src/index.ts';
import {
  analyticOffSphereFloor,
  applyDistortion,
  fovVDeg,
  intrinsicsFromThrow,
  invertDistortion,
  pixelToRay,
  prepareProjector,
  throwRatioOf,
  worldToPixel,
} from '../src/optics.ts';
import { aimAtSphereCenter, angleBetweenDeg, raySphereIntersect } from '../src/geometry.ts';
import { DEG2RAD, addScaled, dot } from '../src/vec.ts';

const R = 0.8636;
const D = 5.18;

function makeProjector(overrides: Partial<ProjectorIntrinsics> = {}, positionZ = 0) {
  const position = { x: D, y: 0, z: positionZ };
  const aim = aimAtSphereCenter(position);
  const intrinsics: ProjectorIntrinsics = {
    ...intrinsicsFromThrow({ resX: 1920, resY: 1080, distanceM: D, radiusM: R }),
    ...overrides,
  };
  return prepareProjector(
    {
      id: 'P1',
      pose: { position, yawDeg: aim.yawDeg, pitchDeg: aim.pitchDeg, rollDeg: 0 },
      intrinsics,
      transfer: {
        gamma: { r: 2.2, g: 2.2, b: 2.2 },
        blackFloor: { r: 1 / 800, g: 1 / 800, b: 1 / 800 },
        gain: { r: 1, g: 1, b: 1 },
        whitePointK: 6500,
      },
      viewport: { x: 0, y: 0, w: 0.5, h: 0.5 },
    },
    R,
    0,
  );
}

test('§D: distortion inverts to better than 1e-10 in normalized units', () => {
  // Coefficients well beyond the misalignment magnitudes scene.ts injects, so
  // the tolerance claim holds across the whole sensitivity sweep and not just at
  // the nominal zero of PARAMETERS.md §3.1.
  const cases: Partial<ProjectorIntrinsics>[] = [
    { k1: 0, k2: 0, p1: 0, p2: 0 },
    { k1: 0.02, k2: 0.004, p1: 0, p2: 0 },
    { k1: -0.05, k2: 0.01, p1: 0, p2: 0 },
    { k1: 0.1, k2: -0.02, p1: 0.001, p2: -0.0008 },
    { k1: -0.15, k2: 0.03, p1: -0.002, p2: 0.0015 },
  ];

  let worst = 0;
  for (const c of cases) {
    const it = makeProjector(c).cal.intrinsics;
    for (let i = -10; i <= 10; i++) {
      for (let j = -10; j <= 10; j++) {
        const p = { x: i * 0.03, y: j * 0.03 };
        const back = invertDistortion(applyDistortion(p, it), it);
        worst = Math.max(worst, Math.hypot(back.x - p.x, back.y - p.y));
      }
    }
  }
  assert.ok(worst < 1e-10, `worst distortion round-trip error ${worst} (normalized units)`);
});

test('§D: distortion is applied about the principal point INCLUDING lens shift', () => {
  // conventions.ts §D says so explicitly. The observable consequence: with a
  // non-zero shift, the pixel that suffers no distortion is the SHIFTED
  // principal point, not the raster centre.
  const proj = makeProjector({ k1: 0.08, shiftH: 0.4, shiftV: -0.25 });
  const it = proj.cal.intrinsics;

  // The principal point maps to zero normalized coordinates, and zero is a fixed
  // point of the Brown-Conrady map, so its ray is exactly the optical axis.
  const axisRay = pixelToRay(proj, proj.cx, proj.cy);
  assert.ok(angleBetweenDeg(axisRay, proj.axis) < 1e-12, 'the principal point must map to the optical axis');

  // The raster centre does not, once shift is non-zero.
  const centreRay = pixelToRay(proj, it.resX / 2, it.resY / 2);
  assert.ok(
    angleBetweenDeg(centreRay, proj.axis) > 1e-3,
    'with lens shift the raster centre is not the optical axis',
  );
});

test('§I: lens shift is a fraction of the HALF-image dimension', () => {
  const base = makeProjector();
  const shifted = makeProjector({ shiftH: 0.5, shiftV: 0.5 });

  // shiftH = 0.5 moves the principal point by half of HALF the width, i.e. a
  // quarter of the full width. Reading it as a fraction of the full width would
  // double both numbers, which is the bug this test exists to catch.
  assert.ok(
    Math.abs(shifted.cx - (base.cx + 1920 / 4)) < 1e-9,
    `cx moved to ${shifted.cx}, expected ${base.cx + 1920 / 4}`,
  );
  // §I's cy carries a minus sign: positive shiftV raises the image, and v runs
  // DOWN the raster.
  assert.ok(
    Math.abs(shifted.cy - (base.cy - 1080 / 4)) < 1e-9,
    `cy moved to ${shifted.cy}, expected ${base.cy - 1080 / 4}`,
  );

  // A full shiftH of 1.0 puts the principal point on the raster edge, which is
  // what "fraction of the half-image dimension" has to mean for the parameter to
  // have its conventional range of -1..1.
  assert.ok(Math.abs(makeProjector({ shiftH: 1 }).cx - 1920) < 1e-9);
});

test('§I: pixel centres are at half-integer coordinates', () => {
  const proj = makeProjector();
  // The first pixel's centre is (0.5, 0.5) and the last is (resX-0.5, resY-0.5).
  // Those two rays must be symmetric about the optical axis for a centred lens;
  // if the convention were integer-centred they would not be.
  const first = pixelToRay(proj, 0.5, 0.5);
  const last = pixelToRay(proj, 1920 - 0.5, 1080 - 0.5);
  const a = angleBetweenDeg(first, proj.axis);
  const b = angleBetweenDeg(last, proj.axis);
  assert.ok(Math.abs(a - b) < 1e-12, `corner rays asymmetric: ${a} vs ${b} deg from the axis`);

  // The raster centre (960, 540) is a pixel CORNER, and for an unshifted lens it
  // is the optical axis.
  assert.ok(angleBetweenDeg(pixelToRay(proj, 960, 540), proj.axis) < 1e-12);

  // Round-tripping the first pixel's centre must return the same half-integer,
  // not 0 and not 1.
  const p = addScaled(proj.lens, first, 4);
  const back = worldToPixel(proj, p);
  assert.ok(back);
  assert.ok(Math.abs(back.u - 0.5) < 1e-9 && Math.abs(back.v - 0.5) < 1e-9);
});

test('worldToPixel and pixelToRay are mutual inverses to 1e-9', () => {
  // Both directions, with distortion and lens shift active, so the test covers
  // the Newton inversion rather than the identity map.
  const proj = makeProjector({ k1: 0.03, k2: 0.006, p1: 0.0008, p2: -0.0005, shiftH: 0.2, shiftV: -0.15 });

  // Sample pixel CENTRES, spanning the first to the last. The raster corner at
  // exactly (0, 0) is a pixel corner, and a round-trip through it lands within
  // an ulp of the boundary, where worldToPixel's inclusive bounds test can
  // legitimately go either way. Pixel centres are the domain rays are defined
  // on, so they are what the inverse relationship is claimed over.
  let worstPx = 0;
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 12; j++) {
      const u = 0.5 + (i / 12) * (1920 - 1);
      const v = 0.5 + (j / 12) * (1080 - 1);
      const ray = pixelToRay(proj, u, v);
      // Any point along the ray must project back to the same pixel.
      for (const t of [0.5, 4, 40]) {
        const back = worldToPixel(proj, addScaled(proj.lens, ray, t));
        assert.ok(back, `pixel (${u}, ${v}) at t=${t} projected to nothing`);
        worstPx = Math.max(worstPx, Math.hypot(back.u - u, back.v - v));
      }
    }
  }
  assert.ok(worstPx < 1e-9, `worst pixel round-trip error ${worstPx} px`);

  // And the other way: a surface point -> pixel -> ray -> surface point.
  let worstM = 0;
  for (let lat = -60; lat <= 60; lat += 15) {
    for (let lon = -60; lon <= 60; lon += 15) {
      const point = {
        x: R * Math.cos(lat * DEG2RAD) * Math.cos(lon * DEG2RAD),
        y: R * Math.cos(lat * DEG2RAD) * Math.sin(lon * DEG2RAD),
        z: R * Math.sin(lat * DEG2RAD),
      };
      const px = worldToPixel(proj, point);
      if (!px) continue;
      const hit = raySphereIntersect(proj.lens, pixelToRay(proj, px.u, px.v), R);
      assert.ok(hit);
      worstM = Math.max(
        worstM,
        Math.hypot(hit.point.x - point.x, hit.point.y - point.y, hit.point.z - point.z),
      );
    }
  }
  assert.ok(worstM < 1e-9, `worst surface round-trip error ${worstM} m`);
});

test('worldToPixel returns null behind the lens and outside the raster', () => {
  const proj = makeProjector();
  // Behind: the sphere centre is in front, so its mirror through the lens is not.
  assert.equal(worldToPixel(proj, { x: 2 * D, y: 0, z: 0 }), null, 'behind the lens');
  assert.equal(worldToPixel(proj, proj.lens), null, 'at the lens');
  // Outside: far off-axis but still in front.
  assert.equal(worldToPixel(proj, { x: 0, y: 40, z: 0 }), null, 'outside the raster');
  // Inside: the sphere centre projects to the principal point.
  const centre = worldToPixel(proj, { x: 0, y: 0, z: 0 });
  assert.ok(centre);
  assert.ok(Math.abs(centre.u - proj.cx) < 1e-9 && Math.abs(centre.v - proj.cy) < 1e-9);
});

test('A-01: the silhouette is inscribed in the raster MINOR dimension', () => {
  // docs/AMENDMENTS.md A-01. PARAMETERS.md §4.3 requires coverage to reach
  // latitude 80.4, which is impossible if the sphere is inscribed horizontally
  // on a 16:9 raster: the vertical field would be 10.7 degrees against a 19.2
  // degree silhouette.
  const it = intrinsicsFromThrow({ resX: 1920, resY: 1080, distanceM: D, radiusM: R, marginFrac: 0 });
  const silhouetteDiameterDeg = 2 * Math.asin(R / D) * (180 / Math.PI);

  const v = fovVDeg(it);
  assert.ok(
    Math.abs(v - silhouetteDiameterDeg) < 0.02,
    `vertical FOV ${v} must match the silhouette's ${silhouetteDiameterDeg} deg at zero margin`,
  );
  assert.ok(it.fovHDeg > v, 'the horizontal field must over-throw the sphere on a 16:9 raster');
  assert.ok(
    Math.abs(it.fovHDeg - 33.46) < 0.02,
    `expected fovH about 33.46 deg from A-01's construction, got ${it.fovHDeg}`,
  );

  // A-01 quotes T ~ 1.69:1 using the flat-plane approximation d/(D*aspect); the
  // exact tangent-cone construction gives 1.66:1. Both are far from §3.1's
  // literal 3.0:1, which is the tension A-01 documents.
  const t = throwRatioOf(it);
  assert.ok(t > 1.6 && t < 1.7, `throw ratio ${t} should sit near A-01's 1.66-1.69 band`);

  // A portrait raster must inscribe horizontally instead. The function has to
  // decide from the geometry, not assume landscape.
  const portrait = intrinsicsFromThrow({
    resX: 1080,
    resY: 1920,
    distanceM: D,
    radiusM: R,
    marginFrac: 0,
  });
  assert.ok(
    Math.abs(portrait.fovHDeg - silhouetteDiameterDeg) < 0.02,
    `portrait raster must inscribe horizontally, got fovH ${portrait.fovHDeg}`,
  );
});

test('A-01: the margin keeps the limb strictly inside the raster', () => {
  // With zero margin the limb lands exactly on the raster edge and the coverage
  // test and the raster test disagree in the last ulp, fringing the boundary of
  // the region PARAMETERS.md §4.3 cares most about.
  const proj = makeProjector();
  const limbLatDeg = Math.acos(R / D) * (180 / Math.PI);
  const limbPoint = {
    x: R * Math.cos(limbLatDeg * DEG2RAD),
    y: 0,
    z: R * Math.sin(limbLatDeg * DEG2RAD),
  };
  const px = worldToPixel(proj, limbPoint);
  assert.ok(px, 'the limb point must land inside the raster with the default margin');
  assert.ok(px.v > 0 && px.v < 1080, `limb landed at v=${px.v}`);
  // 2% of the silhouette's half-height in pixels is about 10 px of headroom.
  assert.ok(px.v > 5, `expected roughly 10 px of headroom above the limb, got ${px.v}`);
});

test('A-01/A-03: the analytic off-sphere floor matches the documented figures', () => {
  // 1 - (pi/4) * (minor/major). §7 quotes "~51%", which is 16:10 almost exactly
  // and is not 16:9 — the evidence A-01 rests on.
  assert.ok(Math.abs(analyticOffSphereFloor(16 / 10) - 0.5091) < 0.0005);
  assert.ok(Math.abs(analyticOffSphereFloor(16 / 9) - 0.5582) < 0.0005);
  assert.ok(Math.abs(analyticOffSphereFloor(4 / 3) - 0.4110) < 0.0005);
  // A square raster wastes the least; the floor is 1 - pi/4.
  assert.ok(Math.abs(analyticOffSphereFloor(1) - (1 - Math.PI / 4)) < 1e-12);
  // Portrait and landscape of the same shape waste the same amount.
  assert.ok(Math.abs(analyticOffSphereFloor(16 / 9) - analyticOffSphereFloor(9 / 16)) < 1e-12);

  // A-03's point, made concrete: at 16:9 the floor alone exceeds §7's 52% gate.
  assert.ok(
    analyticOffSphereFloor(16 / 9) > 0.52,
    'the §7 gate is unpassable at 16:9 regardless of alignment quality — see A-03',
  );
});

test('the frustum contains the whole silhouette, all the way round the limb', () => {
  // The real requirement behind A-01: every point on the sphere that faces the
  // lens must land inside the raster, or the limb test of PARAMETERS.md §4.1
  // stops being the binding constraint on coverage.
  const proj = makeProjector();
  let outside = 0;
  for (let lat = -89.5; lat <= 89.5; lat += 1) {
    for (let lon = -179.5; lon <= 179.5; lon += 1) {
      const point = {
        x: R * Math.cos(lat * DEG2RAD) * Math.cos(lon * DEG2RAD),
        y: R * Math.cos(lat * DEG2RAD) * Math.sin(lon * DEG2RAD),
        z: R * Math.sin(lat * DEG2RAD),
      };
      // Facing the lens?
      const toLens = {
        x: proj.lens.x - point.x,
        y: proj.lens.y - point.y,
        z: proj.lens.z - point.z,
      };
      if (dot(point, toLens) <= 0) continue;
      if (worldToPixel(proj, point) === null) outside++;
    }
  }
  assert.equal(outside, 0, `${outside} lit-facing surface points fell outside the raster`);
});
