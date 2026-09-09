// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Does the shader's `polarMask` compute what `packages/sim`'s does?
 *
 * ## The gap this closes
 *
 * `packages/harness` guards its shader with a headless chain: a line-for-line
 * TypeScript transliteration in `reference.ts`, a structural test that the two
 * function-name sets match, and `parity.test.ts` comparing the transliteration
 * against `packages/sim` on every configuration — including a dedicated test
 * that a DISABLED polar mask must be caught. That chain is thorough and this
 * file does not duplicate it.
 *
 * The page's shader is a different file, and its guards are different in kind:
 * `web/test/glsl.test.ts` reads the source for structural properties, and
 * `web/src/parity.ts` measures the real GL driver at runtime and puts the number
 * on screen. Both are deliberate — see `parity.ts` on why the last link belongs
 * in a browser. Neither compares the ARITHMETIC of a shader function against the
 * model headlessly, so nothing in CI would notice `polarMask` drifting in one
 * and not the other.
 *
 * That mattered when `bottomOnly`'s default moved (AMENDMENTS A-39). Four
 * implementations carry the same guard — `sim`'s, the harness transliteration,
 * and the two shaders — and the change was safe only because all four read the
 * same flag the same way. That was established by reading them side by side,
 * which is exactly the check that stops happening once nobody remembers to.
 *
 * ## How a shader function is executed without a GPU
 *
 * By translating it, from the shipped source text, under a whitelist that
 * REFUSES anything it does not recognise. The refusal is the safety property: a
 * translator that silently mishandles an unfamiliar construct would compare two
 * things neither of which is the shader, and agree. A translator that throws on
 * `mix(`, on a loop, on a swizzle, cannot — the test fails loudly and a human
 * decides whether to widen the whitelist or hand-write a transliteration.
 *
 * `polarMask` is a scalar function of one argument over four uniforms, with no
 * vectors, no loops and no texture reads, which is what makes this tractable.
 * The translation is small enough to audit in one sitting: GLSL's `1.0` and
 * `0.5` are already valid JavaScript numbers, its ternary and its comparison
 * operators are JavaScript's, and what is left is `float` declarations, three
 * builtin names, and `==`.
 *
 * The evaluator is proven non-vacuous by mutation: the last test corrupts the
 * shader text one term at a time and asserts the comparison FAILS each time. A
 * green agreement from a translator that always returns the model's own answer
 * would be worse than no test.
 *
 * ## What this does NOT check, and where that is checked instead
 *
 * The shader is declared `precision highp float`, so the GPU evaluates this in
 * float32 while both sides here are float64. What this file compares is the
 * ARITHMETIC — which expression, which branch, which operand in which order —
 * and it compares it exactly, because at equal precision any difference at all
 * is a difference in the expression rather than in the rounding.
 *
 * The rounding is a separate question and is not answerable in Node: it depends
 * on the driver. `web/src/parity.ts` asks it on the real GL context at runtime
 * and puts the number on the page, and `smoke:app` compiles the shader in
 * headless Chromium. Between them the three cover different failures — the
 * wrong formula, the wrong rounding, and the shader that will not compile —
 * and none of the three substitutes for another.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { polarMask } from '../../sim/src/coverage.ts';
import type { BlendCalibration } from '../../calibration/src/index.ts';
import type { MaskInterpretation } from '../../sim/src/coverage.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_GLSL = fs.readFileSync(path.join(HERE, '../src/glsl.ts'), 'utf8');
const HARNESS_GLSL = fs.readFileSync(path.join(HERE, '../../harness/src/glsl.ts'), 'utf8');

// ---------------------------------------------------------------------------
// A whitelist translator for scalar GLSL
// ---------------------------------------------------------------------------

/** GLSL builtins this translator knows. Anything else is refused. */
const BUILTINS: Record<string, string> = {
  abs: 'Math.abs',
  cos: 'Math.cos',
  sin: 'Math.sin',
  sqrt: 'Math.sqrt',
  min: 'Math.min',
  max: 'Math.max',
  PI: 'Math.PI',
};

