// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the page shows about a solve, decided where a test can reach it.
 *
 * ## Why this module exists
 *
 * A calibration that converged and recovered the rig was being thrown away by
 * the display. `solveInstalled` gates whether the model readout shows the
 * RECOVERED pose or the nominal rig's DRIFT, and it counted what the image-space
 * silhouette detector had examined. That detector fits a circle, which no model
 * has, so it never runs on a mesh — the count was zero for every mesh solve
 * there had ever been, the rule failed, and the page showed drift where the
 * answer belonged.
 *
 * THE BUG WAS NOT SUBTLE. What made it survive is that it had nowhere to be
 * caught: every test in this repository reads the `SolveResponse`, and none read
 * the page. The recovered pose was asserted correctly hundreds of times while
 * the thing an operator actually looks at showed something else. The browser
 * smoke test is no help: `smoke:app` does not press Recalibrate unless asked,
 * and when asked it solves on the SPHERE — where this count is non-zero and the
 * bug does not bite — then reads the grid error and the improvement line rather
 * than these cells.
 *
 * The fix for the bug was one field. The fix for the CLASS is this file: the
 * decisions about what a reader sees are pure functions of the response and the
 * page's state, so they belong beside `readout.ts` — which has always been the
 * testable half of the panel — rather than inside a 7800-line DOM module that
 * Node cannot import.
 *
 * ## What belongs here, and what does not
 *
 * Decisions and formatting: given a response and a flag, which number does the
 * reader get, and what does the tooltip tell them it means. Nothing here touches
 * the DOM, holds state, or computes physics — `packages/sim` computes every
 * quantity and `readout.ts` turns metric sets into sentences. This turns a solve
 * into the two or three choices the panel makes about it.
 */

import type { SolveResponse } from './protocol.ts';

/**
 * What installability depends on, named rather than implied.
 *
 * Narrower than `SolveResponse` on purpose: the bug was a decision reading the
 * wrong field, so the fields it may read are written down. Anything not here
 * cannot influence whether a calibration is shown as installed.
 */
export type InstallableSolve = Pick<
  SolveResponse,
  'converged' | 'cameraPositions' | 'silhouetteRefusals'
>;

/**
 * The fewest camera positions a calibration is allowed to be attempted from.
 *
 * Not a judgement call: experiment 1 swept the count over five seeds and the gap
 * between one position and two is three orders of magnitude — median worst-lens
 * error 17,490 mm at one against 41.8 mm at two, with a worst draw of
 * 1,978,378 mm. The knee is at three, so two is poor and one is not a
 * measurement at all.
 *
 * What makes one position DANGEROUS rather than merely bad is that nothing in
 * the answer says so: it converges, to a clean residual, and every diagnostic
 * the solver produces reads healthy. The photographs really are explained. A
 * projector close in and zoomed tight is indistinguishable from one far out and
 * zoomed wide, and one viewpoint cannot tell them apart.
 */
export const MIN_CAMERA_POSITIONS = 2;

/**
 * Whether a solve is one the page may present as the installed calibration.
 *
 * `cameraPositions`, NOT `silhouetteCameras`, and the difference is the bug this
 * module was created for. The second counts what the IMAGE-space detector
 * examined, and that detector never runs on a model — it fits a circle, which no
 * model has. Every successful mesh calibration reported zero cameras examined,
 * failed this rule, and was shown as drift.
 *
 * Refusals still subtract: a camera the detector refused contributed nothing,
 * whatever the denominator is. On a mesh there are none to subtract.
 */
export function solveInstalled(r: InstallableSolve): boolean {
  return r.converged && r.cameraPositions - r.silhouetteRefusals >= MIN_CAMERA_POSITIONS;
}

/**
 * What to tell the reader about a solve the page refused, or null if it kept it.
 *
 * DERIVED FROM THE REFUSAL RATHER THAN BESIDE IT, and the first line is the
 * whole point: this sentence says "The result was not applied", so it must be
 * impossible to produce for a result that was applied. It used to be composed in
 * the handler from `silhouetteCameras` while the install was decided from
 * `cameraPositions`. Those agree only because `packages/bench/src/capture.ts`
 * pushes exactly one silhouette report per camera, and only when image masking
 * is on at all — an invariant of a package on the other side of the worker
 * boundary, held by nothing here. A handler whose two halves agree only on the
 * inputs that happen to be reachable is exactly how `solveInstalled` drifted
 * from the drift cells, twice.
 *
 * The counts are the DETECTOR's, and they belong in the sentence even though the
 * decision does not read them: an operator who is told two of three views were
 * refused knows which photograph to reframe, and "two usable positions" does
 * not tell them that.
 *
 * Null for a refusal the views cannot explain — a solve that never converged.
 * Its own message is the solver's, which names the stop reason and the residual,
 * and inventing a second one here would guess at a cause this module cannot see.
 */
