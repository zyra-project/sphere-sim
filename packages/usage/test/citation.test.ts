/**
 * The citation file.
 *
 * Zenodo mints a DOI per GitHub Release and takes its metadata from
 * CITATION.cff. A release whose citation file still names the previous version
 * produces an archived record that misstates what it archived — and nothing
 * downstream notices, because the DOI is minted, the landing page looks right,
 * and the version field is simply wrong in perpetuity. So the pairing is checked
 * mechanically rather than remembered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { check, topLevelScalar } from '../../../tools/check-citation.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');

function fixture(
  cff: string | null,
  version = '1.2.3',
  opts: { license?: string; pkgLicense?: string } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cff-'));
  const pkg: Record<string, string> = { version };
  if (opts.pkgLicense !== undefined) pkg['license'] = opts.pkgLicense;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  if (cff !== null) fs.writeFileSync(path.join(root, 'CITATION.cff'), cff);
  if (opts.license !== undefined) fs.writeFileSync(path.join(root, 'LICENSE'), opts.license);
  return root;
}

const GOOD = `cff-version: 1.2.0
message: Cite it like this.
title: "a thing"
authors:
  - family-names: Doe
    given-names: Jane
version: 1.2.3
`;

test('this repository is releasable as it stands', () => {
  assert.deepEqual(check(REPO), []);
});

test('a version that drifts from package.json is caught', () => {
  const problems = check(fixture(GOOD.replace('version: 1.2.3', 'version: 1.2.2')));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1\.2\.2 does not match package\.json 1\.2\.3/);
});

test('the fields Zenodo needs are required, not merely conventional', () => {
  // A file missing these still parses as YAML and is silently useless.
  for (const [drop, expected] of [
    ['cff-version: 1.2.0\n', /cff-version/],
    ['message: Cite it like this.\n', /message/],
    ['title: "a thing"\n', /title/],
  ] as const) {
    const problems = check(fixture(GOOD.replace(drop, '')));
    assert.ok(problems.some((p) => expected.test(p)), `${drop} went unnoticed`);
  }
  const noAuthors = check(fixture(GOOD.replace(/authors:\n(  - .*\n)+/, '')));
  assert.ok(noAuthors.some((p) => /authors/.test(p)));
});

test('a missing citation file is reported, not thrown on', () => {
  assert.deepEqual(check(fixture(null)), ['CITATION.cff is missing']);
});

test('topLevelScalar ignores nested keys of the same name', () => {
  // `version:` also appears under some nested blocks in real CFF files; reading
  // the first match anywhere would pick up whichever came first in the file.
  const nested = `title: t
identifiers:
  - type: doi
    version: 9.9.9
version: 1.0.0
`;
  assert.equal(topLevelScalar(nested, 'version'), '1.0.0');
});

test('quotes are stripped, so a quoted version still compares equal', () => {
  assert.equal(topLevelScalar('version: "1.2.3"\n', 'version'), '1.2.3');
  assert.equal(topLevelScalar("version: '1.2.3'\n", 'version'), '1.2.3');
});

test('a LICENSE nothing else names is caught', () => {
  // v0.1.0 shipped exactly this way. Zenodo reads CITATION.cff and tooling reads
  // package.json; neither opens the file, so an unnamed licence is invisible
  // downstream and the archived record says all-rights-reserved.
  const problems = check(fixture(GOOD, '1.2.3', { license: 'Apache License...' }));
  assert.ok(problems.some((p) => /CITATION\.cff names no `license`/.test(p)));
  assert.ok(problems.some((p) => /package\.json has no `license`/.test(p)));
});

test('a licence named in only one of the two is caught', () => {
  const onlyCff = check(
    fixture(GOOD + 'license: Apache-2.0\n', '1.2.3', { license: 'x' }),
  );
  assert.ok(onlyCff.some((p) => /package\.json has no `license`/.test(p)));
  assert.ok(!onlyCff.some((p) => /CITATION\.cff names no/.test(p)));
});

test('two licences that disagree are caught', () => {
  const problems = check(
    fixture(GOOD + 'license: MIT\n', '1.2.3', { license: 'x', pkgLicense: 'Apache-2.0' }),
  );
  assert.ok(problems.some((p) => /MIT does not match package\.json Apache-2\.0/.test(p)));
});

test('no LICENSE file means the licence fields are not required', () => {
  // Not every repository has settled on one, and demanding the field before the
  // decision is made would be a check nobody can satisfy.
  assert.deepEqual(check(fixture(GOOD)), []);
});
