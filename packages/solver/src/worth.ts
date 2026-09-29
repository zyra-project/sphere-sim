// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What a capture was worth, said before a pose is said.
 *
 * Phase 3 of `docs/OPERATOR-PATH.md`, second half, and the half the plan calls
 * "the honesty":
 *
 * > **report what the capture was worth before reporting a pose** — how many
 * > correspondences survived, from how many pairs, and which cameras contributed
 * > nothing. A solve on a capture nothing reached currently returns
 * > `converged: true` with the untouched bootstrap's own error presented as a
 * > result, and that guard exists in the pipeline because it happened.
 *
 * That guard lives in `packages/web/src/pipeline.ts`, guards the simulator's own
 * solve, and carries the measurement that motivated it: zero correspondences,
 * `converged: true`, a residual of 0.0000 px, and a worst-lens error of
 * 266.951 mm — the untouched bootstrap's distance from truth, reported as a
 * calibration. This module is that idea generalised, moved to where a real
 * capture passes through, and widened from one refusal into a report.
 *
 * ## Why a report rather than a number
 *
 * `docs/OPERATOR-PATH.md` ranks "understanding a failure" as friction 8 and says
 * why: *"It didn't converge" sends an operator home.* Every rejection the
 * decoder performs is already counted in {@link DecodeStats}, in buckets that
 * are separated on purpose — a capture that was too dim and one that was full of
 * room are different problems with the same correspondence count. Turning those
 * counts into a sentence naming the dominant one is most of the difference
 * between a number and an answer.
 *
 * ## The two refusals, and why only two
 *
 * **Nothing decoded.** Arithmetic, not judgement: there is no pose to report.
 *
 * **Fewer than two cameras contributed.** `docs/EXPERIMENT-1.md` measures this
 * rather than asserting it — one camera is degenerate at 17 489.84 mm, because a
 * single view cannot separate a projector's distance from its field of view, and
 * the second camera is worth 418x. A one-camera capture does not produce a poor
 * calibration; it produces a number with no information in it.
 *
 * Everything else is reported beside the pose rather than used to withhold it,
 * because what a thin capture costs on a real sphere is unmeasured, and a
 * threshold invented here would become the thing the pipeline rested on.
 */

import type { DecodeStats } from './decode.ts';

/** One camera's view of one projector, and what the decoder made of it. */
export interface PairContribution {
  camera: number;
  projector: number;
  stats: DecodeStats;
}

/** A rejection bucket in words an operator can act on. */
const REASONS: { key: keyof DecodeStats; say: string }[] = [
  {
    key: 'rejectedLowModulation',
    say:
      'the projector’s light never reached them brightly enough to read — too dim, too oblique, ' +
      'or past the limb',
  },
  {
    key: 'rejectedOffImage',
    say: 'they were outside the sphere mask, so nothing tried to decode them',
  },
  {
    key: 'rejectedOffSphere',
    say: 'they decoded cleanly and then landed somewhere that is not the sphere — room, floor, ' +
      'or a reflection',
  },
  {
    key: 'rejectedGrayAmbiguous',
    say: 'the Gray planes did not separate from their own complements — the finest stripes are ' +
      'probably finer than the camera can resolve at this distance',
  },
  {
    key: 'rejectedPhaseWeak',
    say: 'the fringes were there but too faint to phase — the same symptom as a bright room',
  },
  {
    key: 'rejectedDisagreement',
    say: 'the Gray address and the phase estimate disagreed, which is what a mis-indexed or ' +
      'shifted capture looks like from inside the decoder',
  },
  { key: 'rejectedOutOfRange', say: 'they decoded to a projector coordinate off its own raster' },
  { key: 'rejectedMissingAxis', say: 'one of the two axes was absent for them' },
];

export interface CaptureWorth {
  /** Correspondences that survived, across every pair. */
  accepted: number;
  /** Camera pixels the decoder looked at. */
  considered: number;
  /**
   * Cameras that contributed nothing at all: those whose pairs accepted no
   * point, and, where the caller names the cameras handed in, those with no
   * pair.
   */
  silentCameras: number[];
  /** Cameras that contributed something. */
  contributingCameras: number[];
  /** Pairs that contributed nothing. */
  silentPairs: { camera: number; projector: number }[];
  /**
   * Per projector, the cameras that decoded anything against it: every
   * projector a pair names, and every projector of the rig where its count was
   * given.
   *
   * A projector is solved from the views that saw IT, so this rather than the
   * capture-wide camera count is what the degeneracy below is about.
   */
  camerasPerProjector: { projector: number; cameras: number[] }[];
  /** The rejection that dominated, if anything was rejected. */
  dominant: { reason: string; count: number; share: number } | null;
  /** False when no pose may be reported at all. */
  usable: boolean;
  /** One line stating what the capture was worth. Always present. */
  summary: string;
  /** Why no pose may be reported. Null when `usable`. */
  refusal: string | null;
}

