// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
import { isDeepStrictEqual } from 'node:util';

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
import type { SurfaceMesh } from '../../calibration/src/index.ts';
import { meshSurface } from '../../sim/src/mesh/surface.ts';
import type { Surface } from '../../sim/src/surface.ts';
import type { CameraPlacementOptions } from '../src/camera.ts';
import type {
  CaptureOptions,
  CaptureResult,
  ExposurePart,
  RoomSpill,
  SensorModel,
  ShutterStraddle,
} from '../src/capture.ts';
import {
  DEFAULT_ROOM_SPILL,
  DEFAULT_SENSOR,
  captureAndDecode,
  makeSensor,
  pairNoiseSeed,
  roomHit,
} from '../src/capture.ts';
import type { PatternPlan } from '../src/patterns.ts';
import { DEFAULT_PATTERN_PLAN, planFrames } from '../src/patterns.ts';
import { makeBenchRng } from '../src/random.ts';
import type { RunOptions } from '../src/run.ts';
import { buildWorld, captureOptionsFor, planPatternFor, runScenario } from '../src/run.ts';
import { PRESETS, makeScenario } from '../src/scenarios.ts';
import type {
  Correspondence,
  DecodeStats,
  LinearImage,
  PatternCapture,
  SilhouetteOptions,
} from '../../solver/src/index.ts';
import { bundleStateFromCalibration, decodeCapture, sphereSegmenter } from '../../solver/src/index.ts';
import { DEFAULT_SEGMENTATION_MARGIN } from '../../solver/src/index.ts';
import { buildMeshIndex, meshSegmenter } from '../../solver/src/mesh.ts';

const RIG = nominalRig({ projectorCount: 4 });
const PLAN = { ...DEFAULT_PATTERN_PLAN, grayBits: 5 };
/** Every noise stream in `capture()` derives from this; see `pairNoiseSeed`. */
const FIXTURE_SEED = 4242;

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
  roomSpill: RoomSpill | null;
  /**
   * Segment against a nominal rig built here in the test, so the test controls
   * exactly what the segmenter is told. `nominalOffsetM` moves every projector
   * away from where it actually is, which is how the second test below proves
   * the segmentation is reading the nominal rather than the truth.
   */
  segmentation: { marginFrac: number; nominalOffsetM?: number } | null;
  segmentImage?: Partial<SilhouetteOptions> | null;
  /** The shape photographed. Omitted is `RIG.sphere`, which every other test wants. */
  surface?: Surface | null;
  /**
   * EXPERIMENT-10's hook. Omitted leaves the field off the conditions
   * altogether, so "absent" and "null" stay two different captures to compare.
   */
  straddle?: ShutterStraddle | null;
  onCapture?: CaptureOptions['onCapture'];
}

/**
 * A segmenter over a rig this test builds, so a test can hand it a nominal that
 * is deliberately wrong. `RIG` is the same object the capture is rendered from,
 * which is exactly the leak the production path must never have — here it is
 * the control, and `nominalOffsetM` is how the leak is proved absent.
 */
function segmenterFor(args: { marginFrac: number; nominalOffsetM?: number }) {
  const off = args.nominalOffsetM ?? 0;
  return sphereSegmenter({
    radiusM: RIG.sphere.radiusM,
    projectors: bundleStateFromCalibration(RIG, []).projectors.map((p) => ({
      ...p,
      position: { x: p.position.x + off, y: p.position.y, z: p.position.z },
    })),
    marginFrac: args.marginFrac,
  });
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
      roomSpill: args.roomSpill ?? null,
      segmentImage: args.segmentImage ?? null,
      ...(args.straddle === undefined ? {} : { straddle: args.straddle }),
    },
    seed: FIXTURE_SEED,
    decode: {
      pixelStride: 1,
      maxCorrespondences: 0,
      segmentation: args.segmentation ? segmenterFor(args.segmentation) : null,
    },
    previewPairs: [],
    previewFrame: -1,
    surface: args.surface ?? null,
    ...(args.onCapture === undefined ? {} : { onCapture: args.onCapture }),
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

// ---------------------------------------------------------------------------
// Where the camera was when the decode says it measured
// ---------------------------------------------------------------------------

test('the reference-epoch pose is the pose the solver reports against, and it is NOT the static one', () => {
  // Round 3's critic found that `camera_pose_rotation` was scored against the
  // camera's static placement while the solver reports the pose at its own mean
  // observation epoch, which made the gate unreachable: a PERFECT solver scored
  // 0.08-0.33 deg against a 0.07 deg limit. The bench now computes where the
  // camera actually was at that epoch, and this pins the two properties that
  // makes the correction meaningful rather than cosmetic.
  const cams = cameras(2);

  // 1. With no motion, the epoch pose IS the static pose, exactly. A correction
  //    that moved the static case would be inventing an error, not removing one.
  const still = capture(cams, { handheld: null });
  for (let i = 0; i < cams.length; i++) {
    const at = still.cameraPoseAtEpoch[i];
    assert.equal(at.position.x, cams[i].pose.position.x);
    assert.equal(at.yawDeg, cams[i].pose.yawDeg);
    assert.equal(still.epochDisplacement[i].translationMm, 0);
    assert.equal(still.epochDisplacement[i].rotationDeg, 0);
  }

  // 2. With motion, it is NOT the static pose, and the gap is the definitional
  //    floor the old metric carried. It has to be comparable with the 0.07 deg
  //    gate or the correction would not have been worth making.
  const moving = capture(cams, { handheld: DEFAULT_HANDHELD });
  let worstGapDeg = 0;
  for (let i = 0; i < cams.length; i++) {
    const at = moving.cameraPoseAtEpoch[i];
    const base = cams[i].pose;
    worstGapDeg = Math.max(
      worstGapDeg,
      Math.hypot(at.yawDeg - base.yawDeg, at.pitchDeg - base.pitchDeg, at.rollDeg - base.rollDeg),
    );
  }
  assert.ok(worstGapDeg > 0.01, `the epoch pose barely moved (${worstGapDeg} deg)`);

  // 3. The epoch is read off the DECODE's own reported epochs, so it lands in
  //    the phase blocks at the end of the sequence rather than at frame zero.
  //    With the standard plan the two phase blocks are frames 26-29 and 30-33.
  for (const f of moving.cameraEpochFrame) {
    assert.ok(f > 20 && f < planLength(), `reference epoch ${f} is not in the phase blocks`);
  }

  // 4. And the inter-epoch displacement — what the solver's differential pose
  //    can see — is much SMALLER than the whole-sequence excursion. Treating
  //    those two as the same quantity was wrong by about 5x.
  for (let i = 0; i < cams.length; i++) {
    assert.ok(
      moving.epochDisplacement[i].rotationDeg < moving.motionExcursion[i].rotationDeg,
      'the four-frame displacement cannot exceed the whole-sequence excursion',
    );
  }
});

function planLength(): number {
  // white + black + 2 axes x grayBits x 2 + 2 axes x phaseSteps.
  return 2 + 4 * PLAN.grayBits + 2 * PLAN.phaseSteps;
}

