// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What a straddled photograph integrated, what the page's reader makes of it,
 * and how a run, a position and a capture are scored. Pure: nothing here reads
 * or writes a file, renders a frame or solves, so every stage can be re-scored
 * from its checkpoint without re-running anything.
 *
 * ## A photograph is a list of parts, per camera row
 *
 * EXPERIMENT-9 reduced a shutter opening to a yes or a no — did a step boundary
 * fall inside the exposure. `exposureBlend` (tether/run.ts) keeps what that
 * reduction threw away: which emitter steps the exposure overlapped, and for
 * what fraction of it. {@link pageParts} then maps those steps onto what the
 * PAGE had lit at the time, which is not the same thing as the step number:
 *
 *   - before Play the page is already showing step 0 — `start()` paints it
 *     silently and the first advance is Play plus one dwell — so a part before
 *     Play is step 0, and EXPERIMENT-9's before-Play "straddles" are clean;
 *   - after the last step the page paints black and stops, so a part past step
 *     135 is `'dark'`;
 *   - a step on another projector lights only that projector's quadrant, so it
 *     contributes that projector's light and nothing of this one's pattern.
 *
 * Parts naming the same lit state are merged. A photograph is CONTENT-CHANGED
 * when any row's merged parts are anything but its filed step, whole.
 *
 * ## Why this file never re-implements the page
 *
 * This project once "re-measured" a number with a probe that carried its own
 * stale copy of a reducer. So every question the page answers is put to the
 * page's own code: the step list is `emitOrder`, the kinds are the manifest's,
 * the complement check is `indexByFingerprint`, a pair residual is
 * `complementResidual`. What is new here is only what the page has no opinion
 * on — how an exposure maps to parts, and how outcomes are tallied — and the
 * tallies are written to be checked against independent counts
 * (`straddle.test.ts`), not against themselves.
 *
 * ## What is NOT established here
 *
 * The oracle observations ({@link oracleObservations}) are exact lit fractions,
 * EXPERIMENT-8's footing. Today's page cannot supply them — its capture-wide
 * classification refuses clean bench positions before the complement check
 * runs — so every verdict built on them is the verdict of a counterfactual
 * reader whose bookends can place runs. It is labelled that way where it is
 * reported, and no fix to the page is implied by it.
 */

import type { ExposurePart, ShutterStraddle } from '../../../bench/src/capture.ts';
import { planFrames } from '../../../bench/src/patterns.ts';
import type { LinearImage } from '../../../solver/src/decode.ts';
import type { EncodedImage } from '../../../solver/src/ingest.ts';
import {
  COMPLEMENT_LIMIT,
  MODULATION_FLOOR,
  complementResidual,
  indexByBookends,
  indexByFingerprint,
  type FrameFingerprint,
  type FrameKind,
  type FrameObservation,
  type IndexingResult,
} from '../../../solver/src/indexing.ts';
import type { EmitStep } from '../../../web/src/emit.ts';
import { exposureBlend, straddles, type BlendPart, type ShotTiming } from '../tether/run.ts';
import {
  EXPECTED,
  FRAMES_PER_RUN,
  GATE_SCAN,
  GRID_GATE_MM,
  MARGINAL_RESIDUAL,
  MINOR_RUN_CORR,
  ORACLE_LIT,
  PLAN,
  PROJECTORS,
  ROTATION_GATE_DEG,
  STEPS,
} from './design.ts';

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** What the page had lit: one projector's frame, or its black after the last step. */
export type LitState = { projector: number; frame: number } | 'dark';

/** One lit state a photograph integrated, and for what fraction of its exposure. */
export interface PagePart {
  /** The page's step, 0 to `STEPS.length`; `STEPS.length` (136) is the dark after the last step. */
  step: number;
  state: LitState;
  /** Positive; one row's parts sum to 1 within 1e-9, and a lone part is exactly 1. */
  weight: number;
}

/**
 * An exposure's overlap with the emitter's steps, as what the page lit.
 *
 * Steps before Play (`m < 0`) are step 0, because the page shows step 0 from
 * Start; steps past the last (`m >= steps.length`) are `'dark'`, because
 * `advance()` paints black and stops. Parts that land on the same state are
 * merged, in step order, and a photograph left with one part gets a weight of
 * exactly 1 — so the renderer hands the sensor the clean frame's own value
 * rather than 0.9999999999999999 of it.
 *
 * Throws on a weight that is not a positive fraction or on weights that do not
 * sum to one: `exposureBlend` never returns either, so either is a caller bug
 * that would otherwise render as a plausibly dim or bright photograph.
 */
export function pageParts(blend: readonly BlendPart[], steps: readonly EmitStep[]): PagePart[] {
  const dark = steps.length;
  const out: PagePart[] = [];
  let sum = 0;
  for (const part of blend) {
    if (!(Number.isFinite(part.weight) && part.weight > 0)) {
      throw new Error(`pageParts: step ${part.step} has weight ${part.weight}; a part is a positive fraction`);
    }
    if (!Number.isInteger(part.step)) throw new Error(`pageParts: step ${part.step} is not a step`);
    sum += part.weight;
    const step = part.step < 0 ? 0 : part.step >= dark ? dark : part.step;
    const same = out.find((p) => p.step === step);
    if (same !== undefined) {
      same.weight += part.weight;
      continue;
    }
    const shown = steps[step];
    out.push({
      step,
      state: step === dark ? 'dark' : { projector: shown.projector, frame: shown.frame },
      weight: part.weight,
    });
  }
  if (out.length === 0 || !(Math.abs(sum - 1) <= 1e-9)) {
    throw new Error(`pageParts: the parts sum to ${sum}, and one exposure's parts sum to 1`);
  }
  if (out.length === 1) out[0].weight = 1;
  return out;
}

/** One photograph of a camera position: the step it is filed as, and what each camera row integrated. */
export interface Photo {
  /** The step the folder files it as: its place among the position's releases (F136). */
  filedStep: number;
  /**
   * Parts per camera row, row 0 read first. Length 1 when every row integrated
   * the same thing (a global shutter); otherwise one entry per row. Rows that
   * integrated the same thing share one array.
   */
  rows: PagePart[][];
}

