/**
 * Panel settings to calibrations. The only place the page's vocabulary meets
 * PARAMETERS.md's.
 *
 * ## Three rigs, and the difference between them is the whole page
 *
 *   - {@link WebWorld.asBuiltRig} — the rig this room was *specified* as. Nobody
 *     ever has this one; it is the drawing.
 *   - {@link WebWorld.truthRig} — the rig the room actually has, the drawing
 *     shaken by the §2 mount tolerances. This is what the lenses do. It is
 *     ground truth and the solver never sees it.
 *   - {@link WebWorld.compositorRig} — what the SOFTWARE believes. It starts as
 *     the drawing, because that is what an operator types into a config file,
 *     and after a solve it becomes whatever `packages/solver` recovered.
 *
 * Every alignment number on the page is a disagreement between the last two. A
 * simulator run against itself cannot misregister — it paints the physically
 * correct texel at the physically correct point by construction — so a page with
 * one rig could show a pretty sphere and never show the problem.
 *
 * ## What this module is allowed to do
 *
 * Call `packages/sim`. Nothing here re-derives geometry: the rigs come from
 * `nominalRig`, the shaking comes from `injectMisalignment`, the pattern comes
 * from `gridAlignmentPattern`. If a projection or a distortion model ever
 * appears in this file, the page has started scoring its own assumptions.
 */

import type { BlendCalibration, RigCalibration } from '../../calibration/src/index.ts';
import { flatField } from '../../sim/src/equirect.ts';
import type { EquirectImage } from '../../sim/src/equirect.ts';
import { defaultScene } from '../../sim/src/render.ts';
import type { Graticule, Scene, ViewerCamera } from '../../sim/src/render.ts';
import type { MisalignmentMagnitudes, Perturbation } from '../../sim/src/scene.ts';
import { DEFAULT_MISALIGNMENT, injectMisalignment, nominalRig } from '../../sim/src/scene.ts';
import { DEG2RAD } from '../../sim/src/vec.ts';
import { aimAtSphereCenter } from '../../sim/src/geometry.ts';
import type { ProjectorNudge, Settings } from './settings.ts';
import {
  CONTENTS,
  CONTENT_CUSTOM,
  CONTENT_MARBLE,
  IN_TO_M,
  NOMINAL_BLACK_PCT,
  NOMINAL_LUMENS,
  noNudge,
  SHIFT_PCT_PER_UNIT,
  RESOLUTIONS,
} from './settings.ts';

/**
 * The exponent a supplied file's pixels are decoded with, on the way from
 * whatever the file stores to the linear light the model works in.
 *
 * PARAMETERS.md §3.2's nominal display gamma, used as an approximation of sRGB —
 * the two differ by a percent or so in the toe, and this is the one that appears
 * everywhere else in the pipeline. It matters that there is a NAME for it,
 * because it is now applied in two places by two different processors: on the
 * CPU by `readEquirect` for a dropped image, and on the GPU by
 * `CONTENT_DECODE_FRAGMENT` for every frame of a dropped video. Two spellings of
 * one number is how the sphere ends up a different brightness depending on which
 * kind of file you handed it.
 */
export const CONTENT_DECODE_GAMMA = 2.2;

/** Equirectangular content raster. Big enough that the grid is not the limit. */
const CONTENT_WIDTH = 2048;
const CONTENT_HEIGHT = 1024;

