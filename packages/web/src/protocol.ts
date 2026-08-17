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

export interface SolveProgress {
  kind: 'solve-progress';
  id: number;
  phase: SolvePhase;
  /** 0 to 1, best effort. The bundle stage reports real iteration counts. */
  fraction: number;
  /** One line, written for someone watching rather than debugging. */
  message: string;
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
}

export type ModelMessage = ModelResponse | WorkerFailure;
export type SolveMessage = SolveResponse | SolveProgress | WorkerFailure;
