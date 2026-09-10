// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The check on the checks.
 *
 * `tools/check-ci-parity.ts` compares what the GitHub workflow runs against what
 * `npm run ci` runs. This tests that comparison — separately from running it,
 * because a parity check that silently matched nothing would report parity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { check, compare, scriptSteps, workflowSteps } from '../../../tools/check-ci-parity.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');

const YAML = `
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Lint
        run: npm run lint:boundary
      # A comment mentioning npm run check:license must not count as a step.
      - name: Build the browser bundles
        run: |
          npm run build:web
          npm run build:app
      - name: Gates
        run: npm run gate -- bench-results.json
`;

test('a workflow step is found whether it is inline or in a run block', () => {
  assert.deepEqual(workflowSteps(YAML), [
    'npm run lint:boundary',
    'npm run build:web',
    'npm run build:app',
    'npm run gate -- bench-results.json',
  ]);
});

test('`npm ci` is an install rather than a check, and does not count', () => {
  assert.ok(!workflowSteps(YAML).includes('npm ci'));
});

test('a comment naming a script does not count as running it', () => {
  // The parity check's own comments name the scripts they are about, so a
  // comparison that read comments would report a workflow running checks it
  // merely discusses — and would go green on a step somebody had commented out.
  assert.ok(!workflowSteps(YAML).includes('npm run check:license'));
  assert.ok(!workflowSteps('      # run: npm run check:license').length);
});

test('arguments are part of the invocation, not noise', () => {
  // `gate -- bench-results.json` and a bare `gate` are different runs: one
  // judges a file that exists and one fails for want of it. A comparison that
  // stripped arguments would call them equal.
  const { onlyInWorkflow, onlyInScript } = compare(YAML, 'npm run gate');
  assert.ok(onlyInWorkflow.includes('npm run gate -- bench-results.json'));
  assert.ok(onlyInScript.includes('npm run gate'));
});

test('order is deliberately not compared', () => {
  // The bundles must be built before the smoke serves them, and that ordering is
  // the workflow's to state. A script chaining with `&&` cannot express
  // parallelism if the workflow ever gains any, so encoding order here would be
  // a second opinion about it.
  const same = compare(YAML, 'npm run gate -- bench-results.json && npm run build:app && npm run build:web && npm run lint:boundary');
  assert.deepEqual(same, { onlyInWorkflow: [], onlyInScript: [] });
});

test('drift is reported in the direction it happened', () => {
  const missingLocally = compare(YAML, 'npm run lint:boundary');
  assert.ok(
    missingLocally.onlyInWorkflow.includes('npm run build:web'),
    'a step CI runs and the script does not was not reported',
  );
  const missingInCi = compare('- run: npm run lint:boundary', 'npm run lint:boundary && npm run check:license');
  assert.ok(
    missingInCi.onlyInScript.includes('npm run check:license'),
    'a check the script runs and CI does not was not reported — the dangerous direction',
  );
});

test('this repository is in parity right now', () => {
  assert.deepEqual(check(REPO), []);
});

test('and the comparison is not vacuous on this repository', () => {
  // The two failures above are on fixtures. This is the guard against the
  // parity check passing because it found nothing to compare: if either reader
  // returned an empty list, `check` would report parity between two empty sets.
  const yaml = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.ok(workflowSteps(yaml).length >= 10, 'the workflow reader found almost nothing');
  assert.ok(scriptSteps(pkg.scripts.ci).length >= 10, 'the script reader found almost nothing');
});
