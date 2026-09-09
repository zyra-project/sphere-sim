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
 */

import type { ZipEntry } from './zip.ts';

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

export interface BundleInput {
  /** `[projectorId, text]` for each lit projector. */
  warp: readonly (readonly [string, string])[];
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
    input.warp.map(([id]) => `warp/${id}.data`),
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
  for (const [id, text] of input.warp) entries.push({ name: `warp/${id}.data`, text });
  for (const [id, text] of input.alignment) {
    entries.push({ name: `alignment/${id}.alignment`, text });
  }
  if (input.config !== null) {
    entries.push({ name: configEntryName(input.configName, entries), text: input.config });
  }
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
