// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * An indexed folder of photographs into the structure the decoder reads.
 *
 * Phase 3 of `docs/OPERATOR-PATH.md` calls its own first half "the plumbing",
 * and this is the piece of it that was missing: Phase 2 works out WHICH frame
 * each photograph is, `decodeCapture` reads a {@link PatternCapture}, and
 * nothing turned one into the other. Until now the only thing that ever built a
 * `PatternCapture` was the bench, which knows the answer by construction because
 * it rendered the frames itself.
 *
 * ## Why the frame order arrives as data
 *
 * `packages/solver` may import only `packages/calibration`, so it cannot see
 * `planFrames` — the function whose output order IS the capture order. The roles
 * therefore arrive as a list, from a caller that can see both sides.
 *
 * That is a boundary rule producing the right shape by accident, and it is worth
 * being explicit about the hazard it leaves: the order is now stated twice, once
 * by `planFrames` and once by whoever fills in {@link FrameRole}s, and a
 * disagreement between them would assemble a capture whose Gray planes are in
 * the wrong slots. It would decode — into a confidently wrong calibration. So
 * {@link assembleCapture} does not trust the list: it checks that the roles form
 * a decodable set and refuses when they do not, rather than indexing into
 * whatever it was handed.
 *
 * ## Refusing is the product
 *
 * Phase 3's done-when is "a pose with its correspondence count beside it, **or a
 * refusal naming what was wrong with the photographs**". Half of that is this
 * function returning a reason instead of a structure.
 */

import type { DecodeAxis, GraySequence, LinearImage, PatternCapture, PhaseSequence } from './decode.ts';

/** What one frame of a run is, in the capture order the emitter played. */
export interface FrameRole {
  kind: 'white' | 'black' | 'gray' | 'grayInverse' | 'phase';
  /** The raster coordinate this frame varies along; null for a flat field. */
  axis: DecodeAxis | null;
  /** Gray plane index, 0 = most significant. Or phase step index. */
  index: number;
}

/** Everything about the rig the assembled capture has to carry. */
export interface AssembleParams {
  camera: number;
  projector: number;
  projectorRes: { x: number; y: number };
  /** Gray planes per axis. The stride is `res / 2^bits`. */
  grayBits: number;
  /**
   * Phase steps per axis, as the emitter PLANNED them. 0 for a Gray-only plan.
   *
   * This is here because without it a short run is indistinguishable from a
   * shorter plan. `decodePhaseAt` reads `steps` as the number of evenly spaced
   * shifts the frames were taken at, so a four-step sequence that lost its last
   * photograph, counted rather than checked, becomes a three-step one: the
   * 0/90/180 degree frames get solved as 0/120/240 and the phase comes back
   * confidently wrong. Counting what arrived can never catch that. Only the
   * planned number can.
   */
  phaseSteps: number;
  /** Fringe period as a multiple of the Gray stride. `decode.ts` wants it even. */
  phasePeriodStrides: number;
}

export type AssembleResult =
  | { ok: true; capture: PatternCapture; problems: string[] }
  | { ok: false; capture: null; problems: string[] };

function refuse(problems: string[]): AssembleResult {
  return { ok: false, capture: null, problems };
}

/**
 * One projector's run of photographs into a {@link PatternCapture}.
 *
 * `images` and `roles` are parallel and in capture order — the order Phase 2's
 * indexing established, or the order the operator shot in if they are trusting
 * that. Both halves of each Gray pair must be present: the decoder reads a bit
 * as the sign of the difference between them, so a plane without its complement
 * is not a degraded bit, it is no bit at all.
 */
