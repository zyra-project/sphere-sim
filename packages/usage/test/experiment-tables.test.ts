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

test('a second copy of a properly registered marker is caught', () => {
  // `syncDocs` locates a block with `indexOf`, so it regenerates the FIRST
  // occurrence and never looks at the rest. A duplicate marker therefore keeps
  // the generated label over a table nothing writes and nothing compares — the
  // same hole as an unregistered marker, one step further in, and the first
  // version of this check waved it through because the id does resolve to this
  // document. Caught in review.
  const file = path.join(DOCS, 'ARBITRARY-SHAPES.md');
  const original = fs.readFileSync(file, 'utf8');
  const marker = '<!-- generated: experiment-7-mechanism-arbitrary-shapes -->';
  assert.ok(original.includes(marker), 'the fixture marker should be in the document');
  try {
    fs.writeFileSync(file, `${original}\n\n${marker}\n| hand | written |\n<!-- /generated -->\n`);
    const found = unregisteredBlocks().filter((b) => b.doc === 'docs/ARBITRARY-SHAPES.md');
    assert.equal(found.length, 1, 'the duplicate should be the one finding');
    assert.equal(found[0].id, 'experiment-7-mechanism-arbitrary-shapes');
  } finally {
    fs.writeFileSync(file, original);
  }
  assert.deepEqual(unregisteredBlocks(), [], 'and the document is left as it was found');
});

// ---------------------------------------------------------------------------
// EXPERIMENT-10's page column: the tables written for the re-run with the
// page's reader. They are not registered in any document until that run's
// results file is committed (the committed file is the first run's, which has
// no page column to render), so they are held here to the quick run's
// document, which a `--quick` run writes beside its checkpoints and which is
// not committed. Where no quick run has been made in this checkout, those
// tests say so and are skipped.
// ---------------------------------------------------------------------------

const QUICK = path.join(REPO, 'experiments', '.experiment-10-partial', 'quick', 'experiment-10.quick.json');
const noQuick = fs.existsSync(QUICK) ? false : 'no --quick run of EXPERIMENT-10 in this checkout';

// A cell's page block, as far as these tests read it.
interface QuickPage {
  status: string;
  rigs: { column: number; of: number };
  read: { captures: number; crashes: number };
  classes: { P: { counts: Record<string, number> } };
  quiet: { runs: number; captures: number; silentWithQuiet: number };
  misfiles: { photographs: number; share: { max: number | null } };
  runs: { both: Record<string, Record<string, number>> };
  words: { runs: number };
}
interface QuickCell {
  id: string;
  trials: number;
  page: QuickPage | { status: 'not run' } | null;
}
interface QuickDoc {
  rescore: { cells: QuickCell[] };
  lateness: { cells: QuickCell[] };
  precondition: { q0: { total: number; page: { placedPositions: number; unseen: number; barelySeen: number } } };
}

const quickDoc = (): QuickDoc => JSON.parse(fs.readFileSync(QUICK, 'utf8')) as QuickDoc;
/** A markdown table's cells, row by row, the header first; blank lines and notes left out. */
const rowsOf = (table: string): string[][] =>
  table
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*---/.test(line))
    .map((line) => line.slice(1, -1).split('|').map((x) => x.trim()));