/** The parts camera row `row` of a photograph integrated. */
export function rowParts(photo: Photo, row: number): PagePart[] {
  return photo.rows.length === 1 ? photo.rows[0] : photo.rows[row];
}

/**
 * The photographs of one camera position, from EXPERIMENT-9's shots.
 *
 * Photograph `j` of the position is filed as step `j` — EXPERIMENT-9's folder
 * model, exactly 136 photographs, the first the first release after Play — and
 * camera row `r` of it integrates `[open + readout·r/(H-1), ... + exposure)`:
 * a rolling readout moves each row's exposure later, row 0 first, as
 * `rowTimeSec` does (camera.ts). `lateS` and `jitter` move the emitter's steps
 * (`exposureBlend`); with both at their defaults this is EXPERIMENT-9's
 * perfect timer.
 */
export function positionPhotos(
  shots: readonly ShotTiming[],
  position: number,
  exposureS: number,
  dwellS: number,
  lateS: number,
  jitter: ((m: number) => number) | null,
  readoutS: number,
  height: number,
): Photo[] {
  const mine = shots.filter((s) => s.position === position);
  // F136, checked: a position of any other length would file photographs under
  // steps that do not match what they are, and every count below would be off.
  if (mine.length !== STEPS.length || mine.some((s, j) => s.filedStep !== j)) {
    throw new Error(
      `positionPhotos: position ${position} holds ${mine.length} shots; a position is ` +
        `${STEPS.length} releases, filed in order as steps 0-${STEPS.length - 1}`,
    );
  }
  if (!(readoutS >= 0)) throw new Error(`positionPhotos: readout ${readoutS} s`);
  if (readoutS > 0 && !(Number.isInteger(height) && height >= 2)) {
    throw new Error(`positionPhotos: a rolling readout needs a height of at least 2 rows, got ${height}`);
  }
  return mine.map((shot) => {
    const at = (open: number): PagePart[] =>
      pageParts(exposureBlend(open, exposureS, dwellS, lateS, jitter), STEPS);
    if (readoutS === 0) return { filedStep: shot.filedStep, rows: [at(shot.open)] };
    const rows: PagePart[][] = [];
    for (let r = 0; r < height; r++) {
      const parts = at(shot.open + (readoutS * r) / (height - 1));
      const prev = rows[r - 1];
      rows.push(prev !== undefined && sameParts(prev, parts) ? prev : parts);
    }
    return { filedStep: shot.filedStep, rows: rows.every((r) => r === rows[0]) ? [rows[0]] : rows };
  });
}

function sameParts(a: readonly PagePart[], b: readonly PagePart[]): boolean {
  return a.length === b.length && a.every((p, i) => p.step === b[i].step && p.weight === b[i].weight);
}

/**
 * A designed straddle of the whole position: every one of its 136 photographs,
 * references included, at the smear `smearAtRow(row)`.
 *
 *   - forward: photograph `k` integrates step `k` for `1 - s` and step `k + 1`
 *     for `s`. The successor of the last step is `'dark'`, the page's black.
 *   - backward: photograph `k` integrates step `k - 1` for `s` and step `k` for
 *     `1 - s`. The predecessor of step 0 is step 0, lit before Play, so
 *     photograph 0 is clean.
 *
 * `height` 1 applies one smear to every row (a global shutter); a larger height
 * asks `smearAtRow` once per camera row, for a rolling readout. The steps go
 * through {@link pageParts}, so the two ends are the page's and not a rule
 * restated here.
 */
export function designedPhotos(
  dir: 'forward' | 'backward',
  smearAtRow: (row: number) => number,
  height: number,
): Photo[] {
  if (!(Number.isInteger(height) && height >= 1)) throw new Error(`designedPhotos: height ${height}`);
  const smears: number[] = [];
  for (let r = 0; r < height; r++) {
    const s = smearAtRow(r);
    if (!(s >= 0 && s <= 1)) throw new Error(`designedPhotos: row ${r} has smear ${s}, outside [0, 1]`);
    smears.push(s);
  }
  const photos: Photo[] = [];
  for (let k = 0; k < STEPS.length; k++) {
    const byS = new Map<number, PagePart[]>();
    const rows = smears.map((s) => {
      let parts = byS.get(s);
      if (parts === undefined) {
        const blend: BlendPart[] =
          dir === 'forward'
            ? [
                { step: k, weight: 1 - s },
                { step: k + 1, weight: s },
              ]
            : [
                { step: k - 1, weight: s },
                { step: k, weight: 1 - s },
              ];
        parts = pageParts(
          blend.filter((p) => p.weight > 0),
          STEPS,
        );
        byS.set(s, parts);
      }
      return parts;
    });
    photos.push({ filedStep: k, rows: rows.every((r) => r === rows[0]) ? [rows[0]] : rows });
  }
  return photos;
}

/** True when any row integrated anything but the filed step, whole. */
export function contentChanged(p: Photo): boolean {
  return p.rows.some((row) => !(row.length === 1 && row[0].step === p.filedStep));
}

/** The kind of what the page lit at a step, from the manifest's own kinds; the dark counts as black. */
export function stepKind(step: number): FrameKind {
  if (step >= STEPS.length) return 'black';
  const shown = STEPS[step];
  if (shown === undefined) throw new Error(`stepKind: no step ${step}`);
  return EXPECTED.kinds[shown.frame];
}

/**
 * Exact observations for the isolated complement check: `{ordinal, mean: lit,
 * litFraction: lit}` with EXPERIMENT-8's lit fractions.
 *
 * Two footings, always both reported:
 *
 *   - `'content'` (primary, EXPERIMENT-8's footing extended to blends): the kind
 *     of the part that held more than half the exposure. A photograph with no
 *     such part — an exact 0.5/0.5 tie, or a split three ways — takes its filed
 *     step's kind. Under a rolling readout a part's share is its weight averaged
 *     over the rows, which is its share of the photograph's integrated light-time.
 *   - `'filed'` (secondary): the kind of the filed step, whatever was integrated.
 *
 * Ordinals are positions in `photos`, so fingerprints must carry the same.
 */