// ---------------------------------------------------------------------------
// Room spill, proven inert and proven not
// ---------------------------------------------------------------------------

test('room spill off is EXACTLY the capture that was there before it existed', () => {
  // The claim every published number rests on. `bench-results.json` was produced
  // without this condition, and a switch that is not exactly inert when off has
  // moved all of them. Bit-for-bit, not closely.
  const cams = cameras(1);
  const a = capture(cams, { sensor: null, roomSpill: null });
  const b = capture(cams, { sensor: null });
  assert.equal(a.correspondences.length, b.correspondences.length);
  for (let i = 0; i < a.correspondences.length; i++) {
    assert.equal(a.correspondences[i].projU, b.correspondences[i].projU);
    assert.equal(a.correspondences[i].projV, b.correspondences[i].projV);
    assert.equal(a.correspondences[i].camU, b.correspondences[i].camU);
  }
  assert.deepEqual(a.stats, b.stats);
});

test('room spill puts modulated light on pixels that miss the sphere', () => {
  // And the other half, which is the one a false negative hides behind. The
  // condition has to be measurably NOT inert when it is on, or an experiment
  // reporting that spill costs nothing is reporting a property of the apparatus.
  //
  // The signature is specific: off-sphere pixels stop being frame-invariant, so
  // pixels that were rejected on modulation are now considered and either
  // accepted or rejected for a different reason. `considered` counts every pixel
  // either way, so what moves is the split.
  const cams = cameras(1);
  const clean = capture(cams, { sensor: null, roomSpill: null });
  const spilt = capture(cams, { sensor: null, roomSpill: DEFAULT_ROOM_SPILL });

  assert.equal(clean.stats.considered, spilt.stats.considered, 'the raster did not change');
  assert.ok(
    spilt.stats.rejectedLowModulation < clean.stats.rejectedLowModulation,
    `spill must lift pixels over the modulation floor: ${clean.stats.rejectedLowModulation} ` +
      `rejected clean, ${spilt.stats.rejectedLowModulation} with spill`,
  );
  assert.ok(
    spilt.correspondences.length > clean.correspondences.length,
    `spill must produce correspondences the clean capture did not: ` +
      `${clean.correspondences.length} vs ${spilt.correspondences.length}`,
  );
});

test('the correspondences room spill adds are off the sphere, which is what makes them wrong', () => {
  // Not merely "more points". The points spill adds decode to a real projector
  // coordinate from a camera ray that never touched the ball, so back-projecting
  // them against the sphere fails — which is exactly the lie the solver is being
  // asked to absorb, and the reason this is worth measuring at all.
  const cams = cameras(1);
  const clean = capture(cams, { sensor: null, roomSpill: null });
  const spilt = capture(cams, { sensor: null, roomSpill: DEFAULT_ROOM_SPILL });

  const key = (c: { camU: number; camV: number }): string => `${c.camU},${c.camV}`;
  const cleanKeys = new Set(clean.correspondences.map(key));
  const added = spilt.correspondences.filter((c) => !cleanKeys.has(key(c)));
  assert.ok(added.length > 0, 'spill added no new camera pixels');

  let missedTheSphere = 0;
  for (const c of added) {
    const cam = cams[c.camera];
    const dir = cameraPixelToRay(cam, c.camU, c.camV);
    if (raySphereIntersect(cam.pose.position, dir, RIG.sphere.radiusM) === null) missedTheSphere++;
  }
  assert.equal(
    missedTheSphere,
    added.length,
    `${added.length - missedTheSphere} of ${added.length} added correspondences were on the ` +
      'sphere — spill is meant to add ONLY room pixels, so this is a leak into the sphere path',
  );
});

