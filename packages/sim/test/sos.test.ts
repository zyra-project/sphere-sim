// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The SOS alignment reader and writer.
 *
 * Two groups, and they answer different questions.
 *
 * The first group pins the conventions, which is the same reason
 * `warp.test.ts` exists: every one of them is invisible when wrong. A sign
 * error on the vertical displacement, a frame read as ±aspect instead of ±1, a
 * grid numbered from the bottom — each writes a well-formed file that produces a
 * picture, just the wrong one. So they are pinned against fields whose exact
 * answer is known in closed form (a principal-point shift is a uniform
 * translation; a focal-length ratio is a pure scale; a roll is a pure rotation)
 * rather than against the prose in `sos.ts`.
 *
 * The second group measures the information loss instead of asserting it. The
 * module claims the nine control points cannot express everything; the tests
 * that matter are the ones that say HOW MUCH, on which error modes, and they
 * are what stops "the format is too coarse" from being repeated as a slogan.
 * The measured answer is not the one the slogan predicts — on this rig's pose
 * errors the nine points are very nearly sufficient — and these tests are where
 * that lives, so the claim moves when the number moves.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { RigCalibration } from '../../calibration/src/index.ts';
import { nominalRig } from '../src/scene.ts';
import { prepareRig } from '../src/optics.ts';
import {
  buildSosAlignment,
  buildSosAlignments,
  formatSosAlignment,
  parseSosAlignment,
  sosIdentityVertex,
  vertexDisplacements,
} from '../src/sos.ts';

/** The file a site sent over — the only real sample this module has ever seen. */
const SAMPLE = `translate 0.026 -0.003
scale 1.06606 1.06393
rotate -0.7
1 -0.992 0.998
2 0 1
3 0.992 0.988
4 -1 0.002
5 0 0
6 1 -0.008
7 -1 -1.01
8 0.014 -1
9 1.006 -0.986
`;

const clone = (rig: RigCalibration): RigCalibration =>
  JSON.parse(JSON.stringify(rig)) as RigCalibration;

/** Truth and compositor from one nominal rig, with the truth side perturbed. */
function pair(mutate: (truth: RigCalibration) => void): {
  truth: ReturnType<typeof prepareRig>;
  compositor: ReturnType<typeof prepareRig>;
} {
  const compositor = nominalRig();
  const truth = clone(compositor);
  mutate(truth);
  return { truth: prepareRig(truth), compositor: prepareRig(compositor) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the sample parses, and reads as the identity grid nudged', () => {
  const cfg = parseSosAlignment(SAMPLE);
  assert.equal(cfg.gridSide, 3);
  assert.equal(cfg.vertices.length, 9);
  assert.deepEqual(cfg.translate, { x: 0.026, y: -0.003 });
  assert.deepEqual(cfg.scale, { x: 1.06606, y: 1.06393 });
  assert.equal(cfg.rotateDeg, -0.7);
  assert.deepEqual(cfg.unrecognised, []);

  // No coordinate is more than 0.014 from where an untweaked grid would put it —
  // a seventh of one cell. That is the observation the whole reading rests on:
  // this is a hand-tweak on top of the identity, not an arbitrary mesh, so a
  // displacement against the identity is a meaningful quantity.
  const d = vertexDisplacements(cfg);
  const worstAxis = Math.max(...d.flatMap((v) => [Math.abs(v.dx), Math.abs(v.dy)]));
  assert.ok(worstAxis <= 0.014 + 1e-12, `worst coordinate ${worstAxis}`);
  // Stated per axis and not as a distance, because the two differ here and the
  // looser one is the true bound: vertex 9 is 0.0152 away as a distance.
  const worst = Math.max(...d.map((v) => Math.hypot(v.dx, v.dy)));
  assert.ok(worst > 0.015 && worst < 0.016, `worst displacement ${worst}`);

  // And it is measured against the TOP-left ordering: point 1 is the top-left
  // corner, not the bottom-left. Read the other way every displacement doubles.
  assert.deepEqual(sosIdentityVertex(0, 3), { x: -1, y: 1 });
  assert.deepEqual(sosIdentityVertex(8, 3), { x: 1, y: -1 });
});

