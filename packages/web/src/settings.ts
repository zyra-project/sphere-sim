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

/** How far back the eye may stand. Far enough to see the room and its ceiling. */
export const MAX_VIEW_RANGE_M = 14;

/**
 * Panel per cent of full image to the calibration's fraction of HALF the image.
 *
 * Half, not full — conventions §3.1 measures lens shift against the half-extent
 * — so 50% of the image is 1.0 in the calibration and the factor is 50.
 */
export const SHIFT_PCT_PER_UNIT = 50;

/**
 * The BenQ LK935's rated output. Amendment A-35 sourced the rest of that sheet.
 *
 * Up here rather than beside `noNudge`, which uses it: the presets build their
 * nudge arrays while this module is still initialising, so a `const` declared
 * after them is in its temporal dead zone when they run.
 */
export const NOMINAL_LUMENS = 5500;

/** §3.2's nominal black floor, 1/800, as a percentage. Class ASSUME. */
export const NOMINAL_BLACK_PCT = 0.125;

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
  /**
   * Multiply by this before printing. The stored value keeps PARAMETERS.md's
   * units; only the row is in the reader's.
   */
  displayScale?: number;
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
      '(amendment A-18). Every lens here is rectilinear — an angle maps to a radius on the chip ' +
      'by a tangent, as a projection lens does; the k1/k2 pair in the readout is the only ' +
      'departure from that, and a fisheye mapping is amendment A-38 and not implemented.',
  },
  {
    id: 'error',
    title: 'What went wrong',
    blurb:
      'Nobody mounts four projectors perfectly. This shakes the rig by the tolerances PARAMETERS.md §2 ' +
      'states — and the software is not told. That gap is the whole problem the solver exists to close. ' +
      'The draw is pseudo-random but never arbitrary: each degree of freedom is a normal draw about ' +
      'its nominal, at the sigma §2 implies — 0.75° of azimuth, 0.3° of yaw and pitch, 0.5° of roll, ' +
      '30 mm of distance, 20 mm of height — scaled by Mount error and fixed by the seed, so the same ' +
      'seed gives byte-identical projectors every time. The two Bump buttons are not random at all: ' +
      'they add a fixed step by hand, on top of whatever the mount already did.',
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
  /**
   * Floor to ceiling, metres.
   *
   * Not a model constant — nothing in PARAMETERS.md depends on it and no metric
   * reads it. It is here because the projectors and the sphere hang from the
   * ceiling and the room reads as a room only when they reach something.
   */
  ceilingM: number;
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
  /**
   * Viewing gain on the picture. PANEL class: it multiplies the render on its
   * way to the screen and nothing else, exactly like the brightness knob on a
   * monitor.
   */
  viewExposure: number;
  /** Display-only shadow lift. See its ControlSpec. */
  viewLift: number;
  /** Grid spacing on the alignment pattern, degrees. */
  gridDeg: number;
  /**
   * Ambient irradiance on the sphere. PARAMETERS.md §5 `E_amb`, nominal 0.04,
   * documented range 0.01–0.15.
   *
   * Sphere galleries are kept dark for a reason and this is the reason: the
   * ambient term adds to every surface point whether a projector lights it or
   * not, so it lifts the blacks, flattens the contrast and washes the polar mask
   * out of visibility. It is the one photometric constant on this page with a
   * documented range rather than an assumed one.
   */
  ambient: number;
  /**
   * The base field. Index into {@link CONTENTS}.
   *
   * Not a cosmetic choice. §8 prescribes a flat mid-grey frame for judging seams
   * and a flat white one for photographing spill; the graticule is what an
   * operator judges REGISTRATION on. Different questions want different frames.
   */
  content: number;
  /** Draw the graticule over whatever the base field is. */
  gridOn: number;

  // ---- per projector ------------------------------------------------------
  /**
   * Hand adjustments to each lens, on top of the seeded mount error. Always four
   * entries, so switching projector count does not lose what was set.
   */
  nudge: ProjectorNudge[];
}

