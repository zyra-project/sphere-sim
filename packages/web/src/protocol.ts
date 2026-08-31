// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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

import type { RigCalibration, SurfaceMesh } from '../../calibration/src/index.ts';
import type { Settings } from './settings.ts';
import type { Reading, RigFact } from './readout.ts';
import type { ProjectorPlacement } from '../../sim/src/placement.ts';

/** A downscale of the live camera, for the CPU half of the parity check. */
export interface ParityCameraRequest {
  width: number;
  height: number;
  fovHDeg: number;
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  /**
   * Samples per pixel, on the regular grid the display shader also uses.
   *
   * Carried in the request rather than read from the settings so the two halves
   * of the comparison cannot be configured apart: whatever the page drew with,
   * the CPU integrates the same point set. See `sampleLattice` in
   * `sim/src/misregistration.ts`.
   */
  samplesPerPixel: number;
  /**
   * {@link ViewerCamera.imageShift} — the viewer camera's lens shift, in halves
   * of the frame height.
   *
   * Sent for the same reason `samplesPerPixel` is: the display applies it and
   * the model has to apply the identical value or the check reports a framing
   * difference as a disagreement about optics. It is not implied by `position`
   * and `target`, because a lens shift deliberately is NOT an aim. Leaving it
   * out was caught by the readout itself — 100% of lit pixels over tolerance,
   * the moment a phone layout first pushed it off zero.
   */
  imageShift: number;
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
   * Which model the parity render should trace, or `''` for the analytic sphere.
   *
   * The NAME and not the mesh. A model is megabytes and this request goes across
   * the boundary on every settled pass, so the geometry travels once, in a
   * {@link SurfaceRequest}, and the worker keeps it; this names the one it
   * should already be holding. A name it does not hold falls back to the sphere
   * and SAYS SO in {@link ModelResponse.parityMeshId} rather than guessing --
   * see there for why silence would be the dangerous answer.
   */
  meshId: string;
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
  /**
   * Which model {@link ModelResponse.parityImage} was actually traced on, or
   * `''` for the analytic sphere.
   *
   * Reported rather than assumed, because the parity check is only meaningful
   * when both renderers drew the same shape. The page hands its display shader a
   * model as soon as one is dropped; this worker can only trace one it has been
   * sent, and a {@link SurfaceRequest} carrying it may not have arrived yet. The
   * two would then disagree completely, at every lit pixel, and the number on
   * screen would read as a catastrophic renderer bug instead of as two pictures
   * of different objects.
   *
   * So the page compares this against what it drew and withholds the verdict
   * when they differ. The check going quiet for a frame is a cost; a red verdict
   * that means nothing is a fault.
   */
  parityMeshId: string;
  /** Worst grid-line displacement, mm. Pulled out because the page leads with it. */
  gridWorstMm: number;
  /** The same number with the compositor believing the config as written. */
  gridBaselineMm: number | null;
  /**
   * How far the compositor's idea of the rig has fallen behind the rig: worst
   * lens displacement in millimetres, worst aim difference in degrees.
   *
   * GROUND TRUTH, and the page says so where it prints them. Both rise the
   * moment a projector is bumped and drop to the recovery error after a solve —
   * which is why they are computed here on every pass rather than only being
   * available in a solve reply.
   */
  driftPositionMm: number;
  driftAimDeg: number;
  /** One per seam, in ring order. Empty when fewer than two projectors are lit. */
  seams: SeamPatch[];
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
  /**
   * One per PANEL SLOT, `null` where that projector is switched off or where no
   * frames were asked for.
   *
   * Slot, not rig position. A projector switched off is dropped from the rig
   * entirely — PARAMETERS.md §2's "quadrants go dark" — so rig position stops
   * meaning P-number the moment anybody uses the switch, and every array after it
   * shifts by one. Which looks entirely plausible.
   */
  projectorFrames: (FrameImage | null)[];
  /** One per panel slot, `null` where switched off. See {@link WarpMesh}. */
  meshes: (WarpMesh | null)[];
  /** Which panel slots are actually in the rig. */
  live: boolean[];
  /**
   * Each projector's own configuration, twice: what the software believes, and
   * where the lens actually is.
   *
   * Two columns of the same six numbers is the whole misregistration story
   * without a diagram — and it is why they are computed by the same function
   * from two different rigs rather than by two functions from one.
   */
  projectorConfig: ({ believed: RigFact[]; actual: RigFact[] } | null)[];
}

