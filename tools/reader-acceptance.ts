// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The page's reader on every clean camera position EXPERIMENT-10's Q0
 * photographed, held to a counterfactual reader, and the folder shapes the
 * card's procedure makes: `experiments/reader-acceptance.json`.
 *
 * ## Why this exists
 *
 * EXPERIMENT-10's Q0 handed the page's reader 108 clean bench positions and it
 * refused every one; `indexPosition` replaced that reader. Its own tests
 * (`packages/solver/test/position.test.ts`) run on a block-space sphere, and
 * `packages/experiments/test/reader.test.ts` hands it two rigs' rendered
 * photographs. This runs the same criteria, stated once in
 * `packages/experiments/src/reader/acceptance.ts`, over every position Q0
 * photographed — 24 rigs at the default preset, the 8 with the room on and the
 * 4 at the fine preset, three cameras each — which is too slow for a test.
 * Nothing here changes a threshold; it records what the reader did.
 *
 * ## What it measures
 *
 *   - Each clean position, through the page's own path, against the
 *     counterfactual: what each reader placed, what the page noted out of view
 *     or barely seen, what it refused and in what words, and for every run its
 *     lit pixels (on the sphere and in the room), its crescent in fingerprint
 *     blocks, how far its slot rises above its own dark, and its worst
 *     complementary pair.
 *   - What the page's own decode, `readRun`, makes of each run the camera
 *     lights that the page does not place, and of each run lit only by the
 *     room: how many correspondences, how many of them off the sphere, and how
 *     far the rest sit from the truth.
 *   - The folder shapes on the designed rigs, with the room off and on:
 *     photographs before Play and after the black, and every projector the
 *     position places re-shot and appended, played on, and alone. And the
 *     faults an operator makes on the way (review B's finding 11): the camera
 *     started late or stopped early by a few photographs, a test shot of
 *     another projector's white before Play, alone and with that projector
 *     re-shot, and a run spoiled by a photograph shot twice or not at all,
 *     re-shot and appended or played on — each read as its position, or
 *     refused in words, and never misfiled.
 *   - How a re-shoot is matched (review finding F14). A re-shot run is taken
 *     for its projector when its white and black reproduce the original's
 *     within `COMPLEMENT_LIMIT`, both ways round. Here: that residual for every
 *     run placed, shot again under a second noise seed — as it is, and with the
 *     re-shoot's exposure 2% off (EXPERIMENT-10's largest gain jitter) — the
 *     least residual between two projectors of one position, and the residual
 *     for the designed rigs rebuilt at the reduced preset with the camera set
 *     turned 0.5 to 5 degrees between a run and its re-shoot, with what the page
 *     then does with that re-shoot appended.
 *
 * ## Deterministic
 *
 * No timestamps and no wall times: the same code writes the same bytes, however
 * many lanes ran it. It records the last commit that changed the code it
 * measures (`packages/` and this file), and whether that code had uncommitted
 * changes when it ran, so a result committed on its own still names the code
 * that wrote it.
 *
 * Usage:  node tools/reader-acceptance.ts [--lanes N] [--only UNIT,...] [--out FILE]
 *
 * A unit is `main:K`, `spill:K`, `fine:K:C` or `turned:K`. About 30 minutes of
 * one core, 8 on four lanes; lanes run units in parallel, one rig each at a
 * time (a fine rig's camera is about 170 MB of frames).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { DEFAULT_SENSOR } from '../packages/bench/src/capture.ts';
import {
  COMPLEMENT_LIMIT,
  DARK_LIMIT,
  FLOOR_QUANTILE,
  MIN_CRESCENT_BLOCKS,
  MODULATION_FLOOR,
  SLOT_SLACK,
  type FrameFingerprint,
} from '../packages/solver/src/indexing.ts';
import { indexPhotographs, type PhotoSummary } from '../packages/web/src/readback.ts';
import {
  extrasPart,
  FEW_LOST,
  folder,
  judgePosition,
  judgeShapes,
  misfiled,
  pageDecode,
  photographCamera,
  POSITION,
  referenceResidual,
  runPart,
  runsPart,
  secondSeed,
  SPOILED,
  turnedRuns,
  type DecodeRecord,
  type PositionRecord,
  type Reason,
  type ShapeRecord,
} from '../packages/experiments/src/reader/acceptance.ts';
import { buildRig } from '../packages/experiments/src/straddle/bank.ts';
import {
  DESIGNED_RIGS,
  ENCODE_FULL_SCALE,
  EXPECTED,
  FINGERPRINT_BLOCKS,
  FRAMES_PER_RUN,
  GAIN_JITTER,
  MANIFEST,
  PROJECTORS,
  SCENE_ROOT_SEED,
} from '../packages/experiments/src/straddle/design.ts';
import { FULL_PLAN, reasonOf, variantOf, type Which } from '../packages/experiments/src/straddle/stages.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'experiments', 'reader-acceptance.json');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');