export interface WebWorld {
  /** The drawing: the rig as specified, before anyone picked up a wrench. */
  asBuiltRig: RigCalibration;
  /** The rig the lenses have. Ground truth. */
  truthRig: RigCalibration;
  /** What the compositor believes. The drawing, or a recovered calibration. */
  compositorRig: RigCalibration;
  /**
   * Is {@link WebWorld.compositorRig} a RECOVERED rig rather than the drawing?
   *
   * Not the same question as "was one supplied": a recovered rig is a belief
   * about a specific set of projectors, and one that no longer matches the room
   * is refused. Anything reporting what a calibration bought has to ask this
   * rather than ask whether it passed one in.
   */
  calibrated: boolean;
  /** Exactly what was done to the rig, so the page can name the worst offender. */
  perturbation: Perturbation;
  scene: Scene;
  image: EquirectImage;
  /**
   * `slots[rigIndex]` is the panel slot that projector came from.
   *
   * Identity until somebody switches one off. See {@link NudgedRig} — everything
   * the page shows per projector is indexed by SLOT, so that P3 stays P3, keeps
   * its colour and keeps its frame when P2 goes dark.
   */
  slots: number[];
}

/**
 * Blend and mask, straight off the panel. Every field here is class ASSUME.
 *
 * `region: 'sector'` is docs/AMENDMENTS.md **A-37** and it is the one place this
 * page departs from the rig the bench scores. The default everywhere else is
 * `'limb'`, which ramps inward from each projector's own footprint edge and
 * leaves the middle of a 71°-wide overlap at 50/50 — under which a projector's
 * own frame is a full disc and the neighbour still carries 38% of the signal 20°
 * from your own centre meridian. `'sector'` gives each projector a longitude
 * wedge and crossfades at the seam, which is what an SOS compositor does and what
 * §4.5's "derived from seam geometry" describes.
 *
 * The page opts in and says which reading it is showing; `bench-results.json` and
 * the harness's zero-delta parity chain stay on `'limb'` until the bench and
 * Experiment 2 have been re-run against the change. A-37 lists what that takes.
 */
export function blendFrom(s: Settings): Partial<BlendCalibration> {
  return {
    rampShape: 'cosine',
    widthDeg: s.blendDeg,
    rampGamma: s.rampGamma,
    maskLoDeg: s.maskLoDeg,
    maskHiDeg: s.maskHiDeg,
    bottomOnly: true,
    region: 'sector',
  };
}

/**
 * The rig the drawing describes.
 *
 * `lensRiseM` is measured from the EQUATOR, because that is how a site survey
 * reads it and how `sos_stream_control.config` records it (two heights in
 * inches, and the difference is what matters). `nominalRig` wants an absolute
 * height above the floor, so the addition happens here, once.
 */
export function buildAsBuilt(s: Settings): RigCalibration {
  const res = RESOLUTIONS[Math.round(s.resolution)] ?? RESOLUTIONS[1];
  const centerHeightM = s.equatorIn * IN_TO_M;
  return nominalRig({
    radiusM: (s.sphereDiaIn * IN_TO_M) / 2,
    centerHeightM,
    distanceM: s.distanceM,
    projectorHeightM: centerHeightM + s.lensRiseM,
    projectorCount: Math.round(s.projectorCount),
    resX: res.resX,
    resY: res.resY,
    marginFrac: s.overfillPct / 100,
    blend: blendFrom(s),
  });
}

/**
 * Every §2 tolerance, scaled by one knob.
 *
 * `DEFAULT_MISALIGNMENT` is the simulator's own statement of how hard to shake
 * each degree of freedom and why; multiplying it is the only thing this page
 * does to it. Spelling the fields out rather than mapping over the object is
 * deliberate — a new degree of freedom appearing in `sim` should fail the
 * typecheck here and be given a considered scale, not silently inherit one.
 */
export function scaledMagnitudes(scale: number): MisalignmentMagnitudes {
  const k = Math.max(0, scale);
  const d = DEFAULT_MISALIGNMENT;
  return {
    azimuthDeg: d.azimuthDeg * k,
    distanceM: d.distanceM * k,
    heightM: d.heightM * k,
    yawDeg: d.yawDeg * k,
    pitchDeg: d.pitchDeg * k,
    rollDeg: d.rollDeg * k,
    fovHDeg: d.fovHDeg * k,
    shiftH: d.shiftH * k,
    shiftV: d.shiftV * k,
    k1: d.k1 * k,
    k2: d.k2 * k,
    centerHeightM: d.centerHeightM * k,
  };
}

