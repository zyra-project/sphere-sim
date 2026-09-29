// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What an operator takes to the wall, as one archive.
 *
 * ## Why these three arrived separately and should not
 *
 * The warp meshes, the SOS alignment files and the patched config are all
 * RIG-level outputs, and all three were reached from the per-projector card —
 * `renderInspect` only draws while a projector is the subject, yet every one of
 * these writes a file per projector or one file for the whole install. Nothing
 * about them belongs to the selected lens. Being hard to find was the symptom;
 * living on the wrong object was the cause.
 *
 * ## One text, quoted twice
 *
 * The derogations below are the page's own words, exported rather than
 * retyped. A README that paraphrased what the panel says would be a second
 * description of the same limits, free to drift from the first — and the reader
 * who most needs them is the one who has already closed the page and is holding
 * the files.
 *
 * ## Where each mesh goes, said by the archive rather than by a filename
 *
 * A Bourke mesh does not say which part of the framebuffer it drives, and the
 * archive used to leave that to its filename: a player had to read `P3` out of
 * `warp/P3.data` and assume SOS's default `projectorInfo(viewport)` order to
 * put it in the top-left. That is the failure `viewportPixels` in `emit.ts`
 * calls the expensive one — a mesh in the wrong quadrant still draws a
 * plausible picture, so nothing on the sphere says the file was misread — and
 * every consumer that re-derived the layout was another chance to invert the
 * bottom-left origin. `layout.json` (issue #49) states it from the rig the
 * meshes were built from; see {@link projectorLayout}.
 */

import type {
  ProjectorCalibration,
  RigCalibration,
  Viewport,
} from '../../calibration/src/index.ts';
import type { WarpTexture } from '../../sim/src/warp.ts';
import type { ZipEntry } from './zip.ts';
import { type RestorePlan, restoreEntries } from './restore.ts';

/**
 * A projector's warp mesh, as the archive names it.
 *
 * One expression, used by the entries, the README and `layout.json`, so that
 * every `mesh` path the layout gives is the name of an entry the archive holds
 * rather than a second spelling of it.
 */
export function warpEntryName(id: string): string {
  return `warp/${id}.data`;
}

/**
 * What each file is, and what it cannot say.
 *
 * `page` is what the panel shows before the click; `readme` is what travels
 * with the file. They are the same sentences: the second audience is the first
 * one an hour later, at a projector, without the page.
 */
export const FILE_NOTES = {
  warp: {
    title: 'warp/<projector>.data',
    page:
      'One Bourke warp-and-blend mesh per lit projector, for the calibration the software ' +
      'currently believes.',
    readme:
      'A Bourke warp-and-blend mesh per lit projector: five columns per vertex, the ' +
      'displacement and the blend weight together. This carries the full correction, ' +
      'including the part an SOS alignment file cannot.',
  },
  layout: {
    title: 'layout.json',
    page:
      'Which part of the framebuffer each warp mesh drives, and the rotation already inside ' +
      'the meshes, read from the rig they were built from, because a Bourke file says neither.',
    readme:
      'Where each warp mesh goes. A Bourke file cannot say which part of the display it ' +
      'drives, and a mesh drawn into the wrong part still draws a plausible picture, so ' +
      'nothing on the sphere would say the file was misread. Pair each mesh with its ' +
      'viewport here, by its "mesh" path, and never by the projector\'s name: a name is not ' +
      'a position, and two rigs can give one name two different places. This file is for ' +
      'whatever loads the meshes. It is not an install target, so restore/ neither covers ' +
      'it nor counts it.\n' +
      '\n' +
      '- "format": sphere-sim/projector-layout@1. Anything else is a different format; do ' +
      'not read it as this one.\n' +
      '- "origin": bottom-left. A viewport\'s y counts UP from the bottom of the framebuffer, ' +
      'as SOS\'s projectorInfo(viewport) does. A screen that counts rows down from the top ' +
      'puts the viewport\'s top edge at 1 - y - h of its height.\n' +
      '- "framebuffer": the one display every viewport divides, width and height in pixels. ' +
      'Check yours against it before drawing: a display of another size resamples every ' +
      'mesh and one of another shape stretches it, and neither looks wrong on the sphere.\n' +
      '- "surface" and "rotationOffsetDeg": what u and v address. "sphere" is the ' +
      'equirectangular map, and the sphere\'s rotation, in degrees, has already been taken ' +
      'off u: do not apply it again. "mesh" is the model\'s own UV set, which has no ' +
      'rotation, so the field is null.\n' +
      '- "projectors": one entry per mesh in warp/, in the same order, and no others. ' +
      '"viewport" is x, y, w and h as fractions of the framebuffer, exactly as the ' +
      'calibration holds them. Draw "mesh" into that rectangle.',
  },
  alignment: {
    title: 'alignment/<projector>.alignment',
    page:
      'The same correction reduced to the nine-point mesh an SOS projector alignment file ' +
      'carries. Lossy — read the note.',
    readme:
      'Lossy on purpose, four ways: no blend column at all, nine control points for the ' +
      'whole frame, computed from the true rig this simulator has and a real dome does ' +
      'not, and a format read off one sample file. Not a replacement for the Bourke mesh ' +
      '— it is the same correction made testable on the software already running the ' +
      'sphere.',
  },
  config: {
    title: 'local_sos_config.json',
    page:
      'The original file with only the recovered numbers moved — every other byte, comment ' +
      'and setting exactly as it arrived, so the diff is readable.',
    readme:
      'The config you loaded, with only the recovered geometry changed. Every other byte, ' +
      'comment and setting is exactly as it arrived, so `diff` against your original shows ' +
      'the calibration and nothing else. One convention it does NOT reproduce: the height ' +
      "field's own description says operators enter it an inch low because it aligns " +
      'better. This writes the height as measured.',
  },
} as const;

/**
 * Why no config is in the archive, when there is none.
 *
 * Stated as a reason rather than an absence. `updateSosConfig` PATCHES the file
 * it was given — that is what preserves every other setting — so with nothing
 * loaded there is nothing to patch, and writing one from defaults would be
 * inventing a site's configuration and handing it over as if it were theirs.
 */
export const CONFIG_ABSENT =
  'No local_sos_config.json is included: none was loaded. This tool patches the config you ' +
  'give it rather than writing one from scratch, so that every setting it does not ' +
  'understand survives untouched. Load your site config on the page and export again to ' +
  'get one.';

/**
 * Why no `layout.json` is in the archive, when there is none.
 *
 * Every case is covered by one sentence rather than a guess at which one this
 * is: there were no meshes to place, or the layout was refused and the refusal
 * is listed. What matters more than the cause is the instruction, because the
 * reader's fallback — a projector's name — is the thing that goes wrong.
 */
export const LAYOUT_ABSENT =
  'No layout.json is included: it places warp meshes, and it is written only beside them, ' +
  'from the same rig. Without it, nothing here says which part of the display a mesh ' +
  "drives. Do not pair one with a part by its projector's name instead, because a name is " +
  'not a position.';

/**
 * What `layout.json` declares itself to be, and the only value a reader should
 * accept as it.
 *
 * Declared here, beside its only writer, and not in `packages/calibration`
 * beside the rig's own `schema`. That package is the boundary object: the one
 * thing allowed to cross between `sim/` and `solver/`, so that the two can
 * disagree loudly about what its numbers mean. Neither side reads or writes
 * this file. A literal would pass `tools/boundary-lint.ts` there — R2 forbids
 * arithmetic and callables, not strings — but a format whose only reader is
 * outside the repository is not something the two models have to agree on, and
 * every other output format here (`bench-results`, `coverage-reference`,
 * `metrics`) lives beside the code that writes it for the same reason.
 *
 * Bump it when a reader of `@1` would misread the file, not when a field is
 * added that such a reader can ignore.
 */
export const LAYOUT_FORMAT = 'sphere-sim/projector-layout@1';

/** Where the layout travels in the archive. */
export const LAYOUT_ENTRY = 'layout.json';

/**
 * The part of a `RigCalibration` a layout reads, and all of it: the
 * framebuffer, and each projector's name and viewport. A whole calibration is
 * one of these.
 */
export interface LayoutRig {
  framebuffer: RigCalibration['framebuffer'];
  projectors: readonly Pick<ProjectorCalibration, 'id' | 'viewport'>[];
}

/** One projector's entry in `layout.json`. */
export interface LayoutProjector {
  /** The projector's name. A label, never a position. */
  id: string;
  /** Its Bourke mesh, as the archive names it: always an entry of the same archive. */
  mesh: string;
  /** Normalised to the framebuffer, origin bottom-left, exactly as the calibration holds it. */
  viewport: Viewport;
}

/**
 * `layout.json`, field for field. The names are the boundary object's own —
 * `framebuffer`, `viewport`, `rotationOffsetDeg` — so a reader who knows the
 * calibration already knows what they mean.
 *
 * The surface and the rotation travel as the pair {@link WarpTexture} is, so
 * the type admits `'sphere'` with a number and `'mesh'` with `null` and nothing
 * in between.
 */
export type ProjectorLayout = {
  format: typeof LAYOUT_FORMAT;
  origin: 'bottom-left';
  framebuffer: { width: number; height: number };
} & WarpTexture & {
  projectors: LayoutProjector[];
};

/**
 * Where each warp mesh goes, for whatever loads the meshes.
 *
 * `rig` is the calibration the meshes were built from, `texture` is what
 * `warpTexture` reports for that same rig, and `meshes` is the id of every mesh
 * the archive carries, in its order. Returns `null` when there are none: a
 * layout places meshes, and one with nothing to place would be a file the
 * reader has to open to learn it says nothing.
 *
 * ## What a reader must do with each field
 *
 *   - **`format`** is {@link LAYOUT_FORMAT}. Anything else is a different
 *     contract, and reading it as this one is a guess.
 *   - **`origin`** is `'bottom-left'`, stated rather than implied because it is
 *     the field most likely to be read backwards. A viewport's `y` counts UP from
 *     the bottom of the framebuffer, as conventions.ts §V and SOS's
 *     `projectorInfo(viewport)` do. A reader drawing in a top-left system — a
 *     canvas, most window systems — puts the top edge at `(1 − y − h)` of the
 *     height, which is the flip `viewportPixels` in `emit.ts` makes.
 *   - **`framebuffer`** is the one display every viewport divides, in pixels:
 *     `RigCalibration.framebuffer`. A reader compares it with the display it is
 *     about to drive. A mesh's `x` spans its projector's aspect and its viewport
 *     gives the pixel shape it lands in; on a display of another shape the two
 *     disagree and the picture stretches, and nothing on the sphere says so.
 *   - **`surface`** and **`rotationOffsetDeg`** say what the meshes' `u` and `v`
 *     address. `'sphere'`: the equirectangular content, with the sphere's
 *     mechanical rotation already taken off `u` — so a reader must NOT apply it
 *     again, and the number is here so an operator can see what was baked in
 *     rather than add it twice. `'mesh'`: the model's own UV set, which has no
 *     rotation, so `null`. Both come from `warpTexture`, which is also what
 *     `buildWarpExport` bakes from.
 *   - **`projectors`** has one entry per mesh the archive carries, in the
 *     archive's order, and no others — a projector switched off at the wall has
 *     no mesh and is not listed, and its quadrant is simply dark. A reader draws
 *     each `mesh` into its `viewport` and pairs the two by this entry alone.
 *     NEVER by `id`: `placedRig` names projectors `P1`…`Pn` in placement order
 *     and lays them out with `gridViewports`, so two placed projectors split the
 *     framebuffer into halves and a lone placed `P1` is the whole of it, where
 *     SOS's `P1` is the bottom-left quadrant. The layout carries the viewports
 *     the rig actually has, never SOS's defaults by id, which is the whole
 *     reason it exists. terraviz's multi-monitor plan (its
 *     `docs/MULTI_MONITOR_PLAN.md`, Rung 16; terraviz#450) withdrew its id
 *     fallback on exactly this ground: handed a bundle with no layout, it asks
 *     the operator, and refuses otherwise.
 *
 * Throws when a mesh names a projector the rig does not hold, or a name that is
 * given twice — two projectors in the rig, or two meshes in the list. Either
 * way the meshes and the rig disagree about which projectors exist, and a
 * layout that picked one would be the silent misplacement this file exists to
 * end.
 */
export function projectorLayout(
  rig: LayoutRig,
  texture: WarpTexture,
  meshes: readonly string[],
): ProjectorLayout | null {
  if (meshes.length === 0) return null;

  const viewports = new Map<string, Viewport>();
  const shared = new Set<string>();
  for (const p of rig.projectors) {
    if (viewports.has(p.id)) shared.add(p.id);
    viewports.set(p.id, p.viewport);
  }

  const listed = new Set<string>();
  const projectors = meshes.map((id): LayoutProjector => {
    const viewport = viewports.get(id);
    if (viewport === undefined) {
      throw new Error(
        `${warpEntryName(id)} has no projector ${id} in the rig it was built from, so ` +
          'nothing can say which part of the framebuffer it drives',
      );
    }
    if (shared.has(id) || listed.has(id)) {
      throw new Error(
        `the name ${id} is given twice, so it cannot say which viewport ` +
          `${warpEntryName(id)} belongs to`,
      );
    }
    listed.add(id);
    return {
      id,
      mesh: warpEntryName(id),
      // Copied field by field, as the calibration holds them. Not rounded and
      // not converted to pixels: the calibration's normalised numbers are the
      // contract, and a rounded copy would be a second, slightly different one.
      viewport: { x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h },
    };
  });

  // The pair copied as the pair, for the viewport's reason, and so the file's
  // key order is this one whatever order the caller's object was built in.
  const surface: WarpTexture =
    texture.surface === 'sphere'
      ? { surface: 'sphere', rotationOffsetDeg: texture.rotationOffsetDeg }
      : { surface: 'mesh', rotationOffsetDeg: null };

  return {
    format: LAYOUT_FORMAT,
    origin: 'bottom-left',
    framebuffer: { width: rig.framebuffer.width, height: rig.framebuffer.height },
    ...surface,
    projectors,
  };
}

/** `layout.json`'s text: plain indented JSON, because people open it as well as programs. */
function layoutText(layout: ProjectorLayout): string {
  return `${JSON.stringify(layout, null, 2)}\n`;
}

export interface BundleInput {
  /** `[projectorId, text]` for each lit projector. */
  warp: readonly (readonly [string, string])[];
  /**
   * Where each of those meshes goes: {@link projectorLayout} given the ids of
   * `warp` above, in its order, and the rig they were built from.
   *
   * `null` when there is no mesh to place, or when the layout was refused — in
   * which case `refused` says why. Required rather than optional, because an
   * archive of meshes with no layout is exactly the ambiguity this file exists
   * to end, and a caller should have to write down that it means one.
   */
  layout: ProjectorLayout | null;
  alignment: readonly (readonly [string, string])[];
  /** The patched config, or `null` when none was loaded. */
  config: string | null;
  /** The name that config arrived under, so it leaves under the same one. */
  configName: string;
  /** What the reduction cost on this rig, as the panel reports it. */
  alignmentCost: string;
  /** Free text identifying the rig, for the README's first line. */
  rigSummary: string;
  /**
   * Parts that could not be built, each already a sentence saying why.
   *
   * A file missing from the archive with no explanation is the failure this
   * whole module is against. `buildWarpExport` refuses a model with no UV set,
   * which is correct and says nothing to somebody holding the archive a day
   * later wondering where the meshes went.
   */
  refused?: readonly string[];
  /**
   * What it would take to undo installing this archive.
   *
   * Optional only so that a caller building an archive for something other than
   * an install does not have to invent one. When it is absent the README says
   * so rather than staying quiet, because silence here reads as "nothing to
   * worry about" and that is the one thing it must never read as.
   */
  restore?: RestorePlan;
}

/** The README that travels with the files. */
export function bundleReadme(input: BundleInput): string {
  const lines: string[] = [
    'Files for the projectors',
    '========================',
    '',
    input.rigSummary,
    '',
    'Written by sphere-sim. Every file here describes the calibration the software',
    'currently believes, which is what an operator loads — not the ground truth the',
    'simulator holds, which no real dome has.',
    '',
  ];

  const section = (title: string, body: string, names: readonly string[]): void => {
    lines.push(title, '-'.repeat(title.length));
    for (const n of names) lines.push(`  ${n}`);
    if (names.length > 0) lines.push('');
    lines.push(...wrap(body));
    lines.push('');
  };

  section(
    FILE_NOTES.warp.title,
    FILE_NOTES.warp.readme,
    input.warp.map(([id]) => warpEntryName(id)),
  );
  // Straight after the meshes it places. The archive lists it before them
  // (see `bundleEntries`), but a reader meets what a warp mesh IS before where
  // each one goes.
  section(
    FILE_NOTES.layout.title,
    input.layout === null ? LAYOUT_ABSENT : FILE_NOTES.layout.readme,
    input.layout === null ? [] : [LAYOUT_ENTRY],
  );
  section(
    FILE_NOTES.alignment.title,
    input.alignmentCost === ''
      ? FILE_NOTES.alignment.readme
      : `${FILE_NOTES.alignment.readme}\n\n${input.alignmentCost}`,
    input.alignment.map(([id]) => `alignment/${id}.alignment`),
  );
  section(
    FILE_NOTES.config.title,
    input.config === null ? CONFIG_ABSENT : FILE_NOTES.config.readme,
    input.config === null ? [] : [input.configName],
  );

  /**
   * Where the operator meets the question of going back.
   *
   * Placed before the refusals rather than after, because it is the only
   * section that changes what somebody does BEFORE they copy a file. The
   * refusals explain an absence; this one can prevent a loss.
   */
  const restore = input.restore;
  section(
    'restore/',
    restore === undefined
      ? 'No restore point was taken. Nothing in this archive records the state of your ' +
          'sphere before an install, so nothing here can put it back. Copy anything you are ' +
          'about to overwrite somewhere safe first.'
      : restore.complete
        ? `${restore.summary} Every file this archive installs has its original beside it ` +
          'under restore/, byte for byte as you loaded it. See restore/MANIFEST.txt.'
        : `${restore.refusal ?? ''} See restore/MANIFEST.txt for which files are covered ` +
          'and which are not.',
    restore === undefined ? [] : ['restore/MANIFEST.txt'],
  );

  const refused = input.refused ?? [];
  if (refused.length > 0) {
    lines.push('Not in this archive', '-'.repeat('Not in this archive'.length));
    for (const r of refused) lines.push(...wrap(`- ${r}`));
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Hard-wrapped to 78 columns, because this is read in a terminal or Notepad. */
function wrap(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= 78) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line !== '') out.push(line);
  }
  return out;
}

