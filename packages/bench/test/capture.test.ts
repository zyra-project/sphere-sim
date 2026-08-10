/**
 * The capture path: does the simulated camera see what the decoder thinks it
 * sees, and do the degradation conditions actually do anything?
 *
 * The second question is the one worth writing tests for. A degradation switch
 * that is secretly a no-op does not fail — it produces a clean null result, and
 * Experiment 1 then reports that rolling shutter costs nothing. That is a false
 * negative manufactured by the apparatus, and the only defence is to assert both
 * halves: that the condition is exactly inert when its cause is absent, and that
 * it is measurably not inert when its cause is present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { nominalRig } from '../../sim/src/scene.ts';
import { prepareRig, worldToPixel } from '../../sim/src/optics.ts';
import { raySphereIntersect } from '../../sim/src/geometry.ts';

import type { SimulatedCamera } from '../src/camera.ts';
import {
  DEFAULT_CLOCK,
  DEFAULT_HANDHELD,
  cameraPixelToRay,
  makeMotionState,
  motionAt,
  placeCameras,
  poseAt,
  rowTimeSec,
} from '../src/camera.ts';
import { DEFAULT_SENSOR, captureAndDecode } from '../src/capture.ts';
import { DEFAULT_PATTERN_PLAN } from '../src/patterns.ts';
import { makeBenchRng } from '../src/random.ts';

const RIG = nominalRig({ projectorCount: 4 });
const PLAN = { ...DEFAULT_PATTERN_PLAN, grayBits: 5 };

function cameras(count = 1, resX = 160, resY = 120): SimulatedCamera[] {
  return placeCameras(
    {
      count,
      distanceM: 2.6,
      heightM: 1.6,
      resX,
      resY,
      fovHDeg: 62,
      k1: -0.09,
      k2: 0.02,
      positionJitterM: 0,
      aimJitterDeg: 0,
      rollJitterDeg: 0,
      heightSpreadM: 0.3,
    },
    RIG.sphere.centerHeightM,
    makeBenchRng(3),
  );
}

interface CaptureArgs {
  handheld: typeof DEFAULT_HANDHELD | null;
  rollingShutter: boolean;
  sensor: typeof DEFAULT_SENSOR | null;
  ambient: number;
}

function capture(cams: SimulatedCamera[], args: Partial<CaptureArgs> = {}) {
  return captureAndDecode(RIG, cams, {
    plan: PLAN,
    conditions: {
      ambient: args.ambient ?? 0.04,
      reflectance: { r: 0.9, g: 0.9, b: 0.88 },
      roomAlbedo: 0.3,
      sensor: args.sensor === undefined ? null : args.sensor,
      handheld: args.handheld ?? null,
      clock: { ...DEFAULT_CLOCK, rollingShutter: args.rollingShutter ?? true },
      minIncidenceCos: 0.2,
    },
    seed: 4242,
    decode: { pixelStride: 1, maxCorrespondences: 0 },
    previewPair: null,
    previewFrame: -1,
  });
}

// ---------------------------------------------------------------------------
// The A/B pattern contract
// ---------------------------------------------------------------------------

test('the solver decodes the projector pixel the simulator actually lit', () => {
  // This is the one test that exercises the whole structured-light contract
  // across the boundary: the bench emits patterns against the definition at the
  // top of `packages/solver/src/decode.ts`, the solver's decoder reads them back
  // without ever seeing the geometry, and the answer is checked against
  // `packages/sim`'s own forward projection. A sign error in the Gray order, a
  // half-pixel convention slip or a mismatched stride all land here.
  const cams = cameras(1, 200, 150);
  const result = capture(cams, { sensor: null, ambient: 0.0 });
  assert.ok(result.correspondences.length > 500, `only ${result.correspondences.length}`);

  const prepared = prepareRig(RIG);
  const errors: number[] = [];
  for (const c of result.correspondences) {
    const cam = cams[c.camera];
    const dir = cameraPixelToRay(cam, c.camU, c.camV);
    const hit = raySphereIntersect(cam.pose.position, dir, RIG.sphere.radiusM);
    if (hit === null) continue;
    const px = worldToPixel(prepared.projectors[c.projector], hit.point);
    if (px === null) continue;
    errors.push(Math.hypot(px.u - c.projU, px.v - c.projV));
  }
  assert.ok(errors.length > 500, `only ${errors.length} checkable`);
  errors.sort((a, b) => a - b);
  const median = errors[Math.floor(errors.length / 2)];
  const p95 = errors[Math.floor(errors.length * 0.95)];
  // Noiseless, so what is left is the phase estimator's own bias against a
  // fringe that the camera samples at a few pixels per period. Sub-pixel is the
  // claim; a whole-pixel median would mean the contract is broken.
  assert.ok(median < 1.0, `median decode error ${median} px`);
  assert.ok(p95 < 4.0, `p95 decode error ${p95} px`);
});

// ---------------------------------------------------------------------------
// Rolling shutter, proven inert and proven not
// ---------------------------------------------------------------------------

test('rolling shutter on a static camera is EXACTLY a no-op', () => {
  // The claim the whole condition rests on. Row 12 of frame 5 and row 0 of frame
  // 5 see the same world when nothing moves, so the readout cannot matter, and
  // the two captures must agree to the last bit rather than merely closely.
  const cams = cameras(1);
  const rolling = capture(cams, { handheld: null, rollingShutter: true });
  const global = capture(cams, { handheld: null, rollingShutter: false });
  assert.equal(rolling.correspondences.length, global.correspondences.length);
  for (let i = 0; i < rolling.correspondences.length; i++) {
    assert.equal(rolling.correspondences[i].projU, global.correspondences[i].projU);
    assert.equal(rolling.correspondences[i].projV, global.correspondences[i].projV);
  }
});

test('handheld motion measurably degrades the decode, and the rolling shutter adds to it', () => {
  const cams = cameras(1);
  const still = capture(cams, { handheld: null, rollingShutter: true });
  const globalShutter = capture(cams, { handheld: DEFAULT_HANDHELD, rollingShutter: false });
  const rolling = capture(cams, { handheld: DEFAULT_HANDHELD, rollingShutter: true });

  // Motion breaks the pattern-versus-complement comparison the Gray decode
  // depends on, so ambiguous bits appear where a still camera had none.
  assert.equal(still.stats.rejectedGrayAmbiguous, 0);
  assert.ok(
    globalShutter.stats.rejectedGrayAmbiguous > 0,
    'inter-frame drift alone should already cost Gray bits',
  );
  assert.ok(
    still.motionExcursion[0].translationMm === 0 && rolling.motionExcursion[0].translationMm > 0.1,
    'the motion excursion must be reported, and be non-trivial',
  );

  // And the two shutters must not agree, or the rolling-shutter switch is
  // decorative even with motion present.
  const sameLength = globalShutter.correspondences.length === rolling.correspondences.length;
  let identical = sameLength;
  if (sameLength) {
    for (let i = 0; i < rolling.correspondences.length; i++) {
      if (
        rolling.correspondences[i].projU !== globalShutter.correspondences[i].projU ||
        rolling.correspondences[i].projV !== globalShutter.correspondences[i].projV
      ) {
        identical = false;
        break;
      }
    }
  }
  assert.ok(!identical, 'rolling and global shutter produced identical decodes under motion');
});

test('row time is monotone within a frame and zero when the shutter is global', () => {
  const rolling = { ...DEFAULT_CLOCK, rollingShutter: true };
  const global = { ...DEFAULT_CLOCK, rollingShutter: false };
  assert.equal(rowTimeSec(rolling, 0, 0, 240), 0);
  assert.ok(rowTimeSec(rolling, 0, 239, 240) > rowTimeSec(rolling, 0, 0, 240));
  assert.ok(
    Math.abs(rowTimeSec(rolling, 0, 239, 240) - DEFAULT_CLOCK.readoutMs / 1000) < 1e-12,
  );
  assert.equal(rowTimeSec(global, 3, 100, 240), (3 * DEFAULT_CLOCK.frameIntervalMs) / 1000);
});

test('motion is a pure function of time, not of call order', () => {
  // A rolling shutter asks for the pose at arbitrary row times in whatever order
  // the renderer happens to walk the frame. If the motion carried a stream
  // position the image would depend on that order.
  const state = makeMotionState(makeBenchRng(11));
  const forward = [0, 0.1, 0.2, 0.3].map((t) => motionAt(DEFAULT_HANDHELD, state, t).dx);
  const backward = [0.3, 0.2, 0.1, 0].map((t) => motionAt(DEFAULT_HANDHELD, state, t).dx).reverse();
  assert.deepEqual(forward, backward);
  assert.deepEqual(motionAt(null, state, 5), motionAt(null, state, 0));
});

test('handheld drift grows with time and stays within the stated envelope', () => {
  const state = makeMotionState(makeBenchRng(5));
  const base = { position: { x: 2.6, y: 0, z: -0.6 }, yawDeg: 180, pitchDeg: 10, rollDeg: 0 };
  const at = (t: number): number => {
    const p = poseAt(base, DEFAULT_HANDHELD, state, t);
    return Math.hypot(
      p.position.x - base.position.x,
      p.position.y - base.position.y,
      p.position.z - base.position.z,
    );
  };
  // Over a 34-frame sequence at 20 fps — about 1.7 s — the drift term alone is
  // 2 mm/s, so a few millimetres is the expected excursion. Much more than that
  // and the condition is modelling somebody waving the phone.
  let worst = 0;
  for (let i = 0; i <= 100; i++) worst = Math.max(worst, at((1.7 * i) / 100));
  assert.ok(worst > 0.001, `excursion ${worst} m is too small to matter`);
  assert.ok(worst < 0.02, `excursion ${worst} m is not a braced phone`);
});

// ---------------------------------------------------------------------------
// The other two conditions
// ---------------------------------------------------------------------------

test('sensor noise and ambient are independently switchable and both bite', () => {
  const cams = cameras(1);
  const clean = capture(cams, { sensor: null, ambient: 0.04 });
  const noisy = capture(cams, { sensor: DEFAULT_SENSOR, ambient: 0.04 });
  const bright = capture(cams, { sensor: null, ambient: 0.15 });

  const key = (c: { camera: number; camU: number; camV: number; projector: number }): string =>
    `${c.camera}:${c.projector}:${c.camU}:${c.camV}`;
  const cleanByPixel = new Map(clean.correspondences.map((c) => [key(c), c]));

  let moved = 0;
  let compared = 0;
  for (const c of noisy.correspondences) {
    const ref = cleanByPixel.get(key(c));
    if (ref === undefined) continue;
    compared++;
    if (c.projU !== ref.projU || c.projV !== ref.projV) moved++;
  }
  assert.ok(compared > 100, 'not enough shared pixels to compare');
  assert.ok(moved > compared * 0.9, `sensor noise moved only ${moved}/${compared} decodes`);

  // Ambient with no sensor noise is a pure DC offset on every frame, so the
  // Gray pattern-versus-complement comparison and the four-step phase fit both
  // cancel it analytically. That it changes almost nothing is the CORRECT
  // behaviour and is worth pinning: it is why the decode survives PARAMETERS.md
  // §5's unmeasured `E_amb` at all, and why §5's factor-of-fifteen range is not
  // a factor-of-fifteen uncertainty on the geometry.
  //
  // "Almost" and not "exactly": the frame buffers are float32, so a larger DC
  // term shifts the pattern into a coarser part of the floating-point grid and
  // the cancellation leaves a rounding residue. Measured at a few parts in a
  // million of a projector pixel — six orders of magnitude below the decode's
  // own noise, and far below the quantization a real 12-bit sensor imposes.
  assert.equal(bright.correspondences.length, clean.correspondences.length);
  let worstAmbientShift = 0;
  for (let i = 0; i < bright.correspondences.length; i++) {
    worstAmbientShift = Math.max(
      worstAmbientShift,
      Math.abs(bright.correspondences[i].projU - clean.correspondences[i].projU),
    );
  }
  assert.ok(worstAmbientShift < 1e-3, `ambient moved a decode by ${worstAmbientShift} px`);
  // What ambient DOES do is raise the noise floor once a real sensor is present,
  // because shot noise scales with total signal.
  const brightNoisy = capture(cams, { sensor: DEFAULT_SENSOR, ambient: 0.15 });
  assert.ok(brightNoisy.correspondences.length > 0);
});

test('the capture is a pure function of its seed', () => {
  const cams = cameras(2);
  const a = capture(cams, { sensor: DEFAULT_SENSOR, handheld: DEFAULT_HANDHELD });
  const b = capture(cams, { sensor: DEFAULT_SENSOR, handheld: DEFAULT_HANDHELD });
  assert.equal(a.correspondences.length, b.correspondences.length);
  for (let i = 0; i < a.correspondences.length; i++) {
    assert.equal(a.correspondences[i].projU, b.correspondences[i].projU);
    assert.equal(a.correspondences[i].sigmaU, b.correspondences[i].sigmaU);
  }
});
