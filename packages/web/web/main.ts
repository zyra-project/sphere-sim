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
import { prepareRig } from '../../sim/src/optics.ts';
import type { NudgeSpec, Settings, SettingKey } from '../src/settings.ts';
import {
  BOULDER_PRESET,
  CONTENTS,
  CONTENT_CUSTOM,
  CONTENT_MARBLE,
  CONTROLS,
  IN_TO_M,
  NUDGE_CONTROLS,
  PERFECT_PRESET,
  PROJECTOR_TINTS,
  RESOLUTIONS,
  SPEC_PRESET,
  VIEWPOINTS,
  clearNudges,
  formatSetting,
  withNudge,
  withSetting,
} from '../src/settings.ts';
import {
  buildViewer,
  buildWorld,
  nudgesAreClear,
  worstAimOffender,
  worstPlacementOffender,
} from '../src/rigs.ts';
import type { Reading, RigFact } from '../src/readout.ts';
import { buildDisplayUniforms, pickMarkerNear } from '../src/uniforms.ts';
import type { DisplayUniforms, OverlayMode } from '../src/uniforms.ts';
import type { ParityVerdict } from '../src/parity.ts';
import { BOUNDARY_LIT_ALLOWANCE, PARITY_HEIGHT, PARITY_WIDTH, judgeParity } from '../src/parity.ts';
import type {
  FrameImage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  RecoveredAxis,
  SolveMessage,
  SolveRequest,
  SolveResponse,
  WarpMesh,
} from '../src/protocol.ts';
import type { DisplayGl } from './gl.ts';
import { createDisplayGl, drawToCanvas, renderAndRead, uploadEquirect } from './gl.ts';

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
   * Separate from `selected` because on a phone the card is 30% of the screen
   * and the Projectors tab is the one that opens by default: tying the card to
   * the tab meant it covered the sphere before anyone had asked to see it, with
   * no way to put it away. Clicking a projector opens it; clicking past them, or
   * the card's own ✕, closes it.
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
  panelOpen: boolean;
  readoutOpen: boolean;
  /** Solve inputs. Deliberately few — see `protocol.ts` on why there is no noise slider. */
  cameraCount: number;
  handheld: boolean;
  ambient: number;
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
  // Open on a wide screen, where it sits beside the room and answers "what is
  // this page about" without a click. `boot` closes it on a phone.
  inspectOpen: true,
  overlay: 'none',
  highlight: -1,
  markersOn: true,
  railOn: true,
  aimGuides: false,
  // Off by default: with every note expanded the control panel is taller than
  // most screens, and a person who wants the reasoning is one click from it.
  explain: false,
  panelOpen: true,
  readoutOpen: true,
  cameraCount: 3,
  handheld: false,
  ambient: 0.04,
};

let model: ModelResponse | null = null;
let parity: ParityVerdict | null = null;
let solveResult: SolveResponse | null = null;
let solveRunning = false;
let solveStage = '';
let solveTrace: { pass: number; cost: number }[] = [];
let solveStep: { step: number; rmsPx: number } | null = null;
let solveShots: FrameImage[] = [];
let solveStartedAt = 0;
let modelPending = false;
let lastError = '';
let resultView: 'axes' | 'config' = 'axes';

let gl: DisplayGl | null = null;
let contentKey = '';
/** A supplied equirectangular image, in linear light. Never leaves the page. */
let customImage: EquirectImage | null = null;
let customName = '';
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
  touched(false);
  requestModel(true);
}
let customError = '';
/** Which image the model worker has been sent, so it is sent exactly once. */
let sentImageId = '';

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

function openLightbox(frame: FrameImage, caption: string): void {
  paintFrame(lightboxCanvas, frame);
  const cap = lightboxEl.querySelector('.cap');
  if (cap) cap.textContent = caption;
  lightboxEl.classList.add('on');
}
lightboxEl.addEventListener('click', () => lightboxEl.classList.remove('on'));