/**
 * The archive's entries, README first.
 *
 * First because an extractor lists central-directory order and a reader opening
 * the archive should meet the explanation before the files it explains.
 */
export function bundleEntries(input: BundleInput): ZipEntry[] {
  const entries: ZipEntry[] = [{ name: 'README.txt', text: bundleReadme(input) }];
  // Beside the README, for the README's reason: it explains the files after it.
  // And ahead of everything an operator installs, so those stay together — it
  // is read by whatever loads the meshes and is not an install target.
  //
  // Ahead of the config for a reason that is not tidiness. `configEntryName`
  // moves a config aside only from names ALREADY written, and a site is free
  // to call its config `layout.json`. Written first, this is one of those
  // names; written after the config, the two would share it.
  if (input.layout !== null) {
    entries.push({ name: LAYOUT_ENTRY, text: layoutText(input.layout) });
  }
  for (const [id, text] of input.warp) entries.push({ name: warpEntryName(id), text });
  for (const [id, text] of input.alignment) {
    entries.push({ name: `alignment/${id}.alignment`, text });
  }
  if (input.config !== null) {
    entries.push({ name: configEntryName(input.configName, entries), text: input.config });
  }
  // Last, and inside its own directory: an extractor lists central-directory
  // order, so the files an operator installs stay together at the top and the
  // copies of what they are replacing do not interleave with them.
  if (input.restore !== undefined) entries.push(...restoreEntries(input.restore));
  return entries;
}

