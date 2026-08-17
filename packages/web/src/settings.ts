/**
 * The panel model: every number a visitor can move, in the words a visitor uses.
 *
 * ## Two vocabularies, one set of constants
 *
 * PARAMETERS.md names things `d_proj`, `h_center`, `fov_h`, `marginFrac`. Those
 * names are correct and this project will not rename them. But a person standing
 * in front of a sphere asks "how far back is it" and "how much does the picture
 * overfill the ball", so every control here carries BOTH: a plain label the page
 * shows, and the exact PARAMETERS.md symbol it drives, printed next to it. The
 * translation happens in `rigs.ts` and nowhere else.
 *
 * ## Why the defaults are Boulder's and not the spec's
 *
 * docs/AMENDMENTS.md **A-36**. NOAA Boulder's live `sos_stream_control.config`
 * disagrees with PARAMETERS.md §1 and §2 on three constants — equator height,
 * projector height, and lens distance. The spec is authoritative for the
 * project's numbers and stays that way; the amendment is OPEN and nothing has
 * been applied to it.
 *
 * This page nevertheless opens at Boulder's values, for one reason: it is a
 * simulator of a real room, and a visitor who types the site's own config into
 * it should see the site. {@link SPEC_PRESET} restores the documented figures in
 * one click, and the page prints the delta between the two whenever they differ,
 * so the conflict is visible rather than resolved by a default.
 *
 * The consequences A-36 identifies are live at these defaults and the readout
 * says so: an 8-inch lens rise makes the horizontal-vs-3D reading of `d_proj`
 * worth 3.85 mm against a 2 mm gate, and gives the aim a real −2.17° elevation
 * where the spec's level rig has none.
 */

import { NOMINAL_SILHOUETTE_MARGIN_FRAC } from '../../calibration/src/conventions.ts';

/** Inches to metres. The SOS config is in inches; this project is in metres. */
export const IN_TO_M = 0.0254;

/** How a control is presented, and what it actually drives. */
export interface ControlSpec {
  key: SettingKey;
  /** What the page calls it. */
  label: string;
  /** The PARAMETERS.md symbol, printed next to the label. Empty when there is none. */
  symbol: string;
  /** Which section of PARAMETERS.md governs it. */
  section: string;
  /** Provenance class of the constant this moves. Drives the colour of the row. */
  klass: 'DOC' | 'CFG' | 'SOLVE' | 'ASSUME' | 'MEAS' | 'PANEL';
  min: number;
  max: number;
  step: number;
  /** Printed after the value. */
  unit: string;
  decimals: number;
  /** Discrete labels, when the control is a choice rather than a quantity. */
  options?: readonly string[];
  /** Which group it belongs to on the page. */
  group: GroupId;
  /** One or two sentences, written for someone who has never seen the project. */
  help: string;
}

export type GroupId = 'install' | 'lens' | 'error' | 'blend' | 'view';

export interface Group {
  id: GroupId;
  title: string;
  blurb: string;
}

export const GROUPS: readonly Group[] = [
  {
    id: 'install',
    title: 'The room',
    blurb:
      'What was built: the ball, how high it hangs, and how many projectors ring it. ' +
      'These are the numbers on a site survey, and both the projectors and the software agree on them.',
  },
  {
    id: 'lens',
    title: 'The lenses',
    blurb:
      'Where each projector sits and how wide it throws. The distance and the overfill together ' +
      'decide the field of view, which is the single number the recovery is most sensitive to ' +
      '(amendment A-18).',
  },
  {
    id: 'error',
    title: 'What went wrong',
    blurb:
      'Nobody mounts four projectors perfectly. This shakes the rig by the tolerances PARAMETERS.md §2 ' +
      'states — and the software is not told. That gap is the whole problem the solver exists to close.',
  },
  {
    id: 'blend',
    title: 'Seams and the polar hole',
    blurb:
      'How the overlapping projectors crossfade, and where the bottom mask starts. Every number in ' +
      'this group is class ASSUME — nobody has measured one of them — so anything downstream of it ' +
      'is marked PROVISIONAL.',
  },
  {
    id: 'view',
    title: 'The view',
    blurb: 'Where you are standing. Changes nothing about the rig and no metric may depend on it (§6).',
  },
];

