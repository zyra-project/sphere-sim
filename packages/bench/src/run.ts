/**
 * One scenario, end to end: build a rig, photograph it, solve it, score it.
 *
 * This is the only place in the repository where the forward model and the
 * inverse model are both in scope, and the order of operations is what keeps
 * that honest:
 *
 *   1. `packages/sim` builds the rig the documentation describes, then perturbs
 *      it. The perturbed rig is GROUND TRUTH and never leaves this function.
 *   2. `packages/sim` renders what cameras in the room photograph while each
 *      structured-light pattern is displayed.
 *   3. `packages/solver` decodes those images and solves, seeing only the
 *      images, the documented nominals, the operator's camera calibration, and
 *      a tape measure or two.
 *   4. The bench compares.
 *
 * Nothing derived from the perturbed rig reaches step 3 except through pixels.
 * The two places that could leak and do not are worth naming: the nominal
 * handed to the solver is built by the SOLVER's own `nominalRig` from the
 * documented constants, not by the simulator's; and the floor references carry
 * the true lens heights, which is not a leak but a measurement — PARAMETERS.md
 * §8 item 1 asks an operator to take exactly those, with a tape measure, and
 * they arrive here with the tape measure's noise on them.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import { PARAMETER_TABLE } from '../../calibration/src/parameters.ts';
import { gridAlignmentPattern } from '../../sim/src/equirect.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import type { Perturbation } from '../../sim/src/scene.ts';
import { injectMisalignment, nominalRig as simNominalRig } from '../../sim/src/scene.ts';
import { defaultScene, viewerAt } from '../../sim/src/render.ts';
import type { Scene } from '../../sim/src/render.ts';
import type { MetricSet } from '../../sim/src/metrics/index.ts';
import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import type { DecodeOptions, SolverResult } from '../../solver/src/index.ts';
import {
  DEFAULT_SEGMENTATION_MARGIN,
  bundleStateFromCalibration,
  nominalRig as solverNominalRig,
  solve,
  sphereSegmenter,
} from '../../solver/src/index.ts';
// Reached past the barrel deliberately: `DEFAULT_FREE_FLAGS` is the solver's own
// statement of which parameters PARAMETERS.md §3.1 says to free, and the
// `fov-held` archetype needs to change exactly one of them without silently
// re-defaulting the other seven.
import { DEFAULT_FREE_FLAGS } from '../../solver/src/bundle.ts';
import type { SimulatedCamera } from './camera.ts';
import { placeCameras } from './camera.ts';
import type { CaptureResult } from './capture.ts';
import { captureAndDecode } from './capture.ts';
import type { PatternPlan } from './patterns.ts';
import { grayBitsForCamera, planFrames, previewFrameIndex } from './patterns.ts';
import { makeBenchRng } from './random.ts';
import type { BenchPreset, Scenario } from './scenarios.ts';
import { scaledMisalignment } from './scenarios.ts';
import type { RecoveryScore } from './score.ts';
import { scoreRecovery } from './score.ts';
import { colorizeFieldWithGaps, renderTwoRigRoomView, writePng } from './views.ts';

/**
 * Everything about a scenario that does not depend on running the solver.
 *
 * Split out because the failure-attribution pass in `cli.ts` needs the truth
 * rig and the scene again, and rebuilding them from the scenario is both cheap
 * and exactly reproducible — cheaper than holding a dozen equirectangular
 * images in memory for the length of a run, and safer than assuming they were
 * not mutated in between.
 */
export interface ScenarioWorld {
  /** The rig PARAMETERS.md describes. What the compositor has before solving. */
  documentedRig: RigCalibration;
  /** Ground truth: the documented rig, perturbed. The solver never sees it. */
  truthRig: RigCalibration;
  perturbation: Perturbation;
  scene: Scene;
  cameras: SimulatedCamera[];
  /** Nominal handed to the solver, built by the SOLVER's own construction. */
  solverNominal: RigCalibration;
}

const CONTENT_WIDTH = 1024;
const CONTENT_HEIGHT = 512;

