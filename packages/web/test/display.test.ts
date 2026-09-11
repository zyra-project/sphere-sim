// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the page decides to show, tested for the first time.
 *
 * These decisions lived in `web/main.ts` until a calibration that converged and
 * recovered the rig was thrown away by the display: `solveInstalled` counted
 * what the image-space silhouette detector had examined, that detector never
 * runs on a model, and so every mesh solve there had ever been was reported as
 * not installed and shown as drift.
 *
 * THE INTERESTING PART IS WHY IT SURVIVED. Every test in this repository reads
 * the `SolveResponse`; none read the page. The recovered pose was asserted
 * correctly hundreds of times while the panel showed something else, and the
 * browser smoke test only presses Recalibrate when asked — and then on the
 * sphere, where the count is non-zero and the bug does not bite.
 *
 * The first test below is the one that would have caught it. The rest are the
 * other decisions that were sitting in the same unreachable place.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtMm,
  freshSolve,
  MIN_CAMERA_POSITIONS,
  poseCells,
  solveInstalled,
  solveRefusalReason,
  solveViewNote,
} from '../src/display.ts';

/**
 * Two solves of the same quality, from a MODEL and from the SPHERE.
 *
 * They carry `silhouetteCameras` — which `InstallableSolve` does not include,
 * and which the predicate therefore cannot read — precisely so the regression
 * below can hold the two apart on the field that used to decide. Three camera
 * positions were photographed either way. On the sphere the image detector
 * examined all three; on a model it never ran, because it fits a circle and no
 * model has one.
 */
const MESH_SOLVE = {
  converged: true,
  cameraPositions: 3,
  silhouetteRefusals: 0,
  silhouetteCameras: 0,
};
const SPHERE_SOLVE = {
  converged: true,
  cameraPositions: 3,
  silhouetteRefusals: 0,
  silhouetteCameras: 3,
};

test('a converged mesh calibration counts as installed', () => {
  // THE REGRESSION, and it is the whole reason this file exists. These two
  // solves photographed the same three positions and differ only in the count
  // the image detector reports, which is zero for every model there has ever
  // been. Judging installability on THAT field showed the nominal rig's drift
  // where the recovered pose belonged, for every mesh solve in the project's
  // history — and the answer must now be the same for both.
  assert.equal(solveInstalled(MESH_SOLVE), true, 'a mesh calibration is thrown away again');
  assert.equal(solveInstalled(SPHERE_SOLVE), solveInstalled(MESH_SOLVE));
});

test('installability counts positions photographed, and subtracts what was refused', () => {
  assert.equal(solveInstalled(SPHERE_SOLVE), true);
  // A refused camera contributed nothing, whatever the denominator is.
  assert.equal(
    solveInstalled({ converged: true, cameraPositions: 3, silhouetteRefusals: 2 }),
    false,
    'two of three views refused leaves one position, and one is not a measurement',
  );
  assert.equal(
    solveInstalled({ converged: true, cameraPositions: 3, silhouetteRefusals: 1 }),
    true,
  );
});

test('one camera position is never installable, however clean the residual', () => {
  // The danger is that nothing in the answer says so: it converges, to a clean
  // residual, and every diagnostic reads healthy. See MIN_CAMERA_POSITIONS.
  assert.equal(solveInstalled({ converged: true, cameraPositions: 1, silhouetteRefusals: 0 }), false);
  assert.equal(MIN_CAMERA_POSITIONS, 2);
});

test('a solve that did not converge is not installable at any camera count', () => {
  assert.equal(
    solveInstalled({ converged: false, cameraPositions: 8, silhouetteRefusals: 0 }),
    false,
  );
});

test('three ways to have no fresh solve, and they are not interchangeable', () => {
  // Nobody has solved yet.
  assert.equal(freshSolve(null, false), null);
  // Somebody moved a lens since: the residual describes a room that is gone.
  assert.equal(freshSolve(MESH_SOLVE, true), null);
  // The solve was refused: its residual describes a calibration nobody installed.
  assert.equal(freshSolve({ converged: true, cameraPositions: 1, silhouetteRefusals: 0 }, false), null);
  // And the one way to have one.
  assert.equal(freshSolve(MESH_SOLVE, false), MESH_SOLVE);
});

