// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The geometric metrics of PARAMETERS.md §7, and the properties that make them
 * worth believing.
 *
 * Four of these tests exist to catch a specific class of failure that unit
 * coverage does not:
 *
 *   - A metric can be perfectly self-consistent and still wrong by a constant
 *     factor. So the registration and grid metrics are checked against a
 *     FIRST-ORDER PERTURBATION CALCULATION derived independently below, which
 *     shares no code with them, at a geometry where the answer also has a closed
 *     form: a yaw error `delta` displaces the sub-projector point by exactly
 *     `(d - R) * delta` of arc.
 *   - A metric can drift with its own sampling. So every metric reports a
 *     convergence check, and the equal-area sampling is verified to integrate to
 *     the sphere rather than assumed to.
 *   - A metric can quietly depend on the viewer. PARAMETERS.md §6 forbids it, so
 *     the whole set is computed at three viewer fields of view and compared.
 *   - A metric can report a number when there is nothing to measure. So the
 *     aligned rig is checked to score zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GATES } from '../../calibration/src/parameters.ts';
import { injectMisalignment, nominalRig } from '../src/scene.ts';
import { defaultScene, viewerAt } from '../src/render.ts';
import type { Scene } from '../src/render.ts';
import { flatField, gridAlignmentPattern, graticuleCoverage } from '../src/equirect.ts';
import { prepareRig, analyticOffSphereFloor } from '../src/optics.ts';
import { aimAtSphereCenter, latLonToWorld } from '../src/geometry.ts';
import { DEG2RAD, cross, dot, normalize, sub } from '../src/vec.ts';
import type { RigCalibration, Vec3 } from '../../calibration/src/index.ts';
import {
  computeCoverageStats,
  computeGeometricMetrics,
  computeGridDisplacement,
  computeOffSphereFlux,
  configuredOffSphereFloor,
  equalAreaLattice,
  latticeWeightM2,
  placeTexelAt,
  sphereAreaM2,
} from '../src/metrics/index.ts';

const R = 0.8636; // PARAMETERS.md §1
const D_MANUAL = 5.18; // §2, the alignment manual's figure

const gridGate = GATES.find((g) => g.id === 'grid_displacement');
assert.ok(gridGate);

/** A cheap scene: the metrics never read the image, only the mask reading. */
function scene(overrides: Partial<Scene> = {}): Scene {
  return defaultScene(flatField(8, 4, { r: 0.5, g: 0.5, b: 0.5 }), overrides);
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

test('equal-area sampling integrates to the sphere, and really is equal-area', () => {
  const n = 200_000;
  const lattice = equalAreaLattice(n);
  assert.equal(lattice.length, n);

  // The literal requirement: the sampled area weights add up to the sphere.
  const summed = lattice.reduce((acc) => acc + latticeWeightM2(n, R), 0);
  const exact = sphereAreaM2(R);
  assert.ok(
    Math.abs(summed - exact) / exact < 0.001,
    `sampled area ${summed} vs 4*pi*R^2 ${exact}`,
  );

  // That check is nearly a tautology for a uniform-weight scheme, so here is the
  // one with teeth: for a genuinely equal-area sample the FRACTION of points in
  // any band |lat| <= L must match that band's area fraction, which is sin(L).
  // A naive lat/lon grid fails this badly and in a way that flatters the poles.
  for (const L of [10, 20, 30, 45, 60, 75, 85]) {
    const inside = lattice.filter((s) => Math.abs(s.latDeg) <= L).length / n;
    assert.ok(
      Math.abs(inside - Math.sin(L * DEG2RAD)) < 0.002,
      `band |lat| <= ${L}: ${inside} of the samples, expected sin(L) = ${Math.sin(L * DEG2RAD)}`,
    );
  }

  // And the failure this scheme exists to avoid, made concrete. A uniform lat/lon
  // grid gives every cell the same vote, so the equatorial band |lat| <= 30 gets
  // a third of the vote when it is half the sphere — which is the same thing as
  // saying the polar caps get two thirds when they are half. Every "fraction of
  // the sphere" in this directory would be wrong by that much.
  const rows = 180;
  const naiveInside =
    Array.from({ length: rows }, (_, y) => 90 - ((y + 0.5) / rows) * 180).filter(
      (lat) => Math.abs(lat) <= 30,
    ).length / rows;
  assert.ok(
    Math.sin(30 * DEG2RAD) - naiveInside > 0.15,
    `a naive lat/lon grid should under-weight the equator badly; it gave |lat| <= 30 a share of ` +
      `${naiveInside} against its true area fraction ${Math.sin(30 * DEG2RAD)}`,
  );
  // Per CELL the bias is unbounded: the outermost row of a 1-degree grid carries
  // the same vote as an equatorial cell while covering 1/cos(89.5) as much sky.
  assert.ok(
    1 / Math.cos(89.5 * DEG2RAD) > 100,
    'the outermost row of a 1-degree grid is over-represented by more than 100x per unit area',
  );
});

test('the lattice is deterministic — no PRNG, no wall clock', () => {
  const a = equalAreaLattice(5000);
  const b = equalAreaLattice(5000);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].latDeg, b[i].latDeg);
    assert.equal(a[i].lonDeg, b[i].lonDeg);
  }
});