test('the room is a closed box: every ray from inside it lands on a surface', () => {
  // The geometry on its own, because a miss here is silent — the pixel simply
  // falls back to the constant background and the condition quietly does less
  // than it says.
  const spill = { wallRadiusM: 6, ceilingM: 4.27 };
  const floorZ = -2.13;
  const origin = { x: 0.4, y: -0.2, z: 0.1 };
  const rr = spill.wallRadiusM * spill.wallRadiusM;
  let wall = 0;
  let floor = 0;
  let ceiling = 0;
  for (let i = 0; i < 400; i++) {
    // A deterministic spray over the whole sphere of directions.
    const u = (i + 0.5) / 400;
    const z = 1 - 2 * u;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * 2.399963;
    const dir = { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
    const p = roomHit(origin, dir, spill, floorZ);
    assert.ok(p !== null, `direction ${i} left the room`);
    assert.ok(p.z >= floorZ - 1e-9 && p.z <= floorZ + spill.ceilingM + 1e-9, 'outside the walls');
    assert.ok(p.x * p.x + p.y * p.y <= rr + 1e-6, 'outside the cylinder');
    // The normal points INTO the room, or the surface is lit from behind.
    const toCentre = { x: origin.x - p.x, y: origin.y - p.y, z: origin.z - p.z };
    const len = Math.hypot(toCentre.x, toCentre.y, toCentre.z);
    assert.ok(
      (p.nx * toCentre.x + p.ny * toCentre.y + p.nz * toCentre.z) / len > -1e-9,
      `the normal at direction ${i} faces out of the room`,
    );
    if (Math.abs(p.z - floorZ) < 1e-9) floor++;
    else if (Math.abs(p.z - (floorZ + spill.ceilingM)) < 1e-9) ceiling++;
    else wall++;
  }
  // All three surfaces are reachable, or one of them is dead code.
  assert.ok(wall > 0 && floor > 0 && ceiling > 0, `wall ${wall}, floor ${floor}, ceiling ${ceiling}`);
});

test('spill does not light the whole room: the shadow and the frustum still reject', () => {
  // The half that would go missing if the sphere-shadow test or the raster test
  // were dropped. If every off-sphere pixel came back modulated, the condition
  // would be a flood rather than a model, and it would be easy to mistake the
  // resulting collapse for a solver result.
  const cams = cameras(1);
  const spilt = capture(cams, { sensor: null, roomSpill: DEFAULT_ROOM_SPILL });
  assert.ok(
    spilt.stats.rejectedLowModulation > 0,
    'every pixel in the frame carried modulation — nothing is shadowed or outside a raster',
  );
  // And it is a large share: one projector covers a wedge of the room, not all
  // of it, and the ball stands in front of part of that wedge.
  assert.ok(
    spilt.stats.rejectedLowModulation > spilt.correspondences.length,
    `${spilt.stats.rejectedLowModulation} rejected against ${spilt.correspondences.length} ` +
      'accepted — one projector should not be lighting most of what one camera sees',
  );
});

// ---------------------------------------------------------------------------
// Sphere segmentation
// ---------------------------------------------------------------------------

test('segmentation keeps the sphere and throws away the room', () => {
  // The claim, end to end and against ground truth — which is available HERE,
  // in the test, and is not available to the thing being tested.
  const cams = cameras(1);
  const spilt = capture(cams, { sensor: null, roomSpill: DEFAULT_ROOM_SPILL });
  const segmented = capture(cams, {
    sensor: null,
    roomSpill: DEFAULT_ROOM_SPILL,
    segmentation: { marginFrac: 0 },
  });

  const offSphere = (r: ReturnType<typeof capture>): number => {
    let n = 0;
    for (const c of r.correspondences) {
      const cam = cams[c.camera];
      const dir = cameraPixelToRay(cam, c.camU, c.camV);
      if (raySphereIntersect(cam.pose.position, dir, RIG.sphere.radiusM) === null) n++;
    }
    return n;
  };

  const before = offSphere(spilt);
  const after = offSphere(segmented);
  assert.ok(before > 0, 'the unsegmented capture had no room correspondences to remove');
  assert.ok(
    after < before / 10,
    `segmentation left ${after} room correspondences of ${before} — it is not removing them`,
  );
  assert.ok(
    segmented.stats.rejectedOffSphere > 0,
    'nothing was counted as rejected off-sphere, so the gate never fired',
  );
  // And it kept the ball: most of the sphere survives, or it is a mask rather
  // than a segmentation.
  const keptSphere = segmented.correspondences.length - after;
  const hadSphere = spilt.correspondences.length - before;
  assert.ok(
    keptSphere > hadSphere * 0.7,
    `segmentation kept ${keptSphere} of ${hadSphere} sphere correspondences`,
  );
});

test('segmentation is driven by the NOMINAL rig, and a wrong nominal degrades it gracefully', () => {
  // The property that makes it honest: it is a function of the calibration the
  // operator starts from, so mis-stating that calibration must change what it
  // rejects. If it did not, it would be reading something it is not entitled to.
  const cams = cameras(1);
  const truthful = capture(cams, {
    sensor: null,
    roomSpill: DEFAULT_ROOM_SPILL,
    segmentation: { marginFrac: 0 },
  });
  const wrong = capture(cams, {
    sensor: null,
    roomSpill: DEFAULT_ROOM_SPILL,
    // A nominal that puts every projector a long way from where it is. Nothing
    // about the CAPTURE changes; only what the segmenter is told.
    segmentation: { marginFrac: 0, nominalOffsetM: 0.6 },
  });
  assert.notEqual(
    wrong.stats.rejectedOffSphere,
    truthful.stats.rejectedOffSphere,
    'moving the nominal changed nothing, so the segmentation is not reading it',
  );
  assert.ok(
    wrong.stats.rejectedOffSphere > 0,
    'a wrong nominal should still reject something, not fall over',
  );
});

// ---------------------------------------------------------------------------
// Image-space segmentation
// ---------------------------------------------------------------------------

test('image segmentation is exactly inert when it is off', () => {
  // captureAndDecode was restructured to render a camera's pairs before decoding
  // any of them, because the mask needs all of them at once. That restructure
  // must not touch the path every published number was produced by.
  const cams = cameras(1);
  const a = capture(cams, { sensor: null, roomSpill: DEFAULT_ROOM_SPILL });
  const b = capture(cams, { sensor: null, roomSpill: DEFAULT_ROOM_SPILL, segmentImage: null });
  assert.equal(a.correspondences.length, b.correspondences.length);
  for (let i = 0; i < a.correspondences.length; i++) {
    assert.deepEqual(a.correspondences[i], b.correspondences[i]);
  }
  assert.equal(a.stats.rejectedOffImage, 0);
  assert.equal(a.silhouettes.length, 0, 'the detector ran with nothing asking it to');
});

test('image segmentation keeps the sphere and throws the room away', () => {
  const cams = cameras(1);
  const off = capture(cams, { sensor: null, roomSpill: DEFAULT_ROOM_SPILL });
  const on = capture(cams, { sensor: null, roomSpill: DEFAULT_ROOM_SPILL, segmentImage: {} });

  assert.ok(on.stats.rejectedOffImage > 0, 'the mask rejected nothing');
  assert.ok(on.silhouettes.length > 0, 'no silhouette was reported');
  for (const sil of on.silhouettes) {
    assert.ok(sil.chosen >= 0, `camera ${sil.camera} found no sphere`);
    assert.ok(sil.maskPixels > 0);
    assert.deepEqual(sil.warnings, [], `camera ${sil.camera} was not sure`);
  }

  // The point is not that it rejects things, it is WHAT it rejects: ground truth
  // is available HERE, in the test, and is not available to the thing tested.
  const offSphere = (r: ReturnType<typeof capture>): number => {
    let n = 0;
    for (const c of r.correspondences) {
      const cam = cams[c.camera];
      const dir = cameraPixelToRay(cam, c.camU, c.camV);
      if (raySphereIntersect(cam.pose.position, dir, RIG.sphere.radiusM) === null) n++;
    }
    return n;
  };
  assert.ok(offSphere(off) > 0, 'the room contributed nothing to reject');
  assert.equal(offSphere(on), 0, 'off-sphere correspondences survived the image mask');
});

test('CaptureOptions.surface changes what the camera photographs', () => {
  // The capture's half of the mesh path, asserted on its own because it is the
  // half that cannot be checked from the page.
  //
  // `packages/solver` could calibrate against a mesh for eleven commits before
  // anything photographed one: `runSolve` called `captureAndDecode` with no
  // surface and `solve` with no `surface`, so a model dropped on the page
  // reached the display shader and nothing else. Wiring both is one field each,
  // and a field that is quietly ignored looks exactly like a field that works —
  // which is the failure this asserts against.
  //
  // The mesh is an ellipsoid rather than a tessellated sphere, and that is the
  // whole design of the test. `packages/solver/test/mesh-bundle.test.ts` records
  // what a sphere fixture does here: it solved against a tessellated sphere,
  // asserted recovery, and passed just as happily with the mesh DISCONNECTED —
  // the disconnected arm scoring better, 4.83 mm against 7.41 mm. A shape a
  // sphere can impersonate cannot tell a live wire from a dead one.
  //
  // What is asserted is a DIFFERENCE, not a quality. Whether the ellipsoid's
  // correspondences are good is `mesh-bundle.test.ts`'s question; this one only
  // has to show that `surface` reaches the renderer, and two identical
  // correspondence sets would show it does not.
  const cams = cameras(1);
  const sphere = capture(cams);

  const nLat = 48;
  const nLon = 96;
  const r = RIG.sphere.radiusM;
  const positions: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const theta = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const phi = (2 * Math.PI * j) / nLon;
      // Squashed in z and in y, so no rotation of a sphere reproduces it.
      positions.push(
        r * Math.sin(theta) * Math.cos(phi),
        r * 0.75 * Math.sin(theta) * Math.sin(phi),
        r * 0.6 * Math.cos(theta),
      );
    }
  }
  const at = (i: number, j: number): number => i * nLon + (j % nLon);
  const indices: number[] = [];
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i !== 0) indices.push(a, b, d);
      if (i !== nLat - 1) indices.push(b, c, d);
    }
  }
  const mesh: SurfaceMesh = {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'capture-ellipsoid',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };

  const ellipsoid = capture(cams, { surface: meshSurface(mesh) });

  assert.ok(sphere.correspondences.length > 0, 'the sphere capture decoded nothing');
  assert.ok(ellipsoid.correspondences.length > 0, 'the mesh capture decoded nothing');

  // Same camera, same patterns, same seed. The only difference is the shape the
  // light landed on, so a ray that struck the sphere at one depth strikes the
  // ellipsoid at another and decodes to a different projector pixel. If
  // `surface` were dropped on the floor these two would be identical.
  // Keyed by the PROJECTOR too. A camera pixel lit by four projectors decodes to
  // four correspondences sharing one `camU`/`camV`, so a key without the
  // projector keeps whichever the map saw last and then compares two different
  // projectors' pixels. Measured with that key and the wire deliberately cut —
  // where the two captures are byte-identical and the count must be zero — it
  // reported 3159 of 9850 pixels "moved". The assertion below still failed, but
  // on a threshold that happened to sit above the contamination rather than on
  // the difference it names.
  const key = (c: { camera: number; projector: number; camU: number; camV: number }): string =>
    `${c.camera}:${c.projector}:${c.camU}:${c.camV}`;
  const sphereAt = new Map(sphere.correspondences.map((c) => [key(c), c]));
  let shared = 0;
  let moved = 0;
  for (const c of ellipsoid.correspondences) {
    const s = sphereAt.get(key(c));
    if (!s) continue;
    shared++;
    if (Math.hypot(c.projU - s.projU, c.projV - s.projV) > 1) moved++;
  }
  assert.ok(shared > 50, `only ${shared} camera pixels decoded on both shapes`);
  // With the wire cut this is exactly zero — same rig, same seed, same patterns,
  // one surface. So the bar is only that the shape moved SOMETHING, and it is
  // set well above zero to leave room for a tessellation that grazes the sphere.
  assert.ok(
    moved > shared * 0.5,
    `${moved} of ${shared} shared (camera, projector, pixel) triples moved by more than ` +
      'a projector pixel — the capture is photographing the same shape either way, ' +
      'so `surface` is inert',
  );
});

