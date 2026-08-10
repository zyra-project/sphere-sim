/**
 * The cross-check: `packages/sim` and `packages/solver` each build "the rig
 * PARAMETERS.md describes", independently, and must arrive at the same rig.
 *
 * ## Why this is not a boundary violation, and why it lives here
 *
 * The two packages share no code, and that is the point: each implements
 * conventions.ts from scratch so that a sign error on one side cannot cancel a
 * sign error on the other. Comparing their *outputs* does not couple them —
 * nothing in `sim` learns anything about `solver`, or the reverse. It is the
 * alarm the architecture is built around, and `packages/bench` is the one place
 * allowed to hold both sides at once (docs/ARCHITECTURE.md, "Why the scorer is a
 * separate package"). A test like this in `sim/` or `solver/` WOULD be a
 * violation, and `tools/boundary-lint.ts` would fail the build.
 *
 * ## What it is for
 *
 * The two builders diverged for a whole round without anybody noticing:
 * `fovH` 34.0918 against 33.4610, and N=3 azimuths 0/90/180 against 0/120/-120.
 * Neither was a bug in either package — PARAMETERS.md pins neither number, so
 * both were honest readings of silent prose. The damage was that the divergence
 * was UNDECLARED: it made "hold the field of view" look like a fix when it is a
 * five-fold regression, because holding it pinned the field 0.63 degrees from
 * truth and the pose absorbed the error. See docs/AMENDMENTS.md A-12 step 1,
 * A-13, and A-14.
 *
 * conventions.ts §N now pins both quantities as literals in the boundary object,
 * and both sides derive their own frustum and their own azimuths from them.
 * This test is what notices if they stop agreeing again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { RigCalibration } from '../../calibration/src/index.ts';
import {
  NOMINAL_SILHOUETTE_MARGIN_FRAC,
  NOMINAL_SLOTS_BY_COUNT,
} from '../../calibration/src/conventions.ts';
import { PARAMETER_TABLE } from '../../calibration/src/parameters.ts';
import { nominalRig as simNominalRig } from '../../sim/src/scene.ts';
import { nominalRig as solverNominalRig } from '../../solver/src/index.ts';

/**
 * Tolerances, each with a reason. They are not "some small number": a tolerance
 * with no argument behind it is a tolerance somebody will widen the first time
 * it fails.
 */
const TOL = {
  /**
   * Field of view, degrees. The two derivations are algebraically identical and
   * arithmetically different — `sim` goes through a focal length in pixels,
   * `solver` through the tangent of a half-angle — so they may differ in the
   * last bits and must not differ in anything else. 1e-9 deg is 6e-8 projector
   * pixels at this focal length; the divergence this test exists to catch was
   * 0.63 deg, seven orders of magnitude larger.
   */
  fovDeg: 1e-9,
  /**
   * Lens position, metres. Zero at the §2 nominal, where §1 and §2 put the lens
   * and the equator at the same 2.1844 m. It is NOT zero when a lens sits at
   * another height: `sim` reads `d_proj` as a horizontal radius and lifts the
   * lens off it, `solver` reads it as the centre-to-lens distance of §2's own
   * wording and derives the radius. That is a real, recorded divergence
   * (packages/bench/README.md) worth 40 micrometres at this corpus's height
   * scatter — fifty times below the §7 pose gate, and it affects only where the
   * solver starts. The tolerance is set to notice it growing, not to hide it.
   */
  positionM: 1e-4,
  /** Aim, degrees. Same argument as `positionM`: a 40 um lift is 0.0005 deg. */
  angleDeg: 1e-3,
};

function azimuthDeg(rig: RigCalibration, i: number): number {
  const p = rig.projectors[i].pose.position;
  return (Math.atan2(p.y, p.x) * 180) / Math.PI;
}

function divergenceNote(what: string, a: number, b: number): string {
  return (
    `${what}: packages/sim says ${a}, packages/solver says ${b}.\n` +
    '\n' +
    'This is NOT a solver defect and NOT a simulator defect. It means the two\n' +
    'independent implementations of "the rig PARAMETERS.md describes" have\n' +
    'drifted apart, which is exactly the failure docs/AMENDMENTS.md A-13\n' +
    'records: the bench then perturbs one rig and initialises the solver from a\n' +
    'different one, every pose number in bench-results.json silently acquires\n' +
    'the gap as a bias, and any experiment that HOLDS the diverged parameter\n' +
    'reports a regression as an improvement.\n' +
    '\n' +
    'Do not "fix" this by making one side call the other. The duplication is\n' +
    'the mechanism (tools/boundary-lint.ts enforces it). Fix it by deciding\n' +
    'which reading is right, stating the value in packages/calibration/src/\n' +
    'conventions.ts §N as a literal, implementing it on both sides, and filing\n' +
    'the ambiguity against PARAMETERS.md in docs/AMENDMENTS.md.'
  );
}