/** A thumbnail that opens full size when clicked. */
function thumb(frame: FrameImage, caption: string): HTMLElement {
  const fig = el('figure');
  const c = el('canvas');
  paintFrame(c, frame);
  fig.append(c, el('figcaption', { textContent: caption }));
  fig.addEventListener('click', () => openLightbox(frame, caption));
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
  options?: readonly string[];
  help: string;
  tint?: string;
  /** Draw the fill from the centre, and print a sign: a control whose zero is the middle. */
  bipolar?: boolean;
  klass?: string;
  onInput: (v: number) => void;
  onSettle?: () => void;
}

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
  const value = el('span', {
    className: 'val num',
    textContent: formatSetting(
      { decimals: o.decimals, unit: o.unit, options: o.options, signed: o.bipolar },
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

  const setFromClientX = (clientX: number): void => {
    const r = rail.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    const raw = o.min + t * span;
    const stepped = o.step > 0 ? Math.round(raw / o.step) * o.step : raw;
    o.onInput(Math.min(o.max, Math.max(o.min, stepped)));
  };
  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
    const move = (ev: PointerEvent): void => setFromClientX(ev.clientX);
    const up = (): void => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      if (o.onSettle) o.onSettle();
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
  });
  return wrap;
}

function chipRow(
  items: readonly { label: string; on: boolean; onPick: () => void; title?: string }[],
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
  return row;
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
    const ratio = bitmap.width / bitmap.height;
    if (Math.abs(ratio - 2) > 0.08) {
      throw new Error(
        `that image is ${bitmap.width}×${bitmap.height}, a ${ratio.toFixed(2)}:1 aspect. An ` +
          'equirectangular sphere map is 2:1 — stretching this one would put the poles in the ' +
          'wrong place.',
      );
    }
    // Downscale to the raster the rest of the page uses. A 4096-wide map is four
    // times the content the projectors can resolve at this geometry and sixteen
    // times the memory.
    const w = 1024;
    const h = 512;
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
        out.data[3 * i + c] = Math.pow(px[4 * i + c] / 255, 2.2);
      }
    }
    return out;
  } finally {
    bitmap.close();
  }
}

async function loadCustomImage(file: File): Promise<void> {
  customError = '';
  try {
    customImage = await readEquirect(file);
    customName = `${file.name}:${file.size}`;
    sentImageId = '';
    state.settings = withSetting(state.settings, 'content', CONTENT_CUSTOM);
    contentKey = '';
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
    if (file) void loadCustomImage(file);
  });
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

const modelWorker = new Worker(new URL('../worker/model.js', import.meta.url), { type: 'module' });
const solveWorker = new Worker(new URL('../worker/solve.js', import.meta.url), { type: 'module' });

let modelSeq = 0;
let modelWanted = -1;
let parityRequestKey = '';

function viewKey(): string {
  const s = state.settings;
  return `${s.viewAzDeg}|${s.viewElDeg}|${s.viewRangeM}|${s.viewFovDeg}`;
}

