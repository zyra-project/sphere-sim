// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Harness state -> the objects `packages/sim` renders from.
 *
 * One function, `buildWorld`, so the GPU path, the CPU reference path and the
 * metrics panel are all driven from exactly the same `RigCalibration` and
 * `Scene`. If they were each built separately, the parity number this harness
 * exists to display would be measuring the builders rather than the renderers.
 *
 * This module is allowed to do arithmetic on the way from a slider to a rig; it
 * is NOT `packages/calibration`, which holds no math. It imports `packages/sim`
 * because the harness is downstream of the forward model — it is not the third
 * side of the A/B boundary and `tools/boundary-lint.ts` constrains only `sim`,
 * `solver` and `calibration`.
 */

import type {
  ChannelTriplet,
  ProjectorCalibration,
  RigCalibration,
  Vec3,
} from '../../calibration/src/index.ts';
import { aimAtSphereCenter } from '../../sim/src/geometry.ts';
import { nominalRig, SOS_QUADRANT_VIEWPORTS } from '../../sim/src/scene.ts';
import type { Scene, ViewerCamera } from '../../sim/src/render.ts';
import { viewerAt } from '../../sim/src/render.ts';
import type { EquirectImage } from '../../sim/src/equirect.ts';
import { flatField, gridAlignmentPattern } from '../../sim/src/equirect.ts';
import { tintedAmbient } from '../../sim/src/color.ts';
import type { ShadingModel } from '../../sim/src/shading.ts';
import { fullShading, lambertianShading } from '../../sim/src/shading.ts';
import type { HarnessState } from './params.ts';
import { RESOLUTIONS, normalizeState, rampShapeAt } from './params.ts';

const DEG2RAD = Math.PI / 180;

/** The content patterns the harness can put on the sphere. */
export type PatternId = 'graticule' | 'mid-gray' | 'white' | 'black';

export const PATTERNS: readonly { id: PatternId; label: string; why: string }[] = [
  {
    id: 'graticule',
    label: 'Grid alignment pattern',
    why: 'What an SOS operator judges during Grid Alignment. Misregistration reads as a doubled or kinked line.',
  },
  {
    id: 'mid-gray',
    label: 'Flat mid-gray (0.5 linear)',
    why: 'PARAMETERS.md §8 item 13: the blend characterization frame. Seams are at their most visible.',
  },
  {
    id: 'white',
    label: 'Full white',
    why: '§8 item 7: the overlap sum.',
  },
  {
    id: 'black',
    label: 'Full black',
    why: '§8 item 8, projectors ON. The difference against item 9 is the black-floor term that drives every overlap artifact.',
  },
];

export interface WorldOptions {
  /** Equirect texture size for the procedural patterns. */
  textureWidth?: number;
  textureHeight?: number;
  /** Viewer camera raster. */
  viewWidth?: number;
  viewHeight?: number;
}

export interface World {
  state: HarnessState;
  rig: RigCalibration;
  scene: Scene;
  image: EquirectImage;
  viewer: ViewerCamera;
  shading: ShadingModel;
  pattern: PatternId;
  /** Linear multiplier applied at the final encode only. Not physical. */
  exposure: number;
}

function triplet(r: number, g: number, b: number): ChannelTriplet {
  return { r, g, b };
}

/**
 * Build the rig PARAMETERS.md describes, then apply the harness's perturbations.
 *
 * The perturbations are DETERMINISTIC functions of the sliders, not seeded draws:
 * `packages/sim`'s `injectMisalignment` exists for the bench, where a random
 * draw with a recorded seed is the right thing. Here a human is dragging a
 * slider and needs the picture to move monotonically with their finger, so
 * azimuth jitter and roll alternate sign across projectors — see the note on
 * those controls for why a common-mode rotation would look like nothing at all.
 */