// ---------------------------------------------------------------------------
// The aligned rig scores zero
// ---------------------------------------------------------------------------

test('a perfectly aligned rig scores zero registration error and zero grid displacement', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const m = computeGeometricMetrics(rig, scene());

  // Registration is an exact geometric identity when the two calibrations are
  // the same object: the pixel a texel is assigned to traces back to that texel.
  // Only the floating-point round trip separates them.
  assert.ok(
    m.registration.overlap.rms < 1e-6,
    `aligned registration RMS ${m.registration.overlap.rms} mm should be floating-point noise`,
  );
  assert.ok(m.registration.overlap.max < 1e-6, `aligned registration max ${m.registration.overlap.max} mm`);
  assert.ok(m.registration.overlap.count > 5000, 'expected a substantial overlap region to exist');

  // Grid displacement goes through the projector rasters, so it has a real
  // floor: the pattern is area-averaged into finite pixels and reconstructed
  // from them. That floor is reported, not hidden, and it is under a tenth of
  // the §7 gate.
  assert.ok(
    m.grid.all.max < 0.1,
    `aligned grid displacement max ${m.grid.all.max} mm (apparatus floor, must stay well under the 1.0 mm gate)`,
  );
  assert.equal(m.grid.measurementFloorMm, m.grid.all.max, 'aligned: the value IS the floor');
  assert.ok(m.grid.measurements.length > 100, `only ${m.grid.measurements.length} line localisations`);

  // Every scored metric passes, and the unscored ones are explicitly listed.
  assert.equal(m.pass, true, JSON.stringify(m.metrics.map((x) => [x.id, x.value, x.pass])));
  assert.deepEqual(
    m.unscored.map((u) => u.id).sort(),
    ['off_sphere_flux', 'registration_error', 'unlit_in_mask_alt_units'],
  );
  for (const metric of m.metrics) {
    assert.equal(metric.provisional, false, `${metric.id} is geometric and must not be provisional`);
    assert.ok(metric.sampling.count > 0, `${metric.id} reported no sampling density`);
    assert.ok(metric.sampling.convergence, `${metric.id} reported no convergence check`);
  }
});

test('the grid metric follows the blend region to where §4.3 says the image becomes streaks', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const m = computeGeometricMetrics(rig, scene());
  const reach = Math.max(...m.grid.measurements.map((x) => Math.abs(x.latDeg)));

  // PARAMETERS.md §1's note is about vertical lines crisscrossing in the overlap
  // regions NEAR THE POLES, so the measurement has to get up there. It should
  // stop where §4.3 says a projector's image degenerates into streaks
  // (cos(incidence) = 0.2, latitude 59.6 in a seam direction) and not before —
  // and that is also where the 60-degree bottom mask starts hiding the region
  // anyway, which §4.4 argues is exactly why the mask is there.
  const seamUsable = m.coverage.usableLatitudeSeamDeg;
  assert.ok(
    reach > seamUsable - 5,
    `grid measurements reached only |lat| ${reach}, well short of §4.3's seam usable limit ` +
      `${seamUsable.toFixed(2)}`,
  );
  assert.ok(
    reach < seamUsable,
    `grid measurements reached |lat| ${reach}, past §4.3's seam usable limit ${seamUsable.toFixed(2)} ` +
      'where a line has no localisable position',
  );
  assert.ok(m.grid.rejected.incidenceTooGrazing > 0, 'the incidence rule should be what stops it');

  assert.ok(
    m.grid.measurements.some((x) => x.orientation === 'meridian') &&
      m.grid.measurements.some((x) => x.orientation === 'parallel'),
    'both line orientations must be measured',
  );
  // A 45-degree graticule puts a line on every seam, which is what lets the
  // measurement get that high: on the seam both projectors view the line
  // symmetrically and neither is the limiting one.
  assert.deepEqual(m.grid.seamLonsDeg.slice().sort((a, b) => a - b), [-135, -45, 45, 135]);
  assert.ok(
    m.grid.measurements.some((x) => x.orientation === 'meridian' && Math.abs(x.lineDeg) === 45),
    'the seam meridians themselves must be among the lines measured',
  );
  // Every rejection is accounted for rather than silently dropped.
  assert.equal(m.grid.rejected.profileNotLocalisable, 0, 'no profile should be unlocalisable on a clean rig');
});

