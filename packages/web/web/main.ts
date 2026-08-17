/**
 * The page.
 *
 * ## Three threads, and what each is allowed to say
 *
 *   - **Main** — draws. It owns the GL context and the DOM and it never computes
 *     a metric. Every number it displays arrived from a worker.
 *   - **Model worker** — `packages/sim`. Says what is true about the rig.
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
 * render; when it settles it asks for the full density and the parity check. The
 * density is printed with the numbers, because a value that depends on a sample
 * count the reader cannot see is a value the reader cannot check.
 *
 * ## What the parity number is measuring
 *
 * The same camera, rendered twice: once by the GPU and once by
 * `packages/sim`'s `renderTwoRigRoomView`. `src/parity.ts` explains why the
 * verdict is a percentile rather than a maximum, and why the tolerance is 2e-3.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import type { Settings, SettingKey, ControlSpec } from '../src/settings.ts';
import {
  BOULDER_PRESET,
  CONTROLS,
  GROUPS,
  PRESETS,
  formatSetting,
  withSetting,
} from '../src/settings.ts';
import { buildViewer, buildWorld, worstAimOffender, worstPlacementOffender } from '../src/rigs.ts';
import type { Reading, RigFact } from '../src/readout.ts';
import { buildDisplayUniforms } from '../src/uniforms.ts';
import type { OverlayMode } from '../src/uniforms.ts';
import type { ParityVerdict } from '../src/parity.ts';
import { BOUNDARY_PIXEL_ALLOWANCE, PARITY_HEIGHT, PARITY_WIDTH, judgeParity } from '../src/parity.ts';
import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  SolveMessage,
  SolveRequest,
  SolveResponse,
} from '../src/protocol.ts';
import type { DisplayGl } from './gl.ts';
import { createDisplayGl, drawToCanvas, renderAndRead, uploadEquirect } from './gl.ts';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PageState {
  settings: Settings;
  /** What the compositor believes. `null` = the config as written. */
  compositorRig: RigCalibration | null;
  overlay: OverlayMode;
  /** `-1` shows every projector; otherwise isolate one. */
  highlight: number;
  /** Solve inputs. Deliberately few — see `protocol.ts` on why there is no noise slider. */
  cameraCount: number;
  handheld: boolean;
  sensorNoise: boolean;
  ambient: number;
}

const state: PageState = {
  settings: { ...BOULDER_PRESET },
  compositorRig: null,
  overlay: 'none',
  highlight: -1,
  cameraCount: 3,
  handheld: false,
  sensorNoise: true,
  ambient: 0.04,
};

let model: ModelResponse | null = null;
let parity: ParityVerdict | null = null;
let solveResult: SolveResponse | null = null;
let solveRunning = false;
let solvePhase = '';
let solveFraction = 0;
let modelPending = false;
let lastError = '';

let gl: DisplayGl | null = null;
/** Which content the texture currently holds, so it is re-uploaded only on a change. */
let contentKey = '';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const controlsEl = document.getElementById('controls') as HTMLDivElement;
const panelEl = document.getElementById('panel') as HTMLDivElement;
const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const stageNoteEl = document.getElementById('stagenote') as HTMLDivElement;
const fatalEl = document.getElementById('fatal') as HTMLDivElement;

function fatal(message: string): void {
  fatalEl.textContent = message;
  fatalEl.classList.add('on');
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

const modelWorker = new Worker(new URL('../worker/model.js', import.meta.url), { type: 'module' });
const solveWorker = new Worker(new URL('../worker/solve.js', import.meta.url), { type: 'module' });

let modelSeq = 0;
let modelWanted = -1;
/** The camera the outstanding parity request was made for, so a stale reply is dropped. */
let parityRequestKey = '';

/**
 * Ask the model worker for the metrics.
 *
 * `fine` decides both the sampling density and whether a parity render comes
 * back. The coarse pass exists so a drag feels connected to the numbers; the
 * fine pass is the one worth reading, and the panel says which it is showing.
 */
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
  };
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
  renderPanel();
}

