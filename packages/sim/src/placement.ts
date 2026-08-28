// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Projectors anywhere — free placement, any number of them.
 *
 * `docs/ARBITRARY-SHAPES.md` Phase 4, and the other half of the question that
 * started the whole exercise: an uploaded model is only half an answer while the
 * rig that lights it is four projectors on a 90-degree ring.
 *
 * ## Why this is a second builder rather than more parameters on `nominalRig`
 *
 * `nominalRig` builds THE RIG PARAMETERS.md DESCRIBES. Its azimuth slots, its
 * cap of four, its always-2x2 framebuffer and its "quadrants go dark" reading of
 * §2 are not limitations to be relaxed — they are the spec, and every scored
 * number in `bench-results.json` is a statement about that rig. Widening it
 * until it could also express an arbitrary rig would leave nothing that names
 * the installation the gates are about.
 *
 * So the nominal rig keeps its constraints and this builder has none. The two
 * meet in one place, asserted rather than assumed: `test/placement.test.ts`
 * checks that `placedRig` handed the nominal geometry reproduces `nominalRig()`
 * field for field. If the general form could not express the specific one, the
 * generalization would be wrong.
 *
 * ## What does NOT generalize, and is refused rather than approximated
 *
 * `blend.region: 'sector'` (docs/AMENDMENTS.md A-37) hands each projector a
 * longitude wedge measured from its lens azimuth. That presumes a ring of lenses
 * around a rotationally symmetric object, which is exactly what this module
 * exists to stop assuming: five projectors on one wall have no meaningful
 * azimuth order, and the wedges would carve up a circle nobody is standing on.
 * It stays available, because a ring is still a rig somebody builds, and
 * {@link placedRig} says so when a placement is not a ring.
 */

import type {
  BlendCalibration,
  ProjectorCalibration,
  ProjectorIntrinsics,
  ProjectorTransfer,
  RigCalibration,
  Vec3,
  Viewport,
} from '../../calibration/src/index.ts';
import { aimAtPoint } from './geometry.ts';
import { intrinsicsFromThrow } from './optics.ts';
import { nominalBlend, assertFramebufferTopology } from './scene.ts';
import { nominalTransfer } from './photometry.ts';

/** Where one projector is, where it points, and what lens it has. */
export interface ProjectorPlacement {
  /** Defaults to `P<index + 1>`, matching the nominal rig's naming. */
  id?: string;
  /** Lens entrance pupil, world frame, metres. */
  position: Vec3;
  /**
   * Orientation, degrees. Omit `yawDeg`/`pitchDeg` to aim at {@link aimAt}.
   *
   * Given explicitly they are used as given — a projector aimed off the object
   * on purpose (a wash across a wall, a deliberate miss to measure spill) is a
   * rig somebody builds, and the builder should not quietly re-aim it.
   */
  yawDeg?: number;
  pitchDeg?: number;
  /** Roll about the optical axis. Defaults to 0, as §2's nominal does. */
  rollDeg?: number;
  /** What to point at when yaw and pitch are not given. Defaults to the origin. */
  aimAt?: Vec3;
  /** Overrides on the frustum this projector would otherwise be given. */
  intrinsics?: Partial<ProjectorIntrinsics>;
  transfer?: Partial<ProjectorTransfer>;
}

export interface PlacedRigParams {
  projectors: ProjectorPlacement[];
  /** Sphere radius, metres. Still carried: a rig calibration describes a scene. */
  radiusM?: number;
  centerHeightM?: number;
  rotationOffsetDeg?: number;
  /** Native pixels per projector, unless a placement overrides them. */
  resX?: number;
  resY?: number;
  /** Silhouette headroom used when a placement gives no `fovHDeg`. */
  marginFrac?: number;
  /**
   * Framebuffer columns. Defaults to `ceil(sqrt(n))`, which gives the SOS 2x2
   * for four projectors — see {@link gridViewports}.
   */
  columns?: number;
  blend?: Partial<BlendCalibration>;
}

/**
 * Lay `count` projectors out as viewports of ONE framebuffer.
 *
 * The single framebuffer is the part of PARAMETERS.md §3.4 that survives
 * generalization, and it is worth saying why it is not incidental. The
 * simulator's output primitive is one image because the deployment target is one
 * spanned X screen; a rig of independent outputs is a different architecture
 * with different failure modes, and §3.4 explicitly discusses and rejects the
 * multi-window shape. Six projectors on a wall are still driven from one
 * framebuffer, just one split six ways instead of four.
 *
 * **For four projectors this returns the SOS quadrants exactly**, in the config's
 * own order — bottom-left, bottom-right, top-left, top-right — because the grid
 * fills rows from the bottom (conventions.ts §V puts the origin there) and
 * `ceil(sqrt(4))` is 2. `test/placement.test.ts` pins that against
 * `SOS_QUADRANT_VIEWPORTS` rather than against this paragraph, so the general
 * form is checked to contain the specific one rather than claimed to.
 */
export function gridViewports(count: number, columns?: number): Viewport[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`projector count must be a positive integer, got ${count}`);
  }
  const cols = columns ?? Math.ceil(Math.sqrt(count));
  if (!Number.isInteger(cols) || cols < 1) {
    throw new Error(`columns must be a positive integer, got ${cols}`);
  }
  const rows = Math.ceil(count / cols);
  const out: Viewport[] = new Array<Viewport>(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      x: (i % cols) / cols,
      y: Math.floor(i / cols) / rows,
      w: 1 / cols,
      h: 1 / rows,
    };
  }
  return out;
}

