// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The check on the checks, for the generated tables.
 *
 * `tools/experiment-tables.ts` regenerates every table that sits between a pair
 * of `<!-- generated: id -->` markers and fails when a document disagrees with
 * the results file it reports. It was built because a human copying numbers out
 * of JSON got them wrong three times.
 *
 * It had a blind spot in the other direction, and this holds the fix. The tool
 * walked the blocks it knows about and looked for their markers; it never
 * walked the DOCUMENTS and asked which markers they carry. So a marker nobody
 * registered — or one registered against a different document — announced to a
 * reader that the table under it was machine-written and checked, while nothing
 * checked it. That is worse than an unmarked table, because the label buys
 * trust the numbers have not earned.
 *
 * Found by writing one: the experiment-7 table in ARBITRARY-SHAPES.md was
 * pasted under the id registered for EXPERIMENT-7.md, and `check:docs` passed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { unregisteredBlocks } from '../../../tools/experiment-tables.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const DOCS = path.join(REPO, 'docs');

test('every generated marker in the documentation is registered to its own document', () => {
  assert.deepEqual(
    unregisteredBlocks(),
    [],
    'a marker nothing renders is a hand-copied table wearing a generated one’s label',
  );
});

test('a marker registered against another document is caught, not passed', () => {
  // The exact fault that motivated the check, reproduced and then undone. It is
  // the subtle half: the id IS in the registry, so a bare membership test would
  // wave it through.
  const file = path.join(DOCS, 'ARBITRARY-SHAPES.md');
  const original = fs.readFileSync(file, 'utf8');
  const stray = '<!-- generated: experiment-7-mechanism-arbitrary-shapes -->';
  assert.ok(original.includes(stray), 'the fixture marker should be in the document');
  try {
    fs.writeFileSync(file, original.replace(stray, '<!-- generated: experiment-7-mechanism -->'));
    const found = unregisteredBlocks();
    assert.equal(found.length, 1, 'the misdirected marker should be the one finding');
    assert.equal(found[0].doc, 'docs/ARBITRARY-SHAPES.md');
    assert.equal(found[0].id, 'experiment-7-mechanism');
  } finally {
    fs.writeFileSync(file, original);
  }
  assert.deepEqual(unregisteredBlocks(), [], 'and the document is left as it was found');
});

test('a marker in a document no block targets at all is caught', () => {
  // The other half: an id nobody registered anywhere. Written to a scratch file
  // under docs/ so the walk has to be over the DIRECTORY and not over the set of
  // documents the registry happens to name.
  const file = path.join(DOCS, 'ZZ-EXPERIMENT-TABLES-FIXTURE.md');
  assert.ok(!fs.existsSync(file), 'the fixture name should be free');
  try {
    fs.writeFileSync(file, '# fixture\n\n<!-- generated: nothing-renders-this -->\n<!-- /generated -->\n');
    const found = unregisteredBlocks().filter((b) => b.doc.endsWith('ZZ-EXPERIMENT-TABLES-FIXTURE.md'));
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'nothing-renders-this');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
