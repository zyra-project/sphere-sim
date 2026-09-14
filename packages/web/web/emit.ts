// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The projector emitter. `docs/OPERATOR-PATH.md` Phase 1.
 *
 * ## What this page is
 *
 * It is the projectors. A browser window full-screen on the framebuffer SOS
 * drives IS the four projector rasters, because §3.4's framebuffer is one X
 * screen split 2×2 rather than four outputs — so a page that can paint that
 * window can put a structured-light frame on any projector without installing
 * anything, without touching the display pipeline, and without asking anybody
 * for administrator rights. That removes friction 1 from the operator path
 * outright, and friction 1 is the one that ends most adoptions before they
 * start.
 *
 * The consequence runs the other way too and shapes every decision below:
 * **everything this page draws goes on the sphere.** A control panel, a mouse
 * cursor, a focus ring, a bright background — each of those is light on the ball
 * while the shutter is open. So the page has an explicitly ARMED state in which
 * it paints the pattern and literally nothing else, and getting into it is a
 * deliberate act rather than an idle timeout that a bumped mouse can undo.
 *
 * ## What it does not do, deliberately
 *
 * It does not record what it emitted. Knowing which pattern a photograph shows
 * is friction 3, the one genuinely unsolved problem in the plan, and Phase 2
 * settles it **by measurement between three candidate mechanisms**. Inventing a
 * manifest format here would pre-empt that measurement with a guess, and the
 * guess would be the thing everything downstream was built on. The page shows
 * the plan it is playing and counts the steps out loud; turning that into an
 * index a decoder can trust is the next phase's job and is named as such.
 *
 * ## Why the pattern is quantized here and nowhere else
 *
 * `targetRadiance` evaluates the pattern at the continuous coordinate a camera
 * pixel sees and deliberately does not snap it to projector pixel centres,
 * because the bench has no model of the projector's pixel footprint and a
 * staircase with nothing to blur it would be an artifact no projector produces.
 * A real projector is exactly the case that inverts the argument: its raster is
 * a pixel grid and it brings its own footprint. So here the pattern is sampled
 * once per emitted pixel — at pixel centres, which is decode.ts's own
 * convention — and `rasterFit` exists to say whether those pixels are the
 * projector's own or a resampled copy of them.
 *
 * ## Where the numbers come from
 *
 * Nothing on this page is a nominal. The projector count, the raster and the
 * plan are all stated by the operator, because "take the surface and the rig
 * from what the operator supplies, never from a nominal" is the standing rule
 * the shapes work put on this plan — a tool that quietly falls back to the
 * nominal sphere is a tool that calibrates the wrong body and says nothing.
 */

import {
  DEFAULT_PATTERN_PLAN,
  planFrames,
  type FrameSpec,
  type PatternPlan,
} from '../../bench/src/patterns.ts';
import type { Viewport } from '../../calibration/src/index.ts';
import {
  MAX_PLACEABLE_PROJECTORS,
  emitOrder,
  projectorSlots,
  quadrantName,
  quadrantViewports,
  rasterFit,
  rigFit,
  viewportPixels,
  type EmitStep,
  type RasterFit,
} from '../src/emit.ts';
import { describeSequence, encodeToRgba, sampleFrame, strideInfo } from '../src/patternfilm.ts';
import { RESOLUTIONS } from '../src/settings.ts';

// ---- the elements ----------------------------------------------------------