test('the two nominalRig builders agree on the field of view (conventions.ts §N.1)', () => {
  for (const [resX, resY] of [
    [1920, 1080],
    [3840, 2160],
    [1920, 1200],
  ]) {
    for (const distanceM of [PARAMETER_TABLE.d_proj.nominal, 5.0, 6.14, 6.5]) {
      const a = simNominalRig({ resX, resY, distanceM });
      const b = solverNominalRig({ resX, resY, distanceM });
      const fa = a.projectors[0].intrinsics.fovHDeg;
      const fb = b.projectors[0].intrinsics.fovHDeg;
      assert.ok(
        Math.abs(fa - fb) <= TOL.fovDeg,
        divergenceNote(`nominal fovH at ${resX}x${resY}, d_proj = ${distanceM} m`, fa, fb),
      );
    }
  }
});

test('the pinned margin is the thing they agree on, not a coincidence', () => {
  // The headroom of conventions.ts §N.1 must be visible in the answer: with it,
  // the minor half-angle's tangent is (1 + margin) times the silhouette's. A
  // future edit that dropped the margin on BOTH sides would keep the test above
  // green while quietly changing what the nominal rig is, so the value itself is
  // pinned here against the arithmetic §N.1 states in prose.
  const d = PARAMETER_TABLE.d_proj.nominal;
  const r = PARAMETER_TABLE.R.nominal;
  const expectedFovH =
    (2 *
      Math.atan(
        Math.tan(Math.asin(r / d)) * (1 + NOMINAL_SILHOUETTE_MARGIN_FRAC) * (1920 / 1080),
      ) *
      180) /
    Math.PI;
  for (const rig of [simNominalRig(), solverNominalRig()]) {
    assert.ok(
      Math.abs(rig.projectors[0].intrinsics.fovHDeg - expectedFovH) <= TOL.fovDeg,
      `expected fovH ${expectedFovH} from conventions.ts §N.1, got ${rig.projectors[0].intrinsics.fovHDeg}`,
    );
  }
  // And the margin is what separates it from the zero-margin construction the
  // solver used to build: 0.63 degrees, the gap A-13 measured.
  const zeroMargin = (2 * Math.atan(Math.tan(Math.asin(r / d)) * (1920 / 1080)) * 180) / Math.PI;
  assert.ok(
    Math.abs(expectedFovH - zeroMargin - 0.6308) < 0.001,
    `the pinned margin should be worth the 0.63 deg A-13 measured, got ${expectedFovH - zeroMargin}`,
  );
});

test('the two nominalRig builders agree on which quadrants go dark (conventions.ts §N.2)', () => {
  for (const count of [2, 3, 4]) {
    const a = simNominalRig({ projectorCount: count });
    const b = solverNominalRig({ projectorCount: count });
    assert.equal(a.projectors.length, count);
    assert.equal(b.projectors.length, count);

    for (let i = 0; i < count; i++) {
      const az = azimuthDeg(a, i);
      const bz = azimuthDeg(b, i);
      const delta = ((az - bz + 540) % 360) - 180;
      assert.ok(
        Math.abs(delta) <= TOL.angleDeg,
        divergenceNote(`azimuth of projector ${i} at N=${count}`, az, bz),
      );
      // The slot table itself, so a divergence that moved BOTH sides together
      // still shows up.
      const expected = NOMINAL_SLOTS_BY_COUNT[count][i] * 90;
      const off = ((az - expected + 540) % 360) - 180;
      assert.ok(
        Math.abs(off) <= TOL.angleDeg,
        `N=${count} projector ${i} should sit in slot ${NOMINAL_SLOTS_BY_COUNT[count][i]} ` +
          `(azimuth ${expected} deg per conventions.ts §N.2), got ${az}`,
      );
      assert.equal(
        a.projectors[i].id,
        b.projectors[i].id,
        `projector ${i} at N=${count}: sim calls it ${a.projectors[i].id}, solver ${b.projectors[i].id}. ` +
          'The ids name the slot, so disagreeing about them is disagreeing about which quadrant went dark.',
      );
      assert.deepEqual(
        a.projectors[i].viewport,
        b.projectors[i].viewport,
        `projector ${i} at N=${count}: the two sides put it in different quadrants of the shared ` +
          'framebuffer (conventions.ts §V). Composites would disagree about which lens shows what.',
      );
    }
  }
});

