// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What it would take to put the projectors back the way they were.
 *
 * Phase 4 of `docs/OPERATOR-PATH.md` is one conversation with the operator —
 * *here is what changes, here is how to change it back* — and its done-when is
 * the second half: "an operator can install a calibration, dislike it, and be
 * back to exactly the previous state in one step."
 *
 * ## The asymmetry this module exists to name
 *
 * The archive writes three kinds of file, and the page arrived at them from
 * opposite directions:
 *
 *   - the **config** is PATCHED, so the page was handed the original and still
 *     holds every byte of it;
 *   - the **warp meshes** and **alignment files** are GENERATED, and the page
 *     has never seen whatever is sitting at those paths on the sphere.
 *
 * So an archive that installs all three can only put one of them back. That is
 * worse than it sounds, because the failure is not "restore is unavailable" —
 * it is an operator who believes there is a way back, overwrites a working
 * alignment they spent a day on, and finds out afterwards. A restore point
 * covering some of what it overwrote is the thing that makes somebody brave.
 *
 * Hence {@link planRestore} reports `complete: false` and refuses to call
 * itself a restore point whenever anything is uncovered, rather than offering
 * a partial one and listing the gaps in small print.
 *
 * ## What this cannot know
 *
 * A browser page cannot see the sphere's filesystem. It does not know whether a
 * file already exists at a target path, so it cannot tell "this install will
 * destroy something" from "this install will create something new". Every
 * uncovered target is therefore stated conditionally — *if a file is there, it
 * goes and does not come back* — and never as a prediction. Pretending to know
 * would be inventing the one fact that decides whether the operator is safe.
 */

import type { ZipEntry } from './zip.ts';

/**
 * The kinds of file the archive installs, in the operator's words.
 *
 * Both forms are spelled out rather than derived, because the derivation is
 * wrong for the first entry: appending an `s` to "mesh" gives "meshs", and a
 * refusal an operator is meant to act on should not be the first thing in this
 * project that looks machine-written.
 */
export const TARGET_KINDS = {
  warp: { one: 'Bourke warp-and-blend mesh', many: 'Bourke warp-and-blend meshes' },
  alignment: { one: 'SOS projector alignment file', many: 'SOS projector alignment files' },
  config: { one: 'SOS stream control config', many: 'SOS stream control configs' },
} as const;

export type TargetKind = keyof typeof TARGET_KINDS;

/** One file the archive would put on the operator's machine. */
export interface InstallTarget {
  /** Where it goes, written the way the archive and the sphere both name it. */
  path: string;
  kind: TargetKind;
}

/**
 * One file the page holds verbatim, as it arrived from the operator.
 *
 * BYTES, not text, and the difference is the whole guarantee. An earlier
 * version of this interface carried a string and the docblock claimed it was
 * "the bytes that were loaded" — it was not. The page reads a config through
 * `File.text()`, which is a UTF-8 decode: it strips a leading byte-order mark
 * and replaces malformed sequences with U+FFFD. Re-encoding that for the
 * archive returns a file that still parses and is three bytes shorter than the
 * one the operator loaded, silently.
 *
 * A restore point that hands back a subtly different file is the failure this
 * module exists to prevent, so the original is kept as the bytes that arrived
 * and travels as those bytes. "Exactly the previous state" is the standard the
 * phase set, and it is a claim about bytes or it is not a claim.
 */
export interface HeldOriginal {
  path: string;
  bytes: Uint8Array;
}

/** A target whose original the page can put back. */
export interface CoveredTarget extends InstallTarget {
  bytes: Uint8Array;
}

