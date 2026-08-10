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
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
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

  // R2 constrains what the boundary object SHIPS, so it applies to src/ only.
  // The tests that exercise this rule necessarily contain functions and
  // arithmetic; they are not part of the published bag of numbers.
  const inSrc = path.relative(PKG, file).split(path.sep)[1] === 'src';
  if (pkg === 'calibration' && inSrc) checkNoMath(sf, file);

  for (const spec of moduleSpecifiers(sf)) {
    if (!spec.text.startsWith('.') && !spec.text.startsWith('/')) continue;
    const target = path.resolve(path.dirname(file), spec.text);
    const targetPkg = packageOf(target);
    if (targetPkg === null || pkg === null || targetPkg === pkg) continue;

    const line = lineOf(sf, spec.pos);
    const crosses =
      (pkg === 'sim' && targetPkg === 'solver') || (pkg === 'solver' && targetPkg === 'sim');
    if (crosses) {
      violations.push({
        rule: 'R1',
        file,
        line,
        message: `packages/${pkg} imports packages/${targetPkg} ('${spec.text}'). The forward and inverse models share no geometry, no projection math, no distortion model. Only @sphere/calibration crosses. Duplicate the code instead — the duplication is the point.`,
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