test('the geometric segmenter follows the body: a mesh one keeps what a sphere one throws away', () => {
  // `packages/bench/src/run.ts` declined to build a geometric segmenter for a
  // mesh scenario, on the reading that "both segmenters fit a CIRCLE to the
  // sphere's silhouette". That is true of the IMAGE-space detector in
  // `silhouette.ts` and was never true of this one: `sphereSegmenter` is a
  // ray-vs-sphere test, and the only sphere in it is the surface it intersects.
  //
  // What that guard cost is measured here rather than argued. One capture of a
  // tri-axial body, decoded three ways: with no segmenter, with the sphere
  // segmenter the bench would have built, and with the mesh segmenter it now
  // builds instead. The sphere one is not merely unhelpful on this body — it is
  // WRONG in the damaging direction, keeping rays that missed the object and
  // flew on into the room, which is the outlier class segmentation exists to
  // remove.
  const cams = cameras(1);
  const nLat = 48;
  const nLon = 96;
  const r = RIG.sphere.radiusM;
  const positions: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const theta = (Math.PI * i) / nLat;
    for (let j = 0; j < nLon; j++) {
      const phi = (2 * Math.PI * j) / nLon;
      positions.push(
        r * Math.sin(theta) * Math.cos(phi),
        r * 0.7 * Math.sin(theta) * Math.sin(phi),
        r * 0.5 * Math.cos(theta),
      );
    }
  }
  const at = (i: number, j: number): number => i * nLon + (j % nLon);
  const indices: number[] = [];
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i !== 0) indices.push(a, b, d);
      if (i !== nLat - 1) indices.push(b, c, d);
    }
  }
  const mesh: SurfaceMesh = {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'segmenter-ellipsoid',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    normals: null,
    uvs: null,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };

  const projectors = bundleStateFromCalibration(RIG, []).projectors;
  const decodeWith = (segmentation: ((p: number, u: number, v: number) => boolean) | null) =>
    captureAndDecode(RIG, cams, {
      plan: PLAN,
      conditions: {
        ambient: 0.04,
        reflectance: { r: 0.9, g: 0.9, b: 0.88 },
        roomAlbedo: 0.3,
        sensor: null,
        handheld: null,
        clock: { ...DEFAULT_CLOCK, rollingShutter: true },
        minIncidenceCos: 0.2,
        // ON, so there is room for a ray to miss the body and land somewhere
        // that still decodes. With no spill a miss decodes to nothing and the
        // segmenters have nothing to disagree about.
        roomSpill: DEFAULT_ROOM_SPILL,
        segmentImage: null,
      },
      seed: 4242,
      decode: { pixelStride: 1, maxCorrespondences: 0, segmentation },
      previewPairs: [],
      previewFrame: -1,
      surface: meshSurface(mesh),
    });

  const open = decodeWith(null);
  const bySphere = decodeWith(
    sphereSegmenter({ radiusM: r, projectors, marginFrac: DEFAULT_SEGMENTATION_MARGIN }),
  );
  const byMesh = decodeWith(meshSegmenter({ index: buildMeshIndex(mesh), projectors }));

  assert.ok(open.correspondences.length > 0, 'the unsegmented capture decoded nothing');
  // Both segmenters cut something: an assertion that a filter filtered.
  assert.ok(bySphere.correspondences.length < open.correspondences.length, 'the sphere segmenter cut nothing');
  assert.ok(byMesh.correspondences.length < open.correspondences.length, 'the mesh segmenter cut nothing');

  // The point. The sphere segmenter tests against a ball this body is inscribed
  // in, so it ADMITS rays that sailed past the real object — it keeps strictly
  // more than the mesh one, and everything extra it keeps is a point the
  // projector aimed at nothing.
  assert.ok(
    bySphere.correspondences.length > byMesh.correspondences.length,
    `the sphere segmenter kept ${bySphere.correspondences.length} and the mesh one ${byMesh.correspondences.length}; ` +
      'the enclosing body admitted nothing extra, so this fixture proves nothing',
  );

  // And the mesh segmenter is a SUBSET of the open decode rather than a
  // different set: it removes points, it never invents or moves one.
  const key = (c: { camera: number; camU: number; camV: number; projector: number }) =>
    `${c.camera}:${c.projector}:${c.camU}:${c.camV}`;
  const openKeys = new Set(open.correspondences.map(key));
  for (const c of byMesh.correspondences) {
    assert.ok(openKeys.has(key(c)), `the mesh segmenter produced a correspondence the open decode did not: ${key(c)}`);
  }
});

// ---------------------------------------------------------------------------
// EXPERIMENT-10's hooks: the shutter straddle, onCapture, and the two moves it
// reuses. The straddle is proven inert when it keeps every photograph whole,
// and proven to be the blend it claims when it does not.
// ---------------------------------------------------------------------------

/**
 * A capture's frames in `planFrames` order, which is the order they were
 * rendered and noised in. Undoing `renderPair`'s reassembly here is a second
 * statement of the frame order, so it checks itself against `planFrames`.
 */
