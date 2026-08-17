/**
 * What crosses the worker boundary.
 *
 * Two workers, because they answer questions on different timescales and one
 * must never block the other:
 *
 *   - **model** — the metrics. A few hundred milliseconds, re-run whenever a
 *     slider settles.
 *   - **solve** — a full structured-light calibration. Several seconds, run when
 *     a person asks for one, and it must be able to report progress while the
 *     metrics keep updating around it.
 *
 * Every message is plain JSON plus transferable typed arrays. Nothing here is a
 * class instance, a function or a live object: a worker that received a rig
 * containing methods would be receiving a model rather than data, and the whole
 * arrangement depends on the worker rebuilding its own world from constants it
 * can see.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import type { Settings } from './settings.ts';
import type { Reading, RigFact } from './readout.ts';

/** A downscale of the live camera, for the CPU half of the parity check. */
export interface ParityCameraRequest {
  width: number;
  height: number;
  fovHDeg: number;
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

export interface ModelRequest {
  kind: 'model';
  /** Echoed back, so a stale reply arriving after a newer one can be dropped. */
  id: number;
  settings: Settings;
  /** What the compositor believes. `null` means "the config as written". */
  compositorRig: RigCalibration | null;
  /** Sampling density relative to the bench's default. See `metricsFor`. */
  densityScale: number;
  /** Omit to skip the parity render — it is the expensive half. */
  parity: ParityCameraRequest | null;
  /**
   * A supplied equirectangular image, in linear light, when the page is showing
   * one — and `null` when it is not.
   *
   * The worker cannot see the file the user dropped, so it has to be sent. It is
   * sent only when {@link ModelRequest.customImageId} changes and the worker
   * holds the last one, because a megabyte of float across the boundary on every
   * slider drag would cost more than the metrics.
   *
   * Getting this wrong is not cosmetic and was caught by the page's own parity
   * check: with the image on the GPU and the fallback in the worker, the two
   * renderers were comparing different pictures and reported a 15% disagreement
   * that belonged to neither model.
   */
  customImage: { width: number; height: number; data: Float32Array } | null;
  /** Identifies the supplied image. `''` when there is none. */
  customImageId: string;
  /**
   * Render each projector's own frame at this width. Zero skips it.
   *
   * The frame a projector is SENDING is a property of the compositor's
   * calibration alone — it is what the software wrote into that raster — so
   * bumping a projector does not change it. Only recalibrating does. That is the
   * single most counterintuitive thing about how this system works and it is
   * worth a picture.
   */
  projectorPreviewWidth: number;
}

export interface ModelResponse {
  kind: 'model';
  id: number;
  ok: true;
  readings: Reading[];
  facts: RigFact[];
  framebuffer: string;
  /** Worst grid-line displacement, mm. Pulled out because the page leads with it. */
  gridWorstMm: number;
  /** The same number with the compositor believing the config as written. */
  gridBaselineMm: number | null;
  /** Fraction of the sphere lit by 0, 1, 2 … projectors. */
  multiplicityAreaFraction: number[];
  /** §4.3's unlit polar region, north and south, as area fractions. */
  unlitPolarNorth: number;
  unlitPolarSouth: number;
  /** Coverage boundary latitude per longitude — the scalloped edge, for the plot. */
  boundaryNorthDeg: number[];
  boundarySouthDeg: number[];
  /** Grid-line measurements, for the residual scatter. */
  scatter: { latDeg: number; lonDeg: number; displacementMm: number }[];
  /** CPU render of the parity camera, or `null` when none was asked for. */
  parityImage: { width: number; height: number; data: Float32Array } | null;
  parityMs: number;
  metricsMs: number;
  densityScale: number;
  /** One per projector, in rig order. Empty when none was asked for. */
  projectorFrames: FrameImage[];
}

export interface WorkerFailure {
  kind: 'model' | 'solve';
  id: number;
  ok: false;
  /** What went wrong, in a sentence the page can print. */
  error: string;
}

export interface SolveRequest {
  kind: 'solve';
  id: number;
  settings: Settings;
  /** How many camera positions the operator photographed from. */
  cameraCount: number;
  /** Camera raster. The bench's corpus runs at 320×240; the page offers more. */
  cameraResX: number;
  cameraResY: number;
  /**
   * Handheld rather than on a tripod.
   *
   * NOT a noise magnitude — the page has no business inventing one. This
   * switches the bench's own `DEFAULT_HANDHELD` motion model on, and the
   * localisation error that results is an OUTPUT. Experiment 1 measured it:
   * tripod runs land between 0.04 and 0.73 mm and the same camera handheld comes
   * in near 9 mm, which outweighs sensor noise, room light and camera resolution
   * put together.
   */
  handheld: boolean;
  /** The bench's `DEFAULT_SENSOR`. Off renders a noiseless camera — a canary. */
  sensorNoise: boolean;
  /** Room light during the capture. §5 `E_amb`, nominal 0.04, range 0.01–0.15. */
  ambient: number;
  /** Draw for the capture. Separate from the rig's own seed. */
  seed: number;
}

export type SolvePhase = 'capture' | 'decode' | 'initialize' | 'bundle' | 'score' | 'done';

/** A greyscale frame, as the page will draw it. */
export interface FrameImage {
  width: number;
  height: number;
  /** RGB float, row 0 at the top — `packages/sim`'s `RgbImage` layout. */
  data: Float32Array;
  /** What it is a picture of. */
  caption: string;
}

export interface SolveProgress {
  kind: 'solve-progress';
  id: number;
  phase: SolvePhase;
  /** 0 to 1, best effort. The bundle stage reports real iteration counts. */
  fraction: number;
  /** One line, written for someone watching rather than debugging. */
  message: string;
  /**
   * The photographs, sent as soon as the capture finishes rather than with the
   * result. A person watching a five-second solve should see what it is working
   * from while it works, not afterwards.
   */
  shots?: FrameImage[];
  /** One accepted optimiser step, for the convergence trace. */
  step?: { pass: number; iteration: number; cost: number };
}

export interface SolveResponse {
  kind: 'solve';
  id: number;
  ok: true;
  /** What the solver recovered. Feed it back as `compositorRig`. */
  recoveredRig: RigCalibration;
  /** Correspondences the decode produced, after rejection. */
  correspondences: number;
  /** Frames the capture needed — Gray planes plus phase shifts, per camera. */
  frames: number;
  grayBits: number;
  /** Reprojection residual RMS, pixels. */
  residualRmsPx: number;
  iterations: number;
  converged: boolean;
  /**
   * Worst lens position error after removing the unobservable global rotation,
   * millimetres. Ground truth — the page may show it, the solver never saw it.
   */
  posePositionMm: number;
  poseRotationDeg: number;
  /** Recovered minus true sphere centre height, millimetres. */
  centerHeightErrorMm: number;
  /**
   * The unobservable global rotation, in degrees.
   *
   * A sphere seen from outside cannot fix its own rotation about its centre —
   * every projector pose can turn together and produce identical photographs —
   * so this rotation is removed before anything is scored. Its size is reported
   * rather than hidden, because a large gauge with a small residual is a very
   * different result from a small gauge with a small one.
   */
  gaugeAngleDeg: number;
  captureMs: number;
  solveMs: number;
  /**
   * What the solver got wrong and by how much, per projector and axis, against
   * ground truth it never saw.
   *
   * `documented` is the config as written — what the compositor believed before
   * the solve. `recovered` is what came back. `truth` is what the lenses
   * actually have. A reader needs all three: recovered-versus-documented is what
   * MOVED, and recovered-versus-truth is whether it moved to the right place.
   */
  recovery: RecoveredAxis[];
}

export interface RecoveredAxis {
  projectorId: string;
  /** Plain-language axis name. */
  axis: string;
  unit: string;
  documented: number;
  recovered: number;
  truth: number;
  /** `recovered - truth`, in `unit`. */
  errorFromTruth: number;
  /** How far the solve moved it. Large with a small error is a good result. */
  moved: number;
}

export type ModelMessage = ModelResponse | WorkerFailure;
export type SolveMessage = SolveResponse | SolveProgress | WorkerFailure;