modelWorker.onmessage = (event: MessageEvent<ModelMessage>): void => {
  const msg = event.data;
  // Drop a stale reply: a coarse pass sent before the last drag can land after
  // the fine pass that superseded it, and showing it would make the panel walk
  // backwards for no visible reason.
  if (msg.id !== modelWanted) return;
  modelPending = false;
  if (!msg.ok) {
    lastError = msg.error;
    renderPanel();
    return;
  }
  lastError = '';
  model = msg;
  if (msg.parityImage) checkParity(msg.parityImage, msg.parityMs);
  renderPanel();
};

solveWorker.onmessage = (event: MessageEvent<SolveMessage>): void => {
  const msg = event.data;
  if (msg.kind === 'solve-progress') {
    solvePhase = msg.message;
    solveFraction = msg.fraction;
    renderPanel();
    return;
  }
  solveRunning = false;
  if (!msg.ok) {
    lastError = msg.error;
    solvePhase = '';
    renderPanel();
    return;
  }
  solveResult = msg;
  state.compositorRig = msg.recoveredRig;
  solvePhase = '';
  solveFraction = 1;
  markDirty();
  requestModel(true);
};

let solveSeq = 0;

function startSolve(): void {
  if (solveRunning) return;
  solveRunning = true;
  solveFraction = 0;
  solvePhase = 'Building the room and placing the cameras…';
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
    sensorNoise: state.sensorNoise,
    ambient: state.ambient,
    seed: (state.settings.errorSeed * 2654435761) % 2147483647,
  };
  solveWorker.postMessage(req);
  renderPanel();
}