/**
 * The base field the sphere is showing, before any graticule.
 *
 * `background` is linear light. A graticule on pure black is the honest
 * alignment pattern and it is also a mostly-dark sphere; the same lines over a
 * lit field make the seams, the blend ramps and the polar mask visible at the
 * same time, which is most of what there is to look at.
 *
 * The grid is a SEPARATE toggle rather than baked into each entry, because "is
 * the graticule on" and "how bright is the field under it" are two questions and
 * an operator asks them independently: §8 item 13 wants a flat frame with no
 * pattern for judging seams, and the grid gate wants the pattern with nothing
 * else. Folding them together would make four of the six useful combinations
 * unreachable.
 */
export const CONTENTS: readonly {
  label: string;
  background: number;
  help: string;
}[] = [
  {
    label: 'Black',
    background: 0,
    help:
      'Nothing but the graticule, if it is on. This is what the grid-displacement gate measures ' +
      'against and what an operator judges registration on — and it leaves most of the ball dark.',
  },
  {
    label: 'Mid grey',
    background: 0.18,
    help:
      'PARAMETERS.md §8 item 13 prescribes exactly this frame for judging seams: with a lit field ' +
      'and no pattern, a luminance step at a join is the only thing left to see.',
  },
  {
    label: 'White',
    background: 0.9,
    help:
      '§8 items 6–9. Drives the projectors to full and shows the off-sphere spill on the room ' +
      'behind — the thing the field card goes to photograph.',
  },
  {
    label: 'Blue marble',
    background: 0.18,
    help:
      'NASA’s Blue Marble on the sphere, so a misalignment doubles a real coastline instead of an ' +
      'abstract grid line. The grid is what the §7 gate measures and this is what a person ' +
      'recognises; both are one click apart, and no metric reads either.',
  },
  {
    label: 'Your own image',
    background: 0.18,
    help:
      'Drop an equirectangular image on the sphere, or use the button. Any 2:1 map works — a NOAA ' +
      'dataset, Blue Marble, a test chart. Nothing is uploaded: the file is read in the page and ' +
      'never leaves it, which is also why none is shipped with the site.',
  },
];

/** Index into {@link CONTENTS} for the drop-in image. */
/** The shipped Blue Marble. See `assets/README.md` on where the file came from. */
export const CONTENT_MARBLE = 3;

export const CONTENT_CUSTOM = 4;

/** Per-projector rasters. §3.4: the X screen is twice this in each dimension. */
/**
 * How far back an operator stands, for a sphere of this radius.
 *
 * §6's band and the rail are both quoted for the 68-inch ball; the ratio is what
 * carries to another one. The bench does NOT use this — `packages/bench` places
 * its own cameras from its own constants, and every published number came from
 * those — so this is the page's answer to "what would a person do here", not a
 * change to a scored quantity.
 *
 * Here rather than in `pipeline.ts` because the panel needs it too: how much
 * sphere one camera pixel covers is a fact about the distance, and a second copy
 * of the ratio beside the first is a pair that drifts.
 */
export function cameraDistanceM(radiusM: number): number {
  return (2.6 * radiusM) / NOMINAL_RADIUS_M;
}

/** PARAMETERS.md §1's 68-inch sphere, in metres. */
const NOMINAL_RADIUS_M = (68 * IN_TO_M) / 2;