test('the page column table has a row per cell, each read back from the document', { skip: noQuick }, async () => {
  const { experiment10Page } = await import('../../../tools/experiment-tables.ts');
  const doc = quickDoc();
  const rendered = experiment10Page(doc as never);
  const rows = rowsOf(rendered);
  const header = rows[0];
  // The counterfactual's classes, and beside them the page's own: QUIET, and a LOUD capture with a QUIET position.
  assert.deepEqual(header, [
    'cell',
    'captures touched',
    'LOUD (share, 95% CI)',
    'LOUD+SILENT',
    'LOUD+QUIET',
    'SILENT',
    'QUIET',
    'INVISIBLE-ONLY',
    'UNCHANGED',
    'quiet drops: runs (captures)',
    'misfiled photographs (the largest majority share)',
    'crashes',
  ]);
  const col = (name: string): number => header.indexOf(name);
  assert.match(rendered, /The counterfactual reader has no QUIET class/, 'the note does not say the counterfactual has no QUIET');
  const cells = [...doc.rescore.cells, ...doc.lateness.cells];
  assert.equal(rows.length - 1, cells.length, 'a cell has no row, or a row no cell');
  for (const row of rows.slice(1)) {
    assert.equal(row.length, header.length, `${row[0]}: ${row.length} cells under ${header.length} columns`);
    const cell = cells.find((c) => c.id === row[0]);
    assert.ok(cell !== undefined && cell.page !== null, row[0]);
    const page = cell.page as QuickPage;
    if (page.status === 'nothing to read') assert.match(row[1], /\(nothing to read\)$/);
    const k = page.classes.P.counts;
    assert.equal(Number(row[col('LOUD (share, 95% CI)')].split(' ')[0]), k.LOUD, `${row[0]} LOUD`);
    assert.equal(Number(row[col('LOUD+SILENT')]), k['LOUD+SILENT'], `${row[0]} LOUD+SILENT`);
    assert.equal(Number(row[col('LOUD+QUIET')]), k['LOUD+QUIET'], `${row[0]} LOUD+QUIET`);
    assert.equal(Number(row[col('QUIET')]), k.QUIET, `${row[0]} QUIET`);
    const silent = ['SILENT-HARMLESS', 'SILENT-BIASED', 'SILENT-GATE-BREAKING', 'SILENT-UNJUDGEABLE', 'SILENT-UNSOLVED'].reduce((a, x) => a + k[x], 0);
    assert.equal(Number(row[col('SILENT')].split(/[ :]/)[0]), silent, `${row[0]} SILENT`);
    assert.equal(row[col('quiet drops: runs (captures)')], `${page.quiet.runs} (${page.quiet.captures})`, `${row[0]} quiet drops`);
    const misfiles = row[col('misfiled photographs (the largest majority share)')];
    assert.equal(Number(misfiles.split(' ')[0]), page.misfiles.photographs, `${row[0]} misfiles`);
    if (page.misfiles.photographs > 0) assert.ok(misfiles.endsWith(`(${(page.misfiles.share.max as number).toFixed(3)})`), misfiles);
    assert.equal(Number(row[col('crashes')]), page.read.crashes);
  }
  // The quick plan touches nothing at R8 and L-aimed-2: nothing to read, which is not "did not run".
  for (const id of ['R8', 'L-aimed-2']) assert.match(rows.find((r) => r[0] === id)?.[1] ?? '', /nothing to read/);
  assert.doesNotMatch(rendered, /did not run/);
});

test('the page table shows a QUIET capture and a LOUD one with a quiet drop in columns of their own', { skip: noQuick }, async () => {
  // The quick run has no QUIET position, so each column's figure is set in apart
  // from the others, and must come back in its own column.
  const { experiment10Page } = await import('../../../tools/experiment-tables.ts');
  const doc = quickDoc();
  const r1 = doc.rescore.cells.find((c) => c.id === 'R1')?.page as QuickPage;
  Object.assign(r1.classes.P.counts, { QUIET: 7, 'LOUD+QUIET': 3, 'LOUD+SILENT': 5 });
  r1.quiet.silentWithQuiet = 2;
  const rows = rowsOf(experiment10Page(doc as never));
  const at = (name: string): string => (rows.find((r) => r[0] === 'R1') as string[])[rows[0].indexOf(name)];
  assert.deepEqual([at('QUIET'), at('LOUD+QUIET'), at('LOUD+SILENT')], ['7', '3', '5']);
  assert.match(at('SILENT'), /; 2 with a QUIET position too$/);
});