export interface Settings {
  // ---- the room -----------------------------------------------------------
  /** Sphere diameter, inches. PARAMETERS.md §1 `R` at 68 in = 0.8636 m. */
  sphereDiaIn: number;
  /** Equator height off the floor, inches. §1 `h_center`. Boulder 84, spec 86. */
  equatorIn: number;
  /** §2: 2, 3 and 4 are all supported installs. */
  projectorCount: number;
  /** Index into {@link RESOLUTIONS}. §3.1 / §3.4 — per projector, not the X screen. */
  resolution: number;

  // ---- the lenses ---------------------------------------------------------
  /** Lens to sphere centre, metres. §2 `d_proj`, CONFLICTED. Boulder 5.3594. */
  distanceM: number;
  /** Lens height above the equator, metres. Boulder +0.2032; the spec says 0. */
  lensRiseM: number;
  /** Silhouette headroom in the minor raster dimension, percent. See A-01. */
  overfillPct: number;

  // ---- what went wrong ----------------------------------------------------
  /** Scales every §2 mount tolerance at once. 0 is a perfect install. */
  mountError: number;
  /** Which draw. Changing it reshuffles the error without changing its size. */
  errorSeed: number;

  // ---- seams and the polar hole ------------------------------------------
  /** Blend ramp width, degrees of longitude. §4.5, ASSUME. */
  blendDeg: number;
  /** Ramp exponent. §4.5 `rampGamma` 0.8 is DOC; the shape around it is ASSUME. */
  rampGamma: number;
  /** `set bottommask 60,70` — where the mask starts and where it is total. §4.4. */
  maskLoDeg: number;
  maskHiDeg: number;

  // ---- the view -----------------------------------------------------------
  /** Orbit azimuth, degrees. */
  viewAzDeg: number;
  /** Orbit elevation, degrees. */
  viewElDeg: number;
  /** Eye distance from the sphere centre, metres. */
  viewRangeM: number;
  /** §6 `fov_eye`. Inert to every metric, and the tests assert it. */
  viewFovDeg: number;
  /** Grid spacing on the alignment pattern, degrees. */
  gridDeg: number;
  /**
   * Which test pattern is playing. Index into {@link CONTENTS}.
   *
   * Not a cosmetic choice. PARAMETERS.md §8 item 13 prescribes a flat mid-grey
   * frame for judging seams, because a graticule on black leaves most of the
   * sphere dark and a seam has nothing to show up against; the grid is what an
   * operator judges REGISTRATION on. The two questions want different frames and
   * the page offers both.
   */
  content: number;

  // ---- per projector ------------------------------------------------------
  /**
   * Hand adjustments to each lens, on top of the seeded mount error. Always four
   * entries, so switching projector count does not lose what was set.
   */
  nudge: ProjectorNudge[];
}

/**
 * The test patterns on offer, and what each is for.
 *
 * `background` is linear light. A graticule on pure black is the honest
 * alignment pattern and it is also a mostly-dark sphere; putting the same lines
 * over a lit field is what makes the seams, the blend ramps and the polar mask
 * visible at the same time, which is most of what there is to look at.
 */
