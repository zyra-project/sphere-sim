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
  for (const [axis, list] of phases) {
    const res = axis === 'u' ? resX : resY;
    const frames: LinearImage[] = [];
    let gap = false;
    for (let n = 0; n < list.length; n++) {
      const f = list[n];
      if (f === undefined || f === null) {
        gap = true;
        problems.push(
          `The ${axis === 'u' ? 'across' : 'down'} phase steps are missing step ${n + 1}. An ` +
            `N-step estimator assumes N evenly spaced shifts; with one absent the remaining ones ` +
            `are not the set it solves.`,
        );
        break;
      }
      frames.push(f);
    }
    if (gap) continue;
    phase.push({
      axis,
      steps: frames.length,
      periodPx: (res / Math.pow(2, params.grayBits)) * params.phasePeriodStrides,
      frames,
    });
  }

  if (gray.length === 0) {
    problems.push('No complete Gray sequence survived, so nothing addresses a projector pixel.');
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