/**
 * Move the lenses by hand, and drop the ones switched off at the wall.
 *
 * Applied AFTER `injectMisalignment`, so a nudge reads as "and then somebody
 * knocked it", which is what the control means. The lens is moved along its own
 * radius and in height, then RE-AIMED at the sphere centre, and only then are the
 * aim offsets added — the same separation `injectMisalignment` makes, and for the
 * same reason: a pure placement error should leave a rig that is still pointing at
 * the sphere, which is what a real installer would leave behind.
 *
 * Dropping rather than dimming is the model PARAMETERS.md §2 describes — the
 * quadrant goes dark, the framebuffer does not shrink, and a point nothing
 * reaches is genuinely unlit, which is what §7's zero-tolerance gate is about. A
 * projector left in the rig emitting black would still count as covering, and the
 * unlit metric would report a lit sphere with a dark quarter on it.
 *
 * The cost is that the rig's array stops being indexed by panel slot, which is
 * why {@link NudgedRig.slots} exists. Without it, switching P2 off silently
 * renamed P3 to P2 everywhere downstream — its tint, its frame, its warp mesh and
 * its config column all shifted by one, and every one of them looked plausible.
 */
export interface NudgedRig {
  rig: RigCalibration;
  /** `slots[rigIndex]` is the panel slot that projector came from. */
  slots: number[];
}

function applyNudges(rig: RigCalibration, nudges: readonly ProjectorNudge[]): NudgedRig {
  const slots: number[] = [];
  const projectors = rig.projectors
    .map((p, i) => {
      const n = nudges[i];
      if (!n) return p;
      const pos = p.pose.position;
      const horizontal = Math.hypot(pos.x, pos.y);
      const scaleXY = horizontal > 1e-9 ? (horizontal + n.distanceM) / horizontal : 1;
      const position = {
        x: pos.x * scaleXY,
        y: pos.y * scaleXY,
        z: pos.z + n.heightM,
      };
      // Re-aim from the NEW position, then re-apply whatever aim error the
      // mount already had, then the hand adjustment. With both movements at zero
      // the two aims are identical and this reduces to `pose.yawDeg + n.yawDeg`
      // exactly — no drift from merely passing through.
      const wasAimed = aimAtSphereCenter(pos);
      const aim = aimAtSphereCenter(position);
      // Lumens scale the channel gain against the LK935's rated output, and the
      // black level is a percentage of full. Both are Phase 2 — the SHAPE is
      // modelled and the constants underneath are class ASSUME, so the controls
      // carry PROVISIONAL and nothing is optimised against them.
      const lamp = Math.max(0, n.lumens) / NOMINAL_LUMENS;
      const black = Math.max(0, n.blackPct) / 100;
      const t = p.transfer;
      return {
        ...p,
        pose: {
          position,
          yawDeg: aim.yawDeg + (p.pose.yawDeg - wasAimed.yawDeg) + n.yawDeg,
          pitchDeg: aim.pitchDeg + (p.pose.pitchDeg - wasAimed.pitchDeg) + n.pitchDeg,
          rollDeg: p.pose.rollDeg + n.rollDeg,
        },
        intrinsics: {
          ...p.intrinsics,
          fovHDeg: Math.max(0.5, p.intrinsics.fovHDeg + n.fovDeltaDeg),
          // The panel's shift is a percentage of the full image; the
          // calibration's is a fraction of the half-extent (§3.1).
          shiftH: p.intrinsics.shiftH + n.shiftH / SHIFT_PCT_PER_UNIT,
          shiftV: p.intrinsics.shiftV + n.shiftV / SHIFT_PCT_PER_UNIT,
        },
        transfer: {
          ...t,
          gain: { r: t.gain.r * lamp, g: t.gain.g * lamp, b: t.gain.b * lamp },
          blackFloor: { r: black, g: black, b: black },
        },
      };
    })
    .filter((_, i) => {
      if (nudges[i]?.on === false) return false;
      slots.push(i);
      return true;
    });
  return { rig: { ...rig, projectors }, slots };
}