export function buildWorld(scenario: Scenario): ScenarioWorld {
  const rng = makeBenchRng(scenario.seed);

  // The rig the documentation describes, at the DOCUMENTED constants — not at
  // this scenario's own `distanceM`. That distinction is the point of the
  // `long-throw` archetype: §2's conflict means the config a site ships with can
  // be almost a metre wrong about where its own projectors are.
  const documentedRig = simNominalRig({
    projectorCount: scenario.projectorCount,
    slots: scenario.slots,
    distanceM: PARAMETER_TABLE.d_proj.nominal,
    projectorHeightM: PARAMETER_TABLE.h_proj.nominal,
    centerHeightM: PARAMETER_TABLE.h_center.nominal,
    resX: scenario.projectorResX,
    resY: scenario.projectorResY,
    blend: scenario.blend,
  });

  // The rig this site actually has, before mount error.
  const asBuilt = simNominalRig({
    projectorCount: scenario.projectorCount,
    slots: scenario.slots,
    distanceM: scenario.distanceM,
    projectorHeightM: scenario.projectorHeightM,
    centerHeightM: scenario.centerHeightM,
    resX: scenario.projectorResX,
    resY: scenario.projectorResY,
    blend: scenario.blend,
  });
  const misaligned = injectMisalignment(asBuilt, scenario.seed, scaledMisalignment(scenario));

  const image = gridAlignmentPattern({
    width: CONTENT_WIDTH,
    height: CONTENT_HEIGHT,
    spacingDeg: 15,
    lineWidthDeg: 0.35,
    emphasizeAxes: true,
  });
  const amb = scenario.degradation.ambient;
  const scene = defaultScene(image, {
    ambient: { r: amb, g: amb, b: amb },
    maskInterpretation: scenario.maskInterpretation,
  });

  const cameras = placeCameras(
    scenario.cameras,
    misaligned.rig.sphere.centerHeightM,
    rng.fork('cameras'),
  );

  // The nominal the operator hands the solver. Built by `packages/solver`'s own
  // `nominalRig` from the PARAMETERS.md constants, with the four quadrant slots
  // selected down to the ones this install uses — §2's "quadrants go dark"
  // removes projectors from a standard layout, it does not respace the ones
  // that remain, and a nominal that respaced them would hand the bootstrap a
  // 30-degree azimuth error no real operator would make.
  const fullNominal = solverNominalRig({
    projectorCount: 4,
    resX: scenario.projectorResX,
    resY: scenario.projectorResY,
    distanceM: PARAMETER_TABLE.d_proj.nominal,
    projectorHeightM: PARAMETER_TABLE.h_proj.nominal,
    centerHeightM: PARAMETER_TABLE.h_center.nominal,
  });
  const solverNominal: RigCalibration = {
    ...fullNominal,
    projectors: scenario.slots.map((slot) => fullNominal.projectors[slot]),
  };

  return {
    documentedRig,
    truthRig: misaligned.rig,
    perturbation: misaligned.perturbation,
    scene,
    cameras,
    solverNominal,
  };
}

/**
 * Gray-plane count for this geometry.
 *
 * A pattern feature finer than the camera can resolve is worse than no pattern
 * — it decodes, badly, and the resulting error looks like decoder noise rather
 * than like an under-sampled pattern. The ratio below is measured at the
 * sub-camera and sub-projector points, where both pixel footprints are
 * smallest, and the worst pair over the rig governs. See
 * `patterns.ts:grayBitsForCamera`.
 */
export function planPatternFor(world: ScenarioWorld, scenario: Scenario, preset: BenchPreset): {
  plan: Scenario['pattern'];
  projPxPerCamPx: number;
} {
  const radius = world.truthRig.sphere.radiusM;
  let worst = 0;
  for (const cam of world.cameras) {
    const camDist = Math.hypot(cam.pose.position.x, cam.pose.position.y, cam.pose.position.z);
    // Angular pitch times the distance to the near surface point: the surface
    // length one pixel covers at normal incidence.
    const camPitch = (2 * Math.atan(cam.intrinsics.resX / 2 / cam.intrinsics.fx)) / cam.intrinsics.resX;
    const camMm = camPitch * Math.max(0.01, camDist - radius);
    for (const p of world.truthRig.projectors) {
      const projDist = Math.hypot(p.pose.position.x, p.pose.position.y, p.pose.position.z);
      const projPitch = ((p.intrinsics.fovHDeg * Math.PI) / 180) / p.intrinsics.resX;
      const projMm = projPitch * Math.max(0.01, projDist - radius);
      worst = Math.max(worst, camMm / projMm);
    }
  }
  const bits = grayBitsForCamera(
    scenario.projectorResX,
    worst,
    preset.minCameraPixelsPerStride,
  );
  return { plan: { ...scenario.pattern, grayBits: bits }, projPxPerCamPx: worst };
}

