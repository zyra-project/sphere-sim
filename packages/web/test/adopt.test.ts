// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Taking the operator's existing files in, and what it refuses to assume.
 *
 * The module's whole risk is the name→path step, because `restore.ts` is
 * emphatic that "a near-match is not a match" and a file put back at a path it
 * did not come from is worse than no restore point at all. So the tests here
 * are mostly about the cases where the mapping is NOT determined, and about the
 * one claim the module rests on — that the target basenames are distinct — being
 * checked rather than asserted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { adoptOriginals, wanted, type PickedFile } from '../src/adopt.ts';
import { planRestore, type InstallTarget } from '../src/restore.ts';

/** The five files a four-projector install writes, as `buildBundle` lists them. */
const TARGETS: InstallTarget[] = [
  { path: 'warp/P1.data', kind: 'warp' },
  { path: 'warp/P2.data', kind: 'warp' },
  { path: 'alignment/P1.alignment', kind: 'alignment' },
  { path: 'alignment/P2.alignment', kind: 'alignment' },
  { path: 'local_sos_config.json', kind: 'config' },
];

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const pick = (name: string, body = name): PickedFile => ({ name, bytes: bytes(body) });

test('the targets this page generates have distinct basenames, which is what makes the match determined', () => {
  // The module's central claim, tested rather than trusted. `warp/<id>.data`
  // and `alignment/<id>.alignment` differ by extension, and two projectors
  // cannot share an id — so a basename picks out at most one target. If that
  // ever stops being true, `adoptOriginals` refuses rather than guessing, and
  // this test is what says the refusal path is the unusual one.
  const names = TARGETS.map((t) => t.path.slice(t.path.lastIndexOf('/') + 1));
  assert.equal(new Set(names).size, names.length, `basenames collide: ${names.join(', ')}`);
});

test('a picked file is taken as the one target it names, and reported as such', () => {
  const result = adoptOriginals(TARGETS, [pick('P1.data'), pick('P2.alignment')]);

  assert.deepEqual(
    result.held.map((h) => h.path),
    ['warp/P1.data', 'alignment/P2.alignment'],
  );
  assert.deepEqual(
    result.adoptions.map((a) => [a.name, a.path]),
    [
      ['P1.data', 'warp/P1.data'],
      ['P2.alignment', 'alignment/P2.alignment'],
    ],
  );
  assert.ok(result.adoptions.every((a) => a.problem === ''));
});

test('the bytes survive into the plan, which is the only thing that makes this worth doing', () => {
  // Adopting is only useful if `planRestore` then covers the target with the
  // ORIGINAL bytes. A version that recorded the path and dropped the content
  // would produce a plan that claims a cover it cannot honour.
  const original = bytes('the mesh that was there before\n');
  const result = adoptOriginals(TARGETS, [{ name: 'P1.data', bytes: original }]);
  const plan = planRestore(TARGETS, result.held);

  const covered = plan.covered.find((c) => c.path === 'warp/P1.data');
  assert.ok(covered !== undefined, 'the adopted target should be covered');
  assert.deepEqual([...covered.bytes], [...original], 'byte for byte, not a re-encoding');
});

test('a file naming nothing the archive installs is refused and named', () => {
  const result = adoptOriginals(TARGETS, [pick('holiday.jpg'), pick('P1.data')]);

  assert.equal(result.held.length, 1, 'only the one that matched');
  const refused = result.adoptions.find((a) => a.name === 'holiday.jpg');
  assert.equal(refused?.path, null);
  assert.match(refused?.problem ?? '', /holiday\.jpg/, 'the refusal names the file');
});