test('the two nominalRig builders agree on pose, to a stated tolerance', () => {
  const cases: { label: string; params: Record<string, number> }[] = [
    { label: '§2 nominal', params: {} },
    // The height scatter this corpus actually injects (sim/scene.ts
    // DEFAULT_MISALIGNMENT.heightM = 0.02 m), which is where the two readings of
    // `d_proj` in the test below start to separate.
    { label: 'lens 2 cm above the equator', params: { projectorHeightM: 2.2044 } },
    { label: "the floor plan's far end", params: { distanceM: 6.14 } },
  ];
  for (const c of cases) {
    const a = simNominalRig({ ...c.params });
    const b = solverNominalRig({ ...c.params });
    for (let i = 0; i < a.projectors.length; i++) {
      const pa = a.projectors[i].pose;
      const pb = b.projectors[i].pose;
      const d = Math.hypot(
        pa.position.x - pb.position.x,
        pa.position.y - pb.position.y,
        pa.position.z - pb.position.z,
      );
      assert.ok(
        d <= TOL.positionM,
        divergenceNote(`${c.label}: lens ${i} position, metres apart`, d, 0),
      );
      for (const k of ['yawDeg', 'pitchDeg', 'rollDeg'] as const) {
        const delta = ((pa[k] - pb[k] + 540) % 360) - 180;
        assert.ok(
          Math.abs(delta) <= TOL.angleDeg,
          divergenceNote(`${c.label}: lens ${i} ${k}`, pa[k], pb[k]),
        );
      }
    }
    assert.equal(a.sphere.radiusM, b.sphere.radiusM);
    assert.equal(a.sphere.centerHeightM, b.sphere.centerHeightM);
    assert.deepEqual(a.framebuffer, b.framebuffer);
  }
});

/**
 * The one divergence that is left, pinned rather than tolerated.
 *
 * PARAMETERS.md §2 calls `d_proj` "distance, sphere center to lens".
 * `packages/solver` reads that literally and puts the lens at `d_proj` in three
 * dimensions; `packages/sim` places it at `d_proj` in the HORIZONTAL plane and
 * then lifts it. The two agree exactly at §2's own nominal, where §1 and §2 put
 * the lens and the equator at the same 2.1844 m and the lift is zero, and the
 * gap grows quadratically with the lift: `d - sqrt(d^2 - z^2)`.
 *
 * It is recorded in packages/bench/README.md and deliberately not patched — a
 * divergence between two independent implementations is what this repository is
 * built to surface, and the fix belongs to whoever owns `sim`. What was missing
 * is a test that keeps it visible and keeps it small. At the 2 cm of height
 * scatter this corpus injects it is 39 micrometres, fifty times below the §7
 * pose gate; at 0.2 m of ceiling mount it would be 3.9 mm, ABOVE that gate.
 * That is the sentence to put in front of whoever adds a ceiling-mount scenario.
 */
test('the remaining d_proj divergence is the documented horizontal-vs-3D reading', () => {
  const d = PARAMETER_TABLE.d_proj.nominal;
  for (const liftM of [0.02, 0.2]) {
    const params = { projectorHeightM: PARAMETER_TABLE.h_center.nominal + liftM };
    const a = simNominalRig(params).projectors[0].pose.position;
    const b = solverNominalRig(params).projectors[0].pose.position;

    assert.ok(
      Math.abs(Math.hypot(a.x, a.y) - d) < 1e-12,
      `packages/sim should read d_proj as a HORIZONTAL radius, got ${Math.hypot(a.x, a.y)}`,
    );
    assert.ok(
      Math.abs(Math.hypot(b.x, b.y, b.z) - d) < 1e-12,
      `packages/solver should read d_proj as a 3D distance per §2's wording, got ${Math.hypot(b.x, b.y, b.z)}`,
    );

    const predicted = d - Math.sqrt(d * d - liftM * liftM);
    const measured = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    assert.ok(
      Math.abs(measured - predicted) < 1e-9,
      `at a ${liftM} m lift the gap should be d - sqrt(d^2 - z^2) = ${predicted} m, measured ${measured} m. ` +
        'A gap of a different SIZE means something other than the two readings of d_proj has diverged, ' +
        'and that is the case this file exists to catch.',
    );
  }
});
