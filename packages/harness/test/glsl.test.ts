// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The structural half of the parity chain.
 *
 * `parity.ts` compares the TypeScript reference against `packages/sim`
 * numerically. That proves the reference is right. It says nothing about whether
 * the reference still describes the SHADER — and the shader is what the window
 * actually runs.
 *
 * There is no GPU in this container, so the arithmetic link cannot be executed
 * here. What can be checked is the structure: the shader's own source is parsed
 * for its function signatures, and `reference.ts` must expose a counterpart for
 * every one of them, in both directions. A term added to the GLSL and forgotten
 * in the reference fails the build instead of quietly widening the gap the
 * parity number is measuring.
 *
 * That is a weaker guarantee than execution and it is stated as such in
 * `packages/harness/README.md`. It is the strongest one available without a
 * display.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAGMENT_CHUNKS,
  FRAGMENT_SHADER,
  MAX_PROJECTORS,
  NEWTON_ITERATIONS,
  VERTEX_SHADER,
  glslFunctionNames,
  glslUniformNames,
} from '../src/glsl.ts';
import * as reference from '../src/reference.ts';

/**
 * Functions `reference.ts` exports that have no GLSL counterpart, and why.
 *
 * The list is short on purpose: every entry is a place where the two languages
 * genuinely differ, not a place where the reference has drifted ahead.
 */
const REFERENCE_ONLY: Readonly<Record<string, string>> = {
  textureLinear:
    'GLSL calls the builtin `texture()`; a TypeScript mirror has to implement LINEAR filtering, ' +
    'REPEAT on S and CLAMP_TO_EDGE on T by hand.',
  renderRoomReference:
    'The hardware invokes a fragment shader once per pixel. The reference needs an explicit raster loop.',
  renderProjectorReference: 'As renderRoomReference, for the projector raster.',
};

function referenceFunctionNames(): string[] {
  return Object.entries(reference)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
}

test('every GLSL function has a TypeScript counterpart', () => {
  const glsl = glslFunctionNames();
  const ts = new Set(referenceFunctionNames());
  const missing = glsl.filter((name) => !ts.has(name));
  assert.deepEqual(
    missing,
    [],
    `these GLSL functions have no counterpart in reference.ts, so the parity check does not cover them: ` +
      `${missing.join(', ')}. Add them to reference.ts — do NOT delete them from the shader to make this pass.`,
  );
  assert.ok(glsl.length >= 20, `only ${glsl.length} GLSL functions parsed — did the parser stop matching?`);
});

test('every TypeScript reference function has a GLSL counterpart, or a stated reason', () => {
  const glsl = new Set(glslFunctionNames());
  const extra = referenceFunctionNames().filter((n) => !glsl.has(n) && !(n in REFERENCE_ONLY));
  assert.deepEqual(
    extra,
    [],
    `reference.ts exports these with no GLSL counterpart and no entry in REFERENCE_ONLY: ${extra.join(', ')}. ` +
      `Either the shader is missing a term or the reference has grown one the GPU does not run.`,
  );
});

test('the shader is assembled from named chunks that each name what they mirror', () => {
  assert.ok(FRAGMENT_CHUNKS.length >= 10);
  for (const chunk of FRAGMENT_CHUNKS) {
    assert.ok(chunk.name.length > 0);
    assert.ok(chunk.mirrors.length > 0, `chunk ${chunk.name} does not say what it mirrors`);
    assert.ok(chunk.source.length > 0);
  }
  // Assembly is concatenation, in order, with nothing dropped.
  for (const chunk of FRAGMENT_CHUNKS) {
    assert.ok(FRAGMENT_SHADER.includes(chunk.source.trim()), `chunk ${chunk.name} is not in the shader`);
  }
});

test('the shader source is pure ASCII', () => {
  // This is a guard for something that cannot be executed in this container.
  // WebGL restricts a shader source string to the GLSL ES source character set,
  // and implementations differ on whether a non-ASCII byte inside a COMMENT is
  // tolerated or generates INVALID_VALUE. The rest of the project writes
  // "PARAMETERS.md §3.1" everywhere and it would be entirely natural for that
  // habit to reach the shader — where the symptom is a blank canvas and a
  // compile error nobody reads. The TypeScript prose around the templates is
  // free to use whatever it likes; the templates are not.
  for (const [name, src] of [['fragment', FRAGMENT_SHADER], ['vertex', VERTEX_SHADER]] as const) {
    const offenders = new Set<string>();
    for (const ch of src) if (ch.codePointAt(0)! > 126) offenders.add(ch);
    assert.deepEqual(
      [...offenders],
      [],
      `the ${name} shader contains non-ASCII characters: ${[...offenders].join(' ')}. ` +
        `Write "section 3.1" rather than the section sign.`,
    );
  }
});