test('a cell the page column did not run in says so, apart from one it found nothing to read in', { skip: noQuick }, async () => {
  const { experiment10Page, experiment10PageRuns } = await import('../../../tools/experiment-tables.ts');
  const doc = quickDoc();
  const r2 = doc.rescore.cells.find((c) => c.id === 'R2') as QuickCell;
  r2.page = { status: 'not run', rigs: { column: 0, of: 4 } } as never;
  for (const render of [experiment10Page, experiment10PageRuns]) {
    const rows = rowsOf(render(doc as never));
    assert.ok(rows.some((r) => r[0] === 'R2' && r[1] === 'the page column did not run'), 'R2 is not said to be unread');
    assert.ok(rows.every((r) => r[0] !== 'R8' || r[1] !== 'the page column did not run'), 'R8 had nothing to read, and is said not to have run');
  }
  // A file written before the page column was summarised is refused, never rendered as blanks.
  const old = quickDoc();
  (old.rescore.cells.find((c) => c.id === 'R1') as QuickCell).page = null;
  assert.throws(() => experiment10Page(old as never), /R1 has no page column summary/);
  const missing = quickDoc();
  delete (missing.lateness.cells.find((c) => c.id === 'L-aimed-7.5') as { page?: unknown }).page;
  assert.throws(() => experiment10Page(missing as never), /results file has no L-aimed-7\.5\.page/);
});

test('the page against the counterfactual run by run: R1 in full adds up, every cell summarised, the words beside', { skip: noQuick }, async () => {
  const { experiment10PageRuns } = await import('../../../tools/experiment-tables.ts');
  const doc = quickDoc();
  const rendered = experiment10PageRuns(doc as never);
  const tables = rendered.split('\n\n').filter((x) => x.startsWith('|')).map(rowsOf);
  assert.equal(tables.length, 4, 'R1 in full, every cell, the LOUD words, the page\'s words');
  const [full, summary, loud, words] = tables;
  // R1 in full: the all row sums the rows above, and is every run both twins place.
  const r1 = doc.rescore.cells.find((c) => c.id === 'R1')?.page as QuickPage;
  const both = Object.values(r1.runs.both).reduce((a, row) => a + Object.values(row).reduce((b, n) => b + n, 0), 0);
  const all = full[full.length - 1];
  assert.equal(Number(all[all.length - 1].replace(/\*/g, '')), both);
  for (let col = 1; col < all.length; col++) {
    const sum = full.slice(1, -1).reduce((a, row) => a + Number(row[col]), 0);
    assert.equal(Number(all[col].replace(/\*/g, '')), sum, `R1 in full, column ${full[0][col]}`);
  }
  const cells = [...doc.rescore.cells, ...doc.lateness.cells];
  for (const t of [summary, loud, words]) {
    assert.deepEqual(t.slice(1).map((r) => r[0]), cells.map((c) => c.id));
    for (const row of t) assert.equal(row.length, t[0].length, row.join(' | '));
  }
  assert.equal(Number(summary.find((r) => r[0] === 'R1')?.[1]), both);
  for (const c of cells) assert.equal(Number(words.find((r) => r[0] === c.id)?.[1]), (c.page as QuickPage).words.runs, c.id);
});

test('the precondition with both readers: the page\'s reader\'s columns and the replaced reader\'s, labelled', { skip: noQuick }, async () => {
  const { experiment10PreconditionTwoReaders } = await import('../../../tools/experiment-tables.ts');
  const doc = quickDoc();
  const rendered = experiment10PreconditionTwoReaders(doc as never);
  const tables = rendered.split('\n\n').filter((x) => x.startsWith('|')).map(rowsOf);
  assert.equal(tables.length, 4, 'Q0, the counterfactual twins, the page twins, Q0b');
  const [q0, twins, pageTwins, q0b] = tables;
  assert.match(q0[0].join(' | '), /the page’s reader: positions placed \| runs placed \| noted out of view · barely seen \| problems \| the reader it replaced: positions placed \| refused at/);
  const total = q0[q0.length - 1];
  assert.equal(total[2], `**${doc.precondition.q0.total}**`);
  assert.equal(total[3], `**${doc.precondition.q0.page.placedPositions}**`);
  assert.equal(total[5], `**${doc.precondition.q0.page.unseen} · ${doc.precondition.q0.page.barelySeen}**`);
  assert.equal(twins.length, 4);
  assert.match(pageTwins[0][0], /the page’s reader, clean \(the page twin\)/);
  assert.equal(q0b.length - 1, 17, 'every folder shape Q0b builds');
  assert.match(q0b[0][0], /read by the counterfactual reader/);
  assert.doesNotMatch(rendered, /the page’s reasons/);
});
