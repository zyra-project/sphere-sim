// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * assert-baseline — the bench must still produce the numbers this repository
 * has recorded, and a change that moves them must say so.
 *
 *     node tools/assert-baseline.ts bench-results.json
 *     node tools/assert-baseline.ts bench-results.json --update
 *
 * ## The hole this fills
 *
 * `assert-deterministic.ts` runs the bench twice on ONE tree and checks the two
 * runs agree. That catches unseeded randomness, iteration order, a leaked
 * hostname — anything that makes a single commit disagree with itself.
 *
 * It cannot catch drift ACROSS commits, and that is the failure the project
 * actually spends its care on. `docs/ARBITRARY-SHAPES.md` opens every phase by
 * asserting the sphere path is byte-identical to what it was before the change;
 * `packages/sim/src/surface.ts` returns an exact zero from `SphereSurface.centre`
 * specifically so a refactor cannot move it. Every one of those claims was
 * checked by a person running the bench by hand and comparing. Nothing in CI
 * looked, so a mesh change that quietly moved a sphere number would have been
 * caught only if somebody remembered to look — and the number to compare
 * against lived in a sentence in a markdown file.
 *
 * ## Digests rather than the whole document
 *
 * `bench-results.json` is about 5.5 MB. Committing it would make the diff
 * reviewable, and would also put a 5.5 MB file into every commit that
 * legitimately moves a number. So the baseline records SHA-256 digests of the
 * stripped document, and records them per scenario and per scenario FIELD:
 *
 *   - `$` — the whole stripped document
 *   - `$.gates`, `$.aggregate`, ... — each top-level section
 *   - `$.scenarios[i].metrics`, `.solver`, `.recovery`, ... — each field of each
 *     scenario, keyed by the scenario's own id
 *
 * A global hash would say "something moved". This says "scenario `boulder-nominal`
 * moved, in `recovery`", which is the difference between reading a diff and
 * hunting for one. The file is a few tens of kilobytes.
 *
 * ## Updating it is deliberate, and that is the point
 *
 * `--update` rewrites the baseline. A change that legitimately moves a number
 * then carries the new digests in the same commit, where a reviewer sees the
 * count of what moved next to the reason it moved. There is no auto-update in
 * CI and there must not be: a gate that repairs itself when it fails is not a
 * gate. If this check goes red on a change that was supposed to move nothing,
 * that IS the finding.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import {
  VOLATILE_PATHS,
  type Json,
  checkVolatileDeclaration,
  isObject,
  readJson,
  strip,
} from './bench-normalize.ts';

const TOOL = 'assert-baseline';
const BASELINE = 'bench-baseline.json';
const SCHEMA = 'sphere-sim/bench-baseline@1';

/**
 * The command the baseline describes.
 *
 * Recorded so a baseline can never be silently compared against the output of a
 * different scenario count or seed, which would be a green check about nothing.
 */
const COMMAND = 'bench --scenarios 13 --seed 1234';

interface Baseline {
  schema: string;
  command: string;
  volatile: string[];
  characters: number;
  digests: { [path: string]: string };
}

function usage(): never {
  process.stderr.write(
    'usage: node tools/assert-baseline.ts <bench-results.json> [--update]\n' +
      `  Compares a bench run against ${BASELINE}, outside the declared volatile fields.\n` +
      '  --update rewrites the baseline; do that in the commit that moves the numbers.\n',
  );
  process.exit(2);
}

/**
 * A digest of a value, over its canonical serialisation.
 *
 * `JSON.stringify` and not a structural walk: key order is part of what the
 * determinism check already treats as significant, so preserving it here keeps
 * the two checks reading the same document.
 */
function digest(v: Json): string {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}

/** Every path worth naming in a failure, mapped to its digest. */
function digestsOf(stripped: Json): { [path: string]: string } {
  const out: { [path: string]: string } = { $: digest(stripped) };
  if (!isObject(stripped)) return out;

  for (const [k, v] of Object.entries(stripped)) {
    if (k === 'scenarios') continue;
    out[`$.${k}`] = digest(v);
  }

  const scenarios = stripped.scenarios;
  if (!Array.isArray(scenarios)) return out;
  out['$.scenarios'] = digest(scenarios);
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    // Keyed by the scenario's own id where it has one. An index alone would
    // rename every downstream digest when a scenario is inserted, turning one
    // real change into twelve.
    const id = isObject(s) && typeof s.id === 'string' ? s.id : `#${i}`;
    out[`$.scenarios[${id}]`] = digest(s);
    if (!isObject(s)) continue;
    for (const [sk, sv] of Object.entries(s)) {
      out[`$.scenarios[${id}].${sk}`] = digest(sv);
    }
  }
  return out;
}

