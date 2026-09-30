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
 * passes only when every field of every position agrees, and fails, naming the
 * field, when any one does not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  FIELDS,
  compareReplaced,
  parseArgs,
  referenceOf,
  replacedOf,
  report,
  type ReferencePosition,
  type ReplacedPosition,
} from '../../../tools/experiment10-replaced.ts';

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

test("I-replaced holds where the reference is the replaced reader's own record, and fails on any one field", () => {
  const ours = replacedOf(JSON.parse(fs.readFileSync(RESULTS, 'utf8')), 'experiment-10.json');
  assert.ok(ours.length > 0, 'the committed document keeps no replaced reader');
  const held = compareReplaced(ours, referenceFrom(ours), describe);
  assert.equal(held.holds, true, report(held, 'ours', 'theirs').join('\n'));
  assert.equal(held.compared, ours.length);
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

  // A position on one side only fails, and so does a comparison of none.
  const missing = referenceFrom(ours).slice(1);
  const one = compareReplaced(ours, missing, describe);
  assert.deepEqual([one.holds, one.onlyNew.length, one.onlyReference.length], [false, 1, 0]);
  const extra = compareReplaced(ours.slice(1), referenceFrom(ours), describe);
  assert.deepEqual([extra.holds, extra.onlyNew.length, extra.onlyReference.length], [false, 0, 1]);
  assert.equal(compareReplaced([], [], describe).holds, false, 'a comparison of nothing held');
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