const stage = document.getElementById('stage') as HTMLCanvasElement;
const setupEl = document.getElementById('setup') as HTMLDivElement;
const hudEl = document.getElementById('hud') as HTMLDivElement;
const countEl = document.getElementById('count') as HTMLSelectElement;
const resEl = document.getElementById('res') as HTMLSelectElement;
const resXEl = document.getElementById('resX') as HTMLInputElement;
const resYEl = document.getElementById('resY') as HTMLInputElement;
const matchWinEl = document.getElementById('matchwin') as HTMLButtonElement;
const bitsEl = document.getElementById('bits') as HTMLInputElement;
const phaseEl = document.getElementById('phase') as HTMLInputElement;
const dwellEl = document.getElementById('dwell') as HTMLInputElement;
const tickEl = document.getElementById('tick') as HTMLInputElement;
const rigNoteEl = document.getElementById('rignote') as HTMLParagraphElement;
const planNoteEl = document.getElementById('plannote') as HTMLParagraphElement;
const fitEl = document.getElementById('fit') as HTMLDivElement;
const startEl = document.getElementById('start') as HTMLButtonElement;
const counterEl = document.getElementById('counter') as HTMLParagraphElement;
const frameLineEl = document.getElementById('frameline') as HTMLParagraphElement;
const whyEl = document.getElementById('why') as HTMLParagraphElement;
const playEl = document.getElementById('play') as HTMLButtonElement;

// Declared in two steps so the type is non-null at its declaration rather than
// by a narrowing that TypeScript will not carry into a hoisted function body.
const context2d = stage.getContext('2d', { alpha: false, colorSpace: 'srgb' });
if (context2d === null) throw new Error('emit: this browser gave no 2-D canvas context');
const ctx: CanvasRenderingContext2D = context2d;

// ---- state -----------------------------------------------------------------

/** What the operator said the rig is. No part of it has a default. */
interface Rig {
  count: number;
  resX: number;
  resY: number;
}

type Mode = 'setup' | 'hud' | 'armed';

let mode: Mode = 'setup';
let rig: Rig | null = null;
let plan: PatternPlan = { ...DEFAULT_PATTERN_PLAN };
let specs: FrameSpec[] = planFrames(plan);
let notes = describeSequence(plan);
let steps: EmitStep[] = [];
let viewports: readonly Viewport[] = [];
let slots: readonly number[] = [];
let at = 0;
let playing = false;
let playTimer: number | null = null;
/** True once the last step has been played, so the room going dark means done. */
let finished = false;

/** The shortest dwell the timer will honour — and so the shortest the box may say. */
const MIN_DWELL_S = 0.2;

// ---- the canvas ------------------------------------------------------------

function sizeStage(): void {
  // Device pixels, because the whole question this page has to answer honestly
  // is whether one emitted pixel is one projector pixel. A CSS-pixel canvas on a
  // scaled display would report a tidy 1920 and emit something else.
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (stage.width !== w || stage.height !== h) {
    stage.width = w;
    stage.height = h;
    frameCache.clear();
  }
}

/**
 * One frame's pixels, for a quadrant of this size.
 *
 * Built from a ONE-DIMENSIONAL sample of the pattern and then repeated, which is
 * not an optimisation dressed up as a property: `compileFrame` defines a frame
 * as a function of a single raster coordinate, so every column of an 'across'
 * frame is identical by construction. Sampling the plane twice in two dimensions
 * would compute the same numbers a thousand times and give a reader the
 * impression that the second dimension carried information.
 *
 * `samples` is 1 when the quadrant is the projector's own raster: one sample at
 * each pixel centre is decode.ts's convention and reproduces the square wave
 * exactly. When the quadrant is NOT the raster the frame is being resampled
 * anyway, and box-filtering it is the least bad way to do that — see
 * {@link rasterFit}, which says so on the page rather than only here.
 */
function buildFrame(spec: FrameSpec, r: Rig, w: number, h: number, samples: number): ImageData {
  const rowBytes = w * 4;
  const rgba = new Uint8ClampedArray(rowBytes * h);
  const alongX = spec.axis === 'u';
  const flat = spec.axis === null;
  const n = flat ? 1 : alongX ? w : h;
  const linear = sampleFrame(
    spec,
    plan,
    r.resX,
    r.resY,
    alongX || flat ? n : 1,
    alongX || flat ? 1 : n,
    samples,
  );
  const bytes = encodeToRgba(linear);

  // Build row 0, then let the rows (or, for a 'down' frame, the pixels within
  // each row) be memcpy'd rather than written one at a time.
  if (alongX) rgba.set(bytes, 0);
  else fillGrey(rgba, 0, rowBytes, bytes[0]);
  if (flat || alongX) {
    for (let filled = 1; filled < h; filled *= 2) {
      const rows = Math.min(filled, h - filled);
      rgba.copyWithin(filled * rowBytes, 0, rows * rowBytes);
    }
  } else {
    for (let y = 1; y < h; y++) fillGrey(rgba, y * rowBytes, rowBytes, bytes[4 * y]);
  }
  return new ImageData(rgba, w, h);
}