export function solveViewNote(
  r: InstallableSolve & Pick<SolveResponse, 'silhouetteCameras'>,
): string | null {
  if (solveInstalled(r)) return null;
  const usable = r.silhouetteCameras - r.silhouetteRefusals;
  if (r.silhouetteCameras === 0 || usable >= MIN_CAMERA_POSITIONS) return null;
  return (
    `Segmentation could use only ${usable} of ${r.silhouetteCameras} camera views, and a ` +
    `calibration needs at least ${MIN_CAMERA_POSITIONS}. The result was not applied. A refused ` +
    'view found no framed sphere in its photograph — reframe it, or add a position.'
  );
}

/**
 * The solve whose numbers still describe the rig in the room, or null.
 *
 * Three ways to have nothing to show, and they are not interchangeable:
 * nobody has solved yet; somebody moved a lens since the solve, so its residual
 * describes a room that no longer exists; or the solve was refused, and its
 * residual describes a calibration nobody installed. All three fall back to the
 * drift figures, which are always true of the rig as it stands.
 */
export function freshSolve<T extends InstallableSolve>(
  r: T | null,
  rigMovedSinceSolve: boolean,
): T | null {
  if (r === null || rigMovedSinceSolve) return null;
  return solveInstalled(r) ? r : null;
}

/** Why this capture cannot be solved at all, or null if it can. */
export function solveRefusalReason(cameraCount: number): string | null {
  if (cameraCount >= MIN_CAMERA_POSITIONS) return null;
  return (
    `A calibration needs at least ${MIN_CAMERA_POSITIONS} camera positions, and this capture has ` +
    `${cameraCount}. From one spot a projector close in and zoomed tight is indistinguishable ` +
    'from one far out and zoomed wide, so the solve converges to a clean residual and the answer ' +
    'is still metres out — experiment 1 measured a median worst-lens error of 17.5 m at one ' +
    'position against 41.8 mm at two. Move the camera and add a position.'
  );
}

/** Millimetres at a precision that suits the magnitude, or an em dash. */
export function fmtMm(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

export interface PoseCell {
  label: string;
  value: string;
  /** The tooltip, which has to say WHICH quantity this is — see below. */
  title: string;
}

/**
 * The two pose cells: how far the worst lens is from where it should be, and by
 * how much it is aimed wrong.
 *
 * THE TWO SOURCES ARE DIFFERENT QUANTITIES AND THE TOOLTIP SAYS WHICH. Before a
 * usable solve these read the DRIFT — how far the rig in the room has moved from
 * where the software believes it is, which is what recalibrating closes. After
 * one they read the solver's own residual, which is the better number because it
 * has had the unobservable global rotation removed. A reader who cannot tell
 * which one they are looking at cannot tell an improvement from a change of
 * subject, so the two cases carry different text rather than a shared label.
 */
export function poseCells(
  drift: { positionMm: number; aimDeg: number },
  fresh: { posePositionMm: number; poseRotationDeg: number } | null,
): PoseCell[] {
  return [
    {
      label: 'Lens position',
      value: fresh ? `${fmtMm(fresh.posePositionMm)} mm` : `${fmtMm(drift.positionMm)} mm`,
      title: fresh
        ? 'Worst lens position error after removing the unobservable global rotation. Ground truth; the solver never saw it.'
        : 'How far the worst lens has moved from where the software believes it is. Ground truth — recalibrating is what closes it.',
    },
    {
      label: 'Lens aim',
      value: fresh ? `${fresh.poseRotationDeg.toFixed(3)}°` : `${drift.aimDeg.toFixed(3)}°`,
      title: fresh
        ? 'Worst rotation error, roll included, after removing the unobservable global rotation.'
        : 'Worst rotation difference between the two rigs, roll included — the same basis the solver reports after a recalibration, so the two halves of the before-and-after are the same quantity.',
    },
  ];
}
