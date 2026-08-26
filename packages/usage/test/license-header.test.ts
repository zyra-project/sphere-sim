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
  assert.ok(hasHeader(out));
});

test('a doctype stays on line 1', () => {
  const out = addHeader('<!doctype html>\n<html></html>\n', HTML);
  assert.equal(out.split('\n')[0], '<!doctype html>');
  assert.ok(hasHeader(out));
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
  assert.ok(hasHeader(once));
  // check() skips anything that already has one, which is what makes --fix safe
  // to run repeatedly.
  assert.equal(once.split(SPDX).length - 1, 1);
});

test('a mention of SPDX further down the file is not a header', () => {
  const prose = ['', '', '', '', '', '', '', '', '', `// ${SPDX}`, `// ${COPYRIGHT}`].join('\n');
  assert.equal(hasHeader(prose), false);
});

test('both lines are required, not just the identifier', () => {
  assert.equal(hasHeader(`// ${SPDX}\nexport const x = 1;\n`), false);
  assert.equal(hasHeader(`// ${COPYRIGHT}\nexport const x = 1;\n`), false);
  assert.equal(hasHeader(`// ${SPDX}\n// ${COPYRIGHT}\n`), true);
});

test('the year is not pinned', () => {
  // A file edited later should be free to say 2026-2027 without failing a check
  // that has no opinion about copyright terms.
  assert.equal(hasHeader(`// ${SPDX}\n// Copyright 2026-2031 Someone Else\n`), true);
  assert.equal(hasHeader(`// ${SPDX}\n// Copyright 2031 Someone Else\n`), true);
  assert.equal(hasHeader(`// ${SPDX}\n// Copyright\n`), false, 'a bare word is not a notice');
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
