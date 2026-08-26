// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The licence header check.
 *
 * Two of these guard failures that are silent rather than loud. A doctype that
 * is no longer the first line drops a browser into quirks mode, and a shebang
 * that is no longer the first line stops being a shebang — in both cases the
 * file still parses, still passes typecheck, and simply behaves differently.
 * Inserting text at line 1 of every source file in the repository is exactly the
 * operation that would do that, so the prologue handling is tested rather than
 * eyeballed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  COPYRIGHT,
  SPDX,
  addHeader,
  check,
  hasHeader,
  noticeMismatch,
  prologueLines,
  sourceFiles,
} from '../../../tools/license-header.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const TS = { open: '// ', close: '' };
const HTML = { open: '<!-- ', close: ' -->' };

test('this repository is fully headed', () => {
  assert.deepEqual(check(REPO, false), []);
});

test('it covers the source tree and not the build output', () => {
  const files = sourceFiles(REPO);
  assert.ok(files.length > 150, `only ${files.length} files in scope`);
  assert.ok(!files.some((f) => /(^|\/)(dist|node_modules)\//.test(f)));
  assert.ok(files.some((f) => f.endsWith('.mjs')), 'the portable skill is source too');
  assert.ok(files.some((f) => f.endsWith('.html')), 'the app page is source too');
});

test('a shebang stays on line 1', () => {
  const out = addHeader('#!/usr/bin/env node\nconsole.log(1);\n', TS);
  assert.equal(out.split('\n')[0], '#!/usr/bin/env node');
  assert.ok(hasHeader(out, TS));
});

test('a doctype stays on line 1', () => {
  const out = addHeader('<!doctype html>\n<html></html>\n', HTML);
  assert.equal(out.split('\n')[0], '<!doctype html>');
  assert.ok(hasHeader(out, HTML));
  assert.ok(out.includes(`<!-- ${SPDX} -->`));
});

test('prologue detection is case-insensitive and does not fire on ordinary code', () => {
  assert.equal(prologueLines('#!/bin/sh\n'), 1);
  assert.equal(prologueLines('<!DOCTYPE html>\n'), 1);
  assert.equal(prologueLines('<!doctype html>\n'), 1);
  assert.equal(prologueLines('import * as fs from "node:fs";\n'), 0);
  assert.equal(prologueLines('/** a doc comment */\n'), 0);
});

test('the file body survives intact', () => {
  const body = '/**\n * why this file exists\n */\nexport const x = 1;\n';
  const out = addHeader(body, TS);
  assert.ok(out.endsWith(body), 'the original content should be untouched below the header');
});

test('applying twice does not stack headers', () => {
  const once = addHeader('export const x = 1;\n', TS);
  assert.ok(hasHeader(once, TS));
  // check() skips anything that already has one, which is what makes --fix safe
  // to run repeatedly.
  assert.equal(once.split(SPDX).length - 1, 1);
});

test('a file that merely TALKS about the header does not pass', () => {
  // The regression. Searching the first eight lines for the two strings passes
  // for a file which only mentions them — and two files in this repository do
  // exactly that, this test and the tool it tests, so a header lost from either
  // would have gone unnoticed by the check written to notice it.
  const talksAboutIt = [
    '/**',
    ` * Parses ${SPDX} out of source files.`,
    ` * Looks for ${COPYRIGHT} as the second line.`,
    ' */',
    'export const x = 1;',
  ].join('\n');
  assert.equal(hasHeader(talksAboutIt, TS), false);
});

test('the header must be first, not merely early', () => {
  const pushedDown = ['export const x = 1;', `// ${SPDX}`, `// ${COPYRIGHT}`].join('\n');
  assert.equal(hasHeader(pushedDown, TS), false);
});

test('both lines are required, in order', () => {
  assert.equal(hasHeader(`// ${SPDX}\nexport const x = 1;\n`, TS), false);
  assert.equal(hasHeader(`// ${COPYRIGHT}\nexport const x = 1;\n`, TS), false);
  assert.equal(hasHeader(`// ${COPYRIGHT}\n// ${SPDX}\n`, TS), false, 'order matters');
  assert.equal(hasHeader(`// ${SPDX}\n// ${COPYRIGHT}\n`, TS), true);
});

test('the year moves; the holder does not', () => {
  // A file edited in a later year should be free to say 2026-2027. A file
  // quietly attributing itself to somebody else is the drift NOTICE is pinned
  // against, so that is a failure rather than a licence-agnostic shrug.
  assert.equal(hasHeader(`// ${SPDX}\n// Copyright 2026-2031 The Zyra Project\n`, TS), true);
  assert.equal(hasHeader(`// ${SPDX}\n// Copyright 2031 The Zyra Project\n`, TS), true);
  assert.equal(hasHeader(`// ${SPDX}\n// Copyright 2026 Someone Else\n`, TS), false);
  assert.equal(hasHeader(`// ${SPDX}\n// Copyright\n`, TS), false, 'a bare word is not a notice');
});

test('the comment style has to match the file kind', () => {
  // An HTML header in a .ts file is a syntax error waiting to happen, and the
  // reverse renders as visible text on the page.
  assert.equal(hasHeader(`<!-- ${SPDX} -->\n<!-- ${COPYRIGHT} -->\n`, TS), false);
  assert.equal(hasHeader(`// ${SPDX}\n// ${COPYRIGHT}\n`, HTML), false);
});

test('NOTICE names the same copyright holder as the headers', () => {
  assert.equal(noticeMismatch(REPO), null);
});

test('a NOTICE that drifts from the header constant is caught', () => {
  // This drifted once: changing the holder meant sweeping 195 files plus NOTICE
  // plus CITATION.cff by hand, with nothing to catch a miss.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-'));
  fs.writeFileSync(path.join(root, 'NOTICE'), 'sphere-sim\nCopyright 2026 Someone Else\n');
  assert.match(noticeMismatch(root) ?? '', /drifted/);
});

test('no NOTICE at all is not a failure', () => {
  // Not every repository ships one, and demanding it here would be a check
  // about a different thing than licence headers.
  assert.equal(noticeMismatch(fs.mkdtempSync(path.join(os.tmpdir(), 'nonotice-'))), null);
});

test('a file written but not yet git-added is still in scope', () => {
  // `git ls-files` alone lists only tracked files, which made the local check
  // disagree with CI in the one direction that matters: a file you have just
  // written passes here and fails there, so you find out after pushing. The
  // untracked-but-not-ignored set is exactly what is about to become tracked.
  const probe = path.join(REPO, 'packages/usage/src/untracked-header-probe.ts');
  fs.writeFileSync(probe, 'export const probe = 1;\n');
  try {
    assert.ok(
      sourceFiles(REPO).some((f) => f.endsWith('untracked-header-probe.ts')),
      'an untracked source file should be scanned',
    );
    assert.ok(
      check(REPO, false).some((f) => f.endsWith('untracked-header-probe.ts')),
      'and should be reported as missing a header',
    );
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('ignored paths stay out, tracked or not', () => {
  // dist/ is regenerated and gitignored; headers there would be churn that
  // never survives a rebuild.
  const dir = path.join(REPO, 'packages/web/dist');
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, 'ignored-header-probe.ts');
  fs.writeFileSync(probe, 'export const probe = 1;\n');
  try {
    assert.ok(!sourceFiles(REPO).some((f) => f.includes('ignored-header-probe')));
  } finally {
    fs.rmSync(probe, { force: true });
  }
});
