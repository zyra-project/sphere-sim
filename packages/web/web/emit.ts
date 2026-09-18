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
import {
  MANIFEST_FILENAME,
  captureManifest,
  formatManifest,
  manifestExpectedSequence,
  manifestFrameRoles,
  parseCaptureManifest,
  type CaptureManifest,
} from '../src/manifest.ts';
import {
  describeIndexing,
  describeRun,
  finishCapture,
  indexPhotographs,
  readRun,
  summarisePhoto,
  type PhotoSummary,
  type RunOutcome,
} from '../src/readback.ts';
import type { EncodedImage } from '../../solver/src/ingest.ts';
import type { Correspondence } from '../../solver/src/decode.ts';
import type { PairContribution } from '../../solver/src/worth.ts';
import type { Transfer } from '../../solver/src/ingest.ts';

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
const savePlanEl = document.getElementById('saveplan') as HTMLButtonElement;
const planFileEl = document.getElementById('planfile') as HTMLInputElement;
const photosEl = document.getElementById('photos') as HTMLInputElement;
const camIdxEl = document.getElementById('camidx') as HTMLInputElement;
const readbackEl = document.getElementById('readback') as HTMLButtonElement;
const readNoteEl = document.getElementById('readnote') as HTMLParagraphElement;
const readoutEl = document.getElementById('readout') as HTMLDivElement;

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
  // The plan file is only worth saving once the rig is stated: its whole job is
  // to carry the raster and projector count a capture was shot against, and a
  // file written before those are known would be a plan of nothing.
  savePlanEl.disabled = rig === null;
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
    `A capture decoded against a different plan decodes into nonsense, so save the plan below ` +
    `and keep it with the photographs.`;

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
// ---- reading a capture back ------------------------------------------------

/**
 * The plan the operator is about to play, as a file to keep with the photos.
 *
 * This button exists because of the sentence beside it. Since Phase 1 the page
 * has told operators "write the plan down: a capture decoded against a
 * different one decodes into nonsense, and nothing yet records it for you" —
 * which is a real hazard handed over as homework. The page knows every number;
 * `src/manifest.ts` says at length why retyping them is the trap the assembler
 * exists to refuse.
 */