/** One row of opaque grey, written by doubling rather than a per-pixel loop. */
function fillGrey(rgba: Uint8ClampedArray, offset: number, rowBytes: number, v: number): void {
  rgba[offset] = v;
  rgba[offset + 1] = v;
  rgba[offset + 2] = v;
  rgba[offset + 3] = 255;
  for (let filled = 4; filled < rowBytes; filled *= 2) {
    rgba.copyWithin(offset + filled, offset, offset + Math.min(filled, rowBytes - filled));
  }
}

/**
 * A few frames' pixels, kept so stepping back and forth is instant.
 *
 * Bounded hard rather than by a policy: one 1920×1200 frame is 9 MB, and a cache
 * that quietly held the whole 34-frame sequence would be 313 MB on a display
 * machine whose job is running an exhibit.
 */
const frameCache = new Map<string, ImageData>();
const FRAME_CACHE_LIMIT = 3;

function frameFor(frame: number, r: Rig, w: number, h: number, fit: RasterFit): ImageData {
  const key = `${frame}|${w}x${h}|${r.resX}x${r.resY}|${plan.grayBits}|${plan.phaseSteps}`;
  const hit = frameCache.get(key);
  if (hit !== undefined) return hit;
  const built = buildFrame(specs[frame], r, w, h, fit.exact ? 1 : 4);
  if (frameCache.size >= FRAME_CACHE_LIMIT) frameCache.clear();
  frameCache.set(key, built);
  return built;
}

function paint(): void {
  const w = stage.width;
  const h = stage.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (rig === null) return;

  if (mode === 'setup') {
    paintGuides(rig, w, h);
    return;
  }
  // The room going dark is the end-of-sequence signal, and it is the only one an
  // armed operator can see — there is nothing else on the screen by then.
  if (finished) return;
  const step = steps[at];
  if (step === undefined) return;
  const r = viewportPixels(viewports[step.projector], w, h);
  if (r.w <= 0 || r.h <= 0) return;
  const fit = rasterFit(r, rig.resX, rig.resY, plan);
  // Black rather than a pattern that cannot be decoded. Start is gated on
  // `rigFit().anyFatal`, so this is only reachable by resizing mid-capture — and
  // once armed there is no panel left to put a warning in, so the honest output
  // is no output. A frame emitted here would photograph as a plausible capture.
  if (fit.fatal) return;
  ctx.putImageData(frameFor(step.frame, rig, r.w, r.h, fit), r.x, r.y);
}

/**
 * The quadrant outlines, drawn during setup only.
 *
 * Two things an operator cannot check any other way, both visible from across
 * the room: whether this window actually spans the framebuffer (four rectangles
 * that reach the edges), and which physical projector owns which quadrant. The
 * second is the check the setup panel asks for in words, and it is the one that
 * decides whether every photograph afterwards is correctly labelled.
 *
 * Outlines rather than fills, dim rather than white: this is light on the ball
 * while the operator is still setting up beside it.
 */
function paintGuides(r: Rig, w: number, h: number): void {
  ctx.save();
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) / 400));
  ctx.strokeStyle = 'rgba(255, 138, 61, 0.55)';
  ctx.fillStyle = 'rgba(255, 138, 61, 0.75)';
  const size = Math.max(16, Math.round(Math.min(w, h) / 26));
  ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let k = 0; k < viewports.length; k++) {
    const q = viewportPixels(viewports[k], w, h);
    const inset = ctx.lineWidth / 2;
    ctx.strokeRect(q.x + inset, q.y + inset, q.w - ctx.lineWidth, q.h - ctx.lineWidth);
    ctx.fillText(
      `P${slots[k] + 1}  ·  projector ${k + 1} of ${r.count}`,
      q.x + q.w / 2,
      q.y + q.h / 2,
    );
  }
  ctx.restore();
}