/** True when nothing has been moved by hand. */
export function nudgesAreClear(nudges: readonly ProjectorNudge[]): boolean {
  return nudges.every(
    (n) =>
      n.on &&
      n.yawDeg === 0 &&
      n.pitchDeg === 0 &&
      n.rollDeg === 0 &&
      n.distanceM === 0 &&
      n.heightM === 0 &&
      n.fovDeltaDeg === 0 &&
      n.shiftH === 0 &&
      n.shiftV === 0 &&
      n.lumens === NOMINAL_LUMENS &&
      n.blackPct === NOMINAL_BLACK_PCT,
  );
}

/**
 * Build the world the page is showing.
 *
 * `compositorRig` defaults to the drawing — an operator's config file, before
 * anyone has run a calibration. Pass a recovered rig to see what the solve
 * bought.
 *
 * Switching a projector off removes it from the TRUTH rig and from the
 * compositor's, because the software knows which outputs it is driving even when
 * it is wrong about where they point. The alignment error is still measured
 * across whatever is left.
 */
/**
 * The equirectangular content the sphere is showing.
 *
 * Three cases, one function, because the alternative is three places that decide
 * what the sphere is displaying and only one of them being the one the metrics
 * ran against.
 *
 *   - a flat field with the graticule over it,
 *   - a flat field with no graticule,
 *   - a supplied image, optionally with the graticule over it.
 *
 * The graticule is composited by MULTIPLYING the base where a line is not, and
 * writing the line colour where it is — rather than adding — so a grid over a
 * white field stays inside the display's range instead of clipping into a flat
 * white smear. `graticuleCoverage` is the same continuous function the
 * grid-displacement metric evaluates, so the lines a reader sees and the lines
 * the gate measures are the same lines.
 */
/**
 * The last field built, and what it was built from.
 *
 * `buildContent` fills a 1024x512 float image — about 1.5 million writes, and
 * around 40 ms — and `buildWorld` calls it every time. `buildWorld` in turn runs
 * once per animation frame in `draw()` and once per `renderReadout()`, so
 * dragging any slider at all cost two full regenerations of the texture per
 * pointer event: measured at 86 ms of blocked main thread per move, which is
 * five frames' worth for a control that had not touched the content at all.
 *
 * What the field actually depends on is four things, and geometry is none of
 * them. One entry is enough — nothing alternates between two fields — and the
 * result is already shared rather than copied on the `!grid` path below, so
 * handing back the same object is not a new kind of aliasing.
 */
let lastContent: { key: string; custom: EquirectImage | null; image: EquirectImage } | null = null;

export function buildContent(s: Settings, custom: EquirectImage | null): EquirectImage {
  // `content` and the supplied image, and nothing else. The graticule is no
  // longer rasterised into the field — it moved to `buildGraticule` and is
  // evaluated per sample, which `rigs.test.ts`'s 'the field is only ever the
  // field' already asserts — so keying on `gridOn` and `gridDeg` bought a full
  // rebuild of a byte-identical 2048x1024 field for a term the builder does not
  // read. Dragging Grid spacing paid it on every step: 8-12 ms of blocked main
  // thread and a fresh 25 MB Float32Array against a 16.7 ms frame budget, which
  // is the exact stall this cache was added to remove.
  const key = `${Math.round(s.content)}`;
  if (lastContent && lastContent.key === key && lastContent.custom === custom) {
    return lastContent.image;
  }
  const image = buildContentUncached(s, custom);
  lastContent = { key, custom, image };
  return image;
}

