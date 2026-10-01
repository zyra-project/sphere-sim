// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * experiment10-replaced — I-replaced, the one identity EXPERIMENT-10's fourth
 * run holds outside its results file.
 *
 * ## Why this exists
 *
 * The fourth run replaced the page's reader and kept the reader it replaced
 * beside it in Q0, on the same summaries of the same clean photographs, so that
 * what that reader did could be held to the third run's committed results
 * file, 754147f's `experiments/experiment-10.json` (`RERUN_IDENTITIES` in
 * `packages/experiments/src/straddle/design.ts`). The fourth run wrote over
 * that file, and its `harness[]` evaluates only what its own cells can show. So
 * this identity is held here, against 754147f's file itself, and
 * `docs/EXPERIMENT-10.md` cites what this prints. Until it was committed, the
 * document said the identity held on the strength of a script nobody else could
 * run.
 *
 * ## What it compares
 *
 * Every clean position, matched by which, rig and camera:
 *
 *   - placed, runsPlaced and the problems' text;
 *   - reasons: `reasonOf` of each problem, on both sides;
 *   - the description: 754147f's own `describeIndexing`, compiled from
 *     `git show 754147f:packages/web/src/readback.ts`, of the replaced reader's
 *     verdict, against the description 754147f wrote: that commit's words, and
 *     nobody's copy of them, since the page's own function has changed since;
 *   - total;
 *   - margin, wrongKinds and perRun, margins at the four decimals the
 *     committed file holds.
 *
 * A position on one side only fails, and so does one held twice on either side,
 * whatever its copies say: the identity is held at each of 108 positions, so a
 * comparison of any other number fails too. A field that differs is shown on
 * both sides from where they first part.
 *
 * Run:  node tools/experiment10-replaced.ts [--new <file>] [--reference <file>]
 *
 *   --new        an assembled document (`precondition.q0.positions[].replaced`)
 *                or the Q0 checkpoint itself (`units[*].positions[].replaced`);
 *                `experiments/experiment-10.json` when omitted
 *   --reference  754147f's committed document; when omitted it is read with
 *                `git show 754147f:experiments/experiment-10.json`, never from
 *                the working tree, whose file is the fourth run's
 *
 * Exit 0 when every field of every position agrees, 1 when any does not, 2 on
 * misuse or when a file or the commit it reads is missing, with a message
 * naming what. It needs 754147f in the clone, which a shallow clone may lack,
 * so it is run by hand and not in CI; its comparison is tested without the
 * commit (`packages/usage/test/experiment10-replaced.test.ts`).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { PROJECTORS } from '../packages/experiments/src/straddle/design.ts';
import { reasonOf, round } from '../packages/experiments/src/straddle/stages.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The third full run's commit: its committed results file is the reference. */
export const REFERENCE_COMMIT = '754147f';

/**
 * The clean positions I-replaced is held at, as its registered text says ("at
 * each of the 108 positions", `RERUN_IDENTITIES` in design.ts): a comparison of
 * any other number does not hold it.
 */
export const POSITIONS = 108;

/** Where a document the tool reads keeps its results, relative to the repository. */
const RESULTS = 'experiments/experiment-10.json';

export interface PerRun {
  margin: number | null;
  wrongKinds: number;
}

/** The replaced reader's verdict at one clean position, with the classify fields beside it. */
export interface ReplacedPosition {
  which: string;
  rig: number;
  camera: number;
  total: number;
  margin: number | null;
  wrongKinds: number;
  perRun: PerRun[];
  ok: boolean;
  placed: number;
  runsPlaced: number[];
  problems: string[];
}

/** A clean position as 754147f's committed document records its reader's verdict. */
export interface ReferencePosition {
  which: string;
  rig: number;
  camera: number;
  total: number;
  margin: number | null;
  wrongKinds: number;
  perRun: PerRun[];
  placed: number;
  runsPlaced: number[];
  problems: string[];
  description: string;
}

type Json = Record<string, unknown>;

