/**
 * A real calibration, in a browser tab.
 *
 * ## What actually happens when the button is pressed
 *
 * The same four steps `packages/bench/src/run.ts` performs, in the same order,
 * with the same code:
 *
 *   1. `packages/sim` builds the rig the panel describes and shakes it by the
 *      §2 mount tolerances. That rig is GROUND TRUTH and never leaves this file.
 *   2. `packages/sim` renders what cameras in the room photograph while each
 *      structured-light pattern is displayed — Gray planes, then phase shifts,
 *      through a sensor with read noise and quantization, optionally handheld,
 *      through a rolling shutter.
 *   3. `packages/solver` decodes those images and solves. It sees the pixels,
 *      the documented nominals, the operator's camera calibration and a tape
 *      measure. Nothing else.
 *   4. The result is compared against ground truth and reported.
 *
 * Nothing derived from the perturbed rig reaches step 3 except through pixels.
 * The two places that could leak and do not are worth naming: the nominal handed
 * to the solver is built by the SOLVER's own `nominalRig` from documented
 * constants, not by the simulator's — the two disagree slightly and that
 * disagreement is load-bearing evidence that they are independent — and the
 * floor references carry true lens heights, which is not a leak but a
 * measurement: PARAMETERS.md §8 item 1 asks an operator for exactly those, with
 * a tape measure, and they arrive here with the tape measure's noise on them.
 *
 * ## Why this worker may import both sides
 *
 * `tools/boundary-lint.ts` forbids `sim` and `solver` from importing each other
 * or anything but `packages/calibration`. A third package composing both is what
 * `packages/bench` already is and is the only way a solve can be scored at all.
 * The rule that matters here is the one the lint cannot check: nothing in
 * `packages/web` may become a PATH between them. No helper in this file is
 * shared by both sides; each call below hands one model's output to the other as
 * data, through the boundary types.
 *
 * ## Why it is slow, and why that is fine
 *
 * Several seconds. Almost all of it is step 2 — tracing camera pixels through
 * the geometry, once per pattern frame per camera per projector. A four-camera
 * capture at 320×240 with six Gray planes is around 200 frames. Progress is
 * reported per stage, and the metrics worker keeps answering throughout, so the
 * page stays alive while this runs.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import { PARAMETER_TABLE } from '../../calibration/src/parameters.ts';
import { placeCameras } from '../../bench/src/camera.ts';
import { DEFAULT_CLOCK, DEFAULT_HANDHELD } from '../../bench/src/camera.ts';
import { captureAndDecode, DEFAULT_SENSOR } from '../../bench/src/capture.ts';
import {
  DEFAULT_PATTERN_PLAN,
  grayBitsForCamera,
  planFrames,
  previewFrameIndex,
} from '../../bench/src/patterns.ts';
import { makeBenchRng } from '../../bench/src/random.ts';
import { scoreRecovery } from '../../bench/src/score.ts';
import { nominalRig as solverNominalRig, solve } from '../../solver/src/index.ts';
// Reached past the barrel deliberately: `DEFAULT_FREE_FLAGS` is the solver's own
// statement of which parameters PARAMETERS.md §3.1 says to free, and the page
// must not silently re-default the seven it is not touching.
import { DEFAULT_FREE_FLAGS } from '../../solver/src/bundle.ts';
import { buildWorld } from './rigs.ts';
import { RESOLUTIONS } from './settings.ts';
import type {
  FrameImage,
  RecoveredAxis,
  SolveProgress,
  SolveRequest,
  SolveResponse,
} from './protocol.ts';

/** Where a progress line goes. Injected so `runSolve` can be tested off-thread. */
export type ProgressSink = (progress: SolveProgress) => void;

/**
 * Gray planes this geometry can actually carry.
 *
 * A pattern feature finer than the camera can resolve is worse than no pattern:
 * it decodes, badly, and the error looks like decoder noise rather than like an
 * under-sampled pattern. The ratio is measured at the sub-camera and
 * sub-projector points, where both pixel footprints are smallest, and the worst
 * pair over the rig governs. `packages/bench/src/run.ts` computes it the same
 * way, and the two must agree or the page would be photographing a different
 * pattern from the bench at the same settings.
 */