function savePlan(): void {
  if (rig === null) return;
  const m = captureManifest(
    plan,
    { x: rig.resX, y: rig.resY },
    rig.count,
    Number(dwellEl.value) || 0,
    new Date().toISOString(),
  );
  const url = URL.createObjectURL(new Blob([formatManifest(m)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = MANIFEST_FILENAME;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The transfer these bytes actually carry, which is not a choice.
 *
 * This was a menu, and the menu was wrong. `drawImage` converts its source into
 * the canvas's colour space, so a profile-tagged photograph — Display P3 off a
 * phone, Adobe RGB off a camera — is converted to sRGB before `getImageData`
 * ever sees it. Whatever the file was encoded with, what comes back here is
 * sRGB-encoded, and the operator picking "Linear" or "Gamma 2.2" was telling
 * `linearise` something false about bytes the browser had already decided.
 *
 * That is not a cosmetic wrong. This PR's own measurement is what it costs:
 * treating these bytes as linear leaves every one of the 65 536 correspondences
 * in place and moves them 0.0060 px -> 0.0791 px, so the capture does not
 * refuse, it comes back the same size and quietly misplaced. A menu that can
 * only be set to a wrong answer is worse than no menu.
 *
 * So it is stated rather than asked. `readCapture` still takes the transfer as
 * a required argument, because the module does not know it is being fed canvas
 * output and should not assume — this is the one caller that does know.
 */
function canvasTransfer(): Transfer {
  return { kind: 'srgb' };
}

/**
 * One image file into the integers `linearise` reads.
 *
 * `createImageBitmap` plus a 2-D canvas is the only way a page gets at a JPEG's
 * pixels, and it costs the top two bits of a 10-bit capture: the canvas hands
 * back 8-bit RGBA whatever the file held. That is stated in the report rather
 * than hidden, and `docs/OPERATOR-PATH.md` records the measurement that makes
 * it survivable — in Phase 3's synthetic fixture 8-bit sRGB holds the decoded
 * coordinate inside a hundredth of a projector pixel.
 */
async function readImageFile(file: File): Promise<{ width: number; height: number; channels: number; data: Uint8Array; maxValue: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const c = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    if (c === null) throw new Error('this browser gave no 2-D context to read pixels with');
    c.drawImage(bitmap, 0, 0);
    const img = c.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      channels: 4,
      data: new Uint8Array(img.data.buffer.slice(0)),
      maxValue: 255,
    };
  } finally {
    // Released explicitly: a capture is hundreds of frames and a page that
    // leaves each decoded bitmap to the collector runs out of memory partway
    // through, which looks like a bad capture rather than a leak.
    bitmap.close();
  }
}

/**
 * Bytes one photograph costs while a run is being decoded.
 *
 * Both representations are alive at once and that is not an oversight that can
 * be tidied away: `readImageFile` holds RGBA bytes (4/pixel) and `linearise`
 * builds a three-channel Float32 copy (12/pixel) while the encoded originals
 * are still referenced by the run. `ingest.ts` explains at length why it keeps
 * three channels rather than collapsing to luminance — doing that here would
 * silently override the decoder's own channel choice — so 16 bytes per pixel is
 * the real figure, not a pessimistic one.
 */
const BYTES_PER_PIXEL_WHILE_DECODING = 16;

/**
 * As much as one capture may occupy before this page refuses it.
 *
 * Review worked the arithmetic out and it is worth keeping: the documented
 * 34-frame run at 1920x1200 is 299 MiB encoded plus 897 MiB linear, about
 * 1.17 GiB coexisting, which a desktop tab survives. A 24-megapixel camera is
 * the case that does not — the same 34 frames come to roughly 13 GiB and the
 * tab is killed, which an operator reads as "the tool is broken" rather than
 * as "those files are too big".
 *
 * So the bound is set above what the documentation promises and below what
 * cannot work, and the refusal says the number. It is a limit of this page
 * rather than of the decode: the same photographs downscaled go through.
 */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;

/** A message when the run in hand cannot be held in memory, or null while it can. */
function captureTooLarge(
  images: readonly { width: number; height: number }[],
): string | null {
  let pixels = 0;
  for (const img of images) pixels += img.width * img.height;
  const bytes = pixels * BYTES_PER_PIXEL_WHILE_DECODING;
  if (bytes <= MAX_CAPTURE_BYTES) return null;
  const gib = (bytes / (1024 * 1024 * 1024)).toFixed(1);
  const first = images[0];
  const each = first === undefined ? '' :
    ` At ${first.width}x${first.height} that is ${(first.width * first.height / 1e6).toFixed(1)} megapixels a frame.`;
  return (
    `These photographs are too large for this page to decode in one run. ${images.length} of ` +
    `them need about ${gib} GiB of memory at once — the encoded pixels and the linear-light ` +
    `copy the decoder reads are both held while a run is assembled — and this page stops at ` +
    `${(MAX_CAPTURE_BYTES / (1024 * 1024 * 1024)).toFixed(0)} GiB rather than letting the ` +
    `browser kill the tab.${each} Downscale the capture and hand it in again; the decode ` +
    `itself has no such limit.`
  );
}

let heldManifest: CaptureManifest | null = null;
/** True while `runReadback` is between its first await and its last. */
let reading = false;
/**
 * Which plan selection is current.
 *
 * Reading a file is asynchronous, so two quick selections race and the one that
 * resolves LAST wins — which is not necessarily the one the operator chose
 * last. This counter makes a stale resolution recognisable so it can be
 * dropped.
 */
let planPick = 0;

function syncReadback(): void {
  const haveFiles = (photosEl.files?.length ?? 0) > 0;
  // `reading` is part of the condition and was not, which is how a photo change
  // mid-read re-enabled this button and let a second decode start on top of the
  // first.
  readbackEl.disabled = heldManifest === null || !haveFiles || reading;
}

/**
 * Take a plan file, and stop trusting the old one the instant it is chosen.
 *
 * The clearing is the point, and review caught its absence. `heldManifest` used
 * to stay live until the read resolved, with Decode still enabled — so an
 * operator who picked a second plan and pressed Decode straight away decoded
 * their photographs against the FIRST plan. This module exists to stop a
 * capture being decoded against the wrong plan, and the picker in front of it
 * was doing exactly that.
 */
function loadPlanFile(file: File): void {
  const pick = ++planPick;
  // Before the await, not after it: until this file has been read there is no
  // plan in hand, and the button must say so.
  heldManifest = null;
  readNoteEl.textContent = `Reading ${file.name}…`;
  readNoteEl.dataset.smoke = 'plan-reading';
  syncReadback();

  void file
    .text()
    .then((text) => {
      if (pick !== planPick) return; // a later selection already won
      const parsed = parseCaptureManifest(text);
      if (!parsed.ok) {
        heldManifest = null;
        readNoteEl.textContent = parsed.problems.join(' ');
        readNoteEl.dataset.smoke = 'plan-refused';
        syncReadback();
        return;
      }
      heldManifest = parsed.manifest;
      const m = parsed.manifest;
      readNoteEl.textContent =
        `Plan read: ${m.plan.grayBits} Gray planes per axis, ${m.plan.phaseSteps} phase steps, ` +
        `${m.framesPerRun} frames per projector run, ${m.projectorRes.x}x${m.projectorRes.y} ` +
        `raster, ${m.projectors} projectors` +
        (m.written === '' ? '.' : `, written ${m.written}.`) +
        ` Hand in the whole camera position — every projector's run, back to back, in the ` +
        `order they were shot. This page works out where each run starts.`;
      readNoteEl.dataset.smoke = 'plan-read';
      syncReadback();
    })
    .catch((e: unknown) => {
      // A file the browser cannot read — moved, renamed, permission withdrawn
      // — is an ordinary mistake. Unhandled, it left the page silent.
      if (pick !== planPick) return;
      heldManifest = null;
      readNoteEl.textContent = `That plan file could not be read: ${(e as Error).message}`;
      readNoteEl.dataset.smoke = 'plan-refused';
      syncReadback();
    });
}

/**
 * Decode the photographs in hand and say what they were worth.
 *
 * Every input is read ONCE, before the first await, and nothing after that
 * looks at the DOM again. Review found the opposite: the files were snapshotted
 * but the manifest, the transfer and the two indices were read after the
 * decode loop, so a run could pair the photographs the operator chose with a
 * camera index they changed while it was working. A reader that silently
 * combines two different intentions is the same class of fault as decoding
 * against the wrong plan.
 */
async function runReadback(): Promise<void> {
  const files = Array.from(photosEl.files ?? []);
  const manifest = heldManifest;
  const camera = Math.max(0, Math.trunc(Number(camIdxEl.value) || 0));
  const transfer = canvasTransfer();
  if (manifest === null || files.length === 0 || reading) return;

  reading = true;
  syncReadback();
  readoutEl.hidden = false;
  readoutEl.textContent = `Reading ${files.length} photographs…`;
  readoutEl.dataset.smoke = 'reading';

  try {
    // The grid the plan needs, not a number this page picks. `summarisePhoto`
    // has no default for it and `indexPhotographs` refuses a summary too coarse
    // for the plan, so getting it wrong is caught rather than believed.
    const blocks = manifestExpectedSequence(manifest).complements.minBlocks;

    // Pass one: read each photograph, reduce it to what indexing needs, and let
    // the pixels go. A camera position is every projector's run back to back —
    // 136 frames at the page's own plan — and holding that as linear light is
    // several gigabytes. What survives per photograph is a histogram and a
    // block grid, a few kilobytes. See `PhotoSummary`.
    const summaries: PhotoSummary[] = [];
    for (let i = 0; i < files.length; i++) {
      readoutEl.textContent = `Reading photograph ${i + 1} of ${files.length}…`;
      summaries.push(
        summarisePhoto(await readImageFile(files[i]), i, files[i].name, transfer, blocks),
      );
    }

    const indexed = indexPhotographs(summaries, manifest);
    const lines: string[] = [describeIndexing(indexed, manifest.projectors)];
    for (const problem of indexed.problems) lines.push(`  ${problem}`);

    if (indexed.runs.length === 0) {
      readoutEl.textContent = lines.join('\n');
      readoutEl.dataset.smoke = 'read-unindexed';
      return;
    }

    // Pass two: decode the runs the indexer vouched for, ONE AT A TIME, so the
    // peak is one run's pixels rather than the position's. The files are read a
    // second time for this, which is the price of not holding them all — and it
    // is paid only for runs that survived indexing.
    const roles = manifestFrameRoles(manifest);
    const outcomes: RunOutcome[] = [];
    const pairs: PairContribution[] = [];
    const correspondences: Correspondence[] = [];
    for (const run of indexed.runs) {
      readoutEl.textContent = `Decoding projector ${run.projector + 1}…`;
      const images: EncodedImage[] = [];
      let over: string | null = null;
      for (const ordinal of run.ordinals) {
        images.push(await readImageFile(files[ordinal]));
        // Checked as the run GROWS, not once it is whole. An impossible capture
        // should be refused before it has eaten the memory it would be refused
        // for — the property the one-run-at-a-time version had, and which the
        // first draft of this loop quietly dropped by checking at the end.
        over = captureTooLarge(images);
        if (over !== null) break;
      }
      if (over !== null) {
        // What already decoded is still worth saying. Returning with only the
        // refusal would throw away the runs that came back fine, and on a
        // four-projector position that is most of the answer.
        for (const done of outcomes) {
          lines.push(describeRun(done));
          for (const problem of done.problems) lines.push(`  ${problem}`);
        }
        lines.push('', over);
        readoutEl.textContent = lines.join('\n');
        readoutEl.dataset.smoke = 'read-too-large';
        return;
      }
      const one = readRun(
        {
          camera,
          projector: run.projector,
          images,
          names: run.ordinals.map((o) => files[o].name),
        },
        roles,
        manifest,
        transfer,
      );
      outcomes.push(one.outcome);
      if (one.pair !== null) pairs.push(one.pair);
      // A loop rather than a spread: see `readCapture`. One argument per
      // correspondence overflows the call stack above about 0.13 megapixels of
      // camera, which is every camera an operator owns.
      for (const c of one.correspondences) correspondences.push(c);
    }

    const result = finishCapture(outcomes, pairs, correspondences, indexed.runs.length);
    lines.push('');
    for (const run of result.runs) {
      lines.push(describeRun(run));
      for (const problem of run.problems) lines.push(`  ${problem}`);
    }
    if (result.ok) {
      lines.push('', result.worth.summary);
      if (result.worth.refusal !== null) lines.push(result.worth.refusal);
      readoutEl.dataset.smoke = result.worth.usable ? 'read-ok' : 'read-unusable';
    } else {
      lines.push('', result.refusal);
      readoutEl.dataset.smoke = 'read-refused';
    }
    readoutEl.textContent = lines.join('\n');
  } catch (e) {
    // A file the browser cannot decode is an ordinary operator mistake — a RAW
    // file, a stray .txt — and belongs in the report rather than in the console.
    readoutEl.textContent = `These photographs could not be read: ${(e as Error).message}`;
    readoutEl.dataset.smoke = 'read-failed';
  } finally {
    reading = false;
    syncReadback();
  }
}

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
  savePlanEl.addEventListener('click', savePlan);
  planFileEl.addEventListener('change', () => {
    const f = planFileEl.files?.[0];
    if (f !== undefined) loadPlanFile(f);
  });
  photosEl.addEventListener('change', syncReadback);
  readbackEl.addEventListener('click', () => {
    void runReadback();
  });
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