function readBaseline(): Baseline {
  const doc = readJson(TOOL, BASELINE);
  if (!isObject(doc) || doc.schema !== SCHEMA) {
    process.stderr.write(
      `${TOOL}: ${BASELINE} is not a ${SCHEMA} document. Regenerate it with --update.\n`,
    );
    process.exit(2);
  }
  return doc as unknown as Baseline;
}

/**
 * The paths that moved, with the deepest ones first.
 *
 * Deepest first because `$` and `$.scenarios` move whenever anything under them
 * does, so leading with them would bury the one line that says where.
 */
function movedPaths(want: { [p: string]: string }, got: { [p: string]: string }): string[] {
  const paths = new Set([...Object.keys(want), ...Object.keys(got)]);
  const moved = [...paths].filter((p) => want[p] !== got[p]);
  return moved.sort((a, b) => {
    const depth = (p: string): number => p.split(/[.[]/).length;
    return depth(b) - depth(a) || a.localeCompare(b);
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const files = args.filter((a) => a !== '--update');
  if (files.length !== 1) usage();
  const file = files[0];

  const doc = readJson(TOOL, file);
  checkVolatileDeclaration(TOOL, file, doc);
  const stripped = strip(doc);
  const characters = JSON.stringify(stripped).length;
  const digests = digestsOf(stripped);

  if (update) {
    const next: Baseline = {
      schema: SCHEMA,
      command: COMMAND,
      volatile: VOLATILE_PATHS,
      characters,
      digests,
    };
    fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(
      `${TOOL}: wrote ${BASELINE} — ${Object.keys(digests).length} digests, ` +
        `${characters} characters outside [${VOLATILE_PATHS.join(', ')}].\n` +
        '  Commit this alongside the change that moved the numbers, and say in the message\n' +
        '  which numbers moved and why.\n',
    );
    return;
  }

  const base = readBaseline();
  if (base.command !== COMMAND) {
    process.stderr.write(
      `${TOOL}: ${BASELINE} records '${base.command}' but this tool checks '${COMMAND}'. ` +
        'A baseline compared against a different run is a green check about nothing.\n',
    );
    process.exit(2);
  }

  const moved = movedPaths(base.digests, digests);
  if (moved.length === 0) {
    process.stdout.write(
      `${TOOL}: ${file} matches ${BASELINE} — ${Object.keys(digests).length} digests, ` +
        `${characters} characters, unchanged.\n`,
    );
    return;
  }

  process.stderr.write('\nBENCH BASELINE MOVED\n\n');
  process.stderr.write(
    `  ${characters} characters now, ${base.characters} recorded ` +
      `(${characters === base.characters ? 'same length, different content' : 'different length'}).\n\n`,
  );
  const shown = moved.slice(0, 20);
  for (const p of shown) {
    const was = base.digests[p] ?? '(absent)';
    const now = digests[p] ?? '(absent)';
    process.stderr.write(`  ${p}\n      recorded ${was}  ->  now ${now}\n`);
  }
  if (moved.length > shown.length) {
    process.stderr.write(`  ... and ${moved.length - shown.length} more paths\n`);
  }
  process.stderr.write(
    '\n  The bench is a pure function of (calibration, scene, seed), so this means the model\n' +
      '  changed. Two possibilities, and they need opposite responses:\n\n' +
      '    - You did NOT mean to move a number. This is the finding. Something in the change\n' +
      '      reached further than intended — most often a shared code path that the analytic\n' +
      '      sphere also takes.\n\n' +
      '    - You DID mean to move it. Re-run with --update, commit the new baseline in the\n' +
      '      same change, and say in the message which numbers moved and why.\n\n' +
      '  For the field rather than the path, diff two runs directly:\n\n' +
      '    git stash && npm run bench -- --scenarios 12 --seed 1234 --out /tmp/before.json\n' +
      '    git stash pop && npm run bench -- --scenarios 12 --seed 1234 --out /tmp/after.json\n' +
      '    node tools/assert-deterministic.ts /tmp/before.json /tmp/after.json\n\n',
  );
  process.exit(1);
}

main();