test('an unrecognised line is kept rather than dropped or guessed at', () => {
  const cfg = parseSosAlignment(`${SAMPLE}blendcurve 0.8 1.2\n`);
  assert.deepEqual(cfg.unrecognised, [{ line: 13, text: 'blendcurve 0.8 1.2' }]);
});

test('the parser refuses what one sample cannot justify reading', () => {
  const drop = (head: string): string =>
    SAMPLE.split('\n')
      .filter((l) => !l.startsWith(head))
      .join('\n');
  assert.throws(() => parseSosAlignment(drop('rotate')), /no rotate line/);
  assert.throws(() => parseSosAlignment(drop('translate')), /no translate line/);
  assert.throws(() => parseSosAlignment(drop('scale')), /no scale line/);
  // Eight points is not a square grid, so the row/column reading has no basis.
  assert.throws(() => parseSosAlignment(drop('9 ')), /not a square grid/);
  // A gap in the numbering means the file is not the grid this reads it as.
  assert.throws(
    () => parseSosAlignment(SAMPLE.replace('\n5 0 0', '\n55 0 0')),
    /vertex indices are not/,
  );
  assert.throws(() => parseSosAlignment(SAMPLE.replace('-0.7', 'auto')), /non-number/);
  assert.throws(() => parseSosAlignment(SAMPLE.replace('\n5 0 0', '\n5 0 0 0')), /wants 3 numbers/);
});

test('a written file reads back as the same numbers', () => {
  const cfg = parseSosAlignment(SAMPLE);
  const round = parseSosAlignment(formatSosAlignment(cfg));
  assert.deepEqual(round.translate, cfg.translate);
  assert.deepEqual(round.scale, cfg.scale);
  assert.equal(round.rotateDeg, cfg.rotateDeg);
  assert.deepEqual(round.vertices, cfg.vertices);
});

// ---------------------------------------------------------------------------
// The conventions that are invisible when wrong
// ---------------------------------------------------------------------------

test('one rig twice writes the untweaked grid, exactly', () => {
  const rig = prepareRig(nominalRig());
  const out = buildSosAlignment(rig, rig, 0);
  for (let k = 0; k < 9; k++) {
    const want = sosIdentityVertex(k, 3);
    assert.ok(Math.abs(out.alignment.vertices[k].x - want.x) < 1e-9);
    assert.ok(Math.abs(out.alignment.vertices[k].y - want.y) < 1e-9);
  }
  assert.ok(out.residual.fieldRmsPx < 1e-9, `field ${out.residual.fieldRmsPx}`);
  // Not vacuous: the rays did reach the sphere, so the zero is measured.
  assert.ok(out.residual.samples > 100, `${out.residual.samples} samples`);
});

test('a principal-point shift comes out as a uniform slide, in the right direction', () => {
  // The one field whose answer is exact in closed form. `cx = resX/2 * (1 +
  // shiftH)`, so moving the true principal point right by `shiftH` means the
  // real projector must address `shiftH * resX / 2` pixels further right to
  // light the same world point — a uniform translation of `shiftH` in a frame
  // that spans ±1. Every convention in the module rides on this one number:
  // the sign of the displacement, the ±1 frame, and the pixel-to-frame scale.
  const { truth, compositor } = pair((t) => {
    t.projectors[0].intrinsics.shiftH = 0.01;
  });
  const out = buildSosAlignment(truth, compositor, 0);

  for (let k = 0; k < 9; k++) {
    const want = sosIdentityVertex(k, 3);
    assert.ok(
      Math.abs(out.alignment.vertices[k].x - (want.x + 0.01)) < 1e-9,
      `vertex ${k + 1} x ${out.alignment.vertices[k].x}`,
    );
    assert.ok(Math.abs(out.alignment.vertices[k].y - want.y) < 1e-9);
  }
  assert.ok(Math.abs(out.equivalentAffine.translate.x - 0.01) < 1e-9);
  assert.ok(Math.abs(out.equivalentAffine.translate.y) < 1e-9);
  // A pure translation is exactly affine, so nothing is left for the vertices.
  assert.ok(out.residual.affineRmsPx < 1e-9, `affine residual ${out.residual.affineRmsPx}`);
  // And the field it corrected was real: 0.01 of a 1920 frame is 9.6 pixels.
  assert.ok(Math.abs(out.residual.fieldRmsPx - 9.6) < 1e-6, `field ${out.residual.fieldRmsPx}`);
});

