// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The slider manifest — every control the harness exposes, with the provenance
 * class of the constant it moves.
 *
 * ## Why this file is data rather than markup
 *
 * PARAMETERS.md's central claim is that the geometric half of the parameter set
 * is `DOC`/`CFG`/`SOLVE` and the photometric half is `ASSUME`/`MEAS`, and that
 * the second half is "where the bar breaks". A harness that lets a human drag a
 * slider without telling them which half they are in would quietly undo that,
 * because a number you can move with your finger feels like a number somebody
 * checked. So every control carries its class, its section, whether its RANGE is
 * stated by the spec or inferred by us, and a note; the UI is required to render
 * the class and to mark `ASSUME` distinctly, and `test/params.test.ts` asserts
 * that every `ASSUME` control in this table is reachable from the rendered page.
 *
 * Values and ranges come from `packages/calibration/src/parameters.ts` wherever
 * that table has the parameter, so the harness and the sensitivity experiment
 * cannot disagree about what "plausible" means. Where it does not — the sliders
 * this file adds for things the table never needed, like lens shift or the
 * viewer azimuth — `rangeSource` says `'harness'` and the note says why, because
 * an invented range presented next to a stated one is exactly the confusion
 * docs/AMENDMENTS.md A-04 records.
 *
 * `rangeSource: 'harness'` also covers a second, different case: a `DOC` constant
 * PARAMETERS.md states exactly, such as the sphere radius. The slider exists so a
 * human can see what the model does off-nominal. It is not a claim that the value
 * is uncertain, and the note on each such control says so.
 */

import type { ParamClass } from '../../calibration/src/parameters.ts';
import { PARAMETER_TABLE } from '../../calibration/src/parameters.ts';

export type { ParamClass };

/** How a control is presented. No `enum` — Node 22 type stripping forbids it. */
export type ControlKind = 'range' | 'select' | 'toggle';

export interface ControlOption {
  value: number;
  label: string;
}

export interface ControlSpec {
  /** Stable key into {@link HarnessState}. */
  id: string;
  /** Symbol as PARAMETERS.md writes it, or a harness-local name. */
  symbol: string;
  label: string;
  /** PARAMETERS.md section, used to group the panel. */
  section: string;
  klass: ParamClass;
  kind: ControlKind;
  nominal: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  /**
   * `stated` — PARAMETERS.md gives this range.
   * `inferred` — we inferred it (docs/AMENDMENTS.md A-04).
   * `harness` — the slider's travel is a harness framing choice, not a claim
   *   about uncertainty. Every `harness` control's note says which it is.
   */
  rangeSource: 'stated' | 'inferred' | 'harness';
  affects: 'geometry' | 'photometry' | 'both';
  /** Decimal places to print. */
  decimals: number;
  note: string;
  options?: ControlOption[];
}

export interface ControlGroup {
  /** PARAMETERS.md section id, e.g. `§3.2`. */
  section: string;
  title: string;
  /** One sentence naming what a reader should expect the group to change. */
  blurb: string;
  controls: ControlSpec[];
}

/**
 * Pull nominal / min / max / class / note from the calibration table, so the
 * harness cannot drift from the sensitivity experiment's idea of a range.
 * `overrides` covers presentation only (step, decimals) plus the deliberate
 * range widenings, each of which must state itself in the note.
 */
function fromTable(id: string, overrides: Partial<ControlSpec> & { decimals: number }): ControlSpec {
  const spec = PARAMETER_TABLE[id];
  if (!spec) {
    throw new Error(
      `no parameter '${id}' in packages/calibration/src/parameters.ts PARAMETER_TABLE. ` +
        `Known ids: ${Object.keys(PARAMETER_TABLE).join(', ')}`,
    );
  }
  const min = overrides.min ?? spec.min;
  const max = overrides.max ?? spec.max;
  return {
    id,
    symbol: spec.symbol,
    label: spec.name,
    section: spec.section,
    klass: spec.klass,
    kind: 'range',
    nominal: spec.nominal,
    min,
    max,
    step: overrides.step ?? (max - min) / 200,
    unit: spec.unit,
    rangeSource:
      overrides.rangeSource ?? (min === spec.min && max === spec.max ? spec.rangeSource : 'harness'),
    affects: spec.affects,
    decimals: overrides.decimals,
    note: overrides.note ?? spec.note,
    ...(overrides.options ? { options: overrides.options } : {}),
    ...(overrides.kind ? { kind: overrides.kind } : {}),
    ...(overrides.label ? { label: overrides.label } : {}),
    ...(overrides.symbol ? { symbol: overrides.symbol } : {}),
  };
}

