/**
 * One place where a PARAMETERS.md parameter id becomes a number the model actually
 * uses.
 *
 * Experiment 3 sweeps every ASSUME-class photometric constant across its plausible
 * range. That only means anything if each id reaches the model at exactly one place
 * and reaches it completely — a sweep of `rho_spec` that forgot to pass the shading
 * model through would report a sensitivity of zero and look like a finding.
 *
 * Two rules, both enforced here rather than remembered:
 *
 *  1. **An unknown id throws.** A typo must not silently become "nominal", because a
 *     parameter that never moved reports no sensitivity and there is nothing in the
 *     output to distinguish that from a parameter that genuinely does not matter.
 *  2. **The compositor's assumed gamma never moves.** `Scene.encodeGamma` is what the
 *     SOFTWARE believes the display does; `transfer.gamma` is what the display
 *     actually does. PARAMETERS.md §3.2's whole worked example is the case where
 *     they differ, so sweeping `gamma_B` must move the second and leave the first at
 *     2.2. Moving both together would sweep a rig that is perfectly corrected by
 *     construction and report that per-channel gamma does not matter — the exact
 *     opposite of §10's first-ranked risk.
 */

import type { ChannelTriplet, RigCalibration } from '../../../calibration/src/index.ts';
import { PARAMETER_TABLE } from '../../../calibration/src/parameters.ts';
import type { RampShape } from '../../../calibration/src/index.ts';
import type { Scene, ShadingModel } from '../../../sim/src/index.ts';
import {
  defaultScene,
  flatField,
  fullShading,
  nominalRig,
  tintedAmbient,
} from '../../../sim/src/index.ts';

/** Every parameter id {@link buildModel} knows how to apply. */
export const APPLIED_IDS: readonly string[] = [
  'rho_R',
  'rho_G',
  'rho_B',
  'rho_spec',
  'alpha_spec',
  'gamma_R',
  'gamma_G',
  'gamma_B',
  'L_black_R',
  'L_black_G',
  'L_black_B',
  'g_R',
  'g_G',
  'g_B',
  'wp',
  'w_width',
  'gamma_blend',
  'E_amb',
  'E_amb_chroma',
  'mask_lo',
  'mask_hi',
];

/** Overrides keyed by PARAMETERS.md parameter id; anything absent takes its nominal. */
export type Assignment = Readonly<Record<string, number>>;

export interface ModelOptions {
  /** Ramp shape. PARAMETERS.md §4.5 calls the shape unpublished; nominal is cosine. */
  rampShape?: RampShape;
  /** Projector count. §2 supports 2, 3 and 4; both experiments run the nominal 4. */
  projectorCount?: number;
}

export interface BuiltModel {
  rig: RigCalibration;
  scene: Scene;
  /** Must be passed to every metric call, or `rho_spec` and `alpha_spec` are inert. */
  shading: ShadingModel;
  /** Every value actually applied, nominal or swept, for the results file. */
  applied: Record<string, number>;
}

function nominalOf(id: string): number {
  const spec = PARAMETER_TABLE[id];
  if (spec === undefined) throw new Error(`no such parameter in PARAMETER_TABLE: ${id}`);
  return spec.nominal;
}

/**
 * Build the rig, scene and shading model an assignment describes.
 *
 * Everything not named in `assignment` takes its PARAMETERS.md nominal, read from
 * `PARAMETER_TABLE` rather than written out again here — a second copy of the
 * nominals is a second place for them to drift from the spec.
 */
export function buildModel(assignment: Assignment = {}, options: ModelOptions = {}): BuiltModel {
  for (const id of Object.keys(assignment)) {
    if (!APPLIED_IDS.includes(id)) {
      throw new Error(
        `buildModel cannot apply '${id}'. Known ids: ${APPLIED_IDS.join(', ')}. ` +
          `An id this function silently ignored would report zero sensitivity, which is ` +
          `indistinguishable in the output from a constant that genuinely does not matter.`,
      );
    }
  }

  const value = (id: string): number => assignment[id] ?? nominalOf(id);
  const triplet = (r: string, g: string, b: string): ChannelTriplet => ({
    r: value(r),
    g: value(g),
    b: value(b),
  });

  const maskLoDeg = value('mask_lo');
  const maskHiDeg = value('mask_hi');
  if (!(maskHiDeg >= maskLoDeg)) {
    throw new Error(
      `mask_hi (${maskHiDeg}) must not be below mask_lo (${maskLoDeg}); ` +
        `PARAMETERS.md §4.4 reads 'set bottommask 60,70' as onset then full mask.`,
    );
  }

  const rig = nominalRig({
    projectorCount: options.projectorCount ?? 4,
    blend: {
      rampShape: options.rampShape ?? 'cosine',
      widthDeg: value('w_width'),
      rampGamma: value('gamma_blend'),
      maskLoDeg,
      maskHiDeg,
    },
    transfer: {
      gamma: triplet('gamma_R', 'gamma_G', 'gamma_B'),
      blackFloor: triplet('L_black_R', 'L_black_G', 'L_black_B'),
      gain: triplet('g_R', 'g_G', 'g_B'),
      whitePointK: value('wp'),
    },
  });

  // The source image is never sampled by the photometric metrics — §8 item 13
  // prescribes a flat field and every metric generates its own — but `Scene`
  // requires one, and a flat mid-gray is the honest placeholder.
  const scene = defaultScene(flatField(8, 4, { r: 0.5, g: 0.5, b: 0.5 }), {
    reflectance: triplet('rho_R', 'rho_G', 'rho_B'),
    ambient: tintedAmbient(value('E_amb'), value('E_amb_chroma')),
  });

  const shading = fullShading({ weight: value('rho_spec'), alpha: value('alpha_spec') });

  const applied: Record<string, number> = {};
  for (const id of APPLIED_IDS) applied[id] = value(id);

  return { rig, scene, shading, applied };
}
