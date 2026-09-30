// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * I-replaced's comparison, `tools/experiment10-replaced.ts`.
 *
 * The tool holds the reader the page replaced, as EXPERIMENT-10's fourth run
 * kept it in Q0, to the third run's committed results file (754147f), field for
 * field. Run by hand it reads that file and that commit's `describeIndexing`
 * from git, which a shallow clone may lack, so here the reference is built from
 * the committed document's own replaced reader, in 754147f's shape, with the
 * description written by a stand-in. What is tested is that the comparison
 * passes only when every field of every position agrees, at each of the 108
 * positions and each listed once, and fails, naming the field and showing where
 * it parts, when any one does not. Because that reference is read off the
 * same document, the replaced reader is also held to values it is known to
 * have there, beside the page's, and read from a Q0 checkpoint's shape; and the
 * command line exits 2, not 1, when a file or the commit is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  FIELDS,
  POSITIONS,
  compareReplaced,
  firstDifference,
  main,
  parseArgs,
  referenceOf,
  replacedOf,
  report,
  type ReferencePosition,
  type ReplacedPosition,
} from '../../../tools/experiment10-replaced.ts';
import { RERUN_IDENTITIES } from '../../experiments/src/straddle/design.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const RESULTS = path.join(REPO, 'experiments', 'experiment-10.json');

/** A stand-in for 754147f's `describeIndexing`: any function of the verdict will do. */
const describe = (p: ReplacedPosition): string => `${p.total} handed in; ${p.placed} placed into [${p.runsPlaced}]`;

/** The document's replaced reader, as 754147f's document would record it. */
function referenceFrom(ours: readonly ReplacedPosition[]): ReferencePosition[] {
  return ours.map((p) => ({
    which: p.which,
    rig: p.rig,
    camera: p.camera,
    total: p.total,
    margin: p.margin,
    wrongKinds: p.wrongKinds,
    perRun: p.perRun.map((r) => ({ ...r })),
    placed: p.placed,
    runsPlaced: [...p.runsPlaced],
    problems: [...p.problems],
    description: describe(p),
  }));
}

