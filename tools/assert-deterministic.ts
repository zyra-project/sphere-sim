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
 * ## The volatile fields, and why the list is still duplicated on purpose
 *
 * Exactly two things in `bench-results.json` cannot be reproducible: the
 * top-level `env` block (wall clock, git hash, duration, host details) and each
 * scenario's `timings`. `tools/bench-normalize.ts` carries the TOOLS' copy of
 * that list and verifies it against the `volatile` array the results file
 * declares.
 *
 * The duplication is the mechanism. If the exclusion list lived only in the
 * producer, anyone could silence a real determinism failure by adding a field
 * name to it, and the check would keep reporting success. With two copies that
 * must agree, widening the exclusions takes an edit on the suspicious side of
 * the line as well. It moved out of this file so that `assert-baseline.ts`
 * reads a difference the same way this does — a THIRD copy would be a place for
 * the two checks to disagree about what a difference is.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  VOLATILE_PATHS,
  checkVolatileDeclaration,
  firstDifference,
  readJson,
  strip,
} from './bench-normalize.ts';

const TOOL = 'assert-deterministic';

function usage(): never {
  process.stderr.write(
    'usage: node tools/assert-deterministic.ts <a.json> <b.json>\n' +
      '  Compares two bench-results files for equality outside the declared volatile fields.\n',
  );
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 2) usage();
  const [fileA, fileB] = args;

  const rawA = fs.readFileSync(fileA);
  const rawB = fs.readFileSync(fileB);
  const docA = readJson(TOOL, fileA);
  const docB = readJson(TOOL, fileB);
  checkVolatileDeclaration(TOOL, fileA, docA);
  checkVolatileDeclaration(TOOL, fileB, docB);

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