test('a name matching two targets is refused rather than taking the first', () => {
  // Not reachable through the page's own target list, which is why it is
  // constructed here: the check exists so that if the naming convention ever
  // changes, an operator is told instead of handed a file in the wrong place.
  const ambiguous: InstallTarget[] = [
    { path: 'warp/P1.data', kind: 'warp' },
    { path: 'backup/P1.data', kind: 'warp' },
  ];
  const result = adoptOriginals(ambiguous, [pick('P1.data')]);

  assert.equal(result.held.length, 0, 'neither may be taken');
  assert.match(result.adoptions[0]?.problem ?? '', /warp\/P1\.data or backup\/P1\.data/);
  assert.equal(result.stillUncovered.length, 2, 'both are still uncovered');
});

test('a path already held is not overwritten by a picked file', () => {
  // The config arrives through its own picker because its bytes are what get
  // PATCHED. A second original for the same path is a disagreement this page
  // cannot settle, so it keeps the one it is actually using.
  const configBytes = bytes('{"real":true}');
  const result = adoptOriginals(TARGETS, [pick('local_sos_config.json', '{"other":true}')], [
    { path: 'local_sos_config.json', bytes: configBytes },
  ]);

  assert.equal(result.held.length, 0, 'the picked config must not be taken');
  assert.match(result.adoptions[0]?.problem ?? '', /already has an original/);

  // And the plan still covers it — from the config picker's bytes.
  const plan = planRestore(TARGETS, [{ path: 'local_sos_config.json', bytes: configBytes }, ...result.held]);
  const covered = plan.covered.find((c) => c.path === 'local_sos_config.json');
  assert.deepEqual([...(covered?.bytes ?? [])], [...configBytes]);
});

test('the same path offered twice keeps the first and says so', () => {
  const result = adoptOriginals(TARGETS, [pick('P1.data', 'first'), pick('P1.data', 'second')]);

  assert.equal(result.held.length, 1);
  assert.deepEqual([...(result.held[0]?.bytes ?? [])], [...bytes('first')]);
  assert.match(result.adoptions[1]?.problem ?? '', /was already given an original/);
});

test('what is still missing is reported by the path the operator has to find', () => {
  const result = adoptOriginals(TARGETS, [pick('P1.data')]);

  assert.deepEqual(wanted(result.stillUncovered), [
    'warp/P2.data',
    'alignment/P1.alignment',
    'alignment/P2.alignment',
    'local_sos_config.json',
  ]);
  assert.match(result.summary, /1 of 5/);
  assert.match(result.summary, /Still missing/);
});

test('covering everything turns the refusal into a green light, which is the point of this work', () => {
  // Phase 4's own words: "today the refusal always fires, because the page is
  // never given the files it would overwrite". This is the test that says it no
  // longer always fires — and it goes through `planRestore` rather than
  // asserting on `adoptOriginals`' own summary, because the refusal belongs to
  // the plan and that is what the archive carries.
  const everything = adoptOriginals(
    TARGETS,
    [pick('P1.data'), pick('P2.data'), pick('P1.alignment'), pick('P2.alignment')],
    [{ path: 'local_sos_config.json', bytes: bytes('{}') }],
  );
  assert.deepEqual(everything.stillUncovered, []);

  const plan = planRestore(TARGETS, [
    { path: 'local_sos_config.json', bytes: bytes('{}') },
    ...everything.held,
  ]);
  assert.equal(plan.complete, true, 'every target covered');
  assert.equal(plan.refusal, null, 'and so no refusal');
  assert.equal(plan.uncovered.length, 0);
  assert.match(everything.summary, /Installing is reversible/);
});

test('an empty pick changes nothing and does not claim to', () => {
  const result = adoptOriginals(TARGETS, []);
  assert.deepEqual(result.held, []);
  assert.deepEqual(result.adoptions, []);
  assert.equal(result.stillUncovered.length, TARGETS.length);
  assert.match(result.summary, /0 of 5/);
});

test('no targets at all is stated rather than divided by zero', () => {
  const result = adoptOriginals([], [pick('P1.data')]);
  assert.match(result.summary, /writes no files/);
  assert.equal(result.held.length, 0);
});
