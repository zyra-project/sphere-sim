// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The page.
 *
 * ## Three threads, and what each is allowed to say
 *
 *   - **Main** — draws. It owns the GL context and the DOM and it never computes
 *     a metric. Every number it displays arrived from a worker.
 *   - **Model worker** — `packages/sim`. Says what is true about the rig, and
 *     renders each projector's own frame.
 *   - **Solve worker** — `packages/sim` photographing, `packages/solver`
 *     calibrating. Says what an operator could recover from photographs.
 *
 * The separation is not for speed alone. A page that could compute a metric on
 * the main thread would eventually compute one FROM the render — and then a
 * shader bug would move the picture and the number together, the page would be
 * internally consistent and externally wrong, and there would be no way to tell
 * from inside. Keeping the model in a worker makes that structurally impossible
 * rather than merely discouraged.
 *
 * ## Coarse then fine
 *
 * While a slider is moving the page asks for a coarse metric pass and no parity
 * render; when it settles it asks for the full density, the parity check and the
 * projector frames. The density is printed with the numbers, because a value
 * that depends on a sample count the reader cannot see is a value the reader
 * cannot check.
 *
 * ## Everything drawn here is a Float32 image from the model
 *
 * The projector frames, the capture thumbnails and the lightbox are all painted
 * by {@link paintFrame} from linear radiance the worker produced. There is no
 * second rendering path and no image asset: if a thumbnail is wrong, the model
 * is wrong, and that is the property worth having.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import type { EquirectImage } from '../../sim/src/equirect.ts';
import { createImage } from '../../sim/src/equirect.ts';
import { meshSurface } from '../../sim/src/mesh/surface.ts';
import type { MeshSurface } from '../../sim/src/mesh/surface.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import type { PreparedRig } from '../../sim/src/optics.ts';
import { wrapDeg180 } from '../../sim/src/vec.ts';
import type { NudgeSpec, Settings, SettingKey } from '../src/settings.ts';
import {
  BOULDER_PRESET,
  CONTENTS,
  CONTENT_CUSTOM,
  CONTENT_MARBLE,
  CONTROLS,
  GROUPS,
  cameraDistanceM,
  IN_TO_M,
  NUDGE_CONTROLS,
  PERFECT_PRESET,
  PROJECTOR_TINTS,
  RESOLUTIONS,
  SPEC_PRESET,
  VIEWPOINTS,
  clearNudges,
  formatSetting,
  viewSampleSide,
  withNudge,
  withSetting,
} from '../src/settings.ts';
import {
  buildViewer,
  buildAsBuilt,
  buildWorld,
  CONTENT_DECODE_GAMMA,
  framingRangeM,
  nudgesAreClear,
  worstAimOffender,
  worstPlacementOffender,
} from '../src/rigs.ts';
import type { WebWorld } from '../src/rigs.ts';
import type { Reading, RigFact } from '../src/readout.ts';
import { buildDisplayUniforms, packMesh, pickMarkerNear, slotOfRigIndex } from '../src/uniforms.ts';
import type { DisplayMesh, DisplayUniforms, OverlayMode } from '../src/uniforms.ts';
import type { ParityVerdict } from '../src/parity.ts';
import {
  ALLOWANCE_LABEL,
  percentLabel,
  PARITY_HEIGHT,
  PARITY_WIDTH,
  ambientFloorOf,
  judgeParity,
} from '../src/parity.ts';
import type {
  FrameImage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  FramesMessage,
  FramesRequest,
  RecoveredAxis,
  SeamPatch,
  SolveMessage,
  SolveRequest,
  SolveResponse,
  SurfaceFacts,
  SurfaceMessage,
  SurfaceRequest,
  WarpMesh,
} from '../src/protocol.ts';
import type { DisplayGl } from './gl.ts';
import {
  createDisplayGl,
  drawToCanvas,
  freezeContent,
  releaseVideoTarget,
  renderAndRead,
  uploadEquirect,
  uploadVideoFrame,
  withFrozenContent,
} from './gl.ts';
import { equirectAspectError, mediaKind } from '../src/media.ts';
import { containerOf, readGlb } from '../../meshio/src/glb.ts';
import type { ProjectorPlacement } from '../../sim/src/placement.ts';
import { isRing } from '../../sim/src/placement.ts';
import { aimAtPoint } from '../../sim/src/geometry.ts';
import type { MeshLoadReport, SurfaceMesh } from '../../calibration/src/index.ts';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type SectionId = 'projectors' | 'install' | 'room';

interface PageState {
  settings: Settings;
  /** What the compositor believes. `null` = the config as written. */
  compositorRig: RigCalibration | null;
  section: SectionId;
  /** Which projector the Projectors tab is editing, and the inspect card shows. */
  selected: number;
  /**
   * Whether the projector card is up.
   *
   * Separate from `selected`, and CLOSED until somebody asks for it. The card
   * describes one projector, and on first sight there is no reason to think the
   * page is about P1 rather than about the sphere — showing it unprompted
   * answers a question nobody has asked yet and, on a phone, does it over the
   * top of the thing they came to look at. Clicking a projector opens it;
   * clicking past them, or the card's own ✕, closes it again.
   */
  inspectOpen: boolean;
  overlay: OverlayMode;
  /** `-1` shows every projector; otherwise isolate one. */
  highlight: number;
  /** Draw the room's furniture. The projector bodies are also what a click hits. */
  markersOn: boolean;
  railOn: boolean;
  aimGuides: boolean;
  explain: boolean;
  /**
   * Whether the compositor's own constants are showing on the Room tab.
   *
   * Closed by default and remembered, like `explain`. The blend width, the ramp
   * exponent and the two mask angles are class ASSUME — nobody has measured
   * them — and they are set once, if ever. They were sitting above the controls
   * a reader touches on every look, which is the wrong way round: a panel is
   * ordered by how often a control is used, not by how important the constant
   * behind it is.
   */
  seamsOpen: boolean;
  panelOpen: boolean;
  readoutOpen: boolean;
  /**
   * Solve inputs. Deliberately few, and deliberately not a noise magnitude —
   * see `protocol.ts` and `captureControls` on why the millimetres are an
   * output. Room light is NOT here: there is one of those, and it is the slider
   * in `Settings`.
   */
  cameraCount: number;
  handheld: boolean;
  /** Index into {@link CAPTURE_RASTERS}. */
  cameraRes: number;
}

const state: PageState = {
  // Opens on a rig that is ALIGNED, and one click breaks it.
  //
  // Still Boulder's three constants — `PERFECT_PRESET` is Boulder with the mount
  // shake at zero, so A-36's conflict is live and the readout still flags it. What
  // is off is the §2 tolerance draw, and that is a first-impression decision: a
  // page that opens at 127 mm in red has already happened to you, and you have no
  // way to know whether that is the simulator or the room. Press "Another install"
  // or "Bump this one" and the §2 tolerances arrive, with a before to compare to.
  settings: { ...PERFECT_PRESET, nudge: PERFECT_PRESET.nudge.map((n) => ({ ...n })) },
  compositorRig: null,
  section: 'projectors',
  selected: 0,
  inspectOpen: false,
  overlay: 'none',
  highlight: -1,
  markersOn: true,
  railOn: true,
  aimGuides: false,
  // Off by default: with every note expanded the control panel is taller than
  // most screens, and a person who wants the reasoning is one click from it.
  explain: false,
  seamsOpen: false,
  panelOpen: true,
  readoutOpen: true,
  cameraCount: 3,
  handheld: false,
  cameraRes: 0,
};

let model: ModelResponse | null = null;
let parity: ParityVerdict | null = null;
let solveResult: SolveResponse | null = null;
let solveRunning = false;
let solveStage = '';
let solveTrace: { pass: number; cost: number }[] = [];
let solveStep: { step: number; rmsPx: number } | null = null;
let solveShots: FrameImage[] = [];
/** Where each of those was taken from, so the lightbox can re-render it bigger. */
let solveCameras: { id: string; position: { x: number; y: number; z: number }; fovHDeg: number }[] = [];
let solveStartedAt = 0;
let modelPending = false;
let lastError = '';
let resultView: 'axes' | 'config' = 'axes';

let gl: DisplayGl | null = null;
let contentKey = '';
/**
 * A supplied equirectangular image, in linear light. Never leaves the page.
 *
 * When a VIDEO is playing this holds the last frame the model was given — see
 * `snapshotVideo`. The display is not drawn from it; the GPU has its own decoded
 * copy and is a tenth of a second ahead.
 */
let customImage: EquirectImage | null = null;

/** Bumped on every accepted image load, so two different pictures cannot share an id. */
let customImageSeq = 0;
let customName = '';

/**
 * The dropped video, if there is one, and the object URL it is playing from.
 *
 * The file never leaves the page: an object URL is a handle to the reader's own
 * blob, exactly as `readEquirect` reads a dropped image in the tab. Nothing is
 * fetched and nothing is uploaded.
 */
let customVideo: HTMLVideoElement | null = null;
let customVideoUrl = '';
/** The raster the video decodes into. See `videoRasterFor`. */
let videoRaster = { width: 0, height: 0 };
/**
 * `currentTime` at the last upload, so a 30 fps video costs 30 draws a second
 * and not 60. There is a `requestVideoFrameCallback` that would answer this
 * exactly; it is not in every browser this page runs in, and the clock is.
 */
let lastVideoTime = -1;
/** Counts the frames handed to the model, so each one is a new cache key. */
let videoFrameSeq = 0;
/**
 * Why the last snapshot failed, if it did.
 *
 * Its own field rather than `lastError`, which the next model reply clears — so
 * a read-back that failed every time still reported nothing, and the CPU model
 * sat on a black frame while the sphere played.
 */
let snapshotError = '';

/**
 * How often the model is handed a fresh frame while a video plays, in ms.
 *
 * A video is the only content that changes with nobody touching the page, so the
 * settle timer — which follows the CONTROLS — never fires and the model would
 * keep whatever frame happened to be up when the file was dropped. That is the
 * discrepancy this repository has already been caught by once: a sphere showing
 * one thing and the picture captioned "what the projector is sending" showing
 * another.
 *
 * Two seconds rather than every frame because of what is actually downstream. No
 * metric reads the content — `metrics/grid.ts` is analytic and the photometric
 * set generates its own flat field — so this feeds exactly two things: the parity
 * check, and the projector frame previews. Both want a frame from the last few
 * seconds; neither wants thirty a second, which would be a full-density metrics
 * pass and a 25 MB read-back per frame for numbers that cannot move.
 */
const VIDEO_MODEL_INTERVAL_MS = 2000;

/** Is a dropped video the content the sphere is currently showing? */
function videoActive(): boolean {
  return customVideo !== null && Math.round(state.settings.content) === CONTENT_CUSTOM;
}

/** Has the video moved on since the texture was last written? */
function videoAdvanced(): boolean {
  const v = customVideo;
  if (!v || !videoActive()) return false;
  // HAVE_CURRENT_DATA. Below this there is no frame to upload and `texImage2D`
  // would throw or upload a black one.
  if (v.readyState < 2) return false;
  return v.currentTime !== lastVideoTime;
}
/**
 * The shipped Blue Marble, once. Two slots rather than one so that picking Blue
 * marble does not throw away an image somebody dropped, and dropping one does not
 * mean re-fetching a megabyte to get the marble back.
 */
let marbleImage: EquirectImage | null = null;
let marbleError = '';

/** Whichever supplied image the current base field selects, and its identity. */
function suppliedImage(): EquirectImage | null {
  const c = Math.round(state.settings.content);
  if (c === CONTENT_MARBLE) return marbleImage;
  if (c === CONTENT_CUSTOM) return customImage;
  return null;
}

function suppliedName(): string {
  const c = Math.round(state.settings.content);
  if (c === CONTENT_MARBLE) return marbleImage ? 'blue-marble-4096' : '';
  if (c === CONTENT_CUSTOM) return customImage ? customName : '';
  return '';
}

/**
 * Fetch the shipped map and put it through exactly the path a dropped file takes
 * — same 2:1 check, same sRGB decode, same downscale. A second loader would be a
 * second place for the colour conversion to be wrong.
 */
async function loadMarble(): Promise<void> {
  try {
    const res = await fetch('./assets/blue-marble-4096.jpg');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    marbleImage = await readEquirect(new File([blob], 'blue-marble-4096.jpg', { type: blob.type }));
  } catch (err) {
    // Not fatal: the flat fields and the drop target still work, and the chip
    // says why rather than silently showing grey.
    marbleError = err instanceof Error ? err.message : String(err);
    marbleImage = null;
  }
  contentKey = '';
  sentImageId = '';
  solveSentImageId = '';
  touched(false);
  requestModel(true);
}
let customError = '';

/**
 * A dropped model, and what the tracer made of it.
 *
 * `docs/ARBITRARY-SHAPES.md` Phase 1. Deliberately a SIDE panel rather than the
 * live view: the display shader intersects a sphere analytically, and teaching
 * it to traverse a hierarchy is Phase 2. Putting a model into the GL view now
 * would mean the picture on screen was still a sphere while the page claimed a
 * building — so the mesh is rendered on the CPU, by `packages/sim`, and shown
 * beside the live view with that difference stated rather than hidden.
 */
let droppedMesh: SurfaceMesh | null = null;
/**
 * Names the dropped model for the worker, which receives a structured-clone copy
 * and so cannot recognise it by identity. Bumped on every accepted file, never
 * reused. See `SurfaceRequest.meshId`.
 */
let droppedMeshId = 0;
let meshReport: MeshLoadReport | null = null;
let meshFacts: SurfaceFacts | null = null;
let meshFrame: FrameImage | null = null;
let meshError = '';
let meshBusy = false;
/** A surface pass asked for while the worker was busy. See `requestSurface`. */
let queuedSurface = false;
/**
 * A rig placed by hand, or `null` for the one the install settings describe.
 *
 * Module state rather than a `Setting`, and not because it is easier: a
 * `Setting` is one number with a slider, a min and a max, and this is a list of
 * six-vectors that grows and shrinks. Forcing it into that shape would give it a
 * slider it cannot have and a preset comparison it cannot answer. `droppedMesh`
 * lives here for the same reason.
 *
 * It reaches only the SURFACE request. See `SurfaceRequest.placements`: a rig of
 * six on a wall must not arrive at the §7 gates, which are about a different
 * machine.
 */
let customPlacements: ProjectorPlacement[] | null = null;
let meshSeq = 0;

/** Which image the model worker has been sent, so it is sent exactly once. */
let sentImageId = '';
/** The same, for the solve worker: separate process, separate cache. */
let solveSentImageId = '';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const controlsEl = document.getElementById('controls') as HTMLDivElement;
const actionsEl = document.getElementById('actions') as HTMLDivElement;
const topBtnsEl = document.getElementById('topbtns') as HTMLDivElement;
const rightEl = document.getElementById('right') as HTMLDivElement;
const leftEl = document.getElementById('left') as HTMLDivElement;
const leftBtnsEl = document.getElementById('leftbtns') as HTMLDivElement;
const helpEl = document.getElementById('help') as HTMLDivElement;
const readoutEl = document.getElementById('readout') as HTMLDivElement;
const inspectEl = document.getElementById('inspect') as HTMLDivElement;
const bootEl = document.getElementById('boot') as HTMLDivElement;
const fatalEl = document.getElementById('fatal') as HTMLDivElement;
const lightboxEl = document.getElementById('lightbox') as HTMLDivElement;
const lightboxCanvas = document.getElementById('lightbox-canvas') as HTMLCanvasElement;