test('a focal-length ratio comes out as that ratio, on both axes', () => {
  const k = 1.05;
  const { truth, compositor } = pair((t) => {
    const it = t.projectors[0].intrinsics;
    const half = Math.tan(((it.fovHDeg * Math.PI) / 180) / 2);
    it.fovHDeg = ((2 * Math.atan(half / k)) * 180) / Math.PI;
  });
  const out = buildSosAlignment(truth, compositor, 0);
  assert.ok(Math.abs(out.equivalentAffine.scale.x - k) < 1e-9, `${out.equivalentAffine.scale.x}`);
  assert.ok(Math.abs(out.equivalentAffine.scale.y - k) < 1e-9, `${out.equivalentAffine.scale.y}`);
  assert.ok(Math.abs(out.equivalentAffine.rotateDeg) < 1e-9);
  assert.ok(Math.abs(out.equivalentAffine.shear) < 1e-9);
  assert.ok(out.residual.affineRmsPx < 1e-9);

  // Scaling the frame up pushes every vertex but the centre past the edge of the
  // frame, and they are reported rather than clamped: a projector asked to put
  // content outside its own raster cannot, and the file saying so is the point.
  // This is the state the sample file is also in — three of its nine points are
  // outside ±1 — so it is a real configuration and not an error here.
  assert.deepEqual(out.outOfFrame, [1, 2, 3, 4, 6, 7, 8, 9]);
});

test('a roll is exactly affine, and the file\u2019s frame inflates its angle by the aspect', () => {
  const { truth, compositor } = pair((t) => {
    t.projectors[0].pose.rollDeg += 1;
  });
  const out = buildSosAlignment(truth, compositor, 0);
  assert.ok(out.residual.fieldRmsPx > 5, `field ${out.residual.fieldRmsPx}`);
  // Exactly affine — a roll about the optical axis is a rotation in the image
  // plane and nothing else. If the affine stage were subtly wrong this is the
  // case that would show it, because the right answer is zero and not "small".
  assert.ok(out.residual.affineRmsPx < 1e-6, `affine residual ${out.residual.affineRmsPx}`);

  // On screen it is a rotation, of the angle rolled, with unit scale and no
  // shear. That is the physical answer and it is the one that comes out clean.
  assert.ok(Math.abs(Math.abs(out.screenAffine.rotateDeg) - 1) < 1e-6, `${out.screenAffine.rotateDeg}`);
  assert.ok(Math.abs(out.screenAffine.scale.x - 1) < 1e-9);
  assert.ok(Math.abs(out.screenAffine.scale.y - 1) < 1e-9);
  assert.ok(Math.abs(out.screenAffine.shear) < 1e-9);

  // In the file's own ±1 frame the SAME map is not a rotation at all: the frame
  // squashes 1920 into the width it gives 1080, so the angle comes back
  // multiplied by the aspect ratio and a shear appears from nowhere. An angle
  // read out of one of these files is not degrees on the wall, and this is the
  // test that says so.
  const aspect = 1920 / 1080;
  assert.ok(
    Math.abs(Math.abs(out.equivalentAffine.rotateDeg) - Math.atan(aspect * Math.tan(Math.PI / 180)) * (180 / Math.PI)) < 1e-6,
    `${out.equivalentAffine.rotateDeg}`,
  );
  assert.ok(Math.abs(out.equivalentAffine.shear) > 0.02, `${out.equivalentAffine.shear}`);
});

