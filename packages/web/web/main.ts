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
  CONTROLS,
  IN_TO_M,
  NUDGE_CONTROLS,
  PERFECT_PRESET,
  PROJECTOR_TINTS,
  RESOLUTIONS,
  SPEC_PRESET,
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
import { buildDisplayUniforms } from '../src/uniforms.ts';
import type { OverlayMode } from '../src/uniforms.ts';
import type { ParityVerdict } from '../src/parity.ts';
import { BOUNDARY_PIXEL_ALLOWANCE, PARITY_HEIGHT, PARITY_WIDTH, judgeParity } from '../src/parity.ts';
import type {
  FrameImage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  RecoveredAxis,
  SolveMessage,
  SolveRequest,
  SolveResponse,
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
  overlay: OverlayMode;
  /** `-1` shows every projector; otherwise isolate one. */
  highlight: number;
  explain: boolean;
  panelOpen: boolean;
  /** Solve inputs. Deliberately few — see `protocol.ts` on why there is no noise slider. */
  cameraCount: number;
  handheld: boolean;
  ambient: number;
}

const state: PageState = {
  settings: { ...BOULDER_PRESET, nudge: BOULDER_PRESET.nudge.map((n) => ({ ...n })) },
  compositorRig: null,
  section: 'projectors',
  selected: 0,
  overlay: 'none',
  highlight: -1,
  // Off by default: with every note expanded the control panel is taller than
  // most screens, and a person who wants the reasoning is one click from it.
  explain: false,
  panelOpen: true,
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
let customError = '';
/** Which image the model worker has been sent, so it is sent exactly once. */
let sentImageId = '';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const controlsEl = document.getElementById('controls') as HTMLDivElement;
const actionsEl = document.getElementById('actions') as HTMLDivElement;
const topBtnsEl = document.getElementById('topbtns') as HTMLDivElement;
const rightEl = document.getElementById('right') as HTMLDivElement;
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
      out.data[4 * i + c] = Math.min(255, Math.round(255 * Math.pow(v, 1 / 2.2)));
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

function installDropTarget(): void {
  const stop = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const type of ['dragenter', 'dragover', 'dragleave'] as const) {
    window.addEventListener(type, stop);
  }
  window.addEventListener('drop', (e) => {
    stop(e);
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
    projectorPreviewWidth: fine ? 208 : 0,
    // Sent once per image, not once per request: the worker caches it by id, and
    // a megabyte of float on every slider drag would cost more than the metrics.
    // A copy rather than a transfer, because the main thread still needs it for
    // the GPU upload.
    customImage:
      customImage !== null && customName !== sentImageId
        ? { width: customImage.width, height: customImage.height, data: customImage.data }
        : null,
    customImageId: customImage === null ? '' : customName,
  };
  sentImageId = customImage === null ? '' : customName;
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
    if (msg.step) solveTrace.push({ pass: msg.step.pass, cost: msg.step.cost });
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
  const key = `${state.settings.gridDeg}|${state.settings.content}|${state.settings.gridOn}|${customName}`;
  if (gl && key !== contentKey) {
    uploadEquirect(gl, image);
    contentKey = key;
  }
}

function draw(): void {
  if (!gl) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const world = buildWorld(state.settings, state.compositorRig ?? undefined, customImage);
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
      drawFloor: true,
      floorRadiusM: 8,
      displayGamma: 2.2,
    },
  );
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
    const world = buildWorld(state.settings, state.compositorRig ?? undefined, customImage);
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
      { overlay: 'none', highlight: -1, drawFloor: false, displayGamma: 0 },
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
      if (state.selected === i) {
        state.settings = withNudge(state.settings, i, { on: !on });
        touched(true);
        return;
      }
      state.selected = i;
      state.highlight = i;
      markDirty();
      renderControls();
      renderInspect();
      renderActions();
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
        'Pick a projector to move it. These are its REAL position and aim — what the software ' +
        'believes only changes when you recalibrate, which is why the frame below does not move ' +
        'when you drag these. Click a selected projector again to switch it off.',
    }),
  );
  const nudge = state.settings.nudge[state.selected];
  const tint = PROJECTOR_TINTS[state.selected] ?? '#888';
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
        help: spec.help,
        tint,
        bipolar: true,
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

  if (Math.round(state.settings.content) === CONTENT_CUSTOM || customImage !== null) {
    const row = el('div', { className: 'chips' });
    const pick = el('button', {
      className: 'chip',
      textContent: customImage ? `Replace “${customName.split(':')[0]}”` : 'Choose an image…',
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
        setSetting('content', 1);
      });
      row.append(drop);
    }
    out.push(row);
    out.push(
      el('p', {
        className: 'note tiny',
        textContent:
          'Or drop a file anywhere on the page. Any 2:1 equirectangular map — a NOAA dataset, Blue ' +
          'Marble, a test chart. It is read in the page, converted out of sRGB into the linear ' +
          'light the model works in, and never sent anywhere.',
      }),
    );
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
          markDirty();
          renderControls();
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
    className: 'linkish',
    textContent: state.explain ? 'hide notes' : 'explain',
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
  const toggle = el('button', {
    className: 'btn icon',
    textContent: state.panelOpen ? '–' : '≡',
    title: state.panelOpen ? 'Hide the controls' : 'Show the controls',
  });
  toggle.addEventListener('click', () => {
    state.panelOpen = !state.panelOpen;
    rightEl.classList.toggle('collapsed', !state.panelOpen);
    renderTopButtons();
  });
  topBtnsEl.append(toggle);
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
    state.settings = clearNudges(state.settings);
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
    state.settings = { ...BOULDER_PRESET, nudge: BOULDER_PRESET.nudge.map((n) => ({ ...n })) };
    state.overlay = 'none';
    state.highlight = -1;
    forgetCalibration();
    renderControls();
  });
  actionsEl.append(reset);
}

