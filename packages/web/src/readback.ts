// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The caller Phase 3 was missing.
 *
 * `docs/OPERATOR-PATH.md` marks Phase 3 **PLUMBED, UNPROVEN**, and its status
 * line names the gap exactly: the modules that turn encoded photographs into
 * correspondences *"exist and agree with each other end to end, no real
 * photograph has been through them, and **nothing in this repository calls
 * them** — a test does."*
 *
 * This module is the something that calls them. It runs the chain the plan
 * names — `linearise` -> `assembleCapture` -> `decodeCapture` -> `captureWorth`
 * — over a folder of photographs and a {@link CaptureManifest}, and returns
 * either what the capture was worth or a refusal saying what was wrong with the
 * pictures.
 *
 * ## Why this is not simply the test, moved
 *
 * `packages/solver/test/realphotos.test.ts` already runs the same four calls.
 * What it cannot do is be reached by an operator, and a module that only tests
 * call has not closed the gap — it has moved it one directory. So the DOM half
 * of this lives in `web/emit.ts`, on the emitter page's setup panel, and this
 * half is pure so it can be tested in Node. The split is the same one
 * `src/emit.ts` uses and for the same reason.
 *
 * (That path said `web/read.ts` when this landed, which was the separate page
 * this was going to be before it moved onto the emitter — a name for a file
 * that never existed. Review caught it.)
 *
 * ## What it deliberately does not do
 *
 * **It does not report a pose.** Phase 3's done-when is *"a pose with its
 * correspondence count beside it, or a refusal naming what was wrong with the
 * photographs"*, and the phase's own text orders those two: *"report what the
 * capture was worth BEFORE reporting a pose"*. A bundle adjustment needs each
 * camera's intrinsics and a rough pose, which nothing on this page has and
 * `docs/OPERATOR-PATH.md` names as the one prerequisite no phase removes. So
 * this stops at the worth report and says so, rather than inventing intrinsics
 * to reach a number that would then be the thing somebody trusted.
 *
 * **It does not report a pose**, and until Phase 2's indexing was wired in it
 * did not index the photographs either — the order files arrived in was taken
 * as the order they were shot in, and {@link readCapture} still works that way
 * for a caller that has already grouped its runs. {@link indexPhotographs} at
 * the bottom of this file is the route that does not assume it: it turns a
 * whole camera position into projector runs, or refuses. The two are kept
 * separate on purpose, because a bad decode should stay attributable to one
 * stage or the other.
 */

import type { EncodedImage, Transfer } from '../../solver/src/ingest.ts';
import { linearise } from '../../solver/src/ingest.ts';
import type {
  FrameFingerprint,
  FrameObservation,
  FrameStats,
  IndexingResult,
} from '../../solver/src/indexing.ts';
import { fingerprint, indexByFingerprint, litFractions, observe } from '../../solver/src/indexing.ts';
import type { AssembleParams, FrameRole } from '../../solver/src/assemble.ts';
import { assembleCapture } from '../../solver/src/assemble.ts';
import type { Correspondence, DecodeStats } from '../../solver/src/decode.ts';
import { decodeCapture } from '../../solver/src/decode.ts';
import type { CaptureWorth, PairContribution } from '../../solver/src/worth.ts';
import { captureWorth } from '../../solver/src/worth.ts';
import type { CaptureManifest } from './manifest.ts';
import { manifestExpectedSequence, manifestFrameRoles } from './manifest.ts';

/** One projector's run of photographs, as they came off the camera. */
export interface CaptureRun {
  camera: number;
  projector: number;
  /**
   * The photographs, in the order they were shot.
   *
   * Parallel to `manifestFrameRoles(manifest)`. A run whose length disagrees
   * with the plan is refused by {@link assembleCapture} rather than truncated,
   * which is the whole reason the manifest exists.
   */
  images: readonly EncodedImage[];
  /** File names, carried only so a refusal can name the file an operator must look at. */
  names: readonly string[];
}