test('the writer emits the identity affine and nothing else, whatever the fit', () => {
  // The module's one deliberate refusal: SOS's composition order for
  // translate/scale/rotate against the mesh is not known from one sample, so
  // the correction rides entirely in the vertices, where every order agrees.
  // The equivalent affine is computed and reported — it is the number
  // comparable to a site's own file — and must never reach the file itself.
  const { truth, compositor } = pair((t) => {
    t.projectors[0].pose.yawDeg += 1;
    t.projectors[0].intrinsics.shiftH = 0.02;
  });
  const out = buildSosAlignment(truth, compositor, 0);
  assert.ok(Math.abs(out.equivalentAffine.translate.x) > 0.01, 'the fit found a real affine');

  const text = formatSosAlignment(out.alignment);
  assert.match(text, /^translate 0\.000000 0\.000000$/m);
  assert.match(text, /^scale 1\.000000 1\.000000$/m);
  assert.match(text, /^rotate 0\.000000$/m);

  // Three fields per vertex line, and there is no fourth to put a blend in.
  // The intensity `warp.ts` computes has nowhere to go in this format; SOS
  // blends in a separate subsystem entirely. That is the one derogation no
  // residual below can measure, so it is pinned structurally instead.
  const vertexLines = text.trim().split('\n').slice(3);
  assert.equal(vertexLines.length, 9);
  for (const line of vertexLines) assert.equal(line.split(' ').length, 3);
});

// ---------------------------------------------------------------------------
// What the reduction costs, measured
// ---------------------------------------------------------------------------

test('on a pose error the nine points are very nearly sufficient', () => {
  // The result that contradicts the obvious reading of "only nine control
  // points". A projector's pose error, seen through its frustum onto a sphere,
  // produces a displacement field that is very nearly affine — so the coarse
  // mesh is not what limits SOS alignment on this rig. What limits it is that
  // the nine numbers are found by eye.
  //
  // Measured at 61x61 samples on the nominal rig: a 1-degree yaw is a 55-pixel
  // field, of which the affine stage leaves 0.51 px and the nine points leave
  // 0.096 px. The gates below sit well clear of those.
  const { truth, compositor } = pair((t) => {
    t.projectors[0].pose.yawDeg += 1;
  });
  const out = buildSosAlignment(truth, compositor, 0, { samples: 61 });
  assert.ok(out.residual.fieldRmsPx > 50, `field ${out.residual.fieldRmsPx}`);
  assert.ok(out.residual.meshRmsPx < 0.2, `mesh residual ${out.residual.meshRmsPx}`);
  assert.ok(
    out.residual.meshRmsPx < out.residual.fieldRmsPx / 100,
    'the nine points remove over 99% of a pose field',
  );
});

test('parallax is the error mode the coarse mesh actually loses to', () => {
  // A rotation moves every ray the same way; a TRANSLATION of the lens moves
  // them by an amount that depends on how far away the surface is, and depth
  // across a sphere is not bilinear in the frame. So the residual fraction, not
  // the residual, is what separates the two — and it separates them by more
  // than an order of magnitude.
  const rot = buildSosAlignment(
    ...rigsFor((t) => {
      t.projectors[0].pose.yawDeg += 1;
    }),
    0,
    { samples: 61 },
  );
  const trans = buildSosAlignment(
    ...rigsFor((t) => {
      t.projectors[0].pose.position.x += 0.2;
    }),
    0,
    { samples: 61 },
  );
  const rotFrac = rot.residual.meshRmsPx / rot.residual.fieldRmsPx;
  const transFrac = trans.residual.meshRmsPx / trans.residual.fieldRmsPx;
  // Measured: 0.17% against 3.1%, a factor of 18.
  assert.ok(transFrac > 5 * rotFrac, `${transFrac} vs ${rotFrac}`);
  // Still sub-pixel in absolute terms on a 20 cm error, which is the other half
  // of the finding: the coarse mesh loses proportionally, not catastrophically.
  assert.ok(trans.residual.meshRmsPx < 1, `${trans.residual.meshRmsPx} px`);
});