// ---- reading what the operator said ----------------------------------------

function intFrom(el: HTMLInputElement, fallback: number): number {
  const v = Number.parseInt(el.value, 10);
  return Number.isFinite(v) ? v : fallback;
}

/** The rig as currently stated, or null with the reason written to the page. */
function readRig(): Rig | null {
  // Cleared first, so a placement that no longer holds cannot be left standing
  // by an early return. A stale viewport list would draw the previous rig's
  // quadrants under the current rig's labels.
  slots = [];
  viewports = [];
  const count = Number.parseInt(countEl.value, 10);
  const resX = intFrom(resXEl, 0);
  const resY = intFrom(resYEl, 0);
  if (!Number.isFinite(count) || count < 1) {
    rigNoteEl.textContent =
      'Say how many projectors this display drives. Nothing here defaults to four: a tool that ' +
      'assumed the rig would light one projector under another one’s name.';
    return null;
  }
  if (resX < 16 || resY < 16) {
    rigNoteEl.textContent =
      'Say what one projector’s raster is. It is the number the pattern is defined on, and it is ' +
      'half the framebuffer in each dimension when SOS drives four from one X screen.';
    return null;
  }
  try {
    slots = projectorSlots(count);
    viewports = quadrantViewports(count);
  } catch (err) {
    rigNoteEl.textContent = err instanceof Error ? err.message : String(err);
    return null;
  }
  const named = viewports.map((v, k) => `P${slots[k] + 1} ${quadrantName(v)}`).join(' · ');
  rigNoteEl.textContent =
    `${count} projector${count === 1 ? '' : 's'}: ${named}. ` +
    (count < MAX_PLACEABLE_PROJECTORS
      ? 'The other quadrants stay black — PARAMETERS.md §2 darkens quadrants rather than respacing ' +
        'the projectors that remain, so the framebuffer is still the full X screen.'
      : 'The framebuffer is the union of the four, so it is twice the raster in each dimension.');
  return { count, resX, resY };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function readPlan(): PatternPlan {
  return {
    ...DEFAULT_PATTERN_PLAN,
    grayBits: clamp(intFrom(bitsEl, DEFAULT_PATTERN_PLAN.grayBits), 1, 8),
    phaseSteps: clamp(intFrom(phaseEl, DEFAULT_PATTERN_PLAN.phaseSteps), 4, 12),
  };
}

/**
 * Write the clamped values back into the boxes the operator reads.
 *
 * Review caught this and it is not cosmetic. `readPlan` clamps, so typing 9 Gray
 * planes emitted 8 while the box went on saying 9 — and this page's own advice is
 * to WRITE THE PLAN DOWN, because a capture decoded against a different plan
 * decodes into nonsense. A control that disagrees with what is being emitted is
 * therefore not a rounding detail; it is the page handing an operator the wrong
 * number to record.
 *
 * On `change` rather than on `input`, so it does not fight somebody typing the
 * first digit of a two-digit number, and again at Start, which is the last moment
 * the displayed value can still be believed.
 */
function normalizePlanInputs(): void {
  const p = readPlan();
  bitsEl.value = String(p.grayBits);
  phaseEl.value = String(p.phaseSteps);
  const dwell = Number.parseFloat(dwellEl.value);
  dwellEl.value = String(Number.isFinite(dwell) ? clamp(dwell, MIN_DWELL_S, 30) : 2);
}

/** Recompute everything the operator's inputs decide, and say what it means. */
function refresh(): void {
  plan = readPlan();
  specs = planFrames(plan);
  notes = describeSequence(plan);
  rig = readRig();
  syncResolutionMenu(intFrom(resXEl, 0), intFrom(resYEl, 0));
  sizeStage();

  matchWinEl.disabled = viewports.length === 0;
  if (rig === null) {
    planNoteEl.textContent = '';
    fitEl.textContent = '';
    fitEl.className = 'verdict';
    startEl.disabled = true;
    steps = [];
    paint();
    return;
  }

  steps = emitOrder(rig.count, plan);
  const stride = strideInfo(plan, rig.resX, rig.resY);
  const perPos = steps.length;
  planNoteEl.textContent =
    `${specs.length} frames per projector, ${perPos} for the rig — one camera position. ` +
    `${stride.strips} strips across a raster, so the finest Gray strip is ` +
    `${stride.strideXPx.toFixed(1)} projector pixels across and ${stride.strideYPx.toFixed(1)} down. ` +
    `Write the plan down: a capture decoded against a different one decodes into nonsense, and ` +
    `nothing yet records it for you.`;

  // Every occupied quadrant, not just the first. `viewportPixels` rounds, so on
  // an odd framebuffer the left quadrants come out a pixel wider than the right
  // ones — and a verdict read off projector 0 alone can say "exactly one raster"
  // while the projector beside it is being resampled.
  const fit = rigFit(rig.count, stage.width, stage.height, rig.resX, rig.resY, plan);
  if (fit.allExact) {
    const q = viewportPixels(viewports[0], stage.width, stage.height);
    fitEl.className = 'verdict ok';
    fitEl.textContent =
      `This window is ${stage.width}×${stage.height} device pixels, so ` +
      `${rig.count === 1 ? 'the quadrant is' : `all ${rig.count} quadrants are`} ` +
      `${q.w}×${q.h} — exactly one raster. Every emitted pixel is one projector pixel.`;
  } else {
    fitEl.className = fit.anyFatal ? 'verdict bad' : 'verdict warn';
    const slot = slots[fit.worstProjector];
    fitEl.textContent =
      `P${slot + 1} (projector ${fit.worstProjector + 1} of ${rig.count}): ${fit.worst.problem}` +
      (fit.perProjector.filter((f) => !f.exact).length > 1
        ? ` Other quadrants are off by their own amounts; fixing the window fixes all of them.`
        : '');
  }
  startEl.disabled = fit.anyFatal;
  writeUrl();
  paint();
}

// ---- where the operator is in the capture ----------------------------------

function hudText(): void {
  const step = steps[at];
  if (rig === null || step === undefined) return;
  const note = notes[step.frame];
  const slot = slots[step.projector];
  counterEl.textContent = finished
    ? `Sequence complete — ${steps.length} steps`
    : `Step ${step.ordinal} of ${steps.length}`;
  frameLineEl.textContent = finished
    ? 'The screen is black. That is the end-of-sequence signal, and it is the only one you can see while armed.'
    : `Projector ${step.projector + 1} of ${rig.count} — P${slot + 1}, ${quadrantName(viewports[step.projector])} quadrant · ${note.label}`;
  whyEl.textContent = finished ? '' : note.why;
  playEl.textContent = playing ? 'Pause' : 'Play';
}

function go(next: number): void {
  if (steps.length === 0) return;
  // Stepping off the end ends the sequence rather than sticking on the last
  // frame. An armed operator has no counter to read, so "the room went dark" has
  // to mean the same thing whether the page was played or stepped by hand — a
  // last frame that simply stays lit reads as a page that stopped responding.
  finished = next >= steps.length;
  at = Math.max(0, Math.min(steps.length - 1, next));
  paint();
  hudText();
}

function stepProjector(delta: number): void {
  const step = steps[at];
  if (step === undefined) return;
  const target = step.projector + delta;
  if (target < 0 || target >= viewports.length) return;
  go(target * specs.length + step.frame);
}

/**
 * Leave setup for the sequence.
 *
 * Normalizes first, because this is the last moment the displayed plan can still
 * be believed: from here the operator is reading the numbers off the panel to
 * write them down, and everything downstream depends on those being the numbers
 * that were emitted.
 */
function start(): void {
  normalizePlanInputs();
  refresh();
  if (startEl.disabled) return;
  go(0);
  setMode('hud');
}

function setMode(next: Mode): void {
  mode = next;
  setupEl.hidden = next !== 'setup';
  hudEl.hidden = next !== 'hud';
  document.body.classList.toggle('armed', next === 'armed');
  if (next === 'setup') stopPlaying();
  paint();
  hudText();
}

// ---- playing the sequence --------------------------------------------------

/**
 * A short tone at each step.
 *
 * The one piece of feedback that survives being armed. An armed page shows
 * nothing at all — that is the point of it — so an operator running the sequence
 * on a timer beside a camera has no way to know it advanced. A tick is the
 * cheapest channel that is not light, and it is off by default because this
 * machine is usually standing in a public gallery.
 */
let audio: AudioContext | null = null;
function tick(hz: number, ms: number): void {
  if (!tickEl.checked) return;
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = hz;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + ms / 1000);
  } catch {
    // An autoplay policy or a machine with no audio device. The sequence is the
    // deliverable; the tick is a convenience and must never stop it.
  }
}