function fatal(message: string): void {
  fatalEl.textContent = message;
  fatalEl.classList.add('on');
  bootEl.classList.add('off');
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

/**
 * Paint a linear-radiance image from the model into a canvas.
 *
 * The display encode happens HERE and nowhere else, which is conventions.ts §P's
 * rule applied to the DOM: the worker sends linear light because that is what
 * the model produces, and a second encode somewhere upstream would silently
 * brighten every thumbnail on the page relative to the sphere beside them.
 */
function paintFrame(target: HTMLCanvasElement, frame: FrameImage, exposure = 1): void {
  target.width = frame.width;
  target.height = frame.height;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const out = ctx.createImageData(frame.width, frame.height);
  const n = frame.width * frame.height;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, frame.data[3 * i + c] * exposure);
      // A frame that is already a video signal is blitted, not encoded again.
      // See `FrameImage.space` — doing this twice is a `^(1/4.84)` curve, and it
      // flattened the blend ramp on every projector frame into invisibility.
      out.data[4 * i + c] = Math.min(
        255,
        Math.round(255 * (frame.space === 'display' ? v : Math.pow(v, 1 / 2.2))),
      );
    }
    out.data[4 * i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * Two frames in one picture: the old warp in red, the new one in cyan.
 *
 * The card's own caption promises that recalibrating rewrites the frame, and
 * then showed one frame — so pressing Recalibrate appeared to do nothing to it.
 * The shift is a few per cent of the image radius on a repeating grid, which is
 * invisible unless the old frame is sitting underneath the new one. Where the
 * two agree the channels sum back to grey, so what a reader sees is colour
 * exactly where the warp moved.
 *
 * Both are encoded the same way `paintFrame` encodes one, for the same reason.
 */
function paintFramePair(target: HTMLCanvasElement, before: FrameImage, after: FrameImage): void {
  const w = Math.min(before.width, after.width);
  const h = Math.min(before.height, after.height);
  target.width = w;
  target.height = h;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const out = ctx.createImageData(w, h);
  const grey = (f: FrameImage, x: number, y: number): number => {
    // Nearest sample: the two frames are rendered at the same target width, but
    // a stale `before` from a coarser pass must not shear the comparison.
    const sx = Math.min(f.width - 1, Math.round((x * f.width) / w));
    const sy = Math.min(f.height - 1, Math.round((y * f.height) / h));
    const i = 3 * (sy * f.width + sx);
    const v = (f.data[i] + f.data[i + 1] + f.data[i + 2]) / 3;
    return Math.min(255, Math.round(255 * (f.space === 'display' ? v : Math.pow(Math.max(0, v), 1 / 2.2))));
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = 4 * (y * w + x);
      const a = grey(after, x, y);
      out.data[o] = grey(before, x, y);
      out.data[o + 1] = a;
      out.data[o + 2] = a;
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * How wide the worker renders each projector frame.
 *
 * 296 is what the card shows. The lightbox is up to 84vh tall, so blowing the
 * thumbnail up there is a four-fold smooth of a grid the card had just drawn
 * sharp — the opposite of what a zoom-in cursor promises. Opening the lightbox
 * asks for the frame again at 768 and puts this back afterwards, because four
 * frames at 768 on every settle would cost more than the picture is worth.
 */
const THUMB_PX = 296;

/**
 * How wide to re-render for the lightbox: enough for the screen it lands on,
 * capped so a 5K monitor does not ask the worker for a 4000-pixel CPU trace of
 * four frames. A fixed 768 was still an upscale on any modern display.
 */
function zoomWidth(): number {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const wide = Math.max(window.innerWidth * 0.92, window.innerHeight * 0.72 * (16 / 9));
  // Capped at 1200: this is a CPU ray trace per pixel in a worker, and past
  // about a megapixel the wait to see a sharper grid line costs more than the
  // sharper grid line is worth. The card's thumbnail is on screen throughout.
  return Math.round(Math.max(768, Math.min(1200, wide * dpr)));
}

const previewWidth = THUMB_PX;

/**
 * What the lightbox is showing.
 *
 * `after` is the frame as it is now; `before` is the one the same projector was
 * sending under the calibration the last solve replaced. Both are re-rendered at
 * the size of the screen rather than being the card's 296-pixel thumbnail blown
 * up — a comparison of two smoothed upscales would show the smoothing rather
 * than the difference.
 */
type LightboxMode = 'overlay' | 'blink' | 'pair';
let lightbox: {
  slot: number;
  caption: string;
  /**
   * What the pending "after" render is tagged with. A capture preview and a
   * projector frame both open a lightbox and both ask for a bigger render, so a
   * reply has to say which picture it is — matching on the panel slot alone put
   * a camera's view of the room into a projector's frame the moment both used
   * slot −1.
   */
  wants: string;
  after: FrameImage | null;
  before: FrameImage | null;
  mode: LightboxMode;
} | null = null;

function openLightbox(frame: FrameImage, caption: string, slot = -1, wants = 'after'): void {
  lightbox = { slot, caption, wants, after: frame, before: null, mode: 'overlay' };
  lightboxEl.classList.add('on');
  renderLightbox();
  if (slot < 0) return;

  // Ask for both halves at screen size. These are their own request kind: a
  // model request would recompute every metric to fetch a picture, and the
  // "before" one would compute them for a rig nobody is looking at.
  const width = zoomWidth();
  askFrames(slot, state.compositorRig, width, 'after');
  if (solveResult && beforeRig !== undefined) askFrames(slot, beforeRig, width, 'before');
}

let framesSeq = 0;

/** Ask the model worker for one projector's frame at a named calibration. */
function askFrames(
  slot: number,
  compositorRig: RigCalibration | null,
  width: number,
  tag: string,
): void {
  const req: FramesRequest = {
    kind: 'frames',
    id: ++framesSeq,
    settings: state.settings,
    compositorRig,
    slot,
    width,
    tag,
    customImageId: suppliedName(),
  };
  modelWorker.postMessage(req);
}

function closeLightbox(): void {
  lightboxEl.classList.remove('on');
  lightbox = null;
}
lightboxEl.addEventListener('click', (e) => {
  // The mode buttons live inside the overlay, and the overlay closes on click.
  if ((e.target as HTMLElement)?.closest('.modes')) return;
  closeLightbox();
});

/**
 * Draw whichever comparison the lightbox is set to.
 *
 * Three, because the difference between two frames is a few per cent of the
 * image radius on a repeating grid and each way of showing it fails differently:
 * the overlay is readable at a glance and colours the picture, the blink is the
 * only one that survives a fine grid, and side by side is the only one that
 * shows each frame as it actually is.
 */
function renderLightbox(): void {
  if (!lightbox) return;
  const stage = lightboxEl.querySelector('.stage') as HTMLElement | null;
  const modes = lightboxEl.querySelector('.modes') as HTMLElement | null;
  const cap = lightboxEl.querySelector('.cap') as HTMLElement | null;
  if (!stage || !modes || !cap) return;
  const { after, before, mode } = lightbox;
  if (!after) return;

  modes.replaceChildren();
  stage.classList.toggle('blink', before !== null && mode === 'blink');
  const second = document.getElementById('lightbox-canvas-b') as HTMLCanvasElement;
  const panes = Array.from(stage.querySelectorAll('.pane')) as HTMLElement[];
  const labels = panes.map((p) => p.querySelector('.lbl') as HTMLElement);
  /**
   * Name the panes.
   *
   * Side by side, the two frames differ by a sub-percent warp shift, and which
   * one was which was asserted once in 12px grey under both of them — the first
   * thing to go when the window is short enough to clip the caption.
   */
  const label = (i: number, text: string, kind: '' | 'was' | 'now'): void => {
    const l = labels[i];
    if (!l) return;
    l.textContent = text;
    l.className = `lbl${kind ? ` ${kind}` : ''}`;
  };

  if (!before) {
    paintFrame(lightboxCanvas, after);
    second.classList.add('hidden');
    panes[1]?.classList.add('hidden');
    lightboxCanvas.classList.remove('hidden');
    panes[0]?.classList.remove('hidden');
    label(0, '', '');
    cap.textContent = `${lightbox.caption} · click anywhere to close`;
    return;
  }

  for (const m of [
    { id: 'overlay' as const, label: 'Overlay' },
    { id: 'blink' as const, label: 'Blink' },
    { id: 'pair' as const, label: 'Side by side' },
  ]) {
    const b = el('button', { className: `chip${mode === m.id ? ' on' : ''}`, textContent: m.label });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (lightbox) lightbox.mode = m.id;
      renderLightbox();
    });
    modes.append(b);
  }

  lightboxCanvas.classList.remove('hidden');
  panes[0]?.classList.remove('hidden');
  second.classList.toggle('hidden', mode === 'overlay');
  panes[1]?.classList.toggle('hidden', mode === 'overlay');
  if (mode === 'overlay') {
    paintFramePair(lightboxCanvas, before, after);
    label(0, 'before + after', '');
    cap.textContent =
      'Red is where the old warp drew the grid, cyan where it draws it now; grey is where the ' +
      'two agree. The projector has not moved between them — the recalibration rewrote the frame.';
  } else if (mode === 'blink') {
    paintFrame(lightboxCanvas, after);
    paintFrame(second, before);
    // One label, because the two are stacked and only one of them is showing at
    // any instant. Naming either would be wrong half the time.
    label(0, 'alternating', '');
    label(1, '', '');
    cap.textContent =
      'The same frame before and after, alternating. A shift of a few per cent on a repeating ' +
      'grid is invisible side by side and obvious when it blinks.';
  } else {
    paintFrame(lightboxCanvas, before);
    paintFrame(second, after);
    label(0, 'before', 'was');
    label(1, 'after', 'now');
    cap.textContent = 'Left: what it was sending. Right: what it sends now. Click anywhere to close.';
  }
}

/**
 * A thumbnail that opens full size when clicked.
 *
 * `camera` is where the shot was taken from. With it, clicking asks for the same
 * view again at the size of the screen — the capture previews are rendered at
 * 200 px because three CPU room traces during a solve are not free, and blowing
 * that up is four times the smoothing and none of the detail.
 */
function thumb(
  frame: FrameImage,
  caption: string,
  camera?: { id: string; position: { x: number; y: number; z: number }; fovHDeg: number },
): HTMLElement {
  const fig = el('figure');
  const c = el('canvas');
  paintFrame(c, frame);
  fig.append(c, el('figcaption', { textContent: caption }));
  fig.addEventListener('click', () => {
    // Re-rendered rather than blown up, and on the GPU, so it is instant and
    // carries the same room the thumbnail does.
    const bigger = camera ? renderCameraShot(camera, zoomWidth()) : null;
    openLightbox(bigger ?? frame, caption, -1, caption);
  });
  return fig;
}

interface SliderOptions {
  label: string;
  symbol?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  unit: string;
  /** Multiply by this before printing; the value itself keeps the spec's units. */
  displayScale?: number;
  options?: readonly string[];
  help: string;
  /** PARAMETERS.md section, rendered as a tag beside the label. */
  section?: string;
  tint?: string;
  /** Draw the fill from the centre, and print a sign: a control whose zero is the middle. */
  bipolar?: boolean;
  klass?: string;
  onInput: (v: number) => void;
  /**
   * What the setting reads AFTER `onInput`. Optional; without it the row paints
   * what it asked for, which is right for anything `coerce` does not clamp.
   */
  readBack?: () => number;
  onSettle?: () => void;
}

/**
 * Is a slider being dragged right now?
 *
 * `touched` rebuilds the whole control panel, and rebuilding it under a drag is
 * how the drag died: the `track` the pointer was captured on gets detached, the
 * browser drops the capture with it, and the `pointermove` listener that lived
 * on that node never hears another event. Click-to-position kept working because
 * it only needs the one `pointerdown`.
 *
 * So the panel holds still while a slider is held. The row paints itself in
 * place — it is three DOM writes — and everything else catches up on release.
 */
let sliderDragging = false;

/**
 * A pointer-drag slider.
 *
 * Hand-built rather than `<input type=range>` for one reason that is not
 * aesthetics: a bipolar control needs its fill drawn from the centre outward, so
 * a reader can see at a glance that a projector has been nudged left rather than
 * having to read the number. A native range input cannot do that.
 */
function slider(o: SliderOptions): HTMLElement {
  const wrap = el('div', { className: 'sl' });
  const label = el('span', { className: 'lab', textContent: o.label });
  if (o.symbol) label.append(el('span', { className: 'sym mono', textContent: o.symbol }));
  if (o.klass === 'ASSUME') {
    label.append(el('span', { className: 'kpill', textContent: 'ASSUME', title: 'Nobody has measured this constant.' }));
  }
  // '—' is what a control with no section carries, and a tag reading "—" says
  // less than no tag at all.
  if (o.section && o.section !== '—') {
    label.append(
      el('span', {
        className: 'sym mono',
        textContent: o.section,
        title: 'The PARAMETERS.md section this constant comes from.',
      }),
    );
  }
  const value = el('span', {
    className: 'val num',
    textContent: formatSetting(
      {
        decimals: o.decimals,
        unit: o.unit,
        options: o.options,
        signed: o.bipolar,
        displayScale: o.displayScale,
      },
      o.value,
    ),
  });
  wrap.append(el('div', { className: 'row' }, [label, value]));

  const track = el('div', { className: 'track' });
  const rail = el('div', { className: 'rail' });
  const fill = el('div', { className: 'fill' });
  const knob = el('div', { className: 'knob' });
  if (o.tint) fill.style.background = o.tint;
  const span = o.max - o.min || 1;
  const pct = ((o.value - o.min) / span) * 100;
  if (o.bipolar) {
    const zero = ((0 - o.min) / span) * 100;
    fill.style.left = `${Math.min(zero, pct)}%`;
    fill.style.width = `${Math.abs(pct - zero)}%`;
  } else {
    fill.style.width = `${pct}%`;
  }
  knob.style.left = `${pct}%`;
  rail.append(fill, knob);
  track.append(rail);
  wrap.append(track);
  wrap.append(el('p', { className: 'help', textContent: o.help }));

  /** Move the thumb and the number without going through a panel rebuild. */
  const paint = (v: number): void => {
    value.textContent = formatSetting(
      {
        decimals: o.decimals,
        unit: o.unit,
        options: o.options,
        signed: o.bipolar,
        displayScale: o.displayScale,
      },
      v,
    );
    const at = ((v - o.min) / span) * 100;
    if (o.bipolar) {
      const zero = ((0 - o.min) / span) * 100;
      fill.style.left = `${Math.min(zero, at)}%`;
      fill.style.width = `${Math.abs(at - zero)}%`;
    } else {
      fill.style.width = `${at}%`;
    }
    knob.style.left = `${at}%`;
  };

  const setFromClientX = (clientX: number): void => {
    const r = rail.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    const raw = o.min + t * span;
    const stepped = o.step > 0 ? Math.round(raw / o.step) * o.step : raw;
    const asked = Math.min(o.max, Math.max(o.min, stepped));
    o.onInput(asked);
    // What the settings ACTUALLY hold: `coerce` clamps some controls against
    // others — the near zoom limit tracks the sphere radius — and a thumb that
    // kept sliding past a value the model had refused would be lying.
    paint(o.readBack ? o.readBack() : asked);
  };

  track.addEventListener('pointerdown', (e) => {
    // On the window, not the track. The track is replaced the moment anything
    // re-renders the panel, and a listener on a detached node never fires again;
    // that is what made a drag stop dead after the first step while a click
    // carried on working.
    //
    // One pointer owns the drag, and the listeners below answer only to it. They
    // used to answer to any pointer anywhere in the window, which on a
    // touchscreen — where the settings sheet sits over the sphere — meant a
    // second finger orbiting the ball wrote its own clientX into the slider, and
    // that finger's `pointerup` tore the listeners down and set
    // `sliderDragging` false while the reader's finger was still on the track.
    // The drag then went dead mid-gesture and `renderControls` rebuilt the panel
    // underneath it, which reads as the page freezing rather than as a bug.
    if (sliderDragging) return;
    e.preventDefault();
    const owner = e.pointerId;
    sliderDragging = true;
    setFromClientX(e.clientX);
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== owner) return;
      setFromClientX(ev.clientX);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== owner) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      sliderDragging = false;
      // The panel held still for the whole drag, so this is where every other
      // row that reads the value it changed gets to catch up.
      renderControls();
      if (o.onSettle) o.onSettle();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  return wrap;
}

/**
 * A row of chips, and — when the notes are on — a sentence saying what the row
 * is for.
 *
 * The explanation used to be a `title=` attribute on each chip, which is a hover
 * tooltip: it does not exist on a touchscreen, and the panel's own "what do
 * these do?" toggle did not reveal it. So every slider on the page could explain
 * itself and no chip row could, including the four rows whose authored `help`
 * text in `settings.ts` therefore rendered nowhere at all.
 */
function chipRow(
  items: readonly { label: string; on: boolean; onPick: () => void; title?: string }[],
  help = '',
): HTMLElement {
  const row = el('div', { className: 'chips' });
  for (const it of items) {
    const b = el('button', {
      className: `chip${it.on ? ' on' : ''}`,
      textContent: it.label,
      title: it.title ?? '',
    });
    b.addEventListener('click', it.onPick);
    row.append(b);
  }
  if (!help) return row;
  const wrap = el('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '6px';
  wrap.append(row, el('p', { className: 'grouphelp', textContent: help }));
  return wrap;
}

/** One editable number in a projector's placement row. */
function placementField(
  label: string,
  value: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = el('label', { className: 'note tiny' });
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '2px';
  wrap.style.flex = '1 1 0';
  wrap.style.minWidth = '0';
  const input = el('input', { type: 'number', value: String(round3(value)), step: String(step) });
  input.style.width = '100%';
  input.style.minWidth = '0';
  input.addEventListener('change', () => {
    const v = Number.parseFloat(input.value);
    // A field left mid-edit or cleared must not silently place a projector at
    // NaN, which renders as a black frame with no error anywhere.
    if (!Number.isFinite(v)) {
      input.value = String(round3(value));
      return;
    }
    onChange(v);
  });
  wrap.append(el('span', { textContent: label }), input);
  return wrap;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * What "the model" means to the aiming controls.
 *
 * The dropped mesh's own bounds centre, not the world origin. GLB node
 * translations are preserved by the reader and the preview camera orbits that
 * centre, so a legally translated model can sit in frame while an aim at the
 * origin points every projector somewhere else entirely.
 */
function modelAimPoint(): { x: number; y: number; z: number } {
  if (meshFacts === null || droppedMesh === null) return { x: 0, y: 0, z: 0 };
  const p = droppedMesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < droppedMesh.vertexCount; i++) {
    const x = p[3 * i];
    const y = p[3 * i + 1];
    const z = p[3 * i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, z: 0 };
  return { x: 0.5 * (minX + maxX), y: 0.5 * (minY + maxY), z: 0.5 * (minZ + maxZ) };
}

/** The placements the install settings imply, as a starting point to edit. */
function placementsFromInstall(): ProjectorPlacement[] {
  const rig = buildAsBuilt(state.settings);
  return rig.projectors.map((p) => ({
    position: { ...p.pose.position },
    yawDeg: p.pose.yawDeg,
    pitchDeg: p.pose.pitchDeg,
    rollDeg: p.pose.rollDeg,
  }));
}

/**
 * Put the projectors where you like — `docs/ARBITRARY-SHAPES.md` Phase 4.
 *
 * ## Why this lives under the dropped model and not beside the install controls
 *
 * The install controls describe the SOS sphere: two to four projectors in
 * quadrant viewports, and the panel refuses a fifth in so many words, because
 * §3.4's framebuffer has four quadrants and PARAMETERS.md §2 supports 2, 3 and
 * 4. That refusal is still right — every §7 gate on this page is a number about
 * that machine, and a six-projector rig answering them would be a score for an
 * installation nobody described.
 *
 * A rig placed by hand therefore reaches only the model preview, whose three
 * numbers are counts over the surface's own area and stay true whatever is
 * pointing at it. The same argument that made the surface a separate worker
 * request makes free placement a separate rig.
 */
function placementBlock(): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (droppedMesh === null) return out;

  out.push(el('h3', { textContent: 'Projectors' }));

  if (customPlacements === null) {
    out.push(
      el('p', {
        className: 'note tiny',
        textContent:
          'Lit by the install above — ' +
          `${Math.round(state.settings.projectorCount)} projectors on the nominal ring. ` +
          'Take them off the ring to put them anywhere, in any number.',
      }),
    );
    const start = el('button', { className: 'chip', textContent: 'Place by hand' });
    start.addEventListener('click', () => {
      customPlacements = placementsFromInstall();
      requestSurface();
      renderControls();
    });
    const row = el('div', { className: 'chips' });
    row.append(start);
    out.push(row);
    return out;
  }

  const places = customPlacements;
  places.forEach((place, i) => {
    const card = el('div');
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '4px';
    card.style.marginBottom = '8px';

    const head = el('div');
    head.style.display = 'flex';
    head.style.justifyContent = 'space-between';
    head.style.alignItems = 'center';
    head.append(el('strong', { className: 'note tiny', textContent: place.id ?? `P${i + 1}` }));
    if (places.length > 1) {
      const drop = el('button', { className: 'chip', textContent: 'remove', title: 'Take this projector out of the rig' });
      drop.addEventListener('click', () => {
        places.splice(i, 1);
        requestSurface();
        renderControls();
      });
      head.append(drop);
    }
    card.append(head);

    const set = (): void => {
      requestSurface();
      renderControls();
    };
    const xyz = el('div');
    xyz.style.display = 'flex';
    xyz.style.gap = '6px';
    xyz.append(
      placementField('x m', place.position.x, 0.1, (v) => {
        place.position = { ...place.position, x: v };
        set();
      }),
      placementField('y m', place.position.y, 0.1, (v) => {
        place.position = { ...place.position, y: v };
        set();
      }),
      placementField('z m', place.position.z, 0.1, (v) => {
        place.position = { ...place.position, z: v };
        set();
      }),
    );
    card.append(xyz);

    const ypr = el('div');
    ypr.style.display = 'flex';
    ypr.style.gap = '6px';
    ypr.append(
      placementField('yaw°', place.yawDeg ?? 0, 1, (v) => {
        place.yawDeg = v;
        set();
      }),
      placementField('pitch°', place.pitchDeg ?? 0, 1, (v) => {
        place.pitchDeg = v;
        set();
      }),
      placementField('roll°', place.rollDeg ?? 0, 1, (v) => {
        place.rollDeg = v;
        set();
      }),
    );
    card.append(ypr);
    out.push(card);
  });

  const actions = el('div', { className: 'chips' });
  const add = el('button', { className: 'chip', textContent: 'add a projector' });
  add.addEventListener('click', () => {
    // A new lens goes where the last one is, moved along, aimed at the object.
    // Dropping it at the origin would put it inside whatever is being lit.
    const last = places[places.length - 1];
    const r = Math.hypot(last.position.x, last.position.y) || 5.18;
    const az = Math.atan2(last.position.y, last.position.x) + Math.PI / 4;
    const position = { x: r * Math.cos(az), y: r * Math.sin(az), z: last.position.z };
    const aim = aimAtPoint(position, modelAimPoint());
    places.push({ position, yawDeg: aim.yawDeg, pitchDeg: aim.pitchDeg, rollDeg: 0 });
    requestSurface();
    renderControls();
  });
  const aimAll = el('button', {
    className: 'chip',
    textContent: 'aim all at the model',
    title: "Re-point every projector at the model's own centre, keeping it where it stands.",
  });
  aimAll.addEventListener('click', () => {
    for (const place of places) {
      const aim = aimAtPoint(place.position, modelAimPoint());
      place.yawDeg = aim.yawDeg;
      place.pitchDeg = aim.pitchDeg;
    }
    requestSurface();
    renderControls();
  });
  const back = el('button', {
    className: 'chip',
    textContent: 'back to the install',
    title: 'Discard the hand-placed rig and light the model from the install above.',
  });
  back.addEventListener('click', () => {
    customPlacements = null;
    requestSurface();
    renderControls();
  });
  actions.append(add, aimAll, back);
  out.push(actions);

  out.push(
    el('p', {
      className: 'note tiny',
      textContent:
        `${places.length} projectors, laid out as viewports of one framebuffer — ` +
        'SOS drives a spanned X screen and that does not stop being true off the ring. ' +
        'Each is framed from its own throw, so a nearer lens gets a wider field.',
    }),
  );

  if (!isRing(places)) {
    const note = el('p', {
      className: 'note tiny',
      textContent:
        'These lenses do not ring the object. The sector blend reading (A-37) measures a ' +
        "longitude wedge from each lens's azimuth, which presumes a ring — it is off here, and " +
        "the crossfade is the geodesic distance to each projector's own footprint edge instead.",
    });
    out.push(note);
  }

  return out;
}

/**
 * What a dropped model produced: the picture, the coverage, and what the reader
 * refused.
 *
 * ## Why this is beside the live view and not in it
 *
 * The display shader intersects a sphere analytically; teaching it to traverse a
 * bounding volume hierarchy is Phase 2 of `docs/ARBITRARY-SHAPES.md`. So the
 * model is rendered by `packages/sim` on the CPU, in the worker, and shown here.
 *
 * The alternative — quietly loading a model while the canvas keeps drawing a
 * ball — is the one thing this page must not do. Every number it prints comes
 * from the model rather than the picture precisely so that the two can never
 * drift apart unnoticed, and a mesh in the metrics with a sphere on screen would
 * be that drift, installed on purpose.
 */
function modelBlock(): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (meshError) {
    const err = el('p', { className: 'note', textContent: meshError });
    err.style.color = 'var(--warn)';
    out.push(err);
  }
  if (droppedMesh === null) return out;

  out.push(el('h3', { textContent: 'Dropped model' }));

  if (meshFrame) {
    const canvas = el('canvas');
    canvas.dataset.smoke = 'model-preview';
    canvas.width = meshFrame.width;
    canvas.height = meshFrame.height;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    paintFrame(canvas, meshFrame);
    out.push(canvas);
  }

  const f = meshFacts;
  if (f) {
    // `data-smoke` on the lit fraction: it is the one number that proves the
    // whole chain ran — bytes read in the page, mesh across to the worker,
    // hierarchy built, rig traced against it, reply painted. `tools/smoke-app.ts`
    // drops a synthesised GLB and reads exactly this.
    const litRow = el('p', {
      className: 'note tiny',
      textContent:
        `${(100 * f.litFraction).toFixed(1)}% of the area is lit, ` +
        `${f.meanOverlap.toFixed(2)} projectors deep on average`,
    });
    litRow.dataset.smoke = 'model-lit';
    out.push(litRow);

    // Which rig produced that number, from the worker's own reply rather than
    // from the panel beside it. `tools/smoke-app.ts` waits on this: the lit
    // fraction alone cannot tell a fresh five-projector answer from the stale
    // four-projector one still on screen.
    const rigRow = el('p', {
      className: 'note tiny',
      textContent: `lit by ${f.projectorCount} projector${f.projectorCount === 1 ? '' : 's'}`,
    });
    rigRow.dataset.smoke = 'model-rig';
    out.push(rigRow);

    const rows: string[] = [
      `${f.triangles.toLocaleString()} triangles, ${f.vertices.toLocaleString()} vertices`,
      `${f.areaM2.toFixed(2)} m² of surface, ${(2 * f.boundsRadiusM).toFixed(2)} m across`,
      `${(100 * f.shadowedFraction).toFixed(1)}% faces a projector and is dark anyway — the model is in its own way`,
    ];
    if (!f.hasUvs) {
      rows.push('no UV set, so it has no content — coverage and overlap still hold');
    }
    if (!f.hasNormals) rows.push('no normals in the file; the winding supplies them');
    for (const r of rows) out.push(el('p', { className: 'note tiny', textContent: r }));
  } else if (meshBusy) {
    out.push(el('p', { className: 'note tiny', textContent: 'Lighting the model…' }));
  }

  // Everything the reader dropped on the floor, named. A model that arrives with
  // half its geometry missing has to say so.
  for (const s of meshReport?.skipped ?? []) {
    const note = el('p', { className: 'note tiny', textContent: s });
    note.style.color = 'var(--warn)';
    out.push(note);
  }

  // Which renderer is actually drawing the model, asked rather than assumed.
  // This caption said "the live view above is still the sphere" for as long as
  // that was true, and went on saying it after Phase 2 put the mesh on the GPU —
  // in the same file that passes `mesh: model.mesh` to the display shader every
  // frame. The page's own rule, stated above: quietly drawing a ball while a
  // model is loaded is the one thing this page must not do.
  //
  // THREE states, not two, and the first correction to this caption got that
  // wrong. It asked `displayMeshId()`, which means "there is a model and nothing
  // has rejected it" — true from the instant of the drop, while the canvas still
  // holds the previous frame and `packMesh` has not yet been given the chance to
  // refuse. So the caption asserted a GPU trace that had not happened. The
  // question is about the picture, so it is answered by the picture: `draw`
  // records what it actually handed the shader.
  const rejected = droppedMesh !== null && droppedMeshId === rejectedMeshId;
  const tracingModel = droppedMesh !== null && !rejected && drawnMeshId === droppedMeshId;
  const caveat = el('p', {
    className: 'note tiny',
    textContent:
      (tracingModel
        ? 'The live view above traces this same model — the display shader walks its BVH on the ' +
          'GPU. This picture is that scene traced independently on the CPU, which is what the ' +
          'agreement check beside it compares. '
        : rejected
          ? 'The live view above is the sphere: this model was refused, so the display shader ' +
            'fell back and this CPU picture is the only place its shape appears. '
          : 'The live view above has not drawn this model yet — the picture beside it is the ' +
            'CPU trace, which arrived first. ') +
      'Projectors DO crossfade here: the blend is a geodesic distance to the edge ' +
      "of each projector's own footprint, which feathers a shadow edge exactly as it feathers a " +
      'raster edge. The polar mask stays off, and that is a decision rather than a gap: it ' +
      "attenuates a sphere's exposed south cap by latitude, and a model has no pole to " +
      'measure one from. Masking a band of its texture rows would be a picture of a ' +
      'parameter rather than of anything on the model.',
  });
  out.push(caveat);
  return out;
}

/** The authored explanation for a control, for rows that render as chips. */
function helpFor(key: SettingKey): string {
  return CONTROLS.find((c) => c.key === key)?.help ?? '';
}

/**
 * Do these two settings describe the same INSTALL?
 *
 * The comparison deliberately skips the view, the content and the nudges: a
 * preset chip should light when the room matches it, whatever you are looking
 * at and from where.
 */
function matchesInstall(a: Settings, b: Settings): boolean {
  return CONTROLS.every((c) => {
    if (c.group === 'view' || c.key === 'content' || c.key === 'gridOn') return true;
    return Math.abs(a[c.key] - b[c.key]) < 1e-9;
  });
}

/**
 * Read an image file into an equirectangular map in LINEAR light.
 *
 * Two things this does that a naive `drawImage` into a texture would not:
 *
 *  - **It undoes the display encode.** A JPEG or PNG holds sRGB-ish values; the
 *    model works in linear radiance throughout (conventions.ts §P). Uploading
 *    the bytes straight through would make every dataset a stop and a half too
 *    bright at the midtones and would move every photometric number on the page.
 *    2.2 is the encode `defaultScene` assumes, so it is the one undone here.
 *  - **It checks the aspect.** An equirectangular map is 2:1. Anything else is
 *    almost certainly not a sphere map, and stretching it silently would put the
 *    poles in the wrong place with no indication anything was wrong.
 *
 * Nothing is uploaded anywhere. The file is read by the page, converted, and
 * held in memory — which is also why no image ships with the site.
 */
async function readEquirect(file: File): Promise<EquirectImage> {
  const bitmap = await createImageBitmap(file);
  try {
    // One rule, shared with the video loader. See `media.ts`.
    const wrong = equirectAspectError(bitmap.width, bitmap.height, 'image');
    if (wrong) throw new Error(wrong);
    // Downscale to the raster the rest of the page uses.
    //
    // This is the binding limit on how much detail the sphere can show, and the
    // note that used to be here had it backwards. Measured at Boulder's
    // geometry: 1024 texels round a 5.43 m equator is 5.30 mm of sphere per
    // texel, against 0.687 mm for one pixel of a 3840-wide projector at a
    // 5.31 m throw. The content is 7.7 times COARSER than the pixel drawing it,
    // not four times finer — so zoom in far enough and what you are looking at
    // is this texture's own reconstruction rather than anything the rig is
    // doing, which is a thing that cannot happen on a real sphere fed imagery at
    // the projectors' resolution.
    //
    // 2048 is the compromise: 2.65 mm per texel, 25 MB as a float triple on the
    // CPU and again on the GPU and again in the model worker. 4096 would match
    // the source JPEG and still be twice as coarse as a projector pixel, for
    // 101 MB a copy, which is not a trade worth making on a phone.
    //
    // The GRATICULE is no longer in here — it is drawn analytically by both
    // renderers, so the pattern the gate measures is not limited by this at all.
    // What this bounds now is photographic imagery, which has no fine structure
    // to lose in the way a one-pixel line does.
    const w = 2048;
    const h = 1024;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('could not open a 2D context to read the image');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const out = createImage(w, h);
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) {
        out.data[3 * i + c] = Math.pow(px[4 * i + c] / 255, CONTENT_DECODE_GAMMA);
      }
    }
    return out;
  } finally {
    bitmap.close();
  }
}

/**
 * A dropped file, to whichever loader its type names.
 *
 * One entry point for the button and the drop target, because "the page takes
 * video too" has to be true of both or it is a feature nobody finds.
 */
async function loadCustomMedia(file: File): Promise<void> {
  const kind = mediaKind(file.type, file.name);
  // A model is not content — it is the shape the content goes on — so it takes
  // a different path entirely and leaves whatever is on the sphere alone.
  if (kind === 'model') {
    await loadCustomModel(file);
    return;
  }
  if (kind === 'video') {
    await loadCustomVideo(file);
    return;
  }
  await loadCustomImage(file);
}

/**
 * Read a dropped `.glb` and ask the model worker to light it.
 *
 * The reader is `packages/meshio`, which neither `sim` nor `solver` may import —
 * see that package's README for why a loader is the most plausible-looking thing
 * to share across the boundary and the one that must not be.
 *
 * Everything it refuses is SHOWN. A model that arrives with half its geometry
 * missing has to say so, or somebody studies a coverage figure for a shape they
 * did not load.
 */
async function loadCustomModel(file: File): Promise<void> {
  meshError = '';
  meshFacts = null;
  meshFrame = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // `mediaKind` routes anything that looks like a model here, which is the
    // right call — it is a model, and refusing it as a badly-shaped image would
    // be baffling. But only the binary container has a reader, so the refusal
    // has to name the actual format rather than let `readGlb` report that a
    // .gltf file is not glTF.
    const container = containerOf(bytes);
    if (container !== 'glb') {
      setDroppedMesh(null);
      meshReport = null;
      meshError =
        container === 'gltf-json'
          ? `${file.name} is a JSON .gltf. This page reads the binary container — ` +
            're-export as .glb (in Blender, glTF Binary) so the geometry travels in one file.'
          : `${file.name} is not a glTF binary. This page reads .glb; OBJ is not implemented yet.`;
      state.section = 'room';
      renderControls();
      return;
    }
    const report = readGlb(bytes, { name: file.name });
    meshReport = report;
    setDroppedMesh(report.mesh);
    // Take the reader to the panel that shows it. A dropped IMAGE announces
    // itself — it appears on the sphere — but a model's whole result lives in
    // one section, and the panel opens on `projectors`. Dropping a building and
    // having the page respond by doing nothing visible is the same as it not
    // working, and `tools/smoke-app.ts` reported exactly that before this line
    // existed.
    state.section = 'room';
    if (report.mesh === null) {
      meshError =
        report.skipped.length > 0
          ? `nothing in ${file.name} could be lit: ${report.skipped.join('; ')}`
          : `${file.name} holds no geometry this page can use.`;
      renderControls();
      return;
    }
    requestSurface();
  } catch (err) {
    setDroppedMesh(null);
    meshReport = null;
    meshError = err instanceof Error ? err.message : String(err);
    state.section = 'room';
  }
  renderControls();
}

/**
 * The one place the dropped model changes, because the live view has to be told.
 *
 * `draw()` runs only when something has marked the canvas dirty, and dropping a
 * file marks nothing: the model card is DOM that `renderControls` repaints, and
 * for as long as the display shader was handed a sphere whatever the reader
 * loaded, that was enough. It stopped being enough when `draw()` started reading
 * the model -- the card would show the building and the view beside it would go
 * on showing a sphere until some unrelated interaction happened to request a
 * frame. `tools/smoke-app.ts` caught exactly that.
 *
 * Assigning through one function rather than at each of the three sites -- the
 * load, the wrong-container refusal and the catch -- so that clearing the model
 * repaints too. A view left on a building the reader has just removed is the
 * same bug wearing the other sign.
 */
function setDroppedMesh(mesh: SurfaceMesh | null): void {
  droppedMesh = mesh;
  // Bumped on every change including to null, because it is what `displayModel`
  // and the worker both key their caches on. Reusing an id would let a cache
  // answer for the previous model.
  droppedMeshId++;
  // A new id is not a rejected one until `packMesh` says so.
  rejectedMeshId = -1;
  // The standing verdict judged a shape that is no longer on screen. Leaving it
  // up would put a number about the sphere beside a picture of a building --
  // and the reader has no way to tell it is stale. A blank readout while the
  // next pass runs is the honest state; `checkParity` fills it back in.
  parity = null;
  markDirty();
}

/** Ask the worker for a CPU render of the dropped model, and the coverage facts. */
function requestSurface(): void {
  if (droppedMesh === null) return;
  // One in flight at a time. The trace walks a BVH over every camera ray and
  // then samples four thousand points of surface, so a burst of settled passes
  // would queue work faster than the worker retires it and the preview would
  // fall further behind the controls the longer somebody used them.
  if (meshBusy) {
    queuedSurface = true;
    return;
  }
  queuedSurface = false;
  meshBusy = true;
  const req: SurfaceRequest = {
    kind: 'surface',
    id: ++meshSeq,
    settings: state.settings,
    mesh: droppedMesh,
    meshId: `mesh:${droppedMeshId}`,
    // `suppliedName()`, the same id the metrics path sends, so this names the
    // entry that path already put in the worker's cache. `contentKey` is a
    // different thing — the page's own key for whether the GPU texture is stale.
    customImageId: suppliedName(),
    ...(customPlacements && customPlacements.length > 0
      ? { placements: customPlacements }
      : {}),
    width: 320,
    height: 240,
    camera: {
      azimuthDeg: state.settings.viewAzDeg,
      elevationDeg: state.settings.viewElDeg,
      rangeM: state.settings.viewRangeM,
      fovHDeg: state.settings.viewFovDeg,
    },
  };
  // NOT transferred: the page keeps the mesh so it can re-render from another
  // angle without asking the reader to parse the file again.
  modelWorker.postMessage(req);
  renderControls();
}

async function loadCustomImage(file: File): Promise<void> {
  customError = '';
  try {
    const image = await readEquirect(file);
    // Only after it decoded: a file that fails the aspect check must leave
    // whatever was playing exactly where it was.
    stopVideo();
    customImage = image;
    // A monotonic tail, as the video already carries. Name and byte length do not
    // identify PIXELS: re-export a photo at the same size, or crop and re-save to
    // the same length, and the id is unchanged -- so `viewKey` would call a reply
    // rendered from the old image current against the new one on the GPU, which
    // is the exact false disagreement `ModelRequest.customImage` records having
    // been caught by once already. The cost is re-sending an image that really is
    // the same one, which happens once per deliberate load.
    customName = `${file.name}:${file.size}#${++customImageSeq}`;
    sentImageId = '';
    solveSentImageId = '';
    state.settings = withSetting(state.settings, 'content', CONTENT_CUSTOM);
    contentKey = '';
    // A different picture on the sphere, so the snapshotted frames are of a
    // different picture. Same reason as the content chips in `setSetting`.
    staleFrames();
    touched(false);
    requestModel(true);
  } catch (err) {
    customImage = null;
    customName = '';
    customError = err instanceof Error ? err.message : String(err);
    renderControls();
  }
}

/**
 * The raster a video decodes into.
 *
 * Its own, up to the 2048 a dropped image is held to — so the usual SOS dataset,
 * which is 2048x1024, is copied one texel to one texel rather than resampled to
 * a raster it already has. Above that it comes down, for the reason
 * `readEquirect` gives: 2048 is 2.65 mm of sphere per texel against 0.687 mm for
 * a projector pixel, and 4096 costs four times the memory in three places to be
 * twice as coarse as the thing drawing it instead of eight times.
 *
 * Even, because the height is half the width and a half-texel is not a thing.
 */
function videoRasterFor(videoWidth: number): { width: number; height: number } {
  const width = Math.max(2, 2 * Math.round(Math.min(2048, videoWidth) / 2));
  return { width, height: Math.round(width / 2) };
}

let videoModelTimer = 0;

/**
 * Keep the model's copy of the frame from falling behind the sphere's.
 *
 * Hung off the same `requestModel` the settle timer uses, so it obeys the
 * one-in-flight lock and cannot pile up behind a slow worker. Skipped while the
 * tab is hidden: a backgrounded page decodes nothing worth measuring and the
 * whole point of the interval is to not be a background job.
 */
function watchVideoFrames(): void {
  window.clearInterval(videoModelTimer);
  videoModelTimer = window.setInterval(() => {
    if (!videoActive() || document.hidden) return;
    requestModel(true);
  }, VIDEO_MODEL_INTERVAL_MS);
}

/** Put the video down: stop it, release the object URL, give the texture back. */
function stopVideo(): void {
  window.clearInterval(videoModelTimer);
  videoModelTimer = 0;
  if (customVideo) {
    customVideo.pause();
    customVideo.removeAttribute('src');
    customVideo.load();
    customVideo.remove();
  }
  if (customVideoUrl) URL.revokeObjectURL(customVideoUrl);
  customVideo = null;
  customVideoUrl = '';
  videoRaster = { width: 0, height: 0 };
  lastVideoTime = -1;
  if (gl) releaseVideoTarget(gl);
  contentKey = '';
  // There is no video left to have failed to snapshot.
  snapshotError = '';
}

/**
 * A dropped mp4, looping on the sphere.
 *
 * `muted` and `playsInline` are not preferences: without both, iOS refuses to
 * autoplay and refuses to play inline, and the page gets a full-screen video
 * player instead of a planet.
 *
 * What this does NOT do is decode anything on the CPU. The frames go straight
 * from the element to a GPU texture and are turned into linear light by one
 * draw call — see `CONTENT_DECODE_FRAGMENT`. The CPU model gets one frame per
 * settled pass, from `snapshotVideo`, which reads back what the GPU has rather
 * than decoding the file a second way.
 */
async function loadCustomVideo(file: File): Promise<void> {
  customError = '';
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  // In the document, and hidden. A detached element decodes and uploads fine in
  // a desktop browser, but iOS treats inline playback as a property of an
  // element that is IN a page, and a test cannot pause what it cannot select.
  // `aria-hidden` because it is a texture source, not something to announce.
  video.style.position = 'fixed';
  video.style.width = '1px';
  video.style.height = '1px';
  video.style.opacity = '0';
  video.style.pointerEvents = 'none';
  video.style.left = '-10px';
  video.style.top = '-10px';
  video.setAttribute('aria-hidden', 'true');
  video.dataset.smoke = 'content-video';
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener(
        'error',
        () =>
          reject(
            new Error(
              `that file did not decode as video. ${file.name} may use a codec this browser ` +
                'does not have — H.264 in an .mp4 works everywhere.',
            ),
          ),
        { once: true },
      );
      video.src = url;
      document.body.append(video);
    });
    const wrong = equirectAspectError(video.videoWidth, video.videoHeight, 'video');
    if (wrong) throw new Error(wrong);

    // Only now is the old content given up.
    stopVideo();
    customVideo = video;
    customVideoUrl = url;
    videoRaster = videoRasterFor(video.videoWidth);
    lastVideoTime = -1;
    videoFrameSeq = 0;
    // A still, until the first frame is handed over on the next settled pass:
    // `buildWorld` needs an image, and a black one for a few hundred
    // milliseconds is better than the last file's.
    customImage = createImage(videoRaster.width, videoRaster.height);
    customName = `${file.name}:${file.size}#0`;
    sentImageId = '';
    solveSentImageId = '';
    state.settings = withSetting(state.settings, 'content', CONTENT_CUSTOM);
    contentKey = '';
    staleFrames();
    // Autoplay can still be refused — a browser that has never seen a gesture on
    // this page, say. Not fatal: the first frame is already decoded and on the
    // sphere, so a refusal shows a still instead of nothing.
    void video.play().catch(() => {});
    watchVideoFrames();
    touched(false);
    requestModel(true);
  } catch (err) {
    video.remove();
    URL.revokeObjectURL(url);
    customError = err instanceof Error ? err.message : String(err);
    renderControls();
  }
}

