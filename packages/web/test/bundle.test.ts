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
 *
 * `layout.json` has a different property to keep: it must say where each mesh
 * goes from the rig the meshes were built from, and never from a projector's
 * name. So its tests build real rigs — the page's own, one with a projector
 * switched off, and placed ones — and pin the viewports against the numbers
 * the rig describes rather than against the builder's own arithmetic.
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
  LAYOUT_ABSENT,
  projectorLayout,
} from '../src/bundle.ts';
import type { BundleInput, ProjectorLayout } from '../src/bundle.ts';
import { buildWorld } from '../src/rigs.ts';
import { BOULDER_PRESET } from '../src/settings.ts';
import type { Settings } from '../src/settings.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { meshSurface } from '../../sim/src/mesh/surface.ts';
import { placedRig } from '../../sim/src/placement.ts';
import { nominalRig, SOS_QUADRANT_VIEWPORTS } from '../../sim/src/scene.ts';
import { buildWarpExports, formatWarpMesh, warpTexture } from '../../sim/src/warp.ts';
import type { WarpTexture } from '../../sim/src/warp.ts';
import { uvSphere } from '../../harness/src/fixtures.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, '../web/main.ts'), 'utf8');

/** The rig as PARAMETERS.md describes it: four projectors, SOS's quadrants. */
const SOS_RIG = nominalRig();
const ON_THE_SPHERE: WarpTexture = { surface: 'sphere', rotationOffsetDeg: 0 };

const INPUT = (over: Partial<BundleInput> = {}): BundleInput => {
  const warp = over.warp ?? [
    ['P1', 'warp one\n'],
    ['P2', 'warp two\n'],
  ];
  return {
    warp,
    // Built the way `buildBundle` builds it — from the ids of `warp` itself — so
    // a test that overrides the meshes carries the layout with it rather than
    // handing the archive a layout for meshes it does not hold.
    layout: projectorLayout(SOS_RIG, ON_THE_SPHERE, warp.map(([id]) => id)),
    alignment: [
      ['P1', 'align one\n'],
      ['P2', 'align two\n'],
    ],
    config: '{\n  "radius": 0.8128\n}\n',
    configName: 'local_sos_config.json',
    alignmentCost: 'Worst of them, P2: nine points left 0.25 px of a 55.0 px correction.',
    rigSummary: '2 projectors, as last recalibrated.',
    ...over,
  };
};

/**
 * What `buildBundle` hands `bundleEntries` for these settings, on the sphere:
 * the believed rig prepared as `displayModel(world, 'install')` prepares it,
 * its meshes, and the layout from those meshes' own ids and that same rig.
 *
 * Two nodes a side, because the layout reads the meshes' ids and not their
 * nodes, and a 41x41 trace per projector would only make this slower.
 */
function pageArchive(settings: Settings): { warp: [string, string][]; layout: ProjectorLayout | null } {
  const content = prepareRig(buildWorld(settings).compositorRig);
  const warp = buildWarpExports(content, { cols: 2, rows: 2 }).map(
    (e): [string, string] => [e.projectorId, formatWarpMesh(e)],
  );
  const layout = projectorLayout(content.rig, warpTexture(content), warp.map(([id]) => id));
  return { warp, layout };
}

/** Boulder with P2 switched off at the wall. */
const P2_DARK: Settings = {
  ...BOULDER_PRESET,
  nudge: BOULDER_PRESET.nudge.map((n, i) => (i === 1 ? { ...n, on: false } : { ...n })),
};

/** The `layout.json` an archive actually carries, parsed as a reader would. */
function layoutIn(input: BundleInput): Record<string, unknown> | null {
  const entry = bundleEntries(input).find((e) => e.name === 'layout.json');
  return entry === undefined ? null : (JSON.parse(entry.text) as Record<string, unknown>);
}