export function assembleCapture(
  images: readonly LinearImage[],
  roles: readonly FrameRole[],
  params: AssembleParams,
): AssembleResult {
  const problems: string[] = [];
  if (images.length !== roles.length) {
    return refuse([
      `This run holds ${images.length} photographs and ${roles.length} frame roles. Nothing can ` +
        `be assembled from a list whose two halves disagree about its length — that is an ` +
        `indexing fault upstream, not a photograph fault.`,
    ]);
  }
  if (images.length === 0) return refuse(['This run holds no photographs.']);

  const { x: resX, y: resY } = params.projectorRes;
  if (!(resX > 0 && resY > 0)) {
    return refuse([`The projector raster is ${resX}x${resY}, which cannot be a raster.`]);
  }
  if (!Number.isInteger(params.grayBits) || params.grayBits < 1) {
    return refuse([`${params.grayBits} Gray planes per axis is not a plan.`]);
  }
  if (!Number.isInteger(params.phaseSteps) || params.phaseSteps < 0) {
    return refuse([`${params.phaseSteps} phase steps per axis is not a plan.`]);
  }
  if (params.phaseSteps > 0 && params.phaseSteps < 3) {
    return refuse([
      `A ${params.phaseSteps}-step phase pass cannot be solved: the estimator fits an offset, ` +
        `an amplitude and a phase, which is three unknowns and needs at least three shifts.`,
    ]);
  }

  // Sizes must agree, because every later step subtracts one frame from another.
  const w = images[0].width;
  const h = images[0].height;
  const odd = images.findIndex((img) => img.width !== w || img.height !== h);
  if (odd >= 0) {
    return refuse([
      `Photograph ${odd + 1} is ${images[odd].width}x${images[odd].height} where the first is ` +
        `${w}x${h}. Every frame is read against the references pixel for pixel, so one image of ` +
        `a different size is one the capture cannot use — a crop, a rotation the camera applied ` +
        `to some frames and not others, or two cameras' files in one folder.`,
    ]);
  }

  let white: LinearImage | null = null;
  let black: LinearImage | null = null;
  const grays = new Map<DecodeAxis, { patterns: (LinearImage | null)[]; inverses: (LinearImage | null)[] }>();
  const phases = new Map<DecodeAxis, (LinearImage | null)[]>();
  /** `kind:axis:index` of every slot already spoken for, to the frame that took it. */
  const claimed = new Map<string, number>();

  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const img = images[i];
    if (role.kind === 'white') {
      if (white !== null) problems.push(`Two frames claim to be the white reference.`);
      white = img;
      continue;
    }
    if (role.kind === 'black') {
      if (black !== null) problems.push(`Two frames claim to be the black reference.`);
      black = img;
      continue;
    }
    if (role.axis === null) {
      problems.push(`Frame ${i + 1} is a ${role.kind} frame with no axis, which is not a thing.`);
      continue;
    }
    /**
     * The index has to name a slot the plan actually has, and name it once.
     *
     * Assigning straight into a sparse array accepts anything: a duplicate
     * silently replaces the photograph already there, a negative or fractional
     * index writes a property that no later loop reads, and an index past the
     * end of the plan is dropped by the validation below without a word. None
     * of it disturbs the length check at the top, because `images` and `roles`
     * still match — so a malformed role list assembles a capture that decodes.
     */
    const limit = role.kind === 'phase' ? params.phaseSteps : params.grayBits;
    const what = role.kind === 'phase' ? 'phase step' : 'Gray plane';
    if (!Number.isInteger(role.index) || role.index < 0 || role.index >= limit) {
      problems.push(
        `Frame ${i + 1} calls itself ${what} ${role.index} of an axis whose plan has ${limit}. ` +
          `An index outside the plan is not a frame the decoder can place.`,
      );
      continue;
    }
    const key = `${role.kind}:${role.axis}:${role.index}`;
    if (claimed.has(key)) {
      problems.push(
        `Frames ${claimed.get(key)} and ${i + 1} both call themselves ${what} ${role.index + 1} ` +
          `of the ${role.axis === 'u' ? 'across' : 'down'} axis. Two photographs cannot be the ` +
          `same frame: one of them is a duplicate the indexing should have caught, and taking ` +
          `either on faith throws the other away silently.`,
      );
      continue;
    }
    claimed.set(key, i + 1);

    if (role.kind === 'phase') {
      const list = phases.get(role.axis) ?? [];
      list[role.index] = img;
      phases.set(role.axis, list);
      continue;
    }
    const slot = grays.get(role.axis) ?? { patterns: [], inverses: [] };
    if (role.kind === 'gray') slot.patterns[role.index] = img;
    else slot.inverses[role.index] = img;
    grays.set(role.axis, slot);
  }

  const gray: GraySequence[] = [];
  for (const [axis, slot] of grays) {
    const res = axis === 'u' ? resX : resY;
    const missing: string[] = [];
    const patterns: LinearImage[] = [];
    const inverses: LinearImage[] = [];
    for (let j = 0; j < params.grayBits; j++) {
      const p = slot.patterns[j];
      const inv = slot.inverses[j];
      if (p === undefined || p === null) missing.push(`plane ${j + 1}`);
      if (inv === undefined || inv === null) missing.push(`plane ${j + 1}'s complement`);
      if (p !== undefined && p !== null && inv !== undefined && inv !== null) {
        patterns.push(p);
        inverses.push(inv);
      }
    }
    if (missing.length > 0) {
      problems.push(
        `The ${axis === 'u' ? 'across' : 'down'} Gray planes are missing ${missing.join(', ')}. ` +
          `A plane without its complement is not a weak bit, it is no bit: the decoder reads the ` +
          `bit as the sign of the difference between the two.`,
      );
      continue;
    }
    gray.push({ axis, bits: params.grayBits, stridePx: res / Math.pow(2, params.grayBits), patterns, inverses });
  }

  const phase: PhaseSequence[] = [];
  /**
   * The fringe period is only checked where it is about to be used.
   *
   * `decode.ts`'s own header asks for an even multiple of the Gray stride, at
   * least two, and gives the reason: the Gray address has to be finer than one
   * fringe or the fringe order is not determined, and at exactly one stride
   * every Gray misread displaces the coarse estimate by a whole number of
   * fringes — so the unwrap picks a different order and the Gray-versus-phase
   * cross-check can never fire. Zero is worse still: the period becomes zero
   * and the unwrap divides by it.
   */
  if (phases.size > 0) {
    const k = params.phasePeriodStrides;
    if (!Number.isInteger(k) || k < 2 || k % 2 !== 0) {
      return refuse([
        `The fringe period is ${k} Gray strides, and it has to be an even whole number of them, ` +
          `at least two. ${
            k === 0
              ? 'Zero gives a period of zero pixels, which the unwrap divides by.'
              : k < 2
                ? 'Below two the Gray address is no finer than one fringe, so the fringe order ' +
                  'is not determined.'
                : 'At an odd multiple the Gray-versus-phase cross-check loses the ' +
                  'incommensurability it is built on and stops catching disagreements.'
          }`,
      ]);
    }
  }
  for (const [axis, list] of phases) {
    const res = axis === 'u' ? resX : resY;
    const frames: LinearImage[] = [];
    const missing: number[] = [];
    // Against the PLANNED count, never against what turned up: `list.length`
    // stops at the highest index that arrived, so a run that lost its last
    // photograph looks like a complete shorter run and decodes as one.
    for (let n = 0; n < params.phaseSteps; n++) {
      const f = list[n];
      if (f === undefined || f === null) missing.push(n + 1);
      else frames.push(f);
    }
    if (missing.length > 0) {
      problems.push(
        `The ${axis === 'u' ? 'across' : 'down'} phase pass is missing ` +
          `${missing.length === 1 ? `step ${missing[0]}` : `steps ${missing.join(', ')}`} of ` +
          `${params.phaseSteps}. An N-step estimator assumes N evenly spaced shifts, so the ` +
          `frames that did arrive are not a shorter pass the decoder could fall back to — they ` +
          `are the wrong shifts for any N.`,
      );
      continue;
    }
    phase.push({
      axis,
      steps: params.phaseSteps,
      periodPx: (res / Math.pow(2, params.grayBits)) * params.phasePeriodStrides,
      frames,
    });
  }

  /**
   * Both axes, not one of them.
   *
   * `decodeCapture` decodes u and v for every pixel and discards the pixel when
   * either fails, so a capture carrying a complete across sequence and nothing
   * down is not a partial answer that degrades gracefully — it is zero
   * correspondences, counted one pixel at a time as `rejectedMissingAxis`.
   * Checking only that SOME Gray sequence survived let exactly that through.
   *
   * Per axis the decoder needs one of the two, not both: `decodeAxis` fails
   * `missing` only when Gray and phase are both absent.
   */
  for (const axis of ['u', 'v'] as const) {
    if (gray.some((g) => g.axis === axis)) continue;
    if (phase.some((p) => p.axis === axis)) continue;
    problems.push(
      `Nothing in this run addresses the ${axis === 'u' ? 'across' : 'down'} axis. Every pixel ` +
        `needs both coordinates, so a run missing one of them decodes no correspondences at ` +
        `all rather than half of one.`,
    );
  }
  if (problems.length > 0) return refuse(problems);

  return {
    ok: true,
    capture: {
      camera: params.camera,
      projector: params.projector,
      projectorRes: { x: resX, y: resY },
      white,
      black,
      gray,
      phase,
    },
    problems: [],
  };
}
