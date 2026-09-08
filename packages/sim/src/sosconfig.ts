// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `local_sos_config.json` — reading a site's own settings, and writing the
 * geometry a calibration recovers back into it.
 *
 * The second of SOS's two file formats this repository speaks. `sos.ts` writes
 * the alignment file, which is the RESIDUAL warp; this writes the coarse model
 * that residual is a correction to. Between them they are a complete
 * replacement, and neither is on its own — see "What this cannot carry" below,
 * which is the whole reason both exist.
 *
 * ## The shape, and the trap in it
 *
 * A flat JSON object of named settings, each an object carrying presentation
 * metadata and a live `value`:
 *
 *     "P1_DIST_INCHES": {
 *       "description": "Horizontal distance, in inches, of projector 1 from the
 *                       sphere center.  <br><br> Default Value: <br> 211.0",
 *       "envName": "P1_DIST_INCHES",
 *       "value": 213.5
 *     }
 *
 * **Every entry states its factory default inside its own description**, and the
 * two are usually different. A reader who takes the number out of the prose gets
 * SOS's default; only `value` is the site's. That is not a hypothetical hazard:
 * AMENDMENTS A-39 records three constants that entered this project as "NOAA
 * Boulder's live config" and are, exactly, the three defaults this file
 * documents. {@link sosConfigDefault} exists so the two can be compared rather
 * than confused.
 *
 * ## What this cannot carry, which is most of a calibration
 *
 * The config holds **two numbers per projector**: a horizontal distance and a
 * height. It has no field for azimuth, none for yaw, pitch or roll, none for
 * lens shift, focal length or distortion. A bundle adjustment recovers six pose
 * degrees of freedom per projector plus intrinsics, so **at most two of six
 * survive being written here**, and the ±1-2° azimuth tolerance PARAMETERS.md §2
 * describes has nowhere to go at all.
 *
 * So {@link updateSosConfig} reports what it discarded, in the same spirit as
 * `sos.ts`'s residual: a writer that quietly dropped four degrees of freedom per
 * projector would produce a file that loads, looks right, and throws away the
 * part of the calibration that was hardest to get.
 *
 * ## Two conventions of the file that a writer must not "fix"
 *
 *   - **The distance is HORIZONTAL.** "Horizontal distance, in inches, of
 *     projector *n* from the sphere center" — a radius in the floor plane, not a
 *     slant range to the lens. AMENDMENTS A-17 records that this repository's two
 *     `nominalRig` builders disagree on exactly this, so it is written here as
 *     `hypot(x, y)` and pinned by a test rather than left to be inferred.
 *   - **The height field is deliberately biased.** Its own description says "By
 *     experience: 1 inch lower than real height makes better alignment." That is
 *     an empirical fudge compensating for something inside SOS, and this writer
 *     does NOT reproduce it: it writes the recovered height as measured and
 *     reports the convention, because a deliberately wrong number is not a thing
 *     to generate silently. If that inch is absorbing a model error, the
 *     alignment file `sos.ts` writes is where such an error belongs — a residual
 *     warp is exactly the right place for it, and a falsified height is not.
 *
 * ## Why the output is a patch and not a re-serialization
 *
 * {@link formatSosConfig} edits the original text in place, changing only the
 * numbers that changed. Re-serializing the parsed object would be far simpler
 * and would rewrite every line: the file is jsoncpp's styled output, with its
 * own spacing and seventeen-significant-digit doubles, and nothing here
 * reproduces that. An operator about to load a generated config into a running
 * exhibit will diff it first, and a diff of the whole file tells them nothing.
 * Twelve changed numbers tell them everything.
 */

import type { PreparedRig } from './optics.ts';
import { wrapDeg180 } from './vec.ts';

const M_TO_IN = 1 / 0.0254;

/** One setting, as the file stores it. Unknown keys are preserved untouched. */
export interface SosConfigEntry {
  description?: string;
  displayName?: string;
  envName?: string | string[];
  group?: string;
  value: unknown;
  [key: string]: unknown;
}

/** The whole file: setting name to setting. */
export type SosConfig = Record<string, SosConfigEntry>;

/**
 * Parse the file, refusing anything that is not the shape described above.
 *
 * Strict about the shape and indifferent to the contents: an entry this project
 * has never heard of is fine and is carried through, but an entry with no
 * `value` is not, because the whole file is a map from name to value and one
 * without a value means this is not that file.
 */
export function parseSosConfig(text: string): SosConfig {
  const raw: unknown = JSON.parse(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('a local_sos_config.json is a JSON object of named settings');
  }
  const out: SosConfig = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`setting ${JSON.stringify(key)} is not an object`);
    }
    if (!('value' in (entry as Record<string, unknown>))) {
      throw new Error(`setting ${JSON.stringify(key)} has no value`);
    }
    out[key] = entry as SosConfigEntry;
  }
  if (Object.keys(out).length === 0) throw new Error('the file holds no settings');
  return out;
}

