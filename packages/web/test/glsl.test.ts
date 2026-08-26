// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

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
  CONTENT_DECODE_FRAGMENT,
  FRAGMENT_CHUNKS,
  FRAGMENT_SHADER,
  MAX_PROJECTORS,
  NEWTON_ITERATIONS,
  VERTEX_SHADER,
  glslFunctionNames,
  glslUniformNames,
} from '../src/glsl.ts';
import {
  buildDisplayUniforms,
  packRig,
  pickMarker,
  pickMarkerNear,
  slotOfRigIndex,
} from '../src/uniforms.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { coverageAndWeights } from '../../sim/src/coverage.ts';
import { BOULDER_PRESET } from '../src/settings.ts';
import { CONTENT_DECODE_GAMMA } from '../src/rigs.ts';
import { buildViewer, buildWorld } from '../src/rigs.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GL_SOURCE = fs.readFileSync(path.join(HERE, '..', 'web', 'gl.ts'), 'utf8');
const MAIN_SOURCE = fs.readFileSync(path.join(HERE, '..', 'web', 'main.ts'), 'utf8');

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

test('the trace reads the content through contentAt, never the texture directly', () => {
  // The same rule `packages/sim`'s `test/content.test.ts` enforces on the CPU
  // side, on this side. The graticule is drawn analytically over the image, so a
  // trace that samples the texture is drawing content the sphere does not have —
  // and unlike a metric, nothing would fail. It would simply be a different
  // picture, and the parity check would agree with it, because the CPU renderer
  // it is compared against reads `contentAt` too only as long as somebody keeps
  // it that way.
  const trace = FRAGMENT_CHUNKS.find((c) => c.name === 'trace');
  assert.ok(trace);
  assert.ok(trace.source.includes('contentAt('), 'the trace must read the content through contentAt');
  assert.ok(
    !trace.source.includes('sampleEquirect('),
    'the trace samples the equirect directly; the analytic graticule would be missing from it',
  );
  // And contentAt is the one place that does sample it.
  const equirect = FRAGMENT_CHUNKS.find((c) => c.name === 'equirect');
  assert.ok(equirect && equirect.source.includes('vec3 contentAt(float latDeg, float lonDeg)'));
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

test('the A-37 sector wedge is measured from the neighbouring lenses, not from 360/N', () => {
  // conventions.ts SN.2 records equal spacing as "the rejected reading ... it is
  // what one of the two implementations did", and this shader was the one that
  // did it. The trigger is not exotic: PARAMETERS.md S2's N=3 install keeps
  // slots 0/90/180 rather than respacing to 0/120/240, so the plain "3" chip in
  // the Projectors row reaches it in a single click, as does switching one
  // projector off at the wall.
  const blend = FRAGMENT_CHUNKS.find((c) => c.name === 'blend');
  assert.ok(blend);
  assert.ok(
    !/360\.0\s*\/\s*float\(uProjCount\)/.test(blend.source),
    'the sector wedge is 360/N, which respaces the survivors of a dark quadrant',
  );
  assert.ok(
    blend.source.includes('sectorHalfWidths(i, plusHalf, minusHalf)'),
    'the wedge is not measured from the neighbouring lens azimuths',
  );
  // Signed, or the two half-widths are computed and then thrown away.
  assert.ok(blend.source.includes('float edge = dLon >= 0.0 ? plusHalf : minusHalf;'));
  // The helper must stay inside the content rig, like the rest of the chunk.
  for (const physical of ['uLens[', 'uRot[', 'uIntr[', 'uRaster[', 'uLimb[', 'uRadius']) {
    assert.ok(!blend.source.includes(physical));
  }
});

test('on an uneven ring the wedge rule leaves no lit surface unweighted', () => {
  // Why the structural test above is worth having, stated as arithmetic rather
  // than as an assertion about source text. A headless test cannot run the
  // shader, and transliterating it here would only fail when somebody
  // remembered to update the copy — so this pins the PROPERTY the rule has to
  // have, against `packages/sim`'s implementation of it and against the even
  // split the shader used to use.
  //
  // Any point some projector physically lights must come out with a positive
  // normalised weight. Under 360/N on a three-projector ring it does not: the
  // survivors' wedges are widened to 120 degrees, and the surface past the
  // widened wedge but still inside the real footprint belongs to nobody.
  const world = buildWorld({ ...BOULDER_PRESET, projectorCount: 3, mountError: 0 });
  const rig = prepareRig(world.compositorRig);
  assert.equal(rig.projectors.length, 3);

  const R = world.compositorRig.sphere.radiusM;
  let litSamples = 0;
  let unweighted = 0;
  for (let k = 0; k < 3600; k++) {
    const lonDeg = -180 + (360 * k) / 3600;
    const lon = (lonDeg * Math.PI) / 180;
    const point = { x: R * Math.cos(lon), y: R * Math.sin(lon), z: 0 };
    const { weights, lit } = coverageAndWeights(point, rig);
    if (!lit.some(Boolean)) continue;
    litSamples++;
    if (weights.reduce((a, b) => a + b, 0) <= 0) unweighted++;
  }
  assert.ok(litSamples > 0, 'the fixture lit nothing');
  assert.equal(unweighted, 0, `${unweighted} of ${litSamples} lit equator samples carry no weight`);

  // And the point where the two rules actually part company, so this test is a
  // comparison and not just a sanity check. P1 sits at azimuth 0 and the dark
  // quadrant runs from 180 back to 360, so P1's negative-side boundary is the
  // midpoint to P3 at 180 — a half-width of 90 degrees. An even three-way split
  // would put it at 60. At -75 degrees the surface is inside P1's real footprint
  // (the limb is about 80 degrees out) and inside the measured wedge, but
  // outside the even-split one: this is the longitude the shader used to drop to
  // the projector's black floor.
  const lon = (-75 * Math.PI) / 180;
  const probe = { x: R * Math.cos(lon), y: R * Math.sin(lon), z: 0 };
  const at75 = coverageAndWeights(probe, rig);
  assert.ok(at75.lit[0], 'P1 does not physically reach -75 degrees, so the probe proves nothing');
  assert.ok(
    at75.weights[0] > 0,
    'the wedge stops short of the midpoint to the next lens, which is the 360/N rule',
  );
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
  // The rail is the same hazard and had the same rule stated about it in prose
  // while defaulting the other way. It got away with it only because the room
  // march refused to run without markers; the moment the guard rail earned its
  // own toggle, the parity check went red.
  assert.equal(u.rail, 0, 'the guard rail must be opt-in, or the parity render draws one');
  assert.equal(u.aimGuides, 0);
  assert.equal(u.drawFloor, 1, 'the floor is the one piece of scenery that is opt-OUT');
  assert.equal(u.exposure, 1, 'a linear readback must not be scaled by a viewing gain');
  assert.equal(u.lift, 1, 'a linear readback must not be bent by a viewing tone curve');
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

  // A pick answers in RIG indices, and the rig omits every projector that is
  // switched off. Turning P2 off leaves the rig [P1, P3, P4]: the third marker
  // on screen is rig index 2 and panel slot 3, and a page that used the rig
  // index directly put the sliders on P3 while the viewer was looking at P4.
  const slots = [0, 2, 3];
  assert.equal(slotOfRigIndex(2, slots), 3, 'the last marker is P4, not P3');
  assert.equal(slotOfRigIndex(1, slots), 2);
  assert.equal(slotOfRigIndex(0, slots), 0);
  assert.equal(slotOfRigIndex(-1, slots), -1, 'a miss stays a miss');
  // With nothing switched off the two indices are the same thing, which is why
  // the bug survived: every test rig has all four on.
  assert.equal(slotOfRigIndex(2, [0, 1, 2, 3]), 2);
  assert.equal(slotOfRigIndex(2, undefined), 2);

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

test('the shader places the same sample grid the model does, and averages before the encode', () => {
  // `gridSampleOffset` in `sim/src/render.ts` puts sample (i, j) of an n x n set
  // at ((i + 0.5) / n, (j + 0.5) / n). The shader has to place the SAME points or
  // the parity readout is comparing sampling patterns instead of renderers, and
  // this is the one term of it no CPU test can reach.
  const main = FRAGMENT_CHUNKS.find((c) => c.name === 'main');
  assert.ok(main, 'the shader has no entry point');
  assert.ok(
    /\(vec2\(float\(i\), float\(j\)\) \+ 0\.5\) \/ float\(n\)/.test(main.source),
    'the shader must place samples at (i + 0.5) / n, as gridSampleOffset does',
  );

  // Radiance is what adds. The average has to be taken while the values are
  // still linear — after the display encode a half-covered pixel comes out the
  // wrong brightness, which is the classic too-dark antialiased edge.
  const divide = main.source.indexOf('c /= float(n * n)');
  const exposure = main.source.indexOf('c *= uExposure');
  const encode = main.source.indexOf('uDisplayGamma');
  assert.ok(divide > 0, 'the samples are never averaged');
  assert.ok(divide < exposure, 'the samples are averaged after exposure');
  assert.ok(divide < encode, 'the samples are averaged after the display encode');
});

test('on a shifted frame the pick follows the picture, not the raw screen point', () => {
  // The shader traces `(uv * 2 - 1) + vec2(0, uCamShift)`; `eyeRay` did not add
  // the term, so on any narrow viewport the picker tested a ray from a different
  // screen position than the one drawn. `viewShiftFrac` in web/main.ts is zero
  // above 820 px and non-zero below it, which made this a defect that existed
  // only on phones and in portrait — where a tap is hardest to land and where
  // `pickMarkerNear`'s fingertip radius exists for that reason. A miss is not
  // inert: `markerUnder` returning -1 sends the tap into the "clicked the room"
  // branch, which clears the highlight and shuts the projector card, so tapping
  // a lens actively closed the thing it was meant to open.
  const world = buildWorld(BOULDER_PRESET);
  const physical = prepareRig(world.truthRig);
  const content = prepareRig(world.compositorRig);
  const shift = 0.35;

  for (let i = 0; i < world.truthRig.projectors.length; i++) {
    const lens = world.truthRig.projectors[i].pose.position;
    const len = Math.hypot(lens.x, lens.y, lens.z);
    const outside = { x: (lens.x / len) * (len + 3), y: (lens.y / len) * (len + 3), z: lens.z };
    const base = buildViewer(BOULDER_PRESET, 64, 48);
    const camera = { ...base, position: outside, target: lens, imageShift: shift };
    const u = buildDisplayUniforms(physical, content, world.scene, camera, {
      markerRadiusM: 0.12,
    });
    assert.equal(u.camShift, shift, 'the shift did not reach the uniforms');

    // The shader puts the lens at NDC y = -shift: it adds `camShift` to the
    // image coordinate, so the point that traces down the barrel is the one
    // whose ndcY cancels it.
    assert.equal(
      pickMarker(u, 0, -shift),
      i,
      `P${i + 1} is not pickable where the shader draws it`,
    );
    // And the raw screen centre now looks somewhere else entirely, which is what
    // the operator was tapping and missing.
    assert.notEqual(
      pickMarker(u, 0, 0),
      i,
      'the shifted frame still picks at the unshifted point, so the term is being ignored',
    );
  }
});

test('a video hands the content texture back rather than leaving a stale key behind', () => {
  // `ensureContent` returns early while a video is playing, because the decode
  // pass owns the texture and re-uploading the model's snapshot would stutter.
  // It returned WITHOUT touching `contentKey`, and the decode pass writes the
  // same texture the key describes — so the key went on naming a still that was
  // no longer in the texture. Switch to another content and back and the second
  // switch away is a cache HIT: no re-upload, and the sphere keeps showing the
  // video's last decoded frame under a chip row saying Blue Marble, with every
  // number and every projector preview computed from the still.
  const fn = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('function ensureContent('),
    MAIN_SOURCE.indexOf('function ensureContent(') + 1600,
  );
  const early = fn.slice(fn.indexOf('if (videoActive())'), fn.indexOf('const key ='));
  assert.ok(early.length > 0, 'ensureContent no longer has a video early-out');
  assert.ok(
    /contentKey = ''/.test(early),
    'the video early-out leaves the content key naming a still the texture no longer holds',
  );
});

test('the video snapshot warning is released, not latched', () => {
  // Written in one place and cleared nowhere, so one transient read-back failure
  // pinned a present-tense sentence — "the readout and the parity check are
  // describing an older frame" — under the content chips for the life of the
  // page, including with no video on it at all.
  const writes = [...MAIN_SOURCE.matchAll(/snapshotError = /g)].length;
  assert.ok(writes >= 3, `snapshotError is assigned ${writes} times; it needs a release path`);
  const snap = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('function snapshotVideo('),
    MAIN_SOURCE.indexOf('function snapshotVideo(') + 900,
  );
  const success = snap.slice(0, snap.indexOf('} catch'));
  assert.ok(
    /snapshotError = ''/.test(success),
    'a successful snapshot does not clear the warning left by a failed one',
  );
});

test('a lost GPU context is asked back, and never read as a model disagreement', () => {
  // A lost context throws nothing: every GL call afterwards is a silent no-op,
  // and `preserveDrawingBuffer: true` leaves the last frame on screen, so the
  // page looks alive while the picture is frozen. Three separate things were
  // missing and each has its own consequence.
  //
  // Recoverability: per the WebGL spec the browser only attempts restoration
  // when the lost handler calls `preventDefault`. With no listener at all the
  // default stands, `webglcontextrestored` never fires, and a reload is the only
  // way back.
  assert.ok(
    /webglcontextlost/.test(MAIN_SOURCE),
    'nothing listens for the context being lost',
  );
  const lost = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf("addEventListener('webglcontextlost'"));
  assert.ok(
    /preventDefault\(\)/.test(lost.slice(0, 400)),
    'the lost handler does not call preventDefault, so the browser will not restore',
  );
  assert.ok(
    /webglcontextrestored/.test(MAIN_SOURCE),
    'nothing rebuilds the context when the browser offers it back',
  );
  // The rebuild has to re-upload: every GPU object went with the context.
  const restored = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf("addEventListener('webglcontextrestored'"));
  assert.ok(
    /contentKey = ''/.test(restored.slice(0, 700)),
    'the rebuild does not invalidate the uploaded content',
  );

  // Honesty: the parity check reads pixels back off the context. Against a dead
  // one it compares a frozen frame with a live CPU render and reports the two
  // renderers disagreeing — the page's most confident sentence, about the one
  // thing that had not gone wrong.
  assert.ok(
    /contextLost && !\(videoActive\(\)/.test(MAIN_SOURCE),
    'a parity comparison can still be requested against a lost context',
  );
});

test('the viewer lens shift moves the frame, not the aim', () => {
  // `ViewerCamera.imageShift` is a principal-point offset: it is added to the
  // IMAGE coordinate and must never touch the camera basis. A shader that
  // implemented it by tilting `uCamForward` would compose the same picture and
  // stretch the sphere, which is the whole thing this term exists to avoid — and
  // it would still pass the parity check, because the CPU camera would be built
  // from the same numbers.
  const main = FRAGMENT_CHUNKS.find((c) => c.name === 'main');
  assert.ok(main);
  assert.ok(
    main.source.includes('vec2(0.0, uCamShift)'),
    'uCamShift must be added to the image coordinate the sample loop passes to traceScene',
  );
  const basis = FRAGMENT_SHADER.slice(FRAGMENT_SHADER.indexOf('vec3 traceScene('));
  assert.ok(
    !basis.slice(0, basis.indexOf('void main(')).includes('uCamShift'),
    'traceScene must take an image coordinate that already carries the shift, not apply it',
  );
});

test('the video decode pass writes linear light with the same exponent the CPU uses', () => {
  // A dropped IMAGE is decoded on the CPU by `readEquirect`; a dropped VIDEO is
  // decoded on the GPU, once per frame, by this. Two processors applying one
  // convention — and if they drift, the sphere is a different brightness
  // depending on which kind of file it was handed, which nothing else would
  // catch: the parity check compares the two RENDERERS against one texture and
  // is blind to how that texture was made.
  assert.ok(
    CONTENT_DECODE_FRAGMENT.includes(`pow(max(c, vec3(0.0)), vec3(${CONTENT_DECODE_GAMMA}))`),
    `the decode pass must raise the frame to ${CONTENT_DECODE_GAMMA}, as readEquirect does`,
  );
  // Straight into the equirect texture, no flip. Its row 0 is the north row and
  // a frame uploaded with UNPACK_FLIP_Y_WEBGL off puts the top of the picture at
  // the same end; a flip here would render every map upside down.
  assert.ok(
    CONTENT_DECODE_FRAGMENT.includes('texture(uFrame, vUv)'),
    'the decode pass must sample the frame at the target coordinate, unflipped',
  );
  // It is a PASS, not a sample-time decode. A shader that decoded per sample
  // would interpolate encoded values where the CPU model interpolates linear
  // ones, and the two are not the same function.
  assert.ok(!FRAGMENT_SHADER.includes('uFrame'), 'the display shader must not sample a video');
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
