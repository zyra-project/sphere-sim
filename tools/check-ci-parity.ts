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

/**
 * Every workflow that runs checks, and the script a contributor runs instead.
 *
 * A LIST, because the moment there was a second workflow this tool went blind
 * to it. `solve-smoke.yml` exists precisely because three checks behind
 * `--solve` had never run in CI and two of them were broken on `main`; adding
 * it without adding it here would have left the new job unmirrored — a workflow
 * step with no script to reproduce it, which is the first of the two drifts
 * this file was written about.
 *
 * A workflow not named here is not checked, so a third one must be added to
 * this list. That is a real sharp edge and it is the reason this comment is
 * longer than the array.
 */
/**
 * Is this filename one GitHub Actions will actually run?
 *
 * BOTH extensions, because Actions loads `.yml` and `.yaml` alike. The
 * accompanying test's directory walk filtered on `.yml` only, so a
 * `.github/workflows/foo.yaml` would have run npm steps while sitting in
 * neither `MIRRORED` nor `UNMIRRORED` and failing nothing — the blind spot that
 * test exists to close, reopened one character wide. Caught in review on the
 * pull request that added the walk.
 *
 * Here rather than inline in the test so the rule is one thing with one test on
 * it, and so any future walk gets it right by construction rather than by
 * whoever writes it remembering.
 */
export function isWorkflowFile(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

export const MIRRORED: readonly { workflow: string; script: string }[] = [
  { workflow: '.github/workflows/ci.yml', script: 'ci' },
  { workflow: '.github/workflows/solve-smoke.yml', script: 'ci:solve' },
];

/**
 * Workflows that run npm steps and are deliberately NOT mirrored, with the
 * reason each is out of scope.
 *
 * Exempt ON PURPOSE AND IN WRITING, rather than by not being thought about. The
 * accompanying test walks the workflow directory and requires every file to be
 * in one list or the other, so a new workflow is a failing test on the day it
 * lands instead of a job nobody compares against anything.
 *
 * Both entries below are deploys rather than checks, and both are a real if
 * narrower version of the drift this file is about: `build:site` and
 * `pack:skill` are in no `ci` script, so they can only go red on `main`, after
 * a pull request was green. Mirroring them would mean a script per deploy and
 * is a larger decision than this list; recording the gap is the part that
 * should not wait for it.
 */
export const UNMIRRORED: readonly { workflow: string; because: string }[] = [
  {
    workflow: 'pages.yml',
    because:
      'a deploy, not a check. Its `lint:boundary` is already in `ci`; its `build:site` is not, ' +
      'so a site build that breaks is a red main rather than a red pull request.',
  },
  {
    workflow: 'release.yml',
    because:
      'a publish. `pack:skill` runs nowhere else, so a packaging break surfaces on main at ' +
      'release time.',
  },
];

export function check(repo: string): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const problems: string[] = [];
  for (const { workflow, script } of MIRRORED) {
    const file = path.join(repo, workflow);
    if (!fs.existsSync(file)) {
      problems.push(`${workflow} is named as a mirrored workflow and does not exist`);
      continue;
    }
    const yaml = fs.readFileSync(file, 'utf8');
    const body = pkg.scripts[script] ?? '';
    if (body === '') {
      problems.push(
        `package.json has no \`${script}\` script for ${workflow} to be compared against`,
      );
      continue;
    }
    const { onlyInWorkflow, onlyInScript } = compare(yaml, body);
    for (const s of onlyInWorkflow) {
      problems.push(
        `${workflow} runs \`${s}\` and \`npm run ${script}\` does not — a contributor's green ` +
          'sweep can still go red in CI',
      );
    }
    for (const s of onlyInScript) {
      problems.push(
        `\`npm run ${script}\` runs \`${s}\` and ${workflow} does not — the check passes ` +
          'locally and guards nothing',
      );
    }
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
    // Every pair, named. The single-line summary used to say "the workflow",
    // which would now be true of one of them and silent about the other.
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const { workflow, script } of MIRRORED) {
      const n = scriptSteps(pkg.scripts[script] ?? '').length;
      process.stdout.write(
        `check:ci-parity: \`npm run ${script}\` and ${workflow} run the same ${n} checks\n`,
      );
    }
  }
}