/**
 * The factory default an entry states inside its own description, or `null`.
 *
 * The reason this is a function and not a comment: see the module note, and
 * A-39. Three numbers reached this project's spec as site measurements and were
 * defaults read out of prose exactly like this.
 */
export function sosConfigDefault(entry: SosConfigEntry): number | null {
  const text = typeof entry.description === 'string' ? entry.description : '';
  // "... <br><br> Default Value: <br> 211.0" — the tags vary, the phrase does not.
  const match = /Default Value:\s*(?:<br>\s*)*([-+]?\d*\.?\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
}

/** Index the file by `envName`, which is spelled consistently where the keys are not. */
function byEnvName(config: SosConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, entry] of Object.entries(config)) {
    // `envName` is a string for scalars and an array for the per-projector
    // list settings, which this writer does not touch.
    if (typeof entry.envName === 'string') out.set(entry.envName.toUpperCase(), key);
  }
  return out;
}

/** The geometry a site's config states, in inches, for comparison against a rig. */
export interface SosConfigGeometry {
  sphereRadiusIn: number | null;
  equatorHeightIn: number | null;
  /** Per projector, in `P1..Pn` order. `null` where the file has no such entry. */
  distanceIn: (number | null)[];
  heightIn: (number | null)[];
  /** Where 0 degrees longitude sits, degrees. `projectorRotation`. */
  rotationDeg: number | null;
  /** What the same entries state as their factory defaults. See A-39. */
  defaults: {
    sphereRadiusIn: number | null;
    equatorHeightIn: number | null;
    distanceIn: (number | null)[];
    heightIn: (number | null)[];
  };
}

const MAX_PROJECTORS = 4;

