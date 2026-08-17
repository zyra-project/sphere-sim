/**
 * Structural checks on the display shader. Not arithmetic — a headless test
 * cannot run GLSL — but the class of bug these catch is the one that silently
 * removes a term from the model while leaving a picture that still looks like a
 * sphere.
 *
 * The runtime half of the check is `src/parity.ts`, measured in the browser
 * against `packages/sim` and displayed on the page.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FRAGMENT_CHUNKS,
  FRAGMENT_SHADER,
  MAX_PROJECTORS,
  NEWTON_ITERATIONS,
  VERTEX_SHADER,
  glslFunctionNames,
  glslUniformNames,
} from '../src/glsl.ts';
import { buildDisplayUniforms, packRig, pickMarker, pickMarkerNear } from '../src/uniforms.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { BOULDER_PRESET } from '../src/settings.ts';
import { buildViewer, buildWorld } from '../src/rigs.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GL_SOURCE = fs.readFileSync(path.join(HERE, '..', 'web', 'gl.ts'), 'utf8');

test('PARAMETERS.md §2 caps a rig at four projectors and the shader is sized for exactly that', () => {
  assert.equal(MAX_PROJECTORS, 4);
  assert.ok(FRAGMENT_SHADER.includes(`const int MAX_PROJ = ${MAX_PROJECTORS};`));
});

test('the shader carries two complete rigs, field for field', () => {
  // The one bug this file exists to prevent: a rig gaining a uniform that its
  // twin does not, so the compositor's calibration is evaluated with the
  // physical rig's distortion or limb constant. The picture stays plausible and
  // every number derived from it is wrong.
  const names = glslUniformNames();
  const physicalOnly = ['uLens', 'uRot', 'uIntr', 'uRaster', 'uLimb'];
  for (const n of physicalOnly) {
    assert.ok(names.includes(n), `the physical rig is missing ${n}`);
    const twin = `uC${n.slice(1)}`;
    assert.ok(names.includes(twin), `the content rig is missing ${twin}, the twin of ${n}`);
  }
});

test('every uniform the shader declares is set by the binder, and vice versa', () => {
  const declared = new Set(glslUniformNames());
  // `gl.ts` sets the per-rig arrays through one prefixed helper, so the literal
  // names appear as template strings. Expand them the same way the helper does.
  const set = new Set<string>();
  for (const m of GL_SOURCE.matchAll(/loc\('(\w+)'\)/g)) set.add(m[1]);
  for (const m of GL_SOURCE.matchAll(/loc\(`u\$\{prefix\}(\w+)`\)/g)) {
    set.add(`u${m[1]}`);
    set.add(`uC${m[1]}`);
  }

  for (const name of declared) {
    assert.ok(set.has(name), `the shader declares ${name} and gl.ts never sets it`);
  }
  for (const name of set) {
    assert.ok(declared.has(name), `gl.ts sets ${name} and the shader does not declare it`);
  }
});

test('the optics functions take their rig explicitly rather than reading a global', () => {
  // `pixelOf` and `rayFrom` run against BOTH calibrations. A version that read
  // `uLens[i]` internally would silently use the physical rig for the content
  // trace, which is the single most convincing way to make this page lie.
  assert.ok(
    /vec3 rayFrom\(mat3 rot, vec4 intr, vec2 kk, float u, float v\)/.test(FRAGMENT_SHADER),
    'rayFrom must be parameterised by a rig',
  );
  assert.ok(
    /bool pixelOf\(vec3 lens, mat3 rot, vec4 intr, vec4 raster, vec3 worldPoint, out vec2 px\)/.test(
      FRAGMENT_SHADER,
    ),
    'pixelOf must be parameterised by a rig',
  );

  const body = FRAGMENT_SHADER.slice(
    FRAGMENT_SHADER.indexOf('vec3 rayFrom('),
    FRAGMENT_SHADER.indexOf('bool illuminated('),
  );
  for (const global of ['uLens[', 'uRot[', 'uIntr[', 'uRaster[', 'uCLens[', 'uCRot[']) {
    assert.ok(
      !body.includes(global),
      `rayFrom/pixelOf reference ${global} directly; they must take whichever rig the caller means`,
    );
  }
});

test('the content trace evaluates blend, mask and content in the CONTENT rig', () => {
  const trace = FRAGMENT_CHUNKS.find((c) => c.name === 'trace');
  assert.ok(trace);
  // Step 3 of misregistration.ts: the pixel goes back out through the compositor's
  // calibration, hits the compositor's sphere, and the weight and the texel are
  // read there.
  assert.ok(trace.source.includes('rayFrom(uCRot[i], uCIntr[i], uCRaster[i].zw'));
  assert.ok(trace.source.includes('raySphereIntersect(uCLens[i], dir, uCRadius'));
  assert.ok(trace.source.includes('contentWeight(xp, i, count)'));
  // And the emission is from the PHYSICAL lens, with the physical transfer.
  assert.ok(trace.source.includes('uLens[i] - point'));
  assert.ok(trace.source.includes('emittedRadianceRgb(signal, i)'));
});

test('the blend weight is normalised inside the content rig only', () => {
  // `contentWeight` decides how the compositor SPLIT the signal between
  // projectors. That is a property of the calibration the content was generated
  // against; the physical lens positions have no part in it, and a stray `uLens`
  // here would make the split depend on where the projector actually ended up.
  const blend = FRAGMENT_CHUNKS.find((c) => c.name === 'blend');
  assert.ok(blend);
  for (const physical of ['uLens[', 'uRot[', 'uIntr[', 'uRaster[', 'uLimb[', 'uRadius']) {
    assert.ok(
      !blend.source.includes(physical),
      `the blend chunk reads ${physical} from the physical rig`,
    );
  }
  assert.ok(blend.source.includes('uCLimb[i]'));
  assert.ok(blend.source.includes('uCRadius'));
});

test('the ramp exponent is applied to the weight, never to the signal', () => {
  // conventions.ts §B. Applying it to the signal is a per-projector gamma
  // adjustment that breaks normalisation — which is the clause that stops a ramp
  // exponent from being able to create a luminance step at all.
  assert.ok(FRAGMENT_SHADER.includes('return w == 0.0 ? 0.0 : pow(w, rampGamma);'));
  const transfer = FRAGMENT_CHUNKS.find((c) => c.name === 'transfer');
  assert.ok(transfer && !transfer.source.includes('rampGamma'));
});

test('the distortion inversion runs a fixed iteration count a GPU can actually finish', () => {
  assert.equal(NEWTON_ITERATIONS, 8);
  assert.ok(FRAGMENT_SHADER.includes('for (int iter = 0; iter < NEWTON_ITERATIONS; iter++)'));
  // No tolerance break: float32 cannot reach the CPU's 1e-14 and a test it can
  // never satisfy just burns the loop while pretending to be adaptive.
  const optics = FRAGMENT_CHUNKS.find((c) => c.name === 'optics');
  assert.ok(optics && !/1e-1[0-9]/.test(optics.source));
});

test('longitude wrapping is truncated, not floored', () => {
  // GLSL `mod` is floored and JavaScript `%` is truncated. Using `mod` puts every
  // negative longitude a full turn from where the CPU model puts it, and on a
  // four-fold symmetric rig that looks entirely plausible.
  assert.ok(FRAGMENT_SHADER.includes('float d = deg - 360.0 * trunc(deg / 360.0);'));
  assert.ok(!/\bmod\s*\(/.test(FRAGMENT_SHADER));
});

test('the sphere intersection uses the stable geometric discriminant', () => {
  // The textbook b*b - 4ac form is a difference of two numbers around 27 m² at
  // this geometry and loses half the mantissa exactly at the limb.
  assert.ok(FRAGMENT_SHADER.includes('float disc = radius * radius - dot(m, m);'));
  assert.ok(!FRAGMENT_SHADER.includes('4.0 * a * c'));
});

test('the equirect is wrapped in longitude and clamped in latitude', () => {
  // The asymmetry is the correctness: the texture is periodic in longitude and
  // is not periodic in latitude. Wrapping T folds the north pole onto the south.
  assert.ok(GL_SOURCE.includes('gl.TEXTURE_WRAP_S, gl.REPEAT'));
  assert.ok(GL_SOURCE.includes('gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE'));
});

test('the vertex shader allocates no geometry', () => {
  assert.ok(VERTEX_SHADER.includes('gl_VertexID'));
  assert.ok(!VERTEX_SHADER.includes('in vec'));
});

test('the packer transposes into the column-major order GL reads', () => {
  const world = buildWorld(BOULDER_PRESET);
  const prepared = prepareRig(world.truthRig);
  const packed = packRig(prepared);
  const m = prepared.projectors[0].rotation;
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      assert.ok(
        Math.abs(packed.rot[3 * c + r] - m[r * 3 + c]) < 1e-6,
        `element (${r},${c}) is not transposed`,
      );
    }
  }
});

test('unused projector slots hold values a speculating GPU cannot divide by zero', () => {
  const world = buildWorld({ ...BOULDER_PRESET, projectorCount: 2 });
  const packed = packRig(prepareRig(world.truthRig));
  for (let i = 2; i < MAX_PROJECTORS; i++) {
    assert.notEqual(packed.limb[2 * i], 0, `slot ${i} has a zero lens distance`);
    assert.notEqual(packed.intrinsics[4 * i], 0, `slot ${i} has a zero focal length`);
    assert.notEqual(packed.raster[4 * i], 0, `slot ${i} has a zero raster width`);
  }
});

test('the uniforms take the blend from the compositor, not from the lenses', () => {
  // The weights belong to the calibration the content was generated against.
  // Reading them off the physical rig is a subtle and very convincing bug.
  const world = buildWorld(BOULDER_PRESET);
  const physical = prepareRig(world.truthRig);
  const content = prepareRig({
    ...world.compositorRig,
    blend: { ...world.compositorRig.blend, widthDeg: 7.5, rampGamma: 1.4 },
  });
  const u = buildDisplayUniforms(
    physical,
    content,
    world.scene,
    buildViewer(BOULDER_PRESET, 64, 48),
  );
  assert.equal(u.widthDeg, 7.5);
  assert.equal(u.rampGamma, 1.4);
});

test('the markers are off unless asked for, so the parity check never sees one', () => {
  // The same class of bug `RoomViewOptions.drawFloor` produced: the CPU two-rig
  // renderer knows nothing about lens markers, so a default that drew them would
  // make the parity number report a disagreement belonging to neither model.
  const world = buildWorld(BOULDER_PRESET);
  const u = buildDisplayUniforms(
    prepareRig(world.truthRig),
    prepareRig(world.compositorRig),
    world.scene,
    buildViewer(BOULDER_PRESET, 64, 48),
  );
  assert.equal(u.markerRadius, 0);
  assert.equal(u.markerSelected, -1);
  assert.equal(pickMarker(u, 0, 0), -1, 'nothing can be picked when nothing is drawn');
});

test('a click picks the projector under it, and never one behind the sphere', () => {
  // The picker mirrors the shader's `markerHit`. This checks the property that
  // makes the mirror worth having: what you can click is what you can see.
  const world = buildWorld(BOULDER_PRESET);
  const physical = prepareRig(world.truthRig);
  const camera = buildViewer(BOULDER_PRESET, 64, 48);
  const u = buildDisplayUniforms(physical, prepareRig(world.compositorRig), world.scene, camera, {
    markerRadiusM: 0.12,
  });

  // Aim the centre pixel straight down the barrel at each lens in turn, by
  // rebuilding the uniforms with the camera looking at it from outside the room.
  for (let i = 0; i < u.projCount; i++) {
    const lens = {
      x: u.physical.lens[3 * i],
      y: u.physical.lens[3 * i + 1],
      z: u.physical.lens[3 * i + 2],
    };
    const len = Math.hypot(lens.x, lens.y, lens.z);
    const outside = { x: (lens.x / len) * (len + 3), y: (lens.y / len) * (len + 3), z: lens.z };
    const looking = buildDisplayUniforms(
      physical,
      prepareRig(world.compositorRig),
      world.scene,
      { ...camera, position: outside, target: lens },
      { markerRadiusM: 0.12 },
    );
    assert.equal(pickMarker(looking, 0, 0), i, `looking straight at P${i + 1} did not pick it`);

    // From the far side, the sphere is between the camera and that lens. The
    // answer is not "nothing": the projectors are a ring, so the antipode of one
    // lens is behind another, and that near one is genuinely on screen. What must
    // never happen is picking the lens the sphere is hiding.
    const behind = { x: -outside.x, y: -outside.y, z: outside.z };
    const through = buildDisplayUniforms(
      physical,
      prepareRig(world.compositorRig),
      world.scene,
      { ...camera, position: behind, target: lens },
      { markerRadiusM: 0.12 },
    );
    const hidden = pickMarker(through, 0, 0);
    assert.notEqual(hidden, i, `P${i + 1} was picked through the sphere`);
    if (hidden >= 0) {
      const range = (j: number): number =>
        Math.hypot(
          looking.physical.lens[3 * j] - behind.x,
          looking.physical.lens[3 * j + 1] - behind.y,
          looking.physical.lens[3 * j + 2] - behind.z,
        );
      assert.ok(range(hidden) < range(i), 'the picked lens must be the nearer one');
    }
  }

  // A corner of the frame is room, not lens.
  assert.equal(pickMarker(u, -1, -1), -1);
});

test('a fingertip-wide tap finds the projector it landed beside, and still not one behind the sphere', () => {
  // `pickMarkerNear` is what a touchscreen calls. The property it has to keep is
  // the one above — you cannot select what you cannot see — while answering for
  // a contact patch rather than a point, because a projector body is about ten
  // CSS pixels across on a phone and an exact test says "nothing" to most real
  // taps.
  const world = buildWorld(BOULDER_PRESET);
  const physical = prepareRig(world.truthRig);
  const camera = buildViewer(BOULDER_PRESET, 64, 48);

  for (let i = 0; i < 4; i++) {
    const lens = {
      x: physical.projectors[i].lens.x,
      y: physical.projectors[i].lens.y,
      z: physical.projectors[i].lens.z,
    };
    const len = Math.hypot(lens.x, lens.y, lens.z);
    const outside = { x: (lens.x / len) * (len + 3), y: (lens.y / len) * (len + 3), z: lens.z };
    const looking = buildDisplayUniforms(
      physical,
      prepareRig(world.compositorRig),
      world.scene,
      { ...camera, position: outside, target: lens },
      { markerRadiusM: 0.12 },
    );

    // Walk out from the barrel until an exact ray stops hitting it, then tap
    // just past that edge. Measured rather than assumed: how much NDC a
    // projector body covers depends on where the camera was put.
    let missX = 0;
    while (missX < 1 && pickMarker(looking, missX, 0) === i) missX += 0.01;
    assert.ok(missX < 1, `P${i + 1} covers the whole frame; the camera is wrong`);
    assert.equal(pickMarker(looking, missX, 0), -1, 'the near miss should be an exact miss');
    assert.equal(
      pickMarkerNear(looking, missX, 0, 0.03, 0.03),
      i,
      `a tap just past the edge of P${i + 1} did not find it`,
    );

    // Tolerance must not become x-ray vision: from the far side the sphere is in
    // the way, and widening the search must not start returning the hidden lens.
    const behind = { x: -outside.x, y: -outside.y, z: outside.z };
    const through = buildDisplayUniforms(
      physical,
      prepareRig(world.compositorRig),
      world.scene,
      { ...camera, position: behind, target: lens },
      { markerRadiusM: 0.12 },
    );
    assert.notEqual(
      pickMarkerNear(through, 0, 0, 0.12, 0.12),
      i,
      `P${i + 1} was picked through the sphere by a wide tap`,
    );
  }

  // Zero tolerance is exactly the old behaviour, and empty room is still empty.
  const u = buildDisplayUniforms(physical, prepareRig(world.compositorRig), world.scene, camera, {
    markerRadiusM: 0.12,
  });
  assert.equal(pickMarkerNear(u, -1, -1, 0, 0), pickMarker(u, -1, -1));
  assert.equal(pickMarkerNear(u, -1, -1, 0.05, 0.05), -1, 'the corner of the room is not a lens');
});

test('every chunk names the sim module it mirrors', () => {
  for (const c of FRAGMENT_CHUNKS) {
    assert.ok(c.mirrors.length > 0, `chunk '${c.name}' does not say what it mirrors`);
  }
  const mirrored = FRAGMENT_CHUNKS.map((c) => c.mirrors).join(' ');
  assert.ok(
    mirrored.includes('misregistration.ts'),
    'the trace must be attributed to the two-rig renderer it reproduces',
  );
});

test('every declared function is reachable from the entry point', () => {
  // A function nobody calls is a term that was removed from the model and left
  // behind, which reads as coverage it no longer provides.
  const names = glslFunctionNames();
  assert.ok(names.length > 8, `expected a real shader, found ${names.length} functions`);
  for (const name of names) {
    const calls = FRAGMENT_SHADER.split(`${name}(`).length - 1;
    assert.ok(calls >= 2, `${name} is declared and never called`);
  }
});
