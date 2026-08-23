/**
 * Rig construction from PARAMETERS.md nominals, and seeded misalignment
 * injection.
 *
 * Two jobs, and they are opposites. `nominalRig` produces the rig the
 * documentation describes. `injectMisalignment` produces the rig a real
 * installation has, by perturbing the nominal one within the tolerances
 * PARAMETERS.md §2 states — and hands back the exact perturbation it applied so
 * the bench can score a solver against ground truth it did not get to see.
 */

import type {
  BlendCalibration,
  ProjectorCalibration,
  ProjectorTransfer,
  RigCalibration,
  Vec3,
  Viewport,
} from '../../calibration/src/index.ts';
import type { RampShape } from '../../calibration/src/index.ts';
import {
  NOMINAL_AZIMUTH_SLOTS_DEG,
  NOMINAL_SLOTS_BY_COUNT,
} from '../../calibration/src/conventions.ts';
import { aimAtSphereCenter } from './geometry.ts';
import { intrinsicsFromThrow } from './optics.ts';
import { nominalTransfer } from './photometry.ts';
import type { Rng } from './random.ts';
import { makeRng } from './random.ts';
import { DEG2RAD } from './vec.ts';

// PARAMETERS.md §3.2's nominal transfer lives with the transfer model in
// `photometry.ts`, not here: this module builds RIGS, and the twelve gammas,
// twelve black floors and twelve gains are a property of the projectors' optics.
// Re-exported because `nominalRig` is where most callers first meet it.
export { nominalTransfer } from './photometry.ts';

/**
 * The four SOS quadrant viewports, verbatim from PARAMETERS.md §3.4:
 *
 *     set projectorInfo(viewport) { 0,0,0.5,0.5  0.5,0,0.5,0.5  0,0.5,0.5,0.5  0.5,0.5,0.5,0.5 }
 *
 * Normalized to the single shared framebuffer with the ORIGIN AT BOTTOM-LEFT
 * (conventions.ts §V). The order is the config's order, which is
 * bottom-left, bottom-right, top-left, top-right — not raster order. Projector
 * index i takes viewport i, so P1 (the one nearest the SOS computer, §2) lands
 * in the bottom-left quadrant.
 *
 * This is one framebuffer split 2x2, not four independent outputs. Two T1000s
 * spanned into one X screen. Everything downstream of that fact matters: the
 * simulator's output primitive is a single image, and the multi-window IPC
 * architecture §3.4 discusses is the wrong shape for this display.
 */