/**
 * The warp mesh a calibration would have to write, for one projector.
 *
 * The config file carries heights and distances in inches and nothing finer;
 * what actually removes a doubled grid line is a per-vertex displacement applied
 * to the projector's raster. This is that displacement, and it is *derived*
 * rather than drawn: for each vertex, follow the pixel out to the sphere through
 * the calibration the compositor is using, then ask the real rig which pixel
 * would have to be lit to put light on that same point. The difference is the
 * correction.
 *
 * Which makes it a direct read-out of how wrong the compositor currently is.
 * Before a solve the compositor holds the config as written and the mesh is
 * visibly bent; feed a recovered calibration back in and the same computation
 * collapses towards zero. Nothing about the drawing changes — only the two rigs
 * it is asked about.
 */
export interface WarpMesh {
  projectorId: string;
  cols: number;
  rows: number;
  resX: number;
  resY: number;
  /** Vertex positions in the raster, `cols * rows` of them, row-major. */
  u: Float32Array;
  v: Float32Array;
  /**
   * Where each vertex must move to, in pixels. `NaN` where the vertex does not
   * reach the sphere at all — the corners of a raster overshoot the limb, and a
   * zero there would be a claim rather than a gap.
   */
  du: Float32Array;
  dv: Float32Array;
  /** Largest finite displacement, pixels. */
  worstPx: number;
  /** How many vertices reached the sphere. */
  onSphere: number;
}

/**
 * One projector's copy of one grid line, near a seam.
 *
 * `lonDeg`/`latDeg` is where the line BELONGS — the graticule as the content
 * defines it. `dLonDeg`/`dLatDeg` is how far from there this projector actually
 * puts it: the compositor works out which pixel covers the point, and the real
 * lens throws that pixel somewhere else. Two projectors painting the same line
 * from two different wrong places is the doubled line a visitor notices, and it
 * is the entire subject of {@link SeamPatch}.
 *
 * The offset is kept separate from the position rather than pre-added because
 * the page has to exaggerate it to draw it — a tenth of a degree is a fifth of a
 * pixel in a 200-pixel-wide diagram — and an exaggerated picture whose factor is
 * not stated is a picture that is lying.
 */
export interface SeamLine {
  /** 0 for the seam's first projector, 1 for its second. */
  which: 0 | 1;
  lonDeg: Float32Array;
  latDeg: Float32Array;
  dLonDeg: Float32Array;
  dLatDeg: Float32Array;
}

/** A patch of sphere either side of one seam, with both projectors' copies of it. */
export interface SeamPatch {
  /** Panel slots of the pair, in ring order. */
  a: number;
  b: number;
  /** Where the two hand over, degrees of world longitude. */
  seamLonDeg: number;
  /** The window drawn: `seamLonDeg ± halfSpanDeg`, and `± latMaxDeg`. */
  halfSpanDeg: number;
  latMaxDeg: number;
  lines: SeamLine[];
  /** Worst single-axis offset in the patch, degrees. Sets the exaggeration. */
  worstDeg: number;
  /**
   * Worst distance between the two projectors' copies of the SAME point, mm on
   * the sphere surface. This is the width of the doubled line, and it is
   * measured where both projectors reach — not the whole-sphere worst case the
   * headline reports.
   */
  worstMm: number;
}

/**
 * Render one projector's frame for a NAMED compositor calibration.
 *
 * Separate from {@link ModelRequest} because it answers a different question and
 * must not disturb the answer to the first one. The lightbox needs the same
 * frame at four times the width, and the frame the rig was sending BEFORE the
 * last recalibration — which is a different calibration entirely. Asking the
 * model worker for either through a normal request would replace every metric on
 * the page with one computed for a rig nobody is looking at, and would recompute
 * the whole metric set to fetch a picture.
 */
export interface FramesRequest {
  kind: 'frames';
  id: number;
  settings: Settings;
  /** The compositor calibration to render FROM. `null` is the config as written. */
  compositorRig: RigCalibration | null;
  /** Panel slot for a projector's frame. */
  slot: number;
  /** Target width in pixels. */
  width: number;
  /** Identifies the supplied image the worker already holds. `''` when there is none. */
  customImageId: string;
  /** Echoed back, so the page knows which half of a comparison arrived. */
  tag: string;
}

export interface FramesResponse {
  kind: 'frames';
  id: number;
  ok: true;
  slot: number;
  tag: string;
  frame: FrameImage | null;
}

export type FramesMessage = FramesResponse | WorkerFailure;

