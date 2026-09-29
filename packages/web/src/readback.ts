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
 *
 * {@link holdPosition}, below that, keeps every camera position read against
 * one plan, so that what the capture was worth is said over all of them. Taken
 * one position at a time, `captureWorth` could only ever refuse it: one camera
 * is degenerate.
 */

import type { EncodedImage, Transfer } from '../../solver/src/ingest.ts';
import { linearise } from '../../solver/src/ingest.ts';
import type {
  FrameFingerprint,
  FrameStats,
  PositionIndexing,
  ReshootProvenance,
} from '../../solver/src/indexing.ts';
import { fingerprint, indexPosition, observe } from '../../solver/src/indexing.ts';
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
  /** Zero-based, as `worth.ts` counts cameras. An operator reads it counted from one. */
  camera: number;
  /** Zero-based. An operator reads it counted from one. */
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
  /** Zero-based; {@link describeRun} counts from one. */
  camera: number;
  /** Zero-based; {@link describeRun} counts from one. */
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

/**
 * What a capture was worth, with no decoded points attached.
 *
 * Separate from {@link ReadResult} because the points are the expensive half
 * and most callers do not want them. Review measured what that costs: a
 * correspondence is 168 bytes, so one run at 1920x1200 is 0.36 GiB and a
 * four-projector position is **1.44 GiB** — retained, in the page's first
 * version of this, while the next run's 1.17 GiB of pixels loaded. That put the
 * peak near 2.6 GiB against the 2 GiB bound `captureTooLarge` believes it is
 * enforcing, and it bought nothing: the page reports `worth` and the per-run
 * counts, and never reads a single point.
 *
 * `worth` needs only {@link PairContribution}s, which are three numbers and a
 * stats record per run. So the verdict and the points are now separable, and a
 * caller that wants the verdict does not pay for the points.
 */
export type CaptureVerdict =
  | { ok: true; runs: RunOutcome[]; worth: CaptureWorth }
  | { ok: false; runs: RunOutcome[]; worth: null; refusal: string };

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
  runsAttempted: number,
): CaptureVerdict {
  if (pairs.length === 0) {
    // Every run refused before decoding. `captureWorth` reports on what the
    // decoder saw, and it saw nothing, so asking it would produce a report
    // about an empty capture rather than about these photographs.
    return {
      ok: false,
      runs: outcomes,
      worth: null,
      refusal:
        `Not one of the ${runsAttempted} ${runsAttempted === 1 ? 'run' : 'runs'} could be ` +
        `assembled into a capture, so nothing reached the decoder. The problems listed against ` +
        `each run below are about the photographs themselves, not about the solve.`,
    };
  }
  return { ok: true, runs: outcomes, worth: captureWorth(pairs) };
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
    //
    // This function keeps the points because its callers asked for them. A
    // caller that only wants the verdict calls `finishCapture` directly and
    // never builds this array — see `CaptureVerdict` for what that saves.
    for (const c of one.correspondences) correspondences.push(c);
  }
  const verdict = finishCapture(outcomes, pairs, runs.length);
  return verdict.ok ? { ...verdict, correspondences } : { ...verdict, correspondences: [] };
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

/**
 * One line per run, for a report an operator reads rather than parses.
 *
 * Cameras and projectors are counted from one, as everything else an operator
 * reads names them: the emitter's steps and projectors, {@link describeIndexing},
 * and `captureWorth`, which calls camera index 2 "Camera 3". This line printed
 * both indices as they are held, from zero. That was right while the page had a
 * Projector box and a Camera box, both counted from zero, and this line echoed
 * what was typed into them. Once indexing derived the projector, the line said
 * "projector 0" beneath an account of "projectors 1 and 2". And once the page
 * reports on more than one camera, the worth report's "Camera 2 decoded nothing"
 * would have pointed at the camera this line called "Camera 1".
 */