export const RESOLUTIONS: readonly { label: string; resX: number; resY: number }[] = [
  { label: '1024 × 768 · 4:3', resX: 1024, resY: 768 },
  { label: '1920 × 1080 · 16:9', resX: 1920, resY: 1080 },
  { label: '1920 × 1200 · 16:10', resX: 1920, resY: 1200 },
  { label: '3840 × 2160 · 16:9 · LK935', resX: 3840, resY: 2160 },
  // The shape matters more than the pixel count for one §7 gate, so a square
  // chip is offered even though no projector on the market has one: A-03 shows
  // §7's 52% off-sphere-flux gate is unreachable on 16:9 — the floor is about
  // 56% — and reachable on a square. It is the fastest way to see that the gate
  // is about the CHIP and not about the aim.
  { label: '2048 × 2048 · 1:1', resX: 2048, resY: 2048 },
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
  ceilingM: 14 * 12 * IN_TO_M,
  overfillPct: NOMINAL_SILHOUETTE_MARGIN_FRAC * 100,
  mountError: 1,
  errorSeed: 771003,
  blendDeg: 20,
  rampGamma: 0.8,
  maskLoDeg: 60,
  maskHiDeg: 70,
  viewAzDeg: 35,
  viewElDeg: 14,
  viewRangeM: 10.2,
  viewFovDeg: 71,
  // Opens above 1. The model's own radiance off a 0.9-albedo ball at a real
  // incidence angle is a dim picture on a bright screen — correct, and hard to
  // look at beside a demo that draws the map as an emissive texture. This is the
  // only place the two are reconciled, and it is a display term.
  viewExposure: 1.8,
  viewLift: 0.78,
  gridDeg: 15,
  ambient: 0.04,
  content: CONTENT_MARBLE,
  gridOn: 1,
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

/**
 * Where to stand.
 *
 * At any realistic standing distance you cannot see all four projectors at once,
 * because you are standing *inside* the ring — two of them are behind you. That
 * is a fact about the room rather than about the renderer, so seeing the whole
 * installation means stepping outside it, which is what an installer's drawing
 * does too.
 *
 * The page opens at the room view, which for a while it could not: the parity
 * check renders whatever the viewer is looking at, and while its allowance was a
 * fraction of the WHOLE FRAME its sensitivity scaled with how much of the window
 * the sphere filled. Measured, a complete mount error moved 4.65% of the frame
 * standing at the ball and 0.70% from across the room — under the 1% allowance,
 * so the page's own self-check would have passed a rig in pieces at exactly the
 * framing that shows the room best. `src/parity.ts` now measures against the LIT
 * pixels, where the same error moves 41-49% at every framing, and
 * `test/parity.test.ts` pins both halves of that.
 */
export const VIEWPOINTS: readonly {
  id: string;
  label: string;
  help: string;
  view: Pick<Settings, 'viewAzDeg' | 'viewElDeg' | 'viewRangeM' | 'viewFovDeg'>;
}[] = [
  {
    id: 'room',
    label: 'Whole room',
    help:
      'Outside the ring, looking down slightly: the ball, the rail, and the projectors on their ' +
      'hangers. Where the page opens, and the view to click a lens in. On a phone the field of ' +
      'view stays as the screen shape requires, so this moves the eye without stretching the room.',
    view: { viewAzDeg: 35, viewElDeg: 14, viewRangeM: 10.2, viewFovDeg: 71 },
  },
  {
    id: 'close',
    label: 'Standing at it',
    help:
      'Where a visitor stands — inside the ring of projectors, at the rail, with two of them ' +
      'behind you. You cannot see all four from in here, and neither can a visitor.',
    view: { viewAzDeg: 35, viewElDeg: 12, viewRangeM: 6.2, viewFovDeg: 50 },
  },
  {
    id: 'seam',
    label: 'At a seam',
    help: "Close in on the boundary between two projectors, square on, where a misalignment doubles a grid line.",
    view: { viewAzDeg: 45, viewElDeg: 0, viewRangeM: 2.6, viewFovDeg: 34 },
  },
];

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
  /** Degrees, added to the horizontal field of view. The zoom ring. */
  fovDeltaDeg: number;
  /** Lens shift, added to the fraction-of-half-image offsets §3.1 defines. */
  shiftH: number;
  shiftV: number;
  /**
   * Lamp output in lumens. PROVISIONAL — see the control's help.
   *
   * Scales the projector's channel gain against {@link NOMINAL_LUMENS}, which is
   * the LK935's rated figure. PARAMETERS.md gives no absolute lumen number at
   * all; `g_R,G,B` are class ASSUME/MEAS at 1, 1, 1 and §10 counts them among the
   * 31 constants nobody has measured.
   */
  lumens: number;
  /**
   * Black floor, as a percentage of full output. PROVISIONAL.
   *
   * §3.2's nominal is 1/800 = 0.125%, which is a contrast-ratio spec read as a
   * floor. It is class ASSUME.
   */
  blackPct: number;
  /** Switched off at the wall. Its quadrant goes dark; the framebuffer does not. */
  on: boolean;
}

export function noNudge(): ProjectorNudge {
  return {
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    distanceM: 0,
    heightM: 0,
    fovDeltaDeg: 0,
    shiftH: 0,
    shiftV: 0,
    lumens: NOMINAL_LUMENS,
    blackPct: NOMINAL_BLACK_PCT,
    on: true,
  };
}