test('lens distortion is what nine points cannot express, and more points can', () => {
  // The one field where the format's low order genuinely binds. A radial term is
  // even-symmetric about the centre and grows with radius; the bilinear basis on
  // a 2x2 partition has no shape like it, so the nine points recover almost
  // nothing that the global affine had not already taken.
  //
  // Measured with k1 = 0.05: field 0.379 px rms, affine leaves 0.126, the nine
  // points leave 0.121 — a further 4%. A 9x9 mesh leaves 0.019.
  const [truth, compositor] = rigsFor((t) => {
    t.projectors[0].intrinsics.k1 = 0.05;
  });
  const coarse = buildSosAlignment(truth, compositor, 0, { samples: 61 });
  const fine = buildSosAlignment(truth, compositor, 0, { samples: 61, gridSide: 9 });

  assert.ok(
    coarse.residual.meshRmsPx > coarse.residual.fieldRmsPx / 5,
    `the nine points leave a fifth of the field: ${coarse.residual.meshRmsPx} of ${coarse.residual.fieldRmsPx}`,
  );
  assert.ok(
    coarse.residual.meshRmsPx > 0.9 * coarse.residual.affineRmsPx,
    'and almost all of what the affine left',
  );
  // A finer grid takes it out, which is what makes this a limit of the FORMAT
  // rather than of the fit. Nothing SOS reads has a finer grid.
  assert.ok(fine.residual.meshRmsPx < coarse.residual.meshRmsPx / 2, `${fine.residual.meshRmsPx}`);

  // And the absolute numbers stay sub-pixel, because the sphere sits in the
  // middle of the frame where a radial term is smallest. The format's worst
  // error mode is also the one this rig has least of.
  assert.ok(coarse.residual.fieldMaxPx < 2, `${coarse.residual.fieldMaxPx} px`);
});

test('a projector that reaches nothing writes the identity rather than a guess', () => {
  const { truth, compositor } = pair((t) => {
    t.projectors[0].pose.yawDeg += 1;
  });
  // Aim the compositor's projector at the floor: no ray reaches the body, so no
  // sample constrains anything and there is no measurement to reduce.
  const aimed = clone(compositor.rig);
  aimed.projectors[0].pose.pitchDeg -= 80;
  const out = buildSosAlignment(truth, prepareRig(aimed), 0);
  assert.equal(out.residual.samples, 0);
  assert.ok(out.residual.attempted > 100);
  for (let k = 0; k < 9; k++) {
    assert.deepEqual(
      { x: out.alignment.vertices[k].x, y: out.alignment.vertices[k].y },
      sosIdentityVertex(k, 3),
    );
  }
  assert.deepEqual(out.vertexSupport, new Array<number>(9).fill(0));
});

test('every projector in the rig gets a file, in rig order', () => {
  const { truth, compositor } = pair((t) => {
    for (const p of t.projectors) p.pose.yawDeg += 0.5;
  });
  const all = buildSosAlignments(truth, compositor);
  assert.equal(all.length, compositor.projectors.length);
  all.forEach((out, i) => assert.equal(out.projectorId, compositor.projectors[i].cal.id));
});

/** {@link pair}, as a tuple, for the call sites that spread it. */
function rigsFor(
  mutate: (truth: RigCalibration) => void,
): [ReturnType<typeof prepareRig>, ReturnType<typeof prepareRig>] {
  const { truth, compositor } = pair(mutate);
  return [truth, compositor];
}