function requestModel(fine: boolean): void {
  const id = ++modelSeq;
  modelWanted = id;
  modelPending = true;
  const req: ModelRequest = {
    kind: 'model',
    id,
    settings: state.settings,
    compositorRig: state.compositorRig,
    densityScale: fine ? 1 : 0.3,
    parity: null,
    // Only on the settled pass: a projector frame is a CPU trace and four of
    // them on every drag would starve the metrics they sit beside.
    projectorPreviewWidth: fine ? 296 : 0,
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
  if (fine) {
    const camera = buildViewer(state.settings, PARITY_WIDTH, PARITY_HEIGHT);
    req.parity = {
      width: PARITY_WIDTH,
      height: PARITY_HEIGHT,
      fovHDeg: camera.fovHDeg,
      position: camera.position,
      target: camera.target,
    };
    parityRequestKey = viewKey();
  }
  modelWorker.postMessage(req);
  renderReadout();
}

modelWorker.onmessage = (event: MessageEvent<ModelMessage>): void => {
  const msg = event.data;
  // Drop a stale reply: a coarse pass sent before the last drag can land after
  // the fine pass that superseded it, and showing it would make the panel walk
  // backwards for no visible reason.
  if (msg.id !== modelWanted) return;
  modelPending = false;
  bootEl.classList.add('off');
  if (!msg.ok) {
    lastError = msg.error;
    renderReadout();
    return;
  }
  lastError = '';
  // A coarse pass carries no projector frames; keep the last good ones rather
  // than blanking the inspect card on every drag.
  const keptFrames = msg.projectorFrames.length > 0 ? msg.projectorFrames : (model?.projectorFrames ?? []);
  model = { ...msg, projectorFrames: keptFrames };
  if (msg.parityImage) checkParity(msg.parityImage, msg.parityMs);
  renderReadout();
  renderInspect();
};

solveWorker.onmessage = (event: MessageEvent<SolveMessage>): void => {
  const msg = event.data;
  if (msg.kind === 'solve-progress') {
    solveStage = msg.message;
    if (msg.shots) solveShots = msg.shots;
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
  state.compositorRig = msg.recoveredRig;
  solveStage = '';
  markDirty();
  requestModel(true);
  renderActions();
};

let solveSeq = 0;

function startSolve(): void {
  if (solveRunning) return;
  solveRunning = true;
  solveTrace = [];
  solveStep = null;
  solveShots = [];
  solveResult = null;
  solveStartedAt = performance.now();
  solveStage = 'Placing the cameras…';
  const req: SolveRequest = {
    kind: 'solve',
    id: ++solveSeq,
    settings: state.settings,
    cameraCount: state.cameraCount,
    // The bench's own corpus runs at 320×240 and every number this project has
    // published was measured there. Matching it means the page and the report
    // are talking about the same thing.
    cameraResX: 320,
    cameraResY: 240,
    handheld: state.handheld,
    sensorNoise: true,
    ambient: state.ambient,
    seed: (state.settings.errorSeed * 2654435761) % 2147483647,
  };
  solveWorker.postMessage(req);
  renderActions();
  renderReadout();
}

function forgetCalibration(): void {
  state.compositorRig = null;
  solveResult = null;
  solveTrace = [];
  solveStep = null;
  solveShots = [];
  markDirty();
  requestModel(true);
  renderActions();
}

/** Anything that moves the LENSES invalidates a calibration solved for the old rig. */
function invalidateCalibration(): void {
  if (state.compositorRig === null) return;
  state.compositorRig = null;
  solveResult = null;
  solveTrace = [];
  solveStep = null;
  solveShots = [];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let dirty = true;
function markDirty(): void {
  dirty = true;
}

function ensureContent(image: { width: number; height: number; data: Float32Array }): void {
  const key = `${state.settings.gridDeg}|${state.settings.content}|${state.settings.gridOn}|${suppliedName()}`;
  if (gl && key !== contentKey) {
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
const MARKER_RADIUS_M = 0.12;

/**
 * The uniforms of the last on-screen frame, kept so a click can be turned into a
 * projector. It is the drawn state, not a recomputed one: picking against a
 * freshly built camera would drift from what the viewer is looking at during the
 * frame a drag ends on.
 */
let lastUniforms: DisplayUniforms | null = null;

function draw(): void {
  if (!gl) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const world = buildWorld(state.settings, state.compositorRig ?? undefined, suppliedImage());
  ensureContent(world.image);
  const camera = buildViewer(state.settings, w, h);
  const uniforms = buildDisplayUniforms(
    prepareRig(world.truthRig),
    prepareRig(world.compositorRig),
    world.scene,
    camera,
    {
      overlay: state.overlay,
      highlight: state.highlight,
      slots: world.slots,
      drawFloor: true,
      floorRadiusM: 13,
      displayGamma: 2.2,
      markerRadiusM: state.markersOn ? MARKER_RADIUS_M : 0,
      markerSelected: state.selected,
      ceilingM: state.settings.ceilingM,
      rail: state.railOn,
      aimGuides: state.aimGuides,
    },
  );
  lastUniforms = uniforms;
  // Test hooks, set by the function that draws so they cannot describe a state
  // the picture is not in. `tools/smoke-app.ts` clicks a marker it found by
  // colour and reads these back.
  canvas.dataset.selected = String(state.selected);
  canvas.dataset.highlight = String(state.highlight);
  // The camera, so a test can assert that a pinch actually moved it rather than
  // that the page merely survived one.
  canvas.dataset.range = state.settings.viewRangeM.toFixed(3);
  canvas.dataset.az = state.settings.viewAzDeg.toFixed(2);
  drawToCanvas(gl, uniforms, w, h);
}

function checkParity(
  cpu: { width: number; height: number; data: Float32Array },
  cpuMs: number,
): void {
  if (!gl) return;
  if (viewKey() !== parityRequestKey) {
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
    const camera = buildViewer(state.settings, cpu.width, cpu.height);
    const uniforms = buildDisplayUniforms(
      prepareRig(world.truthRig),
      prepareRig(world.compositorRig),
      world.scene,
      camera,
      // No floor and no overlay: `renderTwoRigRoomView` draws neither, so drawing
      // either here would make the parity number measure a difference in
      // settings. The cost is that `shadeFloor` — its occlusion test and the room
      // albedo — is the one part of the shader this check does not cover.
      { overlay: 'none', highlight: -1, drawFloor: false, displayGamma: 0, slots: world.slots },
    );
    const gpu = renderAndRead(gl, uniforms, cpu.width, cpu.height);
    parity = judgeParity(gpu, { width: cpu.width, height: cpu.height, data: cpu.data }, {
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
  if (invalidates) invalidateCalibration();
  markDirty();
  renderControls();
  renderReadout();
  requestModel(false);
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => requestModel(true), 260);
}

function setSetting(key: SettingKey, value: number): void {
  state.settings = withSetting(state.settings, key, value);
  const spec = CONTROLS.find((c) => c.key === key);
  touched(spec ? spec.group !== 'view' : true);
}

function setNudge(key: NudgeSpec['key'], value: number): void {
  state.settings = withNudge(state.settings, state.selected, { [key]: value });
  touched(true);
}

const SECTIONS: { id: SectionId; label: string; title: string }[] = [
  { id: 'projectors', label: 'Projectors', title: 'The lenses, one at a time' },
  { id: 'install', label: 'Install', title: 'What was built' },
  { id: 'room', label: 'Room', title: 'Seams, mask and the view' },
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
    const b = el('button', {
      className: `${state.selected === i ? 'on' : ''}${on ? '' : ' dark'}`,
      title: on
        ? 'Click to select. Click again to switch it off at the wall.'
        : 'Switched off — its quadrant of the framebuffer is dark. Click to switch it back on.',
    });
    const dot = el('span', { className: 'dot' });
    dot.style.background = PROJECTOR_TINTS[i] ?? '#888';
    b.append(dot, el('span', { textContent: `P${i + 1}` }));
    b.addEventListener('click', () => {
      if (state.selected === i && state.inspectOpen) {
        state.settings = withNudge(state.settings, i, { on: !on });
        touched(true);
        return;
      }
      selectProjector(i);
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
        'REAL position and aim; what the software believes only changes when you recalibrate, ' +
        'which is why the frame below does not move when you drag these. Click a selected ' +
        'projector again to switch it off.',
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
        'The sphere loses that share of its light entirely; watch the unlit figure. Click its tab ' +
        'again to switch it back on.',
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
        onSettle: () => requestModel(true),
      }),
    );
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
function controlsFor(groups: readonly string[], skip: readonly SettingKey[] = []): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const spec of CONTROLS.filter((c) => groups.includes(c.group) && !skip.includes(c.key))) {
    out.push(
      slider({
        label: spec.label,
        symbol: spec.symbol,
        value: state.settings[spec.key],
        min: spec.min,
        max: spec.max,
        step: spec.step,
        decimals: spec.decimals,
        unit: spec.unit,
        options: spec.options,
        help: `${spec.section} ${spec.help}`.trim(),
        klass: spec.klass,
        bipolar: spec.min < 0 && spec.max > 0,
        onInput: (v) => setSetting(spec.key, v),
        onSettle: () => requestModel(true),
      }),
    );
  }
  return out;
}

function installSection(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(
    el('p', {
      className: 'grouphelp',
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
        on: false,
        onPick: () => {
          state.settings = { ...p.s, nudge: p.s.nudge.map((n) => ({ ...n })) };
          invalidateCalibration();
          markDirty();
          renderControls();
          requestModel(true);
        },
      })),
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
    ),
  );
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
          'Not offered, and the reason is one of the three facts this project exists to reproduce: ' +
          'SOS drives every projector from ONE framebuffer split into four quadrant viewports ' +
          '(§3.4), so a fifth projector has no quadrant to be. PARAMETERS.md §2 supports 2, 3 and ' +
          '4 and nothing else. A six-projector ring is a perfectly buildable thing — it is just a ' +
          'different display from the one this simulates, and pretending otherwise here would put ' +
          'a number on screen for a machine that does not exist.',
        on: false,
        onPick: () => {},
      },
    ]),
  );
  out.push(...controlsFor(['install', 'lens', 'error'], ['resolution', 'projectorCount']));
  return out;
}