/** How far the camera set is turned between a run and its re-shoot, degrees, both ways round. */
const TURNS_DEG: readonly number[] = [-5, -3, -2, -1, -0.5, 0.5, 1, 2, 3, 5];

/** The re-shoot's exposure off by EXPERIMENT-10's largest gain jitter, as a scale on every photograph. */
const EXPOSURE_OFF = Math.max(...GAIN_JITTER);

const WHITE = EXPECTED.kinds.indexOf('white');
const BLACK = EXPECTED.kinds.indexOf('black');

/** Five places: residuals and levels are read against limits of two. */
function round(x: number): number;
function round(x: number | null): number | null;
function round(x: number | null): number | null {
  return x === null ? null : Math.round(x * 1e5) / 1e5;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Every unit, slowest first so the lanes finish together: a fine rig one
 * camera at a time, as EXPERIMENT-10 builds it; then the rigs with shapes and
 * the turned rigs; then the rest.
 */
function allUnits(): string[] {
  const fine = FULL_PLAN.fineRigs.flatMap((k) => [0, 1, 2].map((c) => `fine:${k}:${c}`));
  const spill = FULL_PLAN.spillRigs.map((k) => `spill:${k}`);
  const designed = FULL_PLAN.rigs.filter((k) => DESIGNED_RIGS.includes(k)).map((k) => `main:${k}`);
  const turned = DESIGNED_RIGS.map((k) => `turned:${k}`);
  const rest = FULL_PLAN.rigs.filter((k) => !DESIGNED_RIGS.includes(k)).map((k) => `main:${k}`);
  return [...fine, ...spill, ...designed, ...turned, ...rest];
}

interface PositionUnit {
  unit: string;
  which: Which;
  variant: string;
  width: number;
  height: number;
  positions: PositionRecord[];
  shapes: ShapeRecord[];
  /** Per placed run: the residual with the re-shoot's exposure off. Keyed `camera:projector`. */
  exposureOff: Record<string, number | null>;
  /**
   * What the page's decode makes of each run the camera lights and the page
   * does not place, and of each run lit only in the room. Keyed `camera:projector`.
   */
  givenUp: Record<string, DecodeRecord>;
}

interface TurnedRun {
  rig: number;
  camera: number;
  projector: number;
  crescentBlocks: number;
  /** The same run shot again from where it was: the second noise seed. */
  genuine: number | null;
  /** The renderer's run turned by 0 under the second seed, against `genuine`'s re-shoot. */
  turnedByZeroGap: number | null;
  /** The residual with the camera set turned by each of `TURNS_DEG`, in that order. */
  residuals: (number | null)[];
  /** What the page made of each of those re-shoots added after the position. */
  page: ('used' | 'refused' | 'other')[];
  reasons: Reason[][];
  misfiled: number[];
}

interface TurnedUnit {
  unit: string;
  runs: TurnedRun[];
}

type UnitResult = PositionUnit | TurnedUnit;

const scaled = (f: FrameFingerprint, by: number): FrameFingerprint => ({
  ...f,
  values: f.values.map((v) => v * by),
});

function positionUnit(unit: string): PositionUnit {
  const [whichText, kText, cText] = unit.split(':');
  const which = whichText as Which;
  const k = Number(kText);
  const variant = variantOf(FULL_PLAN, which);
  const bank = buildRig(k, variant, cText === undefined ? undefined : [Number(cText)]);
  const withShapes = which !== 'fine' && DESIGNED_RIGS.includes(k);
  const positions: PositionRecord[] = [];
  const shapes: ShapeRecord[] = [];
  const exposureOff: Record<string, number | null> = {};
  const givenUp: Record<string, DecodeRecord> = {};
  for (const c of bank.cameras) {
    const shots = photographCamera(bank, c, secondSeed(k));
    const { record } = judgePosition(shots, true);
    positions.push(record);
    // What the page's decode makes of every run the camera lights and the page
    // does not place, and of every run it places whose light is only the room's.
    for (const r of record.projectors) {
      const roomOnly = r.litPixels > 0 && r.litOnSphere === 0;
      if ((r.litPixels > 0 && r.reader !== 'placed') || roomOnly) givenUp[`${c}:${r.projector}`] = pageDecode(bank, c, r.projector);
    }
    for (const p of record.placed) {
      const own = shots.own[p];
      const again = shots.again(p);
      exposureOff[`${c}:${p}`] = referenceResidual(
        [own[WHITE].fingerprint, own[BLACK].fingerprint],
        [scaled(again[WHITE].fingerprint, 1 + EXPOSURE_OFF), scaled(again[BLACK].fingerprint, 1 + EXPOSURE_OFF)],
      );
    }
    if (withShapes) {
      const refused = record.projectors.filter((r) => r.reader === 'refused').map((r) => r.projector);
      shapes.push(
        ...judgeShapes(
          shots,
          { placed: record.placed, unseen: record.unseen, barelySeen: record.barelySeen, refused },
          record.placed,
        ),
      );
    }
  }
  return { unit, which, variant, width: bank.width, height: bank.height, positions, shapes, exposureOff, givenUp };
}

function turnedUnit(unit: string): TurnedUnit {
  const k = Number(unit.split(':')[1]);
  const bank = buildRig(k, 'reduced');
  const second = secondSeed(k);
  const cameras = bank.cameras.map((c) => {
    const shots = photographCamera(bank, c, second);
    return { c, shots, record: judgePosition(shots, true).record };
  });
  const refs = (run: readonly PhotoSummary[]): [FrameFingerprint, FrameFingerprint] => [
    run[WHITE].fingerprint,
    run[BLACK].fingerprint,
  ];
  const runs: TurnedRun[] = [];
  const byZero = turnedRuns(bank, 0, second);
  for (const { c, shots, record } of cameras) {
    for (const p of record.placed) {
      const genuine = record.projectors[p].reshootResidual;
      const zero = referenceResidual(refs(shots.own[p]), refs(byZero[c][p]));
      runs.push({
        rig: k,
        camera: c,
        projector: p,
        crescentBlocks: record.projectors[p].crescentBlocks,
        genuine: round(genuine),
        turnedByZeroGap: genuine === null || zero === null ? null : round(Math.abs(zero - genuine)),
        residuals: [],
        page: [],
        reasons: [],
        misfiled: [],
      });
    }
  }
  for (const deg of TURNS_DEG) {
    const turned = turnedRuns(bank, deg, second);
    for (const { c, shots, record } of cameras) {
      const position = runsPart((p) => shots.own[p], 0);
      for (const p of record.placed) {
        const f = folder([position, extrasPart(shots.darks.slice(0, 1)), runPart(turned[c][p], p)]);
        const indexed = indexPhotographs(f.summaries, MANIFEST);
        const used = indexed.reshoots.some((r) => r.projector === p && r.used === POSITION + 1);
        const run = runs.find((r) => r.camera === c && r.projector === p) as TurnedRun;
        run.residuals.push(round(referenceResidual(refs(shots.own[p]), refs(turned[c][p]))));
        run.page.push(used ? 'used' : indexed.problems.length > 0 ? 'refused' : 'other');
        run.reasons.push(indexed.problems.map(reasonOf));
        run.misfiled.push(misfiled(indexed, f.truth).length);
      }
    }
  }
  return { unit, runs };
}

function runUnit(unit: string): UnitResult {
  return unit.startsWith('turned:') ? turnedUnit(unit) : positionUnit(unit);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Stats {
  n: number;
  min: number | null;
  p10: number | null;
  median: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

function stats(xs: readonly number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number | null => (s.length === 0 ? null : round(s[Math.min(s.length - 1, Math.floor(q * s.length))]));
  return {
    n: s.length,
    min: s.length === 0 ? null : round(s[0]),
    p10: at(0.1),
    median: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: s.length === 0 ? null : round(s[s.length - 1]),
  };
}

const count = <T>(xs: readonly T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

interface Where {
  which: Which;
  rig: number;
  camera: number;
}

function assemble(results: Map<string, UnitResult>, units: readonly string[], commit: { commit: string; clean: boolean }) {
  const positionUnits = units.filter((u) => !u.startsWith('turned:')).map((u) => results.get(u) as PositionUnit);
  const turnedUnits = units.filter((u) => u.startsWith('turned:')).map((u) => results.get(u) as TurnedUnit);
  const whichOrder: Which[] = ['main', 'spill', 'fine'];
  const positions = whichOrder.flatMap((which) =>
    positionUnits
      .filter((u) => u.which === which)
      .flatMap((u) =>
        u.positions.map((p) => ({
          which,
          variant: u.variant,
          width: u.width,
          height: u.height,
          ...p,
          givenUp: Object.fromEntries(
            Object.entries(u.givenUp).flatMap(([key, x]) => {
              const [c, q] = key.split(':').map(Number);
              return c === p.camera ? [[q, x] as const] : [];
            }),
          ) as Record<number, DecodeRecord>,
        })),
      ),
  );
  const shapes = whichOrder.flatMap((which) =>
    positionUnits.filter((u) => u.which === which).flatMap((u) => u.shapes.map((s) => ({ which, ...s }))),
  );
  const runs = positions.flatMap((pos) => pos.projectors.map((r) => ({ pos, r })));
  const where = (pos: Where): string => `${pos.which} rig ${pos.rig} camera ${pos.camera}`;

  // ---- totals per build
  const positionTotals = (which: Which | 'all') => {
    const ps = positions.filter((p) => which === 'all' || p.which === which);
    const rs = runs.filter(({ pos }) => which === 'all' || pos.which === which);
    return {
      positions: ps.length,
      passing: ps.filter((p) => p.failures.length === 0).length,
      agreeing: ps.filter((p) => p.agrees).length,
      ok: ps.filter((p) => p.ok).length,
      photographs: ps.reduce((a, p) => a + p.photographs, 0),
      photographsPlaced: ps.reduce((a, p) => a + p.placed.length * FRAMES_PER_RUN, 0),
      misfiled: ps.reduce((a, p) => a + p.misfiled, 0),
      runs: rs.length,
      page: count(rs, ({ r }) => r.reader),
      counterfactual: count(rs, ({ r }) => r.counterfactual),
      litRuns: rs.filter(({ r }) => r.litPixels > 0).length,
      darkRuns: rs.filter(({ r }) => r.litPixels === 0).length,
      darkRunsReadAs: count(
        rs.filter(({ r }) => r.litPixels === 0),
        ({ r }) => r.reader,
      ),
      litOnlyInTheRoom: rs.filter(({ r }) => r.litPixels > 0 && r.litOnSphere === 0).length,
      litOnlyInTheRoomReadAs: count(
        rs.filter(({ r }) => r.litPixels > 0 && r.litOnSphere === 0),
        ({ r }) => `${r.reader} / counterfactual ${r.counterfactual}`,
      ),
      reasons: count(
        ps.flatMap((p) => p.reasons),
        (x) => x,
      ),
    };
  };

  // ---- every run the camera lights that the page does not place, and what its decode would give
  const decodeOut = (x: DecodeRecord | undefined) =>
    x === undefined
      ? null
      : { correspondences: x.correspondences, offSphere: x.offSphere, medianErrorPx: round(x.medianErrorPx), gross: x.gross };
  const notPlaced = runs
    .filter(({ r }) => r.litPixels > 0 && r.reader !== 'placed')
    .map(({ pos, r }) => ({
      where: where(pos),
      projector: r.projector,
      litPixels: r.litPixels,
      litOnSphere: r.litOnSphere,
      crescentBlocks: r.crescentBlocks,
      peakModulation: round(r.peakModulation),
      slotRise: round(r.slotRise),
      page: r.reader,
      counterfactual: r.counterfactual,
      worstPair: round(r.worstPair),
      decoded: decodeOut(pos.givenUp[r.projector]),
    }));

  // ---- every run the two readers disagree about, in both readers' words
  const pageWords = (pos: PositionRecord, p: number): string[] => [
    ...pos.problems.filter((x) => x.startsWith(`Projector ${p + 1}'s`) || x.startsWith(`Projector ${p + 1} `)),
    ...pos.notes.filter((x) => x.startsWith(`Projector ${p + 1}'s`) || x.startsWith(`Projector ${p + 1} `)),
  ];
  const cfWords = (pos: PositionRecord, p: number): string[] =>
    pos.counterfactualProblems.filter((x) => x.startsWith(`Projector ${p + 1}'s`));
  const disagreements = runs
    .filter(({ pos, r }) => pos.placed.includes(r.projector) !== pos.counterfactualPlaced.includes(r.projector))
    .map(({ pos, r }) => ({
      where: where(pos),
      projector: r.projector,
      litPixels: r.litPixels,
      litOnSphere: r.litOnSphere,
      crescentBlocks: r.crescentBlocks,
      peakModulation: round(r.peakModulation),
      worstPair: round(r.worstPair),
      page: r.reader,
      pageWords: pageWords(pos, r.projector),
      counterfactual: r.counterfactual,
      counterfactualWords: cfWords(pos, r.projector),
      decoded: decodeOut(pos.givenUp[r.projector]),
    }));

  // ---- the room: runs the camera sees only on the wall, and seen runs called out of view
  const seenCalledOutOfView = runs
    .filter(({ r }) => r.litOnSphere > 0 && r.reader === 'unseen')
    .map(({ pos, r }) => ({ where: where(pos), projector: r.projector, litOnSphere: r.litOnSphere, slotRise: round(r.slotRise) }));
  const outOfViewRefused = runs
    .filter(({ r }) => r.litOnSphere === 0 && (r.reader === 'refused' || r.reader === 'not placed'))
    .map(({ pos, r }) => ({ where: where(pos), projector: r.projector, litPixels: r.litPixels, pageWords: pageWords(pos, r.projector) }));
  const roomOnly = runs
    .filter(({ r }) => r.litPixels > 0 && r.litOnSphere === 0)
    .map(({ pos, r }) => ({
      where: where(pos),
      projector: r.projector,
      litPixels: r.litPixels,
      crescentBlocks: r.crescentBlocks,
      peakModulation: round(r.peakModulation),
      slotRise: round(r.slotRise),
      worstPair: round(r.worstPair),
      page: r.reader,
      counterfactual: r.counterfactual,
      decoded: decodeOut(pos.givenUp[r.projector]),
    }));

  // ---- crescents: MIN_CRESCENT_BLOCKS
  const lit = runs.filter(({ r }) => r.litPixels > 0);
  const crescentBy = (keep: (r: PositionRecord['projectors'][number]) => boolean) =>
    stats(lit.filter(({ r }) => keep(r)).map(({ r }) => r.crescentBlocks));
  const smallCrescents = lit
    .filter(({ r }) => r.crescentBlocks < 5 * MIN_CRESCENT_BLOCKS)
    .sort((a, b) => a.r.crescentBlocks - b.r.crescentBlocks)
    .map(({ pos, r }) => ({
      where: where(pos),
      projector: r.projector,
      litPixels: r.litPixels,
      litOnSphere: r.litOnSphere,
      crescentBlocks: r.crescentBlocks,
      worstPair: round(r.worstPair),
      page: r.reader,
      counterfactual: r.counterfactual,
    }));

  // ---- F14: how a re-shoot is matched
  const genuineOf = (which: Which | 'all') =>
    runs
      .filter(({ pos, r }) => (which === 'all' || pos.which === which) && r.reader === 'placed' && r.reshootResidual !== null)
      .map(({ r }) => r.reshootResidual as number);
  const exposureOff = positionUnits.flatMap((u) => Object.values(u.exposureOff).filter((x): x is number => x !== null));
  const largestGenuine = runs
    .filter(({ r }) => r.reader === 'placed' && r.reshootResidual !== null)
    .sort((a, b) => (b.r.reshootResidual as number) - (a.r.reshootResidual as number))
    .slice(0, 5)
    .map(({ pos, r }) => ({ where: where(pos), projector: r.projector, residual: round(r.reshootResidual), crescentBlocks: r.crescentBlocks }));
  const turnedAll = turnedUnits.flatMap((u) => u.runs);
  const byTurn = [...new Set(TURNS_DEG.map((d) => Math.abs(d)))].sort((a, b) => a - b).map((deg) => {
    const turns = turnedAll.flatMap((m) =>
      TURNS_DEG.flatMap((d, i) =>
        Math.abs(d) === deg
          ? [{ residual: m.residuals[i], page: m.page[i], reasons: m.reasons[i], misfiled: m.misfiled[i] }]
          : [],
      ),
    );
    const residuals = turns.flatMap((t) => (t.residual === null ? [] : [t.residual]));
    return {
      deg,
      turns: turns.length,
      residual: stats(residuals),
      withinLimit: residuals.filter((x) => x <= COMPLEMENT_LIMIT).length,
      page: count(turns, (t) => t.page),
      reasons: count(
        turns.flatMap((t) => t.reasons),
        (x) => x,
      ),
      misfiled: turns.reduce((a, t) => a + t.misfiled, 0),
    };
  });

  // ---- shapes
  const shapeTotals = (which: Which | 'all') => {
    const ss = shapes.filter((s) => which === 'all' || s.which === which);
    return {
      cameras: new Set(ss.map((s) => `${s.which}:${s.rig}:${s.camera}`)).size,
      shapes: ss.length,
      passing: ss.filter((s) => s.failures.length === 0).length,
      misfiled: ss.reduce((a, s) => a + s.misfiled, 0),
      // Per kind: how many pass, and of those how many the page read as their
      // position (the rest, of the faults, it refused in words).
      byKind: Object.fromEntries(
        [...new Set(ss.map((s) => s.kind))].map((kind) => {
          const of = ss.filter((s) => s.kind === kind);
          return [
            kind,
            {
              shapes: of.length,
              passing: of.filter((s) => s.failures.length === 0).length,
              read: of.filter((s) => s.failures.length === 0 && s.read).length,
              misfiled: of.reduce((a, s) => a + s.misfiled, 0),
            },
          ];
        }),
      ),
    };
  };

  const failures = [
    ...positions.flatMap((p) => p.failures.map((f) => ({ where: where(p), shape: null as string | null, failure: f }))),
    ...shapes.flatMap((s) => s.failures.map((f) => ({ where: where(s), shape: s.shape as string | null, failure: f }))),
  ];

  return {
    schema: 'sphere-sim/reader-acceptance@1',
    commit: commit.commit,
    clean: commit.clean,
    generatedFrom: {
      tool: SELF,
      sceneRootSeed: SCENE_ROOT_SEED,
      sensor: DEFAULT_SENSOR,
      encodeFullScale: ENCODE_FULL_SCALE,
      fingerprintBlocks: FINGERPRINT_BLOCKS,
      framesPerRun: FRAMES_PER_RUN,
      projectors: PROJECTORS,
      cleanSeed: "the rig's scenario seed, as noisyRun shares its draws with a render of the pair",
      secondSeed: 'nullSeed(k, 0), for everything besides the clean position',
      positions: {
        main: { variant: variantOf(FULL_PLAN, 'main'), rigs: FULL_PLAN.rigs },
        spill: { variant: variantOf(FULL_PLAN, 'spill'), rigs: FULL_PLAN.spillRigs },
        fine: { variant: variantOf(FULL_PLAN, 'fine'), rigs: FULL_PLAN.fineRigs },
      },
      shapes: {
        rigs: DESIGNED_RIGS,
        builds: ['main', 'spill'],
        // The faults: photographs a camera started late or stopped early by, and
        // the photograph of a spoiled run shot twice or not at all, counted from 1.
        lost: FEW_LOST,
        spoiledPhotograph: SPOILED + 1,
      },
      turned: { variant: 'reduced', rigs: DESIGNED_RIGS, degrees: TURNS_DEG },
      exposureOff: EXPOSURE_OFF,
      reader: {
        COMPLEMENT_LIMIT,
        DARK_LIMIT,
        FLOOR_QUANTILE,
        MIN_CRESCENT_BLOCKS,
        MODULATION_FLOOR,
        SLOT_SLACK,
      },
    },
    totals: {
      positions: {
        all: positionTotals('all'),
        main: positionTotals('main'),
        spill: positionTotals('spill'),
        fine: positionTotals('fine'),
      },
      shapes: { all: shapeTotals('all'), main: shapeTotals('main'), spill: shapeTotals('spill') },
      failures,
      disagreements,
      grazing: positions.flatMap((p) => p.grazing.map((g) => `${where(p)}: ${g}`)),
    },
    notPlaced: {
      runs: notPlaced.length,
      correspondences: notPlaced.reduce((a, x) => a + (x.decoded?.correspondences ?? 0), 0),
      mostInOneRun: Math.max(0, ...notPlaced.map((x) => x.decoded?.correspondences ?? 0)),
      list: notPlaced,
    },
    room: {
      seenCalledOutOfView,
      outOfViewRefused,
      roomOnlyReadAs: count(roomOnly, (x) => `${x.page} / counterfactual ${x.counterfactual}`),
      // What the page decodes, in all, from runs it places that light only the room.
      roomOnlyPlaced: {
        runs: roomOnly.filter((x) => x.page === 'placed').length,
        correspondences: roomOnly.filter((x) => x.page === 'placed').reduce((a, x) => a + (x.decoded?.correspondences ?? 0), 0),
        offSphere: roomOnly.filter((x) => x.page === 'placed').reduce((a, x) => a + (x.decoded?.offSphere ?? 0), 0),
      },
      roomOnly,
    },
    crescents: {
      placedByBoth: crescentBy((r) => r.reader === 'placed' && r.counterfactual === 'placed'),
      counterfactualPlaced: crescentBy((r) => r.counterfactual === 'placed'),
      counterfactualBroken: crescentBy((r) => r.counterfactual === 'broken'),
      counterfactualUnanswered: crescentBy((r) => r.counterfactual === 'unanswered'),
      pageBarelySeen: crescentBy((r) => r.reader === 'barely seen'),
      pageOutOfView: crescentBy((r) => r.reader === 'unseen'),
      under: 5 * MIN_CRESCENT_BLOCKS,
      small: smallCrescents,
    },
    reshoots: {
      limit: COMPLEMENT_LIMIT,
      genuine: { all: stats(genuineOf('all')), main: stats(genuineOf('main')), spill: stats(genuineOf('spill')), fine: stats(genuineOf('fine')) },
      largestGenuine,
      exposureOff: stats(exposureOff),
      betweenProjectors: stats(positions.flatMap((p) => (p.crossResidual === null ? [] : [p.crossResidual]))),
      reduced: {
        genuine: stats(turnedAll.flatMap((m) => (m.genuine === null ? [] : [m.genuine]))),
        turnedByZeroGap: stats(turnedAll.flatMap((m) => (m.turnedByZeroGap === null ? [] : [m.turnedByZeroGap]))),
        turned: byTurn,
      },
    },
    positions: positions.map((p) => ({
      which: p.which,
      rig: p.rig,
      camera: p.camera,
      variant: p.variant,
      width: p.width,
      height: p.height,
      photographs: p.photographs,
      placed: p.placed,
      unseen: p.unseen,
      barelySeen: p.barelySeen,
      ok: p.ok,
      problems: p.problems,
      reasons: p.reasons,
      notes: p.notes,
      counterfactualPlaced: p.counterfactualPlaced,
      // The counterfactual's words where they differ from the page's verdict;
      // elsewhere its verdict per run says the same in fewer bytes.
      counterfactualProblems: p.agrees && p.grazing.length === 0 ? [] : p.counterfactualProblems,
      agrees: p.agrees,
      misfiled: p.misfiled,
      crossResidual: round(p.crossResidual),
      failures: p.failures,
      runs: p.projectors.map((r) => ({
        projector: r.projector,
        litPixels: r.litPixels,
        litOnSphere: r.litOnSphere,
        crescentBlocks: r.crescentBlocks,
        peakModulation: round(r.peakModulation),
        slotRise: round(r.slotRise),
        page: r.reader,
        counterfactual: r.counterfactual,
        worstPair: round(r.worstPair),
        reshootResidual: round(r.reshootResidual),
      })),
    })),
    shapes: shapes.map((s) => ({
      which: s.which,
      rig: s.rig,
      camera: s.camera,
      shape: s.shape,
      photographs: s.photographs,
      placed: s.placed,
      unseen: s.unseen,
      barelySeen: s.barelySeen,
      reshoots: s.reshoots,
      ok: s.ok,
      read: s.read,
      reasons: s.reasons,
      misfiled: s.misfiled,
      failures: s.failures,
      // Words only where a shape fails: a passing one says what its position said.
      ...(s.failures.length > 0 ? { problems: s.problems, notes: s.notes } : {}),
    })),
    turned: turnedAll,
  };
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

function measuredCode(): { commit: string; clean: boolean } {
  const paths = ['packages', SELF];
  const commit = execFileSync('git', ['log', '-1', '--format=%H', '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).trim();
  return { commit, clean: status === '' };
}

function parseArgs(argv: readonly string[]): { lanes: number; only: string[] | null; out: string } {
  let lanes = os.availableParallelism();
  let only: string[] | null = null;
  let out = OUT;
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--lanes' && next) lanes = Math.max(1, Number(next));
    else if (argv[i] === '--only' && next) only = next.split(',');
    else if (argv[i] === '--out' && next) out = path.resolve(next);
  }
  return { lanes, only, out };
}

async function main(): Promise<void> {
  const { lanes, only, out } = parseArgs(process.argv.slice(2));
  const every = allUnits();
  const units = only === null ? every : every.filter((u) => only.includes(u));
  for (const u of only ?? []) if (!every.includes(u)) throw new Error(`reader-acceptance: no unit ${u}`);
  const code = measuredCode();
  console.log(
    `reader-acceptance: ${units.length} units on ${Math.min(lanes, units.length)} lanes, code at ${code.commit.slice(0, 12)}` +
      (code.clean ? '' : ' with uncommitted changes'),
  );
  const results = new Map<string, UnitResult>();
  const queue = [...units];
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(lanes, units.length) }, async () => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { lane: true } });
      try {
        for (let unit = queue.shift(); unit !== undefined; unit = queue.shift()) {
          const t0 = Date.now();
          const result = await new Promise<UnitResult>((resolve, reject) => {
            const onMessage = (m: UnitResult): void => {
              worker.off('error', reject);
              resolve(m);
            };
            worker.once('message', onMessage);
            worker.once('error', reject);
            worker.postMessage(unit);
          });
          results.set(unit, result);
          console.log(
            `  ${unit}: ${((Date.now() - t0) / 1000).toFixed(1)} s (${results.size}/${units.length}, ` +
              `${((Date.now() - started) / 60000).toFixed(1)} min)`,
          );
        }
      } finally {
        await worker.terminate();
      }
    }),
  );
  const doc = assemble(results, units, code);
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  const t = doc.totals;
  console.log(
    `\n  positions: ${t.positions.all.positions}, passing ${t.positions.all.passing}, agreeing ${t.positions.all.agreeing}, ` +
      `misfiled ${t.positions.all.misfiled}; shapes: ${t.shapes.all.shapes}, passing ${t.shapes.all.passing}; ` +
      `failures ${t.failures.length}, disagreements ${t.disagreements.length}`,
  );
  console.log(`  wrote ${path.relative(ROOT, out)}`);
}

if (isMainThread) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
} else if ((workerData as { lane?: boolean } | null)?.lane === true) {
  parentPort?.on('message', (unit: string) => {
    parentPort?.postMessage(runUnit(unit));
  });
}