function planPatternFor(
  truthRig: RigCalibration,
  cameras: ReturnType<typeof placeCameras>,
): { grayBits: number; projPxPerCamPx: number } {
  const radius = truthRig.sphere.radiusM;
  let worst = 0;
  for (const cam of cameras) {
    const camDist = Math.hypot(cam.pose.position.x, cam.pose.position.y, cam.pose.position.z);
    const camPitch =
      (2 * Math.atan(cam.intrinsics.resX / 2 / cam.intrinsics.fx)) / cam.intrinsics.resX;
    const camMm = camPitch * Math.max(0.01, camDist - radius);
    for (const p of truthRig.projectors) {
      const projDist = Math.hypot(p.pose.position.x, p.pose.position.y, p.pose.position.z);
      const projPitch = ((p.intrinsics.fovHDeg * Math.PI) / 180) / p.intrinsics.resX;
      const projMm = projPitch * Math.max(0.01, projDist - radius);
      worst = Math.max(worst, camMm / projMm);
    }
  }
  return {
    grayBits: grayBitsForCamera(truthRig.projectors[0].intrinsics.resX, worst, 4),
    projPxPerCamPx: worst,
  };
}

/**
 * What the solve moved, and whether it moved to the right place.
 *
 * Three numbers per axis, and all three are needed. `documented` is what the
 * compositor believed before — the config as written. `recovered` is what came
 * back. `truth` is what the lenses actually have, and the solver never saw it.
 *
 * Recovered-versus-documented is what MOVED; recovered-versus-truth is whether
 * the move was right. Showing only the first would let a solve that confidently
 * moved every projector to the wrong place read as a success, which is the exact
 * failure a calibration display must not be able to have.
 *
 * The axes are the ones an installer can act on. Field of view is included
 * because amendment A-18 measured it as the term worth 88-97% of the position
 * error, so a reader watching a solve should see what it did with it.
 */
function recoveryTable(
  documented: RigCalibration,
  recovered: RigCalibration,
  truth: RigCalibration,
): RecoveredAxis[] {
  const rows: RecoveredAxis[] = [];
  const n = Math.min(
    documented.projectors.length,
    recovered.projectors.length,
    truth.projectors.length,
  );
  type Proj = RigCalibration['projectors'][number];
  const dist = (p: Proj): number =>
    Math.hypot(p.pose.position.x, p.pose.position.y, p.pose.position.z);
  const azDeg = (p: Proj): number =>
    (Math.atan2(p.pose.position.y, p.pose.position.x) * 180) / Math.PI;
  const axes: { axis: string; unit: string; of: (p: Proj) => number }[] = [
    { axis: 'distance to sphere', unit: 'mm', of: (p) => dist(p) * 1000 },
    { axis: 'height', unit: 'mm', of: (p) => p.pose.position.z * 1000 },
    { axis: 'azimuth', unit: '\u00b0', of: azDeg },
    { axis: 'aim yaw', unit: '\u00b0', of: (p) => p.pose.yawDeg },
    { axis: 'aim pitch', unit: '\u00b0', of: (p) => p.pose.pitchDeg },
    { axis: 'roll', unit: '\u00b0', of: (p) => p.pose.rollDeg },
    { axis: 'field of view', unit: '\u00b0', of: (p) => p.intrinsics.fovHDeg },
  ];

  for (let i = 0; i < n; i++) {
    for (const a of axes) {
      const documentedV = a.of(documented.projectors[i]);
      const recoveredV = a.of(recovered.projectors[i]);
      const truthV = a.of(truth.projectors[i]);
      rows.push({
        projectorId: truth.projectors[i].id,
        axis: a.axis,
        unit: a.unit,
        documented: documentedV,
        recovered: recoveredV,
        truth: truthV,
        errorFromTruth: recoveredV - truthV,
        moved: recoveredV - documentedV,
      });
    }
  }
  // Largest movement first: the page shows the top handful, and what a reader
  // wants to see is what the solve actually did rather than the axes it left
  // alone.
  return rows.sort((a, b) => Math.abs(b.moved) - Math.abs(a.moved));
}

/**
 * The whole pipeline, as a plain function of its request.
 *
 * Exported and free of `self` so `test/solve.test.ts` can run a real capture and
 * a real solve in Node and assert on the result. A calibration pipeline that
 * only exists inside a worker is a calibration pipeline nothing can check, and
 * this one is the reason the page can claim anything at all.
 */