test('the apparatus floor is stable across rigs, not a lucky sub-pixel phase', () => {
  // The failure this guards against is subtle and was real: admitting
  // measurements where one projector sees the line at grazing incidence made the
  // self-consistency floor depend on which sub-pixel phase the line landed on,
  // so a 2 mm lens shift that changed nothing else moved the floor from 0.07 mm
  // to 2.5 mm — two and a half times the gate, from the apparatus alone. A floor
  // that moves like that cannot be reported as a floor.
  const base = nominalRig({ distanceM: D_MANUAL });
  let worst = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const rig = injectMisalignment(base, seed).rig;
    // content === physical, so there is nothing to find; whatever it reports is
    // the measurement.
    const report = computeGridDisplacement(rig, rig, 'latitude', gridGate, {
      convergence: false,
      measurementFloor: false,
    });
    assert.ok(report.measurements.length > 80, `seed ${seed}: only ${report.measurements.length} lines`);
    worst = Math.max(worst, report.all.max);
  }
  assert.ok(worst < 0.15, `worst apparatus floor over six perturbed rigs was ${worst.toFixed(4)} mm`);
});

// ---------------------------------------------------------------------------
// A known misalignment produces an error of the RIGHT MAGNITUDE
// ---------------------------------------------------------------------------

/**
 * A pure yaw error on one projector: the whole rig nominal, except projector 0
 * rotated by `deltaDeg` about world +Z through its own lens.
 *
 * conventions.ts §R composes the rotation as `Rz(yaw) * Ry(-pitch) * Rx(roll)`,
 * so adding to `yawDeg` left-multiplies by `Rz(delta)` — a rotation of every ray
 * about an axis through the lens parallel to +Z, with the lens itself fixed.
 * That is the case the perturbation calculation below is written for.
 */
function yawPerturbed(base: RigCalibration, deltaDeg: number): RigCalibration {
  return {
    ...base,
    projectors: base.projectors.map((p, i) =>
      i === 0 ? { ...p, pose: { ...p.pose, yawDeg: p.pose.yawDeg + deltaDeg } } : p,
    ),
  };
}

/**
 * First-order surface displacement of a texel under that yaw error, derived
 * independently of anything in `src/metrics/`.
 *
 * A pixel's ray leaves the lens `L` along unit `u` and hits the sphere at `P`
 * with `t0 = |P - L|`. Rotating by `delta` about `zhat` through `L` sends
 * `u -> u + delta * (zhat x u)`, so the ray at parameter `t0` moves by
 * `v = t0 * delta * w` with `w = zhat x u`. The new hit point is `P + v + lambda*u`
 * for whatever `lambda` slides back onto the sphere, and staying on the sphere
 * to first order means `n . (v + lambda*u) = 0`, giving `lambda = t0*delta*(n.w)/c`
 * with `c = -n.u = cos(incidence)`. So
 *
 *     dP = t0 * delta * [ w + ((n.w)/c) * u ]
 *
 * which is tangent to the surface, so its length is the arc length.
 *
 * The `1/c` is why this is checked only where incidence is not extreme: as the
 * limb is approached the expansion parameter grows and first order stops being
 * the answer. §4.3's own usability line, `cos(incidence) = 0.2`, is a principled
 * place to draw that cut.
 */
function yawDisplacementVector(
  latDeg: number,
  lonDeg: number,
  lens: Vec3,
  deltaRad: number,
): { vector: Vec3; incidenceCos: number } {
  const p = latLonToWorld(latDeg, lonDeg, R);
  const u = normalize(sub(p, lens));
  const t0 = Math.hypot(p.x - lens.x, p.y - lens.y, p.z - lens.z);
  const n = { x: p.x / R, y: p.y / R, z: p.z / R };
  const c = -dot(n, u);
  const w = cross({ x: 0, y: 0, z: 1 }, u);
  const k = dot(n, w) / c;
  const s = t0 * deltaRad;
  return {
    vector: { x: s * (w.x + k * u.x), y: s * (w.y + k * u.y), z: s * (w.z + k * u.z) },
    incidenceCos: c,
  };
}

test('a yaw error displaces the sub-projector point by exactly (d - R) * delta', () => {
  // The cleanest anchor in the whole file, because at the sub-projector point
  // the vector calculation collapses to a closed form with no cancellation:
  // n is parallel to u, so `n.w` vanishes and `|dP| = t0 * delta` with
  // `t0 = d - R`. The lever arm is the lens-to-near-point distance, 4.3164 m.
  const base = nominalRig({ distanceM: D_MANUAL });
  const content = prepareRig(base);

  for (const deltaDeg of [0.001, 0.01, 0.05]) {
    const physical = prepareRig(yawPerturbed(base, deltaDeg));
    const measured = placeTexelAt(0, 0, physical, content, 0).displacementMm;
    const expected = (D_MANUAL - R) * deltaDeg * DEG2RAD * 1000;
    assert.ok(
      Math.abs(measured / expected - 1) < 0.002,
      `at delta = ${deltaDeg} deg the metric measured ${measured.toFixed(5)} mm against the ` +
        `closed form (d - R)*delta = ${expected.toFixed(5)} mm`,
    );
  }

  // Linear in delta, which a metric that had picked up a stray square or square
  // root would not be.
  const p1 = prepareRig(yawPerturbed(base, 0.01));
  const p2 = prepareRig(yawPerturbed(base, 0.02));
  const ratio =
    placeTexelAt(0, 0, p2, content, 0).displacementMm /
    placeTexelAt(0, 0, p1, content, 0).displacementMm;
  assert.ok(Math.abs(ratio - 2) < 0.002, `doubling the yaw error scaled the answer by ${ratio}`);
});