function inPlanOrder(c: PatternCapture, plan: PatternPlan = PLAN): LinearImage[] {
  const out: LinearImage[] = [];
  if (c.white !== null) out.push(c.white);
  if (c.black !== null) out.push(c.black);
  for (const g of c.gray) {
    for (let j = 0; j < g.bits; j++) {
      out.push(g.patterns[j]);
      out.push(g.inverses[j]);
    }
  }
  for (const ph of c.phase) for (const frame of ph.frames) out.push(frame);
  assert.equal(out.length, planFrames(plan).length, 'a capture is not the plan it was shot from');
  return out;
}

interface Shot {
  result: CaptureResult;
  /** What `onCapture` was handed, in the order it was handed it. */
  pairs: { camera: number; projector: number; capture: PatternCapture }[];
}

function shoot(cams: SimulatedCamera[], args: Partial<CaptureArgs> = {}): Shot {
  const pairs: Shot['pairs'] = [];
  const result = capture(cams, {
    ...args,
    onCapture: (camera, projector, c) => {
      pairs.push({ camera, projector, capture: c });
    },
  });
  return { result, pairs };
}

/** Every pair's frames as `[pair][frame]` pixel buffers, pairs in `onCapture` order. */
function framesOf(shot: Shot): (Float32Array | Float64Array)[][] {
  return shot.pairs.map((q) => inPlanOrder(q.capture).map((image) => image.data));
}

/**
 * Bit-for-bit equality of two pixel buffers, reporting the first pixel that
 * differs. `assert.deepEqual` checks the same thing, and when it fails it
 * prints every pixel of both: for a whole capture that is millions of lines
 * and minutes of formatting before the test even reports.
 */
function assertSamePixels(
  a: Float32Array | Float64Array,
  b: Float32Array | Float64Array,
  label: string,
): void {
  assert.equal(a.constructor, b.constructor, `${label}: different buffer types`);
  assert.equal(a.length, b.length, `${label}: different sizes`);
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) assert.fail(`${label}: pixel ${i} is ${a[i]} against ${b[i]}`);
  }
}

/** Two captures of one plan: the same shape, and every frame the same bits. */
function assertSameCapture(
  a: PatternCapture,
  b: PatternCapture,
  label: string,
  plan: PatternPlan = PLAN,
): void {
  const shape = (c: PatternCapture) => ({
    camera: c.camera,
    projector: c.projector,
    projectorRes: c.projectorRes,
    gray: c.gray.map((g) => ({ axis: g.axis, bits: g.bits, stridePx: g.stridePx })),
    phase: c.phase.map((ph) => ({ axis: ph.axis, steps: ph.steps, periodPx: ph.periodPx })),
  });
  assert.deepEqual(shape(a), shape(b), `${label}: captures of different shapes`);
  const fa = inPlanOrder(a, plan);
  const fb = inPlanOrder(b, plan);
  for (let f = 0; f < fa.length; f++) {
    assert.deepEqual(
      [fa[f].width, fa[f].height, fa[f].channels],
      [fb[f].width, fb[f].height, fb[f].channels],
      `${label}: frame ${f} has a different size`,
    );
    assertSamePixels(fa[f].data, fb[f].data, `${label}, frame ${f}`);
  }
}

