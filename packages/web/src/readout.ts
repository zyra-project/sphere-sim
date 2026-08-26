// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The numbers, in sentences.
 *
 * ## Every value here is computed by `packages/sim` and none is computed here
 *
 * That is the point of the module. The page draws the sphere with a shader that
 * is fast and approximate; the shader is never allowed to produce a number. If
 * the readouts came from the render, a bug in the shader would move the picture
 * and the number together and the page would be internally consistent and
 * externally wrong — which is the failure mode the whole A/B split of this
 * project exists to prevent, applied one level down.
 *
 * So this file is a translation layer and a formatter. It reads a `MetricSet`,
 * derives nothing, and adds only the things a plain-language reader needs that
 * the metric objects do not carry: what the number means, what would make it
 * better, and whether anybody has actually measured the constants underneath it.
 *
 * ## The four states a reading can be in
 *
 * `PASS` and `FAIL` mean what they say against a PARAMETERS.md §7 gate.
 * `REFERENCE` is a reading §7 sets no gate for — it is printed because it
 * explains the others, and it never decides anything. `PROVISIONAL` is a
 * reading that rests on a constant nobody has measured; the project's phase gate
 * says those get built and not optimized, and the page prints them greyed with
 * the reason attached rather than omitting them, because a reader who cannot see
 * what is missing cannot judge what is present.
 */

import type { MetricResult, MetricSet } from '../../sim/src/metrics/index.ts';
import { fovVDeg, throwRatioOf } from '../../sim/src/optics.ts';
import type { RigCalibration } from '../../calibration/src/index.ts';
import { DEG2RAD } from '../../sim/src/vec.ts';

export type ReadingStatus = 'PASS' | 'FAIL' | 'REFERENCE' | 'PROVISIONAL';

export interface Reading {
  id: string;
  /** What the page calls it. */
  label: string;
  /** Formatted value, with unit. */
  value: string;
  /** The same value with the sampling basis dropped, for running text. */
  valueShort: string;
  /** Formatted gate, or `''`. */
  gate: string;
  /**
   * The same gate with the sampling basis dropped, for the line under a 44px
   * number where it has to fit.
   *
   * `sim`'s units say what a number was measured over — "mm on sphere surface",
   * "fraction of the protected region" — which is right in a table and wrong as
   * a caption: the headline read "mm / gate 1.000 mm on sphere surface" and
   * wrapped onto three lines beside the figure it was captioning.
   */
  gateShort: string;
  /**
   * The metric could not evaluate part of its own domain, so `value` is a LOWER
   * BOUND and is printed with a `>=`.
   *
   * Without this the panel showed "0.008 mm" beside a FAIL badge and a 1.000 mm
   * gate, which reads as a contradiction rather than as what it is: the worst of
   * the seams that could still be read, on a rig where the seams that moved
   * furthest could no longer be read at all.
   */
  censored: boolean;
  status: ReadingStatus;
  /** One sentence: what this number means. */
  means: string;
  /** One sentence: what moves it. Empty when there is nothing useful to say. */
  lever: string;
  /** PARAMETERS.md section, printed small. */
  section: string;
}

/**
 * A metric's value, printed.
 *
 * Anything `sim` reports as a fraction is shown as a percentage, and the long
 * unit string ("fraction of the protected region") becomes a tooltip rather than
 * a line of body text. "0.0013 fraction of emitted raster area" is precise and
 * unreadable; "0.13% of the raster" is the same number in a form somebody can
 * compare against the one beside it.
 */
function fmt(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '—';
  if (unit.startsWith('fraction')) {
    const pct = value * 100;
    return `${pct.toFixed(pct === 0 || pct >= 10 ? 1 : pct >= 1 ? 2 : 3)}%`;
  }
  const abs = Math.abs(value);
  const digits = abs === 0 ? 1 : abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}

function statusOf(m: MetricResult): ReadingStatus {
  if (m.provisional) return 'PROVISIONAL';
  if (!m.scored || m.pass === null) return 'REFERENCE';
  return m.pass ? 'PASS' : 'FAIL';
}

/**
 * Plain-language copy for each §7 metric.
 *
 * Keyed by the metric's own id so a metric appearing or disappearing in `sim`
 * shows up here as a missing entry rather than as a silently unlabelled row.
 */