function objectAt(x: unknown, where: string): Json {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${where} is not an object`);
  return x as Json;
}

function arrayAt(x: unknown, where: string): unknown[] {
  if (!Array.isArray(x)) throw new Error(`${where} is not an array`);
  return x;
}

/**
 * The replaced reader's verdict at every position of a new file: an assembled
 * document, whose classify fields are already at four decimals, or the Q0
 * checkpoint, whose margins are rounded here as the assembly rounds them.
 */
export function replacedOf(doc: unknown, name: string): ReplacedPosition[] {
  const file = objectAt(doc, name);
  const precondition = file.precondition as Json | undefined;
  const q0 = precondition?.q0 as Json | undefined;
  let positions: ReplacedPosition[];
  if (q0 !== undefined && q0.positions !== undefined) {
    positions = arrayAt(q0.positions, `${name}: precondition.q0.positions`).map((x, i) => {
      const p = objectAt(x, `${name}: position ${i}`);
      const r = objectAt(p.replaced, `${name}: position ${i}'s replaced reader`);
      return {
        which: p.which as string,
        rig: p.rig as number,
        camera: p.camera as number,
        total: p.total as number,
        margin: p.margin as number | null,
        wrongKinds: p.wrongKinds as number,
        perRun: (p.perRun as PerRun[]).map((run) => ({ margin: run.margin, wrongKinds: run.wrongKinds })),
        ok: r.ok as boolean,
        placed: r.placed as number,
        runsPlaced: r.runsPlaced as number[],
        problems: r.problems as string[],
      };
    });
  } else if (file.stage === 'q0' && file.units !== undefined) {
    positions = Object.values(objectAt(file.units, `${name}: units`)).flatMap((u, i) =>
      arrayAt(objectAt(u, `${name}: unit ${i}`).positions, `${name}: unit ${i}'s positions`).map((x, j) => {
        const p = objectAt(x, `${name}: unit ${i} position ${j}`);
        const r = objectAt(p.replaced, `${name}: unit ${i} position ${j}'s replaced reader`);
        return {
          which: p.which as string,
          rig: p.rig as number,
          camera: p.camera as number,
          total: p.total as number,
          margin: round(p.margin as number, 4),
          wrongKinds: p.wrongKinds as number,
          perRun: (p.perRun as PerRun[]).map((run) => ({ margin: round(run.margin, 4), wrongKinds: run.wrongKinds })),
          ok: r.ok as boolean,
          placed: r.placed as number,
          runsPlaced: r.runsPlaced as number[],
          problems: r.problems as string[],
        };
      }),
    );
  } else {
    throw new Error(`${name} is neither an assembled document nor the Q0 checkpoint`);
  }
  for (const p of positions) {
    if (p.ok === undefined || p.problems === undefined) {
      throw new Error(`${name}: ${keyOf(p)} has no verdict from the replaced reader`);
    }
  }
  return positions;
}

/** The reference's positions: 754147f's committed document. */
export function referenceOf(doc: unknown, name: string): ReferencePosition[] {
  const file = objectAt(doc, name);
  const q0 = objectAt(objectAt(file.precondition, `${name}: precondition`).q0, `${name}: precondition.q0`);
  return arrayAt(q0.positions, `${name}: precondition.q0.positions`) as ReferencePosition[];
}

const keyOf = (p: { which: string; rig: number; camera: number }): string =>
  `${p.which} rig ${p.rig} camera ${p.camera}`;

/** The fields compared, in the order they are reported. */
export const FIELDS = [
  'placed',
  'runsPlaced',
  'problems',
  'reasons',
  'description',
  'total',
  'margin',
  'wrongKinds',
  'perRun',
] as const;

export type Field = (typeof FIELDS)[number];

export interface Comparison {
  /** Positions in both files. */
  compared: number;
  /** The positions the identity is held at: `compared` must be this. */
  expected: number;
  /** Each file's positions as listed, a duplicate counted each time it is. */
  ours: number;
  theirs: number;
  /** For each field, the positions where it differs, each with both sides from where they part. */
  differ: Record<Field, string[]>;
  onlyNew: string[];
  onlyReference: string[];
  /** Positions listed more than once in a file, with how many times. */
  duplicatedNew: string[];
  duplicatedReference: string[];
  holds: boolean;
}

/**
 * Two values as JSON, each from a little before the first character where
 * they part, so a long field that differs late shows where it does and not
 * the same opening twice.
 */
export function firstDifference(a: unknown, b: unknown, width = 120): [string, string] {
  const x = JSON.stringify(a) ?? 'undefined';
  const y = JSON.stringify(b) ?? 'undefined';
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  const from = Math.max(0, i - 20);
  const cut = (s: string): string =>
    `${from > 0 ? '…' : ''}${s.slice(from, from + width)}${from + width < s.length ? '…' : ''}`;
  return [cut(x), cut(y)];
}

/**
 * The replaced reader's verdicts against the reference's, field for field.
 * `describe` writes a verdict's description as the reference's code wrote it,
 * and `reasons` classes a problem; both are handed in, so the comparison can be
 * tested without the reference's commit. `expected` is how many positions it
 * must compare to hold.
 */
