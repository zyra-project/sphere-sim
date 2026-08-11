/**
 * The interactive harness.
 *
 * One window, one WebGL2 context, five viewports — a room view plus the four
 * projector views — a live metrics panel, and a slider for every parameter in
 * PARAMETERS.md.
 *
 * ## The four projector views are ONE framebuffer
 *
 * PARAMETERS.md §3.4 reads the SOS config and concludes that the deployment
 * target is a single X screen split 2x2, not four independent outputs:
 *
 *     set projectorInfo(viewport) { 0,0,0.5,0.5  0.5,0,0.5,0.5  0,0.5,0.5,0.5  0.5,0.5,0.5,0.5 }
 *     set projectorInfo(hostname) { localhost localhost localhost localhost }
 *
 * So the harness draws them as quadrants of one rectangle, with the projector's
 * viewport rectangle taken straight from the calibration and applied with
 * `gl.viewport`. GL's viewport origin is bottom-left, and conventions.ts §V puts
 * the SOS viewport origin at bottom-left too, so the two agree with no flip —
 * which is worth stating precisely because everywhere else in the project image
 * row 0 is at the top and the flip is real.
 *
 * A 2- or 3-projector rig leaves its unoccupied quadrants BLACK rather than
 * shrinking the framebuffer. That is §2's "quadrants go dark": the X screen does
 * not resize when a projector is missing, and a harness that repacked the panel
 * would stop showing the deployment target.
 *
 * ## Everything stays on the GPU
 *
 * The five viewports are five draw calls into one context. Nothing is read back
 * per frame. There are exactly two exceptions and both are deliberate:
 *
 *  - the **parity check**, which cannot be done without a read-back, runs at most
 *    once every few hundred milliseconds and at 96x72; and
 *  - the **metrics**, which are computed by `packages/sim` from the CALIBRATION
 *    rather than from pixels — deliberately, because a metric derived from the
 *    GPU image could share a bug with it and move together with the picture,
 *    which would make the panel agree with the render for the wrong reason.
 *
 * ## The parity number is not hideable
 *
 * It sits at the top of the metrics panel, always, with its tolerance beside it.
 * When it goes out of tolerance the whole panel gets a red banner naming the
 * track and the number. See `parity.ts` for what the two tolerances mean and for
 * which links in the chain this measures.
 */

import type { HarnessState, ControlSpec } from '../src/params.ts';
import {
  ALL_CONTROLS,
  CONTROL_GROUPS,
  PRESETS,
  defaultState,
  normalizeState,
  presetState,
} from '../src/params.ts';
import type { PatternId, World } from '../src/state.ts';
import { PATTERNS, buildWorld, framebufferSummary } from '../src/state.ts';
import { buildUniforms } from '../src/uniforms.ts';
import type { PanelMetric } from '../src/metrics.ts';
import { computeMetricPanel } from '../src/metrics.ts';
import type { ParityReport, ParityTrack } from '../src/parity.ts';
import {
  BOUNDARY_PIXEL_ALLOWANCE,
  GPU_TOLERANCE,
  comparePixels,
  simProjectorSamples,
  summarize,
} from '../src/parity.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { renderRoomView } from '../../sim/src/render.ts';
import type { GlHarness } from './gl.ts';
import { createHarnessGl, drawFullScreen, renderAndRead, setUniforms, uploadEquirect } from './gl.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Parity raster. Small enough to read back on a slider drag, big enough to
 *  contain the sphere, the floor and every seam. */
const PARITY_W = 96;
const PARITY_H = 72;
/** Sample grid across one projector's raster for the second parity track. */
const PARITY_PW = 64;
const PARITY_PH = 36;

const TEXTURE_W = 1024;
const TEXTURE_H = 512;