/** What one run's photographs turned into. */
export interface RunOutcome {
  camera: number;
  projector: number;
  frames: number;
  /** Null when the run refused before decoding. */
  stats: DecodeStats | null;
  correspondences: number;
  /** Anything the ingest or the assembler wanted said. Empty when all was well. */
  problems: string[];
  /** Fraction of pixels at the sensor ceiling, worst frame in the run. */
  worstClippedHigh: number;
  /** The file that was worst, so the operator has somewhere to look. */
  worstClippedName: string;
}

export type ReadResult =
  | { ok: true; runs: RunOutcome[]; worth: CaptureWorth; correspondences: Correspondence[] }
  | { ok: false; runs: RunOutcome[]; worth: null; correspondences: []; refusal: string };

/**
 * A capture's worth of photographs, decoded.
 *
 * `runs` arrive already grouped by (camera, projector) and already in capture
 * order. Neither is inferred here, and that is a deliberate limit rather than
 * an oversight: file names are the only ordering signal a folder carries, they
 * sort lexicographically in an order that puts `IMG_10` before `IMG_2`, and a
 * reader that quietly sorted them would produce a capture that decodes — wrong,
 * and with nothing in the output saying so. The caller states the order it
 * believes in; this function decodes what it was handed.
 *
 * The `transfer` has no default for the reason `ingest.ts` gives at length: a
 * caller who does not know what its files are encoded with does not have a
 * capture, it has a folder of pictures.
 */
/**
 * One projector's run, decoded.
 *
 * Split out of {@link readCapture} so a caller can hold ONE run's pixels at a
 * time instead of a whole camera position's. That matters now that the page
 * indexes a position rather than being handed a run: four runs of linear light
 * is several gigabytes, and the peak this keeps is the same one the page has
 * always had.
 *
 * `roles` is passed in rather than derived, because deriving it per run would
 * recompute the plan expansion once per projector to get the same answer.
 */
export function readRun(
  run: CaptureRun,
  roles: readonly FrameRole[],
  manifest: CaptureManifest,
  transfer: Transfer,
): { outcome: RunOutcome; pair: PairContribution | null; correspondences: Correspondence[] } {
  const problems: string[] = [];
  let worstClippedHigh = 0;
  let worstClippedName = '';

  // Ingest first, and keep the reports: a capture that decodes badly because
  // it was overexposed looks, from the decoder's side, exactly like one shot
  // in a bright room. The clipping fraction is the only thing that separates
  // them and it is only visible here.
  const linear = run.images.map((img, i) => {
    const { image, report } = linearise(img, transfer);
    if (report.clippedHigh > worstClippedHigh) {
      worstClippedHigh = report.clippedHigh;
      worstClippedName = run.names[i] ?? `frame ${i + 1}`;
    }
    return image;
  });

  if (worstClippedHigh > CLIPPING_WORTH_SAYING) {
    problems.push(
      `${(100 * worstClippedHigh).toFixed(1)}% of ${worstClippedName} is at the sensor's ` +
        `ceiling. Clipped pixels carry no modulation, so they are read as unlit rather than as ` +
        `too bright — the symptom is a dim capture, not a bright one.`,
    );
  }

  const params: AssembleParams = {
    camera: run.camera,
    projector: run.projector,
    projectorRes: manifest.projectorRes,
    grayBits: manifest.plan.grayBits,
    // From the PLAN and never from the count of what arrived. `assemble.ts`
    // documents why: a four-step run that lost its last photograph, counted
    // rather than checked, decodes as a complete three-step one.
    phaseSteps: manifest.plan.phaseSteps,
    phasePeriodStrides: manifest.plan.phasePeriodStrides,
  };

  const assembled = assembleCapture(linear, roles, params);
  problems.push(...assembled.problems);

  if (!assembled.ok) {
    return {
      outcome: {
        camera: run.camera,
        projector: run.projector,
        frames: run.images.length,
        stats: null,
        correspondences: 0,
        problems,
        worstClippedHigh,
        worstClippedName,
      },
      pair: null,
      correspondences: [],
    };
  }

  const decoded = decodeCapture(assembled.capture);
  return {
    outcome: {
      camera: run.camera,
      projector: run.projector,
      frames: run.images.length,
      stats: decoded.stats,
      correspondences: decoded.correspondences.length,
      problems,
      worstClippedHigh,
      worstClippedName,
    },
    pair: { camera: run.camera, projector: run.projector, stats: decoded.stats },
    correspondences: decoded.correspondences,
  };
}

