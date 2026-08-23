/**
 * The registration-error knob Experiment 2 sweeps, and why it is a rotation.
 *
 * ## What the knob has to be
 *
 * Experiment 2 needs an x-axis in millimetres of registration error on the sphere
 * surface — the unit PARAMETERS.md §7 states its grid gate in — with three
 * properties the seeded misalignment of `sim/scene.ts` cannot give it:
 *
 *  1. **A stated magnitude, not a drawn one.** A contour plot whose x-axis is the
 *     RMS of a random draw needs many seeds per cell to stop being noise, and the
 *     cells still would not line up between the four ramp shapes.
 *  2. **A magnitude that is the same everywhere along a seam.** A random
 *     perturbation puts most of its error where the metric happens not to look.
 *  3. **The direction that actually costs something.** A displacement ALONG a seam
 *     line is invisible to a blend: both projectors' weights are constant along it.
 *     Only the component ACROSS the seam — parallel to the weight gradient — makes
 *     the two projectors' ramps disagree, so that is the component to sweep, and
 *     sweeping it alone is the worst case rather than an average one.
 *
 * ## The construction
 *
 * Rotate each physical projector about the sphere's own polar axis by
 * `+/- epsilon/2`, alternating in sign around the rig, while the compositor keeps
 * the unrotated calibration. Three consequences, all of them wanted:
 *
 *  - A rotation about the polar axis maps the sphere to itself, so projector `i`'s
 *    entire footprint is rigidly rotated by `epsilon_i` in longitude. Every texel it
 *    paints lands exactly `R * epsilon_i * cos(lat)` from where the compositor
 *    intended, in the across-seam direction, at every point of its footprint.
 *  - Alternating signs make EVERY adjacent pair disagree by the full `epsilon`,
 *    rather than one pair disagreeing and the opposite pair agreeing.
 *  - Nothing else changes: the lens stays at the same distance and the same height,
 *    still aimed at the sphere centre, still with the same intrinsics. The rig is
 *    exactly as buildable as the one it came from, which matters because the
 *    experiment is about what a blend does with a misalignment, not about what a
 *    misalignment does to a rig.
 *
 * The alternating pattern only closes for an even projector count. At N = 3 two of
 * the three pairs get `epsilon` and one gets 0, and the function says so rather than
 * pretending otherwise — Experiment 2 runs the nominal N = 4 rig.
 *
 * ## The relationship between the knob and the millimetres
 *
 * `registrationMm(epsilonDeg, latDeg)` is `R * epsilon * cos(lat)` in millimetres,
 * exactly, with no small-angle approximation anywhere: the two projectors' copies of
 * one texel sit on the same parallel, `epsilon` of longitude apart, and the arc
 * between two points on a parallel is `R * cos(lat) * dlon`. `test/misregistration.test.ts`
 * checks that against `packages/sim`'s own geodesic measurement of where the two
 * projectors actually land the texel, which is an independent route to the same
 * number through the frustum, the distortion model and a ray-sphere intersection.
 */

import type { RigCalibration, Vec3 } from '../../../calibration/src/index.ts';

const DEG2RAD = Math.PI / 180;

/** Rotate one point about the world `+Z` axis (the sphere's polar axis). */
function rotateAboutPolarAxis(p: Vec3, angleDeg: number): Vec3 {
  const a = angleDeg * DEG2RAD;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z };
}

/**
 * A copy of `rig` with projector `i` rotated bodily about the polar axis by
 * `epsilonDeg[i]`.
 *
 * The pose rotation is `Rz(eps) * R`, which in conventions.ts §R's
 * `Rz(yaw) * Ry(-pitch) * Rx(roll)` parameterization is exactly `yaw + eps` with
 * pitch and roll untouched — left-multiplying by a rotation about `+Z` composes with
 * the leftmost factor and nothing else. That identity is what makes this a rigid
 * rotation of the projector's whole footprint rather than a re-aim, and
 * `test/misregistration.test.ts` pins it by measuring the footprint instead of
 * trusting the algebra.
 */
export function rotateProjectors(rig: RigCalibration, epsilonDeg: readonly number[]): RigCalibration {
  if (epsilonDeg.length !== rig.projectors.length) {
    throw new Error(
      `rotateProjectors needs one angle per projector: ${rig.projectors.length} projectors, ${epsilonDeg.length} angles`,
    );
  }
  return {
    ...rig,
    sphere: { ...rig.sphere },
    blend: { ...rig.blend },
    framebuffer: { ...rig.framebuffer },
    projectors: rig.projectors.map((p, i) => ({
      ...p,
      pose: {
        position: rotateAboutPolarAxis(p.pose.position, epsilonDeg[i]),
        yawDeg: p.pose.yawDeg + epsilonDeg[i],
        pitchDeg: p.pose.pitchDeg,
        rollDeg: p.pose.rollDeg,
      },
      intrinsics: { ...p.intrinsics },
      transfer: { ...p.transfer },
      viewport: { ...p.viewport },
    })),
  };
}

/** The alternating `+/- epsilon/2` pattern. See the module note on odd `count`. */
export function alternatingRotations(count: number, epsilonDeg: number): number[] {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? epsilonDeg / 2 : -epsilonDeg / 2));
}

/**
 * The physical rig whose every adjacent pair is misregistered by `epsilonDeg` of
 * longitude against `contentRig` — for an EVEN projector count.
 *
 * The alternating pattern cannot close on an odd ring, and the module note above
 * says what happens instead: at N = 3 two pairs get `epsilon` and the wraparound
 * pair gets 0. Experiment 2 runs the nominal N = 4 rig. The qualifier is here as
 * well as in the note because this line is what a reader sees at the call site.
 */
export function misregisteredRig(contentRig: RigCalibration, epsilonDeg: number): RigCalibration {
  return rotateProjectors(contentRig, alternatingRotations(contentRig.projectors.length, epsilonDeg));
}

/**
 * Registration error in millimetres of arc between an adjacent pair, at a latitude.
 *
 * `R * epsilon * cos(lat)`, in mm. Exact — see the module note.
 */
export function registrationMm(epsilonDeg: number, radiusM: number, latDeg: number): number {
  return epsilonDeg * DEG2RAD * radiusM * 1000 * Math.cos(latDeg * DEG2RAD);
}

/** The inverse: the rotation that produces a stated equatorial registration error. */
export function epsilonForMm(errorMm: number, radiusM: number): number {
  return errorMm / 1000 / radiusM / DEG2RAD;
}
