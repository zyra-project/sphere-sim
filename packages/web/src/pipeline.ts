// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
import { NOMINAL_SLOTS_BY_COUNT } from '../../calibration/src/conventions.ts';
import { placeCameras } from '../../bench/src/camera.ts';
import { DEFAULT_CLOCK, DEFAULT_HANDHELD } from '../../bench/src/camera.ts';
import { captureAndDecode, DEFAULT_SENSOR } from '../../bench/src/capture.ts';
import {
  DEFAULT_PATTERN_PLAN,
  grayBitsForCamera,
  planFrames,
} from '../../bench/src/patterns.ts';
import { makeBenchRng } from '../../bench/src/random.ts';
import { scoreRecovery } from '../../bench/src/score.ts';
import { nominalRig as solverNominalRig, solve } from '../../solver/src/index.ts';
// Two hierarchies over one mesh, because `packages/sim` and `packages/solver`
// may not import each other. See `SolveRequest.mesh`.
import { buildMeshIndex, type MeshIndex } from '../../solver/src/mesh.ts';
import { meshSurface } from '../../sim/src/mesh/surface.ts';
import type { Surface } from '../../sim/src/surface.ts';
// Reached past the barrel deliberately: `DEFAULT_FREE_FLAGS` is the solver's own
// statement of which parameters PARAMETERS.md §3.1 says to free, and the page
// must not silently re-default the seven it is not touching.
import { DEFAULT_FREE_FLAGS } from '../../solver/src/bundle.ts';
import { buildWorld } from './rigs.ts';
import type { EquirectImage } from '../../sim/src/equirect.ts';
import { cameraDistanceM, RESOLUTIONS } from './settings.ts';
import type {
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
  /**
   * The short way round.
   *
   * `atan2` comes back in (-180, 180], so a projector sitting near the cut has a
   * documented azimuth of +179.9 and a recovered one of -179.9 — a tenth of a
   * degree apart in the room and 359.8 apart by subtraction. That row then sorted
   * to the top and told a reader the solver had spun a projector most of the way
   * round the ring.
   */
  const wrap = (d: number): number => d - 360 * Math.round(d / 360);
  const axes: {
    axis: string;
    unit: string;
    of: (p: Proj) => number;
    cyclic?: boolean;
  }[] = [
    { axis: 'distance to sphere', unit: 'mm', of: (p) => dist(p) * 1000 },
    { axis: 'height', unit: 'mm', of: (p) => p.pose.position.z * 1000 },
    { axis: 'azimuth', unit: '\u00b0', of: azDeg, cyclic: true },
    { axis: 'aim yaw', unit: '\u00b0', of: (p) => p.pose.yawDeg, cyclic: true },
    { axis: 'aim pitch', unit: '\u00b0', of: (p) => p.pose.pitchDeg, cyclic: true },
    { axis: 'roll', unit: '\u00b0', of: (p) => p.pose.rollDeg, cyclic: true },
    { axis: 'field of view', unit: '\u00b0', of: (p) => p.intrinsics.fovHDeg },
  ];

  /**
   * How far a movement carries the picture, in millimetres on the sphere.
   *
   * The rows are millimetres and degrees together, and ranking them by raw
   * magnitude means 60 mm always beats 0.3 degrees — so the sort promised
   * "largest movements first" and then showed six distances and heights, never
   * once an angle, however badly the aim had been out. A degree at this throw
   * moves the image about 94 mm across the ball, which is the number a reader
   * cares about and the one that makes the two units comparable.
   */
  const ranked: { row: RecoveredAxis; rank: number }[] = [];

  for (let i = 0; i < n; i++) {
    const throwM = dist(recovered.projectors[i]);
    const mmPerDeg = throwM * (Math.PI / 180) * 1000;
    for (const a of axes) {
      const documentedV = a.of(documented.projectors[i]);
      const recoveredV = a.of(recovered.projectors[i]);
      const truthV = a.of(truth.projectors[i]);
      const moved = a.cyclic ? wrap(recoveredV - documentedV) : recoveredV - documentedV;
      const errorFromTruth = a.cyclic ? wrap(recoveredV - truthV) : recoveredV - truthV;
      const row: RecoveredAxis = {
        projectorId: truth.projectors[i].id,
        axis: a.axis,
        unit: a.unit,
        documented: documentedV,
        recovered: recoveredV,
        truth: truthV,
        errorFromTruth,
        moved,
      };
      rows.push(row);
      ranked.push({ row, rank: Math.abs(moved) * (a.unit === 'mm' ? 1 : mmPerDeg) });
    }
  }
  // Largest movement first, measured on the sphere: the page shows the top
  // handful, and what a reader wants to see is what the solve actually did
  // rather than the axes it left alone.
  return ranked.sort((a, b) => b.rank - a.rank).map((r) => r.row);
}