// ---------------------------------------------------------------------------
// The inspect card: one projector's own frame
// ---------------------------------------------------------------------------

function renderInspect(): void {
  inspectEl.replaceChildren();
  const frame = model?.projectorFrames[state.selected];
  if (state.section !== 'projectors' || !frame) {
    inspectEl.classList.remove('on');
    return;
  }
  inspectEl.classList.add('on');
  const tint = PROJECTOR_TINTS[state.selected] ?? '#888';
  const on = state.settings.nudge[state.selected]?.on !== false;

  const head = el('div', { className: 'rowline' });
  const name = el('p', { className: 'eyebrow-sm', textContent: `P${state.selected + 1} — its own frame` });
  name.style.color = tint;
  head.append(name, el('span', { className: 'note tiny', textContent: frame.caption }));
  inspectEl.append(head);

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
    PASS: { text: 'WITHIN GATE', fg: '#7ee2a8', bg: 'rgba(34,197,94,0.14)', bd: 'rgba(34,197,94,0.4)' },
    FAIL: { text: 'OVER GATE', fg: '#ff9b9b', bg: 'rgba(255,107,107,0.14)', bd: 'rgba(255,107,107,0.4)' },
    REFERENCE: { text: 'REFERENCE', fg: '#999', bg: 'rgba(255,255,255,0.06)', bd: 'var(--line-strong)' },
    PROVISIONAL: { text: 'PROVISIONAL', fg: '#ffcc66', bg: 'rgba(255,204,102,0.12)', bd: 'rgba(255,204,102,0.4)' },
    PENDING: { text: 'MEASURING', fg: '#999', bg: 'rgba(255,255,255,0.06)', bd: 'var(--line-strong)' },
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
      ? `${((performance.now() - solveStartedAt) / 1000).toFixed(0)} s`
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
    box.append(el('p', { className: 'eyebrow-sm', textContent: 'What it worked from' }));
    const row = el('div', { className: 'shots' });
    for (const s of solveShots) row.append(thumb(s, s.caption.split('—')[0].trim()));
    box.append(row);
    box.append(
      el('p', {
        className: 'note',
        textContent:
          'Real rendered photographs, one per camera position, through a sensor with read noise ' +
          'and quantization. These pixels are the solver’s entire input — it has never seen where ' +
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
  wrap.dataset.state = parity ? (parity.pass ? 'ok' : 'bad') : 'pending';
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
  line.style.color = parity.pass ? 'var(--good)' : 'var(--bad)';
  wrap.append(line);
  wrap.append(
    el('p', {
      className: 'note tiny num',
      textContent:
        `worst pixel ${parity.delta.maxAbs.toExponential(1)} · ` +
        `${(parity.delta.fractionOverTolerance * 100).toFixed(2)}% over tolerance ` +
        `(${(BOUNDARY_PIXEL_ALLOWANCE * 100).toFixed(0)}% allowed for edges) · ` +
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

function installPointer(): void {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
  });
  const stop = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* the capture was already released */
    }
    requestModel(true);
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    state.settings = withSetting(state.settings, 'viewAzDeg', state.settings.viewAzDeg - dx * 0.35);
    state.settings = withSetting(state.settings, 'viewElDeg', state.settings.viewElDeg + dy * 0.3);
    markDirty();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const next = state.settings.viewRangeM * Math.exp(e.deltaY * 0.0012);
      state.settings = withSetting(state.settings, 'viewRangeM', next);
      markDirty();
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => requestModel(true), 260);
    },
    { passive: false },
  );
  window.addEventListener('resize', markDirty);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') lightboxEl.classList.remove('on');
  });
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
  installPointer();
  installDropTarget();
  renderTopButtons();
  renderControls();
  renderActions();
  renderReadout();
  requestModel(true);
  requestAnimationFrame(frame);
  // The solve's elapsed clock and the "measuring" state both want a repaint that
  // no message triggers. One second is enough for a five-second job.
  window.setInterval(() => {
    if (solveRunning) renderReadout();
  }, 1000);
}

boot();