/**
 * What the capture was worth, from what each camera decoded of each projector.
 *
 * `projectors`, where the caller knows the rig, is how many projectors it has.
 * Without it only the projectors some pair names can be judged, and a projector
 * no camera decoded — every run of it refused, say, at every position — is not
 * in the report at all: two cameras that each decoded projectors 1 to 3 of a
 * four-projector rig passed as usable, with projector 4 unmentioned. With it,
 * such a projector is refused like one only a single camera decoded, named with
 * none.
 *
 * `handedIn`, where the caller knows them, are the cameras handed in. Without
 * them a camera is known only by its pairs, and one none of whose runs reached
 * the decoder has none: a session holding camera 1's decoded runs and camera
 * 2's folder, refused whole, was told a second camera position was needed,
 * beneath a list naming camera 2. With them, such a camera is silent, like one
 * whose runs decoded no point, and is named as one.
 */
export function captureWorth(
  pairs: readonly PairContribution[],
  projectors?: number,
  handedIn?: readonly number[],
): CaptureWorth {
  const accepted = pairs.reduce((a, p) => a + p.stats.accepted, 0);
  const considered = pairs.reduce((a, p) => a + p.stats.considered, 0);

  const byCamera = new Map<number, number>();
  for (const c of handedIn ?? []) byCamera.set(c, 0);
  for (const p of pairs) byCamera.set(p.camera, (byCamera.get(p.camera) ?? 0) + p.stats.accepted);
  const cameras = [...byCamera.keys()].sort((a, b) => a - b);
  const silentCameras = cameras.filter((c) => (byCamera.get(c) ?? 0) === 0);
  const contributingCameras = cameras.filter((c) => (byCamera.get(c) ?? 0) > 0);
  const silentPairs = pairs
    .filter((p) => p.stats.accepted === 0)
    .map((p) => ({ camera: p.camera, projector: p.projector }));

  /**
   * Cameras grouped by the projector they actually saw.
   *
   * The capture-wide count answers a different question than the one that
   * matters. Camera 1 contributing only to projector 1 and camera 2 only to
   * projector 2 is two contributing cameras and two one-view projectors: every
   * lens in the rig carries the distance-versus-field-of-view degeneracy this
   * refusal exists to name, while the capture-wide test waves it through.
   */
  const byProjector = new Map<number, Set<number>>();
  for (let p = 0; p < (projectors ?? 0); p++) byProjector.set(p, new Set());
  for (const p of pairs) {
    if (!byProjector.has(p.projector)) byProjector.set(p.projector, new Set());
    if (p.stats.accepted > 0) byProjector.get(p.projector)?.add(p.camera);
  }
  const camerasPerProjector = [...byProjector.entries()]
    .map(([projector, set]) => ({ projector, cameras: [...set].sort((a, b) => a - b) }))
    .sort((a, b) => a.projector - b.projector);
  const underseen = camerasPerProjector.filter((e) => e.cameras.length < 2);

  const rejected = REASONS.map((r) => ({
    reason: r.say,
    count: pairs.reduce((a, p) => a + (p.stats[r.key] as number), 0),
  }));
  const totalRejected = rejected.reduce((a, r) => a + r.count, 0);
  const worst = rejected.reduce((m, r) => (r.count > m.count ? r : m), { reason: '', count: 0 });
  const dominant =
    worst.count > 0
      ? { reason: worst.reason, count: worst.count, share: worst.count / Math.max(1, totalRejected) }
      : null;

  const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
  const base =
    `${accepted.toLocaleString()} points decoded from ${pairs.length} ` +
    `${plural(pairs.length, 'camera-projector pair')}, out of ${considered.toLocaleString()} ` +
    `camera pixels examined` +
    (dominant === null
      ? '.'
      : `. Of what was thrown away, ${(100 * dominant.share).toFixed(0)}% went because ` +
        `${dominant.reason}.`);

  if (accepted === 0) {
    return {
      accepted,
      considered,
      silentCameras,
      contributingCameras,
      silentPairs,
      camerasPerProjector,
      dominant,
      usable: false,
      summary: base,
      refusal:
        `Nothing decoded. ${base} There is no pose to report: a bundle adjustment given no ` +
        `points returns the rig it started from, with a residual of zero and every appearance ` +
        `of having converged — which is the most confident-looking result this project can ` +
        `produce and the one backed by no data at all.`,
    };
  }

  if (contributingCameras.length < 2) {
    /**
     * The remedy, which may not presume that nothing else was shot.
     *
     * It read "Shoot the sequence from a second position." `docs/EXPERIMENT-10.md`'s
     * Q0 recorded this refusal, ending that way, for a clean folder of the bench's
     * own three-camera capture, and says the emitter page printed it "for a folder,
     * whatever the folder holds": the page read one camera position at a time and
     * handed this function only that position's pairs. A caller in that state may
     * already hold the second position's photographs, and then the remedy is to
     * hand them in, not to go back to the sphere. Which is true is the caller's to
     * know, so the sentence offers both.
     *
     * The other arm is reached only when a camera was handed in and decoded
     * nothing, which a one-position-at-a-time caller could never do: its one
     * camera either contributed or left nothing decoded at all, which is refused
     * above. It said "Cameras 2" for a single camera, unnoticed while nothing
     * reached it; it is singular for one now. A camera none of whose runs
     * reached the decoder is one of these where the caller names the cameras
     * handed in (`handedIn`); where it does not, that camera has no pair, and
     * the sentence asks for a second position the caller already holds.
     */
    const remedy =
      silentCameras.length > 0
        ? `Camera${silentCameras.length === 1 ? '' : 's'} ` +
          `${silentCameras.map((c) => c + 1).join(', ')} decoded nothing — start there.`
        : `A second camera position is needed: hand in its photographs, or shoot one.`;
    return {
      accepted,
      considered,
      silentCameras,
      contributingCameras,
      silentPairs,
      camerasPerProjector,
      dominant,
      usable: false,
      summary: base,
      refusal:
        `Only ${contributingCameras.length} camera contributed. ${base} A single view cannot ` +
        `separate a projector's distance from its field of view, so this is not a poor ` +
        `calibration but a degenerate one: docs/EXPERIMENT-1.md measures one camera at ` +
        `17 489.84 mm against 41.82 mm for two, and the second camera is worth 418x. ` +
        remedy,
    };
  }

  /**
   * The same degeneracy per projector, which the capture-wide count cannot see.
   *
   * Two cameras that each saw a different projector pass the test above and
   * leave every projector solved from a single view. It is the same refusal for
   * the same reason; it just has to be asked once per lens rather than once per
   * capture.
   */
  if (underseen.length > 0) {
    const named = underseen
      .map((e) => `P${e.projector + 1} (${e.cameras.length})`)
      .join(', ');
    return {
      accepted,
      considered,
      silentCameras,
      contributingCameras,
      silentPairs,
      camerasPerProjector,
      dominant,
      usable: false,
      summary: base,
      refusal:
        `${underseen.length === 1 ? 'A projector was' : `${underseen.length} projectors were`} ` +
        `seen by fewer than two cameras: ${named}. ${base} ${contributingCameras.length} cameras ` +
        `contributed across the capture as a whole, but a projector is solved from the views ` +
        `that saw IT, and one view cannot separate its distance from its field of view — ` +
        `docs/EXPERIMENT-1.md measures one camera at 17 489.84 mm against 41.82 mm for two. ` +
        `Move so that every projector's light is in shot from at least two positions.`,
    };
  }

  const warnings =
    silentCameras.length > 0
      ? ` Camera${silentCameras.length === 1 ? '' : 's'} ` +
        `${silentCameras.map((c) => c + 1).join(', ')} contributed nothing and ` +
        `${silentCameras.length === 1 ? 'is' : 'are'} not in this result.`
      : '';

  return {
    accepted,
    considered,
    silentCameras,
    contributingCameras,
    silentPairs,
    camerasPerProjector,
    dominant,
    usable: true,
    summary: base + warnings,
    refusal: null,
  };
}
