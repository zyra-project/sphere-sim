// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the emitter played, written down so a capture can be decoded against it.
 *
 * Phase 3 of `docs/OPERATOR-PATH.md` asks for the solver to see a real
 * photograph. The modules that do that landed already — `ingest.ts`,
 * `assemble.ts`, `worth.ts` — and the plan's own status line says the rest:
 * *"nothing in this repository calls them — a test does."* This module is half
 * of the answer, and it exists because of a sentence the emitter page printed
 * at operators from Phase 1 until this landed:
 *
 * > Write the plan down: a capture decoded against a different one decodes into
 * > nonsense, and nothing yet records it for you.
 *
 * That is a real hazard stated as a chore. `assembleCapture` needs `grayBits`,
 * `phaseSteps`, `phasePeriodStrides` and the projector resolution, and getting
 * any of them wrong does not fail — it decodes. The `phaseSteps` case is the
 * sharpest and `assemble.ts` documents it: a four-step run read as three solves
 * 0/90/180 degrees as 0/120/240 and returns a confident, wrong phase.
 *
 * So a reader that asks the operator to retype the plan is building exactly the
 * trap the assembler was written to refuse. The emitter knows every one of
 * these numbers at the moment it plays them. It should hand them over.
 *
 * ## Why this is a file rather than a field in the archive
 *
 * It travels with the PHOTOGRAPHS, not with the calibration. An operator
 * finishes a capture with a folder of images and this file beside them, and the
 * pairing is what makes the folder decodable months later by somebody who was
 * not there. A number kept only in the page that emitted it is gone the moment
 * the tab closes.
 */

import type { PatternPlan } from '../../bench/src/patterns.ts';
import { complementPlan, planFrames } from '../../bench/src/patterns.ts';
import type { FrameRole } from '../../solver/src/assemble.ts';
import type { ComplementPlan, ExpectedSequence, FrameKind } from '../../solver/src/indexing.ts';

/** The file's own name, so the emitter and the reader cannot disagree about it. */
export const MANIFEST_FILENAME = 'capture-plan.json';

/**
 * What this page can actually emit, and therefore what a plan file may say.
 *
 * These are the emitter's own control ranges, in one place so the number box,
 * the clamp behind it and the parser cannot drift apart. Review found the
 * parser had no upper bound at all, and the consequence was not a lax check but
 * a crash: {@link parseCaptureManifest} derives `framesPerRun` by calling
 * `planFrames`, so a plan claiming a hundred million Gray planes spent 21
 * seconds building an array and then threw `Invalid array length` — an
 * exception, from the function whose docblock promises it refuses rather than
 * guesses, inside a promise with nothing to catch it. The operator picks a file
 * and the page does nothing at all.
 *
 * `phaseSteps` has a floor of 4 rather than 3 because that is what this page
 * emits; `assembleCapture` independently refuses anything under 3, and the
 * gap between the two is deliberate — the manifest describes what was SHOT, and
 * this page cannot have shot a 3-step pass.
 */
export const PLAN_LIMITS = {
  grayBits: { min: 1, max: 8 },
  phaseSteps: { min: 4, max: 12 },
  /** Even multiples of the Gray stride. Two is the natural choice; see decode.ts. */
  phasePeriodStrides: { min: 2, max: 16 },
} as const;

/**
 * A version on the format, checked rather than ignored.
 *
 * The one thing worse than no manifest is a manifest from a different version
 * of this page silently read as though it were this one — which is the same
 * failure the manifest exists to prevent, reintroduced by the fix.
 */
export const MANIFEST_VERSION = 1;

export interface CaptureManifest {
  version: number;
  /** The pattern plan, exactly as the emitter played it. */
  plan: PatternPlan;
  /** The projector raster the patterns addressed, in pixels. */
  projectorRes: { x: number; y: number };
  /** Projectors in the rig. Frames repeat this many times per camera position. */
  projectors: number;
  /** Frames one projector's run holds, derived from the plan. */
  framesPerRun: number;
  /** Seconds the emitter held each frame. Recorded for the operator, not the decoder. */
  dwellS: number;
  /** When the plan was written, ISO 8601. For telling two captures apart. */
  written: string;
}

/**
 * The manifest for a plan the emitter is about to play, or just played.
 *
 * `framesPerRun` is derived here rather than taken as an argument, because it
 * is a function of the plan and a caller that could pass a different number
 * would eventually pass a wrong one.
 */