export const CONTENTS: readonly {
  label: string;
  background: number;
  lines: number;
  help: string;
}[] = [
  {
    label: 'Grid on black',
    background: 0,
    lines: 1,
    help:
      'The bare alignment graticule. This is what the grid-displacement gate measures and what an ' +
      'operator judges registration on — but it leaves most of the sphere dark.',
  },
  {
    label: 'Grid on grey',
    background: 0.18,
    lines: 1,
    help:
      'The same lines over a lit field. The seams, the blend ramps and the polar mask all become ' +
      'visible at once, which is most of what there is to look at.',
  },
  {
    label: 'Flat grey',
    background: 0.18,
    lines: 0.18,
    help:
      'PARAMETERS.md §8 item 13 prescribes exactly this frame for judging seams: with no pattern ' +
      'to distract, a luminance step at a join is the only thing left to see.',
  },
  {
    label: 'Flat white',
    background: 0.9,
    lines: 0.9,
    help:
      '§8 items 6–9. Drives the projectors to full and shows the off-sphere spill on the room ' +
      'behind — the thing the field card goes to photograph.',
  },
];

/** Per-projector rasters. §3.4: the X screen is twice this in each dimension. */
export const RESOLUTIONS: readonly { label: string; resX: number; resY: number }[] = [
  { label: '1024 × 768', resX: 1024, resY: 768 },
  { label: '1920 × 1080', resX: 1920, resY: 1080 },
  { label: '1920 × 1200', resX: 1920, resY: 1200 },
  { label: '3840 × 2160 (LK935)', resX: 3840, resY: 2160 },
];

/**
 * NOAA Boulder, from its own `sos_stream_control.config`. See A-36 and the
 * module note: this is where the page opens, and it is not what PARAMETERS.md
 * says.
 *
 *     Sphere_Height_At_Equator_Inches  84.0
 *     P1..P4_Height_Inches             92.0
 *     P1..P4_DIST_INCHES              211.0
 */
export const BOULDER_PRESET: Settings = {
  sphereDiaIn: 68,
  equatorIn: 84,
  projectorCount: 4,
  resolution: 3,
  distanceM: 211 * IN_TO_M,
  lensRiseM: 8 * IN_TO_M,
  overfillPct: NOMINAL_SILHOUETTE_MARGIN_FRAC * 100,
  mountError: 1,
  errorSeed: 771003,
  blendDeg: 20,
  rampGamma: 0.8,
  maskLoDeg: 60,
  maskHiDeg: 70,
  viewAzDeg: 35,
  viewElDeg: 12,
  viewRangeM: 6.2,
  viewFovDeg: 50,
  gridDeg: 15,
  content: 1,
  nudge: [noNudge(), noNudge(), noNudge(), noNudge()],
};

/**
 * PARAMETERS.md §1 and §2 as written: an 86-inch equator, projectors at the same
 * height, and the alignment manual's 5.18 m. One click away, so the conflict
 * A-36 records can be seen rather than argued about.
 */
export const SPEC_PRESET: Settings = {
  ...BOULDER_PRESET,
  equatorIn: 86,
  distanceM: 5.18,
  lensRiseM: 0,
  nudge: BOULDER_PRESET.nudge.map((n) => ({ ...n })),
};

/** A perfectly-mounted rig. Useful for seeing what the metrics read at zero. */
export const PERFECT_PRESET: Settings = {
  ...BOULDER_PRESET,
  mountError: 0,
  nudge: [noNudge(), noNudge(), noNudge(), noNudge()],
};

export const PRESETS: readonly { id: string; label: string; blurb: string; settings: Settings }[] = [
  {
    id: 'boulder',
    label: 'NOAA Boulder',
    blurb: "the site's own sos_stream_control.config (A-36)",
    settings: BOULDER_PRESET,
  },
  {
    id: 'spec',
    label: 'PARAMETERS.md',
    blurb: '§1 and §2 as documented — an 86-inch equator, level lenses, 5.18 m',
    settings: SPEC_PRESET,
  },
  {
    id: 'perfect',
    label: 'Perfectly mounted',
    blurb: 'Boulder with zero mount error — what the metrics read when nothing is wrong',
    settings: PERFECT_PRESET,
  },
];