function numberAt(config: SosConfig, env: Map<string, string>, name: string): number | null {
  const key = env.get(name);
  if (key === undefined) return null;
  const v = config[key].value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function defaultAt(config: SosConfig, env: Map<string, string>, name: string): number | null {
  const key = env.get(name);
  return key === undefined ? null : sosConfigDefault(config[key]);
}

/** Read the geometry out of a parsed config. */
export function readSosConfigGeometry(config: SosConfig): SosConfigGeometry {
  const env = byEnvName(config);
  const slots = Array.from({ length: MAX_PROJECTORS }, (_, i) => i + 1);
  return {
    sphereRadiusIn: numberAt(config, env, 'SPHERE_RADIUS_INCHES'),
    equatorHeightIn: numberAt(config, env, 'SPHERE_HEIGHT_AT_EQUATOR_INCHES'),
    distanceIn: slots.map((n) => numberAt(config, env, `P${n}_DIST_INCHES`)),
    heightIn: slots.map((n) => numberAt(config, env, `P${n}_HEIGHT_INCHES`)),
    rotationDeg: numberAt(config, env, 'PROJECTOR_ROTATION'),
    defaults: {
      sphereRadiusIn: defaultAt(config, env, 'SPHERE_RADIUS_INCHES'),
      equatorHeightIn: defaultAt(config, env, 'SPHERE_HEIGHT_AT_EQUATOR_INCHES'),
      distanceIn: slots.map((n) => defaultAt(config, env, `P${n}_DIST_INCHES`)),
      heightIn: slots.map((n) => defaultAt(config, env, `P${n}_HEIGHT_INCHES`)),
    },
  };
}

/**
 * The parts of a calibration this file has no field for.
 *
 * Each array is in rig order. These are not errors in the writer; they are the
 * format's own ceiling, and reporting them is what keeps a generated config from
 * looking like a complete answer.
 */
export interface SosConfigDiscard {
  /**
   * Recovered azimuth minus the nominal quadrant the config's model assumes,
   * degrees. There is no azimuth field at all, so the whole of this is dropped.
   *
   * `null` for a projector whose id is not one of the four SOS slots: there is
   * no nominal quadrant to subtract, and a zero there would read as "this one
   * is where the config expects" when the truth is that the config has never
   * heard of it. Every other array here stays in rig order and stays full.
   */
  azimuthDeg: (number | null)[];
  /**
   * Angle between the recovered optical axis and the line from the lens to the
   * body's centre. The config's model has every projector aimed at the centre,
   * so anything here is discarded.
   */
  aimOffAxisDeg: number[];
  /** Recovered roll. No field carries it. */
  rollDeg: number[];
  /** Recovered horizontal field of view, which the config derives and never stores. */
  fovHDeg: number[];
  /** The worst single angular departure above, for a one-line summary. */
  worstAngleDeg: number;
}

/** One value the update would change. */
export interface SosConfigChange {
  /** The setting's key in the file. */
  key: string;
  /** Its `envName`, which is what the description and the docs use. */
  envName: string;
  from: number | null;
  to: number;
}

export interface SosConfigUpdate {
  /** Every value that changed, in file order. Empty when the rig already agrees. */
  changed: SosConfigChange[];
  /** Settings the rig has an answer for that this file has no entry for. */
  missing: string[];
  discarded: SosConfigDiscard;
}

/**
 * Work out what a rig would change in a site's config, without changing it.
 *
 * Separate from {@link formatSosConfig} on purpose: this is the part with the
 * arithmetic in it and it is answerable without any text, so it is testable
 * without any text. The writer takes the result and the original bytes.
 *
 * `rig` is the calibration to write — the recovered one, not ground truth. A
 * config is the coarse model an operator loads, so it can only ever contain what
 * a calibration could have known; see `sos.ts` on the same distinction, where it
 * matters more because that file needs two rigs and this one needs one.
 */
export function updateSosConfig(config: SosConfig, rig: PreparedRig): SosConfigUpdate {
  const env = byEnvName(config);
  const changed: SosConfigChange[] = [];
  const missing: string[] = [];

  const propose = (name: string, to: number): void => {
    const key = env.get(name);
    if (key === undefined) {
      missing.push(name);
      return;
    }
    const before = config[key].value;
    const from = typeof before === 'number' && Number.isFinite(before) ? before : null;
    // Compared at the precision the file is written to, so a rig that already
    // agrees produces an empty patch instead of a diff full of float dust.
    if (from !== null && round2(from) === round2(to)) return;
    changed.push({ key, envName: name, from, to });
  };

  propose('SPHERE_HEIGHT_AT_EQUATOR_INCHES', rig.centerHeightM * M_TO_IN);

  const azimuthDeg: (number | null)[] = [];
  const aimOffAxisDeg: number[] = [];
  const rollDeg: number[] = [];
  const fovHDeg: number[] = [];

  rig.projectors.forEach((p) => {
    const lens = p.lens;
    // The projector's OWN id, never its position in the array. A rig with a
    // projector switched off is shorter and its remaining lenses keep their slot
    // names: two projectors are P1 and P3, at array indices 0 and 1. Naming the
    // config entries by index would write P3's geometry into P2's row, on a file
    // that then loads and aims a projector at the wrong quarter of the room.
    // Every discarded quantity is recorded FIRST and unconditionally, because
    // `SosConfigDiscard` promises rig order and a projector that has no config
    // row still has a roll and an aim the config cannot hold. Returning early
    // here used to shorten three of the four arrays, so a hand-placed rig
    // reported less discarded than it discarded.
    const centre = rig.surface.centre;
    const toCentre = { x: centre.x - lens.x, y: centre.y - lens.y, z: centre.z - lens.z };
    const len = Math.hypot(toCentre.x, toCentre.y, toCentre.z);
    const cos =
      len > 0
        ? (p.axis.x * toCentre.x + p.axis.y * toCentre.y + p.axis.z * toCentre.z) / len
        : 1;
    aimOffAxisDeg.push((Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI);
    rollDeg.push(p.cal.pose.rollDeg);
    fovHDeg.push(p.cal.intrinsics.fovHDeg);

    // The projector's OWN id, never its position in the array. A rig with a
    // projector switched off is shorter and its remaining lenses keep their slot
    // names: two projectors are P1 and P3, at array indices 0 and 1. Naming the
    // config entries by index would write P3's geometry into P2's row, on a file
    // that then loads and aims a projector at the wrong quarter of the room.
    const slot = /^P(\d+)$/.exec(p.cal.id);
    if (slot === null) {
      // A hand-placed rig whose projectors are not the four SOS slots. There is
      // no entry to write and inventing one would be worse than saying so, and
      // no nominal quadrant to measure an azimuth against either.
      missing.push(`${p.cal.id}_DIST_INCHES`, `${p.cal.id}_HEIGHT_INCHES`);
      azimuthDeg.push(null);
      return;
    }
    const n = Number(slot[1]);
    const nominal = NOMINAL_QUADRANT_DEG[n - 1] ?? (90 * (n - 1)) % 360;
    azimuthDeg.push(wrapDeg180((Math.atan2(lens.y, lens.x) * 180) / Math.PI - nominal));

    // HORIZONTAL, per the file's own words and A-17. A slant range would read
    // high by `d - sqrt(d^2 - z^2)`, which at a 12 in lens rise on a 211 in
    // throw is 0.36 in — small, plausible, and wrong in the same direction
    // every time, which is the kind of error that survives a sanity check.
    propose(`P${n}_DIST_INCHES`, Math.hypot(lens.x, lens.y) * M_TO_IN);
    // The file wants height above the FLOOR; the world frame has the body's
    // centre at the origin (conventions.ts §W).
    propose(`P${n}_HEIGHT_INCHES`, (lens.z + rig.centerHeightM) * M_TO_IN);
  });

  const worstAngleDeg = Math.max(
    0,
    ...azimuthDeg.filter((v): v is number => v !== null).map(Math.abs),
    ...aimOffAxisDeg.map(Math.abs),
    ...rollDeg.map(Math.abs),
  );

  return {
    changed,
    missing,
    discarded: { azimuthDeg, aimOffAxisDeg, rollDeg, fovHDeg, worstAngleDeg },
  };
}

/** The quadrants the config's model puts projectors on. PARAMETERS.md §2. */
const NOMINAL_QUADRANT_DEG: readonly number[] = [0, 90, 180, 270];

/**
 * Two decimals — the precision a tape measure in inches actually carries, and
 * the precision the sample file's own values are written to.
 */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function fixed2(v: number): string {
  // At least one decimal place, because the file writes `209.0` and `34.0` and
  // these entries are declared `"dataType": "DOUBLE"`. A bare `211` parses to
  // the same double, and looks like the one line a machine touched.
  const r = round2(v);
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

/**
 * Apply an update to the original text, changing only the numbers that changed.
 *
 * A surgical edit rather than a re-serialization — see the module note. For each
 * changed setting {@link findValueNumberSpan} locates that setting's OWN `value`
 * number and nothing else replaces it.
 *
 * Throws rather than writing a partial patch. A config that got three of its
 * twelve numbers is worse than one that got none, because it is still loadable.
 */
export function formatSosConfig(original: string, update: SosConfigUpdate): string {
  let text = original;
  for (const change of update.changed) {
    // Re-scanned from the start for every change, because each edit shifts the
    // offsets after it. The file is a few hundred lines and the patch a dozen
    // numbers, so the quadratic is free and the alternative is bookkeeping.
    const span = findValueNumberSpan(text, change.key);
    if (span === null) {
      throw new Error(
        `setting ${JSON.stringify(change.key)} has no top-level numeric value in this text`,
      );
    }
    text = text.slice(0, span.start) + fixed2(change.to) + text.slice(span.end);
  }
  return text;
}

/**
 * The span of the number written as setting `key`'s own `value`, or `null`.
 *
 * Depth-aware and string-aware, and both matter. Two earlier versions of this
 * were wrong in ways that produced VALID JSON with the wrong number in it:
 *
 *   - A plain `indexOf` for the quoted key matched the same name appearing as an
 *     `envName` VALUE, or escaped inside a description. Requiring a `{` or `,`
 *     before it helped and was still not enough, because a nested object's
 *     property sits after a `{` too — and `parseSosConfig` deliberately admits
 *     nested metadata this project has never seen.
 *   - Replacing the first `"value"` inside the entry hit a nested one first:
 *     `{ "metadata": { "value": 1 }, "value": 213.5 }` patched the metadata and
 *     left the live number alone.
 *
 * So this walks the text once, counting braces and brackets outside strings,
 * and accepts a key token only at the depth it belongs to: the setting name at
 * depth 1 of the root object, and that setting's `value` at depth 2. A token is
 * a KEY only when the next non-space character is a colon, which is what keeps
 * a string whose contents happen to read `"value"` from counting.
 */
function findValueNumberSpan(text: string, key: string): { start: number; end: number } | null {
  const n = text.length;
  let depth = 0;
  let inEntry = false;
  let entryDepth = -1;
  let i = 0;

  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const str = endOfString(text, i);
      if (str === null) return null;
      let j = str;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== ':') {
        // A string VALUE, not a key. Skipped whole, which is what stops a
        // description containing braces or quotes from moving the depth count.
        i = str;
        continue;
      }
      const name = text.slice(i + 1, str - 1);
      let k = j + 1;
      while (k < n && /\s/.test(text[k])) k++;
      if (!inEntry && depth === 1 && name === key) {
        if (text[k] !== '{') return null;
        inEntry = true;
        entryDepth = depth + 1;
        i = k;
        continue;
      }
      if (inEntry && depth === entryDepth && name === 'value') {
        const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(k));
        return m === null ? null : { start: k, end: k + m[0].length };
      }
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      // The entry closed without a `value` of its own. `parseSosConfig` refuses
      // such a file, so reaching here means the text and the parsed object have
      // come apart — which is a throw upstairs, not a silent skip.
      if (inEntry && depth < entryDepth) return null;
    }
    i++;
  }
  return null;
}

/** The index just past the closing quote of the string starting at `at`. */
function endOfString(text: string, at: number): number | null {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '"') return i + 1;
  }
  return null;
}