/** The dwell the timer will actually use, which is what the box is normalized to. */
function dwellMs(): number {
  const v = Number.parseFloat(dwellEl.value);
  return Math.round(clamp(Number.isFinite(v) ? v : 2, MIN_DWELL_S, 30) * 1000);
}

function stopPlaying(): void {
  playing = false;
  if (playTimer !== null) {
    window.clearTimeout(playTimer);
    playTimer = null;
  }
  playEl.textContent = 'Play';
}

function advance(): void {
  if (at + 1 >= steps.length) {
    stopPlaying();
    finished = true;
    // Black, so the room itself reports the end of the sequence.
    paint();
    hudText();
    tick(520, 90);
    return;
  }
  go(at + 1);
  tick(880, 45);
  if (playing) {
    playTimer = window.setTimeout(advance, dwellMs());
  }
}

function togglePlay(): void {
  if (playing) {
    stopPlaying();
    hudText();
    return;
  }
  if (steps.length === 0) return;
  playing = true;
  playEl.textContent = 'Pause';
  playTimer = window.setTimeout(advance, dwellMs());
  hudText();
}

// ---- the URL is the setup --------------------------------------------------

/**
 * The stated rig, in the address bar.
 *
 * So a site that has worked out its own numbers can bookmark them, and so the
 * next operator opens a page that already knows the rig instead of restating it
 * from memory. It is also the only record this phase keeps of what was played —
 * which is not the same thing as knowing which photograph is which, and is not
 * offered as one.
 */