/** The body of `float NAME(...) { ... }` in a shader source, or `null`. */
export function glslFunctionBody(source: string, name: string): string | null {
  const head = source.indexOf(`float ${name}(`);
  if (head < 0) return null;
  const open = source.indexOf('{', head);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Translate one scalar GLSL statement to JavaScript, or throw.
 *
 * Every rule is a whole-line pattern rather than a token rewrite, so a statement
 * shaped like nothing here — a loop, an assignment to a swizzle, a declaration
 * of a `vec3` — reaches the throw at the bottom instead of being half-handled.
 */
function translateStatement(line: string, known: Set<string>): string {
  const s = line.trim();
  if (s === '') return '';

  const decl = /^float\s+([A-Za-z_]\w*)\s*=\s*(.+);$/.exec(s);
  if (decl) {
    known.add(decl[1]);
    return `let ${decl[1]} = ${translateExpression(decl[2], known)};`;
  }
  const guarded = /^if\s*\((.+)\)\s*return\s+(.+);$/.exec(s);
  if (guarded) {
    return `if (${translateExpression(guarded[1], known)}) return ${translateExpression(guarded[2], known)};`;
  }
  const ret = /^return\s+(.+);$/.exec(s);
  if (ret) return `return ${translateExpression(ret[1], known)};`;

  throw new Error(`this translator does not understand the statement ${JSON.stringify(s)}`);
}

/**
 * Operators the character filter below would wave through, and must not.
 *
 * The filter admits `=`, `&` and `|` as characters because `==`, `&&` and `||`
 * are built from them, and admits `<` and `>` because the comparisons are. That
 * leaves the single forms reachable, and the first of them is the one that
 * matters: JavaScript would quietly EVALUATE `if (a = onset)` as an assignment
 * and carry on, where GLSL would not compile it at all. The rest are operators
 * whose GLSL meaning this translator has not established — `>>` is arithmetic
 * on a GLSL `int` and logical on a `uint`, and every value here arrives as one
 * untyped JavaScript number — so refusing beats guessing which way they round.
 *
 * A shipped shader cannot contain a bare `=` in a condition, because the driver
 * would reject it. The hole was in the guarantee rather than in today's result,
 * and the guarantee is what the rest of this file rests on.
 */
const BANNED_OPERATORS: [RegExp, string][] = [
  [/(^|[^=!<>])=(?!=)/, 'an assignment'],
  [/(^|[^&])&(?!&)/, 'a bitwise &'],
  [/(^|[^|])\|(?!\|)/, 'a bitwise |'],
  [/<<|>>/, 'a shift'],
];

/**
 * Translate one expression, refusing every identifier it cannot account for.
 *
 * The identifier check is what makes the whitelist real: a uniform renamed in
 * the shader and not here stops the test rather than evaluating to `undefined`
 * and comparing `NaN` against a number, which some assertions would pass.
 */
function translateExpression(expr: string, known: Set<string>): string {
  for (const [re, what] of BANNED_OPERATORS) {
    if (re.test(expr)) {
      throw new Error(`this translator does not accept ${what} in ${JSON.stringify(expr)}`);
    }
  }
  for (const token of expr.match(/[A-Za-z_]\w*/g) ?? []) {
    if (!known.has(token) && !(token in BUILTINS)) {
      throw new Error(`unknown identifier ${JSON.stringify(token)} in ${JSON.stringify(expr)}`);
    }
  }
  const illegal = expr.replace(/[A-Za-z_]\w*|[\d.]+|[-+*/()?:<>=!&|,\s]/g, '');
  if (illegal !== '') {
    throw new Error(`unexpected characters ${JSON.stringify(illegal)} in ${JSON.stringify(expr)}`);
  }
  return expr
    .replace(/[A-Za-z_]\w*/g, (t) => BUILTINS[t] ?? t)
    // GLSL `==` on numbers is exact equality, which is JavaScript's `===`. Done
    // after the identifier pass so it cannot rewrite inside a mapped name.
    .replace(/([^=!<>])==([^=])/g, '$1===$2')
    .replace(/([^=!<>])!=([^=])/g, '$1!==$2');
}

/**
 * Compile a scalar GLSL function out of shader source into a callable.
 *
 * `params` names the function's arguments in order; `uniforms` supplies every
 * other identifier it may read. Anything it reads that is in neither throws at
 * translation time, before a single line is evaluated.
 */
export function compileGlslScalar(
  source: string,
  name: string,
  params: readonly string[],
  uniformNames: readonly string[],
): (uniforms: Record<string, number>, ...args: number[]) => number {
  const body = glslFunctionBody(source, name);
  if (body === null) throw new Error(`no scalar function ${JSON.stringify(name)} in this shader`);

  const known = new Set<string>([...params, ...uniformNames]);
  const js = body
    .split('\n')
    .map((line) => translateStatement(line, known))
    .filter((line) => line !== '')
    .join('\n');

  // Uniforms are destructured rather than read through the object, so an
  // identifier the whitelist admitted but the caller forgot to supply is a
  // ReferenceError-shaped `undefined` at the first arithmetic rather than a
  // silent NaN — and the tests below pass every one of them.
  const fn = new Function(
    'U',
    ...params,
    `const { ${uniformNames.join(', ')} } = U;\n${js}`,
  ) as (u: Record<string, number>, ...a: number[]) => number;
  return fn;
}

// ---------------------------------------------------------------------------
// polarMask
// ---------------------------------------------------------------------------

const MASK_UNIFORMS = ['uMaskInterp', 'uMaskLo', 'uMaskHi', 'uMaskBottomOnly'] as const;

/** `web/src/uniforms.ts`'s own mapping, which is what the page binds. */
function uniformsFor(blend: BlendCalibration, interp: MaskInterpretation) {
  return {
    uMaskLo: blend.maskLoDeg,
    uMaskHi: blend.maskHiDeg,
    uMaskBottomOnly: blend.bottomOnly ? 1 : 0,
    uMaskInterp: interp === 'colatitude' ? 1 : 0,
  };
}

const BLEND = (over: Partial<BlendCalibration> = {}): BlendCalibration => ({
  rampShape: 'cosine',
  widthDeg: 20,
  rampGamma: 0.8,
  maskLoDeg: 60,
  maskHiDeg: 70,
  bottomOnly: false,
  ...over,
});

/** Every configuration the mask has, crossed with a latitude sweep. */
function* cases(): Generator<{ blend: BlendCalibration; interp: MaskInterpretation; lat: number }> {
  for (const bottomOnly of [false, true]) {
    for (const interp of ['latitude', 'colatitude'] as const) {
      // Degenerate pairs included on purpose: `full === onset` is a branch of its
      // own in both implementations, and an inverted pair reaches the `a >= full`
      // return before it.
      for (const [lo, hi] of [
        [60, 70],
        [0, 90],
        [70, 70],
        [70, 60],
        [45, 46],
      ]) {
        const blend = BLEND({ bottomOnly, maskLoDeg: lo, maskHiDeg: hi });
        for (let lat = -90; lat <= 90; lat += 0.25) yield { blend, interp, lat };
        for (const lat of [-90, -70, -65, -60, -1e-12, 0, 1e-12, 60, 65, 70, 90]) {
          yield { blend, interp, lat };
        }
      }
    }
  }
}

test('the page shader’s polarMask computes what packages/sim computes, bit for bit', () => {
  const shader = compileGlslScalar(WEB_GLSL, 'polarMask', ['latDeg'], MASK_UNIFORMS);
  let checked = 0;
  for (const { blend, interp, lat } of cases()) {
    const mine = shader(uniformsFor(blend, interp), lat);
    const model = polarMask(lat, blend, interp);
    // Exactly equal, not within a tolerance. Both are float64 evaluating the
    // same expression in the same order, so any difference is a difference in
    // the arithmetic rather than in the rounding — which is the whole question.
    assert.equal(mine, model, `lat ${lat}, ${interp}, ${JSON.stringify(blend)}`);
    checked++;
  }
  assert.ok(checked > 5000, `only ${checked} cases`);
});

test('the two shaders carry the same polarMask, so the page and the harness agree', () => {
  // `packages/harness` has its own headless chain for its own shader. What
  // nothing checked is that the page's shader and the harness's are the same
  // arithmetic — they are separate files, and the harness's guarantees say
  // nothing about the page's.
  //
  // It also carries the harness the rest of the way. Its `glsl.test.ts` checks
  // that `reference.ts` and the shader declare the same FUNCTION NAMES, and
  // `parity.test.ts` checks `reference.ts` against `packages/sim` numerically —
  // so a `reference.ts` that transliterated its shader's `polarMask` wrongly
  // would pass both. With this equality and the test above, the chain closes:
  // the harness shader's text is the page shader's text, and the page shader's
  // arithmetic is `sim`'s, so the harness shader's is too.
  const web = glslFunctionBody(WEB_GLSL, 'polarMask');
  const harness = glslFunctionBody(HARNESS_GLSL, 'polarMask');
  assert.ok(web !== null && harness !== null, 'polarMask is missing from a shader');
  assert.equal(web, harness);
});

test('the translator refuses what it does not understand, rather than guessing', () => {
  // The safety property the whole file rests on. A translator that quietly
  // mishandled an unfamiliar construct would compare two things neither of
  // which is the shader — and they might well agree.
  const withLoop = WEB_GLSL.replace(
    'float a = abs(latDeg);',
    'for (int i = 0; i < 2; i++) { }\n  float a = abs(latDeg);',
  );
  assert.throws(
    () => compileGlslScalar(withLoop, 'polarMask', ['latDeg'], MASK_UNIFORMS),
    /does not understand the statement/,
  );

  const withUnknownCall = WEB_GLSL.replace('cos(PI * t)', 'smoothstep(0.0, 1.0, t)');
  assert.throws(
    () => compileGlslScalar(withUnknownCall, 'polarMask', ['latDeg'], MASK_UNIFORMS),
    /unknown identifier "smoothstep"/,
  );

  const withRenamedUniform = WEB_GLSL.replace(/uMaskLo/g, 'uMaskLower');
  assert.throws(
    () => compileGlslScalar(withRenamedUniform, 'polarMask', ['latDeg'], MASK_UNIFORMS),
    /unknown identifier "uMaskLower"/,
  );

  assert.throws(
    () => compileGlslScalar(WEB_GLSL, 'noSuchFunction', ['x'], MASK_UNIFORMS),
    /no scalar function/,
  );
});

test('the translator refuses the operators its character filter would admit', () => {
  // Found by review, and it was a real hole rather than a style point. The
  // filter admits `=`, `&` and `|` as CHARACTERS so that `==`, `&&` and `||`
  // work, which left the single forms reachable. A bare `=` is the one that
  // bites: `if (a = onset)` is not GLSL a driver would compile, but it is
  // perfectly good JavaScript, so the translator would have assigned, taken the
  // branch on the assigned value, and reported an answer for a shader that
  // cannot exist -- in a file whose stated safety property is that it refuses
  // what it does not understand.
  const cases: [string, string, RegExp][] = [
    ['an assignment for a comparison', 'if (a <= onset) return 1.0;', /an assignment/],
    ['a bitwise & for a logical one', 'uMaskBottomOnly == 1 && latDeg >= 0.0', /a bitwise &/],
    ['a shift', 'float t = (a - onset) / (full - onset);', /a shift/],
  ];
  const swaps: string[] = [
    'if (a = onset) return 1.0;',
    'uMaskBottomOnly == 1 & latDeg >= 0.0',
    'float t = (a - onset) / (full >> onset);',
  ];

  for (let i = 0; i < cases.length; i++) {
    const [what, from, message] = cases[i];
    assert.ok(WEB_GLSL.includes(from), `the target for ${what} has moved: ${from}`);
    assert.throws(
      () => compileGlslScalar(WEB_GLSL.replace(from, swaps[i]), 'polarMask', ['latDeg'], MASK_UNIFORMS),
      message,
      what,
    );
  }

  // And the ban is narrow: the real operators still translate. If this fails,
  // the guard has eaten `==`, `&&`, `<=` or `>=` and every test above is
  // passing for the wrong reason.
  assert.equal(
    compileGlslScalar(WEB_GLSL, 'polarMask', ['latDeg'], MASK_UNIFORMS)(
      uniformsFor(BLEND(), 'latitude'),
      65,
    ),
    polarMask(65, BLEND(), 'latitude'),
  );
});

test('the comparison fails when the shader is wrong, one term at a time', () => {
  // Mutation, because a green agreement proves nothing unless disagreement is
  // reachable. Each of these is a plausible edit — a flipped comparison, a
  // dropped guard, a sign, a swapped bound — and each must be caught.
  const mutations: [string, string, string][] = [
    ['the bottom-only guard', 'uMaskBottomOnly == 1 && latDeg >= 0.0', 'uMaskBottomOnly == 1'],
    ['the guard’s sign', 'latDeg >= 0.0', 'latDeg <= 0.0'],
    ['the onset comparison', 'if (a <= onset) return 1.0;', 'if (a < onset) return 1.0;'],
    ['the absolute value', 'float a = abs(latDeg);', 'float a = latDeg;'],
    ['the feather', 'return 0.5 + 0.5 * cos(PI * t);', 'return 0.5 + 0.5 * cos(t);'],
    ['the two bounds', 'float t = (a - onset) / (full - onset);', 'float t = (a - full) / (onset - full);'],
    ['the interpretation swap', 'uMaskInterp == 0 ? uMaskLo : 90.0 - uMaskHi', 'uMaskLo'],
  ];

  for (const [what, from, to] of mutations) {
    assert.ok(WEB_GLSL.includes(from), `the mutation target for ${what} has moved: ${from}`);
    const broken = compileGlslScalar(
      WEB_GLSL.replace(from, to),
      'polarMask',
      ['latDeg'],
      MASK_UNIFORMS,
    );
    let disagreed = false;
    for (const { blend, interp, lat } of cases()) {
      if (broken(uniformsFor(blend, interp), lat) !== polarMask(lat, blend, interp)) {
        disagreed = true;
        break;
      }
    }
    assert.ok(disagreed, `breaking ${what} did not change any answer, so the sweep cannot see it`);
  }
});