export function runSolve(req: SolveRequest, onProgress: ProgressSink = () => {}): SolveResponse {
  const report = (
    phase: SolveProgress['phase'],
    fraction: number,
    message: string,
    extra: Partial<SolveProgress> = {},
  ): void => {
    onProgress({ kind: 'solve-progress', id: req.id, phase, fraction, message, ...extra });
  };
  const world = buildWorld(req.settings);
  const rng = makeBenchRng(req.seed);

  // §6 bounds the viewing distance at 2.0–3.5 m, the low end by the guard rail.
  // An operator photographing the sphere stands where a viewer stands.
  const cameras = placeCameras(
    {
      count: Math.max(1, Math.round(req.cameraCount)),
      distanceM: 2.6,
      heightM: 1.5,
      resX: req.cameraResX,
      resY: req.cameraResY,
      fovHDeg: 62,
      k1: -0.09,
      k2: 0.02,
      positionJitterM: 0.02,
      aimJitterDeg: 2.0,
      rollJitterDeg: 1.5,
      heightSpreadM: 0.35,
    },
    world.truthRig.sphere.centerHeightM,
    rng.fork('cameras'),
  );

  const { grayBits } = planPatternFor(world.truthRig, cameras);
  const plan = { ...DEFAULT_PATTERN_PLAN, grayBits };
  const frames = planFrames(plan).length * cameras.length * world.truthRig.projectors.length;

  report(
    'capture',
    0.05,
    `Photographing: ${cameras.length} camera${cameras.length === 1 ? '' : 's'} × ` +
      `${world.truthRig.projectors.length} projectors × ${planFrames(plan).length} patterns ` +
      `= ${frames} frames at ${req.cameraResX}×${req.cameraResY}.`,
  );

  const t0 = performance.now();
  const capture = captureAndDecode(world.truthRig, cameras, {
    plan,
    conditions: {
      ambient: req.ambient,
      reflectance: world.scene.reflectance,
      roomAlbedo: world.scene.roomAlbedo,
      sensor: req.sensorNoise ? { ...DEFAULT_SENSOR } : null,
      handheld: req.handheld ? { ...DEFAULT_HANDHELD } : null,
      clock: { ...DEFAULT_CLOCK },
      // §4.3's usability threshold. Below cos(incidence) = 0.2 the spec says
      // resolution smear exceeds 5×; a streaked fringe carries no phase, so
      // those points receive ambient only and the decoder rejects them on
      // modulation exactly as it would in the room.
      minIncidenceCos: 0.2,
    },
    seed: req.seed,
    decode: { pixelStride: 1, maxCorrespondences: 4000 },
    // One frame from every camera, so the page can show what the solve worked
    // from. The frame is the fourth Gray plane of the u axis: coarse enough to
    // read as a pattern in a thumbnail, fine enough that the sphere's curvature
    // visibly bends it.
    previewPairs: cameras.map((_, c) => ({ camera: c, projector: 0 })),
    previewFrame: previewFrameIndex(plan),
  });
  const captureMs = performance.now() - t0;

  const shots: FrameImage[] = capture.previews.map((p) => ({
    width: p.image.width,
    height: p.image.height,
    data: p.image.data,
    caption: `${cameras[p.camera]?.id ?? `C${p.camera + 1}`} — Gray plane ${p.frame}`,
    space: 'linear',
  }));

  report(
    'decode',
    0.55,
    `${capture.correspondences.length.toLocaleString()} points decoded from ` +
      `${capture.stats.considered.toLocaleString()} candidates. ` +
      `${(capture.stats.considered - capture.stats.accepted).toLocaleString()} rejected — ` +
      `too dim, ambiguous, or the two axes disagreed.`,
    { shots },
  );

  // The nominal the operator hands the solver: built by the SOLVER's own
  // construction from the documented constants, with the four quadrant slots cut
  // down to the ones this install uses. §2's "quadrants go dark" removes
  // projectors from a standard layout, it does not respace the ones that remain.
  const res = RESOLUTIONS[Math.round(req.settings.resolution)] ?? RESOLUTIONS[1];
  const fullNominal = solverNominalRig({
    projectorCount: 4,
    resX: res.resX,
    resY: res.resY,
    distanceM: PARAMETER_TABLE.d_proj.nominal,
    projectorHeightM: PARAMETER_TABLE.h_proj.nominal,
    centerHeightM: PARAMETER_TABLE.h_center.nominal,
  });
  const solverNominal: RigCalibration = {
    ...fullNominal,
    projectors: world.truthRig.projectors.map((_, k) => fullNominal.projectors[k]),
  };

  // The operator's guess at where each tripod stood: right side of the sphere,
  // wrong distance and aim. `initialize.ts` is explicit that the pose is an
  // initialisation and needs to be right about which side it was on.
  const guessRng = makeBenchRng(req.seed).fork('camera-guess');
  const cameraInputs = cameras.map((c) => {
    const dist = Math.hypot(c.pose.position.x, c.pose.position.y, c.pose.position.z);
    const s = 1 + guessRng.normal(0, 0.25) / Math.max(0.1, dist);
    return {
      intrinsics: { ...c.intrinsics },
      position: { x: c.pose.position.x * s, y: c.pose.position.y * s, z: c.pose.position.z * s },
      yawDeg: c.pose.yawDeg + guessRng.normal(0, 3),
      pitchDeg: c.pose.pitchDeg + guessRng.normal(0, 3),
      rollDeg: c.pose.rollDeg + guessRng.normal(0, 3),
    };
  });

  // PARAMETERS.md §8 item 1: "floor to each projector lens". Easy to take
  // accurately with a tape, unlike floor to the centre of a suspended sphere —
  // which is the whole argument of §1's note. 3 mm is a careful tape reading.
  const floorRng = makeBenchRng(req.seed).fork('floor-refs');
  const floorSigmaM = 0.003;
  const floorReferences = world.truthRig.projectors.map((p, i) => ({
    kind: 'projector' as const,
    index: i,
    heightM:
      p.pose.position.z + world.truthRig.sphere.centerHeightM + floorRng.normal(0, floorSigmaM),
    sigmaM: floorSigmaM,
  }));

  report('initialize', 0.6, 'Bootstrapping poses from the correspondences…');

  const t1 = performance.now();
  // `onStep` is read-only by construction and the solver's own determinism test
  // asserts that a watched solve and a silent one produce identical output. It
  // is here because five seconds of spinner tells a person nothing and a falling
  // cost tells them the optimiser is working.
  let stepCount = 0;
  const solver = solve({
    nominal: solverNominal,
    cameras: cameraInputs,
    correspondences: capture.correspondences,
    floorReferences,
    options: { seed: req.seed, bundle: { free: { ...DEFAULT_FREE_FLAGS } } },
    onStep: (s) => {
      stepCount++;
      report(
        'bundle',
        // The optimiser's own budget is 100 iterations and it almost never uses
        // them, so a bar driven by `iteration / maxIterations` would crawl and
        // then jump. This saturates instead: honest about being an estimate.
        0.6 + 0.35 * (1 - Math.exp(-stepCount / 12)),
        `Fitting: pass ${s.pass + 1}, step ${s.iteration}, cost ${s.cost.toPrecision(4)}`,
        {
          step: { pass: s.pass, iteration: s.iteration, cost: s.cost },
          // Every step, so the sphere moves as the optimiser does. It is a few
          // hundred bytes of JSON against a step that costs milliseconds, and
          // watching the doubled grid lines walk back together is the clearest
          // statement of what a calibration is that this page can make.
          partialRig: s.calibration,
        },
      );
    },
  });
  const solveMs = performance.now() - t1;

  report(
    'score',
    0.95,
    `Bundle adjustment converged in ${solver.diagnostics.iterations} iterations; ` +
      `residual ${solver.diagnostics.rmsResidualPx.toFixed(3)} px.`,
  );

  const recovery = scoreRecovery({
    truthRig: world.truthRig,
    recoveredRig: solver.calibration,
    truthCameras: cameras.map((c) => c.pose),
    truthCamerasAtEpoch: capture.cameraPoseAtEpoch,
    recoveredCameras: solver.extra.cameras,
    cameraIds: cameras.map((c) => c.id),
    gaugeFreeAxes: solver.extra.gaugeFreeAxes,
    centerHeightObserved: solver.extra.centerHeightObserved,
    nominalCenterHeightM: PARAMETER_TABLE.h_center.nominal,
  });

  return {
    kind: 'solve',
    id: req.id,
    ok: true,
    // The GAUGE-ALIGNED rig, which is what a compositor would be driven with —
    // and what `packages/bench` feeds the metrics as `contentRig`. Handing back
    // the raw one would leave a global rotation in the picture that no metric
    // scores and no operator would ever see.
    recoveredRig: recovery.alignedRig,
    correspondences: capture.correspondences.length,
    frames: capture.framesRendered,
    grayBits,
    residualRmsPx: solver.diagnostics.rmsResidualPx,
    iterations: solver.diagnostics.iterations,
    converged: solver.diagnostics.converged,
    posePositionMm: recovery.aligned.maxPositionMm,
    poseRotationDeg: recovery.aligned.maxRotationDeg,
    centerHeightErrorMm: recovery.centerHeight.errorMm,
    gaugeAngleDeg: recovery.gauge.angleDeg,
    captureMs,
    solveMs,
    recovery: recoveryTable(world.asBuiltRig, recovery.alignedRig, world.truthRig),
  };
}