/**
 * What a capture's decoded runs were worth, from the parts {@link readRun}
 * produced.
 *
 * Separate from {@link readCapture} for the same reason `readRun` is: a caller
 * decoding one run at a time still needs the combined verdict, and
 * `captureWorth` reports across projector pairs rather than on one run.
 */
export function finishCapture(
  outcomes: RunOutcome[],
  pairs: PairContribution[],
  correspondences: Correspondence[],
  runsAttempted: number,
): ReadResult {
  if (pairs.length === 0) {
    // Every run refused before decoding. `captureWorth` reports on what the
    // decoder saw, and it saw nothing, so asking it would produce a report
    // about an empty capture rather than about these photographs.
    return {
      ok: false,
      runs: outcomes,
      worth: null,
      correspondences: [],
      refusal:
        `Not one of the ${runsAttempted} ${runsAttempted === 1 ? 'run' : 'runs'} could be ` +
        `assembled into a capture, so nothing reached the decoder. The problems listed against ` +
        `each run below are about the photographs themselves, not about the solve.`,
    };
  }
  return { ok: true, runs: outcomes, worth: captureWorth(pairs), correspondences };
}

export function readCapture(
  runs: readonly CaptureRun[],
  manifest: CaptureManifest,
  transfer: Transfer,
): ReadResult {
  const roles = manifestFrameRoles(manifest);

  if (runs.length === 0) {
    return {
      ok: false,
      runs: [],
      worth: null,
      correspondences: [],
      refusal:
        'No photographs were handed in, so there is nothing to decode. A capture is one folder ' +
        'per projector run, each holding the frames that run played.',
    };
  }

  const outcomes: RunOutcome[] = [];
  const pairs: PairContribution[] = [];
  const correspondences: Correspondence[] = [];
  for (const run of runs) {
    const one = readRun(run, roles, manifest, transfer);
    outcomes.push(one.outcome);
    if (one.pair !== null) pairs.push(one.pair);
    // A loop, NOT `push(...one.correspondences)`. The spread passes one argument
    // per element, and V8 throws `RangeError: Maximum call stack size exceeded`
    // somewhere past a hundred thousand of them — measured between 100 000 and
    // 131 072. A run yields up to one correspondence per camera pixel, so any
    // photograph above about 0.13 megapixels crossed it: every real camera.
    // The page caught the throw and reported "these photographs could not be
    // read", which is a confident wrong answer about the operator's files.
    for (const c of one.correspondences) correspondences.push(c);
  }
  return finishCapture(outcomes, pairs, correspondences, runs.length);
}

/**
 * Clipping worth mentioning, as a fraction of the frame.
 *
 * Not a threshold anything is withheld on. A sphere photographed with a bright
 * specular highlight legitimately clips a little, and `docs/OPERATOR-PATH.md`
 * is explicit that inventing a real-world gate before a real-world measurement
 * is the one thing this project refuses. One percent is where it becomes worth
 * an operator's attention, and it is said beside the result rather than used to
 * withhold it.
 */
export const CLIPPING_WORTH_SAYING = 0.01;

/** One line per run, for a report an operator reads rather than parses. */
export function describeRun(o: RunOutcome): string {
  const who = `Camera ${o.camera}, projector ${o.projector}`;
  if (o.stats === null) {
    return `${who}: ${o.frames} photographs, none decoded — see the problems below.`;
  }
  const share = o.stats.considered > 0 ? (100 * o.correspondences) / o.stats.considered : 0;
  return (
    `${who}: ${o.correspondences.toLocaleString()} correspondences from ` +
    `${o.stats.considered.toLocaleString()} camera pixels (${share.toFixed(1)}%), ` +
    `${o.frames} photographs.`
  );
}

// ---------------------------------------------------------------------------
// Which photograph is which frame — Phase 2, reached from the page
// ---------------------------------------------------------------------------