/**
 * Per-projector adjustment, on top of whatever the seeded mount error already
 * did. The panel's "Projectors" tab edits one of these at a time.
 *
 * These move the LENSES and nothing else. The software is not told — that is the
 * whole point, and it is why bumping a projector does not change the frame that
 * projector is sending. Only a recalibration rewrites that.
 */
export interface ProjectorNudge {
  /** Degrees, added to the aim after the projector is re-aimed at the centre. */
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Metres, added to the lens's distance from the sphere centre. */
  distanceM: number;
  /** Metres, added to the lens height. */
  heightM: number;
  /** Switched off at the wall. Its quadrant goes dark; the framebuffer does not. */
  on: boolean;
}

export function noNudge(): ProjectorNudge {
  return { yawDeg: 0, pitchDeg: 0, rollDeg: 0, distanceM: 0, heightM: 0, on: true };
}

/** One control on the per-projector tab. Same shape as {@link ControlSpec}. */
export interface NudgeSpec {
  key: keyof Omit<ProjectorNudge, 'on'>;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  decimals: number;
  help: string;
}

export const NUDGE_CONTROLS: readonly NudgeSpec[] = [
  {
    key: 'yawDeg',
    label: 'Aim left / right',
    min: -3,
    max: 3,
    step: 0.01,
    unit: '°',
    decimals: 2,
    help:
      'Swings this projector like turning your head. A degree is plenty to ruin a seam — at 5.36 m ' +
      'it moves the image about 94 mm across the sphere.',
  },
  {
    key: 'pitchDeg',
    label: 'Aim up / down',
    min: -3,
    max: 3,
    step: 0.01,
    unit: '°',
    decimals: 2,
    help: 'Tips it up or down, on top of the down-tilt its mount height already gives it.',
  },
  {
    key: 'rollDeg',
    label: 'Roll',
    min: -3,
    max: 3,
    step: 0.01,
    unit: '°',
    decimals: 2,
    help:
      'Twists the picture, like tilting a frame on a wall. PARAMETERS.md §2: "A degree of roll is ' +
      'invisible on a test grid until it interacts with the blend region" — so watch the seams, ' +
      'not the middle.',
  },
  {
    key: 'distanceM',
    label: 'Move in / out',
    min: -0.4,
    max: 0.4,
    step: 0.002,
    unit: ' m',
    decimals: 3,
    help:
      'Slides this one along its own radius. It re-aims at the sphere centre automatically, so this ' +
      'changes how much of the ball it covers rather than where it points.',
  },
  {
    key: 'heightM',
    label: 'Raise / lower',
    min: -0.4,
    max: 0.4,
    step: 0.002,
    unit: ' m',
    decimals: 3,
    help: 'Up or down on its mount, again with an automatic re-aim.',
  },
];

/** Tints for P1…P4, in rig order. Used for tabs, dots and every per-projector plot. */
export const PROJECTOR_TINTS: readonly string[] = ['#5cc8c8', '#c486f7', '#f59f4a', '#6dc96d'];

export type SettingKey = keyof Omit<Settings, 'nudge'>;