test('registration error under a known misalignment matches perturbation theory', () => {
  const deltaDeg = 0.01;
  const delta = deltaDeg * DEG2RAD;
  const base = nominalRig({ distanceM: D_MANUAL });
  const content = prepareRig(base);
  const physical = prepareRig(yawPerturbed(base, deltaDeg));
  const lens = content.projectors[0].lens;

  let worstError = 0;
  let checked = 0;
  for (const latDeg of [-55, -40, -20, 0, 20, 40, 55]) {
    for (const lonDeg of [-60, -45, -20, 0, 20, 45, 60]) {
      const theory = yawDisplacementVector(latDeg, lonDeg, lens, delta);
      if (theory.incidenceCos < 0.2) continue; // see the note on yawDisplacementVector
      const measured = placeTexelAt(latDeg, lonDeg, physical, content, 0);
      if (!measured.responsible) continue;
      const expected = Math.hypot(theory.vector.x, theory.vector.y, theory.vector.z) * 1000;
      checked++;
      worstError = Math.max(worstError, Math.abs(measured.displacementMm / expected - 1));
    }
  }
  assert.ok(checked > 20, `only ${checked} well-conditioned points were compared`);
  assert.ok(
    worstError < 0.02,
    `worst disagreement with first-order perturbation theory was ${(worstError * 100).toFixed(2)}%`,
  );
});

/**
 * The rig the page actually draws: A-37's SECTOR blend rather than the `limb`
 * default, at the density a settled pass uses.
 *
 * Both matter for what follows. Under `limb` the blend region is the whole
 * overlap, so plenty of seam samples involving a moved projector survive; under
 * `sector` it is a narrow band at the seam, which is exactly where a moved
 * projector's copy of the line has gone, so they all go at once.
 */
function sectorRig(): RigCalibration {
  const plain = nominalRig({ distanceM: D_MANUAL });
  return { ...plain, blend: { ...plain.blend, region: 'sector' } };
}
const PAGE_DENSITY = 0.3;

test('a displacement too large to measure is reported, not dropped from the maximum', () => {
  // The grid metric localises each projector's copy of a line inside a scan
  // window centred on where the line should be. Move a projector far enough and
  // its copy leaves the window, the sample cannot be localised, and it was
  // DROPPED — from a statistic whose whole job is to report the largest
  // displacement. The rejection therefore correlates with the quantity being
  // measured, and always in the same direction: what survives is the small
  // displacements.
  //
  // The consequence is a headline that reads as a perfect rig for a broken one.
  // Yaw one projector by 2 degrees and every seam sample involving it drops out,
  // leaving only the seams between the three untouched projectors — so the worst
  // grid displacement comes back as the apparatus floor, to four decimal places
  // the same number an ALIGNED rig gives, while registration error is over a
  // hundred millimetres.
  const base = sectorRig();
  const opts = { convergence: false, measurementFloor: false } as const;

  const clean = computeGridDisplacement(base, base, 'latitude', gridGate, opts, PAGE_DENSITY);
  assert.equal(clean.rejected.displacedBeyondWindow, 0, 'an aligned rig lost samples');
  assert.equal(clean.metric.censored, false);
  assert.equal(clean.metric.pass, true);

  const broken = computeGridDisplacement(
    yawPerturbed(base, 2),
    base,
    'latitude',
    gridGate,
    opts,
    PAGE_DENSITY,
  );
  assert.ok(
    broken.rejected.displacedBeyondWindow > 0,
    'a 2-degree yaw displaced nothing beyond the window; the fixture no longer bites',
  );
  // This is the number the page used to print with a PASS badge. It is allowed
  // to stay — it IS the worst of the seams that could still be read — and the
  // whole fix is that it can no longer be mistaken for the worst case.
  assert.ok(
    Math.abs(broken.metric.value - clean.metric.value) < 1e-9,
    'the fixture no longer reproduces the aligned rig\'s own number for a broken one',
  );
  assert.ok(broken.metric.value < gridGate.max, 'and it is under the gate, which is why it mattered');
  assert.equal(broken.metric.censored, true, 'the value is a lower bound and does not say so');
  assert.equal(broken.metric.pass, false, 'a censored maximum certified the rig under the gate');
  assert.match(broken.metric.note, /^INCOMPLETE: \d+ of \d+/);
});

test('making the rig worse can never turn a grid failure back into a pass', () => {
  // The invariant the censoring broke, stated directly. Sweeping one projector's
  // yaw away from zero, the verdict may go from PASS to FAIL and must then stay
  // FAIL — it may not come back, whatever happens to the sample set. Before the
  // fix it came back at 2 degrees and stayed back, because by then the only
  // samples left were between the three projectors nobody had touched.
  const base = sectorRig();
  let failed = false;
  for (const yawDeg of [0, 0.25, 0.5, 1, 1.5, 2, 3, 5]) {
    const report = computeGridDisplacement(
      yawPerturbed(base, yawDeg),
      base,
      'latitude',
      gridGate,
      { convergence: false, measurementFloor: false },
      PAGE_DENSITY,
    );
    if (report.metric.pass === false) failed = true;
    else if (failed) {
      assert.fail(
        `a ${yawDeg}-degree yaw passed after a smaller one failed: ` +
          `${report.metric.value.toFixed(4)} mm over ${report.all.count} samples, ` +
          `${report.rejected.displacedBeyondWindow} displaced beyond the window`,
      );
    }
  }
  assert.ok(failed, 'no yaw in the sweep failed the gate, so the sweep proves nothing');
});