export function oracleObservations(photos: readonly Photo[], footing: 'content' | 'filed'): FrameObservation[] {
  return photos.map((photo, ordinal) => {
    let step = photo.filedStep;
    if (footing === 'content') {
      const share = new Map<number, number>();
      for (const row of photo.rows) {
        for (const part of row) share.set(part.step, (share.get(part.step) ?? 0) + part.weight / photo.rows.length);
      }
      for (const [s, w] of share) if (w > 0.5) step = s;
    }
    const lit = ORACLE_LIT[stepKind(step)];
    return { ordinal, mean: lit, litFraction: lit };
  });
}

/**
 * The complement check in isolation: `indexByFingerprint` on these
 * fingerprints, with oracle observations on the given footing, against the
 * page's own expected sequence. A counterfactual reader; see the header.
 */
export function isolatedCheck(
  fingerprints: readonly FrameFingerprint[],
  photos: readonly Photo[],
  footing: 'content' | 'filed',
): IndexingResult {
  return indexByFingerprint(oracleObservations(photos, footing), fingerprints, EXPECTED);
}

/**
 * Which photograph is decoded at each of the position's frames: index `p·34 + f`
 * holds the folder position of the photograph decoded as projector `p`'s frame
 * `f`.
 *
 * With `assignment` null that is the photograph filed there. With an assignment
 * (`IndexingResult.assignment`, a global frame per photograph) it is the one the
 * bookends ASSIGNED there, which is what the page would decode; a frame no
 * photograph was assigned to, because its run was not placed, falls back to the
 * filed one, so the capture stays whole and can still be audited.
 *
 * The one statement of that rule: the renderer's hook and the bank's fast path
 * both read it, so the two cannot decode different photographs at one frame.
 */
export function decodedPhotographs(
  photos: readonly Photo[],
  assignment: readonly (number | null)[] | null,
): number[] {
  if (photos.length !== STEPS.length || photos.some((p, j) => p.filedStep !== j)) {
    throw new Error(`decodedPhotographs: a position is ${STEPS.length} photographs filed in order`);
  }
  const photoFor = STEPS.map((_, k) => k);
  if (assignment === null) return photoFor;
  if (assignment.length !== photos.length) {
    throw new Error(`decodedPhotographs: ${assignment.length} assignments for ${photos.length} photographs`);
  }
  const seen = new Set<number>();
  assignment.forEach((frame, j) => {
    if (frame === null) return;
    if (!(Number.isInteger(frame) && frame >= 0 && frame < STEPS.length) || seen.has(frame)) {
      throw new Error(`decodedPhotographs: photograph ${j} is assigned frame ${frame}, which is not a free frame`);
    }
    seen.add(frame);
    photoFor[frame] = j;
  });
  return photoFor;
}

/**
 * The renderer's hook for one camera: what the photograph decoded as
 * `(camera, projector, frame)` integrated, row by row — which photograph that
 * is, is {@link decodedPhotographs}'s rule.
 *
 * Returns null for another camera, and for a row that integrated exactly the
 * frame it is decoded as, so that row is today's render bit for bit. Each
 * distinct row is converted once and the same array returned every time,
 * because the renderer validates a parts array once, by identity.
 */
export function straddleForCamera(
  camera: number,
  photos: readonly Photo[],
  assignment: readonly (number | null)[] | null,
): ShutterStraddle {
  const photoFor = decodedPhotographs(photos, assignment);
  const converted = new Map<PagePart[], ExposurePart[]>();
  const partsOf = (row: PagePart[]): ExposurePart[] => {
    let out = converted.get(row);
    if (out === undefined) {
      out = row.map((part) => ({
        weight: part.weight,
        shown: part.state === 'dark' ? 'dark' : { projector: part.state.projector, frame: part.state.frame },
      }));
      converted.set(row, out);
    }
    return out;
  };
  return {
    parts(c: number, p: number, f: number, row: number): readonly ExposurePart[] | null {
      if (c !== camera) return null;
      if (!(Number.isInteger(p) && p >= 0 && p < PROJECTORS && Number.isInteger(f) && f >= 0 && f < FRAMES_PER_RUN)) {
        throw new Error(`straddleForCamera: asked for projector ${p}, frame ${f}, which the page never shows`);
      }
      const frame = p * FRAMES_PER_RUN + f;
      const parts = rowParts(photos[photoFor[frame]], row);
      if (parts === undefined) throw new Error(`straddleForCamera: no row ${row}`);
      if (parts.length === 1 && parts[0].step === frame) return null;
      return partsOf(parts);
    },
  };
}

// ---------------------------------------------------------------------------
// Runs, positions and captures
// ---------------------------------------------------------------------------

/** Positions within a run of the phase frames, from the plan rather than as 26-33. */
export const PHASE_FRAMES: readonly number[] = planFrames(PLAN).flatMap((spec, f) => (spec.kind === 'phase' ? [f] : []));

export type RunOutcomeKind =
  | 'placed'
  | 'refused-complement'
  | 'refused-unanswered'
  | 'refused-bookends-length'
  | 'refused-bookends-kind'
  | 'refused-bookends-count'
  | 'refused-classify';

