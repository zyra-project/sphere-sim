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
import { createImage, graticuleCoverage, gridAlignmentPattern } from '../../sim/src/equirect.ts';
import type { EquirectImage } from '../../sim/src/equirect.ts';
import { defaultScene } from '../../sim/src/render.ts';
import type { Scene, ViewerCamera } from '../../sim/src/render.ts';
import type { MisalignmentMagnitudes, Perturbation } from '../../sim/src/scene.ts';
import { DEFAULT_MISALIGNMENT, injectMisalignment, nominalRig } from '../../sim/src/scene.ts';
import { DEG2RAD } from '../../sim/src/vec.ts';
import { aimAtSphereCenter } from '../../sim/src/geometry.ts';
import type { ProjectorNudge, Settings } from './settings.ts';
import { CONTENTS, CONTENT_CUSTOM, CONTENT_MARBLE, IN_TO_M, RESOLUTIONS } from './settings.ts';

/** Equirectangular content raster. Big enough that the grid is not the limit. */
const CONTENT_WIDTH = 1024;
const CONTENT_HEIGHT = 512;

export interface WebWorld {
  /** The drawing: the rig as specified, before anyone picked up a wrench. */
  asBuiltRig: RigCalibration;
  /** The rig the lenses have. Ground truth. */
  truthRig: RigCalibration;
  /** What the compositor believes. The drawing, or a recovered calibration. */
  compositorRig: RigCalibration;
  /** Exactly what was done to the rig, so the page can name the worst offender. */
  perturbation: Perturbation;
  scene: Scene;
  image: EquirectImage;
}

/** Blend and mask, straight off the panel. Every field here is class ASSUME. */
export function blendFrom(s: Settings): Partial<BlendCalibration> {
  return {
    rampShape: 'cosine',
    widthDeg: s.blendDeg,
    rampGamma: s.rampGamma,
    maskLoDeg: s.maskLoDeg,
    maskHiDeg: s.maskHiDeg,
    bottomOnly: true,
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
 * Apply the panel's hand adjustments to the lenses.
 *
 * Applied AFTER `injectMisalignment`, so a nudge reads as "and then somebody
 * knocked it", which is what the control means. The lens is moved along its own
 * radius and in height, then RE-AIMED at the sphere centre, and only then are
 * the aim offsets added — the same separation `injectMisalignment` makes, and
 * for the same reason: a pure placement error should leave a rig that is still
 * pointing at the sphere, which is what a real installer would leave behind.
 *
 * A projector switched off is dropped from the rig entirely rather than left in
 * with zero output. Its quadrant of the framebuffer goes dark and the
 * framebuffer keeps its size, which is exactly what PARAMETERS.md §2's
 * "quadrants go dark" describes — and it is why `nominalRig` is asked to rebuild
 * the viewport assignment rather than this function editing one.
 */
function applyNudges(rig: RigCalibration, nudges: readonly ProjectorNudge[]): RigCalibration {
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
      return {
        ...p,
        pose: {
          position,
          yawDeg: aim.yawDeg + (p.pose.yawDeg - wasAimed.yawDeg) + n.yawDeg,
          pitchDeg: aim.pitchDeg + (p.pose.pitchDeg - wasAimed.pitchDeg) + n.pitchDeg,
          rollDeg: p.pose.rollDeg + n.rollDeg,
        },
      };
    })
    .filter((_, i) => nudges[i]?.on !== false);
  return { ...rig, projectors };
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
      n.heightM === 0,
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
export function buildContent(s: Settings, custom: EquirectImage | null): EquirectImage {
  const choice = Math.round(s.content);
  const base = CONTENTS[choice] ?? CONTENTS[1];
  const grid = Math.round(s.gridOn) === 1;
  const spacingDeg = Math.round(s.gridDeg);

  // Two fields are a supplied image rather than a flat colour: the shipped Blue
  // Marble and whatever the reader dropped. Both arrive here the same way — the
  // page decides which slot is live and hands it over — so there is one code path
  // and one sRGB conversion, not one per source.
  const wantsImage = choice === CONTENT_CUSTOM || choice === CONTENT_MARBLE;
  // A supplied image that has not arrived yet falls back to the grey field
  // rather than to black: an empty sphere reads as a broken page.
  const supplied = wantsImage ? custom : null;
  if (wantsImage && supplied === null) {
    return gridAlignmentPattern({
      width: CONTENT_WIDTH,
      height: CONTENT_HEIGHT,
      spacingDeg,
      lineWidthDeg: 0.35,
      emphasizeAxes: grid,
      lineColor: grid ? { r: 1, g: 1, b: 1 } : { r: 0.18, g: 0.18, b: 0.18 },
      backgroundColor: { r: 0.18, g: 0.18, b: 0.18 },
    });
  }

  if (supplied === null) {
    const v = base.background;
    return gridAlignmentPattern({
      width: CONTENT_WIDTH,
      height: CONTENT_HEIGHT,
      spacingDeg,
      lineWidthDeg: 0.35,
      emphasizeAxes: grid,
      // With the grid off, the line colour IS the background: the generator then
      // paints a flat field, and there is no second code path to keep in step.
      lineColor: grid ? { r: 1, g: 1, b: 1 } : { r: v, g: v, b: v },
      backgroundColor: { r: v, g: v, b: v },
    });
  }

  if (!grid) return supplied;

  const out = createImage(supplied.width, supplied.height);
  for (let y = 0; y < supplied.height; y++) {
    const latDeg = 90 - ((y + 0.5) / supplied.height) * 180;
    for (let x = 0; x < supplied.width; x++) {
      const lonDeg = ((x + 0.5) / supplied.width) * 360 - 180;
      const cover = graticuleCoverage(latDeg, lonDeg, spacingDeg, 0.35, true);
      const i = 3 * (y * supplied.width + x);
      for (let c = 0; c < 3; c++) {
        out.data[i + c] = supplied.data[i + c] * (1 - cover) + cover;
      }
    }
  }
  return out;
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
    maskInterpretation: 'latitude',
    ambient: { r: s.ambient, g: s.ambient, b: s.ambient },
  });

  // The `on` flags are the only part of a nudge the software knows about, so
  // they apply to both rigs; the movements apply to the lenses alone.
  const off = s.nudge.map((n) => ({ ...n, yawDeg: 0, pitchDeg: 0, rollDeg: 0, distanceM: 0, heightM: 0 }));
  const drawing = applyNudges(asBuiltRig, off);
  return {
    asBuiltRig: drawing,
    truthRig: applyNudges(misaligned.rig, s.nudge),
    compositorRig: compositorRig ?? drawing,
    perturbation: misaligned.perturbation,
    scene,
    image,
  };
}

/**
 * The eye. Orbits the sphere centre, which sits at world origin — the world
 * frame's origin is the sphere centre and +Z is up (conventions.ts §W), so the
 * floor is at `-h_center`.
 */
export function buildViewer(s: Settings, width: number, height: number): ViewerCamera {
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
  };
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