/**
 * Hand the model the frame the display is showing.
 *
 * Read back off the GPU rather than decoded again on the CPU, and that is the
 * whole point: the shader and `renderTwoRigRoomView` then work from ONE frame
 * rather than from two derivations of one file, which is a stronger guarantee
 * than the still path has ever had. `freezeContent` also holds a copy for the
 * parity draw, because by the time the worker answers the video has moved on.
 *
 * Only on the settled pass. It is a 25 MB read-back at the full raster, and the
 * numbers it feeds do not read the content at all — no metric on this page does.
 * What it feeds is the parity check and the projector frame previews.
 */
function snapshotVideo(): void {
  if (!gl || !videoActive()) return;
  try {
    const frame = freezeContent(gl);
    customImage = frame;
    videoFrameSeq++;
    customName = `${customName.split('#')[0]}#${videoFrameSeq}`;
    // Cleared on success. It was written once and released nowhere, so a single
    // transient read-back failure pinned a present-tense warning — "the readout
    // and the parity check are describing an older frame" — under the content
    // chips for the life of the page, including after the video was removed and
    // there was no older frame to describe.
    snapshotError = '';
  } catch (err) {
    // A read-back that fails must not take the page with it: the sphere is still
    // being drawn from a texture that works.
    snapshotError = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Drop an equirectangular image anywhere on the page.
 *
 * The whole window is the target, which is generous and completely invisible —
 * so dragging a file over the page raises a banner saying what will happen to
 * it. Without one there is nothing on screen that says the page accepts a file
 * at all, which is exactly the report this came from.
 */
function installDropTarget(): void {
  let depth = 0;
  const stop = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  const show = (on: boolean): void => {
    document.body.classList.toggle('dropping', on);
  };

  window.addEventListener('dragenter', (e) => {
    stop(e);
    // Entering a child fires `dragenter` before the parent's `dragleave`, so a
    // boolean flickers and a counter does not.
    depth++;
    show(true);
  });
  window.addEventListener('dragover', stop);
  window.addEventListener('dragleave', (e) => {
    stop(e);
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  window.addEventListener('drop', (e) => {
    stop(e);
    depth = 0;
    show(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadCustomMedia(file);
  });
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

const modelWorker = new Worker(new URL('../worker/model.js', import.meta.url), { type: 'module' });
const solveWorker = new Worker(new URL('../worker/solve.js', import.meta.url), { type: 'module' });

let modelSeq = 0;
/** Metrics passes that have landed. Exposed for `tools/smoke-app.ts`. */
let modelPasses = 0;
let modelWanted = -1;
let parityRequestKey = '';

function viewKey(): string {
  // EVERYTHING the two renderers are given, not a list of the parts that seemed
  // to matter.
  //
  // The CPU half is rendered from the state as it was when the request went out,
  // and lands about half a second later. Anything that changed in between makes
  // the reply a picture of a different scene than the frame it is compared
  // against, and the verdict then reports a disagreement that belongs to neither
  // renderer. The page has been bitten by exactly that before, over the content
  // texture -- see `ModelRequest.customImage`, which records a 15% disagreement
  // that was two pictures rather than two models.
  //
  // This used to name seven fields: the camera, the sample count, the layout
  // shift and the content. Each was there for a real reason, and the set was
  // still wrong -- `gridOn`, `gridDeg`, `ambient`, `mountError`, `errorSeed`,
  // `sphereDiaIn`, `roomSpill` and the compositor's own calibration all change
  // the picture and none of them retired anything. A guard that has to be
  // extended by hand every time a setting is added is a guard that is correct
  // only until the next commit.
  //
  // The compositor rig is the one that mattered most and was missed: a running
  // solve replaces it on every step and deliberately requests no new pass ("draw
  // with it; compute nothing from it"), so the reply in flight was scored
  // against a frame drawn from a rig it had never seen. That is a FALSE
  // disagreement, printed at exactly the moment somebody is watching the solve.
  //
  // Being total costs nothing, because `touched()` requests a model pass on
  // every settings change -- a key that retires the reply in flight is always
  // followed by one that replaces it. During a solve there is deliberately no
  // such replacement, and the check goes quiet until the result lands, which is
  // the honest answer rather than a verdict about a gauge.
  //
  // `viewShiftFrac` and `suppliedName` stay because neither lives in `settings`:
  // the first is read off the live panel geometry, the second names the image
  // itself rather than the setting that selects one.
  return JSON.stringify([
    state.settings,
    state.compositorRig,
    viewShiftFrac().toFixed(3),
    suppliedName(),
  ]);
}

/**
 * Samples per pixel for the display AND for the parity check's CPU render.
 *
 * One function, read by both, because the whole value of the parity number rests
 * on the two halves using the same one. Two call sites reading the setting
 * separately is how they end up a version apart during a drag.
 */
function paritySamples(): number {
  const n = viewSampleSide(state.settings);
  return n * n;
}

/**
 * Ask the metrics worker for a fresh pass, at most one at a time.
 *
 * `modelWanted` only ever discarded stale REPLIES; every call still posted, so a
 * slider drag queued one full metrics pass per pointer event and the worker
 * ground through all of them, every one but the last already superseded. On a
 * phone that is the same core the page is drawing on.
 *
 * So: while one is in flight, remember what was wanted and send it when the
 * reply lands. The picture still tracks the slider — it just tracks it at the
 * rate the worker can actually answer, which is what the reader sees anyway.
 * `fine` sticks if either the pending or the queued request asked for it: the
 * settle timer's full-density pass must not be swallowed by a coarse one
 * arriving a millisecond later.
 */
function requestModel(fine: boolean): void {
  // A dropped model's preview and its three coverage figures come from the same
  // rig the sphere metrics do, so every slider that moves the rig makes them
  // stale — and stale is the one thing this panel must not be, because the
  // numbers beside the picture are the whole reason the picture is there. They
  // refresh on the SETTLED pass only: the trace is a BVH walk, far too
  // expensive for the every-frame pass a drag produces.
  if (fine) requestSurface();
  if (modelPending) {
    queuedModel = { fine: fine || (queuedModel?.fine ?? false) };
    return;
  }
  postModel(fine);
}

/** A pass asked for while the worker was busy. See `requestModel`. */
let queuedModel: { fine: boolean } | null = null;

/** Send whatever was asked for while the last pass was running. */
function drainModel(): void {
  const next = queuedModel;
  queuedModel = null;
  if (next) postModel(next.fine);
}

/**
 * Let go of the one-in-flight lock if a reply never comes.
 *
 * The lock is what stops the flood, and a lock nothing releases is a page that
 * stops answering. A worker that dies, or a request that throws somewhere with
 * no reply path, would otherwise leave every later slider silently inert. Ten
 * seconds is far longer than the slowest full-density pass and far shorter than
 * a reader's patience.
 */
let modelWatchdog = 0;

function postModel(fine: boolean): void {
  // Before the request is built, because the request carries the frame. Only on
  // the settled pass: this is a full-raster read-back off the GPU, and a coarse
  // pass during a drag neither needs it nor could afford it.
  if (fine) snapshotVideo();
  const id = ++modelSeq;
  modelWanted = id;
  modelPending = true;
  window.clearTimeout(modelWatchdog);
  modelWatchdog = window.setTimeout(() => {
    if (!modelPending) return;
    modelPending = false;
    drainModel();
  }, 10_000);
  parityMeshIdAsked = displayMeshId();
  const req: ModelRequest = {
    kind: 'model',
    id,
    // Names the model the parity render must trace, so the worker's picture and
    // the shader's are of the same shape. See `ModelResponse.parityMeshId`.
    meshId: displayMeshId(),
    settings: state.settings,
    compositorRig: state.compositorRig,
    densityScale: fine ? 1 : 0.3,
    parity: null,
    // Only on the settled pass: a projector frame is a CPU trace and four of
    // them on every drag would starve the metrics they sit beside.
    projectorPreviewWidth: fine ? previewWidth : 0,
    // Sent once per image, not once per request: the worker caches it by id, and
    // a megabyte of float on every slider drag would cost more than the metrics.
    // A copy rather than a transfer, because the main thread still needs it for
    // the GPU upload.
    customImage:
      suppliedImage() !== null && suppliedName() !== sentImageId
        ? {
            width: suppliedImage()!.width,
            height: suppliedImage()!.height,
            data: suppliedImage()!.data,
          }
        : null,
    customImageId: suppliedName(),
  };
  sentImageId = suppliedName();
  // Not until a real frame has been through the GPU. Until then the model holds
  // the black placeholder `loadCustomVideo` left it, and a comparison against
  // whatever the texture happens to contain is a disagreement about nothing.
  // Not against a lost context either. The read-back would come back as the
  // frozen frame or as zeros, and `judgeParity` would report the two renderers
  // disagreeing — which would be a confident statement about the wrong thing.
  if (fine && !contextLost && !(videoActive() && videoFrameSeq === 0)) {
    const camera = buildViewer(state.settings, PARITY_WIDTH, PARITY_HEIGHT, viewShiftFrac());
    req.parity = {
      width: PARITY_WIDTH,
      height: PARITY_HEIGHT,
      fovHDeg: camera.fovHDeg,
      position: camera.position,
      target: camera.target,
      samplesPerPixel: paritySamples(),
      imageShift: camera.imageShift ?? 0,
    };
    parityRequestKey = viewKey();
  }
  modelWorker.postMessage(req);
  renderReadout();
}

modelWorker.onmessage = (event: MessageEvent<ModelMessage | FramesMessage | SurfaceMessage>): void => {
  const msg = event.data;
  // A dropped model, rendered on the CPU. Its own id sequence, like the
  // lightbox's frames, so it can never be mistaken for a stale metrics reply and
  // release the metrics lock.
  if (msg.kind === 'surface') {
    if (msg.id !== meshSeq) return;
    meshBusy = false;
    // Whatever settled while this pass was running, now that the worker is free.
    if (queuedSurface) {
      queuedSurface = false;
      requestSurface();
    }
    if (!msg.ok) {
      meshError = msg.error;
      meshFrame = null;
      meshFacts = null;
    } else {
      meshFrame = msg.frame;
      meshFacts = msg.facts;
      // The worker is now HOLDING this model, which is the earliest moment its
      // parity image can be traced on the same shape the shader is drawing --
      // `ModelRequest.meshId` names a model, and the worker answers with the
      // sphere for one it has not been sent. Without this the readout stayed
      // blank after a drop until some unrelated control happened to request a
      // pass, because `requestSurface` asks for a picture and never for a
      // verdict.
      //
      // Only when the SHAPE changed, not on every settled recompute. A surface
      // reply lands for each settled control while a model is loaded, and asking
      // for a fine model pass on all of them would roughly double the most
      // expensive work the page does for a verdict that is already current.
      if (displayMeshId() !== parityMeshIdAsked) requestModel(true);
    }
    renderControls();
    return;
  }
  // A frame the lightbox asked for, on its own id sequence. It carries no
  // metrics and must not be mistaken for a stale model reply.
  if (msg.kind === 'frames') {
    // A frame that threw. It reaches the page as a failure carrying this kind
    // rather than 'model', so it stops here instead of clearing the metrics
    // lock — but it still has to be SAID, because the alternative is a lightbox
    // that sits on an empty panel with no explanation.
    if (!msg.ok) {
      lastError = msg.error;
      renderReadout();
      return;
    }
    if (!lightbox || msg.slot !== lightbox.slot) return;
    if (msg.tag === 'before') lightbox.before = msg.frame;
    else if (msg.tag === lightbox.wants && msg.frame) lightbox.after = msg.frame;
    else return;
    renderLightbox();
    return;
  }
  // Drop a stale reply: a coarse pass sent before the last drag can land after
  // the fine pass that superseded it, and showing it would make the panel walk
  // backwards for no visible reason.
  if (msg.id !== modelWanted) return;
  modelPending = false;
  window.clearTimeout(modelWatchdog);
  bootEl.classList.add('off');
  if (!msg.ok) {
    lastError = msg.error;
    renderReadout();
    // On EVERY path out of here, including this one. A reply that released the
    // lock without draining would leave a queued pass unsent and the page frozen
    // on the last answer, which is a worse failure than the flood this replaced.
    drainModel();
    return;
  }
  lastError = '';
  // How many metrics passes have actually landed. A drag used to post one per
  // pointer event and the worker ground through every superseded one, so the
  // count is the flood, and it is the only thing that distinguishes "keeping up"
  // from "hopelessly behind" from outside the page.
  modelPasses++;
  readoutEl.dataset.smokePasses = String(modelPasses);
  // A coarse pass carries no projector frames; keep the last good ones rather
  // than blanking the inspect card on every drag.
  //
  // Per SLOT, not per array. The worker always returns an array as long as the
  // panel has projectors and fills it only on a fine pass, so the reply from a
  // drag is four nulls — a non-empty array of nothing. Testing `.length` took
  // that branch and overwrote the frames with the nulls, so the card vanished
  // on the first pointermove and came back 260 ms after the drag stopped. The
  // comment above this line has been right since it was written and the code
  // under it was not. Merging slot by slot also survives a projector being
  // switched off, where only that slot comes back null.
  const kept = model?.projectorFrames ?? [];
  const projectorFrames = msg.projectorFrames.map((f, i) => f ?? kept[i] ?? null);
  model = { ...msg, projectorFrames };
  if (msg.parityImage) checkParity(msg.parityImage, msg.parityMs, msg.parityMeshId);
  renderReadout();
  renderInspect();
  // LAST, and this is not tidiness.
  //
  // Draining posts the next request, and with a video that request takes a fresh
  // frame off the GPU — which replaces the frozen copy `checkParity` above needs
  // and the id it checks itself against. Draining first therefore invalidated
  // every parity reply the moment before it was judged: the readout sat on the
  // verdict from the black placeholder frame, reporting a disagreement between
  // two renderers that were never given the same picture. The lock is already
  // released, so nothing is lost by posting a few milliseconds later.
  drainModel();
};

solveWorker.onmessage = (event: MessageEvent<SolveMessage>): void => {
  const msg = event.data;
  if (msg.kind === 'solve-progress') {
    solveStage = msg.message;
    if (msg.shotCameras) {
      solveCameras = msg.shotCameras;
      // Rendered on the page, by the shader that knows about the room. The
      // worker used to send pictures; it now sends the poses, which is both
      // three CPU room traces cheaper per solve and the only way the projectors
      // and the rail can be in them.
      solveShots = msg.shotCameras
        .map((c) => renderCameraShot(c, SHOT_THUMB_PX))
        .filter((f): f is FrameImage => f !== null);
    }
    if (msg.step) {
      solveTrace.push({ pass: msg.step.pass, cost: msg.step.cost });
      solveStep = { step: msg.step.step, rmsPx: msg.step.rmsPx };
    }
    if (msg.partialRig) {
      // Draw with it; compute nothing from it. The readout keeps showing the
      // pre-calibration numbers until the real result lands, because an
      // intermediate has not had the unobservable global rotation removed and a
      // metric taken from one would be measuring the gauge.
      state.compositorRig = msg.partialRig;
      // And the standing verdict goes with it. `viewKey` retires a reply in
      // FLIGHT, which is only consulted when one arrives -- and this path
      // deliberately requests none, so with a solve running and nothing in
      // flight the previous rig's verdict would sit on screen unchallenged for
      // the whole solve, beside a picture drawn from a rig it has never seen.
      // Retiring the reply and retiring the verdict are two different jobs.
      parity = null;
      markDirty();
    }
    renderReadout();
    return;
  }
  solveRunning = false;
  if (!msg.ok) {
    lastError = msg.error;
    solveStage = '';
    renderReadout();
    return;
  }
  solveResult = msg;
  solveStage = '';
  // A solve that never settled is not a calibration, and it was installed
  // anyway. `partialRig` above draws the sphere from intermediates while the
  // solve runs, so refusing also has to put the pre-solve rig back — otherwise
  // the last intermediate stays on screen, which is worse than either outcome.
  //
  // The optimiser stopping at its iteration cap means it was still moving when
  // it ran out of steps. Measured on this page: one handheld camera stops at
  // the 400-step cap with a 2.31 px residual and a rig 3.06 m from the lenses.
  // Installing that repaints the sphere and every readout from it.
  // The same rule, applied to what the capture actually yielded. Segmentation
  // refuses a camera whose photograph held no framed sphere — which is the right
  // thing for it to do and still costs that view entirely — so a three-position
  // capture can arrive here with one usable view. That is only knowable after
  // the photographs, which is why it is checked here and the count is checked
  // before them.
  const usableViews = msg.silhouetteCameras - msg.silhouetteRefusals;
  const tooFewViews = msg.silhouetteCameras > 0 && usableViews < MIN_CAMERA_POSITIONS;
  if (tooFewViews) {
    lastError =
      `Segmentation could use only ${usableViews} of ${msg.silhouetteCameras} camera views, and a ` +
      `calibration needs at least ${MIN_CAMERA_POSITIONS}. The result was not applied. A refused ` +
      'view found no framed sphere in its photograph — reframe it, or add a position.';
  }
  if (!msg.converged || tooFewViews) {
    state.compositorRig = beforeRig ?? null;
    markDirty();
    requestModel(true);
    renderActions();
    renderReadout();
    return;
  }
  state.compositorRig = msg.recoveredRig;
  markDirty();
  requestModel(true);
  renderActions();
};

let solveSeq = 0;

/**
 * The frames as they were before the last recalibration, one per slot.
 *
 * Kept so the card can show what the solve rewrote. Cleared whenever the
 * calibration stops being the one these frames belong to — which is any lens
 * movement, and "Forget it".
 */
let beforeFrames: (FrameImage | null)[] = [];

/**
 * The seams as they were before the last recalibration, and which one the
 * picker is on.
 *
 * The seam index is a position in the ring, not a projector: switching one off
 * or changing the count re-forms the ring, so it is clamped where it is read
 * rather than tracked.
 */
let beforeSeams: SeamPatch[] = [];
let beforeMeshes: (WarpMesh | null)[] = [];

/**
 * The compositor calibration in force before the last recalibration — `null`
 * meaning the config as written, which is what it usually is.
 *
 * A rig rather than a picture, because the lightbox re-renders the "before"
 * frame at the size of the screen and a snapshot image could only ever be blown
 * up. `undefined` means there is nothing to compare against.
 */
let beforeRig: RigCalibration | null | undefined;
let seamPick = 0;

/**
 * The world the running solve is photographing, snapshotted when it starts.
 *
 * The capture previews are rendered from this rather than from live settings, so
 * a slider moved while the capture runs cannot redraw the photographs as a rig
 * the camera never saw.
 */
let solveWorld: { world: ReturnType<typeof buildWorld>; ceilingM: number } | null = null;

/**
 * Did this reply become the calibration in force?
 *
 * One predicate, because two call sites need the same answer and they used to
 * disagree: the handler decided whether to install, and the drift cells decided
 * separately whether to show the solver's residual. A residual shown for a rig
 * that was never installed is the same class of lie as installing it.
 */
function solveInstalled(r: SolveResponse): boolean {
  return r.converged && r.silhouetteCameras - r.silhouetteRefusals >= MIN_CAMERA_POSITIONS;
}

/**
 * The fewest camera positions a calibration is allowed to be attempted from.
 *
 * Not a judgement call: experiment 1 swept the count over five seeds and the
 * gap between one position and two is three orders of magnitude — median worst
 * lens error 17,490 mm at one against 41.8 mm at two, with a worst draw of
 * 1,978,378 mm. The knee is at three, so two is poor and one is not a
 * measurement at all.
 *
 * What makes one position DANGEROUS rather than merely bad is that nothing in
 * the answer says so. It converges — in 48 steps, to a residual of 0.518 px,
 * better than the three-camera solve beside it — and every diagnostic the
 * solver produces reads clean: `lastDeficiency` 0 (computed after LM damping,
 * so it cannot see this), `gaugeFreeAxes` the expected [false, false, true],
 * `cameraResidualScale` 1.03. The photographs really are explained. There is
 * simply more than one rig that explains them, because from a single viewpoint
 * a near projector zoomed in is indistinguishable from a far one zoomed out.
 *
 * So this is refused rather than warned about. A warning beside a number that
 * looks better than the good one is not a warning anybody acts on.
 */
export const MIN_CAMERA_POSITIONS = 2;

/**
 * Why this solve cannot be attempted, or `null`.
 *
 * Checked BEFORE the capture, because the answer is knowable before spending
 * ten seconds photographing a sphere to produce a rig that will be thrown away.
 */
function solveRefusalReason(cameraCount: number): string | null {
  if (cameraCount >= MIN_CAMERA_POSITIONS) return null;
  return (
    `A calibration needs at least ${MIN_CAMERA_POSITIONS} camera positions, and this capture has ` +
    `${cameraCount}. From one spot a projector close in and zoomed tight is indistinguishable ` +
    'from one far out and zoomed wide, so the solve converges to a clean residual and the answer ' +
    'is still metres out — experiment 1 measured a median worst-lens error of 17.5 m at one ' +
    'position against 41.8 mm at two. Move the camera and add a position.'
  );
}

function startSolve(): void {
  if (solveRunning) return;
  // Refused outright, not attempted and then judged. See MIN_CAMERA_POSITIONS.
  const refusal = solveRefusalReason(state.cameraCount);
  if (refusal !== null) {
    lastError = refusal;
    renderReadout();
    return;
  }
  solveRunning = true;
  solveTrace = [];
  solveStep = null;
  solveShots = [];
  solveResult = null;
  // Snapshot before the solve, not after: once the compositor rig is replaced
  // there is no way back to the frames it was generating.
  beforeFrames = (model?.projectorFrames ?? []).slice();
  beforeSeams = (model?.seams ?? []).slice();
  beforeMeshes = (model?.meshes ?? []).slice();
  beforeRig = state.compositorRig;
  solveWorld = {
    world: buildWorld(state.settings, state.compositorRig ?? undefined, suppliedImage()),
    ceilingM: state.settings.ceilingM,
  };
  solveStartedAt = performance.now();
  solveStage = 'Placing the cameras…';
  const raster = CAPTURE_RASTERS[state.cameraRes] ?? CAPTURE_RASTERS[0];
  const req: SolveRequest = {
    kind: 'solve',
    id: ++solveSeq,
    settings: state.settings,
    cameraCount: state.cameraCount,
    // Defaults to the bench's own 320×240, because every number this project has
    // published was measured there and the page and the report have to be
    // talking about the same capture. It is a choice now rather than a constant:
    // `scenarios.ts` says outright that it is coarser than a phone.
    cameraResX: raster.resX,
    cameraResY: raster.resY,
    handheld: state.handheld,
    sensorNoise: true,
    // The Room light slider, not a second constant beside it. `state.ambient`
    // was a private 0.04 that nothing could reach, so the slider washed the
    // sphere out on screen and the capture went on photographing a darker room
    // than the one being drawn — §5 `E_amb` having two values at once.
    ambient: state.settings.ambient,
    seed: (state.settings.errorSeed * 2654435761) % 2147483647,
    // The two workers hold their own caches, so this has its own "have you seen
    // it" flag. The solve does not read the image — a capture photographs Gray
    // code, not content — but the three camera previews are renders of the room,
    // and without it they showed a grey graticule while the sphere on screen was
    // showing Blue Marble.
    customImage:
      suppliedImage() !== null && suppliedName() !== solveSentImageId
        ? {
            width: suppliedImage()!.width,
            height: suppliedImage()!.height,
            data: suppliedImage()!.data,
          }
        : null,
    customImageId: suppliedName(),
  };
  solveSentImageId = suppliedName();
  solveWorker.postMessage(req);
  renderActions();
  renderReadout();
}

/**
 * Drop the calibration itself: the recovered geometry, the report, and the
 * comparison that went with them.
 *
 * Reachable three ways, and all of them are the operator saying so. "Forget it"
 * and "Reset" are buttons. Restoring a preset is the third: a preset is a different
 * INSTALLATION, and geometry solved for the old room is not a belief about the
 * new one — it is a wrong answer that would quietly survive the change.
 *
 * Moving a lens is NOT one of these. See `staleComparison`.
 */
function clearCalibration(): void {
  state.compositorRig = null;
  solveResult = null;
  solveTrace = [];
  solveStep = null;
  solveShots = [];
  staleComparison();
}

function forgetCalibration(): void {
  clearCalibration();
  markDirty();
  requestModel(true);
  renderActions();
}

/**
 * Moving a lens makes the last BEFORE/AFTER comparison stale. It does not make
 * the software forget where it thinks the lenses are.
 *
 * This used to null `state.compositorRig`, which reads as the same thing and is
 * not: null means "the config as written", so a bump after a recalibration
 * silently threw the recovered geometry away and reverted the compositor to the
 * drawing. That is the exact opposite of the point the page is making three
 * different ways — the projector tab's own text ("what the software believes
 * only changes when you recalibrate, which is why the frame below does not
 * move"), the help sheet's "bump it again and that frame does not change", and
 * the inspect caption's "moving the projector does not change this picture".
 * All three were true on the first lap and false on the second.
 *
 * So the belief survives, and so does the report of how it was arrived at. What
 * goes is the comparison: the frames, seams and meshes snapshotted at the start
 * of the last solve describe a rig that is no longer the one in the room, and
 * compositing them against the current pictures would put a red/cyan overlay
 * under a caption that blames the recalibration for a movement the operator
 * just made by hand.
 */
/**
 * Throw away the before/after FRAMES.
 *
 * They are pixels, rendered from whatever was playing at the start of the last
 * solve, so changing what is playing makes them a picture of something else.
 * Change the base field after a solve and the card composited an old-content
 * "before" against a new-content "after": every graticule line saturated red
 * against a blue marble, under a caption blaming the recalibration for it.
 *
 * Only the frames. A seam diagram is grid lines projected through two rigs and
 * does not care what is playing behind them, and that comparison is the clearest
 * thing the page draws — dropping it because somebody switched the sphere to
 * grey would be throwing away the demonstration to fix the picture beside it.
 */
function staleFrames(): void {
  beforeFrames = [];
  beforeRig = undefined;
}

/**
 * Throw away every before/after snapshot, frames and geometry alike.
 *
 * For changes that move the lines themselves: the graticule's spacing, or
 * turning it off. The seam diagram IS those lines.
 */
function staleSnapshots(): void {
  staleFrames();
  beforeSeams = [];
  beforeMeshes = [];
}

/**
 * The rig itself moved: every snapshot goes, and so does the claim that the
 * solver's residual still describes the room. See `rigMovedSinceSolve`.
 */
function staleComparison(): void {
  staleSnapshots();
  rigMovedSinceSolve = true;
}

/**
 * Has a lens moved since the last solve finished?
 *
 * The solver's own residual is the better number for "how far has the software
 * fallen behind" — it has the unobservable global rotation removed, which the
 * live two-rig difference cannot do. But it is a number about the rig the solve
 * PHOTOGRAPHED, and now that a bump no longer discards the solve, that rig and
 * the one in the room stop being the same thing. Reporting 0.14 mm of lens error
 * next to a headline that just jumped to 66 mm is the same class of lie this
 * whole change set is about.
 *
 * Not cleared when a result lands mid-movement: a bump while the solve is in
 * flight leaves this true, which is right — the reply describes a rig the
 * operator has already moved.
 */
let rigMovedSinceSolve = false;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let dirty = true;
/**
 * The `droppedMeshId` the display shader was last handed, or `-1` for the sphere.
 *
 * Written by `draw` and read by the model card's caption, which is a claim about
 * the picture beside it and so must be answered by the picture rather than by
 * the page's intent.
 */
let drawnMeshId = -1;

/** Frames actually drawn. See `canvas.dataset.draws`. */
let drawCount = 0;

/**
 * The model named by the last {@link ModelRequest}, so a surface reply can tell
 * "the shape changed under the verdict" from "the same shape recomputed".
 */
let parityMeshIdAsked = '';

/**
 * The `droppedMeshId` the shader refused, or -1.
 *
 * `packMesh` throws on a hierarchy deeper than the shader's traversal stack, and
 * the page then draws the sphere. This is how {@link displayMeshId} knows to say
 * so rather than keep naming a model the shader never received.
 */
let rejectedMeshId = -1;

function markDirty(): void {
  dirty = true;
}

function ensureContent(image: { width: number; height: number; data: Float32Array }): void {
  // A playing video OWNS the content texture: it is written every frame by the
  // decode pass, and `world.image` here is the snapshot the model was given,
  // which is a tenth of a second behind. Uploading it would drop the sphere back
  // to the last settled frame on every draw, which reads as a stutter nobody can
  // account for.
  if (videoActive()) {
    // The key has to go with it. The video decode pass writes the SAME texture
    // this key describes, so leaving the key naming the still that was there
    // before means switching back to that still is a cache HIT: no re-upload,
    // and the sphere keeps showing the video's last decoded frame while the chip
    // row says Blue Marble. Every other place that invalidates the key does it
    // by hand — loadMarble, loadCustomImage, stopVideo, loadCustomVideo, Remove
    // — and this path was the one that was missed.
    contentKey = '';
    return;
  }
  const key = `${state.settings.gridDeg}|${state.settings.content}|${state.settings.gridOn}|${suppliedName()}`;
  if (gl && key !== contentKey) {
    // The decode target holds the content texture at the VIDEO's raster and a
    // framebuffer pointing at it. Uploading a still re-specifies that texture at
    // a different size behind the framebuffer's back, so the target goes first
    // and is rebuilt from scratch if the reader switches back.
    if (gl.video) releaseVideoTarget(gl);
    uploadEquirect(gl, image);
    contentKey = key;
  }
}

/**
 * Lens marker radius, metres. Roughly the size of a projector's front element at
 * this scale — large enough to see across a 5 m room and to hit with a mouse,
 * small enough that it does not read as an object the light comes out of the
 * middle of.
 */
/**
 * A visitor's eye off the floor, metres.
 *
 * The same 1.5 m `pipeline.ts` stands its capture cameras at, and for the same
 * reason: it is where a person's head is, whatever the room is doing.
 */
const VISITOR_EYE_M = 1.5;

const MARKER_RADIUS_M = 0.12;

/**
 * The uniforms of the last on-screen frame, kept so a click can be turned into a
 * projector. It is the drawn state, not a recomputed one: picking against a
 * freshly built camera would drift from what the viewer is looking at during the
 * frame a drag ends on.
 */
let lastUniforms: DisplayUniforms | null = null;

/**
 * Which panel slot each projector in `lastUniforms` came from, kept beside them
 * because the uniforms themselves are indexed by the rig and a rig omits every
 * projector that is switched off.
 */
let lastSlots: readonly number[] = [];

function draw(): void {
  if (!gl) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  // The video first, so the uniforms below are built for the frame that is
  // about to be drawn rather than the one before it.
  if (videoAdvanced() && customVideo) {
    uploadVideoFrame(gl, customVideo, videoRaster.width, videoRaster.height);
    lastVideoTime = customVideo.currentTime;
    // The model is holding the black placeholder `loadCustomVideo` left it until
    // a frame has been through the GPU — and the passes it asked for at load ran
    // BEFORE this, when there was no decode target to read back from. So the
    // first frame asks for its own pass. Once one has landed the interval above
    // takes over, and this cannot fire again.
    if (videoFrameSeq === 0) requestModel(true);
  }

  const world = buildWorld(state.settings, state.compositorRig ?? undefined, suppliedImage());
  ensureContent(world.image);
  const camera = buildViewer(state.settings, w, h, viewShiftFrac());
  // The dropped model, if there is one. Until this the live view drew a sphere
  // whatever the reader had loaded -- the CPU picture on the model card was the
  // only place the shape appeared, and the view beside it was lying about it.
  const model = displayModel(world);
  const uniforms = buildDisplayUniforms(
    model.physical,
    model.content,
    world.scene,
    camera,
    {
      mesh: model.mesh,
      overlay: state.overlay,
      highlight: state.highlight,
      slots: world.slots,
      drawFloor: true,
      floorRadiusM: 13,
      displayGamma: 2.2,
      // Display only. `checkParity` builds its own uniforms and passes neither,
      // so what the parity check reads back is the model's own radiance.
      exposure: state.settings.viewExposure,
      lift: state.settings.viewLift,
      samplesPerPixel: paritySamples(),
      markerRadiusM: state.markersOn ? MARKER_RADIUS_M : 0,
      markerSelected: state.selected,
      ceilingM: state.settings.ceilingM,
      // The same switch that puts the room in the capture puts it on screen, so
      // the picture and the photograph agree about whether a room exists.
      roomOn: state.settings.roomSpill === 1,
      wallRadiusM: state.settings.wallRadiusM,
      rail: state.railOn,
      aimGuides: state.aimGuides,
    },
  );
  lastUniforms = uniforms;
  lastSlots = world.slots;
  // Test hooks, set by the function that draws so they cannot describe a state
  // the picture is not in. `tools/smoke-app.ts` clicks a marker it found by
  // colour and reads these back.
  canvas.dataset.selected = String(state.selected);
  canvas.dataset.highlight = String(state.highlight);
  // The camera, so a test can assert that a pinch actually moved it rather than
  // that the page merely survived one.
  canvas.dataset.range = state.settings.viewRangeM.toFixed(3);
  canvas.dataset.az = state.settings.viewAzDeg.toFixed(2);
  // What the SHADER was handed, which is not the same question as what the page
  // is holding. A dropped model that never reached the display uniforms looks
  // exactly like one that did -- the model card renders on the CPU either way --
  // so a test that only reads the card would have gone on passing through the
  // entire time the live view was still drawing a sphere. Read off `uniforms`
  // rather than off `droppedMesh` for that reason.
  canvas.dataset.meshTriangles = String(uniforms.mesh?.triangleCount ?? 0);
  // What the shader was actually GIVEN, recorded at the moment it was given it.
  // `displayMeshId()` answers "is there a model that has not been rejected",
  // which is a different question and is true too early: `setDroppedMesh` clears
  // `rejectedMeshId` and calls `markDirty()`, which SCHEDULES a repaint, while
  // `rejectedMeshId` is not set until `displayModel` runs inside this function.
  // A caption reading the former between those two moments claims the GPU is
  // tracing a model that has neither been drawn nor been vetted by `packMesh`.
  drawnMeshId = uniforms.mesh === null ? -1 : droppedMeshId;
  // Monotonic, so a test can tell "the frame loop stopped" from "it ran and saw
  // no model". `frame()` catches a throw from here, calls `fatal()` and does NOT
  // re-arm `requestAnimationFrame`, so those two failures look identical from
  // outside and need opposite fixes.
  canvas.dataset.draws = String(++drawCount);
  drawToCanvas(gl, uniforms, w, h);
}

/**
 * One capture camera's view of the room, as a picture.
 *
 * This is what an operator's photograph would actually contain: the sphere, the
 * projectors on their hangers, the guard rail they are standing behind, the
 * floor. The CPU renderer in `packages/sim` draws none of that — deliberately,
 * because none of it is in the model — so these are rendered by the DISPLAY
 * shader instead, which is the one that knows about furniture.
 *
 * Which makes the caption under them load-bearing, and it says so: the room is
 * in the picture and is NOT in the capture. The solver's input is structured
 * light on a sphere, from a forward model where nothing occludes a beam, emits
 * light or casts a shadow. A visitor who thinks the rail is being photographed
 * would draw the wrong conclusion about what the solve had to work with.
 *
 * Rendered from the rig the solve is PHOTOGRAPHING rather than from live
 * settings: a slider moved while the capture runs would otherwise redraw the
 * photographs as a rig the camera never saw.
 */
function renderCameraShot(
  camera: { id: string; position: { x: number; y: number; z: number }; fovHDeg: number },
  width: number,
): FrameImage | null {
  if (!gl || !solveWorld) return null;
  const w = Math.max(16, Math.round(width));
  const h = Math.max(1, Math.round((w * 3) / 4));
  const { world, ceilingM } = solveWorld;
  // Deliberately NOT `displayModel`: these are the solve's own shots, and the
  // solve runs on the sphere. Phase 5 is where a model reaches it, and handing
  // the shader one here would show the reader a picture of geometry the solver
  // behind it never considered.
  const uniforms = buildDisplayUniforms(
    prepareRig(world.truthRig),
    prepareRig(world.compositorRig),
    world.scene,
    {
      position: camera.position,
      target: { x: 0, y: 0, z: 0 },
      upHint: { x: 0, y: 0, z: 1 },
      fovHDeg: camera.fovHDeg,
      width: w,
      height: h,
    },
    {
      slots: world.slots,
      drawFloor: true,
      floorRadiusM: 13,
      displayGamma: 2.2,
      // The same grade the sphere on screen is under, so a capture preview and
      // the room behind it are not two different-looking pictures of one rig.
      exposure: state.settings.viewExposure,
      lift: state.settings.viewLift,
      // The room, as photographed. No selection ring and no aim guides: those
      // are the page talking to you, not things in front of a lens.
      markerRadiusM: MARKER_RADIUS_M,
      markerSelected: -1,
      ceilingM,
      rail: true,
      aimGuides: false,
    },
  );
  const image = renderAndRead(gl, uniforms, w, h);
  return {
    width: image.width,
    height: image.height,
    data: image.data,
    caption: `${camera.id} — where the camera stood`,
    // `displayGamma: 2.2` above means the read-back is already encoded.
    space: 'display',
  };
}

/** How wide the capture thumbnails are rendered. They display at about 120. */
const SHOT_THUMB_PX = 480;

/**
 * The dropped model as the display path needs it, or the sphere.
 *
 * ## Why this is memoised and `prepareRig` on a sphere is not
 *
 * `draw()` runs on every animation frame. On a sphere `prepareRig` is a few
 * dozen multiplications -- `blendModelApplies` is true, so `buildFootprints`
 * never runs -- and rebuilding it per frame is cheaper than deciding not to. On
 * a model none of that holds: `meshSurface` builds a bounding volume hierarchy,
 * `prepareRig` walks it once per projector to build footprints, and `packMesh`
 * walks it again to lay out the textures. Doing that sixty times a second would
 * turn a drag of the exposure slider into a slideshow.
 *
 * Two levels, because the two costs have different lifetimes. The GEOMETRY
 * depends only on which file was dropped, so it survives every slider. The
 * prepared rigs and the packed field depend on the calibration as well, so they
 * are keyed on it too -- structurally, because `buildWorld` returns fresh
 * objects every frame and an identity check would never hit. This mirrors what
 * `packages/web/src/model.ts` already does inside the worker.
 *
 * ## One surface object, deliberately
 *
 * Both rigs are prepared on the SAME `MeshSurface`. `buildDisplayUniforms`
 * refuses anything else, and its reason is the whole design: the shader has one
 * hierarchy and both of its traces read it.
 *
 * ## Why a model that will not fit returns the sphere instead of throwing
 *
 * `packMesh` refuses a hierarchy deeper than the shader's traversal stack, and
 * that refusal used to reach `frame()`, which calls `fatal()` and then returns
 * WITHOUT re-arming `requestAnimationFrame`. The page would not have rendered
 * the model wrong; it would have stopped rendering at all, permanently, over a
 * file the reader could simply have replaced. The refusal now lands in
 * `meshError`, which the model card already shows, and the view stays on the
 * sphere it was drawing before.
 */
let displayModelCache: {
  meshId: number;
  surface: MeshSurface;
  rigKey: string;
  physical: PreparedRig;
  content: PreparedRig;
  mesh: DisplayMesh | null;
} | null = null;

interface DisplayModel {
  physical: PreparedRig;
  content: PreparedRig;
  mesh: DisplayMesh | null;
}

function displayModel(world: WebWorld): DisplayModel {
  // The sphere path, untouched and uncached. Every phase of this work has opened
  // by asserting the sphere renders byte-identically to what it did before, and
  // the cheapest way to keep that true is for the sphere not to enter the new
  // code at all.
  if (droppedMesh === null) {
    return {
      physical: prepareRig(world.truthRig),
      content: prepareRig(world.compositorRig),
      mesh: null,
    };
  }

  const rigKey = JSON.stringify([world.truthRig, world.compositorRig]);
  const hit = displayModelCache;
  if (hit !== null && hit.meshId === droppedMeshId && hit.rigKey === rigKey) {
    return { physical: hit.physical, content: hit.content, mesh: hit.mesh };
  }

  // The surface outlives the calibration: a slider moves the rig, not the model.
  const surface =
    hit !== null && hit.meshId === droppedMeshId ? hit.surface : meshSurface(droppedMesh);
  const physical = prepareRig(world.truthRig, surface);
  const content = prepareRig(world.compositorRig, surface);
  let mesh: DisplayMesh | null;
  try {
    // The CONTENT rig, which is whose blend the shader needs; see `packMesh`.
    mesh = packMesh(content);
  } catch (err) {
    // Reported where the reader is already looking for what became of their
    // file, and the sphere keeps drawing. See the note above on `fatal()`.
    meshError = err instanceof Error ? err.message : String(err);
    displayModelCache = null;
    // And the page must now SAY it is drawing a sphere. `displayMeshId()` still
    // named this model, so `checkParity`'s handshake would have compared the
    // worker's picture OF THE MODEL against this sphere and passed the check
    // that exists to stop exactly that -- printing a total disagreement between
    // two renderers that were handed different shapes. Recording the rejection
    // is what keeps the two answers to "what is on screen" the same answer.
    rejectedMeshId = droppedMeshId;
    parity = null;
    renderControls();
    return {
      physical: prepareRig(world.truthRig),
      content: prepareRig(world.compositorRig),
      mesh: null,
    };
  }
  displayModelCache = { meshId: droppedMeshId, surface, rigKey, physical, content, mesh };
  return { physical, content, mesh };
}

/**
 * The model this page is DRAWING, by the name the worker knows it by. `''` is the
 * sphere. See `ModelRequest.meshId`.
 *
 * Not "the model that was dropped": `displayModel` falls back to the sphere when
 * `packMesh` refuses a hierarchy deeper than the shader's stack, and a page that
 * kept claiming the model then would have the parity check compare a picture of
 * the model against a picture of the sphere and report it as a renderer bug.
 */
function displayMeshId(): string {
  if (droppedMesh === null || droppedMeshId === rejectedMeshId) return '';
  return `mesh:${droppedMeshId}`;
}

function checkParity(
  cpu: { width: number; height: number; data: Float32Array },
  cpuMs: number,
  cpuMeshId: string,
): void {
  if (!gl) return;
  if (viewKey() !== parityRequestKey) {
    parity = null;
    return;
  }
  // Both renderers must have drawn the same SHAPE, and only the worker can say
  // which one it drew: it traces the model it is holding, and the
  // `SurfaceRequest` carrying a freshly dropped file may not have reached it
  // yet. Comparing a model against a sphere would disagree at essentially every
  // lit pixel and print a catastrophic renderer bug that is really two pictures
  // of different objects. The check going quiet for a pass or two while the
  // worker catches up is the cheaper mistake, and it is self-clearing.
  if (cpuMeshId !== displayMeshId()) {
    parity = null;
    return;
  }
  try {
    const world = buildWorld(state.settings, state.compositorRig ?? undefined, suppliedImage());
    // Not merely defensive: a worker reply that landed before the first animation
    // frame would find the content texture never uploaded, and an incomplete
    // texture samples as black — indistinguishable from the shader getting the
    // model wrong. `ensureContent` is a no-op when it is current.
    ensureContent(world.image);
    const camera = buildViewer(state.settings, cpu.width, cpu.height, viewShiftFrac());
    const model = displayModel(world);
    const uniforms = buildDisplayUniforms(
      model.physical,
      model.content,
      // NO GRATICULE, on this side and on the worker's. `packages/web/src/model.ts`
      // drops it from the CPU half of this same comparison and the two must agree;
      // `uGridDeg <= 0` is what switches it off in the shader.
      //
      // It is dropped because it is the one term in this picture that a real
      // driver cannot be held to. Measured on an NVIDIA RTX 4090 Laptop GPU
      // (driver 32.0.16.1088): with the graticule off the two renderers agree to
      // 4.6e-4, 4.3 times under tolerance, on a photographic texture AND on a flat
      // field. With it on, 1-3% of lit pixels go over, the worst by 11x, and it
      // gets worse the further the camera is from the sphere.
      //
      // The graticule is computed in ANGLE space from the ray-sphere hit, so a
      // float32 error in that hit becomes an angular error divided by
      // cos(incidence) -- and then meets `graticuleCoverage`'s steep edge. Far
      // views show more grazing surface per pixel, which is exactly the reported
      // pattern. Nothing here can fix it: GLSL ES guarantees only a few ULP for
      // sin/cos/atan and drivers ship approximations, so this measures the
      // driver's trigonometry rather than this project's model.
      //
      // What is given up is bounded, and link (2) already covers it: whether the
      // shader's graticule is the same FORMULA as the model's is checked
      // function-for-function against `packages/harness/src/reference.ts`. What
      // this pass is for -- that a driver compiled the light transport into the
      // arithmetic the model describes -- is untouched, and agrees.
      { ...world.scene, graticule: null },
      camera,
      // No floor, no overlay and NO EXPOSURE: `renderTwoRigRoomView` has none of
      // the three, so passing any of them here would make the parity number
      // measure a difference in settings rather than a disagreement between two
      // renderers. Exposure defaults to 1 by omission, which is the whole reason
      // the viewing gain can exist without touching this check. The cost is that
      // `shadeFloor` — its occlusion test and the room albedo — is the one part
      // of the shader this check does not cover.
      //
      // The sample count IS passed, and it is the one display setting that must
      // be: the CPU image that just arrived was rendered on the same grid, and a
      // shader reading a different one would report the difference as a model
      // disagreement. `viewKey` carries it for exactly that reason.
      {
        // The same model the CPU side traced, checked above. Without this the
        // shader would draw the sphere while the worker drew the model.
        mesh: model.mesh,
        overlay: 'none',
        highlight: -1,
        drawFloor: false,
        displayGamma: 0,
        samplesPerPixel: paritySamples(),
        slots: world.slots,
      },
    );
    // The frame the worker was given, not the one on screen. With a video
    // playing the live texture is a tenth of a second further on, and comparing
    // against it would report the video's own motion as a disagreement between
    // two renderers. `withFrozenContent` is a no-op when there is no video.
    let gpu!: ReturnType<typeof renderAndRead>;
    withFrozenContent(gl, () => {
      gpu = renderAndRead(gl!, uniforms, cpu.width, cpu.height);
    });
    parity = judgeParity(gpu, { width: cpu.width, height: cpu.height, data: cpu.data }, {
      // The scene's own three numbers, not a constant. `ambient` is a slider and
      // the check must not count a pixel that only ambient reaches -- such a
      // pixel agrees by construction and would dilute the denominator until a
      // misaligned rig read as an aligned one. See `parity.ts` LIT_THRESHOLD.
      ambientFloor: ambientFloorOf(
        world.scene.ambient,
        world.scene.reflectance,
        world.scene.roomAlbedo,
      ),
      floatReadback: gpu.float,
      cpuMs,
    });
  } catch (err) {
    parity = null;
    lastError = err instanceof Error ? err.message : String(err);
  }
  markDirty();
}

function frame(): void {
  // A video that is not on the sphere is a decoder running for nothing, and on a
  // phone that is the battery. The content chips can switch away from it at any
  // time, so the play state follows what is being shown rather than being
  // toggled at each of the places that can change it.
  if (customVideo) {
    const wanted = videoActive();
    if (wanted && customVideo.paused) void customVideo.play().catch(() => {});
    else if (!wanted && !customVideo.paused) customVideo.pause();
  }
  // A playing video is the one thing on this page that changes without anybody
  // touching it. Gated on the clock rather than repainting every animation
  // frame: a 30 fps file then costs thirty draws a second and not sixty, and a
  // paused or buffering one costs none.
  if (videoAdvanced()) dirty = true;
  if (dirty) {
    dirty = false;
    try {
      draw();
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
      return;
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

let settleTimer = 0;

function touched(invalidates: boolean): void {
  if (invalidates) staleComparison();
  clampSelection();
  markDirty();
  // Not while a slider is held: see `sliderDragging`. The row paints itself and
  // the rest of the panel catches up when the pointer comes up.
  if (!sliderDragging) renderControls();
  // The bar reads the projector count for its "Bump all N" label and the
  // calibration for whether "Forget it" is there, and both of those move under
  // it. It is five buttons — cheaper than the thirty rows above it.
  renderActions();
  renderReadout();
  requestModel(false);
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => requestModel(true), 260);
}

/**
 * Keep the selection inside the rig that exists.
 *
 * The projector count is a slider. Dragging it from four down to two left the
 * Projectors tab editing P4 and the card describing P4 — a projector that had
 * stopped being in the room, whose sliders wrote into a slot nothing read and
 * whose frame was the last one drawn before it vanished.
 */
function clampSelection(): void {
  const last = Math.max(0, Math.round(state.settings.projectorCount) - 1);
  if (state.selected > last) state.selected = last;
  if (state.highlight > last) state.highlight = last;
}

function setSetting(key: SettingKey, value: number): void {
  // Which projectors EXIST is not a movement, it is a different installation:
  // the four redistribute round the ring the moment the count changes, so a rig
  // recovered for four is not a belief about three. It also has to go for a
  // blunter reason — the recovered rig is a flat list indexed alongside the lit
  // set, and changing the membership slides the two out of step.
  if (key === 'projectorCount') clearCalibration();
  state.settings = withSetting(state.settings, key, value);
  const spec = CONTROLS.find((c) => c.key === key);
  // What is PLAYING moves no lens, so it must not touch the calibration or the
  // solver's residual — but the before/after pictures were rendered from it, and
  // comparing a graticule against a blue marble is a red smear with a caption
  // blaming the solve for it. Moving the eye is exempt: the frames are the
  // projector's output, not the view of it.
  if (key === 'content') staleFrames();
  else if (key === 'gridOn' || key === 'gridDeg') staleSnapshots();
  touched(spec ? spec.group !== 'view' : true);
}

function setNudge(key: NudgeSpec['key'], value: number): void {
  state.settings = withNudge(state.settings, state.selected, { [key]: value });
  touched(true);
}

const SECTIONS: { id: SectionId; label: string; title: string }[] = [
  { id: 'projectors', label: 'Projectors', title: 'The lenses, one at a time' },
  { id: 'install', label: 'Install', title: 'The installation' },
  // A heading's job is to say what is underneath it, and what is underneath it
  // has moved. "Seams, mask and the view" named a term — mask — that no visible
  // sentence on the page defines; "Seams, the polar hole and where you stand"
  // then led on the one block that is now last and behind a caret.
  { id: 'room', label: 'Room', title: 'What is on the ball, and how you look at it' },
];

function sectionTabs(): HTMLElement {
  const seg = el('div', { className: 'seg' });
  for (const s of SECTIONS) {
    const b = el('button', { className: state.section === s.id ? 'on' : '', textContent: s.label });
    b.addEventListener('click', () => {
      state.section = s.id;
      renderControls();
    });
    seg.append(b);
  }
  return seg;
}

function projectorTabs(): HTMLElement {
  const row = el('div', { className: 'ptabs' });
  const n = Math.round(state.settings.projectorCount);
  for (let i = 0; i < n; i++) {
    const on = state.settings.nudge[i]?.on !== false;
    const selected = state.selected === i;
    const b = el('button', {
      className: `${selected ? 'on' : ''}${on ? '' : ' dark'}`,
      // This tab is now the ONLY switch, so its tooltip carries the whole state
      // rather than pointing at a labelled control underneath it.
      title: !selected
        ? on
          ? `Edit P${i + 1}. Click it again to switch it off at the wall.`
          : `P${i + 1} is switched off at the wall. Select it, then click again to switch it back on.`
        : on
          ? 'Click again to switch it off at the wall — its quadrant of the framebuffer goes dark.'
          : 'Switched off at the wall — its quadrant of the framebuffer is dark. Click to switch it back on.',
    });
    const dot = el('span', { className: 'dot' });
    dot.style.background = PROJECTOR_TINTS[i] ?? '#888';
    b.append(dot, el('span', { textContent: `P${i + 1}` }));
    // First click selects, second click switches it off at the wall.
    //
    // There used to be a labelled On / "Off at the wall" pair under these tabs
    // as well, on the argument that switching a projector off is a change to the
    // installation and deserves a control that says which state it is in. It
    // does — but the tab already says it, twice: it is struck through and it
    // carries a warning border, which is what the CSS beside `.ptabs
    // button.dark` is for. Two controls for one action, one under the other,
    // reads as a mistake rather than as care.
    //
    // Clicking a lens in the ROOM still never toggles: an accidental
    // double-click on the sphere should not change the installation.
    b.addEventListener('click', () => {
      if (!selected) {
        selectProjector(i);
        return;
      }
      // Switching one off changes the MEMBERSHIP of the rig, not a lens's
      // position, and the recovered rig is indexed alongside the lit set — so
      // it has to go with it. See `setSetting`.
      clearCalibration();
      state.settings = withNudge(state.settings, i, { on: !on });
      touched(true);
    });
    row.append(b);
  }
  return row;
}

function projectorSection(): HTMLElement[] {
  const out: HTMLElement[] = [projectorTabs()];
  out.push(
    el('p', {
      className: 'grouphelp',
      textContent:
        'Pick a projector to move it — here, or by clicking its lens in the room. These are its ' +
        'real position and aim; what the software believes only changes when you recalibrate, ' +
        'which is why the frame below does not move when you drag these. Click the tab of the ' +
        'projector you are already on to switch it off at the wall, and again to switch it back; ' +
        'a struck-through tab is a dark quadrant.',
    }),
  );
  const nudge = state.settings.nudge[state.selected];
  const tint = PROJECTOR_TINTS[state.selected] ?? '#888';
  const live = model?.live[state.selected] ?? true;
  if (!live) {
    const off = el('p', {
      className: 'grouphelp',
      textContent:
        `P${state.selected + 1} is switched off at the wall. Its quadrant of the framebuffer is ` +
        'dark and the framebuffer keeps its size — PARAMETERS.md §2\u2019s "quadrants go dark". ' +
        'The sphere loses that share of its light entirely, and the neighbours do not widen to ' +
        'cover the gap; watch the unlit figure. Click its tab above to switch it back on. This is ' +
        'the only control on the page that does it.',
    });
    off.style.color = 'var(--warn)';
    out.push(off);
  }
  for (const spec of NUDGE_CONTROLS) {
    out.push(
      slider({
        label: spec.label,
        value: nudge?.[spec.key] ?? 0,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        decimals: spec.decimals,
        unit: spec.unit,
        // The phase gate is a property of the phase, not of the run: a control
        // whose constants nobody has measured says so on the control, not only in
        // whatever it eventually moves.
        help: spec.provisional ? `PROVISIONAL — ${spec.help.replace(/^PROVISIONAL\. /, '')}` : spec.help,
        klass: spec.provisional ? 'ASSUME' : undefined,
        tint,
        bipolar: !spec.provisional,
        onInput: (v) => setNudge(spec.key, v),
        readBack: () => state.settings.nudge[state.selected]?.[spec.key] ?? 0,
        onSettle: () => requestModel(true),
      }),
    );
    // Turning the whole rig down to see how a dim install reads meant selecting
    // each projector in turn and dragging the same slider four times.
    if (spec.key === 'lumens' || spec.key === 'blackPct') {
      const all = el('button', {
        className: 'linkish',
        textContent: `give all ${Math.round(state.settings.projectorCount)} this ${spec.label.toLowerCase()}`,
      });
      all.addEventListener('click', () => {
        const v = nudge?.[spec.key] ?? 0;
        // The projectors in the ROOM, not every slot in the array: the label
        // already says "all 3", and writing the other slot too left a value
        // waiting to appear the moment the count went back up.
        const n = Math.round(state.settings.projectorCount);
        let next = state.settings;
        for (let i = 0; i < Math.min(n, next.nudge.length); i++) {
          next = withNudge(next, i, { [spec.key]: v });
        }
        state.settings = next;
        touched(true);
      });
      out.push(all);
    }
  }
  return out;
}

/**
 * Sliders for a set of groups.
 *
 * `skip` exists because a few controls read better as chips — a choice from a
 * list should not look like a continuum, since a slider implies the values in
 * between are real. Those are rendered by their section and named here so they
 * cannot also appear as a slider.
 */
/**
 * One control's slider, from its spec.
 *
 * Lifted out of `controlsFor` so a tab can also lay controls out by NAME. The
 * two orders are not the same question: `GROUPS` says what a control is about,
 * and a panel is ordered by how often it is reached for.
 */
function sliderFor(spec: (typeof CONTROLS)[number]): HTMLElement {
  return slider({
    label: spec.label,
    symbol: spec.symbol,
    value: state.settings[spec.key],
    min: spec.min,
    max: spec.max,
    step: spec.step,
    decimals: spec.decimals,
    unit: spec.unit,
    displayScale: spec.displayScale,
    options: spec.options,
    // The section is a TAG beside the label, not the first word of the
    // sentence: the one surface built to be plain language used to open
    // every note with a document symbol — and for a control whose section
    // is '—' it opened with a bare dash and no referent.
    help: spec.help,
    section: spec.section,
    klass: spec.klass,
    bipolar: spec.min < 0 && spec.max > 0,
    onInput: (v) => setSetting(spec.key, v),
    readBack: () => state.settings[spec.key],
    onSettle: () => requestModel(true),
  });
}

/**
 * Named controls, in the order asked for, with no group heading.
 *
 * The Room tab needs this because its groups and its usage do not line up:
 * `view` holds both the display terms somebody touches on every look and the
 * camera sliders that restate a drag, and `blend` holds four constants nobody
 * moves twice. Sorting a tab by frequency means naming the controls, and naming
 * them here rather than reshuffling `GROUPS` keeps the data saying what each
 * control is ABOUT — which is what the Install and Projectors tabs read it for,
 * and what the readout's provenance tags mean.
 */
function controlsByKey(keys: readonly SettingKey[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const key of keys) {
    const spec = CONTROLS.find((c) => c.key === key);
    // Silent omission would be a control that vanished from the panel while
    // every test that only counts sliders carried on passing.
    if (!spec) throw new Error(`no control declared for '${key}'`);
    out.push(sliderFor(spec));
  }
  return out;
}

/**
 * A heading that opens and shuts what follows it.
 *
 * `#controls` is rebuilt wholesale on every change, so a native
 * `<details>` would snap closed under the reader on each keystroke. The open
 * state therefore lives in `PageState` and is remembered, exactly as the
 * "what do these do?" notes are.
 */
function disclosure(title: string, open: boolean, onToggle: () => void): HTMLElement {
  const b = el('button', {
    className: open ? 'lab discl on' : 'lab discl',
    // A real caret rather than a rotating glyph: it has to read as
    // open-or-shut at 11px on a phone.
    textContent: `${open ? '\u25be' : '\u25b8'}  ${title}`,
    title: open ? 'Put these away' : 'Show these',
  });
  b.setAttribute('aria-expanded', open ? 'true' : 'false');
  b.addEventListener('click', onToggle);
  return b;
}

function controlsFor(groups: readonly string[], skip: readonly SettingKey[] = []): HTMLElement[] {
  const out: HTMLElement[] = [];
  // Group by group, in the order GROUPS declares, with each group's authored
  // title above it. Iterating CONTROLS in declaration order instead produced one
  // flat run of eight sliders on the Install tab with the ceiling height wedged
  // between two lens controls, and appended "What went wrong" — a different
  // group with a different meaning — to the end of it with nothing said.
  for (const g of GROUPS) {
    if (!groups.includes(g.id)) continue;
    const specs = CONTROLS.filter((c) => c.group === g.id && !skip.includes(c.key));
    if (specs.length === 0) continue;
    out.push(el('span', { className: 'lab', textContent: g.title }));
    out.push(el('p', { className: 'grouphelp', textContent: g.blurb }));
    for (const spec of specs) out.push(sliderFor(spec));
  }
  return out;
}

function installSection(): HTMLElement[] {
  const out: HTMLElement[] = [];
  // The one paragraph in the panel that is not gated on the notes toggle: it
  // says what rig every number below it describes, and a first-time reader who
  // has not found the toggle needs that more than anyone.
  out.push(
    el('p', {
      className: 'note',
      textContent:
        "Everything here starts at the NOAA Boulder reference install — four BenQ LK935 projectors " +
        'on a 68-inch sphere, 211 inches out and 8 inches above an 84-inch equator, from that ' +
        "theatre's own sos_stream_control.config. That config disagrees with this project's " +
        'specification on three constants; amendment A-36 is open and nothing has been applied to it.',
    }),
  );

  const presets: { label: string; s: Settings; title: string }[] = [
    { label: 'Boulder', s: BOULDER_PRESET, title: "the site's own config (A-36)" },
    { label: 'PARAMETERS.md', s: SPEC_PRESET, title: '§1 and §2 as documented' },
    { label: 'Perfect mount', s: PERFECT_PRESET, title: 'Boulder with zero mount error' },
  ];
  out.push(
    chipRow(
      presets.map((p) => ({
        label: p.label,
        title: p.title,
        // Lit when the install matches, which is a comparison over the install
        // keys only. These chips could never light up before, so the panel
        // never said which of the three rigs you were looking at.
        on: matchesInstall(state.settings, p.s),
        onPick: () => {
          // A preset is an INSTALL, not a viewpoint and not a choice of what is
          // playing. Spreading the whole struct also teleported the camera back
          // across the room and switched the sphere off a dropped-in image, so
          // "restore Boulder" after walking in to look at a seam threw away two
          // things nobody asked it to touch.
          // Carried by GROUP, not by a hand-written list. The list held seven of
          // the ten keys `CONTROLS` puts in group 'view', so picking a preset
          // silently reset the graticule spacing, the edge smoothing and the
          // black lift — under a caption promising it leaves the viewpoint and
          // what is playing alone. `matchesInstall` skips exactly the view keys,
          // so the chip lit up as matching while having changed three of them.
          let next: Settings = { ...p.s, nudge: p.s.nudge.map((n) => ({ ...n })) };
          for (const c of CONTROLS) {
            if (c.group !== 'view') continue;
            // Through `withSetting`, because some of these are bounded against
            // keys the preset DOES change. `viewRangeM`'s floor tracks
            // `sphereDiaIn`: carried across verbatim, a range that was legal
            // beside a small ball survives beside a bigger one and the eye ends
            // up inside the shell, which renders as the room seen from within.
            next = withSetting(next, c.key, state.settings[c.key]);
          }
          state.settings = next;
          clearCalibration();
          markDirty();
          renderControls();
          renderActions();
          requestModel(true);
        },
      })),
      'The three rigs this project can be asked to simulate. They differ in the sphere, the mount ' +
        'and the lens — not in where you are standing or what is playing, which is why picking one ' +
        'leaves both alone.',
    ),
  );

  // Resolution and projector count read better as chips than as a slider: they
  // are choices from a list, and a slider implies the values in between exist.
  out.push(el('span', { className: 'lab', textContent: 'Resolution' }));
  out.push(
    chipRow(
      RESOLUTIONS.map((r, i) => ({
        label: r.label,
        on: Math.round(state.settings.resolution) === i,
        onPick: () => setSetting('resolution', i),
      })),
      helpFor('resolution'),
    ),
  );
  out.push(...roomControls());
  out.push(el('span', { className: 'lab', textContent: 'Projectors' }));
  out.push(
    chipRow([
      ...[2, 3, 4].map((n) => ({
        label: String(n),
        title:
          n === 2
            ? 'Two take opposite slots — adjacent ones would leave most of the sphere unlit (A-06).'
            : '§2: "quadrants go dark". The framebuffer keeps its size.',
        on: Math.round(state.settings.projectorCount) === n,
        onPick: () => setSetting('projectorCount', n),
      })),
      {
        label: '5 or 6',
        title:
          'Not offered HERE, and the reason is one of the three facts this project exists to ' +
          'reproduce: SOS drives every projector from ONE framebuffer split into four quadrant ' +
          'viewports (§3.4), so a fifth projector has no quadrant to be. PARAMETERS.md §2 ' +
          'supports 2, 3 and 4 and nothing else, and every §7 gate on this page is a number about ' +
          'that machine — a five-projector rig answering them would be a score for an ' +
          'installation nobody described. The simulator itself has no such limit: drop a model ' +
          'and the panel beside it will place any number of projectors anywhere, reporting ' +
          'coverage over the surface rather than gates about a sphere.',
        on: false,
        onPick: () => {},
      },
    ], helpFor('projectorCount')),
  );
  out.push(...controlsFor(['install', 'lens', 'error'], ['resolution', 'projectorCount']));
  out.push(...captureControls());
  return out;
}

/**
 * How the operator photographs the room, which is the other half of what a
 * recalibration costs.
 *
 * There is no noise slider here and there is not going to be one. The reference
 * offers "Capture noise" in millimetres, and that number is the one thing on
 * this page the simulator exists to PRODUCE: how precisely a calibration pins a
 * point down is an output of the capture, not a dial. What goes in is the two
 * facts an operator actually decides — whether the camera is on a tripod, and
 * how many spots they walk it to. Experiment 1 says those two outweigh sensor
 * noise, room light and camera resolution put together.
 *
 * Every solve used to run the same fixed best case: three tripod positions, and
 * the fields were declared, initialised, sent, and never written to by anything.
 */
/**
 * Camera rasters the page will photograph at.
 *
 * 320×240 is the bench's own corpus and every number this project has published
 * was measured there, so it stays the default: the report and the page have to
 * be talking about the same capture. `packages/bench/src/scenarios.ts` is blunt
 * about what that number is, though — "coarser than a phone, and the recovered
 * numbers are correspondingly pessimistic", with 640×480 named as "the honest
 * comparison for 'does a phone suffice'". The page promised more in
 * `protocol.ts` and offered none.
 *
 * It stops at 1280×960. Cost is linear in pixels and the capture is a full pixel
 * loop per camera per projector per pattern, so this is already over a minute in
 * a worker; the rung above would be several, and a page nobody waits for teaches
 * nothing. The seconds are measured on this machine at three positions and are
 * there to set an expectation, not as a promise.
 */
const CAPTURE_RASTERS: readonly {
  label: string;
  resX: number;
  resY: number;
  seconds: number;
  note: string;
}[] = [
  { label: '320 × 240', resX: 320, resY: 240, seconds: 10, note: "the bench's corpus, pessimistic" },
  { label: '640 × 480', resX: 640, resY: 480, seconds: 22, note: 'the honest phone comparison' },
  { label: '1280 × 960', resX: 1280, resY: 960, seconds: 75, note: 'slow, and barely better than 640' },
];

/** Millimetres of sphere surface per camera pixel, at the distance §6 puts the operator. */
function capturePxMm(resX: number, radiusM: number): number {
  // The capture camera's 62° horizontal field, from `pipeline.ts`.
  const halfTan = Math.tan((62 / 2) * (Math.PI / 180));
  return ((cameraDistanceM(radiusM) * 2 * halfTan) / resX) * 1000;
}

/**
 * The two capture conditions that decide whether the solve is measuring the ball
 * or the building.
 *
 * High in the panel rather than at the bottom of the capture block, because they
 * are the most consequential switches on the page and they were buried under
 * three groups nobody scrolls to.
 */
function roomControls(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(el('span', { className: 'lab', textContent: 'What else the light lands on' }));
  out.push(
    chipRow(
      [
        {
          label: 'Empty room',
          title: 'The pattern lands on the sphere and on nothing else. What the bench does.',
          on: state.settings.roomSpill !== 1,
          onPick: () => {
            if (state.settings.roomSpill !== 1) return;
            setSetting('roomSpill', 0);
          },
        },
        {
          label: 'Room behind it',
          // The wall distance is a slider now, so stating it as a constant here
          // would go stale the first time anybody moved it.
          title: `A wall at ${state.settings.wallRadiusM.toFixed(2)} m, a floor, and the ceiling from the Install tab. Both constants are ASSUME.`,
          on: state.settings.roomSpill === 1,
          onPick: () => {
            if (state.settings.roomSpill === 1) return;
            setSetting('roomSpill', 1);
          },
        },
      ],
      'The assumption the black background behind the sphere was hiding. Turn it on and press ' +
        'Recalibrate: about 14% of the accepted correspondences come back from a wall, a floor ' +
        'or a ceiling, and because the solver’s world has exactly one surface in it those points ' +
        'are not noise — they are placed on the ball anyway, as a confident lie nothing can ' +
        'reject. Experiment 4 measured a paired factor of 146. It changes the CAPTURE and not ' +
        'the picture: the room is not drawn, the same way the hangers and the rail ARE drawn and ' +
        'are not in the capture. Both room constants are ASSUME, so this is a demonstration and ' +
        'not a prediction of your gallery.',
    ),
  );
  // Only with the room on, the way Grid spacing appears only with the graticule
  // on: with the room off nothing reads it. It was declared with a range, a unit
  // and 250 words of help and then laid out by no panel at all — `controlsFor`
  // is called once, for the install, lens and error groups, and `controlsByKey`
  // never names it — so `r_wall` was pinned at 6.0 m and PARAMETERS.md's own
  // sweep of it (§8 item 19; experiment 4 swept 4, 6 and 9 m) could not be
  // reproduced by hand on the page that exists to make it reproducible.
  if (state.settings.roomSpill === 1) out.push(...controlsByKey(['wallRadiusM']));
  out.push(
    el('span', { className: 'lab', textContent: 'Which pixels the solver may use' }),
  );
  out.push(
    chipRow(
      [
        {
          label: 'Every lit pixel',
          title: 'Every pixel that clears the modulation floor becomes a correspondence.',
          on: state.settings.segmentSphere !== 1,
          onPick: () => {
            if (state.settings.segmentSphere !== 1) return;
            setSetting('segmentSphere', 0);
          },
        },
        {
          label: 'Only the ball',
          title: 'Segment the sphere out of the photograph and reject everything outside it.',
          on: state.settings.segmentSphere === 1,
          onPick: () => {
            if (state.settings.segmentSphere === 1) return;
            setSetting('segmentSphere', 1);
          },
        },
      ],
      'The row above is a fact about the room; this is a choice about the software, and it is the ' +
        'fix for that fact. The decoder normally turns every pixel bright enough to carry a ' +
        'pattern into a correspondence, and with a room in shot a good many of those pixels are ' +
        'wall. Only the ball segments the sphere out of the photograph first and rejects ' +
        'everything outside it. One rule does it: the ball is framed and the room runs off the ' +
        'edge of the picture, so keep the largest lit region that touches no edge. ' +
        'With the room on it is worth a paired factor of 340 and takes usable solves from 2 in ' +
        '30 to 28; on an empty capture it costs nothing. It reads pixels only — no rig, no pose, ' +
        'no radius — so unlike a test against the nominal sphere it cannot lean on the ' +
        'calibration being solved for. Turn the room on, recalibrate, then turn this on and ' +
        'recalibrate again.',
    ),
  );
  return out;
}

function captureControls(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(el('span', { className: 'lab', textContent: 'How you photograph it' }));
  out.push(
    chipRow(
      [
        {
          label: 'Tripod',
          title: 'The camera does not move between the frames of one pattern sequence.',
          on: !state.handheld,
          onPick: () => {
            if (!state.handheld) return;
            state.handheld = false;
            renderControls();
          },
        },
        {
          label: 'Handheld',
          title: 'Held in the hands, with the drift and the tremor that implies.',
          on: state.handheld,
          onPick: () => {
            if (state.handheld) return;
            state.handheld = true;
            renderControls();
          },
        },
      ],
      'The single most consequential thing about a calibration, and the cheapest to fix. This ' +
        'switches on the bench’s own motion model rather than dialling in an error: how badly ' +
        'the hands hurt it is measured, not chosen. Experiment 1 put tripod runs between 0.04 ' +
        'and 0.73 mm and the same camera handheld near 9 mm — about 170× worse. Press ' +
        'Recalibrate on each and read the residual.',
    ),
  );
  out.push(el('span', { className: 'lab', textContent: 'Camera' }));
  const radiusM = (state.settings.sphereDiaIn * IN_TO_M) / 2;
  out.push(
    chipRow(
      CAPTURE_RASTERS.map((r, i) => ({
        label: r.label,
        title: `${r.resX} × ${r.resY} — ${r.note}`,
        on: state.cameraRes === i,
        onPick: () => {
          if (state.cameraRes === i) return;
          state.cameraRes = i;
          renderControls();
        },
      })),
      `What the operator is holding. The bench's published corpus runs at 320×240 because a ` +
        `twenty-scenario sweep has to finish, and that is COARSER than a phone — about ` +
        `${capturePxMm(CAPTURE_RASTERS[0].resX, radiusM).toFixed(1)} mm of sphere per pixel here, ` +
        `against ${capturePxMm(CAPTURE_RASTERS[1].resX, radiusM).toFixed(1)} mm at 640×480, which ` +
        `is the honest setting for "would a phone do". Raising it sharpens the reprojection ` +
        `residual and costs time in proportion to the pixels: roughly ` +
        CAPTURE_RASTERS.map((r) => `${r.label} ${r.seconds}s`).join(', ') +
        ' for three positions. What it does NOT buy is much pose accuracy — the tripod ' +
        'question above outweighs it.',
    ),
  );
  out.push(el('span', { className: 'lab', textContent: 'Camera positions' }));
  out.push(
    chipRow(
      [1, 2, 3, 4].map((n) => ({
        label: String(n),
        title:
          n === 1
            ? 'One spot. A near projector zoomed in looks exactly like a far one zoomed out.'
            : `${n} spots, spread round the ring.`,
        on: state.cameraCount === n,
        onPick: () => {
          if (state.cameraCount === n) return;
          state.cameraCount = n;
          renderControls();
        },
      })),
      'How many places the operator carries the camera to. Spread is what breaks the near/far ' +
        'ambiguity: from one spot a projector close in and zoomed tight is indistinguishable ' +
        'from one far out and zoomed wide. Going from one position to two is worth about 418×; ' +
        'two to three about another 1.7×.',
    ),
  );

  return out;
}

function roomSection(): HTMLElement[] {
  const out: HTMLElement[] = [];

  // The base field is one-of-N. "Grid lines" is an independent on/off and used
  // to sit first in this row, so the default state lit two chips in a row that
  // otherwise behaves as a radio group — which reads as a multi-select and makes
  // the four fields look combinable. It lives with the other toggles now.
  out.push(el('span', { className: 'lab', textContent: 'On the sphere' }));
  out.push(
    chipRow(
      CONTENTS.map((c, i) => ({
        label: c.label,
        title: c.help,
        on: Math.round(state.settings.content) === i,
        onPick: () => {
          if (i === CONTENT_CUSTOM && customImage === null) {
            pickImage();
            return;
          }
          setSetting('content', i);
        },
      })),
      'What is playing on the ball, under the alignment grid. One at a time.',
    ),
  );
  const chosen = CONTENTS[Math.round(state.settings.content)] ?? CONTENTS[1];
  out.push(el('p', { className: 'grouphelp', textContent: chosen.help }));

  // Only once there is one. The chip above already opens the picker when the
  // slot is empty — see its `onPick` — so a second button saying the same thing
  // was two controls for one action, sitting one under the other and reading as
  // a mistake. What is left is what the chip cannot do: swap the file, or give
  // the slot back.
  if (customImage) {
    const row = el('div', { className: 'chips' });
    const pick = el('button', {
      className: 'chip',
      textContent: `Replace “${customName.split(':')[0].split('#')[0]}”`,
      title: 'Any 2:1 equirectangular map, still or moving. Read in the page and never sent anywhere.',
    });
    pick.addEventListener('click', pickImage);
    row.append(pick);
    const drop = el('button', { className: 'chip', textContent: 'Remove' });
    drop.addEventListener('click', () => {
      stopVideo();
      customImage = null;
      customName = '';
      sentImageId = '';
      solveSentImageId = '';
      contentKey = '';
      setSetting('content', CONTENT_MARBLE);
    });
    row.append(drop);
    out.push(row);
  }
  out.push(
    el('p', {
      className: 'note tiny',
      textContent:
        'Drop a file anywhere on the page, or use the chip. Any 2:1 equirectangular map, still or ' +
        'an .mp4 — which loops. A .glb goes somewhere else: it is read as the SHAPE to light ' +
        'rather than as content, and appears below. Read in the page, never sent anywhere.',
    }),
  );

  if (marbleError) {
    const err = el('p', {
      className: 'note tiny',
      textContent: `Blue marble did not load (${marbleError}). The other fields still work.`,
    });
    err.style.color = 'var(--warn)';
    out.push(err);
  }
  if (customError) {
    const err = el('p', { className: 'note', textContent: customError });
    err.style.color = 'var(--warn)';
    out.push(err);
  }
  for (const node of modelBlock()) out.push(node);
  for (const node of placementBlock()) out.push(node);
  // Said out loud, because the failure it reports is otherwise silent: the
  // sphere keeps playing from a texture that works while the model sits on a
  // frame that never arrived, and the only symptom is a parity number nobody can
  // account for. It cost an afternoon to find once.
  if (snapshotError) {
    const err = el('p', {
      className: 'note tiny',
      textContent:
        `The model could not be given a video frame (${snapshotError}). The sphere is still ` +
        'being drawn correctly; the readout and the parity check are describing an older frame.',
    });
    err.style.color = 'var(--warn)';
    out.push(err);
  }

  // The graticule is part of what is ON the sphere, so it belongs here rather
  // than at the bottom of a slider list two headings away — which is where the
  // spacing was, dead last on the tab, under four constants nobody moves.
  //
  // Still not IN the chip row above. That row is one-of-N and the grid is an
  // independent on/off; a lit chip in a radio group reads as a multi-select and
  // made the four fields look combinable. Its own row, immediately under, says
  // both things: separate control, same subject.
  out.push(
    chipRow([
      {
        label: 'Grid lines',
        title:
          'The alignment graticule, over whatever the base field is. This is the pattern the ' +
          'grid-displacement gate measures and the one a misalignment shows up in.',
        on: Math.round(state.settings.gridOn) === 1,
        onPick: () => setSetting('gridOn', Math.round(state.settings.gridOn) === 1 ? 0 : 1),
      },
    ]),
  );
  if (Math.round(state.settings.gridOn) === 1) out.push(...controlsByKey(['gridDeg']));

  // Everything a reader touches on every look, and not one of them can move a
  // number. That is not a convenience claim — every control in this block is
  // class PANEL, which is the same fact the readout's provenance tags carry, and
  // it is worth saying where the controls are rather than only in a document.
  out.push(el('span', { className: 'lab', textContent: 'What you are looking at' }));
  // Always visible, not a note. `.grouphelp` is `display: none` until somebody
  // turns on "what do these do?", and this sentence is the point of the grouping
  // rather than a gloss on it: it is what makes the block safe to play with, and
  // a reader who has to switch the notes on to find that out has already been
  // careful for no reason. One line, because the block below it is the thing a
  // phone reader came here to reach.
  out.push(
    el('p', {
      className: 'note tiny',
      textContent: 'Display only — nothing here can move a number.',
    }),
  );
  out.push(
    el('p', {
      className: 'grouphelp',
      textContent:
        'Overlays, scenery and the grade on the way to your screen. Every control in this block ' +
        'is class PANEL, which is the same fact the provenance tags in the readout carry: the ' +
        'metrics are computed from the rig and the content, so none of these reaches one. The ' +
        'parity check goes further and asserts the two display curves are OFF when it reads the ' +
        'render back, so the number it prints is the model’s own radiance underneath them.',
    }),
  );
  out.push(el('span', { className: 'lab', textContent: 'Show me' }));
  const overlays: { id: OverlayMode; label: string; title: string }[] = [
    { id: 'none', label: 'Plain', title: 'The sphere as a visitor sees it.' },
    {
      id: 'overlap',
      label: 'Coverage',
      title:
        'Tinted by how many projectors light each point. Never three — PARAMETERS.md §4.2, and if ' +
        'red ever appears the code has a bug.',
    },
    { id: 'seams', label: 'Seams', title: 'Where two projectors overlap and crossfade.' },
    {
      id: 'byprojector',
      label: 'By projector',
      title:
        'Each projector\u2019s panel colour, mixed in proportion to what it is contributing. Where ' +
        'one projector has the surface to itself you get its colour flat; across a seam the two ' +
        'colours cross-fade, and the WIDTH of that gradient is the blend band \u2014 the ' +
        '\u201cSeam blend width\u201d slider stretches and narrows it in front of you. It used to ' +
        'tint by whichever projector was winning, which put a razor edge at the halfway line and ' +
        'hid the hand-over entirely.',
    },
    {
      id: 'unlit',
      label: 'Dark',
      title:
        'The polar hole. Four-lobed and scalloped, not a circle: coverage reaches ~80° along each ' +
        "projector's meridian and only ~76° between them.",
    },
  ];
  out.push(
    chipRow(
      overlays.map((o) => ({
        label: o.label,
        title: o.title,
        on: state.overlay === o.id,
        onPick: () => {
          state.overlay = o.id;
          markDirty();
          renderControls();
        },
      })),
    ),
  );
  out.push(el('span', { className: 'lab', textContent: 'In the room' }));
  out.push(
    chipRow([
      {
        label: 'Projectors',
        title:
          'The four projectors on their hangers, and the rod the sphere hangs from. Each lens ' +
          'glows in its own colour; click one to select it and see the frame going down its cable. ' +
          'Scenery — the trace is not told any of it exists, and no light comes off it.',
        on: state.markersOn,
        onPick: () => {
          state.markersOn = !state.markersOn;
          markDirty();
          renderControls();
        },
      },
      {
        label: 'Guard rail',
        title:
          'The rail visitors stand behind, its footprint on the floor, and the rod the sphere ' +
          'hangs from. Scenery — nothing in the model reads it, it emits no light and occludes ' +
          'none.',
        on: state.railOn,
        onPick: () => {
          state.railOn = !state.railOn;
          markDirty();
          renderControls();
        },
      },
      {
        label: 'Aim guides',
        title:
          "A faint cone of light from each lens to the ball, in the projector's own colour. Drawn " +
          'from where the lens ACTUALLY is, so a bumped projector\u2019s cone visibly misses where ' +
          'the others converge.',
        on: state.aimGuides,
        onPick: () => {
          state.aimGuides = !state.aimGuides;
          markDirty();
          renderControls();
        },
      },
    ]),
  );
  // The grade on the way to the screen. Three PANEL sliders, here rather than in
  // the middle of the camera controls they used to sit among.
  out.push(...controlsByKey(['viewExposure', 'viewLift', 'viewSamples']));

  out.push(el('span', { className: 'lab', textContent: 'Where you stand' }));
  // Which chip is lit, if any: dragging the sphere leaves none of them lit,
  // which is correct — the viewpoint is then wherever you put it.
  // The field of view is excluded on a narrow viewport, because that is the one
  // key the chip deliberately does NOT write there — `fitFirstScreen` owns it,
  // and comparing against the desktop 71 would mean no chip could ever light up
  // on a phone however exactly you had landed on its viewpoint.
  const skipFov = narrowViewport();
  const here = VIEWPOINTS.findIndex((v) =>
    (Object.keys(v.view) as (keyof typeof v.view)[])
      .filter((k) => !(skipFov && k === 'viewFovDeg'))
      .every((k) => Math.abs(state.settings[k] - v.view[k]) < 1e-6),
  );
  out.push(
    chipRow(
      VIEWPOINTS.map((v, i) => ({
        label: v.label,
        title: v.help,
        on: here === i,
        onPick: () => {
          // Where you STAND. Not what is installed, so it must not mark the
          // comparison stale — and on a narrow viewport it must not undo the
          // portrait field `fitFirstScreen` chose, or one tap on "Whole room"
          // puts a 390 px phone back to a ~114 degree vertical frustum with no
          // way back except the field-of-view slider.
          const { viewFovDeg, ...rest } = v.view;
          state.settings = {
            ...state.settings,
            ...rest,
            viewFovDeg: narrowViewport() ? portraitFovDeg() : viewFovDeg,
          };
          touched(false);
        },
      })),
    ),
  );
  // The camera, under the chips that set it. These four restate a drag and a
  // pinch, which is why the chips come first: they are what a reader actually
  // clicks, and the sliders are for saying a number out loud.
  out.push(...controlsByKey(['viewAzDeg', 'viewElDeg', 'viewRangeM', 'viewFovDeg']));

  out.push(el('span', { className: 'lab', textContent: 'Show only' }));
  const n = Math.round(state.settings.projectorCount);
  out.push(
    chipRow(
      [
        {
          label: 'All',
          on: state.highlight === -1,
          onPick: () => {
            state.highlight = -1;
            markDirty();
            renderControls();
          },
        },
        ...Array.from({ length: n }, (_, i) => ({
          label: `P${i + 1}`,
          on: state.highlight === i,
          onPick: () => {
            state.highlight = i;
            // Showing one also selects it, so the inspect card is describing the
            // projector whose light is on screen rather than some other one's.
            state.selected = i;
            state.inspectOpen = true;
            markDirty();
            renderControls();
            renderInspect();
          },
        })),
      ],
      'Draws one projector’s contribution on its own, which is how you see what a single lens is ' +
        'responsible for and where its edges fall. This is a filter on the PICTURE and nothing ' +
        'else: the rig is untouched, every number below is still the whole installation, and ' +
        'switching a projector off is on the Projectors tab.',
    ),
  );

  // LAST, and shut. These are the compositor's constants — §4.5's blend width and
  // ramp exponent, §4.4's two mask angles, §5's ambient — and four of the five
  // are class ASSUME: nobody has measured them. They are also the only controls
  // on this tab that CAN move a number, which is exactly why they should not be
  // the first thing under a reader's thumb.
  //
  // They used to sit above everything: a phone reader scrolled past four
  // constants they will never touch to reach the grid toggle they touch every
  // time. Behind a caret they are one tap away and no longer in the road.
  out.push(
    disclosure('Seams and the polar hole', state.seamsOpen, () => {
      state.seamsOpen = !state.seamsOpen;
      rememberSeamsOpen();
      renderControls();
    }),
  );
  if (state.seamsOpen) {
    out.push(
      el('p', {
        className: 'grouphelp',
        textContent:
          'What the compositor is told to do where two projectors meet, and where it stops ' +
          'painting toward the south pole. These are the only controls on this tab a metric can ' +
          'see. Four of them are class ASSUME — the shape of the ramp and the two mask angles are ' +
          'nobody’s measurement — so moving them changes the answer and the readout will say so.',
      }),
    );
    out.push(...controlsByKey(['blendDeg', 'rampGamma', 'maskLoDeg', 'maskHiDeg', 'ambient']));
  }
  return out;
}

function renderControls(): void {
  controlsEl.replaceChildren();
  controlsEl.classList.toggle('explain', state.explain);
  controlsEl.append(sectionTabs());

  const section = SECTIONS.find((s) => s.id === state.section) ?? SECTIONS[0];
  const head = el('div', { className: 'rowline' });
  head.append(el('p', { className: 'eyebrow-sm', textContent: section.title }));
  const explain = el('button', {
    className: state.explain ? 'linkish on' : 'linkish',
    textContent: state.explain ? 'hide notes' : 'what do these do?',
  });
  explain.addEventListener('click', () => {
    state.explain = !state.explain;
    rememberExplain();
    renderControls();
  });
  head.append(explain);
  controlsEl.append(head);

  const body =
    state.section === 'projectors'
      ? projectorSection()
      : state.section === 'install'
        ? installSection()
        : roomSection();
  for (const node of body) controlsEl.append(node);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The file picker, created on demand so the page has no hidden input in its DOM. */
function pickImage(): void {
  const input = document.createElement('input');
  input.type = 'file';
  // `.glb` is listed because the note beside this chip says a model can be
  // dropped OR chosen. Without it the picker hides every model file and the
  // advertised path silently does not work.
  input.accept = 'image/*,video/*,model/gltf-binary,.glb';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void loadCustomMedia(file);
  });
  input.click();
}

function renderTopButtons(): void {
  topBtnsEl.replaceChildren();

  const help = el('button', {
    className: 'btn icon',
    textContent: '?',
    title: 'What is this, and how do I use it?',
  });
  help.addEventListener('click', () => openHelp());
  topBtnsEl.append(help);

  const toggle = el('button', {
    className: 'btn icon',
    textContent: state.panelOpen ? '\u2013' : '\u2261',
    title: state.panelOpen ? 'Hide the controls' : 'Show the controls',
    ariaLabel: state.panelOpen ? 'Hide the controls' : 'Show the controls',
  });
  toggle.addEventListener('click', () => {
    state.panelOpen = !state.panelOpen;
    rightEl.classList.toggle('collapsed', !state.panelOpen);
    // Now, not when the observer gets round to it: this button is the one that
    // changes how much room the sheets leave, and the picture has to be in the
    // room they left before the next frame rather than half a second later.
    settleSheets();
    renderTopButtons();
  });
  topBtnsEl.append(toggle);

  leftBtnsEl.replaceChildren();
  const readout = el('button', {
    className: 'btn icon',
    textContent: state.readoutOpen ? '\u2013' : '\u2261',
    title: state.readoutOpen ? 'Hide the readout' : 'Show the readout',
    ariaLabel: state.readoutOpen ? 'Hide the readout' : 'Show the readout',
  });
  readout.addEventListener('click', () => {
    state.readoutOpen = !state.readoutOpen;
    leftEl.classList.toggle('collapsed', !state.readoutOpen);
    settleSheets();
    renderTopButtons();
  });
  leftBtnsEl.append(readout);
}

/**
 * The help sheet.
 *
 * Shown once, unprompted, and then only when asked for. A page whose first
 * screen is a sphere and thirty controls needs to say what it is; a page that
 * says it every visit is a page people learn to dismiss without reading.
 *
 * The "seen" flag is in `localStorage` and its absence is handled: a browser
 * with storage disabled shows the sheet every time, which is the failure that
 * costs a click rather than the one that hides the explanation.
 */
const HELP_SEEN_KEY = 'sphere-sim.help.seen.v1';

/**
 * The notes toggle, remembered.
 *
 * The help sheet promises the notes "stay on until you turn it off", and every
 * reload turned them off. Same failure handling as the help flag: a browser with
 * storage disabled loses the preference rather than breaking.
 */
const EXPLAIN_KEY = 'sphere-sim.explain.v1';
const SEAMS_KEY = 'sphere-sim.seams-open.v1';

function rememberExplain(): void {
  try {
    localStorage.setItem(EXPLAIN_KEY, state.explain ? '1' : '0');
  } catch {
    /* storage disabled */
  }
}

function rememberSeamsOpen(): void {
  try {
    localStorage.setItem(SEAMS_KEY, state.seamsOpen ? '1' : '0');
  } catch {
    /* storage disabled */
  }
}

function openHelp(): void {
  const sheet = helpEl.querySelector('.sheet');
  if (!sheet) return;
  sheet.replaceChildren();

  const h = (tag: 'h2' | 'h3' | 'p', text: string, cls = ''): HTMLElement =>
    el(tag, { textContent: text, className: cls });

  sheet.append(h('h2', 'A sphere you can knock out of alignment'));
  sheet.append(
    h(
      'p',
      'A Science On a Sphere theatre, simulated. Four projectors ring a 68-inch ball and paint ' +
        'one image between them. Where two of them overlap they have to draw the same coastline ' +
        'in the same place. When one gets knocked they do not — and you see a doubled line.',
    ),
  );

  sheet.append(h('h3', 'Try this first'));
  const list = el('ol');
  for (const [lead, rest] of [
    [
      'Press "Bump this one"',
      ' — or "Another install", where every projector moves a little because the building did. ' +
        'Watch the number on the left jump and turn red.',
    ],
    [
      'Zoom right in on a seam',
      ' — scroll, or pinch on a touchscreen — and you can see the grid lines sitting apart. Click ' +
        'a projector to see the frame it is sending. Bump it again and that frame does not ' +
        'change: the software has not been told, so only where the light lands has moved.',
    ],
    [
      'Press Recalibrate',
      ' and watch it work. It does not undo the bump — it photographs the sphere with structured ' +
        'light, works out where the lenses really are from those photographs alone, and lists ' +
        'what it found. The three photos appear with the results. Five seconds or so.',
    ],
  ]) {
    // One element per grid cell: the counter is the first column and everything
    // else has to be the second. Appending the bold lead and the rest as two
    // siblings made them two cells, and the sentence wrapped one word per line
    // down a 22px column.
    const body = el('span');
    body.append(el('strong', { textContent: lead }), rest);
    const li = el('li');
    li.append(body);
    list.append(li);
  }
  sheet.append(list);

  sheet.append(h('h3', 'The one thing worth understanding'));
  sheet.append(
    h(
      'p',
      'There are two rigs, not one: where the lenses actually are, and where the software ' +
        'believes they are. Moving a projector changes only the first, which is why the frame it ' +
        'is sending does not move and why the picture on the ball goes wrong. Recalibrating is ' +
        'what updates the second.',
    ),
  );

  sheet.append(h('h3', 'The number on the left'));
  sheet.append(
    h(
      'p',
      'Millimetres of disagreement between projectors where they overlap, at the worst point on ' +
        'the sphere. Under a millimetre is good — a visitor would never notice. This is the whole ' +
        'point: today that judgement is made by eye, with no number to check.',
    ),
  );

  sheet.append(h('h3', 'Anything else'));
  const more = el('ul');
  for (const item of [
    'Drag to walk around the sphere — the orbit passes underneath it, which is the only way to ' +
      'see the unlit cap at the bottom.',
    'On the Room tab, press "Whole room" to step outside the ring — all four projectors, each in ' +
      'its own colour — or turn the grid off and drop any 2:1 equirectangular image on the page.',
    '"Show only" on the Room tab draws one projector\u2019s light on its own. It changes the ' +
      'picture and nothing else; the switch that actually turns a projector off is on the ' +
      'Projectors tab, beside its sliders.',
    'Nothing here is arbitrary. "Another install" draws each mount error from a normal about its ' +
      'nominal at the tolerance \u00a72 implies, fixed by a seed you can see and set on the Install ' +
      'tab \u2014 the same seed gives the same rig forever. The two Bump buttons add a fixed step ' +
      'rather than a random one, so the same click twice does the same thing.',
    'The sphere looks dimmer here than in a demo that draws a map as if it glowed, because it is a ' +
      'painted ball: what you see is the image times the paint\u2019s 0.9 reflectance times the ' +
      'cosine of the angle the light arrives at, which falls to nothing at the edge. "Screen ' +
      'brightness" on the Room tab exposes the picture without touching a single number.',
    'The "what do these do?" link above the sliders turns on a plain-language note under every ' +
      'control, and stays on until you turn it off.',
    'This sheet is always one press of "?" away, top right.',
  ]) {
    more.append(el('li', { textContent: item }));
  }
  sheet.append(more);

  sheet.append(h('h3', 'Where the numbers come from'));
  sheet.append(
    h(
      'p',
      'The picture is drawn by a shader. Every NUMBER is computed separately by the project\u2019s ' +
        'forward model, and the two are compared against each other continuously — that ' +
        'disagreement is printed at the bottom of the readout rather than assumed away. The ' +
        'calibration is run by an inverse model that shares no geometry code with the simulator ' +
        'at all, which is the only reason its score means anything.',
    ),
  );
  sheet.append(
    h(
      'p',
      'The page opens at NOAA Boulder\u2019s published configuration, which disagrees with this ' +
        'project\u2019s own specification on three constants. That conflict is recorded rather than ' +
        'resolved, and the readout flags what it costs.',
      'small',
    ),
  );

  const close = el('div', { className: 'close' });
  const btn = el('button', { className: 'btn primary', textContent: 'Start bumping things' });
  btn.dataset.smoke = 'help-close';
  btn.addEventListener('click', closeHelp);
  close.append(btn);
  sheet.append(close);

  helpEl.classList.add('on');
}

function closeHelp(): void {
  helpEl.classList.remove('on');
  try {
    localStorage.setItem(HELP_SEEN_KEY, '1');
  } catch {
    /* storage disabled — the sheet shows again next visit, which is the harmless failure */
  }
}

/**
 * Add a step, and turn round at the wall rather than pressing into it.
 *
 * The nudges are clamped to the slider's own range, and a step that only ever
 * added meant about a dozen presses of "Bump this one" pinned yaw at 3.00 deg
 * and every press after that changed nothing at all — a button that reads as
 * broken, with no message saying why.
 *
 * Reflecting keeps every press doing something without giving up the property
 * the fixed step was chosen for: this is a pure function of the current value,
 * so the same clicks from the same state give the same rig, and every number on
 * the page depends on that.
 *
 * It does not random-walk. Once it reaches the wall it wobbles between the last
 * two positions, which is the honest thing for it to do — the range is the range
 * a mount can actually be knocked through, and there is nothing further out to
 * show. What matters is that the seams keep moving and the button never goes
 * quietly dead.
 */
function bumpBy(current: number, step: number, limit: number): number {
  const up = current + step;
  if (up <= limit && up >= -limit) return up;
  const down = current - step;
  return Math.max(-limit, Math.min(limit, down));
}

/** The nudge ranges the bump buttons have to stay inside. See `NUDGE_CONTROLS`. */
const BUMP_ANGLE_LIMIT = 3;
const BUMP_METRE_LIMIT = 0.4;

function renderActions(): void {
  actionsEl.replaceChildren();

  const bump = el('button', {
    className: 'btn',
    textContent: 'Bump this one',
    title:
      'Knock the selected projector by about a quarter of a degree and a few centimetres, the ' +
      'way a ladder does.',
  });
  bump.addEventListener('click', () => {
    const i = state.selected;
    const n = state.settings.nudge[i];
    // A fixed step rather than a random one: the same click twice does the same
    // thing, and every number this page shows depends on that.
    //
    // Position as well as aim. A ladder that catches a projector shifts it as
    // well as turning it, and with aim alone the readout's "Lens position" cell
    // sat at 0.00 mm however many times you pressed — beside a sentence
    // promising it was how far the software's idea had fallen behind the room.
    state.settings = withNudge(state.settings, i, {
      yawDeg: bumpBy(n?.yawDeg ?? 0, 0.25, BUMP_ANGLE_LIMIT),
      rollDeg: bumpBy(n?.rollDeg ?? 0, 0.15, BUMP_ANGLE_LIMIT),
      distanceM: bumpBy(n?.distanceM ?? 0, 0.06, BUMP_METRE_LIMIT),
      heightM: bumpBy(n?.heightM ?? 0, 0.02, BUMP_METRE_LIMIT),
    });
    touched(true);
  });
  actionsEl.append(bump);

  // The reference calls this "drift all", and it is a different thing from
  // "another install": this knocks every lens by hand, on top of whatever the
  // mount already did, without redrawing the mount error or changing the seed.
  // A building settling moves all four; a ladder moves one.
  //
  // Counted from the room rather than from the array. The label said "four" and
  // the loop wrote four slots whatever the projector count was, so a two-lens
  // room mislabelled the button and quietly accumulated aim error in the two
  // slots nothing was reading — which then appeared, already knocked, the moment
  // the count went back up.
  const lit = Math.round(state.settings.projectorCount);
  const bumpAll = el('button', {
    className: 'btn',
    textContent: `Bump all ${lit}`,
    title:
      'Knock every projector by the same amount in a different direction. A fixed step, not a ' +
      'random one — the same click twice does the same thing.',
  });
  bumpAll.addEventListener('click', () => {
    let next = state.settings;
    for (let i = 0; i < Math.min(lit, next.nudge.length); i++) {
      const n = next.nudge[i];
      // Deterministic and different per projector: alternating signs, so the four
      // do not all move the same way and cancel at every seam.
      const sy = i % 2 === 0 ? 1 : -1;
      const sr = i < 2 ? 1 : -1;
      next = withNudge(next, i, {
        yawDeg: bumpBy(n?.yawDeg ?? 0, 0.18 * sy, BUMP_ANGLE_LIMIT),
        pitchDeg: bumpBy(n?.pitchDeg ?? 0, 0.12 * sr, BUMP_ANGLE_LIMIT),
        rollDeg: bumpBy(n?.rollDeg ?? 0, 0.1 * sy * sr, BUMP_ANGLE_LIMIT),
        distanceM: bumpBy(n?.distanceM ?? 0, 0.035 * sy, BUMP_METRE_LIMIT),
      });
    }
    state.settings = next;
    touched(true);
  });
  actionsEl.append(bumpAll);

  const drift = el('button', {
    className: 'btn',
    textContent: 'Another install',
    title:
      'Draw a different mount error at the same magnitude. Deterministic — the seed is on the ' +
      'Install tab, and the same seed always gives the same rig.',
  });
  drift.addEventListener('click', () => {
    // A different INSTALLATION, so the calibration goes with it — geometry
    // recovered for the old mount error is not a belief about the new one.
    clearCalibration();
    // Also turns the mount shake ON, because the page opens with it off. A button
    // labelled "another install" that produced the same perfectly-mounted rig
    // every time would be a button that does nothing.
    state.settings = clearNudges(state.settings);
    state.settings = withSetting(state.settings, 'mountError', 1);
    setSetting('errorSeed', ((state.settings.errorSeed + 104729) % 999_999) + 1);
  });
  actionsEl.append(drift);

  const refusal = solveRefusalReason(state.cameraCount);
  const solve = el('button', {
    className: 'btn primary',
    textContent: solveRunning ? 'Calibrating…' : 'Recalibrate',
    // Disabled with the reason on it, rather than live and then refusing on
    // click: a button that does nothing when pressed reads as a broken page.
    disabled: solveRunning || refusal !== null,
    title:
      refusal ??
      'Photograph the sphere with structured light and solve for where the lenses really are.',
  });
  solve.addEventListener('click', startSolve);
  actionsEl.append(solve);

  if (state.compositorRig !== null) {
    const forget = el('button', { className: 'btn', textContent: 'Forget it' });
    forget.addEventListener('click', forgetCalibration);
    actionsEl.append(forget);
  }

  const reset = el('button', { className: 'btn', textContent: 'Reset' });
  reset.addEventListener('click', () => {
    state.settings = { ...PERFECT_PRESET, nudge: PERFECT_PRESET.nudge.map((n) => ({ ...n })) };
    state.overlay = 'none';
    state.highlight = -1;
    // The preset carries Boulder's desktop 71°, which across a 390x844 screen is
    // the 114° vertical frustum `portraitFovDeg` exists to prevent — and Reset,
    // whose whole job is to put everything back, was the one writer of the key
    // that ignored it. It also poisoned the refit: `fitFirstScreen` overwrites
    // only while the value is still the one it wrote, so installing a foreign
    // one made it give up ownership for the life of the page and rotating the
    // phone stopped fixing anything. Clearing `fittedFov` hands ownership back
    // and re-fits for whatever viewport is actually there.
    fittedFov = null;
    fitFirstScreen();
    forgetCalibration();
    renderControls();
  });
  actionsEl.append(reset);
}

// ---------------------------------------------------------------------------
// The inspect card: one projector, three ways
// ---------------------------------------------------------------------------

const INSPECT_VIEWS = [
  { id: 'frame' as const, label: 'Its frame', title: 'The image going down this projector’s cable.' },
  {
    id: 'where' as const,
    label: 'Where it is',
    title: 'Its configuration as the software holds it, against where the lens actually is.',
  },
  {
    id: 'mesh' as const,
    label: 'Warp mesh',
    title: 'The per-vertex correction the config file cannot carry.',
  },
];

let inspectView: (typeof INSPECT_VIEWS)[number]['id'] = 'frame';

function renderInspect(): void {
  inspectEl.replaceChildren();
  const frame = model?.projectorFrames[state.selected] ?? null;
  // Shown whenever a projector is the subject — either because the Projectors
  // tab is open, or because one is isolated in the room. It used to be tied to
  // the tab alone, which meant clicking a lens in the room lit up its light and
  // showed nothing about it.
  const subject = state.inspectOpen && (state.section === 'projectors' || state.highlight >= 0);
  // The class is on the column, not the card: on a phone it is what tells the
  // readout to stand down while a projector is the subject.
  leftEl.classList.toggle('inspecting', subject);
  // The projector card replaces the readout on a phone, and the two are not the
  // same height, so the room between the sheets moves when it opens.
  settleSheets();
  // A missing frame is no longer a reason to hide the card. Switching a
  // projector off drops it out of the rig, so its frame, config and mesh all
  // come back null — and returning early here meant the click that switched it
  // off was also the click that made its card vanish, which reads as the page
  // losing track of it. The "Currently switched off" line was unreachable code
  // for the same reason.
  if (!subject) {
    inspectEl.classList.remove('on');
    return;
  }
  inspectEl.classList.add('on');
  const tint = PROJECTOR_TINTS[state.selected] ?? '#888';
  const on = state.settings.nudge[state.selected]?.on !== false;

  const head = el('div', { className: 'rowline' });
  // Says what the picture is, not just whose it is: "P3" over a picture of the
  // world is an identifier, "P3 is sending" is a sentence about the thing below.
  const name = el('p', { className: 'eyebrow-sm', textContent: `P${state.selected + 1} is sending` });
  name.style.color = tint;
  // Walk round to this projector's side.
  //
  // Isolating a projector that lights the far side of the ball leaves you
  // looking at the unlit back of it, which is the truth and reads as a fault.
  // The azimuth comes off the drawn uniforms rather than being recomputed, so
  // the link goes exactly where the marker is.
  let caption: HTMLElement = el('span', {
    className: 'note tiny',
    textContent: frame ? frame.caption : 'switched off',
  });
  // Offered whenever the selected projector lights the side of the ball you are
  // not looking at. It used to be gated on that projector being ISOLATED, which
  // was the only way the room went dark — and selecting no longer isolates, so
  // the gate would have retired a link that is useful either way.
  //
  // The lens array is indexed by RIG position and `state.selected` is a panel
  // slot; with one projector switched off the two stop agreeing, and reading it
  // directly walked you round to a different projector's side.
  const rigIndex = lastSlots.indexOf(state.selected);
  if (lastUniforms && rigIndex >= 0) {
    const lx = lastUniforms.physical.lens[3 * rigIndex];
    const ly = lastUniforms.physical.lens[3 * rigIndex + 1];
    const az = (Math.atan2(ly, lx) * 180) / Math.PI;
    const lightsFarSide = Math.abs(((az - state.settings.viewAzDeg + 540) % 360) - 180) > 120;
    if (lightsFarSide) {
      const walk = el('button', {
        className: 'linkish',
        textContent: `stand where P${state.selected + 1} does`,
        title:
          'Walk round to this projector\u2019s side of the room and look up at the ball from ' +
          'under its beam, where a visitor stands.',
      });
      walk.addEventListener('click', () => {
        // Walking round the ball is a view change, not an installation change.
        state.settings = withSetting(state.settings, 'viewAzDeg', az);
        // And UNDER the projector, not above it.
        //
        // Azimuth alone put the eye at the default 14 degrees and 10.2 m, which
        // is above a lens sitting at about 2 degrees and 5.36 m — so walking
        // round to a projector's side parked its body squarely between you and
        // the sphere, filling the frame with the back of a box. The lens hangs
        // just above the equator and a visitor's eye is well below it, so
        // standing where the projector throws from means standing under it and
        // looking slightly up, which is also what §6 describes.
        //
        // Derived from the room rather than fixed: the sphere centre sits at the
        // equator height and that is a slider, so a 108-inch equator has to move
        // the eye with it or this stops being a viewer's eye and becomes a
        // number that used to be one.
        //
        // And at the projector's own distance, which is what the label says and
        // also the only realistic place to put a person: the lens ring is 5.36 m
        // out and the ceiling is 14 feet, so a gallery holding this is about
        // twelve metres across. The default 10.2 m viewpoint is a fine way to
        // see the whole installation and it is standing outside the building.
        const centreM = state.settings.equatorIn * IN_TO_M;
        const rise = VISITOR_EYE_M - centreM;
        const r = Math.max(Math.hypot(lx, ly), Math.abs(rise) + 0.5);
        const el = (Math.asin(Math.max(-1, Math.min(1, rise / r))) * 180) / Math.PI;
        state.settings = withSetting(state.settings, 'viewRangeM', r);
        state.settings = withSetting(state.settings, 'viewElDeg', el);
        touched(false);
      });
      caption = walk;
    }
  }
  const close = el('button', {
    className: 'linkish',
    textContent: '✕',
    title: 'Put this card away',
    ariaLabel: 'Close the projector card',
  });
  close.addEventListener('click', () => {
    state.inspectOpen = false;
    renderInspect();
  });
  head.append(name, caption, close);
  inspectEl.append(head);

  // One view at a time. All three at once needs more height than a panel beside
  // a sphere has, and the frame is what a reader wants first.
  const seg = el('div', { className: 'seg' });
  for (const v of INSPECT_VIEWS) {
    const b = el('button', {
      className: inspectView === v.id ? 'on' : '',
      textContent: v.label,
      title: v.title,
    });
    b.addEventListener('click', () => {
      inspectView = v.id;
      renderInspect();
    });
    seg.append(b);
  }
  inspectEl.append(seg);

  if (inspectView === 'frame') {
    if (frame) {
      // Kept, greyed, when the projector is switched off: this is still exactly
      // the frame the compositor is generating for it — the signal is there, the
      // lamp is not.
      const c = el('canvas', { className: on ? 'framepic' : 'framepic dark' });
      const slot = state.selected;
      if (beforeFrames[slot] && solveResult) paintFramePair(c, beforeFrames[slot]!, frame);
      else paintFrame(c, frame);
      // The caption already opens with the projector id, so prefixing it printed
      // "P1 — P1 — 3840 × 2160".
      c.addEventListener('click', () => openLightbox(frame, frame.caption, slot));
      inspectEl.append(c);
      inspectEl.append(
        el('p', {
          className: 'note',
          textContent:
            beforeFrames[slot] && solveResult
              ? 'Red is where the old warp drew the grid; cyan is where it draws it now. The ' +
                'recalibration rewrote this frame — the projector has not moved since, and the ' +
                'light now lands where the software thinks it does.'
              : !on
                ? 'The frame this projector would be sending. Nothing is going down the cable ' +
                  'while it is switched off, but the compositor’s arithmetic for it has not ' +
                  'changed — switch it back on and this is what arrives.'
                : 'The image this projector is sending down the cable. It fades out at the left ' +
                  'and right where it hands over to its neighbours — widest across the equator, ' +
                  'pinching shut toward the poles. Moving the projector does NOT change this ' +
                  'picture, because the software has not been told. Recalibrating is what ' +
                  'rewrites it.',
        }),
      );
      // The zoom cursor is a mouse affordance and this card is now the phone's
      // main surface, so the affordance gets said out loud.
      inspectEl.append(
        el('p', {
          className: 'note tiny',
          textContent: coarsePointer()
            ? 'Tap the frame to see it full size.'
            : 'Click the frame to see it full size.',
        }),
      );
    } else {
      inspectEl.append(
        el('p', {
          className: 'note',
          textContent:
            'Nothing is going down this cable. The compositor generates a frame for each ' +
            'projector it believes is in the room, and this one is switched off — so it is not ' +
            'in the rig, its quadrant of the sphere is dark, and the neighbours do not widen to ' +
            'cover the gap.',
        }),
      );
    }
    if (!on) {
      const off = el('p', { className: 'note', textContent: 'Currently switched off at the wall.' });
      off.style.color = 'var(--warn)';
      inspectEl.append(off);
    }
  }

  const cfg = model?.projectorConfig[state.selected] ?? null;
  if (inspectView === 'where' && !cfg) {
    inspectEl.append(
      el('p', {
        className: 'note',
        textContent:
          'A switched-off projector has no row in the compositor’s calibration, so there is ' +
          'nothing here to compare against where the lens actually is. Switch it back on to see ' +
          'the two columns.',
      }),
    );
  }
  if (inspectView === 'where' && cfg) {
    const table = el('table', { className: 'rec' });
    const head = el('tr');
    head.append(
      el('th', { textContent: '' }),
      el('th', { className: 'r', textContent: 'software believes' }),
      el('th', { className: 'r', textContent: 'actually' }),
    );
    table.append(head);
    for (let k = 0; k < cfg.believed.length; k++) {
      const b = cfg.believed[k];
      const a = cfg.actual[k];
      const tr = el('tr');
      tr.setAttribute('title', b.note);
      tr.append(el('td', { textContent: b.label }));
      tr.append(el('td', { className: 'r num', textContent: b.value }));
      const right = el('td', { className: 'r num', textContent: a ? a.value : '—' });
      // Only the disagreements are coloured. A row where the two agree is not a
      // finding, and colouring every row would make the page look alarmed about
      // a raster size.
      if (a && a.value !== b.value) right.style.color = 'var(--warn)';
      tr.append(right);
      table.append(tr);
    }
    inspectEl.append(table);
    inspectEl.append(
      el('p', {
        className: 'note',
        textContent:
          'Left is the calibration the compositor is working from — what an operator typed into ' +
          'sos_stream_control.config, or what the last solve recovered. Right is where the lens ' +
          'actually is. Every alignment number on this page is the gap between those two columns; ' +
          'the solver sees only photographs and never the right-hand one.',
      }),
    );
  }

  const mesh = model?.meshes[state.selected] ?? null;
  if (inspectView === 'mesh' && !mesh) {
    inspectEl.append(
      el('p', {
        className: 'note',
        textContent:
          'No warp mesh: this projector is switched off, so the compositor is not generating a ' +
          'frame for it and there is nothing to bend.',
      }),
    );
  }
  if (inspectView === 'mesh' && mesh) {
    // Magnified so the shape is legible. At true scale a 1 mm error and a 100 mm
    // error are both a straight grid, so the factor is chosen to put the worst
    // vertex at a fixed fraction of the raster — and then printed, because a
    // diagram whose scale is picked to look convincing is not evidence.
    //
    // When there is a before, ONE factor covers both pictures, taken from the
    // worse of the two. A solved mesh is nearly flat and would otherwise be
    // magnified a hundred times more than the mesh it is being compared with,
    // which would draw the correction as having got worse.
    const was = solveResult ? (beforeMeshes[state.selected] ?? null) : null;
    const worst = Math.max(mesh.worstPx, was?.worstPx ?? 0);
    const gain = worst > 1e-9 ? Math.min(400, Math.max(1, (0.07 * mesh.resX) / worst)) : 1;
    if (was) {
      const wasCap = el('p', {
        className: 'note tiny',
        textContent: `Before — the bend the compositor was applying, ${was.worstPx.toFixed(1)} px at worst`,
      });
      wasCap.style.color = 'var(--bad)';
      inspectEl.append(wasCap);
      inspectEl.append(meshDiagram(was, MESH_BEFORE_COLOR, gain));
      const nowCap = el('p', {
        className: 'note tiny',
        textContent: `After — ${mesh.worstPx.toFixed(2)} px, at the same magnification`,
      });
      nowCap.style.color = 'var(--good)';
      inspectEl.append(nowCap);
    }
    inspectEl.append(meshDiagram(mesh, tint, gain));
    // The mesh drawings are two overlapping grids in colours explained three
    // lines further down, in a paragraph that also covers the magnification and
    // the vertex count. The seam diagram beneath has a legend; this did not.
    inspectEl.append(meshLegend(tint, was !== null));
    inspectEl.append(
      el('p', {
        className: 'note tiny num',
        textContent:
          `worst vertex ${mesh.worstPx.toFixed(mesh.worstPx < 10 ? 2 : 1)} px ` +
          `across a ${mesh.resX}-pixel raster, drawn ×${gain < 10 ? gain.toFixed(1) : gain.toFixed(0)} ` +
          `to be visible at all — ${mesh.onSphere} of ${mesh.cols * mesh.rows} vertices reach the ball`,
      }),
    );
    inspectEl.append(
      el('p', {
        className: 'note',
        textContent:
          'Grey is the raster as the software addresses it; colour is where each vertex has to ' +
          'move for the light to land where the software thinks it does. This is the correction ' +
          'the config file cannot carry. It is not drawn — each vertex is followed out to the ' +
          'ball through the believed calibration and back through the real one, so recalibrating ' +
          'collapses it towards straight.',
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------

function fmtMm(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

function badgeFor(status: Reading['status'] | 'PENDING'): HTMLElement {
  const map: Record<string, { text: string; fg: string; bg: string; bd: string }> = {
    // The page's own palette, not two lighter greens and reds that appear nowhere
    // else in it. `--good` and `--bad` are declared in index.html and every other
    // state colour on the page already uses them.
    PASS: { text: 'ALIGNED', fg: 'var(--good)', bg: 'rgba(34,197,94,0.10)', bd: 'rgba(34,197,94,0.45)' },
    FAIL: { text: 'DRIFTED', fg: 'var(--bad)', bg: 'rgba(239,68,68,0.10)', bd: 'rgba(239,68,68,0.45)' },
    REFERENCE: { text: 'REFERENCE', fg: 'var(--muted)', bg: 'rgba(255,255,255,0.06)', bd: 'var(--line-strong)' },
    PROVISIONAL: { text: 'PROVISIONAL', fg: 'var(--warn)', bg: 'rgba(255,204,102,0.12)', bd: 'rgba(255,204,102,0.4)' },
    PENDING: { text: 'MEASURING', fg: 'var(--muted)', bg: 'rgba(255,255,255,0.06)', bd: 'var(--line-strong)' },
  };
  const m = map[status] ?? map.PENDING;
  const b = el('span', { className: 'badge', textContent: m.text });
  b.style.color = m.fg;
  b.style.background = m.bg;
  b.style.border = `1px solid ${m.bd}`;
  return b;
}

/** The convergence trace, as a sparkline. Log cost, because it falls decades. */
function sparkline(trace: readonly { pass: number; cost: number }[]): HTMLElement | null {
  if (trace.length < 2) return null;
  const w = 320;
  const h = 38;
  const logs = trace.map((t) => Math.log10(Math.max(1e-12, t.cost)));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  const span = hi - lo || 1;
  const pts = logs
    .map((v, i) => {
      const x = (i / Math.max(1, logs.length - 1)) * w;
      const y = 34 - ((v - lo) / span) * 30;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(h));
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Optimiser cost falling with each accepted step');
  const base = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  base.setAttribute('x1', '0');
  base.setAttribute('y1', '36');
  base.setAttribute('x2', String(w));
  base.setAttribute('y2', '36');
  base.setAttribute('stroke', 'rgba(255,255,255,0.1)');
  svg.append(base);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', solveRunning ? '#4da6ff' : '#22c55e');
  line.setAttribute('stroke-width', '1.8');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.append(line);
  return svg as unknown as HTMLElement;
}

/**
 * One projector's warp mesh, drawn.
 *
 * The grey grid is the raster as the compositor addresses it; the coloured grid
 * is where each vertex has to move so the light lands where the compositor
 * thinks it does. The displacement is magnified by a stated factor, because at
 * true scale a good calibration and a bad one are both a straight grid — and the
 * factor is printed rather than tuned to taste.
 *
 * Every number here came from the model worker. This function positions lines.
 */
function meshDiagram(mesh: WarpMesh, tint: string, gain: number): HTMLElement {
  const W = 320;
  const H = Math.round((W * mesh.resY) / mesh.resX);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(H));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Warp mesh for ${mesh.projectorId}`);

  const sx = W / mesh.resX;
  const sy = H / mesh.resY;
  const at = (k: number, warped: boolean): [number, number] | null => {
    const dx = mesh.du[k];
    const dy = mesh.dv[k];
    if (warped && !Number.isFinite(dx)) return null;
    return [
      (mesh.u[k] + (warped ? dx * gain : 0)) * sx,
      (mesh.v[k] + (warped ? dy * gain : 0)) * sy,
    ];
  };

  for (const warped of [false, true]) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', warped ? tint : MESH_RASTER_COLOR);
    g.setAttribute('stroke-width', warped ? '1.3' : '1');
    // Rows then columns, each broken wherever a vertex missed the sphere: a
    // segment drawn straight through a gap would assert a correction nobody
    // computed.
    for (const alongRow of [true, false]) {
      const outer = alongRow ? mesh.rows : mesh.cols;
      const inner = alongRow ? mesh.cols : mesh.rows;
      for (let a = 0; a < outer; a++) {
        let run: string[] = [];
        for (let b = 0; b < inner; b++) {
          const k = alongRow ? a * mesh.cols + b : b * mesh.cols + a;
          const p = at(k, warped);
          if (!p) {
            if (run.length > 1) run = flushRun(g, run);
            else run = [];
            continue;
          }
          run.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
        }
        if (run.length > 1) flushRun(g, run);
      }
    }
    svg.append(g);
  }
  return svg as unknown as HTMLElement;
}

/**
 * One seam, close up: both projectors' copies of the same grid lines.
 *
 * Every point on this patch of sphere is drawn twice, once by each of the two
 * projectors that reach it, and where the two copies land apart is the doubled
 * line a visitor sees. Each is drawn in its own projector's colour, so which
 * line belongs to which lens is a fact about the picture rather than something
 * to be inferred, and the dashed vertical is the meridian they hand over on.
 *
 * `gain` magnifies the offsets and is printed by the caller. It has to: at
 * Boulder's throw a failing seam is a hundredth of a degree across a 24-degree
 * window, which is a fifth of a pixel here. What is NOT magnified is the
 * position of the lines themselves, so the shape of the patch stays true and
 * only the disagreement is amplified.
 */
function seamDiagram(patch: SeamPatch, gain: number): HTMLElement {
  const PAD = 6;
  const GUT = 0;
  const W = 262;
  const H = 132;
  // Headroom for the seam marker. It cannot live inside the plot: at the default
  // graticule a grid meridian falls exactly on the seam, so a line drawn there
  // is a line drawn underneath another one whatever order they are painted in.
  const TOP = 13;
  const lonSpan = patch.halfSpanDeg * 2;
  const latSpan = patch.latMaxDeg * 2;
  const lonMin = patch.seamLonDeg - patch.halfSpanDeg;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W + GUT + PAD * 2} ${H + TOP + PAD}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `The seam between P${patch.a + 1} and P${patch.b + 1}, offsets magnified ${Math.round(gain)} times`,
  );

  const x = (lon: number, dLon: number): number =>
    GUT + PAD + ((lon + dLon * gain - lonMin) / lonSpan) * W;
  const y = (lat: number, dLat: number): number =>
    TOP + ((patch.latMaxDeg - (lat + dLat * gain)) / latSpan) * H;

  const tints = [PROJECTOR_TINTS[patch.a] ?? '#888', PROJECTOR_TINTS[patch.b] ?? '#888'];
  for (const which of [0, 1] as const) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', tints[which]);
    g.setAttribute('stroke-width', '1.3');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    for (const line of patch.lines) {
      if (line.which !== which) continue;
      const pts: string[] = [];
      for (let i = 0; i < line.lonDeg.length; i++) {
        pts.push(
          `${x(line.lonDeg[i], line.dLonDeg[i]).toFixed(1)},` +
            `${y(line.latDeg[i], line.dLatDeg[i]).toFixed(1)}`,
        );
      }
      if (pts.length > 1) {
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        poly.setAttribute('points', pts.join(' '));
        g.append(poly);
      }
    }
    svg.append(g);
  }

  // Drawn LAST. At the default graticule a grid meridian falls exactly on the
  // seam, so underneath the lines this was invisible — and the legend was
  // pointing at a dashed line nobody could see.
  const sx = x(patch.seamLonDeg, 0).toFixed(1);
  const seam = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  seam.setAttribute('x1', sx);
  seam.setAttribute('x2', sx);
  seam.setAttribute('y1', String(TOP));
  seam.setAttribute('y2', String(TOP + H));
  seam.setAttribute('stroke', 'rgba(255,255,255,0.45)');
  seam.setAttribute('stroke-dasharray', '3 5');
  svg.append(seam);
  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  mark.setAttribute('x', sx);
  mark.setAttribute('y', '9');
  mark.setAttribute('text-anchor', 'middle');
  mark.setAttribute('fill', 'rgba(255,255,255,0.55)');
  mark.setAttribute('font-size', '8.5');
  mark.textContent = 'seam';
  svg.append(mark);
  return svg as unknown as HTMLElement;
}

/** Which colour is which projector, said once under the picture. */
/** The red the "before" mesh is drawn in. Named so the legend cannot drift. */
const MESH_BEFORE_COLOR = 'rgba(255,107,107,0.85)';
/** The unbent raster, ditto. `meshDiagram` draws it and `meshLegend` names it. */
const MESH_RASTER_COLOR = 'rgba(255,255,255,0.16)';

/**
 * What the two grids in a warp-mesh drawing are.
 *
 * The faint one is the projector's own raster, undistorted; the tinted one is
 * where the correction sends each vertex. After a solve there is a third, in the
 * same red the seam diagrams use for the state that was wrong.
 */
function meshLegend(tint: string, hasBefore: boolean): HTMLElement {
  const row = el('div', { className: 'legend' });
  const item = (color: string, text: string): void => {
    const span = el('span');
    const swatch = el('i');
    swatch.style.background = color;
    span.append(swatch, text);
    row.append(span);
  };
  item(MESH_RASTER_COLOR, 'the raster, unbent');
  if (hasBefore) item(MESH_BEFORE_COLOR, 'the old correction');
  item(tint, hasBefore ? 'the new one' : 'the correction');
  return row;
}

function seamLegend(patch: SeamPatch): HTMLElement {
  const row = el('div', { className: 'legend' });
  for (const slot of [patch.a, patch.b]) {
    const item = el('span');
    const swatch = el('i');
    swatch.style.background = PROJECTOR_TINTS[slot] ?? '#888';
    item.append(swatch, `P${slot + 1}`);
    row.append(item);
  }
  // Named rather than described: at the default graticule a grid meridian falls
  // on the seam and hides the dashed rule, so "dashed" was pointing at something
  // a reader could not always find. The marker at the top of the plot is labelled.
  row.append(el('span', { textContent: 'seam: where they hand over' }));
  return row;
}

/**
 * How much to magnify a seam's offsets.
 *
 * Chosen to put the worst one at a fixed fraction of the window rather than
 * tuned by eye, capped so a rig that is out by a lot does not draw lines off the
 * patch, and floored at 1 so an aligned seam draws as one line rather than as
 * two that have been pushed apart to look like something.
 */
function seamGain(worstDeg: number): number {
  if (!(worstDeg > 1e-4)) return 1;
  return Math.max(1, Math.min(120, 3.2 / worstDeg));
}

function flushRun(g: SVGElement, run: string[]): string[] {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', run.join(' '));
  g.append(line);
  return [];
}

/** How many rows of the recovery table are printed. See `recoveryRestEl`. */
const RECOVERY_ROWS = 6;

function recoveryTableEl(rows: readonly RecoveredAxis[]): HTMLElement {
  const table = el('table', { className: 'rec' });
  const head = el('tr');
  for (const h of ['', 'Axis', 'Config → recovered', 'vs truth']) {
    head.append(el('th', { textContent: h }));
  }
  table.append(head);
  for (const r of rows.slice(0, RECOVERY_ROWS)) {
    const tr = el('tr');
    const idx = Number(r.projectorId.replace(/\D/g, '')) - 1;
    const id = el('td', { textContent: r.projectorId });
    id.style.color = PROJECTOR_TINTS[idx] ?? 'var(--fg-2)';
    id.style.fontWeight = '600';
    tr.append(id);
    tr.append(el('td', { textContent: r.axis }));
    const d = Math.abs(r.documented) >= 100 ? 0 : 2;
    tr.append(
      el('td', {
        className: 'r num',
        textContent: `${r.documented.toFixed(d)} → ${r.recovered.toFixed(d)}${r.unit}`,
      }),
    );
    const off = el('td', {
      className: 'r num',
      textContent: `${r.errorFromTruth >= 0 ? '+' : ''}${r.errorFromTruth.toFixed(d)}${r.unit}`,
    });
    const rel = Math.abs(r.errorFromTruth) / Math.max(1e-9, Math.abs(r.moved));
    off.style.color = rel < 0.2 ? 'var(--good)' : rel < 0.6 ? 'var(--warn)' : 'var(--bad)';
    tr.append(off);
    table.append(tr);
  }
  return table;
}

/**
 * What the table did not show.
 *
 * Seven axes on four projectors is twenty-eight rows and the table prints six,
 * which is the right call — but it printed them under "Largest movements first"
 * with nothing saying there was a rest, so a reader concluded the solve had
 * touched six things. Naming the number is the difference between a summary and
 * a claim.
 */
function recoveryRestEl(rows: readonly RecoveredAxis[], shown: number): HTMLElement | null {
  const rest = rows.length - shown;
  if (rest <= 0) return null;
  return el('p', {
    className: 'note tiny',
    textContent: `${rest} more axes moved less, across every projector — the solver frees all of them at once.`,
  });
}

/**
 * The recovered geometry as `sos_stream_control.config` would carry it.
 *
 * Only coarse geometry lives in that file — heights and distances, in inches.
 * Everything finer is in the warp mesh, and the page says so rather than
 * implying a config edit is the whole calibration.
 */
function configText(recovered: RigCalibration, documented: RigCalibration): string {
  const inches = (m: number): string => (m / IN_TO_M).toFixed(1);
  const lines: string[] = [];
  lines.push(
    `Sphere_Height_At_Equator_Inches  ${inches(recovered.sphere.centerHeightM)}` +
      (Math.abs(recovered.sphere.centerHeightM - documented.sphere.centerHeightM) > 1e-6
        ? `   was ${inches(documented.sphere.centerHeightM)}`
        : ''),
  );
  for (let i = 0; i < recovered.projectors.length; i++) {
    const r = recovered.projectors[i];
    const d = documented.projectors[i];
    const hR = r.pose.position.z + recovered.sphere.centerHeightM;
    const hD = d ? d.pose.position.z + documented.sphere.centerHeightM : hR;
    const dR = Math.hypot(r.pose.position.x, r.pose.position.y);
    const dD = d ? Math.hypot(d.pose.position.x, d.pose.position.y) : dR;
    lines.push(
      `${r.id}_Height_Inches                 ${inches(hR)}` +
        (Math.abs(hR - hD) > 1e-6 ? `   was ${inches(hD)}` : ''),
    );
    lines.push(
      `${r.id}_DIST_INCHES                  ${inches(dR)}` +
        (Math.abs(dR - dD) > 1e-6 ? `   was ${inches(dD)}` : ''),
    );
  }
  return lines.join('\n');
}

/**
 * The doubled line itself, at one seam, with a picker for the others.
 *
 * The page's headline is a millimetre figure and its subject is a pair of lines
 * that do not sit on top of each other. Everything else here — the badge, the
 * gate, the warp mesh — describes that pair without ever drawing it, and the
 * reference implementation is right that this is the picture the product is
 * about. It lives in the readout rather than in the calibration result because
 * the doubled line exists BEFORE you solve; that is the whole complaint.
 *
 * After a recalibration the same seam is drawn twice, before and after, at the
 * same magnification — a comparison at two different scales would be worthless
 * and is the easiest way to accidentally overstate a result.
 */
/**
 * How much of the frame's width the seam patch is framed to fill.
 *
 * Not 1: the patch is `±halfSpanDeg` of longitude and the two graticule
 * meridians either side of the seam sit at its edges, which are what make a
 * doubled line read as doubled rather than as a line drawn crooked. Filling the
 * frame exactly would put them on the frame's edge, where the sphere's limb is
 * already crowding them and where a desktop's side panels are.
 */
const SEAM_FRAME_FILL = 0.7;

/**
 * Walk round to a seam and look straight at it.
 *
 * The diagram beside these chips is a MEASUREMENT, drawn at a stated
 * exaggeration because a tenth of a degree is a fifth of a pixel at any honest
 * scale. The sphere is the thing itself. A reader looking at "74.3 mm apart"
 * should be able to see 74.3 mm, and until this they had to find the seam by
 * dragging, with nothing on screen saying which way to drag.
 *
 * Three settings, all of them PANEL class — this moves a camera and touches
 * nothing the model reads:
 *
 *   - Azimuth is the seam's own world longitude. `SeamPatch.seamLonDeg` is
 *     half way round from one lens to the next through the gap between them, and
 *     the viewer's azimuth is a world longitude too, so the two are the same
 *     number.
 *   - Elevation is ZERO, which is the one choice here that is not forced. The
 *     seam is a meridian; from anywhere else it is foreshortened, and the
 *     equator crossing — where the blend band is widest and the doubling worst —
 *     is what a reader wants in the middle of the frame. This is an inspection,
 *     not a visitor: "stand where P1 does" on the projector card is the other
 *     thing and it puts the eye at 1.5 m, below the ball, on purpose.
 *   - The distance comes from `framingRangeM`, which solves for it rather than
 *     picking one, so the same framing holds at any sphere diameter and any
 *     field of view. On a phone, where the field is chosen from the aspect, it
 *     backs the eye off on its own.
 *
 * Framed on the HORIZONTAL field even on a portrait screen. The seam is a
 * vertical feature and the doubling is a horizontal distance, so width is the
 * dimension that has to fit; the latitude band overflowing the top and bottom of
 * a tall frame costs nothing. It also lands right: the sphere is drawn at the
 * middle of the room the two sheets leave, so the equator crossing arrives in
 * the middle of the band a phone reader can actually see.
 */
function lookAtSeam(patch: SeamPatch): void {
  const r = framingRangeM(
    (state.settings.sphereDiaIn * IN_TO_M) / 2,
    patch.halfSpanDeg,
    state.settings.viewFovDeg,
    SEAM_FRAME_FILL,
  );
  state.settings = withSetting(state.settings, 'viewAzDeg', wrapDeg180(patch.seamLonDeg));
  state.settings = withSetting(state.settings, 'viewElDeg', 0);
  // `withSetting` floors this against the sphere's own radius, so a wide field
  // asking for an eye inside the ball gets the closest it can stand instead.
  state.settings = withSetting(state.settings, 'viewRangeM', r);
  touched(false);
}

function seamSection(): HTMLElement | null {
  const seams = model?.seams ?? [];
  if (seams.length === 0) return null;
  const pick = Math.min(seamPick, seams.length - 1);
  const patch = seams[pick];
  const box = el('div', { className: 'sect' });

  const head = el('div', { className: 'rowline' });
  head.append(el('p', { className: 'eyebrow-sm', textContent: 'At the seams' }));
  head.append(
    el('span', {
      className: 'note tiny num',
      textContent: `${fmtMm(patch.worstMm)} mm apart`,
      title:
        'The worst distance between the two projectors’ copies of the same point, inside this ' +
        'seam. The headline above is the worst point anywhere on the sphere.',
    }),
  );
  box.append(head);

  box.append(
    chipRow(
      seams.map((s, i) => ({
        label: `P${s.a + 1}–P${s.b + 1}`,
        on: i === pick,
        title:
          `Draw the P${s.a + 1}–P${s.b + 1} seam below, and walk round to it — the ball turns to ` +
          'this seam and comes in close enough to see the doubling at full size.',
        onPick: () => {
          seamPick = i;
          // The picture and the diagram are the same subject, so the chip moves
          // both. `lookAtSeam` ends in `touched`, which redraws the readout.
          lookAtSeam(s);
        },
      })),
    ),
  );

  // ONE magnification for both pictures, taken from whichever is worse — which
  // before a solve is the "before" and after one is very much not.
  // Same seam, or no comparison: the ring is rebuilt on every pass and a "before"
  // taken from a different pair of projectors would be a comparison of two
  // unrelated things wearing the same label.
  const snapshot = beforeSeams[pick] ?? null;
  const before = snapshot && snapshot.a === patch.a && snapshot.b === patch.b ? snapshot : null;
  const gain = seamGain(Math.max(patch.worstDeg, before?.worstDeg ?? 0));

  if (before && solveResult) {
    // The caption follows the numbers. "They draw the same lines in different
    // places" is the usual case and is false for a seam that was already clean —
    // which happens whenever the bump was on the other side of the ring.
    // Coloured, because the two drawings are the same size and the same palette
    // and the readout scrolls: a diagram can appear without its heading, and
    // then which one is the problem and which the fix is unknowable. Red and
    // green are already the page's words for those two things.
    const was = el('p', {
      className: 'note tiny',
      textContent:
        before.worstMm >= 0.5
          ? `Before — P${before.a + 1} and P${before.b + 1} draw the same lines in different places`
          : `Before — P${before.a + 1} and P${before.b + 1} already agreed here`,
    });
    was.style.color = 'var(--bad)';
    box.append(was);
    box.append(seamDiagram(before, gain));
    const now = el('p', {
      className: 'note tiny',
      textContent: `After — ${fmtMm(before.worstMm)} mm apart became ${fmtMm(patch.worstMm)} mm`,
    });
    now.style.color = 'var(--good)';
    box.append(now);
  }
  box.append(seamDiagram(patch, gain));
  box.append(seamLegend(patch));

  box.append(
    el('p', {
      className: 'note',
      textContent:
        'Both projectors paint this patch, so every line here is drawn twice — once by each, in ' +
        'its own colour, and the marked meridian is where they hand over. Where the two ' +
        'copies land apart is the doubled line a visitor notices. The solver removes it by bending ' +
        'each projector’s image on the warp mesh.',
    }),
  );
  // What the picture's scale is, always — a diagram whose magnification is
  // chosen to look convincing and then not stated is not evidence.
  box.append(
    el('p', {
      className: 'note tiny num',
      textContent:
        gain > 1.01
          ? `offsets magnified ×${gain < 10 ? gain.toFixed(1) : gain.toFixed(0)} to be visible at all`
          : patch.worstMm < 0.5
            ? 'true scale — the two copies are on top of each other'
            : 'true scale — no magnification needed to see them apart',
    }),
  );
  return box;
}

function solveSection(): HTMLElement | null {
  if (!solveRunning && !solveResult && solveShots.length === 0) return null;
  const box = el('div', { className: 'sect' });

  const head = el('div', { className: 'rowline' });
  // The heading is derived from the same reading the badge above it is derived
  // from, so the two can never disagree. It used to be green unconditionally:
  // a solve that landed over the gate — high capture noise, say — printed a
  // green "Calibration result" directly under a red DRIFTED badge.
  const passed = model?.readings.find((r) => r.id === 'grid_displacement')?.status === 'PASS';
  // Three states, not two. The verdict is read live so a solve that landed over
  // the gate cannot print green under a red badge — but "live" and "what this
  // solve did" are the same thing only while nothing has moved since. Once a
  // lens has been knocked, this card is a record rather than a verdict, and
  // saying so beats re-judging a finished solve by a number it never saw.
  const stale = !solveRunning && rigMovedSinceSolve;
  const title = el('p', {
    className: 'eyebrow-sm',
    textContent: solveRunning
      ? 'Calibrating'
      : stale
        ? 'Last calibration — a lens has moved since'
        : passed
          ? 'Converged'
          : 'Still over the gate',
  });
  title.style.color = solveRunning
    ? 'var(--accent)'
    : stale
      ? 'var(--muted)'
      : passed
        ? 'var(--good)'
        : 'var(--warn)';
  const right = el('span', {
    className: 'note tiny num',
    textContent: solveRunning
      ? solveStep
        ? `step ${solveStep.step} · ${solveStep.rmsPx.toFixed(2)} px`
        : `${((performance.now() - solveStartedAt) / 1000).toFixed(0)} s`
      : solveResult
        ? `${((solveResult.captureMs + solveResult.solveMs) / 1000).toFixed(1)} s`
        : '',
  });
  head.append(title, right);
  // Put the analysis away without throwing the calibration away. The only
  // control that used to clear this section was "Forget it", which drops the
  // recovered rig and changes the picture on the sphere.
  if (!solveRunning) {
    const shut = el('button', {
      className: 'linkish',
      textContent: '✕',
      title: 'Hide this analysis. The calibration stays applied.',
      ariaLabel: 'Hide the calibration analysis',
    });
    shut.addEventListener('click', () => {
      solveResult = null;
      solveShots = [];
      solveTrace = [];
      solveStep = null;
      solveStage = '';
      renderReadout();
      renderInspect();
    });
    head.append(shut);
  }
  box.append(head);

  const spark = sparkline(solveTrace);
  if (spark) box.append(spark);
  if (solveStage) box.append(el('p', { className: 'note', textContent: solveStage }));

  if (solveShots.length > 0) {
    box.append(el('p', { className: 'eyebrow-sm', textContent: 'Where it shot from' }));
    const row = el('div', { className: 'shots' });
    solveShots.forEach((s, i) =>
      row.append(thumb(s, s.caption.split('—')[0].trim(), solveCameras[i])),
    );
    box.append(row);
    box.append(
      el('p', {
        className: 'note',
        textContent:
          'The room from each spot the camera was moved to — the sphere, the projectors on their ' +
          'hangers, the rail a visitor stands behind. That furniture is in the PICTURE and not in ' +
          'the capture: nothing in the model occludes a beam or casts a shadow. ' +
          (state.settings.roomSpill === 1
            ? 'Room spill is ON, so the reverse is also true and worth saying plainly: there IS a ' +
              'wall, a floor and a ceiling in the CAPTURE that are not in these pictures, and the ' +
              'solver received structured light on all of them. The number above is not ' +
              'comparable with the report. '
            : 'So what the solver actually received was structured light on a sphere and nothing ' +
              'else. ') +
          'These are renders of the same rig for the same reason: the capture patterns one ' +
          'projector at a time, so a single frame of it is a crescent of light on one side of the ' +
          'ball and tells you nothing about where anybody stood. Those frames go through a sensor ' +
          'with read noise and quantization, and those pixels are the solver’s entire input — it ' +
          'has never seen where the projectors are. Spread matters more than exact position: from ' +
          'one spot alone, a near projector zoomed in looks identical to a far one zoomed out.',
      }),
    );
  }

  if (solveResult) {
    const r = solveResult;
    box.append(
      el('p', {
        className: 'note',
        textContent:
          `${r.correspondences.toLocaleString()} points decoded from ${r.frames} frames ` +
          `(${r.grayBits} Gray planes). ` +
          (r.converged
            ? `Converged in ${r.iterations} steps, residual ${r.residualRmsPx.toFixed(3)} px.`
            : `Did NOT converge — stopped at the ${r.iterations}-step cap with a residual of ` +
              `${r.residualRmsPx.toFixed(3)} px, still moving. The result was not applied; the ` +
              'calibration in force is the one from before. More camera positions is the usual ' +
              'remedy, and a tripod rather than a handheld capture is the other.'),
      }),
    );

    // Below experiment 1's knee, but not refused. The refusal is at ONE position
    // (see MIN_CAMERA_POSITIONS, where the measurement is): the gap between one
    // and two is three orders of magnitude, and between two and three it is a
    // factor of 1.7. Two positions is a determinate network that recovers to
    // tens of millimetres — poor against a 2 mm gate, and worth saying, and not
    // the same thing as a rig that cannot be determined at all.
    if (state.cameraCount === 2) {
      box.append(
        el('p', {
          className: 'note',
          textContent:
            'Two camera positions is below the knee experiment 1 measured. Two recovers a median ' +
            'worst-lens error of 41.8 mm and three recovers 24.9 mm, over five seeds — both well ' +
            'over the 2 mm pose gate, and the third position is the cheapest of the two ' +
            'improvements left.',
        }),
      );
    }

    // A camera the segmentation refused contributed NOTHING, and refusing is the
    // right thing for it to have done — it found no framed sphere and declined to
    // guess rather than handing the solver a wall. But a silent refusal and a
    // working camera look identical from out here, so it is said out loud. This
    // is the one failure mode experiment 5's falsifiers actually caught.
    if (r.silhouetteRefusals > 0) {
      box.append(
        el('p', {
          className: 'note warn',
          textContent:
            `Segmentation refused ${r.silhouetteRefusals} of ${r.silhouetteCameras} camera views: ` +
            'it found no sphere clear of the frame edge and declined to guess rather than hand ' +
            'the solver a wall. Those views contributed nothing, so this solve used fewer ' +
            'cameras than it photographed from — and camera spread is the thing the recovery is ' +
            'most sensitive to. Step back, or frame the ball with room around it.',
        }),
      );
    }

    const seg = el('div', { className: 'seg' });
    for (const v of [
      { id: 'axes' as const, label: 'What it found' },
      { id: 'config' as const, label: 'Config file' },
    ]) {
      const b = el('button', { className: resultView === v.id ? 'on' : '', textContent: v.label });
      b.addEventListener('click', () => {
        resultView = v.id;
        renderReadout();
      });
      seg.append(b);
    }
    box.append(seg);

    if (resultView === 'axes') {
      box.append(recoveryTableEl(r.recovery));
      const rest = recoveryRestEl(r.recovery, RECOVERY_ROWS);
      if (rest) box.append(rest);
      box.append(
        el('p', {
          className: 'note',
          textContent:
            'Largest movements first, ranked by how far each one carries the picture across the ' +
            'sphere — a degree of aim moves it about as far as 90 mm of throw, so the two units ' +
            'can be compared. The last column is against ground truth the solver never ' +
            'saw — small there with a large movement is a good result, because it means the ' +
            'calibration moved a long way and landed in the right place.',
        }),
      );
    } else {
      const world = buildWorld(state.settings);
      box.append(el('pre', { className: 'cfg', textContent: configText(r.recoveredRig, world.asBuiltRig) }));
      box.append(
        el('p', {
          className: 'note',
          textContent:
            'Only coarse geometry — heights and distances, in inches — persists in the config. ' +
            'Everything finer lives in the warp mesh, which is what actually removes a doubled ' +
            'grid line.',
        }),
      );
      // A sentence that names a picture ought to be able to show it. The mesh
      // lives in the projector card's third tab, which a reader following this
      // paragraph had no way to reach.
      const toMesh = el('button', {
        className: 'linkish',
        textContent: `show me P${state.selected + 1}’s warp mesh`,
      });
      toMesh.addEventListener('click', () => {
        inspectView = 'mesh';
        state.inspectOpen = true;
        state.section = 'projectors';
        renderControls();
        renderInspect();
      });
      box.append(toMesh);
    }
  }
  return box;
}

function parityLine(): HTMLElement {
  const wrap = el('div', { className: 'sect' });
  wrap.dataset.smoke = 'parity';
  wrap.dataset.state = parity ? (parity.blind ? 'blind' : parity.pass ? 'ok' : 'bad') : 'pending';
  wrap.append(el('p', { className: 'eyebrow-sm', textContent: 'Picture vs model' }));
  if (!parity) {
    wrap.append(
      el('p', {
        className: 'note',
        textContent:
          'Measured when the view settles. The page renders the same camera twice — once on the ' +
          'GPU, once through the forward model on the CPU — and prints how far apart they are.',
      }),
    );
    return wrap;
  }
  const line = el('p', { className: 'note', textContent: parity.summary });
  line.style.color = parity.blind ? 'var(--warn)' : parity.pass ? 'var(--good)' : 'var(--bad)';
  wrap.append(line);
  wrap.append(
    el('p', {
      className: 'note tiny num',
      textContent:
        `worst pixel ${parity.delta.maxAbs.toExponential(1)} · ` +
        // The same precision the allowance is printed at. At one decimal the
        // pair collapses -- "0.2% of lit pixels over tolerance (0.2% allowed)"
        // reads as a contradiction and hides why the verdict failed.
        `${percentLabel(parity.delta.fractionOfLitOverTolerance)}% of lit pixels over ` +
        `tolerance (${ALLOWANCE_LABEL} allowed for edges) · ` +
        `${parity.delta.litPixelCount.toLocaleString()} lit of ` +
        `${parity.delta.pixelCount.toLocaleString()} px · CPU ${parity.cpuMs.toFixed(0)} ms`,
    }),
  );
  wrap.append(
    el('p', {
      className: 'note tiny',
      textContent:
        'The floor and the graticule are off on both sides for this comparison — the model’s ' +
        'two-calibration renderer draws no floor, and the graticule measures the driver’s ' +
        'trigonometry rather than this model. Both are what this number does not cover.',
    }),
  );
  return wrap;
}

const MULT_COLORS = ['#2a2f38', '#2a61a0', '#33ad6b', '#e62419'];

function coverageBar(fractions: readonly number[]): HTMLElement {
  const wrap = el('div', { className: 'sect' });
  wrap.append(el('p', { className: 'eyebrow-sm', textContent: 'Coverage' }));
  const bar = el('div', { className: 'bar' });
  const legend = el('div', { className: 'legend' });
  const labels = ['dark', 'one projector', 'two — a seam', 'THREE — impossible'];
  for (let i = 0; i < fractions.length; i++) {
    const f = fractions[i];
    if (f <= 0) continue;
    const color = MULT_COLORS[Math.min(i, MULT_COLORS.length - 1)];
    const seg = el('span');
    seg.style.width = `${(f * 100).toFixed(3)}%`;
    seg.style.background = color;
    bar.append(seg);
    const key = el('span');
    const sw = el('i');
    sw.style.background = color;
    key.append(sw, `${labels[Math.min(i, labels.length - 1)]} ${(f * 100).toFixed(1)}%`);
    legend.append(key);
  }
  wrap.append(bar, legend);
  return wrap;
}

function factsList(facts: readonly RigFact[]): HTMLElement {
  const wrap = el('div', { className: 'sect' });
  wrap.append(el('p', { className: 'eyebrow-sm', textContent: 'This rig' }));
  const table = el('table', { className: 'rec' });
  for (const f of facts) {
    const tr = el('tr');
    tr.setAttribute('title', f.note);
    tr.append(el('td', { textContent: f.label }));
    const v = el('td', { className: 'r num', textContent: f.value });
    tr.append(v);
    const verdict = el('td', { className: 'r', textContent: f.verdict });
    verdict.style.color = f.ok === null ? 'var(--dim)' : f.ok ? 'var(--good)' : 'var(--warn)';
    verdict.style.fontSize = '10px';
    tr.append(verdict);
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

function renderReadout(): void {
  readoutEl.replaceChildren();

  if (contextLost) {
    const box = el('div');
    box.append(el('p', { className: 'eyebrow-sm', textContent: 'The picture has stopped' }));
    const p = el('p', {
      className: 'note',
      textContent:
        'The browser took the GPU context away — a driver reset, or the tab being put to sleep. ' +
        'The picture on screen is the last frame drawn and is no longer following the controls. ' +
        'Every number below is still live: they are computed on the CPU in a worker, which is ' +
        'unaffected. The page asks for the context back and redraws itself when it gets one.',
    });
    p.style.color = 'var(--bad)';
    box.append(p);
    readoutEl.append(box);
  }

  if (lastError) {
    const box = el('div');
    box.append(el('p', { className: 'eyebrow-sm', textContent: 'Something failed' }));
    const p = el('p', { className: 'note', textContent: lastError });
    p.style.color = 'var(--bad)';
    box.append(p);
    readoutEl.append(box);
  }

  const grid = model?.readings.find((r) => r.id === 'grid_displacement');
  const head = el('div', { className: 'rowline' });
  head.append(el('p', { className: 'eyebrow-sm', textContent: 'Worst grid-line error' }));
  head.append(badgeFor(grid?.status ?? 'PENDING'));
  readoutEl.append(head);

  const big = el('div', { className: 'bigrow' });
  const value = el('div', {
    className: 'big num',
    textContent: model ? fmtMm(model.gridWorstMm) : '—',
  });
  // A stable hook for `tools/smoke-app.ts`. The tool must not key off styling
  // classes: a restyle would then break the one check that answers "did the
  // shader compile and did the worker reply", and it would break silently.
  value.dataset.smoke = 'grid-mm';
  value.style.color = grid ? (grid.status === 'PASS' ? 'var(--good)' : 'var(--bad)') : 'var(--muted)';
  const unit = el('div', {
    className: 'note unit',
    textContent: `mm  / gate ${grid?.gateShort || '1.00 mm'}`,
  });
  big.append(value, unit);
  readoutEl.append(big);

  readoutEl.append(
    el('p', {
      className: 'note phone-hide',
      textContent:
        'How far a line on the alignment grid lands from where it belongs, at the worst point on ' +
        'the sphere. This is the doubled or kinked line an operator sees. Under a millimetre is ' +
        'good — a visitor would never see it; the gate is the number §7 says it has to beat.',
    }),
  );

  // The typical seam beside the worst point. `sim` computes this — RMS over
  // every point at least two projectors reach, area-weighted — and the page
  // never printed it, so a rig with one bad corner and three clean seams read
  // the same as a rig that was out everywhere.
  const seam = model?.readings.find((r) => r.id === 'registration_error');
  if (seam) {
    readoutEl.append(
      el('p', {
        className: 'note tiny',
        textContent: `Across every blend band, RMS: ${seam.valueShort}.`,
        title: seam.means,
      }),
    );
  }

  if (model?.gridBaselineMm !== null && model !== null && solveResult) {
    const from = model.gridBaselineMm as number;
    const to = model.gridWorstMm;
    // Which way it went, said out loud. `from / to` printed as "N× better"
    // regardless of direction, so a solve that landed worse than it started
    // reported "0.4× better" in green — a number that is both wrong and
    // reassuring.
    const better = to <= from;
    const factor = better ? (to > 0 ? from / to : Infinity) : from > 0 ? to / from : Infinity;
    const d = el('p', { className: 'note num' });
    d.innerHTML = '';
    d.append(
      `${fmtMm(from)} mm before  →  `,
      el('strong', { textContent: `${fmtMm(to)} mm now` }),
      Number.isFinite(factor) ? `   (${factor.toFixed(1)}× ${better ? 'better' : 'worse'})` : '',
    );
    d.style.color = better ? 'var(--good)' : 'var(--bad)';
    d.dataset.smoke = 'improvement';
    readoutEl.append(d);
  } else if (model) {
    const world = buildWorld(state.settings);
    const place = worstPlacementOffender(world.perturbation, state.settings.distanceM);
    const aim = worstAimOffender(world.perturbation);
    const parts: string[] = [];
    if (place && place.displacementMm > 0) parts.push(`${place.projectorId} ${place.what} (${place.amount})`);
    if (aim && aim.displacementMm > 0) parts.push(`${aim.projectorId} ${aim.what} (${aim.amount})`);
    const byHand = !nudgesAreClear(state.settings.nudge);
    // "Biggest faults: plus what you moved by hand." is what the old phrasing
    // produced on a perfectly-mounted rig that has only been bumped, which is
    // the state one press of "Bump this one" leaves the page in.
    if (parts.length > 0) {
      readoutEl.append(
        el('p', {
          className: 'note tiny',
          textContent:
            `Biggest faults: ${parts.join('; ')}` +
            `${byHand ? ', plus what you moved by hand' : ''}.`,
        }),
      );
    } else if (byHand) {
      readoutEl.append(
        el('p', {
          className: 'note tiny',
          textContent: 'The mount is true; this is what you moved by hand.',
        }),
      );
    }
  }

  const seamBox = seamSection();
  if (seamBox) readoutEl.append(seamBox);

  const solveBox = solveSection();
  if (solveBox) readoutEl.append(solveBox);

  if (model) {
    const g = el('div', { className: 'grid2' });
    const cell = (k: string, v: string, title = ''): HTMLElement => {
      const d = el('div', { title });
      d.append(el('span', { className: 'k', textContent: k }), el('span', { className: 'v num', textContent: v }));
      return d;
    };
    const unlit = model.readings.find((r) => r.id === 'unlit_in_mask');
    const spill = model.readings.find((r) => r.id === 'off_sphere_flux_excess');
    // The gap between where the lenses are and where the software thinks they
    // are, live. These two cells used to read "— not solved" until a solve had
    // run, which is precisely the moment they both go back to nearly zero: a
    // bump was never quantified, only its consequence on the grid was. After a
    // solve the solver's own residual is the better number, because it has had
    // the unobservable global rotation removed.
    // The solver's residual only while it still describes the rig in the room.
    // See `rigMovedSinceSolve`.
    // ...and not from a solve that was refused: its residual describes a rig
    // that was never installed, so the cells would report the accuracy of a
    // calibration nobody is looking at.
    const fresh =
      rigMovedSinceSolve || solveResult === null || !solveInstalled(solveResult)
        ? null
        : solveResult;
    g.append(
      cell(
        'Lens position',
        fresh
          ? `${fmtMm(fresh.posePositionMm)} mm`
          : `${fmtMm(model.driftPositionMm)} mm`,
        fresh
          ? 'Worst lens position error after removing the unobservable global rotation. Ground truth; the solver never saw it.'
          : 'How far the worst lens has moved from where the software believes it is. Ground truth — recalibrating is what closes it.',
      ),
    );
    g.append(
      cell(
        'Lens aim',
        fresh ? `${fresh.poseRotationDeg.toFixed(3)}°` : `${model.driftAimDeg.toFixed(3)}°`,
        fresh
          ? 'Worst rotation error, roll included, after removing the unobservable global rotation.'
          : 'Worst rotation difference between the two rigs, roll included — the same basis the solver reports after a recalibration, so the two halves of the before-and-after are the same quantity.',
      ),
    );
    g.append(cell('Unlit above mask', unlit ? unlit.value : '—', unlit?.means ?? ''));
    g.append(cell('Excess spill', spill ? spill.value : '—', spill?.means ?? ''));
    readoutEl.append(g);
    // Four cells whose only explanation used to be a hover tooltip — which does
    // not exist on a touchscreen, and which the notes toggle never revealed. Two
    // of the four use words ("mask", "spill") the page defines nowhere visible.
    readoutEl.append(
      el('p', {
        className: 'note tiny phone-hide',
        textContent:
          'The first two are how far the software’s idea of a projector has fallen behind where ' +
          'it really is; both drop to the solver’s own residual when you recalibrate. Unlit is ' +
          'how much of the protected band gets no light at all — four projectors on one ring can ' +
          'never quite reach the poles. Spill is light that misses the ball and lands on the wall.',
      }),
    );

    readoutEl.append(factsList(model.facts));
    readoutEl.append(coverageBar(model.multiplicityAreaFraction));
    readoutEl.append(
      el('p', {
        className: 'note tiny',
        textContent:
          `The dark region at the bottom is ${(model.unlitPolarSouth * 100).toFixed(2)}% of the ` +
          `sphere and is not a circle — four-lobed and scalloped. ${model.framebuffer}`,
      }),
    );
  }

  readoutEl.append(parityLine());

  if (model) {
    readoutEl.append(
      el('p', {
        className: 'note tiny',
        textContent:
          `Computed by packages/sim at ${(model.densityScale * 100).toFixed(0)}% of the bench's ` +
          `sampling density in ${model.metricsMs.toFixed(0)} ms` +
          `${modelPending ? ' — a newer pass is running' : ''}.`,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------

/**
 * How far from the point of contact a projector still counts as hit, in CSS
 * pixels. A mouse gets almost nothing — the cursor tip is exact and a generous
 * radius would select things it is not over. A finger gets 22, which is about
 * half the 44px touch target everyone's guidelines ask for, because the miss it
 * prevents (a projector body is ten pixels across on a phone) is total: the tap
 * does nothing at all and looks like a broken page.
 */
const PICK_SLOP_PX: Record<string, number> = { touch: 22, pen: 10, mouse: 3 };

/**
 * Which projector marker is under a canvas event, or `-1`.
 *
 * The NDC conversion is the inverse of the shader's `vUv * 2 - 1`, with y
 * flipped because the DOM measures down from the top and the shader measures up.
 */
function markerUnder(e: PointerEvent, slopPx = PICK_SLOP_PX[e.pointerType] ?? 3): number {
  if (!lastUniforms) return -1;
  const r = canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return -1;
  const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
  const ndcY = 1 - ((e.clientY - r.top) / r.height) * 2;
  const hit = pickMarkerNear(
    lastUniforms,
    ndcX,
    ndcY,
    (2 * slopPx) / r.width,
    (2 * slopPx) / r.height,
  );
  // Back to a panel slot: with one projector switched off the rig is shorter
  // than the panel, and clicking the last marker used to select its neighbour.
  return slotOfRigIndex(hit, lastSlots);
}

/**
 * Select a projector from anywhere — a marker in the room, or a tab.
 *
 * Selecting is selecting. It used to also ISOLATE, so clicking a lens in the
 * room put the other three out and left you looking at a quarter-lit sphere —
 * which reads as having switched them off, and is a destructive-looking answer
 * to what should be the mildest gesture on the page. What a click does now is
 * point the panel and the card at that projector and nothing else. "Show only"
 * on the Room tab is still there for the isolating question, where it is
 * labelled and reversible.
 */
function selectProjector(i: number): void {
  state.selected = i;
  state.inspectOpen = true;
  state.section = 'projectors';
  markDirty();
  renderControls();
  renderInspect();
  renderActions();
}

/**
 * Orbit degrees per pixel dragged, slowed as the camera closes in.
 *
 * At arm's length a drag should swing you round the room; two metres from the
 * seam the same drag threw the view off the sphere entirely, because a degree of
 * azimuth covers the same arc no matter how near you are but the SCREEN covers
 * far less of it. The floor of 0.25 stops the gesture from dying at the closest
 * zoom.
 */
function orbitGain(): number {
  return Math.min(1, (state.settings.viewRangeM / 10.2) * 0.75 + 0.25);
}

/**
 * Move the eye, and put the panel back in step with it.
 *
 * The view sliders and the "Where you stand" chips read the same settings the
 * canvas gestures write, so a drag that only called `markDirty` left the Room
 * tab showing where you used to be — and left a viewpoint chip lit for a view
 * you had already orbited away from. `renderControls` runs on the settle timer
 * rather than per pointermove: rebuilding thirty rows at 60 Hz would cost more
 * than the picture.
 */
function viewSettled(): void {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    requestModel(true);
    renderControls();
  }, 260);
}

function zoomTo(range: number): void {
  state.settings = withSetting(state.settings, 'viewRangeM', range);
  markDirty();
  viewSettled();
}

/**
 * One wheel notch, in the units `deltaY` is actually reported in.
 *
 * `deltaMode` is not decoration. Chrome reports pixels (100 per notch) and
 * Firefox reports LINES — `deltaY` of 3 — so a handler that multiplies raw
 * `deltaY` zooms 33 times slower there: about 380 notches to get from the
 * opening 10.2 m to the seam, which reads as "scrolling does nothing" rather
 * than as a units bug.
 */
const WHEEL_LINE_PX = 16;

function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * WHEEL_LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * window.innerHeight;
  return e.deltaY;
}

function installPointer(): void {
  // Every pointer currently down on the canvas. One is an orbit, two is a pinch.
  //
  // The single-pointer version of this was a promise the page did not keep: the
  // hint line has said "scroll or pinch to zoom" since it was written, and a
  // phone has no scroll wheel, so on a touchscreen there was no way to zoom at
  // all short of finding the Range slider inside a panel that covered the
  // sphere. Two fingers arrived as two independent orbit drags fighting each
  // other, and the browser then cancelled both.
  const down = new Map<number, { x: number; y: number }>();
  let mode: 'idle' | 'orbit' | 'pinch' = 'idle';
  let lastX = 0;
  let lastY = 0;
  // Distance travelled since the press, so a drag that ends over a marker is not
  // also a click on it. Compared against a few pixels rather than zero because a
  // mouse moves a little while a button goes down — and a finger moves rather
  // more than a little, which is why the threshold follows the pointer type.
  let travel = 0;
  let tapType = 'mouse';
  let pinchSpan0 = 0;
  let pinchRange0 = 0;

  const span = (): number => {
    const p = [...down.values()];
    if (p.length < 2) return 0;
    return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  };
  const beginPinch = (): void => {
    mode = 'pinch';
    pinchSpan0 = Math.max(span(), 1);
    pinchRange0 = state.settings.viewRangeM;
    // A pinch is not a click, and it is not an orbit either: whichever finger
    // went down first has already accumulated travel, and lifting it must not
    // then be read as a tap on whatever is underneath.
    travel = 1e9;
  };

  canvas.addEventListener('pointerdown', (e) => {
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (down.size === 1) {
      mode = 'orbit';
      lastX = e.clientX;
      lastY = e.clientY;
      travel = 0;
      tapType = e.pointerType;
      canvas.classList.add('dragging');
    } else if (down.size === 2) {
      beginPinch();
    }
  });

  const stop = (e: PointerEvent): void => {
    if (!down.has(e.pointerId)) return;
    down.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* the capture was already released */
    }
    if (down.size === 1) {
      // Back to one finger: resume orbiting from wherever it now is rather than
      // from where the pinch started, or the view jumps.
      const p = [...down.values()][0];
      mode = 'orbit';
      lastX = p.x;
      lastY = p.y;
      return;
    }
    if (down.size > 0) return;

    mode = 'idle';
    canvas.classList.remove('dragging');
    // A tap, not a drag. A fingertip wobbles while it lifts; five pixels is the
    // right threshold for a mouse and would reject most real taps.
    if (travel < (tapType === 'touch' ? 14 : 5)) {
      const hit = markerUnder(e);
      if (hit >= 0) selectProjector(hit);
      else {
        // Clicking past the projectors puts them all back and puts the card
        // away. The pair reads as one gesture: click a lens to see only it,
        // click the room to see the sum — and on a phone this is how you get
        // the sphere back from under the card.
        const changed = state.highlight !== -1 || state.inspectOpen;
        state.highlight = -1;
        state.inspectOpen = false;
        if (changed) {
          markDirty();
          renderActions();
          renderInspect();
        }
      }
    }
    requestModel(true);
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  canvas.addEventListener('pointermove', (e) => {
    if (!down.has(e.pointerId)) {
      if (mode === 'idle') canvas.classList.toggle('overmarker', markerUnder(e) >= 0);
      return;
    }
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (down.size >= 2) {
      if (mode !== 'pinch') beginPinch();
      // Fingers apart means zoom IN, which is a shorter range: the ratio is the
      // starting span over the current one.
      zoomTo(pinchRange0 * (pinchSpan0 / Math.max(span(), 1)));
      return;
    }
    if (mode !== 'orbit') return;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    travel += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX;
    lastY = e.clientY;
    const gain = orbitGain();
    // Azimuth WRAPS rather than clamping. `withSetting` clamps to the control's
    // declared range, so dragging round the ball used to hit a wall at ±180° —
    // mid-orbit, for no reason a viewer could see.
    const az = state.settings.viewAzDeg - dx * 0.35 * gain;
    state.settings = withSetting(state.settings, 'viewAzDeg', ((az + 540) % 360) - 180);
    state.settings = withSetting(
      state.settings,
      'viewElDeg',
      state.settings.viewElDeg + dy * 0.3 * gain,
    );
    markDirty();
    viewSettled();
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // A trackpad pinch arrives as a wheel event with ctrlKey set, at a much
      // larger deltaY than a scroll notch. Treating the two the same made a
      // two-finger pinch on a laptop fly straight to the near limit.
      const k = e.ctrlKey ? 0.0004 : 0.0012;
      zoomTo(state.settings.viewRangeM * Math.exp(wheelPixels(e) * k));
    },
    { passive: false },
  );
  window.addEventListener('resize', markDirty);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Innermost first: the sheet over the lightbox over the card.
    if (helpEl.classList.contains('on')) closeHelp();
    else if (lightboxEl.classList.contains('on')) closeLightbox();
    else if (state.inspectOpen) {
      state.inspectOpen = false;
      renderInspect();
    }
  });
}

/**
 * A phone gets a different first screen.
 *
 * Not a different page — the same controls, the same numbers — but the panels
 * open on a wide screen would cover every pixel of the room on a narrow one, and
 * the sphere is the subject. So the control sheet and the projector card start
 * closed, leaving the action bar, the readout and the room.
 *
 * The threshold is the stylesheet's own: `@media (max-width: 820px)` is where it
 * stops putting two columns beside the sphere and starts stacking a sheet above
 * and a sheet below. These two used to disagree — 760 here, 820 there — which
 * left a 60-pixel band (iPad portrait sits in it) with the stacked layout and
 * both sheets open over a sphere still framed for a desktop.
 */
const NARROW_PX = 820;

/**
 * Where the bottom hint bar disappears (`@media (max-width: 900px)`). Below this
 * the subtitle is the only place a gesture can be named — a wider band than the
 * layout change, because it answers a different stylesheet rule.
 */
const HINT_PX = 900;

function narrowViewport(): boolean {
  return window.innerWidth < NARROW_PX;
}

/**
 * The bottom hint line is hidden below 900px, so on a phone the subtitle is the
 * only sentence naming the gestures. It says what you can DO here rather than
 * how the numbers are produced, which is what the desktop line is for and what a
 * reader on a 390-pixel screen has no room to care about yet.
 */
function gestureSub(): string {
  // The band this sentence covers reaches 900px, which on a laptop is a mouse.
  // Naming the wrong gesture is worse than naming none.
  return coarsePointer()
    ? 'Drag to rotate · pinch to zoom · tap a projector to see the frame it sends.'
    : 'Drag to rotate · scroll to zoom · click a projector to see the frame it sends.';
}
const DESKTOP_SUB =
  'Four projectors, one sphere. Knock one out of true and watch the seams double — then ' +
  'recalibrate and watch a solver find it from photographs alone.';

/**
 * What the fit last wrote into `viewFovDeg`, so a refit can tell its own value
 * from one the reader chose.
 *
 * The field of view is a slider on the Room tab, not an internal. Recomputing it
 * on every resize would be a page that argues with you; never recomputing it is
 * a phone that loaded in landscape and kept a 114-degree vertical frustum after
 * you turned it upright. So: refit only while the value is still the one the fit
 * put there.
 */
let fittedFov: number | null = null;
/** Which side of `NARROW_PX` the layout was last arranged for. */
let fittedNarrow: boolean | null = null;
/** Which side of `HINT_PX` the subtitle was last written for. */
let fittedGestures: boolean | null = null;

/** Returns true when something the panel draws actually moved. */
function fitFirstScreen(): boolean {
  const narrow = narrowViewport();
  // Two boundaries, and crossing either changes something drawn. The panel state
  // below follows only the layout one.
  const gesturesNow = window.innerWidth < HINT_PX;
  const crossed = fittedNarrow !== narrow || fittedGestures !== gesturesNow;
  const layoutCrossed = fittedNarrow !== narrow;
  fittedNarrow = narrow;
  fittedGestures = gesturesNow;

  const gestures = window.innerWidth < HINT_PX;
  const sub = document.querySelector('.brand .sub');
  if (sub) sub.textContent = gestures ? gestureSub() : DESKTOP_SUB;

  // Where the top sheet may start. The stylesheet cannot ask how tall the
  // wordmark came out — it wraps differently at 320px and at 430px, and the
  // subtitle's text changes with the viewport a few lines above — so the one
  // number that depends on it is measured and handed over.
  const brand = document.querySelector('.brand');
  if (brand) {
    const bottom = Math.ceil(brand.getBoundingClientRect().bottom);
    document.documentElement.style.setProperty('--sheet-top', `${bottom + 6}px`);
  }

  // Only on crossing the threshold: re-collapsing on every resize would slam the
  // panel shut under a reader who had just opened it, and a phone fires resize
  // for the address bar sliding away.
  if (layoutCrossed) {
    state.panelOpen = !narrow;
    rightEl.classList.toggle('collapsed', narrow);
  }

  // Only ever overwrite our own value. On the first call there is none, so the
  // fit takes it; after that a reader who moved the Field-of-view slider keeps
  // what they set, and crossing the threshold does not quietly undo it.
  const ours = fittedFov === null || Math.abs(state.settings.viewFovDeg - fittedFov) < 1e-6;
  let movedFov = false;
  if (ours) {
    const fov = narrow ? portraitFovDeg() : PERFECT_PRESET.viewFovDeg;
    movedFov = Math.abs(state.settings.viewFovDeg - fov) > 1e-6;
    state.settings = withSetting(state.settings, 'viewFovDeg', fov);
    fittedFov = state.settings.viewFovDeg;
  }
  return crossed || movedFov;
}

/**
 * Tell the stylesheet how much of the bottom of the screen the readout column is
 * actually taking.
 *
 * The phone layout is two sheets pinned to the top and bottom edges with the
 * room visible between them, and the top sheet's height has to be "what is left"
 * — which means somebody has to know what the bottom one took. The stylesheet
 * cannot ask: `#left` is bottom-anchored, its height is its content's, and its
 * content is a button, or a button and a readout, or a button and a projector
 * card, depending on what the reader has open.
 *
 * It used to guess, with a constant 54vh, and the guess was the readout at full
 * height. With the readout collapsed to its 44-pixel button that reserved about
 * four hundred pixels for a panel that was not on the screen — visible as a wide
 * empty band under the sphere — and it spent them on nothing, while the settings
 * sheet above was cut off mid-slider.
 *
 * Measured from the TOP of the column to the bottom of the window rather than
 * from its own box, so the 8px the card floats above the edge is counted too.
 */
function publishLeftHeight(): void {
  const top = leftEl.getBoundingClientRect().top;
  const h = Math.max(0, Math.round(window.innerHeight - top));
  document.documentElement.style.setProperty('--left-h', `${h}px`);
}

/**
 * Where the sphere belongs in the frame, in halves of the frame height, positive
 * DOWN. Zero on any viewport wide enough to put the panels beside the sphere.
 *
 * On a phone the two sheets are pinned to the top and bottom edges, so the room
 * a reader can see is the band between them — and that band is not centred on
 * the window. Drawing the ball at the middle of the WINDOW put it behind the
 * settings sheet the moment the sheet was allowed to be a useful size, which is
 * the other half of `publishLeftHeight`: reclaiming the space is only an
 * improvement if the picture does not go under the panel that reclaimed it.
 *
 * Measured from the two cards rather than from the CSS constants, because the
 * cards are what a reader can see and the constants are only their caps.
 */
function viewShiftFrac(): number {
  if (!narrowViewport()) return 0;
  const top = rightEl.getBoundingClientRect().bottom;
  const bottom = leftEl.getBoundingClientRect().top;
  const h = window.innerHeight;
  if (!(bottom > top) || h < 1) return 0;
  // Half-frames, which is the unit `buildViewer` takes: the middle of the window
  // is 0 and the bottom edge is 1.
  const shift = ((top + bottom) / 2 - h / 2) / (h / 2);
  // A band smaller than the ball cannot be aimed at usefully, and a runaway
  // value would swing the camera off the sphere entirely.
  return Math.max(-1, Math.min(1, shift));
}

/** The last shift the picture was drawn with, so a re-layout can tell if it moved. */
let drawnShift = 0;
let sheetTimer = 0;

/**
 * Re-measure the sheets and, if the room between them moved, redraw and re-check.
 *
 * Order matters and is not incidental: `publishLeftHeight` writes the variable
 * `#right`'s cap is computed from, and `viewShiftFrac` then reads a bounding
 * rectangle — which forces the layout the write invalidated. So one synchronous
 * call sees the whole chain settle, rather than measuring `#right` at the height
 * it had a moment ago.
 */
function settleSheets(): void {
  publishLeftHeight();
  const shift = viewShiftFrac();
  if (Math.abs(shift - drawnShift) < 0.002) return;
  drawnShift = shift;
  markDirty();
  // The camera moved, so the parity check's CPU half is for a view that is no
  // longer on the screen. Debounced, because a sheet opening settles over
  // several frames.
  window.clearTimeout(sheetTimer);
  sheetTimer = window.setTimeout(() => requestModel(true), 200);
}

/**
 * Keep `settleSheets` running whenever a panel changes shape on its own.
 *
 * A `ResizeObserver` rather than a hook on every control that can change a
 * panel's height: the readout grows when a solve lands, the projector card
 * appears on a tap, the settings sheet changes with the tab. One observer sees
 * all of it and cannot be forgotten by the next thing that changes a height.
 *
 * It is a BACKSTOP and not the mechanism, which the page's own phone check
 * insisted on. Delivery is asynchronous and, on a busy main thread — a panel
 * opening re-renders thirty rows and redraws the canvas — it was measured
 * arriving somewhere between 400 ms and a second after the toggle that caused
 * it. For most of a second the sheet was sized against the panel heights from
 * before the tap. The three buttons that deliberately change a panel's height
 * therefore call `settleSheets` themselves, synchronously; this catches
 * everything else.
 *
 * There is no feedback loop in it. `--left-h` is computed from `#left` alone and
 * only `#right`'s cap reads it, so the write can move `#right` and stops there.
 */
function watchSheets(): void {
  settleSheets();
  if (typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => settleSheets());
  ro.observe(leftEl);
  ro.observe(rightEl);
}

/**
 * Follow the viewport.
 *
 * The fit used to run once at boot, so a phone that loaded in landscape and was
 * then turned upright kept the desktop framing: both panels over the sphere and
 * a 71-degree horizontal field stretched to about 114 vertical, which is the
 * precise failure `portraitFovDeg` exists to prevent. Orientation changes are
 * the common case and they arrive as a resize; `orientationchange` is listened
 * for as well because iOS has historically fired it first.
 */
function watchViewport(): void {
  let timer = 0;
  const refit = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      // Only redraw the panel when the fit actually moved something. A phone
      // fires resize for the address bar sliding away, and `renderControls`
      // replaces the slider you are dragging — which drops its pointer capture
      // and leaves the knob stuck under your finger.
      if (!fitFirstScreen()) return;
      renderTopButtons();
      renderControls();
      markDirty();
      // The field of view moved, so the readings computed against the old one —
      // the parity check above all — are for a camera that is no longer there.
      requestModel(true);
    }, 120);
  };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
}

/**
 * A horizontal field chosen so the VERTICAL one stays sane on a tall screen.
 *
 * `viewFovDeg` is horizontal and the renderer derives the vertical half-angle by
 * multiplying by the raster's aspect — right on a desktop, and untenable in
 * portrait: 71° across a 390×844 screen works out to a 114° vertical field, so
 * the room stretches away at the top and bottom of the frame and the sphere in
 * the middle is forty pixels across. Holding the vertical field at 78° instead
 * puts the ball back at about a fifth of the screen width, which is where the
 * reference installation photo has it.
 *
 * Clamped to the slider's own range so this can never set a value the Range
 * control cannot show, and so a landscape phone gets the desktop framing back.
 */
/** Is the primary pointer a finger? Decides "tap" from "click". */
function coarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

function portraitFovDeg(): number {
  const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
  const halfV = Math.tan((78 / 2) * (Math.PI / 180));
  const fovH = 2 * Math.atan(halfV * aspect) * (180 / Math.PI);
  return Math.max(34, Math.min(71, fovH));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * True between `webglcontextlost` and the rebuild that answers it.
 *
 * A lost context is not an error anything throws: every GL call afterwards is a
 * silent no-op, and with `preserveDrawingBuffer: true` the compositor keeps the
 * last frame on screen. So the page looks alive — sliders move, the worker is
 * CPU-only and keeps answering — while the picture is frozen. And the parity
 * check, which reads pixels back off that dead context, reported the frozen
 * frame as a MODEL DISAGREEMENT: the page's most confident sentence, about the
 * one thing that had not gone wrong.
 */
let contextLost = false;

function installContextLossHandling(): void {
  // `preventDefault` is not optional bookkeeping: per the WebGL spec the browser
  // only attempts restoration when the lost handler calls it. Without a listener
  // at all — which is what this page had — the default action stands,
  // `webglcontextrestored` never fires, and a reload is the only way back.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    gl = null;
    renderReadout();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      gl = createDisplayGl(canvas);
    } catch (err) {
      fatal(
        `The GPU context was lost and could not be rebuilt: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    contextLost = false;
    // Every GPU-side object went with the context, so nothing may be assumed
    // still uploaded. Clearing the key forces the content back up on the next
    // pass, the same way `stopVideo` does.
    contentKey = '';
    lastVideoTime = -1;
    markDirty();
    renderReadout();
    requestModel(true);
  });
}

function boot(): void {
  installContextLossHandling();
  try {
    gl = createDisplayGl(canvas);
  } catch (err) {
    fatal(
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        'The numbers on this page do not need a GPU — they are computed by packages/sim on the CPU ' +
        'in a worker — but the picture does.',
    );
    return;
  }
  if (gl.missingUniforms.length > 0) {
    fatal(
      `The shader declares uniforms the linker did not expose: ${gl.missingUniforms.join(', ')}. ` +
        'Each one is a term of the model that has stopped being applied, and the picture would ' +
        'still look like a sphere.',
    );
  }
  try {
    state.explain = localStorage.getItem(EXPLAIN_KEY) === '1';
    state.seamsOpen = localStorage.getItem(SEAMS_KEY) === '1';
  } catch {
    /* storage disabled */
  }
  fitFirstScreen();
  watchViewport();
  watchSheets();
  installPointer();
  installDropTarget();
  void loadMarble();
  helpEl.addEventListener('click', (e) => {
    if (e.target === helpEl) closeHelp();
  });
  renderTopButtons();
  renderControls();
  renderActions();
  renderReadout();
  requestModel(true);
  requestAnimationFrame(frame);

  let seen = false;
  try {
    seen = localStorage.getItem(HELP_SEEN_KEY) === '1';
  } catch {
    /* storage disabled */
  }
  if (!seen) openHelp();
  // The solve's elapsed clock and the "measuring" state both want a repaint that
  // no message triggers. One second is enough for a five-second job.
  window.setInterval(() => {
    if (solveRunning) renderReadout();
  }, 1000);
}

boot();