/**
 * The whole pipeline, as a plain function of its request.
 *
 * Exported and free of `self` so `test/solve.test.ts` can run a real capture and
 * a real solve in Node and assert on the result. A calibration pipeline that
 * only exists inside a worker is a calibration pipeline nothing can check, and
 * this one is the reason the page can claim anything at all.
 */
/**
 * The nominal the operator hands the solver: the SOLVER's own construction from
 * the documented constants, at the quadrant slots this install actually uses.
 *
 * Exported because the slot mapping is the whole content of it and it is two
 * hops, neither of which is obvious. It used to be one line inside `runSolve` —
 * `world.truthRig.projectors.map((_, k) => fullNominal.projectors[k])` — which
 * takes a PREFIX of the four-slot nominal, so the moment the lit set was not a
 * prefix of the slot list every projector past the gap was handed a nominal a
 * full quadrant around the ring: 7.33 m of position error, from one click on
 * `Projectors = 2`. `NudgedRig.slots` exists for exactly this and its own doc
 * comment names this failure class; nothing was reading it here.
 *
 * Hop one: PARAMETERS.md S2's "quadrants go dark" removes a projector from a
 * standard layout rather than respacing the ones that remain, so an N-projector
 * install occupies conventions.ts SN.2's SUBSET of the four 90-degree slots.
 * Hop two: `NudgedRig.slots` indexes that already-cut installed rig, not the
 * four quadrants — at Projectors = 3 the installed rig is slots 0, 1, 2, so
 * `slots` of [0, 2] means quadrants 0 and 180, not 0 and 90.
 *
 * Built BY `nominalRig` at the named slots rather than sliced out of a
 * four-projector rig. The solver's own construction is the one that has to be
 * right about where a dark quadrant leaves the others, and it validates that the
 * slots are distinct and in range on the way in.
 */
export function solverNominalFor(
  settings: SolveRequest['settings'],
  slots: readonly number[],
): RigCalibration {
  const res = RESOLUTIONS[Math.round(settings.resolution)] ?? RESOLUTIONS[1];
  const installed = NOMINAL_SLOTS_BY_COUNT[Math.round(settings.projectorCount)] ?? [0, 1, 2, 3];
  const litSlots = slots.map((i) => installed[i]);
  return solverNominalRig({
    projectorCount: litSlots.length,
    slots: litSlots,
    resX: res.resX,
    resY: res.resY,
    distanceM: PARAMETER_TABLE.d_proj.nominal,
    projectorHeightM: PARAMETER_TABLE.h_proj.nominal,
    centerHeightM: PARAMETER_TABLE.h_center.nominal,
  });
}

/**
 * The image playing on the sphere, held across solves.
 *
 * The same arrangement `model.ts` uses and for the same reason: a megabyte of
 * float per request is not worth resending when it changes once. Kept here
 * rather than in the worker shell so `test/solve.test.ts` exercises the same
 * path the page does.
 */
let cachedImage: EquirectImage | null = null;
let cachedImageId = '';

/**
 * The dropped model's two hierarchies, held across solves.
 *
 * Built together and discarded together so they can never describe different
 * shapes: a cache that refreshed one and kept the other would photograph one
 * model and calibrate against another, which is exactly the failure the
 * agreement test in `packages/bench` exists to catch, arriving through a door
 * no test watches.
 */