export function captureManifest(
  plan: PatternPlan,
  projectorRes: { x: number; y: number },
  projectors: number,
  dwellS: number,
  written: string,
): CaptureManifest {
  return {
    version: MANIFEST_VERSION,
    plan: { ...plan },
    projectorRes: { ...projectorRes },
    projectors,
    framesPerRun: planFrames(plan).length,
    dwellS,
    written,
  };
}

/** The manifest as the file the operator downloads. Two-space JSON, so it is readable. */
export function formatManifest(m: CaptureManifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

export type ManifestParse =
  | { ok: true; manifest: CaptureManifest; problems: string[] }
  | { ok: false; manifest: null; problems: string[] };

function refuse(problems: string[]): ManifestParse {
  return { ok: false, manifest: null, problems };
}

function posInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** An integer inside a stated inclusive range. Rejects NaN and Infinity by construction. */
function inRange(v: unknown, limit: { min: number; max: number }): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= limit.min && v <= limit.max;
}

/** A value named so a refusal can quote it without printing `[object Object]`. */
function describe(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (v === undefined) return 'missing';
  return `not a number (${typeof v})`;
}

/**
 * Read a manifest back, refusing rather than defaulting.
 *
 * Every field this checks is one that decodes wrong rather than failing when it
 * is wrong, so there is nothing here to be lenient about. A missing
 * `phaseSteps` is not "assume four"; it is a folder whose plan is unknown, and
 * the honest report of that is a refusal.
 */
export function parseCaptureManifest(text: string): ManifestParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return refuse([`This is not JSON, so it is not a capture plan: ${(e as Error).message}`]);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse(['A capture plan is a JSON object, and this file holds something else.']);
  }
  const o = raw as Record<string, unknown>;

  if (o.version !== MANIFEST_VERSION) {
    return refuse([
      `This capture plan says version ${String(o.version)} and this page writes version ` +
        `${MANIFEST_VERSION}. Decoding a capture against a plan from another version is the ` +
        `failure this file exists to prevent, so it is refused rather than guessed at.`,
    ]);
  }

  const plan = o.plan as Record<string, unknown> | undefined;
  const problems: string[] = [];
  if (typeof plan !== 'object' || plan === null) {
    return refuse(['The capture plan has no `plan`, so nothing here says what was projected.']);
  }
  // Ranges before anything is derived from them. `planFrames` expands the plan
  // into an array, so an unbounded value is not a lenient check, it is a hang
  // followed by a throw. See PLAN_LIMITS.
  if (!inRange(plan.grayBits, PLAN_LIMITS.grayBits)) {
    problems.push(
      `\`plan.grayBits\` is ${describe(plan.grayBits)}. This page emits ` +
        `${PLAN_LIMITS.grayBits.min}–${PLAN_LIMITS.grayBits.max} Gray planes per axis, so a ` +
        `plan outside that was not written by it.`,
    );
  }
  if (!inRange(plan.phaseSteps, PLAN_LIMITS.phaseSteps)) {
    problems.push(
      `\`plan.phaseSteps\` is ${describe(plan.phaseSteps)}. This page emits ` +
        `${PLAN_LIMITS.phaseSteps.min}–${PLAN_LIMITS.phaseSteps.max} steps, and the decoder ` +
        `cannot solve fewer than three at all.`,
    );
  }
  if (!inRange(plan.phasePeriodStrides, PLAN_LIMITS.phasePeriodStrides)) {
    problems.push(
      `\`plan.phasePeriodStrides\` is ${describe(plan.phasePeriodStrides)}, outside ` +
        `${PLAN_LIMITS.phasePeriodStrides.min}–${PLAN_LIMITS.phasePeriodStrides.max}.`,
    );
  } else if ((plan.phasePeriodStrides as number) % 2 !== 0) {
    // decode.ts's normative header requires an even multiple, and an odd one is
    // not a near miss: at 1 every Gray misread displaces the estimate by a whole
    // fringe and the cross-check can never fire.
    problems.push(
      `\`plan.phasePeriodStrides\` is ${String(plan.phasePeriodStrides)}, which is odd. The ` +
        `decoder requires an even multiple of the Gray stride.`,
    );
  }
  if (typeof plan.includeWhiteBlack !== 'boolean') {
    problems.push('`plan.includeWhiteBlack` is missing, so the frame order is not determined.');
  }

  const res = o.projectorRes as Record<string, unknown> | undefined;
  if (typeof res !== 'object' || res === null || !posInt(res.x) || !posInt(res.y)) {
    problems.push('`projectorRes` is missing or not a pair of positive integers.');
  }
  if (!posInt(o.projectors)) problems.push('`projectors` is missing or not a positive integer.');

  if (problems.length > 0) return refuse(problems);

  const typedPlan: PatternPlan = {
    grayBits: plan.grayBits as number,
    phaseSteps: plan.phaseSteps as number,
    phasePeriodStrides: plan.phasePeriodStrides as number,
    includeWhiteBlack: plan.includeWhiteBlack as boolean,
  };

  // Derived rather than trusted. If the file's own `framesPerRun` disagrees
  // with its own plan, one of the two is a transcription and neither can be
  // told from the other — so say so instead of picking.
  const derived = planFrames(typedPlan).length;
  if (posInt(o.framesPerRun) && o.framesPerRun !== derived) {
    return refuse([
      `This capture plan says ${String(o.framesPerRun)} frames per run, but its own plan ` +
        `produces ${derived}. One of the two was edited by hand and nothing here can tell which, ` +
        `so neither is used.`,
    ]);
  }

  return {
    ok: true,
    manifest: {
      version: MANIFEST_VERSION,
      plan: typedPlan,
      projectorRes: {
        x: (res as Record<string, unknown>).x as number,
        y: (res as Record<string, unknown>).y as number,
      },
      projectors: o.projectors as number,
      framesPerRun: derived,
      dwellS: typeof o.dwellS === 'number' && o.dwellS > 0 ? o.dwellS : 0,
      written: typeof o.written === 'string' ? o.written : '',
    },
    problems: [],
  };
}