/**
 * Light a dropped model instead of the sphere, and send back a picture of it.
 *
 * `docs/ARBITRARY-SHAPES.md` Phase 1. A THIRD request kind rather than a field
 * on {@link ModelRequest}, and the separation is the point: the metrics path is
 * the sphere's, it feeds every number the page prints, and its request is sent
 * on every settling slider. Threading a mesh through it would put a hierarchy
 * traversal in the interactive loop and make a §7 metric answerable about a
 * shape §7 was never written for. This path renders a picture and reports what
 * the model is; it computes no gate and moves no metric.
 *
 * The mesh crosses as typed arrays, which is what this protocol is FOR — its own
 * header says "plain JSON plus transferable typed arrays". That is exactly why
 * the mesh is not on `RigCalibration`, whose contract is JSON: see `prepareRig`.
 */
export interface SurfaceRequest {
  kind: 'surface';
  id: number;
  settings: Settings;
  /** The model to light. `null` puts the sphere back. */
  mesh: SurfaceMesh | null;
  /**
   * Names WHICH model this is, so the worker can tell a re-render of the same
   * one from a different file.
   *
   * The mesh crosses by structured clone, so the worker receives a fresh copy on
   * every request and object identity says nothing. Without a name it has to
   * rebuild the hierarchy, the adjacency graph and the footprint fields from
   * scratch each time a slider settles, for a model that has not changed. A page
   * that omits it gets that behaviour — correct, and slower.
   *
   * A token the page mints when it accepts a file, not a hash: a hash of a
   * megabyte of positions on every request is most of the saving back, and the
   * page already knows the answer for free.
   */
  meshId?: string;
  /** Width of the room view to render. The height follows the aspect. */
  width: number;
  height: number;
  /** Where the viewer stands, in the same terms the parity camera uses. */
  camera: { azimuthDeg: number; elevationDeg: number; rangeM: number; fovHDeg: number };
  /**
   * A rig placed by hand, replacing the one `settings` describes.
   *
   * Only on this request kind, and that is the same argument the request kind
   * itself was made for. The metrics path answers PARAMETERS.md §7 about a
   * 130-inch sphere lit by an SOS rig of two to four projectors in quadrant
   * viewports; a rig of six on a wall is not that machine, and letting one reach
   * §7 would put a gate score on screen for an installation the gate was never
   * written about. Here the reported numbers — lit fraction, mean overlap,
   * self-shadowed fraction — are counts over the surface's own area and stay
   * true whatever is pointing at it.
   *
   * Plain data, because it crosses to the worker by structured clone.
   */
  placements?: ProjectorPlacement[];
  /**
   * Identifies the content the page is showing, so the preview lights the model
   * with it rather than with the grey fallback.
   *
   * An ID rather than the pixels: the worker already caches the last image the
   * metrics path sent, keyed exactly this way, and a megabyte of float across
   * the boundary on every settled slider would cost more than the render. When
   * the worker has not been sent that image, it falls back — the same
   * deliberately SILENT-free behaviour `computeModel` documents.
   */
  customImageId?: string;
}

/** What a model turned out to be, once read and built. */
export interface SurfaceFacts {
  name: string;
  triangles: number;
  vertices: number;
  hasUvs: boolean;
  hasNormals: boolean;
  /**
   * How many projectors lit it, from the rig the worker actually used.
   *
   * Reported rather than inferred from the panel, and that is the point: it is
   * the one number in this reply that proves WHICH rig produced the others. A
   * page that showed five rows while the worker traced four would otherwise look
   * exactly like one that worked.
   */
  projectorCount: number;
  /** Bounding radius in metres, and the surface area the tracer measured. */
  boundsRadiusM: number;
  areaM2: number;
  /**
   * Fraction of the model's AREA that at least one projector reaches, and the
   * mean number that reach a point.
   *
   * Equal-area samples, so an ordinary mean is already an area-weighted mean —
   * see `sim/src/metrics/sampling.ts` for why that property is worth having.
   */
  litFraction: number;
  meanOverlap: number;
  /**
   * Fraction of the area that faces a projector and lands on its raster, and is
   * dark anyway because the model is in its own way.
   *
   * The number that does not exist on a sphere, and the reason a projection
   * surface needs more than a coverage angle.
   */
  shadowedFraction: number;
}

export interface SurfaceResponse {
  kind: 'surface';
  id: number;
  ok: true;
  frame: FrameImage | null;
  facts: SurfaceFacts | null;
}

export type SurfaceMessage = SurfaceResponse | WorkerFailure;