/** Two decodes, compared one correspondence at a time so a failure prints one. */
function assertSameCorrespondences(a: Correspondence[], b: Correspondence[], label: string): void {
  assert.equal(a.length, b.length, `${label}: ${a.length} correspondences against ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (!isDeepStrictEqual(a[i], b[i])) assert.deepEqual(a[i], b[i], `${label}: correspondence ${i}`);
  }
}

test('a straddle that keeps every photograph whole is byte-identical to no straddle', () => {
  // The claim every published number rests on now that the hook exists. The
  // straddled path is a separate loop from the one the bench runs, so "off" is
  // worth exactly as much as that loop's copy of the arithmetic and its walk of
  // the noise stream — and a copy that is merely CLOSE still moves the odd
  // noisy pixel across a quantisation step, which can move a decode. So four
  // ways of saying "whole", compared bit for bit: absent, null, every row null,
  // and every row one part of weight 1 on the filed frame. The last two run the
  // straddled loop; a real sensor is on, so a row that skips the sensor shows;
  // and it runs again with room spill on, so the wall's term in the copied
  // arithmetic is exercised.
  //
  // Two more conditions, for what those two leave to chance or never reach. A
  // quantising sensor shows a double rounded to Float32 before the sensor only
  // where the noisy value lands within that rounding of a step's edge: measured
  // with every ideal rounded, 15 of the 4.6 million pixels of one two-camera
  // capture, none of them on a white or black frame, so a rounding confined to
  // those two frames passed both runs above unseen. Without the quantiser the
  // Float32 each output is stored in keeps the difference on about one pixel in
  // five. And a moving camera re-traces its geometry every frame, a branch of
  // the copied loop a still camera never takes. One camera is enough for either.
  const whole: { name: string; straddle: ShutterStraddle | null }[] = [
    { name: 'null', straddle: null },
    { name: 'every row null', straddle: { parts: () => null } },
    {
      name: 'the filed frame at weight 1',
      straddle: { parts: (_c, p, f) => [{ weight: 1, shown: { projector: p, frame: f } }] },
    },
  ];
  const unquantised: SensorModel = { ...DEFAULT_SENSOR, quantizationBits: null };
  const runs: { name: string; cams: SimulatedCamera[]; args: Partial<CaptureArgs> }[] = [
    { name: 'room spill off', cams: cameras(2), args: { sensor: DEFAULT_SENSOR, roomSpill: null } },
    { name: 'room spill on', cams: cameras(2), args: { sensor: DEFAULT_SENSOR, roomSpill: DEFAULT_ROOM_SPILL } },
    {
      name: 'unquantised, room spill on',
      cams: cameras(1),
      args: { sensor: unquantised, roomSpill: DEFAULT_ROOM_SPILL },
    },
    { name: 'handheld', cams: cameras(1), args: { sensor: DEFAULT_SENSOR, handheld: DEFAULT_HANDHELD } },
  ];
  for (const run of runs) {
    const cams = run.cams;
    const absent = shoot(cams, run.args);
    assert.ok(absent.result.correspondences.length > 1000, `${run.name}: the capture decoded almost nothing`);
    assert.equal(absent.pairs.length, cams.length * RIG.projectors.length);
    for (const { name, straddle } of whole) {
      const kept = shoot(cams, { ...run.args, straddle });
      const label = `${name}, ${run.name}`;
      assert.equal(kept.pairs.length, absent.pairs.length);
      for (let k = 0; k < absent.pairs.length; k++) {
        assertSameCapture(kept.pairs[k].capture, absent.pairs[k].capture, `${label}, pair ${k}`);
      }
      assertSameCorrespondences(kept.result.correspondences, absent.result.correspondences, label);
      assert.deepEqual(kept.result.stats, absent.result.stats, `${label}: the stats differ`);
    }
  }
});

test('the blend is exposure-weighted, pre-sensor, and the neighbour is what the page lit', () => {
  // No sensor, so every number here is the renderer's arithmetic and nothing
  // else, compared against the clean capture's own frames. Three defects this
  // exists to catch, each of which renders a perfectly plausible frame: the
  // weights applied to the wrong states; a part on ANOTHER projector traced
  // through this projector's geometry, which lights this projector's footprint
  // with the neighbour's frame; and the neighbour's radiance added without
  // taking the shared ambient back out, which counts the room's light twice —
  // or taking out the sphere's ambient off the sphere, where what is shared is
  // the room's background.
  const cams = cameras(1);
  const clean = framesOf(shoot(cams, { sensor: null }));
  const n = clean[0][0].length;
  const last = planFrames(PLAN).length - 1;
  // With no sensor a pixel this projector does not reach is the same number in
  // its white and its black frame, and a pixel it does reach is not.
  const lit = (p: number, i: number): boolean => clean[p][0][i] !== clean[p][1][i];

  // The neighbour test needs pixels only this projector lights and pixels only
  // the next one does, so take the adjacent pair with the most of the rarer.
  let p = -1;
  let fewest = 0;
  for (let q = 0; q + 1 < clean.length; q++) {
    let onlyThis = 0;
    let onlyNext = 0;
    for (let i = 0; i < n; i++) {
      if (lit(q, i) && !lit(q + 1, i)) onlyThis++;
      else if (!lit(q, i) && lit(q + 1, i)) onlyNext++;
    }
    if (Math.min(onlyThis, onlyNext) > fewest) {
      fewest = Math.min(onlyThis, onlyNext);
      p = q;
    }
  }
  assert.ok(fewest >= 100, `no adjacent projectors light pixels the other does not (${fewest})`);

  const gray = 2;
  assert.equal(planFrames(PLAN)[gray].kind, 'gray');
  assert.equal(planFrames(PLAN)[gray + 1].kind, 'grayInverse');
  const straddle: ShutterStraddle = {
    parts(_c, q, f) {
      if (q !== p) return null;
      // A Gray plane smeared into its own complement.
      if (f === gray) {
        return [
          { weight: 0.7, shown: { projector: q, frame: gray } },
          { weight: 0.3, shown: { projector: q, frame: gray + 1 } },
        ];
      }
      // This projector's last frame smeared into the next projector's white,
      // which is what the page shows next.
      if (f === last) {
        return [
          { weight: 0.7, shown: { projector: q, frame: last } },
          { weight: 0.3, shown: { projector: q + 1, frame: 0 } },
        ];
      }
      if (f === 0) return [{ weight: 1, shown: 'dark' }];
      return null;
    },
  };
  const blended = framesOf(shoot(cams, { sensor: null, straddle }));

  // Float32 storage of numbers below about 1.5 is good to a few 1e-8.
  const tolerance = 1e-6;
  let worst = 0;
  let differing = 0;
  for (let i = 0; i < n; i++) {
    const want = 0.7 * clean[p][gray][i] + 0.3 * clean[p][gray + 1][i];
    worst = Math.max(worst, Math.abs(blended[p][gray][i] - want));
    if (clean[p][gray][i] !== clean[p][gray + 1][i]) differing++;
  }
  assert.ok(differing > 100, 'the plane and its complement agree everywhere, so no weight was tested');
  assert.ok(worst <= tolerance, `0.7 of a Gray plane and 0.3 of its complement is off by ${worst}`);

  let onlyNext = 0;
  let onlyThis = 0;
  let worstNext = 0;
  let worstThis = 0;
  // The radiances of the pixels neither projector reaches; see below.
  const unlit = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (lit(p + 1, i) && !lit(p, i)) {
      // Here this projector's frames are all the ambient term, and the next
      // projector's white is ambient plus its own light.
      onlyNext++;
      const want = 0.7 * clean[p][last][i] + 0.3 * clean[p + 1][0][i];
      worstNext = Math.max(worstNext, Math.abs(blended[p][last][i] - want));
    } else if (!lit(p + 1, i)) {
      // Here the next projector adds nothing, and the page left this one black:
      // where this one reaches, and where neither does, on the sphere or off it.
      // Off it, the light the neighbour's part takes back out is the room's and
      // not the sphere's ambient, and taking out the wrong one moves the blend
      // by 0.3 of the difference where nothing was lit at all.
      if (lit(p, i)) onlyThis++;
      else unlit.add(clean[p][1][i]);
      const want = 0.7 * clean[p][last][i] + 0.3 * clean[p][1][i];
      worstThis = Math.max(worstThis, Math.abs(blended[p][last][i] - want));
    }
  }
  assert.equal(Math.min(onlyNext, onlyThis), fewest);
  // With no sensor, an unlit pixel is the sphere's ambient or the room's
  // background, so both kinds of pixel were checked.
  assert.equal(unlit.size, 2, `the pixels neither projector reaches are at ${unlit.size} radiances, not 2`);
  assert.ok(worstNext <= tolerance, `where only projector ${p + 1} reaches, the blend is off by ${worstNext}`);
  assert.ok(worstThis <= tolerance, `where projector ${p + 1} does not reach, the blend is off by ${worstThis}`);

  // The page's black after its last step is this projector's black frame.
  assertSamePixels(blended[p][0], clean[p][1], "'dark' against this projector's black");

  // And nothing the straddle did not name moved at all.
  for (let q = 0; q < clean.length; q++) {
    for (let f = 0; f < clean[q].length; f++) {
      if (q === p && (f === 0 || f === gray || f === last)) continue;
      assertSamePixels(blended[q][f], clean[q][f], `projector ${q} frame ${f}, which nothing named`);
    }
  }
});

test('noise is drawn once, on the sum', () => {
  // A straddled pixel's photons arrive in one exposure, and shot noise is
  // Poisson on their SUM. Noising each part and mixing the results is the
  // tempting implementation — both parts already exist as images — and at an
  // even split it halves the variance, so a straddled photograph would come out
  // quieter than a clean one. With no read noise, no quantisation and no clip,
  // a pixel's variance is exactly its signal over the gain.
  const sensor: SensorModel = {
    electronsPerUnitRadiance: 50,
    readNoiseElectrons: 0,
    quantizationBits: null,
    saturationRadiance: 1e9,
  };
  const cams = cameras(1);
  const clean = framesOf(shoot(cams, { sensor: null }));
  // White at 0.5, black at 0.5.
  const straddle: ShutterStraddle = {
    parts: (_c, p, f) =>
      f === 0
        ? [
            { weight: 0.5, shown: { projector: p, frame: 0 } },
            { weight: 0.5, shown: { projector: p, frame: 1 } },
          ]
        : null,
  };
  const noisy = framesOf(shoot(cams, { sensor, straddle }));
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let signal = 0;
  for (let p = 0; p < clean.length; p++) {
    const white = clean[p][0];
    const black = clean[p][1];
    const photo = noisy[p][0];
    for (let i = 0; i < white.length; i++) {
      if (white[i] === black[i]) continue;
      const expected = 0.5 * white[i] + 0.5 * black[i];
      const r = photo[i] - expected;
      count++;
      sum += r;
      sumSq += r * r;
      signal += expected;
    }
  }
  assert.ok(count >= 2000, `only ${count} lit pixels`);
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  const predicted = signal / count / sensor.electronsPerUnitRadiance;
  assert.ok(
    Math.abs(variance / predicted - 1) <= 0.1,
    `the straddled frame's variance is ${variance}, and one Poisson draw on the sum gives ${predicted}`,
  );
});

