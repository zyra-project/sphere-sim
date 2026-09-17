// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The restore point, and the case where offering one would be the bug.
 *
 * Phase 4's done-when is "install a calibration, dislike it, and be back to
 * exactly the previous state in one step", so the property worth testing is not
 * that a restore directory gets written — it is that a restore point covering
 * SOME of what it overwrote is refused rather than offered with caveats.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { bundleEntries } from '../src/bundle.ts';
import { buildZip } from '../src/zip.ts';
import {
  type HeldOriginal,
  type InstallTarget,
  planRestore,
  restoreEntries,
  restoreEntryNames,
  restoreManifest,
} from '../src/restore.ts';

const CONFIG_TEXT = '{\n  "hgt": { "value": 209.0 }\n}\n';
const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);

/** What the page installs today: two warps, two alignments, one config. */
function targets(): InstallTarget[] {
  return [
    { path: 'warp/P1.data', kind: 'warp' },
    { path: 'warp/P3.data', kind: 'warp' },
    { path: 'alignment/P1.alignment', kind: 'alignment' },
    { path: 'alignment/P3.alignment', kind: 'alignment' },
    { path: 'local_sos_config.json', kind: 'config' },
  ];
}

/** Everything, as it would be once the page can be given the current files. */
function everything(): HeldOriginal[] {
  return [
    { path: 'warp/P1.data', bytes: bytes('old P1 warp\n') },
    { path: 'warp/P3.data', bytes: bytes('old P3 warp\n') },
    { path: 'alignment/P1.alignment', bytes: bytes('old P1 alignment\n') },
    { path: 'alignment/P3.alignment', bytes: bytes('old P3 alignment\n') },
    { path: 'local_sos_config.json', bytes: bytes(CONFIG_TEXT) },
  ];
}

test('holding only the config is refused as a restore point, not offered as a partial one', () => {
  // This is the page's real situation today. The config is PATCHED, so the page
  // was handed it and still has every byte; the warps and alignments are
  // GENERATED, so it has never seen what is at those paths.
  const plan = planRestore(targets(), [{ path: 'local_sos_config.json', bytes: bytes(CONFIG_TEXT) }]);

  assert.equal(plan.covered.length, 1);
  assert.equal(plan.uncovered.length, 4);
  assert.equal(plan.complete, false, 'one of five covered is not a restore point');
  assert.ok(plan.refusal !== null);

  // The refusal has to name the shape of the gap, not just its size: an
  // operator needs to know it is their warp meshes and alignment files.
  assert.match(plan.refusal ?? '', /2 Bourke warp-and-blend meshes and 2 SOS projector alignment/);
  // And it has to say why THIS tool cannot cover them, or the reader assumes
  // a bug rather than a boundary.
  assert.match(plan.refusal ?? '', /generated rather than patched/);
  // The sentence the whole module exists for.
  assert.match(plan.refusal ?? '', /worse than none, because it is the one that makes you brave/);
});

test('a complete plan says so without hedging', () => {
  const plan = planRestore(targets(), everything());
  assert.equal(plan.complete, true);
  assert.equal(plan.uncovered.length, 0);
  assert.equal(plan.refusal, null);
  assert.equal(plan.covered.length, 5);
  assert.match(plan.summary, /5 of 5 files/);
});

test('originals travel byte for byte, under a path that says where they go back', () => {
  const plan = planRestore(targets(), everything());
  const entries = restoreEntries(plan);
  const byName = new Map(entries.map((e) => [e.name, e.bytes]));

  // Byte for byte, and checked as bytes: restoring from a re-encoded string
  // would put back a file that is equivalent rather than identical, and
  // "exactly the previous state" is the standard the phase set.
  assert.deepEqual(byName.get('restore/local_sos_config.json'), bytes(CONFIG_TEXT));
  assert.deepEqual(byName.get('restore/warp/P1.data'), bytes('old P1 warp\n'));
  assert.ok(byName.has('restore/MANIFEST.txt'));
  assert.equal(entries.length, 6, 'five originals and the manifest');
});