function roomSection(): HTMLElement[] {
  const out: HTMLElement[] = [];

  out.push(el('span', { className: 'lab', textContent: 'On the sphere' }));
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
      ...CONTENTS.map((c, i) => ({
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
    ]),
  );
  const chosen = CONTENTS[Math.round(state.settings.content)] ?? CONTENTS[1];
  out.push(el('p', { className: 'grouphelp', textContent: chosen.help }));

  // Always offered, never conditional on already having one. The previous
  // version showed the button only once an image was loaded or the "Your own
  // image" chip was selected, which meant the one control that answers "can I put
  // MY data on this?" was invisible until you had already found it.
  {
    const row = el('div', { className: 'chips' });
    const pick = el('button', {
      className: 'chip',
      textContent: customImage ? `Replace “${customName.split(':')[0]}”` : 'Use your own image…',
      title: 'Any 2:1 equirectangular map. Read in the page and never sent anywhere.',
    });
    pick.addEventListener('click', pickImage);
    row.append(pick);
    if (customImage) {
      const drop = el('button', { className: 'chip', textContent: 'Remove' });
      drop.addEventListener('click', () => {
        customImage = null;
        customName = '';
        sentImageId = '';
        contentKey = '';
        setSetting('content', CONTENT_MARBLE);
      });
      row.append(drop);
    }
    out.push(row);
    out.push(
      el('p', {
        className: 'note tiny',
        textContent:
          'Or drop a file anywhere on the page. Any 2:1 equirectangular map — a NOAA dataset, a ' +
          'test chart, your own. It is read in the page, converted out of sRGB into the linear ' +
          'light the model works in, and never sent anywhere.',
      }),
    );
  }
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

  out.push(...controlsFor(['blend', 'view'], ['content', 'gridOn']));
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
        'Tinted by whichever projector is contributing most, in the four panel colours. The line ' +
        'between two tints is the middle of the blend band — and it moves when a projector moves.',
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
  out.push(el('span', { className: 'lab', textContent: 'Where you stand' }));
  // Which chip is lit, if any: dragging the sphere leaves none of them lit,
  // which is correct — the viewpoint is then wherever you put it.
  const here = VIEWPOINTS.findIndex((v) =>
    (Object.keys(v.view) as (keyof typeof v.view)[]).every(
      (k) => Math.abs(state.settings[k] - v.view[k]) < 1e-6,
    ),
  );
  out.push(
    chipRow(
      VIEWPOINTS.map((v, i) => ({
        label: v.label,
        title: v.help,
        on: here === i,
        onPick: () => {
          state.settings = { ...state.settings, ...v.view };
          touched(true);
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
          'glows in its own colour; click one to see only its light and the frame going down its ' +
          'cable. Scenery — the trace is not told any of it exists, and no light comes off it.',
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
          'The rail visitors stand behind, and its footprint on the floor. Scenery — nothing in ' +
          'the model reads it, it emits no light and occludes none.',
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
  out.push(el('span', { className: 'lab', textContent: 'Isolate' }));
  const n = Math.round(state.settings.projectorCount);
  out.push(
    chipRow([
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
          // Isolating also selects, so the inspect card is showing the frame of
          // the projector whose light is on screen rather than some other one's.
          state.selected = i;
          state.inspectOpen = true;
          markDirty();
          renderControls();
          renderInspect();
        },
      })),
    ]),
  );
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
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void loadCustomImage(file);
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

function openHelp(): void {
  const sheet = helpEl.querySelector('.sheet');
  if (!sheet) return;
  sheet.replaceChildren();

  const h = (tag: 'h2' | 'h3' | 'p', text: string, cls = ''): HTMLElement =>
    el(tag, { textContent: text, className: cls });

  sheet.append(h('h2', 'What this is'));
  sheet.append(
    h(
      'p',
      'A Science On a Sphere theatre, simulated. Four projectors ring a 68-inch ball and paint ' +
        'one image between them. Getting them to agree — so a coastline drawn by two projectors ' +
        'lands in one place rather than two — is the whole problem, and this page lets you break ' +
        'it and then fix it.',
    ),
  );

  sheet.append(h('h3', 'The one thing worth understanding'));
  sheet.append(
    h(
      'p',
      'There are two rigs, not one. Where the lenses ACTUALLY are, and where the software BELIEVES ' +
        'they are. Move a projector and only the first changes — which is why the frame that ' +
        'projector is sending does not move, and why the picture on the ball goes wrong. ' +
        'Recalibrating is what updates the second one.',
    ),
  );

  sheet.append(h('h3', 'Try this'));
  const list = el('ul');
  for (const item of [
    'Drag to walk around the sphere — the orbit passes underneath it. Scroll, or pinch on a ' +
      'touchscreen, to move closer. Tap a projector to see the frame it is sending; tap the room ' +
      'to put that card away.',
    'On the Room tab, press "Whole room" to step outside the ring — all four projectors, each in its own colour. Click a lens to see only its light and the frame going down its cable.',
    'On the Projectors tab, drag "Aim left / right" and watch the grid lines double at the seams — the number on the left climbs past its 1 mm gate.',
    'Press Recalibrate. The simulator photographs the sphere with structured light, the solver works out where the lenses really are from those photographs alone, and the sphere converges as it goes. Five seconds or so.',
    'Open "What it found" to see which axis it moved and how close it landed to the truth it never saw.',
    'On the Room tab, turn the grid off and drop any 2:1 equirectangular image on the page — a NOAA dataset, Blue Marble, a test chart.',
  ]) {
    list.append(el('li', { textContent: item }));
  }
  sheet.append(list);

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
  const btn = el('button', { className: 'btn primary', textContent: 'Start' });
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

function renderActions(): void {
  actionsEl.replaceChildren();

  const bump = el('button', {
    className: 'btn',
    textContent: 'Bump this one',
    title: 'Knock the selected projector by about a quarter of a degree, the way a ladder does.',
  });
  bump.addEventListener('click', () => {
    const i = state.selected;
    const n = state.settings.nudge[i];
    // A fixed step rather than a random one: the same click twice does the same
    // thing, and every number this page shows depends on that.
    state.settings = withNudge(state.settings, i, {
      yawDeg: Math.max(-3, Math.min(3, (n?.yawDeg ?? 0) + 0.25)),
      rollDeg: Math.max(-3, Math.min(3, (n?.rollDeg ?? 0) + 0.15)),
    });
    touched(true);
  });
  actionsEl.append(bump);

  const drift = el('button', {
    className: 'btn',
    textContent: 'Another install',
    title:
      'Draw a different mount error at the same magnitude. Deterministic — the seed is on the ' +
      'Install tab, and the same seed always gives the same rig.',
  });
  drift.addEventListener('click', () => {
    // Also turns the mount shake ON, because the page opens with it off. A button
    // labelled "another install" that produced the same perfectly-mounted rig
    // every time would be a button that does nothing.
    state.settings = clearNudges(state.settings);
    state.settings = withSetting(state.settings, 'mountError', 1);
    setSetting('errorSeed', ((state.settings.errorSeed + 104729) % 999_999) + 1);
  });
  actionsEl.append(drift);

  const solve = el('button', {
    className: 'btn primary',
    textContent: solveRunning ? 'Calibrating…' : 'Recalibrate',
    disabled: solveRunning,
    title: 'Photograph the sphere with structured light and solve for where the lenses really are.',
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
  leftEl.classList.toggle('inspecting', subject && frame !== null);
  if (!subject || !frame) {
    inspectEl.classList.remove('on');
    return;
  }
  inspectEl.classList.add('on');
  const tint = PROJECTOR_TINTS[state.selected] ?? '#888';
  const on = state.settings.nudge[state.selected]?.on !== false;

  const head = el('div', { className: 'rowline' });
  const name = el('p', { className: 'eyebrow-sm', textContent: `P${state.selected + 1}` });
  name.style.color = tint;
  // Walk round to this projector's side.
  //
  // Isolating a projector that lights the far side of the ball leaves you
  // looking at the unlit back of it, which is the truth and reads as a fault.
  // The azimuth comes off the drawn uniforms rather than being recomputed, so
  // the link goes exactly where the marker is.
  let caption: HTMLElement = el('span', { className: 'note tiny', textContent: frame.caption });
  if (state.highlight === state.selected && lastUniforms) {
    const lx = lastUniforms.physical.lens[3 * state.selected];
    const ly = lastUniforms.physical.lens[3 * state.selected + 1];
    const az = (Math.atan2(ly, lx) * 180) / Math.PI;
    const lightsFarSide = Math.abs(((az - state.settings.viewAzDeg + 540) % 360) - 180) > 120;
    if (lightsFarSide) {
      const walk = el('button', {
        className: 'linkish',
        textContent: `stand where P${state.selected + 1} does`,
        title: 'This projector lights the side of the ball you are not looking at.',
      });
      walk.addEventListener('click', () => {
        state.settings = withSetting(state.settings, 'viewAzDeg', az);
        touched(true);
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
    const c = el('canvas', { className: 'framepic' });
    paintFrame(c, frame);
    c.addEventListener('click', () => openLightbox(frame, `P${state.selected + 1} — ${frame.caption}`));
    inspectEl.append(c);
    inspectEl.append(
      el('p', {
        className: 'note',
        textContent:
          'The image this projector is sending down the cable. It fades out at the left and right ' +
          'where it hands over to its neighbours — widest across the equator, pinching shut toward ' +
          'the poles. Moving the projector does NOT change this picture, because the software has ' +
          'not been told. Recalibrating is what rewrites it.',
      }),
    );
    if (!on) {
      const off = el('p', { className: 'note', textContent: 'Currently switched off at the wall.' });
      off.style.color = 'var(--warn)';
      inspectEl.append(off);
    }
  }

  const cfg = model?.projectorConfig[state.selected] ?? null;
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
  if (inspectView === 'mesh' && mesh) {
    // Magnified so the shape is legible. At true scale a 1 mm error and a 100 mm
    // error are both a straight grid, so the factor is chosen to put the worst
    // vertex at a fixed fraction of the raster — and then printed, because a
    // diagram whose scale is picked to look convincing is not evidence.
    const gain =
      mesh.worstPx > 1e-9 ? Math.min(400, Math.max(1, (0.07 * mesh.resX) / mesh.worstPx)) : 1;
    inspectEl.append(meshDiagram(mesh, tint, gain));
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
    g.setAttribute('stroke', warped ? tint : 'rgba(255,255,255,0.16)');
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

function flushRun(g: SVGElement, run: string[]): string[] {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', run.join(' '));
  g.append(line);
  return [];
}

function recoveryTableEl(rows: readonly RecoveredAxis[]): HTMLElement {
  const table = el('table', { className: 'rec' });
  const head = el('tr');
  for (const h of ['', 'Axis', 'Config → recovered', 'vs truth']) {
    head.append(el('th', { textContent: h }));
  }
  table.append(head);
  for (const r of rows.slice(0, 6)) {
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

function solveSection(): HTMLElement | null {
  if (!solveRunning && !solveResult && solveShots.length === 0) return null;
  const box = el('div', { className: 'sect' });

  const head = el('div', { className: 'rowline' });
  const title = el('p', {
    className: 'eyebrow-sm',
    textContent: solveRunning ? 'Calibrating' : 'Calibration result',
  });
  title.style.color = solveRunning ? 'var(--accent)' : 'var(--good)';
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
  box.append(head);

  const spark = sparkline(solveTrace);
  if (spark) box.append(spark);
  if (solveStage) box.append(el('p', { className: 'note', textContent: solveStage }));

  if (solveShots.length > 0) {
    box.append(el('p', { className: 'eyebrow-sm', textContent: 'Where it shot from' }));
    const row = el('div', { className: 'shots' });
    for (const s of solveShots) row.append(thumb(s, s.caption.split('—')[0].trim()));
    box.append(row);
    box.append(
      el('p', {
        className: 'note',
        textContent:
          'The sphere from each spot the camera was moved to. These are renders of the same rig, ' +
          'not frames from the capture: the capture patterns one projector at a time, so a single ' +
          'frame is a crescent of light on one side of the ball and tells you nothing about where ' +
          'anybody stood. The frames themselves go through a sensor with read noise and ' +
          'quantization, and those pixels are the solver’s entire input — it has never seen where ' +
          'the projectors are. Spread matters more than exact position: from one spot alone, a ' +
          'near projector zoomed in looks identical to a far one zoomed out.',
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
          `(${r.grayBits} Gray planes). Converged in ${r.iterations} steps` +
          `${r.converged ? '' : ' — hit the cap'}, residual ${r.residualRmsPx.toFixed(3)} px.`,
      }),
    );

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
      box.append(
        el('p', {
          className: 'note',
          textContent:
            'Largest movements first. The last column is against ground truth the solver never ' +
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
        `${(parity.delta.fractionOfLitOverTolerance * 100).toFixed(1)}% of lit pixels over ` +
        `tolerance (${(BOUNDARY_LIT_ALLOWANCE * 100).toFixed(0)}% allowed for edges) · ` +
        `${parity.delta.litPixelCount.toLocaleString()} lit of ` +
        `${parity.delta.pixelCount.toLocaleString()} px · CPU ${parity.cpuMs.toFixed(0)} ms`,
    }),
  );
  wrap.append(
    el('p', {
      className: 'note tiny',
      textContent:
        'The floor is off on both sides for this comparison, because the model’s two-calibration ' +
        'renderer draws none — so the floor is the one part of the shader this does not cover.',
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
  const unit = el('div', { className: 'note unit', textContent: `mm  / gate ${grid?.gate || '1.000'}` });
  big.append(value, unit);
  readoutEl.append(big);

  readoutEl.append(
    el('p', {
      className: 'note',
      textContent:
        'How far a line on the alignment grid lands from where it belongs, at the worst point on ' +
        'the sphere. This is the doubled or kinked line an operator sees.',
    }),
  );

  if (model?.gridBaselineMm !== null && model !== null && solveResult) {
    const from = model.gridBaselineMm as number;
    const to = model.gridWorstMm;
    const factor = to > 0 ? from / to : Infinity;
    const d = el('p', { className: 'note num' });
    d.innerHTML = '';
    d.append(
      `${fmtMm(from)} mm before  →  `,
      el('strong', { textContent: `${fmtMm(to)} mm now` }),
      Number.isFinite(factor) ? `   (${factor.toFixed(1)}× better)` : '',
    );
    d.style.color = 'var(--good)';
    d.dataset.smoke = 'improvement';
    readoutEl.append(d);
  } else if (model) {
    const world = buildWorld(state.settings);
    const place = worstPlacementOffender(world.perturbation, state.settings.distanceM);
    const aim = worstAimOffender(world.perturbation);
    const parts: string[] = [];
    if (place && place.displacementMm > 0) parts.push(`${place.projectorId} ${place.what} (${place.amount})`);
    if (aim && aim.displacementMm > 0) parts.push(`${aim.projectorId} ${aim.what} (${aim.amount})`);
    if (!nudgesAreClear(state.settings.nudge)) parts.push('plus what you moved by hand');
    if (parts.length > 0) {
      readoutEl.append(
        el('p', { className: 'note tiny', textContent: `Biggest faults: ${parts.join('; ')}.` }),
      );
    }
  }

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
    g.append(
      cell(
        'Lens position',
        solveResult ? `${fmtMm(solveResult.posePositionMm)} mm` : '— not solved',
        'Worst lens position error after removing the unobservable global rotation. Ground truth; the solver never saw it.',
      ),
    );
    g.append(
      cell(
        'Lens aim',
        solveResult ? `${solveResult.poseRotationDeg.toFixed(3)}°` : '— not solved',
        'Worst aim error, same basis.',
      ),
    );
    g.append(cell('Unlit above mask', unlit ? unlit.value : '—', unlit?.means ?? ''));
    g.append(cell('Excess spill', spill ? spill.value : '—', spill?.means ?? ''));
    readoutEl.append(g);

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
  return pickMarkerNear(lastUniforms, ndcX, ndcY, (2 * slopPx) / r.width, (2 * slopPx) / r.height);
}

/**
 * Select a projector from anywhere — a marker in the room, or a tab.
 *
 * Selecting isolates it, which is the answer to "what is THIS one painting":
 * everything else goes dark and what is left is that projector's contribution,
 * with its own frame beside it in the inspect card.
 */
function selectProjector(i: number): void {
  state.selected = i;
  state.highlight = i;
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

function zoomTo(range: number): void {
  state.settings = withSetting(state.settings, 'viewRangeM', range);
  markDirty();
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => requestModel(true), 260);
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
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // A trackpad pinch arrives as a wheel event with ctrlKey set, at a much
      // larger deltaY than a scroll notch. Treating the two the same made a
      // two-finger pinch on a laptop fly straight to the near limit.
      const k = e.ctrlKey ? 0.0004 : 0.0012;
      zoomTo(state.settings.viewRangeM * Math.exp(e.deltaY * k));
    },
    { passive: false },
  );
  window.addEventListener('resize', markDirty);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Innermost first: the sheet over the lightbox over the card.
    if (helpEl.classList.contains('on')) closeHelp();
    else if (lightboxEl.classList.contains('on')) lightboxEl.classList.remove('on');
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
 * closed, leaving the action bar, the readout and the room. The threshold is the
 * width at which two 330px columns plus a sphere between them stop fitting.
 */
const NARROW_PX = 760;

function fitFirstScreen(): void {
  if (window.innerWidth >= NARROW_PX) return;
  state.panelOpen = false;
  state.inspectOpen = false;
  rightEl.classList.add('collapsed');
  state.settings = withSetting(state.settings, 'viewFovDeg', portraitFovDeg());
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
function portraitFovDeg(): number {
  const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
  const halfV = Math.tan((78 / 2) * (Math.PI / 180));
  const fovH = 2 * Math.atan(halfV * aspect) * (180 / Math.PI);
  return Math.max(34, Math.min(71, fovH));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot(): void {
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
  fitFirstScreen();
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