test('grid displacement under a known misalignment matches perturbation theory', () => {
  // The grid metric measures only the component PERPENDICULAR to the line, which
  // for a meridian is the east-west component. One projector is perturbed and
  // the other is not, so the discontinuity between their copies of the line is
  // that component of the perturbed projector's displacement.
  const deltaDeg = 0.01;
  const delta = deltaDeg * DEG2RAD;
  const base = nominalRig({ distanceM: D_MANUAL });
  const content = prepareRig(base);
  const lens = content.projectors[0].lens;
  const report = computeGridDisplacement(
    yawPerturbed(base, deltaDeg),
    base,
    'latitude',
    gridGate,
    { convergence: false, measurementFloor: false },
  );

  let worstError = 0;
  let checked = 0;
  for (const m of report.measurements) {
    if (m.orientation !== 'meridian') continue;
    if (m.projectorA !== 0 && m.projectorB !== 0) continue;
    const theory = yawDisplacementVector(m.latDeg, m.lineDeg, lens, delta);
    if (theory.incidenceCos < 0.2) continue;
    const lon = m.lineDeg * DEG2RAD;
    const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
    const expected = Math.abs(dot(theory.vector, east)) * 1000;
    // Skip anything within a few floors of the apparatus limit; a ratio against
    // a near-zero expectation measures the apparatus, not the rig.
    if (expected < 0.5) continue;
    checked++;
    worstError = Math.max(worstError, Math.abs(m.displacementMm / expected - 1));
  }
  assert.ok(checked > 40, `only ${checked} well-conditioned line measurements were compared`);
  assert.ok(
    worstError < 0.08,
    `worst disagreement with first-order perturbation theory was ${(worstError * 100).toFixed(2)}%`,
  );
});

test('a misaligned rig fails the grid gate, and the aligned one passes', () => {
  const base = nominalRig({ distanceM: D_MANUAL });
  const aligned = computeGeometricMetrics(base, scene(), { densityScale: 0.35 });
  const misaligned = computeGeometricMetrics(base, scene(), {
    contentRig: yawPerturbed(base, 0.1),
    densityScale: 0.35,
  });

  const gridOf = (m: typeof aligned): number =>
    m.metrics.filter((x) => x.id === 'grid_displacement')[0].value;
  assert.ok(gridOf(aligned) < 1.0, `aligned grid ${gridOf(aligned)} mm should pass the 1.0 mm gate`);
  assert.ok(
    gridOf(misaligned) > 10,
    `0.1 deg of yaw is a gross error and should show tens of mm, got ${gridOf(misaligned)}`,
  );
  assert.equal(misaligned.pass, false);
  // The apparatus floor stays small even though the measured value is large —
  // which is what makes the large value believable.
  assert.ok(misaligned.grid.measurementFloorMm < 0.2, `floor ${misaligned.grid.measurementFloorMm} mm`);
});

// ---------------------------------------------------------------------------
// PARAMETERS.md §6 — no metric may depend on the viewer
// ---------------------------------------------------------------------------

test('§6: every metric value is identical at fov_eye 35, 50 and 70 degrees', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const runs = [35, 50, 70].map((fov) =>
    computeGeometricMetrics(rig, scene(), {
      // The viewer is carried through the whole call and must touch nothing.
      viewer: viewerAt(0, 2.5, 1.6, rig.sphere.centerHeightM, 320, 200, fov),
      densityScale: 0.35,
      convergence: false,
    }),
  );

  // The provenance block records the FOV, so the runs really did differ.
  assert.deepEqual(runs.map((m) => m.provenance.viewerFovHDeg), [35, 50, 70]);

  const reference = runs[0];
  for (const run of runs.slice(1)) {
    assert.equal(run.metrics.length, reference.metrics.length);
    for (let i = 0; i < reference.metrics.length; i++) {
      const a = reference.metrics[i];
      const b = run.metrics[i];
      assert.equal(b.id, a.id);
      // Bit-identical, not merely close: PARAMETERS.md §6 says the values must
      // not depend on the framing, and any dependence at all is a defect.
      assert.equal(b.value, a.value, `${a.id} moved with fov_eye: ${a.value} vs ${b.value}`);
      assert.equal(b.pass, a.pass);
      assert.deepEqual(b.detail, a.detail, `${a.id} detail moved with fov_eye`);
    }
    assert.equal(run.pass, reference.pass);
  }
});