const COPY: Record<string, { label: string; means: string; lever: string }> = {
  grid_displacement: {
    label: 'Worst grid-line error',
    means:
      'How far a line on the alignment grid lands from where it should, at the worst point on the ' +
      'sphere. This is the number an operator sees as a doubled or kinked line, and it is the gate ' +
      'the whole project is aimed at.',
    lever:
      'Recalibrate. Failing that, it tracks how wrong the software is about where the lenses are — ' +
      'so it scales with Mount error and drops to near zero when that is 0.',
  },
  registration_error: {
    label: 'Seam registration error',
    means:
      'Where two projectors both light the same patch, how far apart the two copies of the same ' +
      'texel land. PARAMETERS.md §7 sets no numeric gate on this, so it is reported for reference ' +
      'and never decides anything.',
    lever: 'Same cause as the grid error; this one is measured only inside the overlap.',
  },
  unlit_in_mask: {
    label: 'Unlit above the mask',
    means:
      'The fraction of sphere that should be lit and is not. §7 calls this a hard requirement: ' +
      'anything above the bottom mask must receive light from at least one projector, so the gate ' +
      'is exactly zero and only an exact zero passes.',
    lever:
      'Widen Overfill, move the projectors back, or lower where the bottom mask starts. Dropping to ' +
      'two or three projectors opens gaps this will find.',
  },
  off_sphere_flux_excess: {
    label: 'Light thrown past the ball',
    means:
      'How much more light misses the sphere than has to. A rectangular image cannot cover a round ' +
      'ball without spilling — that floor is about 56% on a 16:9 chip and is not a fault — so this ' +
      'measures only the EXCESS above that floor, which is aim error and overfill.',
    lever: 'Reduce Overfill; fix the aim. This is the number the field card goes to measure in person.',
  },
  off_sphere_flux: {
    label: 'Total light past the ball',
    means:
      'The raw fraction, including the unavoidable floor. §7 gates this at 52%, which a 16:9 ' +
      'projector cannot reach no matter how well aimed — amendment A-03 — so it is printed for ' +
      'reference and excluded from the verdict.',
    lever: 'A squarer chip. Nothing about the alignment moves it much.',
  },
  unlit_in_mask_alt_units: {
    label: 'Unlit above the mask, read the other way',
    means:
      'The same gate, with `set bottommask 60,70` read as an angle from the pole instead of a ' +
      'latitude. The spec never says which it means, and the two readings put the mask edge in ' +
      'different places — so both are printed rather than one being chosen quietly. Amendment A-02.',
    lever: 'Nothing on this page. It is settled by reading the config at the actual site.',
  },
};

/**
 * The unit with its sampling basis removed: "mm on sphere surface" → "mm".
 *
 * Only the leading token survives, and only when the unit starts with one — a
 * fraction unit has no short form and keeps its percentage formatting.
 */
function shortUnit(unit: string): string {
  if (unit.startsWith('fraction')) return unit;
  return unit.split(' ')[0] ?? unit;
}