/** A control the calibration table does not carry. Every field is explicit. */
function local(spec: ControlSpec): ControlSpec {
  return spec;
}

const BLACK_FLOOR_NOTE =
  '1/800 nominal, plausible range 1/2000 to 1/300 — a factor of six. PARAMETERS.md §10 ranks this ' +
  'the second-highest photometric risk because so much SOS content is dark.';

export const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    section: '§1',
    title: 'Sphere geometry and surface',
    blurb:
      'The sphere itself. Geometry here is DOC or SOLVE; the four reflectance terms are ASSUME ' +
      'and scale every photometric result.',
    controls: [
      fromTable('R', {
        decimals: 4,
        min: 0.6,
        max: 1.2,
        step: 0.0001,
        rangeSource: 'harness',
        note:
          'PARAMETERS.md §1 fixes this at 0.8636 m (68 in diameter), class DOC. The slider travel is ' +
          'a harness framing choice so a human can see the model off-nominal — it is NOT a claim ' +
          'that the radius is uncertain. Other sphere sizes exist, which is why §1 says keep it configurable.',
      }),
      fromTable('h_center', {
        decimals: 4,
        min: 2.05,
        max: 2.32,
        step: 0.0005,
        note:
          '§1 nominal 2.1844 m (7 ft 2 in), class DOC/SOLVE. The calibration table’s range is the documented ' +
          '±1 inch trial-and-error correction; this slider travels wider so the failure §1’s note describes — ' +
          'vertical grid lines diverging near the poles — is reachable by eye. Our bundle adjustment treats it ' +
          'as a free parameter, which is why it is SOLVE rather than MEAS.',
      }),
      fromTable('theta_rot', { decimals: 1, step: 1 }),
      fromTable('rho_R', { decimals: 3, step: 0.005 }),
      fromTable('rho_G', {
        decimals: 3,
        step: 0.005,
        note:
          'Matte white paint, green channel. §1 gives 0.90 and no range at all; the 0.80-0.95 span is ' +
          'inferred (docs/AMENDMENTS.md A-04). §10 ranks reflectance fourth of the four highest photometric ' +
          'risks — a narrower range than the others, but it scales every photometric result.',
      }),
      fromTable('rho_B', { decimals: 3, step: 0.005 }),
      fromTable('rho_spec', { decimals: 3, step: 0.001 }),
      fromTable('alpha_spec', { decimals: 3, step: 0.005 }),
    ],
  },
  {
    section: '§2',
    title: 'Projector placement',
    blurb:
      'All six pose degrees of freedom are SOLVE — the nominals only initialize a solver. ' +
      'd_proj is the conflict §2 declines to settle.',
    controls: [
      fromTable('d_proj', { decimals: 3, step: 0.01 }),
      fromTable('h_proj', { decimals: 3, step: 0.005 }),
      local({
        id: 'N_proj',
        symbol: 'N_proj',
        label: 'Projector count',
        section: '§2',
        klass: 'CFG',
        kind: 'select',
        nominal: 4,
        min: 2,
        max: 4,
        step: 1,
        unit: '',
        rangeSource: 'stated',
        affects: 'both',
        decimals: 0,
        note:
          '§2: "2- and 3-projector installs are supported; quadrants go dark." Which quadrants is not ' +
          'stated; conventions.ts §N.2 pins slots {0,2} for N=2 and {0,1,2} for N=3 (AMENDMENTS A-06, A-19). ' +
          'The unlit-in-mask gate is unsatisfiable below N=4 — that is A-10, not a bug.',
        options: [
          { value: 2, label: '2 (opposed, slots 0 and 2)' },
          { value: 3, label: '3 (slots 0, 1, 2)' },
          { value: 4, label: '4 (all quadrants)' },
        ],
      }),
      fromTable('phi_jitter', {
        decimals: 2,
        step: 0.05,
        label: 'Azimuth jitter (alternating sign)',
        note:
          '§2: "Real mounts hold ±1–2°". Applied with ALTERNATING SIGN across projectors — a common-mode ' +
          'rotation of the whole rig is a gauge freedom and is very nearly invisible (AMENDMENTS A-09), ' +
          'so a single-sign slider would look like it did nothing.',
      }),
      local({
        id: 'roll',
        symbol: 'roll',
        label: 'Roll (alternating sign)',
        section: '§2',
        klass: 'SOLVE',
        kind: 'range',
        nominal: 0,
        min: -3,
        max: 3,
        step: 0.05,
        unit: 'deg',
        rangeSource: 'harness',
        affects: 'geometry',
        decimals: 2,
        note:
          '§2 gives roll a nominal of 0 and no tolerance: "A degree of roll is invisible on a test grid ' +
          'until it interacts with the blend region." The travel is a harness choice. Alternating sign, ' +
          'for the reason the azimuth jitter alternates.',
      }),
    ],
  },
  {
    section: '§3.1',
    title: 'Optics, distortion and the shared framebuffer',
    blurb:
      'Per-projector raster, not the X screen — §3.4 makes the framebuffer twice this in each dimension. ' +
      'k1/k2 are what SOS’s manual "Vertex Tweaking" stage compensates by hand.',
    controls: [
      local({
        id: 'res_index',
        symbol: 'res_proj',
        label: 'Native resolution per projector',
        section: '§3.1',
        klass: 'CFG',
        kind: 'select',
        nominal: 1,
        min: 0,
        max: 2,
        step: 1,
        unit: '',
        rangeSource: 'stated',
        affects: 'both',
        decimals: 0,
        note:
          '§3.1 gives 1920×1080 or 3840×2160 PER PROJECTOR. §3.4: SOS drives all four from ONE framebuffer ' +
          'split 2×2, so the X screen is twice this in each dimension — 7680×4320 for four native-4K units.',
        options: [
          { value: 0, label: '1280×720 (framebuffer 2560×1440)' },
          { value: 1, label: '1920×1080 (framebuffer 3840×2160)' },
          { value: 2, label: '3840×2160 (framebuffer 7680×4320)' },
        ],
      }),
      local({
        id: 'margin_frac',
        symbol: 'marginFrac',
        label: 'Silhouette headroom in the minor dimension',
        section: '§3.1',
        klass: 'ASSUME',
        kind: 'range',
        nominal: 0.02,
        min: 0,
        max: 0.12,
        step: 0.002,
        unit: 'fraction',
        rangeSource: 'harness',
        affects: 'geometry',
        decimals: 3,
        note:
          'PARAMETERS.md never states it. conventions.ts §N.1 pins 0.02 because two implementations ' +
          'independently picked 0.02 and 0, and the undeclared 0.63° gap in field of view is the whole of ' +
          'docs/AMENDMENTS.md A-17. At zero the limb lands exactly on the raster edge and coverage grows a ' +
          'ragged fringe — visible in the projector views as you drag this to 0.',
      }),
      local({
        id: 'k1',
        symbol: 'k1',
        label: 'Radial distortion k1',
        section: '§3.1',
        klass: 'SOLVE',
        kind: 'range',
        nominal: 0,
        min: -0.06,
        max: 0.06,
        step: 0.001,
        unit: '',
        rangeSource: 'harness',
        affects: 'geometry',
        decimals: 4,
        note:
          '§3.1 nominal 0, class SOLVE, no stated range. The scene.ts misalignment sigma is 0.005, which ' +
          'produces about a pixel of displacement at the raster corner — the scale "Vertex Tweaking" removes ' +
          'by hand. The travel here is roughly ten sigma so the effect is visible.',
      }),
      local({
        id: 'k2',
        symbol: 'k2',
        label: 'Radial distortion k2',
        section: '§3.1',
        klass: 'SOLVE',
        kind: 'range',
        nominal: 0,
        min: -0.02,
        max: 0.02,
        step: 0.0005,
        unit: '',
        rangeSource: 'harness',
        affects: 'geometry',
        decimals: 4,
        note: '§3.1 nominal 0, class SOLVE, no stated range. Travel is roughly ten times scene.ts’s sigma.',
      }),
      local({
        id: 'shiftH',
        symbol: 'shift_h',
        label: 'Lens shift, horizontal',
        section: '§3.1',
        klass: 'SOLVE',
        kind: 'range',
        nominal: 0,
        min: -0.15,
        max: 0.15,
        step: 0.002,
        unit: 'fraction of half-image',
        rangeSource: 'harness',
        affects: 'geometry',
        decimals: 3,
        note:
          '§3.1 gives a nominal of 0, a class of SOLVE, and NO uncertainty — which is docs/AMENDMENTS.md A-12, ' +
          'and that omission decides the §7 rotation gate. At this geometry 0.01 of shift is worth 0.17° of ' +
          'yaw, so shift and pointing are very nearly the same parameter.',
      }),
      local({
        id: 'shiftV',
        symbol: 'shift_v',
        label: 'Lens shift, vertical',
        section: '§3.1',
        klass: 'SOLVE',
        kind: 'range',
        nominal: 0,
        min: -0.15,
        max: 0.15,
        step: 0.002,
        unit: 'fraction of half-image',
        rangeSource: 'harness',
        affects: 'geometry',
        decimals: 3,
        note: 'As shift_h. Non-zero for ceiling mounts, per §3.1. See docs/AMENDMENTS.md A-12.',
      }),
    ],
  },
  {
    section: '§3.2',
    title: 'Per-channel transfer — twelve gammas, twelve floors, twelve gains',
    blurb:
      'The rev 2 change, and the reason the simulator exists. Every control in this group is ASSUME or MEAS. ' +
      'Set the projector’s blue gamma to 2.4 while the compositor still encodes at 2.2 to reproduce §3.2’s worked yellow band.',
    controls: [
      fromTable('gamma_R', { decimals: 3, step: 0.005 }),
      fromTable('gamma_G', {
        decimals: 3,
        step: 0.005,
        note:
          'Green channel of the projector’s ACTUAL transfer. §3.2: "Real projectors diverge 0.1-0.3 between ' +
          'channels", twelve values across the rig. Drag one channel away from the others and watch the ' +
          'divergence readings in the metrics panel rather than the seam gates — that gap is A-15.',
      }),
      fromTable('gamma_B', { decimals: 3, step: 0.005 }),
      fromTable('L_black_R', { decimals: 5, step: 0.00002, note: BLACK_FLOOR_NOTE }),
      fromTable('L_black_G', { decimals: 5, step: 0.00002, note: BLACK_FLOOR_NOTE }),
      fromTable('L_black_B', {
        decimals: 5,
        step: 0.00002,
        note: `${BLACK_FLOOR_NOTE} DLP and LCD leak differently per channel, so the uplift in an overlap is tinted.`,
      }),
      fromTable('g_R', { decimals: 3, step: 0.002 }),
      fromTable('g_G', {
        decimals: 3,
        step: 0.002,
        note:
          'Green channel gain. §3.2: "Four lamps at different hour counts give four different white points." ' +
          'PARAMETERS.md publishes no range for gain; 0.85-1.15 is inferred (docs/AMENDMENTS.md A-04).',
      }),
      fromTable('g_B', {
        decimals: 3,
        step: 0.002,
        note:
          'Blue channel gain. Together with g_R and g_G this triple IS the projector’s white point — §3.2 ' +
          'says wp_i is "derived from g; tracked separately for reporting", which docs/AMENDMENTS.md A-27 ' +
          'asks be marked as derived rather than as an independent constant.',
      }),
      local({
        id: 'encode_gamma',
        symbol: 'encodeGamma',
        label: 'Compositor’s ASSUMED encode gamma',
        section: '§3.2',
        klass: 'ASSUME',
        kind: 'range',
        nominal: 2.2,
        min: 1.9,
        max: 2.5,
        step: 0.005,
        unit: '',
        rangeSource: 'harness',
        affects: 'photometry',
        decimals: 3,
        note:
          'What the SOFTWARE thinks the display does, as against γ_R,G,B which is what the display actually ' +
          'does. §3.2’s worked example is exactly the case where they differ. One scalar, applied to all three ' +
          'channels, because SOS carries one number.',
      }),
    ],
  },
  {
    section: '§4',
    title: 'Blending and polar masking',
    blurb:
      'γ_blend is the one DOC-class photometric constant in the whole document. The mask’s units are inferred ' +
      'and that inference governs the domain of §7’s only gate with no tolerance (A-02).',
    controls: [
      local({
        id: 'ramp_shape',
        symbol: 'w(θ)',
        label: 'Blend ramp shape',
        section: '§4.5',
        klass: 'ASSUME',
        kind: 'select',
        nominal: 1,
        min: 0,
        max: 3,
        step: 1,
        unit: '',
        rangeSource: 'harness',
        affects: 'photometry',
        decimals: 0,
        note:
          '§4.5: "Shape unpublished." conventions.ts §B defines four; none of them is a measurement. ' +
          'PARAMETERS.md §8 item 13 is the frame that would settle it.',
        options: [
          { value: 0, label: 'linear' },
          { value: 1, label: 'cosine (nominal)' },
          { value: 2, label: 'smoothstep' },
          { value: 3, label: 'gaussian' },
        ],
      }),
      fromTable('w_width', { decimals: 2, step: 0.25 }),
      fromTable('gamma_blend', { decimals: 3, step: 0.005 }),
      fromTable('mask_lo', { decimals: 2, step: 0.25 }),
      fromTable('mask_hi', { decimals: 2, step: 0.25 }),
      local({
        id: 'mask_interp',
        symbol: 'bottommask units',
        label: 'How `set bottommask 60,70` is read',
        section: '§4.4',
        klass: 'ASSUME',
        kind: 'select',
        nominal: 0,
        min: 0,
        max: 1,
        step: 1,
        unit: '',
        rangeSource: 'stated',
        affects: 'both',
        decimals: 0,
        note:
          'docs/AMENDMENTS.md A-02. §4.4 reads 60 and 70 as absolute LATITUDE and marks the reading ' +
          '"ASSUME — verify". Read as colatitude the protected region roughly triples and §7’s hard 0% ' +
          'unlit gate applies over a much larger area at much worse incidence. Watch the metrics panel when you switch.',
        options: [
          { value: 0, label: 'latitude (§4.4’s reading)' },
          { value: 1, label: 'colatitude (the alternative)' },
        ],
      }),
      local({
        id: 'mask_bottom_only',
        symbol: 'bottomOnly',
        label: 'Mask the south pole only',
        section: '§4.4',
        klass: 'DOC',
        kind: 'toggle',
        nominal: 1,
        min: 0,
        max: 1,
        step: 1,
        unit: '',
        rangeSource: 'stated',
        affects: 'both',
        decimals: 0,
        note:
          '§4.4: the sphere hangs from a ceiling mount that physically occludes the north polar cap, so only ' +
          'the exposed bottom needs a software mask. The asymmetry in the config is explained by the hardware.',
      }),
    ],
  },
  {
    section: '§5',
    title: 'Room environment',
    blurb:
      'Every entry is ASSUME. E_amb and its colour temperature are third on §10’s risk list: ambient crushes ' +
      'contrast and shifts every ΔE.',
    controls: [
      fromTable('E_amb', { decimals: 4, step: 0.001 }),
      fromTable('E_amb_chroma', { decimals: 0, step: 25 }),
      fromTable('rho_room', { decimals: 3, step: 0.005 }),
    ],
  },
  {
    section: '§6',
    title: 'Viewer',
    blurb:
      '§6 is emphatic that both the adult (1.60 m) and child (1.15 m) cases must be run: the equator sits at ' +
      '2.18 m so everyone looks up, children steeply, and children are a large share of the SOS audience.',
    controls: [
      local({
        id: 'h_eye',
        symbol: 'h_eye',
        label: 'Eye height',
        section: '§6',
        klass: 'ASSUME',
        kind: 'range',
        nominal: 1.6,
        min: 0.9,
        max: 1.9,
        step: 0.01,
        unit: 'm',
        rangeSource: 'harness',
        affects: 'geometry',
        decimals: 2,
        note:
          '§6 gives two values rather than a range: 1.60 m adult, 1.15 m child, and says RUN BOTH. This one ' +
          'slider spans them; the presets below jump to each.',
      }),
      fromTable('d_view', { decimals: 2, step: 0.02 }),
      fromTable('fov_eye', { decimals: 1, step: 0.5 }),
      local({
        id: 'view_az',
        symbol: 'view_az',
        label: 'Viewer azimuth',
        section: '§6',
        klass: 'CFG',
        kind: 'range',
        nominal: 45,
        min: -180,
        max: 180,
        step: 1,
        unit: 'deg',
        rangeSource: 'harness',
        affects: 'geometry',
        decimals: 0,
        note:
          'Framing only; no metric depends on it (§6, asserted in packages/sim/test/metrics.test.ts). The ' +
          'default of 45° puts the viewer on a SEAM direction, which is where §4.3 says coverage is worst and ' +
          'where the blend artifacts live.',
      }),
      local({
        id: 'exposure',
        symbol: 'exposure',
        label: 'Display exposure',
        section: '§6',
        klass: 'CFG',
        kind: 'range',
        nominal: 1,
        min: 0.25,
        max: 8,
        step: 0.05,
        unit: '×',
        rangeSource: 'harness',
        affects: 'photometry',
        decimals: 2,
        note:
          'A display control, not a physical one: a linear multiplier applied at the final encode step only ' +
          '(png.ts EncodeOptions). Push it to 6–8 to see the projector black floor on the floor plane, which is ' +
          'the most recognizable feature of a real SOS room photograph.',
      }),
    ],
  },
];

