// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * One trial: break a capture on purpose, then ask each mechanism what it sees.
 *
 * Pure. It returns objects and writes nothing, so the sweep can be resumed,
 * re-ordered or re-scored without re-running anything.
 *
 * ## What a "photograph" is here
 *
 * A lit fraction and the frame it really is. Nothing is rendered, and that is a
 * deliberate separation rather than a shortcut: this arm measures how the
 * INDEXING LOGIC behaves under drops and duplicates, which is combinatorial —
 * a deleted file is deleted whether the picture behind it came off a sensor or a
 * ray tracer. Whether the references stay separable from the patterned frames on
 * a real-looking image is a different question with a different failure mode, and
 * mixing the two would let a photometric wobble be reported as a fault-tolerance
 * result. The classification arm measures that one on rendered frames.
 *
 * The consequence, stated so nobody has to infer it: **classification is exact
 * in this arm by construction**, which makes every number here an
 * IDEAL-CLASSIFICATION BASELINE rather than an upper bound.
 *
 * The distinction is one review had to correct. Exact classification does bound
 * RECOVERABILITY from above — no amount of photometric trouble helps a mechanism
 * place more frames correctly. It bounds nothing about the failure rates: in a
 * room a misread reference can break a run's structure and produce an extra
 * REFUSAL, which lowers the silent-error rate, or it can leave the structure
 * intact and raise it. Neither direction is established, so "upper bound" was a
 * claim about the room that this experiment never made.
 */

import { makeBenchRng, deriveSeed } from '../../../bench/src/random.ts';
import {
  indexByBookends,
  indexByOrder,
  type ExpectedSequence,
  type FrameKind,
  type FrameObservation,
  type IndexingResult,
} from '../../../solver/src/indexing.ts';
import { EXPERIMENT_ROOT_SEED, FRAMES_PER_PROJECTOR, PROJECTORS, type Arm } from './design.ts';

/** The plan's shape: white, black, then the patterned frames. */
export function expectedSequence(
  projectors = PROJECTORS,
  framesPerProjector = FRAMES_PER_PROJECTOR,
): ExpectedSequence {
  const kinds: FrameKind[] = ['white', 'black'];
  while (kinds.length < framesPerProjector) kinds.push('patterned');
  return { kinds, projectors };
}

/** A photograph on the card: what it looks like, and what it actually is. */
interface Shot {
  lit: number;
  trueFrame: number;
}

function cleanCapture(expected: ExpectedSequence): Shot[] {
  const shots: Shot[] = [];
  for (let p = 0; p < expected.projectors; p++) {
    for (let f = 0; f < expected.kinds.length; f++) {
      const kind = expected.kinds[f];
      shots.push({
        lit: kind === 'white' ? 1 : kind === 'black' ? 0 : 0.5,
        trueFrame: p * expected.kinds.length + f,
      });
    }
  }
  return shots;
}

/**
 * Drops first, then duplicates of what is left.
 *
 * The order is not neutral and is worth naming: applying duplicates first would
 * let a drop remove a frame that had just been duplicated, quietly turning a
 * two-fault trial into a clean one and flattering every mechanism. This way each
 * arm injects the faults it says it does.
 */
export function breakCapture(shots: readonly Shot[], arm: Arm, seed: number): Shot[] {
  const rng = makeBenchRng(seed);
  const out = shots.slice();
  for (let i = 0; i < arm.drops && out.length > 1; i++) {
    out.splice(rng.int(0, out.length - 1), 1);
  }
  for (let i = 0; i < arm.dupes; i++) {
    const at = rng.int(0, out.length - 1);
    out.splice(at, 0, { ...out[at] });
  }
  return out;
}

export type Outcome = 'clean' | 'refused' | 'silent';

export interface TrialResult {
  arm: string;
  seed: number;
  mechanism: 'order' | 'bookends';
  /**
   * `clean` — said nothing was wrong and was right.
   * `refused` — noticed, whether it kept part of the capture or none of it.
   * `silent` — said nothing was wrong and filed at least one photograph under
   * the wrong frame. **The outcome the phase is chosen on.**
   */
  outcome: Outcome;
  /** Photographs filed under a frame they are not. */
  misplaced: number;
  /** Photographs placed at all — the rest are dropped rather than guessed. */
  placed: number;
  /** Projector runs the mechanism declared usable. */
  usableRuns: number;
  /**
   * Runs declared usable that hold a misplaced photograph.
   *
   * The sharpest reading of "notices": a mechanism can refuse a capture as a
   * whole and still hand back a run it has got wrong, and that run would go into
   * a solve carrying a wrong answer with a clean bill of health.
   */
  badUsableRuns: number;
}

function score(
  result: IndexingResult,
  shots: readonly Shot[],
  expected: ExpectedSequence,
  arm: Arm,
  seed: number,
): TrialResult {
  let misplaced = 0;
  let placed = 0;
  const runLength = expected.kinds.length;
  const badRuns = new Set<number>();
  for (let i = 0; i < result.assignment.length; i++) {
    const got = result.assignment[i];
    if (got === null) continue;
    placed++;
    if (got !== shots[i].trueFrame) {
      misplaced++;
      badRuns.add(Math.floor(got / runLength));
    }
  }
  const badUsableRuns = result.usableProjectors.filter((p) => badRuns.has(p)).length;
  const outcome: Outcome = result.ok ? (misplaced === 0 ? 'clean' : 'silent') : 'refused';
  return {
    arm: arm.key,
    seed,
    mechanism: result.mechanism,
    outcome,
    misplaced,
    placed,
    usableRuns: result.usableProjectors.length,
    badUsableRuns,
  };
}

export function seedFor(arm: Arm, trial: number): number {
  return deriveSeed(EXPERIMENT_ROOT_SEED, `indexing/${arm.key}/${trial}`);
}

/** Both mechanisms on the same broken capture, so the comparison is paired. */
export function runTrial(arm: Arm, trial: number, expected: ExpectedSequence): TrialResult[] {
  const seed = seedFor(arm, trial);
  const shots = breakCapture(cleanCapture(expected), arm, seed);
  const observations: FrameObservation[] = shots.map((s, i) => ({
    ordinal: i,
    mean: s.lit,
    litFraction: s.lit,
  }));
  return [
    score(indexByOrder(observations, expected), shots, expected, arm, seed),
    score(indexByBookends(observations, expected), shots, expected, arm, seed),
  ];
}