test('malformed straddle parts throw, naming the photograph they came from', () => {
  // A malformed part rendered anyway is a plausible frame with the wrong light
  // in it: weights short of one dim it, a negative weight subtracts light, and a
  // state the rig or the plan does not have reads past the end of an array.
  // Each is refused, and the refusal names the camera, projector, frame and row
  // it came from, which is what a caller needs to find the fault in its own
  // timing model. The message is matched, not just the throw, because a state
  // past the end of an array throws a TypeError anyway.
  const cams = cameras(2);
  const frames = planFrames(PLAN).length;
  const cases: [string, ExposurePart[], RegExp][] = [
    [
      'weights summing to 0.9',
      [
        { weight: 0.5, shown: { projector: 2, frame: 3 } },
        { weight: 0.4, shown: { projector: 2, frame: 4 } },
      ],
      /weights summing to 0\.9;/,
    ],
    [
      'a negative weight',
      [
        { weight: 1.25, shown: { projector: 2, frame: 3 } },
        { weight: -0.25, shown: { projector: 2, frame: 4 } },
      ],
      /weight of -0\.25;/,
    ],
    [
      'a frame the plan does not have',
      [{ weight: 1, shown: { projector: 2, frame: frames } }],
      new RegExp(`named frame ${frames},`),
    ],
    [
      'a projector the rig does not have',
      [{ weight: 1, shown: { projector: RIG.projectors.length, frame: 3 } }],
      new RegExp(`named projector ${RIG.projectors.length},`),
    ],
  ];
  for (const [name, parts, what] of cases) {
    const straddle: ShutterStraddle = {
      parts: (c, p, f, row) => (c === 1 && p === 2 && f === 3 && row === 7 ? parts : null),
    };
    assert.throws(
      () => capture(cams, { straddle }),
      (e: unknown) =>
        e instanceof Error &&
        /camera 1, projector 2, frame 3, row 7/.test(e.message) &&
        what.test(e.message),
      name,
    );
  }
});

test('onCapture is observational and sees exactly the frames that were decoded', () => {
  // The callback exists so an experiment can audit what a capture actually
  // photographed. That is worth something only if watching changes nothing,
  // and if what it is handed is what was decoded: a copy taken at any other
  // moment — before the noise, say — would audit a capture that never happened.
  const cams = cameras(2);
  const unwatched = capture(cams, { sensor: DEFAULT_SENSOR });
  const watched = shoot(cams, { sensor: DEFAULT_SENSOR });
  assertSameCorrespondences(watched.result.correspondences, unwatched.correspondences, 'watching');
  assert.deepEqual(watched.result.stats, unwatched.stats);

  assert.deepEqual(
    watched.pairs.map((q) => [q.camera, q.projector, q.capture.camera, q.capture.projector]),
    [0, 1].flatMap((c) => [0, 1, 2, 3].map((p) => [c, p, c, p])),
  );
  const again: Correspondence[] = [];
  const stats = { ...watched.result.stats };
  for (const k of Object.keys(stats) as (keyof DecodeStats)[]) stats[k] = 0;
  for (const q of watched.pairs) {
    // The fixture's own decode options.
    const decoded = decodeCapture(q.capture, { pixelStride: 1, maxCorrespondences: 0, segmentation: null });
    for (const c of decoded.correspondences) again.push(c);
    for (const k of Object.keys(stats) as (keyof DecodeStats)[]) stats[k] += decoded.stats[k];
  }
  assert.ok(again.length > 1000, 'the capture decoded almost nothing');
  assertSameCorrespondences(again, watched.result.correspondences, 'the frames handed over, decoded again');
  assert.deepEqual(stats, watched.result.stats);
});

test("the bench's own sensor and stream, applied to a noiseless frame, reproduce the renderer", () => {
  // EXPERIMENT-10's fast path renders a pair once without noise, blends the
  // frames itself, and noises the blend by walking `makeSensor` over
  // `pairNoiseSeed`'s stream. It is a model of the renderer, worth exactly its
  // agreement with the renderer: if the renderer's stream moved, the fast path
  // would go on producing noise that looks right and belongs to nobody.
  //
  // Not bit-exact, and the reason is known. The noiseless frames are stored as
  // Float32, so the walk noises a rounded value where the renderer noised the
  // double, and now and then the two land either side of a quantisation step.
  // Counted in steps rather than in radiance, because both sides are stored as
  // Float32 too, and one step apart can be a step and an ulp apart in radiance.
  const cams = cameras(2);
  const clean = shoot(cams, { sensor: null });
  const noisy = shoot(cams, { sensor: DEFAULT_SENSOR });
  const bits = DEFAULT_SENSOR.quantizationBits;
  assert.ok(bits !== null);
  const step = DEFAULT_SENSOR.saturationRadiance / (2 ** bits - 1);
  const level = (v: number): number => Math.round(v / step);
  let total = 0;
  let same = 0;
  let worst = 0;
  for (let k = 0; k < clean.pairs.length; k++) {
    const { camera, projector } = clean.pairs[k];
    const sensor = makeSensor(DEFAULT_SENSOR, makeBenchRng(pairNoiseSeed(FIXTURE_SEED, camera, projector)));
    const a = inPlanOrder(clean.pairs[k].capture);
    const b = inPlanOrder(noisy.pairs[k].capture);
    for (let f = 0; f < a.length; f++) {
      for (let i = 0; i < a[f].data.length; i++) {
        const walked = Math.fround(sensor(a[f].data[i]));
        const rendered = b[f].data[i];
        total++;
        if (walked === rendered) same++;
        else worst = Math.max(worst, Math.abs(level(walked) - level(rendered)));
      }
    }
  }
  assert.ok(same >= 0.999 * total, `${total - same} of ${total} pixels differ from the renderer's`);
  assert.ok(worst <= 1, `a pixel differs from the renderer's by ${worst} quantisation steps`);
});