/** Every control, flattened, in panel order. */
export const ALL_CONTROLS: readonly ControlSpec[] = CONTROL_GROUPS.flatMap((g) => g.controls);

/** Harness state is one number per control id. Nothing else. */
export type HarnessState = Record<string, number>;

export function defaultState(): HarnessState {
  const state: HarnessState = {};
  for (const c of ALL_CONTROLS) state[c.id] = c.nominal;
  return state;
}

/**
 * Clamp a state to the declared ranges and fill in anything missing.
 *
 * Called on every state that arrives from outside the manifest — a URL fragment,
 * a preset, a stale localStorage entry — so a control that was removed or
 * re-ranged cannot put a NaN or an out-of-range value into the rig builder and
 * produce a render nobody can explain.
 */
export function normalizeState(partial: Readonly<HarnessState>): HarnessState {
  const out = defaultState();
  for (const c of ALL_CONTROLS) {
    const v = partial[c.id];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[c.id] = v < c.min ? c.min : v > c.max ? c.max : v;
  }
  return out;
}

/** Which controls are class ASSUME — the ones the UI must mark. */
export const ASSUME_CONTROL_IDS: readonly string[] = ALL_CONTROLS.filter(
  (c) => c.klass === 'ASSUME',
).map((c) => c.id);

/** Per-projector raster for each `res_index` option. §3.1 / §3.4. */
export const RESOLUTIONS: readonly { resX: number; resY: number }[] = [
  { resX: 1280, resY: 720 },
  { resX: 1920, resY: 1080 },
  { resX: 3840, resY: 2160 },
];