let cachedMeshId = '';
let cachedSurface: Surface | null = null;
let cachedIndex: MeshIndex | null = null;

export function runSolve(req: SolveRequest, onProgress: ProgressSink = () => {}): SolveResponse {
  if (req.customImage) {
    cachedImage = req.customImage;
    cachedImageId = req.customImageId;
  }
  if (req.mesh) {
    cachedMeshId = req.meshId;
    cachedSurface = meshSurface(req.mesh);
    cachedIndex = buildMeshIndex(req.mesh);
  } else if (req.meshId === '') {
    // The page went back to the sphere. Dropping both is what makes the sphere
    // path here the same code it was: `surface` omitted and `surface: null`.
    cachedMeshId = '';
    cachedSurface = null;
    cachedIndex = null;
  }
  // A stale cache is not a shape to guess at. If the page believes this worker
  // holds a model it does not, both halves fall back together rather than one
  // of them tracing a sphere.
  const meshHeld = req.meshId !== '' && cachedMeshId === req.meshId;
  const captureSurface = meshHeld ? cachedSurface : null;
  const solveSurface = meshHeld ? cachedIndex : null;
  const report = (
    phase: SolveProgress['phase'],
    fraction: number,
    message: string,
    extra: Partial<SolveProgress> = {},
  ): void => {
    onProgress({ kind: 'solve-progress', id: req.id, phase, fraction, message, ...extra });
  };
  // The content matters to the camera previews and to nothing else in here.
  const world = buildWorld(
    req.settings,
    undefined,
    cachedImageId === req.customImageId ? (cachedImage ?? undefined) : undefined,
  );
  // Nothing to photograph. `planPatternFor` reads `projectors[0].intrinsics` to
  // size the Gray code and threw a raw TypeError here — a message naming neither
  // the control that caused it nor the way back — and nothing upstream stops the
  // last lit projector being switched off: the tabs toggle freely and the metrics
  // worker is perfectly happy with an unlit sphere.
  if (world.truthRig.projectors.length === 0) {
    throw new Error(
      'Every projector is switched off at the wall, so there is nothing to photograph. ' +
        'Switch at least one back on and recalibrate.',
    );
  }

  const rng = makeBenchRng(req.seed);

  // §6 bounds the viewing distance at 2.0–3.5 m, the low end by the guard rail.
  // An operator photographing the sphere stands where a viewer stands — and
  // "where a viewer stands" is set by the size of the ball. On a 130-inch sphere
  // a camera 2.6 m from the centre is 0.95 m off the surface, inside the rail,
  // photographing a fraction of the silhouette; the solve would then be handed a
  // geometry no operator could have produced. So the distance scales with the
  // radius and the HEIGHT does not: 1.5 m is an operator's eye, whatever the
  // ball is doing, and `placeCameras` already measures it off the floor.
  //
  // At §1's 68-inch sphere the factor is 1 and the placement is unchanged, so
  // every number this page has ever printed at the default is untouched.
  const cameras = placeCameras(
    {
      count: Math.max(1, Math.round(req.cameraCount)),
      distanceM: cameraDistanceM(world.truthRig.sphere.radiusM),
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
  // The white/black pair has to be present for the preview below to be frame 0,
  // and it is what the decoder normalizes against in any case.
  const plan = { ...DEFAULT_PATTERN_PLAN, grayBits, includeWhiteBlack: true };
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
    // Photograph the same shape the bundle below will be fitted against.
    surface: captureSurface,
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
      // The room defaults OFF because its three constants are ASSUME and nobody
      // has measured a wall; segmentation defaults ON because the payoff is
      // asymmetric -- 6.7% of solves usable against 93.3% when a room is
      // present, and 0.908x when there is none, which is inside the seed range.
      // That makes segmentation the one condition where this page deliberately
      // differs from the bench, so the panel says so and the readout says so.
      //
      // The old comment here argued the page should have no control at all,
      // because a browser solve that QUIETLY ran a different capture would make
      // the two incomparable. That was about silence, not about the switch.
      // The panel's own wall and ceiling, not the bench's defaults, so the room
      // drawn on screen and the room photographed are one room. They start at
      // §5's nominals; moving either slider moves both.
      roomSpill:
        req.settings.roomSpill === 1
          ? { wallRadiusM: req.settings.wallRadiusM, ceilingM: req.settings.ceilingM }
          : null,
      segmentImage: req.settings.segmentSphere === 1 ? {} : null,
    },
    seed: req.seed,
    decode: { pixelStride: 1, maxCorrespondences: 4000 },
    // No frames kept from the capture itself: a single structured-light frame is
    // a crescent of one projector's light on one side of the ball and tells a
    // reader nothing about where anybody stood. The page draws the CAMERAS
    // instead, from the poses reported below.
    previewPairs: [],
    previewFrame: 0,
  });
  const captureMs = performance.now() - t0;

  // Poses, not pictures. The page renders these itself through the display
  // shader, which is the renderer that knows the room has projectors and a
  // handrail standing in it — `renderTwoRigRoomView` draws neither, deliberately,
  // because neither is in the model. That also takes three CPU room traces out
  // of every solve.
  //
  // The field of view is derived from the camera rather than restated: a camera
  // whose focal length changed and whose preview did not would be a picture of a
  // different lens.
  const shotCameras = cameras.map((cam, i) => ({
    id: cam.id || `C${i + 1}`,
    position: cam.pose.position,
    fovHDeg: 2 * Math.atan(cam.intrinsics.resX / 2 / cam.intrinsics.fx) * (180 / Math.PI),
  }));

  report(
    'decode',
    0.55,
    `${capture.correspondences.length.toLocaleString()} points decoded from ` +
      `${capture.stats.considered.toLocaleString()} candidates. ` +
      `${(capture.stats.considered - capture.stats.accepted).toLocaleString()} rejected — ` +
      `too dim, ambiguous, or the two axes disagreed.`,
    { shotCameras },
  );

  // The nominal the operator hands the solver: built by the SOLVER's own
  // construction from the documented constants, with the four quadrant slots cut
  // down to the ones this install uses. §2's "quadrants go dark" removes
  // projectors from a standard layout, it does not respace the ones that remain.
  const solverNominal = solverNominalFor(req.settings, world.slots);
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
    options: {
      seed: req.seed,
      bundle: { free: { ...DEFAULT_FREE_FLAGS }, surface: solveSurface },
    },
    onStep: (s) => {
      stepCount++;
      // The optimiser's cost is a robustified sum of squares in its own units.
      // An RMS in PIXELS is the same information in the unit the residual is
      // reported in at the end, so the number a reader watches fall is the same
      // number they are handed when it stops.
      const rmsPx = Math.sqrt(Math.max(0, s.cost) / Math.max(1, capture.correspondences.length));
      report(
        'bundle',
        // The optimiser's own budget is 100 iterations and it almost never uses
        // them, so a bar driven by `iteration / maxIterations` would crawl and
        // then jump. This saturates instead: honest about being an estimate.
        0.6 + 0.35 * (1 - Math.exp(-stepCount / 12)),
        `Fitting — step ${stepCount}, residual ${rmsPx.toFixed(2)} px`,
        {
          step: { pass: s.pass, iteration: s.iteration, cost: s.cost, rmsPx, step: stepCount },
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
    // Not "converged in N iterations" unconditionally, which is what this said:
    // the sentence asserted the one thing the operator most needs to be told
    // when it is false.
    solver.diagnostics.converged
      ? `Bundle adjustment converged in ${solver.diagnostics.iterations} iterations; ` +
        `residual ${solver.diagnostics.rmsResidualPx.toFixed(3)} px.`
      : `Bundle adjustment did NOT converge — it stopped at its ` +
        `${solver.diagnostics.iterations}-iteration cap with a residual of ` +
        `${solver.diagnostics.rmsResidualPx.toFixed(3)} px.`,
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
    silhouetteRefusals: capture.silhouettes.filter((s) => s.chosen < 0 || s.warnings.length > 0)
      .length,
    silhouetteCameras: capture.silhouettes.length,
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