export interface ScenarioTimings {
  buildMs: number;
  captureMs: number;
  solveMs: number;
  scoreMs: number;
  metricsMs: number;
  baselineMetricsMs: number;
  renderMs: number;
  totalMs: number;
}

export interface ScenarioArtifacts {
  roomBefore: string;
  roomAfter: string;
  registration: string;
  cameraFrame: string;
}

export interface ScenarioResult {
  scenario: Scenario;
  /** Exactly what was done to the rig. Ground truth, reported, never given away. */
  perturbation: Perturbation;
  /** Null when the solve threw. Everything downstream then reports the failure. */
  error: string | null;
  capture: CaptureResult;
  patternBits: number;
  projPxPerCamPx: number;
  solver: SolverResult | null;
  recovery: RecoveryScore | null;
  /** Metrics with the RECOVERED calibration driving the content. */
  metrics: MetricSet | null;
  /** Metrics with the DOCUMENTED calibration driving the content — the before. */
  baseline: MetricSet | null;
  artifacts: ScenarioArtifacts | null;
  timings: ScenarioTimings;
  /** Kept so the failure-attribution pass can rebuild hybrids without re-solving. */
  alignedRig: RigCalibration | null;
}

export interface RunOptions {
  preset: BenchPreset;
  outDir: string;
  repoRoot: string;
  /** Skip PNG output. Used by the determinism test's second pass and by loop.ts. */
  writeArtifacts: boolean;
  /** Compute the documented-calibration baseline metrics. */
  baseline: boolean;
  /**
   * Decoder thresholds, on top of the bench's own two.
   *
   * For experiments that ask what a threshold can and cannot reject. Undefined
   * everywhere in the bench itself, so every published number was produced with
   * `DEFAULT_DECODE_OPTIONS` plus the preset's correspondence cap and nothing
   * else — and a run that overrode one is visible in the experiment's own
   * `generatedFrom` rather than hidden in a default.
   */
  decode?: Partial<DecodeOptions>;
  /**
   * Reject decoded correspondences that cannot be on the sphere, using the
   * NOMINAL rig the solver is about to start from.
   *
   * Off everywhere in the bench, so every published number is unsegmented. It
   * exists for docs/EXPERIMENT-4.md, which measures what the room costs and
   * whether this recovers it, and it is built here rather than by the caller
   * because the nominal it must be tested against is built here — a caller
   * assembling its own would be one refactor away from handing the decoder the
   * truth rig, which would make every number downstream of it worthless.
   */
  segmentSphere?: boolean;
  /**
   * Segment the sphere out of the PHOTOGRAPH before decoding.
   *
   * Independent of `segmentSphere` and testable against it: that one casts a
   * decoded ray at the nominal rig and so inherits a dependence on the error
   * being solved for, this one reads pixels and inherits nothing. Off by
   * default; no published number was produced with it.
   */
  segmentImage?: boolean;
  /**
   * How far to inflate the segmentation's test sphere. Defaults to
   * `DEFAULT_SEGMENTATION_MARGIN`. Inert unless `segmentSphere` is on.
   *
   * Separable because it is the parameter the whole idea turns on: the margin
   * that keeps genuine points at the limb is the same margin that admits room
   * points just outside it, and which of those dominates is a measurement.
   */
  segmentMarginFrac?: number;
}