test('the README quotes the notes rather than restating them', () => {
  // If this fails because somebody edited the README wording directly, the fix
  // is to edit `FILE_NOTES` — the panel and the file have to say one thing.
  const readme = bundleReadme(INPUT());
  for (const note of [FILE_NOTES.warp, FILE_NOTES.layout, FILE_NOTES.alignment, FILE_NOTES.config]) {
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
  for (const note of [FILE_NOTES.warp, FILE_NOTES.layout, FILE_NOTES.alignment, FILE_NOTES.config]) {
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
    'layout.json',
    'warp/P1.data',
    'warp/P2.data',
    'alignment/P1.alignment',
    'alignment/P2.alignment',
    'local_sos_config.json',
  ]);

  const without = bundleEntries(INPUT({ config: null }));
  // Any `.json` but the layout, which the archive writes whether or not a config
  // was loaded: "ends in .json" stopped meaning "a config" the day it arrived.
  assert.ok(
    !without.some((e) => e.name.endsWith('.json') && e.name !== 'layout.json'),
    'a config appeared from nowhere',
  );
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
  for (const call of ['buildWarpExports', 'projectorLayout', 'buildSosAlignments', 'formatSosConfig']) {
    assert.ok(fn.includes(call), `buildBundle no longer calls ${call}`);
  }
  // Each of the four sits inside an `attempt(...)`, which is what records a
  // refusal instead of propagating it. Checked by counting: four parts, four
  // attempts, so a fifth part added without one fails here. The fourth was
  // `layout.json`, which arrived after this test and was held to it:
  // `projectorLayout` refuses a mesh the rig does not hold, and that refusal
  // must not take the alignment files and the config down with it.
  const attempts = fn.match(/\battempt\(/g) ?? [];
  assert.equal(
    attempts.length,
    4,
    `buildBundle has ${attempts.length} attempt() calls for four parts — a part that is ` +
      'not wrapped can still take the whole archive down',
  );
});

test('the page lays the meshes out from the rig they were traced on, by their own ids', () => {
  // `buildBundle` is a DOM script's function and cannot be called here, so the
  // one expression that decides what the layout describes is pinned from the
  // source. Two choices in it are each invisible in the output when wrong:
  //
  //   - `model.content`, the rig the meshes were traced on. `model.physical` is
  //     the truth rig — the one no real dome has — and `world.compositorRig`
  //     without the display model skips the surface the meshes were built on,
  //     so `warpTexture` would call a dropped model a sphere.
  //   - `warp.map(...)`: the ids of the meshes the archive holds, in its order.
  //     The rig's own projector list would still list its projectors after the
  //     meshes had been refused.
  const body = MAIN.slice(MAIN.indexOf('function buildBundle('));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.match(
    fn,
    /projectorLayout\(\s*model\.content\.rig,\s*warpTexture\(model\.content\),\s*warp\.map\(\(\[id\]\) => id\),?\s*\)/,
    'buildBundle no longer builds the layout from model.content and the ids of warp',
  );
  // And it reaches the archive, rather than being built and dropped.
  assert.match(fn, /bundleEntries\(\{[^}]*\blayout,/, 'the layout is built but not handed to bundleEntries');
});

// ---------------------------------------------------------------------------
// layout.json: where each mesh goes
// ---------------------------------------------------------------------------

test('the page’s own rig lays its meshes out in SOS’s four quadrants', () => {
  // The viewports are PARAMETERS.md §3.4's `projectorInfo(viewport)` string,
  // `{ 0,0,0.5,0.5  0.5,0,0.5,0.5  0,0.5,0.5,0.5  0.5,0.5,0.5,0.5 }`, typed
  // out here in the config's own order rather than read from
  // `SOS_QUADRANT_VIEWPORTS`, so the layout is checked against the spec and not
  // against the table it was built from. Boulder's projectors are LK935s at
  // 3840x2160 each, so the X screen they span is 7680x4320.
  const { layout } = pageArchive(BOULDER_PRESET);
  assert.deepEqual(layout, {
    format: 'sphere-sim/projector-layout@1',
    origin: 'bottom-left',
    framebuffer: { width: 7680, height: 4320 },
    surface: 'sphere',
    rotationOffsetDeg: 0,
    projectors: [
      { id: 'P1', mesh: 'warp/P1.data', viewport: { x: 0, y: 0, w: 0.5, h: 0.5 } },
      { id: 'P2', mesh: 'warp/P2.data', viewport: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
      { id: 'P3', mesh: 'warp/P3.data', viewport: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
      { id: 'P4', mesh: 'warp/P4.data', viewport: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
    ],
  });
});

test('a projector switched off at the wall is not listed, and the rest keep their quadrants', () => {
  // The case a layout by POSITION gets wrong. With P2 dark the rig holds three
  // projectors, and the second of them is P3 — whose quadrant is the top-left,
  // not the bottom-right that index 1 would give it. §2's "quadrants go dark":
  // P2's quadrant is simply unlit, and the framebuffer does not shrink.
  const { warp, layout } = pageArchive(P2_DARK);
  assert.deepEqual(warp.map(([id]) => id), ['P1', 'P3', 'P4']);
  assert.ok(layout !== null);
  assert.deepEqual(layout.framebuffer, { width: 7680, height: 4320 });
  assert.deepEqual(layout.projectors, [
    { id: 'P1', mesh: 'warp/P1.data', viewport: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    { id: 'P3', mesh: 'warp/P3.data', viewport: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
    { id: 'P4', mesh: 'warp/P4.data', viewport: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
  ]);
});

test('the layout lists the meshes the archive carries, not every projector the rig holds', () => {
  // A layout is a statement about THIS archive. A projector with no mesh in it
  // has nothing to place, and listing it anyway sends a reader looking for a
  // file that is not there. So the set is the meshes', and so is the order.
  const layout = projectorLayout(SOS_RIG, ON_THE_SPHERE, ['P4', 'P1']);
  assert.ok(layout !== null);
  assert.deepEqual(
    layout.projectors.map((p) => [p.id, p.mesh]),
    [
      ['P4', 'warp/P4.data'],
      ['P1', 'warp/P1.data'],
    ],
  );
  // And with no meshes at all there is no layout: it would be a file a reader
  // has to open to learn that it says nothing.
  assert.equal(projectorLayout(SOS_RIG, ON_THE_SPHERE, []), null);
});

test('a placed rig carries its own viewports: two are halves, and a lone P1 is the whole frame', () => {
  // Why the id fallback had to go (terraviz's Rung 16). `placedRig` names
  // projectors P1…Pn in placement order and lays them out with `gridViewports`,
  // so the same names land in different places: SOS's P1 is a quadrant, and
  // these are not. A reader that paired by name would draw each mesh into a
  // quarter of the part it drives, and the picture would still be a picture.
  const at = (x: number): { position: { x: number; y: number; z: number } } => ({
    position: { x, y: 0, z: 0 },
  });
  const onAModel: WarpTexture = { surface: 'mesh', rotationOffsetDeg: null };

  const pair = placedRig({ projectors: [at(5), at(-5)], resX: 1920, resY: 1080 });
  const two = projectorLayout(pair, onAModel, ['P1', 'P2']);
  assert.ok(two !== null);
  assert.deepEqual(two.framebuffer, { width: 3840, height: 1080 });
  assert.deepEqual(two.projectors, [
    { id: 'P1', mesh: 'warp/P1.data', viewport: { x: 0, y: 0, w: 0.5, h: 1 } },
    { id: 'P2', mesh: 'warp/P2.data', viewport: { x: 0.5, y: 0, w: 0.5, h: 1 } },
  ]);

  const lone = projectorLayout(placedRig({ projectors: [at(5)], resX: 1920, resY: 1080 }), onAModel, [
    'P1',
  ]);
  assert.ok(lone !== null);
  assert.deepEqual(lone.framebuffer, { width: 1920, height: 1080 });
  assert.deepEqual(lone.projectors, [
    { id: 'P1', mesh: 'warp/P1.data', viewport: { x: 0, y: 0, w: 1, h: 1 } },
  ]);

  // The same names, different places — which is the whole argument, asserted.
  assert.notDeepEqual(two.projectors[1].viewport, SOS_QUADRANT_VIEWPORTS[1]);
  assert.notDeepEqual(lone.projectors[0].viewport, SOS_QUADRANT_VIEWPORTS[0]);
});

test('every mesh the layout names is an entry of the archive, in the order warp/ lists them', () => {
  // The reader follows `mesh` to open the file, so a path the archive does not
  // hold is a layout pointing at nothing — and one spelled differently from the
  // entry is the same failure with a plausible name.
  for (const settings of [BOULDER_PRESET, P2_DARK]) {
    const { warp, layout } = pageArchive(settings);
    const input = INPUT({ warp, layout });
    const names = bundleEntries(input).map((e) => e.name);
    const read = layoutIn(input);
    assert.ok(read !== null, 'the archive carries meshes and no layout.json');
    const meshes = (read.projectors as { mesh: string }[]).map((p) => p.mesh);
    for (const mesh of meshes) assert.ok(names.includes(mesh), `${mesh} is not in the archive`);
    assert.deepEqual(
      meshes,
      names.filter((n) => n.startsWith('warp/')),
      'the layout and warp/ disagree about which meshes there are, or their order',
    );
  }
});

test('the format and the origin are exactly the strings a reader checks for', () => {
  // Literals here, not the exported constant: a reader outside this repository
  // compares against the text, so a changed constant must fail this rather than
  // be compared with itself. `origin` is stated because it is the field most
  // likely to be read backwards.
  const read = layoutIn(INPUT());
  assert.ok(read !== null);
  assert.equal(read.format, 'sphere-sim/projector-layout@1');
  assert.equal(read.origin, 'bottom-left');
  // The framebuffer is in pixels and the viewport in fractions of it, as the
  // calibration holds them — not the viewport already multiplied out.
  assert.deepEqual(read.framebuffer, { width: 3840, height: 2160 });
  assert.deepEqual((read.projectors as { viewport: unknown }[])[1].viewport, {
    x: 0.5,
    y: 0,
    w: 0.5,
    h: 0.5,
  });
});

test('the layout states the rotation baked into the meshes, and null on a model', () => {
  // 37 degrees, not the page's 0: a layout that wrote 0 regardless would pass at
  // the only rotation the page has. `warpTexture` is what `buildWarpExport`
  // bakes from, and `packages/sim/test/warp.test.ts` checks the bake moves `u`
  // by exactly this; here the layout has to say the same number.
  const turned = nominalRig({ rotationOffsetDeg: 37 });
  const sphere = prepareRig(turned);
  const onSphere = layoutIn(
    INPUT({ layout: projectorLayout(sphere.rig, warpTexture(sphere), ['P1', 'P2']) }),
  );
  assert.ok(onSphere !== null);
  assert.equal(onSphere.surface, 'sphere');
  assert.equal(onSphere.rotationOffsetDeg, 37);

  // The SAME rig on a model: its UV has no rotation to apply, so the field is
  // null — and null in the file, not left out, so a reader can tell "no
  // rotation exists" from "this writer predates the field".
  const model = prepareRig(turned, meshSurface(uvSphere(24, 12, turned.sphere.radiusM)));
  const onModel = layoutIn(
    INPUT({ layout: projectorLayout(model.rig, warpTexture(model), ['P1', 'P2']) }),
  );
  assert.ok(onModel !== null);
  assert.equal(onModel.surface, 'mesh');
  assert.ok('rotationOffsetDeg' in onModel, 'the rotation was left out rather than written as null');
  assert.equal(onModel.rotationOffsetDeg, null);
});

test('layout.json is in the archive only beside meshes, and says why when not', () => {
  const withMeshes = INPUT();
  assert.ok(bundleEntries(withMeshes).some((e) => e.name === 'layout.json'));
  assert.ok(bundleReadme(withMeshes).includes('  layout.json'), 'the README does not list it');

  // The meshes refused, as a model with no UV set refuses them: no meshes, so
  // nothing to place, and the README says what to do INSTEAD — which is not to
  // fall back on the names.
  const without = INPUT({ warp: [], refused: ['the warp meshes: no UV set'] });
  assert.ok(!bundleEntries(without).some((e) => e.name === 'layout.json'));
  const readme = bundleReadme(without).replace(/\s+/g, ' ');
  assert.ok(readme.includes(LAYOUT_ABSENT.replace(/\s+/g, ' ')), 'the absence is not explained');
  assert.ok(!readme.includes(FILE_NOTES.layout.readme.replace(/\s+/g, ' ')));
});

test('a config named layout.json does not overwrite the layout', () => {
  // The picker takes a config by CONTENT, so a site may call theirs anything —
  // including the one name this archive now writes beside the README. The
  // README.txt case below is the same hazard; this one exists because the
  // layout is written BEFORE the config, which is what lets `configEntryName`
  // see it and move the config aside.
  const clash = bundleEntries(INPUT({ configName: 'layout.json' }));
  const names = clash.map((e) => e.name);
  assert.equal(
    new Set(names.map((n) => n.toLowerCase())).size,
    names.length,
    `the archive has two entries with one name: ${names.join(', ')}`,
  );
  assert.ok(names.includes('config/layout.json'), names.join(', '));
  const layout = clash.find((e) => e.name === 'layout.json');
  assert.ok(layout !== undefined);
  assert.equal(
    (JSON.parse(layout.text) as { format: string }).format,
    'sphere-sim/projector-layout@1',
    'layout.json is the config, not the layout',
  );
});

test('a mesh the rig does not hold, or a name two projectors share, is refused', () => {
  // Both mean the meshes and the rig disagree about which projectors exist, and
  // a layout that picked an answer would be the silent misplacement it exists
  // to end. `buildBundle` catches the refusal like any other part's.
  assert.throws(
    () => projectorLayout(SOS_RIG, ON_THE_SPHERE, ['P1', 'P5']),
    /warp\/P5\.data has no projector P5/,
  );
  const twins = {
    framebuffer: SOS_RIG.framebuffer,
    projectors: [
      { id: 'P1', viewport: SOS_QUADRANT_VIEWPORTS[0] },
      { id: 'P1', viewport: SOS_QUADRANT_VIEWPORTS[1] },
    ],
  };
  assert.throws(() => projectorLayout(twins, ON_THE_SPHERE, ['P1']), /the name P1 is given twice/);
  assert.throws(
    () => projectorLayout(SOS_RIG, ON_THE_SPHERE, ['P1', 'P1']),
    /the name P1 is given twice/,
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
