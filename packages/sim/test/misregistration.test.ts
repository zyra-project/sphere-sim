// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The raster-source path of the two-calibration trace.
 *
 * A frame of the structured-light sequence is written straight into each
 * projector's raster, so the trace must stop at the PHYSICAL pixel and consult
 * no calibration's belief about where that pixel lands. Every test below is a
 * property of that sentence rather than of the code that implements it:
 *
 *   - A frame that is a linear ramp across the raster comes back as exactly the
 *     physical pixel coordinate the point is lit from. Bilinear reconstruction
 *     reproduces a linear function, so any other number means the wrong pixel,
 *     the wrong weights, or a blend weight nobody should be applying.
 *   - Changing the content rig, the image, the graticule or the polar mask moves
 *     no byte of a raster render, and does move a content render.
 *   - A projector outside the mask is a projector sent zero: still present,
 *     still leaking its black floor.
 *   - A reconstruction corner off the raster's edge reads the edge pixel.
 *
 * The frame is a plain function here, not `compileFrame`: this package may
 * import `packages/calibration` and nothing else, its tests included. The real
 * pattern is checked against the real definition in `packages/web`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChannelTriplet, RigCalibration } from '../../calibration/src/index.ts';
import { flatField } from '../src/equirect.ts';
import { renderTwoRigRoomView, traceTwoRig } from '../src/misregistration.ts';
import type { RasterSource } from '../src/misregistration.ts';
import { pixelToRay, prepareRig, worldToPixel } from '../src/optics.ts';
import type { PreparedRig } from '../src/optics.ts';
import { defaultScene } from '../src/render.ts';
import type { Scene, ViewerCamera } from '../src/render.ts';
import { injectMisalignment, nominalRig } from '../src/scene.ts';
import type { ProjectorContribution, ShadingModel } from '../src/shading.ts';

const TRUTH = prepareRig(nominalRig());
/** The same room with every lens knocked by a §2 draw — a compositor that is wrong. */
const WRONG = prepareRig(injectMisalignment(nominalRig(), 771003).rig);

const CAMERA: ViewerCamera = {
  position: { x: 3.4, y: 2.2, z: 0.6 },
  target: { x: 0, y: 0, z: 0 },
  upHint: { x: 0, y: 0, z: 1 },
  fovHDeg: 42,
  width: 56,
  height: 42,
};

/** Every projector of a four-projector rig. */
const ALL = 0b1111;

/** The frame is the pixel's own column, as a fraction of the raster. */
function rampAcross(mask = ALL): RasterSource {
  return {
    mask,
    at: (i, column) => (column + 0.5) / TRUTH.projectors[i].cal.intrinsics.resX,
  };
}

/** A shading model that keeps what it was handed and returns black. */
function capturing(): { model: ShadingModel; last: () => ProjectorContribution[] } {
  let seen: ProjectorContribution[] = [];
  return {
    model: {
      name: 'capture',
      shade(input): ChannelTriplet {
        seen = input.contributions;
        return { r: 0, g: 0, b: 0 };
      },
    },
    last: () => seen,
  };
}

/** A scene whose encode is the identity, so a signal IS the frame's value. */
function linearScene(overrides: Partial<Scene> = {}): Scene {
  return defaultScene(flatField(64, 32, { r: 0.3, g: 0.3, b: 0.3 }), {
    encodeGamma: { r: 1, g: 1, b: 1 },
    ...overrides,
  });
}

/**
 * The point projector `i` lights from pixel (u, v), and a ray from its own lens
 * that reaches it. From the lens the first hit IS that point, so the trace finds
 * the pixel it was aimed at to within rounding.
 */
function aimedAt(rig: PreparedRig, i: number, u: number, v: number) {
  const p = rig.projectors[i];
  return { origin: p.lens, dir: pixelToRay(p, u, v) };
}