/** One control on the per-projector tab. Same shape as {@link ControlSpec}. */
export interface NudgeSpec {
  key: keyof Omit<ProjectorNudge, 'on'>;
  /**
   * Phase 2. Everything downstream of it is marked PROVISIONAL, because every
   * constant it rests on is class ASSUME and PARAMETERS.md §10 says of them:
   * "All of it. This is where the bar breaks."
   */
  provisional?: boolean;
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
  {
    key: 'fovDeltaDeg',
    label: 'Image size',
    min: -6,
    max: 6,
    step: 0.02,
    unit: '°',
    decimals: 2,
    help:
      'The zoom ring. How wide a cone of light it throws, on top of the field of view the ' +
      'distance and the overfill already imply. Too narrow leaves a dark rim at the limb; too wide ' +
      'wastes light on the wall behind and dims what lands. The LK935\u2019s 1.6\u00d7 zoom spans ' +
      'about \u00b16\u00b0 at this throw \u2014 A-35.',
  },
  // Per cent of the FULL image, which is how a projector spec sheet states lens
  // shift and how an installer reads it off one. The calibration carries the
  // §3.1 fraction-of-half-image instead, so `applyNudges` divides by
  // `SHIFT_PCT_PER_UNIT` on the way in — the panel speaks the installer's units
  // and the model keeps its own. The ranges are the LK935's own: ±23% across,
  // ±60% up, which is the whole point of a ceiling mount and was previously
  // clipped to a quarter of it.
  {
    key: 'shiftH',
    label: 'Lens shift left / right',
    min: -23,
    max: 23,
    step: 0.5,
    unit: '%',
    decimals: 1,
    help:
      'Slides the image inside the lens without turning the projector, as a percentage of the ' +
      'image width. Different from aim: the cone stays where it points and the picture moves ' +
      'within it, so the silhouette stops being centred in the raster. The LK935 shifts ±23% ' +
      'horizontally.',
  },
  {
    key: 'shiftV',
    label: 'Lens shift up / down',
    min: -60,
    max: 60,
    step: 0.5,
    unit: '%',
    decimals: 1,
    help:
      'The same, vertically, and the LK935 goes to ±60% of image height. This is the control a ' +
      'real install uses to put the ball in the frame from a ceiling mount without tilting the ' +
      'projector down and keystoning the image.',
  },
  {
    key: 'lumens',
    label: 'Lamp output',
    min: 500,
    max: 8000,
    step: 50,
    unit: ' lm',
    decimals: 0,
    provisional: true,
    help:
      'PROVISIONAL. Scales this projector\u2019s channel gain against the LK935\u2019s rated 5500 lm. ' +
      'PARAMETERS.md gives no absolute lumen figure anywhere \u2014 §3.2 holds the three gains at 1 ' +
      'and classes them ASSUME/MEAS, noting that four lamps at different hour counts give four ' +
      'different white points. So the SHAPE of what this does is modelled and the number it is ' +
      'measured against is not. The phase gate says build it and do not optimise against it.',
  },
  {
    key: 'blackPct',
    label: 'Black level',
    min: 0,
    max: 1.2,
    step: 0.005,
    unit: '%',
    decimals: 3,
    provisional: true,
    help:
      'PROVISIONAL. What this projector emits with black in the frame, as a percentage of full ' +
      'output. §3.2\u2019s nominal 0.125% is a contrast-ratio spec read as a floor, class ASSUME. It ' +
      'is what lifts the unlit polar cap off true black and what makes the rectangle of glow around ' +
      'the sphere in every real SOS photograph.',
  },
];

/** Tints for P1…P4, in rig order. Used for tabs, dots and every per-projector plot. */
export const PROJECTOR_TINTS: readonly string[] = ['#5cc8c8', '#c486f7', '#f59f4a', '#6dc96d'];

/**
 * The same four colours as linear-light triples, for the shader.
 *
 * The lens markers and the by-projector overlay are drawn before the display
 * encode, so a tint handed to the shader as its 8-bit value would come back out
 * lighter than the chip beside it and the page would be using two different
 * colours for one projector.
 *
 * The exponent is 2.2 rather than the sRGB piecewise curve on purpose: this has
 * to invert the shader's `pow(c, 1/uDisplayGamma)`, which is a plain power. It is
 * not a claim about sRGB — the dropped-in image conversion, which really is
 * decoding sRGB, uses the piecewise curve.
 */