function writeUrl(): void {
  if (rig === null) return;
  const q = new URLSearchParams({
    n: String(rig.count),
    resX: String(rig.resX),
    resY: String(rig.resY),
    bits: String(plan.grayBits),
    phase: String(plan.phaseSteps),
    dwell: dwellEl.value,
  });
  history.replaceState(null, '', `?${q.toString()}`);
}

function readUrl(): void {
  const q = new URLSearchParams(location.search);
  const n = q.get('n');
  // Set before the option list is consulted: a count above four is not in the
  // menu, and the refusal it produces is the thing the operator needs to read.
  if (n !== null) countEl.value = n;
  if (n !== null && countEl.value !== n) {
    const stray = document.createElement('option');
    stray.value = n;
    stray.textContent = n;
    countEl.append(stray);
    countEl.value = n;
  }
  resXEl.value = q.get('resX') ?? '';
  resYEl.value = q.get('resY') ?? '';
  bitsEl.value = q.get('bits') ?? String(DEFAULT_PATTERN_PLAN.grayBits);
  phaseEl.value = q.get('phase') ?? String(DEFAULT_PATTERN_PLAN.phaseSteps);
  dwellEl.value = q.get('dwell') ?? '2';
}

// ---- wiring ----------------------------------------------------------------

function buildResolutionMenu(): void {
  const choose = document.createElement('option');
  choose.value = '';
  choose.textContent = '— choose —';
  resEl.append(choose);
  for (const r of RESOLUTIONS) {
    const o = document.createElement('option');
    o.value = `${r.resX}x${r.resY}`;
    o.textContent = r.label;
    resEl.append(o);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'something else';
  resEl.append(custom);
}

/**
 * Point the menu at whatever the two number fields say.
 *
 * The menu is a shortcut into the fields, not a second source of truth: a URL or
 * a typed number can name a raster the list does not carry, and a menu still
 * reading "— choose —" beside a filled-in 1920×1200 invites the operator to
 * choose again and overwrite what their site actually has.
 */
function syncResolutionMenu(resX: number, resY: number): void {
  const match = RESOLUTIONS.find((r) => r.resX === resX && r.resY === resY);
  resEl.value = match === undefined ? (resX > 0 && resY > 0 ? 'custom' : '') : `${resX}x${resY}`;
}

function toggleFullscreen(): void {
  if (document.fullscreenElement === null) void document.documentElement.requestFullscreen();
  else void document.exitFullscreen();
}

function main(): void {
  buildResolutionMenu();
  readUrl();

  resEl.addEventListener('change', () => {
    const [x, y] = resEl.value.split('x');
    if (x !== undefined && y !== undefined) {
      resXEl.value = x;
      resYEl.value = y;
    }
    refresh();
  });
  matchWinEl.addEventListener('click', () => {
    // Derived from the display rather than from a nominal — but only correct if
    // the window really does fill the framebuffer already, which is exactly what
    // it then makes the fit verdict unable to tell you. Said on the button and
    // said again here.
    //
    // It needs the projector count first and does not assume one. A fallback
    // quadrant here would be this page's own layout guess wearing a measurement's
    // clothes, which is the failure `quadrantViewports` refuses above four.
    if (viewports.length === 0) return;
    sizeStage();
    const q = viewportPixels(viewports[0], stage.width, stage.height);
    resXEl.value = String(q.w);
    resYEl.value = String(q.h);
    refresh();
  });
  for (const el of [countEl, resXEl, resYEl, bitsEl, phaseEl, dwellEl]) {
    el.addEventListener('change', () => {
      normalizePlanInputs();
      refresh();
    });
    el.addEventListener('input', refresh);
  }
  document.getElementById('fullscreen')?.addEventListener('click', toggleFullscreen);
  startEl.addEventListener('click', () => {
    start();
  });
  document.getElementById('prev')?.addEventListener('click', () => go(at - 1));
  document.getElementById('next')?.addEventListener('click', () => go(at + 1));
  playEl.addEventListener('click', togglePlay);
  document.getElementById('back')?.addEventListener('click', () => setMode('setup'));
  document.getElementById('arm')?.addEventListener('click', () => setMode('armed'));

  window.addEventListener('resize', () => {
    sizeStage();
    refresh();
  });

  window.addEventListener('keydown', (ev) => {
    if (mode === 'setup' && ev.key !== 'F11') {
      if (ev.key === 'Enter' && !startEl.disabled) {
        start();
        ev.preventDefault();
      }
      return;
    }
    switch (ev.key) {
      case ' ':
      case 'ArrowRight':
      case 'ArrowDown':
        go(at + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        go(at - 1);
        break;
      case ']':
        stepProjector(1);
        break;
      case '[':
        stepProjector(-1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(steps.length - 1);
        break;
      case 'p':
      case 'P':
        togglePlay();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'Enter':
        setMode(mode === 'armed' ? 'hud' : 'armed');
        break;
      case 'Escape':
        setMode(mode === 'armed' ? 'hud' : 'setup');
        break;
      default:
        return;
    }
    ev.preventDefault();
  });

  refresh();
  setMode('setup');
  // The stamp emit.html's inline script looks for. Last thing in `main`, so it
  // means "this module ran to the end" rather than "this module was fetched".
  document.documentElement.dataset.emitBooted = 'yes';
}

main();