export function readingsFrom(set: MetricSet): Reading[] {
  const out: Reading[] = [];
  for (const m of set.metrics) {
    const copy = COPY[m.id];
    const bound = m.censored ? '\u2265 ' : '';
    const standing = copy ? copy.means : m.note;
    out.push({
      id: m.id,
      label: copy ? copy.label : m.label,
      value: bound + fmt(m.value, m.unit),
      valueShort: bound + fmt(m.value, shortUnit(m.unit)),
      gate: m.gateMax === null ? '' : fmt(m.gateMax, m.unit),
      gateShort: m.gateMax === null ? '' : fmt(m.gateMax, shortUnit(m.unit)),
      censored: m.censored,
      status: statusOf(m),
      // The metric's own first sentence goes ahead of the standing copy when it
      // is censored: it names how many samples went and why, which is the part a
      // reader needs to make sense of a small number under a FAIL badge.
      means: m.censored ? `${m.note.split('. ')[0]}. ${standing}` : standing,
      lever: copy ? copy.lever : '',
      section: m.id.startsWith('off_sphere') ? '§7 / §4.1' : '§7',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry facts the panel prints beside the metrics
// ---------------------------------------------------------------------------

export interface RigFact {
  label: string;
  value: string;
  /** Empty, or a short judgement: 'inside the LK935 band', 'over the 1 mm gate'. */
  verdict: string;
  ok: boolean | null;
  note: string;
}

/**
 * The BenQ LK935's published zoom range, as a throw ratio. Amendment A-35.
 *
 * PARAMETERS.md §3.1 does not say whether a nominal field of view comes off the
 * lens or out of `d_proj`, and A-18 measured that the answer is worth 88–97% of
 * the pose error. Until that is settled, the honest thing a page can do is print
 * the field of view its geometry implies and say whether a real LK935 could
 * produce it.
 */
export const LK935_THROW_MIN = 1.36;
export const LK935_THROW_MAX = 2.18;

/**
 * Distance between two adjacent projector pixels where they land on the sphere,
 * at the sub-projector point.
 *
 * The ON-AXIS pitch times the throw distance to the near surface. It is a
 * geometric identity, not a model: no coverage, no blend, no transfer. It is
 * here rather than in `sim` because it is a presentation convenience — `sim`'s
 * grid metric already measures the thing that matters — and because it is the
 * one number a visitor asks for by name.
 *
 * `2 * tan(fov / 2) / resX`, not `fov / resX`. Every lens in this project is
 * rectilinear — linear in TANGENT, not in angle: `optics.ts` sets
 * `fx = resX / 2 / halfMinor` so that `fovHDeg = 2 * atan(resX / 2 / fx)` — so
 * the pixels are not equal in angle across the raster and `fov / resX` is their
 * AVERAGE. The one this fact is about is the widest of them: the on-axis pixel,
 * which is the one that lands at the sub-projector point.
 *
 * The average understates it by `2 * tan(t/2) / t`, which is 2.8% at Boulder's
 * geometry and 24% at the far corner of the sphere-diameter and distance
 * sliders. That is enough to change the answer: at a 130-inch ball 4.32 m out
 * the fact read "0.90 mm on the sphere / under the 1 mm gate" for a pixel that
 * lands 1.04 mm away.
 */
export function pixelFootprintMm(rig: RigCalibration): number {
  let worst = 0;
  for (const p of rig.projectors) {
    const lensDist = Math.hypot(p.pose.position.x, p.pose.position.y, p.pose.position.z);
    const pitch = (2 * Math.tan((p.intrinsics.fovHDeg * DEG2RAD) / 2)) / p.intrinsics.resX;
    worst = Math.max(worst, pitch * Math.max(0.01, lensDist - rig.sphere.radiusM) * 1000);
  }
  return worst;
}

/**
 * The two readings of `d_proj` §2 declines to choose between, and the gap
 * between them — 3.85 mm at Boulder's raised mount, against a 2 mm pose gate
 * (amendment A-36).
 *
 * Zero at a level rig, which is exactly why it went unnoticed until a real
 * site's config arrived.
 */
export function dProjAmbiguityMm(rig: RigCalibration): number {
  let worst = 0;
  for (const p of rig.projectors) {
    const horizontal = Math.hypot(p.pose.position.x, p.pose.position.y);
    const three = Math.hypot(horizontal, p.pose.position.z);
    worst = Math.max(worst, (three - horizontal) * 1000);
  }
  return worst;
}

/**
 * What the panel's own settings imply, before anybody picked up a wrench.
 *
 * `rig` is the AS-BUILT rig — the drawing — not the shaken one. That choice
 * matters and it is not cosmetic. A visitor sets the distance to 5.36 m and
 * wants to know what field of view that implies; showing the field of view of a
 * projector that happens to have drawn a large zoom perturbation answers a
 * different question, and it would make the "is this a real LK935" verdict
 * flicker with the mount-error seed.
 *
 * The `d_proj` fact is the sharpest case. At Boulder's specified geometry the
 * horizontal and 3-D readings differ by exactly the 3.85 mm amendment A-36
 * computes. At the spec's level rig they are identical — which is precisely why
 * the ambiguity went unnoticed — but a shaken level rig still shows about
 * 0.18 mm of it, from mount jitter alone. Reading the drawing keeps the fact
 * about the constant instead of about the seed.
 *
 * `set` is the opposite: it is computed on the rig the room actually has,
 * because coverage and overlap are facts about where the light goes.
 */
export function rigFacts(rig: RigCalibration, set: MetricSet | null): RigFact[] {
  const p0 = rig.projectors[0];
  const facts: RigFact[] = [];
  if (!p0) return facts;

  const throwRatio = throwRatioOf(p0.intrinsics);
  const inBand = throwRatio >= LK935_THROW_MIN && throwRatio <= LK935_THROW_MAX;
  facts.push({
    label: 'Field of view',
    value: `${p0.intrinsics.fovHDeg.toFixed(2)}° × ${fovVDeg(p0.intrinsics).toFixed(2)}°`,
    verdict: '',
    ok: null,
    note:
      'Not a slider. It falls out of the distance to the sphere and the overfill, because the image ' +
      'has to just cover the ball. Whether that is the right way round — lens first, or distance ' +
      'first — is the open question amendment A-18 is waiting on, and it is worth most of the ' +
      'recovery error.',
  });
  facts.push({
    label: 'Throw ratio',
    value: `${throwRatio.toFixed(2)}:1`,
    verdict: inBand ? 'a real LK935 can do this' : 'outside the LK935’s zoom range',
    ok: inBand,
    note:
      `The BenQ LK935 spans ${LK935_THROW_MIN.toFixed(2)}–${LK935_THROW_MAX.toFixed(2)}:1 on its ` +
      '1.6× zoom (A-35). Outside that band the geometry on screen is fine but no projector in the ' +
      'room could produce it, so you are specifying a different lens.',
  });

  const px = pixelFootprintMm(rig);
  facts.push({
    label: 'One projector pixel',
    value: `${px.toFixed(2)} mm on the sphere`,
    verdict: px <= 1 ? 'under the 1 mm gate' : 'over the 1 mm gate',
    ok: px <= 1,
    note:
      'How far apart two adjacent pixels land. It is a floor on how well anything can be aligned — ' +
      'you cannot register better than you can address — but on a real sphere it reads as softness ' +
      'rather than visible squares, because the warp resamples between pixels and nothing is in ' +
      'perfect focus across a curved surface.',
  });

  const amb = dProjAmbiguityMm(rig);
  if (amb > 0.05) {
    facts.push({
      label: 'The d_proj ambiguity',
      value: `${amb.toFixed(2)} mm`,
      verdict: amb > 2 ? 'larger than the 2 mm pose gate' : 'under the pose gate',
      ok: amb <= 2,
      note:
        'PARAMETERS.md §2 does not say whether the distance to a projector is measured horizontally ' +
        'or straight to the lens. At a level rig the two are the same and it never mattered. Raise ' +
        'the lenses and they separate — at Boulder’s 8-inch rise, by nearly twice the gate the pose ' +
        'is scored against. This is amendment A-36, open.',
    });
  }

  if (set) {
    const maxMult = set.coverage.maxMultiplicity;
    facts.push({
      label: 'Most projectors on one spot',
      value: String(maxMult),
      verdict: maxMult <= 2 ? 'never three, as predicted' : `${maxMult} — the lenses are too high`,
      ok: maxMult <= 2,
      // This arm was unreachable until `metricsFor` stopped inheriting sim's
      // `assertMultiplicity`, and while it was unreachable it said the wrong
      // thing: it promised a code bug. It is not one. §4.2's argument assumes
      // lenses at or near the equator, and the page has a slider that lifts them
      // well past that, at which point three- and four-way overlap is real
      // geometry that the documented rig simply never reaches.
      note:
        'Overlap multiplicity never exceeds 2 on the documented rig. Three-way overlap would need a ' +
        'point within about 80° of three equatorial directions spaced 90° apart; the only candidate ' +
        'region is polar, and on a level ring the poles sit exactly 90° from every projector. That ' +
        'argument is about a LEVEL ring: raise the lenses more than a sphere radius above the ' +
        'equator — past about 0.9 m on this page — and the north pole comes into view of all four ' +
        'at once, which is what a reading above 2 here means. Every area-weighted number in the set ' +
        'is still computed, but §4.2 no longer covers the rig producing them.',
    });
  }

  return facts;
}

/** PARAMETERS.md §1 works in inches; the models work in metres. */
const IN_PER_M = 1 / 0.0254;

/**
 * One projector's own configuration, as an installer would read it off a
 * drawing: where the lens is, what it is pointed at, what raster it is driven at.
 *
 * These come off the rig the argument names, and the page calls it twice — once
 * for what the software believes and once for where the lens actually is. Two
 * columns of the same six numbers is the whole misregistration story in a form
 * that needs no diagram, so this function must not be given a special case for
 * either rig.
 */
export function projectorFacts(rig: RigCalibration, index: number): RigFact[] {
  const p = rig.projectors[index];
  if (!p) return [];
  const pos = p.pose.position;
  const it = p.intrinsics;
  const dist = Math.hypot(pos.x, pos.y);
  // Wrapped into [0, 360) rather than atan2's (-180, 180]. Believed 180.00 next
  // to actual -178.95 is a one-degree error that reads as a three-hundred-and-
  // fifty-nine-degree one, and the whole point of the column pair is that a
  // reader can subtract them by eye.
  const az = ((Math.atan2(pos.y, pos.x) * 180) / Math.PI + 360) % 360;
  // The config file measures height from the FLOOR; the models measure it from
  // the sphere centre. Getting that wrong is an eight-inch error that looks
  // entirely plausible on a drawing.
  const heightFromFloor = pos.z + rig.sphere.centerHeightM;

  return [
    {
      label: 'Distance from the axis',
      value: `${(dist * IN_PER_M).toFixed(1)} in / ${dist.toFixed(3)} m`,
      verdict: '',
      ok: null,
      note:
        '`P*_DIST_INCHES` in sos_stream_control.config, measured from the sphere’s vertical ' +
        'axis to the lens. PARAMETERS.md §1 says 5.18 m; Boulder’s own config says 211 in. ' +
        'That conflict is amendment A-36 and the page opens at Boulder’s number.',
    },
    {
      label: 'Lens height',
      value: `${(heightFromFloor * IN_PER_M).toFixed(1)} in above the floor`,
      verdict: '',
      ok: null,
      note:
        '`P*_Height_Inches`, from the floor. §2 puts the lenses level with the equator; ' +
        'Boulder mounts them 8 in above it. Everything in this panel is measured from the sphere ' +
        'centre instead, and the two differ by the equator height — an eight-inch error that ' +
        'reads as plausible on a drawing.',
    },
    {
      label: 'Around the ball',
      value: `${az.toFixed(2)}°`,
      verdict: '',
      ok: null,
      note:
        'Where it stands on the ring. Four projectors sit 90° apart; a mount tolerance moves ' +
        'this by a fraction of a degree, which is enough to double a grid line at the seam.',
    },
    {
      label: 'Raster',
      value: `${it.resX} × ${it.resY}`,
      verdict: '',
      ok: null,
      note:
        'One quadrant of the single X screen SOS drives (§3.4). Not a separate output — ' +
        'switching a projector off blacks its quadrant and leaves the framebuffer the same size.',
    },
    {
      label: 'Field of view',
      value: `${it.fovHDeg.toFixed(2)}° × ${fovVDeg(it).toFixed(2)}°`,
      verdict: '',
      ok: null,
      note:
        'Derived from the distance and the overfill rather than set: the image has to just cover ' +
        'the ball. A-18 measured that which way round this is derived — lens first or distance ' +
        'first — is worth most of the recovery error.',
    },
    {
      label: 'Lens distortion',
      value: `k1 ${it.k1.toFixed(5)}, k2 ${it.k2.toFixed(5)}`,
      verdict: it.k1 === 0 && it.k2 === 0 ? 'a pinhole' : '',
      ok: null,
      note:
        'PARAMETERS.md §3.1 holds k1 and k2 at zero nominal and classes them SOLVE — precisely ' +
        'because real lenses are not zero. So the drawing is a pinhole and the room is not, and ' +
        'the gap between these two columns is about a pixel at the raster corner: the scale SOS’s ' +
        'manual "Vertex Tweaking" exists to remove by hand.',
    },
  ];
}

/** How many pixels the whole framebuffer is, said out loud. */
export function framebufferSentence(rig: RigCalibration): string {
  const fb = rig.framebuffer;
  const p = rig.projectors[0];
  const lit = rig.projectors.length;
  const dark = 4 - lit;
  const base =
    `One ${fb.width} × ${fb.height} framebuffer split into four quadrants of ` +
    `${p ? p.intrinsics.resX : '?'} × ${p ? p.intrinsics.resY : '?'}`;
  return dark === 0
    ? `${base}. Not four separate outputs — one image, which is what SOS actually drives.`
    : `${base}, ${dark} of them black. Fewer projectors do not shrink the framebuffer; the quadrants ` +
        'go dark, and the X screen stays the same size.';
}