/** conventions.ts §B ramp shapes, indexed by the `ramp_shape` control. */
export const RAMP_SHAPE_BY_INDEX: readonly ('linear' | 'cosine' | 'smoothstep' | 'gaussian')[] = [
  'linear',
  'cosine',
  'smoothstep',
  'gaussian',
];

/**
 * The ramp shape a control index names.
 *
 * The clamp used to be written inline as `Math.max(0, Math.min(3, Math.round(v)))`,
 * which holds for every finite input and fails for exactly one: `Math.round(NaN)`
 * is NaN, and both clamps pass it straight through, so the lookup yielded
 * `undefined` and the rig carried a shape that is not a shape. `normalizeState`
 * drops non-finite values before they ever get here, so nothing in this
 * repository could reach it — but `buildRig` is exported, and a guarantee that
 * depends on every caller having gone through a different function first is not
 * a guarantee.
 */
export function rampShapeAt(index: number): (typeof RAMP_SHAPE_BY_INDEX)[number] {
  if (!Number.isFinite(index)) {
    throw new Error(`ramp_shape must be a finite control index in 0..3; got ${index}`);
  }
  return RAMP_SHAPE_BY_INDEX[Math.max(0, Math.min(3, Math.round(index)))];
}

/**
 * Named starting points. Each is a partial state; the rest stays at nominal.
 *
 * These are not "scenarios" in the bench's sense and produce no scores. They
 * exist so a human can reach the two or three configurations the documents argue
 * about without setting eight sliders by hand and wondering whether they got it
 * right.
 */
