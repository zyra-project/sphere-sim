// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The acceptance sweep's command line.
 *
 * `tools/reader-acceptance.ts` writes `experiments/reader-acceptance.json`, the
 * whole sweep's record: `docs/OPERATOR-PATH.md`'s table is generated from it,
 * and the docs quote its numbers. `--only` runs some of its units, and a run of
 * some units wrote there too unless `--out` said otherwise, so a quick look at
 * one rig replaced the record with one rig's positions. Review of PR #53 caught
 * it. The sweep itself is half an hour and is not run here; its command line
 * is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../../..');
const REGISTERED = path.join(REPO, 'experiments', 'reader-acceptance.json');

/**
 * The tool, imported rather than run: it is the command, and its lanes, as well
 * as the parser. It is imported under a command line its main would refuse
 * before any work — some units, one that does not exist, with nowhere of their
 * own to write — so that a main run on import shows as that refusal, and sets
 * the exit code, rather than starting the sweep inside a test.
 */
async function importTool(): Promise<typeof import('../../../tools/reader-acceptance.ts')> {
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = [argv[0], 'imported by a test', '--only', 'no-such-unit'];
  try {
    const tool = await import('../../../tools/reader-acceptance.ts');
    assert.equal(process.exitCode, exitCode, 'importing the tool ran its main');
    return tool;
  } finally {
    process.argv = argv;
  }
}

test('a run of some units is refused before any work where it would write over the whole sweep', async () => {
  const { parseArgs } = await importTool();
  const refusal = /reader-acceptance: --only runs part of the sweep, .*Name another file with --out\.$/;
  assert.throws(() => parseArgs(['--only', 'main:0']), refusal, 'with no --out');
  assert.throws(() => parseArgs(['--only', 'main:0', '--out', REGISTERED]), refusal, 'with the record named');
  assert.throws(() => parseArgs(['--out', REGISTERED, '--only', 'main:0,spill:3']), refusal, 'either order');

  const elsewhere = path.join(os.tmpdir(), 'reader-acceptance-main-0.json');
  assert.deepEqual(parseArgs(['--only', 'main:0', '--out', elsewhere, '--lanes', '2']), {
    lanes: 2,
    only: ['main:0'],
    out: elsewhere,
  });
  // The whole sweep still writes its record, where the docs' table reads it.
  assert.equal(parseArgs(['--lanes', '4']).out, REGISTERED);
  assert.equal(parseArgs(['--lanes', '4', '--out', elsewhere]).out, elsewhere);
});
