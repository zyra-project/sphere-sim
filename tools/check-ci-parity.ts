// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run ci` and the GitHub workflow run the same checks.
 *
 * ## Why this is a gate rather than a convention
 *
 * The two lists drifted apart in BOTH directions and neither drift announced
 * itself, because the failure mode of a check that does not run is silence.
 *
 *   - `check:citation` and `check:license` were in the script and in no workflow
 *     step. A source file with no SPDX header, or a CITATION.cff fallen behind
 *     `package.json`, merged clean for as long as both checks had existed. This
 *     is the dangerous direction: the check exists, passes locally, and guards
 *     nothing.
 *   - `bench`, its determinism re-run, `check:bench`, `gate` and `build:web`
 *     were in the workflow and not in the script. That is the direction that
 *     merely wastes a cycle, and it did: a locally-green sweep went red at
 *     `check:bench` because a mask change had moved 39 recorded digests.
 *
 * Both were found by reading the two files side by side, which is exactly the
 * check that stops happening.
 *
 * ## What it compares, and what it deliberately does not
 *
 * The SET of npm invocations, with arguments, ignoring order. Order is a real
 * property — the bundles must be built before the smoke serves them — but it is
 * the workflow's to state, and a script that chains with `&&` cannot express the
 * workflow's parallelism if it ever gains any. Encoding order here would be a
 * second opinion about it.
 *
 * `npm ci` (the install) is not a check and is excluded by name.
 *
 * A step that is not an `npm run` is invisible to this comparison, which is how
 * the determinism check hid: it was two bare lines, one of them
 * `node tools/assert-deterministic.ts`. It is `npm run check:determinism` now,
 * and the rule that follows is worth stating plainly — A WORKFLOW STEP THAT IS
 * NOT AN `npm run` CANNOT BE MIRRORED AND WILL NOT BE NOTICED.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Every `npm …` invocation in a workflow file, in the order they appear. */
export function workflowSteps(yaml: string): string[] {
  const out: string[] = [];
  for (const raw of yaml.split('\n')) {
    const line = raw.trim();
    // `run: npm …`, and the bare continuation lines of a `run: |` block. Both
    // are commands; a comment mentioning one is not, so `#` lines never match.
    const m = /^(?:-\s*)?(?:run:\s*)?(npm\s+.*)$/.exec(line);
    if (m === null || line.startsWith('#')) continue;
    const cmd = m[1].trim();
    if (cmd === 'npm ci') continue;
    out.push(cmd);
  }
  return out;
}

/** Every `npm …` invocation the `ci` script chains, in order. */
export function scriptSteps(ciScript: string): string[] {
  return ciScript
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('npm '));
}

export interface Parity {
  onlyInWorkflow: string[];
  onlyInScript: string[];
}

export function compare(yaml: string, ciScript: string): Parity {
  const wf = new Set(workflowSteps(yaml));
  const sc = new Set(scriptSteps(ciScript));
  return {
    onlyInWorkflow: [...wf].filter((s) => !sc.has(s)).sort(),
    onlyInScript: [...sc].filter((s) => !wf.has(s)).sort(),
  };
}

export function check(repo: string): string[] {
  const yaml = fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const ci = pkg.scripts.ci ?? '';
  if (ci === '') return ['package.json has no `ci` script for the workflow to be compared against'];

  const { onlyInWorkflow, onlyInScript } = compare(yaml, ci);
  const problems: string[] = [];
  for (const s of onlyInWorkflow) {
    problems.push(
      `the workflow runs \`${s}\` and \`npm run ci\` does not — a contributor's green sweep ` +
        'can still go red in CI',
    );
  }
  for (const s of onlyInScript) {
    problems.push(
      `\`npm run ci\` runs \`${s}\` and the workflow does not — the check passes locally and ` +
        'guards nothing on a pull request',
    );
  }
  return problems;
}

if (import.meta.filename === process.argv[1]) {
  const repo = path.resolve(import.meta.dirname, '..');
  const problems = check(repo);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`check:ci-parity: ${p}\n`);
    process.exitCode = 1;
  } else {
    const n = scriptSteps(
      (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }).scripts.ci,
    ).length;
    process.stdout.write(
      `check:ci-parity: \`npm run ci\` and the workflow run the same ${n} checks\n`,
    );
  }
}