/** What the isolated check did to one run of a treated position, and why it matters. */
export interface RunOutcome10 {
  projector: number;
  /** A photograph filed in this run's 34 steps is content-changed. */
  touched: boolean;
  /** The twin — the same capture unstraddled, on the same noise — placed this run. */
  attributable: boolean;
  /**
   * A photograph at one of the run's phase frames is content-changed: the ones
   * the check assigned there when it placed the run, the filed ones otherwise.
   */
  phaseTouched: boolean;
  outcome: RunOutcomeKind;
  /** `refused-complement` only: the pair the page named, as positions in the run. */
  brokenPair: readonly [number, number] | null;
  /** `refused-complement` only: the page's own figure for it, a whole percentage. */
  brokenPercent: number | null;
  /**
   * `refused-complement` with evidence only: the pair's exact residual, by
   * `complementResidual` on the photographs the bookends placed in the run.
   */
  brokenResidual: number | null;
  /** Untouched, attributable, and refused: a neighbour's straddle moved its bookends. */
  collateral: boolean;
  /**
   * Touched, attributable, refused, and not phase-touched. Harness identity H5
   * says a lone straddled photograph at frames 0-25, below s = 0.4, moves no
   * coordinate, so such a refusal cost a run that would have decoded right.
   * Established one straddled photograph at a time (`straddle.test.ts`, T19),
   * not for every combination of them.
   */
  falseAlarm: boolean;
}

/** One problem the indexer wrote, read back into what it refused. */
type Refusal =
  | { scope: 'position'; kind: 'refused-bookends-count' | 'refused-classify' }
  | { scope: 'run'; run: number; kind: RunOutcomeKind; pair: readonly [number, number] | null; percent: number | null }
  | { scope: 'none' };

/**
 * The indexer's problems, read back by the words `indexing.ts` writes.
 *
 * Every line has to be recognised: one that is not throws, naming it, so a
 * reworded message stops the experiment rather than being tallied as nothing.
 * Refusals that mean the harness handed the indexer something malformed —
 * fingerprints of the wrong grid, out of order, a plan without pairs — throw
 * too, because they are this experiment's bugs and not a straddle's cost.
 */
