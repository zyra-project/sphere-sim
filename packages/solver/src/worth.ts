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
  /** Cameras that contributed nothing at all. */
  silentCameras: number[];
  /** Cameras that contributed something. */
  contributingCameras: number[];
  /** Pairs that contributed nothing. */
  silentPairs: { camera: number; projector: number }[];
  /** The rejection that dominated, if anything was rejected. */
  dominant: { reason: string; count: number; share: number } | null;
  /** False when no pose may be reported at all. */
  usable: boolean;
  /** One line stating what the capture was worth. Always present. */
  summary: string;
  /** Why no pose may be reported. Null when `usable`. */
  refusal: string | null;
}

export function captureWorth(pairs: readonly PairContribution[]): CaptureWorth {
  const accepted = pairs.reduce((a, p) => a + p.stats.accepted, 0);
  const considered = pairs.reduce((a, p) => a + p.stats.considered, 0);

  const byCamera = new Map<number, number>();
  for (const p of pairs) byCamera.set(p.camera, (byCamera.get(p.camera) ?? 0) + p.stats.accepted);
  const cameras = [...byCamera.keys()].sort((a, b) => a - b);
  const silentCameras = cameras.filter((c) => (byCamera.get(c) ?? 0) === 0);
  const contributingCameras = cameras.filter((c) => (byCamera.get(c) ?? 0) > 0);
  const silentPairs = pairs
    .filter((p) => p.stats.accepted === 0)
    .map((p) => ({ camera: p.camera, projector: p.projector }));

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
    return {
      accepted,
      considered,
      silentCameras,
      contributingCameras,
      silentPairs,
      dominant,
      usable: false,
      summary: base,
      refusal:
        `Only ${contributingCameras.length} camera contributed. ${base} A single view cannot ` +
        `separate a projector's distance from its field of view, so this is not a poor ` +
        `calibration but a degenerate one: docs/EXPERIMENT-1.md measures one camera at ` +
        `17 489.84 mm against 41.82 mm for two, and the second camera is worth 418x. ` +
        (silentCameras.length > 0
          ? `Cameras ${silentCameras.map((c) => c + 1).join(', ')} decoded nothing — start there.`
          : `Shoot the sequence from a second position.`),
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
    dominant,
    usable: true,
    summary: base + warnings,
    refusal: null,
  };
}