test('azimuthOffsetDeg absent is 0, and present it only rotates the set', () => {
  // The bench never sets it, so absent has to be exactly the placement every
  // published number was produced with. And present it has to turn the set and
  // do nothing else: an offset that took a draw, or moved where the cameras
  // look but not where they stand, would change which rig EXPERIMENT-10
  // photographs rather than which way it faces. s01's own placement options,
  // jitter and all, so the draws are real ones.
  const opts = makeScenario(1234, 1, PRESETS.default).cameras;
  assert.equal(opts.azimuthOffsetDeg, undefined, 'a scenario set the offset');
  const place = (o: CameraPlacementOptions): SimulatedCamera[] =>
    placeCameras(o, RIG.sphere.centerHeightM, makeBenchRng(17));
  const without = place(opts);
  assert.deepEqual(place({ ...opts, azimuthOffsetDeg: 0 }), without);

  const turned = place({ ...opts, azimuthOffsetDeg: 30 });
  const deg = (rad: number): number => (rad * 180) / Math.PI;
  const wrap = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;
  const azimuth = (c: SimulatedCamera): number => deg(Math.atan2(c.pose.position.y, c.pose.position.x));
  const range = (c: SimulatedCamera): number =>
    Math.hypot(c.pose.position.x, c.pose.position.y, c.pose.position.z);
  assert.equal(turned.length, without.length);
  for (let i = 0; i < without.length; i++) {
    const a = without[i];
    const b = turned[i];
    assert.ok(Math.abs(wrap(azimuth(b) - azimuth(a)) - 30) <= 1e-9, `camera ${i} did not turn by 30 degrees`);
    assert.equal(b.heightM, a.heightM);
    assert.equal(b.pose.position.z, a.pose.position.z);
    assert.ok(Math.abs(range(b) - range(a)) <= 1e-12, `camera ${i} changed its distance`);
    // Still aimed at the centre with the same jitter: the yaw turns with the
    // set, and the pitch and roll do not move.
    assert.ok(Math.abs(wrap(b.pose.yawDeg - a.pose.yawDeg) - 30) <= 1e-9, `camera ${i} did not turn its yaw`);
    assert.ok(Math.abs(b.pose.pitchDeg - a.pose.pitchDeg) <= 1e-9);
    assert.equal(b.pose.rollDeg, a.pose.rollDeg);
  }
});

test('captureOptionsFor is the literal runScenario used', () => {
  // EXPERIMENT-10 photographs scenarios through `captureOptionsFor` so that its
  // captures ARE the bench's. It is a move of the literal `runScenario` built
  // inline, and this pins the move: the expected values are written out rather
  // than read back through the function, so a changed literal fails here
  // instead of agreeing with itself. Then `runScenario` itself is caught at its
  // first photograph, before anything solves, to show it photographs with
  // exactly these options, the experiment's two overrides and a scenario's
  // straddle included.
  const scenario = makeScenario(1234, 1, PRESETS.default);
  assert.equal(scenario.id, 's01-nominal');
  const world = buildWorld(scenario);
  const options: RunOptions = {
    preset: PRESETS.default,
    outDir: '',
    repoRoot: '',
    writeArtifacts: false,
    baseline: false,
  };
  const plan = planPatternFor(world, scenario, PRESETS.default).plan;
  const got = captureOptionsFor(world, scenario, options, plan);
  assert.equal(got.plan, plan);
  assert.deepEqual(got.conditions, {
    ambient: 0.04,
    reflectance: world.scene.reflectance,
    roomAlbedo: world.scene.roomAlbedo,
    sensor: DEFAULT_SENSOR,
    handheld: null,
    clock: DEFAULT_CLOCK,
    minIncidenceCos: 0.2,
    roomSpill: null,
    segmentImage: null,
    straddle: null,
  });
  assert.equal(got.surface, null);
  assert.equal(got.seed, scenario.seed);
  assert.deepEqual(got.decode, {
    pixelStride: 1,
    maxCorrespondences: PRESETS.default.maxCorrespondencesPerPair,
    segmentation: null,
  });
  assert.deepEqual(got.previewPairs, [{ camera: 0, projector: 0 }]);
  assert.equal(got.previewFrame, -1);
  assert.equal(got.onCapture, null);

  // Each override moves its own field and nothing else.
  const reseeded = captureOptionsFor(world, scenario, { ...options, captureSeed: 99 }, plan);
  assert.equal(reseeded.seed, 99);
  assert.deepEqual({ ...reseeded, seed: scenario.seed }, got);
  const pagePlan = { ...DEFAULT_PATTERN_PLAN };
  assert.notDeepEqual(pagePlan, plan, 's01 already derives the page plan, so the override is untested');
  const replanned = captureOptionsFor(world, scenario, options, pagePlan);
  assert.equal(replanned.plan, pagePlan);
  assert.deepEqual({ ...replanned, plan }, got);
  // And the straddle a scenario carries reaches the conditions as it was given.
  // It is the treatment the experiment applies, and a slip here would
  // disconnect it silently: every treated capture photographed clean, and every
  // straddle reported harmless. This one photographs the first pair's white as
  // black.
  const darkWhite: ShutterStraddle = {
    parts: (c, p, f) => (c === 0 && p === 0 && f === 0 ? [{ weight: 1, shown: 'dark' }] : null),
  };
  const straddled = { ...scenario, degradation: { ...scenario.degradation, straddle: darkWhite } };
  const restraddled = captureOptionsFor(world, straddled, options, plan);
  assert.equal(restraddled.conditions.straddle, darkWhite);
  assert.deepEqual({ ...restraddled, conditions: { ...restraddled.conditions, straddle: null } }, got);

  class Enough extends Error {}
  const firstPhotograph = (start: (watch: NonNullable<CaptureOptions['onCapture']>) => unknown): PatternCapture => {
    const seen: { capture: PatternCapture | null } = { capture: null };
    assert.throws(
      () =>
        start((_camera, _projector, c) => {
          seen.capture = c;
          throw new Enough();
        }),
      Enough,
    );
    assert.ok(seen.capture !== null, 'nothing was photographed');
    return seen.capture;
  };
  const overridden: RunOptions = { ...options, plan: pagePlan, captureSeed: 99 };
  const fromRun = firstPhotograph((watch) => runScenario(straddled, { ...overridden, onCapture: watch }));
  const fromHere = firstPhotograph((watch) =>
    captureAndDecode(world.truthRig, world.cameras, {
      ...captureOptionsFor(world, straddled, overridden, pagePlan),
      onCapture: watch,
    }),
  );
  assert.equal(fromRun.gray[0].bits, pagePlan.grayBits, 'runScenario did not photograph the plan it was given');
  assertSameCapture(fromRun, fromHere, "runScenario's first photograph", pagePlan);

  // The straddle took, on the one frame it named and nowhere else: the white
  // differs from the unstraddled photograph's wherever projector 0 reaches, and
  // every other frame is the unstraddled one's bit for bit, because the noise is
  // drawn in the same order either way.
  const unstraddled = firstPhotograph((watch) =>
    captureAndDecode(world.truthRig, world.cameras, {
      ...captureOptionsFor(world, scenario, overridden, pagePlan),
      onCapture: watch,
    }),
  );
  const treated = inPlanOrder(fromRun, pagePlan);
  const twin = inPlanOrder(unstraddled, pagePlan);
  let changed = 0;
  for (let i = 0; i < treated[0].data.length; i++) if (treated[0].data[i] !== twin[0].data[i]) changed++;
  assert.ok(changed > 1000, `runScenario's straddled white differs from the clean one on ${changed} pixels`);
  for (let f = 1; f < treated.length; f++) {
    assertSamePixels(treated[f].data, twin[f].data, `frame ${f}, which the straddle did not name`);
  }
});
