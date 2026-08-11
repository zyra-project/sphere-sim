/**
 * The parity check, and the thing it is for.
 *
 * Four claims:
 *
 *  1. **The GLSL reference and `packages/sim` agree**, on the nominal rig and on
 *     five configurations chosen to reach the parts of the model the nominal one
 *     does not: distortion, lens shift, a colatitude mask, a diverged transfer,
 *     and a two-projector install.
 *  2. **Both halves of the model are covered.** The room track never calls
 *     `pixelToRay`; the projector track never calls the shading model, the floor
 *     or the ambient term. Checking one alone leaves half the shader unmeasured.
 *  3. **The check fails when the model is wrong.** A parity check nobody has
 *     watched fail is not a check, so a deliberately broken uniform block —
 *     mask disabled, ramp exponent moved, black floor zeroed — must be caught,
 *     one at a time.
 *  4. **The projector-track shortcut is the same calculation as
 *     `renderProjectorView`.** `simProjectorSamples` evaluates the tracer's inner
 *     loop on a sample grid instead of a full raster; at a raster small enough to
 *     render whole, the two must agree bit for bit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOUNDARY_PIXEL_ALLOWANCE,
  MODEL_TOLERANCE,
  checkModelParity,
  comparePixels,
  simProjectorSamples,
} from '../src/parity.ts';
import { buildUniforms } from '../src/uniforms.ts';
import { renderRoomReference } from '../src/reference.ts';
import { buildWorld, buildImage } from '../src/state.ts';
import type { HarnessState } from '../src/params.ts';
import { defaultState } from '../src/params.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { renderProjectorView } from '../../sim/src/render.ts';
import { nominalRig } from '../../sim/src/scene.ts';
import { defaultScene } from '../../sim/src/render.ts';
import { viewerAt } from '../../sim/src/render.ts';

const WIDTH = 96;
const HEIGHT = 72;

function world(overrides: HarnessState = {}, pattern: 'graticule' | 'mid-gray' = 'graticule') {
  return buildWorld({ ...defaultState(), ...overrides }, pattern, {
    textureWidth: 512,
    textureHeight: 256,
    viewWidth: WIDTH,
    viewHeight: HEIGHT,
  });
}

const CASES: { name: string; state: HarnessState; why: string }[] = [
  { name: 'nominal', state: {}, why: 'PARAMETERS.md nominal, four projectors' },
  {
    name: 'distortion + shift',
    state: { k1: 0.03, k2: -0.008, shiftH: 0.05, shiftV: -0.04, roll: 1.2, phi_jitter: 1.5 },
    why: 'reaches the Brown-Conrady inversion and the shifted principal point',
  },
  {
    name: 'colatitude mask',
    state: { mask_interp: 1 },
    why: 'docs/AMENDMENTS.md A-02: the other reading of `set bottommask 60,70`',
  },
  {
    name: 'diverged transfer',
    state: { gamma_B: 2.4, g_R: 1.08, L_black_B: 0.003, E_amb: 0.12, E_amb_chroma: 2800 },
    why: 'PARAMETERS.md §3.2’s worked example plus a tinted ambient',
  },
  {
    name: 'specular lobe',
    state: { rho_spec: 0.06, alpha_spec: 0.3 },
    why: 'the GGX branch of §1, which lambertian-v1 skips entirely',
  },
  {
    name: 'two projectors',
    state: { N_proj: 2, w_width: 8, ramp_shape: 3, gamma_blend: 1.3 },
    why: '§2’s opposed pair, a gaussian ramp, and a ramp exponent away from 0.8',
  },
];

test('the GLSL reference and packages/sim agree, on every configuration', () => {
  for (const c of CASES) {
    const w = world(c.state);
    const report = checkModelParity(w.rig, w.scene, w.viewer, {
      width: WIDTH,
      height: HEIGHT,
      projectorWidth: 64,
      projectorHeight: 36,
      specWeight: w.state.rho_spec,
      specAlpha: w.state.alpha_spec,
      shading: w.shading,
    });
    assert.equal(
      report.pass,
      true,
      `${c.name} (${c.why}): ${report.summary}\n` +
        report.tracks
          .map(
            (t) =>
              `  ${t.id}: p99.9 ${t.delta.p999.toExponential(3)}, max ${t.delta.maxAbs.toExponential(3)}, ` +
              `${t.delta.pixelsOverTolerance}/${t.delta.pixelCount} over tolerance`,
          )
          .join('\n'),
    );
  }
});

test('both halves of the model are covered by a track', () => {
  const w = world();
  const report = checkModelParity(w.rig, w.scene, w.viewer, {
    width: 48,
    height: 36,
    projectorWidth: 32,
    projectorHeight: 18,
  });
  const ids = report.tracks.map((t) => t.id);
  assert.ok(ids.includes('room'), 'no room track');
  assert.equal(ids.filter((id) => id.startsWith('projector-')).length, 4, 'not every projector checked');
  // The two tracks must describe DIFFERENT coverage, or one of them is decoration.
  const covers = new Set(report.tracks.map((t) => t.covers));
  assert.equal(covers.size, 2);
});

test('the check fails when the model is wrong, one term at a time', () => {
  const w = world({ mask_interp: 0 });
  const camera = w.viewer;
  const good = buildUniforms(w.rig, w.scene, camera, { mode: 'room', displayGamma: 0 });
  const simLike = renderRoomReference(good, WIDTH, HEIGHT);

  const breakages: { what: string; mutate: (u: ReturnType<typeof buildUniforms>) => void }[] = [
    { what: 'polar mask disabled', mutate: (u) => { u.maskLo = 90; u.maskHi = 90; } },
    { what: 'ramp exponent moved off 0.8', mutate: (u) => { u.rampGamma = 1.6; } },
    { what: 'black floor zeroed', mutate: (u) => { for (const p of u.projectors) p.black = { r: 0, g: 0, b: 0 }; } },
    { what: 'blend width halved', mutate: (u) => { u.widthDeg = 10; } },
    { what: 'encode gamma off by 0.2', mutate: (u) => { u.encodeGamma = { r: 2.4, g: 2.4, b: 2.4 }; } },
  ];

  for (const b of breakages) {
    const broken = buildUniforms(w.rig, w.scene, camera, { mode: 'room', displayGamma: 0 });
    b.mutate(broken);
    const other = renderRoomReference(broken, WIDTH, HEIGHT);
    const delta = comparePixels(simLike, other, MODEL_TOLERANCE);
    assert.ok(
      delta.p999 > MODEL_TOLERANCE || delta.fractionOverTolerance > BOUNDARY_PIXEL_ALLOWANCE,
      `${b.what} was NOT caught: p99.9 ${delta.p999.toExponential(3)}, ` +
        `${(delta.fractionOverTolerance * 100).toFixed(3)}% of pixels over tolerance`,
    );
  }
});

test('the projector-track shortcut is the tracer’s own inner loop', () => {
  // A raster small enough to render whole, so `simProjectorSamples` and
  // `renderProjectorView` are sampling exactly the same pixel centres.
  const rig = nominalRig({ resX: 64, resY: 36 });
  const scene = defaultScene(buildImage('graticule', 256, 128));
  const prepared = prepareRig(rig);
  const whole = renderProjectorView(prepared, 0, scene, { samplesPerPixel: 1 });
  const sampled = simProjectorSamples(prepared, 0, scene, 64, 36);
  const delta = comparePixels(whole, sampled, 0);
  assert.equal(delta.maxAbs, 0, 'the shortcut is not the same calculation as renderProjectorView');
});

test('comparePixels refuses to compare rasters of different size', () => {
  const a = { width: 4, height: 4, data: new Float32Array(48) };
  const b = { width: 8, height: 4, data: new Float32Array(96) };
  assert.throws(() => comparePixels(a, b, 1e-9), /identical rasters/);
});

test('a room render is not a black frame, so the parity number means something', () => {
  // A parity check between two black images passes perfectly and proves nothing.
  const w = world();
  const u = buildUniforms(w.rig, w.scene, { ...w.viewer, width: 64, height: 48 }, {
    mode: 'room',
    displayGamma: 0,
  });
  const img = renderRoomReference(u, 64, 48);
  let lit = 0;
  let bright = 0;
  for (let i = 0; i < img.data.length; i += 3) {
    if (img.data[i] > 1e-4) lit++;
    if (img.data[i] > 0.2) bright++;
  }
  assert.ok(lit > 64 * 48 * 0.4, `only ${lit} of ${64 * 48} pixels carry any light`);
  assert.ok(bright > 50, `only ${bright} pixels are actually bright — is the sphere in frame?`);
});

test('viewerAt places a viewer who is looking up at the equator', () => {
  // PARAMETERS.md §6: the equator sits at 2.18 m so everybody looks up.
  const adult = viewerAt(45, 2.5, 1.6, 2.1844, 64, 48, 50);
  const child = viewerAt(45, 2.5, 1.15, 2.1844, 64, 48, 50);
  assert.ok(adult.position.z < 0, 'the adult viewer is not below the sphere centre');
  assert.ok(child.position.z < adult.position.z, 'the child is not lower than the adult');
});