test('the manifest is written even when the plan is incomplete — especially then', () => {
  const plan = planRestore(targets(), [{ path: 'local_sos_config.json', bytes: bytes(CONFIG_TEXT) }]);
  const entries = restoreEntries(plan);
  const manifest = entries.find((e) => e.name === 'restore/MANIFEST.txt')?.text ?? '';

  // An archive that silently omits the restore directory tells the operator
  // nothing. One that contains a file naming the four it cannot put back is
  // the only version that can prevent the mistake.
  assert.match(manifest, /NOT in this archive/);
  assert.match(manifest, /warp\/P1\.data/);
  assert.match(manifest, /alignment\/P3\.alignment/);
  assert.match(manifest, /Copies in this archive/);
  assert.match(manifest, /restore\/local_sos_config\.json {2}-> {2}local_sos_config\.json/);

  // And the limit of the tool's own knowledge, which is the thing most likely
  // to be read as a prediction if it is not stated. Matched against a
  // whitespace-flattened copy because the manifest hard-wraps to 78 columns,
  // so any sentence worth asserting on is longer than a line.
  const flat = manifest.replace(/\s+/g, ' ');
  assert.match(flat, /it does not know whether those files exist/);
  assert.match(flat, /It is not predicting that you will lose something/);
});

test('an empty install is refused rather than called a complete restore point', () => {
  // Vacuous truth is the trap: nothing uncovered, so `uncovered.length === 0`,
  // so a naive `complete` would be true and the README would promise a way back
  // from an archive that installs nothing.
  const plan = planRestore([], []);
  assert.equal(plan.complete, false);
  assert.match(plan.refusal ?? '', /empty one/);
});

test('an original at a different path does not count as covering a target', () => {
  // Restoring a file to a path it did not come from is how a config lands in
  // the wrong projector's directory, and nothing here could check it guessed
  // right — so a near-match is not a match.
  const plan = planRestore(
    [{ path: 'alignment/P1.alignment', kind: 'alignment' }],
    [{ path: 'alignment/P2.alignment', bytes: bytes('someone else\n') }],
  );
  assert.equal(plan.complete, false);
  assert.equal(plan.covered.length, 0);
  assert.equal(plan.uncovered[0].path, 'alignment/P1.alignment');
});

test('the archive carries the restore directory and the README states the refusal', () => {
  const plan = planRestore(targets(), [{ path: 'local_sos_config.json', bytes: bytes(CONFIG_TEXT) }]);
  const entries = bundleEntries({
    warp: [['P1', 'warp one\n'], ['P3', 'warp three\n']],
    alignment: [['P1', 'align one\n'], ['P3', 'align three\n']],
    config: CONFIG_TEXT,
    configName: 'local_sos_config.json',
    alignmentCost: '',
    rigSummary: '2 projectors.',
    restore: plan,
  });
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('restore/MANIFEST.txt'));
  assert.ok(names.includes('restore/local_sos_config.json'));

  const readme = entries.find((e) => e.name === 'README.txt')?.text ?? '';
  assert.match(readme, /restore\//);
  assert.match(readme, /makes you brave/);
});

test('an archive with no restore plan says so rather than staying quiet', () => {
  const entries = bundleEntries({
    warp: [['P1', 'warp one\n']],
    alignment: [],
    config: null,
    configName: 'local_sos_config.json',
    alignmentCost: '',
    rigSummary: '1 projector.',
  });
  const readme = entries.find((e) => e.name === 'README.txt')?.text ?? '';
  // Silence here reads as "nothing to worry about", which is the one thing it
  // must never read as.
  assert.match(readme, /No restore point was taken/);
  assert.ok(!entries.some((e) => e.name.startsWith('restore/')));
});

