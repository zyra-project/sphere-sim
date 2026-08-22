/**
 * The progress page: `progress/index.html`, regenerated from `bench-results.json`
 * plus the PNGs a round already wrote to `progress/data/`.
 *
 *     node packages/bench/src/progress.ts        # rebuild the page
 *     node packages/bench/src/reference.ts       # the static reference, ONCE, by hand
 *
 * This is the primary way a human sees whether the project is working, so it is
 * built against the three failure modes `results.ts` is built against — a mean
 * hiding a bimodal failure, a pass rate hiding which gate failed and why, a
 * number with no provenance — plus one that only applies to a picture:
 *
 * **A plot that cannot show structure is decoration.** The residual scatter is
 * the first thing on the page and it draws EVERY correspondence, because the
 * question it answers is whether the residual is structured (the model is wrong)
 * or random (sensor noise). That distinction is invisible in a scalar RMS,
 * obvious in a scatter, and quantified beside every panel so nobody has to trust
 * their eyes.
 *
 * ## Rules the output obeys
 *
 * - **Self-contained.** Inline CSS, inline SVG, images as `data:` URIs. No
 *   network request of any kind. `test/progress.test.ts` asserts the absence of
 *   external URLs, because a report that quietly needs the internet is a report
 *   that will be blank in the room where it matters.
 * - **Plots are SVG generated from the data.** A static report, not a charting
 *   app: there is no JavaScript in the output at all, so nothing can fail to
 *   initialise and nothing renders differently on a second visit.
 * - **Legible in light and dark.** Every colour is a CSS custom property with a
 *   `prefers-color-scheme` override, and no plot encodes information in a colour
 *   that vanishes against either background.
 * - **The static reference is READ, never computed here.** `reference.ts`
 *   explains why that separation is the whole point of it.
 * - **Explained before it is dense, and never instead of it.** An orientation
 *   block opens the page, every section carries a plain-language "how to read
 *   this" box under its heading, and a glossary defines the vocabulary the rest
 *   of the page uses without pausing. All of it is ADDITIVE: not one number,
 *   caption, citation or diagnostic was removed, rounded or softened to make
 *   room, because the reader who needs the scaffolding and the reader who reads
 *   `bench-results.json` are two different people and the page serves both.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { viridis } from '../../sim/src/png.ts';
import type { MetricResult } from '../../sim/src/metrics/index.ts';
import type { BenchResults, Dispersion, GateSummary, ScenarioJson } from './results.ts';
import type { RoundHistory, RoundRecord } from './loop.ts';
import { ROUNDS_SCHEMA, TRACKED } from './loop.ts';
import type { CoverageReference, ReferenceChecks } from './reference.ts';
import { REFERENCE_RELATIVE_PATH, analyseCoverageReference, loadCoverageReference } from './reference.ts';

export const PROGRESS_SCHEMA = 'sphere-sim/progress-page@1';

// ---------------------------------------------------------------------------
// The parts of `bench-results.json` this page reads
//
// `ScenarioJson` types `solver`, `recovery` and `inputs` as open records so the
// results schema can grow without this file's types going stale. Narrow views of
// them live here and are applied at the read site with a shape check, so a
// results file missing a block renders an explicit gap instead of throwing.
// ---------------------------------------------------------------------------

export interface ResidualColumnsJson {
  count: number;
  projector: number[];
  camera: number[];
  u: number[];
  v: number[];
  du: number[];
  dv: number[];
}

export interface SolverJson {
  converged: boolean;
  stopReason: string;
  iterations: number;
  rmsResidualPx: number;
  perProjectorRmsPx: number[];
  correspondencesUsed: number;
  correspondencesRejected: number;
  gaugeFreeAxes: boolean[];
  centerHeightObserved: boolean;
  residuals: ResidualColumnsJson;
}

export interface RecoveryJson {
  preAlignment: { maxPositionMm: number; maxRotationDeg: number };
  postAlignment: { maxPositionMm: number; maxRotationDeg: number };
  gauge: { angleDeg: number; unconstrainedAngleDeg: number; freeAxes: boolean[] };
  centerHeight: { errorMm: number; observed: boolean };
  intrinsics: { maxFovHDeg: number; maxK1: number; maxK2: number; maxShift: number };
}

export interface InputsJson {
  projectorCount: number;
  slots: number[];
  distanceM: number;
  projectorRes: { x: number; y: number };
  maskInterpretation: 'latitude' | 'colatitude';
  floorReferenceCount: number;
  floorSigmaM: number;
  cameras: { count: number; res: { x: number; y: number } };
  degradation: { ambient: number };
  injected: { centerHeightMm: number; projectors: { id: string; azimuthDeg: number }[] };
}

function solverOf(s: ScenarioJson): SolverJson | null {
  const raw = s.solver as unknown as SolverJson | null;
  if (raw === null || raw === undefined) return null;
  return raw.residuals === undefined ? null : raw;
}

function recoveryOf(s: ScenarioJson): RecoveryJson | null {
  const raw = s.recovery as unknown as RecoveryJson | null;
  if (raw === null || raw === undefined) return null;
  return raw.postAlignment === undefined ? null : raw;
}

function inputsOf(s: ScenarioJson): InputsJson {
  return (s.inputs ?? {}) as unknown as InputsJson;
}

function artifact(s: ScenarioJson, key: string): string {
  const a = s.artifacts;
  if (a === null || a === undefined) return '';
  const v = a[key];
  return typeof v === 'string' ? v : '';
}

/** Nominal azimuth of a projector slot, PARAMETERS.md §2, counterclockwise. */
const SLOT_AZIMUTH_DEG = [0, 90, 180, 270];

function projectorMeridiansDeg(inputs: InputsJson): number[] {
  const slots = inputs.slots ?? [];
  const injected = inputs.injected?.projectors ?? [];
  return slots.map((slot, i) => {
    const base = SLOT_AZIMUTH_DEG[slot] ?? 0;
    const delta = injected[i]?.azimuthDeg ?? 0;
    let lon = base + delta;
    while (lon > 180) lon -= 360;
    while (lon <= -180) lon += 360;
    return lon;
  });
}

// ---------------------------------------------------------------------------
// Residual statistics — the numbers that stand beside each scatter panel
// ---------------------------------------------------------------------------

export interface ResidualBin {
  rMid: number;
  mean: number;
  sd: number;
  count: number;
}

export interface ResidualStats {
  projector: number;
  label: string;
  count: number;
  rmsPx: number;
  biasDuPx: number;
  biasDvPx: number;
  /** Standard deviations along the principal axes of the (du, dv) cloud. */
  sigmaMajorPx: number;
  sigmaMinorPx: number;
  /** `sigmaMajor / sigmaMinor`. 1 is isotropic. */
  anisotropy: number;
  /** Orientation of the major axis in the raster, degrees from +u. */
  majorAxisDeg: number;
  /**
   * The anisotropy the DECODE alone produces. `patterns.ts` counts Gray planes
   * once and uses that count on both axes, so the `u` stride is `resX/2^b` and
   * the `v` stride is `resY/2^b`: a decode-noise-limited residual is wider in
   * `u` than in `v` by exactly the raster aspect ratio, and departures from
   * that ratio — not the ratio itself — are the model talking.
   */
  anisotropyExpected: number;
  /** Fraction of the RADIAL residual's variance explained by image radius. */
  radialStructure: number;
  /** What that fraction would be for independent noise: `(bins - 1) / count`. */
  radialStructureExpected: number;
  /** `(observed - expected) / sd_under_noise`. The structure statistic. */
  radialStructureZ: number;
  meanRadialPx: number;
  /** Largest per-quadrant mean residual, in standard errors. G3's signature. */
  quadrantZ: number;
  /**
   * Fraction of residuals pointing within 10 degrees of the `u` or `v` raster
   * axis, after standardising each axis separately.
   *
   * The decode quantises `u` and `v` independently, so a decode-limited residual
   * lands on an axis-aligned lattice and the cloud grows arms along the two
   * raster axes. Standardising per axis first removes the anisotropy, so this
   * measures the CROSS rather than the stretch — two different apparatus
   * signatures that the same ellipse would confound.
   */
  axisAlignedFraction: number;
  /** `2/9`: what an isotropic cloud gives for four ±10° sectors. */
  axisAlignedExpected: number;
  axisAlignedZ: number;
  bins: ResidualBin[];
  centreU: number;
  centreV: number;
  maxRadiusPx: number;
  verdict: 'noise' | 'weak' | 'structured';
  verdictText: string;
}

interface ProjectorPoints {
  u: number[];
  v: number[];
  du: number[];
  dv: number[];
}

/** One projector's points, pulled out of the columnar residual block. */
export function pointsFor(cols: ResidualColumnsJson, projector: number): ProjectorPoints {
  const out: ProjectorPoints = { u: [], v: [], du: [], dv: [] };
  const count = Math.min(cols.count, cols.projector.length);
  for (let i = 0; i < count; i++) {
    if (cols.projector[i] !== projector) continue;
    const a = cols.du[i];
    const b = cols.dv[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.u.push(cols.u[i]);
    out.v.push(cols.v[i]);
    out.du.push(a);
    out.dv.push(b);
  }
  return out;
}

/** Image radius and the radial component of each residual, about `(cu, cv)`. */
function radialComponents(
  p: ProjectorPoints,
  cu: number,
  cv: number,
): { radius: number[]; radial: number[] } {
  const radius: number[] = [];
  const radial: number[] = [];
  for (let i = 0; i < p.du.length; i++) {
    const x = p.u[i] - cu;
    const y = p.v[i] - cv;
    const r = Math.hypot(x, y);
    const ux = r > 0 ? x / r : 1;
    const uy = r > 0 ? y / r : 0;
    radius.push(r);
    radial.push(p.du[i] * ux + p.dv[i] * uy);
  }
  return { radius, radial };
}

const RADIAL_BINS = 12;

/**
 * The isotropy and structure statistics for one projector's residuals.
 *
 * Two independent questions, because the failure signatures
 * docs/ARCHITECTURE.md names are two different shapes:
 *
 *  - **Anisotropy** (G1): is the cloud round? Reported as the ratio of the two
 *    principal standard deviations against the ratio the decode alone produces.
 *    A cloud stretched along `u` by the raster aspect ratio is the apparatus;
 *    anything else is the model.
 *  - **Radial structure** (G3, G4): does the residual's radial component depend
 *    on image radius? Reported as the fraction of that component's variance
 *    explained by a 12-bin radial profile, compared with the fraction
 *    independent noise produces by chance, in units of that null's own standard
 *    deviation. conventions.ts §C names this signature exactly: a distortion
 *    applied in the wrong direction is "symmetric in image radius and therefore
 *    easy to mistake for a focal-length error".
 *
 * The z-score assumes independent samples. Neighbouring correspondences come
 * from neighbouring camera pixels and are correlated, so the true null is wider
 * than this one — which is why the verdict thresholds are 3 and 10 rather than
 * the 2 a strict reading would use.
 */
export function analyseResiduals(
  cols: ResidualColumnsJson,
  projector: number,
  resX: number,
  resY: number,
): ResidualStats | null {
  const p = pointsFor(cols, projector);
  const n = p.du.length;
  if (n === 0) return null;

  let mdu = 0;
  let mdv = 0;
  for (let i = 0; i < n; i++) {
    mdu += p.du[i];
    mdv += p.dv[i];
  }
  mdu /= n;
  mdv /= n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const a = p.du[i] - mdu;
    const b = p.dv[i] - mdv;
    sxx += a * a;
    sxy += a * b;
    syy += b * b;
    sumSq += p.du[i] * p.du[i] + p.dv[i] * p.dv[i];
  }
  sxx /= n;
  sxy /= n;
  syy /= n;

  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const sigmaMajor = Math.sqrt(Math.max(tr / 2 + disc, 0));
  const sigmaMinor = Math.sqrt(Math.max(tr / 2 - disc, 1e-30));
  const majorAxisDeg = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;

  const centreU = resX / 2;
  const centreV = resY / 2;
  const maxRadius = Math.hypot(resX / 2, resY / 2);
  const { radius, radial } = radialComponents(p, centreU, centreV);

  let meanRadial = 0;
  for (const v of radial) meanRadial += v;
  meanRadial /= n;
  let totalVar = 0;
  for (const v of radial) totalVar += (v - meanRadial) * (v - meanRadial);
  totalVar /= n;

  const binSum = new Float64Array(RADIAL_BINS);
  const binSumSq = new Float64Array(RADIAL_BINS);
  const binN = new Int32Array(RADIAL_BINS);
  for (let i = 0; i < n; i++) {
    const k = Math.min(
      RADIAL_BINS - 1,
      Math.max(0, Math.floor((radius[i] / maxRadius) * RADIAL_BINS)),
    );
    binSum[k] += radial[i];
    binSumSq[k] += radial[i] * radial[i];
    binN[k]++;
  }
  let betweenVar = 0;
  const bins: ResidualBin[] = [];
  for (let k = 0; k < RADIAL_BINS; k++) {
    if (binN[k] === 0) continue;
    const mk = binSum[k] / binN[k];
    betweenVar += binN[k] * (mk - meanRadial) * (mk - meanRadial);
    bins.push({
      rMid: ((k + 0.5) / RADIAL_BINS) * maxRadius,
      mean: mk,
      sd: Math.sqrt(Math.max(0, binSumSq[k] / binN[k] - mk * mk)),
      count: binN[k],
    });
  }
  betweenVar /= n;
  const radialStructure = totalVar > 0 ? betweenVar / totalVar : 0;
  const dof = Math.max(1, bins.length - 1);
  const expected = dof / n;
  const nullSd = Math.sqrt(2 * dof) / n;
  const z = nullSd > 0 ? (radialStructure - expected) / nullSd : 0;

  // Quadrant bias: the other structure docs/ARCHITECTURE.md G3 names. Each
  // raster quadrant's mean residual, in standard errors of that mean.
  const qx: number[] = [0, 0, 0, 0];
  const qy: number[] = [0, 0, 0, 0];
  const qn: number[] = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const q = (p.u[i] >= centreU ? 1 : 0) + (p.v[i] >= centreV ? 2 : 0);
    qx[q] += p.du[i] - mdu;
    qy[q] += p.dv[i] - mdv;
    qn[q]++;
  }
  const sigmaMean = Math.sqrt((sxx + syy) / 2);
  let quadrantZ = 0;
  for (let q = 0; q < 4; q++) {
    if (qn[q] < 8 || !(sigmaMean > 0)) continue;
    const zq = Math.hypot(qx[q] / qn[q], qy[q] / qn[q]) / (sigmaMean / Math.sqrt(qn[q]));
    if (zq > quadrantZ) quadrantZ = zq;
  }

  // Axis alignment, measured after standardising each raster axis on its own so
  // the anisotropy above cannot masquerade as a cross.
  const sdU = Math.sqrt(sxx);
  const sdV = Math.sqrt(syy);
  let aligned = 0;
  if (sdU > 0 && sdV > 0) {
    for (let i = 0; i < n; i++) {
      const a = (p.du[i] - mdu) / sdU;
      const b = (p.dv[i] - mdv) / sdV;
      if (a === 0 && b === 0) {
        aligned++;
        continue;
      }
      const ang = Math.abs((Math.atan2(b, a) * 180) / Math.PI);
      if (Math.min(ang, Math.abs(ang - 90), Math.abs(ang - 180)) <= 10) aligned++;
    }
  }
  const axisAlignedFraction = n > 0 ? aligned / n : NaN;
  const axisAlignedExpected = 2 / 9;
  const axisAlignedZ =
    n > 0
      ? (axisAlignedFraction - axisAlignedExpected) /
        Math.sqrt((axisAlignedExpected * (1 - axisAlignedExpected)) / n)
      : NaN;

  const verdict: ResidualStats['verdict'] = z >= 10 ? 'structured' : z >= 3 ? 'weak' : 'noise';

  return {
    projector,
    label: `P${projector + 1}`,
    count: n,
    rmsPx: Math.sqrt(sumSq / n),
    biasDuPx: mdu,
    biasDvPx: mdv,
    sigmaMajorPx: sigmaMajor,
    sigmaMinorPx: sigmaMinor,
    anisotropy: sigmaMinor > 0 ? sigmaMajor / sigmaMinor : NaN,
    majorAxisDeg,
    anisotropyExpected: resY > 0 ? resX / resY : NaN,
    radialStructure,
    radialStructureExpected: expected,
    radialStructureZ: z,
    meanRadialPx: meanRadial,
    quadrantZ,
    axisAlignedFraction,
    axisAlignedExpected,
    axisAlignedZ,
    bins,
    centreU,
    centreV,
    maxRadiusPx: maxRadius,
    verdict,
    verdictText:
      verdict === 'structured'
        ? 'radially structured'
        : verdict === 'weak'
          ? 'weak radial structure'
          : 'consistent with noise',
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(v: number | null | undefined, decimals = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6)) return v.toExponential(2);
  return v.toFixed(decimals);
}