test('the whole metric set is deterministic', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const a = computeGeometricMetrics(rig, scene(), { densityScale: 0.35, convergence: false });
  const b = computeGeometricMetrics(rig, scene(), { densityScale: 0.35, convergence: false });
  assert.deepEqual(
    a.metrics.map((m) => [m.id, m.value, m.detail]),
    b.metrics.map((m) => [m.id, m.value, m.detail]),
  );
  assert.deepEqual(Array.from(a.fields.registrationMm.data), Array.from(b.fields.registrationMm.data));
});

// ---------------------------------------------------------------------------
// Off-sphere flux — docs/AMENDMENTS.md A-01 and A-03
// ---------------------------------------------------------------------------

test('A-01: the configured floor reduces to 1 - (pi/4)*(minor/major) at zero margin', () => {
  // A-01's table is derived for a silhouette inscribed in the raster's minor
  // dimension with no headroom. The general formula this module uses must agree
  // with it in that case, or the two numbers in the report are not comparable.
  for (const [resX, resY, expected] of [
    [1920, 1200, 0.509],
    [1920, 1080, 0.558],
    [1024, 768, 0.411],
  ] as const) {
    const rig = nominalRig({ distanceM: D_MANUAL, resX, resY, marginFrac: 0 });
    const it = rig.projectors[0].intrinsics;
    const cfg = configuredOffSphereFloor(it, D_MANUAL, R);
    assert.ok(
      Math.abs(cfg.floor - analyticOffSphereFloor(resX / resY)) < 1e-9,
      `${resX}x${resY}: configured floor ${cfg.floor} vs aspect floor ${analyticOffSphereFloor(resX / resY)}`,
    );
    assert.ok(
      Math.abs(cfg.floor - expected) < 0.001,
      `${resX}x${resY}: floor ${cfg.floor} against A-01's tabulated ${expected}`,
    );
  }
});

test('A-03: flux is scored on the excess, and the absolute reading is reported unscored', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const gate = GATES.find((g) => g.id === 'off_sphere_flux');
  assert.ok(gate);
  const flux = computeOffSphereFlux(rig, gate, { convergence: false });

  // A well-built rig sits on its own floor: the measured fraction and the
  // analytic one agree to a hundredth of a percentage point.
  assert.ok(
    Math.abs(flux.excessAboveConfiguredFloor) < 0.0005,
    `a nominal rig should sit on its floor; excess ${flux.excessAboveConfiguredFloor}`,
  );
  assert.equal(flux.metric.pass, true);
  assert.equal(flux.metric.scored, true);

  // ...and yet it fails §7's published 52% gate, because the 16:9 floor alone is
  // 55.8%. That is A-03 exactly: the gate as written is unpassable at this
  // aspect ratio no matter how well aimed the rig is. The metric set must
  // therefore not let it decide the verdict.
  assert.ok(flux.absoluteFraction > 0.52, `absolute flux ${flux.absoluteFraction}`);
  assert.equal(flux.absoluteMetric.pass, false);
  assert.equal(flux.absoluteMetric.scored, false);
  assert.ok(
    Math.abs(flux.aspectFloor - 0.5582) < 0.001,
    `16:9 aspect floor came out ${flux.aspectFloor}, A-01 tabulates 55.8%`,
  );
  // The 2% silhouette margin of AMENDMENTS A-01, which the aspect-only floor
  // knows nothing about, costs 1.7 percentage points — more than §7's entire
  // 1-point misaim budget. This is why the configured floor exists.
  assert.ok(
    flux.configuredFloor - flux.aspectFloor > 0.015,
    `the 2% margin should cost more than 1.5 points: ${flux.configuredFloor - flux.aspectFloor}`,
  );

  for (const p of flux.perProjector) {
    assert.equal(p.nonConvexRows, 0, `${p.id}: the silhouette must be convex in the raster`);
    assert.equal(p.silhouetteFitsRaster, true);
  }
});

test('misaim shows up as excess off-sphere flux only once the silhouette leaves the raster', () => {
  const base = nominalRig({ distanceM: D_MANUAL });
  const gate = GATES.find((g) => g.id === 'off_sphere_flux');
  assert.ok(gate);

  // Horizontal misaim is nearly free, and that is a real property of the rig
  // rather than a hole in the metric: AMENDMENTS A-01 inscribes the silhouette
  // in the raster's MINOR dimension, so a 16:9 projector carries about seven
  // degrees of horizontal slack before any of the sphere falls off the frame.
  // Two degrees of yaw moves the silhouette without clipping it, so the lit
  // AREA — which is what this metric counts — does not change.
  const yawed = computeOffSphereFlux(yawPerturbed(base, 2), gate, { convergence: false });
  assert.ok(
    Math.abs(yawed.excessAboveConfiguredFloor) < 0.001,
    `2 deg of yaw should not clip a silhouette with 7 deg of horizontal headroom; excess ` +
      `${yawed.excessAboveConfiguredFloor}`,
  );

  // Vertically there is only the 2% construction margin, so pitch clips quickly
  // — and that asymmetry is exactly what the Red Ball procedure is checking.
  const pitched: RigCalibration = {
    ...base,
    projectors: base.projectors.map((p) => ({
      ...p,
      pose: { ...p.pose, pitchDeg: p.pose.pitchDeg + 2 },
    })),
  };
  const flux = computeOffSphereFlux(pitched, gate, { convergence: false });
  assert.ok(
    flux.excessAboveConfiguredFloor > 0.01,
    `2 deg of pitch should breach the 1-point budget; excess ${flux.excessAboveConfiguredFloor}`,
  );
  assert.ok(flux.absoluteFraction > yawed.absoluteFraction);
  assert.equal(flux.metric.pass, false);
});