/**
 * What one photograph still says about itself once its pixels are gone.
 *
 * The whole reason this type exists is memory. Indexing needs every photograph
 * in the camera position compared against every other — that is what a
 * capture-wide threshold and a complement pair both require — and a position is
 * four runs, 136 frames at the page's own plan. Holding them all as linear
 * light is several gigabytes on a laptop standing next to a sphere.
 *
 * So a photograph is read, reduced, and released. What survives is a histogram
 * and a block grid, which together are a few kilobytes: 64 bins plus a 64x64
 * grid is about 17 KB, so a whole position is around 2 MB rather than 4 GiB.
 * The files are then read a SECOND time, one run at a time, for the decode.
 * Reading twice is the price of not holding a position at once, and it is the
 * right way round — the second read only ever covers runs the indexer vouched
 * for, so a capture that fails indexing is never decoded at all.
 */
export interface PhotoSummary {
  /** Everything {@link observe} kept, including the ordinal. */
  stats: FrameStats;
  /** The block grid {@link complementResidual} compares. */
  fingerprint: FrameFingerprint;
  /** For naming a photograph in a refusal. */
  name: string;
  /** Fraction of this frame at the sensor ceiling, from the ingest report. */
  clippedHigh: number;
}

/**
 * Read one photograph down to what indexing needs, and let the pixels go.
 *
 * `blocks` is not defaulted, for {@link fingerprint}'s reason: the count that
 * works is a property of the pattern plan, and the manifest is what knows it.
 * {@link indexPhotographs} refuses a summary too coarse for the plan rather
 * than running a check that cannot fail, so passing the wrong number here is
 * caught rather than silently believed.
 */
export function summarisePhoto(
  image: EncodedImage,
  ordinal: number,
  name: string,
  transfer: Transfer,
  blocks: number,
): PhotoSummary {
  const { image: linear, report } = linearise(image, transfer);
  return {
    stats: observe(linear, ordinal),
    fingerprint: fingerprint(linear, ordinal, blocks),
    name,
    clippedHigh: report.clippedHigh,
  };
}

/** One projector's run, as positions in the folder rather than as pixels. */
export interface IndexedRun {
  projector: number;
  /** Folder positions, in the order the plan says the frames were played. */
  ordinals: number[];
}

export interface IndexedCapture {
  /** True when every photograph the plan asks for was placed. */
  ok: boolean;
  /** The runs the indexer will vouch for. Empty when it vouches for none. */
  runs: IndexedRun[];
  /** What disagreed, in an operator's terms. Empty when all was well. */
  problems: string[];
  mechanism: IndexingResult['mechanism'];
  /** Photographs the folder held, and how many were placed. */
  total: number;
  placed: number;
}

/**
 * Turn a folder of photographs into projector runs, or refuse.
 *
 * This is the call `docs/OPERATOR-PATH.md` Phase 2 was built for and nothing
 * made: the mechanisms have existed since Experiment 8 and the only thing that
 * ever ran them was a test. The page asked the operator to hand in **one
 * projector's run at a time, in the order it was shot**, and that instruction
 * was the indexing — performed by a person, unchecked.
 *
 * It uses {@link indexByFingerprint}, which is the bookends plus the complement
 * check, because that is the mechanism Experiment 8 settled on: over 10 000
 * faulty captures it took the runs handed back from 5.8% mis-indexed to 0.4%,
 * and on every arm that cannot contain a cancelling pair it offered exactly the
 * runs the bookends offered and got none of them wrong. Ordering alone is not
 * offered here at all — it is the baseline the measurement exists to beat, and
 * the page should not hand an operator the mechanism that is silently wrong
 * 40% of the time.
 *
 * ## What it still does not do
 *
 * **It does not say which camera took the photographs.** `docs/CALIBRATE.md` is
 * explicit that Phase 2 removes the need to know which FRAME a photograph is
 * and does not remove the need to know which CAMERA took it: each camera is a
 * separate solver input with its own intrinsics and its own pose. So the camera
 * index is still the operator's to state, and it is still on the page.
 *
 * **It does not sort the folder.** The order files arrive in is taken as the
 * order they were shot in, exactly as before — what changes is that a fault in
 * that order is now usually caught instead of decoded. `readCapture`'s own note
 * says why nothing sorts: file names sort `IMG_10` before `IMG_2`.
 */
