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
import { buildDisplayUniforms, pickMarkerNear, slotOfRigIndex } from '../src/uniforms.ts';
import type { DisplayUniforms, OverlayMode } from '../src/uniforms.ts';
import type { ParityVerdict } from '../src/parity.ts';
import { BOUNDARY_LIT_ALLOWANCE, PARITY_HEIGHT, PARITY_WIDTH, judgeParity } from '../src/parity.ts';
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
  solveSentImageId = '';
  touched(false);
  requestModel(true);
}
let customError = '';
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
    e.preventDefault();
    sliderDragging = true;
    setFromClientX(e.clientX);
    const move = (ev: PointerEvent): void => setFromClientX(ev.clientX);
    const up = (): void => {
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
/** Metrics passes that have landed. Exposed for `tools/smoke-app.ts`. */
let modelPasses = 0;
let modelWanted = -1;
let parityRequestKey = '';

function viewKey(): string {
  const s = state.settings;
  return `${s.viewAzDeg}|${s.viewElDeg}|${s.viewRangeM}|${s.viewFovDeg}`;
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
  const id = ++modelSeq;
  modelWanted = id;
  modelPending = true;
  window.clearTimeout(modelWatchdog);
  modelWatchdog = window.setTimeout(() => {
    if (!modelPending) return;
    modelPending = false;
    drainModel();
  }, 10_000);
  const req: ModelRequest = {
    kind: 'model',
    id,
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

modelWorker.onmessage = (event: MessageEvent<ModelMessage | FramesMessage>): void => {
  const msg = event.data;
  // A frame the lightbox asked for, on its own id sequence. It carries no
  // metrics and must not be mistaken for a stale model reply.
  if (msg.kind === 'frames') {
    if (!msg.ok || !lightbox || msg.slot !== lightbox.slot) return;
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
  // Before any early return below. A reply that released the lock without
  // draining would leave a queued pass unsent and the page frozen on the last
  // answer, which is a worse failure than the flood this replaced.
  drainModel();
  bootEl.classList.add('off');
  if (!msg.ok) {
    lastError = msg.error;
    renderReadout();
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
  if (msg.parityImage) checkParity(msg.parityImage, msg.parityMs);
  renderReadout();
  renderInspect();
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

function startSolve(): void {
  if (solveRunning) return;
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
      // Display only. `checkParity` builds its own uniforms and does not pass
      // this, so what the parity check reads back is the model's own radiance.
      exposure: state.settings.viewExposure,
      markerRadiusM: state.markersOn ? MARKER_RADIUS_M : 0,
      markerSelected: state.selected,
      ceilingM: state.settings.ceilingM,
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
      exposure: state.settings.viewExposure,
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
      // No floor, no overlay and NO EXPOSURE: `renderTwoRigRoomView` has none of
      // the three, so passing any of them here would make the parity number
      // measure a difference in settings rather than a disagreement between two
      // renderers. Exposure defaults to 1 by omission, which is the whole reason
      // the viewing gain can exist without touching this check. The cost is that
      // `shadeFloor` — its occlusion test and the room albedo — is the one part
      // of the shader this check does not cover.
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
  // "Seams, mask and the view" named a term — mask — that no visible sentence on
  // the page defines, in a heading whose job is to say what is underneath it.
  { id: 'room', label: 'Room', title: 'Seams, the polar hole and where you stand' },
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
      title: !selected
        ? `Edit P${i + 1}.`
        : on
          ? 'Click again to switch it off at the wall.'
          : 'Switched off at the wall — its quadrant of the framebuffer is dark. Click to switch it back on.',
    });
    const dot = el('span', { className: 'dot' });
    dot.style.background = PROJECTOR_TINTS[i] ?? '#888';
    b.append(dot, el('span', { textContent: `P${i + 1}` }));
    // First click selects, second click switches it off at the wall — and the
    // On / Off pair below says which state it is in, so the gesture is a
    // shortcut for a control that is visible rather than the only way to reach
    // it. Clicking a lens in the ROOM never toggles: an accidental double-click
    // on the sphere should not change the installation.
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
        'which is why the frame below does not move when you drag these. Clicking the tab of the ' +
        'projector already selected switches it off at the wall, which is what the pair below is ' +
        'showing you.',
    }),
  );
  {
    // The only switch on the page. Switching a projector off is a change to the
    // installation — a dark quadrant, a hole in the coverage, a different unlit
    // figure — so it gets a labelled control that says which state it is in,
    // rather than a second click on the tab you use to select things.
    const lit = state.settings.nudge[state.selected]?.on !== false;
    out.push(
      chipRow(
        [
          {
            label: 'On',
            on: lit,
            onPick: () => {
              if (lit) return;
              clearCalibration();
              state.settings = withNudge(state.settings, state.selected, { on: true });
              touched(true);
            },
          },
          {
            label: 'Off at the wall',
            on: !lit,
            onPick: () => {
              if (!lit) return;
              clearCalibration();
              state.settings = withNudge(state.settings, state.selected, { on: false });
              touched(true);
            },
          },
        ],
        'Switching one off is what an operator does when a lamp fails. Its quadrant of the ' +
          'framebuffer goes dark and the framebuffer keeps its size (§2), so the sphere loses that ' +
          'share of its light entirely and the neighbours do not widen to cover the gap — watch the ' +
          'unlit figure. Nothing else on this page turns a projector on or off.',
      ),
    );
  }
  const nudge = state.settings.nudge[state.selected];
  const tint = PROJECTOR_TINTS[state.selected] ?? '#888';
  const live = model?.live[state.selected] ?? true;
  if (!live) {
    const off = el('p', {
      className: 'grouphelp',
      textContent:
        `P${state.selected + 1} is switched off at the wall. Its quadrant of the framebuffer is ` +
        'dark and the framebuffer keeps its size — PARAMETERS.md §2\u2019s "quadrants go dark". ' +
        'The sphere loses that share of its light entirely; watch the unlit figure. The On / Off ' +
        'pair above puts it back.',
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
    for (const spec of specs) {
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
        }),
      );
    }
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
          state.settings = {
            ...p.s,
            nudge: p.s.nudge.map((n) => ({ ...n })),
            viewAzDeg: state.settings.viewAzDeg,
            viewElDeg: state.settings.viewElDeg,
            viewRangeM: state.settings.viewRangeM,
            viewFovDeg: state.settings.viewFovDeg,
            viewExposure: state.settings.viewExposure,
            content: state.settings.content,
            gridOn: state.settings.gridOn,
          };
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
  solveSentImageId = '';
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
  out.push(el('span', { className: 'lab', textContent: 'In the room' }));
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

/**
 * The notes toggle, remembered.
 *
 * The help sheet promises the notes "stay on until you turn it off", and every
 * reload turned them off. Same failure handling as the help flag: a browser with
 * storage disabled loses the preference rather than breaking.
 */
const EXPLAIN_KEY = 'sphere-sim.explain.v1';

function rememberExplain(): void {
  try {
    localStorage.setItem(EXPLAIN_KEY, state.explain ? '1' : '0');
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
  leftEl.classList.toggle('inspecting', subject);
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
        title: 'This projector lights the side of the ball you are not looking at.',
      });
      walk.addEventListener('click', () => {
        // Walking round the ball is a view change, not an installation change.
        state.settings = withSetting(state.settings, 'viewAzDeg', az);
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
        onPick: () => {
          seamPick = i;
          renderReadout();
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
          'the capture: nothing in the model emits light, occludes a beam or casts a shadow, so ' +
          'what the solver actually received was structured light on a sphere and nothing else. ' +
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
    const fresh = rigMovedSinceSolve ? null : solveResult;
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
        fresh ? 'Worst aim error, same basis.' : 'Worst aim difference between the two rigs.',
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
  try {
    state.explain = localStorage.getItem(EXPLAIN_KEY) === '1';
  } catch {
    /* storage disabled */
  }
  fitFirstScreen();
  watchViewport();
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
