// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * license-header — every source file names its licence, and CI says so.
 *
 * ## Why the short form
 *
 * Apache 2.0 does not require per-file headers; its appendix says "we
 * recommend". The licence is satisfied by LICENSE and NOTICE at the root. What
 * a per-file marker buys is machine readability — scanners, REUSE, and GitHub
 * all read SPDX identifiers — and that costs two lines rather than the sixteen
 * of the full boilerplate.
 *
 * Sixteen would have been the wrong trade here specifically. 186 of this
 * repository's 191 source files open with a doc comment explaining what the file
 * is for, and those comments are the thing that makes the codebase readable.
 * Pushing every one of them sixteen lines down to make room for identical legal
 * text works against the project's own documentation discipline, and it would
 * have added ~3,000 lines that no reader ever needs to read twice.
 *
 * ## What counts as correct
 *
 * The SPDX line and a copyright line, above everything except a line that must
 * come first. The year is not pinned: a file edited in a later year should be
 * free to say `2026-2027` without failing a check that has no opinion about
 * copyright terms.
 *
 * ## Prologues
 *
 * Three files cannot take a header at line 1 — two HTML documents whose doctype
 * must lead, and one script with a shebang. Inserting above either breaks the
 * file silently: a doctype that is not first drops the browser into quirks mode,
 * and a shebang that is not first stops being a shebang. So the header goes
 * after that line rather than before it.
 *
 * Run:  node tools/license-header.ts          # check, exits non-zero on a miss
 *       node tools/license-header.ts --fix    # insert what is missing
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SPDX = 'SPDX-License-Identifier: Apache-2.0';
export const COPYRIGHT = 'Copyright 2026 Eric Hackathorn';

interface Comment {
  readonly open: string;
  readonly close: string;
}

/** How a header is spelled in each language this repository writes. */
function commentStyle(file: string): Comment | null {
  if (/\.(ts|mjs|js)$/.test(file)) return { open: '// ', close: '' };
  if (/\.html$/.test(file)) return { open: '<!-- ', close: ' -->' };
  return null;
}

/**
 * A line that must stay first, if the file has one.
 *
 * Returns the number of leading lines to skip. Getting this wrong is silent in
 * both directions — a displaced doctype means quirks mode, a displaced shebang
 * means the file stops being executable — so it is tested rather than assumed.
 */
export function prologueLines(text: string): number {
  const first = text.split('\n', 1)[0] ?? '';
  if (first.startsWith('#!')) return 1;
  if (/^\s*<!doctype\b/i.test(first)) return 1;
  return 0;
}

export function hasHeader(text: string): boolean {
  // Only the opening of the file is examined. A file that mentions SPDX in its
  // prose further down has not thereby licensed itself.
  const head = text.split('\n').slice(0, 8).join('\n');
  return head.includes(SPDX) && /Copyright\s+\d{4}(-\d{4})?\s+\S/.test(head);
}

export function addHeader(text: string, style: Comment): string {
  const lines = text.split('\n');
  const skip = prologueLines(text);
  const header = [
    `${style.open}${SPDX}${style.close}`,
    `${style.open}${COPYRIGHT}${style.close}`,
    '',
  ];
  // A prologue is followed by a blank line already in some files; do not add a
  // second one, and do not leave zero.
  const rest = lines.slice(skip);
  while (rest.length > 0 && rest[0].trim() === '') rest.shift();
  return [...lines.slice(0, skip), ...header, ...rest].join('\n');
}

export function sourceFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.mjs', '*.html'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/(^|\/)(node_modules|dist)\//.test(f))
    .filter((f) => commentStyle(f) !== null)
    .sort();
}

export function check(root: string, fix: boolean): string[] {
  const missing: string[] = [];
  for (const rel of sourceFiles(root)) {
    const full = path.join(root, rel);
    const text = fs.readFileSync(full, 'utf8');
    if (hasHeader(text)) continue;
    if (fix) {
      const style = commentStyle(rel);
      if (style !== null) fs.writeFileSync(full, addHeader(text, style));
    }
    missing.push(rel);
  }
  return missing;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fix = process.argv.includes('--fix');
  const root = ROOT;
  const missing = check(root, fix);
  const total = sourceFiles(root).length;

  if (fix) {
    console.log(`check:license: added a header to ${missing.length} of ${total} files`);
    process.exit(0);
  }
  if (missing.length > 0) {
    for (const f of missing) console.error(`check:license: ${f} has no SPDX header`);
    console.error(`check:license: ${missing.length} of ${total} files. Run: node tools/license-header.ts --fix`);
    process.exit(1);
  }
  console.log(`check:license: all ${total} source files carry an SPDX header`);
}