function buildContentUncached(s: Settings, custom: EquirectImage | null): EquirectImage {
  const choice = Math.round(s.content);
  const base = CONTENTS[choice] ?? CONTENTS[1];

  // Two fields are a supplied image rather than a flat colour: the shipped Blue
  // Marble and whatever the reader dropped. Both arrive here the same way — the
  // page decides which slot is live and hands it over — so there is one code path
  // and one sRGB conversion, not one per source.
  const wantsImage = choice === CONTENT_CUSTOM || choice === CONTENT_MARBLE;
  // A supplied image that has not arrived yet falls back to the grey field
  // rather than to black: an empty sphere reads as a broken page.
  const supplied = wantsImage ? custom : null;
  if (supplied !== null) return supplied;
  const v = wantsImage ? 0.18 : base.background;
  return flatField(CONTENT_WIDTH, CONTENT_HEIGHT, { r: v, g: v, b: v });
}

/**
 * The graticule the renderers draw over the field, or `null` for none.
 *
 * A quarter of a degree of line on a 68-inch ball is about two millimetres, and
 * it is the pattern the §7 gate measures — so it is evaluated per sample rather
 * than rasterised into the content. See `Scene.graticule` for the arithmetic
 * that made the old way visible.
 */
export function buildGraticule(s: Settings): Graticule | null {
  if (Math.round(s.gridOn) !== 1) return null;
  return {
    spacingDeg: Math.round(s.gridDeg),
    lineWidthDeg: 0.35,
    emphasizeAxes: true,
    color: { r: 1, g: 1, b: 1 },
  };
}

export function buildWorld(
  s: Settings,
  compositorRig?: RigCalibration,
  custom: EquirectImage | null = null,
): WebWorld {
  const asBuiltRig = buildAsBuilt(s);
  const misaligned = injectMisalignment(
    asBuiltRig,
    Math.round(s.errorSeed),
    scaledMagnitudes(s.mountError),
  );
  const image = buildContent(s, custom);
  const scene = defaultScene(image, {
    graticule: buildGraticule(s),
    maskInterpretation: 'latitude',
    ambient: { r: s.ambient, g: s.ambient, b: s.ambient },
  });

  // The `on` flags are the only part of a nudge the software knows about, so
  // they apply to both rigs; the movements apply to the lenses alone.
  //
  // Built UP from neutral, not stripped DOWN from the operator's nudge. The
  // stripping version listed the five pose terms by hand and `ProjectorNudge`
  // has ten, so `fovDeltaDeg`, `shiftH`, `shiftV`, `lumens` and `blackPct` were
  // copied into the compositor rig as well as the truth rig — and a change the
  // compositor already knows about cancels out of every alignment metric. Drag
  // P1's lens shift to 10% and the sphere visibly moves while registration error
  // stays at 139.211 mm, identical to three decimals to the untouched rig,
  // against a true misregistration of 301.1 mm; the vertical shift is worse,
  // because the readout goes DOWN as the real error goes up.
  //
  // Starting from `noNudge()` means the next degree of freedom added to
  // ProjectorNudge is neutral here on the day it lands, rather than leaking
  // until somebody notices a number that will not move.
  const off = s.nudge.map((n) => ({ ...noNudge(), on: n.on }));
  const drawn = applyNudges(asBuiltRig, off);
  const drawing = drawn.rig;
  const truth = applyNudges(misaligned.rig, s.nudge);
  // A recovered rig comes back from `packages/solver`, which knows nothing about
  // blending — the boundary type carries the fields but the solver never reads or
  // writes them, so its `blend` is whatever nominal it was handed. The blend is a
  // panel setting rather than something a calibration recovers, so it is taken
  // from the panel in both cases. Without this the projector frames silently
  // changed shape after a solve, because the recovered rig's blend had no A-37
  // region and fell back to the default.
  // A recovered rig is a belief about a SPECIFIC set of projectors. If the room
  // no longer holds that set — the count moved, or one was switched off at the
  // wall — the two lists stop lining up, and `metrics/registration.ts` indexes
  // one by the other's length. That throws inside `pixelToRay` rather than
  // degrading, the worker posts `ok: false`, and the page keeps the last good
  // model on screen under a red banner: every number still describing a rig that
  // is no longer in the room.
  //
  // The page clears the calibration on both of those controls, so this should be
  // unreachable. It is here because "should be unreachable" and "is checked" are
  // different things, and the failure mode is a readout that looks live.
  const usable = compositorRig && compositorRig.projectors.length === truth.rig.projectors.length;
  const compositor = usable
    ? { ...compositorRig, blend: { ...compositorRig.blend, ...blendFrom(s) } }
    : drawing;
  return {
    asBuiltRig: drawing,
    truthRig: truth.rig,
    slots: truth.slots,
    compositorRig: compositor,
    /**
     * Is the compositor a RECOVERED rig, or the config as written?
     *
     * Callers used to answer this by testing the `compositorRig` argument they
     * passed in, which is the question one step too early: a rig that does not
     * match the room is refused above, and "what the calibration bought" then
     * had a baseline to compare against and no calibration in force.
     */
    calibrated: Boolean(usable),
    perturbation: misaligned.perturbation,
    scene,
    image,
  };
}

