// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * check-citation — CITATION.cff must not drift from package.json.
 *
 * Zenodo mints a DOI per GitHub Release and reads CITATION.cff for the metadata
 * that goes with it. A release whose citation file still says the previous
 * version produces an archived record that misstates what it archived, and
 * nothing downstream notices — the DOI is minted, the page looks right, and the
 * version field is simply wrong forever.
 *
 * So the two are checked against each other here rather than kept in step by
 * memory, in the same spirit as check:docs and progress:reference:check.
 *
 * CITATION.cff is YAML and this repository has no runtime dependencies, so this
 * reads the two top-level scalars it needs rather than pulling in a parser. That
 * is deliberate and it is also the limit of what this file should ever do: if
 * this check needs to understand nested YAML, add the dependency instead of
 * growing a parser here.
 *
 * Run: node tools/check-citation.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A top-level `key: value` scalar, unquoted. Indented lines are ignored. */
export function topLevelScalar(cff: string, key: string): string | null {
  for (const line of cff.split('\n')) {
    if (/^\s/.test(line)) continue;
    const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`).exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

export function check(root: string): string[] {
  const problems: string[] = [];
  const cffPath = path.join(root, 'CITATION.cff');
  if (!fs.existsSync(cffPath)) return ['CITATION.cff is missing'];

  const cff = fs.readFileSync(cffPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    version: string;
    license?: string;
  };

  const cffVersion = topLevelScalar(cff, 'version');
  if (cffVersion === null) problems.push('CITATION.cff has no top-level `version`');
  else if (cffVersion !== pkg.version) {
    problems.push(
      `CITATION.cff version ${cffVersion} does not match package.json ${pkg.version}. ` +
        'Bump both together — the release workflow tags whatever package.json says.',
    );
  }

  // Required by the CFF 1.2.0 schema. A file missing these still parses as YAML
  // and is silently useless to Zenodo.
  for (const key of ['cff-version', 'message', 'title']) {
    if (topLevelScalar(cff, key) === null) problems.push(`CITATION.cff has no top-level \`${key}\``);
  }
  if (!/^authors:/m.test(cff)) problems.push('CITATION.cff has no `authors`');

  // A LICENSE file that nothing else names is a licence nobody downstream sees:
  // Zenodo reads CITATION.cff and tooling reads package.json, and neither opens
  // the file. v0.1.0 shipped that way, so the three are now checked together.
  const pkgLicense = pkg.license;
  const cffLicense = topLevelScalar(cff, 'license');
  if (fs.existsSync(path.join(root, 'LICENSE'))) {
    if (cffLicense === null) problems.push('a LICENSE file exists but CITATION.cff names no `license`');
    if (pkgLicense === undefined) problems.push('a LICENSE file exists but package.json has no `license`');
    if (cffLicense !== null && pkgLicense !== undefined && cffLicense !== pkgLicense) {
      problems.push(`CITATION.cff license ${cffLicense} does not match package.json ${pkgLicense}`);
    }
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = check(process.argv[2] ? path.resolve(process.argv[2]) : ROOT);
  for (const p of problems) console.error(`check:citation: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log('check:citation: CITATION.cff agrees with package.json');
}