export function indexPhotographs(
  summaries: readonly PhotoSummary[],
  manifest: CaptureManifest,
): IndexedCapture {
  const expected = manifestExpectedSequence(manifest);
  const runLength = expected.kinds.length;
  const total = summaries.length;

  if (total === 0) {
    return {
      ok: false,
      runs: [],
      problems: [
        'No photographs were handed in, so there is nothing to index. A camera position is ' +
          `every projector's run shot back to back — ${expected.projectors} of them, ` +
          `${runLength} frames each.`,
      ],
      mechanism: 'fingerprint',
      total,
      placed: 0,
    };
  }

  const observations: FrameObservation[] = litFractions(summaries.map((s) => s.stats));
  const fingerprints = summaries.map((s) => s.fingerprint);
  const result = indexByFingerprint(observations, fingerprints, expected);

  // The assignment is a global frame number per photograph. Turning it back
  // into runs is the inverse of `p * runLength + f`, and it is done from the
  // assignment rather than from the run boundaries so that a photograph this
  // dropped stays dropped.
  const byProjector = new Map<number, { ordinal: number; position: number }[]>();
  let placed = 0;
  for (let i = 0; i < result.assignment.length; i++) {
    const frame = result.assignment[i];
    // The assignment is the whole answer. A run the mechanism will not vouch
    // for already has every one of its entries nulled — `indexByFingerprint`
    // clears them before returning, and `packages/solver/test/indexing.test.ts`
    // pins that — so filtering on `usableProjectors` here as well was a check
    // that could not fail. Mutation testing said so: removing it changed
    // nothing, which is the definition of a guard that is not guarding.
    if (frame === null) continue;
    placed++;
    const projector = Math.floor(frame / runLength);
    const list = byProjector.get(projector) ?? [];
    list.push({ ordinal: i, position: frame % runLength });
    byProjector.set(projector, list);
  }

  const runs: IndexedRun[] = [...byProjector.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([projector, entries]) => ({
      projector,
      // By plan position, not by folder position. Both mechanisms here assign a
      // contiguous ascending block per run, so today these are the same order
      // and this sort is a no-op — removing it breaks no test. It stays because
      // what it protects against is SILENT: a mechanism that placed frames out
      // of folder order would produce runs that decode into nonsense with
      // nothing in the output saying which stage went wrong, and that is the
      // one confusion `readCapture` is careful to keep separable.
      ordinals: entries.sort((a, b) => a.position - b.position).map((e) => e.ordinal),
    }));

  const problems = [...result.problems];
  // Clipping is mentioned HERE only when nothing decoded, because it is a
  // plausible cause of the refusal rather than a separate complaint: `classify`
  // loses its margin when the white frames clip, and an operator told only that
  // the references could not be told apart has not been told why. For runs that
  // do decode, `readCapture` reports clipping against the run it belongs to.
  if (runs.length === 0) {
    let worst = 0;
    let worstName = '';
    for (const s of summaries) {
      if (s.clippedHigh > worst) {
        worst = s.clippedHigh;
        worstName = s.name;
      }
    }
    if (worst > CLIPPING_WORTH_SAYING) {
      problems.push(
        `While nothing here decoded: ${(100 * worst).toFixed(1)}% of ${worstName} is at the ` +
          `sensor's ceiling. A clipped white frame is one the references cannot be told apart ` +
          `by, so an overexposed capture and an unreadable one look the same from here.`,
      );
    }
  }

  return { ok: result.ok, runs, problems, mechanism: result.mechanism, total, placed };
}

/** One line saying what the indexer made of the folder. */
export function describeIndexing(indexed: IndexedCapture, projectors: number): string {
  if (indexed.runs.length === 0) {
    return (
      `${indexed.total} photographs handed in, and none of them could be placed. Nothing was ` +
      `decoded — the problems below are about the folder, not about the solve.`
    );
  }
  const kept = indexed.runs.map((r) => r.projector + 1).join(', ');
  return (
    `${indexed.total} photographs handed in; ${indexed.placed} placed into ` +
    `${indexed.runs.length} of ${projectors} projector runs (${kept}). ` +
    (indexed.ok
      ? 'Every frame the plan asks for was found.'
      : 'The rest are listed below and were not decoded.')
  );
}