// ---------------------------------------------------------------------------
// Unlit within the mask boundary — §7's hard gate, docs/AMENDMENTS.md A-02
// ---------------------------------------------------------------------------

test('§7: the unlit gate is zero inside the mask boundary under BOTH readings of bottommask', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const m = computeGeometricMetrics(rig, scene(), { densityScale: 0.5, convergence: false });

  assert.equal(m.unlit.primary.interpretation, 'latitude');
  assert.ok(Math.abs(m.unlit.primary.onsetLatDeg - 60) < 1e-6, `onset ${m.unlit.primary.onsetLatDeg}`);
  assert.equal(m.unlit.primary.unlitFractionOfDomain, 0);
  assert.equal(m.unlit.metric.pass, true);

  // A-02: the colatitude reading moves the domain edge from |lat| 60 to |lat| 20.
  assert.equal(m.unlit.secondary.interpretation, 'colatitude');
  assert.ok(Math.abs(m.unlit.secondary.onsetLatDeg - 20) < 1e-6);
  assert.equal(m.unlit.secondary.unlitFractionOfDomain, 0);
  assert.equal(m.unlit.secondaryMetric.scored, false, 'the alternate reading must not decide a build');

  // The independent check: the unlit region stops well short of the domain edge,
  // found by bisecting the coverage boundary rather than by sampling. §4.3 puts
  // the worst boundary at 76.36 degrees, so the margin is about 16.4.
  assert.ok(
    m.unlit.primary.boundaryMarginNorthDeg > 15 && m.unlit.primary.boundaryMarginSouthDeg > 15,
    `boundary margins ${m.unlit.primary.boundaryMarginNorthDeg}, ${m.unlit.primary.boundaryMarginSouthDeg}`,
  );

  // And the domain is what §7 says it is: a band, not a cap, and symmetric even
  // though the mask is bottom-only.
  assert.ok(Math.abs(m.unlit.primary.domainAreaFraction - Math.sin(60 * DEG2RAD)) < 1e-9);
});

// ---------------------------------------------------------------------------
// Coverage statistics — PARAMETERS.md §4.2 and §4.3
// ---------------------------------------------------------------------------

test('§4.2: coverage statistics see multiplicity 0, 1 and 2 and nothing else', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const m = computeGeometricMetrics(rig, scene(), { densityScale: 0.5, convergence: false });
  const frac = m.coverage.multiplicityAreaFraction;

  assert.equal(m.coverage.maxMultiplicity, 2);
  assert.equal(frac[3], 0, '3-way overlap is impossible; §4.2 exists to say so');
  assert.equal(frac[4], 0);
  assert.ok(frac[0] > 0 && frac[1] > 0 && frac[2] > 0, 'all three regimes must occur');
  const total = frac.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `area fractions sum to ${total}`);

  // Both poles' unlit lobes together, which must match the coverage metric's own
  // integral of the scalloped boundary (docs/AMENDMENTS.md A-05: 0.893% each).
  const polar = m.coverage.unlitPolarAreaFractionNorth + m.coverage.unlitPolarAreaFractionSouth;
  assert.ok(Math.abs(polar - 2 * 0.008931) < 0.0002, `polar unlit total ${polar}`);
  assert.ok(
    Math.abs(frac[0] - polar) < 0.002,
    `the sampled unlit fraction ${frac[0]} should agree with the integrated ${polar}`,
  );

  // §4.3's usable limits, recomputed here so the summary and the coverage module
  // cannot drift apart.
  assert.ok(Math.abs(m.coverage.usableLatitudeMeridianDeg - 69) < 0.5);
  assert.ok(Math.abs(m.coverage.usableLatitudeSeamDeg - 59) < 1.0);
  assert.ok(
    m.coverage.belowUsableIncidenceFraction > 0.05 && m.coverage.belowUsableIncidenceFraction < 0.12,
    `fraction of lit area below cos(incidence) 0.2 was ${m.coverage.belowUsableIncidenceFraction}`,
  );
});

