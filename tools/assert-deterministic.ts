// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * assert-deterministic — two bench runs with the same seed must agree.
 *
 *     node tools/assert-deterministic.ts bench-results.json bench-results-2.json
 *
 * Exits non-zero on any divergence outside the declared volatile fields, and
 * prints the JSON path of the first difference rather than "files differ" —
 * which is the difference between a five-minute fix and an afternoon.
 *
 * ## Why this runs in CI at all
 *
 * docs/ARCHITECTURE.md: "Every render is a pure function of `(calibration,
 * scene, seed)`. No wall-clock, no unseeded randomness, no order-dependent
 * floating-point reduction. CI runs the bench twice with the same seed and
 * diffs the output." The bench is the project's quality bar, and a quality bar
 * that moves between runs cannot detect a regression smaller than its own
 * noise. Every honest number downstream depends on this check passing.
 *
 * ## The volatile fields, and why the list is duplicated on purpose
 *
 * Exactly two things in `bench-results.json` cannot be reproducible: the
 * top-level `env` block (wall clock, git hash, duration, host details) and each
 * scenario's `timings`. This tool carries its OWN copy of that list and
 * verifies it against the `volatile` array the results file declares.
 *
 * The duplication is the mechanism. If the exclusion list lived only in the
 * producer, anyone could silence a real determinism failure by adding a field
 * name to it, and the check would keep reporting success. With two copies that
 * must agree, widening the exclusions takes an edit here as well — in a file
 * whose entire purpose is to be suspicious of exactly that edit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Must match `VOLATILE_PATHS` in packages/bench/src/results.ts. */
const VOLATILE_PATHS: string[] = ['env', 'scenarios[].timings'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function usage(): never {
  process.stderr.write(
    'usage: node tools/assert-deterministic.ts <a.json> <b.json>\n' +
      '  Compares two bench-results files for equality outside the declared volatile fields.\n',
  );
  process.exit(2);
}

function readJson(file: string): Json {
  if (!fs.existsSync(file)) {
    process.stderr.write(`assert-deterministic: no such file: ${file}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  } catch (e) {
    process.stderr.write(
      `assert-deterministic: ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(2);
  }
}

function isObject(v: Json): v is { [key: string]: Json } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Check that the file agrees with this tool about what is allowed to differ.
 *
 * A results file with no `volatile` array is either much older than this tool or
 * was written by something that is not the bench, and in both cases silently
 * assuming the default would be assuming the answer.
 */
function checkVolatileDeclaration(file: string, doc: Json): void {
  if (!isObject(doc) || !Array.isArray(doc.volatile)) {
    process.stderr.write(
      `assert-deterministic: ${file} declares no 'volatile' array. This tool refuses to guess ` +
        'which fields are allowed to differ; the producer must say so and the two lists must match.\n',
    );
    process.exit(2);
  }
  const declared = (doc.volatile as Json[]).map((v) => String(v));
  const same =
    declared.length === VOLATILE_PATHS.length &&
    declared.every((v, i) => v === VOLATILE_PATHS[i]);
  if (!same) {
    process.stderr.write(
      `assert-deterministic: ${file} declares volatile paths [${declared.join(', ')}] but this tool ` +
        `knows [${VOLATILE_PATHS.join(', ')}]. Widening the exclusion list is exactly the change this ` +
        'check exists to notice; if the new list is correct, update tools/assert-deterministic.ts too.\n',
    );
    process.exit(2);
  }
}

/** Remove the volatile paths. Hardcoded to the two the schema declares. */
function strip(doc: Json): Json {
  if (!isObject(doc)) return doc;
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'env') continue;
    if (k === 'scenarios' && Array.isArray(v)) {
      out[k] = v.map((s) => {
        if (!isObject(s)) return s;
        const copy: { [key: string]: Json } = {};
        for (const [sk, sv] of Object.entries(s)) {
          if (sk === 'timings') continue;
          copy[sk] = sv;
        }
        return copy;
      });
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * First structural difference, as a JSON path.
 *
 * Key ORDER counts as a difference. Two runs of the same code cannot produce a
 * different key order unless something about the construction order changed,
 * and that is precisely the class of nondeterminism — an iteration over an
 * unordered structure — that docs/ARCHITECTURE.md warns about.
 */
function firstDifference(a: Json, b: Json, at = '$'): string | null {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a === b) return null;
    // Number formatting is not at issue here: both sides came from the same
    // serialiser, so a difference is a difference in the value.
    return `${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return `${at}: array vs object`;
  if (aArr && bArr) {
    if (a.length !== b.length) return `${at}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  const ak = Object.keys(a as { [key: string]: Json });
  const bk = Object.keys(b as { [key: string]: Json });
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) {
    return `${at}: key set or key ORDER differs\n    a: ${ak.join(', ')}\n    b: ${bk.join(', ')}`;
  }
  for (const k of ak) {
    const d = firstDifference(
      (a as { [key: string]: Json })[k],
      (b as { [key: string]: Json })[k],
      `${at}.${k}`,
    );
    if (d !== null) return d;
  }
  return null;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 2) usage();
  const [fileA, fileB] = args;

  const rawA = fs.readFileSync(fileA);
  const rawB = fs.readFileSync(fileB);
  const docA = readJson(fileA);
  const docB = readJson(fileB);
  checkVolatileDeclaration(fileA, docA);
  checkVolatileDeclaration(fileB, docB);

  if (rawA.equals(rawB)) {
    // Identical including the timestamp. Possible when the two runs landed in
    // the same millisecond, or when somebody compared a file with itself.
    process.stdout.write(
      `assert-deterministic: ${path.basename(fileA)} and ${path.basename(fileB)} are byte-identical.\n`,
    );
    return;
  }

  const diff = firstDifference(strip(docA), strip(docB));
  if (diff === null) {
    process.stdout.write(
      `assert-deterministic: ${path.basename(fileA)} and ${path.basename(fileB)} agree on every ` +
        `field outside [${VOLATILE_PATHS.join(', ')}].\n`,
    );
    return;
  }

  process.stderr.write('\nDETERMINISM FAILURE\n\n');
  process.stderr.write(`  ${fileA}\n  ${fileB}\n\n`);
  process.stderr.write(`  first difference at ${diff}\n\n`);
  process.stderr.write(
    '  Two runs with the same seed produced different results. Every number this repository\n' +
      '  publishes assumes this cannot happen: a bench that moves between runs cannot detect a\n' +
      '  regression smaller than its own noise. Usual causes, in order of how often they are it:\n' +
      '    - Math.random, Date.now, or anything else unseeded on the render or solve path\n' +
      '    - iteration over a Map or Set whose insertion order depends on input order\n' +
      '    - a floating-point reduction whose order depends on scheduling or on a cache\n' +
      '    - a path, hostname or locale leaking into the output\n\n',
  );
  process.exit(1);
}

main();