test('the shader declares GLSL ES 3.00 exactly once, at the top of each stage', () => {
  for (const [name, src] of [['fragment', FRAGMENT_SHADER], ['vertex', VERTEX_SHADER]] as const) {
    assert.ok(src.startsWith('#version 300 es'), `${name} shader does not start with #version 300 es`);
    assert.equal(
      (src.match(/#version/g) ?? []).length,
      1,
      `${name} shader has more than one #version directive — chunk concatenation went wrong`,
    );
  }
});

test('the shader uses no GLSL builtin whose semantics differ from JavaScript', () => {
  // `mod` is floored; JavaScript's `%` is truncated. Using it for wrapDeg180
  // would put every negative longitude a full turn from where the CPU tracer
  // puts it, and on a four-fold symmetric rig that looks entirely plausible.
  assert.equal(
    /\bmod\s*\(/.test(FRAGMENT_SHADER),
    false,
    'the shader calls mod(); it is floored where JavaScript % is truncated. Use trunc() as wrapDeg180 does.',
  );
  // `smoothstep` is Hermite; conventions.ts §B's smoothstep ramp is the same
  // polynomial but the clamp differs at the endpoints, and the ramp is written
  // out longhand so the two cannot diverge.
  assert.equal(/\bsmoothstep\s*\(/.test(FRAGMENT_SHADER), false, 'the shader calls the smoothstep builtin');
});

test('the parity-relevant constants are shared, not restated', () => {
  assert.equal(MAX_PROJECTORS, 4, 'PARAMETERS.md §2 caps the rig at four projectors');
  assert.ok(FRAGMENT_SHADER.includes(`const int MAX_PROJ = ${MAX_PROJECTORS};`));
  assert.ok(FRAGMENT_SHADER.includes(`const int NEWTON_ITERATIONS = ${NEWTON_ITERATIONS};`));
  // reference.ts imports NEWTON_ITERATIONS from glsl.ts rather than restating it,
  // so the two loops cannot fall out of step.
  const before = reference.invertDistortion(0.3, 0.2, 0.05, 0.01);
  assert.ok(Number.isFinite(before[0]) && Number.isFinite(before[1]));
});

/**
 * A static lint, because the shader cannot be compiled in this container.
 *
 * These two checks catch the authoring mistakes that actually happen when source
 * is assembled from ordered chunks: an unbalanced delimiter, and a function used
 * before it is declared. GLSL requires declaration before use and has no
 * forward declarations, so reordering `FRAGMENT_CHUNKS` — or adding a helper at
 * the bottom and calling it from the top — is a compile error whose only symptom
 * in this repository would be a blank canvas.
 */
test('the shader has balanced delimiters', () => {
  const stripped = FRAGMENT_SHADER.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const pairs: [string, string][] = [
    ['{', '}'],
    ['(', ')'],
    ['[', ']'],
  ];
  for (const [open, close] of pairs) {
    let depth = 0;
    for (const ch of stripped) {
      if (ch === open) depth++;
      else if (ch === close) depth--;
      assert.ok(depth >= 0, `the shader closes a '${close}' that was never opened`);
    }
    assert.equal(depth, 0, `the shader leaves ${depth} unclosed '${open}'`);
  }
});

test('every shader function is declared before it is used', () => {
  const stripped = FRAGMENT_SHADER.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const declaredAt = new Map<string, number>();
  for (const m of stripped.matchAll(
    /^\s*(?:float|vec2|vec3|vec4|bool|int|void|Surface)\s+([A-Za-z_]\w*)\s*\(/gm,
  )) {
    if (!declaredAt.has(m[1])) declaredAt.set(m[1], m.index ?? 0);
  }
  for (const [name, declIndex] of declaredAt) {
    // The declaration itself is the first match; a call is any later `name(`
    // that is not preceded by a return type on the same statement.
    for (const use of stripped.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
      const at = use.index ?? 0;
      if (at <= declIndex) {
        const line = stripped.slice(0, at).split('\n').length;
        assert.fail(
          `${name} is used at line ${line}, before its declaration. GLSL has no forward ` +
            `declarations, so this does not compile — check the order of FRAGMENT_CHUNKS.`,
        );
      }
    }
  }
  // And nothing is declared and never called (main excepted, which is the entry).
  for (const [name, declIndex] of declaredAt) {
    const uses = [...stripped.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].filter(
      (u) => (u.index ?? 0) > declIndex,
    );
    assert.ok(uses.length > 0, `${name} is declared and never called — dead code in a shader`);
  }
});

test('the shader declares every uniform the binder looks for, and no orphans', () => {
  const names = glslUniformNames();
  assert.ok(names.includes('uEquirect'));
  assert.ok(names.includes('uProjCount'));
  assert.ok(names.includes('uMaskInterp'), 'A-02’s two readings of bottommask are not reachable from the shader');
  for (const name of names) {
    assert.ok(
      FRAGMENT_SHADER.includes(name),
      `uniform ${name} is declared but never referenced — a dead uniform is a term of the model that stopped applying`,
    );
    // Declared once, used at least once more.
    const uses = (FRAGMENT_SHADER.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
    assert.ok(uses >= 2, `uniform ${name} is declared and never read`);
  }
});

test('reference.ts does not import packages/sim', async () => {
  // If it did, the parity number would be comparing sim against itself through a
  // wrapper and would read zero however wrong the shader was. This is the same
  // argument packages/sim/README.md makes about the A/B boundary, applied to a
  // different boundary.
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'reference.ts'), 'utf8');
  for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
    assert.equal(
      /sim\/src/.test(m[1]),
      false,
      `reference.ts imports ${m[1]}. It must be an INDEPENDENT transliteration of glsl.ts, or the ` +
        `parity check measures nothing.`,
    );
  }
});

test('the harness binder gives its mesh textures storage before anything is drawn', async () => {
  // The same bug as `packages/web/test/glsl.test.ts` pins on the app binder, in
  // the binder that was written first. `uploadMesh` returns early when the model
  // asked for is the one already uploaded, and `null` -- no model, the 1x1
  // placeholders -- is a legitimate model, so a record starting at `null` made
  // the first call a no-op and left three textures created and never defined.
  //
  // Over the source because `web/gl.ts` needs DOM types the root tsconfig
  // withholds on purpose; see the twin for the whole argument.
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const gl = fs.readFileSync(path.join(here, '..', 'web', 'gl.ts'), 'utf8');
  assert.ok(
    /meshUploaded: undefined,/.test(gl),
    'meshUploaded must start as undefined; null is a model that IS uploaded',
  );
  assert.ok(!/meshUploaded: null,/.test(gl));
});