/**
 * The eye. Orbits the sphere centre, which sits at world origin — the world
 * frame's origin is the sphere centre and +Z is up (conventions.ts §W), so the
 * floor is at `-h_center`.
 *
 * `imageShift` moves the BALL down the frame, in halves of the frame height: 0
 * puts it in the middle of the window, 1 puts it a full half-frame lower. It
 * exists for the phone, where the panels are sheets pinned to the top and bottom
 * edges and the room a reader can actually see is the band between them — which
 * is not centred on the window, so neither should the sphere be. See
 * `viewShiftFrac` in `web/main.ts`, which measures the band and is the only
 * caller that passes anything but zero.
 *
 * It is a LENS SHIFT — {@link ViewerCamera.imageShift} — and not an aim above
 * the ball, which is the other way to get the same composition and is wrong. An
 * aimed camera puts the sphere off its own optical axis, where a rectilinear
 * projection stretches it; at the two thirds of a half-frame a phone layout
 * wants, in a portrait frustum, that is a 27 degree tilt and the ball renders as
 * a visible egg. Shifting the principal point moves the window and leaves the
 * axis on the ball. It is measured, both renderers carry the term, and the
 * parity check runs them at the same value.
 */
export function buildViewer(
  s: Settings,
  width: number,
  height: number,
  imageShift = 0,
): ViewerCamera {
  const az = s.viewAzDeg * DEG2RAD;
  const el = s.viewElDeg * DEG2RAD;
  const r = s.viewRangeM;
  // `sim`'s `viewerAt` places a viewer by azimuth and eye HEIGHT, which is the
  // right parameterisation for a person standing in a room and the wrong one for
  // an orbit control that has to pass over the pole. The struct is the boundary
  // between the two and is built here rather than fought with there.
  return {
    position: {
      x: r * Math.cos(el) * Math.cos(az),
      y: r * Math.cos(el) * Math.sin(az),
      z: r * Math.sin(el),
    },
    target: { x: 0, y: 0, z: 0 },
    upHint: { x: 0, y: 0, z: 1 },
    fovHDeg: s.viewFovDeg,
    width,
    height,
    imageShift,
  };
}

/**
 * How far back to stand to frame a patch of sphere `halfSpanDeg` wide.
 *
 * Used by the seam picker: clicking a seam walks the camera round to it and
 * comes in until the patch the diagram covers fills `fill` of the frame's width.
 *
 * Solved rather than picked, so one rule holds at any sphere diameter and any
 * field of view — including a phone's, which is chosen from the aspect and is
 * much narrower than a desktop's, so the same call backs the eye off on its own.
 *
 * The geometry: from an eye at `r` on the equatorial plane looking at the sphere
 * centre, a surface point `φ` of longitude away from the point facing the eye is
 * at `(R cos φ, R sin φ)` while the eye is at `(r, 0)`, so it subtends
 *
 *     θ = atan2(R sin φ, r − R cos φ)
 *
 * from the view axis. Setting `θ` to `fill` of the half-field and solving for `r`
 * gives the line below. `test/rigs.test.ts` checks the inversion by putting the
 * answer back through the forward formula.
 *
 * The caller is expected to clamp: at a wide enough field this asks for an eye
 * inside the ball, and `withSetting` floors `viewRangeM` against the radius.
 */
