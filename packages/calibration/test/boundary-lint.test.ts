/**
 * Tests for the rule that keeps the project honest.
 *
 * The boundary lint is the only mechanical guarantee that the simulator is not
 * scoring its own assumptions. An unexercised guard is not a guard, so each of
 * R1, R2 and R3 gets a fixture that must fail, plus a clean fixture that must
 * pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const LINTER = path.resolve(import.meta.dirname, '../../../tools/boundary-lint.ts');

interface Fixture {
  [relPath: string]: string;
}

function runLint(files: Fixture): { code: number; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-fixture-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    try {
      const out = execFileSync(process.execPath, [LINTER, root], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('R1: sim importing solver fails the build', () => {
  const r = runLint({
    'packages/solver/src/project.ts': 'export const q = 1;\n',
    'packages/sim/src/optics.ts': "import { q } from '../../solver/src/project.ts';\nexport const z = q;\n",
  });
  assert.equal(r.code, 1, 'expected a non-zero exit');
  assert.match(r.out, /R1/);
  assert.match(r.out, /share no geometry/);
});

test('R1: solver importing sim fails the build', () => {
  const r = runLint({
    'packages/sim/src/geometry.ts': 'export const q = 1;\n',
    'packages/solver/src/bundle.ts': "import { q } from '../../sim/src/geometry.ts';\nexport const z = q;\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /R1/);
});

test('R1: a dynamic import across the boundary fails too', () => {
  const r = runLint({
    'packages/sim/src/geometry.ts': 'export const q = 1;\n',
    'packages/solver/src/sneaky.ts':
      "export async function load() { return await import('../../sim/src/geometry.ts'); }\n",
  });
  assert.equal(r.code, 1, 'dynamic import must not be a loophole');
  assert.match(r.out, /R1/);
});

test('R1: a re-export across the boundary fails too', () => {
  const r = runLint({
    'packages/sim/src/geometry.ts': 'export const q = 1;\n',
    'packages/solver/src/reexport.ts': "export { q } from '../../sim/src/geometry.ts';\n",
  });
  assert.equal(r.code, 1, 're-export must not be a loophole');
  assert.match(r.out, /R1/);
});

test('R1: an import type across the boundary fails too', () => {
  const r = runLint({
    'packages/sim/src/geometry.ts': 'export type Q = number;\n',
    'packages/solver/src/t.ts': "export type Z = import('../../sim/src/geometry.ts').Q;\n",
  });
  assert.equal(r.code, 1, 'type-only imports still couple the two models');
});

test('R2: arithmetic in the calibration package fails the build', () => {
  const r = runLint({
    'packages/calibration/src/index.ts': 'export const R = 1.7272 / 2;\n',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /R2/);
  assert.match(r.out, /bag of numbers/);
});

test('R2: a helper function in the calibration package fails the build', () => {
  const r = runLint({
    'packages/calibration/src/index.ts':
      'export function distort(x: number): number { return x; }\n',
  });
  assert.equal(r.code, 1, 'even a math-free helper is a shared implementation');
  assert.match(r.out, /R2/);
});

test('R2: Math.* in the calibration package fails the build', () => {
  const r = runLint({
    'packages/calibration/src/index.ts': 'export const HALF_FOV = Math.PI;\n',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /R2/);
});

test('R2: negative literals are constants, not arithmetic', () => {
  const r = runLint({
    'packages/calibration/src/index.ts': 'export const SHIFT = { v: -0.25, h: 0.0 };\n',
  });
  assert.equal(r.code, 0, `negative constants must be allowed, got: ${r.out}`);
});

test('R1: a shared third package is the same violation with an extra hop', () => {
  const r = runLint({
    'packages/util/src/prng.ts': 'export const seed = 1;\n',
    'packages/sim/src/scene.ts': "import { seed } from '../../util/src/prng.ts';\nexport const s = seed;\n",
  });
  assert.equal(r.code, 1, 'sim and solver may import calibration and nothing else');
  assert.match(r.out, /R1/);
  assert.match(r.out, /how the boundary erodes/);
});

test('R1: a BARE specifier across the boundary fails too', () => {
  // The lint originally checked relative paths only. That is correct today and
  // silently wrong the moment anyone adds workspaces or a tsconfig path alias —
  // and a boundary rule that goes quiet is worse than no rule, because the
  // "0 violations" line keeps being printed.
  const r = runLint({
    'packages/sim/src/geometry.ts': 'export const q = 1;\n',
    'packages/solver/src/bundle.ts': "import { q } from '@sphere/sim';\nexport const z = q;\n",
  });
  assert.equal(r.code, 1, 'bare specifiers must not be a loophole');
  assert.match(r.out, /R1/);
});

test('R1: a bare deep import across the boundary fails too', () => {
  const r = runLint({
    'packages/solver/src/project.ts': 'export const q = 1;\n',
    'packages/sim/src/optics.ts': "import { q } from '@sphere/solver/project.ts';\nexport const z = q;\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /R1/);
});

test('R1: an unrecognised @sphere package is refused rather than ignored', () => {
  const r = runLint({
    'packages/sim/src/optics.ts': "import { q } from '@sphere/geometry-utils';\nexport const z = q;\n",
  });
  assert.equal(r.code, 1, 'an unknown name in our own scope must not be waved through');
});

test('bare imports of third-party and node builtins are still fine', () => {
  const r = runLint({
    'packages/sim/src/png.ts': "import zlib from 'node:zlib';\nimport ts from 'typescript';\nexport const z = [zlib, ts];\n",
  });
  assert.equal(r.code, 0, `only @sphere packages are the lint's business: ${r.out}`);
});

test('R3: calibration importing sim fails the build', () => {
  const r = runLint({
    'packages/sim/src/geometry.ts': 'export const q = 1;\n',
    'packages/calibration/src/index.ts': "export { q } from '../../sim/src/geometry.ts';\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /R3/);
});

test('both sides importing calibration is fine', () => {
  const r = runLint({
    'packages/calibration/src/index.ts': 'export interface Cal { fovHDeg: number }\n',
    'packages/sim/src/optics.ts':
      "import type { Cal } from '../../calibration/src/index.ts';\nexport const f = (c: Cal) => c.fovHDeg;\n",
    'packages/solver/src/project.ts':
      "import type { Cal } from '../../calibration/src/index.ts';\nexport const g = (c: Cal) => c.fovHDeg;\n",
  });
  assert.equal(r.code, 0, `the boundary object must be importable by both: ${r.out}`);
});

test('the real repository passes its own rule', () => {
  const out = execFileSync(process.execPath, [LINTER], { encoding: 'utf8' });
  assert.match(out, /0 violations/);
});

// The two holes below were found by an adversarial review that reproduced them
// against the real linter: both fixtures printed "0 violations, exit 0" before
// the fix. They are the failure the lint exists to prevent — solver executing
// sim's own distortion math — reached by walking around the scan rather than by
// breaking a rule.

test('R1: a directory named dist BELOW a package src is still scanned', () => {
  // `dist` used to be pruned at any depth, so packages/solver/src/dist/ was
  // unreachable by every rule while being ordinary, importable TypeScript.
  const r = runLint({
    'packages/sim/src/optics.ts':
      'export function undistort(x: number, k1: number): number { return x * (1 + k1 * x * x); }\n',
    'packages/solver/src/dist/leak.ts': "export { undistort } from '../../../sim/src/optics.ts';\n",
  });
  assert.notEqual(r.code, 0, `a re-export hidden in src/dist passed the lint:\n${r.out}`);
  assert.match(r.out, /R1/);
});

test('R1: a real build output directory is still skipped', () => {
  // The narrowing must not cost the lint its reason for skipping dist at all:
  // packages/<pkg>/dist is compiler output and contains whatever src contains.
  const r = runLint({
    'packages/calibration/src/index.ts': 'export const R = 0.8636;\n',
    'packages/solver/dist/main.js.ts': "export { R } from '../../sim/src/optics.ts';\n",
  });
  assert.equal(r.code, 0, `a package-root dist/ was scanned when it should not be:\n${r.out}`);
});

test('R2: math anywhere in calibration fails, not only under src/', () => {
  // R1 lets BOTH sides import packages/calibration, so a helper parked outside
  // src/ was shared executable math with the math check switched off — the exact
  // erosion path R1's own violation message describes.
  const r = runLint({
    'packages/calibration/src/index.ts': 'export const R = 0.8636;\n',
    'packages/calibration/lib/math.ts':
      'export function scale(a: number, b: number): number { return a * b; }\n',
  });
  assert.notEqual(r.code, 0, `executable math outside calibration/src passed the lint:\n${r.out}`);
  assert.match(r.out, /R2/);
});

test('R2: the calibration tests may still contain arithmetic', () => {
  const r = runLint({
    'packages/calibration/src/index.ts': 'export const R = 0.8636;\n',
    'packages/calibration/test/r.test.ts': 'const twice = 0.8636 * 2;\nexport { twice };\n',
  });
  assert.equal(r.code, 0, `the exemption for calibration's own tests was lost:\n${r.out}`);
});