export interface RestorePlan {
  /** Targets whose originals travel in the archive and can be put back. */
  covered: CoveredTarget[];
  /** Targets the archive would write over with no copy of what was there. */
  uncovered: InstallTarget[];
  /**
   * True only when every target is covered.
   *
   * There is deliberately no middle value. See the module note: a partial
   * restore point is the failure mode, not a degraded success.
   */
  complete: boolean;
  /** One line stating what the plan is worth. Always present. */
  summary: string;
  /** Why this is not a restore point. Null when `complete`. */
  refusal: string | null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Group paths by kind, for a message that reads like a sentence. */
function byKind(targets: readonly InstallTarget[]): string {
  const groups = new Map<TargetKind, string[]>();
  for (const t of targets) {
    const list = groups.get(t.kind) ?? [];
    list.push(t.path);
    groups.set(t.kind, list);
  }
  return [...groups.entries()]
    .map(([kind, paths]) => {
      const words = TARGET_KINDS[kind];
      return `${paths.length} ${paths.length === 1 ? words.one : words.many}`;
    })
    .join(' and ');
}

/**
 * What the archive could put back, against what it would write.
 *
 * `held` is matched to `targets` by exact path. A near-match is not a match:
 * restoring a file to a path it did not come from is how a config lands in the
 * wrong projector's directory, and the page has no way to check it guessed
 * right.
 */
export function planRestore(
  targets: readonly InstallTarget[],
  held: readonly HeldOriginal[],
): RestorePlan {
  const originals = new Map(held.map((h) => [h.path, h.bytes]));
  const covered: CoveredTarget[] = [];
  const uncovered: InstallTarget[] = [];
  for (const target of targets) {
    const bytes = originals.get(target.path);
    if (bytes === undefined) uncovered.push(target);
    else covered.push({ ...target, bytes });
  }

  if (targets.length === 0) {
    return {
      covered,
      uncovered,
      complete: false,
      summary: 'Nothing would be installed, so there is nothing to undo.',
      refusal:
        'This archive writes no files, so it has nothing to take a restore point of. That is ' +
        'not a restore point you can rely on later — it is an empty one.',
    };
  }

  const summary =
    `${covered.length} of ${targets.length} ${plural(targets.length, 'file')} the archive ` +
    `installs can be put back from copies travelling with it.`;

  if (uncovered.length === 0) {
    return { covered, uncovered, complete: true, summary, refusal: null };
  }

  return {
    covered,
    uncovered,
    complete: false,
    summary,
    refusal:
      `This is not a restore point. ${summary} The ${byKind(uncovered)} ` +
      `${plural(uncovered.length, 'is', 'are')} generated rather than patched, so the page has ` +
      `never seen whatever is at ${plural(uncovered.length, 'that path', 'those paths')} on your ` +
      `sphere: if a file is there, installing replaces it and nothing here brings it back. ` +
      `Copy ${plural(uncovered.length, 'it', 'them')} somewhere safe yourself before you ` +
      `install — there is nowhere on this page to hand ${plural(uncovered.length, 'it', 'them')} ` +
      `in, so copying ${plural(uncovered.length, 'it', 'them')} by hand is the only way back ` +
      `that exists today. A restore point ` +
      `that covers some of what it overwrote is worse than none, because it is the one that ` +
      `makes you brave.`,
  };
}

/** The manifest's own name, which everything else has to avoid. */
const MANIFEST_NAME = 'restore/MANIFEST.txt';

/**
 * Where each covered original travels, with collisions resolved once.
 *
 * `bundle.ts`'s `configEntryName` already had to solve this at the top level:
 * the picker accepts a config by CONTENT, so a site is free to call theirs
 * anything, and ZIP permits duplicate names while extractors disagree about
 * which one wins. The same hazard reaches one directory down, and this module
 * walked straight into it — a config named `MANIFEST.txt` lands on
 * `restore/MANIFEST.txt`, which is the file explaining what can be put back.
 * Either the instructions or the operator's own config disappears, and which
 * one depends on their unzip tool.
 *
 * Resolved here, once, and the result is used by both the entries and the
 * manifest so the two cannot disagree about where a file went. Compared
 * case-insensitively, because the extractor is what has to cope and Windows
 * and macOS treat `manifest.txt` as the same file.
 */
export function restoreEntryNames(covered: readonly CoveredTarget[]): Map<string, string> {
  const taken = new Set<string>([MANIFEST_NAME.toLowerCase()]);
  const out = new Map<string, string>();
  for (const c of covered) {
    const wanted = `restore/${c.path}`;
    let name = wanted;
    // A numbered suffix before the extension rather than after: `MANIFEST-2.txt`
    // still opens in a text editor, `MANIFEST.txt-2` does not.
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const dot = wanted.lastIndexOf('.');
      const cut = dot > wanted.lastIndexOf('/') ? dot : wanted.length;
      name = `${wanted.slice(0, cut)}-${n}${wanted.slice(cut)}`;
    }
    taken.add(name.toLowerCase());
    out.set(c.path, name);
  }
  return out;
}