export function buildRig(s: HarnessState): RigCalibration {
  const count = Math.max(2, Math.min(4, Math.round(s.N_proj)));
  const resIndex = Math.max(0, Math.min(RESOLUTIONS.length - 1, Math.round(s.res_index)));
  const res = RESOLUTIONS[resIndex];

  const base = nominalRig({
    radiusM: s.R,
    centerHeightM: s.h_center,
    rotationOffsetDeg: s.theta_rot,
    distanceM: s.d_proj,
    projectorHeightM: s.h_proj,
    projectorCount: count,
    resX: res.resX,
    resY: res.resY,
    marginFrac: s.margin_frac,
    blend: {
      rampShape: rampShapeAt(s.ramp_shape),
      widthDeg: s.w_width,
      rampGamma: s.gamma_blend,
      maskLoDeg: s.mask_lo,
      maskHiDeg: s.mask_hi,
      bottomOnly: s.mask_bottom_only >= 0.5,
    },
    transfer: {
      gamma: triplet(s.gamma_R, s.gamma_G, s.gamma_B),
      blackFloor: triplet(s.L_black_R, s.L_black_G, s.L_black_B),
      gain: triplet(s.g_R, s.g_G, s.g_B),
      whitePointK: 6500,
    },
  });

  const projectors: ProjectorCalibration[] = base.projectors.map((p, i) => {
    const sign = i % 2 === 0 ? 1 : -1;
    const nominal = p.pose.position;
    const az = Math.atan2(nominal.y, nominal.x) + sign * s.phi_jitter * DEG2RAD;
    const horizontal = Math.hypot(nominal.x, nominal.y);
    const position: Vec3 = {
      x: horizontal * Math.cos(az),
      y: horizontal * Math.sin(az),
      z: nominal.z,
    };
    const aim = aimAtSphereCenter(position);
    return {
      id: p.id,
      pose: {
        position,
        yawDeg: aim.yawDeg,
        pitchDeg: aim.pitchDeg,
        rollDeg: sign * s.roll,
      },
      intrinsics: {
        ...p.intrinsics,
        shiftH: s.shiftH,
        shiftV: s.shiftV,
        k1: s.k1,
        k2: s.k2,
        // §3.1 holds p1, p2 at zero: "Extra DOF overfits." The harness holds
        // them there too rather than offering a slider for a term the spec
        // instructs implementations not to solve.
        p1: 0,
        p2: 0,
      },
      transfer: { ...p.transfer },
      viewport: { ...p.viewport },
    };
  });

  return { ...base, projectors };
}

/** The content, in LINEAR light. conventions.ts §P. */
export function buildImage(pattern: PatternId, width: number, height: number): EquirectImage {
  switch (pattern) {
    case 'graticule':
      return gridAlignmentPattern({ width, height, spacingDeg: 15, lineWidthDeg: 0.6 });
    case 'mid-gray':
      return flatField(width, height, triplet(0.5, 0.5, 0.5));
    case 'white':
      return flatField(width, height, triplet(1, 1, 1));
    case 'black':
      return flatField(width, height, triplet(0, 0, 0));
  }
}

export function buildScene(s: HarnessState, image: EquirectImage): Scene {
  return {
    image,
    // The harness draws whatever field it was asked for, graticule included when
    // that is the field. Nothing here overlays a second one.
    graticule: null,
    encodeGamma: triplet(s.encode_gamma, s.encode_gamma, s.encode_gamma),
    reflectance: triplet(s.rho_R, s.rho_G, s.rho_B),
    // §5 `E_amb_chroma`: exhibit lighting is rarely daylight-balanced, and the
    // tint belongs to the LIGHT rather than to the surface, so it is built into
    // the ambient triple here rather than folded into reflectance.
    ambient: tintedAmbient(s.E_amb, s.E_amb_chroma),
    roomAlbedo: s.rho_room,
    maskInterpretation: s.mask_interp >= 0.5 ? 'colatitude' : 'latitude',
  };
}

export function buildViewer(s: HarnessState, width: number, height: number): ViewerCamera {
  return viewerAt(s.view_az, s.d_view, s.h_eye, s.h_center, width, height, s.fov_eye);
}

/**
 * `full-v1` whenever the specular lobe is non-zero, `lambertian-v1` at zero.
 *
 * PARAMETERS.md §1 says of `ρ_spec`: "Set to 0 to test sensitivity", and
 * `fullShading` reproduces `lambertianShading` to the last bit at zero. Choosing
 * the cheaper model there is therefore free, and it means the harness's
 * zero-specular render is bit-identical to what every geometric bench capture
 * renders — the picture and the numbers describe the same thing.
 */
export function buildShading(s: HarnessState): ShadingModel {
  return s.rho_spec > 0 ? fullShading({ weight: s.rho_spec, alpha: s.alpha_spec }) : lambertianShading();
}

export function buildWorld(
  partial: Readonly<HarnessState>,
  pattern: PatternId,
  options: WorldOptions = {},
): World {
  const state = normalizeState(partial);
  const image = buildImage(pattern, options.textureWidth ?? 1024, options.textureHeight ?? 512);
  return {
    state,
    rig: buildRig(state),
    scene: buildScene(state, image),
    image,
    viewer: buildViewer(state, options.viewWidth ?? 320, options.viewHeight ?? 240),
    shading: buildShading(state),
    pattern,
    exposure: state.exposure,
  };
}

/** The framebuffer topology §3.4 describes, as a sentence a panel can print. */
export function framebufferSummary(rig: RigCalibration): string {
  const p = rig.projectors[0];
  const quadrants = SOS_QUADRANT_VIEWPORTS.length;
  return (
    `${rig.framebuffer.width}×${rig.framebuffer.height} X screen = one framebuffer split into ` +
    `${quadrants} quadrant viewports of ${p ? p.intrinsics.resX : 0}×${p ? p.intrinsics.resY : 0}, ` +
    `${rig.projectors.length} occupied. PARAMETERS.md §3.4 — not four independent outputs.`
  );
}
