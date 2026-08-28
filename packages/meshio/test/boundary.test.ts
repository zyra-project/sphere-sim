// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Neither model may reach this package.
 *
 * `tools/boundary-lint.ts` already forbids it in general — R1 is an allowlist,
 * and its own fixture "a shared third package is the same violation with an
 * extra hop" covers exactly this shape. So why a second test?
 *
 * Because the general rule fails with a general message, and the reasoning that
 * put a GLB reader in its own package is specific: a loader is the most
 * plausible-looking thing anyone would ever want to share across the boundary.
 * It is pure IO, it holds no geometry, and duplicating it feels like waste — the
 * exact argument that would be made for sharing a PRNG, then a distortion model.
 * A test that names this package makes the answer findable by whoever is about
 * to make it.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourcesOf(pkg: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(path.join(PACKAGES, pkg));
  return out;
}

for (const pkg of ['sim', 'solver']) {
  test(`packages/${pkg} does not reach packages/meshio`, () => {
    const offenders: string[] = [];
    for (const file of sourcesOf(pkg)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*meshio/.test(src) || /import\s*\(\s*['"][^'"]*meshio/.test(src)) {
        offenders.push(path.relative(PACKAGES, file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `packages/${pkg} imports packages/meshio. A loader looks like the safest thing ` +
        `to share across the boundary and is not: the mesh crosses as DATA and each ` +
        `side builds its own traversal. See packages/calibration/src/mesh.ts.`,
    );
  });
}

test('meshio itself reaches only the boundary object', () => {
  // It may read `calibration` for the type it produces. Anything else — and in
  // particular `sim`, whose MeshSurface would be convenient here — would make
  // this package a path between the two models rather than a leaf.
  for (const file of sourcesOf('meshio')) {
    if (file.includes(`${path.sep}test${path.sep}`)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      // A bare `@sphere/*` specifier names a package too, and skipping it left
      // this test blind to the most direct violation it exists to catch:
      // `import { meshSurface } from '@sphere/sim'` passed. `tools/boundary-lint.ts`
      // already resolves these for exactly this reason — the modules call
      // themselves `@sphere/sim` and `@sphere/calibration` in their own headers,
      // so the day someone adds a workspaces field or a path alias the form
      // starts resolving — and a test named "meshio reaches only the boundary
      // object" should not be the one place that reading is missing.
      let rel: string;
      if (spec.startsWith('@sphere/')) {
        rel = spec.slice('@sphere/'.length).split('/')[0];
      } else if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        rel = path.relative(PACKAGES, target).split(path.sep)[0];
      } else {
        continue;
      }
      assert.ok(
        rel === 'calibration' || rel === 'meshio',
        `${path.relative(PACKAGES, file)} imports packages/${rel}; meshio may reach only calibration`,
      );
    }
  }
});