export function compareReplaced(
  ours: readonly ReplacedPosition[],
  theirs: readonly ReferencePosition[],
  describe: (p: ReplacedPosition) => string,
  reasons: (problem: string) => string = reasonOf,
  expected: number = POSITIONS,
): Comparison {
  // A position listed twice is a failure however its copies agree, so each
  // side is counted as listed before it is keyed.
  const duplicated = (xs: readonly { which: string; rig: number; camera: number }[]): string[] => {
    const n = new Map<string, number>();
    for (const p of xs) n.set(keyOf(p), (n.get(keyOf(p)) ?? 0) + 1);
    return [...n].filter(([, k]) => k > 1).map(([key, k]) => `${key} (${k} times)`);
  };
  const reference = new Map(theirs.map((p) => [keyOf(p), p]));
  const mine = new Map(ours.map((p) => [keyOf(p), p]));
  const differ = Object.fromEntries(FIELDS.map((f) => [f, [] as string[]])) as Record<Field, string[]>;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  let compared = 0;
  for (const [k, p] of mine) {
    const q = reference.get(k);
    if (q === undefined) continue;
    compared++;
    const now: Record<Field, unknown> = {
      placed: p.placed,
      runsPlaced: p.runsPlaced,
      problems: p.problems,
      reasons: p.problems.map(reasons),
      description: describe(p),
      total: p.total,
      margin: p.margin,
      wrongKinds: p.wrongKinds,
      perRun: p.perRun,
    };
    const then: Record<Field, unknown> = {
      placed: q.placed,
      runsPlaced: q.runsPlaced,
      problems: q.problems,
      reasons: q.problems.map(reasons),
      description: q.description,
      total: q.total,
      margin: q.margin,
      wrongKinds: q.wrongKinds,
      perRun: q.perRun.map((r) => ({ margin: r.margin, wrongKinds: r.wrongKinds })),
    };
    for (const f of FIELDS) {
      if (same(now[f], then[f])) continue;
      const [a, b] = firstDifference(now[f], then[f]);
      differ[f].push(`${k}: ${a} against ${b}`);
    }
  }
  const onlyNew = [...mine.keys()].filter((k) => !reference.has(k));
  const onlyReference = [...reference.keys()].filter((k) => !mine.has(k));
  const duplicatedNew = duplicated(ours);
  const duplicatedReference = duplicated(theirs);
  const failures =
    FIELDS.reduce((a, f) => a + differ[f].length, 0) +
    onlyNew.length +
    onlyReference.length +
    duplicatedNew.length +
    duplicatedReference.length;
  return {
    compared,
    expected,
    ours: ours.length,
    theirs: theirs.length,
    differ,
    onlyNew,
    onlyReference,
    duplicatedNew,
    duplicatedReference,
    holds: failures === 0 && compared === expected,
  };
}

/** What the comparison says, line by line: the fields, then the verdict. */
export function report(c: Comparison, newName: string, referenceName: string): string[] {
  const lines = [
    `I-replaced: ${c.compared} positions compared of the ${c.expected} it is held at ` +
      `(${c.ours} listed in ${newName}, ${c.theirs} in ${referenceName})`,
  ];
  for (const f of FIELDS) {
    lines.push(`  ${f.padEnd(11)} ${c.differ[f].length === 0 ? 'equal at every position' : `${c.differ[f].length} differ`}`);
    for (const line of c.differ[f].slice(0, 3)) lines.push(`      ${line}`);
  }
  if (c.onlyNew.length > 0) lines.push(`  only in the new file: ${c.onlyNew.length} (${c.onlyNew.slice(0, 3).join('; ')})`);
  if (c.onlyReference.length > 0) {
    lines.push(`  only in the reference: ${c.onlyReference.length} (${c.onlyReference.slice(0, 3).join('; ')})`);
  }
  if (c.duplicatedNew.length > 0) {
    lines.push(`  listed twice or more in the new file: ${c.duplicatedNew.length} (${c.duplicatedNew.slice(0, 3).join('; ')})`);
  }
  if (c.duplicatedReference.length > 0) {
    lines.push(
      `  listed twice or more in the reference: ${c.duplicatedReference.length} ` +
        `(${c.duplicatedReference.slice(0, 3).join('; ')})`,
    );
  }
  if (c.compared !== c.expected) lines.push(`  compared ${c.compared} positions, not the ${c.expected} it is held at`);
  lines.push(c.holds ? 'I-replaced HOLDS' : 'I-replaced DOES NOT HOLD');
  return lines;
}

/**
 * A file as a commit holds it, or a throw naming the commit and the file and
 * what git said: a clone without the commit is the likeliest cause.
 */