export const PROJECTOR_TINTS_LINEAR: readonly (readonly [number, number, number])[] =
  PROJECTOR_TINTS.map((hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const ch = (shift: number): number => Math.pow(((n >> shift) & 255) / 255, 2.2);
    return [ch(16), ch(8), ch(0)] as const;
  });

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
    key: 'ceilingM',
    label: 'Ceiling height',
    symbol: '',
    section: '—',
    klass: 'PANEL',
    min: 2.8,
    max: 7,
    step: 0.05,
    unit: ' m',
    decimals: 2,
    group: 'install',
    help:
      'How high the ceiling is. Nothing in the model reads this and no metric moves with it — the ' +
      'sphere hangs from it and the projectors hang from it, and a room with no ceiling reads as a ' +
      'void. PARAMETERS.md §4.4 does lean on the ceiling mount for one thing: it is why the north ' +
      'polar cap needs no software mask and the south does.',
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
    key: 'ambient',
    label: 'Room light',
    symbol: 'E_amb',
    section: '§5',
    klass: 'DOC',
    min: 0,
    max: 0.2,
    step: 0.005,
    // Shown as a percentage of full scale. The stored constant is §5's E_amb and
    // stays exactly as §5 states it; what changed is that the row used to read
    // "0.040" with no unit at all, and the sentence saying what 0.040 was a
    // fraction OF was hidden behind the notes toggle.
    unit: '%',
    displayScale: 100,
    decimals: 1,
    group: 'blend',
    help:
      'Light in the gallery, as irradiance on the sphere relative to full scale. §5 gives 0.04 as ' +
      'nominal and 0.01–0.15 as the range. Turn it up and the picture washes out — the ambient adds ' +
      'to every point whether a projector lights it or not, so it lifts the blacks and hides the ' +
      'polar mask. This is why sphere rooms are kept dark.',
  },
  {
    key: 'content',
    label: 'Base field',
    symbol: '',
    section: '§8',
    klass: 'PANEL',
    min: 0,
    max: CONTENTS.length - 1,
    step: 1,
    unit: '',
    decimals: 0,
    options: CONTENTS.map((c) => c.label),
    group: 'view',
    help:
      'What is playing on the sphere under the graticule. The flat fields are what §8 prescribes ' +
      'for judging seams and for photographing the spill.',
  },
  {
    key: 'gridOn',
    label: 'Grid lines',
    symbol: '',
    section: '§7',
    klass: 'PANEL',
    min: 0,
    max: 1,
    step: 1,
    unit: '',
    decimals: 0,
    options: ['off', 'on'],
    group: 'view',
    help:
      'The alignment graticule, over whatever the base field is. This is the pattern the ' +
      'grid-displacement gate measures and the one a misalignment shows up in — turn it off to ' +
      'judge the imagery alone.',
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
    // Past the poles in both directions, which is not a nicety: §4.3's unlit
    // region is at the SOUTH pole and you cannot see it from a viewer's eye
    // height. The one part of this display that four projectors can never reach
    // was the one part the camera could not be pointed at.
    min: -89,
    max: 89,
    step: 1,
    unit: '°',
    decimals: 0,
    group: 'view',
    help:
      'Looking up from the floor or down from the mezzanine — and all the way under, which is the ' +
      'only way to see the unlit polar cap §4.3 is about. §6 bounds where a VISITOR stands; this ' +
      'is a camera and no metric depends on it.',
  },
  {
    key: 'viewRangeM',
    // The floor here is a hard bound for the CONTROL, below the smallest sphere
    // this page can be asked to draw. What actually stops the drag is the live
    // floor in `withSetting`, which tracks `sphereDiaIn`.
    label: 'Standing distance',
    symbol: '',
    section: '§6',
    klass: 'PANEL',
    min: 0.5,
    max: MAX_VIEW_RANGE_M,
    step: 0.1,
    unit: ' m',
    decimals: 1,
    group: 'view',
    help: 'How far back you are from the middle of the ball.',
  },
  {
    key: 'viewExposure',
    label: 'Screen brightness',
    symbol: '',
    section: '§6',
    klass: 'PANEL',
    min: 0.5,
    max: 4,
    step: 0.1,
    unit: '×',
    decimals: 1,
    group: 'view',
    help:
      'How hard the picture is exposed on the way to your screen, like the brightness knob on a ' +
      'monitor. It multiplies the render and nothing else: no metric can see it, the parity check ' +
      'reads the model’s own radiance underneath it, and turning it up does not make the ' +
      'projectors brighter — Lamp output on the Projectors tab does that. It opens above 1 because ' +
      'the sphere is a painted ball at 0.9 reflectance lit at an angle, so the honest picture is ' +
      'darker than a demo that draws the map as if it glowed.',
  },
  {
    key: 'viewLift',
    label: 'Shadow lift',
    symbol: '',
    section: '§6',
    klass: 'PANEL',
    min: 0.5,
    max: 1,
    step: 0.02,
    unit: '',
    decimals: 2,
    group: 'view',
    help:
      'How much the dark end of the picture is opened up on the way to your screen — a tone ' +
      'curve, applied after everything the model computes and before nothing at all. At 1.00 you ' +
      'are looking at the radiance the model actually produced, which is a painted ball at 0.9 ' +
      'reflectance lit at an angle and is genuinely this dark; deep ocean leaves the projector at ' +
      'about a tenth of full and arrives on your screen at about a tenth. Below 1.00 the shadows ' +
      'come up without the highlights moving much, which is what a display demo does and why one ' +
      'looks vivid beside this. Like Screen brightness it multiplies nothing the model reads: no ' +
      'metric can see it and the parity check asserts it is off.',
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

/**
 * How close the eye may get to the surface of the ball, in metres.
 *
 * Close enough to read one projector pixel — at Boulder's throw a pixel is under
 * a millimetre on the surface — and far enough that the near plane is outside
 * the sphere rather than inside it.
 */
export const VIEW_GAP_M = 0.09;

export function withSetting(s: Settings, key: SettingKey, value: number): Settings {
  const next: Settings = { ...s, [key]: coerce(key, value) };
  // The standing distance is measured from the CENTRE of the ball, so its floor
  // has to move with the ball. `min: 1.4` in the spec is right for the 68-inch
  // default and wrong at both ends of `sphereDiaIn`: at 40 inches it holds the
  // camera 0.9 m off a surface you were trying to inspect, and at 130 inches it
  // puts the eye a quarter of a metre INSIDE the sphere, which renders as the
  // room seen from within a black shell.
  if (key === 'viewRangeM' || key === 'sphereDiaIn') {
    const floor = (next.sphereDiaIn * IN_TO_M) / 2 + VIEW_GAP_M;
    if (next.viewRangeM < floor) next.viewRangeM = Math.min(floor, MAX_VIEW_RANGE_M);
  }
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
  spec: {
    options?: readonly string[];
    decimals: number;
    unit: string;
    signed?: boolean;
    displayScale?: number;
  },
  value: number,
): string {
  if (spec.options) return spec.options[Math.round(value)] ?? String(value);
  const shown = value * (spec.displayScale ?? 1);
  const sign = spec.signed && shown > 0 ? '+' : '';
  return `${sign}${shown.toFixed(spec.decimals)}${spec.unit}`;
}

/** Replace one projector's nudge, leaving the rest alone. */
export function withNudge(s: Settings, index: number, patch: Partial<ProjectorNudge>): Settings {
  const nudge = s.nudge.map((n, i) => (i === index ? { ...n, ...patch } : { ...n }));
  return { ...s, nudge };
}

/**
 * Clear every hand adjustment, and leave the lamps alone.
 *
 * Whether a projector is switched on at the wall is not an adjustment — it is
 * the state of the installation, and it is the one thing on this panel a person
 * has to set deliberately. "Another install" draws a different MOUNT error; a
 * projector somebody had switched off to look at the hole coming silently back
 * on is not part of that, and it is the same surprise in the opposite direction
 * as the one that made switching off a second click on a tab.
 *
 * "Reset" restores everything, including this, and says so.
 */
export function clearNudges(s: Settings): Settings {
  return { ...s, nudge: s.nudge.map((n) => ({ ...noNudge(), on: n.on })) };
}