/**
 * The `restore/` half of the archive: every original, plus what it is worth.
 *
 * The manifest is written even when the plan is incomplete — especially then.
 * An archive that silently omits a restore directory tells the operator
 * nothing; one that contains a file saying which of their files are NOT in it
 * is the only version of this that can prevent the mistake.
 */
export function restoreEntries(plan: RestorePlan): ZipEntry[] {
  const names = restoreEntryNames(plan.covered);
  const entries: ZipEntry[] = [{ name: MANIFEST_NAME, text: restoreManifest(plan) }];
  for (const c of plan.covered) {
    // `text` is unused for these — `buildZip` stores `bytes` verbatim when it is
    // present — and is empty rather than a decoded view of the same file, so
    // nothing downstream can read a lossy copy by mistake.
    entries.push({ name: names.get(c.path) ?? `restore/${c.path}`, text: '', bytes: c.bytes });
  }
  return entries;
}

function wrap(text: string, width = 78): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** What `restore/` is and is not, for somebody holding the archive without the page. */
export function restoreManifest(plan: RestorePlan): string {
  const lines: string[] = ['Putting it back', '===============', ''];

  /**
   * The refusal leads, because a warning under a heading saying "read this
   * first" that sits below two file listings is not read first.
   *
   * It carries the summary inside it, so the standalone summary line is only
   * printed when the plan is complete and there is no refusal to carry it.
   */
  if (!plan.complete) {
    lines.push('BEFORE YOU INSTALL', '------------------', '', ...wrap(plan.refusal ?? ''), '');
  } else {
    lines.push(...wrap(plan.summary), '');
  }

  if (plan.covered.length > 0) {
    const names = restoreEntryNames(plan.covered);
    lines.push('Copies in this archive', '----------------------');
    for (const c of plan.covered) {
      lines.push(`  ${names.get(c.path) ?? `restore/${c.path}`}  ->  ${c.path}`);
    }
    lines.push(
      '',
      ...wrap(
        'These are the files exactly as you loaded them, byte for byte, not re-written ' +
          'from anything this tool parsed out of them. Copying each one back over the path ' +
          'on the right returns that file to the state it was in before the install.',
      ),
      '',
    );
  }

  if (plan.uncovered.length > 0) {
    lines.push('NOT in this archive', '-------------------');
    for (const u of plan.uncovered) lines.push(`  ${u.path}`);
    lines.push(
      '',
      ...wrap(
        'This tool generates these rather than patching them, so it has never seen what is ' +
          'at those paths on your sphere. If a file is already there, installing replaces it ' +
          'and nothing in this archive brings it back. Copy them somewhere safe before you ' +
          'install anything.',
      ),
      '',
      ...wrap(
        'Note what this tool cannot tell you: it has no way to look at your filesystem, so ' +
          'it does not know whether those files exist. It is not predicting that you will ' +
          'lose something. It is saying it would not be able to tell you if you did.',
      ),
      '',
    );
  }

  return lines.join('\n');
}
