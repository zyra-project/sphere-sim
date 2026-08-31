// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The one tools-side reading of what a bench result MEANS, shared by the two
 * checks that compare bench outputs.
 *
 * `assert-deterministic.ts` asks whether two runs of the same tree agree.
 * `assert-baseline.ts` asks whether this tree still produces the numbers the
 * repository has recorded. They are different questions and they need the same
 * three answers: which fields are allowed to differ, how to strip them, and how
 * to name the first place two documents part company.
 *
 * ## The volatile list is still duplicated on purpose
 *
 * Exactly two things in `bench-results.json` cannot be reproducible: the
 * top-level `env` block (wall clock, git hash, duration, host details) and each
 * scenario's `timings`. This module carries the TOOLS' copy of that list and
 * {@link checkVolatileDeclaration} verifies it against the `volatile` array the
 * results file declares.
 *
 * The duplication is the mechanism, and moving it here does not spend it. If the
 * exclusion list lived only in the producer, anyone could silence a real
 * failure by adding a field name to it and the checks would keep reporting
 * success. There are still two independent copies that must agree — the
 * producer's in `packages/bench/src/results.ts`, and this one — so widening the
 * exclusions still takes an edit on the suspicious side of the line. What this
 * module removes is a THIRD copy, which would have been a place for the two
 * checks to disagree with each other about what a difference is.
 */

import * as fs from 'node:fs';

/** Must match `VOLATILE_PATHS` in packages/bench/src/results.ts. */
export const VOLATILE_PATHS: string[] = ['env', 'scenarios[].timings'];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function isObject(v: Json): v is { [key: string]: Json } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Read a results file, or exit 2 saying which file and why. */
export function readJson(tool: string, file: string): Json {
  if (!fs.existsSync(file)) {
    process.stderr.write(`${tool}: no such file: ${file}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  } catch (e) {
    process.stderr.write(
      `${tool}: ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(2);
  }
}

/**
 * Check that the file agrees with the tools about what is allowed to differ.
 *
 * A results file with no `volatile` array is either much older than these tools
 * or was written by something that is not the bench, and in both cases silently
 * assuming the default would be assuming the answer.
 */
export function checkVolatileDeclaration(tool: string, file: string, doc: Json): void {
  if (!isObject(doc) || !Array.isArray(doc.volatile)) {
    process.stderr.write(
      `${tool}: ${file} declares no 'volatile' array. This tool refuses to guess which fields are ` +
        'allowed to differ; the producer must say so and the two lists must match.\n',
    );
    process.exit(2);
  }
  const declared = (doc.volatile as Json[]).map((v) => String(v));
  const same =
    declared.length === VOLATILE_PATHS.length && declared.every((v, i) => v === VOLATILE_PATHS[i]);
  if (!same) {
    process.stderr.write(
      `${tool}: ${file} declares volatile paths [${declared.join(', ')}] but the tools know ` +
        `[${VOLATILE_PATHS.join(', ')}]. Widening the exclusion list is exactly the change these ` +
        'checks exist to notice; if the new list is correct, update tools/bench-normalize.ts too.\n',
    );
    process.exit(2);
  }
}

/** Remove the volatile paths. Hardcoded to the two the schema declares. */
export function strip(doc: Json): Json {
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
export function firstDifference(a: Json, b: Json, at = '$'): string | null {
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