export interface Preset {
  id: string;
  label: string;
  why: string;
  state: Readonly<HarnessState>;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'nominal',
    label: 'PARAMETERS.md nominal',
    why: 'Every control at its documented nominal. Four projectors, no misalignment, no divergence.',
    state: {},
  },
  {
    id: 'yellow-band',
    label: '§3.2 worked example — the yellow band',
    why:
      'Every projector’s blue channel at γ = 2.4 while the compositor still encodes at 2.2. §3.2 works the ' +
      'arithmetic: blue emits 0.730^2.4 = 0.469 per projector against 0.500, a 6% blue deficit in the overlap ' +
      'that reads as a yellow band. No scalar gamma can correct it.',
    state: { gamma_B: 2.4, exposure: 1 },
  },
  {
    id: 'child',
    label: '§6 child viewer',
    why:
      'Eye height 1.15 m at the guard rail. The equator is at 2.18 m, so a child looks up steeply and sees far ' +
      'more of the masked polar region than an adult does.',
    state: { h_eye: 1.15, d_view: 2.0 },
  },
  {
    id: 'dark-content',
    label: 'Dark content, black floor visible',
    why:
      'Black floors at the top of their plausible range (1/300), ambient at the bottom, exposure up. This is ' +
      'the configuration §7’s black-uplift gate is about, and the one where the floor spill is obvious.',
    state: {
      L_black_R: 0.003333,
      L_black_G: 0.003333,
      L_black_B: 0.003333,
      E_amb: 0.01,
      exposure: 6,
    },
  },
  {
    id: 'three-projectors',
    label: '§2 three-projector install',
    why:
      'Slots 0, 1, 2 per conventions.ts §N.2. One 90° wedge of longitude is lit only by its neighbours’ skirts. ' +
      'The unlit-in-mask metric goes non-zero and stays there — docs/AMENDMENTS.md A-10, not a defect.',
    state: { N_proj: 3 },
  },
  {
    id: 'colatitude-mask',
    label: 'A-02: read the mask as colatitude',
    why:
      'The same `set bottommask 60,70` read as degrees from the pole. The protected region roughly triples and ' +
      '§7’s hard unlit gate starts applying over ground at much worse incidence.',
    state: { mask_interp: 1 },
  },
  {
    id: 'misaligned',
    label: 'Mount tolerance at §2’s limit',
    why:
      '2° of azimuth jitter and 1.5° of roll, alternating sign, plus lens shift and radial distortion. What the ' +
      'seams look like before anybody aligns anything.',
    state: { phi_jitter: 2, roll: 1.5, shiftH: 0.03, k1: 0.02 },
  },
];

export function presetState(preset: Preset): HarnessState {
  return normalizeState({ ...defaultState(), ...preset.state });
}