function bytes(a: Float32Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

test('without a raster source the trace is the content trace, however the absence is said', () => {
  const scene = defaultScene(flatField(64, 32, { r: 0.5, g: 0.4, b: 0.3 }));
  const plain = renderTwoRigRoomView(TRUTH, WRONG, scene, CAMERA, { samplesPerPixel: 1 });
  for (const raster of [null, undefined]) {
    const again = renderTwoRigRoomView(TRUTH, WRONG, scene, CAMERA, { samplesPerPixel: 1, raster });
    assert.deepEqual(bytes(again.data), bytes(plain.data), `raster: ${raster} changed the content render`);
  }
});

test('a raster frame is read at the physical pixel, reconstructed exactly, and blended by nothing', () => {
  // A ramp across the raster, bilinear over pixel centres, returns the pixel
  // coordinate itself. So the signal each emitting projector sends must be its
  // PHYSICAL u over the raster width — against a compositor that believes the
  // lenses are somewhere else, which is the case where reading the wrong rig
  // would show.
  const scene = linearScene();
  const cap = capturing();
  let checked = 0;
  let wouldDiffer = 0;
  for (let i = 0; i < TRUTH.projectors.length; i++) {
    const it = TRUTH.projectors[i].cal.intrinsics;
    for (const [u, v] of [
      [0.5 * it.resX, 0.5 * it.resY],
      [0.37 * it.resX + 0.25, 0.61 * it.resY],
      [0.52 * it.resX + 0.75, 0.33 * it.resY + 0.5],
      [0.45 * it.resX, 0.8 * it.resY + 0.125],
    ]) {
      const ray = aimedAt(TRUTH, i, u, v);
      traceTwoRig(ray.origin, ray.dir, TRUTH, WRONG, scene, cap.model, rampAcross());
      const mine = cap.last().find((c) => c.projector === i);
      assert.ok(mine, `P${i + 1} does not light the point it was aimed at`);
      const hit = TRUTH.surface.intersect(ray.origin, ray.dir);
      assert.ok(hit);
      const px = worldToPixel(TRUTH.projectors[i], hit.point);
      assert.ok(px);
      const expected = px.u / it.resX;
      assert.ok(
        Math.abs(mine.signal.r - expected) < 1e-12,
        `P${i + 1} at (${u}, ${v}) sent ${mine.signal.r}, not its own pixel ${expected}`,
      );
      assert.equal(mine.signal.g, mine.signal.r);
      assert.equal(mine.signal.b, mine.signal.r);
      assert.equal(mine.weight, 1, 'a calibration frame is blended by nothing');
      // Non-vacuity: the compositor's pixel for the same point is elsewhere, so
      // a trace that asked it would have been caught above.
      const believed = worldToPixel(WRONG.projectors[i], hit.point);
      if (!believed || Math.abs(believed.u - px.u) > 1) wouldDiffer++;
      checked++;
    }
  }
  assert.equal(checked, 16);
  assert.ok(wouldDiffer >= 8, `the compositor agreed with the lenses at ${16 - wouldDiffer} of 16 points`);
});

test('a projector outside the mask is sent zero: still present, still leaking', () => {
  const scene = linearScene();
  const cap = capturing();
  const it = TRUTH.projectors[0].cal.intrinsics;
  const ray = aimedAt(TRUTH, 0, 0.5 * it.resX, 0.5 * it.resY);
  traceTwoRig(ray.origin, ray.dir, TRUTH, WRONG, scene, cap.model, rampAcross(0b0010));
  const p1 = cap.last().find((c) => c.projector === 0);
  assert.ok(p1, 'a projector sent black must still be in the room: its black floor lands');
  assert.deepEqual(p1.signal, { r: 0, g: 0, b: 0 });
  assert.equal(p1.weight, 0);

  // And the picture agrees: leaving a projector out of the mask is exactly
  // sending it a frame of zeros, byte for byte.
  const onlyP2 = renderTwoRigRoomView(TRUTH, TRUTH, scene, CAMERA, { raster: rampAcross(0b0010) });
  const zeros: RasterSource = {
    mask: ALL,
    at: (i, column) => (i === 1 ? (column + 0.5) / TRUTH.projectors[1].cal.intrinsics.resX : 0),
  };
  const sentZero = renderTwoRigRoomView(TRUTH, TRUTH, scene, CAMERA, { raster: zeros });
  assert.deepEqual(bytes(onlyP2.data), bytes(sentZero.data));
});

test('the content rig, the image, the graticule and the polar mask never reach a raster frame', () => {
  const frame = rampAcross();
  const base = defaultScene(flatField(64, 32, { r: 0.1, g: 0.1, b: 0.1 }));
  const bright = defaultScene(flatField(64, 32, { r: 0.9, g: 0.9, b: 0.9 }), {
    graticule: { spacingDeg: 15, lineWidthDeg: 0.35, emphasizeAxes: true, color: { r: 1, g: 1, b: 1 } },
    maskInterpretation: 'colatitude',
  });
  const masked: RigCalibration = nominalRig({ blend: { maskLoDeg: 5, maskHiDeg: 10 } });
  const variants: { name: string; content: PreparedRig; scene: Scene }[] = [
    { name: 'a wrong compositor', content: WRONG, scene: base },
    { name: 'another image, a graticule and the other mask reading', content: TRUTH, scene: bright },
    { name: 'a polar mask covering most of the ball', content: prepareRig(masked), scene: base },
  ];
  const reference = renderTwoRigRoomView(TRUTH, TRUTH, base, CAMERA, { raster: frame });
  let lit = 0;
  for (let k = 0; k < reference.data.length; k++) if (reference.data[k] > 0.05) lit++;
  assert.ok(lit > 500, `the raster render lit only ${lit} channels; the comparison would be vacuous`);
  for (const v of variants) {
    const withFrame = renderTwoRigRoomView(TRUTH, v.content, v.scene, CAMERA, { raster: frame });
    assert.deepEqual(bytes(withFrame.data), bytes(reference.data), `${v.name} reached a raster frame`);
    // And each variant is one the CONTENT trace does see, so the equality above
    // is a statement about the raster path rather than about a variant that
    // changes nothing.
    const contentBefore = renderTwoRigRoomView(TRUTH, TRUTH, base, CAMERA);
    const contentAfter = renderTwoRigRoomView(TRUTH, v.content, v.scene, CAMERA);
    assert.notDeepEqual(
      bytes(contentAfter.data),
      bytes(contentBefore.data),
      `${v.name} does not change the content render either`,
    );
  }
});

test('a reconstruction corner off the raster reads the edge pixel', () => {
  // A narrow lens puts the whole raster inside the silhouette, so its edge rows
  // and columns land on the ball and can be traced to.
  const narrow = nominalRig();
  narrow.projectors[0] = {
    ...narrow.projectors[0],
    intrinsics: { ...narrow.projectors[0].intrinsics, fovHDeg: 8 },
  };
  const rig = prepareRig(narrow);
  const it = rig.projectors[0].cal.intrinsics;
  const scene = linearScene();
  const cap = capturing();
  const frame: RasterSource = {
    mask: 0b0001,
    // Halved so it stays inside [0, 1], which the encode clamps to.
    at: (_i, column, row) => ((column + 0.5) / it.resX + (row + 0.5) / it.resY) / 2,
  };
  // Within half a pixel of the left edge and of the top edge: both corners on
  // each axis are the edge pixel, so the reconstruction is that pixel's value.
  for (const [u, v, expected] of [
    [0.2, 0.3, (0.5 / it.resX + 0.5 / it.resY) / 2],
    [it.resX - 0.2, it.resY - 0.1, ((it.resX - 0.5) / it.resX + (it.resY - 0.5) / it.resY) / 2],
  ]) {
    const ray = aimedAt(rig, 0, u, v);
    traceTwoRig(ray.origin, ray.dir, rig, rig, scene, cap.model, frame);
    const mine = cap.last().find((c) => c.projector === 0);
    assert.ok(mine, `the raster corner (${u}, ${v}) is not on the ball`);
    assert.ok(
      Math.abs(mine.signal.r - expected) < 1e-9,
      `at (${u}, ${v}) the edge read ${mine.signal.r}, not the edge pixel's ${expected}`,
    );
  }
});