const CLASS_BLURB: Record<string, string> = {
  DOC: 'Published in NOAA SOS documentation or config. Low risk — but check the citation.',
  CFG: 'Read from a hardware spec sheet or site config. Known per install.',
  SOLVE: 'Recovered by the alignment bundle adjustment. The nominal is only an initialization.',
  ASSUME: 'NOT PUBLISHED, NOT MEASURED, CHOSEN BY US. PARAMETERS.md: "this is where the bar breaks."',
  MEAS: 'Pending measurement at a real installation. Blocking for photometric metrics.',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state: HarnessState = defaultState();
let pattern: PatternId = 'graticule';
let world: World = rebuildWorld();
let gl: GlHarness | null = null;
let parity: ParityReport | null = null;
let parityError: string | null = null;
let metricsPending = false;
let autoMetrics = true;

function rebuildWorld(): World {
  return buildWorld(state, pattern, {
    textureWidth: TEXTURE_W,
    textureHeight: TEXTURE_H,
    viewWidth: PARITY_W,
    viewHeight: PARITY_H,
  });
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function fmt(value: number, digits: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(2);
  return value.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Layout: five viewports in one context
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The room rectangle and the framebuffer rectangle, in DEVICE pixels with the
 * origin at the BOTTOM-left, which is where `gl.viewport` wants it.
 *
 * The framebuffer panel keeps the X screen's own aspect ratio and is letterboxed
 * inside its share of the canvas, so a 4K rig and a 720p rig show the same shape
 * — the topology is the point, not the pixel count.
 */
function layout(width: number, height: number, fbAspect: number): { room: Rect; framebuffer: Rect } {
  const gap = Math.round(Math.min(width, height) * 0.012);
  const roomW = Math.round(width * 0.58);
  const room: Rect = { x: 0, y: 0, w: roomW, h: height };
  const panelX = roomW + gap;
  const panelW = Math.max(1, width - panelX);
  let fbW = panelW;
  let fbH = Math.round(fbW / fbAspect);
  if (fbH > height) {
    fbH = height;
    fbW = Math.round(fbH * fbAspect);
  }
  return {
    room,
    framebuffer: {
      x: panelX + Math.round((panelW - fbW) / 2),
      y: Math.round((height - fbH) / 2),
      w: fbW,
      h: fbH,
    },
  };
}

function renderFrame(): void {
  if (!gl) return;
  const canvas = gl.gl.canvas as HTMLCanvasElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const width = Math.max(2, Math.round(cssW * dpr));
  const height = Math.max(2, Math.round(cssH * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const g = gl.gl;
  const fb = world.rig.framebuffer;
  const rects = layout(width, height, fb.width / fb.height);

  g.bindFramebuffer(g.FRAMEBUFFER, null);
  g.disable(g.SCISSOR_TEST);
  g.clearColor(0, 0, 0, 1);
  g.clear(g.COLOR_BUFFER_BIT);
  g.enable(g.SCISSOR_TEST);

  // Viewport 1: the room.
  const roomCamera = { ...world.viewer, width: rects.room.w, height: rects.room.h };
  const roomUniforms = buildUniforms(world.rig, world.scene, roomCamera, {
    mode: 'room',
    drawFloor: true,
    exposure: world.exposure,
    displayGamma: 2.2,
    specWeight: state.rho_spec,
    specAlpha: state.alpha_spec,
  });
  g.viewport(rects.room.x, rects.room.y, rects.room.w, rects.room.h);
  g.scissor(rects.room.x, rects.room.y, rects.room.w, rects.room.h);
  setUniforms(gl, roomUniforms);
  drawFullScreen(gl);

  // Viewports 2-5: the ONE framebuffer, split into its four quadrant viewports.
  // Unoccupied quadrants stay at the clear colour — §2's "quadrants go dark".
  const panel = rects.framebuffer;
  g.viewport(panel.x, panel.y, panel.w, panel.h);
  g.scissor(panel.x, panel.y, panel.w, panel.h);
  g.clearColor(0.02, 0.02, 0.024, 1);
  g.clear(g.COLOR_BUFFER_BIT);

  for (let i = 0; i < world.rig.projectors.length; i++) {
    const vp = world.rig.projectors[i].viewport;
    // conventions.ts §V: the SOS viewport origin is bottom-left, and so is GL's.
    // No flip here, deliberately, and this is the only place in the project
    // where that is true.
    const rx = panel.x + Math.round(vp.x * panel.w);
    const ry = panel.y + Math.round(vp.y * panel.h);
    const rw = Math.max(1, Math.round(vp.w * panel.w));
    const rh = Math.max(1, Math.round(vp.h * panel.h));
    const u = buildUniforms(world.rig, world.scene, roomCamera, {
      mode: 'projector',
      projIndex: i,
      displayGamma: 0, // already encoded framebuffer content; do not encode twice
    });
    g.viewport(rx, ry, rw, rh);
    g.scissor(rx, ry, rw, rh);
    setUniforms(gl, u);
    drawFullScreen(gl);
  }
  g.disable(g.SCISSOR_TEST);

  positionLabels(rects, dpr);
}

/** HTML labels over the canvas: GL draws no text, and text is what makes the
 *  quadrants readable as P1..P4 rather than as four similar squares. */
function positionLabels(rects: { room: Rect; framebuffer: Rect }, dpr: number): void {
  const overlay = el<HTMLDivElement>('overlay');
  const toCss = (r: Rect, canvasHeight: number): Rect => ({
    x: r.x / dpr,
    y: (canvasHeight - r.y - r.h) / dpr,
    w: r.w / dpr,
    h: r.h / dpr,
  });
  const canvas = el<HTMLCanvasElement>('view');
  const H = canvas.height;
  const parts: string[] = [];
  const room = toCss(rects.room, H);
  parts.push(
    `<div class="vp-label" style="left:${room.x + 8}px;top:${room.y + 8}px">ROOM VIEW` +
      `<span>viewer at ${state.view_az.toFixed(0)}°, ${state.d_view.toFixed(2)} m, eye ${state.h_eye.toFixed(2)} m</span></div>`,
  );
  const fb = toCss(rects.framebuffer, H);
  parts.push(
    `<div class="vp-label" style="left:${fb.x + 8}px;top:${fb.y + 8}px">ONE FRAMEBUFFER, FOUR QUADRANT VIEWPORTS` +
      `<span>${world.rig.framebuffer.width}×${world.rig.framebuffer.height} X screen — PARAMETERS.md §3.4</span></div>`,
  );
  for (let i = 0; i < 4; i++) {
    const p = world.rig.projectors[i];
    const vp = p ? p.viewport : [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }][i];
    const x = fb.x + vp.x * fb.w + 6;
    // Viewport y is bottom-left origin; CSS top is measured downward.
    const y = fb.y + fb.h - (vp.y + 0.5) * fb.h + 6;
    const label = p ? p.id : 'DARK';
    parts.push(
      `<div class="quad-label${p ? '' : ' dark'}" style="left:${x}px;top:${y}px">${label}</div>`,
    );
  }
  overlay.innerHTML = parts.join('');
}

// ---------------------------------------------------------------------------
// Parity — GPU against packages/sim, on screen
// ---------------------------------------------------------------------------

function runParity(): void {
  if (!gl) return;
  try {
    const camera = { ...world.viewer, width: PARITY_W, height: PARITY_H };
    const prepared = prepareRig(world.rig);

    const roomU = buildUniforms(world.rig, world.scene, camera, {
      mode: 'room',
      drawFloor: true,
      exposure: 1,
      displayGamma: 0,
      specWeight: state.rho_spec,
      specAlpha: state.alpha_spec,
    });
    const gpuRoom = renderAndRead(gl, roomU, PARITY_W, PARITY_H);
    const cpuRoom = renderRoomView(prepared, world.scene, camera, {
      samplesPerPixel: 1,
      drawFloor: true,
      shading: world.shading,
    });

    const projU = buildUniforms(world.rig, world.scene, camera, {
      mode: 'projector',
      projIndex: 0,
      displayGamma: 0,
    });
    const gpuProj = renderAndRead(gl, projU, PARITY_PW, PARITY_PH);
    const cpuProj = simProjectorSamples(prepared, 0, world.scene, PARITY_PW, PARITY_PH);

    const tolerance = gpuRoom.float
      ? GPU_TOLERANCE
      : // An 8-bit read-back quantizes at 1/255, so a float tolerance would be a
        // statement about the read-back path rather than about the renderer. The
        // UI says which one is in force.
        Math.max(GPU_TOLERANCE, 1 / 255);

    const tracks: ParityTrack[] = [
      track('room', 'ray-sphere, coverage, blend, mask, transfer, shading, floor', gpuRoom, cpuRoom, tolerance),
      track('projector-0', 'pixel → ray, distortion inversion, lens shift, raster bounds', gpuProj, cpuProj, tolerance),
    ];
    parity = summarize('gpu', tracks, tolerance);
    parityError = null;
  } catch (err) {
    parity = null;
    parityError = err instanceof Error ? err.message : String(err);
  }
  renderMetricsPanel();
}

function track(
  id: string,
  covers: string,
  a: { width: number; height: number; data: Float32Array },
  b: { width: number; height: number; data: Float32Array },
  tolerance: number,
): ParityTrack {
  const delta = comparePixels(a, b, tolerance);
  const percentileOk = delta.p999 <= tolerance;
  const boundaryOk = delta.fractionOverTolerance <= BOUNDARY_PIXEL_ALLOWANCE;
  const reasons: string[] = [];
  if (!percentileOk) reasons.push(`p99.9 ${delta.p999.toExponential(3)} > ${tolerance.toExponential(1)}`);
  if (!boundaryOk) {
    reasons.push(
      `${(delta.fractionOverTolerance * 100).toFixed(2)}% of pixels over tolerance (allowance ` +
        `${(BOUNDARY_PIXEL_ALLOWANCE * 100).toFixed(0)}%)`,
    );
  }
  return { id, covers, delta, tolerance, pass: percentileOk && boundaryOk, reason: reasons.join('; ') };
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function metricRow(m: PanelMetric): string {
  const verdict =
    m.pass === null
      ? '<span class="pill pending">reading</span>'
      : !m.scored
        ? `<span class="pill pending">${m.pass ? 'within' : 'over'} — not scored</span>`
        : m.pass
          ? '<span class="pill pass">PASS</span>'
          : '<span class="pill fail">FAIL</span>';
  const gate = m.gateMax === null ? '—' : `≤ ${fmt(m.gateMax, m.digits)}`;
  return `<tr class="${m.provisional ? 'prov' : ''}">
    <td><span class="mname">${m.label}</span><span class="msec">${m.section}</span>
        <div class="mnote">${m.note}</div></td>
    <td class="num">${fmt(m.value, m.digits)}<span class="munit">${m.unit}</span></td>
    <td class="num">${gate}</td>
    <td>${verdict}${m.provisional ? '<span class="pill provisional">PROVISIONAL</span>' : ''}</td>
  </tr>`;
}

function parityBlock(): string {
  if (parityError !== null) {
    return `<div class="parity fail">
      <div class="phead">GPU ↔ CPU PARITY — COULD NOT BE MEASURED</div>
      <div class="pbody">${parityError}</div>
      <div class="pnote">The harness renders with GLSL and the bench renders on the CPU. Those are two
        implementations of the simulator's own model and they can drift apart. With no parity number,
        nothing in this window is known to match what the bench scores.</div>
    </div>`;
  }
  if (parity === null) {
    return `<div class="parity pending">
      <div class="phead">GPU ↔ CPU PARITY — measuring…</div>
    </div>`;
  }
  const cls = parity.pass ? 'ok' : 'fail';
  const rows = parity.tracks
    .map(
      (t) =>
        `<tr class="${t.pass ? '' : 'bad'}"><td>${t.id}</td>
         <td class="num">${t.delta.p999.toExponential(2)}</td>
         <td class="num">${t.delta.maxAbs.toExponential(2)}</td>
         <td class="num">${t.delta.pixelsOverTolerance}/${t.delta.pixelCount}</td>
         <td class="cov">${t.covers}</td></tr>`,
    )
    .join('');
  return `<div class="parity ${cls}">
    <div class="phead">${parity.pass ? 'GPU ↔ CPU PARITY' : '⚠ GPU AND CPU RENDERERS DISAGREE'}
      <span class="pval">${parity.worstP999.toExponential(2)}</span>
      <span class="ptol">tolerance ${parity.tolerance.toExponential(1)} of relative radiance</span></div>
    ${parity.pass ? '' : `<div class="pbody">${parity.summary}</div>`}
    <table class="ptable"><thead><tr><th>track</th><th>p99.9</th><th>max</th><th>over tol.</th><th>covers</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="pnote">The GLSL renderer is a SECOND implementation of the simulator's model
      (docs/ARCHITECTURE.md). This is the delta between it and <code>packages/sim</code>'s CPU tracer on
      the same scene, at ${PARITY_W}×${PARITY_H} and ${PARITY_PW}×${PARITY_PH}, read back in
      ${gl && gl.floatReadback ? 'float' : '8-bit (no EXT_color_buffer_float — tolerance widened to 1/255)'}.
      Texture format ${gl ? gl.textureFormat : '?'}. The verdict is taken on the 99.9th percentile because a
      geometric boundary landing between two samples produces a full-amplitude delta at one pixel and that
      is not drift.</div>
  </div>`;
}

function renderMetricsPanel(): void {
  const host = el<HTMLDivElement>('metrics');
  const panel = lastPanel;
  const parityHtml = parityBlock();
  if (!panel) {
    host.innerHTML = `${parityHtml}<p class="muted">Metrics have not been computed yet.</p>`;
    return;
  }
  host.innerHTML = `
    ${parityHtml}
    <h3>Geometric <span class="tag">trustworthy today — every constant behind these is DOC, CFG or SOLVE</span></h3>
    <table class="mtable"><thead><tr><th>metric</th><th class="num">value</th><th class="num">gate</th><th></th></tr></thead>
      <tbody>${panel.geometry.map(metricRow).join('')}</tbody></table>
    <h3>Photometric <span class="tag prov">every one PROVISIONAL</span></h3>
    <div class="provbanner">
      PARAMETERS.md §10: every photometric constant is class ASSUME or MEAS and <strong>not one of them has
      been measured</strong>. §3.2's per-channel gamma divergence is ranked the single highest risk in the
      project. docs/ARCHITECTURE.md's phase gate therefore says: build these, mark them, and never optimize
      against them. A number below that passes its gate is a statement about γ_B = 2.2, which nobody has checked.
    </div>
    <table class="mtable"><thead><tr><th>metric</th><th class="num">value</th><th class="num">gate</th><th></th></tr></thead>
      <tbody>${panel.photometry.map(metricRow).join('')}</tbody></table>
    <p class="muted small">Computed by <code>packages/sim</code> from the calibration, not from the rendered
      pixels — a metric derived from the GPU image could share a bug with it and move together with the picture.
      Sampling density ${(panel.densityScale * 100).toFixed(0)}% of the bench's default; ${panel.computeMs} ms.
      ${metricsPending ? '<strong>recomputing…</strong>' : ''}</p>
    <p class="muted small">${framebufferSummary(world.rig)}</p>`;
}

let lastPanel: ReturnType<typeof computeMetricPanel> | null = null;

function recomputeMetrics(): void {
  metricsPending = true;
  renderMetricsPanel();
  // Yield first so the panel repaints with "recomputing" before the CPU work.
  window.setTimeout(() => {
    try {
      lastPanel = computeMetricPanel(world.rig, world.scene, {
        densityScale: 0.15,
        shading: world.shading,
        specWeight: state.rho_spec,
        specAlpha: state.alpha_spec,
      });
    } catch (err) {
      lastPanel = null;
      // eslint-disable-next-line no-console
      console.error('metric computation failed', err);
    }
    metricsPending = false;
    renderMetricsPanel();
  }, 0);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function controlHtml(c: ControlSpec): string {
  const value = state[c.id];
  const klass = `k-${c.klass.toLowerCase()}`;
  const assume = c.klass === 'ASSUME' ? ' assume' : '';
  let input: string;
  if (c.kind === 'select' && c.options) {
    input = `<select data-id="${c.id}">${c.options
      .map((o) => `<option value="${o.value}"${Math.round(value) === o.value ? ' selected' : ''}>${o.label}</option>`)
      .join('')}</select>`;
  } else if (c.kind === 'toggle') {
    input = `<label class="tgl"><input type="checkbox" data-id="${c.id}"${value >= 0.5 ? ' checked' : ''}/> on</label>`;
  } else {
    input = `<input type="range" data-id="${c.id}" min="${c.min}" max="${c.max}" step="${c.step}" value="${value}"/>`;
  }
  const rangeTag =
    c.rangeSource === 'stated'
      ? '<span class="rs stated" title="PARAMETERS.md states this range">range: stated</span>'
      : c.rangeSource === 'inferred'
        ? '<span class="rs inferred" title="We inferred this range — docs/AMENDMENTS.md A-04">range: inferred</span>'
        : '<span class="rs harness" title="Slider travel is a harness framing choice, not a claim about uncertainty">range: harness</span>';
  return `<div class="ctl${assume}" data-ctl="${c.id}">
    <div class="crow">
      <span class="cname" title="${c.note.replace(/"/g, '&quot;')}">${c.symbol}</span>
      <span class="cval" data-val="${c.id}">${fmt(value, c.decimals)}<span class="cunit">${c.unit}</span></span>
    </div>
    ${input}
    <div class="cmeta">
      <span class="pill klass ${klass}" title="${CLASS_BLURB[c.klass]}">${c.klass}</span>
      ${rangeTag}
      <span class="clabel">${c.label}</span>
    </div>
  </div>`;
}

function buildControls(): void {
  const host = el<HTMLDivElement>('controls');
  const groups = CONTROL_GROUPS.map(
    (g) => `<details class="group" open>
      <summary><span class="gsec">${g.section}</span> ${g.title}</summary>
      <p class="gblurb">${g.blurb}</p>
      <div class="ctls">${g.controls.map(controlHtml).join('')}</div>
    </details>`,
  ).join('');
  host.innerHTML = groups;

  host.addEventListener('input', (ev) => {
    const target = ev.target as HTMLInputElement | HTMLSelectElement;
    const id = target.getAttribute('data-id');
    if (!id) return;
    const spec = ALL_CONTROLS.find((c) => c.id === id);
    if (!spec) return;
    const next =
      spec.kind === 'toggle'
        ? (target as HTMLInputElement).checked
          ? 1
          : 0
        : Number(target.value);
    state = normalizeState({ ...state, [id]: next });
    const readout = host.querySelector(`[data-val="${id}"]`);
    if (readout) readout.innerHTML = `${fmt(state[id], spec.decimals)}<span class="cunit">${spec.unit}</span>`;
    onStateChanged();
  });
}

function syncControls(): void {
  const host = el<HTMLDivElement>('controls');
  for (const c of ALL_CONTROLS) {
    const input = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-id="${c.id}"]`);
    if (!input) continue;
    if (c.kind === 'toggle') (input as HTMLInputElement).checked = state[c.id] >= 0.5;
    else input.value = String(c.kind === 'select' ? Math.round(state[c.id]) : state[c.id]);
    const readout = host.querySelector(`[data-val="${c.id}"]`);
    if (readout) readout.innerHTML = `${fmt(state[c.id], c.decimals)}<span class="cunit">${c.unit}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let slowTimer = 0;

/**
 * Rebuild, redraw, and schedule the expensive work.
 *
 * The picture updates on every input event; parity and metrics are debounced,
 * because they cost tens of milliseconds and a slider drag fires continuously.
 * The equirect texture is NOT re-uploaded here: no slider changes the content,
 * only the `Content` selector does, and re-uploading a megapixel of float on
 * every frame of a viewer sweep would make the window feel like the model is
 * expensive when it is not.
 */
function onStateChanged(): void {
  world = rebuildWorld();
  renderFrame();
  window.clearTimeout(slowTimer);
  slowTimer = window.setTimeout(() => {
    runParity();
    if (autoMetrics) recomputeMetrics();
  }, 250);
}

function buildToolbar(): void {
  const host = el<HTMLDivElement>('toolbar');
  host.innerHTML = `
    <label>Content
      <select id="pattern">${PATTERNS.map(
        (p) => `<option value="${p.id}" title="${p.why}">${p.label}</option>`,
      ).join('')}</select></label>
    <label>Preset
      <select id="preset">${PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select></label>
    <label class="chk"><input type="checkbox" id="automet" checked/> auto-recompute metrics</label>
    <button id="recompute">Recompute now</button>
    <button id="reset">Reset to nominal</button>
    <span id="presetwhy" class="why"></span>`;

  el<HTMLSelectElement>('pattern').addEventListener('change', (ev) => {
    pattern = (ev.target as HTMLSelectElement).value as PatternId;
    world = rebuildWorld();
    if (gl) uploadEquirect(gl, { width: TEXTURE_W, height: TEXTURE_H, data: world.image.data });
    onStateChanged();
  });
  el<HTMLSelectElement>('preset').addEventListener('change', (ev) => {
    const id = (ev.target as HTMLSelectElement).value;
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    state = presetState(preset);
    el<HTMLSpanElement>('presetwhy').textContent = preset.why;
    syncControls();
    onStateChanged();
  });
  el<HTMLInputElement>('automet').addEventListener('change', (ev) => {
    autoMetrics = (ev.target as HTMLInputElement).checked;
  });
  el<HTMLButtonElement>('recompute').addEventListener('click', () => recomputeMetrics());
  el<HTMLButtonElement>('reset').addEventListener('click', () => {
    state = defaultState();
    el<HTMLSpanElement>('presetwhy').textContent = '';
    syncControls();
    onStateChanged();
  });
}

function fatal(message: string): void {
  el<HTMLDivElement>('fatal').innerHTML =
    `<strong>The harness cannot run here.</strong><br/>${message}<br/><br/>` +
    `The parity check that pins the GPU renderer to <code>packages/sim</code> also runs headless: ` +
    `<code>node --test "packages/harness/test/**/*.test.ts"</code>. That path needs no GPU and covers the ` +
    `model; only the float32 and driver terms need this window.`;
  el<HTMLDivElement>('fatal').style.display = 'block';
}

function boot(): void {
  buildToolbar();
  buildControls();
  try {
    gl = createHarnessGl(el<HTMLCanvasElement>('view'));
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
    return;
  }
  if (gl.missingUniforms.length > 0) {
    fatal(
      `the linked program does not expose these uniforms the shader declares: ` +
        `${gl.missingUniforms.join(', ')}. A uniform that went missing is a term of the model that ` +
        `stopped being applied, and the render would still look like a sphere.`,
    );
    return;
  }
  uploadEquirect(gl, { width: TEXTURE_W, height: TEXTURE_H, data: world.image.data });
  renderFrame();
  runParity();
  recomputeMetrics();
  window.addEventListener('resize', () => renderFrame());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
