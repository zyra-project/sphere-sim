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
 * **It does not index the photographs.** The order files arrive in is taken as
 * the order they were shot in. Phase 2 built mechanisms for establishing that
 * from the pictures themselves; wiring them in is separate work and doing it
 * badly here would hide which of the two stages a bad decode came from. See
 * {@link readCapture}'s note on ordering.
 */

import type { EncodedImage, Transfer } from '../../solver/src/ingest.ts';
import { linearise } from '../../solver/src/ingest.ts';
import type { AssembleParams } from '../../solver/src/assemble.ts';
import { assembleCapture } from '../../solver/src/assemble.ts';
import type { Correspondence, DecodeStats } from '../../solver/src/decode.ts';
import { decodeCapture } from '../../solver/src/decode.ts';
import type { CaptureWorth, PairContribution } from '../../solver/src/worth.ts';
import { captureWorth } from '../../solver/src/worth.ts';
import type { CaptureManifest } from './manifest.ts';
import { manifestFrameRoles } from './manifest.ts';

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
export function readCapture(
  runs: readonly CaptureRun[],
  manifest: CaptureManifest,
  transfer: Transfer,
): ReadResult {
  const outcomes: RunOutcome[] = [];
  const pairs: PairContribution[] = [];
  const correspondences: Correspondence[] = [];
  const roles = manifestFrameRoles(manifest);

  if (runs.length === 0) {
    return {
      ok: false,
      runs: outcomes,
      worth: null,
      correspondences: [],
      refusal:
        'No photographs were handed in, so there is nothing to decode. A capture is one folder ' +
        'per projector run, each holding the frames that run played.',
    };
  }

  for (const run of runs) {
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
      outcomes.push({
        camera: run.camera,
        projector: run.projector,
        frames: run.images.length,
        stats: null,
        correspondences: 0,
        problems,
        worstClippedHigh,
        worstClippedName,
      });
      continue;
    }

    const decoded = decodeCapture(assembled.capture);
    correspondences.push(...decoded.correspondences);
    pairs.push({ camera: run.camera, projector: run.projector, stats: decoded.stats });
    outcomes.push({
      camera: run.camera,
      projector: run.projector,
      frames: run.images.length,
      stats: decoded.stats,
      correspondences: decoded.correspondences.length,
      problems,
      worstClippedHigh,
      worstClippedName,
    });
  }

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
        `Not one of the ${runs.length} ${runs.length === 1 ? 'run' : 'runs'} could be assembled ` +
        `into a capture, so nothing reached the decoder. The problems listed against each run ` +
        `below are about the photographs themselves, not about the solve.`,
    };
  }

  return { ok: true, runs: outcomes, worth: captureWorth(pairs), correspondences };
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