export function framingRangeM(
  radiusM: number,
  halfSpanDeg: number,
  fovHDeg: number,
  fill: number,
): number {
  const phi = Math.max(0.5, halfSpanDeg) * DEG2RAD;
  // A degenerate field would divide by approximately zero and put the eye in the
  // next county; the floor is a fifth of a degree of half-field.
  const theta = Math.max(0.005, ((fovHDeg * DEG2RAD) / 2) * fill);
  return radiusM * Math.cos(phi) + (radiusM * Math.sin(phi)) / Math.tan(theta);
}

/**
 * Which perturbed degree of freedom moved the lens furthest, so the page can say
 * *what* went wrong rather than only *how much*.
 *
 * The comparison is between contributions to the lens position, which is why
 * the angular terms are converted through the throw distance: a tenth of a
 * degree of azimuth at 5.36 m is 9.4 mm, and a tenth of a degree of yaw moves
 * the lens not at all. Aim errors are therefore reported separately rather than
 * ranked against placement errors in the same list, because they are not the
 * same kind of quantity and adding them would produce a number with no units.
 */
export interface Offender {
  projectorId: string;
  /** Plain-language name of the degree of freedom. */
  what: string;
  /** How much it moved, in its own units, as a printable string. */
  amount: string;
  /** Millimetres of lens displacement this term is responsible for. */
  displacementMm: number;
}

export function worstPlacementOffender(p: Perturbation, distanceM: number): Offender | null {
  let worst: Offender | null = null;
  for (const proj of p.projectors) {
    const terms: { what: string; amount: string; mm: number }[] = [
      {
        what: 'swung sideways on its mount',
        amount: `${proj.azimuthDeg >= 0 ? '+' : ''}${proj.azimuthDeg.toFixed(2)}° of azimuth`,
        mm: Math.abs(proj.azimuthDeg * DEG2RAD * distanceM) * 1000,
      },
      {
        what: 'sits at the wrong distance',
        amount: `${proj.distanceM >= 0 ? '+' : ''}${(proj.distanceM * 1000).toFixed(0)} mm`,
        mm: Math.abs(proj.distanceM) * 1000,
      },
      {
        what: 'hangs at the wrong height',
        amount: `${proj.heightM >= 0 ? '+' : ''}${(proj.heightM * 1000).toFixed(0)} mm`,
        mm: Math.abs(proj.heightM) * 1000,
      },
    ];
    for (const t of terms) {
      if (worst === null || t.mm > worst.displacementMm) {
        worst = { projectorId: proj.id, what: t.what, amount: t.amount, displacementMm: t.mm };
      }
    }
  }
  return worst;
}

/** The largest aim error, reported in degrees because that is what it is. */
export function worstAimOffender(p: Perturbation): Offender | null {
  let worst: Offender | null = null;
  for (const proj of p.projectors) {
    const terms: { what: string; deg: number }[] = [
      { what: 'aimed left or right of the centre', deg: proj.yawDeg },
      { what: 'aimed above or below the centre', deg: proj.pitchDeg },
      { what: 'is rolled in its mount', deg: proj.rollDeg },
    ];
    for (const t of terms) {
      if (worst === null || Math.abs(t.deg) > worst.displacementMm) {
        worst = {
          projectorId: proj.id,
          what: t.what,
          amount: `${t.deg >= 0 ? '+' : ''}${t.deg.toFixed(2)}°`,
          displacementMm: Math.abs(t.deg),
        };
      }
    }
  }
  return worst;
}