export const SOS_QUADRANT_VIEWPORTS: readonly Viewport[] = [
  { x: 0, y: 0, w: 0.5, h: 0.5 },
  { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  { x: 0, y: 0.5, w: 0.5, h: 0.5 },
  { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
];

/**
 * Nominal azimuths, PARAMETERS.md §2: counterclockwise from P1. Restated from
 * conventions.ts §N.2's `NOMINAL_AZIMUTH_SLOTS_DEG` so this module keeps its own
 * name for them; the values are the boundary object's.
 */
export const NOMINAL_AZIMUTHS_DEG: readonly number[] = NOMINAL_AZIMUTH_SLOTS_DEG;

export interface NominalRigParams {
  /** Sphere radius, metres. PARAMETERS.md §1, nominal 0.8636. */
  radiusM?: number;
  /** Floor to sphere centre, metres. §1 `h_center`, nominal 2.1844. */
  centerHeightM?: number;
  /** Mechanical rotation of the sphere, degrees. §1 `theta_rot`, nominal 0. */
  rotationOffsetDeg?: number;
  /**
   * Lens to sphere centre, metres. §2 `d_proj`, CONFLICTED: the alignment manual
   * says 5.18, the floor plan implies 5.50-6.14. Default is the manual's figure
   * because §4.3's coverage numbers are quoted at it.
   */
  distanceM?: number;
  /** Projector height above the floor, metres. §2 `h_proj`, nominal 2.1844. */
  projectorHeightM?: number;
  /**
   * How many projectors. §2: "2- and 3-projector installs are supported;
   * quadrants go dark. Simulator must handle N=2,3,4."
   */
  projectorCount?: number;
  /**
   * Which of the four nominal slots the projectors occupy. See
   * {@link defaultSlotsFor} — the spec does not say which two a 2-projector
   * install uses, and the answer changes the coverage field completely.
   */
  slots?: number[];
  /** Native pixels per projector. §3.1 / §3.4 — NOT the shared X screen. */
  resX?: number;
  resY?: number;
  /** Silhouette headroom in the minor raster dimension. See AMENDMENTS A-01. */
  marginFrac?: number;
  blend?: Partial<BlendCalibration>;
  transfer?: Partial<ProjectorTransfer>;
}

/**
 * PARAMETERS.md §4.5 nominals. `rampGamma` 0.8 is the one DOC-class value in
 * here, straight from the SOS config; the shape and width are ASSUME.
 * `bottomOnly` and the 60/70 pair come from `set bottommask 60,70` (§4.4).
 */
export function nominalBlend(overrides: Partial<BlendCalibration> = {}): BlendCalibration {
  const shape: RampShape = overrides.rampShape ?? 'cosine';
  return {
    rampShape: shape,
    widthDeg: overrides.widthDeg ?? 20,
    rampGamma: overrides.rampGamma ?? 0.8,
    maskLoDeg: overrides.maskLoDeg ?? 60,
    maskHiDeg: overrides.maskHiDeg ?? 70,
    bottomOnly: overrides.bottomOnly ?? true,
    // Present only when asked for. docs/AMENDMENTS.md A-37 is not applied, so a
    // rig nobody opted in for must serialize exactly as it did before the field
    // existed — bench-results.json is what critics read and it should not gain a
    // key because a simulator grew an option.
    ...(overrides.region ? { region: overrides.region } : {}),
  };
}

/**
 * Which slots a rig of `count` projectors occupies, by default.
 *
 * PARAMETERS.md §2 gives the nominal azimuths as 0, 90, 180, 270 and says 2- and
 * 3-projector installs are supported with quadrants going dark. It does not say
 * WHICH quadrants, and for N=2 the answer is not a detail: taking the first two
 * slots puts both lenses 90 degrees apart, leaving rather more than half the
 * sphere permanently unlit, which is not an installation anybody would build.
 * The antipodal pair is the only 2-projector arrangement that covers the sphere,
 * so slots 0 and 2 (azimuths 0 and 180) are the default.
 *
 * N=3 takes the first three, which is what "quadrants go dark" reads most
 * naturally as: one projector is simply absent from an otherwise standard rig.
 *
 * Recorded as docs/AMENDMENTS.md A-06 (N=2) and A-19 (N=3). The table itself is
 * now pinned in conventions.ts §N.2 as `NOMINAL_SLOTS_BY_COUNT`, because
 * `packages/solver` read the same silent spec as equal 120-degree spacing and
 * nothing was declaring which reading the project had taken. Reading a literal
 * from the boundary object is not sharing math: the slot list is a value, and
 * each side still places, aims and views its own projectors from it. Override
 * with `slots` to model a site that did something else.
 */
export function defaultSlotsFor(count: number): number[] {
  const pinned = NOMINAL_SLOTS_BY_COUNT[count];
  if (pinned !== undefined) return [...pinned];
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * Build a `RigCalibration` from the PARAMETERS.md nominals.
 *
 * Projector `i` sits at azimuth `NOMINAL_AZIMUTHS_DEG[i]`, at `d_proj` from the
 * sphere centre, at `h_proj` above the floor. §2 says projectors are "generally"
 * at the same 7 ft 2 in as the equator, so with the default heights every lens
 * lands at world z = 0 and `aimAtSphereCenter` returns pitch 0 and
 * `yaw = phi + 180` — the identity conventions.ts §R states.
 *
 * The framebuffer is always the full 2x2 X screen even when `projectorCount` is
 * 2 or 3. That is the point of §2's "quadrants go dark": the hardware is still
 * one spanned X screen, and the unused quadrants render black rather than the
 * framebuffer shrinking to fit. A simulator that resized the framebuffer would
 * silently stop modelling the deployment target.
 */
export function nominalRig(params: NominalRigParams = {}): RigCalibration {
  const radiusM = params.radiusM ?? 0.8636;
  const centerHeightM = params.centerHeightM ?? 2.1844;
  const distanceM = params.distanceM ?? 5.18;
  const projectorHeightM = params.projectorHeightM ?? 2.1844;
  const count = params.projectorCount ?? 4;
  const resX = params.resX ?? 1920;
  const resY = params.resY ?? 1080;

  if (count < 1 || count > 4 || !Number.isInteger(count)) {
    throw new Error(
      `projectorCount must be an integer in 1..4 (PARAMETERS.md §2 supports 2, 3 and 4); got ${count}`,
    );
  }

  const intrinsics = intrinsicsFromThrow({
    resX,
    resY,
    distanceM,
    radiusM,
    marginFrac: params.marginFrac,
  });

  const slots = params.slots ?? defaultSlotsFor(count);
  if (slots.length !== count) {
    throw new Error(`slots must name exactly ${count} quadrants, got ${slots.length}`);
  }
  for (const s of slots) {
    if (!Number.isInteger(s) || s < 0 || s > 3) throw new Error(`slot ${s} is not one of 0..3`);
  }
  if (new Set(slots).size !== slots.length) throw new Error(`slots must be distinct: ${slots}`);

  const projectors: ProjectorCalibration[] = [];
  for (let k = 0; k < count; k++) {
    const i = slots[k];
    const phi = NOMINAL_AZIMUTHS_DEG[i] * DEG2RAD;
    const position: Vec3 = {
      x: distanceM * Math.cos(phi),
      y: distanceM * Math.sin(phi),
      // World +Z is up with the origin at the sphere centre, so a lens at
      // h_proj above the floor sits at h_proj - h_center.
      z: projectorHeightM - centerHeightM,
    };
    const aim = aimAtSphereCenter(position);
    projectors.push({
      id: `P${i + 1}`,
      pose: { position, yawDeg: aim.yawDeg, pitchDeg: aim.pitchDeg, rollDeg: 0 },
      intrinsics: { ...intrinsics },
      transfer: nominalTransfer(params.transfer),
      viewport: SOS_QUADRANT_VIEWPORTS[i],
    });
  }

  const rig: RigCalibration = {
    schema: 'sphere-sim/rig-calibration@2',
    sphere: {
      radiusM,
      centerHeightM,
      rotationOffsetDeg: params.rotationOffsetDeg ?? 0,
    },
    blend: nominalBlend(params.blend),
    // PARAMETERS.md §3.4: "Per-projector resolution is half the X screen in each
    // dimension." Four 1920x1080 projectors imply a 3840x2160 X screen.
    framebuffer: { width: resX * 2, height: resY * 2 },
    projectors,
  };

  assertFramebufferTopology(rig);
  return rig;
}

/**
 * Check the invariant PARAMETERS.md §3.4 states, at construction time.
 *
 * "Any resolution figure must state which it means" — so the simulator states it
 * by asserting it. A rig whose framebuffer is not exactly twice the per-projector
 * raster in each dimension is not modelling a spanned X screen, and every
 * viewport composite downstream would be quietly wrong.
 */
export function assertFramebufferTopology(rig: RigCalibration): void {
  for (const p of rig.projectors) {
    const vp = p.viewport;
    const wpx = vp.w * rig.framebuffer.width;
    const hpx = vp.h * rig.framebuffer.height;
    if (Math.abs(wpx - p.intrinsics.resX) > 1e-9 || Math.abs(hpx - p.intrinsics.resY) > 1e-9) {
      throw new Error(
        `projector ${p.id}: viewport ${vp.w}x${vp.h} of a ` +
          `${rig.framebuffer.width}x${rig.framebuffer.height} framebuffer is ${wpx}x${hpx} px, ` +
          `but its raster is ${p.intrinsics.resX}x${p.intrinsics.resY}. PARAMETERS.md §3.4: ` +
          `SOS drives every projector from ONE framebuffer split 2x2, so the X screen is 2x ` +
          `the per-projector resolution in each dimension.`,
      );
    }
    if (vp.x < 0 || vp.y < 0 || vp.x + vp.w > 1 + 1e-12 || vp.y + vp.h > 1 + 1e-12) {
      throw new Error(`projector ${p.id}: viewport ${JSON.stringify(vp)} leaves the framebuffer`);
    }
  }
}

/**
 * How hard to shake each degree of freedom.
 *
 * Defaults come from PARAMETERS.md §2 and §1 where the spec gives a tolerance,
 * and are marked below where they had to be chosen. Every value is a Gaussian
 * standard deviation except where noted, because mount error is a sum of many
 * small independent contributions and a uniform draw would understate the tails
 * the solver actually has to survive.
 */
export interface MisalignmentMagnitudes {
  /** Azimuth about the sphere centre, degrees. §2: "Real mounts hold +/-1-2 deg". */
  azimuthDeg?: number;
  /** Lens to sphere centre, metres. §2 prior is 5.0-6.5; this is the jitter. */
  distanceM?: number;
  /** Lens height, metres. */
  heightM?: number;
  /** Aim error on top of the nominal at-the-centre aim, degrees. */
  yawDeg?: number;
  pitchDeg?: number;
  /** §2: "A degree of roll is invisible on a test grid until it interacts with the blend region." */
  rollDeg?: number;
  /** Horizontal field of view, degrees. */
  fovHDeg?: number;
  /** Lens shift, as a fraction of the half-image dimension. §3.1. */
  shiftH?: number;
  shiftV?: number;
  /** Radial distortion. §3.1: this is what SOS's manual "Vertex Tweaking" fixes by hand. */
  k1?: number;
  k2?: number;
  /** Floor to sphere centre, metres. §1: the documented remedy is "+/- an inch". */
  centerHeightM?: number;
}

export const DEFAULT_MISALIGNMENT: Required<MisalignmentMagnitudes> = {
  // §2 states the mount tolerance as a bound (1-2 deg), not a sigma. Taking
  // sigma = 0.75 puts the 2-sigma point at 1.5 deg, in the middle of the stated
  // band, so a typical draw lands inside the tolerance and the tail does not.
  azimuthDeg: 0.75,
  // The d_proj conflict in §2 spans 5.18 to 6.14 m between two documents. That
  // is a disagreement about the nominal, not a mount tolerance, so it is swept
  // separately by the bench; this is the residual placement error of one lens
  // against its own nominal.
  distanceM: 0.03,
  heightM: 0.02,
  yawDeg: 0.3,
  pitchDeg: 0.3,
  rollDeg: 0.5,
  // fov_h is SOLVE-class and derived from the lens; zoom repeatability on a
  // long-throw lens is the source of this one. Chosen, not documented.
  fovHDeg: 0.15,
  shiftH: 0.01,
  shiftV: 0.01,
  // §3.1 holds k1, k2 at zero nominal but classes them SOLVE precisely because
  // real lenses are not zero. These magnitudes produce about a pixel of
  // displacement at the raster corner, which is the scale "Vertex Tweaking"
  // exists to remove by hand.
  k1: 0.005,
  k2: 0.001,
  // §1: "add or subtract an inch in the config and re-run alignment". One inch
  // is 0.0254 m, and it is the granularity of the documented correction loop, so
  // it is the natural sigma for the error that loop is chasing.
  centerHeightM: 0.0254,
};

/** Exactly what was done to each projector, for scoring a recovery against. */
export interface ProjectorPerturbation {
  id: string;
  azimuthDeg: number;
  distanceM: number;
  heightM: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  fovHDeg: number;
  shiftH: number;
  shiftV: number;
  k1: number;
  k2: number;
  /** Straight-line displacement of the lens from its nominal position, metres. */
  positionErrorM: number;
}

export interface Perturbation {
  seed: number;
  magnitudes: Required<MisalignmentMagnitudes>;
  centerHeightM: number;
  projectors: ProjectorPerturbation[];
}

export interface MisalignedRig {
  rig: RigCalibration;
  perturbation: Perturbation;
}

/**
 * Perturb a rig by seeded amounts drawn from the PARAMETERS.md §2 tolerances,
 * and report exactly what was done.
 *
 * Determinism is the whole contract here: the bench injects a known
 * misalignment, runs the solver on renders of the result, and scores the
 * recovery against this function's own report. If the same seed produced a
 * different rig on a second run, every before/after comparison in the progress
 * page would be measuring noise.
 *
 * Draw order is fixed and documented per projector, in the order the fields are
 * declared. Reordering the draws changes every scenario in the corpus even
 * though no magnitude changed, so treat the order as part of the interface.
 *
 * The azimuth, distance and height perturbations move the lens; the yaw, pitch
 * and roll perturbations are applied on top of a fresh at-the-centre aim from
 * the moved position. That separation matters: it means a pure placement error
 * still produces a rig that is aimed at the sphere, which is what a real
 * installer would leave behind, rather than one that is both misplaced and
 * pointing off into the room.
 */
export function injectMisalignment(
  rig: RigCalibration,
  seed: number,
  magnitudes: MisalignmentMagnitudes = {},
): MisalignedRig {
  const mag: Required<MisalignmentMagnitudes> = { ...DEFAULT_MISALIGNMENT, ...magnitudes };
  const rng: Rng = makeRng(seed);

  const dCenterHeight = rng.normal(0, mag.centerHeightM);
  const centerHeightM = rig.sphere.centerHeightM + dCenterHeight;

  const perturbations: ProjectorPerturbation[] = [];
  const projectors: ProjectorCalibration[] = rig.projectors.map((p) => {
    const nominal = p.pose.position;
    const nominalAzimuth = Math.atan2(nominal.y, nominal.x);
    const nominalDistance = Math.hypot(nominal.x, nominal.y);

    const dAz = rng.normal(0, mag.azimuthDeg);
    const dDist = rng.normal(0, mag.distanceM);
    const dHeight = rng.normal(0, mag.heightM);
    const dYaw = rng.normal(0, mag.yawDeg);
    const dPitch = rng.normal(0, mag.pitchDeg);
    const dRoll = rng.normal(0, mag.rollDeg);
    const dFov = rng.normal(0, mag.fovHDeg);
    const dShiftH = rng.normal(0, mag.shiftH);
    const dShiftV = rng.normal(0, mag.shiftV);
    const dK1 = rng.normal(0, mag.k1);
    const dK2 = rng.normal(0, mag.k2);

    const az = nominalAzimuth + dAz * DEG2RAD;
    const dist = nominalDistance + dDist;
    const position: Vec3 = {
      x: dist * Math.cos(az),
      y: dist * Math.sin(az),
      z: nominal.z + dHeight,
    };
    const aim = aimAtSphereCenter(position);

    perturbations.push({
      id: p.id,
      azimuthDeg: dAz,
      distanceM: dDist,
      heightM: dHeight,
      yawDeg: dYaw,
      pitchDeg: dPitch,
      rollDeg: dRoll,
      fovHDeg: dFov,
      shiftH: dShiftH,
      shiftV: dShiftV,
      k1: dK1,
      k2: dK2,
      positionErrorM: Math.hypot(
        position.x - nominal.x,
        position.y - nominal.y,
        position.z - nominal.z,
      ),
    });

    return {
      id: p.id,
      pose: {
        position,
        yawDeg: aim.yawDeg + dYaw,
        pitchDeg: aim.pitchDeg + dPitch,
        rollDeg: p.pose.rollDeg + dRoll,
      },
      intrinsics: {
        ...p.intrinsics,
        fovHDeg: p.intrinsics.fovHDeg + dFov,
        shiftH: p.intrinsics.shiftH + dShiftH,
        shiftV: p.intrinsics.shiftV + dShiftV,
        k1: p.intrinsics.k1 + dK1,
        k2: p.intrinsics.k2 + dK2,
      },
      transfer: { ...p.transfer },
      viewport: { ...p.viewport },
    };
  });

  return {
    rig: {
      schema: rig.schema,
      sphere: { ...rig.sphere, centerHeightM },
      blend: { ...rig.blend },
      framebuffer: { ...rig.framebuffer },
      projectors,
    },
    perturbation: {
      seed,
      magnitudes: mag,
      centerHeightM: dCenterHeight,
      projectors: perturbations,
    },
  };
}

/**
 * Pixel rectangle a viewport occupies inside the shared framebuffer, in
 * top-left-origin raster coordinates.
 *
 * conventions.ts §V puts the viewport origin at BOTTOM-LEFT, matching the SOS
 * config; image buffers everywhere else in this package have row 0 at the top.
 * The flip lives here, once, so that no call site has to remember it. Getting it
 * wrong swaps the top and bottom quadrant pairs, which on a symmetric four-way
 * rig produces an image that looks entirely correct until someone stands next to
 * the actual sphere.
 */
export function viewportPixelRect(
  viewport: Viewport,
  framebufferWidth: number,
  framebufferHeight: number,
): { x0: number; y0: number; width: number; height: number } {
  const x0 = Math.round(viewport.x * framebufferWidth);
  const width = Math.round(viewport.w * framebufferWidth);
  const height = Math.round(viewport.h * framebufferHeight);
  // Bottom-left origin -> top-left origin.
  const y0 = Math.round(framebufferHeight - (viewport.y + viewport.h) * framebufferHeight);
  return { x0, y0, width, height };
}
