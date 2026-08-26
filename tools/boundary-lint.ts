// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * boundary-lint — the CI rule that keeps the forward model and the inverse
 * model from ever touching each other.
 *
 * Three rules, all fatal:
 *
 *   R1  Nothing under packages/sim may import anything under packages/solver,
 *       and nothing under packages/solver may import anything under
 *       packages/sim. Not directly, not transitively through a third package,
 *       not via a dynamic import, not via a re-export.
 *
 *   R2  packages/calibration contains no executable mathematics. No arithmetic
 *       operators, no Math.*, no callable declarations. It is a bag of numbers
 *       and the prose describing what the numbers mean.
 *
 *   R3  packages/calibration may not import from sim or solver. The boundary
 *       object cannot depend on either side of the boundary.
 *
 * Run: node tools/boundary-lint.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Root is overridable so the rule can be tested against fixture trees that
// deliberately violate it. A lint rule nobody has watched fail is not a rule.
const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'packages');

interface Violation {
  rule: 'R1' | 'R2' | 'R3';
  file: string;
  line: number;
  message: string;
}

const violations: Violation[] = [];

/** Which top-level package a file belongs to, or null if outside packages/. */
function packageOf(file: string): string | null {
  const rel = path.relative(PKG, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  return first ?? null;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `dist` is skipped only where a build actually writes it — directly under a
      // package root. Pruning the name at any depth meant packages/solver/src/dist/
      // was unscannable: plain TypeScript, imported normally, invisible to every
      // rule below. A guard with a directory name as its escape hatch is not a guard.
      if (entry.name === 'node_modules') continue;
      if (entry.name === 'dist' && path.dirname(path.dirname(full)) === PKG) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every module specifier a file references, static or dynamic. */
function moduleSpecifiers(sf: ts.SourceFile): { text: string; pos: number }[] {
  const specs: { text: string; pos: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push({ text: node.moduleSpecifier.text, pos: node.moduleSpecifier.getStart(sf) });
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const arg = node.arguments[0];
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteral(arg)) {
        specs.push({ text: arg.text, pos: arg.getStart(sf) });
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const lit = node.argument.literal;
      if (ts.isStringLiteral(lit)) specs.push({ text: lit.text, pos: node.getStart(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/**
 * Every package directory, mapped from the bare specifiers that could name it.
 *
 * Relative-path checking alone is too narrow, and the failure mode is silent.
 * Today the repo has no workspaces and no tsconfig `paths`, so `packages/sim`
 * can only be reached as `../../sim/src/...` — but every source header in the
 * repo already calls these packages `@sphere/sim`, `@sphere/solver` and
 * `@sphere/calibration`. The day someone adds a `workspaces` field or a path
 * alias, `import { ... } from '@sphere/sim'` starts resolving, R1 stops
 * matching, and the lint keeps cheerfully printing `0 violations` while the
 * boundary is gone. For a rule whose failure mode is "every score in the
 * project becomes circular", going quiet is the one behaviour it must never
 * have. So bare specifiers are resolved too, and an unknown `@sphere/*` scope
 * is an error rather than a shrug.
 */
function knownPackages(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(PKG)) return map;
  for (const entry of fs.readdirSync(PKG, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    map.set(`@sphere/${entry.name}`, entry.name);
    map.set(entry.name, entry.name);
    // Honour an explicit package name if one is ever declared.
    const manifest = path.join(PKG, entry.name, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
        if (typeof name === 'string' && name.length > 0) map.set(name, entry.name);
      } catch {
        // A malformed manifest is not this rule's problem; the conventional
        // names above still cover it.
      }
    }
  }
  return map;
}

const PACKAGE_BY_SPECIFIER = knownPackages();

/** The package a specifier points at, whether written relative or bare. */
function resolveTargetPackage(fromFile: string, spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    return packageOf(path.resolve(path.dirname(fromFile), spec));
  }
  // Bare: match the longest known package name that the specifier starts with,
  // so `@sphere/sim` and `@sphere/sim/optics.ts` both resolve.
  for (const [name, dir] of PACKAGE_BY_SPECIFIER) {
    if (spec === name || spec.startsWith(`${name}/`)) return dir;
  }
  if (spec.startsWith('@sphere/')) {
    // An unrecognised name in our own scope. Refuse to guess.
    return '__unknown_sphere_package__';
  }
  return null;
}

const ARITHMETIC = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
]);

/** R2: prove the calibration package holds no computation. */
function checkNoMath(sf: ts.SourceFile, file: string): void {
  const report = (node: ts.Node, what: string): void => {
    violations.push({
      rule: 'R2',
      file,
      line: lineOf(sf, node.getStart(sf)),
      message: `${what} in the calibration package. The boundary object is a bag of numbers with zero math; if a value needs deriving, write the derivation in a note and the result as a literal.`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ARITHMETIC.has(node.operatorToken.kind)) {
      report(node, `arithmetic operator '${node.operatorToken.getText(sf)}'`);
    }
    // Unary minus on a numeric literal is a negative constant, not arithmetic.
    if (ts.isPrefixUnaryExpression(node)) {
      const isNegativeLiteral =
        (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
        ts.isNumericLiteral(node.operand);
      if (!isNegativeLiteral && node.operator !== ts.SyntaxKind.ExclamationToken) {
        report(node, 'unary arithmetic');
      }
    }
    if (ts.isPostfixUnaryExpression(node)) report(node, 'increment or decrement');
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Math'
    ) {
      report(node, `'Math.${node.name.getText(sf)}'`);
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      report(node, 'a callable declaration');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const files = walk(PKG).concat(process.argv[2] ? [] : walk(path.join(ROOT, 'tools')));

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const pkg = packageOf(file);

  // R2 constrains what the boundary object SHIPS, so it exempts tests only. The
  // tests that exercise this rule necessarily contain functions and arithmetic;
  // they are not part of the published bag of numbers.
  //
  // It used to be scoped to src/ instead, which is not the same thing: R1 lets
  // both sim and solver import packages/calibration, so anything ELSE under
  // calibration — lib/, util/, a stray helpers.ts — was importable by both sides
  // and never checked for math. That is precisely the erosion path R1's own
  // message warns about, with the check that would have caught it turned off.
  const segment = path.relative(PKG, file).split(path.sep)[1];
  if (pkg === 'calibration' && segment !== 'test') checkNoMath(sf, file);

  for (const spec of moduleSpecifiers(sf)) {
    const targetPkg = resolveTargetPackage(file, spec.text);
    if (targetPkg === null || pkg === null || targetPkg === pkg) continue;

    const line = lineOf(sf, spec.pos);
    // sim and solver may reach exactly one package: calibration. Naming solver
    // directly is the obvious violation; a shared "utils" package is the
    // non-obvious one, and it is the same violation with an extra hop, so the
    // rule is stated as an allowlist rather than a denylist.
    if ((pkg === 'sim' || pkg === 'solver') && targetPkg !== 'calibration') {
      const direct =
        (pkg === 'sim' && targetPkg === 'solver') || (pkg === 'solver' && targetPkg === 'sim');
      violations.push({
        rule: 'R1',
        file,
        line,
        message: direct
          ? `packages/${pkg} imports packages/${targetPkg} ('${spec.text}'). The forward and inverse models share no geometry, no projection math, no distortion model. Duplicate the code instead — the duplication is the point.`
          : `packages/${pkg} imports packages/${targetPkg} ('${spec.text}'). sim and solver may import packages/calibration and nothing else. A shared helper package is how the boundary erodes: today it holds a PRNG, next month it holds a distortion model, and every recovery score becomes circular.`,
      });
    }
    if (pkg === 'calibration' && (targetPkg === 'sim' || targetPkg === 'solver')) {
      violations.push({
        rule: 'R3',
        file,
        line,
        message: `packages/calibration imports packages/${targetPkg} ('${spec.text}'). The boundary object may not depend on either side of the boundary.`,
      });
    }
  }
}

const bySeverity = violations.sort((a, b) => (a.rule < b.rule ? -1 : 1));
if (bySeverity.length > 0) {
  console.error('\nBOUNDARY VIOLATIONS\n');
  for (const v of bySeverity) {
    console.error(`  ${v.rule} ${path.relative(ROOT, v.file)}:${v.line}`);
    console.error(`     ${v.message}\n`);
  }
  console.error(`${bySeverity.length} violation(s). See packages/sim/README.md for why this rule exists.\n`);
  process.exit(1);
}

console.log(`boundary-lint: ${files.length} files, 0 violations (R1 A/B isolation, R2 calibration is math-free, R3 calibration depends on neither side).`);