export function describeRun(o: RunOutcome): string {
  const who = `Camera ${o.camera + 1}, projector ${o.projector + 1}`;
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
  /**
   * True when every run this camera could see was placed and nothing was
   * refused. A projector out of view does not make it false: there is nothing
   * of it to place.
   */
  ok: boolean;
  /** The runs the indexer will vouch for. Empty when it vouches for none. */
  runs: IndexedRun[];
  /** What disagreed, in an operator's terms. Empty when all was well. */
  problems: string[];
  /**
   * What was noticed and stopped nothing, in an operator's terms: photographs
   * before Play or after the screen went black, projectors out of view or
   * barely seen, runs replaced by their re-shoots. Never a refusal — those are
   * {@link problems}.
   */
  notes: string[];
  /** Projectors this camera could not see, zero-based: every photograph of their slot dark. */
  unseen: number[];
  /** Projectors that lit too little from here to check or decode, zero-based. */
  barelySeen: number[];
  /** Runs placed from a re-shoot appended to the position, and which run each replaced. */
  reshoots: ReshootProvenance[];
  mechanism: PositionIndexing['mechanism'];
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
 * It uses `indexPosition`, which finds each run by what its own white, black
 * and phase frames show and checks it with the complement check that
 * Experiment 8 settled on. Until this changed it used `indexByFingerprint` —
 * the bookends plus that check — which rests on classifying the whole capture
 * into white, black and patterned, and `docs/EXPERIMENT-10.md` measured that
 * refusing every clean bench position: seen from one place, the coarse Gray
 * planes light all of a crescent or none of it, and some projectors are out of
 * sight altogether. The complement check is unchanged and asked the same
 * questions in the same words, so what Experiment 8 established about it still
 * holds; what changed is how a run is found and how it gets its projector
 * number. Ordering alone is still not offered here at all — it is the baseline
 * the measurement exists to beat, and the page should not hand an operator the
 * mechanism that is silently wrong 40% of the time.
 *
 * A projector the camera cannot see is a note, not a problem: its slot is dark
 * photographs, and there is nothing to decode and nothing to re-shoot. A re-shot
 * run added after the position replaces its original, and says so.
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
      notes: [],
      unseen: [],
      barelySeen: [],
      reshoots: [],
      mechanism: 'position',
      total,
      placed: 0,
    };
  }

  const result = indexPosition(
    summaries.map((s) => s.fingerprint),
    expected,
  );

  // The assignment is a global frame number per photograph. Turning it back
  // into runs is the inverse of `p * runLength + f`, and it is done from the
  // assignment rather than from the run boundaries so that a photograph this
  // dropped stays dropped.
  const byProjector = new Map<number, { ordinal: number; position: number }[]>();
  let placed = 0;
  for (let i = 0; i < result.assignment.length; i++) {
    const frame = result.assignment[i];
    // The assignment is the whole answer. A run the mechanism will not vouch
    // for has no entry in it — `indexPosition` places only the run it uses for
    // each projector, and `packages/solver/test/position.test.ts` scores every
    // placed photograph against the truth — so filtering on `usableProjectors`
    // here as well would be a check that could not fail. (Mutation testing said
    // so of the same filter over the fingerprint mechanism's assignment.)
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
      // By plan position, not by folder position. The mechanism assigns a
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
  // plausible cause of the refusal rather than a separate complaint: a clipped
  // white is flat where a projector's light varies, which can hide the
  // crescent a run is found by, and an operator told only that no run could be
  // read has not been told why. For runs that do decode, `readCapture` reports
  // clipping against the run it belongs to.
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

  return {
    ok: result.ok,
    runs,
    problems,
    notes: [...result.notes],
    unseen: [...result.unseenProjectors],
    barelySeen: [...result.barelySeenProjectors],
    reshoots: result.reshoots.map((r) => ({ ...r })),
    mechanism: result.mechanism,
    total,
    placed,
  };
}