function gitShow(commit: string, file: string, repo: string): string {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${commit}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const said = String((e as { stderr?: unknown }).stderr ?? '').trim().split('\n')[0] ?? '';
    throw new Error(
      `git show ${commit}:${file} failed${said === '' ? '' : ` (${said})`}; is ${commit} in this clone? ` +
        'A shallow clone may lack it.',
    );
  }
}

/**
 * `describeIndexing` as the reference's commit wrote it, compiled from that
 * commit's `packages/web/src/readback.ts`, as a verdict's description.
 */
export function describeAt(commit: string, repo: string = ROOT): (p: ReplacedPosition) => string {
  const source = gitShow(commit, 'packages/web/src/readback.ts', repo);
  const file = ts.createSourceFile('readback.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'describeIndexing',
  );
  if (declaration === undefined) throw new Error(`${commit}'s readback.ts has no describeIndexing`);
  const js = ts.transpileModule(declaration.getText(file).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const describeIndexing = new Function(`${js}\nreturn describeIndexing;`)() as (
    indexed: { ok: boolean; total: number; placed: number; runs: { projector: number }[] },
    projectors: number,
  ) => string;
  return (p) =>
    describeIndexing(
      { ok: p.ok, total: p.total, placed: p.placed, runs: p.runsPlaced.map((projector) => ({ projector })) },
      PROJECTORS,
    );
}

export interface Options {
  newFile: string;
  reference: string | null;
}

/** The command line, or a throw that names what is wrong with it. */
export function parseArgs(argv: readonly string[]): Options {
  const out: Options = { newFile: path.join(ROOT, RESULTS), reference: null };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if ((argv[i] === '--new' || argv[i] === '--reference') && (value === undefined || value.startsWith('--'))) {
      throw new Error(`${argv[i]} needs a file`);
    }
    if (argv[i] === '--new') out.newFile = path.resolve(argv[++i]);
    else if (argv[i] === '--reference') out.reference = path.resolve(argv[++i]);
    else throw new Error(`unknown argument '${argv[i]}'`);
  }
  return out;
}

/**
 * The command line run: 0 when I-replaced holds, 1 when it does not, and 2,
 * with a message, when the command line is wrong or a file or the commit it
 * reads is missing or unreadable, which is no verdict on the identity.
 * `commit` is the reference's, a parameter only so a test can name one the
 * clone does not hold.
 */
export function main(argv: readonly string[] = process.argv.slice(2), commit: string = REFERENCE_COMMIT): number {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    process.stderr.write(
      `experiment10-replaced: ${(e as Error).message}\n` +
        'usage: node tools/experiment10-replaced.ts [--new <document or Q0 checkpoint>] [--reference <file>]\n',
    );
    return 2;
  }
  // A file inside the repository by its path there, any other by its own.
  const nameOf = (file: string): string => {
    const inside = path.relative(ROOT, file);
    return inside.startsWith('..') || path.isAbsolute(inside) ? file : inside;
  };
  const referenceName = options.reference === null ? `git show ${commit}:${RESULTS}` : nameOf(options.reference);
  const newName = nameOf(options.newFile);
  // Each input read in turn, and a failure worded as the input it could not
  // read, so a missing file or commit is never reported as a failed identity.
  const reading = <T>(what: string, read: () => T): T => {
    try {
      return read();
    } catch (e) {
      throw new Error(`cannot read ${what}: ${(e as Error).message}`);
    }
  };
  let inputs: {
    ours: ReplacedPosition[];
    theirs: ReferencePosition[];
    describe: (p: ReplacedPosition) => string;
  };
  try {
    inputs = {
      ours: reading(`the new file ${newName}`, () =>
        replacedOf(JSON.parse(fs.readFileSync(options.newFile, 'utf8')), newName),
      ),
      theirs: reading(`the reference ${referenceName}`, () =>
        referenceOf(
          JSON.parse(
            options.reference === null ? gitShow(commit, RESULTS, ROOT) : fs.readFileSync(options.reference, 'utf8'),
          ),
          referenceName,
        ),
      ),
      describe: reading(`${commit}'s describeIndexing`, () => describeAt(commit)),
    };
  } catch (e) {
    process.stderr.write(`experiment10-replaced: ${(e as Error).message}\n`);
    return 2;
  }
  const comparison = compareReplaced(inputs.ours, inputs.theirs, inputs.describe);
  process.stdout.write(`${report(comparison, newName, referenceName).join('\n')}\n`);
  return comparison.holds ? 0 : 1;
}

// Only when invoked directly, so a test can import the comparison without
// running it: the guard `packages/experiments/src/straddle/cli.ts` uses.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
