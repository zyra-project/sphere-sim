// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The archive's contents, and the one property that keeps it honest.
 *
 * The derogations exist in two places by necessity — on the panel before the
 * click, and in the README an hour later at a projector with the page closed —
 * and the whole point of `FILE_NOTES` is that those are the same sentences
 * rather than two descriptions free to drift. The tests that matter here are
 * the ones that would fail if somebody retyped one of them.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { bundleEntries, bundleReadme, CONFIG_ABSENT, FILE_NOTES } from '../src/bundle.ts';
import type { BundleInput } from '../src/bundle.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, '../web/main.ts'), 'utf8');

const INPUT = (over: Partial<BundleInput> = {}): BundleInput => ({
  warp: [
    ['P1', 'warp one\n'],
    ['P2', 'warp two\n'],
  ],
  alignment: [
    ['P1', 'align one\n'],
    ['P2', 'align two\n'],
  ],
  config: '{\n  "radius": 0.8128\n}\n',
  configName: 'local_sos_config.json',
  alignmentCost: 'Worst of them, P2: nine points left 0.25 px of a 55.0 px correction.',
  rigSummary: '2 projectors, as last recalibrated.',
  ...over,
});

test('the README quotes the notes rather than restating them', () => {
  // If this fails because somebody edited the README wording directly, the fix
  // is to edit `FILE_NOTES` — the panel and the file have to say one thing.
  const readme = bundleReadme(INPUT());
  for (const note of [FILE_NOTES.warp, FILE_NOTES.alignment, FILE_NOTES.config]) {
    // Compared with runs of whitespace collapsed: the README hard-wraps to 78
    // columns, so the sentences are the same text at different line breaks.
    const flat = readme.replace(/\s+/g, ' ');
    assert.ok(
      flat.includes(note.readme.replace(/\s+/g, ' ')),
      `the README does not carry ${note.title}'s note verbatim`,
    );
  }
});

test('the panel reads the same constant the README does', () => {
  // The page half of "one text, quoted twice". `renderReadout` must reach for
  // `FILE_NOTES` and `CONFIG_ABSENT`; a literal pasted into main.ts would look
  // right on screen and drift the moment the note is edited.
  assert.ok(MAIN.includes('FILE_NOTES'), 'the panel does not use FILE_NOTES');
  assert.ok(MAIN.includes('CONFIG_ABSENT'), 'the panel does not use CONFIG_ABSENT');
  // And the sentences themselves are NOT in main.ts, which is what makes the
  // check above mean something rather than being satisfied by an unused import.
  for (const note of [FILE_NOTES.warp, FILE_NOTES.alignment, FILE_NOTES.config]) {
    const sentence = note.page.split('.')[0];
    assert.ok(
      !MAIN.includes(sentence),
      `main.ts carries ${note.title}'s text as a literal as well as by reference`,
    );
  }
});

test('the config is in the archive only when one was loaded, and says why when not', () => {
  const withCfg = bundleEntries(INPUT()).map((e) => e.name);
  assert.deepEqual(withCfg, [
    'README.txt',
    'warp/P1.data',
    'warp/P2.data',
    'alignment/P1.alignment',
    'alignment/P2.alignment',
    'local_sos_config.json',
  ]);

  const without = bundleEntries(INPUT({ config: null }));
  assert.ok(!without.some((e) => e.name.endsWith('.json')), 'a config appeared from nowhere');
  // Absence explained, not merely absent. `updateSosConfig` patches the file it
  // is given; there is nothing to patch without one, and inventing a site's
  // configuration would be worse than omitting it.
  assert.ok(bundleReadme(INPUT({ config: null })).replace(/\s+/g, ' ').includes(
    CONFIG_ABSENT.replace(/\s+/g, ' '),
  ));
});

test('the config keeps the name it arrived under', () => {
  // So a diff against the operator's original needs no renaming first.
  const named = bundleEntries(INPUT({ configName: 'boulder_sos_config.json' }));
  assert.ok(named.some((e) => e.name === 'boulder_sos_config.json'));
});

test('the README comes first, so it is met before the files it explains', () => {
  for (const input of [INPUT(), INPUT({ config: null }), INPUT({ warp: [], alignment: [] })]) {
    assert.equal(bundleEntries(input)[0].name, 'README.txt');
  }
});

test('the README wraps for a terminal', () => {
  // Read in Notepad or a terminal, where nothing rewraps it.
  for (const line of bundleReadme(INPUT()).split('\n')) {
    assert.ok(line.length <= 78, `${line.length} columns: ${line}`);
  }
});

test('a part that cannot be built does not take the others with it', () => {
  // Found by `tools/smoke-app.ts`, whose fixture carries no UV set:
  // `buildWarpExport` refuses a model with no unwrap, and the first version of
  // the builder let that one refusal throw out of the whole function. The
  // alignment files and the config need no UVs and had already been built, so
  // dropping an unwrapped model made every file unreachable and the panel
  // rendered an error where the download button belonged.
  const refused = ['the warp meshes: smoke.glb carries no UV set, so there is no texel to send'];
  const partial = INPUT({ warp: [], refused });

  const names = bundleEntries(partial).map((e) => e.name);
  assert.ok(names.includes('alignment/P1.alignment'), 'the alignment files went with the meshes');
  assert.ok(names.includes('local_sos_config.json'), 'the config went with the meshes');
  assert.ok(!names.some((n) => n.startsWith('warp/')), 'a warp mesh appeared from nowhere');

  // And the absence is EXPLAINED. A file missing with no reason is the failure
  // this module exists against, and the reader holding the archive tomorrow
  // cannot ask the page what happened.
  const readme = bundleReadme(partial).replace(/\s+/g, ' ');
  assert.ok(readme.includes('Not in this archive'), 'the README does not name what is missing');
  assert.ok(readme.includes('carries no UV set'), 'the README does not carry the reason');
});

test('a rig with nothing lit still produces a readable archive', () => {
  // Reachable: every projector switched off. An archive explaining that is a
  // better answer than an empty file or a thrown error at the click.
  const empty = bundleEntries(INPUT({ warp: [], alignment: [], config: null }));
  assert.equal(empty.length, 1);
  assert.equal(empty[0].name, 'README.txt');
  assert.ok(empty[0].text.includes('Files for the projectors'));
});