/** "1, 2 and 4". */
function listed(xs: readonly number[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * What the indexer made of the folder, for an operator: one line on what was
 * placed, one on each projector the camera could not see or barely saw, one on
 * each run read from a re-shoot, and then the indexer's other notes.
 *
 * The notes the indexer writes about unseen, barely seen and replaced runs are
 * not repeated here — these lines say the same from the structured fields, so a
 * reader of the lines and a reader of the fields see one account.
 */
export function describeIndexing(indexed: IndexedCapture, projectors: number): string {
  const lines: string[] = [];
  if (indexed.runs.length === 0) {
    lines.push(
      `${indexed.total} photographs handed in, and none of them could be placed. Nothing was ` +
        `decoded — the problems below are about the folder, not about the solve.`,
    );
  } else {
    const kept = indexed.runs.map((r) => r.projector + 1).join(', ');
    const allSeen = indexed.unseen.length === 0 && indexed.barelySeen.length === 0;
    lines.push(
      `${indexed.total} photographs handed in; ${indexed.placed} placed into ` +
        `${indexed.runs.length} of ${projectors} projector runs (${kept}). ` +
        (indexed.ok
          ? allSeen
            ? 'Every frame the plan asks for was found.'
            : 'Every run this camera could see was found.'
          : 'The rest are listed below and were not decoded.'),
    );
  }
  if (indexed.unseen.length > 0) {
    const who = indexed.unseen.map((p) => p + 1);
    lines.push(
      `Not in this camera's view: projector${who.length === 1 ? '' : 's'} ${listed(who)} — ` +
        'every photograph of the run is dark, so there is nothing to decode and nothing to re-shoot.',
    );
  }
  if (indexed.barelySeen.length > 0) {
    const who = indexed.barelySeen.map((p) => p + 1);
    lines.push(
      `Barely seen from here: projector${who.length === 1 ? '' : 's'} ${listed(who)} — too ` +
        'little to check, so not decoded.',
    );
  }
  for (const r of indexed.reshoots) {
    lines.push(
      `Projector ${r.projector + 1} was read from its re-shoot, photographs ${r.used + 1} on, ` +
        `which replaced the run from photograph ${r.replaced + 1}.`,
    );
  }
  const covered = /^Projector \d+ (was not in this camera's view|lit only)|was replaced by its re-shoot/;
  for (const note of indexed.notes) if (!covered.test(note)) lines.push(note);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The session — every camera position read since the plan was loaded
// ---------------------------------------------------------------------------

/**
 * What one decoded run contributed, without a camera. The position it is held
 * under says which camera, and saying it in two places is how the two could
 * come to disagree.
 */
export interface HeldRun {
  /** Zero-based. */
  projector: number;
  stats: DecodeStats;
}

/**
 * One camera position the page has read, as the session holds it.
 *
 * Only what the worth report and the account need. The decoded points are not
 * among them, for the reason {@link CaptureVerdict} gives: they are 168 bytes
 * each, and nothing on the page reads one.
 */
export interface HeldPosition {
  /** Zero-based, as `worth.ts` counts cameras. An operator reads it counted from one. */
  camera: number;
  /** One {@link photographSignature} per photograph: all the session compares positions by. */
  photographs: readonly string[];
  /** The folder's first and last file names, in the order handed in, to name it by later. */
  first: string;
  last: string;
  /** What its decoded runs contributed. Empty when none decoded. */
  decoded: readonly HeldRun[];
}

/**
 * What makes two photographs the same photograph, for the session: name and
 * size. Not the last-modified time, which a copied folder does not keep: the
 * same photographs, copied and read again under another camera number, counted
 * as a second camera. Not the pixels, which would mean reading every file again
 * to compare them, and not the name alone, which cameras reuse — a new card
 * starts again at IMG_0001, and some cameras restart at 10000. Name and size can
 * still match by chance, two dark photographs compressing to the same bytes, so
 * {@link holdPosition} calls two positions the same only when most of them do.
 */
export function photographSignature(file: { readonly name: string; readonly size: number }): string {
  return `${file.size}:${file.name}`;
}

/** Every camera position read against one plan: at most one per camera. */
export interface CaptureSession {
  /**
   * The plan every position here was read against, compared by identity: the
   * object parsed from the file, so one file loaded twice is two plans. Null
   * while no plan is held.
   */
  plan: CaptureManifest | null;
  /** Ascending by camera. No two share a camera, and no two are the same photographs ({@link holdPosition}). */
  positions: readonly HeldPosition[];
}

/** The session before any plan has been read. */
export const EMPTY_SESSION: CaptureSession = { plan: null, positions: [] };

/** What filing one position did to the session. */
export type SessionChange =
  /** The camera held nothing, and no other camera held any of these photographs. */
  | { kind: 'added'; camera: number }
  /** The camera held another reading, and this one replaced it. */
  | { kind: 'replaced'; camera: number; earlier: HeldPosition }
  /**
   * Another camera held `shared` of these photographs, more than half of the
   * smaller position's: the same photographs. That position is no longer held,
   * and they count under this camera.
   */
  | { kind: 'moved'; camera: number; from: HeldPosition; shared: number }
  /** Read against a plan this session is not for, so not kept. */
  | { kind: 'otherPlan'; camera: number };

/**
 * File a camera position under its camera number.
 *
 * `docs/EXPERIMENT-10.md` records the page's worth report printing "Only 1
 * camera contributed." for a folder, whatever the folder held, because the page
 * read one camera position at a time and reported on that position alone. One
 * camera cannot separate a projector's distance from its field of view —
 * `worth.ts` says so with EXPERIMENT-1's numbers — so a report on one position
 * could never be anything but that refusal. The page now keeps every position
 * it reads, and the worth ({@link sessionWorth}) is over all of them.
 *
 * Three rules, each for a mistake an operator can make at a desk with three
 * folders and one camera box:
 *
 * - **A camera read again is replaced, never added to.** Two readings of one
 *   camera are one camera's position read twice — a re-shoot added to its
 *   folder, a folder corrected — and adding them would count that position
 *   twice. The change names the folder replaced, so a camera number left
 *   unchanged between two positions is seen rather than silently absorbed.
 * - **The same photographs count under one camera, the one given last.** The
 *   same photographs under two camera numbers are one position posing as two,
 *   and two cameras are exactly what `captureWorth` asks for before it will
 *   vouch for a solve: it would vouch for one no data supports. So a position
 *   that is the same photographs as another camera's — more than half of the
 *   smaller one's match — replaces that one too. More than half, not the whole
 *   folder: a folder read again with a re-shoot added is the same position
 *   with more photographs in it. And not any one: a photograph is known here
 *   by its name and size, and a dark one can match another card's in both.
 * - **A position read against another plan is not kept.** Positions decoded
 *   against different plans are not one capture, and a plan file loaded while a
 *   position was being read leaves that reading out.
 *
 * Pure: the session handed in is not changed, and nothing here touches a page.
 */
export function holdPosition(
  session: CaptureSession,
  plan: CaptureManifest,
  position: HeldPosition,
): { session: CaptureSession; changes: SessionChange[] } {
  if (plan !== session.plan) {
    return { session, changes: [{ kind: 'otherPlan', camera: position.camera }] };
  }
  const mine = new Set(position.photographs);
  const changes: SessionChange[] = [];
  const kept: HeldPosition[] = [];
  for (const held of session.positions) {
    if (held.camera === position.camera) {
      changes.push({ kind: 'replaced', camera: position.camera, earlier: held });
      continue;
    }
    const shared = held.photographs.filter((p) => mine.has(p)).length;
    if (2 * shared > Math.min(held.photographs.length, position.photographs.length)) {
      changes.push({ kind: 'moved', camera: position.camera, from: held, shared });
      continue;
    }
    kept.push(held);
  }
  if (changes.length === 0) changes.push({ kind: 'added', camera: position.camera });
  kept.push(position);
  kept.sort((a, b) => a.camera - b.camera);
  return { session: { plan, positions: kept }, changes };
}

/**
 * The session a newly loaded plan starts, and what the old one held.
 *
 * Loading a plan file clears the session whatever the file says, the same file
 * loaded again included. The page stops trusting the old plan the instant a new
 * one is chosen (`loadPlanFile` says why), and every position held was decoded
 * against the plan being replaced. `letGo` is what the page tells the operator
 * it let go; {@link describeLetGo} says it.
 */
export function sessionForPlan(
  previous: CaptureSession,
  plan: CaptureManifest | null,
): { session: CaptureSession; letGo: readonly HeldPosition[] } {
  return { session: { plan, positions: [] }, letGo: previous.positions };
}

/**
 * What every position held was worth together: `captureWorth` over all their
 * runs, each counted under the camera its position is held as, and told the
 * plan's projector count, so that a projector no held camera decoded is named
 * rather than left out: a session whose positions each decoded projectors 1 to
 * 3 of four was reported usable, projector 4 unmentioned.
 *
 * Null when no run of any held position decoded, for {@link finishCapture}'s
 * reason: `captureWorth` would report on an empty capture rather than on these
 * photographs.
 */
export function sessionWorth(session: CaptureSession): CaptureWorth | null {
  const pairs: PairContribution[] = [];
  for (const held of session.positions) {
    for (const run of held.decoded) {
      pairs.push({ camera: held.camera, projector: run.projector, stats: run.stats });
    }
  }
  return pairs.length === 0 ? null : captureWorth(pairs, session.plan?.projectors);
}

/** "IMG_0001.jpg to IMG_0136.jpg", or the one name. */
function folderOf(p: HeldPosition): string {
  return p.first === p.last ? p.first : `${p.first} to ${p.last}`;
}

/** Whether every photograph of `part` is in `whole`. */
function within(part: readonly string[], whole: readonly string[]): boolean {
  const inWhole = new Set(whole);
  return part.every((s) => inWhole.has(s));
}

function samePhotographs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && within(a, b);
}

function describeChange(session: CaptureSession, change: SessionChange): string {
  const n = change.camera + 1;
  const now = session.positions.find((p) => p.camera === change.camera);
  switch (change.kind) {
    case 'added':
      return `This position is now held as camera ${n}.`;
    case 'replaced': {
      const earlier = folderOf(change.earlier);
      // The same folder again, or the same folder grown — which is what a
      // re-shoot added to its end looks like — is this camera's own position
      // read again, and saying "in place of" would send the operator looking
      // for a mistake that was not made. The folder is named either way.
      if (now !== undefined && within(change.earlier.photographs, now.photographs)) {
        const more = now.photographs.length - change.earlier.photographs.length;
        return more === 0
          ? `Camera ${n}'s photographs (${earlier}) were read again, and this reading replaces the last.`
          : `Camera ${n}'s position (${earlier}) was read again with ${more} more ` +
              `photograph${more === 1 ? '' : 's'}, and this reading replaces the last.`;
      }
      return (
        `This position is now held as camera ${n}, in place of the one read as camera ${n} ` +
        `before (${earlier}). Reading a camera number again replaces what it held, so if that ` +
        `was another camera's position, give this one its own number and read both again.`
      );
    }
    case 'moved': {
      const m = change.from.camera + 1;
      if (now !== undefined && samePhotographs(now.photographs, change.from.photographs)) {
        return (
          `These photographs were held as camera ${m}. They count as camera ${n} now, the number ` +
          `given last, and camera ${m} is no longer held: one position under two numbers would ` +
          `pass for two cameras.`
        );
      }
      return (
        `Camera ${m}'s position (${folderOf(change.from)}) shares ${change.shared} of its ` +
        `${change.from.photographs.length} photographs with this one, so it is the same position and ` +
        `no longer held: a position counts under one camera, the number given last.`
      );
    }
    case 'otherPlan':
      return (
        'A plan file was loaded while this position was being read, so it is not held: it was ' +
        'read against the plan before. Read it again to add it.'
      );
  }
}

/** One held position, for the account. */
function describeHeld(p: HeldPosition): string {
  const photos = p.photographs.length;
  const runs = p.decoded.length;
  const points = p.decoded.reduce((a, r) => a + r.stats.accepted, 0);
  return (
    `Camera ${p.camera + 1}: ${folderOf(p)}, ${photos} photograph${photos === 1 ? '' : 's'}; ` +
    (runs === 0
      ? 'no run decoded.'
      : `${runs} run${runs === 1 ? '' : 's'} decoded, ${points.toLocaleString()} correspondences.`)
  );
}

/**
 * The session, for an operator: what filing the last position did, every
 * position held, and what they were worth together — `captureWorth`'s summary,
 * and its refusal if it makes one.
 *
 * Cameras are counted from one, as `captureWorth` names them, so "Camera 2
 * decoded nothing" in its refusal is the "Camera 2" listed above it.
 */
export function describeSession(session: CaptureSession, changes: readonly SessionChange[]): string {
  const lines = changes.map((c) => describeChange(session, c));
  if (session.positions.length === 0) {
    lines.push('No camera position is held, so there is no worth to report.');
    return lines.join('\n');
  }
  lines.push('Camera positions held until a plan file is loaded; the worth below covers every one:');
  for (const p of session.positions) lines.push(`  ${describeHeld(p)}`);
  const worth = sessionWorth(session);
  if (worth === null) {
    lines.push('None of them decoded a run, so there is no worth to report.');
  } else {
    lines.push(worth.summary);
    if (worth.refusal !== null) lines.push(worth.refusal);
  }
  return lines.join('\n');
}

/** What loading a plan file let go, for an operator. Empty when it held nothing. */
export function describeLetGo(letGo: readonly HeldPosition[]): string {
  if (letGo.length === 0) return '';
  const one = letGo.length === 1;
  const cameras = listed(letGo.map((p) => p.camera + 1));
  return (
    `The position${one ? '' : 's'} read as camera${one ? '' : 's'} ${cameras} ` +
    `${one ? 'is' : 'are'} no longer held: loading a plan file starts the report over, since ` +
    `every position is decoded against the plan it was read with. Read ` +
    `${one ? 'it' : 'them'} again to include ${one ? 'it' : 'them'}.`
  );
}