test('a 3-way overlap throws rather than being reported', () => {
  // §4.2's bound is arithmetic, not a property of a particular rig, so a
  // multiplicity above 2 means the geometry has stopped working and every
  // area-weighted number downstream is meaningless. It must not be survivable.
  //
  // Building a counterexample takes some care, which is itself the point: at the
  // nominal azimuths the bound holds for EVERY d_proj, because any three of the
  // four directions contain an antipodal pair and `2 * acos(R/d) < 180` however
  // large d gets. Breaking it needs three projectors bunched within one
  // half-space AND a long enough throw that each reaches nearly a hemisphere.
  const base = nominalRig({ distanceM: D_MANUAL, projectorCount: 3, slots: [0, 1, 2] });
  const bunched: RigCalibration = {
    ...base,
    projectors: base.projectors.map((p, i) => {
      const azimuth = i * 30 * DEG2RAD;
      const position = { x: 30 * Math.cos(azimuth), y: 30 * Math.sin(azimuth), z: 0 };
      const aim = aimAtSphereCenter(position);
      return { ...p, pose: { position, yawDeg: aim.yawDeg, pitchDeg: aim.pitchDeg, rollDeg: 0 } };
    }),
  };

  assert.throws(
    () => computeCoverageStats(bunched, 'latitude', { sampleCount: 4000, convergence: false }),
    /§4\.2/,
  );
  // ...and the escape hatch reports the violation instead of throwing, for
  // anyone deliberately exploring a pathological rig.
  const forced = computeCoverageStats(bunched, 'latitude', {
    sampleCount: 4000,
    convergence: false,
    assertMultiplicity: false,
  });
  assert.ok(forced.maxMultiplicity >= 3, `expected 3-way overlap, got ${forced.maxMultiplicity}`);
});

// ---------------------------------------------------------------------------
// Field maps and reporting surface
// ---------------------------------------------------------------------------

test('the metric set carries the fields a progress page needs to show WHERE', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const m = computeGeometricMetrics(rig, scene(), {
    contentRig: yawPerturbed(rig, 0.05),
    densityScale: 0.35,
    convergence: false,
  });

  const f = m.fields;
  assert.equal(f.registrationMm.width * f.registrationMm.height, f.registrationMm.data.length);
  assert.equal(f.multiplicity.data.length, f.registrationMm.data.length);
  assert.equal(f.incidenceCos.data.length, f.registrationMm.data.length);

  // The registration map is defined exactly where two projectors reach, and NaN
  // elsewhere — so a renderer can distinguish "no error" from "no data".
  let defined = 0;
  for (let i = 0; i < f.registrationMm.data.length; i++) {
    const hasValue = Number.isFinite(f.registrationMm.data[i]);
    if (hasValue) {
      defined++;
      assert.ok(f.multiplicity.data[i] >= 2, 'error defined where fewer than two projectors reach');
    }
  }
  assert.ok(defined > 1000, `only ${defined} cells carry a registration value`);
  assert.ok(m.fields.gridSamples.length > 50, 'grid scatter overlay is empty');

  // Provenance is enough to reconstruct what was measured.
  assert.equal(m.provenance.perfectlyAligned, false);
  assert.equal(m.provenance.projectors.length, 4);
  assert.ok(Math.abs(m.provenance.projectors[0].distanceM - D_MANUAL) < 1e-9);
  assert.ok(m.provenance.conventions.startsWith('sphere-sim/conventions@'));
});

test('the metric graticule and the display graticule are the same pattern', () => {
  // `metrics/grid.ts` evaluates `graticuleCoverage` analytically while
  // `gridAlignmentPattern` rasterizes it. They must be one definition, or the
  // metric would be measuring a pattern nobody displays.
  const spacing = 30;
  const width = 0.75;
  const img = gridAlignmentPattern({
    width: 720,
    height: 360,
    spacingDeg: spacing,
    lineWidthDeg: width,
    emphasizeAxes: false,
  });
  for (const [x, y] of [[10, 10], [180, 90], [360, 180], [700, 350], [0, 0]] as const) {
    const lat = 90 - ((y + 0.5) / 360) * 180;
    const lon = -180 + ((x + 0.5) / 720) * 360;
    const expected = graticuleCoverage(lat, lon, spacing, width, false);
    assert.ok(
      Math.abs(img.data[3 * (y * 720 + x)] - expected) < 1e-6,
      `texel (${x}, ${y}): raster ${img.data[3 * (y * 720 + x)]} vs analytic ${expected}`,
    );
  }
});

test('the mask interpretation reaches every metric that has a domain', () => {
  const rig = nominalRig({ distanceM: D_MANUAL });
  const lat = computeGeometricMetrics(rig, scene({ maskInterpretation: 'latitude' }), {
    densityScale: 0.35,
    convergence: false,
  });
  const colat = computeGeometricMetrics(rig, scene({ maskInterpretation: 'colatitude' }), {
    densityScale: 0.35,
    convergence: false,
  });

  assert.equal(lat.provenance.maskInterpretation, 'latitude');
  assert.equal(colat.provenance.maskInterpretation, 'colatitude');
  assert.equal(lat.unlit.primary.interpretation, 'latitude');
  assert.equal(colat.unlit.primary.interpretation, 'colatitude');
  // The colatitude reading masks everything below |lat| 30, so the registration
  // overlap it can see is strictly smaller.
  assert.ok(
    colat.registration.overlap.count < lat.registration.overlap.count,
    `colatitude masks more of the sphere, so it must sample fewer overlap points: ` +
      `${colat.registration.overlap.count} vs ${lat.registration.overlap.count}`,
  );
});