export function runScenario(scenario: Scenario, options: RunOptions): ScenarioResult {
  const t0 = Date.now();
  const world = buildWorld(scenario);
  const { plan, projPxPerCamPx } = planPatternFor(world, scenario, options.preset);
  const tBuild = Date.now();

  const capture = captureAndDecode(world.truthRig, world.cameras, {
    plan,
    conditions: {
      ambient: scenario.degradation.ambient,
      reflectance: world.scene.reflectance,
      roomAlbedo: world.scene.roomAlbedo,
      sensor: scenario.degradation.sensor,
      handheld: scenario.degradation.handheld,
      clock: scenario.degradation.clock,
      minIncidenceCos: 0.2,
      roomSpill: scenario.degradation.roomSpill,
      segmentImage: options.segmentImage === true ? {} : null,
    },
    seed: scenario.seed,
    decode: {
      pixelStride: 1,
      maxCorrespondences: options.preset.maxCorrespondencesPerPair,
      // Built from the NOMINAL rig — what the operator starts from — and never
      // from `world.truthRig`, which is two lines above and is ground truth.
      segmentation: options.segmentSphere === true
        ? sphereSegmenter({
            radiusM: world.solverNominal.sphere.radiusM,
            projectors: bundleStateFromCalibration(world.solverNominal, []).projectors,
            marginFrac: options.segmentMarginFrac ?? DEFAULT_SEGMENTATION_MARGIN,
          })
        : null,
      // Last, so a caller can raise the decoder's own rejection thresholds. The
      // bench never does; an experiment that is asking whether a threshold could
      // reject something needs to be able to move it, and moving it by editing
      // `DEFAULT_DECODE_OPTIONS` would move every published number with it.
      ...(options.decode ?? {}),
    },
    // One frame kept as an artifact: the fourth Gray plane of the u axis, which
    // is coarse enough to read as a pattern in a thumbnail and fine enough to
    // show the sphere's curvature bending it.
    previewPairs: [{ camera: 0, projector: 0 }],
    previewFrame: options.writeArtifacts ? previewFrameIndex(plan) : -1,
  });
  const tCapture = Date.now();

  // The operator's guess at where each tripod stood. Right side of the sphere,
  // wrong distance and aim — `initialize.ts` is explicit that the pose is an
  // initialisation and needs to be right about which side it was on, not about
  // how far away.
  const guessRng = makeBenchRng(scenario.seed).fork('camera-guess');
  const cameraInputs = world.cameras.map((c) => {
    const dist = Math.hypot(c.pose.position.x, c.pose.position.y, c.pose.position.z);
    const s = 1 + guessRng.normal(0, scenario.cameraNominalPositionErrorM) / Math.max(0.1, dist);
    return {
      intrinsics: { ...c.intrinsics },
      position: {
        x: c.pose.position.x * s,
        y: c.pose.position.y * s,
        z: c.pose.position.z * s,
      },
      yawDeg: c.pose.yawDeg + guessRng.normal(0, scenario.cameraNominalAngleErrorDeg),
      pitchDeg: c.pose.pitchDeg + guessRng.normal(0, scenario.cameraNominalAngleErrorDeg),
      rollDeg: c.pose.rollDeg + guessRng.normal(0, scenario.cameraNominalAngleErrorDeg),
    };
  });

  // PARAMETERS.md §8 item 1: "floor to each projector lens". Easy to take
  // accurately, unlike floor to the centre of a suspended sphere — which is the
  // whole argument of §1's note.
  const floorRng = makeBenchRng(scenario.seed).fork('floor-refs');
  const floorReferences = world.truthRig.projectors
    .slice(0, scenario.floorReferenceCount)
    .map((p, i) => ({
      kind: 'projector' as const,
      index: i,
      heightM:
        p.pose.position.z +
        world.truthRig.sphere.centerHeightM +
        floorRng.normal(0, scenario.floorSigmaM),
      sigmaM: scenario.floorSigmaM,
    }));

  let solver: SolverResult | null = null;
  let error: string | null = null;
  try {
    solver = solve({
      nominal: world.solverNominal,
      cameras: cameraInputs,
      correspondences: capture.correspondences,
      floorReferences,
      options: {
        seed: scenario.seed,
        bundle: { free: { ...DEFAULT_FREE_FLAGS, projectorFov: scenario.freeFov } },
      },
    });
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const tSolve = Date.now();

  let recovery: RecoveryScore | null = null;
  if (solver !== null) {
    recovery = scoreRecovery({
      truthRig: world.truthRig,
      recoveredRig: solver.calibration,
      truthCameras: world.cameras.map((c) => c.pose),
      // Where the cameras actually were at the epoch the solver's reported
      // poses refer to. Round 3 scored against the static placement and round
      // 3's critic showed that makes `camera_pose_rotation` unreachable: a
      // perfect solver scores 0.08-0.33 deg against a 0.07 deg gate on a motion
      // archetype, because the truth pose has moved and the metric is measuring
      // that. Both numbers are reported; the gate reads this one.
      truthCamerasAtEpoch: capture.cameraPoseAtEpoch,
      recoveredCameras: solver.extra.cameras,
      cameraIds: world.cameras.map((c) => c.id),
      gaugeFreeAxes: solver.extra.gaugeFreeAxes,
      centerHeightObserved: solver.extra.centerHeightObserved,
      nominalCenterHeightM: PARAMETER_TABLE.h_center.nominal,
    });
  }
  const tScore = Date.now();

  let metrics: MetricSet | null = null;
  if (recovery !== null) {
    try {
      metrics = computeGeometricMetrics(world.truthRig, world.scene, {
        contentRig: recovery.alignedRig,
        densityScale: options.preset.metricDensityScale,
        convergence: options.preset.metricConvergence,
      });
    } catch (e) {
      error = error ?? `metrics: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const tMetrics = Date.now();

  let baseline: MetricSet | null = null;
  if (options.baseline) {
    try {
      baseline = computeGeometricMetrics(world.truthRig, world.scene, {
        contentRig: world.documentedRig,
        densityScale: options.preset.metricDensityScale,
        convergence: false,
      });
    } catch {
      baseline = null;
    }
  }
  const tBaseline = Date.now();

  let artifacts: ScenarioArtifacts | null = null;
  if (options.writeArtifacts) {
    artifacts = writeArtifacts(scenario, world, recovery, metrics, capture, options);
  }
  const tRender = Date.now();

  return {
    scenario,
    perturbation: world.perturbation,
    error,
    capture,
    patternBits: plan.grayBits,
    projPxPerCamPx,
    solver,
    recovery,
    metrics,
    baseline,
    artifacts,
    alignedRig: recovery === null ? null : recovery.alignedRig,
    timings: {
      buildMs: tBuild - t0,
      captureMs: tCapture - tBuild,
      solveMs: tSolve - tCapture,
      scoreMs: tScore - tSolve,
      metricsMs: tMetrics - tScore,
      baselineMetricsMs: tBaseline - tMetrics,
      renderMs: tRender - tBaseline,
      totalMs: tRender - t0,
    },
  };
}

function writeArtifacts(
  scenario: Scenario,
  world: ScenarioWorld,
  recovery: RecoveryScore | null,
  metrics: MetricSet | null,
  capture: CaptureResult,
  options: RunOptions,
): ScenarioArtifacts {
  const size = options.preset.renderSize;
  const physical = prepareRig(world.truthRig);
  // A viewer at the guard rail, adult eye height, looking at a SEAM. The seam is
  // where PARAMETERS.md §7's grid gate lives and where a doubled line shows;
  // framing on a projector's own meridian would put the most forgiving part of
  // the sphere in the middle of every artifact.
  const camera = viewerAt(45, 2.5, 1.6, world.truthRig.sphere.centerHeightM, size, size, 50);

  const before = renderTwoRigRoomView(
    physical,
    prepareRig(world.documentedRig),
    world.scene,
    camera,
    { samplesPerPixel: 4, seed: scenario.seed },
  );
  const paths: ScenarioArtifacts = {
    roomBefore: writePng(options.outDir, options.repoRoot, `${scenario.id}-room-before.png`, before),
    // Empty rather than a copy of the "before" when there is nothing to show.
    // Writing the same image under both names would put a picture in front of a
    // reader that says the solve changed nothing, when what happened is that
    // the solve threw.
    roomAfter: '',
    registration: '',
    cameraFrame: '',
  };
  if (recovery !== null) {
    const after = renderTwoRigRoomView(
      physical,
      prepareRig(recovery.alignedRig),
      world.scene,
      camera,
      { samplesPerPixel: 4, seed: scenario.seed },
    );
    paths.roomAfter = writePng(
      options.outDir,
      options.repoRoot,
      `${scenario.id}-room-after.png`,
      after,
    );
  }

  if (metrics !== null) {
    // Fixed 0-10 mm scale rather than auto-ranged. An auto-ranged colormap makes
    // every scenario look equally bad, which is precisely the comparison a
    // reader is trying to make across scenarios.
    const field = colorizeFieldWithGaps(metrics.fields.registrationMm, 0, 10);
    paths.registration = writePng(
      options.outDir,
      options.repoRoot,
      `${scenario.id}-registration.png`,
      field,
    );
  }
  if (capture.preview !== null) {
    paths.cameraFrame = writePng(
      options.outDir,
      options.repoRoot,
      `${scenario.id}-camera.png`,
      capture.preview,
    );
  }
  return paths;
}