/**
 * Where the loaded config goes, given what is already in the archive.
 *
 * IT KEEPS THE NAME IT ARRIVED UNDER whenever that name is free, because the
 * whole point of writing it back is that the operator can diff it against the
 * file on their server without renaming anything first.
 *
 * The exception is a collision, and the one that matters is real rather than
 * theoretical: the picker accepts a config by CONTENT, so a site is free to
 * call theirs `README.txt`, and this archive already contains a `README.txt` of
 * its own. ZIP permits duplicate names and extractors disagree about what to do
 * with them — some take the first, some the last, some write both and some
 * prompt — so the operator's instructions could be silently overwritten by
 * JSON, or the config lost. Neither is a failure anybody would see happen.
 *
 * Compared case-INSENSITIVELY, because the extractor is the thing that has to
 * cope and Windows and macOS will treat `readme.txt` as the same file.
 *
 * On a collision the file keeps its name and moves into `config/`, which cannot
 * clash with anything this function writes. A directory is a smaller change to
 * ask of a reader than a mangled filename, and the README says it happened.
 */
export function configEntryName(name: string, existing: readonly ZipEntry[]): string {
  // A basename. `file.name` from a picker is already one, but a name carrying a
  // path separator would either nest unexpectedly or, with `..` in it, be a
  // traversal for an extractor that resolves entry paths.
  const base = name.split(/[\\/]/).pop()?.trim() ?? '';
  const safe = base === '' || base === '.' || base === '..' ? 'local_sos_config.json' : base;
  const taken = new Set(existing.map((e) => e.name.toLowerCase()));
  return taken.has(safe.toLowerCase()) ? `config/${safe}` : safe;
}