test('the pose cells fall back to drift, and say that is what they are', () => {
  // The two sources are DIFFERENT QUANTITIES. Drift is how far the rig has moved
  // from where the software believes it is; the solver's residual is what is
  // left after a calibration, with the unobservable global rotation removed. A
  // reader who cannot tell which they are looking at cannot tell an improvement
  // from a change of subject.
  const drift = { positionMm: 41.83, aimDeg: 0.9127 };
  const cold = poseCells(drift, null);
  assert.deepEqual(cold.map((c) => c.label), ['Lens position', 'Lens aim']);
  // The ids are what `tools/smoke-app.ts` finds these cells by, so they are
  // pinned here: a hook that moves with the label stops checking silently.
  assert.deepEqual(cold.map((c) => c.id), ['lens-position', 'lens-aim']);
  assert.equal(cold[0].value, '41.8 mm');
  assert.equal(cold[1].value, '0.913°');
  assert.match(cold[0].title, /moved from where the software believes it is/);
  assert.match(cold[0].title, /recalibrating is what closes it/);

  const solved = poseCells(drift, { posePositionMm: 2.418, poseRotationDeg: 0.0409 });
  assert.deepEqual(solved.map((c) => c.id), ['lens-position', 'lens-aim'], 'the id must not depend on whether a solve landed');
  assert.equal(solved[0].value, '2.42 mm', 'a usable solve must replace the drift figure');
  assert.equal(solved[1].value, '0.041°');
  assert.match(solved[0].title, /after removing the unobservable global rotation/);
  assert.match(solved[0].title, /the solver never saw it/);

  // The tooltips must DIFFER, or the cell silently changes subject.
  assert.notEqual(cold[0].title, solved[0].title);
  assert.notEqual(cold[1].title, solved[1].title);
});

test('a capture with too few positions is refused with the measurement in hand', () => {
  assert.equal(solveRefusalReason(2), null);
  assert.equal(solveRefusalReason(3), null);
  const one = solveRefusalReason(1);
  assert.ok(one !== null, 'one position must be refused');
  // The reason has to carry WHY, because the failure is silent otherwise: a
  // one-position solve converges to a clean residual and is metres out.
  assert.match(one, /at least 2 camera positions, and this capture has 1/);
  assert.match(one, /17\.5 m at one position against 41\.8 mm at two/);
});

test('a note that says the result was not applied cannot appear when it was', () => {
  // The sentence used to be composed in the handler from `silhouetteCameras`
  // while the install was decided from `cameraPositions`. Those agree only
  // because `capture.ts` happens to push exactly one silhouette report per
  // camera — an invariant of a different file, held by nothing in this one.
  //
  // Swept over the shapes a reply can take, INCLUDING the ones that invariant
  // forbids, because the guard is what makes the file boundary stop mattering:
  // a solve the page installed is never described as not applied, whatever the
  // two counts say about each other.
  for (const converged of [true, false]) {
    for (let cameraPositions = 0; cameraPositions <= 4; cameraPositions++) {
      for (let silhouetteCameras = 0; silhouetteCameras <= 4; silhouetteCameras++) {
        for (let silhouetteRefusals = 0; silhouetteRefusals <= 2; silhouetteRefusals++) {
          const r = { converged, cameraPositions, silhouetteCameras, silhouetteRefusals };
          if (!solveInstalled(r)) continue;
          assert.equal(
            solveViewNote(r),
            null,
            `an installed solve is told it was not applied: ${JSON.stringify(r)}`,
          );
        }
      }
    }
  }
});

test('the view note names which photographs to reframe, or says nothing', () => {
  // Two of three views refused leaves one usable position, which is not a
  // measurement — and the DETECTOR's counts are what the sentence carries, even
  // though the decision does not read them. "One usable position" does not tell
  // an operator which photograph to go back to.
  const note = solveViewNote({
    converged: true,
    cameraPositions: 3,
    silhouetteCameras: 3,
    silhouetteRefusals: 2,
  });
  assert.ok(note !== null, 'a capture the detector gutted is applied without a word');
  assert.match(note, /only 1 of 3 camera views/);
  assert.match(note, /The result was not applied/);
  assert.match(note, /reframe it, or add a position/);

  // A mesh solve has no detector counts at all, so the views explain nothing and
  // the note says nothing. Refused here only because it did not converge.
  assert.equal(
    solveViewNote({
      converged: false,
      cameraPositions: 3,
      silhouetteCameras: 0,
      silhouetteRefusals: 0,
    }),
    null,
    'a mesh solve is blamed on camera views that were never examined',
  );
});

test('millimetres are printed at a precision that suits the magnitude', () => {
  assert.equal(fmtMm(1234.5), '1235', 'hundreds and up get no decimals');
  assert.equal(fmtMm(41.83), '41.8', 'tens get one');
  assert.equal(fmtMm(2.418), '2.42', 'units get two');
  assert.equal(fmtMm(-41.83), '-41.8', 'the magnitude decides, not the sign');
  // A cell with no number says so rather than printing NaN at the reader.
  assert.equal(fmtMm(Number.NaN), '—');
  assert.equal(fmtMm(Number.POSITIVE_INFINITY), '—');
});