export const CONTROLS: readonly ControlSpec[] = [
  {
    key: 'sphereDiaIn',
    label: 'Sphere diameter',
    symbol: 'R',
    section: '§1',
    klass: 'DOC',
    min: 40,
    max: 130,
    step: 1,
    unit: '″',
    decimals: 0,
    group: 'install',
    help:
      'The ball itself. 68 inches is the Science On a Sphere standard, and it is the one number in ' +
      'this panel that is documented, measured and not in dispute.',
  },
  {
    key: 'equatorIn',
    label: 'Equator height',
    symbol: 'h_center',
    section: '§1',
    klass: 'DOC',
    min: 60,
    max: 108,
    step: 1,
    unit: '″',
    decimals: 0,
    group: 'install',
    help:
      'How high the middle of the ball sits off the floor. Boulder runs 84 inches; PARAMETERS.md §1 ' +
      'says 86. Both are written down, they disagree, and amendment A-36 records that rather than ' +
      'quietly picking one. The documented remedy for getting this wrong is "add or subtract an inch ' +
      'in the config and re-run alignment", which is also why the solver is scored on recovering it.',
  },
  {
    key: 'projectorCount',
    label: 'Projectors',
    symbol: 'N',
    section: '§2',
    klass: 'CFG',
    min: 2,
    max: 4,
    step: 1,
    unit: '',
    decimals: 0,
    group: 'install',
    help:
      'Four is standard. Two and three are supported installs and the spec says "quadrants go dark" — ' +
      'so the remaining projectors stay where they were rather than respacing, and the framebuffer is ' +
      'still the full 2×2 X screen with unused quadrants black. Two projectors take opposite slots, ' +
      'because adjacent ones would leave most of the sphere unlit (A-06).',
  },
  {
    key: 'resolution',
    label: 'Resolution',
    symbol: 'res_x, res_y',
    section: '§3.1',
    klass: 'CFG',
    min: 0,
    max: 3,
    step: 1,
    unit: '',
    decimals: 0,
    options: RESOLUTIONS.map((r) => r.label),
    group: 'install',
    help:
      'The chip behind each lens — per projector, not the shared framebuffer, which is twice this in ' +
      'each direction. It sets how far apart two projector pixels land on the sphere, which the ' +
      'readout prints against the 1 mm gate.',
  },

  {
    key: 'distanceM',
    label: 'Distance to the sphere',
    symbol: 'd_proj',
    section: '§2',
    klass: 'SOLVE',
    min: 3.2,
    max: 7.2,
    step: 0.01,
    unit: ' m',
    decimals: 3,
    group: 'lens',
    help:
      'From the sphere centre out to the lens. This is the most conflicted constant in the project: ' +
      'the alignment manual implies 5.18 m, the floor plan implies 5.50–6.14 m, and Boulder’s own ' +
      'config says 211 inches — 5.359 m — which falls between them. §2 does not even say whether it ' +
      'means the horizontal radius or the true 3-D distance to the lens, and at Boulder’s raised ' +
      'mount those two readings differ by 3.85 mm against a 2 mm gate (A-36).',
  },
  {
    key: 'lensRiseM',
    label: 'Lens rise above the equator',
    symbol: 'h_proj − h_center',
    section: '§2',
    klass: 'SOLVE',
    min: -0.6,
    max: 1.4,
    step: 0.005,
    unit: ' m',
    decimals: 3,
    group: 'lens',
    help:
      'PARAMETERS.md §2 says projectors are "generally" at the same height as the equator, which makes ' +
      'the aim exactly level. Boulder’s are 8 inches up, so they tilt down about 2.2° — small, but ' +
      'enough to wake a sign convention that was harmless while everything was level (A-07, A-36). ' +
      'Each projector re-aims at the sphere centre automatically as you move it.',
  },
  {
    key: 'overfillPct',
    label: 'Overfill past the silhouette',
    symbol: 'marginFrac',
    section: '§4.1',
    klass: 'ASSUME',
    min: 0,
    max: 12,
    step: 0.1,
    unit: '%',
    decimals: 1,
    group: 'lens',
    help:
      'How much wider than the ball each projector throws. Zero puts the edge of the image exactly on ' +
      'the limb, where the coverage test and the raster test disagree in the last decimal place and the ' +
      'edge frays; too much wastes light on the wall behind. Nothing in the spec pins it, so 2% is a ' +
      'project decision (A-01) — and one that used to differ between the simulator and the solver by ' +
      '0.63° of field, which is exactly the kind of quiet disagreement this page exists to surface.',
  },

  {
    key: 'mountError',
    label: 'Mount error',
    symbol: '',
    section: '§2',
    klass: 'PANEL',
    min: 0,
    max: 3,
    step: 0.05,
    unit: '×',
    decimals: 2,
    group: 'error',
    help:
      'Scales every mount tolerance §2 states — azimuth, distance, height, aim, roll, zoom, lens shift ' +
      'and distortion — at once. 1× is a typical install: about three quarters of a degree of azimuth, ' +
      'half a degree of roll, three centimetres of placement. The projectors move; the software is not ' +
      'told. Set it to 0 and every alignment metric should read essentially zero, which is a check on ' +
      'the metrics as much as on the rig.',
  },
  {
    key: 'errorSeed',
    label: 'Which install',
    symbol: 'seed',
    section: '',
    klass: 'PANEL',
    min: 1,
    max: 999999,
    step: 1,
    unit: '',
    decimals: 0,
    group: 'error',
    help:
      'The same seed always produces the same rig, exactly, forever — that determinism is what makes ' +
      'a before-and-after comparison mean anything. Change it to draw a different unlucky installer.',
  },

  {
    key: 'blendDeg',
    label: 'Seam blend width',
    symbol: 'widthDeg',
    section: '§4.5',
    klass: 'ASSUME',
    min: 0,
    max: 30,
    step: 0.5,
    unit: '°',
    decimals: 1,
    group: 'blend',
    help:
      'How wide a band each overlapping pair crossfades across. Wider hides a seam better but spreads ' +
      'any misalignment over more of the sphere. Nobody has measured what a real SOS install uses, so ' +
      'this is an assumption, and experiment 2 measured what changing it costs.',
  },
  {
    key: 'rampGamma',
    label: 'Blend ramp exponent',
    symbol: 'rampGamma',
    section: '§4.5',
    klass: 'ASSUME',
    min: 0.4,
    max: 2.4,
    step: 0.05,
    unit: '',
    decimals: 2,
    group: 'blend',
    help:
      'The curve the two sides of a seam fade along. 0.8 comes straight from the SOS config; whether ' +
      'the shape around it is a cosine or something else does not. When it does not match the ' +
      'projector’s transfer curve the two halves stop adding to one and the seam shows as a bright ' +
      'or dark band even though the geometry is perfect.',
  },
  {
    key: 'maskLoDeg',
    label: 'Bottom mask starts',
    symbol: 'maskLoDeg',
    section: '§4.4',
    klass: 'ASSUME',
    min: 30,
    max: 89,
    step: 1,
    unit: '°',
    decimals: 0,
    group: 'blend',
    help:
      'From `set bottommask 60,70`. The pole is unreachable — every projector sits on the equator, so ' +
      'light rakes across the bottom of the ball at a vanishing angle — and the mask fades content out ' +
      'before it gets there. The spec never says whether 60 means latitude or angle from the pole, ' +
      'which changes where the mask lands; the page prints which reading it used.',
  },
  {
    key: 'maskHiDeg',
    label: 'Bottom mask total',
    symbol: 'maskHiDeg',
    section: '§4.4',
    klass: 'ASSUME',
    min: 31,
    max: 90,
    step: 1,
    unit: '°',
    decimals: 0,
    group: 'blend',
    help: 'Where the mask reaches full black. Below this the sphere is intentionally dark.',
  },

  {
    key: 'content',
    label: 'Test pattern',
    symbol: '',
    section: '§8',
    klass: 'PANEL',
    min: 0,
    max: 3,
    step: 1,
    unit: '',
    decimals: 0,
    options: CONTENTS.map((c) => c.label),
    group: 'view',
    help:
      'What is playing on the sphere. The grid is what registration is judged on; the flat fields ' +
      'are what §8 prescribes for judging seams and for photographing the spill.',
  },
  {
    key: 'viewAzDeg',
    label: 'Walk around',
    symbol: '',
    section: '§6',
    klass: 'PANEL',
    min: -180,
    max: 180,
    step: 1,
    unit: '°',
    decimals: 0,
    group: 'view',
    help: 'Drag the picture instead, if you prefer.',
  },
  {
    key: 'viewElDeg',
    label: 'Eye height',
    symbol: '',
    section: '§6',
    klass: 'PANEL',
    min: -35,
    max: 70,
    step: 1,
    unit: '°',
    decimals: 0,
    group: 'view',
    help: 'Looking up from the floor, or down from the mezzanine.',
  },
  {
    key: 'viewRangeM',
    label: 'Standing distance',
    symbol: '',
    section: '§6',
    klass: 'PANEL',
    min: 1.4,
    max: 14,
    step: 0.1,
    unit: ' m',
    decimals: 1,
    group: 'view',
    help: 'How far back you are from the middle of the ball.',
  },
  {
    key: 'viewFovDeg',
    label: 'Your field of view',
    symbol: 'fov_eye',
    section: '§6',
    klass: 'CFG',
    min: 20,
    max: 90,
    step: 1,
    unit: '°',
    decimals: 0,
    group: 'view',
    help:
      'PARAMETERS.md §6 is explicit that no metric may depend on this. It changes the picture and ' +
      'nothing else, and the test suite computes every metric at 35°, 50° and 70° and asserts the ' +
      'numbers are identical.',
  },
  {
    key: 'gridDeg',
    label: 'Grid spacing',
    symbol: '',
    section: '',
    klass: 'PANEL',
    min: 5,
    max: 30,
    step: 1,
    unit: '°',
    decimals: 0,
    group: 'view',
    help:
      'Degrees between lines on the alignment pattern. Closer lines make a small misalignment easier ' +
      'to see — this is the pattern an operator judges by eye, and the grid-displacement gate is a ' +
      'measurement of exactly it.',
  },
];