export interface WorkerFailure {
  /**
   * The kind of the REQUEST that failed, not of the worker that failed it.
   *
   * `worker/model.ts` says why: this shell answers several request kinds on one
   * port, and labelling a failed frame render `'model'` sent it down the metrics
   * path on the page. Every kind that can be requested has to appear here, or a
   * failure on that path narrows to `never` and the page cannot print it.
   */
  kind: 'model' | 'solve' | 'frames' | 'surface';
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
  /**
   * The equirectangular image playing on the sphere, in linear light, when there
   * is one — and `null` when the page believes this worker already holds it.
   *
   * The solve does not READ it: a structured-light capture photographs Gray-code
   * patterns, not the content, so nothing the solver recovers can depend on what
   * is playing. What depends on it is the three "where it shot from" previews,
   * which are renders of the room from each camera pose — and with no image they
   * fell back to a grey graticule while the sphere on screen was showing Blue
   * Marble. Three pictures of a different installation, captioned as this one.
   */
  customImage: { width: number; height: number; data: Float32Array } | null;
  /** Identifies it. `''` when there is none. Cached in the worker by id. */
  customImageId: string;
  /**
   * Room light during the capture. §5 `E_amb`, nominal 0.04.
   *
   * The same quantity as the panel's "Room light" slider and taken from it. The
   * page used to hold a second, private 0.04 and send that instead, so raising
   * the slider washed the sphere out on screen while the capture went on
   * photographing a darker room.
   */
  ambient: number;
  /** Draw for the capture. Separate from the rig's own seed. */
  seed: number;
}

export type SolvePhase = 'capture' | 'decode' | 'initialize' | 'bundle' | 'score' | 'done';

/** A frame, as the page will draw it. */
export interface FrameImage {
  width: number;
  height: number;
  /** RGB float, row 0 at the top — `packages/sim`'s `RgbImage` layout. */
  data: Float32Array;
  /** What it is a picture of. */
  caption: string;
  /**
   * Which space the numbers are in, because the two kinds of frame on this page
   * are genuinely in different ones and the difference was invisible.
   *
   * `'linear'` — radiance, as a camera sensor integrated it. The capture
   * thumbnails and the parity patch.
   * `'display'` — a video signal, already through conventions.ts §P's encode.
   * A projector's own frame is exactly this: it is the picture going down the
   * cable, and `blendedSignal` encoded it on the way out.
   *
   * Getting it wrong is not subtle in its cause and is very subtle in its
   * effect. The projector frames were being encoded a second time on the way to
   * the canvas — `^(1/2.2)` twice, so `^(1/4.84)` — which compresses a blend
   * ramp running 1.0 to 0.5 to nothing into 29 of 255 display levels. The fade
   * was there in the model the whole time and could not be seen.
   */
  space: 'linear' | 'display';
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
  /**
   * Where the capture cameras stood, sent as soon as the capture finishes rather
   * than with the result: a person watching a five-second solve should see what
   * it is working from while it works.
   *
   * Poses rather than pictures. The page renders them itself, through the
   * display shader, because that is the renderer that knows the room has
   * projectors and a handrail in it — `packages/sim` draws neither, deliberately,
   * since neither is in the model. Sending poses is also three CPU room traces
   * cheaper per solve, and lets the page re-render one at any size.
   */
  shotCameras?: { id: string; position: { x: number; y: number; z: number }; fovHDeg: number }[];
  /**
   * One accepted optimiser step, for the convergence trace.
   *
   * `rmsPx` is the cost expressed as a reprojection RMS in projector pixels —
   * the same unit the final residual is reported in, so the number a reader
   * watches fall is the number they are handed when it stops.
   */
  step?: { pass: number; iteration: number; cost: number; rmsPx: number; step: number };
  /**
   * The answer so far, so the sphere can be seen converging rather than
   * snapping into place at the end.
   *
   * NOT gauge-aligned — the unobservable global rotation is removed once, after
   * the loop. An intermediate is a valid solution in whatever frame the
   * initialisation left it in: right for watching, wrong for measuring. The page
   * draws with it and computes nothing from it, and the readout keeps showing
   * the pre-calibration numbers until the real result lands.
   */
  partialRig?: RigCalibration;
}

export interface SolveResponse {
  kind: 'solve';
  id: number;
  ok: true;
  /** What the solver recovered. Feed it back as `compositorRig`. */
  recoveredRig: RigCalibration;
  /** Correspondences the decode produced, after rejection. */
  correspondences: number;
  /**
   * Cameras whose photograph held no framed sphere, so segmentation refused.
   *
   * Reported because refusing is the RIGHT behaviour and still costs the solve
   * that camera's entire contribution -- experiment 5 measured one in ninety
   * runs, and nothing but a counter noticed. A silent refusal and a working
   * camera look identical from outside. Zero when segmentation is off.
   */
  silhouetteRefusals: number;
  /** Cameras the detector examined, so the refusals have a denominator. */
  silhouetteCameras: number;
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