function resetCalibration(): void {
  state.compositorRig = null;
  solveResult = null;
  markDirty();
  requestModel(true);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let dirty = true;
function markDirty(): void {
  dirty = true;
}

function viewKey(): string {
  const s = state.settings;
  return `${s.viewAzDeg}|${s.viewElDeg}|${s.viewRangeM}|${s.viewFovDeg}`;
}

/**
 * Upload the equirect content only when something it depends on moved.
 *
 * The grid spacing is the only setting that changes the texture; everything else
 * changes where the texture LANDS. Re-uploading a megabyte every frame because
 * the viewer turned would cost more than the render.
 */
function ensureContent(image: { width: number; height: number; data: Float32Array }): void {
  const key = `${state.settings.gridDeg}`;
  if (gl && key !== contentKey) {
    uploadEquirect(gl, image);
    contentKey = key;
  }
}

function draw(): void {
  if (!gl) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const world = buildWorld(state.settings, state.compositorRig ?? undefined);
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

/**
 * The GPU half of the parity check, compared against the CPU half the worker
 * just sent.
 *
 * Rendered at `displayGamma: 0` — linear, unencoded — because `sim` returns
 * linear radiance and encoding one side would make the comparison measure the
 * encode. Skipped when the view moved while the worker was busy, since the two
 * images would then be of different cameras and the delta would be enormous and
 * meaningless.
 */
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
    const world = buildWorld(state.settings, state.compositorRig ?? undefined);
    // Not merely defensive: a worker reply that landed before the first animation
    // frame would find the content texture never uploaded, and an incomplete
    // texture samples as black — which is indistinguishable from the shader
    // getting the model wrong. `ensureContent` is a no-op when it is current.
    ensureContent(world.image);
    const camera = buildViewer(state.settings, cpu.width, cpu.height);
    const uniforms = buildDisplayUniforms(
      prepareRig(world.truthRig),
      prepareRig(world.compositorRig),
      world.scene,
      camera,
      // No floor and no overlay: `renderTwoRigRoomView` draws neither, so drawing
      // either here would make the parity number measure a difference in
      // settings. The cost is that `shadeFloor` — its occlusion test and the
      // room albedo — is the one part of the shader this check does not cover,
      // and the panel says so rather than implying full coverage.
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
  // The read-back bound an offscreen framebuffer; the canvas is stale until the
  // next frame redraws it.
  markDirty();
}

function frame(): void {
  if (dirty) {
    dirty = false;
    try {
      draw();
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

let settleTimer = 0;

function onSettingChanged(key: SettingKey, value: number): void {
  state.settings = withSetting(state.settings, key, value);
  // Changing the geometry invalidates a calibration that was solved for the old
  // one. Silently keeping it would show a recovered rig against a rig it never
  // saw, which is a picture of nothing.
  const spec = CONTROL_BY_KEY.get(key);
  if (spec && spec.group !== 'view' && state.compositorRig !== null) {
    state.compositorRig = null;
    solveResult = null;
  }
  markDirty();
  renderControls();
  requestModel(false);
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => requestModel(true), 260);
}

const CONTROL_BY_KEY = new Map<SettingKey, ControlSpec>(CONTROLS.map((c) => [c.key, c]));

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

const openHelp = new Set<string>();

function controlRow(spec: ControlSpec): HTMLElement {
  const value = state.settings[spec.key];
  const box = el('div', { className: `ctl${spec.klass === 'ASSUME' ? ' assume' : ''}` });
  if (openHelp.has(spec.key)) box.classList.add('open');

  const name = el('div', {}, [
    el('span', { className: 'cname', textContent: spec.label }),
    spec.symbol ? el('span', { className: 'csym mono', textContent: spec.symbol }) : '',
  ]);
  const right = el('div', {}, [
    el('span', { className: 'cval', textContent: formatSetting(spec, value) }),
    ' ',
    el('span', { className: `pill k-${spec.klass}`, textContent: spec.klass, title: klassTitle(spec.klass) }),
  ]);
  box.append(el('div', { className: 'crow' }, [name, right]));

  const range = el('input', {
    type: 'range',
    min: String(spec.min),
    max: String(spec.max),
    step: String(spec.step),
    value: String(value),
  });
  range.addEventListener('input', () => onSettingChanged(spec.key, Number(range.value)));
  box.append(range);

  const why = el('button', { className: 'cwhy', textContent: openHelp.has(spec.key) ? 'less' : 'what is this?' });
  why.addEventListener('click', () => {
    if (openHelp.has(spec.key)) openHelp.delete(spec.key);
    else openHelp.add(spec.key);
    renderControls();
  });
  box.append(why);
  box.append(el('div', { className: 'chelp', textContent: `${spec.section} ${spec.help}`.trim() }));
  return box;
}

function klassTitle(klass: ControlSpec['klass']): string {
  switch (klass) {
    case 'DOC':
      return 'Documented. Written down in a NOAA document.';
    case 'CFG':
      return "Configuration. Read out of the installation's own config file.";
    case 'SOLVE':
      return 'Solved. Recovered by calibration rather than measured.';
    case 'ASSUME':
      return 'Assumed. NOBODY HAS MEASURED THIS. Anything downstream is provisional.';
    case 'MEAS':
      return 'Needs measuring in person. On the field card.';
    default:
      return 'A control of this page, not a constant of the installation.';
  }
}

const openGroups = new Set<string>(['install', 'lens', 'error']);

function renderControls(): void {
  controlsEl.replaceChildren();
  for (const group of GROUPS) {
    const details = el('details', { className: 'group', open: openGroups.has(group.id) });
    details.addEventListener('toggle', () => {
      if (details.open) openGroups.add(group.id);
      else openGroups.delete(group.id);
    });
    details.append(el('summary', { textContent: group.title }));
    details.append(el('div', { className: 'gblurb', textContent: group.blurb }));
    for (const spec of CONTROLS.filter((c) => c.group === group.id)) {
      details.append(controlRow(spec));
    }
    controlsEl.append(details);
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function renderToolbar(): void {
  toolbarEl.replaceChildren();

  const preset = el('select');
  preset.append(el('option', { value: '', textContent: 'Load a preset…' }));
  for (const p of PRESETS) {
    preset.append(el('option', { value: p.id, textContent: `${p.label} — ${p.blurb}` }));
  }
  preset.addEventListener('change', () => {
    const found = PRESETS.find((p) => p.id === preset.value);
    if (!found) return;
    state.settings = { ...found.settings };
    state.compositorRig = null;
    solveResult = null;
    preset.value = '';
    markDirty();
    renderControls();
    requestModel(true);
  });
  toolbarEl.append(preset);

  const overlay = el('select');
  const modes: { id: OverlayMode; label: string }[] = [
    { id: 'none', label: 'Plain view' },
    { id: 'overlap', label: 'Colour by how many projectors light it' },
    { id: 'seams', label: 'Show the seams' },
    { id: 'unlit', label: 'Show what is dark' },
  ];
  for (const m of modes) overlay.append(el('option', { value: m.id, textContent: m.label }));
  overlay.value = state.overlay;
  overlay.addEventListener('change', () => {
    state.overlay = overlay.value as OverlayMode;
    markDirty();
  });
  toolbarEl.append(overlay);

  const isolate = el('select');
  isolate.append(el('option', { value: '-1', textContent: 'All projectors' }));
  for (let i = 0; i < Math.round(state.settings.projectorCount); i++) {
    isolate.append(el('option', { value: String(i), textContent: `Only P${i + 1}` }));
  }
  isolate.value = String(state.highlight);
  isolate.addEventListener('change', () => {
    state.highlight = Number(isolate.value);
    markDirty();
  });
  toolbarEl.append(isolate);

  toolbarEl.append(el('div', { className: 'spacer' }));

  const cams = el('select', { title: 'How many positions the operator photographs from.' });
  for (let n = 1; n <= 8; n++) {
    cams.append(el('option', { value: String(n), textContent: `${n} camera${n === 1 ? '' : 's'}` }));
  }
  cams.value = String(state.cameraCount);
  cams.addEventListener('change', () => {
    state.cameraCount = Number(cams.value);
  });
  toolbarEl.append(cams);

  const rig = el('select', {
    title: 'Experiment 1 measured this: a tripod localises to under a millimetre, the same camera ' +
      'handheld to about nine, and that one difference outweighs everything else put together.',
  });
  rig.append(el('option', { value: 'tripod', textContent: 'On a tripod' }));
  rig.append(el('option', { value: 'handheld', textContent: 'Handheld' }));
  rig.value = state.handheld ? 'handheld' : 'tripod';
  rig.addEventListener('change', () => {
    state.handheld = rig.value === 'handheld';
  });
  toolbarEl.append(rig);

  const solveBtn = el('button', {
    className: 'primary',
    textContent: solveRunning ? 'Calibrating…' : 'Recalibrate',
    disabled: solveRunning,
  });
  solveBtn.addEventListener('click', startSolve);
  toolbarEl.append(solveBtn);

  if (state.compositorRig !== null) {
    const reset = el('button', { textContent: 'Forget the calibration' });
    reset.addEventListener('click', resetCalibration);
    toolbarEl.append(reset);
  }

  // The seed is a slider in the panel because it belongs beside the mount error
  // it draws. It is also a button here, because "show me a different unlucky
  // installer" is a thing somebody wants to do repeatedly and dragging a slider
  // across a million positions is not how they want to do it.
  const reshuffle = el('button', {
    textContent: 'Another install',
    title: 'Draw a different mount error at the same magnitude. Deterministic: the seed is shown ' +
      'in the panel and the same seed always gives the same rig.',
  });
  reshuffle.addEventListener('click', () => {
    // A fixed odd stride rather than Math.random: the sequence is reproducible
    // from the starting seed, which is the property every other number on this
    // page depends on.
    onSettingChanged('errorSeed', ((state.settings.errorSeed + 104729) % 999_999) + 1);
  });
  toolbarEl.append(reshuffle);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const openRows = new Set<string>();

function fmtMm(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(v < 10 ? 2 : 1)} mm` : '—';
}

function headline(): HTMLElement {
  const box = el('div', { className: 'headline' });
  if (!model) {
    box.append(el('div', { className: 'cap', textContent: 'Worst grid-line error' }));
    box.append(el('div', { className: 'big muted', textContent: 'computing…' }));
    return box;
  }
  const grid = model.readings.find((r) => r.id === 'grid_displacement');
  const pass = grid?.status === 'PASS';
  box.append(el('div', { className: 'cap', textContent: 'Worst grid-line error' }));
  box.append(
    el('div', { className: `big ${pass ? 'pass' : 'fail'}`, textContent: fmtMm(model.gridWorstMm) }),
  );
  box.append(
    el('div', {
      className: 'why',
      textContent: pass
        ? 'Inside the 1 mm gate. A line on the alignment grid lands where it should everywhere on ' +
          'the sphere.'
        : 'Outside the 1 mm gate. This is how far a line on the alignment grid sits from where it ' +
          'belongs, at the worst point on the sphere — the doubled or kinked line an operator sees.',
    }),
  );

  if (model.gridBaselineMm !== null && solveResult) {
    const from = model.gridBaselineMm;
    const to = model.gridWorstMm;
    const factor = to > 0 ? from / to : Infinity;
    const d = el('div', { className: 'delta' }, [
      el('span', { className: 'from', textContent: fmtMm(from) }),
      el('span', { className: 'arrow', textContent: '→' }),
      el('span', { className: 'to', textContent: fmtMm(to) }),
      el('span', {
        className: 'muted small',
        textContent: Number.isFinite(factor)
          ? `${factor.toFixed(1)}× better after the calibration`
          : 'after the calibration',
      }),
    ]);
    box.append(d);
  } else {
    const world = buildWorld(state.settings);
    const place = worstPlacementOffender(world.perturbation, state.settings.distanceM);
    const aim = worstAimOffender(world.perturbation);
    const parts: string[] = [];
    if (place) parts.push(`${place.projectorId} ${place.what} (${place.amount})`);
    if (aim) parts.push(`${aim.projectorId} ${aim.what} (${aim.amount})`);
    if (parts.length > 0) {
      box.append(
        el('div', { className: 'delta' }, [
          el('span', { className: 'muted small', textContent: `Biggest single fault: ${parts.join('; ')}.` }),
        ]),
      );
    }
  }
  return box;
}

function parityBox(): HTMLElement {
  if (!parity) {
    return el('div', { className: 'parity pending' }, [
      el('div', { className: 'ph', textContent: 'Picture vs model' }),
      el('div', {
        textContent:
          'Not measured yet — it runs when the view settles. The page renders the same camera twice, ' +
          'once on the GPU and once through the forward model on the CPU, and prints how far apart ' +
          'they are.',
      }),
    ]);
  }
  const box = el('div', { className: `parity ${parity.pass ? 'ok' : 'bad'}` });
  box.append(
    el('div', { className: 'ph', textContent: parity.pass ? 'Picture matches the model' : 'Picture disagrees with the model' }),
  );
  box.append(el('div', { textContent: parity.summary }));
  box.append(
    el('div', {
      className: 'small muted gap',
      textContent:
        'The floor is off on both sides for this comparison, because the model’s two-calibration ' +
        'renderer does not draw one — so the floor’s occlusion test and the room albedo are the one ' +
        'part of the shader this number does not cover.',
    }),
  );
  box.append(
    el('div', {
      className: 'small muted',
      textContent:
        `worst pixel ${parity.delta.maxAbs.toExponential(1)}, ` +
        `${(parity.delta.fractionOverTolerance * 100).toFixed(2)}% over tolerance ` +
        `(${(BOUNDARY_PIXEL_ALLOWANCE * 100).toFixed(0)}% allowed for edges), ` +
        `${parity.delta.pixelCount.toLocaleString()} pixels, CPU side ${parity.cpuMs.toFixed(0)} ms`,
    }),
  );
  return box;
}

function readingsTable(readings: readonly Reading[]): HTMLElement {
  const table = el('table', { className: 'rows' });
  const head = el('tr', {}, [
    el('th', { textContent: 'What was measured' }),
    el('th', { textContent: '' }),
    el('th', { textContent: 'Value' }),
  ]);
  table.append(head);
  for (const r of readings) {
    const tr = el('tr', { className: 'clickable' });
    if (openRows.has(r.id)) tr.classList.add('open');
    tr.addEventListener('click', () => {
      if (openRows.has(r.id)) openRows.delete(r.id);
      else openRows.add(r.id);
      renderPanel();
    });
    const nameCell = el('td', {}, [
      el('span', { className: 'rname', textContent: r.label }),
      el('div', { className: 'rnote', textContent: `${r.means} ${r.lever}`.trim() }),
    ]);
    tr.append(nameCell);
    tr.append(el('td', {}, [el('span', { className: `st ${r.status}`, textContent: r.status })]));
    tr.append(
      el('td', { className: 'rval' }, [
        r.value,
        r.gate ? el('span', { className: 'rgate', textContent: `gate ${r.gate}` }) : '',
      ]),
    );
    table.append(tr);
  }
  return table;
}

function factsTable(facts: readonly RigFact[]): HTMLElement {
  const table = el('table', { className: 'rows' });
  for (const f of facts) {
    const id = `fact:${f.label}`;
    const tr = el('tr', { className: 'clickable' });
    if (openRows.has(id)) tr.classList.add('open');
    tr.addEventListener('click', () => {
      if (openRows.has(id)) openRows.delete(id);
      else openRows.add(id);
      renderPanel();
    });
    tr.append(
      el('td', {}, [
        el('span', { className: 'rname', textContent: f.label }),
        el('div', { className: 'rnote', textContent: f.note }),
      ]),
    );
    tr.append(
      el('td', {}, [
        f.ok === null
          ? ''
          : el('span', { className: `st ${f.ok ? 'PASS' : 'FAIL'}`, textContent: f.ok ? 'OK' : 'WATCH' }),
      ]),
    );
    tr.append(
      el('td', { className: 'rval' }, [
        f.value,
        f.verdict ? el('span', { className: 'rgate', textContent: f.verdict }) : '',
      ]),
    );
    table.append(tr);
  }
  return table;
}

const MULT_COLORS = ['#2a2f38', '#2a61a0', '#33ad6b', '#e62419'];

function coverageBar(fractions: readonly number[]): HTMLElement {
  const wrap = el('div');
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
    const key = el('span', {}, []);
    const swatch = el('i');
    swatch.style.background = color;
    key.append(swatch, `${labels[Math.min(i, labels.length - 1)]} ${(f * 100).toFixed(1)}%`);
    legend.append(key);
  }
  wrap.append(bar, legend);
  return wrap;
}

function solveBox(): HTMLElement {
  const box = el('div', { id: 'solvebox', className: solveRunning ? 'running' : '' });
  if (solveRunning) {
    box.append(el('div', { textContent: solvePhase }));
    const prog = el('div', { className: 'prog' });
    const fill = el('i');
    fill.style.width = `${Math.round(solveFraction * 100)}%`;
    prog.append(fill);
    box.append(prog);
    box.append(
      el('div', {
        className: 'small muted',
        textContent:
          'The simulator is photographing the sphere and the solver is recovering the rig from ' +
          'those photographs alone. It has never seen where the projectors really are.',
      }),
    );
    return box;
  }
  if (!solveResult) {
    box.append(
      el('div', {
        textContent:
          'The software is running on the config as written — the numbers an operator typed in, ' +
          'not where the projectors ended up. Press Recalibrate to photograph the sphere and solve ' +
          'for the truth.',
      }),
    );
    return box;
  }

  const r = solveResult;
  box.append(el('div', { className: 'ph', textContent: 'Calibration result' }));
  const dl = el('dl');
  const row = (k: string, v: string): void => {
    dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
  };
  row('Photographs', `${r.frames} frames, ${r.grayBits} Gray planes`);
  row('Points decoded', r.correspondences.toLocaleString());
  row('Residual', `${r.residualRmsPx.toFixed(3)} px`);
  row('Iterations', `${r.iterations}${r.converged ? '' : ' (hit the cap)'}`);
  row('Lens position error', fmtMm(r.posePositionMm));
  row('Lens aim error', `${r.poseRotationDeg.toFixed(3)}°`);
  row('Sphere height error', fmtMm(r.centerHeightErrorMm));
  row('Unobservable rotation', `${r.gaugeAngleDeg.toFixed(3)}°`);
  row('Time', `${((r.captureMs + r.solveMs) / 1000).toFixed(1)} s`);
  box.append(dl);
  box.append(
    el('div', {
      className: 'small muted',
      textContent:
        'The three error figures are against ground truth the solver never saw. The unobservable ' +
        'rotation is real and not a defect: a sphere photographed from outside cannot fix its own ' +
        'rotation about its centre, so that much is removed before anything is scored.',
    }),
  );
  return box;
}

function renderPanel(): void {
  panelEl.replaceChildren();

  if (lastError) {
    panelEl.append(
      el('div', { className: 'parity bad' }, [
        el('div', { className: 'ph', textContent: 'Something failed' }),
        el('div', { textContent: lastError }),
      ]),
    );
  }

  panelEl.append(headline());
  panelEl.append(solveBox());
  panelEl.append(parityBox());

  if (model) {
    panelEl.append(el('h2', { textContent: 'Against the specification' }));
    panelEl.append(readingsTable(model.readings));
    panelEl.append(
      el('div', {
        className: 'small muted gap',
        textContent:
          `Computed by packages/sim at ${(model.densityScale * 100).toFixed(0)}% of the bench's ` +
          `sampling density, ${model.metricsMs.toFixed(0)} ms` +
          `${modelPending ? ' — a newer pass is running' : ''}. Click a row for what it means.`,
      }),
    );

    panelEl.append(el('h2', { textContent: 'What this rig is' }));
    panelEl.append(factsTable(model.facts));

    panelEl.append(el('h2', { textContent: 'Coverage' }));
    panelEl.append(coverageBar(model.multiplicityAreaFraction));
    panelEl.append(
      el('div', {
        className: 'small muted gap',
        textContent:
          `The dark region at the bottom is ${(model.unlitPolarSouth * 100).toFixed(2)}% of the ` +
          `sphere, and it is not a circle — coverage reaches about 80° of latitude along each ` +
          `projector's own meridian and only about 76° between them, so the hole is four-lobed and ` +
          `scalloped. Turn on "Show what is dark" and look at it from below.`,
      }),
    );
    panelEl.append(
      el('div', { className: 'small muted gap', textContent: model.framebuffer }),
    );
  } else if (!lastError) {
    panelEl.append(el('div', { className: 'small muted', textContent: 'Computing the first pass…' }));
  }

  renderToolbar();
  stageNoteEl.textContent =
    'Drag to walk around, scroll to move closer. The picture is a shader; the numbers are the model.';
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
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.classList.remove('dragging');
    canvas.releasePointerCapture(e.pointerId);
    requestModel(true);
  });
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
  renderControls();
  renderPanel();
  requestModel(true);
  requestAnimationFrame(frame);
}

boot();