export const CONTROL_BY_KEY: ReadonlyMap<SettingKey, ControlSpec> = new Map(
  CONTROLS.map((c) => [c.key, c]),
);

/** Clamp and quantise one setting to its control's declared range. */
export function coerce(key: SettingKey, value: number): number {
  const spec = CONTROL_BY_KEY.get(key);
  if (!spec) return value;
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  if (spec.step >= 1 && spec.decimals === 0) return Math.round(clamped);
  return clamped;
}

export function withSetting(s: Settings, key: SettingKey, value: number): Settings {
  const next: Settings = { ...s, [key]: coerce(key, value) };
  // The mask is a pair, and a lo above a hi is not a configuration, it is a bug
  // that would silently invert the ramp. Push the other end rather than refuse
  // the drag.
  if (key === 'maskLoDeg' && next.maskLoDeg >= next.maskHiDeg) {
    next.maskHiDeg = Math.min(90, next.maskLoDeg + 1);
  }
  if (key === 'maskHiDeg' && next.maskHiDeg <= next.maskLoDeg) {
    next.maskLoDeg = Math.max(30, next.maskHiDeg - 1);
  }
  return next;
}

/**
 * `signed` prints a leading `+`, and only a control whose zero is meaningful
 * should ask for it. "+5.359 m" for a distance reads as an offset from something
 * and there is nothing to be offset from; "+0.25°" for a nudge is exactly right,
 * because the reader needs to see which way it was moved without parsing a minus
 * sign that may or may not be there.
 */
export function formatSetting(
  spec: { options?: readonly string[]; decimals: number; unit: string; signed?: boolean },
  value: number,
): string {
  if (spec.options) return spec.options[Math.round(value)] ?? String(value);
  const sign = spec.signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(spec.decimals)}${spec.unit}`;
}

/** Replace one projector's nudge, leaving the rest alone. */
export function withNudge(s: Settings, index: number, patch: Partial<ProjectorNudge>): Settings {
  const nudge = s.nudge.map((n, i) => (i === index ? { ...n, ...patch } : { ...n }));
  return { ...s, nudge };
}

/** Clear every hand adjustment. */
export function clearNudges(s: Settings): Settings {
  return { ...s, nudge: s.nudge.map(() => noNudge()) };
}