/**
 * One projector's run of frame roles, in the order the emitter played them.
 *
 * This is the join `packages/solver` cannot make for itself: `boundary-lint`
 * lets `solver` reach only `calibration`, so `assembleCapture` can never see
 * `planFrames` and takes the roles as data. `packages/web` is under neither
 * side of that rule, which makes this page the one place in the repository
 * where the emitter's plan and the decoder's expectations can be put side by
 * side — so this function is where they are checked against each other.
 *
 * `FrameSpec` and `FrameRole` are structurally identical today, and this is
 * deliberately still a conversion rather than a cast. They belong to packages
 * that cannot import each other, so nothing but this line would fail if one of
 * them changed.
 */
export function manifestFrameRoles(m: CaptureManifest): FrameRole[] {
  return planFrames(m.plan).map((spec) => ({
    kind: spec.kind,
    axis: spec.axis,
    index: spec.index,
  }));
}

/**
 * The shape an indexer should expect a folder of photographs to have.
 *
 * The second join this page exists to make, and the same one {@link
 * manifestFrameRoles} makes for the decoder. `packages/solver` states what it
 * expects as a list of KINDS and a list of complement POSITIONS precisely
 * because it may not see a `PatternPlan`; `packages/bench` owns the plan and
 * the capture order it implies. This page is under neither rule, so it is where
 * the two are put side by side.
 *
 * `projectors` comes from the manifest rather than the plan, because the plan
 * says what one run holds and the manifest says how many runs were shot.
 *
 * The return type says `complements` is always there, because it always is —
 * every plan this page can parse has at least one Gray plane, so
 * `complementPlan` always yields pairs. Narrowing it here rather than leaving
 * the caller an optional to handle is what stops the page carrying a branch for
 * a case it cannot reach; an unreachable branch reads like a guard and guards
 * nothing.
 *
 * Deliberately a conversion and not a cast, for {@link manifestFrameRoles}'s
 * reason: `FrameSpec.kind` has five values and `FrameKind` has three, and the
 * collapse from one to the other is a statement about what a photograph can say
 * about itself without being decoded. White and black are separable from every
 * patterned frame; one Gray plane is not separable from another.
 */
export function manifestExpectedSequence(
  m: CaptureManifest,
): ExpectedSequence & { complements: ComplementPlan } {
  const kinds: FrameKind[] = planFrames(m.plan).map((spec) =>
    spec.kind === 'white' ? 'white' : spec.kind === 'black' ? 'black' : 'patterned',
  );
  return { kinds, projectors: m.projectors, complements: complementPlan(m.plan) };
}