/**
 * Build a rig from explicit placements.
 *
 * No azimuth slots, no cap on the count, no assumption that the lenses ring the
 * object. What it keeps from the nominal rig is everything that is about the
 * hardware rather than about the geometry: one framebuffer, viewports that match
 * their rasters, and the same photometric defaults.
 */
export function placedRig(params: PlacedRigParams): RigCalibration {
  const n = params.projectors.length;
  if (n < 1) throw new Error('a rig needs at least one projector');
  const radiusM = params.radiusM ?? 0.8636;
  const centerHeightM = params.centerHeightM ?? 2.1844;
  const resX = params.resX ?? 1920;
  const resY = params.resY ?? 1080;

  const cols = params.columns ?? Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const viewports = gridViewports(n, cols);

  const projectors: ProjectorCalibration[] = params.projectors.map((place, i) => {
    const target = place.aimAt ?? { x: 0, y: 0, z: 0 };
    // Aim only where the caller did not state the angles. Both may be given, and
    // giving one is a mistake worth naming rather than half-honouring.
    const hasYaw = place.yawDeg !== undefined;
    const hasPitch = place.pitchDeg !== undefined;
    if (hasYaw !== hasPitch) {
      throw new Error(
        `projector ${i}: give both yawDeg and pitchDeg, or neither and let it aim at a point`,
      );
    }
    const aim = hasYaw
      ? { yawDeg: place.yawDeg as number, pitchDeg: place.pitchDeg as number }
      : aimAtPoint(place.position, target);

    const px = place.position.x - target.x;
    const py = place.position.y - target.y;
    const pz = place.position.z - target.z;
    const distanceM = Math.hypot(px, py, pz);
    // Each projector is framed from ITS OWN throw. On the nominal ring every
    // lens is the same distance out so this is one number four times; off a ring
    // it is not, and giving them all the far one's field would have the near
    // ones overshoot the object by metres.
    const base = intrinsicsFromThrow({
      resX: place.intrinsics?.resX ?? resX,
      resY: place.intrinsics?.resY ?? resY,
      distanceM: distanceM > 0 ? distanceM : radiusM * 2,
      radiusM,
      marginFrac: params.marginFrac,
      pixelAspect: place.intrinsics?.pixelAspect,
    });

    return {
      id: place.id ?? `P${i + 1}`,
      pose: {
        position: place.position,
        yawDeg: aim.yawDeg,
        pitchDeg: aim.pitchDeg,
        rollDeg: place.rollDeg ?? 0,
      },
      intrinsics: { ...base, ...place.intrinsics },
      transfer: nominalTransfer(place.transfer),
      viewport: viewports[i],
    };
  });

  const rig: RigCalibration = {
    schema: 'sphere-sim/rig-calibration@2',
    sphere: {
      radiusM,
      centerHeightM,
      rotationOffsetDeg: params.rotationOffsetDeg ?? 0,
    },
    blend: nominalBlend(params.blend),
    // Sized from the grid rather than from a doubling, so the invariant
    // `assertFramebufferTopology` checks holds by construction for any count.
    framebuffer: {
      width: (projectors[0]?.intrinsics.resX ?? resX) * cols,
      height: (projectors[0]?.intrinsics.resY ?? resY) * rows,
    },
    projectors,
  };

  assertFramebufferTopology(rig);
  return rig;
}

/**
 * Whether these placements form a ring about the world Z axis — the arrangement
 * `blend.region: 'sector'` assumes.
 *
 * Used to warn rather than to forbid: a ring is still a rig somebody builds, and
 * a rig that is nearly a ring is one somebody built badly, which is the whole
 * subject of this repository. The radius and height bounds are deliberately
 * loose because the question is "is the sector reading meaningful here", not
 * "is this rig good".
 *
 * **The azimuth gap is the condition that actually distinguishes a ring**, and
 * the first version of this function omitted it — with only radius and height it
 * tests for a CYLINDER, and three projectors bunched on one wall sit on a
 * cylinder as surely as four spread around one. `test/placement.test.ts` caught
 * it: lenses at `x = 5`, `y = -2, 0, 2` are all within 7% of the mean radius and
 * at identical height, so they passed as a ring while occupying 44 degrees of
 * arc. So the lenses must also go most of the way ROUND: no gap between
 * neighbouring azimuths wider than half the circle. That admits the spec's own
 * N=3 rig, whose widest gap is exactly 180 where a quadrant went dark, and
 * rejects two lenses 90 degrees apart — which docs/AMENDMENTS.md A-06 already
 * says is not an installation anybody would build.
 */
export function isRing(placements: readonly ProjectorPlacement[]): boolean {
  if (placements.length < 2) return false;
  const r = placements.map((p) => Math.hypot(p.position.x, p.position.y));
  const z = placements.map((p) => p.position.z);
  const meanR = r.reduce((a, b) => a + b, 0) / r.length;
  if (meanR <= 0) return false;
  const spreadR = Math.max(...r) - Math.min(...r);
  const spreadZ = Math.max(...z) - Math.min(...z);
  if (spreadR > 0.1 * meanR) return false;
  if (spreadZ > 0.1 * meanR) return false;

  const az = placements
    .map((p) => (Math.atan2(p.position.y, p.position.x) * 180) / Math.PI)
    .map((a) => (a < 0 ? a + 360 : a))
    .sort((a, b) => a - b);
  let widest = az[0] + 360 - az[az.length - 1];
  for (let i = 1; i < az.length; i++) widest = Math.max(widest, az[i] - az[i - 1]);
  return widest <= 180 + 1e-9;
}