test("the replaced reader is read from where the document keeps it, not the page's reader beside it", () => {
  // The reference below is built from what replacedOf reads, so a replacedOf
  // that read the wrong reader would agree with itself there. Here it is held
  // to what the committed document records at one position: the reader the
  // page replaced placed nothing and refused at classify, where the page's own
  // reader placed 102 photographs.
  const doc = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  const ours = replacedOf(doc, 'experiment-10.json');
  assert.equal(ours.length, POSITIONS);
  const first = ours.find((p) => p.which === 'main' && p.rig === 0 && p.camera === 0);
  assert.ok(first !== undefined, 'main rig 0 camera 0 is not in the document');
  assert.deepEqual([first.placed, first.runsPlaced, first.ok], [0, [], false]);
  assert.ok(first.problems[0]?.startsWith('The white and black frames'), first.problems.join(' | '));
  const kept = doc.precondition.q0.positions.find(
    (p: { which: string; rig: number; camera: number }) => p.which === 'main' && p.rig === 0 && p.camera === 0,
  );
  assert.equal(kept.page.placed, 102, "the page's reader no longer placed 102 there, so this pins nothing");
  assert.deepEqual([first.total, first.margin, first.wrongKinds], [136, 0.0005, 77]);
  assert.deepEqual(first.perRun, [
    { margin: 0.0881, wrongKinds: 6 },
    { margin: 0.0428, wrongKinds: 6 },
    { margin: 0.0556, wrongKinds: 10 },
    { margin: 0, wrongKinds: 33 },
  ]);
  // The identity is held at the positions its registered text names.
  const identity = RERUN_IDENTITIES.find((x) => x.id === 'I-replaced');
  assert.match(identity?.holds ?? '', new RegExp(`at each of the ${POSITIONS} positions`));

  // The Q0 checkpoint keeps each position's reading unrounded, grouped by
  // unit, with the page's fields at the top; replacedOf reads the replaced
  // reader there too, rounding the margins as the assembly does.
  const unrounded = (x: number): number => x + 0.0000123;
  const units: Record<string, { positions: unknown[] }> = {};
  for (const p of doc.precondition.q0.positions) {
    const unit = `${p.which}:${p.rig}`;
    units[unit] ??= { positions: [] };
    units[unit].positions.push({
      ...p.page,
      which: p.which,
      rig: p.rig,
      camera: p.camera,
      total: p.total,
      margin: unrounded(p.margin),
      wrongKinds: p.wrongKinds,
      perRun: p.perRun.map((r: { margin: number; wrongKinds: number }, projector: number) => ({
        projector,
        margin: unrounded(r.margin),
        wrongKinds: r.wrongKinds,
      })),
      replaced: p.replaced,
    });
  }
  const checkpoint = { schema: 'sphere-sim/experiment-10-checkpoint@3', stage: 'q0', units, complete: true };
  const fromCheckpoint = replacedOf(checkpoint, 'q0.json');
  const key = (p: ReplacedPosition): string => `${p.which} ${p.rig} ${p.camera}`;
  assert.deepEqual(
    [...fromCheckpoint].sort((a, b) => key(a).localeCompare(key(b))),
    [...ours].sort((a, b) => key(a).localeCompare(key(b))),
  );
  assert.equal(compareReplaced(fromCheckpoint, referenceFrom(ours), describe).holds, true);
  // A checkpoint whose position has no replaced reader is refused, not compared.
  const unit0 = Object.keys(units)[0];
  const bare = structuredClone(checkpoint);
  delete (bare.units[unit0].positions[0] as { replaced?: unknown }).replaced;
  assert.throws(() => replacedOf(bare, 'q0.json'), /q0\.json: unit 0 position 0's replaced reader is not an object/);
});

test("I-replaced holds where the reference is the replaced reader's own record, and fails on any one field", () => {
  const ours = replacedOf(JSON.parse(fs.readFileSync(RESULTS, 'utf8')), 'experiment-10.json');
  assert.ok(ours.length > 0, 'the committed document keeps no replaced reader');
  const held = compareReplaced(ours, referenceFrom(ours), describe);
  assert.equal(held.holds, true, report(held, 'ours', 'theirs').join('\n'));
  assert.equal(held.compared, ours.length);
  assert.equal(held.compared, POSITIONS);
  assert.match(report(held, 'ours', 'theirs')[0], /^I-replaced: 108 positions compared of the 108 it is held at \(108 listed in ours, 108 in theirs\)$/);
  assert.match(report(held, 'ours', 'theirs').at(-1) ?? '', /^I-replaced HOLDS$/);

  // One field of one position moved, each in turn: the comparison fails, and
  // names that field and no other.
  const moves: Record<(typeof FIELDS)[number], (p: ReferencePosition) => void> = {
    placed: (p) => { p.placed += 1; },
    runsPlaced: (p) => { p.runsPlaced = [...p.runsPlaced, 9]; },
    problems: (p) => { p.problems = [...p.problems, 'No projector run could be found in the 136 photographs.']; },
    reasons: (p) => { p.problems = [...p.problems, 'No projector run could be found in the 136 photographs.']; },
    description: (p) => { p.description = `${p.description} `; },
    total: (p) => { p.total += 1; },
    margin: (p) => { p.margin = (p.margin ?? 0) + 0.0001; },
    wrongKinds: (p) => { p.wrongKinds += 1; },
    perRun: (p) => { p.perRun = p.perRun.map((r, i) => (i === 0 ? { ...r, wrongKinds: r.wrongKinds + 1 } : r)); },
  };
  for (const field of FIELDS) {
    const theirs = referenceFrom(ours);
    moves[field](theirs[1]);
    const c = compareReplaced(ours, theirs, describe);
    assert.equal(c.holds, false, `${field} moved and I-replaced still held`);
    // A reason is read off its problem, so a problem added moves both; any other field moves alone.
    const expected = field === 'problems' || field === 'reasons' ? ['problems', 'reasons'] : [field];
    assert.deepEqual(
      FIELDS.filter((f) => c.differ[f].length > 0),
      expected,
      `${field} moved: ${JSON.stringify(c.differ)}`,
    );
    assert.equal(c.differ[field].length, 1, 'one position moved, and not one was named');
    assert.match(report(c, 'ours', 'theirs').at(-1) ?? '', /^I-replaced DOES NOT HOLD$/);
  }
  // A per-run margin moves perRun too, at the four decimals the file holds.
  const marginMoved = referenceFrom(ours);
  marginMoved[1].perRun = marginMoved[1].perRun.map((r, i) => (i === 2 ? { ...r, margin: (r.margin ?? 0) + 0.0001 } : r));
  const byMargin = compareReplaced(ours, marginMoved, describe);
  assert.deepEqual([byMargin.holds, FIELDS.filter((f) => byMargin.differ[f].length > 0)], [false, ['perRun']]);

  // A field that differs is shown from where the two sides part, so a long
  // value that differs late shows the difference and not its opening twice.
  const late = referenceFrom(ours);
  late[1].description = `${late[1].description}${'x'.repeat(200)}`;
  const lateDiff = compareReplaced(ours, late, describe).differ.description[0];
  assert.match(lateDiff, /x/, lateDiff);
  const longA = { text: `${'a'.repeat(300)}-then-this` };
  const longB = { text: `${'a'.repeat(300)}-then-that` };
  const [a, b] = firstDifference(longA, longB);
  assert.ok(a.includes('-then-this') && b.includes('-then-that') && a.startsWith('…'), `${a} | ${b}`);
  assert.deepEqual(firstDifference([1, 2], [1, 3]), ['[1,2]', '[1,3]'], 'a short value is shown whole');

  // A position on one side only fails, and so does a comparison of none.
  const missing = referenceFrom(ours).slice(1);
  const one = compareReplaced(ours, missing, describe);
  assert.deepEqual([one.holds, one.onlyNew.length, one.onlyReference.length], [false, 1, 0]);
  const extra = compareReplaced(ours.slice(1), referenceFrom(ours), describe);
  assert.deepEqual([extra.holds, extra.onlyNew.length, extra.onlyReference.length], [false, 0, 1]);
  assert.equal(compareReplaced([], [], describe).holds, false, 'a comparison of nothing held');

  // A position listed twice fails on either side, whatever its copies say:
  // keyed alone, the later copy would stand for both, and one whose verdict
  // disagrees with the reference could pass. Each side is counted as listed.
  for (const [side, twice] of [
    ['new', compareReplaced([...ours, { ...ours[1], placed: 5 }], referenceFrom(ours), describe)],
    ['new, the copy agreeing', compareReplaced([...ours, ours[1]], referenceFrom(ours), describe)],
    ['reference', compareReplaced(ours, [...referenceFrom(ours), referenceFrom(ours)[1]], describe)],
  ] as const) {
    assert.equal(twice.holds, false, `a position listed twice in the ${side} file held`);
    assert.equal(twice.compared, POSITIONS, side);
    const lines = report(twice, 'ours', 'theirs');
    assert.match(lines.at(-1) ?? '', /^I-replaced DOES NOT HOLD$/);
    assert.ok(lines.some((x) => /listed twice or more in the (new file|reference): 1 \(main rig 0 camera 1 \(2 times\)\)/.test(x)), lines.join('\n'));
  }
  const listedTwice = compareReplaced([...ours, ours[1]], referenceFrom(ours), describe);
  assert.deepEqual([listedTwice.ours, listedTwice.theirs, listedTwice.duplicatedNew, listedTwice.duplicatedReference], [POSITIONS + 1, POSITIONS, ['main rig 0 camera 1 (2 times)'], []]);
  assert.match(report(listedTwice, 'ours', 'theirs')[0], /\(109 listed in ours, 108 in theirs\)/);

  // Every position agreeing is not enough: the identity is held at 108, so
  // a comparison of fewer, on both sides alike, does not hold it.
  const fewer = compareReplaced(ours.slice(1), referenceFrom(ours).slice(1), describe);
  assert.deepEqual([fewer.holds, fewer.compared, fewer.onlyNew, fewer.onlyReference], [false, POSITIONS - 1, [], []]);
  assert.ok(report(fewer, 'ours', 'theirs').includes(`  compared ${POSITIONS - 1} positions, not the ${POSITIONS} it is held at`));
  assert.equal(compareReplaced(ours.slice(1), referenceFrom(ours).slice(1), describe, undefined, POSITIONS - 1).holds, true);
});

test("the reference is read as 754147f's document records it, and the command line names what it cannot use", () => {
  const ours = replacedOf(JSON.parse(fs.readFileSync(RESULTS, 'utf8')), 'experiment-10.json');
  const doc = { precondition: { q0: { positions: referenceFrom(ours) } } };
  assert.deepEqual(referenceOf(doc, 'reference'), referenceFrom(ours));
  assert.throws(() => referenceOf({ precondition: {} }, 'reference'), /reference: precondition\.q0 is not an object/);
  assert.throws(() => replacedOf({ precondition: { q0: {} } }, 'odd.json'), /odd\.json is neither an assembled document nor the Q0 checkpoint/);

  assert.equal(parseArgs([]).newFile, RESULTS, 'the committed document is not the default');
  assert.equal(parseArgs([]).reference, null, 'the reference is not read from git by default');
  assert.equal(parseArgs(['--reference', 'x.json']).reference, path.resolve('x.json'));
  assert.throws(() => parseArgs(['--new']), /--new needs a file/);
  assert.throws(() => parseArgs(['--reference', '--new', 'a.json']), /--reference needs a file/);
  assert.throws(() => parseArgs(['--stage', 'q0']), /unknown argument '--stage'/);
});

test('a missing file or commit exits 2 with a message naming it, never 1, which is a failed identity', () => {
  // What main writes to stderr and stdout, with the code it returns.
  const run = (argv: string[], commit?: string): { code: number; err: string; out: string } => {
    const err: string[] = [];
    const out: string[] = [];
    const writeErr = process.stderr.write.bind(process.stderr);
    const writeOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((x: string) => (err.push(String(x)), true)) as typeof process.stderr.write;
    process.stdout.write = ((x: string) => (out.push(String(x)), true)) as typeof process.stdout.write;
    try {
      return { code: commit === undefined ? main(argv) : main(argv, commit), err: err.join(''), out: out.join('') };
    } finally {
      process.stderr.write = writeErr;
      process.stdout.write = writeOut;
    }
  };
  const gone = path.join(REPO, 'experiments', 'no-such-reference.json');
  const noReference = run(['--reference', gone]);
  assert.deepEqual([noReference.code, noReference.out], [2, '']);
  assert.match(noReference.err, /^experiment10-replaced: cannot read the reference experiments\/no-such-reference\.json: ENOENT/);
  const noNew = run(['--new', gone, '--reference', RESULTS]);
  assert.equal(noNew.code, 2);
  assert.match(noNew.err, /cannot read the new file experiments\/no-such-reference\.json/);
  // A commit the clone does not hold, as a shallow clone may not hold 754147f.
  const noCommit = run([], '0000000');
  assert.deepEqual([noCommit.code, noCommit.out], [2, '']);
  assert.match(noCommit.err, /cannot read the reference git show 0000000:experiments\/experiment-10\.json: git show 0000000:experiments\/experiment-10\.json failed .*is 0000000 in this clone\?/);
  // Misuse is 2 as well.
  assert.equal(run(['--stage', 'q0']).code, 2);
});