function readProblem(line: string): Refusal {
  let m: RegExpMatchArray | null;
  if (/^\d+ photograph\(s\) sit before the first white frame\./.test(line)) return { scope: 'none' };
  if (/^Found \d+ projector runs and the capture should hold \d+\./.test(line)) {
    return { scope: 'position', kind: 'refused-bookends-count' };
  }
  if (/^The white and black frames cannot be reliably told from the patterned ones/.test(line)) {
    return { scope: 'position', kind: 'refused-classify' };
  }
  if ((m = line.match(/^Projector (\d+)'s run holds \d+ photographs and should hold \d+\./)) !== null) {
    return { scope: 'run', run: Number(m[1]) - 1, kind: 'refused-bookends-length', pair: null, percent: null };
  }
  if ((m = line.match(/^Projector (\d+)'s run is the right length but frame \d+ looks like a /)) !== null) {
    return { scope: 'run', run: Number(m[1]) - 1, kind: 'refused-bookends-kind', pair: null, percent: null };
  }
  m = line.match(
    /^Projector (\d+)'s frames (\d+) and (\d+) were played as a pattern and its complement, and they no longer add up to one: they miss the run's own white and black by (\d+)% of its modulation/,
  );
  if (m !== null) {
    return {
      scope: 'run',
      run: Number(m[1]) - 1,
      kind: 'refused-complement',
      pair: [Number(m[2]) - 1, Number(m[3]) - 1],
      percent: Number(m[4]),
    };
  }
  if ((m = line.match(/^Projector (\d+)'s run could not be checked:/)) !== null) {
    return { scope: 'run', run: Number(m[1]) - 1, kind: 'refused-unanswered', pair: null, percent: null };
  }
  throw new Error(`runVerdicts: the indexer said something this experiment does not recognise: ${line}`);
}

/**
 * Each run's outcome in a treated position, against its twin.
 *
 * `twinPlaced` is the runs the isolated check placed on the TWIN — the same
 * capture without the straddle, on the same noise stream — and it is what
 * makes a refusal the straddle's own: a run the twin refuses too (an invisible
 * or grazing projector) is refused anyway, whatever the straddle did.
 *
 * `evidence`, when given, must be what `result` was computed from; it is used
 * only to recompute a broken pair's exact residual, with the indexer's own
 * `indexByBookends` locating the run and `complementResidual` measuring it.
 */
export function runVerdicts(
  result: IndexingResult,
  photos: readonly Photo[],
  twinPlaced: readonly number[],
  evidence?: { observations: readonly FrameObservation[]; fingerprints: readonly FrameFingerprint[] },
): RunOutcome10[] {
  if (result.mechanism !== 'fingerprint') throw new Error(`runVerdicts: a ${result.mechanism} result is not the complement check`);
  if (photos.length !== STEPS.length || result.assignment.length !== photos.length) {
    throw new Error(`runVerdicts: ${photos.length} photographs and ${result.assignment.length} assignments; a position is ${STEPS.length}`);
  }
  const refusals = result.problems.map(readProblem);
  const whole = refusals.find((r) => r.scope === 'position');
  const byRun = new Map<number, Extract<Refusal, { scope: 'run' }>>();
  for (const r of refusals) {
    if (r.scope !== 'run') continue;
    if (byRun.has(r.run)) throw new Error(`runVerdicts: projector ${r.run + 1} was refused twice`);
    byRun.set(r.run, r);
  }

  const bookends =
    evidence === undefined ? null : indexByBookends(evidence.observations, EXPECTED).assignment;
  const whiteAt = EXPECTED.kinds.indexOf('white');
  const blackAt = EXPECTED.kinds.indexOf('black');

  const out: RunOutcome10[] = [];
  for (let p = 0; p < PROJECTORS; p++) {
    const from = p * FRAMES_PER_RUN;
    let touched = false;
    for (let f = 0; f < FRAMES_PER_RUN; f++) if (contentChanged(photos[from + f])) touched = true;
    const placed = result.usableProjectors.includes(p);
    let phaseTouched = false;
    for (const f of PHASE_FRAMES) {
      const at = placed ? result.assignment.indexOf(from + f) : from + f;
      if (at < 0) throw new Error(`runVerdicts: placed run ${p + 1} has no photograph at frame ${f + 1}`);
      if (contentChanged(photos[at])) phaseTouched = true;
    }

    let outcome: RunOutcomeKind = 'placed';
    let brokenPair: readonly [number, number] | null = null;
    let brokenPercent: number | null = null;
    let brokenResidual: number | null = null;
    const own = byRun.get(p);
    if (placed) {
      if (own !== undefined || whole !== undefined) throw new Error(`runVerdicts: run ${p + 1} was placed and refused`);
    } else if (whole !== undefined) {
      outcome = whole.kind;
    } else if (own !== undefined) {
      outcome = own.kind;
      brokenPair = own.pair;
      brokenPercent = own.percent;
      if (own.pair !== null && evidence !== undefined && bookends !== null) {
        const start = bookends.indexOf(from);
        if (start < 0) throw new Error(`runVerdicts: the bookends did not place run ${p + 1}, yet it reached the pairs`);
        const fps = evidence.fingerprints;
        brokenResidual = complementResidual(
          fps[start + own.pair[0]],
          fps[start + own.pair[1]],
          fps[start + whiteAt],
          fps[start + blackAt],
        );
      }
    } else {
      throw new Error(`runVerdicts: run ${p + 1} was neither placed nor refused`);
    }

    const attributable = twinPlaced.includes(p);
    const refused = outcome !== 'placed';
    out.push({
      projector: p,
      touched,
      attributable,
      phaseTouched,
      outcome,
      brokenPair,
      brokenPercent,
      brokenResidual,
      collateral: !touched && attributable && refused,
      falseAlarm: touched && attributable && refused && !phaseTouched,
    });
  }
  return out;
}

/** What the twin — the unstraddled capture — says about one run. */
export interface TwinStatus {
  projector: number;
  /** The isolated check placed it. */
  placed: boolean;
  /** The worst of its pair residuals; null when a pair could not be answered. */
  worstResidual: number | null;
  /** Its clean page-path correspondences, or null when they were not decoded. */
  correspondences: number | null;
}

/** Placed on the twin, with its worst residual within `MARGINAL_BAND` of the limit. */
export function isMarginal(t: TwinStatus): boolean {
  return t.placed && t.worstResidual !== null && t.worstResidual > MARGINAL_RESIDUAL;
}

/** Fewer clean page-path correspondences than a run worth solving from. */
export function isMinor(t: TwinStatus): boolean {
  if (t.correspondences === null) throw new Error(`isMinor: run ${t.projector + 1} was never decoded`);
  return t.correspondences < MINOR_RUN_CORR;
}

export type PositionCategory = 'UNTOUCHED' | 'UNCHANGED' | 'INVISIBLE-ONLY' | 'REFUSED-ALL' | 'MIXED' | 'PLACED';

/**
 * A camera position's category, reported side by side and never ranked.
 *
 *   - UNTOUCHED: no photograph changed, and EXPERIMENT-9 did not flag it;
 *   - UNCHANGED: EXPERIMENT-9's `straddles()` flagged it (`exp9Flagged`), and
 *     no photograph changed — its only straddles were before Play;
 *   - INVISIBLE-ONLY: only runs the twin refuses anyway were touched;
 *   - REFUSED-ALL / MIXED / PLACED: of the touched attributable runs, every one
 *     refused / some of each / every one placed. PLACED is SILENT.
 *
 * `excludeMinorMarginal` narrows "attributable" to runs whose twin is neither
 * minor nor marginal, so a position whose only touched attributable runs are
 * minor or marginal reads INVISIBLE-ONLY there: nothing robust was touched.
 */
export function classifyPosition(
  outcomes: readonly RunOutcome10[],
  twin: readonly TwinStatus[],
  options: { exp9Flagged?: boolean; excludeMinorMarginal?: boolean } = {},
): PositionCategory {
  if (outcomes.length !== PROJECTORS) throw new Error(`classifyPosition: ${outcomes.length} runs, not ${PROJECTORS}`);
  const counted = outcomes.filter((o) => {
    const t = twin.find((x) => x.projector === o.projector);
    if (t === undefined) throw new Error(`classifyPosition: no twin for run ${o.projector + 1}`);
    // Two statements of one fact, so they are held to each other: a twin that
    // disagrees with the attribution the outcome was computed from is a
    // bookkeeping fault, and would move runs between categories silently.
    if (t.placed !== o.attributable) throw new Error(`classifyPosition: run ${o.projector + 1}'s twin disagrees with its attribution`);
    if (!o.touched || !o.attributable) return false;
    return !(options.excludeMinorMarginal === true && (isMinor(t) || isMarginal(t)));
  });
  if (!outcomes.some((o) => o.touched)) return options.exp9Flagged === true ? 'UNCHANGED' : 'UNTOUCHED';
  if (counted.length === 0) return 'INVISIBLE-ONLY';
  const refused = counted.filter((o) => o.outcome !== 'placed').length;
  if (refused === 0) return 'PLACED';
  if (refused === counted.length) return 'REFUSED-ALL';
  return 'MIXED';
}

/** What a straddle did to the solve, paired against its twin. See the spec's §3.8. */
export interface Harm {
  /** D_grid: how far the straddle moved the seams, twin against treated, mm. */
  dGridMm: number;
  /** τ_null: the 95th percentile of D_grid between a twin and its re-shoots, mm. */
  tauNullMm: number;
  /** `grid_displacement` against truth, twin and treated, with their censoring. */
  gTwinMm: number;
  gTwinCensored: boolean;
  gTreatedMm: number;
  gTreatedCensored: boolean;
  /** `recovery.aligned.maxRotationDeg`, twin and treated. */
  rotationTwinDeg: number;
  rotationTreatedDeg: number;
}

export type HarmClass = 'HARMLESS' | 'BIASED' | 'GATE-BREAKING';

/**
 * GATE-BREAKING when the straddle alone pushed the seams past the §7 grid gate
 * (twin at or under it, treated over it, neither censored); otherwise BIASED
 * when it moved them further than a re-shoot does, HARMLESS when not.
 *
 * The spec's HARMLESS (D_grid <= τ_null) and GATE-BREAKING overlap when a flip
 * happens within re-shoot noise. The flip is given precedence, because a gate
 * that changes its verdict is the thing an operator would see.
 * `withinReshootNoise` in {@link CaptureCategory} carries the overlap, and the
 * document tallies it per cell (`classes.*.solved.withinReshootNoise`). The
 * first full run's document did not: this comment said the overlap was
 * reported while nothing read the field.
 */
export function harmClass(h: Harm): HarmClass {
  if (!h.gTwinCensored && !h.gTreatedCensored && h.gTwinMm <= GRID_GATE_MM && h.gTreatedMm > GRID_GATE_MM) {
    return 'GATE-BREAKING';
  }
  return h.dGridMm > h.tauNullMm ? 'BIASED' : 'HARMLESS';
}

export type CaptureClass =
  | 'LOUD'
  | 'SILENT-HARMLESS'
  | 'SILENT-BIASED'
  | 'SILENT-GATE-BREAKING'
  | 'SILENT-UNSOLVED'
  | 'INVISIBLE-ONLY'
  | 'UNCHANGED'
  | 'UNTOUCHED';

export interface CaptureCategory {
  policy: 'P' | 'A';
  class: CaptureClass;
  /**
   * LOUD, and a straddle still reaches the calibration. Under P (re-shoot a
   * refused position whole) that is another position PLACED; under A (keep a
   * MIXED position's placed runs) a MIXED position counts too.
   */
  loudAndSilent: boolean;
  /** The harm of what reached the calibration, when it was solved; null otherwise. */
  harm: HarmClass | null;
  /** D_grid within re-shoot noise, when solved: the overlap `harmClass` resolves. */
  withinReshootNoise: boolean | null;
  /** The straddle alone pushed the §7 rotation gate over, when solved. Flagged, not a class. */
  rotationGateFlipped: boolean | null;
}

/**
 * One capture's class from its positions and, when it was solved, its harm.
 *
 * LOUD when any position is REFUSED-ALL or MIXED: the operator is told, at the
 * desk, though what the page tells them (a dropped frame and a duplicated one,
 * re-shoot one projector) is neither the cause nor a remedy it can read back.
 * SILENT when nothing was refused and a position is PLACED, split by harm, or
 * SILENT-UNSOLVED where no solve was run. Otherwise INVISIBLE-ONLY, UNCHANGED
 * or UNTOUCHED, in that order. `harm` must be the solve of the policy asked
 * about; it is ignored where nothing silent reached the calibration.
 */
export function classifyCapture(
  positions: readonly PositionCategory[],
  harm: Harm | null,
  policy: 'P' | 'A',
): CaptureCategory {
  const has = (c: PositionCategory): boolean => positions.includes(c);
  const loud = has('REFUSED-ALL') || has('MIXED');
  const silentPart = policy === 'P' ? has('PLACED') : has('PLACED') || has('MIXED');
  const judged = silentPart && harm !== null ? harm : null;
  const cat = (c: CaptureClass, loudAndSilent: boolean, h: Harm | null): CaptureCategory => ({
    policy,
    class: c,
    loudAndSilent,
    harm: h === null ? null : harmClass(h),
    withinReshootNoise: h === null ? null : h.dGridMm <= h.tauNullMm,
    rotationGateFlipped:
      h === null ? null : h.rotationTwinDeg <= ROTATION_GATE_DEG && h.rotationTreatedDeg > ROTATION_GATE_DEG,
  });
  if (loud) return cat('LOUD', silentPart, judged);
  if (has('PLACED')) {
    if (judged === null) return cat('SILENT-UNSOLVED', false, null);
    const c = harmClass(judged);
    return cat(c === 'HARMLESS' ? 'SILENT-HARMLESS' : c === 'BIASED' ? 'SILENT-BIASED' : 'SILENT-GATE-BREAKING', false, judged);
  }
  if (has('INVISIBLE-ONLY')) return cat('INVISIBLE-ONLY', false, null);
  if (has('UNCHANGED')) return cat('UNCHANGED', false, null);
  return cat('UNTOUCHED', false, null);
}

// ---------------------------------------------------------------------------
// The page's 8-bit read path
// ---------------------------------------------------------------------------

/** 12-bit levels, the sensor's own quantisation, for which the encode keeps a table. */
const LUT_LEVELS = 4096;

/** IEC 61966-2-1's forward transfer, the inverse of `decodeTransfer`'s sRGB branch. */
function srgbEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function toByte(c: number, toneKappa: number): number {
  const x = c < 0 ? 0 : c > 1 ? 1 : c;
  let e = srgbEncode(x);
  if (toneKappa !== 0) e = (1 - toneKappa) * e + toneKappa * (3 * e * e - 2 * e * e * e);
  return Math.round(255 * e);
}

/**
 * A linear frame as the 8-bit sRGB bytes a camera file would carry: one grey
 * channel, `round(255·srgb(value / fullScale))`, clamped to [0, 1] first.
 *
 * The page reads photographs through a canvas, which hands it sRGB bytes, so
 * the question "does a straddle survive the page's own read path" has to be
 * asked of bytes, not of the renderer's floats. One channel stands in for the
 * canvas's RGBA with R = G = B; `straddle.test.ts` holds `summarisePhoto` to
 * that equivalence.
 *
 * A value sitting exactly on one of the sensor's 12-bit levels (as every noisy
 * frame's does) is looked up rather than recomputed; the table is built from
 * those very values, so it is a cache and never a second answer.
 *
 * `toneKappa` applies `TONE_CURVE`'s S-curve to the encoded value before it is
 * rounded — the mismatched-camera sensitivity case. 0, the default, is the
 * plain encode.
 */
export function encodeSrgb8(img: LinearImage, fullScale: number, toneKappa = 0): EncodedImage {
  if (img.channels !== 1) throw new Error(`encodeSrgb8: ${img.channels} channels; the bench renders one`);
  if (!(fullScale > 0)) throw new Error(`encodeSrgb8: full scale ${fullScale}`);
  const step = fullScale / (LUT_LEVELS - 1);
  const level = new Float64Array(LUT_LEVELS);
  const byte = new Uint8Array(LUT_LEVELS);
  for (let k = 0; k < LUT_LEVELS; k++) {
    level[k] = Math.fround(k * step);
    byte[k] = toByte(level[k] / fullScale, toneKappa);
  }
  const n = img.width * img.height;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = img.data[i];
    const k = Math.round(v / step);
    data[i] = k >= 0 && k < LUT_LEVELS && level[k] === v ? byte[k] : toByte(v / fullScale, toneKappa);
  }
  return { width: img.width, height: img.height, channels: 1, data, maxValue: 255 };
}

// ---------------------------------------------------------------------------
// The complement check, a run at a time
// ---------------------------------------------------------------------------

/** One run's fingerprints, in `planFrames` order: 34 of them. */
export type RunFingerprints = readonly FrameFingerprint[];

/**
 * Every complementary pair's residual in one run, against the run's own white
 * and black, by `complementResidual` — exactly the numbers `indexByFingerprint`
 * compares with the limit, in plan order, but all of them rather than up to
 * the first that fails.
 */
export function pairResiduals(run: RunFingerprints): (number | null)[] {
  if (run.length !== FRAMES_PER_RUN) throw new Error(`pairResiduals: ${run.length} fingerprints, a run is ${FRAMES_PER_RUN}`);
  const white = run[EXPECTED.kinds.indexOf('white')];
  const black = run[EXPECTED.kinds.indexOf('black')];
  return EXPECTED.complements.pairs.map(([a, b]) => complementResidual(run[a], run[b], white, black));
}

/**
 * The pair the check would refuse a run on, or -1 when it would place it: the
 * first pair over the limit, as `indexByFingerprint` names it, else the first
 * that could not be answered.
 */
export function failingPair(residuals: readonly (number | null)[]): number {
  const over = residuals.findIndex((r) => r !== null && r > COMPLEMENT_LIMIT);
  if (over >= 0) return over;
  return residuals.findIndex((r) => r === null);
}

/** The direct verdict: every pair answered and none over the limit. */
export function runPlaced(residuals: readonly (number | null)[]): boolean {
  return failingPair(residuals) < 0;
}

/**
 * Where a run starts to be refused, as the smear rises.
 *
 * `residualAt(s)` is the run's pair residuals at smear `s`. The run is checked
 * clean first (a run refused at 0 crosses at 0); then the smear is scanned on
 * `GATE_SCAN`'s grid to its end, and the first refusing bracket bisected to
 * `GATE_SCAN.resolution`. `s` is that bracket's midpoint, and `pair` the pair
 * refusing at its top, which is the binding pair unless two cross within the
 * resolution of each other. `nonMonotone` records a run the scan found placed
 * again after refusing it, where one crossing does not describe the run.
 *
 * `s` and `pair` are null for a run the scan never refused, rather than a
 * sentinel number a percentile could swallow.
 */
export function runCrossing(residualAt: (s: number) => readonly (number | null)[]): {
  s: number | null;
  pair: number | null;
  nonMonotone: boolean;
} {
  const at0 = failingPair(residualAt(0));
  if (at0 >= 0) return { s: 0, pair: at0, nonMonotone: false };
  const n = Math.round(GATE_SCAN.max / GATE_SCAN.step);
  let first = -1;
  let nonMonotone = false;
  for (let i = 1; i <= n; i++) {
    const refused = failingPair(residualAt(i * GATE_SCAN.step)) >= 0;
    if (refused && first < 0) first = i;
    else if (!refused && first >= 0) nonMonotone = true;
  }
  if (first < 0) return { s: null, pair: null, nonMonotone: false };
  let lo = (first - 1) * GATE_SCAN.step;
  let hi = first * GATE_SCAN.step;
  while (hi - lo > GATE_SCAN.resolution) {
    const mid = (lo + hi) / 2;
    if (failingPair(residualAt(mid)) >= 0) hi = mid;
    else lo = mid;
  }
  return { s: (lo + hi) / 2, pair: failingPair(residualAt(hi)), nonMonotone };
}

const SPECS = planFrames(PLAN);
const frameOf = (kind: string, axis: string | null, index: number): number => {
  const f = SPECS.findIndex((s) => s.kind === kind && s.axis === axis && s.index === index);
  if (f < 0) throw new Error(`straddle/run: the plan has no ${kind} ${axis ?? ''}${index}`);
  return f;
};
const WHITE_FRAME = frameOf('white', null, 0);
const BLACK_FRAME = frameOf('black', null, 0);
const U0_FRAME = frameOf('gray', 'u', 0);
const U1_FRAME = frameOf('gray', 'u', 1);

/**
 * How one run's modulation is spread over the four quarters of the projector's
 * u axis, from its clean fingerprints: A_1..A_4, the white-minus-black mass of
 * the blocks the check counts, split by where each block sits in u.
 *
 * A block's shares come from the two coarsest u planes' block means, as
 * fractions of its modulation: `g0` (the MSB, lit on the right half) and `g1`
 * (lit on the middle two quarters). A block spanning two ADJACENT quarters has
 * `f3 = min(g0, g1)`, `f4 = g0 - f3`, `f2 = g1 - f3`, `f1 = 1 - max(g0, g1)`;
 * a block spanning quarters that are not adjacent is not representable, and
 * nothing smaller than a quarter of the raster is. Blocks under the check's own
 * modulation floor are left out, as the check leaves them out.
 */
export function quarterMasses(fps: RunFingerprints): [number, number, number, number] {
  if (fps.length !== FRAMES_PER_RUN) throw new Error(`quarterMasses: ${fps.length} fingerprints, a run is ${FRAMES_PER_RUN}`);
  const W = fps[WHITE_FRAME];
  const B = fps[BLACK_FRAME];
  const G0 = fps[U0_FRAME];
  const G1 = fps[U1_FRAME];
  const usable = (i: number): boolean =>
    W.measured[i] === 1 && B.measured[i] === 1 && G0.measured[i] === 1 && G1.measured[i] === 1;
  let peak = 0;
  for (let i = 0; i < W.values.length; i++) if (usable(i)) peak = Math.max(peak, W.values[i] - B.values[i]);
  const A: [number, number, number, number] = [0, 0, 0, 0];
  if (!(peak > 0)) return A;
  const floor = MODULATION_FLOOR * peak;
  const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
  for (let i = 0; i < W.values.length; i++) {
    if (!usable(i)) continue;
    const a = W.values[i] - B.values[i];
    if (!(a >= floor)) continue;
    const g0 = clamp01((G0.values[i] - B.values[i]) / a);
    const g1 = clamp01((G1.values[i] - B.values[i]) / a);
    const f3 = Math.min(g0, g1);
    A[0] += a * (1 - Math.max(g0, g1));
    A[1] += a * (g1 - f3);
    A[2] += a * f3;
    A[3] += a * (g0 - f3);
  }
  return A;
}

/**
 * The smear at which pair u0 alone crosses the limit under a whole-run FORWARD
 * blend, from the quarter masses.
 *
 * Forward, pair u0's deviation is `s(1 - 2g0 + g1)` of a block's modulation —
 * `s`, `2s`, 0 and `s` on the four quarters — and the blended reference's
 * modulation is `(1 - s) - s·g0`. Setting their mass-weighted ratio to the
 * limit L gives `s = L·ΣA / (A1 + 2A2 + A4 + L·((A1 + A2) + 2(A3 + A4)))`,
 * which at equal masses is 12.24%.
 *
 * Pair u0 only: every other pair has its own successor and its own crossing,
 * and a run's crossing is the least of them. Backward has other algebra.
 *
 * Exact only while no block crosses the check's floor. The masses are summed
 * over the blocks that clear {@link MODULATION_FLOOR} of the CLEAN run's
 * brightest block, and `complementResidual` re-derives its floor from the
 * BLENDED references at every smear (`(1 - s) - s·g0` of a block's
 * modulation). A block near the floor can leave the sums as the smear rises,
 * which nothing here sees. The first full run measured the cost: at most
 * 0.00018 on every run whose u0 crossing is 0.20 or less, and up to 0.015 on
 * three runs that hold nearly all their modulation where pair u0 cannot
 * deviate, and that the check refuses on another pair first.
 */
export function u0Crossing(A: readonly [number, number, number, number]): number {
  const L = COMPLEMENT_LIMIT;
  const [a1, a2, a3, a4] = A;
  return (L * (a1 + a2 + a3 + a4)) / (a1 + 2 * a2 + a4 + L * (a1 + a2 + 2 * (a3 + a4)));
}

/**
 * A fingerprint of a blend, from the fingerprints of what it blends: block
 * means are linear in the image, so this is the fingerprint of the blended
 * photograph up to Float32 rounding (`straddle.test.ts`, T14), at the cost of
 * 4,096 multiply-adds instead of a pass over every pixel.
 *
 * A lone part hands back its state's own arrays, shared and not copied, as
 * EXPERIMENT-8 shares its grids: `indexByFingerprint` only reads them. A caller
 * that wants to scale a fingerprint must copy it first.
 */
export function blendFingerprint(
  parts: readonly PagePart[],
  ordinal: number,
  stateFingerprint: (state: LitState) => FrameFingerprint,
): FrameFingerprint {
  if (parts.length === 1) {
    const only = stateFingerprint(parts[0].state);
    return { ordinal, blocks: only.blocks, values: only.values, measured: only.measured };
  }
  const first = stateFingerprint(parts[0].state);
  const n = first.values.length;
  const acc = new Float64Array(n);
  const measured = new Uint8Array(n).fill(1);
  for (const part of parts) {
    const fp = stateFingerprint(part.state);
    if (fp.blocks !== first.blocks) throw new Error('blendFingerprint: the states are on different grids');
    for (let i = 0; i < n; i++) {
      acc[i] += part.weight * fp.values[i];
      measured[i] &= fp.measured[i];
    }
  }
  return { ordinal, blocks: first.blocks, values: Float32Array.from(acc), measured };
}

// ---------------------------------------------------------------------------
// The audit of EXPERIMENT-9's photographs
// ---------------------------------------------------------------------------

/** How one trial's photographs reconcile with what EXPERIMENT-9 counted. */
export interface Reconciliation {
  photographs: number;
  /** EXPERIMENT-9's own count: `straddles()` on every shot. */
  straddled: number;
  /** Straddled by EXPERIMENT-9's count and clean on the page: before-Play straddles. */
  phantoms: number;
  /** Photographs that integrated anything but their filed step, whole (page semantics). */
  contentChanged: number;
  /** Changed without straddling: the whole exposure fell on another step, or the dark. */
  whollyWrong: number;
  /** Photographs a part of which is the page's dark after the last step. */
  endingInDark: number;
}

/**
 * EXPERIMENT-9's shots of one capture, reconciled with what they integrated,
 * on its perfect timer. By construction `contentChanged = straddled - phantoms
 * + whollyWrong`; what `straddle.test.ts` checks is that the phantoms and the
 * wholly wrong photographs this finds are the ones the timing alone implies.
 */
export function reconcileShots(shots: readonly ShotTiming[], exposureS: number, dwellS: number): Reconciliation {
  const r: Reconciliation = { photographs: 0, straddled: 0, phantoms: 0, contentChanged: 0, whollyWrong: 0, endingInDark: 0 };
  const positions = [...new Set(shots.map((s) => s.position))].sort((a, b) => a - b);
  for (const position of positions) {
    const photos = positionPhotos(shots, position, exposureS, dwellS, 0, null, 0, 1);
    const mine = shots.filter((s) => s.position === position);
    photos.forEach((photo, j) => {
      const straddled = straddles(mine[j].open, exposureS, dwellS);
      const changed = contentChanged(photo);
      r.photographs++;
      if (straddled) r.straddled++;
      if (changed) r.contentChanged++;
      if (straddled && !changed) r.phantoms++;
      if (changed && !straddled) r.whollyWrong++;
      if (photo.rows.some((row) => row.some((p) => p.state === 'dark'))) r.endingInDark++;
    });
  }
  return r;
}