function pct(v: number, decimals = 1): string {
  return Number.isFinite(v) ? `${(100 * v).toFixed(decimals)}%` : '—';
}

/** SVG coordinate, trimmed to a tenth of a pixel. Plot files live on this. */
function c(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 10) / 10);
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
}

function tickLabel(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + 1));
  return v.toFixed(decimals);
}

function viridisHex(t: number): string {
  const rgb = viridis(t);
  const to = (x: number): string =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(rgb.r)}${to(rgb.g)}${to(rgb.b)}`;
}

// ---------------------------------------------------------------------------
// Plain-language scaffolding
//
// Everything in this region is ADDITIVE. It explains the page to a reader who
// has never seen the project; it removes, rounds and softens nothing. The dense
// prose beside it is the detail, and these blocks are the way in.
//
// Three rules they obey, and the tests enforce all three:
//
//  - **Always visible.** Never inside a `<details>`. A reader who needs the
//    explanation is exactly the reader who will not think to click for it.
//  - **No spec numbers.** No `§`, no amendment code, no file path. Those belong
//    in the dense text, which keeps every one of them.
//  - **Visually distinct.** A tinted panel with a left rule, so an expert can
//    skip the lot at a glance and go straight to the data.
// ---------------------------------------------------------------------------

export interface HowToRead {
  /** Plain words: what the reader is looking at. One or two sentences. */
  shows: string;
  /** What the reader should see if the thing is working. */
  good?: string;
  /** The failure this is built to reveal, and what it means. */
  bad?: string;
  /** One extra labelled line, where a section needs vocabulary of its own. */
  extra?: { label: string; text: string };
}

/**
 * The "how to read this" block that sits under every section heading.
 *
 * Same shape every time — the reader learns it once. The `good` and `bad` lines
 * are omitted only where the section genuinely has no failure mode to describe;
 * `shows` is never omitted.
 *
 * The text is trusted HTML assembled in this module, exactly like `figure`'s
 * caption: it is written here as a literal, never taken from the results file.
 */
function howToRead(h: HowToRead): string {
  const line = (label: string, text: string): string =>
    `<p class="howto-line"><span class="howto-label">${label}</span><span class="howto-text">${text}</span></p>`;
  const parts = [line('What this shows', h.shows)];
  if (h.good !== undefined) parts.push(line('Good looks like', h.good));
  if (h.bad !== undefined) parts.push(line('Bad looks like', h.bad));
  if (h.extra !== undefined) parts.push(line(h.extra.label, h.extra.text));
  return `<div class="howto">${parts.join('')}</div>`;
}

/**
 * The orientation block: four paragraphs for somebody who has never heard of
 * any of this, before the first number on the page.
 *
 * It carries no statistic and therefore never goes stale against a run. It is
 * the only block on the page that assumes nothing at all.
 */
function orientationBlock(): string {
  return `<div class="orientation" id="orientation">
    <h2 class="plain-h">Start here — what this is, in four paragraphs</h2>
    <p><strong>What the thing is.</strong> A sphere hangs in the middle of a room, and four projectors spaced
      evenly around it throw overlapping pictures onto its surface. Done right, the four pictures join into a
      single seamless image wrapped all the way around the ball. This is NOAA's Science On a Sphere, and there
      are a few hundred of them in museums and science centres. Getting the four projectors to agree is a manual
      job today: a person stands in the room, looks at a test grid on the sphere, nudges a projector, and looks
      again. It takes one to two hours for someone doing it the first time, it is judged entirely by eye, and no
      published document says how close is close enough.</p>
    <p><strong>What this project builds.</strong> Two programs. The <strong>simulator</strong> runs forwards:
      tell it where the four projectors are and it predicts what the sphere will look like. The
      <strong>solver</strong> runs backwards: show it photographs of patterns projected onto the sphere and it
      works out where the projectors must have been to produce those photographs. The pair makes the alignment
      a measurement instead of an opinion — the solver proposes an answer, and the simulator says what that
      answer would look like to somebody standing in the room.</p>
    <p><strong>Why they are written twice.</strong> The two programs share no code, and that is deliberate. If
      the solver worked backwards through the simulator's own arithmetic, then checking one against the other
      would only prove that a function can undo itself, and every score on this page would mean nothing. They are
      kept apart by a rule that fails the build the moment either one so much as imports the other. That is what
      makes agreement between them worth reporting.</p>
    <p><strong>What this page is.</strong> The automated report, rebuilt from the most recent run. Every number
      on it was produced by a fixed sequence started from a recorded random number, so the same input always
      gives the same output and anybody can run it again and get this page back. Nothing here is a screenshot of
      something somebody adjusted by hand, and no number was typed in. Where a measurement could not be made, the
      page says so in place of the number rather than leaving a tidy gap.</p>
    <p class="orientation-foot">Every section below opens with a tinted box like the ones you are about to see:
      what it shows, what good looks like, what bad looks like. Words this page uses without stopping to explain
      them are defined in the <a href="#glossary">glossary</a> at the end.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Plot primitives
// ---------------------------------------------------------------------------

interface PanelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function frameRect(box: PanelBox): string {
  return `<rect class="frame" x="${c(box.x)}" y="${c(box.y)}" width="${c(box.w)}" height="${c(box.h)}"/>`;
}

/**
 * The scatter itself: one `<circle>` per correspondence, nothing subsampled.
 *
 * One element per point rather than one path holding all of them, and the reason
 * is the only one that matters here: a single path composites its own overlaps
 * away, so twenty thousand points and two thousand points would paint the same
 * flat grey. Separate elements at low alpha accumulate, and the density gradient
 * is half of what the reader is looking at.
 *
 * Points outside the axis range are CLAMPED to the frame rather than dropped. An
 * outlier silently removed is the one thing a residual plot must never do; piled
 * on the edge it reads as "there are points past here", which is exactly true.
 */
