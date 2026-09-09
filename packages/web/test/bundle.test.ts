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

import {
  bundleEntries,
  bundleReadme,
  configEntryName,
  CONFIG_ABSENT,
  FILE_NOTES,
} from '../src/bundle.ts';
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

test('a config named like the generated README does not overwrite it', () => {
  // The picker takes a config by CONTENT, so nothing stops a site calling
  // theirs README.txt -- and this archive writes one of its own. ZIP allows
  // duplicate names and extractors disagree about which wins, so the operator's
  // instructions could be replaced by JSON with nobody seeing it happen.
  const clash = bundleEntries(INPUT({ configName: 'README.txt' }));
  const names = clash.map((e) => e.name);
  assert.equal(
    new Set(names.map((n) => n.toLowerCase())).size,
    names.length,
    `the archive has two entries with one name: ${names.join(', ')}`,
  );
  // And the config is still IN it, under a name that keeps the filename whole.
  assert.ok(names.includes('config/README.txt'), names.join(', '));
  // The README this collided with is the generated one, not the config.
  const readme = clash.find((e) => e.name === 'README.txt');
  assert.ok(readme !== undefined && readme.text.includes('warp/'), 'the README was overwritten');
});

test('the collision check is case-insensitive, because extractors are', () => {
  // Windows and macOS treat readme.txt and README.txt as one file, so a
  // same-name comparison would let this pair through to the one place it breaks.
  const names = bundleEntries(INPUT({ configName: 'readme.TXT' })).map((e) => e.name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, names.join(', '));
});

test('a config name keeps its own name whenever nothing is in the way', () => {
  // The exception must stay an exception: writing the config back is only
  // useful if the operator can diff it against their server's copy without
  // renaming it first, so the ordinary case moves nothing.
  const names = bundleEntries(INPUT({ configName: 'boulder_sos_config.json' })).map((e) => e.name);
  assert.ok(names.includes('boulder_sos_config.json'), names.join(', '));
  assert.ok(!names.includes('config/boulder_sos_config.json'), names.join(', '));
});

test('a config name carrying a path is reduced to its basename', () => {
  // `file.name` from a picker is already a basename, so this is defence rather
  // than a fix for something observed -- but an entry path with `..` in it is a
  // traversal for any extractor that resolves them, and the cost of not being
  // the archive that ships one is a `split`.
  assert.equal(configEntryName('/etc/passwd', []), 'passwd');
  assert.equal(configEntryName('../../local_sos_config.json', []), 'local_sos_config.json');
  assert.equal(configEntryName('C:\\Users\\sos\\local_sos_config.json', []), 'local_sos_config.json');
  // A name that is nothing but a traversal has no basename to keep.
  assert.equal(configEntryName('..', []), 'local_sos_config.json');
  assert.equal(configEntryName('   ', []), 'local_sos_config.json');
});

test('every part of the archive is built through the same refusal path', () => {
  // `buildBundle` isolates each part so one refusal cannot take the others with
  // it -- a model with no UV set has no warp meshes and perfectly good alignment
  // files. The config was left OUT of that isolation: `formatSosConfig` refuses
  // a setting whose value is not a top-level number, and that exception threw
  // out of the whole function, doing to the archive exactly what the warp
  // refusal used to.
  const body = MAIN.slice(MAIN.indexOf('function buildBundle('));
  const end = body.indexOf('\n}\n');
  assert.ok(end > 0, 'buildBundle has no closing brace');
  const fn = body.slice(0, end);
  for (const call of ['buildWarpExports', 'buildSosAlignments', 'formatSosConfig']) {
    assert.ok(fn.includes(call), `buildBundle no longer calls ${call}`);
  }
  // Each of the three sits inside an `attempt(...)`, which is what records a
  // refusal instead of propagating it. Checked by counting: three parts, three
  // attempts, so a fourth part added without one fails here.
  const attempts = fn.match(/\battempt\(/g) ?? [];
  assert.equal(
    attempts.length,
    3,
    `buildBundle has ${attempts.length} attempt() calls for three parts — a part that is ` +
      'not wrapped can still take the whole archive down',
  );
});

test('the readout does not rebuild the archive under a live slider drag', () => {
  // Every warp mesh is a 41x41 grid of rays per projector and `renderReadout`
  // runs on every `touched()`, which includes every pointer move of a drag. The
  // always-visible block therefore had to go through a memo; calling
  // `buildBundle` straight from the readout puts thousands of intersections back
  // on the main thread per repaint.
  assert.ok(MAIN.includes('function bundleForPanel('), 'the panel memo is gone');
  assert.ok(MAIN.includes('sliderDragging'), 'the memo no longer knows about drags');
  // The readout reaches the archive through the memo and not around it. Two
  // call sites are legitimate: the memo itself, and the download click, which
  // must build the real bytes rather than serve a cached manifest.
  // Not followed by `:`, which excludes the declaration's own return type.
  const calls = (MAIN.match(/\bbuildBundle\(\)(?!:)/g) ?? []).length;
  assert.equal(calls, 2, `buildBundle() is called ${calls} times; expected the memo and the download`);
});

test('loading a config repaints the panel that reports whether one is in the archive', () => {
  // `pickSosConfig` used to call `renderInspect` alone, which redraws the
  // projector card the button lives on. The file block lives in the READOUT, so
  // it went on saying no config was loaded while the download quietly included
  // one.
  const at = MAIN.indexOf('function pickSosConfig(');
  assert.ok(at > 0, 'pickSosConfig is gone');
  const fn = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.ok(fn.includes('renderReadout()'), 'a config load no longer repaints the readout');
  assert.ok(fn.includes('sosConfigSeq++'), 'the memo cannot see that a new config was loaded');
});
