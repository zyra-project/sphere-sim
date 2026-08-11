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