function scatterPoints(
  xs: readonly number[],
  ys: readonly number[],
  toX: (v: number) => number,
  toY: (v: number) => number,
  box: PanelBox,
  alpha: number,
): string {
  const out: string[] = [`<g class="pts" fill-opacity="${alpha.toFixed(3)}">`];
  const x0 = box.x;
  const x1 = box.x + box.w;
  const y0 = box.y;
  const y1 = box.y + box.h;
  for (let i = 0; i < xs.length; i++) {
    const px = toX(xs[i]);
    const py = toY(ys[i]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    out.push(
      `<circle cx="${c(Math.min(x1, Math.max(x0, px)))}" cy="${c(Math.min(y1, Math.max(y0, py)))}" r="0.9"/>`,
    );
  }
  out.push('</g>');
  return out.join('');
}

// ---------------------------------------------------------------------------
// 1. Solver residual scatter, per projector
// ---------------------------------------------------------------------------

const PAD_L = 46;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 30;
const PLOT_W = 210;
const PLOT_H = 210;

function scatterPanel(p: ProjectorPoints, stats: ResidualStats, lim: number, alpha: number): string {
  const box: PanelBox = { x: PAD_L, y: PAD_T, w: PLOT_W, h: PLOT_H };
  const width = PAD_L + PLOT_W + PAD_R;
  const height = PAD_T + PLOT_H + PAD_B;
  const toX = (v: number): number => box.x + ((v + lim) / (2 * lim)) * box.w;
  const toY = (v: number): number => box.y + box.h - ((v + lim) / (2 * lim)) * box.h;

  const step = niceStep(2 * lim);
  const ticks: string[] = [];
  for (let k = -Math.ceil(lim / step); k <= Math.ceil(lim / step); k++) {
    const v = k * step;
    if (Math.abs(v) > lim) continue;
    ticks.push(
      `<line class="grid" x1="${c(toX(v))}" y1="${c(box.y)}" x2="${c(toX(v))}" y2="${c(box.y + box.h)}"/>`,
      `<line class="grid" x1="${c(box.x)}" y1="${c(toY(v))}" x2="${c(box.x + box.w)}" y2="${c(toY(v))}"/>`,
      `<text class="tick" x="${c(toX(v))}" y="${c(box.y + box.h + 13)}" text-anchor="middle">${tickLabel(v, step)}</text>`,
      `<text class="tick" x="${c(box.x - 5)}" y="${c(toY(v) + 3)}" text-anchor="end">${tickLabel(v, step)}</text>`,
    );
  }

  // One- and two-sigma covariance ellipses, plus a dashed circle of the same
  // area as the one-sigma ellipse. The circle is the isotropic reference: the
  // gap between the two IS the anisotropy statistic, drawn.
  const scale = box.w / (2 * lim);
  const cxp = toX(stats.biasDuPx);
  const cyp = toY(stats.biasDvPx);
  const rEq = Math.sqrt(stats.sigmaMajorPx * stats.sigmaMinorPx) * scale;
  const ellipses: string[] = [];
  for (const k of [1, 2]) {
    ellipses.push(
      `<ellipse class="ellipse" cx="${c(cxp)}" cy="${c(cyp)}" rx="${c(k * stats.sigmaMajorPx * scale)}" ry="${c(k * stats.sigmaMinorPx * scale)}" transform="rotate(${c(-stats.majorAxisDeg)} ${c(cxp)} ${c(cyp)})"/>`,
    );
  }
  ellipses.push(`<circle class="ref-circle" cx="${c(cxp)}" cy="${c(cyp)}" r="${c(rEq)}"/>`);

  return [
    `<svg class="plot" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="residual du against dv for projector ${stats.projector + 1}">`,
    frameRect(box),
    ticks.join(''),
    `<line class="axis" x1="${c(toX(0))}" y1="${c(box.y)}" x2="${c(toX(0))}" y2="${c(box.y + box.h)}"/>`,
    `<line class="axis" x1="${c(box.x)}" y1="${c(toY(0))}" x2="${c(box.x + box.w)}" y2="${c(toY(0))}"/>`,
    scatterPoints(p.du, p.dv, toX, toY, box, alpha),
    ellipses.join(''),
    `<text class="axis-label" x="${c(box.x + box.w / 2)}" y="${c(height - 5)}" text-anchor="middle">du — projector px</text>`,
    `<text class="axis-label" x="11" y="${c(box.y + box.h / 2)}" text-anchor="middle" transform="rotate(-90 11 ${c(box.y + box.h / 2)})">dv — projector px</text>`,
    '</svg>',
  ].join('');
}

/**
 * Residual against image radius, with the binned radial profile drawn over it.
 *
 * The profile line is the picture of the statistic printed beside the panel: a
 * flat line is a residual independent of radius; a line that walks away from
 * zero toward the raster edge is PARAMETERS.md §3.1's `k1, k2` or a focal-length
 * error, which conventions.ts §C warns look alike from here.
 *
 * Radius is measured from the RASTER CENTRE, not from the recovered principal
 * point: the recovered lens shift on this corpus moves it by well under a pixel,
 * and using the recovered value would make the diagnostic depend on the
 * parameter it is being used to diagnose.
 */
function radiusPanel(p: ProjectorPoints, stats: ResidualStats, lim: number, alpha: number): string {
  const box: PanelBox = { x: PAD_L, y: PAD_T, w: PLOT_W, h: PLOT_H };
  const width = PAD_L + PLOT_W + PAD_R;
  const height = PAD_T + PLOT_H + PAD_B;
  const { radius, radial } = radialComponents(p, stats.centreU, stats.centreV);
  const toX = (v: number): number => box.x + (v / stats.maxRadiusPx) * box.w;
  const toY = (v: number): number => box.y + box.h - ((v + lim) / (2 * lim)) * box.h;

  const step = niceStep(2 * lim);
  const ticks: string[] = [];
  for (let k = -Math.ceil(lim / step); k <= Math.ceil(lim / step); k++) {
    const v = k * step;
    if (Math.abs(v) > lim) continue;
    ticks.push(
      `<line class="grid" x1="${c(box.x)}" y1="${c(toY(v))}" x2="${c(box.x + box.w)}" y2="${c(toY(v))}"/>`,
      `<text class="tick" x="${c(box.x - 5)}" y="${c(toY(v) + 3)}" text-anchor="end">${tickLabel(v, step)}</text>`,
    );
  }
  const rStep = niceStep(stats.maxRadiusPx) * 2;
  for (let r = 0; r <= stats.maxRadiusPx + 1e-9; r += rStep) {
    ticks.push(
      `<line class="grid" x1="${c(toX(r))}" y1="${c(box.y)}" x2="${c(toX(r))}" y2="${c(box.y + box.h)}"/>`,
      `<text class="tick" x="${c(toX(r))}" y="${c(box.y + box.h + 13)}" text-anchor="middle">${Math.round(r)}</text>`,
    );
  }

  const profile = stats.bins
    .map((b, i) => `${i === 0 ? 'M' : 'L'}${c(toX(b.rMid))} ${c(toY(b.mean))}`)
    .join(' ');

  return [
    `<svg class="plot" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="radial residual against image radius for projector ${stats.projector + 1}">`,
    frameRect(box),
    ticks.join(''),
    `<line class="axis" x1="${c(box.x)}" y1="${c(toY(0))}" x2="${c(box.x + box.w)}" y2="${c(toY(0))}"/>`,
    scatterPoints(radius, radial, toX, toY, box, alpha),
    // Standard error of each bin's mean, drawn. The outermost bins hold the
    // fewest correspondences — the sphere's limb does not fill the raster
    // corners — and a profile that plunges in a bin of forty points is a
    // different claim from one that plunges in a bin of four hundred.
    stats.bins
      .map((b) => {
        const se = b.count > 0 ? b.sd / Math.sqrt(b.count) : 0;
        return `<line class="profile-err" x1="${c(toX(b.rMid))}" y1="${c(toY(b.mean - se))}" x2="${c(toX(b.rMid))}" y2="${c(toY(b.mean + se))}"/>`;
      })
      .join(''),
    `<path class="profile" d="${profile}"/>`,
    stats.bins
      .map((b) => `<circle class="profile-dot" cx="${c(toX(b.rMid))}" cy="${c(toY(b.mean))}" r="2.2"/>`)
      .join(''),
    `<text class="axis-label" x="${c(box.x + box.w / 2)}" y="${c(height - 5)}" text-anchor="middle">image radius — px from raster centre</text>`,
    `<text class="axis-label" x="11" y="${c(box.y + box.h / 2)}" text-anchor="middle" transform="rotate(-90 11 ${c(box.y + box.h / 2)})">radial residual — px</text>`,
    '</svg>',
  ].join('');
}

function statBlock(stats: ResidualStats, cleanRef: ResidualStats | null): string {
  const anisoNote =
    Number.isFinite(stats.anisotropyExpected) && stats.anisotropyExpected > 0
      ? `${num(stats.anisotropy, 2)} vs ${num(stats.anisotropyExpected, 2)} expected from the decode`
      : num(stats.anisotropy, 2);
  const rows: [string, string, string][] = [
    ['points', String(stats.count), 'every correspondence, none dropped'],
    ['RMS', `${num(stats.rmsPx, 4)} px`, 'the scalar this page exists to look past'],
    [
      'bias',
      `(${num(stats.biasDuPx, 4)}, ${num(stats.biasDvPx, 4)}) px`,
      'a non-zero mean is a systematic offset, not noise',
    ],
    [
      'anisotropy',
      anisoNote,
      `major axis ${num(stats.majorAxisDeg, 0)}° from +u; sigma ${num(stats.sigmaMajorPx, 4)} / ${num(stats.sigmaMinorPx, 4)} px`,
    ],
    [
      'radial structure',
      `${pct(stats.radialStructure, 2)} of radial variance (noise floor ${pct(stats.radialStructureExpected, 2)})`,
      `z = ${num(stats.radialStructureZ, 1)}; mean radial ${num(stats.meanRadialPx, 4)} px`,
    ],
    ['quadrant bias', `z = ${num(stats.quadrantZ, 1)}`, 'worst raster quadrant mean, in standard errors'],
    [
      'axis alignment',
      `${pct(stats.axisAlignedFraction)} within 10° of u or v (isotropic ${pct(stats.axisAlignedExpected)}, z = ${num(stats.axisAlignedZ, 1)})`,
      'the decode quantises u and v separately, so its own residual lies on an axis-aligned cross',
    ],
  ];
  const cleanLine =
    cleanRef === null
      ? ''
      : `<div class="muted small">apparatus reference (s00-clean, residual ${num(cleanRef.rmsPx, 5)} px): anisotropy ${num(cleanRef.anisotropy, 2)}, radial z ${num(cleanRef.radialStructureZ, 1)}</div>`;
  return `<div class="stats">
      <div class="verdict verdict-${stats.verdict}">${esc(stats.verdictText)}</div>
      <table class="kv">${rows
        .map(
          ([k, v, note]) =>
            `<tr><th>${esc(k)}</th><td>${esc(v)}<div class="muted small">${esc(note)}</div></td></tr>`,
        )
        .join('')}</table>
      ${cleanLine}
    </div>`;
}

function residualSection(results: BenchResults): string {
  const blocks: string[] = [];

  // The clean scenario is the apparatus reference: zero injected misalignment,
  // no ambient, no sensor noise, a static camera. Whatever structure survives
  // THERE is the bench's own floor, and every other panel is read against it.
  const cleanScenario = results.scenarios.find((s) => s.archetype === 'clean');
  const cleanCols = cleanScenario === undefined ? null : solverOf(cleanScenario);

  for (const s of results.scenarios) {
    const solver = solverOf(s);
    const inputs = inputsOf(s);
    if (solver === null) {
      blocks.push(
        `<div class="panel"><h3>${esc(s.id)}</h3><p class="gap">No solver output: ${esc(s.error ?? 'the solve produced nothing')}.</p></div>`,
      );
      continue;
    }
    const resX = inputs.projectorRes?.x ?? 1920;
    const resY = inputs.projectorRes?.y ?? 1080;
    const cols = solver.residuals;

    const projectors = [...new Set(cols.projector.slice(0, cols.count))].sort((a, b) => a - b);
    const panels: string[] = [];
    for (const projector of projectors) {
      const stats = analyseResiduals(cols, projector, resX, resY);
      if (stats === null) continue;
      const p = pointsFor(cols, projector);
      const mags = p.du.map((d, i) => Math.hypot(d, p.dv[i])).sort((a, b) => a - b);
      const lim = Math.max(quantile(mags, 0.995) * 1.1, 1e-7);
      const alpha = Math.min(0.6, Math.max(0.05, 900 / Math.max(1, p.du.length)));
      const cleanRef =
        cleanCols === null || s.archetype === 'clean'
          ? null
          : analyseResiduals(cleanCols.residuals, projector, resX, resY);
      panels.push(`<div class="proj">
          <h4>${esc(stats.label)} <span class="muted">— ${stats.count} correspondences, RMS ${num(stats.rmsPx, 4)} px</span></h4>
          <div class="proj-body">
            <div class="plots">${scatterPanel(p, stats, lim, alpha)}${radiusPanel(p, stats, lim, alpha)}</div>
            ${statBlock(stats, cleanRef)}
          </div>
        </div>`);
    }

    blocks.push(`<div class="panel">
        <h3>${esc(s.id)} <span class="muted">— ${esc(s.question)}</span></h3>
        <p class="meta">${cols.count} residuals shown, all of them · solver RMS ${num(solver.rmsResidualPx, 5)} px · ${solver.iterations} iterations · stop reason <code>${esc(solver.stopReason)}</code> · converged ${solver.converged ? 'yes' : 'no'} · ${solver.correspondencesRejected} correspondences rejected by the robust loss · ${inputs.cameras?.count ?? '?'} camera(s)</p>
        ${panels.join('')}
      </div>`);
  }

  return `<section id="residuals">
    <h2>1 · Solver residual scatter, per projector</h2>
    ${howToRead({
      shows:
        'When the solver finishes it has a guess for where every projector is. Take that guess, work out where each measured point <em>should</em> have landed, and subtract where it actually landed. What is left over is called a residual, and every single one of them is drawn here as a dot.',
      good: 'A formless round blob centred on the middle. That means the leftovers are camera noise, and the answer is already as good as the photographs allow.',
      bad: 'Any <em>shape</em> at all — a ring, a fan, a smear off to one side, dots drifting further out towards the edges. Shape means the model is missing something real, and which shape it is tells you what. This difference is invisible in an average and obvious in a picture, which is why this plot comes first.',
      extra: {
        label: 'Two shapes that are fine',
        text:
          'The blob is expected to come out about 1.8 times wider than it is tall, and to grow faint arms along the two directions of the grid. Both are fingerprints of the measuring method rather than faults in the answer, and the dense paragraph below explains why. The numbers printed beside each picture separate the two — a verdict of <em>consistent with noise</em> means nothing beyond those two fingerprints was found.',
      },
    })}
    <p class="lede">Every structured-light correspondence, plotted twice: <strong>du against dv</strong>, and the
      <strong>radial component against image radius</strong>. Nothing is subsampled — where there are twelve thousand
      residuals, twelve thousand circles are drawn at low alpha, so density reads as density. The question is not how
      big the residual is (the RMS beside each panel says that); it is whether the residual has
      <strong>structure</strong>, which means the model is wrong, or is <strong>random</strong>, which means the sensor
      is noisy. docs/ARCHITECTURE.md G3 and G4 name the two structured signatures: radial growth with image radius is
      distortion or focal length, a quadrant pattern is the bundle.</p>
    <p class="lede muted">Two apparatus signatures have to be subtracted by eye before anything is blamed on the
      model, and both are visible on <code>s00-clean</code>, whose residual is 9×10<sup>-5</sup> px — a rig with
      nothing wrong with it. <strong>The stretch:</strong> the dashed circle on each scatter has the same area as the
      solid one-sigma ellipse, so the gap between them is the anisotropy, and a ratio near the raster aspect (1.78) is
      the decode — <code>patterns.ts</code> picks one Gray-plane count and uses it on both axes, so the <code>u</code>
      stride is 1920/2<sup>b</sup> against 1080/2<sup>b</sup> for <code>v</code>. <strong>The cross:</strong> the
      decode quantises the two axes independently, so its own residual falls on an axis-aligned lattice and the cloud
      grows arms along <code>u</code> and <code>v</code>; the axis-alignment statistic measures that after
      standardising each axis, so it cannot be confused with the stretch. Neither is a defect. Radial structure and
      quadrant bias are.</p>
    ${blocks.join('')}
  </section>`;
}

// ---------------------------------------------------------------------------
// 2. Equirectangular error map
// ---------------------------------------------------------------------------

const MAP_W = 360;
const MAP_H = 180;

function errorMapPanel(s: ScenarioJson, image: string | null): string {
  const inputs = inputsOf(s);
  const meridians = projectorMeridiansDeg(inputs);
  // A seam is one direction, not two: halfway between two ADJACENT projectors.
  // Drawing 45 degrees either side of every meridian would put two lines a
  // degree apart wherever the two mounts are not exactly 90 degrees off, which
  // is every real rig and every perturbed one here.
  const sorted = [...meridians].sort((a, b) => a - b);
  const seams: number[] = sorted.map((lon, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360;
    let mid = (lon + next) / 2;
    while (mid > 180) mid -= 360;
    while (mid <= -180) mid += 360;
    return mid;
  });
  const colatitude = inputs.maskInterpretation === 'colatitude';
  const maskOnset = colatitude ? 20 : 60;
  const maskFull = colatitude ? 30 : 70;

  const padL = 40;
  const padR = 14;
  const padT = 16;
  const padB = 30;
  const toX = (lon: number): number => padL + lon + 180;
  const toY = (lat: number): number => padT + 90 - lat;
  const width = padL + MAP_W + padR;
  const height = padT + MAP_H + padB;

  const gridLines: string[] = [];
  for (let lon = -180; lon <= 180; lon += 30) {
    gridLines.push(
      `<line class="maphair" x1="${c(toX(lon))}" y1="${c(padT)}" x2="${c(toX(lon))}" y2="${c(padT + MAP_H)}"/>`,
      `<text class="tick" x="${c(toX(lon))}" y="${c(padT + MAP_H + 13)}" text-anchor="middle">${lon}</text>`,
    );
  }
  for (let lat = -90; lat <= 90; lat += 30) {
    gridLines.push(
      `<line class="maphair" x1="${c(padL)}" y1="${c(toY(lat))}" x2="${c(padL + MAP_W)}" y2="${c(toY(lat))}"/>`,
      `<text class="tick" x="${c(padL - 5)}" y="${c(toY(lat) + 3)}" text-anchor="end">${lat}</text>`,
    );
  }

  const marks: string[] = [];
  meridians.forEach((lon, i) => {
    marks.push(
      `<line class="meridian" x1="${c(toX(lon))}" y1="${c(padT)}" x2="${c(toX(lon))}" y2="${c(padT + MAP_H)}"/>`,
      `<text class="map-label meridian-label" x="${c(toX(lon) + 3)}" y="${c(padT + 10)}">P${(inputs.slots?.[i] ?? i) + 1}</text>`,
    );
  });
  for (const lon of seams) {
    marks.push(
      `<line class="seam" x1="${c(toX(lon))}" y1="${c(padT)}" x2="${c(toX(lon))}" y2="${c(padT + MAP_H)}"/>`,
    );
  }
  marks.push(
    `<line class="mask" x1="${c(padL)}" y1="${c(toY(-maskOnset))}" x2="${c(padL + MAP_W)}" y2="${c(toY(-maskOnset))}"/>`,
    `<line class="mask" x1="${c(padL)}" y1="${c(toY(-maskFull))}" x2="${c(padL + MAP_W)}" y2="${c(toY(-maskFull))}"/>`,
    `<text class="map-label mask-label" x="${c(padL + 4)}" y="${c(toY(-maskOnset) - 3)}">mask onset ${maskOnset}°S</text>`,
    `<text class="map-label mask-label" x="${c(padL + 4)}" y="${c(toY(-maskFull) + 10)}">full mask ${maskFull}°S</text>`,
  );

  const img =
    image === null
      ? `<rect class="gap-rect" x="${c(padL)}" y="${c(padT)}" width="${MAP_W}" height="${MAP_H}"/><text class="tick" x="${c(padL + MAP_W / 2)}" y="${c(padT + MAP_H / 2)}" text-anchor="middle">registration map PNG not found</text>`
      : `<image x="${c(padL)}" y="${c(padT)}" width="${MAP_W}" height="${MAP_H}" href="${image}" preserveAspectRatio="none" image-rendering="pixelated"/>`;

  const reg = s.metrics.find((m) => m.id === 'registration_error');
  const grid = s.metrics.find((m) => m.id === 'grid_displacement');

  return `<div class="panel">
      <h3>${esc(s.id)}</h3>
      <div class="map-row">
        <svg class="plot" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="equirectangular registration error map for ${esc(s.id)}">
          ${img}
          ${gridLines.join('')}
          ${marks.join('')}
          <rect class="frame" x="${c(padL)}" y="${c(padT)}" width="${MAP_W}" height="${MAP_H}"/>
          <text class="axis-label" x="${c(padL + MAP_W / 2)}" y="${c(height - 4)}" text-anchor="middle">longitude (°)</text>
          <text class="axis-label" x="10" y="${c(padT + MAP_H / 2)}" text-anchor="middle" transform="rotate(-90 10 ${c(padT + MAP_H / 2)})">latitude (°)</text>
        </svg>
        <div class="stats">
          <table class="kv">
            <tr><th>registration RMS</th><td>${num(reg?.value, 3)} mm<div class="muted small">over every point at least two projectors reach, area-weighted</div></td></tr>
            <tr><th>registration p95 / max</th><td>${num(reg?.detail?.p95Mm, 3)} / ${num(reg?.detail?.maxMm, 3)} mm</td></tr>
            <tr><th>grid displacement</th><td>${num(grid?.value, 3)} mm against a ${num(grid?.gateMax, 1)} mm gate — ${grid?.pass ? 'pass' : 'FAIL'}</td></tr>
            <tr><th>overlap area</th><td>${pct(reg?.detail?.overlapAreaFraction ?? NaN)} of the sphere</td></tr>
          </table>
          <div class="muted small">Colour is registration error, 0–10 mm, viridis. Flat grey is
            <em>fewer than two projectors reach here</em>, which is not the same as zero error and is drawn
            differently on purpose. Solid verticals are projector meridians, dotted are the seam directions
            halfway between them, and the two horizontals are the polar mask onset and full-mask latitudes.</div>
        </div>
      </div>
    </div>`;
}

function colorbar(): string {
  const stops: string[] = [];
  for (let i = 0; i <= 10; i++) {
    stops.push(`<stop offset="${i * 10}%" stop-color="${viridisHex(i / 10)}"/>`);
  }
  return `<svg class="plot colorbar" viewBox="0 0 300 42" width="300" height="42" role="img" aria-label="registration error colour scale">
      <defs><linearGradient id="vir" x1="0" x2="1" y1="0" y2="0">${stops.join('')}</linearGradient></defs>
      <rect x="0" y="6" width="230" height="14" fill="url(#vir)"/>
      <rect class="gap-rect" x="240" y="6" width="18" height="14"/>
      <text class="tick" x="0" y="32">0 mm</text>
      <text class="tick" x="230" y="32" text-anchor="end">10 mm</text>
      <text class="tick" x="264" y="17">&lt;2 projectors</text>
    </svg>`;
}

function errorMapSection(results: BenchResults, images: ImageStore): string {
  return `<section id="error-map">
    <h2>2 · Equirectangular registration error map</h2>
    ${howToRead({
      shows:
        "The sphere unrolled flat, like a world map. Colour is how far the projected picture lands from where it was supposed to land, in millimetres measured across the sphere's own surface.",
      good: 'Even and dark everywhere: the error is small, and it is the same wherever you look.',
      bad: 'Bright patches — and <em>where</em> they sit is the diagnosis. Bright along the joins between projectors means the projectors disagree with each other. Bright at the top and bottom means the geometry itself has run out there, where the light arrives almost sideways and a single pixel smears into a streak.',
    })}
    <p class="lede">Where the error is, not how much of it there is. A single RMS cannot distinguish a uniform blur —
      which reads as softness — from a hard displacement concentrated in one seam near a pole, which reads as the
      doubled grid lines PARAMETERS.md §1's note describes, and those two want different remedies. The projector
      meridians, the seam directions and the mask boundary are drawn on top so a reader can tell instantly whether
      error concentrates at seams, at the poles, or at grazing incidence.</p>
    ${colorbar()}
    ${results.scenarios.map((s) => errorMapPanel(s, images.get(artifact(s, 'registration')))).join('')}
  </section>`;
}

// ---------------------------------------------------------------------------
// 3. Grid alignment pattern through the full pipeline
// ---------------------------------------------------------------------------

/**
 * A render with its caption, or an explicit gap where the PNG should be.
 *
 * `caption` is trusted HTML assembled by this module; `missing` is the text a
 * reader sees when the file the results file named is not on disk. A missing
 * render is drawn as a hole rather than skipped, because a page that quietly
 * omits an image looks identical to a page whose render was never produced.
 */
function figure(src: string | null, caption: string, missing: string): string {
  const body =
    src === null
      ? `<div class="img-missing">${esc(missing)}</div>`
      : `<img src="${src}" alt="rendered view" loading="lazy"/>`;
  return `<figure>${body}<figcaption>${caption}</figcaption></figure>`;
}

function gridViewSection(results: BenchResults, images: ImageStore): string {
  const cards = results.scenarios.map((s) => {
    const grid = s.metrics.find((m) => m.id === 'grid_displacement');
    const baseline = s.baseline?.metrics.find((m) => m.id === 'grid_displacement');
    return `<div class="card">
        <h3>${esc(s.id)}</h3>
        ${figure(images.get(artifact(s, 'roomAfter')), `Recovered calibration driving the content, physical rig as built. Grid displacement <strong>${num(grid?.value, 3)} mm</strong> against a ${num(grid?.gateMax, 1)} mm gate.`, 'room render not found')}
        <div class="muted small">Documented calibration before solving read ${num(baseline?.value, 3)} mm on the same rig and the same camera.
          A viewer at the guard rail, 2.5 m out, 1.6 m eye height, framed on a <em>seam</em> at 45° — the most
          revealing place to stand and the one an operator judges.</div>
      </div>`;
  });
  return `<section id="grid-view">
    <h2>3 · Grid alignment pattern through the full pipeline</h2>
    ${howToRead({
      shows:
        'The same test grid a real operator looks at while aligning a real sphere, put through the whole chain here: content made from the calibration the solver recovered, thrown by the projectors as they physically sit, landing on the sphere, photographed from where a visitor stands.',
      good: 'Lines that meet across every join. A grid line crossing from one projector into the next stays one continuous line.',
      bad: 'Lines that kink, double, or drift apart where two projectors meet. That is exactly what an operator sees standing in the room, which makes this the one picture on the page directly comparable with the real procedure.',
    })}
    <p class="lede">The same 15° graticule an operator sees during SOS Grid Alignment, rendered through the whole
      forward model: content generated against the <em>recovered</em> calibration, projected by the rig that
      physically exists, shaded, and photographed by a viewer camera. Where the two calibrations disagree each
      projector paints the line from where it believes it is pointing, which is what produces a doubled or kinked
      line at a seam. A single calibration rendered against itself cannot show this at all.</p>
    <div class="grid-cards">${cards.join('')}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// 4. Before / after
// ---------------------------------------------------------------------------

export interface PreviousRound {
  label: string;
  results: BenchResults;
  images: ImageStore;
}

function beforeAfterSection(
  results: BenchResults,
  images: ImageStore,
  previous: PreviousRound | null,
): string {
  let matched = 0;
  const rows = results.scenarios.map((s) => {
    const grid = s.metrics.find((m) => m.id === 'grid_displacement');
    const baseline = s.baseline?.metrics.find((m) => m.id === 'grid_displacement');
    const prevScenario = previous?.results.scenarios.find((p) => p.id === s.id && p.seed === s.seed);
    if (prevScenario !== undefined) matched++;
    const prevGrid = prevScenario?.metrics.find((m) => m.id === 'grid_displacement');

    const left =
      prevScenario === undefined
        ? figure(
            images.get(artifact(s, 'roomBefore')),
            `<strong>Before</strong> — documented calibration, ${num(baseline?.value, 3)} mm`,
            'room render not found',
          )
        : figure(
            previous!.images.get(artifact(prevScenario, 'roomAfter')),
            `<strong>Previous best</strong> (${esc(previous!.label)}) — ${num(prevGrid?.value, 3)} mm`,
            'previous render not found',
          );
    const right = figure(
      images.get(artifact(s, 'roomAfter')),
      `<strong>After</strong> — recovered calibration, ${num(grid?.value, 3)} mm`,
      'room render not found',
    );
    return `<div class="card"><h3>${esc(s.id)} <span class="muted">seed ${s.seed}</span></h3><div class="pair">${left}${right}</div></div>`;
  });

  const provenance =
    previous === null
      ? `<p class="note">No previous best round is on disk yet, so the pair shown is the one this round can make
         honestly: the <strong>documented calibration</strong> (what a site ships with, before any solve) against the
         <strong>recovered calibration</strong>, on the same rig, the same seed and the same camera. Once
         <code>loop.ts</code> has recorded a best round it copies that round's renders to
         <code>progress/data/best/</code>, and this section becomes previous-best against current with the seeds
         matched scenario by scenario.</p>`
      : `<p class="note">Left is the previous best round (${esc(previous.label)}), right is this round, matched on
         scenario id <em>and</em> seed — ${matched} of ${results.scenarios.length} scenario(s) matched. A scenario
         that did not match shows this round's documented-calibration render instead, because a pair drawn from two
         different seeds is a pair of two different rigs and comparing them says nothing about the build.
         <br/><br/>Seeds are <em>meant</em> to differ between rounds: docs/ARCHITECTURE.md regenerates the corpus every
         round so a builder cannot overfit to it. The consequence is that "previous best versus current, same seed,
         same camera" is only obtainable by <strong>replaying</strong> the best round against the current code —
         <code>node packages/bench/src/loop.ts --replay N</code> with N the best round's number, or
         <code>--seed ${previous.results.run.seed}</code> — which is precisely the comparison this section is for. On an ordinary round
         the pair below falls back to documented-versus-recovered, which is the honest same-seed pair available.</p>`;

  return `<section id="before-after">
    <h2>4 · Before and after, same seed, same camera</h2>
    ${howToRead({
      shows:
        'The same scene rendered twice: once with the best calibration the project had before, once with the one it has now. Same random draw of the rig, same camera, same everything except the calibration under test.',
      good: 'The right-hand picture visibly tidier at the joins than the left-hand one.',
      bad: 'No visible difference, or a right-hand picture that is worse. Because everything except the thing being tested is held identical, any difference you can see is the change itself and not the luck of the draw.',
    })}
    ${provenance}
    <div class="grid-cards">${rows.join('')}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// 5. Metric sparklines over rounds
// ---------------------------------------------------------------------------

function sparkline(
  label: string,
  unit: string,
  medians: number[],
  p95: number[],
  gateMax: number | null,
): string {
  const w = 260;
  const h = 74;
  const padL = 6;
  const padR = 6;
  const padT = 8;
  const padB = 14;
  const values = [...medians, ...p95, ...(gateMax === null ? [] : [gateMax])].filter((v) =>
    Number.isFinite(v),
  );
  if (values.length === 0) {
    return `<div class="spark"><h4>${esc(label)}</h4><div class="muted small">no finite values yet</div></div>`;
  }
  // The axis starts at zero for a magnitude, and below it when a series can go
  // negative — the off-sphere excess is a difference against an analytic floor
  // and a rig can beat it, so clamping at zero would draw that point on the
  // frame and hide the sign.
  const lo = Math.min(0, ...values) * 1.15;
  const hi = Math.max(...values) * 1.15 || 1;
  const n = Math.max(1, medians.length);
  const toX = (i: number): number =>
    padL + (n === 1 ? (w - padL - padR) / 2 : (i / (n - 1)) * (w - padL - padR));
  const toY = (v: number): number =>
    padT + (1 - (v - lo) / (hi - lo || 1)) * (h - padT - padB);
  const zeroLine =
    lo < 0
      ? `<line class="axis" x1="${c(padL)}" y1="${c(toY(0))}" x2="${c(w - padR)}" y2="${c(toY(0))}"/>`
      : '';

  const line = (series: number[], cls: string): string => {
    const pts = series
      .map((v, i) => (Number.isFinite(v) ? `${c(toX(i))},${c(toY(v))}` : null))
      .filter((x): x is string => x !== null);
    if (pts.length === 0) return '';
    if (pts.length === 1) {
      const [x, y] = pts[0].split(',');
      return `<circle class="${cls}-dot" cx="${x}" cy="${y}" r="2.6"/>`;
    }
    return `<polyline class="${cls}" points="${pts.join(' ')}"/>`;
  };

  const gateLine =
    gateMax === null || !Number.isFinite(gateMax) || gateMax > hi
      ? ''
      : `<line class="gate-line" x1="${c(padL)}" y1="${c(toY(gateMax))}" x2="${c(w - padR)}" y2="${c(toY(gateMax))}"/><text class="tick" x="${c(w - padR)}" y="${c(toY(gateMax) - 3)}" text-anchor="end">gate ${num(gateMax, 3)}</text>`;

  const last = medians[medians.length - 1];
  const prev = medians.length > 1 ? medians[medians.length - 2] : NaN;
  const delta = Number.isFinite(prev) ? last - prev : NaN;
  return `<div class="spark">
      <h4>${esc(label)} <span class="muted">${esc(unit)}</span></h4>
      <svg class="plot" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)} over rounds">
        ${zeroLine}
        ${gateLine}
        ${line(p95, 'spark-p95')}
        ${line(medians, 'spark-median')}
      </svg>
      <div class="small">median <strong>${num(last, 4)}</strong>${
        Number.isFinite(delta)
          ? ` <span class="${delta < 0 ? 'good' : delta > 0 ? 'bad' : 'muted'}">${delta < 0 ? '▼' : '▲'} ${num(Math.abs(delta), 4)} vs previous round</span>`
          : ' <span class="muted">first round</span>'
      }<br/><span class="muted">solid = median across scenarios, faint = p95</span></div>
    </div>`;
}

/** Both branches of `trendSection` carry the same explanation, so it lives once. */
const TREND_HOWTO = howToRead({
  shows:
    'Whether the numbers are moving. Each small chart is one measurement, plotted across the rounds of work the project has done, against the line it has to get under.',
  good: 'Lines heading downwards and settling below the threshold line, with the faint line — the bad cases — coming down alongside the solid one.',
  bad: "Flat lines, or lines heading upwards. And one to watch for: a round that improves the typical case while making the worst case worse counts as a regression here, not progress. The worst case is what a person standing in the room actually sees.",
});

function trendSection(results: BenchResults, rounds: RoundHistory | null): string {
  // The gate id comes from TRACKED itself. It used to be a second copy of the
  // key -> gate mapping living here, which is one more place to forget when the
  // ranking vector changes.
  const gateFor = (key: string): number | null => {
    const id = TRACKED.find((t) => t.key === key)?.gateId;
    const gate = results.gates.gates.find((g) => g.id === id);
    return gate === undefined ? null : gate.max;
  };

  if (rounds === null || rounds.rounds.length === 0) {
    const sparks = TRACKED.map((t) => {
      const d = results.aggregate[t.key];
      return sparkline(t.label, t.unit, [d?.median ?? NaN], [d?.p95 ?? NaN], gateFor(t.key));
    });
    return `<section id="trend">
      <h2>5 · Metric trend over rounds</h2>
      ${TREND_HOWTO}
      <p class="note">No round history at <code>progress/rounds.json</code> yet, so each sparkline holds a single
        point: this results file. <code>node packages/bench/src/loop.ts</code> runs a Phase 1 round, appends to the
        history with a fresh chained seed, and these become trends. A trend is what the loop is judged on —
        docs/ARCHITECTURE.md's stopping condition compares a round's median against its own scatter across seeds,
        and neither number means anything from one round alone.</p>
      <div class="spark-row">${sparks.join('')}</div>
    </section>`;
  }

  const ordered = [...rounds.rounds].sort((a, b) => a.round - b.round);
  const sparks = TRACKED.map((t) =>
    sparkline(
      t.label,
      t.unit,
      ordered.map((r) => r.series[t.key]?.median ?? NaN),
      ordered.map((r) => r.series[t.key]?.p95 ?? NaN),
      gateFor(t.key),
    ),
  );

  const last = ordered[ordered.length - 1];
  const table = ordered
    .slice(-12)
    .map(
      (r) =>
        `<tr><td>${r.round}</td><td>${r.seed}</td><td><code>${esc(r.gitCommit.slice(0, 8))}</code></td><td>${r.pass ? '<span class="good">pass</span>' : '<span class="bad">fail</span>'}</td><td>${num(r.series.gridDisplacementMm?.median, 4)}</td><td>${TRACKED.map((t) => `${t.label}: ${movementLabel(r, t.key)}`).join(', ')}</td></tr>`,
    )
    .join('');

  return `<section id="trend">
    <h2>5 · Metric trend over rounds</h2>
    ${TREND_HOWTO}
    <p class="lede">Trend, not just the current value. A metric that moved by less than the round's own scatter across
      seeds did not move: docs/ARCHITECTURE.md defines a non-improving round that way, and three consecutive
      non-improving rounds end Phase 1. This history is at round ${last.round}, ${last.consecutiveNonImproving}
      consecutive non-improving.</p>
    <div class="spark-row">${sparks.join('')}</div>
    <table class="data">
      <thead><tr><th>round</th><th>seed</th><th>commit</th><th>gates</th><th>grid median (mm)</th><th>movement</th></tr></thead>
      <tbody>${table}</tbody>
    </table>
  </section>`;
}

// ---------------------------------------------------------------------------
// 6. The static reference
// ---------------------------------------------------------------------------

/**
 * Run-length rows of a piecewise-constant field, as SVG rects.
 *
 * The multiplicity map takes three values and the incidence map is quantised to
 * bands, so a run-length pass turns 64 800 cells into a few thousand rectangles
 * and the map stays a plot generated from the data rather than a picture
 * somebody rendered elsewhere and pasted in.
 */
function bandedField(
  data: readonly number[],
  width: number,
  height: number,
  bandOf: (v: number) => number,
  fillOf: (band: number) => string,
  ox: number,
  oy: number,
  scaleX: number,
  scaleY: number,
): string {
  const out: string[] = [];
  for (let y = 0; y < height; y++) {
    let runStart = 0;
    let runBand = bandOf(data[y * width]);
    for (let x = 1; x <= width; x++) {
      const band = x < width ? bandOf(data[y * width + x]) : NaN;
      if (x === width || band !== runBand) {
        out.push(
          `<rect x="${c(ox + runStart * scaleX)}" y="${c(oy + y * scaleY)}" width="${c((x - runStart) * scaleX)}" height="${c(scaleY + 0.02)}" fill="${fillOf(runBand)}"/>`,
        );
        runStart = x;
        runBand = band;
      }
    }
  }
  return out.join('');
}

function referenceMaps(ref: CoverageReference): { multiplicity: string; incidence: string } {
  const { width, height } = ref.grid;
  const padL = 40;
  const padR = 12;
  const padT = 16;
  const padB = 30;
  const w = 360;
  const h = 180;
  const sx = w / width;
  const sy = h / height;
  const toX = (lon: number): number => padL + ((lon + 180) / 360) * w;
  const toY = (lat: number): number => padT + ((90 - lat) / 180) * h;

  const axes = (): string => {
    const parts: string[] = [];
    for (let lon = -180; lon <= 180; lon += 45) {
      parts.push(
        `<line class="maphair" x1="${c(toX(lon))}" y1="${c(padT)}" x2="${c(toX(lon))}" y2="${c(padT + h)}"/>`,
        `<text class="tick" x="${c(toX(lon))}" y="${c(padT + h + 13)}" text-anchor="middle">${lon}</text>`,
      );
    }
    for (let lat = -90; lat <= 90; lat += 30) {
      parts.push(
        `<line class="maphair" x1="${c(padL)}" y1="${c(toY(lat))}" x2="${c(padL + w)}" y2="${c(toY(lat))}"/>`,
        `<text class="tick" x="${c(padL - 5)}" y="${c(toY(lat) + 3)}" text-anchor="end">${lat}</text>`,
      );
    }
    for (const az of ref.rig.azimuthsDeg) {
      parts.push(
        `<line class="meridian" x1="${c(toX(az))}" y1="${c(padT)}" x2="${c(toX(az))}" y2="${c(padT + h)}"/>`,
      );
    }
    return parts.join('');
  };

  const multiplicityColours = ['var(--unlit)', 'var(--mult1)', 'var(--mult2)', '#ff0000', '#ff00ff'];
  const multMap = `<svg class="plot" viewBox="0 0 ${padL + w + padR} ${padT + h + padB}" width="${padL + w + padR}" height="${padT + h + padB}" role="img" aria-label="overlap multiplicity over the sphere">
      ${bandedField(ref.multiplicity, width, height, (v) => v, (b) => multiplicityColours[b] ?? '#ff0000', padL, padT, sx, sy)}
      ${axes()}
      <rect class="frame" x="${c(padL)}" y="${c(padT)}" width="${w}" height="${h}"/>
      <text class="axis-label" x="${c(padL + w / 2)}" y="${c(padT + h + padB - 3)}" text-anchor="middle">longitude (°)</text>
    </svg>`;

  const bands = 12;
  const incMap = `<svg class="plot" viewBox="0 0 ${padL + w + padR} ${padT + h + padB}" width="${padL + w + padR}" height="${padT + h + padB}" role="img" aria-label="best cosine of incidence over the sphere">
      ${bandedField(
        ref.incidenceCos,
        width,
        height,
        (v) => (v < 0 ? -1 : Math.min(bands - 1, Math.floor(v * bands))),
        (b) => (b < 0 ? 'var(--unlit)' : viridisHex((b + 0.5) / bands)),
        padL,
        padT,
        sx,
        sy,
      )}
      ${axes()}
      <line class="mask" x1="${c(padL)}" y1="${c(toY(-ref.rig.maskLoDeg))}" x2="${c(padL + w)}" y2="${c(toY(-ref.rig.maskLoDeg))}"/>
      <line class="mask" x1="${c(padL)}" y1="${c(toY(-ref.rig.maskHiDeg))}" x2="${c(padL + w)}" y2="${c(toY(-ref.rig.maskHiDeg))}"/>
      <rect class="frame" x="${c(padL)}" y="${c(padT)}" width="${w}" height="${h}"/>
      <text class="axis-label" x="${c(padL + w / 2)}" y="${c(padT + h + padB - 3)}" text-anchor="middle">longitude (°)</text>
    </svg>`;

  return { multiplicity: multMap, incidence: incMap };
}

/**
 * The unlit polar region, drawn as a polar plot of its own boundary.
 *
 * This is the single most direct picture of PARAMETERS.md §4.3's claim: the
 * boundary latitude as a function of longitude, plotted around the pole against
 * the two circles that bound it. Four dips means four lobes; a curve that lies
 * on either circle means a circular cap and a bug.
 */
function referencePolar(ref: CoverageReference, checks: ReferenceChecks): string {
  const size = 300;
  const cxy = size / 2;
  const latMin = 70;
  const rOf = (lat: number): number => ((90 - lat) / (90 - latMin)) * (cxy - 26);
  const point = (lonDeg: number, lat: number): [number, number] => {
    const a = (lonDeg * Math.PI) / 180;
    const r = rOf(lat);
    return [cxy + r * Math.cos(a), cxy - r * Math.sin(a)];
  };

  const path = ref.boundary.lonDeg
    .map((lon, i) => {
      const [x, y] = point(lon, ref.boundary.northLatDeg[i]);
      return `${i === 0 ? 'M' : 'L'}${c(x)} ${c(y)}`;
    })
    .join(' ');

  const rings: string[] = [];
  for (let lat = 75; lat <= 90; lat += 5) {
    rings.push(
      `<circle class="maphair" cx="${cxy}" cy="${cxy}" r="${c(rOf(lat))}" fill="none"/>`,
      `<text class="tick" x="${c(cxy + 3)}" y="${c(cxy - rOf(lat) + 10)}">${lat}°</text>`,
    );
  }
  const spokes: string[] = [];
  for (const az of ref.rig.azimuthsDeg) {
    const [x, y] = point(az, latMin);
    spokes.push(`<line class="meridian" x1="${cxy}" y1="${cxy}" x2="${c(x)}" y2="${c(y)}"/>`);
  }
  for (const lon of checks.lobeLongitudesDeg) {
    const [x, y] = point(lon, latMin);
    spokes.push(`<line class="seam" x1="${cxy}" y1="${cxy}" x2="${c(x)}" y2="${c(y)}"/>`);
  }

  // The REGION is filled, not just outlined. A curve alone invites the reader to
  // check whether it is round; a filled shape shows what is actually being
  // claimed — a permanently dark patch around each pole with four corners
  // reaching down the seam directions.
  return `<svg class="plot" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="polar view of the unlit region boundary">
      ${rings.join('')}
      ${spokes.join('')}
      <path class="unlit-region" d="${path} Z"/>
      <circle class="bound-cap" cx="${cxy}" cy="${cxy}" r="${c(rOf(ref.analytic.meridianLimitDeg))}" fill="none"/>
      <circle class="bound-cap" cx="${cxy}" cy="${cxy}" r="${c(rOf(ref.analytic.seamLimitDeg))}" fill="none"/>
      <path class="boundary" d="${path} Z"/>
      <text class="tick" x="4" y="14">north pole at centre, ${latMin}°N at the rim (azimuthal equidistant)</text>
    </svg>`;
}

function referenceProfile(ref: CoverageReference): string {
  const w = 360;
  const h = 130;
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 30;
  const lats = ref.boundary.northLatDeg;
  const lo = Math.min(...lats) - 0.8;
  const hi = Math.max(...lats) + 0.8;
  const toX = (lon: number): number => padL + ((lon + 180) / 360) * w;
  const toY = (lat: number): number => padT + (1 - (lat - lo) / (hi - lo)) * h;
  const d = ref.boundary.lonDeg
    .map((lon, i) => `${i === 0 ? 'M' : 'L'}${c(toX(lon))} ${c(toY(lats[i]))}`)
    .join(' ');
  const marks = [
    { lat: ref.analytic.meridianLimitDeg, label: `meridian limit ${ref.analytic.meridianLimitDeg.toFixed(2)}°` },
    { lat: ref.analytic.seamLimitDeg, label: `seam limit ${ref.analytic.seamLimitDeg.toFixed(2)}°` },
  ]
    .map(
      (m) =>
        `<line class="gate-line" x1="${c(padL)}" y1="${c(toY(m.lat))}" x2="${c(padL + w)}" y2="${c(toY(m.lat))}"/><text class="tick" x="${c(padL + w)}" y="${c(toY(m.lat) - 3)}" text-anchor="end">${esc(m.label)}</text>`,
    )
    .join('');
  const ticks: string[] = [];
  for (let lon = -180; lon <= 180; lon += 45) {
    ticks.push(
      `<line class="maphair" x1="${c(toX(lon))}" y1="${c(padT)}" x2="${c(toX(lon))}" y2="${c(padT + h)}"/>`,
      `<text class="tick" x="${c(toX(lon))}" y="${c(padT + h + 13)}" text-anchor="middle">${lon}</text>`,
    );
  }
  return `<svg class="plot" viewBox="0 0 ${padL + w + padR} ${padT + h + padB}" width="${padL + w + padR}" height="${padT + h + padB}" role="img" aria-label="coverage boundary latitude against longitude">
      <rect class="frame" x="${c(padL)}" y="${c(padT)}" width="${w}" height="${h}"/>
      ${ticks.join('')}
      ${marks}
      <path class="boundary" d="${d}"/>
      <text class="axis-label" x="${c(padL + w / 2)}" y="${c(padT + h + padB - 3)}" text-anchor="middle">longitude (°)</text>
      <text class="axis-label" x="10" y="${c(padT + h / 2)}" text-anchor="middle" transform="rotate(-90 10 ${c(padT + h / 2)})">boundary latitude (°)</text>
    </svg>`;
}

/** Both branches of `referenceSection` carry the same explanation, so it lives once. */
const REFERENCE_HOWTO = howToRead({
  shows:
    'A test disguised as a picture. Two things about this rig are fixed by physics however well or badly it is aligned: every point on the sphere is lit by at most two projectors, never three and never four; and the patch at each pole that no projector can reach is a four-lobed scalloped shape, not a circle.',
  good: 'At most two-way overlap anywhere on the map, and a polar patch with four corners reaching down between the projectors — closer to a square than a circle.',
  bad: 'Any three-way or four-way overlap, or a round polar cap. Either one is a bug in the simulator rather than a badly aligned rig. These pictures are drawn once and deliberately never regenerated by a run, so they cannot be quietly refreshed into agreeing with a broken build.',
});

function referenceSection(ref: CoverageReference | null, checks: ReferenceChecks | null): string {
  if (ref === null || checks === null) {
    return `<section id="reference">
      <h2>6 · Static reference — coverage and incidence <span class="tag">rendered once</span></h2>
      ${REFERENCE_HOWTO}
      <p class="note">No reference on disk. Run <code>node packages/bench/src/reference.ts</code> once to compute it.
        It is deliberately NOT regenerated by a bench round: it is a correctness check dressed as a visual, and a
        check that refreshes itself against the current build can only ever agree with it.</p>
    </section>`;
  }

  const maps = referenceMaps(ref);
  const checkRows = checks.checks
    .map(
      (ch) => `<tr class="${ch.pass ? 'row-pass' : 'row-fail'}">
        <td>${ch.pass ? '<span class="good">PASS</span>' : '<span class="bad">FAIL</span>'}</td>
        <td><strong>${esc(ch.claim)}</strong><div class="muted small">${esc(ch.observed)}</div></td>
        <td class="small">${esc(ch.failureMeans)}</td>
      </tr>`,
    )
    .join('');

  return `<section id="reference">
    <h2>6 · Static reference — coverage and incidence <span class="tag">rendered once, ${esc(ref.generatedAt.slice(0, 10))}, commit <code>${esc(ref.gitCommit.slice(0, 8))}</code></span></h2>
    ${REFERENCE_HOWTO}
    <div class="callout">
      <h3>What you should see, and what would be a bug</h3>
      <p><strong>Overlap multiplicity of at most 2, everywhere.</strong> Exactly three colours in the multiplicity
        map — unlit, one-way on each projector's own meridian, two-way in the seams — and no fourth.
        Three- or four-way overlap anywhere — especially toward the poles — is a bug: PARAMETERS.md §4.2 exists
        precisely to correct rev 1's claim that overlap climbs to 4 near the poles. Any point within
        ${ref.analytic.meridianLimitDeg.toFixed(1)}° of three lenses spaced 90° apart would need to be within that
        angle of two antipodal directions at once, and the poles sit exactly 90° from every lens.</p>
      <p><strong>A four-lobed, scalloped unlit polar region.</strong> The filled polar plot must reach furthest from
        the pole in the four seam directions and least far on the four projector meridians — boundary latitude
        running between ${ref.analytic.seamLimitDeg.toFixed(2)}° and ${ref.analytic.meridianLimitDeg.toFixed(2)}° —
        and the unrolled curve beside it must show four minima, one per seam. A circular cap, meaning a region that
        fills one of the two dashed circles exactly, is a bug: it means coverage is being tested with a rotationally
        symmetric approximation instead of against each lens in turn.</p>
      <p class="muted"><strong>This file is not refreshed by a bench round.</strong> Rebuilding it is
        <code>node packages/bench/src/reference.ts</code>, a deliberate act;
        <code>node packages/bench/src/reference.ts --check</code> recomputes and diffs without writing, which is the
        one that belongs in CI. If the reference regenerated itself every round it would always agree with whatever
        the forward model currently believes, and the check would be worth nothing.</p>
    </div>
    <table class="data checks">
      <thead><tr><th>result</th><th>claim, and what the data says</th><th>what a failure would mean</th></tr></thead>
      <tbody>${checkRows}</tbody>
    </table>
    <div class="ref-maps">
      <figure>${maps.multiplicity}<figcaption><strong>Overlap multiplicity.</strong>
        ${checks.areaByMultiplicity.map((f, i) => `${i}-way ${pct(f)}`).join(' · ')}. Verticals are the projector
        meridians. Maximum observed multiplicity is <strong>${checks.maxMultiplicity}</strong>.</figcaption></figure>
      <figure>${maps.incidence}<figcaption><strong>Best cos(incidence)</strong>, viridis
        0→1, grey where nothing reaches. The horizontals are the polar mask onset (${ref.rig.maskLoDeg}°S) and full
        mask (${ref.rig.maskHiDeg}°S) — PARAMETERS.md §4.4 reads the config's <code>bottommask 60,70</code> as
        latitudes, and the onset matching the seam-direction usable limit is the evidence for that reading.</figcaption></figure>
      <figure>${referencePolar(ref, checks)}<figcaption><strong>The unlit polar region</strong>, filled, looking down
        on the north pole, against the two circles that bound it: the ${ref.analytic.meridianLimitDeg.toFixed(2)}° cap
        it must contain and the ${ref.analytic.seamLimitDeg.toFixed(2)}° cap that must contain it. Solid spokes are
        projector meridians, dotted are the seams the corners reach down. <strong>It should look like a square.</strong>
        §4.1's own coverage test is <code>cos(lat)·cos(lon−φ) &gt; R/d</code>, so the boundary's polar trace is
        <code>r = asin((R/d)/cos θ)</code>, and with R/d = ${(ref.rig.radiusM / ref.rig.distanceM).toFixed(4)} the
        arcsine is within a percent of its argument across the whole range — leaving <code>r ∝ 1/cos θ</code>, and
        <code>r·cos(θ−φ) = a</code> is the polar equation of a straight line. Four projectors, four lines, one square
        with its corners in the seam directions. A circle instead of a square is the bug.</figcaption></figure>
      <figure>${referenceProfile(ref)}<figcaption><strong>The same curve, unrolled.</strong> Four minima at
        ${checks.lobeLongitudesDeg.map((l) => `${l.toFixed(0)}°`).join(', ')}, scallop depth
        ${checks.scallopDepthDeg.toFixed(2)}°. Unlit area ${pct(checks.unlitFractionNorth, 3)} of the sphere per pole,
        strictly between the ${pct(checks.capAboveMeridianLimit, 3)} and ${pct(checks.capAboveSeamLimit, 3)} caps —
        docs/AMENDMENTS.md A-05 on why that disagrees with §4.3's stated 1.4–2.8%.</figcaption></figure>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * The dispersion strip: min to max, p05–p95 box, median tick, and every
 * scenario's own value as a dot, against the gate.
 *
 * Never a bare mean. The corpus is bimodal by construction — most scenarios
 * excellent and a few catastrophic is docs/ARCHITECTURE.md's G2 signature — and
 * the shape is the finding. A log axis because the values span four orders of
 * magnitude on this corpus and a linear one would put every passing scenario on
 * top of the origin.
 */
/**
 * How a round's movement should be shown, including for records written before
 * the bar was fixed.
 *
 * Two absences used to render identically as 'flat'. A missing key defaulted to
 * it, and — worse — every one of the five rounds on record was LABELLED 'flat'
 * by a bar computed from scenario scatter rather than seed noise, which on this
 * corpus was larger than the gate. Those labels are not evidence of flatness and
 * are not shown as though they were. A record predating the fix is detectable:
 * its series carries no `scatterAcrossScenarios`.
 */
function movementLabel(r: RoundRecord, key: string): string {
  const legacy = Object.values(r.series).some(
    (s) => (s as { scatterAcrossScenarios?: number }).scatterAcrossScenarios === undefined,
  );
  if (legacy) return 'unqualified (bar predates the fix)';
  return r.movement[key] ?? 'unqualified';
}

function dispersionStrip(d: Dispersion, gateMax: number, unit: string): string {
  const w = 330;
  const h = 46;
  const padL = 8;
  const padR = 8;
  const finite = d.values.filter((v) => Number.isFinite(v) && v > 0);
  const candidates = [...finite, gateMax].filter((v) => Number.isFinite(v) && v > 0);
  if (candidates.length === 0) {
    return `<div class="muted small">no positive finite values to plot (${d.count} scored)</div>`;
  }
  const lo = Math.min(...candidates) / 3;
  const hi = Math.max(...candidates) * 3;
  const toX = (v: number): number => {
    const t = (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
    return padL + Math.min(1, Math.max(0, t)) * (w - padL - padR);
  };
  const yMid = 20;
  const box =
    Number.isFinite(d.p05) && Number.isFinite(d.p95) && d.p05 > 0
      ? `<rect class="box" x="${c(toX(d.p05))}" y="${c(yMid - 7)}" width="${c(Math.max(1, toX(d.p95) - toX(d.p05)))}" height="14"/>`
      : '';
  const whisker =
    Number.isFinite(d.min) && d.min > 0
      ? `<line class="whisker" x1="${c(toX(d.min))}" y1="${c(yMid)}" x2="${c(toX(d.max))}" y2="${c(yMid)}"/>`
      : '';
  const dots = finite
    .map((v) => `<circle class="dot" cx="${c(toX(v))}" cy="${c(yMid)}" r="3"/>`)
    .join('');
  const median = Number.isFinite(d.median)
    ? `<line class="median" x1="${c(toX(d.median))}" y1="${c(yMid - 9)}" x2="${c(toX(d.median))}" y2="${c(yMid + 9)}"/>`
    : '';
  const gate = `<line class="gate-line" x1="${c(toX(gateMax))}" y1="4" x2="${c(toX(gateMax))}" y2="${c(h - 12)}"/><text class="tick" x="${c(toX(gateMax))}" y="${c(h - 2)}" text-anchor="middle">gate ${num(gateMax, 3)}</text>`;
  return `<svg class="plot strip" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="dispersion against the gate">
      ${whisker}${box}${dots}${median}${gate}
      <text class="tick" x="${c(padL)}" y="10">${num(d.min, 3)}</text>
      <text class="tick" x="${c(w - padR)}" y="10" text-anchor="end">${num(d.max, 3)} ${esc(unit)}</text>
    </svg>`;
}

function attributionBlock(gate: GateSummary): string {
  const a = gate.attribution;
  if (a === null) {
    return gate.pass
      ? ''
      : `<div class="attribution missing"><strong>Largest contributor: not attributed.</strong> Attribution runs on
         the worst failing scenario for gates whose metric is a function of the recovered calibration; this gate is
         either a property of the physical rig or the run was made with <code>--no-attribution</code>.</div>`;
  }
  const bars = a.byGroup
    .map((g) => {
      const span = Math.max(...a.byGroup.map((x) => Math.abs(x.value)), 1e-12);
      const width = (100 * Math.abs(g.value)) / span;
      return `<div class="bar-row"><span class="bar-label">${esc(g.group)}</span><span class="bar"><span style="width:${width.toFixed(1)}%"></span></span><span class="bar-value">${num(g.value, 3)}</span></div>`;
    })
    .join('');
  return `<div class="attribution">
      <strong>Largest contributor: ${esc(a.contributor)}</strong> — ${esc(a.explains)}, measured on
      <code>${esc(a.scenario)}</code>.
      <div class="muted small">${esc(a.method)}</div>
      <div class="bars">${bars}</div>
      <div class="muted small">${esc(a.note)}</div>
    </div>`;
}

function gateSection(results: BenchResults): string {
  // A waiver never turns a FAIL into a PASS on this page. It adds a second pill
  // and a citation, because "this gate fails and the project knows why, and the
  // decision is pending with the author" is a different sentence from either
  // "pass" or "fail" and a reader must not have to guess which they are looking
  // at. Expiry is judged by `packages/bench/src/gate.ts`, which owns the exit
  // code; the page reports what the waiver says.
  const waiverFor = (id: string): (typeof results.gates.waivers)[number] | undefined =>
    (results.gates.waivers ?? []).find((w) => w.gate === id && w.gateFailed);

  const rows = results.gates.gates
    .map((g) => {
      const notMeasurable =
        g.scenariosNotMeasurable.length === 0
          ? ''
          : `<div class="muted small">not measurable on ${g.scenariosNotMeasurable.map((x) => `<code>${esc(x)}</code>`).join(', ')} — the metric had nothing to measure there, which is a different sentence from a failure and is counted separately.</div>`;
      const w = waiverFor(g.id);
      const waived =
        w === undefined
          ? ''
          : `<div class="muted small"><span class="pill waived">WAIVED</span> against
              <code>${esc(w.amendment)}</code> (${esc(w.amendmentTitle)}), status
              <strong>${esc(w.amendmentStatus)}</strong>, expires ${esc(w.expires)}${
                w.ceiling === null ? '' : `, covered up to ${num(w.ceiling, 4)} ${esc(g.unit)}`
              }${w.scenarios === null ? '' : `, archetypes ${w.scenarios.map((x) => `<code>${esc(x)}</code>`).join(', ')}`}.
              The number above is unchanged; the waiver records why it is what it is and where the decision
              is pending. See <code>gate-waivers.json</code>. ${esc(w.reason)}</div>`;
      return `<tr class="${g.pass ? 'row-pass' : 'row-fail'}">
        <td>
          <div class="gate-id"><code>${esc(g.id)}</code> ${g.pass ? '<span class="pill pass">PASS</span>' : '<span class="pill fail">FAIL</span>'}${g.provisional ? ' <span class="pill provisional">PROVISIONAL</span>' : ''}${g.advisory ? ' <span class="pill advisory">ADVISORY</span>' : ''}</div>
          <div class="small">${esc(g.metric)}</div>
          <div class="muted small">${esc(g.klass)} · ${esc(g.basis)}</div>
          ${
            g.advisory
              ? `<div class="muted small">The threshold is this project's own, not one PARAMETERS.md §7 publishes.
                 Reported and tracked because it is diagnostic; never allowed to fail a build, because failing
                 somebody's build on a number we invented asserts an authority this repo does not have.</div>`
              : ''
          }
          ${waived}
          ${g.dependsOnRecovery ? '' : '<div class="muted small">Property of where the lenses physically point. No solver can move this one.</div>'}
          ${notMeasurable}
        </td>
        <td class="numeric">
          <div><strong>${num(g.worst?.value, 4)}</strong> ${esc(g.unit)} worst</div>
          <div class="muted small">${g.worst === null ? '' : `on <code>${esc(g.worst.scenario)}</code>`}</div>
          <div class="small">gate ${num(g.max, 3)} · ${g.scenariosFailed}/${g.scenariosScored} scenarios failed</div>
        </td>
        <td>
          <div class="small">min ${num(g.distribution.min, 4)} · p05 ${num(g.distribution.p05, 4)} · <strong>median ${num(g.distribution.median, 4)}</strong> · p95 ${num(g.distribution.p95, 4)} · max ${num(g.distribution.max, 4)}</div>
          ${dispersionStrip(g.distribution, g.max, g.unit)}
          ${g.failedScenarios.length === 0 ? '' : `<div class="small">failed: ${g.failedScenarios.map((x) => `<code>${esc(x)}</code>`).join(', ')}</div>`}
          ${attributionBlock(g)}
        </td>
      </tr>`;
    })
    .join('');

  const unscored = results.gates.unscored
    .map(
      (u) =>
        `<li><code>${esc(u.id)}</code><div class="muted small">${esc(u.reason)}</div></li>`,
    )
    .join('');

  return `<section id="gates">
    <h2>Gates — current values against PARAMETERS.md §7</h2>
    ${howToRead({
      shows:
        'A gate is a pass/fail threshold: a line drawn on a measurement, below which the build is allowed to call itself working. One row per gate, showing the worst value any test case reached and how all the test cases were spread.',
      good: 'Every row passing, with the dots on its strip sitting well to the left of the marked threshold — passing with room to spare rather than by a hair.',
      bad: 'A failing row, which names the largest single cause underneath rather than leaving you to guess. Also bad: a row where most dots sit left of the line and one sits far out to the right. One bad case is a real failure, not an outlier to be averaged away, which is why no row here shows an average.',
      extra: {
        label: 'The four words',
        text:
          '<strong>PASS</strong> — the measurement met the threshold. <strong>FAIL</strong> — it did not. ' +
          '<strong>WAIVED</strong> — it did not, and the reason is written down: a numbered amendment, an expiry ' +
          'date, and a ceiling above which the waiver stops applying. So a known failure cannot quietly become ' +
          'permanent, and a failure bigger than the one that was argued for still breaks the build. The number ' +
          'itself is never softened. <strong>ADVISORY</strong> — the threshold is one this project invented ' +
          'rather than one the specification publishes, so it is reported and tracked but never fails a build.',
      },
    })}
    <p class="lede">Every gate with its full dispersion, never a bare mean: the corpus is bimodal by construction and
      a mean hides exactly the failure mode docs/ARCHITECTURE.md's G2 describes. Each strip is a log axis with the
      whisker at min–max, the box at p05–p95, the tick at the median, one dot per scenario and the gate marked. For a
      failing gate, the single largest contributor is <em>measured</em> — by counterfactual substitution, error
      decomposition, or an observability split, whichever fits — not ranked.</p>
    <table class="data gates">
      <thead><tr><th>gate</th><th>worst</th><th>distribution across scenarios, and attribution</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <details><summary>Reported but excluded from the verdict (${results.gates.unscored.length})</summary><ul class="unscored">${unscored}</ul></details>
  </section>`;
}

// ---------------------------------------------------------------------------
// PROVISIONAL metrics
// ---------------------------------------------------------------------------

/** Both branches of `provisionalSection` carry the same explanation. */
const PROVISIONAL_HOWTO = howToRead({
  shows:
    'Numbers about colour and brightness, kept in a box of their own. Nobody has ever measured how these particular projectors handle colour, so every number in here rests on an assumption about the hardware rather than on a reading taken from it.',
  good: 'Everything in the box computed, tested and displayed — and nothing outside the box depending on any of it. The box being empty is fine too; it means this run produced no such number.',
  bad: 'One of these numbers quoted as a result. They are fenced off rather than mixed in for exactly that reason: an assumption printed beside a measurement quietly borrows the credibility of the measurement.',
});

function provisionalSection(results: BenchResults): string {
  const byId = new Map<string, { metric: MetricResult; scenarios: string[]; values: number[] }>();
  for (const s of results.scenarios) {
    for (const m of s.metrics) {
      if (!m.provisional) continue;
      const entry = byId.get(m.id) ?? { metric: m, scenarios: [], values: [] };
      entry.scenarios.push(s.id);
      entry.values.push(m.value);
      byId.set(m.id, entry);
    }
  }

  const why = `<p>A PROVISIONAL metric is one whose value depends on a constant nobody has measured.
      PARAMETERS.md §10 counts 31 ASSUME-class parameters and every photometric metric — seam luminance, seam
      chromaticity, black uplift — is a function of several of them. A photometric metric that passes its gate today
      is a statement about <code>γ_B = 2.2</code>, which is a guess, and §10 ranks per-channel gamma divergence as the
      single highest photometric risk. Presenting such a number beside a geometric one without marking it would let a
      guess borrow the credibility of a measurement, which is the specific dishonesty
      docs/ARCHITECTURE.md's phase gate exists to prevent. They are shown, they are marked, and
      <code>loop.ts</code> refuses to score a round on one.</p>`;

  if (byId.size === 0) {
    return `<section id="provisional">
      <h2>PROVISIONAL metrics <span class="tag">none yet — the mechanism is live</span></h2>
      ${PROVISIONAL_HOWTO}
      <div class="provisional empty">
        ${why}
        <p><strong>This run contains none.</strong> Every metric in it sets <code>provisional: false</code> and means
          it: no geometric number depends on an ASSUME-class photometric constant. The block above is the mechanism,
          wired and tested — the moment a Phase 2 metric arrives with the flag set it appears here, in this box, with
          its value, its gate and the constants it rests on, and nowhere else on the page.</p>
      </div>
    </section>`;
  }

  const cards = [...byId.entries()]
    .map(([id, e]) => {
      const finite = e.values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      return `<div class="card">
        <h3><code>${esc(id)}</code> <span class="pill provisional">PROVISIONAL</span></h3>
        <div class="small">${esc(e.metric.label)}</div>
        <table class="kv">
          <tr><th>median</th><td>${num(quantile(finite, 0.5), 4)} ${esc(e.metric.unit)}</td></tr>
          <tr><th>min / max</th><td>${num(finite[0], 4)} / ${num(finite[finite.length - 1], 4)}</td></tr>
          <tr><th>gate</th><td>${e.metric.gateMax === null ? 'none' : num(e.metric.gateMax, 4)} — ${e.metric.gate === null ? '' : `${esc(e.metric.gate.klass)}, ${esc(e.metric.gate.basis)}`}</td></tr>
          <tr><th>scenarios</th><td>${e.scenarios.map((x) => `<code>${esc(x)}</code>`).join(', ')}</td></tr>
        </table>
        <div class="muted small">${esc(e.metric.note)}</div>
      </div>`;
    })
    .join('');

  return `<section id="provisional">
    <h2>PROVISIONAL metrics <span class="tag">${byId.size} metric(s) — do not quote these</span></h2>
    ${PROVISIONAL_HOWTO}
    <div class="provisional">${why}<div class="grid-cards">${cards}</div></div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

export interface ExperimentSeries {
  label: string;
  x: number[];
  y: number[];
}

export interface ExperimentReport {
  id: string;
  title?: string;
  question?: string;
  finding: string;
  provisional?: boolean;
  xLabel: string;
  yLabel: string;
  series: ExperimentSeries[];
}

interface ExperimentSlot {
  id: string;
  title: string;
  question: string;
  provisionalByConstruction: boolean;
  report: ExperimentReport | null;
}

/** The three experiments of docs/ARCHITECTURE.md. Each runs ONCE. */
export const EXPERIMENT_SLOTS: { id: string; title: string; question: string; provisional: boolean }[] = [
  {
    id: 'experiment-1-cameras',
    title: 'Experiment 1 — camera positions, 1 to 8',
    question:
      'How many photographs does a real calibration need, and does a phone suffice? Noise, ambient and rolling shutter enter as separate conditions so the effect can be attributed.',
    provisional: false,
  },
  {
    id: 'experiment-2-blend',
    title: 'Experiment 2 — blend softness against geometric tolerance',
    question:
      'Does soft blending buy geometric tolerance? If it does, the value proposition inverts from "our alignment is more accurate" to "you need less alignment accuracy". Depends on Phase 2 photometry, so its output inherits the PROVISIONAL marking.',
    provisional: true,
  },
  {
    id: 'experiment-3-sensitivity',
    title: 'Experiment 3 — photometric sensitivity across every ASSUME range',
    question:
      "Which unmeasured constants actually matter — i.e. what gets measured on the real-sphere visit? Its output is the work order for PARAMETERS.md §8. Depends on Phase 2 photometry, so its output inherits the PROVISIONAL marking.",
    provisional: true,
  },
];

function experimentPlot(report: ExperimentReport): string {
  const w = 340;
  const h = 190;
  const padL = 52;
  const padR = 14;
  const padT = 12;
  const padB = 34;
  const xs = report.series.flatMap((s) => s.x).filter((v) => Number.isFinite(v));
  const ys = report.series.flatMap((s) => s.y).filter((v) => Number.isFinite(v));
  if (xs.length === 0 || ys.length === 0) return '<div class="muted small">series carried no finite values</div>';
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(0, Math.min(...ys));
  const y1 = Math.max(...ys) * 1.1 || 1;
  const toX = (v: number): number => padL + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * w;
  const toY = (v: number): number => padT + (1 - (v - y0) / (y1 - y0 || 1)) * h;
  const lines = report.series
    .map(
      (s, i) =>
        `<polyline class="series series-${i % 4}" points="${s.x.map((v, k) => `${c(toX(v))},${c(toY(s.y[k]))}`).join(' ')}"/>`,
    )
    .join('');
  const legend = report.series
    .map(
      (s, i) =>
        `<span class="legend"><span class="swatch swatch-${i % 4}"></span>${esc(s.label)}</span>`,
    )
    .join('');
  return `<svg class="plot" viewBox="0 0 ${padL + w + padR} ${padT + h + padB}" width="${padL + w + padR}" height="${padT + h + padB}" role="img" aria-label="${esc(report.title ?? report.id)}">
      <rect class="frame" x="${c(padL)}" y="${c(padT)}" width="${w}" height="${h}"/>
      ${lines}
      <text class="axis-label" x="${c(padL + w / 2)}" y="${c(padT + h + padB - 4)}" text-anchor="middle">${esc(report.xLabel)}</text>
      <text class="axis-label" x="12" y="${c(padT + h / 2)}" text-anchor="middle" transform="rotate(-90 12 ${c(padT + h / 2)})">${esc(report.yLabel)}</text>
      <text class="tick" x="${c(padL)}" y="${c(padT + h + 13)}">${num(x0, 2)}</text>
      <text class="tick" x="${c(padL + w)}" y="${c(padT + h + 13)}" text-anchor="end">${num(x1, 2)}</text>
      <text class="tick" x="${c(padL - 5)}" y="${c(padT + 8)}" text-anchor="end">${num(y1, 2)}</text>
      <text class="tick" x="${c(padL - 5)}" y="${c(padT + h)}" text-anchor="end">${num(y0, 2)}</text>
    </svg><div class="legends">${legend}</div>`;
}

function experimentSection(slots: ExperimentSlot[]): string {
  const cards = slots
    .map((slot) => {
      if (slot.report === null) {
        return `<div class="card placeholder">
          <h3>${esc(slot.title)} <span class="pill pending">not yet run</span></h3>
          <p class="small">${esc(slot.question)}</p>
          <div class="placeholder-box">plot appears here when
            <code>progress/experiments/${esc(slot.id)}.json</code> exists</div>
          ${slot.provisionalByConstruction ? '<div class="muted small">Will be marked PROVISIONAL when it lands: it depends on Phase 2 photometry.</div>' : ''}
        </div>`;
      }
      const r = slot.report;
      return `<div class="card">
        <h3>${esc(r.title ?? slot.title)} ${r.provisional ? '<span class="pill provisional">PROVISIONAL</span>' : '<span class="pill pass">complete</span>'}</h3>
        <p class="small">${esc(r.question ?? slot.question)}</p>
        ${experimentPlot(r)}
        <p class="finding"><strong>Finding.</strong> ${esc(r.finding)}</p>
      </div>`;
    })
    .join('');
  return `<section id="experiments">
    <h2>Experiments — measurements, not loop iterations</h2>
    ${howToRead({
      shows:
        'Measurements, not tuning. Each one asks a single question — how many photographs a calibration needs, whether a softer join hides more error, which unmeasured assumptions actually matter — runs once, and reports what it found.',
      good: 'A plot and a written finding, including findings that went against what the project expected.',
      bad: 'A measurement that has been run again and again until it says something better. That is why each of these runs once and is not repeated: an experiment iterated until it flatters the build has stopped being a measurement and become an advertisement.',
    })}
    <p class="lede">Each runs <strong>once</strong>, produces a plot and a written finding, and is not iterated to
      improve its result. Iterating an experiment until it says something better is how a measurement becomes an
      advertisement.</p>
    <div class="grid-cards">${cards}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Glossary
//
// Every word the rest of the page uses without stopping to explain it. The list
// is exported so `test/progress.test.ts` can assert coverage: a page that uses a
// term and does not define it is the failure this block exists to prevent, and
// that is a test's job rather than a proofreader's.
//
// Two entries are longer than the others on purpose. `gauge` and `paired
// comparison` are both counter-intuitive, both load-bearing for reading the
// numbers on this page, and both routinely got wrong — a short definition of
// either would be worse than none.
// ---------------------------------------------------------------------------

export interface GlossaryEntry {
  term: string;
  /** Trusted HTML, written here as a literal. Plain words, no spec numbers. */
  definition: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: 'residual',
    definition:
      'What is left over. Once the solver has settled on an answer, it predicts where each measured point should have appeared and subtracts where that point actually appeared. The difference is the residual: the part of the photographs the answer does not explain.',
  },
  {
    term: 'gauge',
    definition:
      'The part of the answer photographs cannot possibly contain. Take the whole rig — every projector and every camera together — and rotate all of it about the centre of the sphere. Every photograph comes out identical, pixel for pixel, because nothing in the pictures depends on which way the whole arrangement faces. So that rotation cannot be recovered from photographs by <em>any</em> method at all, ours included. It is removed before a recovered rig is compared with the truth. Comparing without removing it first would measure our own arbitrary choice of which way the room points, and report that as an error made by the solver.',
  },
  {
    term: 'gate',
    definition:
      'A pass/fail threshold on a measurement. Four verdicts appear on this page: passed, failed, waived (failed, with the reason written down in a numbered amendment that carries an expiry date and a ceiling), and advisory (a threshold this project invented rather than one the specification publishes, so it is reported but never fails a build).',
  },
  {
    term: 'provisional',
    definition:
      'A number that depends on a constant nobody has measured yet. It is computed, tested and shown — and marked, so it can never be mistaken for a result or quoted as one.',
  },
  {
    term: 'waived',
    definition:
      'A gate that fails, where the failure is understood and the reasoning is on the record: a numbered amendment, an expiry date, and a ceiling above which the waiver no longer covers it. The measured number is not softened, hidden or rounded — the waiver records why it is what it is, and a failure worse than the one that was argued for still breaks the build.',
  },
  {
    term: 'registration error',
    definition:
      'How far the projected picture lands from where it was supposed to land, measured in millimetres along the surface of the sphere, at every point where two projectors both reach.',
  },
  {
    term: 'seam',
    definition:
      'The band where two neighbouring projectors both light the sphere and their two pictures have to agree. Four projectors make four seams, and misalignment shows up there first.',
  },
  {
    term: 'correspondence',
    definition:
      'One matched pair of points: <em>this</em> pixel of that projector lit up <em>that</em> pixel of this camera. A single capture yields tens of thousands of them, and they are the entire raw material the solver works from.',
  },
  {
    term: 'decode',
    definition:
      'Reading the correspondences back out of the photographs. Each projector shows a sequence of striped patterns — one "Gray plane" per frame, each with stripes half the width of the last — so every spot on the sphere receives its own on/off sequence, like a short barcode played out in time. Decoding turns that sequence back into "you are pixel such-and-such of projector three".',
  },
  {
    term: 'structured light',
    definition:
      'The technique behind the whole capture: project patterns you already know, photograph them, and work backwards from what the camera saw. It needs nothing more exotic than a camera, which is the point — the method has to work in a museum, not only in a lab.',
  },
  {
    term: 'archetype',
    definition:
      'A named kind of test case: a spotless rig, a normally lit room, a handheld phone, an installation with only three projectors. The archetype says what is being stressed.',
  },
  {
    term: 'scenario',
    definition:
      'One concrete test case: an archetype plus a specific random draw of the imperfections in the rig. Scenarios are the things that actually get scored, and the page names each one.',
  },
  {
    term: 'seed',
    definition:
      'The number every random draw starts from. Same seed, same rig, same noise, same answer — which is what makes every comparison on this page repeatable, and what stops a good result from being a lucky one.',
  },
  {
    term: 'paired comparison',
    definition:
      'The way a change is tested here. Photograph the scene once, then solve it twice with exactly one setting different. Both answers see identical photographs, so any difference between them is that setting and nothing else. The alternative — running the whole thing twice and comparing the two runs — lets the random draw of the scene swamp the effect you are trying to see: on this project that draw alone moves each score by 69 to 182 per cent of its own value, which is why an unpaired comparison cannot resolve even a change of two times.',
  },
  {
    term: 'bundle adjustment',
    definition:
      'The arithmetic that turns tens of thousands of correspondences into one answer: nudge the position, aim and lens of every projector together, over and over, until the disagreement with the photographs is as small as it can be made. "Bundle" because the whole bundle of light rays is adjusted at once rather than one camera at a time.',
  },
  {
    term: 'equirectangular',
    definition:
      'The sphere unrolled onto a rectangle — longitude across, latitude up — the same layout as a classroom world map. Honest in the middle, badly stretched at the top and bottom, and convenient because a whole sphere fits in one picture.',
  },
  {
    term: 'provenance class',
    definition:
      'The shorthand printed under each gate saying where its threshold came from. <strong>DOC</strong> — published in the manufacturer or operator documentation. <strong>CFG</strong> — read off a specification sheet or the configuration file of a site. <strong>SOLVE</strong> — not assumed at all; the solver works it out. <strong>ASSUME</strong> — nobody has published it and nobody has measured it, so this project chose a value; this is where the bar could be confidently wrong. <strong>MEAS</strong> — waiting on a measurement at a real installation. <strong>DERIVED</strong> — calculated from the others rather than chosen.',
  },
  {
    term: 'overlap multiplicity',
    definition:
      'How many projectors light a given point on the sphere: none, one, or two. Never three or four on a rig like this one — checking that is half of what the static reference exists for.',
  },
  {
    term: 'polar mask',
    definition:
      'Software that fades the picture out towards the bottom of the sphere, where the light arrives so slanted that a pixel would land as a streak. The sphere hangs from a mount that already hides the top, so only the bottom needs masking.',
  },
  {
    term: 'off-sphere flux',
    definition:
      'The share of the light from a projector that misses the sphere altogether and lands on the room behind it. It can never be zero, because a rectangular picture cannot exactly fill a round outline; what gets scored is the excess above the amount the shape alone forces.',
  },
  {
    term: 'phase 1 and phase 2',
    definition:
      'The two halves of the work, kept apart on purpose. Phase 1 is geometry — where the projectors are and where the picture lands — and it is worked on now, because the simulator knows the true answer and can mark its own homework. Phase 2 is brightness and colour, which is built and tested but deliberately not tuned, because tuning against constants nobody has measured produces confident nonsense.',
  },
  {
    term: 'round',
    definition:
      'One pass of the improvement loop: change something in the solver, generate a fresh set of test cases with new random draws so the change cannot be quietly fitted to the old ones, score everything, and record the result whether it helped or not.',
  },
  {
    term: 'incidence angle',
    definition:
      'How slanted the light arrives at the surface. Head on, a projector pixel lands as a small square. Out near the edge of what that projector can reach, the same pixel smears into a long streak — which is why parts of the sphere can be lit and still be unusable.',
  },
];

function glossarySection(): string {
  const rows = GLOSSARY.map(
    (g) => `<dt>${esc(g.term)}</dt><dd>${g.definition}</dd>`,
  ).join('');
  return `<section id="glossary">
    <h2>Glossary</h2>
    ${howToRead({
      shows:
        'Plain definitions for the words this page uses without stopping to explain them. Two of them — gauge and paired comparison — are counter-intuitive rather than merely unfamiliar, so they get a longer entry.',
    })}
    <dl class="glossary">${rows}</dl>
  </section>`;
}

// ---------------------------------------------------------------------------
// Header and footer
// ---------------------------------------------------------------------------

function headerSection(results: BenchResults, generatedAt: string, rounds: RoundHistory | null): string {
  const pass = results.gates.pass;
  const failing = results.gates.gates.filter((g) => !g.pass);
  const scenariosWithErrors = results.scenarios.filter((s) => s.error !== null);
  const round = rounds === null || rounds.rounds.length === 0 ? null : rounds.rounds[rounds.rounds.length - 1];
  const provisionalCount = new Set(
    results.scenarios.flatMap((s) => s.metrics.filter((m) => m.provisional).map((m) => m.id)),
  ).size;

  const meta: [string, string][] = [
    ['seed', String(results.run.seed)],
    ['scenarios', String(results.run.scenarioCount)],
    ['preset', results.run.preset],
    ['conventions', results.run.conventions],
    ['spec', results.run.parametersRev],
    ['bench run at', results.env.generatedAt],
    ['commit', `${results.env.gitCommit.slice(0, 10)}${results.env.gitDirty ? ' (dirty tree)' : ''}`],
    ['node / platform', `${results.env.node} · ${results.env.platform}`],
    ['bench wall clock', `${(results.env.durationMs / 1000).toFixed(1)} s`],
    ['page built at', generatedAt],
    ['round', round === null ? 'no round history' : `${round.round} (${round.consecutiveNonImproving} consecutive non-improving)`],
  ];

  return `<header>
    <div class="title">
      <h1>sphere-sim — progress</h1>
      <div class="verdict-banner ${pass ? 'pass' : 'fail'}">
        ${pass ? 'ALL SCORED GEOMETRIC GATES PASS' : `${failing.length} GATE${failing.length === 1 ? '' : 'S'} FAILING`}
        ${failing.length === 0 ? '' : `<span class="which">${failing.map((g) => esc(g.id)).join(' · ')}</span>`}
      </div>
    </div>
    ${orientationBlock()}
    <p class="lede">Phase 1 is geometry and it is optimised in a loop. Phase 2 is photometry and it is built but not
      optimised, because optimising against constants nobody has measured produces confident nonsense.
      ${
        provisionalCount === 0
          ? 'Every number below is geometric, and the <a href="#provisional">PROVISIONAL block</a> is empty and says so.'
          : `${provisionalCount} metric(s) rest on unmeasured constants and are quarantined in the <a href="#provisional">PROVISIONAL block</a>; nothing else on this page depends on one.`
      }</p>
    ${scenariosWithErrors.length === 0 ? '' : `<div class="banner-error">${scenariosWithErrors.length} scenario(s) errored: ${scenariosWithErrors.map((s) => `<code>${esc(s.id)}</code> ${esc(s.error ?? '')}`).join('; ')}</div>`}
    <table class="meta-table">${meta
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
      .join('')}</table>
    <nav>
      <a href="#orientation">start here</a>
      <a href="#gates">gates</a>
      <a href="#residuals">1 · residuals</a>
      <a href="#error-map">2 · error map</a>
      <a href="#grid-view">3 · grid view</a>
      <a href="#before-after">4 · before/after</a>
      <a href="#trend">5 · trend</a>
      <a href="#reference">6 · static reference</a>
      <a href="#provisional">provisional</a>
      <a href="#experiments">experiments</a>
      <a href="#capture">capture</a>
      <a href="#glossary">glossary</a>
      <a href="#notes">notes</a>
    </nav>
  </header>`;
}

function captureSection(results: BenchResults, images: ImageStore): string {
  const rows = results.scenarios
    .map((s) => {
      const inputs = inputsOf(s);
      const solver = solverOf(s);
      const recovery = recoveryOf(s);
      const capture = s.capture as unknown as {
        framesRendered: number;
        correspondences: number;
      };
      return `<div class="card">
        <h3>${esc(s.id)}</h3>
        ${figure(images.get(artifact(s, 'cameraFrame')), 'One Gray plane as the camera saw it — the solver never gets anything else.', 'camera frame not found')}
        <table class="kv">
          <tr><th>projectors / cameras</th><td>${inputs.projectorCount} · ${inputs.cameras?.count ?? '?'} at ${inputs.cameras?.res?.x ?? '?'}×${inputs.cameras?.res?.y ?? '?'}</td></tr>
          <tr><th>frames · correspondences</th><td>${capture?.framesRendered ?? '?'} · ${capture?.correspondences ?? '?'}</td></tr>
          <tr><th>ambient</th><td>${num(inputs.degradation?.ambient, 3)} relative (§5 range 0.01–0.15)</td></tr>
          <tr><th>floor references</th><td>${inputs.floorReferenceCount} at σ ${num((inputs.floorSigmaM ?? 0) * 1000, 1)} mm</td></tr>
          <tr><th>pose error, aligned</th><td>${num(recovery?.postAlignment.maxPositionMm, 3)} mm · ${num(recovery?.postAlignment.maxRotationDeg, 4)}°</td></tr>
          <tr><th>gauge removed</th><td>${num(recovery?.gauge.angleDeg, 5)}° constrained, ${num(recovery?.gauge.unconstrainedAngleDeg, 5)}° if unconstrained</td></tr>
          <tr><th>h_center</th><td>${num(recovery?.centerHeight.errorMm, 3)} mm ${recovery?.centerHeight.observed === false ? '(held, not solved — no floor reference)' : ''}</td></tr>
          <tr><th>solver</th><td>${num(solver?.rmsResidualPx, 5)} px RMS, ${solver?.iterations ?? '?'} iterations, ${solver?.converged ? 'converged' : `stopped on ${esc(solver?.stopReason ?? '?')}`}</td></tr>
        </table>
      </div>`;
    })
    .join('');
  return `<section id="capture">
    <h2>The capture each solve was given</h2>
    ${howToRead({
      shows:
        'What the solver was actually handed. The projectors display a sequence of striped patterns, a camera photographs each one, and those photographs are the only input the solver ever gets — it is never given the answer in any other form. One frame from each test case is shown here, with the conditions it was taken under.',
      good: 'Frames that look like real photographs of a room — dim, grainy, taken from a distance, sometimes shaky — and the solver still recovering the rig from them.',
      bad: 'A capture too clean to be real. A solver only ever handed perfect pictures has been graded on an exam it wrote itself, and its scores would say nothing about a room with the lights on and somebody holding a phone.',
    })}
    <p class="lede">The solver is scored on images, never on correspondences. Every number above came out of a
      rendered structured-light sequence that the solver's own decoder read back, so every rejected pixel is a pixel a
      real capture would also have lost.</p>
    <div class="grid-cards">${rows}</div>
  </section>`;
}

function notesSection(results: BenchResults, reference: CoverageReference | null): string {
  return `<section id="notes">
    <h2>Notes carried from the results file</h2>
    ${howToRead({
      shows:
        'Anything the run itself wanted on the record, followed by the exact commands that rebuild everything above. Nothing here is written by hand for the report; the notes come out of the run.',
      good: 'The commands below, pasted into a fresh copy of the project, producing this same page with the same numbers on it.',
    })}
    <ul class="notes">${results.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    <h3>How to rebuild what is on this page</h3>
    <pre>node packages/bench/src/cli.ts --scenarios 6 --seed 1234 --out bench-results.json   # results + PNGs
node packages/bench/src/loop.ts                     # one Phase 1 round; refreshes this page
node packages/bench/src/progress.ts                 # rebuild this page alone
node packages/bench/src/reference.ts --check        # recompute the static reference and DIFF it
node packages/bench/src/reference.ts                # rewrite it — deliberate, and rarely</pre>
    <p class="muted small">Static reference on disk: ${
      reference === null
        ? 'none'
        : `${esc(REFERENCE_RELATIVE_PATH)}, computed ${esc(reference.generatedAt)} at commit <code>${esc(reference.gitCommit.slice(0, 10))}</code> for d_proj = ${reference.rig.distanceM} m.`
    }</p>
    <p class="muted small">Generated by <code>packages/bench/src/progress.ts</code> (${esc(PROGRESS_SCHEMA)}) from
      <code>${esc(results.schema)}</code>. No JavaScript, no external requests, no fonts or images loaded from
      anywhere — every image on this page is embedded in it.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** Repo-relative PNG path to `data:` URI. Missing files render as gaps. */
export interface ImageStore {
  get(relPath: string): string | null;
}

export function imageStoreFromDisk(repoRoot: string): ImageStore {
  const cache = new Map<string, string | null>();
  return {
    get(relPath: string): string | null {
      if (relPath === '') return null;
      const hit = cache.get(relPath);
      if (hit !== undefined) return hit;
      const file = path.resolve(repoRoot, relPath);
      let value: string | null = null;
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          value = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
        }
      } catch {
        value = null;
      }
      cache.set(relPath, value);
      return value;
    },
  };
}

export const EMPTY_IMAGE_STORE: ImageStore = { get: () => null };

export interface ProgressInput {
  results: BenchResults;
  images: ImageStore;
  rounds: RoundHistory | null;
  reference: CoverageReference | null;
  previous: PreviousRound | null;
  experiments: ExperimentReport[];
  generatedAt: string;
}

export function renderProgressPage(input: ProgressInput): string {
  const checks = input.reference === null ? null : analyseCoverageReference(input.reference);
  const slots: ExperimentSlot[] = EXPERIMENT_SLOTS.map((s) => ({
    id: s.id,
    title: s.title,
    question: s.question,
    provisionalByConstruction: s.provisional,
    report: input.experiments.find((e) => e.id === s.id) ?? null,
  }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>sphere-sim — progress</title>
<style>${CSS}</style>
</head>
<body>
${headerSection(input.results, input.generatedAt, input.rounds)}
<main>
${gateSection(input.results)}
${residualSection(input.results)}
${errorMapSection(input.results, input.images)}
${gridViewSection(input.results, input.images)}
${beforeAfterSection(input.results, input.images, input.previous)}
${trendSection(input.results, input.rounds)}
${referenceSection(input.reference, checks)}
${provisionalSection(input.results)}
${experimentSection(slots)}
${captureSection(input.results, input.images)}
${glossarySection()}
${notesSection(input.results, input.reference)}
</main>
</body>
</html>
`;
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --fg: #1a1a1a; --muted: #5c6470; --line: #d9dde3;
  --grid: #edf0f4; --accent: #2b5fd9; --pass: #1f7a3d; --fail: #b3261e; --warn: #9a6700;
  --dot: #2b5fd9; --ellipse: #b3261e; --profile: #b3261e; --gate: #b3261e;
  --unlit: #b8bcc4; --mult1: #3b6ea5; --mult2: #f0b429; --box: #cfe0ff; --provisional: #fff4d6;
  --provisional-line: #d9a800;
  /* The plain-language blocks. A tint of the accent over the panel, so it holds
     its contrast in both themes without a second colour to keep in step. */
  --plain-bg: #f1f5fe;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --panel: #1b1e24; --fg: #e8eaed; --muted: #9aa3af; --line: #333944;
    --grid: #262b33; --accent: #7aa2ff; --pass: #4ec37a; --fail: #ff6b5e; --warn: #e0a83c;
    --dot: #7aa2ff; --ellipse: #ff8f85; --profile: #ff8f85; --gate: #ff6b5e;
    --unlit: #444a55; --mult1: #4a7fbf; --mult2: #d9a300; --box: #2a3550; --provisional: #2e2712;
    --provisional-line: #b98f00;
    --plain-bg: #1d232f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main, header { max-width: 1180px; margin: 0 auto; padding: 0 22px; }
header { padding-top: 30px; }
h1 { font-size: 27px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 21px; margin: 0 0 10px; padding-bottom: 8px; border-bottom: 2px solid var(--line); }
h3 { font-size: 16px; margin: 18px 0 8px; }
h4 { font-size: 14px; margin: 14px 0 6px; }
section { margin: 42px 0; }
p { margin: 8px 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em;
  background: var(--grid); padding: 1px 4px; border-radius: 3px; }
pre { background: var(--grid); padding: 12px 14px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
a { color: var(--accent); }
.title { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; justify-content: space-between; }
.verdict-banner { font-weight: 700; letter-spacing: 0.03em; padding: 8px 14px; border-radius: 6px; font-size: 14px; }
.verdict-banner.pass { background: color-mix(in srgb, var(--pass) 16%, transparent); color: var(--pass);
  border: 1px solid var(--pass); }
.verdict-banner.fail { background: color-mix(in srgb, var(--fail) 14%, transparent); color: var(--fail);
  border: 1px solid var(--fail); }
.verdict-banner .which { display: block; font-weight: 400; font-size: 12px; opacity: 0.85; }
.banner-error { border: 1px solid var(--fail); color: var(--fail); padding: 8px 12px; border-radius: 6px; }
.lede { max-width: 78ch; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.good { color: var(--pass); }
.bad { color: var(--fail); }
nav { display: flex; flex-wrap: wrap; gap: 14px; margin: 16px 0 4px; padding: 10px 0;
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 13px; }
.meta-table { border-collapse: collapse; margin: 14px 0; font-size: 13px; }
.meta-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 2px 16px 2px 0; white-space: nowrap; }
.meta-table td { padding: 2px 0; }
table.data { width: 100%; border-collapse: collapse; margin: 12px 0; }
table.data th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--muted); border-bottom: 1px solid var(--line); padding: 6px 8px; }
table.data td { border-bottom: 1px solid var(--line); padding: 10px 8px; vertical-align: top; }
table.data tr.row-fail td:first-child { box-shadow: inset 3px 0 0 var(--fail); }
table.data tr.row-pass td:first-child { box-shadow: inset 3px 0 0 var(--pass); }
td.numeric { white-space: nowrap; }
table.kv { border-collapse: collapse; font-size: 13px; }
table.kv th { text-align: left; font-weight: 500; color: var(--muted); padding: 3px 12px 3px 0;
  vertical-align: top; white-space: nowrap; }
table.kv td { padding: 3px 0; vertical-align: top; }
.pill { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 20px; }
.pill.pass { background: color-mix(in srgb, var(--pass) 18%, transparent); color: var(--pass); }
.pill.fail { background: color-mix(in srgb, var(--fail) 18%, transparent); color: var(--fail); }
.pill.pending { background: var(--grid); color: var(--muted); }
.pill.provisional { background: var(--provisional); color: var(--warn); border: 1px solid var(--provisional-line); }
.pill.waived { background: var(--provisional); color: var(--warn); border: 1px dashed var(--provisional-line); }
.pill.advisory { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent);
  border: 1px solid var(--accent); }
.tag { font-size: 12px; font-weight: 400; color: var(--muted); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 16px 0; }
.panel .meta { font-size: 12.5px; color: var(--muted); margin-top: 0; }
/* A default round draws about 113 000 circles: every residual, in two views,
   none subsampled. content-visibility lets the browser skip the ones nobody is
   looking at, which keeps scrolling smooth without dropping a single point. */
.proj { border-top: 1px solid var(--line); padding-top: 8px; margin-top: 12px;
  content-visibility: auto; contain-intrinsic-size: auto 300px; }
.proj-body { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.plots { display: flex; flex-wrap: wrap; gap: 8px; }
.stats { min-width: 300px; flex: 1 1 300px; }
.verdict { display: inline-block; font-weight: 700; font-size: 12px; letter-spacing: 0.04em;
  padding: 3px 9px; border-radius: 4px; margin-bottom: 6px; }
.verdict-noise { background: color-mix(in srgb, var(--pass) 16%, transparent); color: var(--pass); }
.verdict-weak { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.verdict-structured { background: color-mix(in srgb, var(--fail) 16%, transparent); color: var(--fail); }
svg.plot { display: block; max-width: 100%; height: auto; overflow: visible; }
svg.plot .frame { fill: none; stroke: var(--line); stroke-width: 1; }
svg.plot .grid, svg.plot .maphair { stroke: var(--grid); stroke-width: 1; }
@media (prefers-color-scheme: dark) { svg.plot .maphair { stroke: rgba(255,255,255,0.18); } }
svg.plot .axis { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
svg.plot .tick { fill: var(--muted); font-size: 9px; }
svg.plot .axis-label { fill: var(--muted); font-size: 10px; }
svg.plot .pts circle { fill: var(--dot); }
svg.plot .ellipse { fill: none; stroke: var(--ellipse); stroke-width: 1.2; }
svg.plot .ref-circle { fill: none; stroke: var(--ellipse); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.75; }
svg.plot .profile { fill: none; stroke: var(--profile); stroke-width: 1.6; }
svg.plot .profile-dot { fill: var(--profile); }
svg.plot .profile-err { stroke: var(--profile); stroke-width: 1.4; opacity: 0.65; }
svg.plot .meridian { stroke: #ffffff; stroke-width: 1.2; opacity: 0.85; }
svg.plot .seam { stroke: #ffffff; stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.7; }
svg.plot .mask { stroke: #ff5a4d; stroke-width: 1.1; stroke-dasharray: 5 3; }
svg.plot .map-label { font-size: 9px; fill: #ffffff; }
svg.plot .mask-label { fill: #ff5a4d; }
svg.plot .gap-rect { fill: var(--unlit); }
svg.plot .boundary { fill: none; stroke: var(--accent); stroke-width: 1.8; }
svg.plot .unlit-region { fill: var(--unlit); stroke: none; }
svg.plot .bound-cap { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 4 3; }
svg.plot .gate-line { stroke: var(--gate); stroke-width: 1.2; stroke-dasharray: 4 3; }
svg.plot .box { fill: var(--box); opacity: 0.75; }
svg.plot .whisker { stroke: var(--muted); stroke-width: 1; }
svg.plot .dot { fill: var(--dot); fill-opacity: 0.55; }
svg.plot .median { stroke: var(--fg); stroke-width: 2; }
svg.plot .spark-median { fill: none; stroke: var(--accent); stroke-width: 2; }
svg.plot .spark-p95 { fill: none; stroke: var(--accent); stroke-width: 1; opacity: 0.4; }
svg.plot .spark-median-dot { fill: var(--accent); }
svg.plot .spark-p95-dot { fill: var(--accent); opacity: 0.4; }
svg.plot .series { fill: none; stroke-width: 1.8; }
svg.plot .series-0 { stroke: var(--accent); } svg.plot .series-1 { stroke: var(--warn); }
svg.plot .series-2 { stroke: var(--pass); } svg.plot .series-3 { stroke: var(--fail); }
.legends { font-size: 12px; display: flex; gap: 12px; flex-wrap: wrap; }
.swatch { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 2px; }
.swatch-0 { background: var(--accent); } .swatch-1 { background: var(--warn); }
.swatch-2 { background: var(--pass); } .swatch-3 { background: var(--fail); }
.colorbar { margin: 6px 0 12px; }
.map-row { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
.grid-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card h3 { margin-top: 0; }
figure { margin: 0 0 8px; }
figure img { width: 100%; height: auto; display: block; border-radius: 4px; background: var(--grid); }
figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; }
.img-missing { border: 1px dashed var(--line); color: var(--muted); font-size: 12px; padding: 30px 10px;
  text-align: center; border-radius: 4px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.spark-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 16px; }
.spark { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.spark h4 { margin: 0 0 4px; }
.attribution { margin-top: 10px; padding: 8px 10px; border-left: 3px solid var(--accent);
  background: var(--grid); border-radius: 0 5px 5px 0; font-size: 13px; }
.attribution.missing { border-left-color: var(--muted); }
.bars { margin: 6px 0; }
.bar-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 2px 0; }
.bar-label { flex: 0 0 210px; color: var(--muted); }
.bar { flex: 1 1 auto; background: var(--line); height: 8px; border-radius: 4px; overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--accent); }
.bar-value { flex: 0 0 70px; text-align: right; }
/* Plain-language scaffolding. Tinted and left-ruled so it reads as a different
   kind of thing from the data, and an expert can skip all of it at a glance. */
.orientation { background: var(--plain-bg); border: 1px solid var(--line);
  border-left: 4px solid var(--accent); border-radius: 0 8px 8px 0; padding: 14px 20px 16px;
  margin: 18px 0 6px; max-width: 84ch; }
.orientation h2.plain-h { font-size: 17px; margin: 0 0 10px; padding: 0; border-bottom: none;
  letter-spacing: 0.01em; }
.orientation p { margin: 0 0 10px; }
.orientation p:last-child { margin-bottom: 0; }
.orientation-foot { font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 9px; }
.howto { background: var(--plain-bg); border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0;
  padding: 9px 14px; margin: 10px 0 16px; max-width: 88ch; font-size: 13.5px; }
.howto-line { display: grid; grid-template-columns: 128px 1fr; gap: 12px; align-items: baseline; margin: 5px 0; }
.howto-label { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--accent); }
@media (max-width: 640px) {
  .howto-line { grid-template-columns: 1fr; gap: 1px; }
}
dl.glossary { display: grid; grid-template-columns: minmax(140px, 200px) 1fr; gap: 4px 20px;
  margin: 12px 0; max-width: 100ch; }
dl.glossary dt { font-weight: 700; }
dl.glossary dd { margin: 0 0 12px; }
@media (max-width: 640px) {
  dl.glossary { grid-template-columns: 1fr; gap: 0; }
  dl.glossary dt { margin-top: 10px; }
}
.callout { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--accent);
  border-radius: 0 8px 8px 0; padding: 12px 16px; margin: 12px 0; }
.callout h3 { margin-top: 0; }
.provisional { background: var(--provisional); border: 1px solid var(--provisional-line);
  border-radius: 8px; padding: 12px 16px; }
.provisional.empty { opacity: 0.95; }
.ref-maps { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 18px; }
.placeholder-box { border: 1px dashed var(--line); border-radius: 6px; padding: 34px 12px; text-align: center;
  color: var(--muted); font-size: 12px; }
.finding { font-size: 13px; }
.note { background: var(--grid); border-radius: 6px; padding: 10px 12px; font-size: 13px; max-width: 82ch; }
.notes li, .unscored li { margin-bottom: 8px; }
.unscored { padding-left: 18px; }
details summary { cursor: pointer; color: var(--accent); font-size: 13px; }
.gate-id { display: flex; align-items: center; gap: 8px; }
`;

// ---------------------------------------------------------------------------
// Loading and writing
// ---------------------------------------------------------------------------

export interface ProgressPaths {
  repoRoot: string;
  resultsFile: string;
  outFile: string;
  roundsFile: string;
  referenceFile: string;
  previousResultsFile: string;
  previousImageDir: string;
  experimentsDir: string;
}

export function defaultPaths(repoRoot: string): ProgressPaths {
  return {
    repoRoot,
    resultsFile: path.join(repoRoot, 'bench-results.json'),
    outFile: path.join(repoRoot, 'progress', 'index.html'),
    roundsFile: path.join(repoRoot, 'progress', 'rounds.json'),
    referenceFile: path.join(repoRoot, REFERENCE_RELATIVE_PATH),
    previousResultsFile: path.join(repoRoot, 'progress', 'data', 'best-results.json'),
    previousImageDir: path.join(repoRoot, 'progress', 'data', 'best'),
    experimentsDir: path.join(repoRoot, 'progress', 'experiments'),
  };
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * The previous best round's renders live in `progress/data/best/`, keyed by the
 * same basename the results file records. `loop.ts` copies them there when a
 * round becomes the best, because the round-by-round PNGs are overwritten in
 * place and a before/after pair built from overwritten files would compare a
 * round against itself.
 */
function bestImageStore(dir: string): ImageStore {
  const inner = imageStoreFromDisk(dir);
  return { get: (relPath: string): string | null => inner.get(path.basename(relPath)) };
}

export function loadProgressInput(paths: ProgressPaths): ProgressInput {
  const results = readJson<BenchResults>(paths.resultsFile);
  if (results === null) {
    throw new Error(
      `progress: no results at ${paths.resultsFile}. Run the bench first: node packages/bench/src/cli.ts`,
    );
  }
  const rounds = readJson<RoundHistory>(paths.roundsFile);
  const reference = loadCoverageReference(paths.referenceFile);

  const previousResults = readJson<BenchResults>(paths.previousResultsFile);
  const previous: PreviousRound | null =
    previousResults === null || previousResults.env?.generatedAt === results.env.generatedAt
      ? null
      : {
          label: `seed ${previousResults.run.seed}, ${previousResults.env.generatedAt.slice(0, 10)}`,
          results: previousResults,
          images: bestImageStore(paths.previousImageDir),
        };

  const experiments: ExperimentReport[] = [];
  for (const slot of EXPERIMENT_SLOTS) {
    const report = readJson<ExperimentReport>(path.join(paths.experimentsDir, `${slot.id}.json`));
    if (report !== null && Array.isArray(report.series)) experiments.push({ ...report, id: slot.id });
  }

  return {
    results,
    images: imageStoreFromDisk(paths.repoRoot),
    rounds: rounds !== null && rounds.schema === ROUNDS_SCHEMA ? rounds : null,
    reference,
    previous,
    experiments,
    generatedAt: new Date().toISOString(),
  };
}

export function writeProgressPage(paths: ProgressPaths): { file: string; bytes: number } {
  const html = renderProgressPage(loadProgressInput(paths));
  fs.mkdirSync(path.dirname(paths.outFile), { recursive: true });
  fs.writeFileSync(paths.outFile, html);
  return { file: paths.outFile, bytes: Buffer.byteLength(html) };
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function main(): void {
  const argv = process.argv.slice(2);
  const paths = defaultPaths(repoRoot());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`progress: ${a} needs a value`);
      return path.resolve(paths.repoRoot, v);
    };
    switch (a) {
      case '--results':
        paths.resultsFile = next();
        break;
      case '--out':
        paths.outFile = next();
        break;
      case '--rounds':
        paths.roundsFile = next();
        break;
      case '--reference':
        paths.referenceFile = next();
        break;
      default:
        throw new Error(`progress: unknown argument '${a}'`);
    }
  }
  const written = writeProgressPage(paths);
  process.stdout.write(
    `progress: written ${path.relative(paths.repoRoot, written.file)} (${(written.bytes / 1024 / 1024).toFixed(2)} MB)\n`,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