test('the manifest wraps to something readable in a terminal', () => {
  // Read in a terminal or Notepad by somebody standing at a projector.
  const text = restoreManifest(planRestore(targets(), everything()));
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line of ${line.length} chars: ${line}`);
  }
});

test('the warning comes before the file lists, not under them', () => {
  // A heading that says to read it first, printed below two file listings, is
  // not read first. This pins the order rather than the wording.
  const text = restoreManifest(
    planRestore(targets(), [{ path: 'local_sos_config.json', bytes: bytes(CONFIG_TEXT) }]),
  );
  const warning = text.indexOf('BEFORE YOU INSTALL');
  const covered = text.indexOf('Copies in this archive');
  const missing = text.indexOf('NOT in this archive');
  assert.ok(warning >= 0 && covered >= 0 && missing >= 0);
  assert.ok(warning < covered, 'the warning must precede the list of what is covered');
  assert.ok(warning < missing, 'and the list of what is not');

  // A complete plan has no warning to lead with, and must not manufacture one.
  const whole = restoreManifest(planRestore(targets(), everything()));
  assert.ok(!whole.includes('BEFORE YOU INSTALL'));
  assert.match(whole, /5 of 5 files/);
});

test('a config with a byte-order mark comes back with its byte-order mark', () => {
  // The defect this interface changed for. `File.text()` is a UTF-8 DECODE: it
  // strips a leading BOM, so a config written by a Windows tool came back three
  // bytes shorter and still valid JSON. A restore copy that differs from the
  // original in a way nobody can see is the exact trap this module argues about.
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(CONFIG_TEXT)]);

  // What the old path did, shown rather than asserted about: decode, re-encode.
  const roundTripped = enc.encode(new TextDecoder().decode(withBom));
  assert.equal(roundTripped.length, withBom.length - 3, 'the decode really does eat the BOM');

  const plan = planRestore(
    [{ path: 'local_sos_config.json', kind: 'config' }],
    [{ path: 'local_sos_config.json', bytes: withBom }],
  );
  const entry = restoreEntries(plan).find((e) => e.name === 'restore/local_sos_config.json');
  assert.ok(entry !== undefined);
  assert.deepEqual(entry.bytes, withBom);

  // And it survives the archive, not just the plan: `buildZip` stores `bytes`
  // verbatim when they are present rather than encoding `text`.
  const zip = buildZip(restoreEntries(plan));
  const haystack = Array.from(zip).join(',');
  assert.ok(haystack.includes(Array.from(withBom).join(',')), 'the BOM is in the archive');
});

test('a config named MANIFEST.txt does not evict the manifest', () => {
  // The picker accepts a config by CONTENT, so a site may call theirs anything.
  // ZIP permits duplicate names and extractors disagree about which wins, so an
  // unresolved collision loses either the operator's config or the file
  // explaining what can be put back. `bundle.ts` already solved this one
  // directory up; this module walked into it one directory down.
  const plan = planRestore(
    [{ path: 'MANIFEST.txt', kind: 'config' }],
    [{ path: 'MANIFEST.txt', bytes: bytes('their config\n') }],
  );
  const entries = restoreEntries(plan);
  const names = entries.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, `duplicate entry names: ${names.join(', ')}`);
  assert.ok(names.includes('restore/MANIFEST.txt'));

  // The suffix goes before the extension, so the file still opens in an editor.
  const moved = restoreEntryNames(plan.covered).get('MANIFEST.txt');
  assert.equal(moved, 'restore/MANIFEST-2.txt');

  // And the manifest points at where the file actually went, rather than at
  // the name it wanted. The two are resolved once, together.
  const manifest = entries.find((e) => e.name === 'restore/MANIFEST.txt')?.text ?? '';
  assert.match(manifest, /restore\/MANIFEST-2\.txt {2}-> {2}MANIFEST\.txt/);
});

test('the refusal does not offer an action the page cannot perform', () => {
  // There is no picker for existing warp or alignment files — docs/OPERATOR-PATH.md
  // says so in this PR's own words. Telling an operator to "load them on the
  // page" is an instruction that cannot be followed, which is the same fault
  // this module exists to argue against, committed inside the argument.
  const plan = planRestore(targets(), [
    { path: 'local_sos_config.json', bytes: bytes(CONFIG_TEXT) },
  ]);
  assert.ok(!/load (it|them) on the page/.test(plan.refusal ?? ''));
  assert.match(plan.refusal ?? '', /Load them on this page and a copy travels in the archive/);
});
